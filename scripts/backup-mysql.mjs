import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import {
  BUSINESS_TABLES,
  OpsError,
  createMySqlPool,
  digestFile,
  inspectMySql,
  publicFailure,
  snapshotIsRestoreReady,
  validBackupName,
  verifyBlobDirectory,
} from "./mysql-ops-common.mjs";

import { privateDataRoots, copyPrivateDataDirectories } from "./private-data-backup.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function requiredDirectory(environment, name, fallback) {
  const value = String(environment[name] || fallback || "").trim();
  if (!value) throw new OpsError(`${name}_REQUIRED`);
  return path.resolve(value);
}

function backupName() {
  return `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 6)}`;
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const entry = await fs.lstat(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new OpsError("BACKUP_DIRECTORY_INVALID");
  return await fs.realpath(directory);
}

async function closeHandles(handles) {
  const failures = [];
  for (const handle of handles.values()) {
    try { await handle.close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "BACKUP_FILE_CLOSE_FAILED");
}

export async function createMySqlBackup({
  environment = process.env,
  acquireMaintenanceLease = acquireBlobMaintenanceLease,
} = {}) {
  const dataDirectory = requiredDirectory(environment, "DATA_DIR");
  const backupRoot = await ensurePrivateDirectory(requiredDirectory(environment, "BACKUP_DIR", path.join(root, "backups")));
  const name = backupName();
  if (!validBackupName(name)) throw new OpsError("BACKUP_NAME_INVALID");
  const destination = path.join(backupRoot, name);
  const dataDestination = path.join(destination, "mysql");
  const uploadDestination = path.join(destination, "uploads");
  const manifestPath = path.join(destination, "manifest.json");
  const temporaryManifestPath = path.join(destination, `.manifest-${randomUUID()}.tmp`);
  await fs.mkdir(dataDestination, { recursive: true, mode: 0o700 });
  await fs.mkdir(uploadDestination, { mode: 0o700 });

  const handles = new Map();
  let pool;
  let maintenanceLease;
  let platformLease;
  let privateFiles;
  const assertOwned = () => { platformLease?.assertOwned(); maintenanceLease.assertOwned(); };
  let connection;
  let transactionStarted = false;
  let snapshot;
  let copiedBlobs;
  let handlesClosed = false;
  let operationError;
  try {
    if ((await privateDataRoots(dataDirectory)).length) platformLease = acquirePlatformInstanceLeaseSync(dataDirectory);
    maintenanceLease = await acquireMaintenanceLease(dataDirectory, { waitMs: 30_000 });
    assertOwned();
    pool = createMySqlPool(environment).pool;
    for (const spec of BUSINESS_TABLES) {
      handles.set(spec.name, await fs.open(path.join(dataDestination, `${spec.name}.ndjson`), "wx", 0o600));
    }
    connection = await pool.getConnection();
    await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    transactionStarted = true;
    snapshot = await inspectMySql(connection, {
      privateDataDirectory: dataDirectory,
      pageVisitor: async (spec, rows) => {
        if (!rows.length) return;
        assertOwned();
        const payload = rows.map((row) => `${JSON.stringify(row)}\n`).join("");
        await handles.get(spec.name).write(payload, null, "utf8");
      },
    });
    await connection.query("COMMIT");
    transactionStarted = false;
    connection.release();
    connection = null;
    await closeHandles(handles);
    handlesClosed = true;
    assertOwned();

    const sourceUploads = path.join(dataDirectory, "uploads");
    const sourceBlobs = await verifyBlobDirectory(sourceUploads, snapshot.internal.blobReferences, { allowExtras: true });
    if (!sourceBlobs.verified) throw new OpsError("BACKUP_SOURCE_BLOB_MANIFEST_INVALID");
    if (!snapshotIsRestoreReady(snapshot.report, sourceBlobs)) throw new OpsError("BACKUP_SOURCE_DATA_INVALID");
    for (const key of [...snapshot.internal.blobReferences.keys()].sort()) {
      assertOwned();
      await fs.copyFile(path.join(sourceUploads, key), path.join(uploadDestination, key), constants.COPYFILE_EXCL);
    }
    assertOwned();
    copiedBlobs = await verifyBlobDirectory(uploadDestination, snapshot.internal.blobReferences);
    if (!copiedBlobs.verified || copiedBlobs.manifestSha256 !== sourceBlobs.manifestSha256) {
      throw new OpsError("BACKUP_BLOB_ZERO_DIFF_FAILED");
    }

    const files = {};
    for (const spec of BUSINESS_TABLES) {
      const filename = path.join(dataDestination, `${spec.name}.ndjson`);
      files[spec.name] = {
        file: `mysql/${spec.name}.ndjson`,
        sha256: await digestFile(filename),
        rows: snapshot.report.tables[spec.name].rows,
      };
    }
    if (!platformLease && (await privateDataRoots(dataDirectory)).length) throw new OpsError("PRIVATE_BACKUP_REQUIRES_OFFLINE");
    privateFiles = platformLease ? await copyPrivateDataDirectories(dataDirectory, destination, { assertOwned }) : undefined;
    const manifest = {
      privateFiles,
      version: 2,
      completed: true,
      restorable: true,
      backend: "mysql",
      kind: "logical-export-v1",
      createdAt: new Date().toISOString(),
      aggregateSha256: snapshot.report.aggregateSha256,
      schemaMigrationCount: snapshot.report.schemaMigrationCount,
      schemaMigrationsSha256: snapshot.report.schemaMigrationsSha256,
      runtimeSchemaValidated: snapshot.report.runtimeSchemaValidated,
      runtimeSchemaVersion: snapshot.report.runtimeSchemaVersion,
      dataSchemaVersion: snapshot.report.dataSchemaVersion,
      jsonInvalid: snapshot.report.jsonInvalid,
      invariants: snapshot.report.invariants,
      activity: snapshot.report.activity,
      vectors: snapshot.report.vectors,
      tables: snapshot.report.tables,
      files,
      blobs: copiedBlobs,
    };
    assertOwned();
    await fs.writeFile(temporaryManifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    assertOwned();
  } catch (error) {
    operationError = error;
  } finally {
    if (transactionStarted) {
      try { await connection.query("ROLLBACK"); } catch (error) { operationError ||= error; }
    }
    try { connection?.release(); } catch (error) { operationError ||= error; }
    if (!handlesClosed) {
      try { await closeHandles(handles); } catch (error) { operationError ||= error; }
    }
    try { if (pool) await pool.end(); } catch (error) { operationError ||= error; }
    try { if (maintenanceLease) await maintenanceLease.release(); } catch (error) { operationError ||= error; }
    try { platformLease?.releaseSync(); } catch (error) { operationError ||= error; }
  }
  if (operationError) {
    try { await fs.unlink(temporaryManifestPath); } catch { /* no completed marker can exist */ }
    throw operationError;
  }

  try { await fs.rename(temporaryManifestPath, manifestPath); }
  catch {
    try { await fs.unlink(temporaryManifestPath); } catch { /* incomplete backup remains unpublished */ }
    throw new OpsError("BACKUP_MANIFEST_PUBLISH_FAILED");
  }
  const rows = Object.values(snapshot.report.tables).reduce((sum, table) => sum + table.rows, 0);
  return {
    ok: true,
    code: "MYSQL_LOGICAL_BACKUP_COMPLETE",
    kind: "logical-export-v1",
    backupName: name,
    tableCount: BUSINESS_TABLES.length,
    rows,
    aggregateSha256: snapshot.report.aggregateSha256,
    privateFiles: privateFiles ? { files: privateFiles.files.length, sha256: privateFiles.sha256, sensitive: true, offline: true } : { files: 0, legacy: true },
    blobs: snapshot.internal.blobReferences.size,
    blobManifestSha256: copiedBlobs.manifestSha256,
  };
}

async function main() {
  process.stdout.write(`${JSON.stringify(await createMySqlBackup())}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(publicFailure(error, "MYSQL_BACKUP_FAILED"))}\n`);
    process.exitCode = 1;
  });
}
