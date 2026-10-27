import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { loadWorkerConfig, normalizeS3Prefix, REMOTE_DELETE_CONFIRMATION } from "../nas-sync-worker/config.mjs";
import { readStableFile, runSyncOnce, scanSource } from "../nas-sync-worker/sync.mjs";
import { createS3ObjectStore } from "../nas-sync-worker/s3-store.mjs";
import { startHealthServer } from "../nas-sync-worker/health.mjs";
import { installShutdownHandlers } from "../nas-sync-worker/lifecycle.mjs";
import { prepareWorker } from "../nas-sync-worker/index.mjs";

class MemoryObjectStore {
  constructor() {
    this.objects = new Map();
    this.putCalls = [];
    this.headCalls = [];
    this.removeCalls = [];
    this.failPuts = 0;
  }
  async head(key) {
    this.headCalls.push(key);
    return this.objects.get(key) || null;
  }
  async put({ key, body, size, sha256 }) {
    this.putCalls.push(key);
    if (this.failPuts > 0) { this.failPuts -= 1; throw Object.assign(new Error("temporary object-store error"), { code: "TEMPORARY" }); }
    assert.equal(body.length, size);
    assert.equal(createHash("sha256").update(body).digest("hex"), sha256);
    this.objects.set(key, { size, sha256, etag: `etag-${this.putCalls.length}` });
  }
  async remove(key) {
    this.removeCalls.push(key);
    this.objects.delete(key);
  }
}

async function fixture(t, extraEnv = {}, flags = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nas-minio-sync-test-"));
  const sourceRoot = path.join(directory, "source");
  const stateDir = path.join(directory, "state");
  await fs.mkdir(sourceRoot);
  t.after(async () => {
    if (path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith("nas-minio-sync-test-")) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
  const env = {
    NAS_TO_S3_SOURCE_ROOT: sourceRoot,
    NAS_TO_S3_STATE_DIR: stateDir,
    NAS_TO_S3_STABLE_SECONDS: "0",
    NAS_TO_S3_RETRY_BASE_MS: "10",
    NAS_TO_S3_VERIFY_AFTER_SECONDS: "3600",
    NAS_S3_ENDPOINT: "http://127.0.0.1:9000",
    NAS_S3_ACCESS_KEY_ID: "test-access",
    NAS_S3_SECRET_ACCESS_KEY: "test-secret",
    NAS_S3_BUCKET: "agent-knowledge-test",
    NAS_S3_PREFIX: "knowledge",
    NAS_TO_S3_STORE_ID: "test-minio-primary",
    ...extraEnv,
  };
  return { directory, sourceRoot, stateDir, env, config: await loadWorkerConfig(env, flags) };
}

async function writeFile(root, relative, content = "测试知识正文") {
  const target = path.join(root, ...relative.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
  return target;
}

test("configuration validates S3 paths, credentials and the two-step delete guard", async (t) => {
  const f = await fixture(t);
  assert.equal(f.config.basePrefix, "knowledge");
  assert.equal(f.config.connectionTimeoutMs, 3000);
  assert.equal(f.config.requestTimeoutMs, 30_000);
  assert.equal(f.config.socketTimeoutMs, 30_000);
  assert.equal(f.config.operationTimeoutMs, 45_000);
  assert.equal(f.config.rehashAfterMs, 3_600_000);
  assert.equal(normalizeS3Prefix("/knowledge/archive/"), "knowledge/archive");
  assert.throws(() => normalizeS3Prefix("knowledge/../escape"), /不安全路径/);
  await assert.rejects(loadWorkerConfig({ ...f.env, NAS_TO_S3_DELETE_REMOTE: "true" }), /DELETE_MISSING_MANAGED_OBJECTS/);
  const destructive = await loadWorkerConfig({
    ...f.env,
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  });
  assert.equal(destructive.deleteRemote, true);
  const { NAS_TO_S3_STORE_ID: _storeId, ...withoutStoreId } = f.env;
  await assert.rejects(loadWorkerConfig({
    ...withoutStoreId,
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  }), /NAS_TO_S3_STORE_ID/);
  await assert.rejects(loadWorkerConfig({ ...f.env, NAS_S3_ENDPOINT: "http://user:pass@127.0.0.1:9000" }), /无用户信息/);
  const dry = await loadWorkerConfig({
    NAS_TO_S3_SOURCE_ROOT: f.sourceRoot,
    NAS_TO_S3_STATE_DIR: f.stateDir,
    NAS_S3_BUCKET: "agent-knowledge-test",
  }, { dryRun: true });
  assert.equal(dry.dryRun, true);
  await assert.rejects(loadWorkerConfig({
    ...f.env,
    NAS_TO_S3_OPERATION_TIMEOUT_MS: "5000",
    NAS_TO_S3_HEALTH_STALL_SECONDS: "5",
  }), /必须大于单次 S3 操作 deadline/);
});

test("state is bound to one explicit S3 namespace before any managed-object action", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "智能体甲/knowledge.txt", "namespace-bound-content");
  const originalStore = new MemoryObjectStore();
  const first = await runSyncOnce(f.config, originalStore, { now: Date.now(), sleep: async () => {} });
  assert.equal(first.summary.uploaded, 1);
  assert.equal(first.state.version, 2);
  assert.equal(typeof first.state.storeIdentity, "string");
  await fs.rm(path.join(f.sourceRoot, "智能体甲", "knowledge.txt"));

  const variants = [
    { NAS_S3_ENDPOINT: "http://127.0.0.1:9001" },
    { NAS_TO_S3_STORE_ID: "different-minio-namespace" },
    { NAS_S3_PREFIX: "unrelated-tenant-prefix" },
  ];
  for (const variant of variants) {
    const changed = await loadWorkerConfig({
      ...f.env,
      ...variant,
      NAS_TO_S3_DELETE_REMOTE: "true",
      NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
    });
    const unrelatedStore = new MemoryObjectStore();
    unrelatedStore.objects.set(first.scan.files[0].key, { size: 123, sha256: "unrelated" });
    let storeCreations = 0;
    await assert.rejects(prepareWorker(changed, { createObjectStore: async () => {
      storeCreations += 1;
      return unrelatedStore;
    } }), { code: "STATE_STORE_IDENTITY_MISMATCH" });
    assert.equal(storeCreations, 0, "state binding must be checked before constructing a client or checking a bucket");
    await assert.rejects(runSyncOnce(changed, unrelatedStore, { now: Date.now() + 1000, sleep: async () => {} }), {
      code: "STATE_STORE_IDENTITY_MISMATCH",
    });
    assert.deepEqual(unrelatedStore.removeCalls, []);
    assert.deepEqual(unrelatedStore.putCalls, []);
    assert.deepEqual(unrelatedStore.headCalls, []);
  }

  const rotatedCredential = await loadWorkerConfig({ ...f.env, NAS_S3_ACCESS_KEY_ID: "rotated-worker-access-key" });
  assert.equal(rotatedCredential.storeIdentity, f.config.storeIdentity, "explicit store id must permit credential rotation within the same namespace");
});

test("legacy managed state without a store identity fails closed", async (t) => {
  const f = await fixture(t);
  const legacy = {
    version: 1, sourceRoot: f.config.sourceRoot, bucket: f.config.bucket, basePrefix: f.config.basePrefix,
    files: { legacy: { key: "knowledge/legacy.txt", status: "synced" } }, orphanedKeys: [],
  };
  const store = new MemoryObjectStore();
  await assert.rejects(runSyncOnce(f.config, store, { state: legacy, now: Date.now(), sleep: async () => {} }), {
    code: "STATE_STORE_IDENTITY_MISMATCH",
  });
  assert.deepEqual(store.removeCalls, []);
  assert.deepEqual(store.putCalls, []);
  assert.deepEqual(store.headCalls, []);
});

test("malformed v2 state keys fail before any object-store client or operation", async (t) => {
  const f = await fixture(t, {
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  });
  await fs.mkdir(f.stateDir, { recursive: true });
  const validRecord = {
    sourceRelative: "agent-one/file.txt", agentDirectory: "agent-one", agentPrefix: "agent-one",
    key: "knowledge/agent-one/file.txt", size: 1, mtimeMs: 1, sha256: "a".repeat(64), status: "synced",
  };
  const malformedStates = [
    { files: { "agent-one/file.txt": { ...validRecord, key: "outside/victim.txt" } }, orphanedKeys: [] },
    { files: {}, orphanedKeys: ["another/victim2.txt"] },
    { files: { "agent-one/file.txt": { ...validRecord, key: 42 } }, orphanedKeys: [] },
    { files: { "agent-one/file.txt": validRecord }, orphanedKeys: [validRecord.key] },
  ];

  for (const malformed of malformedStates) {
    const state = {
      version: 2, sourceRoot: f.config.sourceRoot, bucket: f.config.bucket,
      storeIdentity: f.config.storeIdentity, basePrefix: f.config.basePrefix,
      lastRun: null, updatedAt: null, ...malformed,
    };
    await fs.writeFile(f.config.statePath, JSON.stringify(state), "utf8");
    const store = new MemoryObjectStore();
    let storeCreations = 0;
    let bucketChecks = 0;
    await assert.rejects(prepareWorker(f.config, { createObjectStore: async () => {
      storeCreations += 1;
      return { ...store, checkBucket: async () => { bucketChecks += 1; } };
    } }), { code: "STATE_MANIFEST_INVALID" });
    assert.equal(storeCreations, 0);
    assert.equal(bucketChecks, 0);
    await assert.rejects(runSyncOnce(f.config, store, { state, now: Date.now(), sleep: async () => {} }), {
      code: "STATE_MANIFEST_INVALID",
    });
    assert.deepEqual(store.removeCalls, []);
    assert.deepEqual(store.putCalls, []);
    assert.deepEqual(store.headCalls, []);
  }
});

test("NAS Compose reaches host MinIO through loopback without a DHCP address", async () => {
  const compose = await fs.readFile(new URL("../nas-sync-worker/compose.yml", import.meta.url), "utf8");
  const example = await fs.readFile(new URL("../nas-sync-worker/env.example", import.meta.url), "utf8");
  assert.match(compose, /^\s*network_mode:\s*host\s*$/m);
  assert.match(example, /^NAS_S3_ENDPOINT=http:\/\/127\.0\.0\.1:\d+$/m);
  assert.doesNotMatch(example, /192\.168\.0\.28/);
});

test("Chinese source paths map to an agent prefix and upload only RAG-supported extensions", async (t) => {
  const f0 = await fixture(t);
  const mapPath = path.join(f0.directory, "agent-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ "数字(智)唐劲松医生": "tang-jinsong" }));
  const config = await loadWorkerConfig({ ...f0.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath, NAS_TO_S3_REQUIRE_AGENT_MAP: "true" });
  await writeFile(f0.sourceRoot, "数字(智)唐劲松医生/指南/饮食建议.pdf", "pdf-like-test-content");
  await writeFile(f0.sourceRoot, "数字(智)唐劲松医生/视频.mp4", "not-rag-input");
  const store = new MemoryObjectStore();
  const first = await runSyncOnce(config, store, { now: Date.now(), sleep: async () => {} });
  assert.equal(first.summary.uploaded, 1);
  assert.equal(first.summary.ignored.unsupported, 1);
  assert.deepEqual(store.putCalls, ["knowledge/tang-jinsong/指南/饮食建议.pdf"]);
  const manifest = JSON.parse(await fs.readFile(config.statePath, "utf8"));
  assert.equal(manifest.files["数字(智)唐劲松医生/指南/饮食建议.pdf"].status, "synced");
  assert.equal(JSON.stringify(manifest).includes("test-secret"), false);

  const second = await runSyncOnce(config, store, { now: Date.now() + 1000, sleep: async () => {} });
  assert.equal(second.summary.skipped, 1);
  assert.equal(store.putCalls.length, 1);
});

test("unmapped directories are visible in status but cannot cross agent boundaries", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_REQUIRE_AGENT_MAP: "true" });
  await writeFile(f.sourceRoot, "未配置医生/知识.txt", "unmapped");
  const scan = await scanSource(f.config, { now: Date.now() });
  assert.equal(scan.ignored.unmappedAgents, 1);
  assert.equal(scan.files.length, 0);
  assert.equal(scan.present.has("未配置医生/知识.txt"), true);
});

test("two source directories can never share one agent object prefix", async (t) => {
  const f = await fixture(t);
  const mapPath = path.join(f.directory, "collision-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ "医生甲": "same-agent", "医生乙": "same-agent" }));
  await assert.rejects(loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath }), /同一目标前缀/);

  await fs.writeFile(mapPath, JSON.stringify({ "医生甲": "Agent-One", "医生乙": "agent-one" }));
  await assert.rejects(
    loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath }),
    /大小写或 Unicode 规范化/,
  );

  await fs.writeFile(mapPath, JSON.stringify({ "医生甲": "Café", "医生乙": "Cafe\u0301" }));
  await assert.rejects(
    loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath }),
    /同一目标前缀/,
  );

  await fs.writeFile(mapPath, JSON.stringify({ "é-agent": "agent-one", "e\u0301-agent": "agent-two" }));
  await assert.rejects(
    loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath }),
    /源目录名.*Unicode 规范化/,
  );
});

test("NFC-colliding sibling files and directories are all skipped before processing", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "agent-one/é.txt", "composed file");
  await writeFile(f.sourceRoot, "agent-one/e\u0301.txt", "decomposed file");
  await writeFile(f.sourceRoot, "agent-one/Café/a.txt", "composed directory");
  await writeFile(f.sourceRoot, "agent-one/Cafe\u0301/b.txt", "decomposed directory");
  const store = new MemoryObjectStore();
  const result = await runSyncOnce(f.config, store, { now: Date.now(), sleep: async () => {} });
  assert.equal(result.summary.scanComplete, false);
  assert.equal(result.summary.deletionSafe, false);
  assert.equal(result.summary.ignored.normalizationCollisions, 4);
  assert.equal(result.scan.files.length, 0);
  assert.equal(result.scan.errors.some((error) => error.code === "NORMALIZATION_COLLISION"), true);
  assert.equal(store.putCalls.length, 0);
});

test("NFC-colliding top-level agent directories fail closed even when both are unmapped", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_REQUIRE_AGENT_MAP: "true" });
  await writeFile(f.sourceRoot, "é-agent/a.txt", "composed agent directory");
  await writeFile(f.sourceRoot, "e\u0301-agent/b.txt", "decomposed agent directory");
  const scan = await scanSource(f.config, { now: Date.now() });
  assert.equal(scan.complete, false);
  assert.equal(scan.deletionSafe, false);
  assert.equal(scan.ignored.normalizationCollisions, 2);
  assert.equal(scan.files.length, 0);
  assert.equal(scan.errors.some((error) => error.code === "NORMALIZATION_COLLISION"), true);
});

test("mapped and default agent prefixes cannot differ by case only", async (t) => {
  const f = await fixture(t);
  const mapPath = path.join(f.directory, "mixed-prefix-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ "映射医生": "Shared-Agent" }));
  const config = await loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath });
  await writeFile(f.sourceRoot, "映射医生/a.txt", "mapped source");
  await writeFile(f.sourceRoot, "shared-agent/b.txt", "default source");
  const scan = await scanSource(config, { now: Date.now() });
  assert.equal(scan.complete, false);
  assert.equal(scan.deletionSafe, false);
  assert.equal(scan.ignored.prefixCollisions, 2);
  assert.equal(scan.files.length, 0);
});

test("case-distinct nested filenames remain separate S3 objects", {
  skip: process.platform === "win32" ? "NTFS test workspace cannot represent case-distinct sibling names" : false,
}, async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "agent-one/Guide.txt", "upper-case path");
  await writeFile(f.sourceRoot, "agent-one/guide.txt", "lower-case path");
  const store = new MemoryObjectStore();
  const result = await runSyncOnce(f.config, store, { now: Date.now(), sleep: async () => {} });
  assert.equal(result.summary.uploaded, 2);
  assert.deepEqual(store.putCalls.sort(), ["knowledge/agent-one/Guide.txt", "knowledge/agent-one/guide.txt"].sort());
});

test("minimum age holds a changing file until a later stable scan", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_STABLE_SECONDS: "60" });
  const target = await writeFile(f.sourceRoot, "agent-one/notes.txt", "stable later");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await fs.utimes(target, new Date(now), new Date(now));
  const first = await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  assert.equal(first.summary.ignored.unstable, 1);
  assert.equal(store.putCalls.length, 0);
  await fs.utimes(target, new Date(now - 120_000), new Date(now - 120_000));
  const second = await runSyncOnce(f.config, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(second.summary.uploaded, 1);
});

test("content hash and remote metadata avoid duplicate upload after mtime-only changes", async (t) => {
  const f = await fixture(t);
  const target = await writeFile(f.sourceRoot, "agent-one/notes.txt", "same bytes");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  const originalCalls = store.putCalls.length;
  await fs.utimes(target, new Date(now - 20_000), new Date(now - 20_000));
  const result = await runSyncOnce(f.config, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(result.summary.deduplicated, 1);
  assert.equal(store.putCalls.length, originalCalls);
});

test("periodic rehash detects content changes even when size and mtime are unchanged", async (t) => {
  const f0 = await fixture(t, { NAS_TO_S3_REHASH_AFTER_SECONDS: "0" });
  const target = await writeFile(f0.sourceRoot, "agent-one/same-fingerprint.txt", "AAAA");
  const store = new MemoryObjectStore();
  const fixedMtime = Math.trunc(Date.now() - 10_000);
  await fs.utimes(target, new Date(fixedMtime), new Date(fixedMtime));
  const now = fixedMtime + 20_000;
  const first = await runSyncOnce(f0.config, store, { now, sleep: async () => {} });
  const record = first.state.files["agent-one/same-fingerprint.txt"];
  await fs.writeFile(target, "BBBB");
  await fs.utimes(target, new Date(record.mtimeMs), new Date(record.mtimeMs));
  const rescanned = await scanSource(f0.config, { now: now + 1000 });
  assert.equal(rescanned.files[0].size, record.size);
  assert.equal(rescanned.files[0].mtimeMs, record.mtimeMs);
  const second = await runSyncOnce(f0.config, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(second.summary.rehashed, 1);
  assert.equal(second.summary.uploaded, 1);
  assert.equal(store.putCalls.length, 2);
  assert.notEqual(second.state.files["agent-one/same-fingerprint.txt"].sha256, record.sha256);
});

test("transient uploads retry and verify the final object", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_MAX_ATTEMPTS: "3" });
  await writeFile(f.sourceRoot, "agent-one/retry.txt", "retry content");
  const store = new MemoryObjectStore();
  store.failPuts = 2;
  const result = await runSyncOnce(f.config, store, { now: Date.now(), sleep: async () => {} });
  assert.equal(result.summary.uploaded, 1);
  assert.equal(result.summary.retries, 2);
  assert.equal(store.putCalls.length, 3);
});

test("missing local files are retained remotely by default and deleted only with explicit guard", async (t) => {
  const f = await fixture(t);
  const target = await writeFile(f.sourceRoot, "agent-one/delete.txt", "managed content");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  await fs.unlink(target);
  const retained = await runSyncOnce(f.config, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(retained.summary.retainedMissing, 1);
  assert.equal(store.removeCalls.length, 0);

  const deleteConfig = await loadWorkerConfig({
    ...f.env,
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  });
  const removed = await runSyncOnce(deleteConfig, store, { now: now + 2000, sleep: async () => {} });
  assert.equal(removed.summary.deleted, 1);
  assert.deepEqual(store.removeCalls, ["knowledge/agent-one/delete.txt"]);
});

test("dry-run plans work without object-store calls or a state write", async (t) => {
  const f = await fixture(t, {}, { dryRun: true });
  await writeFile(f.sourceRoot, "agent-one/preview.txt", "preview only");
  const store = new MemoryObjectStore();
  const result = await runSyncOnce(f.config, store, { now: Date.now(), sleep: async () => {} });
  assert.equal(result.summary.plannedUploads, 1);
  assert.equal(store.headCalls.length, 0);
  assert.equal(store.putCalls.length, 0);
  await assert.rejects(fs.access(f.config.statePath));
});

test("an incomplete bounded scan never removes managed remote objects", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_MAX_SCAN_FILES: "3" });
  await writeFile(f.sourceRoot, "agent-one/a.txt", "a");
  await writeFile(f.sourceRoot, "agent-one/b.txt", "b");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  const limited = await loadWorkerConfig({
    ...f.env,
    NAS_TO_S3_MAX_SCAN_FILES: "1",
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  });
  const result = await runSyncOnce(limited, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(result.summary.scanComplete, false);
  assert.equal(result.summary.deleted, 0);
  assert.equal(store.removeCalls.length, 0);
});

test("replacing a managed agent directory with a symlink makes the whole scan deletion-unsafe", async (t) => {
  const f = await fixture(t);
  const managedDirectory = path.join(f.sourceRoot, "agent-one");
  await writeFile(f.sourceRoot, "agent-one/source.txt", "managed");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  await fs.rm(managedDirectory, { recursive: true });
  const outside = path.join(f.directory, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "other.txt"), "outside source");
  await fs.symlink(outside, managedDirectory, process.platform === "win32" ? "junction" : "dir");
  const deleteConfig = await loadWorkerConfig({
    ...f.env,
    NAS_TO_S3_DELETE_REMOTE: "true",
    NAS_TO_S3_DELETE_CONFIRM: REMOTE_DELETE_CONFIRMATION,
  });
  const result = await runSyncOnce(deleteConfig, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(result.summary.scanComplete, false);
  assert.equal(result.summary.deletionSafe, false);
  assert.equal(result.summary.ignored.symlinks, 1);
  assert.equal(store.removeCalls.length, 0);
});

test("a scanned file handle fails closed if its anchored agent directory is swapped before reading", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "agent-one/nested/source.txt", "trusted source");
  const scan = await scanSource(f.config, { now: Date.now() });
  assert.equal(scan.files.length, 1);
  const original = path.join(f.sourceRoot, "agent-one");
  const moved = path.join(f.sourceRoot, "agent-one-original");
  const outside = path.join(f.directory, "outside-agent");
  await fs.mkdir(path.join(outside, "nested"), { recursive: true });
  await fs.writeFile(path.join(outside, "nested", "source.txt"), "untrusted data");
  await fs.rename(original, moved);
  await fs.symlink(outside, original, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(readStableFile(scan.files[0], f.config), (error) => {
    assert.match(error.code, /^SOURCE_/);
    return true;
  });
});

test("a symlink in any source-root ancestor fails closed before traversal", async (t) => {
  const f = await fixture(t);
  const physicalParent = path.join(f.directory, "physical-parent");
  const physicalSource = path.join(physicalParent, "source");
  const linkedParent = path.join(f.directory, "linked-parent");
  await fs.mkdir(physicalSource, { recursive: true });
  await writeFile(physicalSource, "agent-one/source.txt", "must not traverse ancestor link");
  await fs.symlink(physicalParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
  const config = await loadWorkerConfig({ ...f.env, NAS_TO_S3_SOURCE_ROOT: path.join(linkedParent, "source") });
  const scan = await scanSource(config, { now: Date.now() });
  assert.equal(scan.complete, false);
  assert.equal(scan.deletionSafe, false);
  assert.equal(scan.files.length, 0);
  assert.equal(scan.errors.some((error) => error.code === "SOURCE_ANCESTOR_UNSAFE"), true);
});

test("failed prefix migration preserves the old managed key until the new key succeeds", async (t) => {
  const f = await fixture(t, { NAS_TO_S3_MAX_ATTEMPTS: "1" });
  await writeFile(f.sourceRoot, "agent-one/source.txt", "mapping migration");
  const store = new MemoryObjectStore();
  const now = Date.now();
  await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  const oldKey = "knowledge/agent-one/source.txt";
  const mapPath = path.join(f.directory, "migration-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ "agent-one": "renamed-agent" }));
  const renamed = await loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath, NAS_TO_S3_MAX_ATTEMPTS: "1" });
  store.failPuts = 1;
  const failed = await runSyncOnce(renamed, store, { now: now + 1000, sleep: async () => {} });
  const failedRecord = failed.state.files["agent-one/source.txt"];
  assert.equal(failedRecord.status, "migration-error");
  assert.equal(failedRecord.key, oldKey);
  assert.equal(failedRecord.pending.key, "knowledge/renamed-agent/source.txt");
  assert.equal(failed.state.orphanedKeys.includes(oldKey), false);

  const succeeded = await runSyncOnce(renamed, store, { now: now + 2000, sleep: async () => {} });
  assert.equal(succeeded.state.files["agent-one/source.txt"].key, "knowledge/renamed-agent/source.txt");
  assert.equal(succeeded.state.orphanedKeys.includes(oldKey), true);
});

test("deduplicated prefix migration still retains the old key as a managed orphan", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "agent-one/source.txt", "deduplicated migration");
  const store = new MemoryObjectStore();
  const now = Date.now();
  const first = await runSyncOnce(f.config, store, { now, sleep: async () => {} });
  const oldKey = "knowledge/agent-one/source.txt";
  const newKey = "knowledge/renamed-agent/source.txt";
  store.objects.set(newKey, { ...store.objects.get(oldKey) });
  const mapPath = path.join(f.directory, "dedupe-map.json");
  await fs.writeFile(mapPath, JSON.stringify({ "agent-one": "renamed-agent" }));
  const renamed = await loadWorkerConfig({ ...f.env, NAS_TO_S3_AGENT_MAP_FILE: mapPath });
  const result = await runSyncOnce(renamed, store, { now: now + 1000, sleep: async () => {} });
  assert.equal(result.summary.deduplicated, 1);
  assert.equal(result.state.files["agent-one/source.txt"].key, newKey);
  assert.deepEqual(result.state.orphanedKeys, [oldKey]);
  assert.equal(first.summary.uploaded, 1);
});

test("health endpoint returns fixed summaries without source paths or error text", async (t) => {
  const runtime = {
    startedAt: "2026-09-04T00:00:00.000Z",
    running: false,
    stopping: false,
    lastError: { code: "EACCES", message: "cannot read /nas/knowledge/医生甲/病历.txt" },
    lastRun: {
      startedAt: "2026-09-04T00:00:01.000Z",
      completedAt: "2026-09-04T00:00:02.000Z",
      dryRun: false,
      scanComplete: false,
      deletionSafe: false,
      scannedFiles: 4,
      eligibleFiles: 3,
      uploaded: 0,
      deduplicated: 0,
      skipped: 0,
      verified: 0,
      deleted: 0,
      retainedMissing: 1,
      deferred: 0,
      failed: 1,
      ignored: { symlinks: 1 },
      scanErrors: [{ code: "EACCES", message: "secret path", path: "/nas/knowledge/医生甲/病历.txt" }],
    },
  };
  const server = startHealthServer(0, runtime);
  await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(body.includes("/nas/knowledge"), false);
  assert.equal(body.includes("病历.txt"), false);
  const parsed = JSON.parse(body);
  assert.equal(parsed.status, "degraded");
  assert.equal(parsed.lastRun.scanErrorCount, 1);
  assert.deepEqual(parsed.lastError, { code: "EACCES" });
  const readiness = await fetch(`http://127.0.0.1:${server.address().port}/readyz`);
  assert.equal(readiness.status, 503);
  assert.equal((await readiness.json()).status, "degraded");
});

test("readiness is degraded for failed, incomplete or running work and recovers after success", async (t) => {
  const now = Date.parse("2026-09-04T00:02:00.000Z");
  const runtime = {
    startedAt: "2026-09-04T00:00:00.000Z",
    lastProgressAt: new Date(now).toISOString(),
    healthStallMs: 60_000,
    running: false,
    stopping: false,
    lastError: null,
    lastRun: { scanComplete: true, failed: 1, operationTimeouts: 0 },
  };
  const server = startHealthServer(0, runtime, "127.0.0.1", { now: () => now });
  await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const healthUrl = `http://127.0.0.1:${server.address().port}/healthz`;
  const readinessUrl = `http://127.0.0.1:${server.address().port}/readyz`;

  let response = await fetch(healthUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "degraded");
  response = await fetch(readinessUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "degraded");

  runtime.lastRun = { scanComplete: false, failed: 0, operationTimeouts: 0 };
  response = await fetch(readinessUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "degraded");

  runtime.lastRun = { scanComplete: true, failed: 0, operationTimeouts: 0 };
  runtime.running = true;
  response = await fetch(readinessUrl);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "degraded");

  runtime.running = false;
  response = await fetch(readinessUrl);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
});

test("health endpoint returns 503 while the loop is stalled or shutting down", async (t) => {
  let clock = Date.parse("2026-09-04T00:02:00.000Z");
  const runtime = {
    startedAt: "2026-09-04T00:00:00.000Z",
    lastProgressAt: "2026-09-04T00:00:00.000Z",
    healthStallMs: 30_000,
    running: true,
    stopping: false,
    lastRun: null,
    lastError: null,
  };
  const server = startHealthServer(0, runtime, "127.0.0.1", { now: () => clock });
  await once(server, "listening");
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/healthz`;
  let response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "stalled");
  runtime.running = false;
  runtime.lastRun = { operationTimeouts: 1 };
  clock += 1000;
  response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "timed_out");
  runtime.lastRun = { operationTimeouts: 0, scanComplete: true, failed: 0 };
  runtime.lastError = null;
  clock += 1000;
  response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");
  runtime.stopping = true;
  clock += 1000;
  response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, "stopping");
});

test("SIGTERM and SIGINT abort in-flight work and mark health as stopping", () => {
  for (const signalName of ["SIGTERM", "SIGINT"]) {
    const processLike = new EventEmitter();
    const controller = new AbortController();
    const runtime = { stopping: false };
    const removeHandlers = installShutdownHandlers(runtime, controller, processLike);
    processLike.emit(signalName);
    assert.equal(runtime.stopping, true);
    assert.equal(controller.signal.aborted, true);
    removeHandlers();
    assert.equal(processLike.listenerCount("SIGTERM"), 0);
    assert.equal(processLike.listenerCount("SIGINT"), 0);
  }
});

test("sync loop forwards AbortSignal and does not turn shutdown into a file failure", async (t) => {
  const f = await fixture(t);
  await writeFile(f.sourceRoot, "agent-one/abort.txt", "abort this run");
  const controller = new AbortController();
  const store = new MemoryObjectStore();
  let receivedSignal = false;
  store.head = async (_key, options = {}) => {
    receivedSignal = options.signal === controller.signal;
    controller.abort();
    throw Object.assign(new Error("aborted at S3 boundary"), { code: "AbortError" });
  };
  await assert.rejects(
    runSyncOnce(f.config, store, { signal: controller.signal, now: Date.now(), sleep: async () => {} }),
    (error) => error.code === "OPERATION_ABORTED",
  );
  assert.equal(receivedSignal, true);
});

test("AWS S3 adapter preserves UTF-8 keys and verifies SHA-256 metadata", async (t) => {
  let stored = null;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    requests.push({ method: request.method, pathname });
    if (request.method === "HEAD" && pathname === "/agent-knowledge-test/") { response.writeHead(200).end(); return; }
    if (request.method === "HEAD") {
      if (!stored) { response.writeHead(404).end(); return; }
      response.writeHead(200, {
        "content-length": String(stored.body.length),
        "x-amz-meta-sha256": stored.sha256,
        etag: '"local-etag"',
      }).end();
      return;
    }
    if (request.method === "PUT") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      stored = { body: Buffer.concat(chunks), sha256: request.headers["x-amz-meta-sha256"] };
      response.writeHead(200, { etag: '"local-etag"' }).end();
      return;
    }
    if (request.method === "DELETE") { stored = null; response.writeHead(204).end(); return; }
    response.writeHead(405).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); });
  const address = server.address();
  const f = await fixture(t, { NAS_S3_ENDPOINT: `http://127.0.0.1:${address.port}` });
  const objectStore = await createS3ObjectStore(f.config);
  t.after(() => objectStore.destroy());
  await objectStore.checkBucket();
  const key = "knowledge/tang-jinsong/指南/饮食建议.pdf";
  const body = Buffer.from("utf8-object-content");
  const sha256 = createHash("sha256").update(body).digest("hex");
  assert.equal(await objectStore.head(key), null);
  await objectStore.put({ key, body, size: body.length, sha256, mtimeMs: Date.now() });
  assert.deepEqual(await objectStore.head(key), { size: body.length, sha256, etag: "local-etag", lastModified: "" });
  await objectStore.remove(key);
  assert.equal(stored, null);
  assert.equal(requests.some((request) => request.pathname === `/agent-knowledge-test/${key}`), true);
});

test("AWS S3 adapter enforces a hard deadline and external abort on hung sockets", async (t) => {
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const f = await fixture(t, { NAS_S3_ENDPOINT: `http://127.0.0.1:${address.port}` });
  const objectStore = await createS3ObjectStore({
    ...f.config,
    connectionTimeoutMs: 100,
    requestTimeoutMs: 5000,
    socketTimeoutMs: 5000,
    operationTimeoutMs: 75,
  });
  const transportTimeoutStore = await createS3ObjectStore({
    ...f.config,
    connectionTimeoutMs: 100,
    requestTimeoutMs: 5000,
    socketTimeoutMs: 50,
    operationTimeoutMs: 1000,
  });
  t.after(async () => {
    objectStore.destroy();
    transportTimeoutStore.destroy();
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  const startedAt = Date.now();
  await assert.rejects(
    objectStore.head("knowledge/agent-one/hung.txt"),
    (error) => error.code === "S3_OPERATION_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 2000, "hard deadline must settle well before transport timeouts");

  await assert.rejects(
    transportTimeoutStore.head("knowledge/agent-one/socket-timeout.txt"),
    (error) => error.code === "S3_OPERATION_TIMEOUT",
  );

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 25);
  try {
    await assert.rejects(
      objectStore.head("knowledge/agent-one/abort.txt", { signal: controller.signal }),
      (error) => error.code === "OPERATION_ABORTED",
    );
  } finally {
    clearTimeout(abortTimer);
  }
});
