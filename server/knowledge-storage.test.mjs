import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PlatformDatabase } from "./database.mjs";
import { KnowledgeService } from "./knowledge-service.mjs";
import { normalizeSource } from "./domain.mjs";

const seed = { slug: "storage-agent", name: "存储边界助手", department: "测试", specialty: "知识存储" };
const exists = (target) => fs.access(target).then(() => true, () => false);

async function fixture(t, { env = {}, fileSystem = fs } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-storage-test-"));
  const database = new PlatformDatabase({ dataDir: directory, seedDoctors: [seed] });
  const knowledge = new KnowledgeService(database, { env, fileSystem });
  t.after(async () => {
    await knowledge.stop();
    database.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("agent-platform-storage-test-"));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const store = (input = {}) => knowledge.storeDocument({
    agentSlug: seed.slug,
    name: "知识.txt",
    buffer: Buffer.from("first"),
    ...input,
  }, "test");
  return { directory, database, knowledge, store };
}

test("updating a document retires its previous blob and keeps only the current version", async (t) => {
  const f = await fixture(t);
  const first = await f.store({ buffer: Buffer.from("version-one") });
  const before = f.database.getEntity("documents", first.document.id);
  const oldPath = path.join(f.knowledge.uploadDir, before.storageKey);

  await f.store({ existing: before, buffer: Buffer.from("version-two") });
  const current = f.database.getEntity("documents", before.id);

  assert.notEqual(current.storageKey, before.storageKey);
  assert.equal(await exists(oldPath), false);
  assert.equal(await exists(path.join(f.knowledge.uploadDir, current.storageKey)), true);
  assert.deepEqual((await fs.readdir(f.knowledge.uploadDir)).sort(), [current.storageKey]);
});

test("GC never removes a blob while any document references it and a sweep recovers true orphans", async (t) => {
  const f = await fixture(t);
  const first = await f.store();
  const original = f.database.getEntity("documents", first.document.id);
  const sharedId = randomUUID();
  f.database.saveEntity("documents", { ...original, id: sharedId, name: "共享引用.txt", source: "legacy", sourceId: sharedId });

  await f.store({ existing: original, buffer: Buffer.from("second") });
  const current = f.database.getEntity("documents", original.id);
  const oldPath = path.join(f.knowledge.uploadDir, original.storageKey);
  assert.equal(await exists(oldPath), true, "second document still references the old blob");

  const orphanKey = `${randomUUID()}.bin`;
  await fs.writeFile(path.join(f.knowledge.uploadDir, orphanKey), "orphan");
  f.database.patchEntity("documents", sharedId, { storageKey: current.storageKey, size: current.size });
  const result = await f.knowledge.garbageCollectBlobs({ sweep: true, force: true });

  assert.equal(result.failed, 0);
  assert.equal(await exists(oldPath), false);
  assert.equal(await exists(path.join(f.knowledge.uploadDir, orphanKey)), false);
  assert.equal(await exists(path.join(f.knowledge.uploadDir, current.storageKey)), true, "current references must survive a full sweep");
});

test("GC defers while an online backup owns the maintenance lock and resumes afterward", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.knowledge.uploadDir, { recursive: true });
  const orphanKey = `${randomUUID()}.bin`;
  const orphanPath = path.join(f.knowledge.uploadDir, orphanKey);
  await fs.writeFile(orphanPath, "orphan");
  await fs.mkdir(f.knowledge.blobStorage.lockDirectory);
  const deferred = await f.knowledge.garbageCollectBlobs({ sweep: true, force: true });
  assert.equal(deferred.deferred, true);
  assert.equal(await exists(orphanPath), true);

  await fs.rmdir(f.knowledge.blobStorage.lockDirectory);
  const resumed = await f.knowledge.garbageCollectBlobs({ force: true });
  assert.equal(resumed.deleted, 1);
  assert.equal(await exists(orphanPath), false);
});

test("GC stops before unlink when its renewable maintenance lease is replaced", async (t) => {
  let lockDirectory;
  let ownerPath;
  let replaced = false;
  const fileSystem = Object.create(fs);
  fileSystem.readdir = async (...arguments_) => {
    const entries = await fs.readdir(...arguments_);
    if (!replaced && lockDirectory) {
      replaced = true;
      const lockEntries = await fs.readdir(lockDirectory);
      for (const entry of lockEntries.filter((name) => name.startsWith(".owner-"))) await fs.unlink(path.join(lockDirectory, entry));
      await fs.rmdir(lockDirectory);
      await fs.mkdir(lockDirectory);
      ownerPath = path.join(lockDirectory, ".owner-dddddddd-dddd-4ddd-8ddd-dddddddddddd");
      await fs.writeFile(ownerPath, JSON.stringify({ version: 1, token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }));
    }
    return entries;
  };
  const f = await fixture(t, { fileSystem });
  lockDirectory = f.knowledge.blobStorage.lockDirectory;
  await fs.mkdir(f.knowledge.uploadDir, { recursive: true });
  const orphanKey = `${randomUUID()}.bin`;
  const orphanPath = path.join(f.knowledge.uploadDir, orphanKey);
  await fs.writeFile(orphanPath, "must survive lost ownership");

  await assert.rejects(f.knowledge.garbageCollectBlobs({ sweep: true, force: true }), { code: "LEASE_COMPROMISED" });
  assert.equal(await exists(orphanPath), true);
  assert.equal((await fs.stat(lockDirectory)).isDirectory(), true, "old release must preserve the replacement lease");
  await fs.unlink(ownerPath);
  await fs.rmdir(lockDirectory);
  const recovered = await f.knowledge.garbageCollectBlobs({ sweep: true, force: true });
  assert.equal(recovered.deleted, 1);
  assert.equal(await exists(orphanPath), false);
});

test("a transient unlink failure never fails the update and is retried later", async (t) => {
  let failTarget = null;
  let failedOnce = false;
  const fileSystem = Object.create(fs);
  fileSystem.unlink = async (target) => {
    if (!failedOnce && failTarget && path.resolve(target) === path.resolve(failTarget)) {
      failedOnce = true;
      throw Object.assign(new Error("synthetic busy file"), { code: "EBUSY" });
    }
    return fs.unlink(target);
  };
  const f = await fixture(t, { fileSystem });
  const first = await f.store();
  const original = f.database.getEntity("documents", first.document.id);
  failTarget = path.join(f.knowledge.uploadDir, original.storageKey);

  const update = await f.store({ existing: original, buffer: Buffer.from("replacement") });
  assert.equal(update.unchanged, false);
  assert.equal(await exists(failTarget), true);
  assert.equal(f.knowledge.blobStorage.retired.has(original.storageKey), true);

  const retry = await f.knowledge.garbageCollectBlobs({ force: true });
  assert.equal(retry.failed, 0);
  assert.equal(await exists(failTarget), false);
  const current = f.database.getEntity("documents", original.id);
  assert.equal(await exists(path.join(f.knowledge.uploadDir, current.storageKey)), true);
});

test("a failed write that leaves a partial file is recovered without a database reference", async (t) => {
  let failOnce = true;
  const fileSystem = Object.create(fs);
  fileSystem.writeFile = async (...arguments_) => {
    await fs.writeFile(...arguments_);
    if (failOnce) {
      failOnce = false;
      throw Object.assign(new Error("synthetic post-write failure"), { code: "EIO" });
    }
  };
  const f = await fixture(t, { fileSystem });
  await assert.rejects(f.store(), /synthetic post-write failure/);
  assert.equal(f.database.listEntities("documents").length, 0);
  assert.equal(f.database.listJobs().length, 0);
  assert.deepEqual(await fs.readdir(f.knowledge.uploadDir), []);
});

test("agent quotas count projected replacements, allow exact boundaries and reject excess growth", async (t) => {
  const f = await fixture(t, { env: {
    KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT: "2",
    KNOWLEDGE_MAX_BYTES_PER_AGENT: "10",
    KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE: "10",
    KNOWLEDGE_MAX_BYTES_PER_SOURCE: "10",
  } });
  const first = await f.store({ name: "a.txt", buffer: Buffer.from("aaaa") });
  await f.store({ name: "b.txt", source: "text", buffer: Buffer.from("bbbbbb") });
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, 2);

  await assert.rejects(f.store({ name: "c.txt", buffer: Buffer.from("x") }), { code: "KNOWLEDGE_AGENT_DOCUMENT_QUOTA", statusCode: 413 });
  const existing = f.database.getEntity("documents", first.document.id);
  await assert.rejects(f.store({ existing, name: "a.txt", buffer: Buffer.from("ccccc") }), { code: "KNOWLEDGE_AGENT_BYTES_QUOTA", statusCode: 413 });
  await f.store({ existing, name: "a.txt", buffer: Buffer.from("dddd") });

  assert.equal(f.database.listEntities("documents").length, 2);
  assert.equal(f.database.listEntities("documents").reduce((total, document) => total + document.size, 0), 10);
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, 2);
});

test("the transactional quota recheck prevents concurrent uploads from bypassing the limit", async (t) => {
  const f = await fixture(t, { env: {
    KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT: "1",
    KNOWLEDGE_MAX_BYTES_PER_AGENT: "100",
    KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE: "10",
    KNOWLEDGE_MAX_BYTES_PER_SOURCE: "100",
  } });
  const results = await Promise.allSettled([
    f.store({ name: "one.txt", buffer: Buffer.from("one") }),
    f.store({ name: "two.txt", buffer: Buffer.from("two") }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "KNOWLEDGE_AGENT_DOCUMENT_QUOTA");
  assert.equal(f.database.listEntities("documents").length, 1);
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, 1);
});

test("soft-deleted documents release quota and retire their no-longer-current blob", async (t) => {
  const f = await fixture(t, { env: {
    KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT: "1",
    KNOWLEDGE_MAX_BYTES_PER_AGENT: "5",
    KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE: "1",
    KNOWLEDGE_MAX_BYTES_PER_SOURCE: "5",
  } });
  const first = await f.store({ name: "old.txt", buffer: Buffer.from("12345") });
  const stored = f.database.getEntity("documents", first.document.id);
  const oldPath = path.join(f.knowledge.uploadDir, stored.storageKey);
  await f.knowledge.deleteDocument(stored.id, "test");
  await f.knowledge.garbageCollectBlobs({ force: true });

  const deleted = f.database.getEntity("documents", stored.id);
  assert.equal(deleted.status, "deleted");
  assert.equal(deleted.storageKey, null);
  assert.equal(await exists(oldPath), false);
  await f.store({ name: "new.txt", buffer: Buffer.from("abcde") });
  assert.equal(f.database.listEntities("documents").filter((document) => document.status !== "deleted").length, 1);
  assert.equal((await fs.readdir(f.knowledge.uploadDir)).length, 1);
});

test("an audit failure rolls a soft delete back without orphaning its blob", async (t) => {
  const f = await fixture(t);
  const first = await f.store({ name: "retained.txt", buffer: Buffer.from("retained") });
  const stored = f.database.getEntity("documents", first.document.id);
  const blobPath = path.join(f.knowledge.uploadDir, stored.storageKey);
  const audit = f.database.audit;
  f.database.audit = () => { throw new Error("synthetic audit failure"); };

  await assert.rejects(() => f.knowledge.deleteDocument(stored.id, "test"), /synthetic audit failure/);
  f.database.audit = audit;
  const current = f.database.getEntity("documents", stored.id);
  assert.equal(current.status, stored.status);
  assert.equal(current.storageKey, stored.storageKey);
  assert.equal(await exists(blobPath), true);
  assert.equal(f.knowledge.blobStorage.retired.has(stored.storageKey), false);
});

test("source quotas are enforced independently while an in-place update stays count-neutral", async (t) => {
  const f = await fixture(t, { env: {
    KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT: "10",
    KNOWLEDGE_MAX_BYTES_PER_AGENT: "100",
    KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE: "1",
    KNOWLEDGE_MAX_BYTES_PER_SOURCE: "5",
  } });
  const source = normalizeSource({ name: "来源配额", agentSlug: seed.slug, transport: "webdav", path: "folder" });
  f.database.saveEntity("sources", source);
  const first = await f.store({ source: "nas", sourceId: source.id, sourcePath: "folder/a.txt", sourceSignature: "v1", buffer: Buffer.from("aaaaa") });
  await assert.rejects(f.store({ source: "nas", sourceId: source.id, sourcePath: "folder/b.txt", sourceSignature: "v1", buffer: Buffer.from("b") }), { code: "KNOWLEDGE_SOURCE_DOCUMENT_QUOTA" });

  const existing = f.database.getEntity("documents", first.document.id);
  await assert.rejects(f.store({ existing, source: "nas", sourceId: source.id, sourcePath: "folder/a.txt", sourceSignature: "v2", buffer: Buffer.from("bbbbbb") }), { code: "KNOWLEDGE_SOURCE_BYTES_QUOTA" });
  await f.store({ existing, source: "nas", sourceId: source.id, sourcePath: "folder/a.txt", sourceSignature: "v2", buffer: Buffer.from("ccccc") });
  assert.equal(f.database.listEntities("documents").length, 1);
});

test("NAS status returns only a failure count instead of the internal retry queue", async (t) => {
  const f = await fixture(t);
  const source = normalizeSource({ name: "安全状态", agentSlug: seed.slug, transport: "webdav", path: "folder" });
  f.database.saveEntity("sources", { ...source, syncFailureOrder: Array.from({ length: 2000 }, (_, index) => ({ path: `private/${index}.txt`, signature: `secret-${index}` })) });

  const status = await f.knowledge.nasStatus();
  assert.equal(status.sources[0].syncFailureCount, 2000);
  assert.equal(Object.hasOwn(status.sources[0], "syncFailureOrder"), false);
  assert.equal(JSON.stringify(status).includes("private/1999.txt"), false);
  assert.equal(JSON.stringify(status).includes("secret-1999"), false);
});
