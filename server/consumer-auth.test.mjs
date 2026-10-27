import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlatformApp } from "./app.mjs";
import { doctorProfiles } from "../src/data/doctorProfiles.ts";
import { ConsumerStore } from "./consumer-store.mjs";
import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { createMySqlBackup } from "../scripts/backup-mysql.mjs";
import { verifyLocalMySqlBackup } from "../scripts/verify-local-mysql-backup.mjs";
import { restoreMySqlBackup } from "../scripts/restore-mysql-backup.mjs";

const env = { WECHAT_APP_ID: "wx7a4c71565eeee4b9", WECHAT_APP_SECRET: "test-only-consumer-secret" };
const doctor = doctorProfiles.find(item => item.slug === "tang-jinsong");

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medtalent-consumer-test-"));
  // Opt-in isolated local MySQL acceptance; never load project/server secrets.
  let mysqlAdmin;
  const mysqlName = `consumer_qa_${randomBytes(8).toString("hex")}`;
  const mysqlEnv = {};
  if (process.env.CONSUMER_MYSQL_QA_PORT === "33129") {
    mysqlAdmin = await mysql.createConnection({ host: "127.0.0.1", port: 33129, user: "root" });
    await mysqlAdmin.query(`CREATE DATABASE ${mysqlName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await mysqlAdmin.query("CREATE USER IF NOT EXISTS 'consumerqa'@'127.0.0.1' IDENTIFIED BY 'isolated-test-password'");
    await mysqlAdmin.query(`GRANT ALL ON ${mysqlName}.* TO 'consumerqa'@'127.0.0.1'`);
    Object.assign(mysqlEnv, { DATABASE_URL: `mysql://consumerqa:isolated-test-password@127.0.0.1:33129/${mysqlName}`, MYSQL_SSL_MODE: "disabled" });
  }
  let platform;
  let server;
  let origin;
  let calls = 0;
  async function stop() {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await platform?.close();
  }
  async function start() {
    platform = await createPlatformApp({ dataDir: directory, env: { ...env, ...mysqlEnv, ...options.env }, seedDoctors: options.seedDoctors || [doctor], startWorker: false, disableRateLimits: true,
      fetchImpl: async (url, request) => {
        calls++;
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://api.weixin.qq.com");
        assert.equal(parsed.pathname, "/sns/jscode2session");
        assert.equal(request.redirect, "error");
        const code = parsed.searchParams.get("js_code");
        if (options.provider) return options.provider(code);
        if (code === "bad-code") return Response.json({ errcode: 40029, errmsg: "SECRET-provider-details", session_key: "must-not-escape" });
        return Response.json({ openid: code.startsWith("other") ? "openid-other" : "openid-same", session_key: "must-not-escape", unionid: "unused-unionid" });
      } });
    server = platform.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  await start();
  t.after(async () => {
    await stop();
    if (mysqlAdmin) {
      assert.match(mysqlName, /^consumer_qa_[a-f0-9]{16}$/);
      await mysqlAdmin.query(`DROP DATABASE ${mysqlName}`);
      await mysqlAdmin.end();
    }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("medtalent-consumer-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const client = () => {
    const state = { cookie: "", csrf: "" };
    return Object.assign(state, { async request(route, method = "GET", body, extra = {}) {
      const response = await fetch(`${origin}${route}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), Cookie: state.cookie, "x-csrf-token": state.csrf, ...extra }, body: body ? JSON.stringify(body) : undefined });
      const data = await response.json();
      if (response.headers.get("set-cookie")) state.cookie = response.headers.get("set-cookie").split(";", 1)[0];
      if (data.csrfToken) state.csrf = data.csrfToken;
      return { status: response.status, data, headers: response.headers };
    } });
  };
  async function begin(client) {
    assert.equal((await client.request("/api/wechat/session")).status, 200);
    const result = await client.request("/api/wechat/login", "POST", { returnPath: "/d/tang-jinsong/ask" });
    assert.equal(result.status, 200);
    return result.data;
  }
  async function complete(request, code) {
    return client().request("/api/wechat/login/complete", "POST", { requestId: request.requestId, bridgeToken: request.bridgeToken, code });
  }
  async function login(client, code) {
    const request = await begin(client);
    assert.deepEqual((await complete(request, code)).data, { ok: true });
    const result = await client.request("/api/wechat/login/consume", "POST", { requestId: request.requestId });
    assert.equal(result.status, 200);
    assert.equal(result.data.authenticated, true);
    assert.deepEqual(Object.keys(result.data.user).sort(), ["displayName", "id"]);
    return result.data.user;
  }
  return { client, begin, complete, login, directory, mysqlAdmin, mysqlEnv, get database() { return platform.database; }, get store() { return new ConsumerStore(platform.database); }, get calls() { return calls; }, restart: async () => { await stop(); await start(); } };
}

const documentPath = section => `/api/user/data/tang-jinsong/${section}`;

test("consumer login supports persistent cross-device data while isolating other WeChat accounts and administrators", async t => {
  const f = await fixture(t);
  const a = f.client(), b = f.client(), other = f.client();
  const user = await f.login(a, "same-device-a");
  assert.equal((await f.login(b, "same-device-b")).id, user.id);
  assert.notEqual((await f.login(other, "other-device")).id, user.id);
  assert.equal((await a.request(documentPath("profile-name"), "PUT", { value: "跨设备名字", expectedRevision: 0 })).status, 200);
  assert.equal((await b.request("/api/user/data/tang-jinsong")).data.documents[0].value, "跨设备名字");
  assert.deepEqual((await other.request("/api/user/data/tang-jinsong")).data.documents, []);
  assert.equal((await a.request("/api/admin/session")).status, 401);
  const admin = f.client();
  assert.equal((await admin.request("/api/auth/login", "POST", { username: "admin", password: "dev-admin-password" })).status, 200);
  assert.equal((await admin.request("/api/user/data/tang-jinsong")).status, 401);
  await f.restart();
  assert.equal((await b.request("/api/user/data/tang-jinsong")).data.documents[0].value, "跨设备名字");
});

test("consumer CSRF, bridge proof, initiator binding, rotation and replay are enforced", async t => {
  const f = await fixture(t);
  const a = f.client(), attacker = f.client();
  const session = await a.request("/api/wechat/session");
  assert.match(session.headers.get("set-cookie"), /HttpOnly/);
  assert.match(session.headers.get("set-cookie"), /SameSite=Lax/);
  assert.equal((await a.request("/api/wechat/login", "POST", { returnPath: "/" }, { "x-csrf-token": "" })).status, 403);
  assert.equal((await a.request("/api/wechat/login", "POST", { returnPath: "https://evil.test" })).status, 400);
  const request = await f.begin(a);
  assert.equal((await f.complete({ ...request, bridgeToken: "0".repeat(64) }, "same-code")).status, 409);
  assert.equal(f.calls, 0);
  await attacker.request("/api/wechat/session");
  assert.equal((await attacker.request("/api/wechat/login/consume", "POST", { requestId: request.requestId })).status, 409);
  assert.equal((await a.request("/api/wechat/login/consume", "POST", { requestId: request.requestId })).data.code, "LOGIN_PENDING");
  assert.equal((await f.complete(request, "same-code")).status, 200);
  assert.equal((await f.complete(request, "same-code")).status, 409);
  const oldCookie = a.cookie, oldCsrf = a.csrf;
  assert.equal((await a.request("/api/wechat/login/consume", "POST", { requestId: request.requestId })).status, 200);
  assert.notEqual(a.cookie, oldCookie);
  assert.notEqual(a.csrf, oldCsrf);
  assert.equal((await a.request("/api/user/data/tang-jinsong", "GET", undefined, { Cookie: oldCookie })).status, 401);
  assert.equal((await a.request("/api/wechat/login/consume", "POST", { requestId: request.requestId })).status, 409);
  const reused = await f.begin(attacker);
  assert.equal((await f.complete(reused, "same-code")).status, 409);
  assert.equal((await a.request(documentPath("profile-name"), "PUT", { value: "x", expectedRevision: 0 }, { "x-csrf-token": oldCsrf })).status, 403);
  assert.equal((await a.request("/api/wechat/logout", "POST")).status, 200);
  assert.equal((await a.request("/api/user/data/tang-jinsong")).status, 401);
});

test("CAS resolves concurrent devices, preserves tombstones and prevents stale chat resaving after opt-out", async t => {
  const f = await fixture(t);
  const a = f.client(), b = f.client();
  await f.login(a, "a-cas"); await f.login(b, "b-cas");
  const updates = await Promise.all([a.request(documentPath("profile-name"), "PUT", { value: "A", expectedRevision: 0 }), b.request(documentPath("profile-name"), "PUT", { value: "B", expectedRevision: 0 })]);
  assert.deepEqual(updates.map(x => x.status).sort(), [200, 409]);
  assert.equal(updates.find(x => x.status === 409).data.document.revision, 1);
  assert.equal((await a.request(documentPath("profile-name"), "PUT", { value: null, expectedRevision: 1 })).data.document.revision, 2);
  assert.equal((await b.request(documentPath("profile-name"), "PUT", { value: "stale", expectedRevision: 1 })).status, 409);
  for (const section of ["chat-messages", "chat-assessments-v1"]) assert.equal((await a.request(documentPath(section), "PUT", { value: [], expectedRevision: 0 })).status, 200);
  assert.equal((await a.request(documentPath("chat-messages"), "PUT", { value: [], expectedRevision: 1 })).status, 200);
  const privacyAck = await a.request(documentPath("privacy"), "PUT", { value: { saveChat: false, voicePlayback: true, reminders: true }, expectedRevision: 0 });
  assert.equal(privacyAck.status, 200);
  assert.deepEqual(privacyAck.data.relatedDocuments.map(({ section, value, revision }) => ({ section, value, revision })), [
    { section: "chat-messages", value: null, revision: 3 }, { section: "chat-assessments-v1", value: null, revision: 2 },
  ]);
  const docs = (await b.request("/api/user/data/tang-jinsong")).data.documents;
  for (const section of ["chat-messages", "chat-assessments-v1"]) {
    assert.equal(docs.find(d => d.section === section).value, null);
    assert.deepEqual(privacyAck.data.relatedDocuments.find(d => d.section === section), docs.find(d => d.section === section));
    assert.equal((await b.request(documentPath(section), "PUT", { value: [], expectedRevision: 2 })).data.code, "CHAT_STORAGE_DISABLED");
  }
  const resumed = await a.request(documentPath("privacy"), "PUT", { value: { saveChat: true }, expectedRevision: privacyAck.data.document.revision });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.data.relatedDocuments, undefined);
  for (const tombstone of privacyAck.data.relatedDocuments) {
    assert.equal((await a.request(documentPath(tombstone.section), "PUT", { value: [], expectedRevision: tombstone.revision })).status, 200);
    assert.equal((await b.request(documentPath(tombstone.section), "PUT", { value: [], expectedRevision: 1 })).status, 409);
  }
});

test("optional assessment notes persist across account devices and restart, then are erased by chat opt-out", async t => {
  const f = await fixture(t);
  const a = f.client(), b = f.client(), other = f.client();
  await f.login(a, "assessment-a"); await f.login(b, "assessment-b"); await f.login(other, "other-assessment");
  const result = { id: "assessment-note", scaleId: "phq9", createdAt: "2026-10-07T02:00:00.000Z", answers: [...Array(8).fill(0), 1, 0], score: 1, maxScore: 27, supplement: "记录我的感受\n补充描述不计分" };
  const saved = await a.request(documentPath("chat-assessments-v1"), "PUT", { value: [result], expectedRevision: 0 });
  assert.equal(saved.status, 200);
  const findResult = response => response.data.documents.find(document => document.section === "chat-assessments-v1");
  assert.deepEqual(findResult(await b.request("/api/user/data/tang-jinsong")).value, [result]);
  assert.deepEqual((await other.request("/api/user/data/tang-jinsong")).data.documents, []);
  await f.restart();
  assert.deepEqual(findResult(await b.request("/api/user/data/tang-jinsong")).value, [result]);
  const edited = { ...result, supplement: "补充已修改" };
  assert.equal((await b.request(documentPath("chat-assessments-v1"), "PUT", { value: [edited], expectedRevision: 1 })).status, 200);
  assert.equal(findResult(await a.request("/api/user/data/tang-jinsong")).value[0].supplement, "补充已修改");
  assert.equal((await a.request(documentPath("privacy"), "PUT", { value: { saveChat: false, voicePlayback: true, reminders: true }, expectedRevision: 0 })).status, 200);
  assert.equal(findResult(await b.request("/api/user/data/tang-jinsong")).value, null);
  assert.equal((await b.request(documentPath("chat-assessments-v1"), "PUT", { value: [edited], expectedRevision: 3 })).data.code, "CHAT_STORAGE_DISABLED");
});

test("provider errors are scrubbed, unknown sections/agents and malformed documents are rejected", async t => {
  const f = await fixture(t);
  const a = f.client();
  const pending = await f.begin(a);
  const failed = await f.complete(pending, "bad-code");
  assert.equal(failed.status, 502);
  assert.doesNotMatch(JSON.stringify(failed.data), /SECRET|session_key|must-not-escape|openid/);
  assert.equal((await a.request("/api/wechat/login/consume", "POST", { requestId: pending.requestId })).status, 409);
  await f.login(a, "valid-after-failure");
  assert.equal((await a.request(documentPath("unknown"), "PUT", { value: null, expectedRevision: 0 })).status, 400);
  assert.equal((await a.request(documentPath("chat-messages"), "PUT", { value: "invalid", expectedRevision: 0 })).status, 400);
  assert.equal((await a.request(documentPath("privacy"), "PUT", { value: { saveChat: "false" }, expectedRevision: 0 })).status, 400);
  assert.equal((await a.request("/api/user/data/not-published")).status, 404);
  assert.equal((await a.request(documentPath("wellness-v1"), "PUT", { value: { large: "a".repeat(530000) }, expectedRevision: 0 })).status, 413);
});

test("all eleven agents persist service plans with account and doctor isolation, revisions and deletion", async t => {
  const f = await fixture(t, { seedDoctors: doctorProfiles });
  const a = f.client(), b = f.client(), other = f.client();
  await f.login(a, "service-a"); await f.login(b, "service-b"); await f.login(other, "other-service");
  const expected = new Map();
  const findPlans = response => response.data.documents.find(document => document.section === "service-plans-v1");
  for (const profile of doctorProfiles) {
    const route = `/api/user/data/${profile.slug}`;
    assert.equal(findPlans(await b.request(route + "?include=service-plans-v1")), undefined, "a different doctor's plans never fill this doctor's document");
    const value = { version: 1, plans: [{ id: `plan-${profile.slug}`, service: profile.services[0], completed: ["整理近期记录"], note: `只属于 ${profile.name}`, targetDate: "2028-02-29", updatedAt: "2026-10-22T08:00:00.000Z" }] };
    const saved = await a.request(`${route}/service-plans-v1`, "PUT", { value, expectedRevision: 0 });
    assert.equal(saved.status, 200);
    assert.deepEqual(findPlans(await b.request(route + "?include=service-plans-v1")).value, value);
    assert.equal(findPlans(await other.request(route + "?include=service-plans-v1")), undefined);
    expected.set(profile.slug, value);
  }
  await f.restart();
  for (const [slug, value] of expected) assert.deepEqual(findPlans(await b.request(`/api/user/data/${slug}?include=service-plans-v1`)).value, value);
  const original = expected.get("tang-jinsong");
  const edited = { ...original, plans: [{ ...original.plans[0], note: "另一设备已修改" }] };
  assert.equal((await b.request(documentPath("service-plans-v1"), "PUT", { value: edited, expectedRevision: 1 })).status, 200);
  const stale = await a.request(documentPath("service-plans-v1"), "PUT", { value: original, expectedRevision: 1 });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data.document.value, edited);
  assert.equal((await a.request(documentPath("privacy"), "PUT", { value: { saveChat: false }, expectedRevision: 0 })).status, 200);
  assert.deepEqual(findPlans(await b.request("/api/user/data/tang-jinsong?include=service-plans-v1")).value, edited, "chat privacy does not erase an independently saved service plan");
  assert.equal((await a.request(documentPath("service-plans-v1"), "PUT", { value: null, expectedRevision: 2 })).status, 200);
  const tombstone = findPlans(await b.request("/api/user/data/tang-jinsong?include=service-plans-v1"));
  assert.equal(tombstone.value, null);
  assert.equal(tombstone.revision, 3);
  assert.equal((await b.request(documentPath("service-plans-v1"), "PUT", { value: edited, expectedRevision: 2 })).status, 409);
});

test("service plans reject malformed, excessive or ambiguous entries before saving", async t => {
  const f = await fixture(t);
  const a = f.client();
  await f.login(a, "service-validation");
  const plan = { id: "one", service: "就诊资料准备", completed: [], note: "", targetDate: "", updatedAt: "2026-10-22T08:00:00.000Z" };
  const invalidValues = [
    {}, [], { version: 2, plans: [] }, { version: 1, plans: "invalid" },
    { version: 1, plans: [], extra: true },
    { version: 1, plans: Array.from({ length: 33 }, (_, index) => ({ ...plan, id: String(index) })) },
    { version: 1, plans: [plan, plan] },
    ...[
      { id: "" }, { id: "x".repeat(121) }, { service: " " }, { service: "x".repeat(121) },
      { completed: "invalid" }, { completed: Array(17).fill("step") }, { completed: ["x".repeat(161)] }, { completed: [42] },
      { note: 42 }, { note: "x".repeat(2001) }, { targetDate: "2026-02-29" }, { targetDate: "2026-02-30" },
      { updatedAt: "2026-10-22" }, { updatedAt: "2026-02-30T08:00:00.000Z" }, { updatedAt: "2026-10-22T25:00:00.000Z" },
      { extra: true },
    ].map(patch => ({ version: 1, plans: [{ ...plan, ...patch }] })),
  ];
  for (const value of invalidValues) {
    const response = await a.request(documentPath("service-plans-v1"), "PUT", { value, expectedRevision: 0 });
    assert.equal(response.status, 400);
    assert.equal(response.data.code, "INVALID_DOCUMENT");
  }
  assert.equal((await a.request("/api/user/data/tang-jinsong")).data.documents.length, 0);
  const atLimits = { version: 1, plans: Array.from({ length: 32 }, (_, index) => ({ ...plan, id: String(index), service: "s".repeat(120), completed: Array(16).fill("c".repeat(160)), note: "n".repeat(2000), targetDate: "2028-02-29", updatedAt: "2026-10-22T16:00:00+08:00" })) };
  assert.equal((await a.request(documentPath("service-plans-v1"), "PUT", { value: atLimits, expectedRevision: 0 })).status, 200);
});

test("expired, cancelled and concurrent login attempts cannot finish or replay provider exchange", async t => {
  let releaseProvider;
  const hold = new Promise(resolve => { releaseProvider = resolve; });
  const f = await fixture(t, { provider: async () => { await hold; return Response.json({ openid: "openid-held" }); } });
  const a = f.client();
  const expired = await f.begin(a);
  await f.store.transaction(() => f.store.run("UPDATE consumer_login_requests SET expires_at=? WHERE id=?", ["2000-01-01T00:00:00.000Z", expired.requestId]));
  assert.equal((await f.complete(expired, "expired-code")).status, 409);
  assert.equal(f.calls, 0);
  const pending = await f.begin(a);
  const completing = f.complete(pending, "held-code");
  // Wait until the fixture's provider has received the claimed request.
  while (!f.calls) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await f.complete(pending, "held-code")).status, 409);
  assert.equal((await a.request("/api/wechat/logout", "POST")).status, 200);
  releaseProvider();
  assert.equal((await completing).status, 502);
  assert.equal(Number((await f.store.get("SELECT COUNT(*) total FROM consumer_users")).total), 0);
});

test("production consumer cookies are secure and capability disablement does not reuse stored admin identity", async t => {
  const f = await fixture(t, { env: { PUBLIC_URL: "https://agent.hzmwmt.com" } });
  const a = f.client();
  const response = await a.request("/api/wechat/session");
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(response.data.authenticated, false);
  assert.equal(response.data.user, null);
});

test("real MySQL consumer identity and documents survive verified logical backup and restore", { skip: process.env.CONSUMER_MYSQL_QA_PORT !== "33129" }, async t => {
  const f = await fixture(t);
  const a = f.client();
  const user = await f.login(a, "backup-device");
  await a.request(documentPath("profile-name"), "PUT", { value: "备份恢复测试", expectedRevision: 0 });
  for (const section of ["health-records", "favorites"]) assert.equal((await a.request(documentPath(section), "PUT", { value: [], expectedRevision: 0 })).status, 200);
  const otherDoctor = "consumer-backup-other";
  await f.database.createAgent({ ...doctor, slug: otherDoctor, name: "合成备份医生" }, "synthetic-test", true);
  assert.equal((await a.request(`/api/user/data/${otherDoctor}/privacy`, "PUT", { value: { saveChat: true }, expectedRevision: 0 })).status, 200);
  const b = f.client();
  await f.login(b, "other-backup-device");
  assert.equal((await b.request(documentPath("profile-name"), "PUT", { value: "第二个合成账号", expectedRevision: 0 })).status, 200);
  const expectedDocuments = await f.store.rows("SELECT user_id,agent_slug,section,value_json,revision,updated_at FROM consumer_documents ORDER BY BINARY user_id,BINARY agent_slug,BINARY section");
  assert.equal(expectedDocuments.length, 5);
  const backupRoot = path.join(f.directory, "backups");
  await fs.mkdir(path.join(f.directory, "uploads"), { recursive: true });
  const report = await createMySqlBackup({ environment: { ...f.mysqlEnv, DATA_DIR: f.directory, BACKUP_DIR: backupRoot } });
  assert.equal(report.ok, true);
  const backupDirectory = path.join(backupRoot, report.backupName);
  assert.equal((await verifyLocalMySqlBackup(backupDirectory)).ok, true);
  const restoredName = `consumer_qa_${randomBytes(8).toString("hex")}`;
  await f.mysqlAdmin.query(`CREATE DATABASE ${restoredName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await f.mysqlAdmin.query(`GRANT ALL ON ${restoredName}.* TO 'consumerqa'@'127.0.0.1'`);
  try {
    const restoredEnv = { ...f.mysqlEnv, DATABASE_URL: `mysql://consumerqa:isolated-test-password@127.0.0.1:33129/${restoredName}`, DATA_DIR: path.join(f.directory, "restored"), MYSQL_RESTORE_SOURCE_DIR: backupDirectory };
    const restored = await restoreMySqlBackup({ environment: restoredEnv });
    assert.equal(restored.code, "MYSQL_LOGICAL_RESTORE_ZERO_DIFF");
    const [documents] = await f.mysqlAdmin.query(`SELECT user_id,agent_slug,section,value_json,revision,updated_at FROM ${restoredName}.consumer_documents ORDER BY BINARY user_id,BINARY agent_slug,BINARY section`);
    assert.deepEqual(documents, expectedDocuments);
    assert.equal(JSON.parse(documents.find(row => row.user_id === user.id && row.section === "profile-name").value_json), "备份恢复测试");
  } finally {
    assert.match(restoredName, /^consumer_qa_[a-f0-9]{16}$/);
    await f.mysqlAdmin.query(`DROP DATABASE ${restoredName}`);
  }
});

test("service-plan GET requires an exact opt-in while legacy and malformed requests preserve all stored data", async t => {
  const f = await fixture(t, { seedDoctors: doctorProfiles });
  const client = f.client(), other = f.client(), guest = f.client();
  await f.login(client, "opt-in-main"); await f.login(other, "other-opt-in");
  const route = "/api/user/data/tang-jinsong";
  const value = { version: 1, plans: [{ id: "synthetic-plan", service: "Synthetic preparation", completed: [], note: "Synthetic note", targetDate: "", updatedAt: "2026-10-23T00:00:00.000Z" }] };
  assert.equal((await client.request(documentPath("profile-name"), "PUT", { value: "existing-name", expectedRevision: 0 })).status, 200);
  assert.equal((await client.request(documentPath("service-plans-v1"), "PUT", { value, expectedRevision: 0 })).status, 200);
  const storedRows = () => f.store.rows("SELECT * FROM consumer_documents ORDER BY user_id,agent_slug,section");
  const before = await storedRows();
  const legacy = await client.request(route);
  assert.equal(legacy.status, 200);
  assert.deepEqual(legacy.data.documents.map(document => document.section), ["profile-name"]);
  const included = await client.request(route + "?include=service-plans-v1");
  assert.equal(included.status, 200);
  assert.deepEqual(included.data.documents.find(document => document.section === "service-plans-v1").value, value);
  for (const query of [
    "?include=", "?include=unknown", "?include=SERVICE-PLANS-V1", "?include=service-plans-v1%20",
    "?include=service-plans-v1&include=service-plans-v1", "?include=service-plans-v1&include=privacy",
    "?include[]=service-plans-v1", "?include[section]=service-plans-v1", "?include=service-plans-v1,privacy",
  ]) {
    const result = await client.request(route + query);
    assert.equal(result.status, 200, query);
    assert.deepEqual(result.data.documents.map(document => document.section), ["profile-name"], query);
  }
  assert.deepEqual(await storedRows(), before, "legacy, opted-in, and malformed reads never mutate rows or revisions");
  assert.deepEqual((await other.request(route + "?include=service-plans-v1")).data.documents, []);
  assert.deepEqual((await client.request("/api/user/data/fu-junfen?include=service-plans-v1")).data.documents, []);
  assert.equal((await guest.request(route + "?include=service-plans-v1")).status, 401);
  assert.equal((await client.request(documentPath("service-plans-v1"), "PUT", { value: null, expectedRevision: 1 })).status, 200);
  const tombstoneRows = await storedRows();
  assert.deepEqual((await client.request(route)).data.documents.map(document => document.section), ["profile-name"]);
  const tombstone = (await client.request(route + "?include=service-plans-v1")).data.documents.find(document => document.section === "service-plans-v1");
  assert.equal(tombstone.value, null); assert.equal(tombstone.revision, 2);
  assert.deepEqual(await storedRows(), tombstoneRows, "a filtered tombstone remains stored for CAS and a later new client");
});

import {normalizeAgent} from './domain.mjs';
test('configured component permissions bind the authenticated user and doctor while preserving individual deletion and audit privacy',async t=>{
 const f=await fixture(t);const client=f.client();await f.login(client,'same-component-permission');const other=f.client();await f.login(other,'other-component-permission');
 const records=[{id:'local-one',createdAt:'2026-10-23T00:00:00Z',note:'SYNTHETIC PRIVATE NOTE',measurements:{glucose:0},values:{symptom:'本地流程字段'}},{id:'local-two',createdAt:'2026-10-23T00:00:01Z',note:'SECOND SYNTHETIC NOTE',measurements:{glucose:1}}];
 assert.equal((await client.request(documentPath('health-records'),'PUT',{value:records,expectedRevision:0})).status,200);
 const stored=await f.database.requireAgent('tang-jinsong');await f.database.saveAgent(normalizeAgent({builder:{schemaVersion:1,dataPermissions:{records:'read-only',assessments:'read-only',services:'read-only'}}},stored),'qa-editor');await f.database.publishAgent('tang-jinsong','qa-editor');
 const change=await client.request(documentPath('health-records'),'PUT',{value:[{...records[0],note:'CHANGED'}],expectedRevision:1});assert.equal(change.status,403);assert.equal(change.data.code,'COMPONENT_READ_ONLY');
 assert.equal((await client.request(documentPath('health-records'),'PUT',{value:[records[1]],expectedRevision:1})).status,200);assert.deepEqual((await other.request('/api/user/data/tang-jinsong')).data.documents,[]);
 assert.equal((await client.request(documentPath('health-records'),'PUT',{value:null,expectedRevision:2})).status,200);
 const overview=await f.database.overview();const writes=overview.recentAudit.filter(item=>item.action==='consumer.component_data_write');assert.ok(writes.length>=3);assert.ok(writes.every(item=>!JSON.stringify(item.details).includes('SYNTHETIC')));assert.ok(writes.every(item=>item.actor.startsWith('consumer:')));
 const plans={version:1,plans:[{id:'local-plan',service:'本地计划',completed:[],note:'',targetDate:'',updatedAt:new Date().toISOString(),values:{stepOne:{detail:'本地字段',number:0}}}]};
 const denied=await client.request(documentPath('service-plans-v1'),'PUT',{value:plans,expectedRevision:0});assert.equal(denied.status,403);
 const invalid=await client.request(documentPath('service-plans-v1'),'PUT',{value:{...plans,plans:[{...plans.plans[0],values:{stepOne:{number:1000000001}}}]},expectedRevision:0});assert.equal(invalid.status,400);
});
