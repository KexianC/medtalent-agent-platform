import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import {
  OpsError,
  compareSnapshots,
  createMySqlPool,
  inspectMySql,
  inspectSqliteSnapshot,
  mysqlOptionsFromEnvironment,
  mysqlLockNames,
  publicVerificationReport,
  publicFailure,
  acquireNamedLock,
  releaseNamedLock,
  verifyBlobDirectory,
} from "./mysql-ops-common.mjs";

import { verifySqlitePrivateFiles, verifyPrivateDataDirectories } from "./private-data-backup.mjs";

function requiredDirectory(environment, name, fallback) {
  const value = String(environment[name] || fallback || "").trim();
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

async function readTargetSnapshot(pool, dimensions, privateDataDirectory) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionStarted = true;
    const snapshot = await inspectMySql(connection, { expectedEmbeddingDimensions: dimensions, privateDataDirectory });
    await connection.query("COMMIT");
    transactionStarted = false;
    return snapshot;
  } finally {
    if (transactionStarted) {
      try { await connection.query("ROLLBACK"); } catch { /* preserve the inspection failure */ }
    }
    connection.release();
  }
}

export async function verifySqliteMySqlMigration({ environment = process.env, pool: injectedPool } = {}) {
  const sourceDirectory = requiredDirectory(environment, "MIGRATION_SOURCE_DIR");
  const dataDirectory = requiredDirectory(environment, "DATA_DIR");
  const targetUploadDirectory = requiredDirectory(environment, "MIGRATION_TARGET_UPLOAD_DIR",
    path.join(dataDirectory, "uploads"));
  if (targetUploadDirectory !== path.resolve(dataDirectory, "uploads")) {
    throw new OpsError("TARGET_UPLOAD_DIRECTORY_MISMATCH");
  }
  const dimensions = expectedDimensions(environment);
  const source = inspectSqliteSnapshot(sourceDirectory, { expectedEmbeddingDimensions: dimensions });
  await verifySqlitePrivateFiles(source.internal);
  const sourceBlobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);

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
    else {
      pool = createMySqlPool(environment).pool;
      ownsPool = true;
    }
    maintenanceLease = await acquireBlobMaintenanceLease(dataDirectory, { waitMs: 30_000 });
    lockConnection = await pool.getConnection();
    await lockConnection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await acquireNamedLock(lockConnection, lockName);
    lockHeld = true;
    const target = await readTargetSnapshot(pool, dimensions, dataDirectory);
    const targetBlobs = await verifyBlobDirectory(targetUploadDirectory, target.internal.blobReferences);
    platformLease.assertOwned();
    maintenanceLease.assertOwned();
    const [lockRows] = await lockConnection.execute("SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() connection_id", [lockName]);
    if (lockRows[0]?.owner === null || String(lockRows[0].owner) !== String(lockRows[0].connection_id)) {
      throw new OpsError("MYSQL_OPERATION_LOCK_LOST");
    }
    const privateFiles = await verifyPrivateDataDirectories(dataDirectory, source.internal.manifest.privateFiles);
    const comparison = compareSnapshots(source.report, target.report, sourceBlobs, targetBlobs);
    return { privateFiles, ...publicVerificationReport({
      source: source.report,
      target: target.report,
      sourceBlobs,
      targetBlobs,
      comparison,
    }) };
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
  const report = await verifySqliteMySqlMigration();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "MYSQL_VERIFICATION_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
