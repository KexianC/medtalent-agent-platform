import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PlatformDatabase } from "../server/database.mjs";
import { createAuth, verifyPassword } from "../server/auth.mjs";
import { acquireBlobMaintenanceLease, acquirePlatformInstanceLeaseSync, BLOB_MAINTENANCE_LOCK } from "../server/file-lease.mjs";
import { createBackup } from "../scripts/backup.mjs";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../", import.meta.url));

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medtalent-ops-test-"));
  const dataDir = path.join(directory, "data");
  const backupDir = path.join(directory, "backups");
  const database = new PlatformDatabase({ dataDir, seedDoctors: [{ slug: "ops-agent", name: "运维测试", department: "测试", specialty: "测试资料" }] });
  await createAuth(database, {});
  const documentId = randomUUID();
  const storageKey = `${randomUUID()}.bin`;
  await fs.mkdir(path.join(dataDir, "uploads"));
  await fs.writeFile(path.join(dataDir, "uploads", storageKey), "运维备份测试原件", "utf8");
  database.saveEntity("documents", { id: documentId, agentSlug: "ops-agent", storageKey, name: "测试.txt", status: "ready", approved: true });
  t.after(async () => {
    database.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("medtalent-ops-test-")) await fs.rm(directory, { recursive: true, force: true });
  });
  const env = { ...process.env, NODE_ENV: "test", DATA_DIR: dataDir, BACKUP_DIR: backupDir };
  return { directory, dataDir, backupDir, database, env, documentId, storageKey };
}

async function forceLeaseReplacement(lockPath, token) {
  const entries = await fs.readdir(lockPath);
  for (const entry of entries.filter((name) => name.startsWith(".owner-"))) await fs.unlink(path.join(lockPath, entry));
  await fs.rmdir(lockPath);
  await fs.mkdir(lockPath);
  const ownerPath = path.join(lockPath, `.owner-${token}`);
  await fs.writeFile(ownerPath, JSON.stringify({ version: 1, token }));
  return ownerPath;
}

test("backup produces a restorable SQLite snapshot and exactly its referenced document blobs", async (t) => {
  const f = await setup(t);
  await fs.writeFile(path.join(f.dataDir, "uploads", `${randomUUID()}.bin`), "不被数据库引用的临时文件");
  const result = await execute(process.execPath, [path.join(project, "scripts/backup.mjs")], { cwd: project, env: f.env });
  assert.match(result.stdout, /完整备份已创建/);
  const entries = await fs.readdir(f.backupDir);
  assert.equal(entries.length, 1);
  const snapshotDir = path.join(f.backupDir, entries[0]);
  const manifest = JSON.parse(await fs.readFile(path.join(snapshotDir, "manifest.json"), "utf8"));
  assert.equal(manifest.completed, true);
  assert.equal(manifest.documents, 1);
  assert.deepEqual((await fs.readdir(snapshotDir)).sort(), ["manifest.json", "platform.sqlite", "uploads"]);
  assert.deepEqual(await fs.readdir(path.join(snapshotDir, "uploads")), [f.storageKey]);
  const restoredDir = path.join(f.directory, "restored");
  await fs.cp(snapshotDir, restoredDir, { recursive: true, errorOnExist: true, force: false });
  const restored = new DatabaseSync(path.join(restoredDir, "platform.sqlite"), { readOnly: true });
  assert.equal(String(Object.values(restored.prepare("PRAGMA journal_mode").get())[0]).toLowerCase(), "delete");
  assert.equal(restored.prepare("SELECT COUNT(*) total FROM agents").get().total, 1);
  assert.equal(restored.prepare("SELECT id FROM documents").get().id, f.documentId);
  restored.close();
  assert.deepEqual((await fs.readdir(restoredDir)).sort(), ["manifest.json", "platform.sqlite", "uploads"]);
  assert.equal(await fs.readFile(path.join(restoredDir, "uploads", f.storageKey), "utf8"), "运维备份测试原件");
});

test("backup preserves soft-deleted metadata without requiring a retired blob", async (t) => {
  const f = await setup(t);
  f.database.saveEntity("documents", {
    id: randomUUID(), agentSlug: "ops-agent", storageKey: null, name: "已删除.txt", size: 12,
    status: "deleted", approved: false, deletedAt: new Date().toISOString(),
  });
  const result = await execute(process.execPath, [path.join(project, "scripts/backup.mjs")], { cwd: project, env: f.env });
  assert.match(result.stdout, /完整备份已创建/);
  const [entry] = await fs.readdir(f.backupDir);
  const snapshotDir = path.join(f.backupDir, entry);
  const manifest = JSON.parse(await fs.readFile(path.join(snapshotDir, "manifest.json"), "utf8"));
  assert.equal(manifest.documents, 2);
  assert.equal(manifest.blobs, 1);
  assert.deepEqual(await fs.readdir(path.join(snapshotDir, "uploads")), [f.storageKey]);
  const snapshot = new DatabaseSync(path.join(snapshotDir, "platform.sqlite"), { readOnly: true });
  assert.equal(snapshot.prepare("SELECT COUNT(*) total FROM documents").get().total, 2);
  snapshot.close();
});

test("incomplete backup never receives a successful manifest marker", async (t) => {
  const f = await setup(t);
  await fs.unlink(path.join(f.dataDir, "uploads", f.storageKey));
  await assert.rejects(execute(process.execPath, [path.join(project, "scripts/backup.mjs")], { cwd: project, env: f.env }));
  const entries = await fs.readdir(f.backupDir);
  assert.equal(entries.length, 1);
  await assert.rejects(fs.access(path.join(f.backupDir, entries[0], "manifest.json")));
});

test("a backup that loses its maintenance lease cannot publish a completed manifest", async (t) => {
  const f = await setup(t);
  const lockPath = path.join(f.dataDir, BLOB_MAINTENANCE_LOCK);
  let ownerPath;
  let replaced = false;
  const fileSystem = Object.create(fs);
  fileSystem.copyFile = async (...arguments_) => {
    await fs.copyFile(...arguments_);
    if (!replaced) {
      replaced = true;
      ownerPath = await forceLeaseReplacement(lockPath, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    }
  };

  await assert.rejects(createBackup({ env: f.env, fileSystem }), { code: "LEASE_COMPROMISED" });
  const entries = await fs.readdir(f.backupDir);
  assert.equal(entries.length, 1);
  await assert.rejects(fs.access(path.join(f.backupDir, entries[0], "manifest.json")));
  assert.equal((await fs.stat(lockPath)).isDirectory(), true, "old release must preserve the replacement lease");
  assert.equal(JSON.parse(await fs.readFile(ownerPath, "utf8")).token, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  await fs.unlink(ownerPath);
  await fs.rmdir(lockPath);
});

test("backup publishes its completed manifest only after maintenance lease release succeeds", async (t) => {
  const f = await setup(t);
  const lockPath = path.join(f.dataDir, BLOB_MAINTENANCE_LOCK);
  const replacementToken = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let ownerPath;
  let manifestExistedAtRelease = false;
  let temporaryManifestExistedAtRelease = false;
  const acquireAtRelease = async (...arguments_) => {
    const lease = await acquireBlobMaintenanceLease(...arguments_);
    return {
      assertOwned: () => lease.assertOwned(),
      release: async () => {
        const [destination] = await fs.readdir(f.backupDir);
        const entries = await fs.readdir(path.join(f.backupDir, destination));
        manifestExistedAtRelease = entries.includes("manifest.json");
        temporaryManifestExistedAtRelease = entries.some((entry) => /^\.manifest-.*\.tmp$/.test(entry));
        ownerPath = await forceLeaseReplacement(lockPath, replacementToken);
        return lease.release();
      },
    };
  };

  await assert.rejects(createBackup({ env: f.env, acquireMaintenanceLease: acquireAtRelease }), { code: "LEASE_COMPROMISED" });
  assert.equal(manifestExistedAtRelease, false);
  assert.equal(temporaryManifestExistedAtRelease, true);
  const [destination] = await fs.readdir(f.backupDir);
  await assert.rejects(fs.access(path.join(f.backupDir, destination, "manifest.json")));
  assert.equal((await fs.readdir(path.join(f.backupDir, destination))).some((entry) => /^\.manifest-.*\.tmp$/.test(entry)), false);
  assert.equal(JSON.parse(await fs.readFile(ownerPath, "utf8")).token, replacementToken);
  await fs.unlink(ownerPath);
  await fs.rmdir(lockPath);
});

test("backup reports marker cleanup failures together with the release failure", async (t) => {
  const f = await setup(t);
  const cleanupFailure = Object.assign(new Error("marker cleanup denied"), { code: "EACCES" });
  const releaseFailure = Object.assign(new Error("lease lost while releasing"), { code: "LEASE_COMPROMISED" });
  const fileSystem = Object.create(fs);
  fileSystem.unlink = async (target) => {
    if (/^\.manifest-.*\.tmp$/.test(path.basename(target))) throw cleanupFailure;
    return fs.unlink(target);
  };
  const acquireFailingRelease = async (...arguments_) => {
    const lease = await acquireBlobMaintenanceLease(...arguments_);
    return {
      assertOwned: () => lease.assertOwned(),
      release: async () => {
        await lease.release();
        throw releaseFailure;
      },
    };
  };

  let failure;
  try { await createBackup({ env: f.env, fileSystem, acquireMaintenanceLease: acquireFailingRelease }); }
  catch (error) { failure = error; }
  assert.equal(failure instanceof AggregateError, true);
  assert.deepEqual(failure.errors.map((error) => error.code), ["LEASE_COMPROMISED", "EACCES"]);
});

test("admin reset changes only the named admin password, revokes sessions and never prints it", async (t) => {
  const f = await setup(t);
  const user = f.database.sqlite.prepare("SELECT id,password_hash FROM users WHERE username='admin'").get();
  f.database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('synthetic-token',?,?)").run(user.id, "2099-01-01T00:00:00.000Z");
  const password = "unique-ops-test-password-9347";
  const result = await execute(process.execPath, [path.join(project, "scripts/reset-admin.mjs")], { cwd: project,
    env: { ...f.env, RESET_ADMIN_USERNAME: "admin", RESET_ADMIN_PASSWORD: password } });
  assert.equal(result.stdout.includes(password), false);
  const updated = f.database.sqlite.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id);
  assert.equal(verifyPassword(password, updated.password_hash), true);
  assert.equal(verifyPassword("dev-admin-password", updated.password_hash), false);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM sessions").get().total, 0);
  await assert.rejects(execute(process.execPath, [path.join(project, "scripts/reset-admin.mjs")], { cwd: project,
    env: { ...f.env, RESET_ADMIN_USERNAME: "does-not-exist", RESET_ADMIN_PASSWORD: password } }));
});

test("admin reset refuses an active platform instance without changing credentials or sessions", async (t) => {
  const f = await setup(t);
  const user = f.database.sqlite.prepare("SELECT id,password_hash FROM users WHERE username='admin'").get();
  f.database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('active-platform-session',?,?)")
    .run(user.id, "2099-01-01T00:00:00.000Z");
  const instanceLease = acquirePlatformInstanceLeaseSync(f.dataDir);
  let failure;
  try {
    await execute(process.execPath, [path.join(project, "scripts/reset-admin.mjs")], { cwd: project,
      env: { ...f.env, RESET_ADMIN_USERNAME: "admin", RESET_ADMIN_PASSWORD: "blocked-reset-password-9347" } });
  } catch (error) { failure = error; }
  finally { instanceLease.releaseSync(); }

  assert.ok(failure);
  assert.match(failure.stderr, /DATA_DIR .*请停止重复实例/);
  assert.equal(f.database.sqlite.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id).password_hash, user.password_hash);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM sessions WHERE user_id=?").get(user.id).total, 1);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM audit WHERE action='user.password_reset'").get().total, 0);
});
