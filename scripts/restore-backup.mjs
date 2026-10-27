import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import { inspectSqliteSnapshot, snapshotIsRestoreReady, verifyBlobDirectory } from "./mysql-ops-common.mjs";
import { verifySqlitePrivateFiles, restorePrivateDataDirectories, digestPrivateFile } from "./private-data-backup.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
// Restores an immutable SQLite backup into an empty, offline DATA_DIR. It never opens or migrates the source.
export async function restoreBackup({ sourceDirectory, dataDirectory } = {}) {
  if (!sourceDirectory || !dataDirectory) fail("SQLITE_RESTORE_DIRECTORIES_REQUIRED");
  const source = inspectSqliteSnapshot(path.resolve(sourceDirectory));
  const privateFiles = await verifySqlitePrivateFiles(source.internal);
  const blobs = await verifyBlobDirectory(source.internal.uploadDirectory, source.internal.blobReferences);
  if (!snapshotIsRestoreReady(source.report, blobs)) fail("SQLITE_BACKUP_NOT_RESTORABLE");
  const target = path.resolve(dataDirectory);
  try {
    const entry = await fs.lstat(target);
    if (!entry.isDirectory() || entry.isSymbolicLink() || (await fs.readdir(target)).length) fail("SQLITE_RESTORE_TARGET_NOT_EMPTY");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  // No target file or lease is created until every source manifest, row, blob and private file has passed preflight.
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const platformLease = acquirePlatformInstanceLeaseSync(target);
  let maintenanceLease;
  const staging = path.join(target, ".restore-" + randomUUID());
  const installed = [];
  const assertOwned = () => { platformLease.assertOwned(); maintenanceLease.assertOwned(); };
  let success = false;
  try {
    maintenanceLease = await acquireBlobMaintenanceLease(target, { waitMs: 30_000 });
    assertOwned();
    await fs.mkdir(staging, { mode: 0o700 });
    await fs.mkdir(path.join(staging, "uploads"), { mode: 0o700 });
    await fs.copyFile(source.internal.databasePath, path.join(staging, "platform.sqlite"), constants.COPYFILE_EXCL);
    await fs.chmod(path.join(staging, "platform.sqlite"), 0o600);
    for (const key of source.internal.blobReferences.keys()) {
      assertOwned();
      await fs.copyFile(path.join(source.internal.uploadDirectory, key), path.join(staging, "uploads", key), constants.COPYFILE_EXCL);
      await fs.chmod(path.join(staging, "uploads", key), 0o600);
    }
    await restorePrivateDataDirectories(source.internal.root, staging, source.internal.manifest.privateFiles, { assertOwned });
    const restoredBlobs = await verifyBlobDirectory(path.join(staging, "uploads"), source.internal.blobReferences);
    const expectedDatabaseHash = await digestPrivateFile(source.internal.databasePath);
    if (!restoredBlobs.verified || blobs.manifestSha256 !== restoredBlobs.manifestSha256
      || await digestPrivateFile(path.join(staging, "platform.sqlite")) !== expectedDatabaseHash) fail("SQLITE_RESTORE_ZERO_DIFF_FAILED");
    await verifySqlitePrivateFiles(source.internal);
    assertOwned();
    // The database is installed last; a failed install is rolled back while the instance lease remains held.
    for (const name of ["uploads", ...(source.internal.manifest.privateFiles?.roots || []), "platform.sqlite"]) {
      const destination = path.join(target, name);
      try { await fs.lstat(destination); fail("SQLITE_RESTORE_TARGET_CHANGED"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await fs.rename(path.join(staging, name), destination);
      installed.push(name);
    }
    assertOwned();
    success = true;
    return { ok: true, code: "SQLITE_RESTORE_ZERO_DIFF", documents: source.report.tables.documents.rows,
      blobs: blobs.files, databaseSha256: expectedDatabaseHash, privateFiles };
  } finally {
    let cleanupError;
    try {
      if (!success) for (const name of installed.reverse()) await fs.rename(path.join(target, name), path.join(staging, name));
      // Staging is a validated child created by this invocation, never a caller-supplied deletion target.
      await fs.rm(staging, { recursive: true, force: true });
    } catch (error) { cleanupError = error; }
    try { await maintenanceLease?.release(); } catch (error) { cleanupError ||= error; }
    try { platformLease.releaseSync(); } catch (error) { cleanupError ||= error; }
    if (cleanupError) throw cleanupError;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  restoreBackup({ sourceDirectory: process.env.SQLITE_RESTORE_SOURCE_DIR, dataDirectory: process.env.DATA_DIR })
    .then(result => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch(() => { process.stderr.write(JSON.stringify({ ok: false, code: "SQLITE_RESTORE_FAILED" }) + "\n"); process.exitCode = 1; });
}
