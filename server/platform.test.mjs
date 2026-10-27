import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPlatformApp } from "./app.mjs";
import { PlatformDatabase } from "./database.mjs";
import { normalizeAgent, normalizeSource } from "./domain.mjs";
import { generateAgentDrafts, generateContentDraft, optimizeAgentPrompt } from "./ai-studio.mjs";
import { createAuth, hashPassword, verifyPassword, passwordField } from "./auth.mjs";

const seed = { slug: "demo-one", name: "科普助手", hospital: "", department: "专业科普", specialty: "资料与健康概念解释", intro: "测试数据" };
const createInput = (slug, name = "测试智能体") => ({ slug, name, department: "专业科普", specialty: "文档知识解释", intro: "仅用于自动化测试" });
const strictReembeddingEnv = {
  EMBEDDING_API_URL: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
  EMBEDDING_API_KEY: "test-reembedding-key",
  EMBEDDING_MODEL: "qwen3.7-text-embedding-flash",
  EMBEDDING_API_PROTOCOL: "dashscope",
  EMBEDDING_DIMENSIONS: "256",
  EMBEDDING_SEGMENT_CHARACTERS: "225",
  EMBEDDING_BATCH_SIZE: "8",
  EMBEDDING_MAX_RETRIES: "2",
};

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medtalent-platform-test-"));
  t.after(async () => {
    // Only remove this test's own freshly allocated directory, never a user path.
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("medtalent-platform-test-")) await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function listenOnFetchSafePort(app) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await new Promise((resolve) => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // The OS can occasionally allocate a port that the Fetch standard blocks.
      // Probe it before a fixture starts so those allocations are retried instead
      // of turning an unrelated API test into a flaky "bad port" failure.
      const response = await fetch(`${base}/api/health`);
      await response.arrayBuffer();
      return { server, base };
    } catch (error) {
      await new Promise((resolve) => server.close(resolve));
      if (error?.cause?.message !== "bad port") throw error;
    }
  }
  throw new Error("Unable to allocate a Fetch-compatible test port");
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "medtalent-platform-test-"));
  const platform = await createPlatformApp({ dataDir: path.join(directory, "data"), seedDoctors: [seed], startWorker: false, disableRateLimits: true, env: options.env || {}, ...options });
  let server;
  let base;
  try {
    ({ server, base } = await listenOnFetchSafePort(platform.app));
  } catch (error) {
    await platform.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("medtalent-platform-test-")) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("medtalent-platform-test-")) await fs.rm(directory, { recursive: true, force: true });
  });
  const request = async (method, url, body, cookie, additionalHeaders = {}) => {
    const headers = { ...additionalHeaders, ...(cookie ? { Cookie: cookie } : {}) };
    if (body !== undefined && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(`${base}${url}`, { method, headers, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  };
  const login = await request("POST", "/api/auth/login", { username: "admin", password: "dev-admin-password" });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const api = (method, url, body, headers) => request(method, url, body, cookie, headers);
  const drain = async () => { let count = 0; while (await platform.knowledge.runOne()) { if (++count > 100) throw new Error("Queue failed to drain"); } return count; };
  return { ...platform, directory, server, base, request, api, cookie, drain };
}

test("password hashes are salted and verified without retaining plaintext", () => {
  const hash = hashPassword("a-safe-test-password");
  assert.notEqual(hash, hashPassword("a-safe-test-password"));
  assert.equal(verifyPassword("a-safe-test-password", hash), true);
  assert.equal(verifyPassword("wrong", hash), false);
  assert.equal(hash.includes("a-safe-test-password"), false);
});

test("password validation preserves exact strings and enforces safe type and length boundaries", () => {
  const exact = "  independently-generated-test-value\t";
  assert.equal(passwordField(exact), exact);
  assert.equal(passwordField("x", { min: 1, rejectExamples: false }), "x");
  assert.equal(passwordField("z".repeat(1024)).length, 1024);
  for (const invalid of [undefined, null, false, 12345, [], {}, "", "short", " ".repeat(12), "\t\n\r  ", "x".repeat(1025), "  dev-admin-password  ", "\tchange-this-example\t", " replace-this-example ", " password-example-value "]) {
    assert.throws(() => passwordField(invalid), { code: "INVALID_PASSWORD", statusCode: 400 });
  }
});

test("production bootstrap refuses missing/default credentials", async (t) => {
  const directory = await temporaryDirectory(t);
  const database = new PlatformDatabase({ dataDir: directory });
  await assert.rejects(() => createAuth(database, { NODE_ENV: "production" }), /ADMIN_PASSWORD/);
  await assert.rejects(() => createAuth(database, { NODE_ENV: "production", ADMIN_PASSWORD: "dev-admin-password" }), /ADMIN_PASSWORD/);
  await assert.rejects(() => createAuth(database, { NODE_ENV: "production", ADMIN_TOKEN: "weak" }), /ADMIN_TOKEN/);
  await createAuth(database, {});
  await assert.rejects(() => createAuth(database, { NODE_ENV: "production" }), /拒绝沿用开发/);
  database.close();
});

test("bootstrap accepts an exact 1024-character password and rejects oversize, blank and non-text values before creating a user", async (t) => {
  const directory = await temporaryDirectory(t);
  const database = new PlatformDatabase({ dataDir: directory });
  try {
    for (const invalid of ["q".repeat(1025), " ".repeat(12), 123456789012, {}, "  dev-admin-password  ", " replace-with-your-strong-password "]) {
      await assert.rejects(() => createAuth(database, { NODE_ENV: "production", ADMIN_PASSWORD: invalid }), { code: "INVALID_PASSWORD" });
      assert.equal(database.sqlite.prepare("SELECT COUNT(*) total FROM users").get().total, 0);
    }
    const password = `  ${"K".repeat(1020)}  `;
    const auth = await createAuth(database, { NODE_ENV: "production", ADMIN_PASSWORD: password });
    const response = { cookie() {} };
    assert.equal((await auth.login({ body: { username: "admin", password } }, response)).user.username, "admin");
    await assert.rejects(() => auth.login({ body: { username: "admin", password: password.trim() } }, response), { code: "INVALID_CREDENTIALS" });
  } finally { database.close(); }
});

test("API account creation and password changes preserve surrounding whitespace and revoke prior sessions", async (t) => {
  const f = await fixture(t);
  const firstPassword = "  exact-first-member-test-value\t";
  const created = await f.api("POST", "/api/admin/users", { username: "exact-member", role: "viewer", password: firstPassword });
  assert.equal(created.status, 201);
  const firstLogin = await f.request("POST", "/api/auth/login", { username: "exact-member", password: firstPassword });
  assert.equal(firstLogin.status, 200);
  const oldCookie = firstLogin.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.request("POST", "/api/auth/login", { username: "exact-member", password: firstPassword.trim() })).status, 401);
  const secondPassword = "\t exact-second-member-test-value  ";
  assert.equal((await f.api("PUT", `/api/admin/users/${created.data.id}`, { password: secondPassword })).status, 200);
  assert.equal((await f.request("GET", "/api/admin/agents", undefined, oldCookie)).status, 401);
  assert.equal((await f.request("POST", "/api/auth/login", { username: "exact-member", password: firstPassword })).status, 401);
  assert.equal((await f.request("POST", "/api/auth/login", { username: "exact-member", password: secondPassword.trim() })).status, 401);
  assert.equal((await f.request("POST", "/api/auth/login", { username: "exact-member", password: secondPassword })).status, 200);
  const hash = f.database.sqlite.prepare("SELECT password_hash FROM users WHERE id=?").get(created.data.id).password_hash;
  assert.equal(verifyPassword(secondPassword, hash), true);
  assert.equal(verifyPassword(secondPassword.trim(), hash), false);
});

test("API password boundaries reject invalid creation, update and login values without changing the existing password", async (t) => {
  const f = await fixture(t);
  const maximum = "Z".repeat(1024);
  const created = await f.api("POST", "/api/admin/users", { username: "password-bounds", role: "viewer", password: maximum });
  assert.equal(created.status, 201);
  assert.equal((await f.request("POST", "/api/auth/login", { username: "password-bounds", password: maximum })).status, 200);
  for (const invalid of [null, false, 12345, [], {}, "", "tiny", " ".repeat(12), "q".repeat(1025), "  dev-admin-password  "]) {
    assert.equal((await f.api("POST", "/api/admin/users", { username: "invalid-password", role: "viewer", password: invalid })).status, 400);
    assert.equal((await f.api("PUT", `/api/admin/users/${created.data.id}`, { password: invalid })).status, 400);
  }
  for (const invalid of [undefined, null, false, 12345, [], {}, "", "  \t\n", "q".repeat(1025)]) {
    assert.equal((await f.request("POST", "/api/auth/login", { username: "password-bounds", password: invalid })).status, 400);
  }
  assert.equal((await f.request("POST", "/api/auth/login", { username: "password-bounds", password: maximum })).status, 200);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM users WHERE username='invalid-password'").get().total, 0);
});

test("reset-admin enforces its maximum and preserves a valid raw password without printing credentials", async (t) => {
  const f = await fixture(t);
  const script = fileURLToPath(new URL("../scripts/reset-admin.mjs", import.meta.url));
  const runReset = (password) => spawnSync(process.execPath, [script], {
    env: { ...process.env, DATA_DIR: f.database.dataDir, RESET_ADMIN_USERNAME: "admin", RESET_ADMIN_PASSWORD: password },
    encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  const initialHash = f.database.sqlite.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash;
  for (const invalid of ["q".repeat(1025), " ".repeat(12), "  dev-admin-password  "]) {
    const result = runReset(invalid);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RESET_ADMIN_PASSWORD/);
    // Pure whitespace can also appear as diagnostic indentation, so only match nonblank secrets.
    if (invalid.trim()) assert.equal(`${result.stdout}${result.stderr}`.includes(invalid), false);
    assert.equal(f.database.sqlite.prepare("SELECT password_hash FROM users WHERE username='admin'").get().password_hash, initialHash);
  }
  const password = `  ${"R".repeat(1020)}  `;
  await new Promise((resolve) => f.server.close(resolve));
  await f.close();
  const result = runReset(password);
  assert.equal(result.status, 0);
  assert.equal(`${result.stdout}${result.stderr}`.includes(password), false);
  const reopened = new PlatformDatabase({ dataDir: f.database.dataDir });
  try {
    assert.equal(reopened.sqlite.prepare("SELECT COUNT(*) total FROM sessions").get().total, 0);
    const auth = await createAuth(reopened, {});
    const response = { cookie() {} };
    assert.equal((await auth.login({ body: { username: "admin", password } }, response)).user.username, "admin");
    await assert.rejects(() => auth.login({ body: { username: "admin", password: password.trim() } }, response), { code: "INVALID_CREDENTIALS" });
  } finally { reopened.close(); }
});

test("job, overview and audit APIs project legacy rows without credential-bearing payloads", async (t) => {
  const currentSecret = "CURRENT-S3-SECRET-DO-NOT-RETURN";
  const overlappingSecret = "CURRENT-S3-SECRET";
  const legacyBearer = "legacy-bearer-token-do-not-return";
  const legacyTildeBearer = "legacy~tilde~bearer~do-not-return";
  const legacyNested = "legacy-nested-secret-do-not-return";
  const legacyPassword = "legacy-password-do-not-return";
  const legacySessionToken = "legacy-session-token-do-not-return";
  const legacySignature = "legacy-signature-do-not-return";
  const legacyAtSuffix = "ss-sensitive-url-password-do-not-return";
  const legacyPemBody = "LEGACY-PEM-BODY-DO-NOT-RETURN";
  const legacyPrivateKey = "legacy-private-key-do-not-return";
  const webdavUsername = "current-webdav-user-do-not-return";
  const upstreamBodies = [];
  const upstreamFetch = async (_url, options = {}) => {
    const body = String(options.body || "");
    upstreamBodies.push(body);
    const request = JSON.parse(body);
    const system = request.messages?.[0]?.content || "";
    const content = system.includes("健康科普内容编辑")
      ? JSON.stringify({ title: "安全草稿", summary: "安全摘要", body: "安全正文", tags: ["安全"] })
      : system.includes("智能体提示词编辑")
        ? JSON.stringify({ systemPrompt: "安全的优化提示词" })
        : "这是安全的科普测试回复。";
    return Response.json({ choices: [{ message: { content } }] });
  };
  const f = await fixture(t, { env: {
    NAS_S3_ACCESS_KEY_ID: "current-test-access",
    NAS_S3_SECRET_ACCESS_KEY: currentSecret,
    NAS_WEBDAV_USERNAME: webdavUsername,
    ADMIN_TOKEN: overlappingSecret,
    AI_API_KEY: "synthetic-ai-provider-key", AI_API_URL: "https://ai.example.invalid/v1", AI_MODEL: "unit-test-model",
  }, fetchImpl: upstreamFetch });
  const timestamp = new Date().toISOString();
  f.database.transaction(() => {
    const agentRow = f.database.sqlite.prepare("SELECT draft,published FROM agents WHERE slug=?").get(seed.slug);
    const taintAgent = (serialized) => {
      const agent = JSON.parse(serialized);
      return JSON.stringify({ ...agent, name: `科普助手 apiKey=${legacyNested}`, specialty: `Bearer ${legacyTildeBearer}`,
        intro: `https://legacy-user:pa@${legacyAtSuffix}@host.invalid/profile privateKey=${legacyPrivateKey}`,
        secretAccessKey: legacyNested, credentials: { token: legacyBearer }, createdAt: currentSecret,
        config: { ...agent.config, systemPrompt: `password=${legacyPassword} ${currentSecret}\n-----BEGIN PRIVATE KEY-----\n${legacyPemBody}\n-----END PRIVATE KEY-----`,
          apiKey: legacyNested, credentials: { token: legacyBearer } } });
    };
    f.database.sqlite.prepare("UPDATE agents SET draft=?,published=? WHERE slug=?")
      .run(taintAgent(agentRow.draft), taintAgent(agentRow.published), seed.slug);
    f.database.sqlite.prepare(`INSERT INTO jobs(id,type,status,payload,result,error,progress,attempts,max_attempts,run_after,created_at,finished_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "legacy-sensitive-job", "nas.sync", "completed",
      JSON.stringify({ sourceId: "safe-source", authorization: `Bearer ${legacyBearer}` }),
      JSON.stringify({ sourceId: "safe-source", scanned: 7, complete: false,
        warning: `Bearer ${legacyBearer}; value=${currentSecret}`,
        errors: [{ path: "safe/path.txt", error: `upstream user ${webdavUsername}` }],
        credentials: { secretAccessKey: legacyNested } }),
      `password=${legacyPassword}; sessionToken=${legacySessionToken}; X-Amz-Signature=${legacySignature}`, 100, 1, 3, timestamp, timestamp, timestamp,
    );
    f.database.sqlite.prepare("INSERT INTO audit(id,action,actor,target,details,created_at) VALUES(?,?,?,?,?,?)").run(
      "legacy-sensitive-audit", "legacy.import", "system", "safe-target",
      JSON.stringify({ authorization: `Bearer ${legacyBearer}`, nested: { apiKey: legacyNested, note: currentSecret }, owner: webdavUsername }), timestamp,
    );
    f.database.saveEntity("documents", {
      id: "legacy-sensitive-document", agentSlug: seed.slug,
      name: `历史文档 password=${legacyPassword} ${currentSecret} https://user:pa@${legacyAtSuffix}@host.invalid/x.txt`, mimeType: "text/plain", size: 12,
      source: "nas", sourceId: "safe-source", sourcePath: "safe/history.txt", status: "error", approved: false,
      chunkCount: 0, embeddingMode: null, revision: 1, createdAt: timestamp, updatedAt: timestamp, indexedAt: null,
      storageKey: "ffffffff-ffff-4fff-8fff-ffffffffffff.bin", checksum: currentSecret,
      error: `Bearer ${legacyBearer}; password=${legacyPassword}; user=${webdavUsername}`,
      secretAccessKey: legacyNested, credentials: { secret: legacyNested },
    });
    f.database.sqlite.prepare("INSERT INTO chunks(id,document_id,agent_slug,position,text) VALUES(?,?,?,?,?)")
      .run(currentSecret, "legacy-sensitive-document", seed.slug, 0,
        `历史片段 ${currentSecret} apiKey=${legacyNested} sessionToken=${legacySessionToken} X-Amz-Signature=${legacySignature} privateKey=${legacyPrivateKey}`);
    f.database.saveEntity("sources", {
      id: "safe-source", agentSlug: seed.slug, name: `历史安全映射 Bearer ${legacyTildeBearer}`, transport: "s3", path: "safe/history",
      enabled: false, autoPublish: false, deleteMissing: false, intervalMinutes: 5, revision: 1,
      createdAt: timestamp, updatedAt: timestamp, lastSyncAt: timestamp, lastStatus: "failed",
      lastError: `Bearer ${legacyBearer}; password=${legacyPassword}; value=${currentSecret}`,
      secretAccessKey: legacyNested,
    });
    f.database.saveEntity("content", {
      id: "legacy-sensitive-content", agentSlug: seed.slug, title: "公开历史内容", summary: "安全摘要", body: "安全正文",
      type: "article", status: "published", tags: ["安全"], createdAt: timestamp, updatedAt: timestamp, publishedAt: timestamp,
      privateKey: legacyNested, credentials: { token: legacyBearer },
    });
    f.database.saveEntity("documents", {
      id: "legacy-searchable-document", agentSlug: seed.slug,
      name: `可检索引用 apiKey=${legacyNested} ${currentSecret}.txt`, mimeType: "text/plain", size: 18,
      source: "upload", sourceId: null, sourcePath: null, status: "ready", approved: true,
      chunkCount: 1, embeddingMode: "lexical", revision: 1, createdAt: timestamp, updatedAt: timestamp, indexedAt: timestamp,
      storageKey: null, checksum: "safe-searchable-checksum",
    });
    f.database.sqlite.prepare("INSERT INTO chunks(id,document_id,agent_slug,position,text) VALUES(?,?,?,?,?)")
      .run("legacy-searchable-chunk", "legacy-searchable-document", seed.slug, 0,
        `独特检索命中词 apiKey=${legacyNested} Bearer ${legacyTildeBearer} sessionToken=${legacySessionToken}\n-----BEGIN PRIVATE KEY-----\n${legacyPemBody}\n-----END PRIVATE KEY-----`);
    f.database.sqlite.prepare("UPDATE agent_versions SET snapshot=?,published_at=?,actor=? WHERE agent_slug=? AND version=1")
      .run(JSON.stringify({ name: `历史版本 apiKey=${legacyNested} ${currentSecret}` }), currentSecret,
        `Bearer ${legacyTildeBearer}`, seed.slug);
    f.database.sqlite.prepare("INSERT INTO usage(id,agent_slug,latency_ms,success,created_at) VALUES(?,?,?,?,?)")
      .run("legacy-sensitive-usage", seed.slug, 1, 1, currentSecret);
    const adminUser = f.database.sqlite.prepare("SELECT id,password_hash FROM users WHERE username='admin'").get();
    f.database.sqlite.prepare("UPDATE users SET name=?,created_at=? WHERE id=?")
      .run(`password=${legacyPassword} ${currentSecret}`, `Bearer ${legacyTildeBearer}`, adminUser.id);
    f.database.sqlite.prepare(`INSERT INTO users(id,username,name,role,active,password_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(currentSecret, "legacy-projected-user",
      `https://legacy:pa@${legacyAtSuffix}@host.invalid/user privateKey=${legacyPrivateKey}`,
      "legacy-owner", 1, adminUser.password_hash, currentSecret, timestamp);
  });
  await fs.mkdir(f.knowledge.uploadDir, { recursive: true });
  await fs.writeFile(path.join(f.knowledge.uploadDir, "ffffffff-ffff-4fff-8fff-ffffffffffff.bin"), "safe download body", "utf8");

  const jobs = await f.api("GET", "/api/admin/jobs");
  const overview = await f.api("GET", "/api/admin/overview");
  const audit = await f.api("GET", "/api/admin/audit");
  const documents = await f.api("GET", "/api/admin/documents");
  const documentDetail = await f.api("GET", "/api/admin/documents/legacy-sensitive-document");
  const nasStatus = await f.api("GET", "/api/admin/nas");
  const updatedSource = await f.api("PUT", "/api/admin/nas/sources/safe-source", { path: "safe/updated" });
  const adminAgents = await f.api("GET", "/api/admin/agents");
  const adminAgent = await f.api("GET", `/api/admin/agents/${seed.slug}`);
  const adminContent = await f.api("GET", "/api/admin/content");
  const publicDoctors = await f.request("GET", "/api/doctors");
  const publicDoctor = await f.request("GET", `/api/doctors/${seed.slug}`);
  const session = await f.api("GET", "/api/admin/session");
  const users = await f.api("GET", "/api/admin/users");
  const versions = await f.api("GET", `/api/admin/agents/${seed.slug}/versions`);
  const citationSearch = await f.api("POST", "/api/admin/knowledge/search", { agentSlug: seed.slug, query: "独特检索命中词" });
  const download = await f.api("GET", "/api/admin/documents/legacy-sensitive-document/download");
  const generatedContent = await f.api("POST", "/api/admin/content/generate", { agentSlug: seed.slug, brief: "创建安全草稿", type: "article" });
  const optimized = await f.api("POST", `/api/admin/agents/${seed.slug}/optimize`, {});
  const chat = await f.request("POST", "/api/chat", { doctorSlug: seed.slug, message: "请做一般科普" });
  for (const response of [jobs, overview, audit, documents, documentDetail, nasStatus, updatedSource,
    adminAgents, adminAgent, adminContent, publicDoctors, publicDoctor, versions, citationSearch,
    generatedContent, optimized, chat, session, users]) {
    assert.equal(response.status, 200);
    const serialized = JSON.stringify(response.data);
    for (const secret of [currentSecret, overlappingSecret, legacyBearer, legacyTildeBearer, legacyNested, legacyPassword,
      legacySessionToken, legacySignature, legacyAtSuffix, legacyPemBody, legacyPrivateKey, webdavUsername]) {
      assert.equal(serialized.includes(secret), false, `management API leaked ${secret}`);
    }
  }
  assert.equal(download.status, 200);
  for (const secret of [currentSecret, legacyPassword]) assert.equal((download.headers.get("content-disposition") || "").includes(secret), false);
  for (const body of upstreamBodies) {
    for (const secret of [currentSecret, overlappingSecret, legacyTildeBearer, legacyNested, legacyPassword,
      legacyAtSuffix, legacyPemBody, legacyPrivateKey]) {
      assert.equal(body.includes(secret), false, `external AI request leaked ${secret}`);
    }
  }
  assert.equal(upstreamBodies.length, 3);
  const projected = jobs.data.find((job) => job.id === "legacy-sensitive-job");
  assert.equal(projected.payload, undefined);
  assert.equal(projected.result.scanned, 7);
  assert.equal(projected.result.complete, false);
  assert.equal(projected.result.credentials, undefined);
  assert.match(projected.result.warning, /服务端日志/);
  assert.match(projected.error, /服务端日志/);
  const projectedDocument = documents.data.find((document) => document.id === "legacy-sensitive-document");
  assert.equal(projectedDocument.name.includes(legacyPassword), false);
  assert.equal(projectedDocument.storageKey, undefined);
  assert.equal(projectedDocument.checksum, undefined);
  assert.equal(projectedDocument.secretAccessKey, undefined);
  assert.equal(projectedDocument.credentials, undefined);
  assert.match(projectedDocument.error, /服务端日志/);
  assert.equal(documentDetail.data.chunks.length, 1);
  assert.equal(JSON.stringify(documentDetail.data.chunks).includes(currentSecret), false);
  assert.equal(JSON.stringify(documentDetail.data.chunks).includes(legacyNested), false);
  assert.equal(updatedSource.data.path, "safe/updated");
  assert.equal(updatedSource.data.secretAccessKey, undefined);
  assert.match(updatedSource.data.lastError, /服务端日志/);
  assert.equal(adminAgent.data.secretAccessKey, undefined);
  assert.equal(adminAgent.data.credentials, undefined);
  assert.equal(adminAgent.data.config.apiKey, undefined);
  assert.equal(adminAgent.data.config.credentials, undefined);
  assert.equal(publicDoctor.data.config, undefined);
  assert.equal(publicDoctor.data.secretAccessKey, undefined);
  assert.equal(adminContent.data.find((content) => content.id === "legacy-sensitive-content").privateKey, undefined);
  assert.equal(publicDoctor.data.content.find((content) => content.id === "legacy-sensitive-content").credentials, undefined);
  assert.equal(overview.data.dailyUsage.some((row) => row.date === currentSecret.slice(0, 10)), false);
  assert.equal(audit.data.find((record) => record.id === "legacy-sensitive-audit").details, null);
  const projectedLegacyUser = users.data.find((user) => user.username === "legacy-projected-user");
  assert.equal(projectedLegacyUser.role, "invalid");
  assert.equal(projectedLegacyUser.createdAt, null);
  assert.equal(session.data.user.createdAt, null);
  assert.equal(versions.data[0].publishedAt, null);
  assert.equal(JSON.stringify(versions.data).includes(legacyNested), false);
  assert.ok(citationSearch.data.citations.length > 0);
  assert.equal(JSON.stringify(citationSearch.data.citations).includes(legacyTildeBearer), false);
});

test("agent and source validators reject traversal, bad schema and unbounded configuration", () => {
  assert.throws(() => normalizeAgent(createInput("../bad")), /标识/);
  assert.throws(() => normalizeAgent({ ...createInput("good-one"), config: { maxTokens: 999999 } }), /长度/);
  assert.throws(() => normalizeAgent({ ...createInput("good-one"), config: { ragEnabled: "false" } }), /布尔/);
  for (const sourcePath of ["../outside", "a/../outside", "C:/secret", "\\server\\share", "/etc", "foo//bar", "foo:bar", "foo/bar ", "foo/bar.", "foo/%2e%2e/bar", "foo/%252e%252e/bar"]) {
    assert.throws(() => normalizeSource({ name: "NAS", agentSlug: "good-one", path: sourcePath }), { code: "INVALID_NAS_PATH" });
  }
  assert.equal(normalizeSource({ name: "中文目录", agentSlug: "good-one", transport: "webdav", path: "医生知识库/睡眠/" }).path, "医生知识库/睡眠");
  assert.throws(() => normalizeSource({ name: "S3 根目录", agentSlug: "good-one", transport: "s3", path: "" }), { code: "INVALID_NAS_PATH" });
});

test("admin settings expose embedding tuning without returning credentials", async (t) => {
  const secret = "settings-test-embedding-secret";
  const f = await fixture(t, { env: {
    EMBEDDING_API_URL: "https://embeddings.example.test/v1/embeddings",
    EMBEDDING_API_KEY: secret,
    EMBEDDING_MODEL: "test-embedding-model",
    EMBEDDING_API_PROTOCOL: "dashscope",
    EMBEDDING_DIMENSIONS: "256",
    EMBEDDING_BATCH_SIZE: "20",
    EMBEDDING_MAX_RETRIES: "2",
    EMBEDDING_SEGMENT_CHARACTERS: "450",
  } });
  const settings = await f.api("GET", "/api/admin/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.data.embeddingConfigured, true);
  assert.equal(settings.data.embeddingModel, "test-embedding-model");
  assert.equal(settings.data.embeddingApiProtocol, "dashscope");
  assert.equal(settings.data.embeddingDimensions, 256);
  assert.equal(settings.data.embeddingBatchSize, 20);
  assert.equal(settings.data.embeddingMaxRetries, 2);
  assert.equal(settings.data.embeddingSegmentCharacters, 450);
  assert.equal(JSON.stringify(settings.data).includes(secret), false);
});

test("session is HttpOnly, public APIs hide prompts, and all admin writes require authentication", async (t) => {
  const f = await fixture(t);
  const login = await f.request("POST", "/api/auth/login", { username: "admin", password: "dev-admin-password" });
  assert.match(login.headers.get("set-cookie"), /HttpOnly/);
  assert.match(login.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal(login.data.user.password_hash, undefined);
  assert.equal((await f.request("GET", "/api/admin/agents")).status, 401);
  assert.equal((await f.request("POST", "/api/admin/agents", createInput("not-allowed"))).status, 401);
  const publicAgent = await f.request("GET", "/api/doctors/demo-one");
  assert.equal(publicAgent.status, 200);
  assert.equal(publicAgent.data.config, undefined);
  assert.equal(JSON.stringify(publicAgent.data).includes("systemPrompt"), false);
  assert.equal((await f.api("PUT", "/api/admin/agents/demo-one", { intro: "cross site" }, { Origin: "https://malicious.example" })).status, 403);
  assert.equal((await f.request("GET", "/api/not-a-route")).status, 404);
  assert.equal((await f.api("GET", "/api/admin/documents?agentSlug=demo-one&agentSlug=other-one")).status, 400);
  assert.equal((await f.api("GET", "/api/admin/content?agentSlug=demo-one&agentSlug=other-one")).status, 400);
});

test("published versions are isolated from drafts; restore does not silently publish", async (t) => {
  const f = await fixture(t);
  const created = await f.api("POST", "/api/admin/agents", createInput("new-assistant", "第一版名称"));
  assert.equal(created.status, 201);
  assert.equal(created.data.status, "draft");
  assert.equal((await f.request("GET", "/api/doctors/new-assistant")).status, 404);
  const published = await f.api("POST", "/api/admin/agents/new-assistant/publish");
  assert.equal(published.data.version, 1);
  await f.api("PUT", "/api/admin/agents/new-assistant", { name: "未发布的名称" });
  assert.equal((await f.request("GET", "/api/doctors/new-assistant")).data.name, "第一版名称");
  assert.equal((await f.api("GET", "/api/admin/agents/new-assistant")).data.hasUnpublishedChanges, true);
  await f.api("POST", "/api/admin/agents/new-assistant/publish");
  assert.equal((await f.request("GET", "/api/doctors/new-assistant")).data.name, "未发布的名称");
  await f.api("POST", "/api/admin/agents/new-assistant/rollback", { version: 1 });
  assert.equal((await f.api("GET", "/api/admin/agents/new-assistant")).data.name, "第一版名称");
  assert.equal((await f.request("GET", "/api/doctors/new-assistant")).data.name, "未发布的名称");
  assert.equal((await f.api("GET", "/api/admin/agents/new-assistant/versions")).data.length, 2);
  await f.api("POST", "/api/admin/agents/new-assistant/archive");
  assert.equal((await f.request("GET", "/api/doctors/new-assistant")).status, 404);
  assert.equal((await f.request("POST", "/api/chat", { doctorSlug: "new-assistant", message: "你好" })).status, 404);
});

test("batch create is atomic and template mode is explicit and offline", async (t) => {
  const f = await fixture(t);
  const duplicate = await f.api("POST", "/api/admin/agents/batch", { agents: [createInput("batch-new"), createInput("demo-one")] });
  assert.equal(duplicate.status, 409);
  assert.equal(f.database.getAgent("batch-new"), null);
  const preview = await f.api("POST", "/api/admin/agents/generate", { mode: "template", count: 2, brief: "助手甲|测试机构|资料科|科普知识\n助手乙|测试机构|资料科|服务指南" });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.mode, "template");
  assert.equal(preview.data.drafts[0].name, "助手甲");
  assert.equal(f.database.listAgents().length, 1);
  const committed = await f.api("POST", "/api/admin/agents/batch", { agents: preview.data.drafts });
  assert.equal(committed.status, 201);
  assert.equal(committed.data.agents.every((agent) => agent.status === "draft"), true);
  const ai = await f.api("POST", "/api/admin/agents/generate", { mode: "ai", count: 2, brief: "测试建档" });
  assert.equal(ai.status, 503);
  assert.equal(ai.data.code, "AI_NOT_CONFIGURED");
});

test("AI-assisted generation uses the configured compatible API and validates drafts", async () => {
  let request;
  const result = await generateAgentDrafts({ brief: "创建资料助手", count: 1, mode: "ai" }, {
    env: { AI_API_KEY: "synthetic-key", AI_API_URL: "https://model.invalid/v1", AI_MODEL: "unit-test-model" },
    fetchImpl: async (url, options) => { request = { url, ...options }; return Response.json({ choices: [{ message: { content: JSON.stringify({ agents: [createInput("generated-one")] }) } }] }); },
  });
  assert.equal(result.mode, "ai");
  assert.equal(result.drafts.length, 1);
  assert.equal(request.url, "https://model.invalid/v1/chat/completions");
  const requestBody = JSON.parse(request.body);
  assert.equal(requestBody.model, "unit-test-model");
  assert.equal(requestBody.max_tokens, 3000);
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.equal(requestBody.thinking, undefined);
  assert.equal(request.redirect, "error");
});

test("AI Studio disables DeepSeek thinking so JSON is not starved by reasoning tokens", async () => {
  let requestBody;
  const result = await generateAgentDrafts({ brief: "创建资料助手", count: 1, mode: "ai" }, {
    env: { AI_API_KEY: "synthetic-key", AI_API_URL: "https://api.deepseek.com", AI_MODEL: "deepseek-v4-flash" },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ agents: [{
        ...createInput("deepseek-generated"),
        department: "",
        specialty: "",
      }] }) } }] });
    },
  });
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.equal(requestBody.max_tokens, 3000);
  assert.match(requestBody.messages[0].content, /department 和 specialty 使用‘健康科普’/);
  assert.equal(result.drafts[0].department, "健康科普");
  assert.equal(result.drafts[0].specialty, "健康科普");
});

test("AI Studio success payloads cannot reflect configured credentials or private keys", async () => {
  const secret = "studio-provider-secret-echo-7Y";
  const privateKey = "-----BEGIN PRIVATE KEY-----\nSTUDIO-PRIVATE-MATERIAL-SENTINEL\n-----END PRIVATE KEY-----";
  const env = { AI_API_KEY: secret, AI_API_URL: "https://model.invalid/v1", AI_MODEL: "unit-test-model" };
  const responseFor = (value) => async () => Response.json({
    choices: [{ message: { content: JSON.stringify(value) } }],
  });

  const agents = await generateAgentDrafts({ brief: "创建资料助手", count: 1, mode: "ai" }, {
    env,
    fetchImpl: responseFor({ agents: [{
      ...createInput("reflected-agent"),
      name: secret,
      specialty: `Bearer ${secret}`,
      intro: `privateKey=${privateKey}`,
      config: {
        systemPrompt: privateKey,
        welcomeMessage: `token=${secret}`,
        responseStyle: "professional",
        language: "zh-CN",
      },
    }] }),
  });
  const safeAgent = normalizeAgent(createInput("safe-agent"));
  const content = await generateContentDraft({ agent: safeAgent, brief: "起草一篇说明", type: "article" }, {
    env,
    fetchImpl: responseFor({
      title: secret,
      summary: `Bearer ${secret}`,
      body: privateKey,
      tags: [secret, `password=${secret}`],
    }),
  });
  const optimized = await optimizeAgentPrompt(safeAgent, "保留原专业边界", {
    env,
    fetchImpl: responseFor({ systemPrompt: `${secret}\n${privateKey}` }),
  });

  for (const output of [agents, content, optimized]) {
    const serialized = JSON.stringify(output);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("STUDIO-PRIVATE-MATERIAL-SENTINEL"), false);
    assert.match(serialized, /已过滤/);
  }

  const numericCredential = "0.123456";
  const numericResult = await generateAgentDrafts({ brief: "创建数值配置助手", count: 1, mode: "ai" }, {
    env: { ...env, AI_API_KEY: numericCredential },
    fetchImpl: responseFor({ agents: [{
      ...createInput("numeric-reflection-agent"),
      config: { ragThreshold: 0.123456 },
    }] }),
  });
  assert.equal(numericResult.drafts[0].config.ragThreshold, 0.12);
  assert.equal(JSON.stringify(numericResult).includes(numericCredential), false);

  const markerCredential = "[redacted]";
  const markerContent = await generateContentDraft({ agent: safeAgent, brief: "起草一篇说明", type: "article" }, {
    env: { ...env, AI_API_KEY: markerCredential },
    fetchImpl: responseFor({ title: markerCredential, summary: markerCredential, body: markerCredential, tags: [markerCredential] }),
  });
  assert.equal(JSON.stringify(markerContent).includes(markerCredential), false);

  const fixedWarning = "AI 生成资料必须逐条人工核验，尤其是姓名、机构与专业资质；确认创建后仍为未发布草稿。";
  const warningResult = await generateAgentDrafts({ brief: "创建资料助手", count: 1, mode: "ai" }, {
    env: { ...env, ADMIN_TOKEN: fixedWarning },
    fetchImpl: responseFor({ agents: [createInput("warning-collision-agent")] }),
  });
  assert.equal(JSON.stringify(warningResult).includes(fixedWarning), false);

  for (const shortCredentialEnv of [
    { AI_API_KEY: "abc" },
    { DEEPSEEK_API_KEY: "abc" },
  ]) {
    let upstreamCalled = false;
    const shortOptions = {
      env: { ...shortCredentialEnv, AI_API_URL: "https://model.invalid/v1", AI_MODEL: "unit-test-model" },
      fetchImpl: async () => { upstreamCalled = true; return Response.json({}); },
    };
    const operations = [
      () => generateAgentDrafts({ brief: "创建资料助手", count: 1, mode: "ai" }, shortOptions),
      () => generateContentDraft({ agent: safeAgent, brief: "起草一篇说明", type: "article" }, shortOptions),
      () => optimizeAgentPrompt(safeAgent, "保留原专业边界", shortOptions),
    ];
    for (const operation of operations) {
      await assert.rejects(operation(), (error) => error?.code === "AI_CONFIG_INVALID");
    }
    assert.equal(upstreamCalled, false);
  }
});

test("public error codes cannot collide with configured provider credentials", async (t) => {
  const cases = [
    {
      secret: "AI_UPSTREAM_ERROR",
      request: (f) => f.api("POST", "/api/admin/agents/generate", { brief: "创建资料助手", count: 1, mode: "ai" }),
      env: (secret) => ({ AI_API_KEY: secret, AI_API_URL: "https://model.invalid/v1" }),
    },
    {
      secret: "UPSTREAM_ERROR",
      request: (f) => f.request("POST", "/api/chat", { doctorSlug: "demo-one", message: "请介绍一般健康知识" }),
      env: (secret) => ({ AI_API_KEY: secret, AI_API_URL: "https://model.invalid/v1" }),
    },
    {
      secret: "TTS_UPSTREAM_ERROR",
      request: (f) => f.request("POST", "/api/tts", { text: "测试播报" }),
      env: (secret) => ({ DASHSCOPE_API_KEY: secret }),
    },
  ];
  for (const item of cases) {
    const f = await fixture(t, {
      env: item.env(item.secret),
      fetchImpl: async () => new Response("provider failed", { status: 500 }),
    });
    const response = await item.request(f);
    assert.equal(response.status, 502);
    assert.equal(JSON.stringify(response.data).includes(item.secret), false);
    assert.match(response.data.code, /^[A-Z][A-Z0-9_]*$/);
  }
});

test("viewer role cannot write and the final admin cannot be disabled", async (t) => {
  const f = await fixture(t);
  for (const role of ["__proto__", "constructor", "toString"]) assert.equal((await f.api("POST", "/api/admin/users", { username: "bad-role", role, password: "viewer-safe-password" })).status, 400);
  const created = await f.api("POST", "/api/admin/users", { username: "viewer", name: "只读测试", role: "viewer", password: "viewer-safe-password" });
  assert.equal(created.status, 201);
  const loggedIn = await f.request("POST", "/api/auth/login", { username: "viewer", password: "viewer-safe-password" });
  const cookie = loggedIn.headers.get("set-cookie").split(";")[0];
  assert.equal((await f.request("GET", "/api/admin/agents", undefined, cookie)).status, 200);
  assert.equal((await f.request("POST", "/api/admin/agents/demo-one/publish", undefined, cookie)).status, 403);
  assert.equal((await f.request("GET", "/api/admin/users", undefined, cookie)).status, 403);
  const adminId = (await f.api("GET", "/api/admin/session")).data.user.id;
  assert.equal((await f.api("PUT", `/api/admin/users/${adminId}`, { active: false })).status, 409);
  await f.api("PUT", `/api/admin/users/${created.data.id}`, { active: false });
  assert.equal((await f.request("GET", "/api/admin/agents", undefined, cookie)).status, 401);
});

test("knowledge lifecycle: upload, durable job, parse, approve, tenant-isolated retrieval and removal", async (t) => {
  const f = await fixture(t);
  await f.api("POST", "/api/admin/agents", createInput("other-agent"));
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", { name: "青竹资料", text: "青竹资料代号为ZX91。本文是自动化测试资料，仅说明青竹资料的命名，不包含医疗建议。" });
  assert.equal(created.status, 201);
  assert.equal(created.data.document.status, "queued");
  assert.equal(created.data.document.storageKey, undefined);
  const documentId = created.data.document.id;
  assert.equal((await f.api("POST", `/api/admin/documents/${documentId}/approve`, { agentSlug: "demo-one", revision: created.data.document.revision })).status, 409);
  await f.drain();
  const indexed = await f.api("GET", `/api/admin/documents/${documentId}`);
  assert.equal(indexed.data.document.status, "review");
  assert.ok(indexed.data.chunks.length > 0);
  assert.equal((await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹资料" })).data.citations.length, 0);
  const approved = await f.api("POST", `/api/admin/documents/${documentId}/approve`, { agentSlug: "demo-one", revision: indexed.data.document.revision });
  const result = await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹资料" });
  assert.equal(result.data.mode, "lexical");
  assert.equal(result.data.citations[0].documentId, documentId);
  assert.match(result.data.citations[0].text, /ZX91/);
  assert.equal((await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "other-agent", query: "青竹资料" })).data.citations.length, 0);
  assert.equal((await f.request("GET", `/api/admin/documents/${documentId}/download`)).status, 401);
  await f.api("DELETE", `/api/admin/documents/${documentId}`, { agentSlug: "demo-one", revision: approved.data.revision });
  const deletedDownload = await f.api("GET", `/api/admin/documents/${documentId}/download`);
  assert.equal(deletedDownload.status, 410);
  assert.equal(deletedDownload.data.code, "DOCUMENT_DELETED");
  assert.equal((await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹资料" })).data.citations.length, 0);
});

test("single knowledge approval can bind the reviewed document revision", async (t) => {
  const f = await fixture(t);
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "单份版本审核", text: "用于验证单份知识审核不会误发布刷新后的版本。",
  });
  await f.drain();
  const selected = f.database.getEntity("documents", created.data.document.id);

  assert.equal((await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { agentSlug: "demo-one", revision: -1 })).status, 400);
  assert.equal((await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { agentSlug: "demo-one", revision: selected.revision, extra: true })).status, 400);
  assert.equal((await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { revision: selected.revision })).status, 400);
  const mismatched = await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { agentSlug: "other-agent", revision: selected.revision });
  assert.equal(mismatched.status, 409);
  assert.equal(mismatched.data.code, "DOCUMENT_AGENT_MISMATCH");
  f.database.patchEntity("documents", selected.id, { revision: selected.revision + 1 });
  const stale = await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { agentSlug: "demo-one", revision: selected.revision });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "DOCUMENT_REVISION_CONFLICT");
  assert.equal(f.database.getEntity("documents", selected.id).approved, false);

  const current = f.database.getEntity("documents", selected.id);
  assert.equal((await f.api("POST", `/api/admin/documents/${selected.id}/approve`, { agentSlug: "demo-one", revision: current.revision })).status, 200);
  assert.equal(f.database.getEntity("documents", selected.id).approved, true);
});

test("legacy single-document callers remain compatible when mutation binding is omitted", async (t) => {
  const f = await fixture(t);
  const approveDocument = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "兼容单份审核", text: "验证旧版单份审核调用仍可运行。",
  })).data.document;
  const reindexDocument = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "兼容单份重建", text: "验证旧版单份重建调用仍可运行。",
  })).data.document;
  const deleteDocument = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "兼容单份删除", text: "验证旧版单份删除调用仍可运行。",
  })).data.document;
  await f.drain();

  assert.equal((await f.api("POST", `/api/admin/documents/${approveDocument.id}/approve`)).status, 200);
  assert.equal((await f.api("POST", `/api/admin/documents/${reindexDocument.id}/reindex`, { strategy: "full" })).status, 202);
  assert.equal((await f.api("DELETE", `/api/admin/documents/${deleteDocument.id}`)).status, 200);
});

test("single reindex and delete bind the active agent and viewed document revision", async (t) => {
  const f = await fixture(t);
  const reindexCreated = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "单份重建绑定", text: "验证单份重建操作的智能体和版本绑定。",
  })).data.document;
  const deleteCreated = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "单份删除绑定", text: "验证单份删除操作的智能体和版本绑定。",
  })).data.document;
  await f.drain();
  const reindexDocument = f.database.getEntity("documents", reindexCreated.id);
  const deleteDocument = f.database.getEntity("documents", deleteCreated.id);

  const wrongReindex = await f.api("POST", `/api/admin/documents/${reindexDocument.id}/reindex`, {
    agentSlug: "other-agent", revision: reindexDocument.revision, strategy: "full",
  });
  assert.equal(wrongReindex.status, 409);
  assert.equal(wrongReindex.data.code, "DOCUMENT_AGENT_MISMATCH");
  f.database.patchEntity("documents", reindexDocument.id, { revision: reindexDocument.revision + 1 });
  const staleReindex = await f.api("POST", `/api/admin/documents/${reindexDocument.id}/reindex`, {
    agentSlug: "demo-one", revision: reindexDocument.revision, strategy: "full",
  });
  assert.equal(staleReindex.status, 409);
  assert.equal(staleReindex.data.code, "DOCUMENT_REVISION_CONFLICT");
  const currentReindex = f.database.getEntity("documents", reindexDocument.id);
  assert.equal((await f.api("POST", `/api/admin/documents/${reindexDocument.id}/reindex`, {
    agentSlug: "demo-one", revision: currentReindex.revision, strategy: "full",
  })).status, 202);

  const wrongDelete = await f.api("DELETE", `/api/admin/documents/${deleteDocument.id}`, {
    agentSlug: "other-agent", revision: deleteDocument.revision,
  });
  assert.equal(wrongDelete.status, 409);
  assert.equal(wrongDelete.data.code, "DOCUMENT_AGENT_MISMATCH");
  f.database.patchEntity("documents", deleteDocument.id, { revision: deleteDocument.revision + 1 });
  const staleDelete = await f.api("DELETE", `/api/admin/documents/${deleteDocument.id}`, {
    agentSlug: "demo-one", revision: deleteDocument.revision,
  });
  assert.equal(staleDelete.status, 409);
  assert.equal(staleDelete.data.code, "DOCUMENT_REVISION_CONFLICT");
  const currentDelete = f.database.getEntity("documents", deleteDocument.id);
  assert.equal((await f.api("DELETE", `/api/admin/documents/${deleteDocument.id}`, {
    agentSlug: "demo-one", revision: currentDelete.revision,
  })).status, 200);
  assert.equal(f.database.getEntity("documents", deleteDocument.id).status, "deleted");
});

test("batch knowledge review is revision-bound, agent-isolated, deduplicated and reports partial failures", async (t) => {
  const f = await fixture(t);
  await f.api("POST", "/api/admin/agents", createInput("other-agent"));
  const createDocument = async (agentSlug, name) => {
    const response = await f.api("POST", `/api/admin/agents/${agentSlug}/documents/text`, {
      name, text: `${name}的批量审核测试内容。`,
    });
    assert.equal(response.status, 201);
    return response.data.document;
  };
  const first = await createDocument("demo-one", "批量资料一");
  const second = await createDocument("demo-one", "批量资料二");
  const stale = await createDocument("demo-one", "已更新资料");
  const foreign = await createDocument("other-agent", "其他智能体资料");
  await f.drain();
  const pending = await createDocument("demo-one", "尚未解析资料");
  f.database.patchEntity("documents", stale.id, { revision: stale.revision + 1 });

  const viewer = await f.api("POST", "/api/admin/users", { username: "batch-viewer", role: "viewer", password: "batch-viewer-safe-password" });
  assert.equal(viewer.status, 201);
  const viewerLogin = await f.request("POST", "/api/auth/login", { username: "batch-viewer", password: "batch-viewer-safe-password" });
  const viewerCookie = viewerLogin.headers.get("set-cookie").split(";")[0];
  const selection = [
    { id: first.id, revision: first.revision },
    { id: first.id, revision: first.revision },
    { id: second.id, revision: second.revision },
    { id: pending.id, revision: pending.revision },
    { id: foreign.id, revision: foreign.revision },
    { id: "missing-document", revision: 1 },
    { id: stale.id, revision: stale.revision },
  ];
  assert.equal((await f.request("POST", "/api/admin/documents/batch-review", {
    agentSlug: "demo-one", action: "approve", documents: selection,
  }, viewerCookie)).status, 403);

  const response = await f.api("POST", "/api/admin/documents/batch-review", {
    agentSlug: "demo-one", action: "approve", documents: selection,
  });
  assert.equal(response.status, 200);
  assert.deepEqual({
    action: response.data.action, agentSlug: response.data.agentSlug, requested: response.data.requested,
    succeeded: response.data.succeeded, failed: response.data.failed,
  }, { action: "approve", agentSlug: "demo-one", requested: 6, succeeded: 2, failed: 4 });
  assert.deepEqual(response.data.results.map((result) => result.id), [
    first.id, second.id, pending.id, foreign.id, "missing-document", stale.id,
  ]);
  assert.deepEqual(response.data.results.filter((result) => result.ok).map((result) => result.document.approved), [true, true]);
  assert.deepEqual(response.data.results.filter((result) => !result.ok).map((result) => result.error.code), [
    "DOCUMENT_NOT_INDEXED", "DOCUMENT_AGENT_MISMATCH", "NOT_FOUND", "DOCUMENT_REVISION_CONFLICT",
  ]);
  assert.equal(f.database.getEntity("documents", first.id).approved, true);
  assert.equal(f.database.getEntity("documents", second.id).approved, true);
  assert.equal(f.database.getEntity("documents", pending.id).approved, false);
  assert.equal(f.database.getEntity("documents", foreign.id).approved, false);
  assert.equal(f.database.getEntity("documents", stale.id).approved, false);

  const audit = (await f.api("GET", "/api/admin/audit")).data;
  const summary = audit.find((record) => record.action === "document.batch_review");
  assert.deepEqual(summary.details, { action: "approve", requested: 6, succeeded: 2, failed: 4 });
  assert.equal(summary.target, "demo-one");
  assert.equal(audit.filter((record) => record.action === "document.approve").length, 2);

  await f.drain();
  const currentPending = f.database.getEntity("documents", pending.id);
  const countSearchableChunks = f.database.countSearchableChunks.bind(f.database);
  f.database.countSearchableChunks = () => 25000;
  try {
    const singleCapacity = await f.api("POST", `/api/admin/documents/${pending.id}/approve`, { agentSlug: "demo-one", revision: currentPending.revision });
    assert.equal(singleCapacity.status, 409);
    assert.equal(singleCapacity.data.code, "INDEX_CAPACITY_EXCEEDED");
    const batchCapacity = await f.api("POST", "/api/admin/documents/batch-review", {
      agentSlug: "demo-one", action: "approve", documents: [{ id: pending.id, revision: currentPending.revision }],
    });
    assert.equal(batchCapacity.status, 200);
    assert.deepEqual({ succeeded: batchCapacity.data.succeeded, failed: batchCapacity.data.failed }, { succeeded: 0, failed: 1 });
    assert.equal(batchCapacity.data.results[0].error.code, "INDEX_CAPACITY_EXCEEDED");
    assert.equal(f.database.getEntity("documents", pending.id).approved, false);
  } finally {
    f.database.countSearchableChunks = countSearchableChunks;
  }
});

test("batch knowledge review rejects malformed or ambiguous selections before changing documents", async (t) => {
  const f = await fixture(t);
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "审核输入校验", text: "用于验证批量审核输入边界。",
  });
  await f.drain();
  const document = created.data.document;
  const requests = [
    null,
    { agentSlug: "demo-one", action: "reject", documents: [{ id: document.id, revision: document.revision }] },
    { agentSlug: "demo-one", action: "approve", documentIds: [document.id] },
    { agentSlug: "demo-one", action: "approve", documents: [] },
    { agentSlug: "demo-one", action: "approve", documents: Array.from({ length: 101 }, () => ({ id: document.id, revision: document.revision })) },
    { agentSlug: "demo-one", action: "approve", documents: [{ id: document.id, revision: -1 }] },
    { agentSlug: "demo-one", action: "approve", documents: [{ id: document.id, revision: document.revision }, { id: document.id, revision: document.revision + 1 }] },
  ];
  for (const body of requests) assert.equal((await f.api("POST", "/api/admin/documents/batch-review", body)).status, 400);
  assert.equal((await f.api("POST", "/api/admin/documents/batch-review", {
    agentSlug: "unknown-agent", action: "approve", documents: [{ id: document.id, revision: document.revision }],
  })).status, 404);
  assert.equal(f.database.getEntity("documents", document.id).approved, false);
  assert.equal(f.database.listAudit().some((record) => record.action === "document.batch_review"), false);
});

test("batch knowledge review binds legacy documents without a stored revision to revision zero", async (t) => {
  const f = await fixture(t);
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "旧版审核资料", text: "用于验证旧版资料的版本绑定。",
  });
  await f.drain();
  const legacy = f.database.getEntity("documents", created.data.document.id);
  delete legacy.revision;
  f.database.saveEntity("documents", legacy);
  assert.equal((await f.api("GET", `/api/admin/documents/${legacy.id}`)).data.document.revision, 0);

  const response = await f.api("POST", "/api/admin/documents/batch-review", {
    agentSlug: "demo-one", action: "approve", documents: [{ id: legacy.id, revision: 0 }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual({ requested: response.data.requested, succeeded: response.data.succeeded, failed: response.data.failed }, {
    requested: 1, succeeded: 1, failed: 0,
  });
  assert.equal(response.data.results[0].document.approved, true);
});

test("batch knowledge review counts earlier approvals in the same batch at the exact search-capacity boundary", async (t) => {
  const f = await fixture(t);
  const first = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "容量边界一", text: "第一个容量边界片段。",
  })).data.document;
  const second = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "容量边界二", text: "第二个容量边界片段。",
  })).data.document;
  await f.drain();
  assert.equal(f.database.countDocumentChunks(first.id), 1);
  assert.equal(f.database.countDocumentChunks(second.id), 1);
  const countSearchableChunks = f.database.countSearchableChunks.bind(f.database);
  f.database.countSearchableChunks = (agentSlug) => 24999 + countSearchableChunks(agentSlug);
  try {
    const response = await f.api("POST", "/api/admin/documents/batch-review", {
      agentSlug: "demo-one", action: "approve", documents: [
        { id: first.id, revision: first.revision }, { id: second.id, revision: second.revision },
      ],
    });
    assert.equal(response.status, 200);
    assert.deepEqual({ succeeded: response.data.succeeded, failed: response.data.failed }, { succeeded: 1, failed: 1 });
    assert.equal(response.data.results[0].ok, true);
    assert.equal(response.data.results[1].error.code, "INDEX_CAPACITY_EXCEEDED");
    assert.equal(f.database.getEntity("documents", first.id).approved, true);
    assert.equal(f.database.getEntity("documents", second.id).approved, false);
    const currentFirst = f.database.getEntity("documents", first.id);
    assert.equal((await f.api("POST", `/api/admin/documents/${first.id}/approve`, { agentSlug: "demo-one", revision: currentFirst.revision })).status, 200);
  } finally {
    f.database.countSearchableChunks = countSearchableChunks;
  }
});

test("unexpected batch review failures roll back prior approvals and their audit records", async (t) => {
  const f = await fixture(t);
  const first = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "回滚资料一", text: "第一个事务回滚片段。",
  })).data.document;
  const second = (await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "回滚资料二", text: "第二个事务回滚片段。",
  })).data.document;
  await f.drain();
  const audit = f.database.audit.bind(f.database);
  f.database.audit = (action, ...args) => {
    if (action === "document.batch_review") throw new Error("simulated summary audit failure");
    return audit(action, ...args);
  };
  let response;
  try {
    response = await f.api("POST", "/api/admin/documents/batch-review", {
      agentSlug: "demo-one", action: "approve", documents: [
        { id: first.id, revision: first.revision }, { id: second.id, revision: second.revision },
      ],
    });
  } finally {
    f.database.audit = audit;
  }
  assert.equal(response.status, 500);
  assert.equal(f.database.getEntity("documents", first.id).approved, false);
  assert.equal(f.database.getEntity("documents", second.id).approved, false);
  assert.equal(f.database.listAudit().some((record) => ["document.approve", "document.batch_review"].includes(record.action)), false);
});

test("authenticated reindex strategy explicitly queues existing-chunk work and preserves ordinary full reindex", async (t) => {
  const f = await fixture(t);
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", {
    name: "已有分片资料", text: "已有分片只用于受控向量化测试。",
  });
  await f.drain();
  const documentId = created.data.document.id;
  const initial = f.database.getEntity("documents", documentId);
  const full = await f.api("POST", `/api/admin/documents/${documentId}/reindex`, { agentSlug: "demo-one", revision: initial.revision });
  assert.equal(full.status, 202);
  assert.equal(full.data.type, "document.ingest");
  assert.equal((await f.api("GET", `/api/admin/documents/${documentId}`)).data.document.status, "queued");
  await f.drain();
  f.knowledge.env = strictReembeddingEnv;
  const reembedTarget = f.database.getEntity("documents", documentId);

  assert.equal((await f.request("POST", `/api/admin/documents/${documentId}/reindex`, { agentSlug: "demo-one", revision: reembedTarget.revision, strategy: "reuseExistingChunks" })).status, 401);
  const invalid = await f.api("POST", `/api/admin/documents/${documentId}/reindex`, { agentSlug: "demo-one", revision: reembedTarget.revision, strategy: "reuse-existing-chunks" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.code, "INVALID_REINDEX_STRATEGY");
  assert.equal((await f.api("POST", `/api/admin/documents/${documentId}/reindex`, {
    agentSlug: "demo-one", revision: reembedTarget.revision, strategy: "reuseExistingChunks", unexpected: true,
  })).status, 400);

  const queued = await f.api("POST", `/api/admin/documents/${documentId}/reindex`, { agentSlug: "demo-one", revision: reembedTarget.revision, strategy: "reuseExistingChunks" });
  assert.equal(queued.status, 202);
  assert.equal(queued.data.type, "document.reembed");
  const active = await f.api("GET", "/api/admin/jobs/active");
  assert.equal(active.data.count, 1);
  assert.equal(active.data.jobs[0].id, queued.data.id);
  assert.equal((await f.api("GET", `/api/admin/jobs/${queued.data.id}`)).data.id, queued.data.id);

  const conflicting = await f.api("POST", `/api/admin/documents/${documentId}/reindex`, { agentSlug: "demo-one", revision: reembedTarget.revision, strategy: "full" });
  assert.equal(conflicting.status, 409);
  assert.equal(conflicting.data.code, "DOCUMENT_JOB_ACTIVE");
  assert.equal((await f.api("GET", `/api/admin/documents/${documentId}`)).data.document.status, "review");
});

test("multipart upload preserves Chinese filename and rejects unsupported types", async (t) => {
  const f = await fixture(t);
  const form = new FormData();
  form.append("file", new Blob(["测试可检索文件"], { type: "text/plain" }), "测试知识.txt");
  const response = await f.api("POST", "/api/admin/agents/demo-one/documents", form);
  assert.equal(response.status, 201);
  assert.equal(response.data.document.name, "测试知识.txt");
  const invalid = new FormData();
  invalid.append("file", new Blob(["script"], { type: "application/octet-stream" }), "program.exe");
  assert.equal((await f.api("POST", "/api/admin/agents/demo-one/documents", invalid)).status, 415);
});

test("local NAS mappings sync only their own folders and incrementally reindex changes", async (t) => {
  const nasRoot = await temporaryDirectory(t);
  await fs.mkdir(path.join(nasRoot, "alpha"));
  await fs.mkdir(path.join(nasRoot, "beta"));
  await fs.writeFile(path.join(nasRoot, "alpha", "alpha.txt"), "青竹代码：FIRST1，只属于甲智能体。", "utf8");
  await fs.writeFile(path.join(nasRoot, "beta", "beta.txt"), "蓝海代码：BETA2，只属于乙智能体。", "utf8");
  const f = await fixture(t, { env: { NAS_LOCAL_ROOT: nasRoot } });
  await f.api("POST", "/api/admin/agents", createInput("other-agent"));
  const sourceA = (await f.api("POST", "/api/admin/nas/sources", { name: "甲目录", agentSlug: "demo-one", transport: "local", path: "alpha", autoPublish: true, deleteMissing: true })).data;
  await f.api("POST", "/api/admin/nas/sources", { name: "乙目录", agentSlug: "other-agent", transport: "local", path: "beta", autoPublish: true });
  await f.drain();
  const docs = (await f.api("GET", "/api/admin/documents")).data;
  assert.equal(docs.length, 2);
  assert.equal(docs.find((doc) => doc.name === "alpha.txt").agentSlug, "demo-one");
  assert.equal(docs.find((doc) => doc.name === "beta.txt").agentSlug, "other-agent");
  assert.equal(docs.every((doc) => doc.status === "ready"), true);
  await fs.writeFile(path.join(nasRoot, "alpha", "alpha.txt"), "青竹代码现已更新为SECOND123，本次替换了旧代码。", "utf8");
  await f.api("POST", `/api/admin/nas/sources/${sourceA.id}/sync`);
  await f.drain();
  const current = (await f.api("GET", "/api/admin/documents?agentSlug=demo-one")).data;
  assert.equal(current.length, 1);
  assert.equal(current[0].revision, 2);
  const result = await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹代码" });
  assert.match(result.data.citations[0].text, /SECOND123/);
  assert.doesNotMatch(result.data.citations[0].text, /FIRST1/);
  await f.api("POST", `/api/admin/nas/sources/${sourceA.id}/sync`);
  await f.drain();
  assert.equal((await f.api("GET", "/api/admin/documents?agentSlug=demo-one")).data[0].revision, 2);
  await fs.unlink(path.join(nasRoot, "alpha", "alpha.txt"));
  await f.api("POST", `/api/admin/nas/sources/${sourceA.id}/sync`);
  await f.drain();
  assert.equal((await f.api("GET", "/api/admin/documents?agentSlug=demo-one")).data.length, 0);
  assert.equal((await f.api("GET", "/api/admin/documents?agentSlug=other-agent")).data.length, 1);
});

test("NAS source scopes are transactionally disjoint across and within agents", async (t) => {
  const f = await fixture(t);
  await f.api("POST", "/api/admin/agents", createInput("other-agent"));
  await f.api("POST", "/api/admin/agents", createInput("third-agent"));
  const first = await f.api("POST", "/api/admin/nas/sources", {
    name: "张医生知识库", agentSlug: "demo-one", transport: "s3", path: "医生知识库/张医生", enabled: false,
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.path, "医生知识库/张医生");

  for (const [agentSlug, sourcePath] of [
    ["other-agent", "医生知识库/张医生"],
    ["other-agent", "医生知识库"],
    ["other-agent", "医生知识库/张医生/子目录"],
    ["demo-one", "医生知识库/张医生/重复来源"],
  ]) {
    const conflict = await f.api("POST", "/api/admin/nas/sources", { name: "重叠来源", agentSlug, transport: "s3", path: sourcePath, enabled: false });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, "NAS_SOURCE_SCOPE_CONFLICT");
  }

  const sibling = await f.api("POST", "/api/admin/nas/sources", {
    name: "李医生知识库", agentSlug: "other-agent", transport: "s3", path: "医生知识库/李医生", enabled: false,
  });
  assert.equal(sibling.status, 201);
  const rejectedUpdate = await f.api("PUT", `/api/admin/nas/sources/${sibling.data.id}`, { path: "医生知识库/张医生/新资料" });
  assert.equal(rejectedUpdate.status, 409);
  assert.equal(rejectedUpdate.data.code, "NAS_SOURCE_SCOPE_CONFLICT");
  const afterRejectedUpdate = (await f.api("GET", "/api/admin/nas")).data.sources.find((source) => source.id === sibling.data.id);
  assert.equal(afterRejectedUpdate.path, "医生知识库/李医生");

  // Different transports have independently configured roots and therefore do not alias by path alone.
  assert.equal((await f.api("POST", "/api/admin/nas/sources", {
    name: "本地独立根", agentSlug: "third-agent", transport: "local", path: "医生知识库/张医生", enabled: false,
  })).status, 201);
  const localConflict = await f.api("POST", "/api/admin/nas/sources", {
    name: "本地重叠根", agentSlug: "other-agent", transport: "local", path: "医生知识库", enabled: false,
  });
  assert.equal(localConflict.status, 409);
  assert.equal(localConflict.data.code, "NAS_SOURCE_SCOPE_CONFLICT");
  assert.equal((await f.api("POST", "/api/admin/nas/sources", {
    name: "禁止桶根", agentSlug: "third-agent", transport: "s3", path: "", enabled: false,
  })).status, 400);

  const concurrent = await Promise.all([
    f.api("POST", "/api/admin/nas/sources", { name: "并发甲", agentSlug: "other-agent", transport: "s3", path: "并发范围/共享", enabled: false }),
    f.api("POST", "/api/admin/nas/sources", { name: "并发乙", agentSlug: "third-agent", transport: "s3", path: "并发范围/共享", enabled: false }),
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [201, 409]);
  assert.equal((await f.api("GET", "/api/admin/nas")).data.sources.filter((source) => source.transport === "s3" && source.path === "并发范围/共享").length, 1);

  const legacyParent = normalizeSource({ name: "旧库父目录", agentSlug: "demo-one", transport: "local", path: "旧库", enabled: false });
  const legacyChild = normalizeSource({ name: "旧库子目录", agentSlug: "other-agent", transport: "local", path: "旧库/子目录", enabled: false });
  const legacyEmptyS3 = { ...normalizeSource({ name: "旧空S3目录", agentSlug: "third-agent", transport: "s3", path: "placeholder", enabled: false }), path: "" };
  f.database.saveEntity("sources", legacyParent);
  f.database.saveEntity("sources", legacyChild);
  f.database.saveEntity("sources", legacyEmptyS3);
  const legacyStatus = (await f.api("GET", "/api/admin/nas")).data.sources;
  assert.equal(legacyStatus.find((source) => source.id === legacyParent.id).scopeIssue.code, "NAS_SOURCE_SCOPE_CONFLICT");
  assert.equal(legacyStatus.find((source) => source.id === legacyChild.id).scopeIssue.code, "NAS_SOURCE_SCOPE_CONFLICT");
  assert.equal(legacyStatus.find((source) => source.id === legacyEmptyS3.id).scopeIssue.code, "NAS_SOURCE_SCOPE_INVALID");
  for (const [sourceId, code] of [[legacyParent.id, "NAS_SOURCE_SCOPE_CONFLICT"], [legacyEmptyS3.id, "NAS_SOURCE_SCOPE_INVALID"]]) {
    const connectionTest = await f.api("POST", `/api/admin/nas/sources/${sourceId}/test`);
    assert.equal(connectionTest.status, 409);
    assert.equal(connectionTest.data.code, code);
    const manualSync = await f.api("POST", `/api/admin/nas/sources/${sourceId}/sync`);
    assert.equal(manualSync.status, 409);
    assert.equal(manualSync.data.code, code);
  }
});

test("failed or partial NAS scans never remove previously indexed documents", async (t) => {
  const nasRoot = await temporaryDirectory(t);
  await fs.mkdir(path.join(nasRoot, "source"));
  await fs.writeFile(path.join(nasRoot, "source", "original.txt"), "原始资料内容", "utf8");
  const env = { NAS_LOCAL_ROOT: nasRoot };
  const f = await fixture(t, { env });
  const source = (await f.api("POST", "/api/admin/nas/sources", { name: "安全同步", agentSlug: "demo-one", transport: "local", path: "source", autoPublish: true, deleteMissing: true })).data;
  await f.drain();
  await fs.unlink(path.join(nasRoot, "source", "original.txt"));
  await fs.writeFile(path.join(nasRoot, "source", "next-a.txt"), "新增甲资料", "utf8");
  await fs.writeFile(path.join(nasRoot, "source", "next-b.txt"), "新增乙资料", "utf8");
  env.NAS_MAX_FILES = "1";
  await f.api("POST", `/api/admin/nas/sources/${source.id}/sync`);
  await f.drain();
  assert.ok((await f.api("GET", "/api/admin/documents")).data.some((document) => document.name === "original.txt"));
  assert.equal(f.database.listSyncRuns()[0].stats.complete, false);
  await f.api("PUT", `/api/admin/nas/sources/${source.id}`, { path: "missing-directory" });
  await f.drain();
  assert.equal(f.database.listSyncRuns()[0].status, "failed");
  assert.ok((await f.api("GET", "/api/admin/documents")).data.some((document) => document.name === "original.txt"));
});

test("NAS connection setup errors are actionable and never expose credentials", async (t) => {
  const f = await fixture(t);
  const source = (await f.api("POST", "/api/admin/nas/sources", { name: "未配置连接", agentSlug: "demo-one", path: "knowledge", transport: "webdav", enabled: false })).data;
  const result = await f.api("POST", `/api/admin/nas/sources/${source.id}/test`);
  assert.equal(result.status, 503);
  assert.equal(result.data.code, "NAS_NOT_CONFIGURED");
  assert.match(result.data.error, /NAS_WEBDAV/);
});

test("content publication is visible publicly and unpublishing retracts its knowledge", async (t) => {
  const f = await fixture(t);
  const content = (await f.api("POST", "/api/admin/content", { agentSlug: "demo-one", title: "青竹说明", summary: "资料摘要", body: "青竹资料的测试代号是CONTENT9。", status: "published", type: "faq" })).data;
  const indexed = await f.api("POST", `/api/admin/content/${content.id}/index`);
  await f.drain();
  assert.equal((await f.request("GET", "/api/doctors/demo-one")).data.content.length, 1);
  assert.ok((await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹资料" })).data.citations.length > 0);
  await f.api("PUT", `/api/admin/content/${content.id}`, { status: "draft" });
  assert.equal((await f.request("GET", "/api/doctors/demo-one")).data.content.length, 0);
  assert.equal((await f.api("POST", "/api/admin/knowledge/search", { agentSlug: "demo-one", query: "青竹资料" })).data.citations.length, 0);
  assert.equal((await f.api("POST", `/api/admin/documents/${indexed.data.document.id}/approve`, {
    agentSlug: "demo-one", revision: indexed.data.document.revision,
  })).status, 409);
});

test("chat uses published model configuration plus approved RAG context and returns real citations", async (t) => {
  const requests = [];
  const f = await fixture(t, { env: { AI_API_KEY: "synthetic-test-key", AI_API_URL: "https://model.invalid/v1", AI_MODEL: "mock-model" },
    fetchImpl: async (url, options) => {
      requests.push({ url, payload: JSON.parse(options.body) });
      if (JSON.parse(options.body).stream) return new Response('data: {"choices":[{"delta":{"content":"测试知识答复。"}}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
      return Response.json({ choices: [{ message: { content: "根据资料[1]，青竹测试代号为RAG77。" } }] });
    } });
  const created = await f.api("POST", "/api/admin/agents/demo-one/documents/text", { name: "青竹资料", text: "青竹测试代号为RAG77。这是测试资料。", approved: true });
  await f.drain();
  await f.api("PUT", "/api/admin/agents/demo-one", { config: { systemPrompt: "已发布测试角色", temperature: 0.45, topP: 0.8, maxTokens: 1024 } });
  await f.api("POST", "/api/admin/agents/demo-one/publish");
  await f.api("PUT", "/api/admin/agents/demo-one", { config: { systemPrompt: "未发布的秘密草稿", temperature: 0.9 } });
  const chat = await f.request("POST", "/api/chat", { doctorSlug: "demo-one", message: "青竹测试代号是什么？" });
  assert.equal(chat.status, 200);
  assert.deepEqual(chat.data.citations, [{ title: "青竹资料.md" }]);
  assert.equal(new Set(chat.data.citations.map((citation) => citation.title)).size, chat.data.citations.length);
  assert.deepEqual(Object.keys(chat.data.citations[0]), ["title"]);
  assert.equal(chat.data.retrievalMode, "lexical");
  const payload = requests.at(-1).payload;
  assert.equal(payload.temperature, 0.45);
  assert.equal(payload.top_p, 0.8);
  assert.equal(payload.max_tokens, 1024);
  assert.ok(payload.messages.some((message) => message.content.includes("RAG77")));
  assert.match(payload.messages[0].content, /已发布测试角色/);
  assert.doesNotMatch(payload.messages[0].content, /未发布的秘密草稿/);
  assert.match(payload.messages[0].content, /不得进行诊断/);
  const preview = await f.api("POST", "/api/admin/agents/demo-one/chat", { message: "青竹测试代号是什么？" });
  assert.equal(preview.data.citations[0].documentId, created.data.document.id);
  assert.match(preview.data.citations[0].text, /RAG77/);
  const streamed = await f.request("POST", "/api/chat/stream", { doctorSlug: "demo-one", message: "青竹测试代号是什么？" });
  const events = streamed.data.trim().split("\n").map(JSON.parse);
  const done = events.find((event) => event.type === "done");
  assert.deepEqual(done.citations, [{ title: "青竹资料.md" }]);
  assert.deepEqual(Object.keys(done.citations[0]), ["title"]);
  assert.equal(done.retrievalMode, "lexical");
  assert.equal(f.database.overview().stats.conversations, 2);
  const storedUsage = f.database.sqlite.prepare("SELECT * FROM usage LIMIT 1").get();
  assert.equal(storedUsage.message, undefined);
  assert.equal(storedUsage.reply, undefined);
});

test("unconfigured model is explicit, while crisis response bypasses all remote services", async (t) => {
  let networkCalls = 0;
  const f = await fixture(t, { fetchImpl: async () => { networkCalls += 1; throw new Error("No external requests permitted"); } });
  const ordinary = await f.request("POST", "/api/chat", { doctorSlug: "demo-one", message: "普通科普问题" });
  assert.equal(ordinary.status, 503);
  assert.equal(ordinary.data.code, "AI_NOT_CONFIGURED");
  const crisis = await f.request("POST", "/api/chat", { doctorSlug: "demo-one", message: "我现在想伤害自己" });
  assert.equal(crisis.status, 200);
  assert.equal(crisis.data.crisis, true);
  assert.equal(crisis.data.citations.length, 0);
  assert.equal(networkCalls, 0);
});

test("SQLite persists draft/version data and safely requeues interrupted jobs after restart", async (t) => {
  const directory = await temporaryDirectory(t);
  let database = new PlatformDatabase({ dataDir: directory, seedDoctors: [seed] });
  database.createAgent(normalizeAgent(createInput("persisted-agent")), "test");
  database.publishAgent("persisted-agent", "test");
  const job = database.enqueue("nas.sync", { sourceId: "test-source" });
  assert.equal(database.claimJob().id, job.id);
  database.close();
  database = new PlatformDatabase({ dataDir: directory, seedDoctors: [] });
  assert.equal(database.getAgent("persisted-agent", true).version, 1);
  assert.equal(database.getJob(job.id).status, "queued");
  assert.equal(database.getJob(job.id).attempts, 1);
  database.close();
});
