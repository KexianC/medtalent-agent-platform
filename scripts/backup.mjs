import { DatabaseSync, backup } from "node:sqlite";
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";

import { backupReleaseBlobReferences } from "./release-backup-references.mjs";
import { privateDataRoots, copyPrivateDataDirectories, digestPrivateFile } from "./private-data-backup.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/i;
const usesMySql = (environment) => Object.prototype.hasOwnProperty.call(environment, "DATABASE_URL")
  && environment.DATABASE_URL !== "";

async function removeIncompleteMarkers(fileSystem, ...paths) {
  const failures = [];
  for (const target of paths) {
    try { await fileSystem.unlink(target); }
    catch (error) { if (error?.code !== "ENOENT") failures.push(error); }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "无法清理未完成的备份标记。");
}

async function removeClosedSnapshotSidecars(fileSystem, databasePath) {
  for (const suffix of ["-wal", "-shm"]) {
    const target = `${databasePath}${suffix}`;
    let entry;
    try { entry = await fileSystem.lstat(target); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("备份数据库辅助文件类型无效，已停止。");
    if (suffix === "-wal" && entry.size !== 0) throw new Error("备份数据库仍含未归并的 WAL 数据，已停止。");
    await fileSystem.unlink(target);
  }
}

function combineFailures(message, ...failures) {
  const present = failures.filter(Boolean);
  if (present.length === 1) return present[0];
  const aggregate = new AggregateError(present, message, { cause: present[0] });
  if (present[0]?.code) aggregate.code = present[0].code;
  return aggregate;
}

export async function createBackup({ env = process.env, fileSystem = fs, acquireMaintenanceLease = acquireBlobMaintenanceLease } = {}) {
  if (usesMySql(env)) {
    throw Object.assign(new Error("MySQL backup handler required."), { code: "MYSQL_BACKUP_HANDLER_REQUIRED" });
  }
  const dataDir = path.resolve(env.DATA_DIR || path.join(root, "data"));
  const backupRoot = path.resolve(env.BACKUP_DIR || path.join(root, "backups"));
  const sourcePath = path.join(dataDir, "platform.sqlite");
  await fileSystem.access(sourcePath);

  const privateRoots = await privateDataRoots(dataDir);
  const platformLease = privateRoots.length ? acquirePlatformInstanceLeaseSync(dataDir) : null;
  let maintenanceLease;
  try { maintenanceLease = await acquireMaintenanceLease(dataDir, { waitMs: 30_000 }); }
  catch (error) { platformLease?.releaseSync(); throw error; }
  const assertOwned = () => { platformLease?.assertOwned(); maintenanceLease.assertOwned(); };
  const destination = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`);
  const manifestPath = path.join(destination, "manifest.json");
  const temporaryManifestPath = path.join(destination, `.manifest-${randomUUID()}.tmp`);
  let documents;
  let releaseReferences;
  let blobCount = 0;
  let operationError;

  try {
    assertOwned();
    await fileSystem.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    const backupRootEntry = await fileSystem.lstat(backupRoot);
    if (!backupRootEntry.isDirectory() || backupRootEntry.isSymbolicLink()) throw Object.assign(new Error("BACKUP_DIRECTORY_INVALID"), { code: "BACKUP_DIRECTORY_INVALID" });
    await fileSystem.mkdir(destination, { mode: 0o700 });
    await fileSystem.mkdir(path.join(destination, "uploads"), { mode: 0o700 });
    assertOwned();
    const snapshotPath = path.join(destination, "platform.sqlite");
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try { await backup(source, snapshotPath); } finally { source.close(); }
    assertOwned();
    // Normalize the private snapshot to a self-contained DELETE-journal file.
    // Restores and read-only verification must never depend on WAL sidecars.
    const snapshot = new DatabaseSync(snapshotPath);
    try {
      snapshot.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      const journalMode = String(Object.values(snapshot.prepare("PRAGMA journal_mode=DELETE").get())[0] || "").toLowerCase();
      if (journalMode !== "delete") throw new Error("备份数据库无法切换为独立日志模式，已停止。");
      const integrity = snapshot.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
      if (integrity.length !== 1 || integrity[0] !== "ok") throw new Error("备份数据库完整性检查失败，已停止。");
      documents = snapshot.prepare("SELECT payload FROM documents").all().map((row) => JSON.parse(row.payload));
      releaseReferences = backupReleaseBlobReferences(snapshot.prepare("SELECT key,value FROM meta").all(), dataDir).references;
    } finally { snapshot.close(); }
    await removeClosedSnapshotSidecars(fileSystem, snapshotPath);
    assertOwned();

    // The renewable maintenance lease keeps reference-aware GC from
    // invalidating this immutable snapshot while its blobs are copied.
    const storageKeys = new Set();
    const allReferences = new Map(releaseReferences);
    for (const document of documents.filter((item) => item.status !== "deleted")) {
      if (!STORAGE_KEY.test(document.storageKey || "")) throw new Error("备份中发现无效的资料存储标识，已停止。");
      storageKeys.add(document.storageKey);
      if (Number.isSafeInteger(document.size) && document.size >= 0 && /^[a-f0-9]{64}$/i.test(document.checksum || "")) {
        const expected = { size: document.size, checksum: document.checksum.toLowerCase() };
        const previous = allReferences.get(document.storageKey);
        if (previous && (previous.size !== expected.size || previous.checksum !== expected.checksum)) throw Object.assign(new Error("BACKUP_BLOB_REFERENCE_CONFLICT"), { code: "BACKUP_BLOB_REFERENCE_CONFLICT" });
        allReferences.set(document.storageKey, expected);
      }
    }
    for (const storageKey of releaseReferences.keys()) storageKeys.add(storageKey);
    for (const storageKey of storageKeys) {
      assertOwned();
      const sourceEntry = await fileSystem.lstat(path.join(dataDir, "uploads", storageKey));
      if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || sourceEntry.nlink > 1) throw Object.assign(new Error("BACKUP_BLOB_FILE_INVALID"), { code: "BACKUP_BLOB_FILE_INVALID" });
      await fileSystem.copyFile(path.join(dataDir, "uploads", storageKey), path.join(destination, "uploads", storageKey), constants.COPYFILE_EXCL);
      assertOwned();
      const expected = allReferences.get(storageKey);
      if (expected && ((await fileSystem.lstat(path.join(destination, "uploads", storageKey))).size !== expected.size || await digestPrivateFile(path.join(destination, "uploads", storageKey)) !== expected.checksum)) throw Object.assign(new Error("RELEASE_BACKUP_ORIGINAL_INVALID"), { code: "RELEASE_BACKUP_ORIGINAL_INVALID" });
    }
    blobCount = storageKeys.size;
    if (!platformLease && (await privateDataRoots(dataDir)).length) throw Object.assign(new Error("PRIVATE_BACKUP_REQUIRES_OFFLINE"), { code: "PRIVATE_BACKUP_REQUIRES_OFFLINE" });
    const privateFiles = platformLease ? await copyPrivateDataDirectories(dataDir, destination, { assertOwned }) : undefined;
    const databaseSha256 = await digestPrivateFile(snapshotPath);
    await fileSystem.chmod(snapshotPath, 0o600);
    const manifest = { privateFiles, databaseSha256, version: 1, completed: true, createdAt: new Date().toISOString(), documents: documents.length,
      blobs: blobCount, database: "platform.sqlite" };
    assertOwned();
    await fileSystem.writeFile(temporaryManifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    assertOwned();
  } catch (error) { operationError = error; }

  let releaseError;
  try { await maintenanceLease.release(); } catch (error) { releaseError = error; }
  try { platformLease?.releaseSync(); } catch (error) { releaseError = releaseError ? combineFailures("备份租约释放失败。", releaseError, error) : error; }
  if (operationError || releaseError) {
    let cleanupError;
    try { await removeIncompleteMarkers(fileSystem, temporaryManifestPath, manifestPath); }
    catch (error) { cleanupError = error; }
    throw combineFailures("备份失败，且部分失败信息需要一并处理。", operationError, releaseError, cleanupError);
  }

  try { await fileSystem.rename(temporaryManifestPath, manifestPath); }
  catch (publicationError) {
    let cleanupError;
    try { await removeIncompleteMarkers(fileSystem, temporaryManifestPath, manifestPath); }
    catch (error) { cleanupError = error; }
    throw combineFailures("备份完成标记发布失败。", publicationError, cleanupError);
  }
  return { destination, documents: documents.length, blobs: blobCount };
}

async function main() {
  if (usesMySql(process.env)) {
    const { createMySqlBackup } = await import("./backup-mysql.mjs");
    process.stdout.write(`${JSON.stringify(await createMySqlBackup())}\n`);
    return;
  }
  const result = await createBackup();
  console.log(`完整备份已创建：${result.destination}`);
  console.log("备份含私有知识和账号密码哈希，请加密保存并限制访问。仅有 manifest.completed=true 的目录可用于恢复。");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    if (usesMySql(process.env)) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: "MYSQL_BACKUP_FAILED" })}\n`);
    } else console.error(error?.message || "备份失败。");
    process.exitCode = 1;
  });
}
