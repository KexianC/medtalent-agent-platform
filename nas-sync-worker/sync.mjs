import path from "node:path";
import { promises as fs, constants } from "node:fs";
import { createHash } from "node:crypto";
import { loadState, saveState } from "./state.mjs";
import { canonicalObjectPrefixKey, validateObjectSegment } from "./config.mjs";

const IGNORED_DIRECTORIES = new Set(["#recycle", "@eaDir", ".snapshot", ".snapshots"]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

function insideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fileIdentity(info) {
  return `${info.dev}:${info.ino}`;
}

function samePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function unsafeSource(message, code = "SOURCE_PATH_CHANGED") {
  return Object.assign(new Error(message), { code });
}

function siblingNormalizationCollisions(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const normalized = entry.name.normalize("NFC");
    const names = groups.get(normalized) || [];
    names.push(entry.name);
    groups.set(normalized, names);
  }
  const names = new Set();
  let groupCount = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    groupCount += 1;
    for (const name of group) names.add(name);
  }
  return { names, groupCount };
}

function recordNormalizationCollisions(result, collisions, currentPath = "") {
  if (!collisions.names.size) return;
  result.complete = false;
  result.deletionSafe = false;
  result.ignored.normalizationCollisions += collisions.names.size;
  result.errors.push({
    code: "NORMALIZATION_COLLISION",
    message: `同一目录中发现 ${collisions.groupCount} 组 NFC 规范化后重名项，已整组跳过并禁止本轮删除。`,
    ...(currentPath ? { path: currentPath.slice(0, 300) } : {}),
  });
}

async function captureDirectoryAnchor(absolutePath, containmentRoot = null) {
  const resolved = path.resolve(absolutePath);
  const before = await fs.lstat(resolved);
  if (before.isSymbolicLink() || !before.isDirectory()) throw unsafeSource("NAS 路径包含符号链接或非目录祖先。", "SOURCE_ANCESTOR_UNSAFE");
  const realPath = await fs.realpath(resolved);
  if (containmentRoot && !insideRoot(containmentRoot, realPath)) throw unsafeSource("NAS 目录解析后超出已锚定根目录。", "SOURCE_ESCAPE");
  const after = await fs.lstat(resolved);
  if (after.isSymbolicLink() || !after.isDirectory() || fileIdentity(before) !== fileIdentity(after)) {
    throw unsafeSource("NAS 目录在锚定期间发生变化。", "SOURCE_PATH_CHANGED");
  }
  const realPathAfter = await fs.realpath(resolved);
  if (!samePath(realPath, realPathAfter)) throw unsafeSource("NAS 目录解析目标发生变化。", "SOURCE_PATH_CHANGED");
  return { absolutePath: resolved, realPath, identity: fileIdentity(after) };
}

async function verifyDirectoryAnchor(anchor) {
  const info = await fs.lstat(anchor.absolutePath);
  if (info.isSymbolicLink() || !info.isDirectory() || fileIdentity(info) !== anchor.identity) {
    throw unsafeSource("已锚定 NAS 目录被替换。", "SOURCE_PATH_CHANGED");
  }
  const realPath = await fs.realpath(anchor.absolutePath);
  if (!samePath(realPath, anchor.realPath)) throw unsafeSource("已锚定 NAS 目录解析目标改变。", "SOURCE_PATH_CHANGED");
}

async function verifyAnchorChain(anchors) {
  for (const anchor of anchors) await verifyDirectoryAnchor(anchor);
}

async function captureSourceRoot(sourceRoot) {
  const resolved = path.resolve(sourceRoot);
  const parsed = path.parse(resolved);
  const remainder = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const anchors = [];
  let current = parsed.root;
  for (const component of remainder) {
    current = path.join(current, component);
    anchors.push(await captureDirectoryAnchor(current));
  }
  if (!anchors.length) anchors.push(await captureDirectoryAnchor(parsed.root));
  const root = anchors.at(-1);
  await verifyAnchorChain(anchors);
  return { rootRealPath: root.realPath, identity: root.identity, anchors };
}

function sourceId(parts) {
  return parts.map((part) => validateObjectSegment(part, "NAS 相对路径")).join("/");
}

function objectKey(config, agentPrefix, relativeParts) {
  const segments = [...config.basePrefix.split("/").filter(Boolean), validateObjectSegment(agentPrefix, "智能体对象前缀"), ...relativeParts]
    .filter(Boolean)
    .map((part) => validateObjectSegment(part, "对象键路径"));
  return segments.join("/");
}

export function sanitizeError(error) {
  const message = String(error?.message || error || "未知错误")
    .replace(/(access[_ -]?key|secret|password|passwd|session[_ -]?token|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[REDACTED]@")
    .slice(0, 500);
  return { code: String(error?.code || error?.name || "SYNC_ERROR").slice(0, 80), message };
}

function sameFingerprint(record, file) {
  return record?.size === file.size && record?.mtimeMs === file.mtimeMs && record?.key === file.key;
}

function remoteMatches(head, size, sha256) {
  return Boolean(head && Number(head.size) === size && String(head.sha256 || "").toLowerCase() === sha256.toLowerCase());
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error("同步任务因进程退出而取消。"), { code: "OPERATION_ABORTED" });
}

function timestampDue(value, intervalMs, now) {
  const timestamp = Date.parse(value || "");
  return intervalMs === 0 || !Number.isFinite(timestamp) || now - timestamp >= intervalMs;
}

export async function scanSource(config, { now = Date.now(), onProgress = () => {}, signal } = {}) {
  throwIfAborted(signal);
  const result = {
    complete: true,
    deletionSafe: true,
    files: [],
    present: new Set(),
    errors: [],
    deletionAnchors: [],
    ignored: { rootFiles: 0, symlinks: 0, unsupported: 0, tooLarge: 0, unstable: 0, unmappedAgents: 0, prefixCollisions: 0, normalizationCollisions: 0 },
    sourceIdentity: "",
    rootDirectories: 0,
    scannedFiles: 0,
  };
  let root;
  try {
    root = await captureSourceRoot(config.sourceRoot);
    result.sourceIdentity = root.identity;
    result.deletionAnchors.push(...root.anchors);
  } catch (error) {
    throwIfAborted(signal);
    result.complete = false;
    result.deletionSafe = false;
    result.errors.push(sanitizeError(error));
    return result;
  }

  let topEntries;
  try {
    await verifyAnchorChain(root.anchors);
    topEntries = await fs.readdir(root.rootRealPath, { withFileTypes: true });
    await verifyAnchorChain(root.anchors);
  } catch (error) {
    throwIfAborted(signal);
    result.complete = false;
    result.deletionSafe = false;
    result.errors.push(sanitizeError(error));
    return result;
  }

  const walk = async (directoryAnchor, anchors, agentRootRealPath, sourceParts, agentPrefix, relativeParts) => {
    if (!result.complete && result.scannedFiles >= config.maxScanFiles) return;
    let entries;
    try {
      await verifyAnchorChain(anchors);
      entries = await fs.readdir(directoryAnchor.absolutePath, { withFileTypes: true });
      await verifyAnchorChain(anchors);
    } catch (error) {
      throwIfAborted(signal);
      result.complete = false;
      result.deletionSafe = false;
      result.errors.push({ ...sanitizeError(error), path: sourceId(sourceParts).slice(0, 300) });
      return;
    }
    const normalizationCollisions = siblingNormalizationCollisions(entries);
    recordNormalizationCollisions(result, normalizationCollisions, sourceId(sourceParts));
    entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    for (const entry of entries) {
      onProgress();
      if (normalizationCollisions.names.has(entry.name)) continue;
      if (result.scannedFiles >= config.maxScanFiles) {
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ code: "SCAN_LIMIT", message: `扫描文件数达到上限 ${config.maxScanFiles}，已禁止本轮删除。` });
        return;
      }
      let safeName;
      try { safeName = validateObjectSegment(entry.name, "NAS 文件名"); } catch (error) {
        result.complete = false;
        result.errors.push(sanitizeError(error));
        continue;
      }
      const absolutePath = path.join(directoryAnchor.absolutePath, entry.name);
      if (entry.isSymbolicLink()) {
        result.ignored.symlinks += 1;
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ code: "SYMLINK_SKIPPED", message: "发现符号链接分支，本轮已禁止删除。" });
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) {
          try {
            const childAnchor = await captureDirectoryAnchor(absolutePath, agentRootRealPath);
            result.deletionAnchors.push(childAnchor);
            await verifyAnchorChain(anchors);
            await walk(childAnchor, [...anchors, childAnchor], agentRootRealPath, [...sourceParts, safeName], agentPrefix, [...relativeParts, safeName]);
          } catch (error) {
            throwIfAborted(signal);
            result.complete = false;
            result.deletionSafe = false;
            result.errors.push({ ...sanitizeError(error), path: sourceId([...sourceParts, safeName]).slice(0, 300) });
          }
        }
        continue;
      }
      if (!entry.isFile()) {
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ code: "UNCONFIRMED_ENTRY", message: "发现无法确认的文件类型，本轮已禁止删除。" });
        continue;
      }
      result.scannedFiles += 1;
      const id = sourceId([...sourceParts, safeName]);
      result.present.add(id);
      if (!agentPrefix) continue;
      if (IGNORED_FILES.has(entry.name)) { result.ignored.unsupported += 1; continue; }
      const extension = path.extname(entry.name).toLowerCase();
      if (!config.allowedExtensions.has(extension)) { result.ignored.unsupported += 1; continue; }
      let info;
      let realPath;
      try {
        await verifyAnchorChain(anchors);
        info = await fs.lstat(absolutePath);
        realPath = await fs.realpath(absolutePath);
        await verifyAnchorChain(anchors);
        if (!insideRoot(agentRootRealPath, realPath)) throw unsafeSource("文件解析后超出智能体根目录。", "SOURCE_ESCAPE");
      } catch (error) {
        throwIfAborted(signal);
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ ...sanitizeError(error), path: id.slice(0, 300) });
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink()) {
        result.ignored.symlinks += 1;
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ code: "SYMLINK_SKIPPED", message: "发现符号链接或文件类型发生变化，本轮已禁止删除。" });
        continue;
      }
      if (info.size > config.maxFileBytes) { result.ignored.tooLarge += 1; continue; }
      if (config.stableMs > 0 && now - info.mtimeMs < config.stableMs) { result.ignored.unstable += 1; continue; }
      const keyParts = [...relativeParts, safeName];
      result.files.push({
        id,
        absolutePath,
        realPath,
        fileIdentity: fileIdentity(info),
        anchors,
        agentRootRealPath,
        sourceRelative: id,
        agentDirectory: sourceParts[0],
        agentPrefix,
        key: objectKey(config, agentPrefix, keyParts),
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
    }
  };

  const topNormalizationCollisions = siblingNormalizationCollisions(topEntries);
  recordNormalizationCollisions(result, topNormalizationCollisions);
  topEntries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const agentDirectories = [];
  for (const entry of topEntries) {
    if (topNormalizationCollisions.names.has(entry.name)) continue;
    let directoryName;
    try { directoryName = validateObjectSegment(entry.name, "智能体一级目录名"); } catch (error) {
      result.complete = false;
      result.errors.push(sanitizeError(error));
      continue;
    }
    if (entry.isSymbolicLink()) {
      result.ignored.symlinks += 1;
      result.complete = false;
      result.deletionSafe = false;
      result.errors.push({ code: "SYMLINK_SKIPPED", message: "发现一级符号链接目录，本轮已禁止删除。" });
      continue;
    }
    if (!entry.isDirectory()) {
      if (entry.isFile()) result.ignored.rootFiles += 1;
      else {
        result.complete = false;
        result.deletionSafe = false;
        result.errors.push({ code: "UNCONFIRMED_ENTRY", message: "发现无法确认的一级文件类型，本轮已禁止删除。" });
      }
      continue;
    }
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    result.rootDirectories += 1;
    const mapped = Object.hasOwn(config.agentMap, directoryName) ? config.agentMap[directoryName] : null;
    const agentPrefix = mapped || (config.requireAgentMap ? null : directoryName);
    if (!agentPrefix) result.ignored.unmappedAgents += 1;
    agentDirectories.push({ entry, directoryName, agentPrefix });
  }
  const prefixOwners = new Map();
  for (const item of agentDirectories) {
    if (!item.agentPrefix) continue;
    const prefixKey = canonicalObjectPrefixKey(item.agentPrefix);
    const owners = prefixOwners.get(prefixKey) || [];
    owners.push(item.directoryName);
    prefixOwners.set(prefixKey, owners);
    item.prefixKey = prefixKey;
  }
  for (const item of agentDirectories) {
    let safePrefix = item.agentPrefix;
    if (safePrefix && prefixOwners.get(item.prefixKey).length > 1) {
      safePrefix = null;
      result.complete = false;
      result.deletionSafe = false;
      result.ignored.prefixCollisions += 1;
      result.errors.push({ code: "PREFIX_COLLISION", message: `一级目录 ${item.directoryName} 的对象前缀与其它智能体冲突。` });
    }
    try {
      await verifyAnchorChain(root.anchors);
      const agentAnchor = await captureDirectoryAnchor(path.join(root.rootRealPath, item.entry.name), root.rootRealPath);
      result.deletionAnchors.push(agentAnchor);
      await verifyAnchorChain(root.anchors);
      await walk(agentAnchor, [...root.anchors, agentAnchor], agentAnchor.realPath, [item.directoryName], safePrefix, []);
    } catch (error) {
      throwIfAborted(signal);
      result.complete = false;
      result.deletionSafe = false;
      result.errors.push({ ...sanitizeError(error), path: item.directoryName.slice(0, 300) });
    }
  }
  if (result.rootDirectories === 0) result.deletionSafe = false;
  return result;
}

export async function verifyCurrentFile(file) {
  await verifyAnchorChain(file.anchors);
  const info = await fs.lstat(file.absolutePath);
  if (info.isSymbolicLink() || !info.isFile() || fileIdentity(info) !== file.fileIdentity) {
    throw unsafeSource("已扫描文件被替换。", "SOURCE_PATH_CHANGED");
  }
  const realPath = await fs.realpath(file.absolutePath);
  if (!samePath(realPath, file.realPath) || !insideRoot(file.agentRootRealPath, realPath)) {
    throw unsafeSource("文件解析目标改变或超出智能体根目录。", "SOURCE_ESCAPE");
  }
  await verifyAnchorChain(file.anchors);
  return info;
}

export async function readStableFile(file, config, options = {}) {
  options.signal?.throwIfAborted?.();
  await verifyCurrentFile(file);
  const noFollow = constants.O_NOFOLLOW || 0;
  const handle = await fs.open(file.absolutePath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || fileIdentity(before) !== file.fileIdentity || before.size !== file.size || before.mtimeMs !== file.mtimeMs) {
      throw Object.assign(new Error("文件在扫描后发生变化，留待下一轮处理。"), { code: "SOURCE_CHANGED" });
    }
    if (process.platform === "linux") {
      let openedPath;
      try { openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`); } catch {
        throw unsafeSource("无法验证已打开文件句柄的真实路径。", "SOURCE_HANDLE_UNVERIFIED");
      }
      if (!samePath(openedPath, file.realPath) || !insideRoot(file.agentRootRealPath, openedPath)) {
        throw unsafeSource("已打开文件句柄超出智能体根目录。", "SOURCE_ESCAPE");
      }
    }
    await verifyAnchorChain(file.anchors);
    if (before.size > config.maxFileBytes) throw Object.assign(new Error("文件超过同步大小上限。"), { code: "FILE_TOO_LARGE" });
    const body = await handle.readFile({ signal: options.signal });
    options.signal?.throwIfAborted?.();
    const after = await handle.stat();
    if (fileIdentity(after) !== file.fileIdentity || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw Object.assign(new Error("文件读取期间发生变化，留待下一轮处理。"), { code: "SOURCE_CHANGED" });
    }
    await verifyCurrentFile(file);
    return { body, sha256: createHash("sha256").update(body).digest("hex") };
  } finally {
    await handle.close();
  }
}

function invalidManagedState() {
  return Object.assign(new Error("状态清单包含无效或越出受管前缀的对象记录；禁止连接对象存储，请人工核验清单或使用新的状态目录。"), {
    code: "STATE_MANIFEST_INVALID",
  });
}

function validateStatePath(value, label, { minimumSegments = 1 } = {}) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 4096
    || value.startsWith("/") || value.endsWith("/")) throw invalidManagedState();
  const parts = value.split("/");
  if (parts.length < minimumSegments) throw invalidManagedState();
  try {
    for (const part of parts) if (validateObjectSegment(part, label) !== part) throw invalidManagedState();
  } catch (error) {
    if (error?.code === "STATE_MANIFEST_INVALID") throw error;
    throw invalidManagedState();
  }
  return parts;
}

function validateManagedKey(key, config) {
  const parts = validateStatePath(key, "状态清单对象键", { minimumSegments: 2 });
  if (Buffer.byteLength(key, "utf8") > 1024 || !key.startsWith(`${config.basePrefix}/`)
    || key === config.basePrefix || parts.slice(0, config.basePrefix.split("/").length).join("/") !== config.basePrefix) {
    throw invalidManagedState();
  }
  return key;
}

function validateManagedRecords(config, state) {
  const activeKeys = new Set();
  const reservedKeys = new Set();
  for (const [recordId, record] of Object.entries(state.files)) {
    const sourceParts = validateStatePath(recordId, "状态清单源路径", { minimumSegments: 2 });
    if (!record || typeof record !== "object" || Array.isArray(record) || record.sourceRelative !== recordId
      || record.agentDirectory !== sourceParts[0] || typeof record.agentPrefix !== "string") throw invalidManagedState();
    let agentPrefix;
    try { agentPrefix = validateObjectSegment(record.agentPrefix, "状态清单智能体前缀"); }
    catch { throw invalidManagedState(); }
    if (agentPrefix !== record.agentPrefix) throw invalidManagedState();
    const key = validateManagedKey(record.key, config);
    if (key !== objectKey(config, agentPrefix, sourceParts.slice(1)) || activeKeys.has(key)) throw invalidManagedState();
    activeKeys.add(key);
    reservedKeys.add(key);
    if (record.pending !== undefined) {
      const pending = record.pending;
      if (!pending || typeof pending !== "object" || Array.isArray(pending) || typeof pending.agentPrefix !== "string") throw invalidManagedState();
      let pendingPrefix;
      try { pendingPrefix = validateObjectSegment(pending.agentPrefix, "状态清单待迁移前缀"); }
      catch { throw invalidManagedState(); }
      const pendingKey = validateManagedKey(pending.key, config);
      if (pendingPrefix !== pending.agentPrefix || pendingKey !== objectKey(config, pendingPrefix, sourceParts.slice(1))
        || reservedKeys.has(pendingKey)) throw invalidManagedState();
      reservedKeys.add(pendingKey);
    }
  }
  const orphanKeys = new Set();
  for (const key of state.orphanedKeys) {
    validateManagedKey(key, config);
    if (reservedKeys.has(key) || orphanKeys.has(key)) throw invalidManagedState();
    orphanKeys.add(key);
  }
}

export async function loadAndValidateState(config, suppliedState) {
  const state = suppliedState || await loadState(config);
  if (!state || typeof state !== "object" || Array.isArray(state) || ![1, 2].includes(state.version)
    || !state.files || typeof state.files !== "object" || Array.isArray(state.files)
    || !Array.isArray(state.orphanedKeys)) throw invalidManagedState();
  if (state.bucket !== config.bucket || state.sourceRoot !== config.sourceRoot) {
    throw Object.assign(new Error("状态清单与当前 sourceRoot/bucket 不一致；请人工迁移或使用新的状态目录。"), {
      code: "STATE_STORE_IDENTITY_MISMATCH",
    });
  }
  const managedStateExists = Object.keys(state.files || {}).length > 0 || (state.orphanedKeys || []).length > 0;
  if (!state.storeIdentity) {
    if (managedStateExists) {
      throw Object.assign(new Error("旧状态清单尚未绑定 MinIO/S3 命名空间；请人工核验后迁移或使用新的状态目录，禁止自动沿用受管对象记录。"), {
        code: "STATE_STORE_IDENTITY_MISMATCH",
      });
    }
    state.storeIdentity = config.storeIdentity;
  } else if (state.storeIdentity !== config.storeIdentity) {
    throw Object.assign(new Error("状态清单与当前 MinIO/S3 命名空间不一致；禁止读取旧清单执行覆盖或删除，请人工迁移或使用新的状态目录。"), {
      code: "STATE_STORE_IDENTITY_MISMATCH",
    });
  }
  if (state.basePrefix === undefined && !managedStateExists) state.basePrefix = config.basePrefix;
  if (state.basePrefix !== config.basePrefix || !config.basePrefix) throw Object.assign(
    new Error("状态清单与当前受管对象前缀不一致；请人工迁移或使用新的状态目录。"),
    { code: "STATE_STORE_IDENTITY_MISMATCH" },
  );
  validateManagedRecords(config, state);
  state.version = 2;
  return state;
}

async function retry(operation, config, sleep, signal, onProgress = () => {}) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    onProgress();
    try { return { value: await operation(attempt), attempts: attempt }; } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      if (attempt < config.maxAttempts) {
        await sleep(Math.min(config.retryBaseMs * 2 ** (attempt - 1), 60_000));
        throwIfAborted(signal);
        onProgress();
      }
    }
  }
  const finalError = lastError instanceof Error ? lastError : new Error("S3 操作失败。");
  finalError.attempts = config.maxAttempts;
  throw finalError;
}

function syncedRecord(file, loaded, remote, nowIso, previous = {}) {
  return {
    ...previous,
    sourceRelative: file.sourceRelative,
    agentDirectory: file.agentDirectory,
    agentPrefix: file.agentPrefix,
    key: file.key,
    size: file.size,
    mtimeMs: file.mtimeMs,
    sha256: loaded.sha256,
    etag: remote?.etag || previous.etag || "",
    status: "synced",
    attempts: 0,
    lastError: null,
    pending: undefined,
    lastSyncedAt: previous.key === file.key && previous.sha256 === loaded.sha256 ? previous.lastSyncedAt || nowIso : nowIso,
    lastVerifiedAt: nowIso,
    lastHashedAt: nowIso,
  };
}

function commitSyncedRecord(state, file, record, previous) {
  state.orphanedKeys = state.orphanedKeys.filter((key) => key !== file.key);
  if (previous?.key && previous.key !== file.key && !state.orphanedKeys.includes(previous.key)) state.orphanedKeys.push(previous.key);
  state.files[file.id] = record;
}

async function verifyDeletionAnchors(scan) {
  const seen = new Set();
  for (const anchor of scan.deletionAnchors || []) {
    const key = `${anchor.absolutePath}\u0000${anchor.identity}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await verifyDirectoryAnchor(anchor);
  }
}

function failedRecord(previous, file, safe, error, nowIso) {
  const failure = {
    status: previous?.key && previous.key !== file.key ? "migration-error" : "error",
    attempts: Number(error?.attempts || 1),
    lastError: safe,
    lastAttemptAt: nowIso,
  };
  if (previous?.key && previous.key !== file.key) {
    return {
      ...previous,
      ...failure,
      pending: { key: file.key, size: file.size, mtimeMs: file.mtimeMs, agentPrefix: file.agentPrefix },
    };
  }
  return {
    ...previous,
    sourceRelative: file.sourceRelative,
    agentDirectory: file.agentDirectory,
    agentPrefix: file.agentPrefix,
    key: file.key,
    size: file.size,
    mtimeMs: file.mtimeMs,
    ...failure,
  };
}

export async function runSyncOnce(config, objectStore, options = {}) {
  const now = options.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const signal = options.signal;
  const progress = () => {
    throwIfAborted(signal);
    options.onProgress?.();
  };
  progress();
  const state = await loadAndValidateState(config, options.state);
  const scan = await scanSource(config, { now, onProgress: progress, signal });
  if (state.sourceIdentity && scan.sourceIdentity && state.sourceIdentity !== scan.sourceIdentity) scan.deletionSafe = false;
  if (!state.sourceIdentity && scan.sourceIdentity) state.sourceIdentity = scan.sourceIdentity;

  const summary = {
    startedAt: nowIso,
    completedAt: null,
    dryRun: config.dryRun,
    scanComplete: scan.complete,
    deletionSafe: scan.deletionSafe,
    scannedFiles: scan.scannedFiles,
    eligibleFiles: scan.files.length,
    uploaded: 0,
    deduplicated: 0,
    skipped: 0,
    verified: 0,
    rehashed: 0,
    plannedUploads: 0,
    plannedChecks: 0,
    deleted: 0,
    retainedMissing: 0,
    plannedDeletes: 0,
    deferred: 0,
    failed: 0,
    operationTimeouts: 0,
    retries: 0,
    ignored: scan.ignored,
    scanErrors: scan.errors,
  };
  let actions = 0;
  let checkpointChanges = 0;
  const checkpoint = async () => {
    checkpointChanges += 1;
    if (!config.dryRun && checkpointChanges >= config.checkpointEvery) {
      checkpointChanges = 0;
      await saveState(config, state);
    }
  };

  for (const file of scan.files) {
    progress();
    const previous = state.files[file.id];
    const fingerprintSame = previous?.status === "synced" && sameFingerprint(previous, file);
    const verificationDue = fingerprintSame && timestampDue(previous.lastVerifiedAt, config.verifyAfterMs, now);
    const rehashDue = fingerprintSame && timestampDue(previous.lastHashedAt, config.rehashAfterMs, now);
    if (fingerprintSame && !verificationDue && !rehashDue) {
      summary.skipped += 1;
      continue;
    }
    if (actions >= config.maxFilesPerRun) { summary.deferred += 1; continue; }
    actions += 1;
    if (config.dryRun) {
      if (fingerprintSame && rehashDue) {
        try {
          const loaded = await readStableFile(file, config, { signal });
          summary.rehashed += 1;
          if (loaded.sha256 === previous.sha256) summary.plannedChecks += 1;
          else summary.plannedUploads += 1;
        } catch (error) {
          throwIfAborted(signal);
          summary.failed += 1;
          summary.scanErrors.push(sanitizeError(error));
        }
      } else if (fingerprintSame) summary.plannedChecks += 1;
      else summary.plannedUploads += 1;
      continue;
    }
    try {
      let loaded;
      let checkedRemote;
      let contentStillMatches = fingerprintSame;
      if (fingerprintSame && rehashDue) {
        loaded = await readStableFile(file, config, { signal });
        summary.rehashed += 1;
        previous.lastHashedAt = nowIso;
        contentStillMatches = loaded.sha256 === previous.sha256;
        if (contentStillMatches && !verificationDue) {
          await checkpoint();
          continue;
        }
      }
      if (fingerprintSame && contentStillMatches && verificationDue) {
        const checked = await retry(() => objectStore.head(file.key, { signal }), config, sleep, signal, progress);
        summary.retries += checked.attempts - 1;
        checkedRemote = checked.value;
        if (remoteMatches(checked.value, file.size, previous.sha256)) {
          previous.lastVerifiedAt = nowIso;
          previous.etag = checked.value.etag || previous.etag;
          summary.verified += 1;
          await checkpoint();
          continue;
        }
      }

      loaded ||= await readStableFile(file, config, { signal });
      let remote = checkedRemote;
      if (remote === undefined) {
        const checked = await retry(() => objectStore.head(file.key, { signal }), config, sleep, signal, progress);
        summary.retries += checked.attempts - 1;
        remote = checked.value;
      }
      if (remoteMatches(remote, file.size, loaded.sha256)) {
        commitSyncedRecord(state, file, syncedRecord(file, loaded, remote, nowIso, previous), previous);
        summary.deduplicated += 1;
      } else {
        const uploaded = await retry(async () => {
          await objectStore.put({ key: file.key, body: loaded.body, size: file.size, sha256: loaded.sha256, mtimeMs: file.mtimeMs }, { signal });
          const head = await objectStore.head(file.key, { signal });
          if (!remoteMatches(head, file.size, loaded.sha256)) throw Object.assign(new Error("上传后校验不一致。"), { code: "VERIFY_FAILED" });
          return head;
        }, config, sleep, signal, progress);
        summary.retries += uploaded.attempts - 1;
        remote = uploaded.value;
        const after = await verifyCurrentFile(file);
        if (after.size !== file.size || after.mtimeMs !== file.mtimeMs) throw Object.assign(new Error("上传期间源文件发生变化，下一轮将重新同步。"), { code: "SOURCE_CHANGED_AFTER_UPLOAD" });
        commitSyncedRecord(state, file, syncedRecord(file, loaded, remote, nowIso, previous), previous);
        summary.uploaded += 1;
      }
      await checkpoint();
    } catch (error) {
      throwIfAborted(signal);
      const safe = sanitizeError(error);
      summary.failed += 1;
      if (error?.code === "S3_OPERATION_TIMEOUT") summary.operationTimeouts += 1;
      summary.retries += Math.max(0, Number(error?.attempts || 1) - 1);
      state.files[file.id] = failedRecord(previous, file, safe, error, nowIso);
      await checkpoint();
    }
  }

  if (config.deleteRemote && scan.complete && scan.deletionSafe) {
    try {
      progress();
      await verifyDeletionAnchors(scan);
    } catch (error) {
      throwIfAborted(signal);
      scan.complete = false;
      scan.deletionSafe = false;
      scan.errors.push(sanitizeError(error));
    }
  }
  summary.scanComplete = scan.complete;
  summary.deletionSafe = scan.deletionSafe;
  let mayDelete = config.deleteRemote && scan.complete && scan.deletionSafe;
  for (const [id, record] of Object.entries(state.files)) {
    progress();
    if (scan.present.has(id)) continue;
    if (!mayDelete) {
      summary.retainedMissing += 1;
      if (!config.dryRun) record.status = "source-missing-retained";
      continue;
    }
    if (config.dryRun) { summary.plannedDeletes += 1; continue; }
    try {
      await verifyDeletionAnchors(scan);
      const removed = await retry(() => objectStore.remove(record.key, { signal }), config, sleep, signal, progress);
      summary.retries += removed.attempts - 1;
      delete state.files[id];
      summary.deleted += 1;
      await checkpoint();
    } catch (error) {
      throwIfAborted(signal);
      if (error?.code?.startsWith?.("SOURCE_")) {
        mayDelete = false;
        summary.deletionSafe = false;
        summary.scanComplete = false;
        summary.scanErrors.push(sanitizeError(error));
      }
      summary.failed += 1;
      if (error?.code === "S3_OPERATION_TIMEOUT") summary.operationTimeouts += 1;
      record.status = "delete-error";
      record.lastError = sanitizeError(error);
      record.lastAttemptAt = nowIso;
      await checkpoint();
    }
  }

  if (mayDelete && !config.dryRun && state.orphanedKeys.length) {
    const remaining = [];
    for (const key of state.orphanedKeys) {
      progress();
      try {
        await verifyDeletionAnchors(scan);
        const removed = await retry(() => objectStore.remove(key, { signal }), config, sleep, signal, progress);
        summary.retries += removed.attempts - 1;
        summary.deleted += 1;
      } catch (error) {
        throwIfAborted(signal);
        if (error?.code?.startsWith?.("SOURCE_")) {
          mayDelete = false;
          summary.deletionSafe = false;
          summary.scanComplete = false;
        }
        summary.failed += 1;
        if (error?.code === "S3_OPERATION_TIMEOUT") summary.operationTimeouts += 1;
        remaining.push(key);
        if (!mayDelete) remaining.push(...state.orphanedKeys.slice(state.orphanedKeys.indexOf(key) + 1));
        if (!mayDelete) break;
      }
    }
    state.orphanedKeys = remaining;
  }

  summary.completedAt = new Date(options.completedAt ?? Date.now()).toISOString();
  state.basePrefix = config.basePrefix;
  state.lastRun = summary;
  if (!config.dryRun) await saveState(config, state);
  return { summary, state, scan };
}
