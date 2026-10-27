import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { normalizeSource } from "./domain.mjs";
import { getNasCapabilities, getNasS3PublicConfig, listNasFiles, readNasFile } from "./nas.mjs";

const davEnv = { NAS_WEBDAV_URL: "https://nas.example.test:5006/知识库/", NAS_WEBDAV_USERNAME: "reader", NAS_WEBDAV_PASSWORD: "test-password" };
const davSource = { transport: "webdav", path: "睡眠" };
const s3Env = {
  NAS_S3_ENDPOINT: "https://minio.example.test",
  NAS_S3_REGION: "us-east-1",
  NAS_S3_BUCKET: "agent-knowledge",
  NAS_S3_PREFIX: "知识库",
  NAS_S3_FORCE_PATH_STYLE: "true",
  NAS_S3_ACCESS_KEY_ID: "unit-test-access-key",
  NAS_S3_SECRET_ACCESS_KEY: "unit-test-secret-key",
};
const s3Source = { transport: "s3", path: "sleep-agent" };
const escapeXml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
function entry(href, { directory = false, size = 4, etag = '"v1"', status = 200, type = "" } = {}) {
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? "<d:collection/>" : type}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Thu, 03 Sep 2026 02:00:00 GMT</d:getlastmodified><d:getetag>${escapeXml(etag)}</d:getetag></d:prop><d:status>HTTP/1.1 ${status} Status</d:status></d:propstat></d:response>`;
}
const multi = (...entries) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries.join("")}</d:multistatus>`, { status: 207, headers: { "Content-Type": "application/xml" } });

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-nas-test-"));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("agent-platform-nas-test-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}

test("capabilities disclose only configured transport booleans", () => {
  assert.deepEqual(getNasCapabilities({}), { webdav: false, local: false, s3: false });
  assert.deepEqual(getNasCapabilities({ ...davEnv, NAS_LOCAL_ROOT: "/mounted/nas" }), { webdav: true, local: true, s3: false });
});

test("NAS rejects UI endpoints, absolute paths and plain or encoded traversal before I/O", async () => {
  for (const invalid of ["../other", "a/../other", "/absolute", "C:/secret", "\\\\nas\\share", "a\\b", "a/%2e%2e/b", "a/%252e%252e/b", "a/%2fsecret", "a//b", "a/file:stream", "a/file ", "a/file.", "NUL", "a/."]) {
    await assert.rejects(listNasFiles({ transport: "webdav", path: invalid }, { env: davEnv, fetchImpl: () => assert.fail("must not send") }), { code: "INVALID_NAS_PATH" }, invalid);
  }
  await assert.rejects(listNasFiles({ transport: "s3", path: "" }, { env: s3Env, s3ClientFactory: () => assert.fail("must not initialize S3 client") }), { code: "INVALID_NAS_PATH" });
  await assert.rejects(listNasFiles({ ...davSource, endpoint: "https://evil.test" }, { env: davEnv }), { code: "NAS_CONFIG_FROM_ENV_ONLY" });
  await assert.rejects(readNasFile(davSource, { path: "其他/file.txt" }, { env: davEnv, fetchImpl: () => assert.fail("must not send") }), { code: "NAS_PATH_OUTSIDE_SOURCE" });
});

test("WebDAV recursively uses read-only Depth 1 and scoped encoded paths", async () => {
  const requested = [];
  const manifest = await listNasFiles(davSource, {
    env: davEnv,
    fetchImpl: async (url, options) => {
      requested.push(url);
      assert.equal(options.method, "PROPFIND");
      assert.equal(options.headers.Depth, "1");
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from("reader:test-password").toString("base64")}`);
      if (requested.length === 1) return multi(entry("/知识库/睡眠/", { directory: true }), entry("/知识库/睡眠/指南.txt"), entry("/知识库/睡眠/子目录/", { directory: true }));
      return multi(entry("/知识库/睡眠/子目录/", { directory: true }), entry("/知识库/睡眠/子目录/FAQ.md", { etag: '"v2"', size: 10 }));
    },
  });
  assert.equal(requested.length, 2);
  assert.ok(requested.every((url) => url.startsWith("https://nas.example.test:5006/%E7%9F%A5%E8%AF%86%E5%BA%93/%E7%9D%A1%E7%9C%A0/")));
  assert.equal(manifest.complete, true);
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), ["睡眠/子目录/FAQ.md", "睡眠/指南.txt"].sort());
  assert.equal(manifest.files[0].modifiedAt, "2026-09-03T02:00:00.000Z");
});

test("WebDAV skips unsafe cross-origin, root escape, nested depth and link entries with incomplete manifest", async () => {
  const manifest = await listNasFiles(davSource, { env: davEnv, fetchImpl: async () => multi(
    entry("/知识库/睡眠/", { directory: true }),
    entry("https://evil.test/secret.txt"),
    entry("/知识库/其他/secret.txt"),
    entry("/知识库/睡眠/../secret.txt"),
    entry("/知识库/睡眠/nested/deep.txt"),
    entry("/知识库/睡眠/linked.txt", { type: "<d:redirectref/>" }),
    entry("/知识库/睡眠/good.txt"),
  ) });
  assert.equal(manifest.complete, false);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].name, "good.txt");
  assert.ok(manifest.warning);
});

test("WebDAV does not follow redirects or leak credentials to a redirected host", async () => {
  let calls = 0;
  await assert.rejects(listNasFiles(davSource, { env: davEnv, fetchImpl: async (_url, options) => {
    calls += 1;
    assert.equal(options.redirect, "manual");
    return new Response(null, { status: 302, headers: { Location: "https://evil.test/collect" } });
  } }), { code: "NAS_REDIRECT_REJECTED" });
  assert.equal(calls, 1);
});

test("WebDAV rejects malformed/DTD responses, authentication failure and missing configuration", async () => {
  await assert.rejects(listNasFiles(davSource, { env: davEnv, fetchImpl: async () => new Response('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:multistatus xmlns:d="DAV:">&x;</d:multistatus>', { status: 207 }) }), { code: "INVALID_WEBDAV_RESPONSE" });
  await assert.rejects(listNasFiles(davSource, { env: davEnv, fetchImpl: async () => new Response("invalid", { status: 207 }) }), { code: "INVALID_WEBDAV_RESPONSE" });
  await assert.rejects(listNasFiles(davSource, { env: davEnv, fetchImpl: async () => new Response(null, { status: 401 }) }), { code: "NAS_AUTH_FAILED" });
  await assert.rejects(listNasFiles(davSource, { env: {} }), { code: "NAS_NOT_CONFIGURED" });
});

test("WebDAV times out requests and stalled response bodies with structured errors", async () => {
  // AbortSignal.timeout uses an unref'ed timer; keep this isolated mock alive.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(listNasFiles(davSource, { env: { ...davEnv, NAS_TIMEOUT_MS: "10" }, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }), { code: "NAS_TIMEOUT" });
    await assert.rejects(readNasFile(davSource, { path: "睡眠/stalled.txt", size: 0 }, { env: { ...davEnv, NAS_TIMEOUT_MS: "10" }, fetchImpl: async () => new Response(new ReadableStream({ start() {}, cancel() {} })) }), { code: "NAS_TIMEOUT" });
  } finally { clearTimeout(keepAlive); }
});

test("WebDAV marks count/depth/metadata and nested failures incomplete to prevent false deletions", async () => {
  const files = await listNasFiles(davSource, { env: { ...davEnv, NAS_MAX_FILES: "1" }, fetchImpl: async () => multi(entry("/知识库/睡眠/", { directory: true }), entry("/知识库/睡眠/a.txt"), entry("/知识库/睡眠/b.txt")) });
  assert.equal(files.files.length, 1);
  assert.equal(files.complete, false);
  const depth = await listNasFiles(davSource, { env: { ...davEnv, NAS_MAX_DEPTH: "0" }, fetchImpl: async () => multi(entry("/知识库/睡眠/", { directory: true }), entry("/知识库/睡眠/folder/", { directory: true })) });
  assert.equal(depth.complete, false);
  const missingSelf = await listNasFiles(davSource, { env: davEnv, fetchImpl: async () => multi(entry("/知识库/睡眠/a.txt")) });
  assert.equal(missingSelf.complete, false);
  let calls = 0;
  const nested = await listNasFiles(davSource, { env: davEnv, fetchImpl: async () => ++calls === 1 ? multi(entry("/知识库/睡眠/", { directory: true }), entry("/知识库/睡眠/folder/", { directory: true })) : new Response(null, { status: 403 }) });
  assert.equal(nested.complete, false);
});

test("WebDAV file reads are bounded, conditional and detect version/size changes", async () => {
  const file = { path: "睡眠/指南.txt", size: 4, signature: 'etag:"v1"', modifiedAt: "2026-09-03T02:00:00.000Z" };
  const buffer = await readNasFile(davSource, file, { env: davEnv, fetchImpl: async (_url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.headers["If-Match"], '"v1"');
    return new Response("text", { headers: { etag: '"v1"' } });
  } });
  assert.equal(buffer.toString(), "text");
  await assert.rejects(readNasFile(davSource, file, { env: davEnv, fetchImpl: async () => new Response("text", { headers: { etag: '"v2"' } }) }), { code: "NAS_FILE_CHANGED" });
  await assert.rejects(readNasFile(davSource, file, { env: davEnv, fetchImpl: async () => new Response("longer") }), { code: "NAS_FILE_CHANGED" });
  await assert.rejects(readNasFile(davSource, { ...file, size: 2 }, { env: { ...davEnv, NAS_MAX_FILE_BYTES: "3" }, fetchImpl: async () => new Response("1234") }), { code: "NAS_FILE_TOO_LARGE" });
  await assert.rejects(readNasFile(davSource, file, { env: davEnv, fetchImpl: async () => new Response(null, { status: 412 }) }), { code: "NAS_FILE_CHANGED" });
});

test("local mode scans nested mounted files and reads unchanged content", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "医生", "知识"), { recursive: true });
  await fs.writeFile(path.join(root, "医生", "知识", "指南.txt"), "睡眠健康");
  const source = { transport: "local", path: "医生" };
  const manifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.equal(manifest.complete, true);
  assert.equal(manifest.files[0].path, "医生/知识/指南.txt");
  assert.equal(manifest.files[0].size, Buffer.byteLength("睡眠健康"));
  assert.equal((await readNasFile(source, manifest.files[0], { env: { NAS_LOCAL_ROOT: root } })).toString(), "睡眠健康");
  await fs.writeFile(path.join(root, "医生", "知识", "其他.txt"), "无关资料");
  const withSibling = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.equal(withSibling.files.find((file) => file.name === "指南.txt").signature, manifest.files[0].signature);
  await fs.writeFile(path.join(root, "医生", "知识", "指南.txt"), "已经修改过的知识内容");
  await assert.rejects(readNasFile(source, manifest.files[0], { env: { NAS_LOCAL_ROOT: root } }), { code: "NAS_FILE_CHANGED" });
});

test("local scan reports incomplete at file count, size and recursion boundaries", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "a.txt"), "1234");
  await fs.writeFile(path.join(root, "b.txt"), "1234");
  await fs.writeFile(path.join(root, "nested", "c.txt"), "1234");
  const source = { transport: "local", path: "" };
  assert.equal((await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root, NAS_MAX_FILES: "1" } })).complete, false);
  assert.equal((await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root, NAS_MAX_DEPTH: "0" } })).complete, false);
  const size = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root, NAS_MAX_FILE_BYTES: "3" } });
  assert.equal(size.complete, false);
  assert.equal(size.files.length, 0);
});

test("local mode rejects symlinks/junctions and does not read outside source", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.mkdir(path.join(root, "safe"));
  await fs.writeFile(path.join(outside, "secret.txt"), "not allowed");
  try {
    await fs.symlink(outside, path.join(root, "safe", "escape"), process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error.code === "EPERM") return t.skip("host does not permit creating test symlinks");
    throw error;
  }
  const source = { transport: "local", path: "safe" };
  const manifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.equal(manifest.complete, false);
  assert.equal(manifest.files.length, 0);
  await assert.rejects(readNasFile(source, { path: "safe/escape/secret.txt" }, { env: { NAS_LOCAL_ROOT: root } }), { code: "NAS_SYMLINK_REJECTED" });
  await assert.rejects(listNasFiles({ transport: "local", path: "safe/escape" }, { env: { NAS_LOCAL_ROOT: root } }), { code: "NAS_SYMLINK_REJECTED" });
});

test("local mode rejects a same-inode equal-size rewrite even when mtime is restored", async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, "医生知识库"));
  const filename = path.join(root, "医生知识库", "指南.txt");
  const fixedTime = new Date("2026-01-02T03:04:05.000Z");
  await fs.writeFile(filename, "AAAA");
  await fs.utimes(filename, fixedTime, fixedTime);
  const source = { transport: "local", path: "医生知识库" };
  const manifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  const before = await fs.stat(filename, { bigint: true });
  await fs.writeFile(filename, "BBBB");
  await fs.utimes(filename, fixedTime, fixedTime);
  const after = await fs.stat(filename, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.notEqual(after.ctimeNs, before.ctimeNs);
  const updatedManifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.notEqual(updatedManifest.files[0].signature, manifest.files[0].signature);
  await assert.rejects(readNasFile(source, manifest.files[0], { env: { NAS_LOCAL_ROOT: root } }), { code: "NAS_FILE_CHANGED" });
});

test("local mode rejects a parent directory replacement during manifest scanning", async (t) => {
  const root = await fixture(t);
  const doctorRoot = path.join(root, "医生");
  const active = path.join(doctorRoot, "知识库");
  const prepared = path.join(doctorRoot, "候选知识库");
  const old = path.join(doctorRoot, "旧知识库");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(prepared);
  await fs.writeFile(path.join(active, "指南.txt"), "ORIGINAL");
  await fs.writeFile(path.join(prepared, "指南.txt"), "REPLACED");
  const activeReal = await fs.realpath(active);
  const originalLstat = fs.lstat.bind(fs);
  let replaced = false;
  const fileSystem = { ...fs, lstat: async (target, options) => {
    const stat = await originalLstat(target, options);
    if (!replaced && path.resolve(String(target)).toLowerCase() === path.resolve(activeReal).toLowerCase()) {
      replaced = true;
      await fs.rename(active, old);
      await fs.rename(prepared, active);
    }
    return stat;
  } };
  await assert.rejects(listNasFiles({ transport: "local", path: "医生/知识库" }, { env: { NAS_LOCAL_ROOT: root }, fileSystem }), { code: "NAS_FILE_CHANGED" });
  assert.equal(replaced, true);
});

test("local scan discards an opened directory replaced before child checks or after files are staged", async (t) => {
  for (const [label, swapOnNext] of [["before child inspection", 1], ["after staging a file", 2]]) await t.test(label, async (scenario) => {
    const root = await fixture(scenario);
    const doctorRoot = path.join(root, "医生");
    const active = path.join(doctorRoot, "知识库");
    const prepared = path.join(doctorRoot, "候选知识库");
    const old = path.join(doctorRoot, "旧知识库");
    await fs.mkdir(active, { recursive: true });
    await fs.mkdir(prepared);
    const fixedTime = new Date("2026-02-03T04:05:06.000Z");
    await fs.writeFile(path.join(active, "指南.txt"), "AAAA");
    await fs.writeFile(path.join(prepared, "指南.txt"), "BBBB");
    await fs.utimes(path.join(active, "指南.txt"), fixedTime, fixedTime);
    await fs.utimes(path.join(prepared, "指南.txt"), fixedTime, fixedTime);
    await fs.utimes(active, fixedTime, fixedTime);
    await fs.utimes(prepared, fixedTime, fixedTime);
    const activeReal = await fs.realpath(active);
    const originalOpendir = fs.opendir.bind(fs);
    let replaced = false;
    let nextCalls = 0;
    const fileSystem = { ...fs, opendir: async (target, options) => {
      const directory = await originalOpendir(target, options);
      if (path.resolve(String(target)).toLowerCase() !== path.resolve(activeReal).toLowerCase()) return directory;
      return {
        close: (...args) => directory.close(...args),
        [Symbol.asyncIterator]() {
          const iterator = directory[Symbol.asyncIterator]();
          return {
            async next(...args) {
              nextCalls += 1;
              if (!replaced && nextCalls === swapOnNext) {
                replaced = true;
                await fs.rename(active, old);
                await fs.rename(prepared, active);
              }
              return iterator.next(...args);
            },
            async return(...args) { return iterator.return ? iterator.return(...args) : { done: true }; },
          };
        },
      };
    } };
    const manifest = await listNasFiles({ transport: "local", path: "医生/知识库" }, { env: { NAS_LOCAL_ROOT: root }, fileSystem });
    assert.equal(replaced, true);
    assert.equal(manifest.complete, false);
    assert.equal(manifest.files.length, 0);
  });
});

test("local mode anchors parent directory identity across scan and read without exposing absolute paths", async (t) => {
  const root = await fixture(t);
  const doctorRoot = path.join(root, "医生");
  const active = path.join(doctorRoot, "知识库");
  const prepared = path.join(root, "候选知识库");
  await fs.mkdir(active, { recursive: true });
  await fs.mkdir(prepared);
  const activeFile = path.join(active, "指南.txt");
  const preparedFile = path.join(prepared, "指南.txt");
  await fs.writeFile(activeFile, "相同文件内容");
  await fs.link(activeFile, preparedFile);
  const source = { transport: "local", path: "医生/知识库" };
  const manifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.equal(JSON.stringify(manifest).includes(root), false);
  const scannedFile = await fs.stat(activeFile, { bigint: true });
  await fs.rename(active, path.join(doctorRoot, "旧知识库"));
  await fs.rename(prepared, active);
  const replacementFile = await fs.stat(activeFile, { bigint: true });
  assert.equal(replacementFile.dev, scannedFile.dev);
  assert.equal(replacementFile.ino, scannedFile.ino);
  const replacementManifest = await listNasFiles(source, { env: { NAS_LOCAL_ROOT: root } });
  assert.notEqual(replacementManifest.files[0].signature, manifest.files[0].signature);
  await assert.rejects(readNasFile(source, manifest.files[0], { env: { NAS_LOCAL_ROOT: root } }), { code: "NAS_FILE_CHANGED" });
});

test("S3 capability and public configuration never disclose credential values", () => {
  assert.equal(getNasCapabilities(s3Env).s3, true);
  const summary = getNasS3PublicConfig({ ...s3Env, NAS_S3_SESSION_TOKEN: "unit-test-session-token" });
  assert.deepEqual(summary, {
    endpoint: "https://minio.example.test",
    bucket: "agent-knowledge",
    region: "us-east-1",
    prefix: "知识库",
    forcePathStyle: true,
    credentialConfigured: true,
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(s3Env.NAS_S3_ACCESS_KEY_ID), false);
  assert.equal(serialized.includes(s3Env.NAS_S3_SECRET_ACCESS_KEY), false);
  assert.equal(serialized.includes("unit-test-session-token"), false);
});

test("source normalization canonicalizes minio and rejects server configuration fields", () => {
  const source = normalizeSource({ name: "MinIO", agentSlug: "sleep-agent", transport: "minio", path: "医生/睡眠", enabled: true });
  assert.equal(source.transport, "s3");
  assert.equal(source.path, "医生/睡眠");
  for (const unsafe of [
    { endpoint: "https://other.example" },
    { bucket: "other-bucket" },
    { accessKeyId: "from-browser" },
    { secretAccessKey: "from-browser" },
    { credentials: { accessKeyId: "from-browser" } },
  ]) assert.throws(() => normalizeSource({ name: "unsafe", agentSlug: "sleep-agent", transport: "s3", path: "", ...unsafe }), { code: "NAS_CONFIG_FROM_ENV_ONLY" });
});

test("S3 lists every page under the configured and per-agent prefixes", async () => {
  const commands = [];
  let clientConfig;
  let destroyed = 0;
  const firstModified = new Date("2026-09-03T02:00:00.000Z");
  const secondModified = new Date("2026-09-04T03:04:05.000Z");
  const pages = [
    {
      Contents: [
        { Key: "知识库/sleep-agent/中文指南.pdf", Size: 7, ETag: '"etag-a"', LastModified: firstModified },
        { Key: "知识库/sleep-agent/目录/", Size: 0, ETag: '"marker"', LastModified: firstModified },
      ],
      IsTruncated: true,
      NextContinuationToken: "page-2",
    },
    {
      Contents: [{ Key: "知识库/sleep-agent/问答/FAQ.md", Size: 9, ETag: '"etag-b"', LastModified: secondModified }],
      IsTruncated: false,
    },
  ];
  const manifest = await listNasFiles({ transport: "minio", path: s3Source.path }, {
    env: s3Env,
    s3ClientFactory: (config) => {
      clientConfig = config;
      return {
        async send(command) { commands.push(command); return pages.shift(); },
        destroy() { destroyed += 1; },
      };
    },
  });
  assert.equal(manifest.complete, true);
  assert.deepEqual(new Set(manifest.files.map((file) => file.path)), new Set(["sleep-agent/中文指南.pdf", "sleep-agent/问答/FAQ.md"]));
  assert.ok(manifest.files.every((file) => file.signature.startsWith(`s3:${file.size}:`) && file.signature.includes(file.etag)));
  assert.equal(commands.length, 2);
  assert.ok(commands.every((command) => command instanceof ListObjectsV2Command));
  assert.equal(commands[0].input.Bucket, "agent-knowledge");
  assert.equal(commands[0].input.Prefix, "知识库/sleep-agent/");
  assert.equal(commands[1].input.ContinuationToken, "page-2");
  assert.equal(clientConfig.endpoint, "https://minio.example.test");
  assert.equal(clientConfig.forcePathStyle, true);
  assert.deepEqual(Object.keys(clientConfig.credentials).sort(), ["accessKeyId", "secretAccessKey"]);
  assert.equal(destroyed, 1);
});

test("S3 rejects keys outside source scope and marks unsafe or unsupported entries incomplete", async () => {
  const modified = new Date("2026-09-03T02:00:00.000Z");
  const object = (key, extra = {}) => ({ Key: key, Size: 4, ETag: '"v1"', LastModified: modified, ...extra });
  const manifest = await listNasFiles(s3Source, {
    env: { ...s3Env, NAS_MAX_DEPTH: "0", NAS_MAX_FILE_BYTES: "5" },
    s3ClientFactory: () => ({
      async send() { return { Contents: [
        object("知识库/other-agent/secret.txt"),
        object("知识库/sleep-agent/../secret.txt"),
        object("知识库/sleep-agent/%252e%252e/secret.txt"),
        object("知识库/sleep-agent/a\\b.txt"),
        object("知识库/sleep-agent/a//b.txt"),
        object("知识库/sleep-agent/nested/deep.txt"),
        object("知识库/sleep-agent/large.txt", { Size: 6 }),
        object("知识库/sleep-agent/no-etag.txt", { ETag: undefined }),
        object("知识库/sleep-agent/good.txt"),
      ], IsTruncated: false }; },
      destroy() {},
    }),
  });
  assert.equal(manifest.complete, false);
  assert.deepEqual(manifest.files.map((file) => file.path), ["sleep-agent/good.txt"]);
  assert.match(manifest.warning, /S3|对象|目录/);
});

test("S3 file limits and failed later pages produce incomplete manifests without false deletion safety", async () => {
  const modified = new Date("2026-09-03T02:00:00.000Z");
  const limited = await listNasFiles(s3Source, {
    env: { ...s3Env, NAS_MAX_FILES: "1" },
    s3ClientFactory: () => ({
      async send() { return { Contents: [
        { Key: "知识库/sleep-agent/a.txt", Size: 1, ETag: '"a"', LastModified: modified },
        { Key: "知识库/sleep-agent/b.txt", Size: 1, ETag: '"b"', LastModified: modified },
      ] }; },
      destroy() {},
    }),
  });
  assert.equal(limited.files.length, 1);
  assert.equal(limited.complete, false);

  let page = 0;
  const partial = await listNasFiles(s3Source, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send() {
        page += 1;
        if (page === 1) return { Contents: [{ Key: "知识库/sleep-agent/a.txt", Size: 1, ETag: '"a"', LastModified: modified }], IsTruncated: true, NextContinuationToken: "next" };
        throw Object.assign(new Error("upstream detail must not escape"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
      },
      destroy() {},
    }),
  });
  assert.equal(partial.files.length, 1);
  assert.equal(partial.complete, false);
  assert.match(partial.warning, /分页/);
  assert.equal(partial.warning.includes("upstream detail"), false);
});

test("S3 reads the exact listed object with conditional metadata and a bounded stream", async () => {
  const modified = new Date("2026-09-03T02:00:00.000Z");
  const listingFactory = () => ({
    async send() { return { Contents: [{ Key: "知识库/sleep-agent/中文.txt", Size: 6, ETag: '"version-1"', LastModified: modified }] }; },
    destroy() {},
  });
  const file = (await listNasFiles(s3Source, { env: s3Env, s3ClientFactory: listingFactory })).files[0];
  let command;
  const buffer = await readNasFile(s3Source, file, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send(value) {
        command = value;
        return { ContentLength: 6, ETag: '"version-1"', LastModified: modified, Body: Readable.from([Buffer.from("你好")]) };
      },
      destroy() {},
    }),
  });
  assert.ok(command instanceof GetObjectCommand);
  assert.equal(command.input.Bucket, "agent-knowledge");
  assert.equal(command.input.Key, "知识库/sleep-agent/中文.txt");
  assert.equal(command.input.IfMatch, '"version-1"');
  assert.equal(command.input.IfUnmodifiedSince.toISOString(), modified.toISOString());
  assert.equal(buffer.toString(), "你好");

  await assert.rejects(readNasFile(s3Source, file, {
    env: s3Env,
    s3ClientFactory: () => ({
      async send() { return { ContentLength: 6, ETag: '"version-2"', LastModified: modified, Body: Readable.from([Buffer.from("你好")]) }; },
      destroy() {},
    }),
  }), { code: "NAS_FILE_CHANGED" });

  await assert.rejects(readNasFile(s3Source, file, {
    env: { ...s3Env, NAS_MAX_FILE_BYTES: "6" },
    s3ClientFactory: () => ({
      async send() { return { ContentLength: 6, ETag: '"version-1"', LastModified: modified, Body: Readable.from([Buffer.from("1234567")]) }; },
      destroy() {},
    }),
  }), { code: "NAS_FILE_TOO_LARGE" });
});

test("S3 aborts a stalled object body within the configured read timeout", async () => {
  const modified = new Date("2026-09-03T02:00:00.000Z");
  const listingFactory = () => ({
    async send() { return { Contents: [{ Key: "知识库/sleep-agent/stalled.txt", Size: 1, ETag: '"stalled"', LastModified: modified }] }; },
    destroy() {},
  });
  const file = (await listNasFiles(s3Source, { env: s3Env, s3ClientFactory: listingFactory })).files[0];
  let destroyed = false;
  const body = {
    destroy() { destroyed = true; },
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}), return: async () => ({ done: true }) };
    },
  };
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(readNasFile(s3Source, file, {
      env: { ...s3Env, NAS_TIMEOUT_MS: "10" },
      s3ClientFactory: () => ({
        async send() { return { ContentLength: 1, ETag: '"stalled"', LastModified: modified, Body: body }; },
        destroy() {},
      }),
    }), { code: "NAS_TIMEOUT" });
    assert.equal(destroyed, true);
  } finally { clearTimeout(keepAlive); }
});

test("S3 maps authentication, missing bucket and timeout failures without leaking upstream details", async () => {
  const failing = (error) => () => ({ async send() { throw error; }, destroy() {} });
  const authError = Object.assign(new Error("contains-sensitive-upstream-detail"), { name: "AccessDenied", $metadata: { httpStatusCode: 403 } });
  await assert.rejects(listNasFiles(s3Source, { env: s3Env, s3ClientFactory: failing(authError) }), (error) => {
    assert.equal(error.code, "NAS_AUTH_FAILED");
    assert.equal(error.message.includes("contains-sensitive"), false);
    return true;
  });
  await assert.rejects(listNasFiles(s3Source, { env: s3Env, s3ClientFactory: failing(Object.assign(new Error("missing"), { name: "NoSuchBucket", $metadata: { httpStatusCode: 404 } })) }), { code: "NAS_BUCKET_NOT_FOUND" });

  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(listNasFiles(s3Source, {
      env: { ...s3Env, NAS_TIMEOUT_MS: "10", NAS_SCAN_TIMEOUT_MS: "20" },
      s3ClientFactory: () => ({ async send() { return new Promise(() => {}); }, destroy() {} }),
    }), { code: "NAS_TIMEOUT" });
  } finally { clearTimeout(keepAlive); }
});

test("S3 rejects invalid endpoint, bucket, prefix, boolean and absent credentials before network I/O", async () => {
  const invalidEnvironments = [
    { ...s3Env, NAS_S3_SECRET_ACCESS_KEY: "" },
    { ...s3Env, NAS_S3_ENDPOINT: "https://user:pass@minio.example.test" },
    { ...s3Env, NAS_S3_ENDPOINT: "https://minio.example.test/base" },
    { ...s3Env, NAS_S3_BUCKET: "INVALID_BUCKET" },
    { ...s3Env, NAS_S3_PREFIX: "../outside" },
    { ...s3Env, NAS_S3_FORCE_PATH_STYLE: "sometimes" },
  ];
  for (const env of invalidEnvironments) {
    await assert.rejects(listNasFiles(s3Source, { env, s3ClientFactory: () => assert.fail("must not initialize S3 client") }), (error) => ["NAS_NOT_CONFIGURED", "INVALID_NAS_CONFIG", "INVALID_NAS_PATH"].includes(error.code));
  }
  await assert.rejects(listNasFiles({ ...s3Source, endpoint: "https://evil.example" }, { env: s3Env, s3ClientFactory: () => assert.fail("must not initialize S3 client") }), { code: "NAS_CONFIG_FROM_ENV_ONLY" });
});
