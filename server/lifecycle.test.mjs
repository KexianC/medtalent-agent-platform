import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformDatabase } from "./database.mjs";
import { KnowledgeService } from "./knowledge-service.mjs";
import { normalizeAgent, normalizeContent, normalizeSource } from "./domain.mjs";

const seed = { slug: "lifecycle-agent", name: "生命周期助手", department: "科普", specialty: "状态一致性测试" };
const embeddingEnv = { EMBEDDING_API_URL: "https://embedding.invalid/v1/embeddings", EMBEDDING_API_KEY: "test-key", EMBEDDING_MODEL: "test-model" };
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
const davEnv = { NAS_WEBDAV_URL: "https://nas.invalid/root/", NAS_WEBDAV_USERNAME: "reader", NAS_WEBDAV_PASSWORD: "test-password" };
const contentBuffer = (content) => Buffer.from(`# ${content.title}\n\n${content.summary}\n\n${content.body}`);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const reembeddingResponse = (request) => {
  const texts = JSON.parse(request.body).input.texts;
  return Response.json({ output: { embeddings: texts.map((_, index) => {
    const embedding = Array(256).fill(0);
    embedding[index % embedding.length] = 1;
    return { text_index: index, embedding };
  }) } });
};

async function fixture(t, { env = {}, fetchImpl = fetch, s3ClientFactory } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-lifecycle-test-"));
  const database = new PlatformDatabase({ dataDir: directory, seedDoctors: [seed] });
  const knowledge = new KnowledgeService(database, { env, fetchImpl, s3ClientFactory });
  let closed = false;
  const closeDatabase = () => { if (!closed) { database.close(); closed = true; } };
  t.after(async () => {
    await knowledge.stop();
    closeDatabase();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("agent-platform-lifecycle-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const drain = async () => { let count = 0; while (await knowledge.runOne()) assert.ok(++count < 100, "queue must finish"); };
  const store = (input) => knowledge.storeDocument({ agentSlug: seed.slug, name: "知识.txt", buffer: Buffer.from("青竹资料测试内容"), ...input }, "test");
  const addContent = (patch = {}) => {
    const content = normalizeContent({ agentSlug: seed.slug, title: "青竹资料", summary: "参考说明", body: "青竹知识的最新代号是CURRENT1。", status: "published", ...patch });
    database.saveEntity("content", content);
    return content;
  };
  const storeContent = (content) => store({ name: `${content.title}.md`, buffer: contentBuffer(content), source: "content", sourceId: content.id, approved: content.status === "published" });
  const addSource = (patch = {}) => {
    const source = normalizeSource({ agentSlug: seed.slug, name: "生命周期NAS", transport: "webdav", path: "folder", autoPublish: true, deleteMissing: true, ...patch });
    database.saveEntity("sources", source);
    return source;
  };
  const sync = async (sourceId) => {
    const job = database.enqueue("nas.sync", { sourceId });
    await drain();
    return database.getJob(job.id);
  };
  return { database, knowledge, directory, drain, store, addContent, storeContent, addSource, sync, closeDatabase };
}

test("first-time content removal during disk I/O cannot create approved orphan knowledge", async (t) => {
  const f = await fixture(t);
  const content = f.addContent();
  const entered = deferred();
  const release = deferred();
  const originalWrite = f.knowledge.blobStorage.write.bind(f.knowledge.blobStorage);
  t.mock.method(f.knowledge.blobStorage, "write", async (...arguments_) => {
    const target = await originalWrite(...arguments_);
    entered.resolve();
    await release.promise;
    return target;
  });
  const pending = f.storeContent(content);
  await entered.promise;
  const rejected = assert.rejects(pending, { code: "CONTENT_CHANGED" });
  f.database.removeEntity("content", content.id);
  release.resolve();
  await rejected;
  assert.equal(f.database.listEntities("documents").length, 0);
  assert.equal(f.database.listJobs().length, 0);
  assert.deepEqual(await fs.readdir(f.knowledge.uploadDir), []);
});

test("concurrent first-time requests deduplicate the same linked content and queue atomically", async (t) => {
  const f = await fixture(t);
  const content = f.addContent();
  const results = await Promise.all([f.storeContent(content), f.storeContent(content)]);
  assert.equal(results[0].document.id, results[1].document.id);
  assert.equal(results.filter((result) => result.unchanged).length, 1);
  assert.equal(f.database.listEntities("documents").length, 1);
  assert.equal(f.database.listJobs().length, 1);
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, 1);
  await f.drain();
  assert.equal(f.database.listEntities("documents")[0].status, "ready");
});

test("document record and ingest job roll back together when enqueue fails", async (t) => {
  const f = await fixture(t);
  const mocked = t.mock.method(f.database, "enqueue", () => { throw new Error("synthetic queue failure"); });
  await assert.rejects(f.store({ approved: true }), /synthetic queue failure/);
  mocked.mock.restore();
  assert.equal(f.database.listEntities("documents").length, 0);
  assert.equal(f.database.listJobs().length, 0);
  assert.deepEqual(await fs.readdir(f.knowledge.uploadDir), []);
});

test("a concurrent document deletion wins over an older pending replacement", async (t) => {
  const f = await fixture(t);
  const first = await f.store({ approved: true });
  await f.drain();
  const existing = f.database.getEntity("documents", first.document.id);
  const entered = deferred();
  const release = deferred();
  const originalWrite = f.knowledge.blobStorage.write.bind(f.knowledge.blobStorage);
  t.mock.method(f.knowledge.blobStorage, "write", async (...arguments_) => {
    const target = await originalWrite(...arguments_);
    entered.resolve();
    await release.promise;
    return target;
  });
  const pending = f.store({ existing, buffer: Buffer.from("替换后的新资料"), approved: true });
  await entered.promise;
  const rejected = assert.rejects(pending, { code: "DOCUMENT_CHANGED" });
  await f.knowledge.deleteDocument(existing.id, "test");
  release.resolve();
  await rejected;
  assert.equal(f.database.getEntity("documents", existing.id).status, "deleted");
  assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0);
});

test("content changing during initial write rejects the old snapshot", async (t) => {
  const f = await fixture(t);
  const original = f.addContent();
  const pending = f.storeContent(original);
  f.database.saveEntity("content", normalizeContent({ body: "当前内容已经更新为NEW2。" }, original));
  await assert.rejects(pending, { code: "CONTENT_CHANGED" });
  assert.equal(f.database.listEntities("documents").length, 0);
});

test("content deletion or withdrawal during embedding cannot publish stale sources", async (t) => {
  for (const action of ["delete", "draft", "edit"]) {
    const entered = deferred();
    const release = deferred();
    const f = await fixture(t, { env: embeddingEnv, fetchImpl: async () => {
      entered.resolve();
      await release.promise;
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    } });
    const content = f.addContent();
    const stored = await f.storeContent(content);
    const running = f.knowledge.runOne();
    await entered.promise;
    if (action === "delete") f.database.removeEntity("content", content.id);
    else f.database.saveEntity("content", normalizeContent(action === "draft" ? { status: "draft" } : { body: "青竹资料已经切换到NEW3版本。" }, content));
    release.resolve();
    await running;
    const current = f.database.getEntity("documents", stored.document.id);
    assert.equal(current.approved, false, action);
    assert.equal(current.status, "review", action);
    assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0, action);
    await assert.rejects(() => f.knowledge.approveDocument(current.id, "test"), { code: "CONTENT_NOT_PUBLISHED" }, action);
  }
});

test("retrieval independently excludes a linked source whose current content was withdrawn", async (t) => {
  const f = await fixture(t);
  const content = f.addContent();
  await f.storeContent(content);
  await f.drain();
  assert.ok((await f.knowledge.search(seed.slug, "青竹资料")).citations.length);
  // Even a legacy record that still says ready/approved must not leak after a
  // content write that bypassed the HTTP route's eager invalidation.
  f.database.saveEntity("content", normalizeContent({ status: "draft" }, content));
  assert.equal(f.database.listEntities("documents")[0].status, "ready");
  assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0);
});

test("legacy NAS scope conflicts fail closed for ready knowledge, approval and queued ingestion", async (t) => {
  const f = await fixture(t);
  const source = f.addSource({ name: "历史父目录", transport: "local", path: "shared" });
  const ready = await f.store({
    name: "历史知识.txt", source: "nas", sourceId: source.id, sourcePath: "shared/ready.txt",
    sourceSignature: "ready-v1", approved: true,
  });
  await f.drain();
  assert.ok((await f.knowledge.search(seed.slug, "青竹资料")).citations.length);

  const queued = await f.store({
    name: "排队知识.txt", buffer: Buffer.from("排队中的青竹NAS资料"), source: "nas", sourceId: source.id,
    sourcePath: "shared/queued.txt", sourceSignature: "queued-v1", approved: true,
  });
  const otherAgent = normalizeAgent({ ...seed, slug: "legacy-overlap-agent", name: "历史冲突智能体" });
  f.database.createAgent(otherAgent, "test");
  f.addSource({ name: "历史子目录", agentSlug: otherAgent.slug, transport: "local", path: "shared/child" });

  assert.equal(f.database.getEntity("documents", ready.document.id).status, "ready");
  assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0);
  await assert.rejects(() => f.knowledge.approveDocument(ready.document.id, "test"), { code: "NAS_SOURCE_SCOPE_CONFLICT" });

  await f.drain();
  const blockedQueued = f.database.getEntity("documents", queued.document.id);
  assert.equal(blockedQueued.status, "review");
  assert.equal(blockedQueued.approved, false);
  assert.equal(blockedQueued.chunkCount, 0);
  assert.equal(f.database.getJob(queued.job.id).result.skipped, true);
  assert.equal((await f.knowledge.search(seed.slug, "排队中的青竹NAS资料")).citations.length, 0);
});

test("legacy NAS sources with persisted connection fields fail closed for every knowledge lifecycle", async (t) => {
  const f = await fixture(t);
  const source = f.addSource({ name: "历史连接字段", transport: "local", path: "legacy-private" });
  const ready = await f.store({
    name: "已索引历史资料.txt", source: "nas", sourceId: source.id, sourcePath: "legacy-private/ready.txt",
    sourceSignature: "ready-v1", approved: true,
  });
  await f.drain();
  assert.ok((await f.knowledge.search(seed.slug, "青竹资料")).citations.length);

  const queued = await f.store({
    name: "待索引历史资料.txt", buffer: Buffer.from("待处理的青竹历史资料"), source: "nas", sourceId: source.id,
    sourcePath: "legacy-private/queued.txt", sourceSignature: "queued-v1", approved: true,
  });
  f.database.patchEntity("sources", source.id, { secretAccessKey: "synthetic-legacy-secret" });

  const projected = (await f.knowledge.nasStatus()).sources.find((entry) => entry.id === source.id);
  assert.equal(projected.scopeIssue.code, "NAS_SOURCE_SCOPE_INVALID");
  assert.equal(projected.path, "[invalid legacy path]");
  assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0);
  await assert.rejects(() => f.knowledge.approveDocument(ready.document.id, "test"), { code: "NAS_SOURCE_SCOPE_INVALID" });
  await assert.rejects(f.store({
    name: "新历史资料.txt", source: "nas", sourceId: source.id, sourcePath: "legacy-private/new.txt",
    sourceSignature: "new-v1", approved: true,
  }), { code: "NAS_SOURCE_SCOPE_INVALID" });

  await f.drain();
  const blocked = f.database.getEntity("documents", queued.document.id);
  assert.equal(blocked.status, "review");
  assert.equal(blocked.approved, false);
  assert.equal(blocked.chunkCount, 0);
  assert.equal(f.database.getJob(queued.job.id).result.skipped, true);
});

test("legacy NAS document paths outside their source mapping fail closed", async (t) => {
  const f = await fixture(t);
  const source = f.addSource({ name: "租户A", transport: "local", path: "Tenant-A" });
  await assert.rejects(f.store({
    name: "越界新资料.txt", source: "nas", sourceId: source.id, sourcePath: "tenant-b/leak.txt",
    sourceSignature: "outside-new", approved: true,
  }), { code: "NAS_DOCUMENT_SOURCE_INVALID" });

  const ready = await f.store({
    name: "租户内资料.txt", source: "nas", sourceId: source.id, sourcePath: "Tenant-A/ready.txt",
    sourceSignature: "ready-inside", approved: true,
  });
  await f.drain();
  // Case-only differences must not pass: S3 and the canonical read boundary
  // both treat source prefixes as exact strings.
  f.database.patchEntity("documents", ready.document.id, { sourcePath: "tenant-a/leak.txt" });
  assert.equal((await f.knowledge.search(seed.slug, "青竹资料")).citations.length, 0);
  await assert.rejects(() => f.knowledge.approveDocument(ready.document.id, "test"), { code: "NAS_DOCUMENT_SOURCE_INVALID" });

  const queued = await f.store({
    name: "待处理租户资料.txt", buffer: Buffer.from("青竹排队越界资料"), source: "nas", sourceId: source.id,
    sourcePath: "Tenant-A/queued.txt", sourceSignature: "queued-inside", approved: true,
  });
  f.database.patchEntity("documents", queued.document.id, { sourcePath: "tenant-b/queued.txt" });
  await f.drain();
  const blocked = f.database.getEntity("documents", queued.document.id);
  assert.equal(blocked.status, "review");
  assert.equal(blocked.approved, false);
  assert.equal(blocked.chunkCount, 0);
  assert.equal(f.database.getJob(queued.job.id).result.skipped, true);
});

test("an older running ingest cannot overwrite a newer document revision", async (t) => {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const f = await fixture(t, { env: embeddingEnv, fetchImpl: async () => {
    if (++calls === 1) { entered.resolve(); await release.promise; }
    return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
  } });
  const original = await f.store({ approved: true, buffer: Buffer.from("青竹版本是OLD1。") });
  const running = f.knowledge.runOne();
  await entered.promise;
  await f.store({ existing: f.database.getEntity("documents", original.document.id), approved: true, buffer: Buffer.from("青竹版本已经更新为NEW2。") });
  release.resolve();
  await running;
  assert.equal(f.database.getJob(original.job.id).result.skipped, true);
  await f.drain();
  const current = f.database.getEntity("documents", original.document.id);
  assert.equal(current.revision, 2);
  assert.equal(current.status, "ready");
  assert.match(f.database.listChunks(current.id)[0].text, /NEW2/);
  assert.doesNotMatch(f.database.listChunks(current.id)[0].text, /OLD1/);
});

test("failed transient ingest can be explicitly retried without duplicate documents or chunks", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: true });
  const originalRead = fs.readFile;
  const mocked = t.mock.method(fs, "readFile", async (target, ...options) => {
    if (String(target).endsWith(".bin")) throw new Error("synthetic transient disk error");
    return originalRead(target, ...options);
  });
  await f.drain();
  mocked.mock.restore();
  assert.equal(f.database.getJob(stored.job.id).status, "failed");
  assert.equal(f.database.getEntity("documents", stored.document.id).status, "error");
  assert.equal(f.database.retryJob(stored.job.id).attempts, 0);
  await f.drain();
  assert.equal(f.database.getJob(stored.job.id).attempts, 1);
  assert.equal(f.database.getJob(stored.job.id).status, "completed");
  assert.equal(f.database.getEntity("documents", stored.document.id).status, "ready");
  assert.equal(f.database.listEntities("documents").length, 1);
  assert.equal(f.database.listChunks(stored.document.id).length, 1);
});

test("restart recovery fails an exhausted running ingest and releases its processing document", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: true });
  assert.equal(f.database.claimJob().id, stored.job.id);
  f.database.patchEntity("documents", stored.document.id, { status: "processing" });
  f.database.sqlite.prepare("UPDATE jobs SET attempts=max_attempts WHERE id=?").run(stored.job.id);
  f.closeDatabase();

  const database = new PlatformDatabase({ dataDir: f.directory });
  try {
    const job = database.getJob(stored.job.id);
    const document = database.getEntity("documents", stored.document.id);
    assert.equal(job.status, "failed");
    assert.equal(job.attempts, job.maxAttempts);
    assert.match(job.error, /最大重试次数/);
    assert.ok(job.finishedAt);
    assert.equal(document.status, "error");
    assert.match(document.error, /最大重试次数/);
    assert.equal(database.claimJob(), null);
    assert.equal(database.getJob(stored.job.id).attempts, job.maxAttempts);
  } finally { database.close(); }
});

test("claimJob closes legacy exhausted queued ingests before claiming eligible work", async (t) => {
  const f = await fixture(t);
  const exhausted = await f.store({ approved: true });
  f.database.sqlite.prepare("UPDATE jobs SET attempts=max_attempts WHERE id=?").run(exhausted.job.id);
  const eligible = f.database.enqueue("nas.sync", { sourceId: "later-source" });

  const claimed = f.database.claimJob();
  assert.equal(claimed.id, eligible.id);
  assert.equal(claimed.attempts, 1);
  const closed = f.database.getJob(exhausted.job.id);
  assert.equal(closed.status, "failed");
  assert.equal(closed.attempts, closed.maxAttempts);
  assert.match(closed.error, /最大重试次数/);
  assert.equal(f.database.getEntity("documents", exhausted.document.id).status, "error");
});

test("an explicit retry gives an exhausted failed job a fresh bounded attempt cycle", async (t) => {
  const f = await fixture(t);
  const job = f.database.enqueue("nas.sync", { sourceId: "manual-retry-source" });
  f.database.sqlite.prepare("UPDATE jobs SET status='failed',attempts=max_attempts,finished_at=? WHERE id=?")
    .run("2026-01-01T00:00:00.000Z", job.id);

  const retried = f.database.retryJob(job.id);
  assert.equal(retried.status, "queued");
  assert.equal(retried.attempts, 0);
  assert.equal(retried.startedAt, null);
  assert.equal(retried.finishedAt, null);
  const claimed = f.database.claimJob();
  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.attempts, 1);
});

test("reindex state change rolls back if creation of its replacement job fails", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: true });
  await f.drain();
  const mocked = t.mock.method(f.database, "enqueue", () => { throw new Error("reindex queue unavailable"); });
  await assert.rejects(() => f.knowledge.reindexDocument(stored.document.id, "test"), /reindex queue unavailable/);
  mocked.mock.restore();
  assert.equal(f.database.getEntity("documents", stored.document.id).status, "ready");
  assert.equal(f.database.listJobs().length, 1);
});

test("existing-chunk reembedding preserves chunk identity and text without reading the source blob", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  const before = f.database.listStoredChunkRows(original.id);
  assert.equal(original.status, "review");
  assert.equal(original.embeddingMode, "lexical");
  await fs.unlink(path.join(f.knowledge.uploadDir, original.storageKey));

  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async (_url, request) => reembeddingResponse(request);
  const job = await f.knowledge.reembedDocument(original.id, "migration-operator");
  assert.equal(job.type, "document.reembed");
  assert.equal(job.payload.operation, "reuseExistingChunks");
  assert.equal(job.payload.revision, original.revision);
  assert.equal(job.payload.chunkCount, original.chunkCount);
  assert.match(job.payload.chunkDigest, /^[0-9a-f]{64}$/);
  assert.equal(f.database.getEntity("documents", original.id).status, "review", "queueing must not change document state");

  await f.drain();
  const completed = f.database.getJob(job.id);
  const afterDocument = f.database.getEntity("documents", original.id);
  const after = f.database.listStoredChunkRows(original.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(after.map(({ id, document_id, agent_slug, position, text }) => ({ id, document_id, agent_slug, position, text })),
    before.map(({ id, document_id, agent_slug, position, text }) => ({ id, document_id, agent_slug, position, text })));
  assert.equal(after.every((row) => row.embedding_model === strictReembeddingEnv.EMBEDDING_MODEL), true);
  assert.equal(after.every((row) => JSON.parse(row.embedding).length === 256), true);
  assert.equal(afterDocument.status, "review");
  assert.equal(afterDocument.approved, false);
  assert.equal(afterDocument.embeddingMode, "hybrid");
  assert.equal(afterDocument.error, null);
  assert.equal(afterDocument.warning, null);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM audit WHERE action='document.reembed' AND actor='migration-operator' AND target=?").get(original.id).total, 1);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM audit WHERE action='document.reembedded' AND target=?").get(original.id).total, 1);
});

test("existing-chunk reembedding recovers an errored document with intact lexical chunks", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  const before = f.database.listStoredChunkRows(original.id);
  f.database.patchEntity("documents", original.id, {
    status: "error", approved: false, error: "synthetic parser exhaustion", updatedAt: new Date().toISOString(),
  });
  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async (_url, request) => reembeddingResponse(request);

  const job = await f.knowledge.reembedDocument(original.id, "migration-operator");
  await f.drain();

  const afterDocument = f.database.getEntity("documents", original.id);
  const after = f.database.listStoredChunkRows(original.id);
  assert.equal(f.database.getJob(job.id).status, "completed");
  assert.equal(afterDocument.status, "review");
  assert.equal(afterDocument.approved, false);
  assert.equal(afterDocument.embeddingMode, "hybrid");
  assert.equal(afterDocument.error, null);
  assert.deepEqual(after.map(({ id, position, text }) => ({ id, position, text })),
    before.map(({ id, position, text }) => ({ id, position, text })));
});

test("existing-chunk reembedding rolls back every vector when chunks change during the provider call", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async (_url, request) => {
    entered.resolve();
    await release.promise;
    return reembeddingResponse(request);
  };
  const job = await f.knowledge.reembedDocument(original.id);
  const running = f.knowledge.runOne();
  await entered.promise;
  f.database.sqlite.prepare("UPDATE chunks SET text=text || '变更' WHERE document_id=?").run(original.id);
  release.resolve();
  await running;

  assert.equal(f.database.getJob(job.id).status, "failed");
  assert.equal(f.database.getEntity("documents", original.id).embeddingMode, "lexical");
  assert.equal(f.database.listStoredChunkRows(original.id).every((row) => row.embedding === null && row.embedding_model === null), true);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM audit WHERE action='document.reembedded' AND target=?").get(original.id).total, 0);
});

test("existing-chunk reembedding treats lexical provider fallback as a hard failure", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async () => Response.json({}, { status: 500 });
  const job = await f.knowledge.reembedDocument(original.id);
  await f.drain();

  assert.equal(f.database.getJob(job.id).status, "failed");
  assert.equal(f.database.getEntity("documents", original.id).embeddingMode, "lexical");
  assert.equal(f.database.listStoredChunkRows(original.id).every((row) => row.embedding === null && row.embedding_model === null), true);
});

test("document jobs are mutually exclusive across full reindex and existing-chunk reembedding", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async (_url, request) => reembeddingResponse(request);
  const reembed = await f.knowledge.reembedDocument(original.id);
  assert.equal((await f.knowledge.reembedDocument(original.id)).id, reembed.id, "the exact same active strategy must deduplicate");
  await assert.rejects(() => f.knowledge.reindexDocument(original.id, "test"), { code: "DOCUMENT_JOB_ACTIVE" });
  assert.equal(f.database.getEntity("documents", original.id).status, "review", "failed cross-strategy enqueue must roll back its queued state");
  assert.equal(f.database.listActiveJobs().length, 1);
  assert.equal(f.database.listActiveJobs()[0].id, reembed.id);
});

test("an active existing-chunk reembed blocks every reverse knowledge-job enqueue and retry", async (t) => {
  const f = await fixture(t);
  const first = await f.store({ name: "第一份.txt", approved: false });
  await f.drain();
  const second = await f.store({ name: "第二份.txt", buffer: Buffer.from("第二份青竹资料"), approved: false });
  await f.drain();
  const failedNas = f.database.enqueue("nas.sync", { sourceId: "failed-before-maintenance" });
  f.database.sqlite.prepare("UPDATE jobs SET status='failed',finished_at=? WHERE id=?")
    .run(new Date().toISOString(), failedNas.id);
  const documentsBefore = f.database.listEntities("documents").length;
  const blobsBefore = (await fs.readdir(f.knowledge.uploadDir)).length;

  f.knowledge.env = strictReembeddingEnv;
  const reembed = await f.knowledge.reembedDocument(first.document.id);
  await assert.rejects(() => f.knowledge.reindexDocument(second.document.id, "test"), { code: "REEMBED_EXCLUSIVE_ACTIVE" });
  assert.equal(f.database.getEntity("documents", second.document.id).status, "review");
  assert.throws(() => f.database.enqueue("nas.sync", { sourceId: "manual-during-reembed" }), { code: "REEMBED_EXCLUSIVE_ACTIVE" });
  assert.throws(() => f.database.retryJob(failedNas.id), { code: "REEMBED_EXCLUSIVE_ACTIVE" });
  await assert.rejects(f.store({ name: "插队上传.txt", buffer: Buffer.from("不得插队") }), { code: "REEMBED_EXCLUSIVE_ACTIVE" });
  assert.equal(f.database.listEntities("documents").length, documentsBefore);
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, blobsBefore);
  assert.deepEqual(f.database.listActiveJobs().map((job) => job.id), [reembed.id]);
});

test("existing-chunk reembedding pins the controlled DashScope endpoint", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  f.knowledge.env = {
    ...strictReembeddingEnv,
    EMBEDDING_API_URL: "https://example.invalid/api/v1/services/embeddings/text-embedding/text-embedding",
  };
  await assert.rejects(() => f.knowledge.reembedDocument(stored.document.id), { code: "REEMBED_CONFIG_MISMATCH" });
  assert.equal(f.database.listActiveJobs().length, 0);
});

test("retrying a failed reembed cannot cross an active full ingest for the same document", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  f.knowledge.env = strictReembeddingEnv;
  const reembed = await f.knowledge.reembedDocument(original.id);
  f.database.sqlite.prepare("UPDATE jobs SET status='failed',finished_at=? WHERE id=?")
    .run(new Date().toISOString(), reembed.id);
  const ingest = await f.knowledge.reindexDocument(original.id, "test");
  assert.equal(ingest.type, "document.ingest");
  assert.throws(() => f.database.retryJob(reembed.id), { code: "DOCUMENT_JOB_ACTIVE" });
  assert.equal(f.database.getJob(reembed.id).status, "failed");
});

test("a later chunk update failure rolls back every earlier vector update atomically", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false, buffer: Buffer.from("甲".repeat(1200)) });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  assert.ok(original.chunkCount > 1);
  f.knowledge.env = strictReembeddingEnv;
  f.knowledge.fetchImpl = async (_url, request) => reembeddingResponse(request);
  f.database.sqlite.exec(`CREATE TRIGGER fail_later_vector_update BEFORE UPDATE OF embedding ON chunks
    WHEN OLD.document_id='${original.id}' AND OLD.position=1
    BEGIN SELECT RAISE(ABORT,'synthetic vector write failure'); END`);
  const job = await f.knowledge.reembedDocument(original.id);
  await f.drain();
  assert.equal(f.database.getJob(job.id).status, "failed");
  assert.equal(f.database.getEntity("documents", original.id).embeddingMode, "lexical");
  assert.equal(f.database.listStoredChunkRows(original.id).every((row) => row.embedding === null && row.embedding_model === null), true);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) total FROM audit WHERE action='document.reembedded' AND target=?").get(original.id).total, 0);
});

test("due NAS sources are not scheduled ahead of a queued existing-chunk reembed", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: false });
  await f.drain();
  const original = f.database.getEntity("documents", stored.document.id);
  f.addSource({ enabled: true, lastSyncAt: null });
  f.knowledge.env = strictReembeddingEnv;
  const reembed = await f.knowledge.reembedDocument(original.id);
  await f.knowledge.scheduleDueSources();
  assert.equal(f.database.listJobs().filter((job) => job.type === "nas.sync" && ["queued", "running"].includes(job.status)).length, 0);
  assert.equal(f.database.claimJob().id, reembed.id);
});

test("restarting a worker resumes an interrupted ingest and replaces chunks once", async (t) => {
  const f = await fixture(t);
  const stored = await f.store({ approved: true });
  f.database.claimJob();
  f.database.patchEntity("documents", stored.document.id, { status: "processing" });
  f.closeDatabase();
  const database = new PlatformDatabase({ dataDir: f.directory });
  const knowledge = new KnowledgeService(database, { env: {} });
  try {
    assert.equal(database.getJob(stored.job.id).status, "queued");
    assert.equal(await knowledge.runOne(), true);
    assert.equal(database.getEntity("documents", stored.document.id).status, "ready");
    assert.equal(database.getJob(stored.job.id).attempts, 2);
    assert.equal(database.listChunks(stored.document.id).length, 1);
    assert.equal(await knowledge.runOne(), false);
  } finally { await knowledge.stop(); database.close(); }
});

test("archiving an agent blocks public retrieval while draft rollback leaves its published snapshot unchanged", async (t) => {
  const f = await fixture(t);
  f.database.saveAgent(normalizeAgent({ name: "未发布改名" }, f.database.requireAgent(seed.slug)), "test");
  assert.equal(f.database.getAgent(seed.slug, true).name, seed.name);
  f.database.rollbackAgent(seed.slug, 1, "test");
  assert.equal(f.database.getAgent(seed.slug, true).version, 1);
  f.database.archiveAgent(seed.slug, "test");
  await assert.rejects(f.knowledge.search(seed.slug, "资料", { published: true }), { code: "AGENT_NOT_FOUND" });
});

test("knowledge search rejects missing or structured agent identifiers before SQLite binding", async (t) => {
  const f = await fixture(t);
  for (const invalid of [undefined, {}, [], [seed.slug], "../other"]) {
    await assert.rejects(f.knowledge.search(invalid, "资料"), { code: "INVALID_INPUT", statusCode: 400 });
  }
});

const xmlEntry = (href, { directory = false, size = 4, etag = '"v1"' } = {}) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? "<d:collection/>" : ""}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Thu, 03 Sep 2026 02:00:00 GMT</d:getlastmodified><d:getetag>${etag}</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const manifest = (...entries) => new Response(`<d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207 });

test("NAS download budget continues changed versions across rounds and only deletes after a full successful round", async (t) => {
  const gets = [];
  const contents = { "a.txt": "AAAA", "b.txt": "BBBB", "c.txt": "CCCC" };
  const f = await fixture(t, { env: { ...davEnv, NAS_SYNC_MAX_FILES_PER_RUN: "1" }, fetchImpl: async (url, options) => {
    if (options.method === "PROPFIND") return manifest(xmlEntry("/root/folder/", { directory: true }), ...Object.keys(contents).map((name) => xmlEntry(`/root/folder/${name}`)));
    const name = new URL(url).pathname.split("/").at(-1);
    gets.push(name);
    return new Response(contents[name], { headers: { etag: '"v1"' } });
  } });
  const source = f.addSource();
  const missing = await f.store({ source: "nas", sourceId: source.id, sourcePath: "folder/missing.txt", sourceSignature: "old-version", approved: true });
  await f.drain();
  for (let round = 1; round <= 3; round += 1) {
    const job = await f.sync(source.id);
    assert.equal(job.result.attempted, 1);
    assert.equal(job.result.deferred, 3 - round);
    assert.equal(job.result.complete, round === 3);
    assert.equal(job.result.truncated, round !== 3);
    assert.equal(f.database.getEntity("documents", missing.document.id).status, round === 3 ? "deleted" : "ready");
  }
  assert.deepEqual(gets, ["a.txt", "b.txt", "c.txt"]);
  assert.deepEqual(f.database.getEntity("sources", source.id).syncFailureOrder, []);
});

test("a persistent first-file failure cannot starve later changed NAS files under a one-file budget", async (t) => {
  const gets = [];
  const f = await fixture(t, { env: { ...davEnv, NAS_SYNC_MAX_FILES_PER_RUN: "1" }, fetchImpl: async (url, options) => {
    if (options.method === "PROPFIND") return manifest(xmlEntry("/root/folder/", { directory: true }), xmlEntry("/root/folder/a-bad.txt"), xmlEntry("/root/folder/b-good.txt"));
    const name = new URL(url).pathname.split("/").at(-1);
    gets.push(name);
    return name === "a-bad.txt" ? new Response(null, { status: 403 }) : new Response("GOOD", { headers: { etag: '"v1"' } });
  } });
  const source = f.addSource();
  const first = await f.sync(source.id);
  assert.equal(first.result.failed, 1);
  assert.equal(first.result.complete, false);
  const second = await f.sync(source.id);
  assert.equal(second.result.created, 1);
  assert.equal(second.result.deferred, 1);
  assert.deepEqual(gets, ["a-bad.txt", "b-good.txt"]);
  assert.equal(f.database.listEntities("documents")[0].status, "ready");
  assert.equal(f.database.getEntity("sources", source.id).syncFailureOrder[0].path, "folder/a-bad.txt");
});

test("NAS fair retry order survives a process restart and still advances past the failed first file", async (t) => {
  const gets = [];
  const env = { ...davEnv, NAS_SYNC_MAX_FILES_PER_RUN: "1" };
  const fetchImpl = async (url, options) => {
    if (options.method === "PROPFIND") return manifest(xmlEntry("/root/folder/", { directory: true }), xmlEntry("/root/folder/a-bad.txt"), xmlEntry("/root/folder/b-good.txt"));
    const name = new URL(url).pathname.split("/").at(-1);
    gets.push(name);
    return name === "a-bad.txt" ? new Response(null, { status: 403 }) : new Response("GOOD", { headers: { etag: '"v1"' } });
  };
  const f = await fixture(t, { env, fetchImpl });
  const source = f.addSource();
  await f.sync(source.id);
  f.closeDatabase();
  const database = new PlatformDatabase({ dataDir: f.directory });
  const knowledge = new KnowledgeService(database, { env, fetchImpl });
  try {
    assert.equal(database.getEntity("sources", source.id).syncFailureOrder[0].path, "folder/a-bad.txt");
    database.enqueue("nas.sync", { sourceId: source.id });
    let count = 0;
    while (await knowledge.runOne()) assert.ok(++count < 10);
    assert.deepEqual(gets, ["a-bad.txt", "b-good.txt"]);
    assert.equal(database.listEntities("documents")[0].status, "ready");
  } finally { await knowledge.stop(); database.close(); }
});

test("NAS manifest warnings remain visible in sync statistics, source status and connection tests", async (t) => {
  const f = await fixture(t, { env: davEnv, fetchImpl: async () => manifest(xmlEntry("/root/folder/", { directory: true }), xmlEntry("https://outside.invalid/file.txt")) });
  const source = f.addSource();
  const job = await f.sync(source.id);
  assert.equal(job.result.complete, false);
  assert.match(job.result.warning, /不安全|不可访问/);
  assert.match(f.database.getEntity("sources", source.id).lastError, /不安全|不可访问/);
  assert.match((await f.knowledge.testSource(source.id)).warning, /不安全|不可访问/);
});

test("NAS source revision edits during downloads or file storage cancel the old mapping's commit", async (t) => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture(t, { env: davEnv, fetchImpl: async (_url, options) => {
    if (options.method === "PROPFIND") return manifest(xmlEntry("/root/folder/", { directory: true }), xmlEntry("/root/folder/a.txt"));
    entered.resolve();
    await release.promise;
    return new Response("AAAA", { headers: { etag: '"v1"' } });
  } });
  const source = f.addSource();
  const job = f.database.enqueue("nas.sync", { sourceId: source.id });
  const running = f.knowledge.runOne();
  await entered.promise;
  const next = normalizeSource({ path: "new-folder" }, source);
  f.database.saveEntity("sources", next);
  release.resolve();
  await running;
  assert.equal(f.database.getJob(job.id).status, "failed");
  assert.match(f.database.getJob(job.id).error, /映射已修改/);
  assert.equal(f.database.listEntities("documents").length, 0);
  assert.equal(f.database.getEntity("sources", source.id).lastStatus, "never");
  const storeEntered = deferred();
  const storeRelease = deferred();
  const originalWrite = f.knowledge.blobStorage.write.bind(f.knowledge.blobStorage);
  t.mock.method(f.knowledge.blobStorage, "write", async (...arguments_) => {
    const target = await originalWrite(...arguments_);
    storeEntered.resolve();
    await storeRelease.promise;
    return target;
  });
  const store = f.store({ source: "nas", sourceId: source.id, sourcePath: "new-folder/a.txt", sourceSignature: "v2", approved: true });
  await storeEntered.promise;
  const rejected = assert.rejects(store, { code: "SOURCE_CHANGED" });
  f.database.saveEntity("sources", normalizeSource({ enabled: false }, next));
  storeRelease.resolve();
  await rejected;
  assert.equal(f.database.listEntities("documents").length, 0);
});

test("legacy overlapping or invalid NAS sources fail closed while a disjoint source keeps syncing", async (t) => {
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-source-scope-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(localRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(localRoot).startsWith("agent-platform-source-scope-test-"));
    await fs.rm(localRoot, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(localRoot, "legacy-local", "child"), { recursive: true });
  await fs.mkdir(path.join(localRoot, "安全来源"), { recursive: true });
  await fs.writeFile(path.join(localRoot, "legacy-local", "parent.txt"), "PARENT");
  await fs.writeFile(path.join(localRoot, "legacy-local", "child", "child.txt"), "CHILD");
  await fs.writeFile(path.join(localRoot, "安全来源", "safe.txt"), "SAFE");

  let webdavCalls = 0;
  let s3Calls = 0;
  const env = {
    ...davEnv,
    NAS_LOCAL_ROOT: localRoot,
    NAS_S3_ENDPOINT: "https://minio.invalid",
    NAS_S3_REGION: "us-east-1",
    NAS_S3_BUCKET: "knowledge",
    NAS_S3_ACCESS_KEY_ID: "test-access",
    NAS_S3_SECRET_ACCESS_KEY: "test-secret",
  };
  const f = await fixture(t, {
    env,
    fetchImpl: async () => { webdavCalls += 1; throw new Error("unsafe WebDAV source was read"); },
    s3ClientFactory: () => ({
      send: async () => { s3Calls += 1; throw new Error("unsafe S3 source was read"); },
      destroy() {},
    }),
  });
  const otherAgent = normalizeAgent({ ...seed, slug: "other-agent", name: "另一智能体" });
  f.database.createAgent(otherAgent, "test");
  const legacySource = (name, agentSlug, transport, sourcePath, patch = {}) => {
    const canonical = normalizeSource({ name, agentSlug, transport: transport === "minio" ? "s3" : transport, path: sourcePath, enabled: true, autoPublish: true });
    const source = { ...canonical, transport, ...patch };
    f.database.saveEntity("sources", source);
    return source;
  };

  const unsafe = [
    legacySource("本地父目录", seed.slug, "local", "legacy-local"),
    legacySource("本地子目录", otherAgent.slug, "local", "legacy-local/child"),
    legacySource("DAV父目录", seed.slug, "webdav", "legacy-dav"),
    legacySource("DAV子目录", otherAgent.slug, "webdav", "legacy-dav/child"),
    legacySource("S3父目录", seed.slug, "s3", "legacy-s3"),
    legacySource("MinIO旧别名子目录", otherAgent.slug, "minio", "legacy-s3/child"),
    legacySource("旧编码目录", seed.slug, "local", "placeholder", { path: "legacy/%252e%252e/escape" }),
  ];
  const safe = legacySource("安全中文目录", seed.slug, "local", "安全来源");

  const status = await f.knowledge.nasStatus();
  for (const source of unsafe) assert.match(status.sources.find((item) => item.id === source.id).scopeIssue.code, /^NAS_SOURCE_SCOPE_(?:CONFLICT|INVALID)$/);
  assert.equal(status.sources.find((item) => item.id === safe.id).scopeIssue, null);
  await assert.rejects(f.knowledge.testSource(unsafe[0].id), { code: "NAS_SOURCE_SCOPE_CONFLICT" });
  await assert.rejects(f.knowledge.testSource(unsafe[6].id), { code: "NAS_SOURCE_SCOPE_INVALID" });
  await assert.rejects(f.knowledge.sync({ id: "manual-conflict", payload: { sourceId: unsafe[0].id } }), { code: "NAS_SOURCE_SCOPE_CONFLICT" });
  await assert.rejects(f.knowledge.sync({ id: "manual-invalid", payload: { sourceId: unsafe[6].id } }), { code: "NAS_SOURCE_SCOPE_INVALID" });

  await f.knowledge.scheduleDueSources();
  const scheduledSourceIds = f.database.listJobs().filter((job) => job.type === "nas.sync").map((job) => job.payload.sourceId);
  assert.deepEqual(scheduledSourceIds, [safe.id]);

  const forced = unsafe.map((source) => f.database.enqueue("nas.sync", { sourceId: source.id }));
  await f.drain();
  for (const job of forced) {
    assert.equal(f.database.getJob(job.id).status, "failed");
    assert.match(f.database.getJob(job.id).error, /目录.*(?:重叠|安全规则)/);
  }
  assert.equal(webdavCalls, 0);
  assert.equal(s3Calls, 0);
  assert.deepEqual(f.database.listEntities("documents").filter((document) => document.status !== "deleted").map((document) => document.sourcePath), ["安全来源/safe.txt"]);
  assert.equal(f.database.getEntity("sources", unsafe[5].id).transport, "minio");
  assert.equal(f.database.getEntity("sources", unsafe[6].id).path, "legacy/%252e%252e/escape");
});
