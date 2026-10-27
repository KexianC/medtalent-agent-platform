import { isUsableProviderCredential } from "./output-safety.mjs";
import { mysqlSslMode, mysqlTlsEnabled } from "./mysql-ssl-policy.mjs";

const MODEL_URL_FIELDS = ["AI_API_URL", "AI_API_BASE", "DEEPSEEK_API_BASE", "EMBEDDING_API_URL"];
const PROVIDER_CREDENTIAL_FIELDS = ["AI_API_KEY", "DEEPSEEK_API_KEY", "EMBEDDING_API_KEY", "DASHSCOPE_API_KEY"];

export class RuntimeConfigError extends Error {
  constructor(field, message) {
    super(`${field}：${message}`);
    this.name = "RuntimeConfigError";
    this.code = "INVALID_RUNTIME_CONFIG";
    this.field = field;
  }
}

function validateInteger(env, field, minimum, maximum) {
  const value = env[field];
  if (value === undefined) return;
  const wellFormed = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()));
  const number = wellFormed ? Number(value) : NaN;
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < minimum || number > maximum) {
    throw new RuntimeConfigError(field, `必须是 ${minimum} 至 ${maximum} 范围内的有限整数。`);
  }
}

function validateUrl(value, field, { originOnly = false, httpsOnly = false } = {}) {
  // Reject normalization surprises (including backslash separators and whitespace)
  // because downstream consumers receive the original environment value.
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/u.test(value)) {
    throw new RuntimeConfigError(field, "必须是格式正确、不含空白字符的绝对 HTTP(S) 地址。");
  }
  const match = value.match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
  let url;
  try { url = new URL(value); } catch { /* Only field-level errors are exposed below. */ }
  if (!match || !url || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.origin === "null") {
    throw new RuntimeConfigError(field, "必须是有效的绝对 HTTP(S) 地址。");
  }
  if (match[1].includes("@") || url.username || url.password) {
    throw new RuntimeConfigError(field, "地址中不能包含用户名或密码，请使用独立的服务端凭据变量。");
  }
  if (value.includes("#")) throw new RuntimeConfigError(field, "地址中不能包含片段标记（#）。");
  if (originOnly && (value.includes("?") || !["", "/"].includes(match[2]) || url.pathname !== "/")) {
    throw new RuntimeConfigError(field, "只能填写站点 Origin（协议、主机和可选端口），不能包含查询参数或非根路径。");
  }
  if (httpsOnly && url.protocol !== "https:") throw new RuntimeConfigError(field, "生产环境必须使用 HTTPS 站点 Origin。");
}

function validateDatabaseConfig(env, production) {
  try { mysqlSslMode(env); }
  catch { throw new RuntimeConfigError("MYSQL_SSL_MODE", "必须为空、required 或 disabled。"); }
  const value = env.DATABASE_URL;
  if (value === undefined || value === "") return;
  if (typeof value !== "string" || /[\\\u0000-\u0020\u007f]/u.test(value)) {
    throw new RuntimeConfigError("DATABASE_URL", "必须是格式正确、不含空白字符的 MySQL 连接地址。");
  }
  let url;
  try { url = new URL(value); } catch { /* Only field-level errors are exposed below. */ }
  const databaseName = url?.pathname?.slice(1);
  if (!url || url.protocol !== "mysql:" || !url.hostname || !url.username || !url.password
    || !databaseName || databaseName.includes("/") || url.search || url.hash) {
    throw new RuntimeConfigError("DATABASE_URL", "必须包含 MySQL 主机、账号、密码和单一数据库名，且不能包含查询参数或片段。");
  }
  const caFile = env.MYSQL_SSL_CA_FILE;
  if (mysqlTlsEnabled(env, url.hostname)) {
    if (typeof caFile !== "string" || !caFile.trim() || /[\u0000-\u001f\u007f]/u.test(caFile)) {
      throw new RuntimeConfigError("MYSQL_SSL_CA_FILE", "MySQL TLS 连接必须配置用于校验服务端身份的 CA 证书文件。");
    }
    if (production && !/^(?:[A-Za-z]:[\\/]|\/)/u.test(caFile)) {
      throw new RuntimeConfigError("MYSQL_SSL_CA_FILE", "生产环境必须使用绝对证书路径。");
    }
  }
}

/**
 * Validate before opening a database or starting listeners. This function does
 * not mutate env and deliberately permits absent model/NAS configuration.
 * Error messages never interpolate values (URLs may accidentally contain keys).
 */
export function validateRuntimeConfig(env = process.env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new RuntimeConfigError("ENV", "启动环境配置必须是键值对象。");
  validateInteger(env, "SESSION_HOURS", 1, 72);
  validateInteger(env, "PORT", 1, 65535);
  if (env.EMBEDDING_DIMENSIONS !== undefined && env.EMBEDDING_DIMENSIONS !== "") validateInteger(env, "EMBEDDING_DIMENSIONS", 1, 16_384);
  if (env.EMBEDDING_BATCH_SIZE !== undefined && env.EMBEDDING_BATCH_SIZE !== "") validateInteger(env, "EMBEDDING_BATCH_SIZE", 1, 20);
  if (env.EMBEDDING_MAX_RETRIES !== undefined && env.EMBEDDING_MAX_RETRIES !== "") validateInteger(env, "EMBEDDING_MAX_RETRIES", 0, 5);
  if (env.EMBEDDING_SEGMENT_CHARACTERS !== undefined && env.EMBEDDING_SEGMENT_CHARACTERS !== "") validateInteger(env, "EMBEDDING_SEGMENT_CHARACTERS", 64, 16_000);
  if (env.EMBEDDING_API_PROTOCOL !== undefined && env.EMBEDDING_API_PROTOCOL !== "" && !["openai", "dashscope"].includes(env.EMBEDDING_API_PROTOCOL)) {
    throw new RuntimeConfigError("EMBEDDING_API_PROTOCOL", "必须是 openai 或 dashscope。");
  }
  const production = env.NODE_ENV === "production";
  validateDatabaseConfig(env, production);
  const publicUrl = env.PUBLIC_URL;
  if (publicUrl === undefined || publicUrl === "") {
    if (production) throw new RuntimeConfigError("PUBLIC_URL", "生产环境必须配置非空的 HTTPS 站点 Origin。");
  } else {
    validateUrl(publicUrl, "PUBLIC_URL", { originOnly: true, httpsOnly: production });
  }
  for (const field of MODEL_URL_FIELDS) {
    if (env[field] === undefined || env[field] === "") continue;
    validateUrl(env[field], field);
  }
  for (const field of PROVIDER_CREDENTIAL_FIELDS) {
    if (env[field] === undefined || env[field] === "") continue;
    if (!isUsableProviderCredential(env[field])) {
      throw new RuntimeConfigError(field, "必须是 8 至 8192 位、不含空白或控制字符的可打印 ASCII 服务端凭据。");
    }
  }
}
