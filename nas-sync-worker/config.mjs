import path from "node:path";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

export const DEFAULT_DOCUMENT_EXTENSIONS = Object.freeze([
  ".pdf", ".docx", ".txt", ".md", ".markdown", ".csv", ".html", ".htm", ".json",
]);

const DELETE_CONFIRMATION = "DELETE_MISSING_MANAGED_OBJECTS";
const SAFE_SEGMENT = /^(?!\.{1,2}$)[^/\\\u0000-\u001f\u007f]+$/u;

function booleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error(`布尔配置值无效：${String(value).slice(0, 20)}`);
}

function integerValue(value, fallback, name, minimum, maximum) {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return parsed;
}

export function validateObjectSegment(value, label = "对象路径段") {
  const segment = String(value || "").normalize("NFC");
  if (segment !== segment.trim()) throw new Error(`${label}不能以空白字符开头或结尾。`);
  if (!segment || !SAFE_SEGMENT.test(segment)) throw new Error(`${label}包含空值、控制字符或不安全路径字符。`);
  return segment;
}

export function canonicalObjectPrefixKey(value) {
  return validateObjectSegment(value, "智能体对象前缀").toLowerCase();
}

export function normalizeS3Prefix(value = "") {
  const raw = String(value || "").normalize("NFC").replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  return raw.split("/").map((part) => validateObjectSegment(part, "NAS_S3_PREFIX")).join("/");
}

function parseExtensions(value) {
  const items = value ? String(value).split(",") : DEFAULT_DOCUMENT_EXTENSIONS;
  const extensions = new Set(items.map((item) => {
    const normalized = item.trim().toLowerCase();
    if (!/^\.[a-z0-9]{1,12}$/.test(normalized)) throw new Error("NAS_TO_S3_ALLOWED_EXTENSIONS 包含无效扩展名。");
    return normalized;
  }));
  if (!extensions.size) throw new Error("至少需要一个允许同步的扩展名。");
  return extensions;
}

async function loadAgentMap(filePath) {
  if (!filePath) return {};
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("智能体目录映射必须是 JSON 对象。");
  const result = {};
  const sourceOwners = new Map();
  const targetOwners = new Map();
  for (const [directory, prefix] of Object.entries(parsed)) {
    const source = validateObjectSegment(directory, "智能体源目录名");
    const target = validateObjectSegment(prefix, `智能体目录 ${source} 的目标前缀`);
    if (sourceOwners.has(source)) throw new Error("智能体源目录名存在 Unicode 规范化碰撞。");
    sourceOwners.set(source, directory);
    const targetKey = canonicalObjectPrefixKey(target);
    const existing = targetOwners.get(targetKey);
    if (existing && existing.source !== source) {
      if (existing.target === target) throw new Error(`多个智能体目录不能映射到同一目标前缀：${target}`);
      throw new Error("多个智能体目录的目标前缀不能仅以大小写或 Unicode 规范化区分。");
    }
    targetOwners.set(targetKey, { source, target });
    result[source] = target;
  }
  return result;
}

function validateEndpoint(raw, required) {
  if (!raw && !required) return "";
  if (!raw) throw new Error("缺少 NAS_S3_ENDPOINT。");
  let endpoint;
  try { endpoint = new URL(raw); } catch { throw new Error("NAS_S3_ENDPOINT 必须是绝对 HTTP(S) 地址。"); }
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("NAS_S3_ENDPOINT 必须是无用户信息、查询参数和片段的 HTTP(S) 地址。");
  }
  return endpoint.toString().replace(/\/$/, "");
}

function storeIdentity({ endpoint, region, bucket, basePrefix, storeId, accessKeyId, dryRun }) {
  const namespace = storeId || (accessKeyId
    ? `access-key:${createHash("sha256").update(accessKeyId).digest("hex")}`
    : dryRun ? "offline-dry-run" : "missing");
  return createHash("sha256").update(JSON.stringify({ version: 1, endpoint, region, bucket, basePrefix, namespace })).digest("hex");
}

export async function loadWorkerConfig(env = process.env, flags = {}) {
  const dryRun = flags.dryRun ?? booleanValue(env.NAS_TO_S3_DRY_RUN, false);
  const once = flags.once ?? booleanValue(env.NAS_TO_S3_ONCE, false);
  const sourceRoot = path.resolve(env.NAS_TO_S3_SOURCE_ROOT || "/nas/knowledge");
  const stateDir = path.resolve(env.NAS_TO_S3_STATE_DIR || "/state");
  const mapPath = env.NAS_TO_S3_AGENT_MAP_FILE ? path.resolve(env.NAS_TO_S3_AGENT_MAP_FILE) : "";
  const agentMap = await loadAgentMap(mapPath);
  const requireAgentMap = booleanValue(env.NAS_TO_S3_REQUIRE_AGENT_MAP, false);
  const deleteRemote = booleanValue(env.NAS_TO_S3_DELETE_REMOTE, false);
  if (deleteRemote && env.NAS_TO_S3_DELETE_CONFIRM !== DELETE_CONFIRMATION) {
    throw new Error(`远端删除还需要 NAS_TO_S3_DELETE_CONFIRM=${DELETE_CONFIRMATION}。`);
  }

  const bucket = String(env.NAS_S3_BUCKET || "agent-knowledge").trim();
  if (!/^(?=.{3,63}$)(?!\d+\.\d+\.\d+\.\d+$)[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error("NAS_S3_BUCKET 不是有效的 S3 bucket 名称。");
  }
  const endpoint = validateEndpoint(env.NAS_S3_ENDPOINT, !dryRun);
  const region = String(env.NAS_S3_REGION || "us-east-1").trim();
  const basePrefix = normalizeS3Prefix(env.NAS_S3_PREFIX || "knowledge");
  if (!basePrefix) throw new Error("NAS_S3_PREFIX 必须是非空的专用受管前缀，不能把整个 bucket 根交给 Worker。");
  const accessKeyId = String(env.NAS_S3_ACCESS_KEY_ID || "");
  const secretAccessKey = String(env.NAS_S3_SECRET_ACCESS_KEY || "");
  if (!dryRun && (!accessKeyId || !secretAccessKey)) throw new Error("缺少 NAS S3 访问凭据；凭据只能通过环境变量注入。");
  const storeId = String(env.NAS_TO_S3_STORE_ID || "").trim();
  if (storeId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(storeId)) {
    throw new Error("NAS_TO_S3_STORE_ID 必须是 3—128 位稳定的字母、数字、点、下划线、冒号或连字符标识。");
  }
  if (deleteRemote && !storeId) {
    throw new Error("启用远端删除必须设置稳定的 NAS_TO_S3_STORE_ID，以把状态清单绑定到明确的 MinIO/S3 命名空间。");
  }
  const healthHost = String(env.NAS_TO_S3_HEALTH_HOST || "127.0.0.1");
  if (!isIP(healthHost)) throw new Error("NAS_TO_S3_HEALTH_HOST 必须是明确的 IPv4 或 IPv6 地址。");
  const connectionTimeoutMs = integerValue(env.NAS_TO_S3_CONNECTION_TIMEOUT_MS, 3_000, "NAS_TO_S3_CONNECTION_TIMEOUT_MS", 100, 60_000);
  const requestTimeoutMs = integerValue(env.NAS_TO_S3_REQUEST_TIMEOUT_MS, 30_000, "NAS_TO_S3_REQUEST_TIMEOUT_MS", 1_000, 300_000);
  const socketTimeoutMs = integerValue(env.NAS_TO_S3_SOCKET_TIMEOUT_MS, 30_000, "NAS_TO_S3_SOCKET_TIMEOUT_MS", 1_000, 300_000);
  const operationTimeoutMs = integerValue(env.NAS_TO_S3_OPERATION_TIMEOUT_MS, 45_000, "NAS_TO_S3_OPERATION_TIMEOUT_MS", 1_000, 600_000);
  const healthStallMs = integerValue(env.NAS_TO_S3_HEALTH_STALL_SECONDS, 90, "NAS_TO_S3_HEALTH_STALL_SECONDS", 5, 3600) * 1000;
  if (healthStallMs <= operationTimeoutMs) throw new Error("NAS_TO_S3_HEALTH_STALL_SECONDS 必须大于单次 S3 操作 deadline。");

  return Object.freeze({
    sourceRoot,
    stateDir,
    statePath: path.join(stateDir, "manifest.json"),
    mapPath,
    agentMap,
    requireAgentMap,
    dryRun,
    once,
    deleteRemote,
    endpoint,
    region,
    bucket,
    storeIdentity: storeIdentity({ endpoint, region, bucket, basePrefix, storeId, accessKeyId, dryRun }),
    basePrefix,
    forcePathStyle: booleanValue(env.NAS_S3_FORCE_PATH_STYLE, true),
    accessKeyId,
    secretAccessKey,
    sessionToken: String(env.NAS_S3_SESSION_TOKEN || ""),
    allowedExtensions: parseExtensions(env.NAS_TO_S3_ALLOWED_EXTENSIONS),
    stableMs: integerValue(env.NAS_TO_S3_STABLE_SECONDS, 30, "NAS_TO_S3_STABLE_SECONDS", 0, 86400) * 1000,
    intervalMs: integerValue(env.NAS_TO_S3_SCAN_INTERVAL_SECONDS, 300, "NAS_TO_S3_SCAN_INTERVAL_SECONDS", 5, 86400) * 1000,
    maxFileBytes: integerValue(env.NAS_TO_S3_MAX_FILE_BYTES, 52_428_800, "NAS_TO_S3_MAX_FILE_BYTES", 1, 52_428_800),
    maxScanFiles: integerValue(env.NAS_TO_S3_MAX_SCAN_FILES, 20_000, "NAS_TO_S3_MAX_SCAN_FILES", 1, 1_000_000),
    maxFilesPerRun: integerValue(env.NAS_TO_S3_MAX_FILES_PER_RUN, 200, "NAS_TO_S3_MAX_FILES_PER_RUN", 1, 10_000),
    maxAttempts: integerValue(env.NAS_TO_S3_MAX_ATTEMPTS, 4, "NAS_TO_S3_MAX_ATTEMPTS", 1, 10),
    retryBaseMs: integerValue(env.NAS_TO_S3_RETRY_BASE_MS, 500, "NAS_TO_S3_RETRY_BASE_MS", 10, 60_000),
    verifyAfterMs: integerValue(env.NAS_TO_S3_VERIFY_AFTER_SECONDS, 86_400, "NAS_TO_S3_VERIFY_AFTER_SECONDS", 60, 2_592_000) * 1000,
    rehashAfterMs: integerValue(env.NAS_TO_S3_REHASH_AFTER_SECONDS, 3_600, "NAS_TO_S3_REHASH_AFTER_SECONDS", 0, 2_592_000) * 1000,
    checkpointEvery: integerValue(env.NAS_TO_S3_CHECKPOINT_EVERY, 10, "NAS_TO_S3_CHECKPOINT_EVERY", 1, 1000),
    connectionTimeoutMs,
    requestTimeoutMs,
    socketTimeoutMs,
    operationTimeoutMs,
    healthStallMs,
    healthHost,
    healthPort: integerValue(env.NAS_TO_S3_HEALTH_PORT, 8790, "NAS_TO_S3_HEALTH_PORT", 1, 65535),
  });
}

export const REMOTE_DELETE_CONFIRMATION = DELETE_CONFIRMATION;
