import test from "node:test";
import assert from "node:assert/strict";
import fileSystem, { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireLease, acquireLeaseSync } from "./file-lease.mjs";

async function fixture(t, name) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `agent-platform-${name}-`));
  const resourcePath = path.join(directory, "resource");
  const lockPath = path.join(directory, "resource.lock");
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return { directory, resourcePath, lockPath, legacyOwnerPath: `${lockPath}.owner` };
}

test("a crashed stale lease is recovered with a new unique owner token", async (t) => {
  const f = await fixture(t, "stale-lease");
  const staleToken = "00000000-0000-4000-8000-000000000000";
  await fs.mkdir(f.lockPath);
  await fs.writeFile(f.legacyOwnerPath, JSON.stringify({ version: 1, token: staleToken }));
  const staleTime = new Date(Date.now() - 10_000);
  await fs.utimes(f.lockPath, staleTime, staleTime);

  const lease = await acquireLease({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约", staleMs: 2_000, updateMs: 1_000 });
  try {
    assert.notEqual(lease.token, staleToken);
    assert.equal(lease.assertOwned(), true);
    assert.notEqual(lease.ownerPath, f.legacyOwnerPath);
    assert.equal(JSON.parse(await fs.readFile(lease.ownerPath, "utf8")).token, lease.token);
  } finally { await lease.release(); }
  await assert.rejects(fs.access(f.lockPath));
  await assert.rejects(fs.access(lease.ownerPath));
});

test("no-replace acquisition preserves a live legacy empty lock directory", async (t) => {
  const f = await fixture(t, "legacy-live-lease");
  const legacyToken = "11111111-1111-4111-8111-111111111111";
  await fs.mkdir(f.lockPath);
  await fs.writeFile(f.legacyOwnerPath, JSON.stringify({ version: 1, token: legacyToken }));

  // On POSIX, rename(stagingDirectory, emptyLegacyDirectory) may replace the
  // destination. Emulate that behavior on Windows so a staging-based publish
  // cannot silently pass this compatibility regression.
  const originalRenameSync = fileSystem.renameSync;
  const originalRmdirSync = fileSystem.rmdirSync;
  fileSystem.renameSync = function posixDirectoryReplace(source, target) {
    if (path.resolve(target) === path.resolve(f.lockPath)) originalRmdirSync(f.lockPath);
    return originalRenameSync.call(this, source, target);
  };
  let unexpectedLease;
  let acquisitionError;
  try {
    unexpectedLease = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约",
      staleMs: 2_000, updateMs: 1_000 });
  } catch (error) { acquisitionError = error; }
  finally { fileSystem.renameSync = originalRenameSync; }

  if (unexpectedLease) unexpectedLease.releaseSync();
  assert.equal(acquisitionError?.code, "LEASE_BUSY");
  assert.equal((await fs.stat(f.lockPath)).isDirectory(), true);
  assert.equal(JSON.parse(await fs.readFile(f.legacyOwnerPath, "utf8")).token, legacyToken);
  await fs.rmdir(f.lockPath);
  await fs.unlink(f.legacyOwnerPath);
});

test("a live heartbeat remains exclusive after the stale interval", async (t) => {
  const f = await fixture(t, "live-lease");
  const first = await acquireLease({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约", staleMs: 2_000, updateMs: 1_000 });
  try {
    await delay(2_300);
    assert.equal(first.assertOwned(), true);
    await assert.rejects(
      acquireLease({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约", staleMs: 2_000, updateMs: 1_000 }),
      { code: "LEASE_BUSY" },
    );
  } finally { await first.release(); }
});

test("birthtime drift on a filesystem fallback does not invalidate the owner", async (t) => {
  const f = await fixture(t, "birthtime-fallback");
  const lease = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约",
    staleMs: 2_000, updateMs: 1_000 });
  const originalStatSync = fileSystem.statSync;
  fileSystem.statSync = function statWithDriftingBirthtime(target, ...arguments_) {
    const stat = originalStatSync.call(this, target, ...arguments_);
    if (path.resolve(target) !== path.resolve(f.lockPath)) return stat;
    return new Proxy(stat, {
      get(record, property, receiver) {
        if (property === "birthtimeMs") return record.birthtimeMs + 5_000;
        return Reflect.get(record, property, receiver);
      },
    });
  };

  try {
    await delay(1_100);
    assert.equal(lease.assertOwned(), true);
    await assert.rejects(
      acquireLease({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约", staleMs: 2_000, updateMs: 1_000 }),
      { code: "LEASE_BUSY" },
    );
  }
  finally {
    fileSystem.statSync = originalStatSync;
    lease.releaseSync();
  }
});

test("a replaced lease fails closed and its old release cannot remove the new owner", async (t) => {
  const f = await fixture(t, "lost-lease");
  let compromised = 0;
  const first = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约",
    staleMs: 2_000, updateMs: 1_000, onCompromised: () => { compromised += 1; } });
  await fs.unlink(first.ownerPath);
  await fs.rmdir(f.lockPath);
  await fs.mkdir(f.lockPath);
  const replacementToken = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const replacementOwnerPath = path.join(f.lockPath, `.owner-${replacementToken}`);
  await fs.writeFile(replacementOwnerPath, JSON.stringify({ version: 1, token: replacementToken }));

  assert.throws(() => first.assertOwned(), { code: "LEASE_COMPROMISED" });
  assert.equal(compromised, 1);
  assert.throws(() => first.releaseSync(), { code: "LEASE_COMPROMISED" });
  assert.equal((await fs.stat(f.lockPath)).isDirectory(), true);
  assert.equal(JSON.parse(await fs.readFile(replacementOwnerPath, "utf8")).token, replacementToken);
  await fs.unlink(replacementOwnerPath);
  await fs.rmdir(f.lockPath);
});

test("a synchronous old wrapper cannot unlink or stop a same-process replacement lease", async (t) => {
  const f = await fixture(t, "sync-release-race");
  const first = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约",
    staleMs: 2_000, updateMs: 1_000 });
  const originalUnlinkSync = fileSystem.unlinkSync;
  const originalRmdirSync = fileSystem.rmdirSync;
  let replacement;

  fileSystem.unlinkSync = function unlinkWithReplacement(target, ...arguments_) {
    if (!replacement && path.resolve(target) === path.resolve(first.ownerPath)) {
      // Deterministically install a new owner after the old marker is removed
      // but before the old wrapper attempts to remove the shared directory.
      fileSystem.unlinkSync = originalUnlinkSync;
      originalUnlinkSync.call(this, target, ...arguments_);
      originalRmdirSync(f.lockPath);
      replacement = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "替代租约",
        staleMs: 2_000, updateMs: 1_000 });
      return;
    }
    return originalUnlinkSync.call(this, target, ...arguments_);
  };

  try { assert.throws(() => first.releaseSync(), { code: "LEASE_COMPROMISED" }); }
  finally { fileSystem.unlinkSync = originalUnlinkSync; }
  assert.ok(replacement, "the replacement must be installed inside the owner-cleanup window");
  assert.notEqual(first.ownerPath, replacement.ownerPath, "owner sidecars must be token-specific");
  assert.equal(JSON.parse(await fs.readFile(replacement.ownerPath, "utf8")).token, replacement.token);
  assert.throws(
    () => acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "第三租约", staleMs: 2_000, updateMs: 1_000 }),
    { code: "LEASE_BUSY" },
  );

  // The old proper-lockfile wrapper must not cancel the replacement's update
  // timer or delete its in-process bookkeeping.
  await delay(2_300);
  assert.equal(replacement.assertOwned(), true);
  replacement.releaseSync();
  await assert.rejects(fs.access(f.lockPath));
  await assert.rejects(fs.access(replacement.ownerPath));
});

test("an asynchronous old wrapper propagates ownership loss without releasing its replacement", async (t) => {
  const f = await fixture(t, "async-release-race");
  const first = await acquireLease({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "测试租约",
    staleMs: 2_000, updateMs: 1_000 });
  const originalUnlink = fileSystem.unlink;
  const originalRmdirSync = fileSystem.rmdirSync;
  let replacement;

  fileSystem.unlink = function unlinkWithReplacement(target, callback) {
    if (!replacement && path.resolve(target) === path.resolve(first.ownerPath)) {
      fileSystem.unlink = originalUnlink;
      return originalUnlink.call(this, target, (unlinkError) => {
        if (unlinkError) return callback(unlinkError);
        originalRmdirSync(f.lockPath);
        replacement = acquireLeaseSync({ resourcePath: f.resourcePath, lockPath: f.lockPath, kind: "替代租约",
          staleMs: 2_000, updateMs: 1_000 });
        callback(null);
      });
    }
    return originalUnlink.call(this, target, callback);
  };

  try { await assert.rejects(first.release(), { code: "LEASE_COMPROMISED" }); }
  finally { fileSystem.unlink = originalUnlink; }
  assert.ok(replacement);
  assert.equal(replacement.assertOwned(), true);
  assert.equal(JSON.parse(await fs.readFile(replacement.ownerPath, "utf8")).token, replacement.token);
  replacement.releaseSync();
  await assert.rejects(fs.access(f.lockPath));
  await assert.rejects(fs.access(replacement.ownerPath));
});
