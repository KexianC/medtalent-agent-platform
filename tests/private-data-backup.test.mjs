import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { PlatformDatabase } from "../server/database.mjs";
import { ProviderRegistry } from "../server/provider-registry.mjs";
import { acquirePlatformInstanceLeaseSync } from "../server/file-lease.mjs";
import { mysqlBackupSchemaSummary, MYSQL_SCHEMA_VERSION } from "../server/mysql-database.mjs";
import { createBackup } from "../scripts/backup.mjs";
import { restoreBackup } from "../scripts/restore-backup.mjs";
import { importMySqlLogicalBackup } from "../scripts/restore-mysql-backup.mjs";
import { BUSINESS_TABLES, inspectSqliteSnapshot, inspectMySqlLogicalBackup, compareSnapshots,
  comparisonSourceSnapshot, normalizedImportRow, sqliteImportRows, digestFile, verifyBlobDirectory } from "../scripts/mysql-ops-common.mjs";
import { PRIVATE_DATA_DIRECTORIES, verifyPrivateDataDirectories, restorePrivateDataDirectories } from "../scripts/private-data-backup.mjs";

const base = fileURLToPath(new URL("../.private-backup-test-tmp/", import.meta.url));
await fs.mkdir(base, { recursive: true });
test.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
async function fixture(t, { privateFiles = true, version = MYSQL_SCHEMA_VERSION } = {}) {
  const dir = await fs.mkdtemp(path.join(base, "fixture-"));
  const data = path.join(dir, "data"), backups = path.join(dir, "backups");
  const db = new PlatformDatabase({ dataDir: data, seedDoctors: [] });
  await fs.mkdir(path.join(data, "uploads"), { recursive: true });
  if (privateFiles) {
    const registry = await new ProviderRegistry(db, { dataDir: data, env: {} }).initialize();
    await registry.save({ kind: "chat", name: "合成供应商", endpoint: "https://not-used.invalid/v1", model: "fixture-model", apiKey: "synthetic-private-key-never-printed", enabled: true }, "fixture");
    for (const name of PRIVATE_DATA_DIRECTORIES.filter(x => x !== "private-config")) {
      await fs.mkdir(path.join(data, name, "nested"), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(data, name, "nested", "fixture.bin"), Buffer.from("synthetic-private-" + name), { mode: 0o600 });
    }
    await db.setMeta("backup.fixture.references", JSON.stringify({ media: "fixture.bin", release: "fixture", report: "fixture", channel: "fixture", qualification: "fixture" }));
  }
  if (version < 3) db.sqlite.exec("DROP TABLE analytics_events");
  if (version < 2) for (const name of ["consumer_documents", "consumer_sessions", "consumer_login_requests", "consumer_login_codes", "consumer_users"]) db.sqlite.exec("DROP TABLE " + name);
  db.sqlite.prepare("UPDATE meta SET value=? WHERE key='schema_version'").run(String(version));
  db.close();
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const result = await createBackup({ env: { DATA_DIR: data, BACKUP_DIR: backups } });
  return { dir, data, backups, source: result.destination, result };
}
const manifest = async dir => JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));

test("SQLite complete offline backup restores encrypted provider key and every controlled private root byte-for-byte", async t => {
  const f = await fixture(t), m = await manifest(f.source);
  assert.deepEqual(m.privateFiles.roots, [...PRIVATE_DATA_DIRECTORIES].sort());
  assert.equal(m.privateFiles.sensitive, true);
  assert.equal(m.privateFiles.consistency, "exclusive-instance-lease");
  assert.equal(m.privateFiles.files.length, 6);
  assert.equal(JSON.stringify(m).includes("synthetic-private-key-never-printed"), false);
  const target = path.join(f.dir, "restored");
  const result = await restoreBackup({ sourceDirectory: f.source, dataDirectory: target });
  assert.equal(result.code, "SQLITE_RESTORE_ZERO_DIFF");
  assert.equal(result.privateFiles.files, 6);
  for (const file of m.privateFiles.files) {
    assert.deepEqual(await fs.readFile(path.join(target, file.path)), await fs.readFile(path.join(f.data, file.path)));
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(target, file.path))).mode & 0o777, 0o600);
  }
  const reopened = new PlatformDatabase({ dataDir: target, seedDoctors: [] });
  try {
    const registry = await new ProviderRegistry(reopened, { dataDir: target, env: {} }).initialize();
    assert.equal(registry.get("chat").apiKey, "synthetic-private-key-never-printed");
    assert.equal(JSON.stringify(registry.list()).includes("synthetic-private-key-never-printed"), false);
    assert.ok(await reopened.getMeta("backup.fixture.references"));
  } finally { reopened.close(); }
});

test("private backup refuses a running platform instance instead of treating the blob lease as a global freeze", async t => {
  const f = await fixture(t), lease = acquirePlatformInstanceLeaseSync(f.data);
  try {
    await assert.rejects(createBackup({ env: { DATA_DIR: f.data, BACKUP_DIR: f.backups } }), { code: "PLATFORM_INSTANCE_LOCKED" });
    assert.equal((await fs.readdir(f.backups)).length, 1);
  } finally { lease.releaseSync(); }
});

test("corrupt private manifest, file bytes, mode and unlisted files all fail before creating a restore target", async t => {
  const f = await fixture(t);
  for (const kind of ["manifest-hash", "path", "mode", "file", "extra", "missing-manifest", "missing-file", "database"]) {
    const source = path.join(f.dir, "corrupt-" + kind), target = path.join(f.dir, "target-" + kind);
    await fs.cp(f.source, source, { recursive: true });
    const m = await manifest(source);
    if (kind === "manifest-hash") m.privateFiles.sha256 = "0".repeat(64);
    if (kind === "path") m.privateFiles.files[0].path = "../escape.key";
    if (kind === "mode") m.privateFiles.files[0].mode = 0o777;
    if (kind === "file") await fs.appendFile(path.join(source, m.privateFiles.files[0].path), "altered");
    if (kind === "extra") await fs.writeFile(path.join(source, "media", "unlisted.bin"), "unlisted");
    if (kind === "missing-file") await fs.unlink(path.join(source, m.privateFiles.files[0].path));
    if (kind === "missing-manifest") delete m.privateFiles;
    if (kind === "database") m.databaseSha256 = "0".repeat(64);
    await fs.writeFile(path.join(source, "manifest.json"), JSON.stringify(m));
    await assert.rejects(restoreBackup({ sourceDirectory: source, dataDirectory: target }));
    await assert.rejects(fs.access(target), { code: "ENOENT" });
  }
});

test("source and restore symlinks are rejected, and existing private targets are never merged", async t => {
  const f = await fixture(t), outside = path.join(f.dir, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.bin"), "synthetic-outside");
  await fs.rm(path.join(f.data, "media"), { recursive: true });
  await fs.symlink(outside, path.join(f.data, "media"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(createBackup({ env: { DATA_DIR: f.data, BACKUP_DIR: f.backups } }), { code: "PRIVATE_BACKUP_DIRECTORY_INVALID" });
  const target = path.join(f.dir, "merge-target");
  await fs.mkdir(path.join(target, "media"), { recursive: true });
  await fs.writeFile(path.join(target, "media", "existing.bin"), "existing");
  await assert.rejects(restorePrivateDataDirectories(f.source, target, (await manifest(f.source)).privateFiles), { code: "PRIVATE_RESTORE_TARGET_NOT_EMPTY" });
  assert.equal(await fs.readFile(path.join(target, "media", "existing.bin"), "utf8"), "existing");
  assert.equal((await fs.readdir(target)).length, 1);
  await fs.rm(path.join(target, "media"), { recursive: true });
  await fs.symlink(outside, path.join(target, "media"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(restorePrivateDataDirectories(f.source, target, (await manifest(f.source)).privateFiles), { code: "PRIVATE_BACKUP_DIRECTORY_INVALID" });
  assert.equal(await fs.readFile(path.join(outside, "private.bin"), "utf8"), "synthetic-outside");
});

test("old schema 1 and 2 SQLite backups without private manifest remain restorable and explicitly legacy", async t => {
  for (const version of [1, 2]) {
    const f = await fixture(t, { privateFiles: false, version });
    const m = await manifest(f.source);
    delete m.databaseSha256; // historical v1 manifest had no physical database digest
    await fs.writeFile(path.join(f.source, "manifest.json"), JSON.stringify(m));
    const source = inspectSqliteSnapshot(f.source);
    assert.equal(source.report.dataSchemaVersion, String(version));
    const restored = await restoreBackup({ sourceDirectory: f.source, dataDirectory: path.join(f.dir, "legacy-restored") });
    assert.equal(restored.privateFiles.legacy, true);
    const upgraded = comparisonSourceSnapshot(source.report);
    assert.equal(upgraded.dataSchemaVersion, String(MYSQL_SCHEMA_VERSION));
    assert.equal(upgraded.tables.analytics_events.rows, 0);
    assert.equal(upgraded.tables.consumer_documents.rows, 0);
  }
});

async function logicalFixture(t, version) {
  const f = await fixture(t, { privateFiles: false, version });
  const source = inspectSqliteSnapshot(f.source), logical = path.join(f.dir, "logical");
  await fs.mkdir(path.join(logical, "mysql"), { recursive: true });
  await fs.mkdir(path.join(logical, "uploads"));
  const db = new DatabaseSync(source.internal.databasePath, { readOnly: true });
  const files = {};
  try {
    for (const spec of BUSINESS_TABLES.filter(spec => source.report.tables[spec.name])) {
      const filename = path.join(logical, "mysql", spec.name + ".ndjson");
      const rows = [...sqliteImportRows(db, spec)].map(row => normalizedImportRow(spec, row));
      await fs.writeFile(filename, rows.map(row => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
      files[spec.name] = { file: "mysql/" + spec.name + ".ndjson", rows: rows.length, sha256: await digestFile(filename) };
    }
  } finally { db.close(); }
  const summary = mysqlBackupSchemaSummary(version), blobs = await verifyBlobDirectory(path.join(logical, "uploads"), source.internal.blobReferences);
  const { schemaInventory, upgradedMeta, ...report } = source.report;
  void schemaInventory; void upgradedMeta;
  await fs.writeFile(path.join(logical, "manifest.json"), JSON.stringify({ ...report, version: 2, completed: true,
    restorable: true, backend: "mysql", kind: "logical-export-v1", schemaMigrationCount: summary.count,
    schemaMigrationsSha256: summary.sha256, runtimeSchemaVersion: version, runtimeSchemaValidated: true, files, blobs }));
  return { ...f, logical, source, blobs };
}

test("historical MySQL logical backups validate original 1/2 checksums and restore imports only additive schema changes", async t => {
  for (const version of [1, 2]) {
    const f = await logicalFixture(t, version), backup = await inspectMySqlLogicalBackup(f.logical);
    assert.equal(backup.report.privateFiles.legacy, true);
    assert.equal(backup.report.runtimeSchemaVersion, version);
    assert.equal(backup.report.tables.analytics_events, undefined);
    const writes = [];
    await importMySqlLogicalBackup({ execute: async (sql, values) => { writes.push({ sql, values }); return [[]]; } }, backup.internal);
    const metaVersion = writes.find(write => write.sql.startsWith("UPDATE meta SET value="));
    assert.equal(metaVersion.values[0], String(MYSQL_SCHEMA_VERSION));
    const expected = comparisonSourceSnapshot(backup.report);
    assert.equal(compareSnapshots(backup.report, expected, f.blobs, f.blobs, { requireQuiescent: false }).verified, true);
    const changed = structuredClone(expected);
    changed.tables.meta.sha256 = "0".repeat(64);
    assert.equal(compareSnapshots(backup.report, changed, f.blobs, f.blobs, { requireQuiescent: false }).verified, false);
    const m = await manifest(f.logical);
    m.schemaMigrationsSha256 = createHash("sha256").update("forged-schema").digest("hex");
    await fs.writeFile(path.join(f.logical, "manifest.json"), JSON.stringify(m));
    await assert.rejects(inspectMySqlLogicalBackup(f.logical), { code: "MYSQL_BACKUP_SCHEMA_INCOMPATIBLE" });
  }
});

test("private-file integrity is enforced by MySQL logical preflight before the import phase", async t => {
  const f = await logicalFixture(t, MYSQL_SCHEMA_VERSION), full = await fixture(t);
  const m = await manifest(f.logical), fullManifest = await manifest(full.source);
  m.privateFiles = fullManifest.privateFiles;
  for (const root of m.privateFiles.roots) await fs.cp(path.join(full.source, root), path.join(f.logical, root), { recursive: true });
  await fs.writeFile(path.join(f.logical, "manifest.json"), JSON.stringify(m));
  assert.equal((await inspectMySqlLogicalBackup(f.logical)).report.privateFiles.files, 6);
  await fs.appendFile(path.join(f.logical, m.privateFiles.files[0].path), "tampered");
  await assert.rejects(inspectMySqlLogicalBackup(f.logical), { code: "PRIVATE_BACKUP_FILE_MISMATCH" });
});

test("legacy data without private roots keeps the original online snapshot behavior", async t => {
  const f = await fixture(t, { privateFiles: false }), lease = acquirePlatformInstanceLeaseSync(f.data);
  try { const backup = await createBackup({ env: { DATA_DIR: f.data, BACKUP_DIR: f.backups } }); assert.equal((await manifest(backup.destination)).privateFiles, undefined); lease.assertOwned(); } finally { lease.releaseSync(); }
});

test("indexed and legacy whole releases preserve historical originals absent from current document rows", async t => {
  for (const indexed of [true, false]) {
    const f = await fixture(t);
    const { randomUUID } = await import("node:crypto");
    const { digest } = await import("../server/builder-lifecycle-schema.mjs");
    const { attachReleaseBlobIndex } = await import("../server/release-blob-references.mjs");
    const slug = "historical-backup", id = randomUUID(), documentId = randomUUID(), storageKey = randomUUID() + ".bin";
    const body = Buffer.from("synthetic historical knowledge original");
    const snapshot = { format: "doctor-agent-release", schemaVersion: 1, id, agentSlug: slug, agent: { slug },
      contents: [], chunks: [], documents: [{ id: documentId, agentSlug: slug, revision: 1,
        storageKey, size: body.length, checksum: createHash("sha256").update(body).digest("hex") }] };
    const descriptor = { id, version: 1, publishedAt: new Date().toISOString(), sha256: digest(snapshot) };
    await fs.mkdir(path.join(f.data, "builder-releases", slug), { recursive: true });
    await fs.writeFile(path.join(f.data, "builder-releases", slug, id + ".json"), JSON.stringify(snapshot), { mode: 0o600 });
    await fs.writeFile(path.join(f.data, "uploads", storageKey), body, { mode: 0o600 });
    const db = new PlatformDatabase({ dataDir: f.data, seedDoctors: [] });
    try { await db.setMeta("t.fixture:builder.releases." + slug, JSON.stringify([indexed ? attachReleaseBlobIndex(slug, descriptor, snapshot) : descriptor])); }
    finally { db.close(); }
    const backup = await createBackup({ env: { DATA_DIR: f.data, BACKUP_DIR: f.backups } });
    assert.equal(backup.documents, 0);
    assert.equal(backup.blobs, 1);
    const inspected = inspectSqliteSnapshot(backup.destination);
    assert.equal(inspected.internal.blobReferences.size, 1);
    const target = path.join(f.dir, "historical-restored");
    assert.equal((await restoreBackup({ sourceDirectory: backup.destination, dataDirectory: target })).blobs, 1);
    assert.deepEqual(await fs.readFile(path.join(target, "uploads", storageKey)), body);
  }
});
