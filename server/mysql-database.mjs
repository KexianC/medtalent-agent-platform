import {analyticsMysqlStatements,analyticsRow,analyticsEventFromRow,buildAnalyticsQuery,buildAnalyticsRetentionQuery,assertAnalyticsQuerySize,ANALYTICS_QUERY_MAX_EVENTS,analyticsDate} from './analytics-store.mjs';
import { buildAuditQuery } from './audit-query.mjs';
import mysql from "mysql2/promise";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { id, MAX_AGENT_SEARCHABLE_CHUNKS, now, normalizeAgent, PlatformError } from "./domain.mjs";
import { mysqlTlsEnabled } from "./mysql-ssl-policy.mjs";
import { CONSUMER_TABLES, consumerMysqlStatements } from "./consumer-schema.mjs";

const ENTITY_TABLES = new Set(["documents", "sources", "content"]);
const EXHAUSTED_JOB_ERROR = "任务已达到最大重试次数，未继续自动执行。";
const EXHAUSTED_DOCUMENT_ERROR = "文档处理在服务中断后已达到最大重试次数，请检查文件后手动重试。";
const KNOWLEDGE_JOB_TYPES = new Set(["document.ingest", "document.reembed", "nas.sync"]);
export const MYSQL_WRITE_BATCH_MAX_ROWS = 100;
export const MYSQL_WRITE_BATCH_MAX_BYTES = 2 * 1024 * 1024;
const REQUIRED_TABLES = [
  "schema_migrations", "transaction_guards", "meta", "agents", "agent_versions", "documents", "chunks",
  "sources", "content", "jobs", "sync_runs", "users", "sessions", "audit", "usage", "analytics_events",
  ...CONSUMER_TABLES,
];

const parse = (value) => {
  if (!value) return null;
  if (typeof value === "string") return JSON.parse(value);
  if (typeof value === "object") return value;
  return JSON.parse(String(value));
};
const number = (value) => Number(value || 0);

function parameterBytes(value) {
  if (value === null || value === undefined) return 4;
  if (Buffer.isBuffer(value)) return value.length;
  return Buffer.byteLength(typeof value === "string" ? value : String(value), "utf8");
}

function writeBatches(records, parametersForRecord) {
  const batches = [];
  let batch = [];
  let bytes = 0;
  for (const record of records) {
    const recordBytes = parametersForRecord(record).reduce((total, value) => total + parameterBytes(value), 256);
    if (recordBytes > MYSQL_WRITE_BATCH_MAX_BYTES) {
      throw new PlatformError("单条 MySQL 批量写入记录超过安全包大小。", 413, "MYSQL_BATCH_ITEM_TOO_LARGE");
    }
    if (batch.length && (batch.length >= MYSQL_WRITE_BATCH_MAX_ROWS || bytes + recordBytes > MYSQL_WRITE_BATCH_MAX_BYTES)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(record);
    bytes += recordBytes;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function parsedJobPayload(value) {
  try {
    const payload = parse(value);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function ingestJobKey(payload) {
  return typeof payload?.documentId === "string" && typeof payload?.checksum === "string"
    ? `${payload.documentId}\u0000${payload.checksum}` : null;
}

function safeDecode(value, field) {
  try { return decodeURIComponent(value); }
  catch { throw new Error(`MySQL ${field} 编码无效。`); }
}

export function mysqlConnectionOptions({ databaseUrl, connectionOptions: overrides = {}, environment = process.env } = {}) {
  if (typeof databaseUrl !== "string" || !databaseUrl) throw new Error("缺少 MySQL DATABASE_URL。");
  if (/[\\\u0000-\u001f\u007f]/.test(databaseUrl)) throw new Error("MySQL DATABASE_URL 包含不允许的字符。");
  let parsed;
  try { parsed = new URL(databaseUrl); }
  catch { throw new Error("MySQL DATABASE_URL 格式无效。"); }
  if (parsed.protocol !== "mysql:") throw new Error("MySQL DATABASE_URL 必须使用 mysql://。");
  if (parsed.search || parsed.hash) throw new Error("MySQL DATABASE_URL 不允许查询参数或片段。");
  if (!parsed.hostname || !parsed.username || !parsed.password) throw new Error("MySQL DATABASE_URL 缺少主机、用户或密码。");
  const rejectUnsafeDecoded = (value, field) => {
    if (!value || /[\\\u0000-\u001f\u007f]/.test(value)) throw new Error(`MySQL ${field} 包含不允许的字符。`);
    return value;
  };
  const user = rejectUnsafeDecoded(safeDecode(parsed.username, "user"), "user");
  const password = rejectUnsafeDecoded(safeDecode(parsed.password, "password"), "password");
  const database = safeDecode(parsed.pathname.replace(/^\//, ""), "database");
  if (!database || database.includes("/") || /[\\\u0000-\u001f\u007f]/.test(database)) {
    throw new Error("MySQL DATABASE_URL 必须指定安全的单一数据库名。");
  }
  const port = parsed.port ? Number(parsed.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MySQL 端口无效。");
  const urlHostname = parsed.hostname.replace(/^\[|\]$/g, "");
  const tlsEnabled = mysqlTlsEnabled(environment, urlHostname);
  const caFile = String(environment.MYSQL_SSL_CA_FILE || "").trim();
  if (tlsEnabled && !caFile) {
    throw new Error("MySQL TLS 连接必须配置 MYSQL_SSL_CA_FILE。仅在明确允许明文连接时设置 MYSQL_SSL_MODE=disabled。");
  }
  let ssl;
  if (tlsEnabled) {
    let ca;
    try { ca = readFileSync(caFile, "utf8"); }
    catch { throw new Error("无法读取 MYSQL_SSL_CA_FILE 指定的 CA 证书。"); }
    ssl = {
      ca,
      rejectUnauthorized: true,
      servername: urlHostname,
    };
  }
  const safeOverrides = {};
  for (const field of ["connectTimeout", "connectionLimit", "waitForConnections", "queueLimit",
    "enableKeepAlive", "keepAliveInitialDelay", "maxIdle", "idleTimeout"]) {
    if (Object.hasOwn(overrides, field)) safeOverrides[field] = overrides[field];
  }
  return {
    host: urlHostname,
    port,
    user,
    password,
    database,
    charset: "utf8mb4_bin",
    timezone: "Z",
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ...safeOverrides,
    ...(ssl ? { ssl } : {}),
    charset: "utf8mb4_bin",
    multipleStatements: false,
  };
}

const SCHEMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INT UNSIGNED NOT NULL,
  name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  applied_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`;

const migrationOneStatements = [
  `CREATE TABLE IF NOT EXISTS transaction_guards (
    name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (name)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS meta (
    \`key\` VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    value LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (\`key\`)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS agents (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    draft LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    published LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'draft',
    version INT UNSIGNED NOT NULL DEFAULT 0,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    published_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (slug), UNIQUE KEY agents_seq (seq),
    CONSTRAINT agents_draft_json CHECK (JSON_VALID(draft)),
    CONSTRAINT agents_published_json CHECK (published IS NULL OR JSON_VALID(published))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS agent_versions (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    version INT UNSIGNED NOT NULL,
    snapshot LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    published_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (agent_slug,version), UNIQUE KEY agent_versions_seq (seq),
    CONSTRAINT agent_versions_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT agent_versions_snapshot_json CHECK (JSON_VALID(snapshot))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS documents (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY documents_seq (seq), KEY documents_agent (agent_slug),
    CONSTRAINT documents_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT documents_payload_json CHECK (JSON_VALID(payload))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS chunks (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    document_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    position INT UNSIGNED NOT NULL,
    text LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    embedding LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    embedding_model VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    PRIMARY KEY (id), UNIQUE KEY chunks_seq (seq), KEY chunks_agent (agent_slug), KEY chunks_document (document_id,position),
    CONSTRAINT chunks_document_fk FOREIGN KEY (document_id) REFERENCES documents(id),
    CONSTRAINT chunks_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT chunks_embedding_json CHECK (embedding IS NULL OR JSON_VALID(embedding))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS sources (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY sources_seq (seq), KEY sources_agent (agent_slug),
    CONSTRAINT sources_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT sources_payload_json CHECK (JSON_VALID(payload))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS content (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY content_seq (seq), KEY content_agent (agent_slug),
    CONSTRAINT content_agent_fk FOREIGN KEY (agent_slug) REFERENCES agents(slug),
    CONSTRAINT content_payload_json CHECK (JSON_VALID(payload))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS jobs (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    type VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    payload LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    result LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    progress INT NOT NULL DEFAULT 0,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    max_attempts INT UNSIGNED NOT NULL DEFAULT 3,
    run_after CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    started_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    finished_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id), UNIQUE KEY jobs_seq (seq), KEY jobs_queue (status,run_after), KEY jobs_active_order (status,created_at,seq),
    CONSTRAINT jobs_payload_json CHECK (JSON_VALID(payload)),
    CONSTRAINT jobs_result_json CHECK (result IS NULL OR JSON_VALID(result))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    source_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    job_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    stats LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    error TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    started_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    finished_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    PRIMARY KEY (id), UNIQUE KEY sync_runs_seq (seq), KEY sync_runs_started (started_at,seq),
    CONSTRAINT sync_runs_stats_json CHECK (JSON_VALID(stats))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS users (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    username VARCHAR(80) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    name VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    password_hash VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    updated_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY users_seq (seq), UNIQUE KEY users_username (username)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS sessions (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    user_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    expires_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (token_hash), UNIQUE KEY sessions_seq (seq), KEY sessions_user (user_id), KEY sessions_expiry (expires_at),
    CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS audit (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    action VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    actor VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    target VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    details LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY audit_seq (seq), KEY audit_created (created_at,seq),
    CONSTRAINT audit_details_json CHECK (details IS NULL OR JSON_VALID(details))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS \`usage\` (
    seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    model VARCHAR(160) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
    retrieval_mode VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
    latency_ms INT UNSIGNED NOT NULL,
    success TINYINT(1) NOT NULL,
    error_code VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    PRIMARY KEY (id), UNIQUE KEY usage_seq (seq), KEY usage_created (created_at,seq)
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`,
  `INSERT IGNORE INTO transaction_guards(name,updated_at) VALUES('platform-write','1970-01-01T00:00:00.000Z')`,
];

const MIGRATIONS = [
  { version: 1, name: "initial-platform-schema", statements: migrationOneStatements },
  { version: 2, name: "consumer-wechat-identity-and-data", statements: consumerMysqlStatements },
  { version: 3, name: "persistent-safe-analytics-events", statements: analyticsMysqlStatements },
];
const migrationChecksum = (migration) => createHash("sha256").update(migration.statements.join("\n-- statement --\n")).digest("hex");
export const MYSQL_SCHEMA_VERSION = MIGRATIONS.at(-1).version;
export function mysqlSchemaMigrationsSha256(rows) {
  if (!Array.isArray(rows)) throw new TypeError("MySQL schema migration rows must be an array.");
  const normalized = rows.map((row) => {
    const rawVersion = Array.isArray(row) ? row[0] : row?.version;
    const rawChecksum = Array.isArray(row) ? row[1] : row?.checksum;
    const version = Number(rawVersion);
    const checksum = typeof rawChecksum === "string" ? rawChecksum : "";
    if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f\d]{64}$/.test(checksum)) {
      throw new TypeError("MySQL schema migration row is invalid.");
    }
    return [String(version), checksum];
  }).sort((left, right) => Number(left[0]) - Number(right[0]));
  if (new Set(normalized.map(([version]) => version)).size !== normalized.length) {
    throw new TypeError("MySQL schema migration versions must be unique.");
  }
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
const MYSQL_SCHEMA_MIGRATION_ENTRIES = MIGRATIONS.map((migration) => [String(migration.version), migrationChecksum(migration)]);
export const MYSQL_SCHEMA_MIGRATION_COUNT = MYSQL_SCHEMA_MIGRATION_ENTRIES.length;
export const MYSQL_SCHEMA_MIGRATION_SHA256 = mysqlSchemaMigrationsSha256(MYSQL_SCHEMA_MIGRATION_ENTRIES);

export function mysqlBackupSchemaSummary(version = MYSQL_SCHEMA_VERSION) {
  const supportedVersion = Number(version);
  if (!Number.isSafeInteger(supportedVersion) || supportedVersion < 1 || supportedVersion > MYSQL_SCHEMA_VERSION) {
    throw new Error("MySQL 备份的 schema migration 版本不受支持。");
  }
  const entries = MYSQL_SCHEMA_MIGRATION_ENTRIES.filter(([entryVersion]) => Number(entryVersion) <= supportedVersion);
  return {count: entries.length, sha256: mysqlSchemaMigrationsSha256(entries), version: supportedVersion};
}

export function validateMySqlBackupSchemaSummary({ count, sha256, version } = {}) {
  if (version === undefined || version === null) throw new Error("MySQL 备份的 schema migration 版本缺失。");
  const expected = mysqlBackupSchemaSummary(version);
  if (number(count) !== expected.count || sha256 !== expected.sha256) {
    throw new Error("MySQL 备份的 schema migration 摘要与当前运行时不匹配。");
  }
  return true;
}

const TABLE_DDL = new Map([SCHEMA_MIGRATIONS_DDL, ...MIGRATIONS.flatMap(migration => migration.statements)].flatMap((statement) => {
  const match = /^CREATE TABLE IF NOT EXISTS\s+`?([a-z_]+)`?/i.exec(statement.trim());
  return match ? [[match[1], statement]] : [];
}));

function expectedColumns() {
  const result = new Map();
  for (const [table, statement] of TABLE_DDL) {
    const columns = new Map();
    let ordinal = 0;
    for (const line of statement.split("\n")) {
      const match = /^\s*`?([a-z_]+)`?\s+((?:BIGINT|INT|TINYINT|VARCHAR|CHAR|LONGTEXT|TEXT)(?:\(\d+\))?(?:\s+UNSIGNED)?)/i.exec(line);
      if (!match) continue;
      const defaultMatch = /\bDEFAULT\s+(?:'([^']*)'|([^\s,]+))/i.exec(line);
      let defaultValue = defaultMatch ? (defaultMatch[1] ?? defaultMatch[2]) : null;
      if (typeof defaultValue === "string" && defaultValue.toUpperCase() === "NULL") defaultValue = null;
      columns.set(match[1], {
        ordinal: ++ordinal,
        columnType: match[2].toLowerCase().replace(/\s+/g, " "),
        nullable: /\bNOT NULL\b/i.test(line) ? "NO" : "YES",
        defaultValue,
        collation: /\bCOLLATE\s+([a-z\d_]+)/i.exec(line)?.[1]?.toLowerCase() || null,
        extra: /\bAUTO_INCREMENT\b/i.test(line) ? "auto_increment" : "",
        generationExpression: "",
      });
    }
    result.set(table, columns);
  }
  return result;
}

function indexColumns(value) {
  return value.split(",").map((column) => column.trim().replace(/`/g, "").replace(/\(\d+\)$/, ""));
}

function expectedIndexes() {
  const result = new Map();
  for (const [table, statement] of TABLE_DDL) {
    for (const match of statement.matchAll(/PRIMARY\s+KEY\s*\(([^)]+)\)/gi)) {
      result.set(`${table}:PRIMARY`, { nonUnique: 0, columns: indexColumns(match[1]) });
    }
    for (const match of statement.matchAll(/(?:^|,|\n)\s*(UNIQUE\s+)?KEY\s+`?([a-z_]+)`?\s*\(([^)]+)\)/gi)) {
      result.set(`${table}:${match[2]}`, { nonUnique: match[1] ? 0 : 1, columns: indexColumns(match[3]) });
    }
  }
  return result;
}

const normalizeCheckClause = (value) => String(value || "").toLowerCase().replace(/[`()\s]/g, "");

function expectedConstraints() {
  const result = new Map();
  for (const [table, statement] of TABLE_DDL) {
    for (const line of statement.split("\n")) {
      const foreignKey = /CONSTRAINT\s+`?([a-z_]+)`?\s+FOREIGN KEY\s*\(`?([a-z_]+)`?\)\s+REFERENCES\s+`?([a-z_]+)`?\s*\(`?([a-z_]+)`?\)/i.exec(line);
      if (foreignKey) result.set(`${table}:${foreignKey[1]}`, {
        type: "FOREIGN KEY", column: foreignKey[2], referencedTable: foreignKey[3], referencedColumn: foreignKey[4],
      });
      const check = /CONSTRAINT\s+`?([a-z_]+)`?\s+CHECK\s*\((.*)\)\s*,?$/i.exec(line.trim());
      if (check) result.set(`${table}:${check[1]}`, { type: "CHECK", clause: normalizeCheckClause(check[2]) });
    }
  }
  return result;
}

const EXPECTED_COLUMNS = expectedColumns();
const EXPECTED_INDEXES = expectedIndexes();
const EXPECTED_CONSTRAINTS = expectedConstraints();

export async function validateMySqlRuntimeSchema(executor) {
  if (!executor || typeof executor.query !== "function") throw new Error("MySQL schema validator requires a query executor.");
  const queryRows = async (sql) => (await executor.query(sql))[0];
  const databaseRows = await queryRows("SELECT DATABASE() AS database_name");
  const databaseName = databaseRows.length === 1 ? databaseRows[0].database_name : null;
  if (!databaseName) throw new Error("MySQL schema validator requires a selected database.");
  const migrationRows = await queryRows("SELECT version,name,checksum FROM schema_migrations ORDER BY version");
  if (migrationRows.length !== MIGRATIONS.length) throw new Error("MySQL 数据库迁移版本数量不匹配。");
  for (const migration of MIGRATIONS) {
    const row = migrationRows.find((candidate) => number(candidate.version) === migration.version);
    if (!row || row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      throw new Error(`MySQL 数据库迁移版本 ${migration.version} 的名称或校验和不匹配。`);
    }
  }
  const metaVersionRows = await queryRows("SELECT value FROM meta WHERE `key`='schema_version'");
  if (metaVersionRows.length !== 1 || String(metaVersionRows[0].value) !== String(MYSQL_SCHEMA_VERSION)) {
    throw new Error("MySQL meta.schema_version 与运行时迁移版本不匹配。");
  }

  const tableRows = await queryRows(`SELECT TABLE_NAME AS table_name,ENGINE AS engine,TABLE_COLLATION AS table_collation
    FROM information_schema.tables
    WHERE table_schema=DATABASE() AND TABLE_TYPE='BASE TABLE'`);
  const tableMap = new Map(tableRows.map((row) => [row.table_name, row]));
  const missingTables = REQUIRED_TABLES.filter((table) => !tableMap.has(table));
  if (missingTables.length) throw new Error(`MySQL 数据库结构不完整：缺少 ${missingTables.join(", ")}。`);
  const unexpectedTables = tableRows.map((row) => row.table_name).filter((table) => !REQUIRED_TABLES.includes(table));
  if (unexpectedTables.length) {
    throw new Error(`MySQL 数据库不允许额外普通表：${unexpectedTables.join(", ")}。`);
  }
  for (const table of REQUIRED_TABLES) {
    const row = tableMap.get(table);
    if (String(row.engine).toLowerCase() !== "innodb" || String(row.table_collation).toLowerCase() !== "utf8mb4_bin") {
      throw new Error(`MySQL 表 ${table} 必须使用 InnoDB 和 utf8mb4_bin。`);
    }
  }

  const columnRows = await queryRows(`SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,
      ORDINAL_POSITION AS ordinal_position,COLUMN_TYPE AS column_type,IS_NULLABLE AS is_nullable,
      COLUMN_DEFAULT AS column_default,COLLATION_NAME AS collation_name,EXTRA AS extra,
      GENERATION_EXPRESSION AS generation_expression
    FROM information_schema.columns
    WHERE table_schema=DATABASE()`);
  const actualColumns = new Map(REQUIRED_TABLES.map((table) => [table, new Map()]));
  for (const row of columnRows) actualColumns.get(row.table_name)?.set(row.column_name, row);
  for (const [table, expected] of EXPECTED_COLUMNS) {
    const actual = actualColumns.get(table);
    if (actual.size !== expected.size) throw new Error(`MySQL 表 ${table} 的列结构不匹配。`);
    for (const [column, definition] of expected) {
      const row = actual.get(column);
      const actualDefault = row?.column_default === undefined || row?.column_default === null ? null : String(row.column_default);
      const actualCollation = row?.collation_name === undefined || row?.collation_name === null
        ? null : String(row.collation_name).toLowerCase();
      if (!row || number(row.ordinal_position) !== definition.ordinal
        || String(row.column_type).toLowerCase().replace(/\s+/g, " ") !== definition.columnType
        || String(row.is_nullable).toUpperCase() !== definition.nullable
        || actualDefault !== definition.defaultValue || actualCollation !== definition.collation
        || String(row.extra || "").toLowerCase().replace(/\s+/g, " ") !== definition.extra
        || String(row.generation_expression || "") !== definition.generationExpression) {
        throw new Error(`MySQL 表 ${table} 的列 ${column} 定义不匹配。`);
      }
    }
  }

  const indexRows = await queryRows(`SELECT TABLE_NAME AS table_name,INDEX_NAME AS index_name,NON_UNIQUE AS non_unique,
      SEQ_IN_INDEX AS seq_in_index,COLUMN_NAME AS column_name FROM information_schema.statistics
    WHERE table_schema=DATABASE()`);
  const indexes = new Map();
  for (const row of indexRows) {
    const key = `${row.table_name}:${row.index_name}`;
    if (!indexes.has(key)) indexes.set(key, { nonUnique: number(row.non_unique), columns: [] });
    indexes.get(key).columns[number(row.seq_in_index) - 1] = row.column_name;
  }
  for (const [key, expected] of EXPECTED_INDEXES) {
    const actual = indexes.get(key);
    if (!actual || actual.nonUnique !== expected.nonUnique || actual.columns.join("\0") !== expected.columns.join("\0")) {
      throw new Error(`MySQL 数据库索引 ${key} 定义不匹配。`);
    }
  }

  const constraintRows = await queryRows(`SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS constraint_name,
      CONSTRAINT_TYPE AS constraint_type,ENFORCED AS enforced
    FROM information_schema.table_constraints
    WHERE table_schema=DATABASE()`);
  const constraints = new Map(constraintRows.map((row) => [`${row.table_name}:${row.constraint_name}`, row]));
  const allowedSemanticConstraints = new Set([
    ...EXPECTED_CONSTRAINTS.keys(),
    ...[...EXPECTED_INDEXES].filter(([, definition]) => definition.nonUnique === 0).map(([key]) => key),
  ]);
  for (const row of constraintRows) {
    if (REQUIRED_TABLES.includes(row.table_name) && !allowedSemanticConstraints.has(`${row.table_name}:${row.constraint_name}`)) {
      throw new Error(`MySQL 表 ${row.table_name} 存在未声明的语义约束 ${row.constraint_name}。`);
    }
  }
  for (const [key, definition] of EXPECTED_INDEXES) {
    if (definition.nonUnique !== 0) continue;
    const constraint = constraints.get(key);
    const expectedType = key.endsWith(":PRIMARY") ? "PRIMARY KEY" : "UNIQUE";
    if (!constraint || String(constraint.constraint_type).toUpperCase() !== expectedType) {
      throw new Error(`MySQL 唯一约束 ${key} 定义不匹配。`);
    }
  }
  const keyRows = await queryRows(`SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS constraint_name,
      COLUMN_NAME AS column_name,ORDINAL_POSITION AS ordinal_position,
      REFERENCED_TABLE_SCHEMA AS referenced_table_schema,REFERENCED_TABLE_NAME AS referenced_table_name,
      REFERENCED_COLUMN_NAME AS referenced_column_name
    FROM information_schema.key_column_usage WHERE table_schema=DATABASE()`);
  const keys = new Map(keyRows.map((row) => [`${row.table_name}:${row.constraint_name}`, row]));
  const referentialRows = await queryRows(`SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS constraint_name,
      UNIQUE_CONSTRAINT_SCHEMA AS unique_constraint_schema,REFERENCED_TABLE_NAME AS referenced_table_name,
      UPDATE_RULE AS update_rule,DELETE_RULE AS delete_rule
    FROM information_schema.referential_constraints WHERE constraint_schema=DATABASE()`);
  const referential = new Map(referentialRows.map((row) => [`${row.table_name}:${row.constraint_name}`, row]));
  const checkRows = await queryRows(`SELECT tc.TABLE_NAME AS table_name,tc.CONSTRAINT_NAME AS constraint_name,
      tc.ENFORCED AS enforced,cc.CHECK_CLAUSE AS check_clause
    FROM information_schema.table_constraints tc JOIN information_schema.check_constraints cc
      ON cc.constraint_schema=tc.constraint_schema AND cc.constraint_name=tc.constraint_name
    WHERE tc.table_schema=DATABASE() AND tc.constraint_type='CHECK'`);
  const checks = new Map(checkRows.map((row) => [`${row.table_name}:${row.constraint_name}`, row]));
  for (const [key, expected] of EXPECTED_CONSTRAINTS) {
    const constraint = constraints.get(key);
    if (!constraint || String(constraint.constraint_type).toUpperCase() !== expected.type
      || (expected.type === "CHECK" && String(constraint.enforced).toUpperCase() !== "YES")) {
      throw new Error(`MySQL 数据库约束 ${key} 类型或启用状态不匹配。`);
    }
    if (expected.type === "FOREIGN KEY") {
      const keyRow = keys.get(key);
      const reference = referential.get(key);
      if (!keyRow || number(keyRow.ordinal_position) !== 1 || keyRow.column_name !== expected.column
        || keyRow.referenced_table_schema !== databaseName
        || keyRow.referenced_table_name !== expected.referencedTable
        || keyRow.referenced_column_name !== expected.referencedColumn
        || !reference || reference.unique_constraint_schema !== databaseName
        || reference.referenced_table_name !== expected.referencedTable
        || !["RESTRICT", "NO ACTION"].includes(String(reference.update_rule).toUpperCase())
        || !["RESTRICT", "NO ACTION"].includes(String(reference.delete_rule).toUpperCase())) {
        throw new Error(`MySQL 外键 ${key} 引用定义不匹配。`);
      }
    } else {
      const check = checks.get(key);
      if (!check || String(check.enforced).toUpperCase() !== "YES"
        || normalizeCheckClause(check.check_clause) !== expected.clause) {
        throw new Error(`MySQL CHECK 约束 ${key} 定义不匹配。`);
      }
    }
  }
  const guardRows = await queryRows("SELECT name FROM transaction_guards WHERE name='platform-write'");
  if (guardRows.length !== 1) throw new Error("MySQL 全局事务 guard 行缺失或重复。");
  const triggerRows = await queryRows(`SELECT TRIGGER_NAME AS trigger_name,EVENT_OBJECT_TABLE AS event_object_table
    FROM information_schema.triggers WHERE trigger_schema=DATABASE()`);
  const runtimeTriggers = triggerRows.filter((row) => REQUIRED_TABLES.includes(row.event_object_table));
  if (runtimeTriggers.length) {
    throw new Error(`MySQL 运行时表不允许触发器：${runtimeTriggers.map((row) => row.trigger_name).join(", ")}。`);
  }
  return { version: MYSQL_SCHEMA_VERSION, tables: REQUIRED_TABLES.length };
}

export class MySQLPlatformDatabase {
  constructor({ pool, ownsPool = false, dataDir, writeGuard, lockNamespace, lockHeartbeatMs = 15_000, onCompromised } = {}) {
    if (!pool) throw new Error("MySQL pool is required; use MySQLPlatformDatabase.initialize().");
    this.storageKind = "MySQL";
    this.pool = pool;
    this.ownsPool = ownsPool;
    this.dataDir = path.resolve(dataDir || "data");
    this.writeGuard = typeof writeGuard === "function" ? writeGuard : null;
    this.onCompromised = typeof onCompromised === "function" ? onCompromised : null;
    this.transactionContext = new AsyncLocalStorage();
    this.closed = false;
    this.closing = false;
    this.lockError = null;
    this.lockConnection = null;
    this.lockHeartbeatTimer = null;
    this.lockHeartbeatPromise = null;
    this.lockVerificationPromise = null;
    this.outerTransactionTail = Promise.resolve();
    this.closePromise = null;
    this.lockHeartbeatMs = Math.max(5_000, Number(lockHeartbeatMs) || 15_000);
    const digest = createHash("sha256").update(String(lockNamespace || "default")).digest("hex").slice(0, 32);
    this.instanceLockName = `medtalent:${digest}:instance`;
    this.migrationLockName = `medtalent:${digest}:migrate`;
    mkdirSync(this.dataDir, { recursive: true });
  }

  static async initialize({ databaseUrl, connectionOptions = {}, pool, dataDir, seedDoctors = [], writeGuard, testHooks,
    lockNamespace, lockHeartbeatMs, onCompromised, instanceLockTimeoutSeconds = 0, migrationLockTimeoutSeconds = 30,
    environment = process.env } = {}) {
    const ownsPool = !pool;
    const options = pool ? null : mysqlConnectionOptions({ databaseUrl, connectionOptions, environment });
    const database = new MySQLPlatformDatabase({
      pool: pool || mysql.createPool(options), ownsPool, dataDir, writeGuard,
      lockNamespace: lockNamespace || options?.database, lockHeartbeatMs, onCompromised,
    });
    try {
      await database.acquireInstanceLock(instanceLockTimeoutSeconds);
      await database.assertSupportedServer();
      await database.runMigrations({ timeoutSeconds: migrationLockTimeoutSeconds, testHooks });
      await database.initializeData(seedDoctors, testHooks);
      database.startLockHeartbeat();
      return database;
    } catch (error) {
      try { await database.close(); } catch { /* preserve the initialization failure */ }
      throw error;
    }
  }

  static async create(options) { return this.initialize(options); }

  async configureConnection(connection) {
    await connection.query("SET NAMES utf8mb4 COLLATE utf8mb4_bin");
    await connection.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED");
  }

  async acquireInstanceLock(timeoutSeconds) {
    this.lockConnection = await this.pool.getConnection();
    await this.configureConnection(this.lockConnection);
    const [rows] = await this.lockConnection.execute("SELECT GET_LOCK(?,?) acquired", [this.instanceLockName, Math.max(0, Number(timeoutSeconds) || 0)]);
    if (number(rows[0]?.acquired) !== 1) {
      throw new PlatformError("该 MySQL 数据库已有活动平台实例。", 503, "PLATFORM_INSTANCE_LOCKED");
    }
  }

  async assertSupportedServer() {
    const [rows] = await this.lockConnection.query("SELECT VERSION() version");
    const version = String(rows[0]?.version || "");
    if (/mariadb/i.test(version)) throw new Error("当前实现要求 MySQL 8.0.16 或更高版本，不支持 MariaDB。");
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 8 || (Number(match[1]) === 8 && (Number(match[2]) < 0 || (Number(match[2]) === 0 && Number(match[3]) < 16)))) {
      throw new Error("当前实现要求 MySQL 8.0.16 或更高版本。");
    }
  }

  async runMigrations({ timeoutSeconds = 30, testHooks } = {}) {
    const connection = await this.pool.getConnection();
    let acquired = false;
    try {
      await this.configureConnection(connection);
      const [lockRows] = await connection.execute("SELECT GET_LOCK(?,?) acquired", [this.migrationLockName, Math.max(0, Number(timeoutSeconds) || 0)]);
      acquired = number(lockRows[0]?.acquired) === 1;
      if (!acquired) throw new PlatformError("MySQL 数据库迁移锁正被占用。", 503, "DATABASE_MIGRATION_LOCKED");
      const [tablesBeforeMigration] = await connection.query(`SELECT TABLE_NAME AS table_name
        FROM information_schema.tables WHERE table_schema=DATABASE()`);
      const tableNamesBeforeMigration = new Set(tablesBeforeMigration.map((row) => row.table_name));
      if (tableNamesBeforeMigration.size && !tableNamesBeforeMigration.has("schema_migrations")) {
        throw new Error("首次 MySQL 迁移要求空目标数据库，现有数据库没有受支持的 schema_migrations。");
      }
      await connection.query(SCHEMA_MIGRATIONS_DDL);
      const [appliedRows] = await connection.query("SELECT version,name,checksum FROM schema_migrations ORDER BY version");
      if (!appliedRows.length) {
        const unexpectedTables = [...tableNamesBeforeMigration].filter((table) => table !== "schema_migrations");
        if (unexpectedTables.length) {
          throw new Error(`首次 MySQL 迁移要求空目标数据库；发现已有表 ${unexpectedTables.join(", ")}。`);
        }
      }
      const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
      for (const row of appliedRows) {
        const migration = known.get(number(row.version));
        if (!migration) throw new Error(`数据库迁移版本 ${row.version} 高于当前程序支持范围。`);
        if (row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
          throw new Error(`数据库迁移版本 ${row.version} 的名称或校验和不匹配。`);
        }
      }
      const applied = new Set(appliedRows.map((row) => number(row.version)));
      for (const migration of MIGRATIONS) {
        if (applied.has(migration.version)) continue;
        await testHooks?.beforeSchemaMutation?.();
        for (const statement of migration.statements) await connection.query(statement);
        await connection.execute("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)",
          [migration.version, migration.name, migrationChecksum(migration), now()]);
      }
      await connection.execute(`INSERT INTO meta(\`key\`,value) VALUES('schema_version',?)
        ON DUPLICATE KEY UPDATE value=?`, [String(MIGRATIONS.at(-1).version), String(MIGRATIONS.at(-1).version)]);
      await validateMySqlRuntimeSchema(connection);
    } finally {
      if (acquired) {
        try { await connection.execute("SELECT RELEASE_LOCK(?) released", [this.migrationLockName]); } catch { /* connection close releases it */ }
      }
      connection.release();
    }
  }

  async initializeData(seedDoctors, testHooks) {
    const seeded = await this._get("SELECT value FROM meta WHERE `key`='seeded'");
    if (!seeded) await this.transaction(async () => {
      for (const doctor of seedDoctors) await this.createAgent(normalizeAgent(doctor), "system", true);
      await this._run("INSERT INTO meta(`key`,value) VALUES('seeded',?)", [now()]);
    });
    await this.transaction(async () => {
      await testHooks?.beforeRecoveryMutation?.();
      const timestamp = now();
      await this.settleExhaustedJobs("running", ["processing"], timestamp);
      await this._run("UPDATE jobs SET status='queued',run_after=?,error='服务重启后恢复任务' WHERE status='running' AND attempts<max_attempts", [timestamp]);
      await this._run("UPDATE sync_runs SET status='interrupted',finished_at=? WHERE status='running'", [timestamp]);
    });
  }

  async validateRuntimeSchema() {
    return await validateMySqlRuntimeSchema(this._executor());
  }

  assertAvailable() {
    if (this.closed || this.closing) throw new PlatformError("平台数据库连接已关闭。", 503, "PLATFORM_DATA_CLOSED");
    if (this.lockError) throw this.lockError;
  }

  async assertWritable() {
    this.assertAvailable();
    await this.writeGuard?.();
  }

  _executor() {
    this.assertAvailable();
    const context = this.transactionContext.getStore();
    return context?.database === this ? context.connection : this.pool;
  }

  async _rows(sql, parameters = []) {
    const [rows] = await this._executor().execute(sql, parameters);
    return rows;
  }

  async _get(sql, parameters = []) {
    const rows = await this._rows(sql, parameters);
    return rows[0];
  }

  async _run(sql, parameters = []) {
    const [result] = await this._executor().execute(sql, parameters);
    return result;
  }

  async transaction(callback) {
    const current = this.transactionContext.getStore();
    if (current?.database === this) {
      await this.assertWritable();
      return await callback();
    }
    this.assertAvailable();
    const predecessor = this.outerTransactionTail;
    let releaseTurn;
    this.outerTransactionTail = new Promise((resolve) => { releaseTurn = resolve; });
    await predecessor;
    try {
      await this.assertWritable();
      await this.verifyInstanceLock();
      this.assertAvailable();
      const connection = await this.pool.getConnection();
      let transactionOpen = false;
      let connectionDestroyed = false;
      try {
        await this.configureConnection(connection);
        await connection.beginTransaction();
        transactionOpen = true;
        const [guardRows] = await connection.execute("SELECT name FROM transaction_guards WHERE name='platform-write' FOR UPDATE");
        if (!Array.isArray(guardRows) || guardRows.length !== 1) {
          throw new PlatformError("MySQL 全局事务 guard 行缺失。", 503, "MYSQL_RUNTIME_SCHEMA_INVALID");
        }
        const result = await this.transactionContext.run({ database: this, connection }, async () => {
          const value = await callback();
          await this.verifyInstanceLock();
          await this.assertWritable();
          return value;
        });
        try {
          await connection.commit();
          transactionOpen = false;
        } catch (cause) {
          transactionOpen = false;
          connectionDestroyed = true;
          try { await connection.destroy?.(); } catch { /* never return an uncertain connection to the pool */ }
          const unknown = new PlatformError(
            "MySQL 事务提交结果未知，平台已停止数据库操作；禁止盲目重试，请先核验业务状态。",
            503,
            "MYSQL_COMMIT_OUTCOME_UNKNOWN",
          );
          unknown.cause = cause;
          this.compromiseDatabase(unknown);
          throw unknown;
        }
        return result;
      } catch (error) {
        if (transactionOpen) {
          try { await connection.rollback(); } catch { /* preserve the operation failure */ }
        }
        throw error;
      } finally {
        if (!connectionDestroyed) connection.release();
      }
    } finally {
      releaseTurn();
    }
  }

  compromiseDatabase(error) {
    if (this.lockError) return this.lockError;
    this.lockError = error;
    try { this.onCompromised?.(this.lockError); } catch { /* compromise state remains sticky */ }
    return this.lockError;
  }

  compromiseInstanceLock(cause) {
    const error = new PlatformError("MySQL 单实例锁已丢失，平台已停止数据库操作。", 503, "PLATFORM_INSTANCE_LOCK_LOST");
    error.cause = cause;
    this.compromiseDatabase(error);
  }

  async verifyInstanceLock() {
    if (this.closed || this.closing || !this.lockConnection) return;
    if (this.lockVerificationPromise) return await this.lockVerificationPromise;
    const verification = (async () => {
      try {
        const [rows] = await this.lockConnection.execute("SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() connection_id", [this.instanceLockName]);
        if (rows[0]?.owner === null || String(rows[0]?.owner) !== String(rows[0]?.connection_id)) {
          this.compromiseInstanceLock(new Error("MySQL instance lock ownership changed."));
        }
      } catch (error) {
        this.compromiseInstanceLock(error);
      }
    })();
    this.lockVerificationPromise = verification;
    try { await verification; }
    finally {
      if (this.lockVerificationPromise === verification) this.lockVerificationPromise = null;
    }
  }

  startLockHeartbeat() {
    if (this.lockHeartbeatTimer) return;
    this.lockHeartbeatTimer = setInterval(() => {
      if (this.lockHeartbeatPromise) return;
      this.lockHeartbeatPromise = this.verifyInstanceLock().finally(() => { this.lockHeartbeatPromise = null; });
    }, this.lockHeartbeatMs);
    this.lockHeartbeatTimer.unref?.();
  }

  async ping() {
    try {
      this.assertAvailable();
      await this.verifyInstanceLock();
      this.assertAvailable();
      await this.lockConnection.ping();
      const row = await this._get("SELECT 1 ok");
      return number(row?.ok) === 1;
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      const unavailable = new PlatformError("MySQL 数据库暂时不可用。", 503, "DATABASE_UNAVAILABLE");
      unavailable.cause = error;
      throw unavailable;
    }
  }

  async close() {
    if (this.closed) return;
    if (this.closePromise) return await this.closePromise;
    if (this.transactionContext.getStore()?.database === this) {
      throw new PlatformError("不能在活动事务内部关闭平台数据库。", 409, "DATABASE_CLOSE_DURING_TRANSACTION");
    }
    this.closing = true;
    this.closePromise = (async () => {
      await this.outerTransactionTail;
      if (this.lockHeartbeatTimer) clearInterval(this.lockHeartbeatTimer);
      this.lockHeartbeatTimer = null;
      try { await this.lockHeartbeatPromise; } catch { /* heartbeat already recorded compromise */ }
      try { await this.lockVerificationPromise; } catch { /* verification already recorded compromise */ }
      if (this.lockConnection) {
        try { await this.lockConnection.execute("SELECT RELEASE_LOCK(?) released", [this.instanceLockName]); } catch { /* connection close releases it */ }
        try { this.lockConnection.release(); } catch { /* already disconnected */ }
        this.lockConnection = null;
      }
      if (this.ownsPool) await this.pool.end();
    })();
    try { await this.closePromise; }
    finally {
      this.closed = true;
      this.closing = false;
    }
  }

  async getMeta(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) throw new PlatformError("元数据标识无效。");
    return (await this._get("SELECT value FROM meta WHERE \x60key\x60=?", [key]))?.value ?? null;
  }

  async setMeta(key, value) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key) || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) throw new PlatformError("元数据格式或大小无效。");
    return await this.transaction(async () => { await this._run("INSERT INTO meta(\x60key\x60,value) VALUES(?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)", [key, value]); return value; });
  }

  async hasAnyUser() {
    return Boolean(await this._get("SELECT 1 found FROM users LIMIT 1"));
  }

  async bootstrapUser(record) { return await this.insertUser(record); }

  async listActivePasswordHashes() {
    return (await this._rows("SELECT password_hash FROM users WHERE active=1")).map((row) => row.password_hash);
  }

  async findSessionUser(tokenHash, timestamp) {
    return await this._get(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`, [tokenHash, timestamp]);
  }

  async findUserByUsername(username) {
    return await this._get("SELECT * FROM users WHERE username=?", [username]);
  }

  async createLoginSession({ tokenHash, userId, expiresAt, now: timestamp = now() }) {
    return await this.transaction(async () => {
      await this._run("DELETE FROM sessions WHERE expires_at<=?", [timestamp]);
      await this._run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", [tokenHash, userId, expiresAt]);
    });
  }

  async deleteSession(tokenHash) {
    return await this.transaction(async () => number((await this._run("DELETE FROM sessions WHERE token_hash=?", [tokenHash])).affectedRows));
  }

  async listUsersRaw() {
    return await this._rows("SELECT * FROM users ORDER BY created_at,id");
  }

  async getUser(userId) { return await this._get("SELECT * FROM users WHERE id=?", [userId]); }

  async countActiveAdmins() {
    return number((await this._get("SELECT COUNT(*) total FROM users WHERE role='admin' AND active=1"))?.total);
  }

  async insertUser(record) {
    return await this.transaction(async () => {
      const createdAt = record.createdAt || record.created_at || now();
      const updatedAt = record.updatedAt || record.updated_at || createdAt;
      const passwordHash = record.passwordHash || record.password_hash;
      await this._run(`INSERT INTO users(id,username,name,role,active,password_hash,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`, [record.id, record.username, record.name, record.role || "editor",
        record.active === undefined ? 1 : Number(record.active), passwordHash, createdAt, updatedAt]);
      return await this.getUser(record.id);
    });
  }

  async updateUser(userId, patch) {
    return await this.transaction(async () => {
      const existing = await this.getUser(userId);
      if (!existing) return null;
      const passwordHash = patch.passwordHash || patch.password_hash || existing.password_hash;
      await this._run("UPDATE users SET name=?,role=?,active=?,password_hash=?,updated_at=? WHERE id=?", [
        patch.name ?? existing.name, patch.role ?? existing.role,
        patch.active === undefined ? existing.active : Number(patch.active), passwordHash,
        patch.updatedAt || patch.updated_at || now(), userId,
      ]);
      return await this.getUser(userId);
    });
  }

  async deleteUserSessions(userId) {
    return await this.transaction(async () => number((await this._run("DELETE FROM sessions WHERE user_id=?", [userId])).affectedRows));
  }

  async agentFromRow(row, published = false) {
    if (!row || (published && (row.status !== "published" || !row.published))) return null;
    return {
      ...parse(published ? row.published : row.draft),
      status: row.status,
      version: number(row.version),
      createdAt: row.created_at,
      updatedAt: published ? row.published_at : row.updated_at,
      publishedAt: row.published_at,
      hasUnpublishedChanges: row.draft !== row.published,
    };
  }

  async getAgent(slug, published = false) {
    return await this.agentFromRow(await this._get("SELECT * FROM agents WHERE slug=?", [slug]), published);
  }

  async requireAgent(slug) {
    const agent = await this.getAgent(slug);
    if (!agent) throw new PlatformError("智能体不存在。", 404, "AGENT_NOT_FOUND");
    return agent;
  }

  async listAgents(published = false) {
    return (await Promise.all((await this._rows("SELECT * FROM agents ORDER BY created_at,slug"))
      .map((row) => this.agentFromRow(row, published)))).filter(Boolean);
  }

  async createAgent(record, actor, publish = false) {
    return await this.transaction(async () => {
      if (await this.getAgent(record.slug)) {
        throw new PlatformError(`智能体标识 ${record.slug} 已存在。`, 409, "DUPLICATE_SLUG");
      }
      const timestamp = now();
      try {
        await this._run("INSERT INTO agents(slug,draft,status,created_at,updated_at) VALUES(?,?,'draft',?,?)",
          [record.slug, JSON.stringify(record), timestamp, timestamp]);
      } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") {
          throw new PlatformError(`智能体标识 ${record.slug} 已存在。`, 409, "DUPLICATE_SLUG");
        }
        throw error;
      }
      await this.audit("agent.create", actor, record.slug);
      if (publish) return await this.publishAgent(record.slug, actor);
      return await this.getAgent(record.slug);
    });
  }

  async saveAgent(record, actor) {
    return await this.transaction(async () => {
      await this.requireAgent(record.slug);
      await this._run("UPDATE agents SET draft=?,updated_at=? WHERE slug=?", [JSON.stringify(record), now(), record.slug]);
      await this.audit("agent.save_draft", actor, record.slug);
      return await this.getAgent(record.slug);
    });
  }

  async publishAgent(slug, actor) {
    return await this.transaction(async () => {
      const agent = await this.requireAgent(slug);
      const snapshot = JSON.stringify(normalizeAgent(agent));
      const version = agent.version + 1;
      const timestamp = now();
      await this._run(`UPDATE agents SET draft=?,published=?,status='published',version=?,published_at=?,updated_at=?
        WHERE slug=?`, [snapshot, snapshot, version, timestamp, timestamp, slug]);
      await this._run("INSERT INTO agent_versions(agent_slug,version,snapshot,published_at,actor) VALUES(?,?,?,?,?)",
        [slug, version, snapshot, timestamp, actor]);
      await this.audit("agent.publish", actor, slug, { version });
      return await this.getAgent(slug);
    });
  }

  async archiveAgent(slug, actor) {
    return await this.transaction(async () => {
      await this.requireAgent(slug);
      await this._run("UPDATE agents SET status='archived',updated_at=? WHERE slug=?", [now(), slug]);
      await this.audit("agent.archive", actor, slug);
      return await this.getAgent(slug);
    });
  }

  async getAgentVersionSnapshot(slug, version) {
    await this.requireAgent(slug);
    const row = await this._get("SELECT snapshot FROM agent_versions WHERE agent_slug=? AND version=?", [slug, version]);
    return row ? parse(row.snapshot) : null;
  }

  async listVersions(slug) {
    await this.requireAgent(slug);
    return (await this._rows(`SELECT version,published_at,snapshot,actor FROM agent_versions
      WHERE agent_slug=? ORDER BY version DESC`, [slug])).map((row) => ({
      version: number(row.version), publishedAt: row.published_at, name: parse(row.snapshot).name, actor: row.actor,
    }));
  }

  async rollbackAgent(slug, version, actor) {
    return await this.transaction(async () => {
      const row = await this._get("SELECT snapshot FROM agent_versions WHERE agent_slug=? AND version=?", [slug, version]);
      if (!row) throw new PlatformError("发布版本不存在。", 404, "VERSION_NOT_FOUND");
      const agent = await this.saveAgent(parse(row.snapshot), actor);
      await this.audit("agent.restore_version_to_draft", actor, slug, { version });
      return agent;
    });
  }

  async checkTable(table) { if (!ENTITY_TABLES.has(table)) throw new Error("Invalid entity table"); }

  async getEntity(table, entityId) {
    await this.checkTable(table);
    return parse((await this._get(`SELECT payload FROM ${table} WHERE id=?`, [entityId]))?.payload);
  }

  async requireEntity(table, entityId) {
    const entity = await this.getEntity(table, entityId);
    if (!entity) throw new PlatformError("记录不存在。", 404, "NOT_FOUND");
    return entity;
  }

  async listEntities(table, agentSlug) {
    await this.checkTable(table);
    const rows = agentSlug
      ? await this._rows(`SELECT payload FROM ${table} WHERE agent_slug=? ORDER BY seq DESC`, [agentSlug])
      : await this._rows(`SELECT payload FROM ${table} ORDER BY seq DESC`);
    return rows.map((row) => parse(row.payload));
  }

  async saveEntity(table, entity) {
    return await this.transaction(async () => {
      await this.checkTable(table);
      const serialized = JSON.stringify(entity);
      await this._run(`INSERT INTO ${table}(id,agent_slug,payload) VALUES(?,?,?)
        ON DUPLICATE KEY UPDATE payload=?`, [entity.id, entity.agentSlug, serialized, serialized]);
      return entity;
    });
  }

  async patchEntity(table, entityId, patch) {
    return await this.transaction(async () => {
      const existing = await this.requireEntity(table, entityId);
      return await this.saveEntity(table, { ...existing, ...patch, id: existing.id, agentSlug: existing.agentSlug });
    });
  }

  async removeEntity(table, entityId) {
    return await this.transaction(async () => {
      await this.checkTable(table);
      await this._run(`DELETE FROM ${table} WHERE id=?`, [entityId]);
    });
  }

  async listChunks(documentId) {
    return (await this._rows("SELECT id,position,text FROM chunks WHERE document_id=? ORDER BY position", [documentId]))
      .map((row) => ({ id: row.id, index: number(row.position), text: row.text }));
  }

  async listStoredChunkRows(documentId) {
    return await this._rows(`SELECT id,document_id,agent_slug,position,text,embedding,embedding_model
      FROM chunks WHERE document_id=? ORDER BY position`, [documentId]);
  }

  async countDocumentChunks(documentId) {
    return number((await this._get("SELECT COUNT(*) total FROM chunks WHERE document_id=?", [documentId]))?.total);
  }

  async countSearchableChunks(agentSlug) {
    const row = await this._get(`SELECT COUNT(*) total FROM chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.agent_slug=? AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.status'))='ready'
        AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.approved'))='true'`, [agentSlug]);
    return number(row?.total);
  }

  async replaceChunks(document, chunks, vectors, embeddingModel) {
    const records = chunks.map((chunk, index) => ({
      id: id(), documentId: document.id, agentSlug: document.agentSlug, position: chunk.index, text: chunk.text,
      embedding: vectors?.[index] ? JSON.stringify(vectors[index]) : null, embeddingModel: embeddingModel || null,
    }));
    const parametersForRecord = (record) => [record.id, record.documentId, record.agentSlug, record.position,
      record.text, record.embedding, record.embeddingModel];
    const batches = writeBatches(records, parametersForRecord);
    return await this.transaction(async () => {
      await this._run("DELETE FROM chunks WHERE document_id=?", [document.id]);
      for (const batch of batches) {
        await this._run(`INSERT INTO chunks(id,document_id,agent_slug,position,text,embedding,embedding_model)
          VALUES ${batch.map(() => "(?,?,?,?,?,?,?)").join(",")}`, batch.flatMap(parametersForRecord));
      }
    });
  }

  async updateChunkEmbeddings(rows, vectors, model) {
    if (!Array.isArray(rows) || !Array.isArray(vectors) || rows.length !== vectors.length) {
      throw new PlatformError("资料分片向量结果数量不匹配。", 409, "DOCUMENT_CHANGED");
    }
    const records = rows.map((row, index) => ({ row, embedding: JSON.stringify(vectors[index]), model }));
    const parametersForRecord = (record) => [record.row.id, record.embedding, record.row.id, record.model,
      record.row.id, record.row.document_id, record.row.agent_slug, record.row.position, record.row.text];
    const batches = writeBatches(records, parametersForRecord);
    return await this.transaction(async () => {
      for (const batch of batches) {
        const embeddingCases = batch.map(() => "WHEN ? THEN ?").join(" ");
        const modelCases = batch.map(() => "WHEN ? THEN ?").join(" ");
        const predicates = batch.map(() => `(id=? AND document_id=? AND agent_slug=? AND position=?
          AND BINARY text=BINARY ? AND embedding IS NULL AND embedding_model IS NULL)`).join(" OR ");
        const parameters = [
          ...batch.flatMap((record) => [record.row.id, record.embedding]),
          ...batch.flatMap((record) => [record.row.id, record.model]),
          ...batch.flatMap((record) => [record.row.id, record.row.document_id, record.row.agent_slug,
            record.row.position, record.row.text]),
        ];
        const result = await this._run(`UPDATE chunks
          SET embedding=CASE id ${embeddingCases} ELSE embedding END,
              embedding_model=CASE id ${modelCases} ELSE embedding_model END
          WHERE ${predicates}`, parameters);
        if (number(result.affectedRows) !== batch.length) {
          throw new PlatformError("资料分片在写入期间已发生变化。", 409, "DOCUMENT_CHANGED");
        }
      }
      return rows.length;
    });
  }

  async searchableChunks(agentSlug, maxChunks = MAX_AGENT_SEARCHABLE_CHUNKS) {
    const rows = await this._rows(`SELECT c.*,d.payload FROM chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.agent_slug=? AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.status'))='ready'
        AND JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.approved'))='true'
      ORDER BY c.document_id,c.position LIMIT ?`, [agentSlug, Number(maxChunks) + 1]);
    if (rows.length > maxChunks) {
      throw new PlatformError(`该智能体已生效片段超过单节点检索上限（${maxChunks}）。请拆分知识库或扩展向量存储，平台不会静默忽略超出部分。`, 503, "INDEX_CAPACITY_EXCEEDED");
    }
    return rows.map((row) => ({
      id: row.id, documentId: row.document_id, title: parse(row.payload).name,
      index: number(row.position), text: row.text, embedding: parse(row.embedding), embeddingModel: row.embedding_model,
    }));
  }

  async audit(action, actor = "system", target = null, details = null) {
    return await this.transaction(async () => {
      await this._run("INSERT INTO audit(id,action,actor,target,details,created_at) VALUES(?,?,?,?,?,?)",
        [id(), action, actor, target, details ? JSON.stringify(details) : null, now()]);
    });
  }

  async appendAnalyticsEvents(events) {
    if(!Array.isArray(events))throw new TypeError('Analytics events must be an array.');
    const rows=events.map(analyticsRow);
    return await this.transaction(async()=>{let inserted=0;for(const batch of writeBatches(rows,row=>row)){const result=await this._run('INSERT IGNORE INTO analytics_events(id,event_type,agent_slug,tenant_id,actor_kind,actor_hash,created_at,test_traffic,safe_json) VALUES '+batch.map(()=>'(?,?,?,?,?,?,?,?,?)').join(','),batch.flat());inserted+=Number(result.affectedRows||0);}return {inserted};});
  }

  async queryAnalyticsEvents(options={}) {
    const query=buildAnalyticsQuery(options),count=await this._get('SELECT COUNT(*) total FROM analytics_events e'+query.where,query.parameters),total=number(count.total);
    assertAnalyticsQuerySize(total);
    const rows=await this._rows('SELECT e.* FROM analytics_events e'+query.where+' ORDER BY e.created_at,e.id LIMIT ?',[...query.parameters,ANALYTICS_QUERY_MAX_EVENTS+1]);
    assertAnalyticsQuerySize(rows.length);
    return {items:rows.map(analyticsEventFromRow),total,truncated:false};
  }

  async queryAnalyticsRetention(options={}) {
    const results=[];
    for(const day of [1,7,30]){const query=buildAnalyticsRetentionQuery(options,day,'mysql'),row=await this._get(query.sql,query.parameters),eligible=number(row.eligible),returned=number(row.returned);results.push({day,eligible,returned,rate:eligible?returned/eligible:null});}
    return results;
  }

  async pruneAnalyticsEvents(before) {
    const cutoff=analyticsDate(before);
    return await this.transaction(async()=>{const result=await this._run('DELETE FROM analytics_events WHERE created_at<?',[cutoff]);return number(result.affectedRows);});
  }

  async queryAudit(options = {}) {
    const query=buildAuditQuery(options);
    const count=await this._get('SELECT COUNT(*) total FROM audit a'+query.where,query.parameters);
    const items=(await this._rows('SELECT a.* FROM audit a'+query.where+' ORDER BY a.created_at DESC,a.seq DESC LIMIT ? OFFSET ?',[...query.parameters,query.limit,query.offset]))
      .map(row=>({id:row.id,action:row.action,actor:row.actor,target:row.target,details:parse(row.details),createdAt:row.created_at}));
    return {items,total:number(count.total),limit:query.limit,offset:query.offset,truncated:false};
  }

  async listAudit(limit = 100) {
    return (await this._rows("SELECT * FROM audit ORDER BY created_at DESC,seq DESC LIMIT ?", [Number(limit)]))
      .map((row) => ({
        id: row.id, action: row.action, actor: row.actor, target: row.target,
        details: parse(row.details), createdAt: row.created_at,
      }));
  }

  async jobFromRow(row) {
    if (!row) return null;
    return {
      id: row.id, type: row.type, status: row.status, payload: parse(row.payload), result: parse(row.result), error: row.error,
      progress: number(row.progress), attempts: number(row.attempts), maxAttempts: number(row.max_attempts),
      runAfter: row.run_after, createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
    };
  }

  async enqueue(type, payload, { deduplicate = true } = {}) {
    return await this.transaction(async () => {
      const serialized = JSON.stringify(payload);
      if (["document.ingest", "document.reembed"].includes(type)) {
        if (typeof payload?.documentId !== "string" || !payload.documentId) throw new Error("Invalid document job payload");
        const active = await this._rows(`SELECT * FROM jobs
          WHERE type IN ('document.ingest','document.reembed') AND status IN ('queued','running')
          ORDER BY created_at,seq`);
        for (const row of active) {
          const activePayload = parsedJobPayload(row.payload);
          if (activePayload?.documentId !== payload.documentId) continue;
          if (deduplicate && row.type === type && row.payload === serialized) return await this.jobFromRow(row);
          if (type === "document.reembed" || row.type === "document.reembed") {
            throw new PlatformError("该资料已有排队或运行中的处理任务。", 409, "DOCUMENT_JOB_ACTIVE");
          }
        }
      }
      if (KNOWLEDGE_JOB_TYPES.has(type)) {
        const activeKnowledge = await this._rows(`SELECT * FROM jobs
          WHERE type IN ('document.ingest','document.reembed','nas.sync') AND status IN ('queued','running')
          ORDER BY created_at,seq`);
        if (type === "document.reembed" && activeKnowledge.length) {
          throw new PlatformError("当前仍有排队或运行中的知识任务，不能开始独占向量化。", 409, "ACTIVE_JOBS_PRESENT");
        }
        if (type !== "document.reembed" && activeKnowledge.some((row) => row.type === "document.reembed")) {
          throw new PlatformError("现有分片向量化正在独占运行，请完成任务完成后重试。", 409, "REEMBED_EXCLUSIVE_ACTIVE");
        }
      }
      if (deduplicate) {
        const pending = await this._get(`SELECT * FROM jobs
          WHERE type=? AND payload=? AND status IN ('queued','running') LIMIT 1`, [type, serialized]);
        if (pending) return await this.jobFromRow(pending);
      }
      const jobId = id();
      const timestamp = now();
      await this._run("INSERT INTO jobs(id,type,status,payload,run_after,created_at) VALUES(?,?,'queued',?,?,?)",
        [jobId, type, serialized, timestamp, timestamp]);
      return await this.getJob(jobId);
    });
  }

  async getJob(jobId) { return await this.jobFromRow(await this._get("SELECT * FROM jobs WHERE id=?", [jobId])); }

  async listJobs(limit = 100) {
    return await Promise.all((await this._rows("SELECT * FROM jobs ORDER BY created_at DESC,seq DESC LIMIT ?", [Number(limit)]))
      .map((row) => this.jobFromRow(row)));
  }

  async listActiveJobs(limit = 100) {
    return await Promise.all((await this._rows(`SELECT * FROM jobs WHERE status IN ('queued','running')
      ORDER BY created_at,seq LIMIT ?`, [Number(limit)])).map((row) => this.jobFromRow(row)));
  }

  async countActiveJobs(excludeJobId = null) {
    const row = excludeJobId
      ? await this._get("SELECT COUNT(*) total FROM jobs WHERE status IN ('queued','running') AND id<>?", [excludeJobId])
      : await this._get("SELECT COUNT(*) total FROM jobs WHERE status IN ('queued','running')");
    return number(row?.total);
  }

  async hasActiveJobType(type) {
    return Boolean(await this._get("SELECT 1 found FROM jobs WHERE type=? AND status IN ('queued','running') LIMIT 1", [type]));
  }

  async settleExhaustedJobs(status, documentStatuses, timestamp = now()) {
    if (!["queued", "running"].includes(status)) throw new Error("Invalid exhausted job status");
    const exhausted = await this._rows("SELECT id,type,payload FROM jobs WHERE status=? AND attempts>=max_attempts", [status]);
    if (!exhausted.length) return 0;
    const eligibleIngestKeys = new Set((await this._rows(`SELECT payload FROM jobs
      WHERE type='document.ingest' AND status IN ('queued','running') AND attempts<max_attempts`))
      .map((row) => ingestJobKey(parsedJobPayload(row.payload))).filter(Boolean));
    const allowedDocumentStatuses = new Set(documentStatuses);
    for (const job of exhausted) {
      if (job.type !== "document.ingest") continue;
      const payload = parsedJobPayload(job.payload);
      const key = ingestJobKey(payload);
      if (!key || eligibleIngestKeys.has(key)) continue;
      const document = await this.getEntity("documents", payload.documentId);
      if (!document || document.checksum !== payload.checksum || !allowedDocumentStatuses.has(document.status)) continue;
      await this.saveEntity("documents", { ...document, status: "error", error: EXHAUSTED_DOCUMENT_ERROR, updatedAt: timestamp });
    }
    return number((await this._run(`UPDATE jobs SET status='failed',error=?,finished_at=?
      WHERE status=? AND attempts>=max_attempts`, [EXHAUSTED_JOB_ERROR, timestamp, status])).affectedRows);
  }

  async claimJob() {
    return await this.transaction(async () => {
      const timestamp = now();
      await this.settleExhaustedJobs("queued", ["queued", "processing"], timestamp);
      const row = await this._get(`SELECT id FROM jobs
        WHERE status='queued' AND attempts<max_attempts AND run_after<=?
        ORDER BY created_at,seq LIMIT 1 FOR UPDATE SKIP LOCKED`, [timestamp]);
      if (!row) return null;
      const result = await this._run(`UPDATE jobs SET status='running',started_at=?,finished_at=NULL,
        attempts=attempts+1,progress=0 WHERE id=? AND status='queued'`, [timestamp, row.id]);
      if (number(result.affectedRows) !== 1) return null;
      return await this.getJob(row.id);
    });
  }

  async progressJob(jobId, progress) {
    return await this.transaction(async () => { await this._run("UPDATE jobs SET progress=? WHERE id=?", [progress, jobId]); });
  }

  async finishJob(jobId, result) {
    return await this.transaction(async () => {
      await this._run(`UPDATE jobs SET status='completed',progress=100,result=?,error=NULL,finished_at=? WHERE id=?`,
        [JSON.stringify(result || {}), now(), jobId]);
    });
  }

  async failJob(jobId, error) {
    return await this.transaction(async () => {
      await this._run("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?",
        [String(error).slice(0, 1000), now(), jobId]);
    });
  }

  async retryJob(jobId) {
    return await this.transaction(async () => {
      const job = await this.getJob(jobId);
      if (!job) throw new PlatformError("任务不存在。", 404);
      if (job.status !== "failed") throw new PlatformError("仅失败的任务可以重试。", 409);
      if (["document.ingest", "document.reembed"].includes(job.type)) {
        const documentId = job.payload?.documentId;
        if (typeof documentId !== "string" || !documentId) {
          throw new PlatformError("资料任务载荷无效。", 409, "DOCUMENT_JOB_INVALID");
        }
        const conflict = (await this._rows(`SELECT payload FROM jobs
          WHERE id<>? AND type IN ('document.ingest','document.reembed') AND status IN ('queued','running')`, [job.id]))
          .some((row) => parsedJobPayload(row.payload)?.documentId === documentId);
        if (conflict) throw new PlatformError("该资料已有排队或运行中的处理任务。", 409, "DOCUMENT_JOB_ACTIVE");
      }
      if (KNOWLEDGE_JOB_TYPES.has(job.type)) {
        const activeKnowledge = await this._rows(`SELECT type FROM jobs
          WHERE id<>? AND type IN ('document.ingest','document.reembed','nas.sync')
            AND status IN ('queued','running')`, [job.id]);
        if (job.type === "document.reembed" && activeKnowledge.length) {
          throw new PlatformError("当前仍有排队或运行中的知识任务，不能开始独占向量化。", 409, "ACTIVE_JOBS_PRESENT");
        }
        if (job.type !== "document.reembed" && activeKnowledge.some((row) => row.type === "document.reembed")) {
          throw new PlatformError("现有分片向量化正在独占运行，请完成任务完成后重试。", 409, "REEMBED_EXCLUSIVE_ACTIVE");
        }
      }
      await this._run(`UPDATE jobs SET status='queued',progress=0,attempts=0,run_after=?,started_at=NULL,finished_at=NULL
        WHERE id=?`, [now(), jobId]);
      return await this.getJob(jobId);
    });
  }

  async beginSyncRun(sourceId, jobId) {
    return await this.transaction(async () => {
      const runId = id();
      await this._run("INSERT INTO sync_runs(id,source_id,job_id,status,stats,started_at) VALUES(?,?,?,'running','{}',?)",
        [runId, sourceId, jobId, now()]);
      return runId;
    });
  }

  async finishSyncRun(runId, status, stats, error = null) {
    return await this.transaction(async () => {
      await this._run("UPDATE sync_runs SET status=?,stats=?,error=?,finished_at=? WHERE id=?",
        [status, JSON.stringify(stats), error, now(), runId]);
    });
  }

  async listSyncRuns(limit = 50) {
    return (await this._rows("SELECT * FROM sync_runs ORDER BY started_at DESC,seq DESC LIMIT ?", [Number(limit)]))
      .map((row) => ({
        id: row.id, sourceId: row.source_id, jobId: row.job_id, status: row.status,
        stats: parse(row.stats), error: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
      }));
  }

  async recordUsage({ agentSlug, model = null, retrievalMode = "none", latencyMs = 0, success = true, errorCode = null }) {
    return await this.transaction(async () => {
      await this._run(`INSERT INTO \`usage\`(id,agent_slug,model,retrieval_mode,latency_ms,success,error_code,created_at)
        VALUES(?,?,?,?,?,?,?,?)`, [id(), agentSlug, model, retrievalMode, Math.max(0, Math.round(latencyMs)),
        success ? 1 : 0, errorCode, now()]);
    });
  }

  async overview() {
    const count = async (sql) => number((await this._get(sql))?.total);
    const [agents, publishedAgents, documents, readyDocuments, chunks, content, conversations, failedJobs,
      recentJobs, recentAudit, dailyUsage] = await Promise.all([
      count("SELECT COUNT(*) total FROM agents WHERE status!='archived'"),
      count("SELECT COUNT(*) total FROM agents WHERE status='published'"),
      count("SELECT COUNT(*) total FROM documents WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))!='deleted'"),
      count("SELECT COUNT(*) total FROM documents WHERE JSON_UNQUOTE(JSON_EXTRACT(payload,'$.status'))='ready'"),
      count(`SELECT COUNT(*) total FROM chunks c JOIN documents d ON c.document_id=d.id
        WHERE JSON_UNQUOTE(JSON_EXTRACT(d.payload,'$.status'))='ready'`),
      count("SELECT COUNT(*) total FROM content"), count("SELECT COUNT(*) total FROM `usage`"),
      count("SELECT COUNT(*) total FROM jobs WHERE status='failed'"), this.listJobs(8), this.listAudit(10),
      this._rows(`SELECT LEFT(created_at,10) date,COUNT(*) total,SUM(success) successful FROM \`usage\`
        WHERE created_at>=? GROUP BY LEFT(created_at,10) ORDER BY date`, [new Date(Date.now() - 7 * 86400000).toISOString()]),
    ]);
    return {
      stats: { agents, publishedAgents, documents, readyDocuments, chunks, content, conversations, failedJobs },
      recentJobs,
      recentAudit,
      dailyUsage: dailyUsage.map((row) => ({ date: row.date, total: number(row.total), successful: number(row.successful) })),
    };
  }
}

export { MySQLPlatformDatabase as MySqlPlatformDatabase };

export async function createMySQLPlatformDatabase(options) {
  return await MySQLPlatformDatabase.initialize(options);
}
