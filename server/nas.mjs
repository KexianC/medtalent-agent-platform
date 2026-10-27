import { promises as fs, constants as fsConstants } from "node:fs";
import path from "node:path";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { hasNasSourceServerOnlyFields } from "./domain.mjs";
import { normalizeNasPathSegment, normalizeNasRelativePath } from "./nas-path.mjs";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:reftarget/></d:prop></d:propfind>';

export class NasError extends Error {
  constructor(message, code = "NAS_ERROR", statusCode = 502) {
    super(message);
    this.name = "NasError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function getNasCapabilities(env = process.env) {
  let s3 = false;
  try { s3Configuration(env); s3 = true; } catch { /* Capability means fully valid server-side configuration. */ }
  return {
    webdav: Boolean(env.NAS_WEBDAV_URL && env.NAS_WEBDAV_USERNAME && env.NAS_WEBDAV_PASSWORD),
    local: Boolean(env.NAS_LOCAL_ROOT),
    s3,
  };
}

function environmentBoolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) return false;
  throw new NasError("NAS_S3_FORCE_PATH_STYLE 必须是 true 或 false。", "INVALID_NAS_CONFIG", 503);
}

export function getNasS3PublicConfig(env = process.env) {
  let endpoint = null;
  try {
    const candidate = new URL(env.NAS_S3_ENDPOINT || "");
    if (["http:", "https:"].includes(candidate.protocol) && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && candidate.pathname === "/") endpoint = candidate.href.replace(/\/$/, "");
  } catch { /* A partially configured endpoint is reported as unavailable. */ }
  let forcePathStyle = null;
  try { forcePathStyle = environmentBoolean(env.NAS_S3_FORCE_PATH_STYLE, true); } catch { /* Invalid values are never reflected as healthy. */ }
  let prefix = null;
  try { prefix = relativePath(env.NAS_S3_PREFIX || ""); } catch { /* Invalid prefixes are never reflected as healthy. */ }
  const bucket = typeof env.NAS_S3_BUCKET === "string" && validS3BucketName(env.NAS_S3_BUCKET) ? env.NAS_S3_BUCKET : null;
  const region = typeof env.NAS_S3_REGION !== "string" || !env.NAS_S3_REGION ? "us-east-1" : validS3Region(env.NAS_S3_REGION) ? env.NAS_S3_REGION : null;
  return {
    endpoint,
    bucket,
    region,
    prefix,
    forcePathStyle,
    credentialConfigured: Boolean(env.NAS_S3_ACCESS_KEY_ID && env.NAS_S3_SECRET_ACCESS_KEY),
  };
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum ? Math.min(number, maximum) : fallback;
}

function limits(env) {
  return {
    maxFiles: boundedNumber(env.NAS_MAX_FILES, 5000, 1, 100_000),
    maxDepth: boundedNumber(env.NAS_MAX_DEPTH, 12, 0, 64),
    maxBytes: boundedNumber(env.NAS_MAX_FILE_BYTES, MAX_FILE_BYTES, 1, MAX_FILE_BYTES),
    timeoutMs: boundedNumber(env.NAS_TIMEOUT_MS, 20_000, 10, 60_000),
    scanTimeoutMs: boundedNumber(env.NAS_SCAN_TIMEOUT_MS, 60_000, 10, 60_000),
  };
}

function validateSegment(segment) {
  try { return normalizeNasPathSegment(segment); }
  catch { throw new NasError("NAS 路径包含不允许的目录或字符。", "INVALID_NAS_PATH", 400); }
}

function relativePath(value, allowEmpty = true) {
  try { return normalizeNasRelativePath(value, { allowEmpty }); }
  catch { throw new NasError("NAS 路径必须是预配置根目录下的安全相对路径。", "INVALID_NAS_PATH", 400); }
}

function validateSource(source) {
  if (!source || !["webdav", "local", "s3", "minio"].includes(source.transport)) throw new NasError("NAS 连接类型必须为 webdav、local 或 s3。", "INVALID_NAS_TRANSPORT", 400);
  if (hasNasSourceServerOnlyFields(source)) throw new NasError("NAS 地址、存储桶与凭据必须由服务器环境变量配置。", "NAS_CONFIG_FROM_ENV_ONLY", 400);
  const transport = source.transport === "minio" ? "s3" : source.transport;
  return { transport, path: relativePath(source.path ?? "", transport !== "s3") };
}

function isWithin(relative, parent) {
  return !parent || relative === parent || relative.startsWith(`${parent}/`);
}

function scopedFilePath(source, file) {
  const relative = relativePath(file?.path, false);
  if (!isWithin(relative, source.path) || relative === source.path) throw new NasError("文件不在当前 NAS 来源目录内。", "NAS_PATH_OUTSIDE_SOURCE", 400);
  return relative;
}

function localSignature(stat) {
  return `local:v2:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function localDirectoryAnchor(stat) {
  return `local-dir:v1:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

function localManifestSignature(stat, parentAnchors) {
  return `${localSignature(stat)}:parents:${parentAnchors.join(",")}`;
}

function sameLocalIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameLocalAnchors(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((anchor, index) => anchor === right[index]);
}

function sameLocalPathSnapshot(left, right) {
  return Boolean(left && right)
    && sameLocalIdentity(left.stat, right.stat)
    && localSignature(left.stat) === localSignature(right.stat)
    && sameLocalAnchors(left.parentAnchors, right.parentAnchors);
}

function localChildParentAnchors(directorySnapshot) {
  return [...directorySnapshot.parentAnchors, localDirectoryAnchor(directorySnapshot.stat)];
}

function validLocalAnchors(value) {
  return Array.isArray(value) && value.length <= 256
    && value.every((anchor) => typeof anchor === "string" && /^local-dir:v1:\d+:\d+:\d+$/.test(anchor));
}

async function resolveLocalRoot(env, fileSystem) {
  if (!env.NAS_LOCAL_ROOT || !path.isAbsolute(env.NAS_LOCAL_ROOT)) throw new NasError("请配置绝对路径 NAS_LOCAL_ROOT（已挂载的 NAS 共享目录）。", "NAS_NOT_CONFIGURED", 503);
  const configured = path.resolve(env.NAS_LOCAL_ROOT);
  const before = await fileSystem.lstat(configured, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) throw new NasError("NAS 根路径必须是目录且不能是符号链接。", "NAS_SYMLINK_REJECTED", 400);
  const real = await fileSystem.realpath(configured);
  const after = await fileSystem.lstat(real, { bigint: true });
  if (!after.isDirectory() || !sameLocalIdentity(before, after)) throw new NasError("NAS 根目录在检查期间发生变化，请稍后重试。", "NAS_FILE_CHANGED", 409);
  return real;
}

async function captureLocalPath(root, relative, fileSystem) {
  let current = root;
  const components = relative ? relative.split("/") : [];
  let stat = await fileSystem.lstat(current, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new NasError("NAS 根路径必须是目录且不能是符号链接。", "NAS_SYMLINK_REJECTED", 400);
  const parentAnchors = [];
  if (components.length) parentAnchors.push(localDirectoryAnchor(stat));
  for (const [index, component] of components.entries()) {
    current = path.join(current, validateSegment(component));
    const before = await fileSystem.lstat(current, { bigint: true });
    if (before.isSymbolicLink()) throw new NasError("NAS 同步不跟随符号链接或目录联接。", "NAS_SYMLINK_REJECTED", 400);
    const real = await fileSystem.realpath(current);
    const fromRoot = path.relative(root, real);
    if (fromRoot.startsWith(`..${path.sep}`) || fromRoot === ".." || path.isAbsolute(fromRoot)) throw new NasError("NAS 路径越过了服务器配置的根目录。", "NAS_PATH_OUTSIDE_ROOT", 400);
    stat = await fileSystem.lstat(real, { bigint: true });
    if (stat.isSymbolicLink() || !sameLocalIdentity(before, stat)) throw new NasError("NAS 路径在检查期间发生变化，请稍后重试。", "NAS_FILE_CHANGED", 409);
    current = real;
    if (index < components.length - 1) {
      if (!stat.isDirectory()) throw new NasError("NAS 路径中的父级不是目录。", "NAS_NOT_DIRECTORY", 400);
      parentAnchors.push(localDirectoryAnchor(stat));
    }
  }
  return { absolute: current, stat, parentAnchors };
}

async function inspectLocalPath(root, relative, fileSystem) {
  const first = await captureLocalPath(root, relative, fileSystem);
  const confirmed = await captureLocalPath(root, relative, fileSystem);
  if (!sameLocalIdentity(first.stat, confirmed.stat)
    || localSignature(first.stat) !== localSignature(confirmed.stat)
    || !sameLocalAnchors(first.parentAnchors, confirmed.parentAnchors)) {
    throw new NasError("NAS 路径在检查期间发生变化，请稍后重试。", "NAS_FILE_CHANGED", 409);
  }
  return confirmed;
}

async function listLocal(source, env, settings, fileSystem) {
  const root = await resolveLocalRoot(env, fileSystem);
  const start = await inspectLocalPath(root, source.path, fileSystem);
  if (!start.stat.isDirectory()) throw new NasError("NAS 来源路径不是目录。", "NAS_NOT_DIRECTORY", 400);
  const files = [];
  const warnings = new Set();
  const queue = [{ relative: source.path, depth: 0, snapshot: start }];
  const deadline = Date.now() + settings.scanTimeoutMs;
  const maxEntries = Math.max(settings.maxFiles * 4, 100);
  let visited = 0;
  let complete = true;
  scan: while (queue.length) {
    if (Date.now() > deadline) { complete = false; warnings.add("目录扫描超时"); break; }
    const item = queue.shift();
    let directory;
    const stagedFiles = [];
    const stagedDirectories = [];
    let directoryStable = true;
    let stopAfterDirectory = false;
    try {
      const beforeOpen = await inspectLocalPath(root, item.relative, fileSystem);
      if (!beforeOpen.stat.isDirectory() || !sameLocalPathSnapshot(item.snapshot, beforeOpen)) throw new NasError("NAS 目录在发现后发生变化。", "NAS_FILE_CHANGED", 409);
      directory = await fileSystem.opendir(beforeOpen.absolute);
      const afterOpen = await inspectLocalPath(root, item.relative, fileSystem);
      if (!afterOpen.stat.isDirectory() || !sameLocalPathSnapshot(item.snapshot, afterOpen)) throw new NasError("NAS 目录在打开期间发生变化。", "NAS_FILE_CHANGED", 409);
      const childParentAnchors = localChildParentAnchors(item.snapshot);
      for await (const entry of directory) {
        visited += 1;
        if (visited > maxEntries || Date.now() > deadline) {
          complete = false;
          warnings.add("达到目录扫描数量或时间上限");
          stopAfterDirectory = true;
          break;
        }
        const relative = item.relative ? `${item.relative}/${entry.name}` : entry.name;
        try {
          validateSegment(entry.name);
          if (entry.isSymbolicLink()) { complete = false; warnings.add("跳过符号链接"); continue; }
          const inspected = await inspectLocalPath(root, relative, fileSystem);
          if (!sameLocalAnchors(inspected.parentAnchors, childParentAnchors)) throw new NasError("NAS 子项不再属于扫描时发现的目录。", "NAS_FILE_CHANGED", 409);
          const { stat } = inspected;
          if (stat.isDirectory()) {
            if (item.depth >= settings.maxDepth) { complete = false; warnings.add("达到子目录深度上限"); }
            else stagedDirectories.push({ relative, depth: item.depth + 1, snapshot: inspected });
          } else if (stat.isFile()) {
            if (Number(stat.size) > settings.maxBytes) { complete = false; warnings.add("跳过超过单文件大小限制的文件"); continue; }
            if (files.length + stagedFiles.length >= settings.maxFiles) {
              complete = false;
              warnings.add("达到文件数量上限");
              stopAfterDirectory = true;
              break;
            }
            stagedFiles.push({
              path: relative,
              name: entry.name,
              size: Number(stat.size),
              signature: localManifestSignature(stat, inspected.parentAnchors),
              modifiedAt: new Date(Number(stat.mtimeMs)).toISOString(),
              localParentAnchors: inspected.parentAnchors,
            });
          } else { complete = false; warnings.add("跳过非普通文件"); }
        } catch (error) {
          if (error?.code === "NAS_FILE_CHANGED") throw error;
          complete = false;
          warnings.add("部分文件无法安全读取");
        }
      }
      const afterEnumeration = await inspectLocalPath(root, item.relative, fileSystem);
      if (!afterEnumeration.stat.isDirectory() || !sameLocalPathSnapshot(item.snapshot, afterEnumeration)) throw new NasError("NAS 目录在枚举期间发生变化。", "NAS_FILE_CHANGED", 409);
    } catch (error) {
      directoryStable = false;
      complete = false;
      warnings.add(error?.code === "NAS_FILE_CHANGED" ? "扫描期间目录发生变化，已丢弃该目录结果" : "部分目录不可访问");
      if (directory) await directory.close().catch(() => {});
    }
    if (directoryStable) {
      files.push(...stagedFiles);
      queue.push(...stagedDirectories);
    }
    if (stopAfterDirectory) break scan;
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), complete, ...(warnings.size ? { warning: [...warnings].join("；") } : {}) };
}

async function readLocal(source, file, env, settings, fileSystem) {
  const relative = scopedFilePath(source, file);
  const root = await resolveLocalRoot(env, fileSystem);
  const inspected = await inspectLocalPath(root, relative, fileSystem);
  const { absolute, stat: original } = inspected;
  if (!original.isFile() || original.isSymbolicLink()) throw new NasError("NAS 路径不是普通文件。", "NAS_NOT_FILE", 400);
  if (Number(original.size) > settings.maxBytes) throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
  if (!file.signature || file.signature !== localManifestSignature(original, inspected.parentAnchors)
    || !validLocalAnchors(file.localParentAnchors)
    || !sameLocalAnchors(file.localParentAnchors, inspected.parentAnchors)) {
    throw new NasError("NAS 文件或父目录在扫描后发生变化，将在下次同步时重试。", "NAS_FILE_CHANGED", 409);
  }
  const handle = await fileSystem.open(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameLocalIdentity(opened, original) || localSignature(opened) !== localSignature(original)) throw new NasError("NAS 文件在读取前发生变化。", "NAS_FILE_CHANGED", 409);
    const buffers = [];
    let length = 0;
    const deadline = Date.now() + settings.timeoutMs;
    while (true) {
      if (Date.now() > deadline) throw new NasError("读取 NAS 文件超时。", "NAS_TIMEOUT", 504);
      const buffer = Buffer.alloc(Math.min(64 * 1024, settings.maxBytes + 1 - length));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > settings.maxBytes) throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
      buffers.push(buffer.subarray(0, bytesRead));
    }
    const finalStat = await handle.stat({ bigint: true });
    const finalPath = await inspectLocalPath(root, relative, fileSystem);
    if (localSignature(finalStat) !== localSignature(original)
      || !sameLocalIdentity(finalStat, finalPath.stat)
      || localManifestSignature(finalPath.stat, finalPath.parentAnchors) !== file.signature
      || !sameLocalAnchors(file.localParentAnchors, finalPath.parentAnchors)) {
      throw new NasError("NAS 文件或父目录在读取期间发生变化，将在下次同步时重试。", "NAS_FILE_CHANGED", 409);
    }
    return Buffer.concat(buffers, length);
  } finally { await handle.close(); }
}

function webdavConfig(env) {
  if (!getNasCapabilities(env).webdav) throw new NasError("请配置 NAS_WEBDAV_URL、NAS_WEBDAV_USERNAME 和 NAS_WEBDAV_PASSWORD。", "NAS_NOT_CONFIGURED", 503);
  let base;
  try { base = new URL(env.NAS_WEBDAV_URL); } catch { throw new NasError("NAS_WEBDAV_URL 不是有效地址。", "INVALID_NAS_CONFIG", 503); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new NasError("NAS WebDAV 仅接受不含凭据和查询参数的 HTTP(S) 根地址。", "INVALID_NAS_CONFIG", 503);
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const baseSegments = decodeUrlSegments(base.pathname);
  return { base, baseSegments, authorization: `Basic ${Buffer.from(`${env.NAS_WEBDAV_USERNAME}:${env.NAS_WEBDAV_PASSWORD}`, "utf8").toString("base64")}` };
}

function decodeUrlSegments(pathname) {
  const pieces = pathname.split("/").filter(Boolean);
  try { return pieces.map((piece) => validateSegment(decodeURIComponent(piece))); }
  catch (error) {
    if (error instanceof NasError) throw error;
    throw new NasError("WebDAV 返回了无法识别的文件路径。", "INVALID_NAS_PATH", 502);
  }
}

function webdavUrl(config, relative, directory = false) {
  const encoded = relative ? relative.split("/").map((piece) => encodeURIComponent(validateSegment(piece))).join("/") : "";
  const url = new URL(encoded + (directory && encoded ? "/" : ""), config.base);
  if (url.origin !== config.base.origin) throw new NasError("不允许跨服务器访问 NAS 文件。", "NAS_CROSS_ORIGIN", 400);
  return url;
}

function hrefPath(href, currentUrl, config, source) {
  if (typeof href !== "string" || !href || href.includes("\\") || /[\u0000-\u001f]/u.test(href)) throw new NasError("WebDAV 返回了无效的文件路径。", "INVALID_NAS_PATH");
  const rawPath = href.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
  for (const segment of rawPath.split("/").filter(Boolean)) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new NasError("WebDAV 路径编码无效。", "INVALID_NAS_PATH"); }
    validateSegment(decoded);
  }
  const url = new URL(href, currentUrl);
  if (url.origin !== config.base.origin || url.username || url.password || url.search || url.hash) throw new NasError("不允许跟随跨服务器或带参数的 WebDAV 路径。", "NAS_CROSS_ORIGIN");
  const segments = decodeUrlSegments(url.pathname);
  if (!config.baseSegments.every((segment, index) => segments[index] === segment)) throw new NasError("WebDAV 文件越过了配置的根目录。", "NAS_PATH_OUTSIDE_ROOT");
  const relative = segments.slice(config.baseSegments.length).join("/");
  if (!isWithin(relative, source.path)) throw new NasError("WebDAV 文件不在当前来源目录内。", "NAS_PATH_OUTSIDE_SOURCE");
  return relative;
}

async function readResponseBuffer(response, maximum, signal) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximum) {
    await response.body?.cancel();
    throw new NasError("NAS 响应超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const buffers = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await new Promise((resolve, reject) => {
        const onAbort = () => {
          void reader.cancel().catch(() => {});
          reject(new NasError("读取 NAS 响应超时。", "NAS_TIMEOUT", 504));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        reader.read().then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new NasError("NAS 响应超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
      }
      buffers.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(buffers, total);
}

async function requestWebdav(url, config, options, settings, fetchImpl) {
  const signal = AbortSignal.timeout(settings.timeoutMs);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: options.method,
      redirect: "manual",
      signal,
      headers: { Authorization: config.authorization, ...options.headers },
      ...(options.body ? { body: options.body } : {}),
    });
  } catch {
    throw new NasError(signal.aborted ? "NAS WebDAV 请求超时。" : "无法连接 NAS WebDAV，请检查地址、网络与证书。", signal.aborted ? "NAS_TIMEOUT" : "NAS_CONNECTION_FAILED", signal.aborted ? 504 : 502);
  }
  if (response.status >= 300 && response.status < 400 || response.redirected) {
    await response.body?.cancel();
    throw new NasError("NAS WebDAV 返回了重定向；为保护凭据，请在环境变量中填写最终地址。", "NAS_REDIRECT_REJECTED");
  }
  if (response.status === 401 || response.status === 403) throw new NasError("NAS 账户认证失败或没有读取该目录的权限。", "NAS_AUTH_FAILED");
  if (response.status === 412) throw new NasError("NAS 文件已变更，将在下次同步重试。", "NAS_FILE_CHANGED", 409);
  if (!response.ok) throw new NasError(`NAS WebDAV 请求失败（HTTP ${response.status}）。`, "NAS_UPSTREAM_ERROR");
  return { response, signal };
}

function array(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function scalar(value) { return typeof value === "object" ? String(value?.["#text"] ?? "") : String(value ?? ""); }
function parseModified(value) { const milliseconds = Date.parse(scalar(value)); return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null; }

async function listWebdav(source, env, settings, fetchImpl) {
  const config = webdavConfig(env);
  const files = [];
  const warnings = new Set();
  const seen = new Set();
  const queue = [{ relative: source.path, depth: 0 }];
  const deadline = Date.now() + settings.scanTimeoutMs;
  const maxEntries = Math.max(settings.maxFiles * 4, 100);
  let visited = 0;
  let complete = true;
  scan: while (queue.length) {
    if (Date.now() > deadline) { complete = false; warnings.add("目录扫描超时"); break; }
    const directory = queue.shift();
    const currentUrl = webdavUrl(config, directory.relative, true);
    let responses;
    try {
      const requestSettings = { ...settings, timeoutMs: Math.max(1, Math.min(settings.timeoutMs, deadline - Date.now())) };
      const { response, signal } = await requestWebdav(currentUrl, config, { method: "PROPFIND", headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" }, body: PROPFIND_BODY }, requestSettings, fetchImpl);
      if (response.status !== 207) throw new NasError("NAS 未返回 WebDAV 多状态目录，请核对 WebDAV 地址而非管理登录网址。", "INVALID_WEBDAV_RESPONSE");
      const xml = (await readResponseBuffer(response, MAX_XML_BYTES, signal)).toString("utf8");
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new NasError("WebDAV 返回了不安全或损坏的 XML。", "INVALID_WEBDAV_RESPONSE");
      const parsed = new XMLParser({ removeNSPrefix: true, ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(xml);
      if (!parsed.multistatus) throw new NasError("WebDAV 返回格式不正确。", "INVALID_WEBDAV_RESPONSE");
      responses = array(parsed.multistatus.response);
    } catch (error) {
      if (directory.depth === 0) throw error;
      complete = false;
      warnings.add("部分 WebDAV 子目录无法扫描");
      continue;
    }
    let foundDirectory = false;
    for (const response of responses) {
      visited += 1;
      if (visited > maxEntries || Date.now() > deadline) { complete = false; warnings.add("达到目录扫描数量或时间上限"); break scan; }
      try {
        const relative = hrefPath(scalar(response.href), currentUrl, config, source);
        const goodProperties = array(response.propstat).filter((entry) => /\s200(?:\s|$)/.test(scalar(entry.status)));
        if (!goodProperties.length) { complete = false; warnings.add("部分 WebDAV 项目无读取权限"); continue; }
        const props = Object.assign({}, ...goodProperties.map((entry) => entry.prop || {}));
        if (props.reftarget || props.linktarget || scalar(props.islink) === "1" || (typeof props.resourcetype === "object" && Object.hasOwn(props.resourcetype, "redirectref"))) throw new NasError("不跟随 WebDAV 链接或重定向引用。", "NAS_SYMLINK_REJECTED");
        const isDirectory = props.resourcetype && typeof props.resourcetype === "object" && Object.hasOwn(props.resourcetype, "collection");
        if (relative === directory.relative) {
          if (!isDirectory) throw new NasError("NAS 来源路径不是目录。", "NAS_NOT_DIRECTORY", 400);
          foundDirectory = true;
          continue;
        }
        if (path.posix.dirname(relative) !== (directory.relative || ".")) throw new NasError("WebDAV Depth:1 返回了非直接子项。", "INVALID_WEBDAV_RESPONSE");
        if (seen.has(relative)) continue;
        seen.add(relative);
        if (isDirectory) {
          if (directory.depth >= settings.maxDepth) { complete = false; warnings.add("达到子目录深度上限"); }
          else queue.push({ relative, depth: directory.depth + 1 });
          continue;
        }
        const sizeText = scalar(props.getcontentlength);
        const size = Number(sizeText);
        if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size < 0) { complete = false; warnings.add("部分文件没有有效大小元数据"); continue; }
        if (size > settings.maxBytes) { complete = false; warnings.add("跳过超过单文件大小限制的文件"); continue; }
        if (files.length >= settings.maxFiles) { complete = false; warnings.add("达到文件数量上限"); break scan; }
        const etag = scalar(props.getetag);
        const modifiedAt = parseModified(props.getlastmodified);
        if (!etag && !modifiedAt) { complete = false; warnings.add("部分文件缺少版本元数据"); continue; }
        files.push({ path: relative, name: path.posix.basename(relative), size, signature: etag ? `etag:${etag}` : `meta:${size}:${modifiedAt}`, modifiedAt });
      } catch { complete = false; warnings.add("跳过不安全或不可访问的 WebDAV 路径"); }
    }
    if (!foundDirectory) { complete = false; warnings.add("WebDAV 未确认当前目录的完整状态"); }
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), complete, ...(warnings.size ? { warning: [...warnings].join("；") } : {}) };
}

async function readWebdav(source, file, env, settings, fetchImpl) {
  const config = webdavConfig(env);
  const relative = scopedFilePath(source, file);
  if (Number(file.size) > settings.maxBytes) throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
  const headers = {};
  const expectedEtag = file.signature?.startsWith("etag:") ? file.signature.slice(5) : undefined;
  if (expectedEtag && !expectedEtag.startsWith("W/") && !/[\r\n]/.test(expectedEtag)) headers["If-Match"] = expectedEtag;
  if (file.modifiedAt && Number.isFinite(Date.parse(file.modifiedAt))) headers["If-Unmodified-Since"] = new Date(file.modifiedAt).toUTCString();
  const { response, signal } = await requestWebdav(webdavUrl(config, relative), config, { method: "GET", headers }, settings, fetchImpl);
  const responseEtag = response.headers.get("etag");
  if (expectedEtag && responseEtag && expectedEtag !== responseEtag) {
    await response.body?.cancel();
    throw new NasError("NAS 文件在扫描后发生变化。", "NAS_FILE_CHANGED", 409);
  }
  const buffer = await readResponseBuffer(response, settings.maxBytes, signal);
  if (Number.isSafeInteger(file.size) && buffer.length !== file.size) throw new NasError("NAS 文件大小在扫描后发生变化，将在下次同步重试。", "NAS_FILE_CHANGED", 409);
  return buffer;
}

function validS3BucketName(value) {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !value.includes("..");
}

function validS3Region(value) { return /^[a-z0-9][a-z0-9-]{0,62}$/i.test(value); }

function s3Configuration(env) {
  const missing = ["NAS_S3_ENDPOINT", "NAS_S3_BUCKET", "NAS_S3_ACCESS_KEY_ID", "NAS_S3_SECRET_ACCESS_KEY"].filter((name) => !env[name]);
  if (missing.length) throw new NasError("请配置 NAS_S3_ENDPOINT、NAS_S3_BUCKET、NAS_S3_ACCESS_KEY_ID 和 NAS_S3_SECRET_ACCESS_KEY。", "NAS_NOT_CONFIGURED", 503);
  let endpoint;
  try { endpoint = new URL(env.NAS_S3_ENDPOINT); }
  catch { throw new NasError("NAS_S3_ENDPOINT 不是有效地址。", "INVALID_NAS_CONFIG", 503); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new NasError("NAS_S3_ENDPOINT 仅接受不含凭据、路径和查询参数的 HTTP(S) 地址。", "INVALID_NAS_CONFIG", 503);
  }
  const bucket = String(env.NAS_S3_BUCKET);
  if (!validS3BucketName(bucket)) throw new NasError("NAS_S3_BUCKET 不是有效的 S3 存储桶名称。", "INVALID_NAS_CONFIG", 503);
  const region = env.NAS_S3_REGION || "us-east-1";
  if (!validS3Region(region)) throw new NasError("NAS_S3_REGION 格式无效。", "INVALID_NAS_CONFIG", 503);
  const credential = (name, maximum) => {
    const value = env[name];
    if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new NasError("NAS S3 凭据配置无效。", "INVALID_NAS_CONFIG", 503);
    return value;
  };
  const accessKeyId = credential("NAS_S3_ACCESS_KEY_ID", 512);
  const secretAccessKey = credential("NAS_S3_SECRET_ACCESS_KEY", 4096);
  const sessionToken = env.NAS_S3_SESSION_TOKEN ? credential("NAS_S3_SESSION_TOKEN", 8192) : undefined;
  return {
    endpoint: endpoint.href.replace(/\/$/, ""),
    bucket,
    region,
    prefix: relativePath(env.NAS_S3_PREFIX || ""),
    forcePathStyle: environmentBoolean(env.NAS_S3_FORCE_PATH_STYLE, true),
    credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
  };
}

function defaultS3ClientFactory(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: config.credentials,
    followRegionRedirects: false,
    maxAttempts: 3,
  });
}

function joinedS3Path(...parts) { return parts.filter(Boolean).join("/"); }
function s3ListPrefix(config, source) {
  const joined = joinedS3Path(config.prefix, source.path);
  return joined ? `${joined}/` : "";
}

function s3ObjectKey(config, relative) { return joinedS3Path(config.prefix, relative); }

function s3RelativeKey(key, config, source) {
  if (typeof key !== "string" || !key || key.length > 8192 || key.endsWith("/")) throw new NasError("S3 返回了无效的对象键。", "INVALID_S3_RESPONSE");
  const root = config.prefix ? `${config.prefix}/` : "";
  if (root && !key.startsWith(root)) throw new NasError("S3 对象越过了配置的全局前缀。", "NAS_PATH_OUTSIDE_ROOT");
  const relative = relativePath(root ? key.slice(root.length) : key, false);
  if (!isWithin(relative, source.path) || relative === source.path) throw new NasError("S3 对象不在当前来源前缀内。", "NAS_PATH_OUTSIDE_SOURCE");
  return relative;
}

function s3Size(value) {
  const size = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function s3Modified(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ""));
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function sameS3ModifiedSecond(left, right) {
  const leftMilliseconds = Date.parse(String(left ?? ""));
  const rightMilliseconds = Date.parse(String(right ?? ""));
  return Number.isFinite(leftMilliseconds) && Number.isFinite(rightMilliseconds)
    && Math.floor(leftMilliseconds / 1000) === Math.floor(rightMilliseconds / 1000);
}

function s3Etag(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value) ? value : null;
}

function s3Signature({ etag, modifiedAt, size }) { return `s3:${size}:${modifiedAt}:${etag}`; }

function mapS3Error(error) {
  if (error instanceof NasError) return error;
  const name = String(error?.name || error?.Code || "");
  const status = Number(error?.$metadata?.httpStatusCode);
  if (["AbortError", "TimeoutError", "RequestTimeout", "RequestTimeoutException"].includes(name) || error?.code === "ETIMEDOUT") return new NasError("NAS S3 操作超时，请检查网络后重试。", "NAS_TIMEOUT", 504);
  if (name === "NoSuchBucket") return new NasError("NAS S3 存储桶不存在。", "NAS_BUCKET_NOT_FOUND", 404);
  if (["PreconditionFailed", "NoSuchKey", "NotFound"].includes(name) || status === 404 || status === 412) return new NasError("NAS S3 对象在扫描后发生变化，将在下次同步重试。", "NAS_FILE_CHANGED", 409);
  if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken"].includes(name) || status === 401 || status === 403) return new NasError("NAS S3 凭据无效或没有读取存储桶的权限。", "NAS_AUTH_FAILED", 502);
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "NetworkingError"].includes(name) || ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(error?.code)) return new NasError("无法连接 NAS S3，请检查地址、网络与证书。", "NAS_CONNECTION_FAILED", 502);
  return new NasError("NAS S3 请求失败，请检查端点、区域和存储桶权限。", "NAS_UPSTREAM_ERROR", 502);
}

async function sendS3Raw(client, command, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  const request = Promise.resolve().then(() => client.send(command, { abortSignal: signal }));
  const output = await new Promise((resolve, reject) => {
    const onAbort = () => reject(new NasError("NAS S3 操作超时，请检查网络后重试。", "NAS_TIMEOUT", 504));
    signal.addEventListener("abort", onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
  return { output, signal };
}

async function sendS3(client, command, timeoutMs) {
  try { return await sendS3Raw(client, command, timeoutMs); }
  catch (error) { throw mapS3Error(error); }
}

function rejectsConditionalGetAsAccessDenied(error) {
  const name = String(error?.name || error?.Code || "");
  return name === "AccessDenied" && Number(error?.$metadata?.httpStatusCode) === 400;
}

async function listS3(source, env, settings, s3ClientFactory) {
  const config = s3Configuration(env);
  const client = s3ClientFactory(config);
  if (!client || typeof client.send !== "function") throw new NasError("NAS S3 客户端初始化失败。", "INVALID_NAS_CONFIG", 503);
  const files = [];
  const warnings = new Set();
  const seenKeys = new Set();
  const seenTokens = new Set();
  const deadline = Date.now() + settings.scanTimeoutMs;
  const maxEntries = Math.max(settings.maxFiles * 4, 100);
  const prefix = s3ListPrefix(config, source);
  let continuationToken;
  let visited = 0;
  let pages = 0;
  let complete = true;
  try {
    scan: while (true) {
      if (Date.now() >= deadline) { complete = false; warnings.add("S3 对象扫描超时"); break; }
      let output;
      try {
        ({ output } = await sendS3(client, new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1000, Math.max(2, settings.maxFiles + 1)),
          ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
        }), Math.max(1, Math.min(settings.timeoutMs, deadline - Date.now()))));
      } catch (error) {
        if (!pages) throw error;
        complete = false;
        warnings.add("部分 S3 分页无法扫描");
        break;
      }
      pages += 1;
      if (!output || (output.Contents !== undefined && !Array.isArray(output.Contents))) throw new NasError("S3 返回格式不正确。", "INVALID_S3_RESPONSE");
      for (const object of output.Contents || []) {
        visited += 1;
        if (visited > maxEntries || Date.now() >= deadline) { complete = false; warnings.add("达到 S3 扫描数量或时间上限"); break scan; }
        try {
          if (typeof object?.Key === "string" && object.Key.endsWith("/")) continue;
          const relative = s3RelativeKey(object?.Key, config, source);
          if (seenKeys.has(object.Key)) { complete = false; warnings.add("S3 分页返回了重复对象"); continue; }
          seenKeys.add(object.Key);
          const withinSource = source.path ? relative.slice(source.path.length + 1) : relative;
          if (withinSource.split("/").length - 1 > settings.maxDepth) { complete = false; warnings.add("达到子目录深度上限"); continue; }
          const size = s3Size(object.Size);
          const etag = s3Etag(object.ETag);
          const modifiedAt = s3Modified(object.LastModified);
          if (size === null || !etag || !modifiedAt) { complete = false; warnings.add("部分 S3 对象缺少有效版本元数据"); continue; }
          if (size > settings.maxBytes) { complete = false; warnings.add("跳过超过单文件大小限制的文件"); continue; }
          if (files.length >= settings.maxFiles) { complete = false; warnings.add("达到文件数量上限"); break scan; }
          files.push({ path: relative, name: path.posix.basename(relative), size, etag, signature: s3Signature({ etag, modifiedAt, size }), modifiedAt });
        } catch { complete = false; warnings.add("跳过不安全或不可访问的 S3 对象键"); }
      }
      if (!output.IsTruncated) break;
      const next = output.NextContinuationToken;
      if (typeof next !== "string" || !next || next.length > 8192 || seenTokens.has(next)) { complete = false; warnings.add("S3 分页游标无效"); break; }
      seenTokens.add(next);
      continuationToken = next;
    }
    return { files: files.sort((a, b) => a.path.localeCompare(b.path)), complete, ...(warnings.size ? { warning: [...warnings].join("；") } : {}) };
  } finally { client.destroy?.(); }
}

function cancelS3Body(iterator, body) {
  try { body?.destroy?.(); } catch { /* Best-effort stream cancellation. */ }
  try {
    const closing = iterator?.return?.();
    if (closing && typeof closing.catch === "function") void closing.catch(() => {});
  } catch { /* Best-effort iterator cancellation. */ }
}

async function nextS3Chunk(iterator, body, signal) {
  if (signal.aborted) throw new NasError("读取 NAS S3 对象超时。", "NAS_TIMEOUT", 504);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cancelS3Body(iterator, body);
      reject(new NasError("读取 NAS S3 对象超时。", "NAS_TIMEOUT", 504));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(iterator.next()).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function readS3Body(body, maximum, signal) {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (body instanceof Uint8Array) {
    if (body.byteLength > maximum) throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
    return Buffer.from(body);
  }
  if (typeof body[Symbol.asyncIterator] !== "function") throw new NasError("S3 对象响应格式不正确。", "INVALID_S3_RESPONSE");
  const iterator = body[Symbol.asyncIterator]();
  const buffers = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await nextS3Chunk(iterator, body, signal);
      if (done) break;
      if (!(typeof value === "string" || value instanceof Uint8Array)) throw new NasError("S3 对象流包含无效数据。", "INVALID_S3_RESPONSE");
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximum) {
        try { body.destroy?.(); } catch { /* Best-effort stream cancellation. */ }
        throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
      }
      buffers.push(chunk);
    }
  } finally { cancelS3Body(iterator); }
  return Buffer.concat(buffers, total);
}

async function readS3(source, file, env, settings, s3ClientFactory) {
  const config = s3Configuration(env);
  const relative = scopedFilePath(source, file);
  const size = s3Size(file?.size);
  const etag = s3Etag(file?.etag);
  const modifiedAt = s3Modified(file?.modifiedAt);
  if (size === null || !etag || !modifiedAt || file.signature !== s3Signature({ etag, modifiedAt, size })) throw new NasError("S3 文件版本元数据无效。", "INVALID_NAS_FILE_METADATA", 400);
  if (size > settings.maxBytes) throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
  const client = s3ClientFactory(config);
  if (!client || typeof client.send !== "function") throw new NasError("NAS S3 客户端初始化失败。", "INVALID_NAS_CONFIG", 503);
  try {
    const deadline = Date.now() + settings.timeoutMs;
    const remainingTimeout = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new NasError("NAS S3 操作超时，请检查网络后重试。", "NAS_TIMEOUT", 504);
      return remaining;
    };
    let response;
    try {
      response = await sendS3Raw(client, new GetObjectCommand({
        Bucket: config.bucket,
        Key: s3ObjectKey(config, relative),
        IfMatch: etag,
        IfUnmodifiedSince: new Date(modifiedAt),
      }), remainingTimeout());
    } catch (error) {
      if (!rejectsConditionalGetAsAccessDenied(error)) throw mapS3Error(error);
      // Some MinIO-compatible gateways return HTTP 400 AccessDenied for all
      // conditional GETs. Retry only that exact compatibility response; the
      // response metadata below must still match the immutable list snapshot.
      response = await sendS3(client, new GetObjectCommand({
        Bucket: config.bucket,
        Key: s3ObjectKey(config, relative),
      }), remainingTimeout());
    }
    const { output, signal } = response;
    const responseSize = s3Size(output?.ContentLength);
    const responseEtag = s3Etag(output?.ETag);
    const responseModifiedAt = s3Modified(output?.LastModified);
    if (responseSize === null || !responseEtag || !responseModifiedAt) throw new NasError("S3 对象响应缺少版本元数据。", "INVALID_S3_RESPONSE");
    if (responseSize > settings.maxBytes) {
      try { output.Body?.destroy?.(); } catch { /* Best-effort stream cancellation. */ }
      throw new NasError("NAS 文件超过大小限制。", "NAS_FILE_TOO_LARGE", 413);
    }
    // ListObjects can retain sub-second precision while the HTTP Last-Modified
    // response header is defined at whole-second precision.
    if (responseSize !== size || responseEtag !== etag || !sameS3ModifiedSecond(responseModifiedAt, modifiedAt)) {
      try { output.Body?.destroy?.(); } catch { /* Best-effort stream cancellation. */ }
      throw new NasError("NAS S3 对象在扫描后发生变化，将在下次同步重试。", "NAS_FILE_CHANGED", 409);
    }
    const buffer = await readS3Body(output.Body, settings.maxBytes, signal);
    if (buffer.length !== size) throw new NasError("NAS S3 对象大小在扫描后发生变化，将在下次同步重试。", "NAS_FILE_CHANGED", 409);
    return buffer;
  } catch (error) { throw mapS3Error(error); }
  finally { client.destroy?.(); }
}

export async function listNasFiles(source, { env = process.env, fetchImpl = fetch, s3ClientFactory = defaultS3ClientFactory, fileSystem = fs } = {}) {
  const selected = validateSource(source);
  const settings = limits(env);
  try {
    return await (selected.transport === "local" ? listLocal(selected, env, settings, fileSystem)
      : selected.transport === "s3" ? listS3(selected, env, settings, s3ClientFactory)
        : listWebdav(selected, env, settings, fetchImpl));
  } catch (error) { throw readableError(error); }
}

export async function readNasFile(source, file, { env = process.env, fetchImpl = fetch, s3ClientFactory = defaultS3ClientFactory, fileSystem = fs } = {}) {
  const selected = validateSource(source);
  const settings = limits(env);
  try {
    return await (selected.transport === "local" ? readLocal(selected, file, env, settings, fileSystem)
      : selected.transport === "s3" ? readS3(selected, file, env, settings, s3ClientFactory)
        : readWebdav(selected, file, env, settings, fetchImpl));
  } catch (error) { throw readableError(error); }
}

function readableError(error) {
  if (error instanceof NasError) return error;
  if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return new NasError("NAS 路径不存在或共享目录尚未挂载，请检查目录配置。", "NAS_PATH_NOT_FOUND", 404);
  if (error?.code === "EACCES" || error?.code === "EPERM") return new NasError("服务器没有读取 NAS 目录的权限，请检查只读账号和共享权限。", "NAS_PERMISSION_DENIED", 403);
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return new NasError("NAS 操作超时，请检查网络后重试。", "NAS_TIMEOUT", 504);
  return new NasError("NAS 文件读取失败，请检查文件是否仍存在、网络连接和目录权限。", "NAS_IO_ERROR", 502);
}
