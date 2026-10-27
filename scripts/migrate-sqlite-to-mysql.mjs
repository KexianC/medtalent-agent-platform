import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MySQLPlatformDatabase, MYSQL_SCHEMA_VERSION } from "../server/mysql-database.mjs";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import {
  BUSINESS_TABLES,
  OpsError,
  acquireNamedLock,
  assertTargetDatabaseEmpty,
  compareSnapshots,
  createMySqlPool,
  inspectMySql,
  inspectSqliteSnapshot,
  mysqlLockNames,
  normalizedImportRow,
  publicVerificationReport,
  publicFailure,
  postCommitVerificationError,
  releaseNamedLock,
  runPostCommitVerification,
  snapshotIsMigrationReady,
  sqliteImportRows,
  verifyBlobDirectory,
} from "./mysql-ops-common.mjs";

import { verifySqlitePrivateFiles, assertPrivateRestoreTarget, restorePrivateDataDirectories, verifyPrivateDataDirectories } from "./private-data-backup.mjs";

const quote = (identifier) => `\`${identifier}\``;

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

async function assertFreshMigratedSchema(connection) {
  for (const spec of BUSINESS_TABLES) {
    if (spec.name === "meta") continue;
    const [rows] = await connection.query(`SELECT COUNT(*) count FROM ${quote(spec.name)}`);
    if (Number(rows[0]?.count) !== 0) throw new OpsError("MYSQL_TARGET_NOT_FRESH");
  }
  const [metaRows] = await connection.query("SELECT `key` FROM meta ORDER BY BINARY `key`");
  if (metaRows.length !== 1 || metaRows[0]?.key !== "schema_version") {
    throw new OpsError("MYSQL_TARGET_NOT_FRESH");
  }
}

async function insertBatch(connection, spec, batch) {
  if (!batch.length) return;
  const columns = [...(spec.seq ? ["seq"] : []), ...spec.columns];
  const values = batch.map(() => `(${columns.map(() => "?").join(",")})`).join(",");
  const parameters = batch.flatMap((row) => columns.map((column) => row[column]));
  await connection.execute(`INSERT INTO ${quote(spec.name)} (${columns.map(quote).join(",")}) VALUES ${values}`, parameters);
}

async function importTable(connection, database, spec) {
  if (spec.name === "meta") {
    for (const rawRow of sqliteImportRows(database, spec)) {
      const row = normalizedImportRow(spec, rawRow);
      if (row.key === "schema_version") {
        await connection.execute("UPDATE meta SET value=? WHERE `key`='schema_version'", [String(MYSQL_SCHEMA_VERSION)]);
      } else {
        await connection.execute("INSERT INTO meta(`key`,value) VALUES(?,?)", [row.key, row.value]);
      }
    }
    return;
  }

  let batch = [];
  let approximateBytes = 0;
  for (const rawRow of sqliteImportRows(database, spec)) {
    const row = normalizedImportRow(spec, rawRow);
    const rowBytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    if (batch.length && (batch.length >= 50 || approximateBytes + rowBytes > 512 * 1024)) {
      await insertBatch(connection, spec, batch);
      batch = [];
      approximateBytes = 0;
    }
    batch.push(row);
    approximateBytes += rowBytes;
  }
  await insertBatch(connection, spec, batch);
}

export async function importSqliteTables(connection, database) {
  for (const spec of BUSINESS_TABLES) await importTable(connection, database, spec);
}

async function inspectCommittedTarget(pool, dimensions, privateDataDirectory) {
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
      try { await connection.query("ROLLBACK"); } catch { /* preserve inspection failure */ }
    }
    connection.release();
  }
}

export async function migrateSqliteToMySql({ environment = process.env } = {}) {
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
  await assertPrivateRestoreTarget(dataDirectory, source.internal.manifest.privateFiles);
  const sourceBlobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
  if (!snapshotIsMigrationReady(source.report, sourceBlobs)) throw new OpsError("SQLITE_SOURCE_NOT_MIGRATION_READY");
  const platformLease = acquirePlatformInstanceLeaseSync(dataDirectory);
  let maintenanceLease;
  let pool;
  let databaseName;
  let operationConnection;
  let operationLockHeld = false;
  let platformDatabase;
  let importConnection;
  let importTransactionStarted = false;
  let sourceDatabase;
  let commitAcknowledgement;
  let commitCause;
  let operationFailure;
  try {
    maintenanceLease = await acquireBlobMaintenanceLease(dataDirectory, { waitMs: 30_000 });
    platformLease.assertOwned();
    maintenanceLease.assertOwned();
    const targetBlobsBefore = await verifyBlobDirectory(targetUploadDirectory, source.internal.blobReferences);
    if (!targetBlobsBefore.verified || targetBlobsBefore.manifestSha256 !== sourceBlobs.manifestSha256) {
      throw new OpsError("TARGET_BLOB_MANIFEST_MISMATCH");
    }

    ({ pool, databaseName } = createMySqlPool(environment));
    operationConnection = await pool.getConnection();
    await operationConnection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await acquireNamedLock(operationConnection, mysqlLockNames(databaseName).migration);
    operationLockHeld = true;
    await assertTargetDatabaseEmpty(operationConnection);

    platformDatabase = new MySQLPlatformDatabase({
      pool,
      ownsPool: false,
      dataDir: dataDirectory,
      lockNamespace: databaseName,
    });
    await platformDatabase.acquireInstanceLock(0);
    await platformDatabase.assertSupportedServer();
    await platformDatabase.runMigrations({ timeoutSeconds: 0 });
    platformDatabase.startLockHeartbeat();
    await platformDatabase.verifyInstanceLock();

    await restorePrivateDataDirectories(source.internal.root, dataDirectory, source.internal.manifest.privateFiles, { assertOwned: () => { platformLease.assertOwned(); maintenanceLease.assertOwned(); } });

    importConnection = await pool.getConnection();
    await importConnection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await importConnection.query("SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await assertFreshMigratedSchema(importConnection);
    await importConnection.query("START TRANSACTION");
    importTransactionStarted = true;
    const [guards] = await importConnection.query("SELECT name FROM transaction_guards WHERE name='platform-write' FOR UPDATE");
    if (guards.length !== 1) throw new OpsError("MYSQL_RUNTIME_SCHEMA_INVALID");
    sourceDatabase = new DatabaseSync(source.internal.databasePath, { readOnly: true });
    sourceDatabase.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    await importSqliteTables(importConnection, sourceDatabase);
    sourceDatabase.close();
    sourceDatabase = null;

    platformLease.assertOwned();
    maintenanceLease.assertOwned();
    await platformDatabase.verifyInstanceLock();
    platformDatabase.assertAvailable();
    const sourceBlobsBeforeCommit = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
    const targetBlobsBeforeCommit = await verifyBlobDirectory(targetUploadDirectory, source.internal.blobReferences);
    await verifyPrivateDataDirectories(dataDirectory, source.internal.manifest.privateFiles);
    const targetBeforeCommit = await inspectMySql(importConnection, { expectedEmbeddingDimensions: dimensions, privateDataDirectory: dataDirectory });
    const comparisonBeforeCommit = compareSnapshots(source.report, targetBeforeCommit.report,
      sourceBlobsBeforeCommit, targetBlobsBeforeCommit);
    if (!comparisonBeforeCommit.verified) throw new OpsError("MYSQL_IMPORT_ZERO_DIFF_FAILED");
    commitAcknowledgement = "acknowledged";
    try {
      await importConnection.query("COMMIT");
      importTransactionStarted = false;
    } catch (error) {
      importTransactionStarted = false;
      commitAcknowledgement = "unknown";
      commitCause = error;
      try { importConnection.destroy(); } catch { /* discard an uncertain session */ }
      importConnection = null;
    }

    return await runPostCommitVerification({ operation: "import", commitAcknowledgement, commitCause }, async () => {
      const target = await inspectCommittedTarget(pool, dimensions, dataDirectory);
      platformLease.assertOwned();
      maintenanceLease.assertOwned();
      await platformDatabase.verifyInstanceLock();
      platformDatabase.assertAvailable();
      const sourceBlobsAfterCommit = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
      const targetBlobs = await verifyBlobDirectory(targetUploadDirectory, target.internal.blobReferences);
      await verifyPrivateDataDirectories(dataDirectory, source.internal.manifest.privateFiles);
      const comparison = compareSnapshots(source.report, target.report, sourceBlobsAfterCommit, targetBlobs);
      if (!comparison.verified) throw new OpsError("MYSQL_IMPORT_POST_COMMIT_ZERO_DIFF_FAILED");
      return {
        ...publicVerificationReport({
          source: source.report,
          target: target.report,
          sourceBlobs: sourceBlobsAfterCommit,
          targetBlobs,
          comparison,
        }),
        commitAcknowledgement: commitAcknowledgement === "unknown" ? "verified-after-unknown-ack" : "acknowledged",
      };
    });
  } catch (error) {
    operationFailure = error;
    throw error;
  } finally {
    const cleanupFailures = [];
    try { if (sourceDatabase) sourceDatabase.close(); } catch (error) { cleanupFailures.push(error); }
    if (importTransactionStarted) {
      try { await importConnection.query("ROLLBACK"); } catch (error) { cleanupFailures.push(error); }
    }
    try { importConnection?.release(); } catch (error) { cleanupFailures.push(error); }
    if (platformDatabase) {
      try { await platformDatabase.close(); } catch (error) { cleanupFailures.push(error); }
    }
    try {
      if (operationLockHeld) await releaseNamedLock(operationConnection, mysqlLockNames(databaseName).migration);
    } catch (error) { cleanupFailures.push(error); }
    try { operationConnection?.release(); } catch (error) { cleanupFailures.push(error); }
    try { if (pool) await pool.end(); } catch (error) { cleanupFailures.push(error); }
    try { if (maintenanceLease) await maintenanceLease.release(); } catch (error) { cleanupFailures.push(error); }
    try { platformLease.releaseSync(); } catch (error) { cleanupFailures.push(error); }
    if (cleanupFailures.length) {
      const failures = operationFailure ? [operationFailure.cause || operationFailure, ...cleanupFailures] : cleanupFailures;
      const cleanupCause = failures.length === 1 ? failures[0]
        : new AggregateError(failures, "MySQL import cleanup failures");
      if (commitAcknowledgement) {
        throw postCommitVerificationError({ operation: "import", commitAcknowledgement, commitCause }, cleanupCause);
      }
      throw cleanupCause;
    }
  }
}

async function main() {
  const report = await migrateSqliteToMySql();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "MYSQL_IMPORT_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
