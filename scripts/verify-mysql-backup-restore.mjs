import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import {
  OpsError,
  acquireNamedLock,
  blobReportMatches,
  compareSnapshots,
  createMySqlPool,
  inspectMySql,
  inspectMySqlLogicalBackup,
  mysqlLockNames,
  mysqlOptionsFromEnvironment,
  publicFailure,
  publicVerificationReport,
  releaseNamedLock,
  snapshotIsRestoreReady,
  verifyBlobDirectory,
} from "./mysql-ops-common.mjs";

import { verifyPrivateDataDirectories } from "./private-data-backup.mjs";

function requiredDirectory(environment, name) {
  const value = String(environment[name] || "").trim();
  if (!value) throw new OpsError(`${name}_REQUIRED`);
  return path.resolve(value);
}

function expectedDimensions(environment) {
  const raw = String(environment.EXPECTED_EMBEDDING_DIMENSIONS || "").trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new OpsError("EXPECTED_EMBEDDING_DIMENSIONS_INVALID");
  return value;
}

async function targetSnapshot(pool, dimensions, privateDataDirectory) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionStarted = true;
    const target = await inspectMySql(connection, { expectedEmbeddingDimensions: dimensions, privateDataDirectory });
    await connection.query("COMMIT");
    transactionStarted = false;
    return target;
  } finally {
    if (transactionStarted) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve verification failure */ }
    }
    connection.release();
  }
}

export async function verifyMySqlBackupRestore({ environment = process.env, pool: injectedPool } = {}) {
  const sourceDirectory = requiredDirectory(environment, "MYSQL_RESTORE_SOURCE_DIR");
  const dataDirectory = requiredDirectory(environment, "DATA_DIR");
  const dimensions = expectedDimensions(environment);
  const source = await inspectMySqlLogicalBackup(sourceDirectory, { expectedEmbeddingDimensions: dimensions });
  const sourceBlobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
  if (!blobReportMatches(source.internal.manifest.blobs, sourceBlobs)
    || !snapshotIsRestoreReady(source.report, sourceBlobs)) throw new OpsError("MYSQL_BACKUP_NOT_RESTORABLE");

  const databaseName = mysqlOptionsFromEnvironment(environment).database;
  const lockName = mysqlLockNames(databaseName).instance;
  const platformLease = acquirePlatformInstanceLeaseSync(dataDirectory);
  let maintenanceLease;
  let pool;
  let ownsPool = false;
  let lockConnection;
  let lockHeld = false;
  try {
    if (injectedPool) pool = injectedPool;
    else { pool = createMySqlPool(environment).pool; ownsPool = true; }
    maintenanceLease = await acquireBlobMaintenanceLease(dataDirectory, { waitMs: 30_000 });
    lockConnection = await pool.getConnection();
    await lockConnection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await acquireNamedLock(lockConnection, lockName);
    lockHeld = true;
    const target = await targetSnapshot(pool, dimensions, dataDirectory);
    const targetBlobs = await verifyBlobDirectory(path.join(dataDirectory, "uploads"), target.internal.blobReferences);
    platformLease.assertOwned();
    maintenanceLease.assertOwned();
    const [lockRows] = await lockConnection.execute("SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() connection_id", [lockName]);
    if (lockRows[0]?.owner === null || String(lockRows[0].owner) !== String(lockRows[0].connection_id)) {
      throw new OpsError("MYSQL_OPERATION_LOCK_LOST");
    }
    const privateFiles = await verifyPrivateDataDirectories(dataDirectory, source.internal.manifest.privateFiles);
    const comparison = compareSnapshots(source.report, target.report, sourceBlobs, targetBlobs,
      { requireQuiescent: false });
    return {
      ...publicVerificationReport({
        source: source.report,
        target: target.report,
        sourceBlobs,
        targetBlobs,
        comparison,
      }),
      privateFiles,
      code: comparison.verified ? "MYSQL_LOGICAL_RESTORE_ZERO_DIFF" : "MYSQL_LOGICAL_RESTORE_MISMATCH",
      kind: "logical-export-v1",
    };
  } finally {
    if (lockHeld) await releaseNamedLock(lockConnection, lockName);
    lockConnection?.release();
    try { if (ownsPool) await pool.end(); }
    finally {
      try { if (maintenanceLease) await maintenanceLease.release(); }
      finally { platformLease.releaseSync(); }
    }
  }
}

async function main() {
  const report = await verifyMySqlBackupRestore();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "MYSQL_RESTORE_VERIFICATION_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
