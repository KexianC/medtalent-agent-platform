import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs, mkdirSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPlatformApp } from "./app.mjs";
import { PLATFORM_INSTANCE_LOCK } from "./file-lease.mjs";

const seed = { slug: "lease-agent", name: "租约测试", department: "测试", specialty: "平台生命周期" };
const ownerPathFor = (lockPath, token) => path.join(lockPath, `.owner-${token}`);

async function directoryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-lifecycle-"));
  const dataDir = path.join(root, "data");
  const servers = new Set();
  const platforms = new Set();
  t.after(async () => {
    try {
      await closeAll(servers, closeServer);
    } finally {
      try { await closeAll(platforms, platform => platform.close()); }
      finally {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith("agent-platform-lifecycle-"));
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
  return { root, dataDir, servers, platforms };
}

async function closeAll(resources, close) {
  const results = await Promise.allSettled([...resources].map(close));
  const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, "Lifecycle fixture cleanup failed");
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function createFixturePlatform(fixture, options) {
  const platform = await createPlatformApp(options);
  fixture.platforms.add(platform);
  return platform;
}

function takeoverInstanceLease(dataDir, token) {
  const lockPath = path.join(dataDir, PLATFORM_INSTANCE_LOCK);
  for (const entry of readdirSync(lockPath).filter((name) => name.startsWith(".owner-"))) unlinkSync(path.join(lockPath, entry));
  rmdirSync(lockPath);
  mkdirSync(lockPath);
  writeFileSync(ownerPathFor(lockPath, token), JSON.stringify({ version: 1, token }));
  return lockPath;
}

function inspectDatabase(dataDir, callback) {
  const database = new DatabaseSync(path.join(dataDir, "platform.sqlite"), { readOnly: true });
  try { return callback(database); }
  finally { database.close(); }
}

async function listen(fixture, platform) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const server = await new Promise((resolve, reject) => {
      const instance = platform.app.listen(0, "127.0.0.1", () => resolve(instance));
      fixture.servers.add(instance);
      instance.once("error", reject);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      // Windows can assign a random port (such as 10080) that Fetch forbids.
      // Probe a public route before any login or lease takeover has side effects.
      const response = await fetch(`${origin}/api/health`, {
        method: "HEAD", headers: { connection: "close" }, signal: AbortSignal.timeout(2_000),
      });
      await response.arrayBuffer();
      return { origin, server };
    } catch (error) {
      await closeServer(server);
      fixture.servers.delete(server);
      if (error.cause?.message !== "bad port") throw error;
    }
  }
  throw new Error("Could not select a local port allowed by Node Fetch");
}

test("a second platform instance cannot share a live DATA_DIR and normal close releases it", async (t) => {
  const f = await directoryFixture(t);
  const first = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [seed], startWorker: false, disableRateLimits: true, env: {} });
  await assert.rejects(
    () => createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [seed], startWorker: false, disableRateLimits: true, env: {} }),
    { code: "PLATFORM_INSTANCE_LOCKED" },
  );
  assert.equal(first.database.listAgents().length, 1);
  await first.close();

  const replacement = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [seed], startWorker: false, disableRateLimits: true, env: {} });
  assert.equal(replacement.database.listAgents().length, 1);
  await replacement.close();
});

test("platform startup recovers a crashed instance lease only after it is stale", async (t) => {
  const f = await directoryFixture(t);
  await fs.mkdir(f.dataDir, { recursive: true });
  const lockPath = path.join(f.dataDir, PLATFORM_INSTANCE_LOCK);
  await fs.mkdir(lockPath);
  await fs.writeFile(ownerPathFor(lockPath, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"), JSON.stringify({ version: 1, token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }));
  const staleTime = new Date(Date.now() - 10_000);
  await fs.utimes(lockPath, staleTime, staleTime);

  const platform = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [seed], startWorker: false, disableRateLimits: true,
    env: {}, instanceLeaseOptions: { staleMs: 2_000, updateMs: 1_000 } });
  assert.notEqual(platform.instanceLease.token, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(platform.database.listAgents().length, 1);
  await platform.close();
});

test("schema initialization rolls back and closes when the instance lease is taken over mid-mutation", async (t) => {
  const f = await directoryFixture(t);
  const replacementToken = "11111111-1111-4111-8111-111111111111";

  await assert.rejects(() => createFixturePlatform(f, {
    dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {},
    testHooks: { beforeSchemaMutation: () => takeoverInstanceLease(f.dataDir, replacementToken) },
  }), { code: "LEASE_COMPROMISED" });

  inspectDatabase(f.dataDir, (database) => {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('meta','users','sessions')").all();
    assert.deepEqual(tables, []);
  });
  assert.equal(JSON.parse(await fs.readFile(ownerPathFor(path.join(f.dataDir, PLATFORM_INSTANCE_LOCK), replacementToken), "utf8")).token, replacementToken);
});

test("restart recovery rolls back when the instance lease is taken over before recovery writes", async (t) => {
  const f = await directoryFixture(t);
  const initial = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {} });
  initial.database.transaction(() => {
    initial.database.sqlite.prepare(`INSERT INTO jobs(id,type,status,payload,run_after,created_at,started_at)
      VALUES('recovery-job','test','running','{}',?,?,?)`).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    initial.database.sqlite.prepare(`INSERT INTO sync_runs(id,source_id,job_id,status,stats,started_at)
      VALUES('recovery-run','source','recovery-job','running','{}',?)`).run("2026-01-01T00:00:00.000Z");
  });
  await initial.close();

  const replacementToken = "22222222-2222-4222-8222-222222222222";
  let unexpectedPlatform;
  try {
    await assert.rejects(async () => {
      unexpectedPlatform = await createFixturePlatform(f, {
        dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {},
        testHooks: { beforeRecoveryMutation: () => takeoverInstanceLease(f.dataDir, replacementToken) },
      });
    }, { code: "LEASE_COMPROMISED" });
  } finally {
    await unexpectedPlatform?.close();
  }

  inspectDatabase(f.dataDir, (database) => {
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id='recovery-job'").get().status, "running");
    assert.equal(database.prepare("SELECT status FROM sync_runs WHERE id='recovery-run'").get().status, "running");
  });
  assert.equal(JSON.parse(await fs.readFile(ownerPathFor(path.join(f.dataDir, PLATFORM_INSTANCE_LOCK), replacementToken), "utf8")).token, replacementToken);
});

test("admin bootstrap rolls back when the instance lease is taken over before the user write", async (t) => {
  const f = await directoryFixture(t);
  const replacementToken = "33333333-3333-4333-8333-333333333333";

  await assert.rejects(() => createFixturePlatform(f, {
    dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {},
    testHooks: { beforeBootstrapMutation: () => takeoverInstanceLease(f.dataDir, replacementToken) },
  }), { code: "LEASE_COMPROMISED" });

  inspectDatabase(f.dataDir, (database) => {
    assert.equal(database.prepare("SELECT COUNT(*) total FROM users").get().total, 0);
    assert.equal(database.prepare("SELECT COUNT(*) total FROM audit WHERE action='user.bootstrap'").get().total, 0);
  });
  assert.equal(JSON.parse(await fs.readFile(ownerPathFor(path.join(f.dataDir, PLATFORM_INSTANCE_LOCK), replacementToken), "utf8")).token, replacementToken);
});

test("login takeover after password verification returns 503 without a cookie or residual session", async (t) => {
  const f = await directoryFixture(t);
  const replacementToken = "44444444-4444-4444-8444-444444444444";
  const platform = await createFixturePlatform(f, {
    dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {},
    testHooks: { beforeLoginSessionMutation: () => takeoverInstanceLease(f.dataDir, replacementToken) },
  });
  const { origin } = await listen(f, platform);

  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "dev-admin-password" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "PLATFORM_INSTANCE_LEASE_LOST");
  assert.equal(response.headers.get("set-cookie"), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(platform.database.closed, true);
  inspectDatabase(f.dataDir, (database) => {
    assert.equal(database.prepare("SELECT COUNT(*) total FROM sessions").get().total, 0);
    assert.equal(database.prepare("SELECT COUNT(*) total FROM audit WHERE action='auth.login'").get().total, 0);
  });
});

test("logout takeover rolls back the deletion and does not clear the client cookie", async (t) => {
  const f = await directoryFixture(t);
  const replacementToken = "55555555-5555-4555-8555-555555555555";
  let armed = false;
  const platform = await createFixturePlatform(f, {
    dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {},
    testHooks: { beforeLogoutSessionMutation: () => { if (armed) takeoverInstanceLease(f.dataDir, replacementToken); } },
  });
  const { origin } = await listen(f, platform);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "dev-admin-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  armed = true;

  const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie } });
  assert.equal(logout.status, 503);
  assert.equal((await logout.json()).code, "PLATFORM_INSTANCE_LEASE_LOST");
  assert.equal(logout.headers.get("set-cookie"), null);
  await new Promise((resolve) => setImmediate(resolve));
  inspectDatabase(f.dataDir, (database) => {
    assert.equal(database.prepare("SELECT COUNT(*) total FROM sessions").get().total, 1);
  });
});

test("a transaction closed by the lease shutdown path preserves the closed error and rolls back", async (t) => {
  const f = await directoryFixture(t);
  const platform = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [], startWorker: false, disableRateLimits: true, env: {} });

  assert.throws(() => platform.database.transaction(() => {
    platform.database.sqlite.prepare(`INSERT INTO audit(id,action,actor,created_at)
      VALUES('closed-transaction','test.closed','test','2026-01-01T00:00:00.000Z')`).run();
    platform.database.close();
  }), { code: "PLATFORM_DATA_CLOSED" });

  inspectDatabase(f.dataDir, (database) => {
    assert.equal(database.prepare("SELECT COUNT(*) total FROM audit WHERE id='closed-transaction'").get().total, 0);
  });
});

test("a compromised instance stops writes, returns safe 503 and closes idempotently without removing the new owner", async (t) => {
  const f = await directoryFixture(t);
  const platform = await createFixturePlatform(f, { dataDir: f.dataDir, seedDoctors: [seed], startWorker: false, disableRateLimits: true, env: {} });
  const { origin, server } = await listen(f, platform);

  const replacementToken = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  takeoverInstanceLease(f.dataDir, replacementToken);
  const replacementOwnerPath = ownerPathFor(platform.instanceLease.lockPath, replacementToken);

  await assert.rejects(platform.knowledge.storeDocument({
    agentSlug: seed.slug, name: "blocked.txt", buffer: Buffer.from("must not be written"),
  }), { code: "LEASE_COMPROMISED" });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(platform.database.closed, true);
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await response.json()).code, "PLATFORM_INSTANCE_LEASE_LOST");

  await closeServer(server);
  await platform.close();
  await platform.close();
  assert.equal((await fs.stat(platform.instanceLease.lockPath)).isDirectory(), true);
  assert.equal(JSON.parse(await fs.readFile(replacementOwnerPath, "utf8")).token, replacementToken);
});
