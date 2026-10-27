import mysql from "mysql2/promise";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { mysqlTlsEnabled } from "../server/mysql-ssl-policy.mjs";
import {
  MYSQL_SCHEMA_VERSION,
  MYSQL_SCHEMA_MIGRATION_COUNT,
  MYSQL_SCHEMA_MIGRATION_SHA256,
  mysqlSchemaMigrationsSha256,
  validateMySqlBackupSchemaSummary,
  validateMySqlRuntimeSchema,
} from "../server/mysql-database.mjs";

import { backupReleaseBlobReferences } from "./release-backup-references.mjs";
import { verifyPrivateDataDirectories } from "./private-data-backup.mjs";

export class OpsError extends Error {
  constructor(code, { cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "OpsError";
    this.code = code;
  }
}

export function publicFailure(error, fallbackCode) {
  return { ok: false, code: error instanceof OpsError ? error.code : fallbackCode };
}

function postCommitCode(operation, commitAcknowledgement) {
  if (operation === "import") return commitAcknowledgement === "unknown"
    ? "MYSQL_IMPORT_COMMIT_OUTCOME_UNKNOWN" : "MYSQL_IMPORT_POST_COMMIT_VERIFICATION_REQUIRED";
  if (operation === "restore") return commitAcknowledgement === "unknown"
    ? "MYSQL_RESTORE_COMMIT_OUTCOME_UNKNOWN" : "MYSQL_RESTORE_POST_COMMIT_VERIFICATION_REQUIRED";
  throw new OpsError("POST_COMMIT_OPERATION_INVALID");
}

export function postCommitVerificationError({ operation, commitAcknowledgement, commitCause }, verificationCause) {
  if (!["acknowledged", "unknown"].includes(commitAcknowledgement)) {
    throw new OpsError("POST_COMMIT_ACKNOWLEDGEMENT_INVALID");
  }
  const cause = commitCause === undefined ? verificationCause
    : new AggregateError([commitCause, verificationCause], "COMMIT acknowledgement and verification failures");
  return new OpsError(postCommitCode(operation, commitAcknowledgement), { cause });
}

export async function runPostCommitVerification(options, verifier) {
  try { return await verifier(); }
  catch (error) { throw postCommitVerificationError(options, error); }
}

const numeric = (...values) => new Set(values);
const json = (...values) => new Set(values);

export const BUSINESS_TABLES = Object.freeze([
  { name: "analytics_events", primary: ["id"], columns: ["id", "event_type", "agent_slug", "tenant_id", "actor_kind", "actor_hash", "created_at", "test_traffic", "safe_json"], numeric: numeric("test_traffic"), json: json("safe_json"), seq: false },
  { name: "meta", primary: ["key"], columns: ["key", "value"], numeric: numeric(), json: json(), seq: false },
  { name: "agents", primary: ["slug"], columns: ["slug", "draft", "published", "status", "version", "created_at", "updated_at", "published_at"], numeric: numeric("version"), json: json("draft", "published"), seq: true },
  { name: "agent_versions", primary: ["agent_slug", "version"], columns: ["agent_slug", "version", "snapshot", "published_at", "actor"], numeric: numeric("version"), json: json("snapshot"), seq: true },
  { name: "documents", primary: ["id"], columns: ["id", "agent_slug", "payload"], numeric: numeric(), json: json("payload"), seq: true },
  { name: "chunks", primary: ["id"], columns: ["id", "document_id", "agent_slug", "position", "text", "embedding", "embedding_model"], numeric: numeric("position"), json: json("embedding"), seq: true },
  { name: "sources", primary: ["id"], columns: ["id", "agent_slug", "payload"], numeric: numeric(), json: json("payload"), seq: true },
  { name: "content", primary: ["id"], columns: ["id", "agent_slug", "payload"], numeric: numeric(), json: json("payload"), seq: true },
  { name: "jobs", primary: ["id"], columns: ["id", "type", "status", "payload", "result", "error", "progress", "attempts", "max_attempts", "run_after", "created_at", "started_at", "finished_at"], numeric: numeric("progress", "attempts", "max_attempts"), json: json("payload", "result"), seq: true },
  { name: "sync_runs", primary: ["id"], columns: ["id", "source_id", "job_id", "status", "stats", "error", "started_at", "finished_at"], numeric: numeric(), json: json("stats"), seq: true },
  { name: "users", primary: ["id"], columns: ["id", "username", "name", "role", "password_hash", "active", "created_at", "updated_at"], numeric: numeric("active"), json: json(), seq: true },
  { name: "sessions", primary: ["token_hash"], columns: ["token_hash", "user_id", "expires_at"], numeric: numeric(), json: json(), seq: true },
  { name: "audit", primary: ["id"], columns: ["id", "action", "actor", "target", "details", "created_at"], numeric: numeric(), json: json("details"), seq: true },
  { name: "usage", primary: ["id"], columns: ["id", "agent_slug", "model", "retrieval_mode", "latency_ms", "success", "error_code", "created_at"], numeric: numeric("latency_ms", "success"), json: json(), seq: true },
  { name: "consumer_users", primary: ["id"], columns: ["id", "app_id", "open_id", "display_name", "created_at", "updated_at"], numeric: numeric(), json: json(), seq: false },
  { name: "consumer_sessions", primary: ["token_hash"], columns: ["token_hash", "user_id", "expires_at", "created_at"], numeric: numeric(), json: json(), seq: false },
  { name: "consumer_login_requests", primary: ["id"], columns: ["id", "session_hash", "bridge_hash", "status", "user_id", "return_path", "expires_at", "created_at"], numeric: numeric(), json: json(), seq: false },
  { name: "consumer_login_codes", primary: ["code_hash"], columns: ["code_hash", "expires_at"], numeric: numeric(), json: json(), seq: false },
  { name: "consumer_documents", primary: ["user_id", "agent_slug", "section"], columns: ["user_id", "agent_slug", "section", "value_json", "revision", "updated_at"], numeric: numeric("revision"), json: json("value_json"), seq: false },
]);

const specsForVersion = version => BUSINESS_TABLES.filter(spec => (Number(version) >= 3 || spec.name !== "analytics_events") && (Number(version) >= 2 || !spec.name.startsWith("consumer_")));
const validSchemaVersion = version => /^[1-9]\d*$/.test(String(version)) && Number(version) <= MYSQL_SCHEMA_VERSION;
const TABLE_BY_NAME = new Map(BUSINESS_TABLES.map((spec) => [spec.name, spec]));
const STORAGE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}$/;
const SQLITE_INTERNAL_TABLE = /^sqlite_(?:sequence|stat[1-4])$/u;

const quote = (identifier) => `\`${identifier}\``;
const sqliteQuote = (identifier) => `"${identifier}"`;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function fixedError(code) { throw new OpsError(code); }

function privateRegularFile(filename, code) {
  let entry;
  try { entry = lstatSync(filename); }
  catch { fixedError(code); }
  if (!entry.isFile() || entry.isSymbolicLink()) fixedError(code);
  return entry;
}

function privateDirectory(directory, code) {
  let entry;
  try { entry = lstatSync(directory); }
  catch { fixedError(code); }
  if (!entry.isDirectory() || entry.isSymbolicLink()) fixedError(code);
  return realpathSync(directory);
}

function childPath(parent, name, kind, code) {
  const target = path.join(parent, name);
  let entry;
  try { entry = kind === "file" ? privateRegularFile(target, code) : lstatSync(target); }
  catch (error) { if (error instanceof OpsError) throw error; fixedError(code); }
  if (kind === "directory" && (!entry.isDirectory() || entry.isSymbolicLink())) fixedError(code);
  let resolved;
  try { resolved = realpathSync(target); }
  catch { fixedError(code); }
  if (path.dirname(resolved) !== parent || path.basename(resolved) !== name) fixedError(code);
  return resolved;
}

function decodeUrlPart(value, code) {
  try { return decodeURIComponent(value); }
  catch { fixedError(code); }
}

export function mysqlOptionsFromEnvironment(environment = process.env, overrides = {}) {
  const raw = environment.DATABASE_URL;
  if (typeof raw !== "string" || !raw || raw.trim() !== raw || /\s/u.test(raw)) fixedError("DATABASE_URL_INVALID");
  let parsed;
  try { parsed = new URL(raw); }
  catch { fixedError("DATABASE_URL_INVALID"); }
  if (parsed.protocol !== "mysql:" || !parsed.hostname || !parsed.username || !parsed.password
    || parsed.search || parsed.hash) fixedError("DATABASE_URL_INVALID");
  const database = decodeUrlPart(parsed.pathname.replace(/^\//u, ""), "DATABASE_URL_INVALID");
  const user = decodeUrlPart(parsed.username, "DATABASE_URL_INVALID");
  const password = decodeUrlPart(parsed.password, "DATABASE_URL_INVALID");
  if (!database || database.includes("/") || !user || !password) fixedError("DATABASE_URL_INVALID");
  const port = parsed.port ? Number(parsed.port) : 3306;
  if (!Number.isInteger(port) || port < 1 || port > 65535) fixedError("DATABASE_URL_INVALID");

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let tlsEnabled;
  try { tlsEnabled = mysqlTlsEnabled(environment, hostname); }
  catch { fixedError("MYSQL_SSL_MODE_INVALID"); }
  const caFilename = String(environment.MYSQL_SSL_CA_FILE || "").trim();
  if (tlsEnabled && !caFilename) fixedError("MYSQL_TLS_REQUIRED");
  let ssl;
  if (tlsEnabled) {
    if (!path.isAbsolute(caFilename)) fixedError("MYSQL_CA_FILE_INVALID");
    privateRegularFile(caFilename, "MYSQL_CA_FILE_INVALID");
    let ca;
    try { ca = readFileSync(caFilename, "utf8"); }
    catch { fixedError("MYSQL_CA_FILE_INVALID"); }
    if (!ca.trim()) fixedError("MYSQL_CA_FILE_INVALID");
    ssl = { ca, rejectUnauthorized: true, servername: hostname };
  }
  const connectionLimit = Number.isSafeInteger(overrides.connectionLimit) && overrides.connectionLimit > 0
    ? Math.min(16, overrides.connectionLimit) : 4;
  const connectTimeout = Number.isSafeInteger(overrides.connectTimeout) && overrides.connectTimeout >= 1_000
    ? Math.min(60_000, overrides.connectTimeout) : 10_000;
  return {
    host: hostname, port, user, password, database,
    charset: "utf8mb4_bin", timezone: "Z", dateStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false,
    waitForConnections: true, connectionLimit, queueLimit: 0, connectTimeout,
    enableKeepAlive: true, keepAliveInitialDelay: 0,
    ssl,
  };
}

export function createMySqlPool(environment = process.env, overrides = {}) {
  const options = mysqlOptionsFromEnvironment(environment, overrides);
  return { pool: mysql.createPool(options), databaseName: options.database };
}

export function mysqlLockNames(databaseName) {
  const namespace = sha256(String(databaseName)).slice(0, 32);
  return {
    instance: `medtalent:${namespace}:instance`,
    migration: `medtalent:${namespace}:sqlite-import`,
    restore: `medtalent:${namespace}:logical-restore`,
  };
}

export async function acquireNamedLock(connection, name) {
  const [rows] = await connection.execute("SELECT GET_LOCK(?,0) acquired", [name]);
  if (Number(rows[0]?.acquired) !== 1) fixedError("MYSQL_OPERATION_LOCKED");
}

export async function releaseNamedLock(connection, name) {
  try { await connection.execute("SELECT RELEASE_LOCK(?) released", [name]); } catch { /* connection close releases it */ }
}

export async function assertTargetDatabaseEmpty(executor) {
  const [rows] = await executor.query(`SELECT table_name AS table_name FROM information_schema.tables
    WHERE table_schema=DATABASE() LIMIT 1`);
  if (rows.length) fixedError("MYSQL_TARGET_NOT_EMPTY");
}

function normalizeInteger(value) {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)$/u.test(value)) return BigInt(value).toString();
  fixedError("DATABASE_INTEGER_INVALID");
}

function normalizeCell(spec, column, value) {
  if (value === null || value === undefined) return null;
  if (spec.numeric.has(column)) return normalizeInteger(value);
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  fixedError("DATABASE_TEXT_INVALID");
}

function lengthPrefix(length) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

function updateValue(hash, value, numericValue = false) {
  if (value === null) {
    hash.update(Buffer.from([0]));
    return;
  }
  const bytes = Buffer.from(value, "utf8");
  hash.update(Buffer.from([numericValue ? 1 : 2]));
  hash.update(lengthPrefix(bytes.length));
  hash.update(bytes);
}

function newTableAccumulator(spec) {
  return {
    spec, rows: 0, rowHash: createHash("sha256"), seqHash: createHash("sha256"), jsonInvalid: 0,
    seqMin: null, seqMax: null, seqInvalid: 0,
  };
}

function addTableRow(accumulator, rawRow) {
  const { spec } = accumulator;
  accumulator.rows += 1;
  accumulator.rowHash.update(Buffer.from([0x52]));
  const row = {};
  if (spec.seq) {
    row.seq = normalizeInteger(rawRow.seq);
    const sequence = BigInt(row.seq);
    if (sequence < 1n) accumulator.seqInvalid += 1;
    if (accumulator.seqMin === null || sequence < accumulator.seqMin) accumulator.seqMin = sequence;
    if (accumulator.seqMax === null || sequence > accumulator.seqMax) accumulator.seqMax = sequence;
  }
  for (const column of spec.columns) {
    const value = normalizeCell(spec, column, rawRow[column]);
    row[column] = value;
    updateValue(accumulator.rowHash, value, spec.numeric.has(column));
    if (value !== null && spec.json.has(column)) {
      try { JSON.parse(value); } catch { accumulator.jsonInvalid += 1; }
    }
  }
  if (spec.seq) {
    accumulator.seqHash.update(Buffer.from([0x53]));
    updateValue(accumulator.seqHash, row.seq, true);
    for (const column of spec.primary) updateValue(accumulator.seqHash, row[column], spec.numeric.has(column));
  }
  return row;
}

function finishTableAccumulator(accumulator) {
  return {
    rows: accumulator.rows,
    sha256: accumulator.rowHash.digest("hex"),
    seqSha256: accumulator.spec.seq ? accumulator.seqHash.digest("hex") : null,
    seqMin: accumulator.spec.seq && accumulator.seqMin !== null ? accumulator.seqMin.toString() : null,
    seqMax: accumulator.spec.seq && accumulator.seqMax !== null ? accumulator.seqMax.toString() : null,
    seqInvalid: accumulator.spec.seq ? accumulator.seqInvalid : 0,
    jsonInvalid: accumulator.jsonInvalid,
  };
}

function parseJson(value) {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return undefined; }
}

function newInspectionState(expectedEmbeddingDimensions) {
  return {
    agents: new Set(), users: new Set(), consumerUsers: new Set(), documents: new Map(), chunkCounts: new Map(), blobReferences: new Map(),
    foreignKeyViolations: 0, payloadIdentityMismatches: 0, chunkCountMismatches: 0,
    invalidStorageReferences: 0, activeJobs: 0, runningSyncRuns: 0, autoPublishSources: 0,
    vectors: { rows: 0, dimensions: {}, invalid: 0, normalizationFailures: 0, modelPresenceMismatches: 0, expectedDimensionMismatches: 0 },
    expectedEmbeddingDimensions: Number.isSafeInteger(expectedEmbeddingDimensions) && expectedEmbeddingDimensions > 0
      ? expectedEmbeddingDimensions : null,
    deferredSessions: [], releaseMetaRows: [], privateDataDirectory: null,
    dataSchemaVersion: null,
  };
}

function observeRow(state, spec, row) {
  if (spec.name === "meta") {
    if (row.key === "schema_version") state.dataSchemaVersion = row.value;
    state.releaseMetaRows.push({ key: row.key, value: row.value });
  } else if (spec.name === "agents") state.agents.add(row.slug);
  else if (spec.name === "agent_versions") {
    if (!state.agents.has(row.agent_slug)) state.foreignKeyViolations += 1;
  } else if (spec.name === "documents") {
    const payload = parseJson(row.payload);
    if (!state.agents.has(row.agent_slug)) state.foreignKeyViolations += 1;
    if (!payload || payload.id !== row.id || payload.agentSlug !== row.agent_slug) state.payloadIdentityMismatches += 1;
    state.documents.set(row.id, { agentSlug: row.agent_slug, payload });
    if (payload && payload.status !== "deleted") {
      const key = payload.storageKey;
      const size = payload.size;
      const checksum = payload.checksum;
      if (typeof key !== "string" || !STORAGE_KEY.test(key) || !Number.isSafeInteger(size) || size < 0
        || typeof checksum !== "string" || !SHA256.test(checksum)) {
        state.invalidStorageReferences += 1;
      } else {
        const existing = state.blobReferences.get(key);
        if (existing && (existing.size !== size || existing.checksum !== checksum.toLowerCase())) {
          state.invalidStorageReferences += 1;
        } else state.blobReferences.set(key, { size, checksum: checksum.toLowerCase() });
      }
    }
  } else if (spec.name === "chunks") {
    const document = state.documents.get(row.document_id);
    if (!document || !state.agents.has(row.agent_slug) || document?.agentSlug !== row.agent_slug) state.foreignKeyViolations += 1;
    state.chunkCounts.set(row.document_id, (state.chunkCounts.get(row.document_id) || 0) + 1);
    const vector = parseJson(row.embedding);
    if ((row.embedding === null) !== (row.embedding_model === null)) state.vectors.modelPresenceMismatches += 1;
    if (row.embedding !== null) {
      state.vectors.rows += 1;
      if (!Array.isArray(vector) || vector.length < 1 || vector.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
        state.vectors.invalid += 1;
      } else {
        const dimension = String(vector.length);
        state.vectors.dimensions[dimension] = (state.vectors.dimensions[dimension] || 0) + 1;
        if (state.expectedEmbeddingDimensions && vector.length !== state.expectedEmbeddingDimensions) {
          state.vectors.expectedDimensionMismatches += 1;
        }
        const norm = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0));
        if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) state.vectors.normalizationFailures += 1;
      }
    }
  } else if (spec.name === "sources") {
    const payload = parseJson(row.payload);
    if (!state.agents.has(row.agent_slug)) state.foreignKeyViolations += 1;
    if (!payload || payload.id !== row.id || payload.agentSlug !== row.agent_slug) state.payloadIdentityMismatches += 1;
    if (payload?.autoPublish === true) state.autoPublishSources += 1;
  } else if (spec.name === "content") {
    const payload = parseJson(row.payload);
    if (!state.agents.has(row.agent_slug)) state.foreignKeyViolations += 1;
    if (!payload || payload.id !== row.id || payload.agentSlug !== row.agent_slug) state.payloadIdentityMismatches += 1;
  } else if (spec.name === "jobs") {
    if (["queued", "running"].includes(row.status)) state.activeJobs += 1;
  } else if (spec.name === "sync_runs") {
    if (row.status === "running") state.runningSyncRuns += 1;
  } else if (spec.name === "users") state.users.add(row.id);
  else if (spec.name === "sessions") state.deferredSessions.push(row.user_id);
  else if (spec.name === "consumer_users") state.consumerUsers.add(row.id);
  else if (["consumer_sessions", "consumer_login_requests"].includes(spec.name)) {
    if (row.user_id !== null && !state.consumerUsers.has(row.user_id)) state.foreignKeyViolations += 1;
  } else if (spec.name === "consumer_documents") {
    if (!state.consumerUsers.has(row.user_id)) state.foreignKeyViolations += 1;
    if (!state.agents.has(row.agent_slug)) state.foreignKeyViolations += 1;
  }
  else if (spec.name === "usage" && !state.agents.has(row.agent_slug)) {
    // SQLite intentionally has no FK here; report it separately without changing declared-FK validity.
    state.usageAgentOrphans = (state.usageAgentOrphans || 0) + 1;
  }
}

function finishInspectionState(state) {
  const releaseBlobs = backupReleaseBlobReferences(state.releaseMetaRows, state.privateDataDirectory);
  for (const [key, expected] of releaseBlobs.references) {
    const existing = state.blobReferences.get(key);
    if (existing && (existing.size !== expected.size || existing.checksum !== expected.checksum)) state.invalidStorageReferences += 1;
    else state.blobReferences.set(key, expected);
  }
  for (const userId of state.deferredSessions) if (!state.users.has(userId)) state.foreignKeyViolations += 1;
  for (const [documentId, document] of state.documents) {
    const expected = document.payload?.chunkCount;
    const actual = state.chunkCounts.get(documentId) || 0;
    if (!Number.isSafeInteger(expected) || expected !== actual) state.chunkCountMismatches += 1;
  }
  const vectors = {
    ...state.vectors,
    dimensions: Object.fromEntries(Object.entries(state.vectors.dimensions).sort(([left], [right]) => Number(left) - Number(right))),
  };
  return {
    invariants: {
      foreignKeyViolations: state.foreignKeyViolations,
      payloadIdentityMismatches: state.payloadIdentityMismatches,
      chunkCountMismatches: state.chunkCountMismatches,
      invalidStorageReferences: state.invalidStorageReferences,
      usageAgentOrphans: state.usageAgentOrphans || 0,
    },
    activity: {
      activeJobs: state.activeJobs,
      runningSyncRuns: state.runningSyncRuns,
      autoPublishSources: state.autoPublishSources,
    },
    vectors,
    dataSchemaVersion: state.dataSchemaVersion,
    blobReferences: state.blobReferences,
  };
}

function aggregateTables(tableReports) {
  const hash = createHash("sha256");
  for (const spec of BUSINESS_TABLES) {
    const report = tableReports[spec.name];
    if (!report) continue;
    hash.update(`${spec.name}\0${report.rows}\0${report.sha256}\0${report.seqSha256 || ""}\n`, "utf8");
  }
  return hash.digest("hex");
}

function sourcePaths(sourceDirectory) {
  const root = privateDirectory(path.resolve(sourceDirectory), "SQLITE_SOURCE_DIRECTORY_INVALID");
  const manifestPath = childPath(root, "manifest.json", "file", "SQLITE_SOURCE_MANIFEST_INVALID");
  const databasePath = childPath(root, "platform.sqlite", "file", "SQLITE_SOURCE_DATABASE_INVALID");
  const uploadDirectory = childPath(root, "uploads", "directory", "SQLITE_SOURCE_UPLOADS_INVALID");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { fixedError("SQLITE_SOURCE_MANIFEST_INVALID"); }
  if (manifest?.version !== 1 || manifest.completed !== true || manifest.database !== "platform.sqlite"
    || !Number.isSafeInteger(manifest.documents) || manifest.documents < 0
    || !Number.isSafeInteger(manifest.blobs) || manifest.blobs < 0) fixedError("SQLITE_SOURCE_MANIFEST_INVALID");
  return { root, manifest, databasePath, uploadDirectory };
}

function sqliteRows(database, spec) {
  if ((spec.name === "analytics_events" || spec.name.startsWith("consumer_")) && !database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(spec.name)) return [];
  const selected = [...(spec.seq ? ["rowid AS seq"] : []), ...spec.columns.map(sqliteQuote)].join(",");
  const order = spec.seq ? "rowid" : spec.primary.map(column => `CAST(${sqliteQuote(column)} AS BLOB)`).join(",");
  return database.prepare(`SELECT ${selected} FROM ${sqliteQuote(spec.name)} ORDER BY ${order}`).iterate();
}

function inspectSqliteSchemaInventory(database) {
  const objects = database.prepare(`SELECT type AS type,name AS name,tbl_name AS table_name
    FROM sqlite_schema ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,name`).all();
  const version = database.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value;
  if (!validSchemaVersion(version)) fixedError("SQLITE_SCHEMA_VERSION_UNSUPPORTED");
  const specs = specsForVersion(version);
  const expectedTables = new Set(specs.map((spec) => spec.name));
  const seenTables = new Set();
  let indexes = 0;
  let internalObjects = 0;
  for (const object of objects) {
    const type = String(object.type || "");
    const name = String(object.name || "");
    const tableName = String(object.table_name || "");
    const internalTable = SQLITE_INTERNAL_TABLE.test(tableName);
    if (type === "table") {
      if (expectedTables.has(name)) seenTables.add(name);
      else if (SQLITE_INTERNAL_TABLE.test(name)) internalObjects += 1;
      else fixedError("SQLITE_SCHEMA_UNKNOWN_TABLE");
    } else if (type === "index") {
      if (!expectedTables.has(tableName) && !internalTable) fixedError("SQLITE_SCHEMA_UNKNOWN_OBJECT");
      indexes += 1;
    } else if (type === "view" || type === "trigger") {
      fixedError("SQLITE_SCHEMA_FORBIDDEN_OBJECT");
    } else fixedError("SQLITE_SCHEMA_UNKNOWN_OBJECT");
  }
  if (seenTables.size !== expectedTables.size
    || [...expectedTables].some((name) => !seenTables.has(name))) fixedError("SQLITE_SCHEMA_TABLE_SET_MISMATCH");
  for (const spec of specs) {
    const columns = database.prepare(`PRAGMA table_xinfo(${sqliteQuote(spec.name)})`).all();
    const actual = columns.map((column) => String(column.name));
    if (stableJson(actual) !== stableJson(spec.columns)
      || columns.some((column) => Number(column.hidden || 0) !== 0)) {
      fixedError("SQLITE_SCHEMA_COLUMNS_MISMATCH");
    }
  }
  return { validated: true, tables: seenTables.size, indexes, internalObjects };
}

export function inspectSqliteSnapshot(sourceDirectory, { expectedEmbeddingDimensions } = {}) {
  const paths = sourcePaths(sourceDirectory);
  let database;
  try { database = new DatabaseSync(paths.databasePath, { readOnly: true }); }
  catch { fixedError("SQLITE_SOURCE_READ_FAILED"); }
  const state = newInspectionState(expectedEmbeddingDimensions);
  state.privateDataDirectory = paths.root;
  const tables = {};
  let integrityOk = false;
  let pragmaForeignKeyViolations = -1;
  let schemaInventory;
  let upgradedMeta;
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    schemaInventory = inspectSqliteSchemaInventory(database);
    const integrity = database.prepare("PRAGMA integrity_check").all().map((row) => Object.values(row)[0]);
    integrityOk = integrity.length === 1 && integrity[0] === "ok";
    pragmaForeignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    for (const spec of specsForVersion(database.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value)) {
      const accumulator = newTableAccumulator(spec);
      const upgraded = spec.name === "meta" ? newTableAccumulator(spec) : null;
      for (const rawRow of sqliteRows(database, spec)) {
        observeRow(state, spec, addTableRow(accumulator, rawRow));
        if (upgraded) addTableRow(upgraded, rawRow.key === "schema_version" ? { ...rawRow, value: String(MYSQL_SCHEMA_VERSION) } : rawRow);
      }
      tables[spec.name] = finishTableAccumulator(accumulator);
      if (upgraded) upgradedMeta = finishTableAccumulator(upgraded);
    }
  } catch (error) {
    if (error instanceof OpsError) throw error;
    fixedError("SQLITE_SOURCE_READ_FAILED");
  }
  finally { database.close(); }
  const finished = finishInspectionState(state);
  const jsonInvalid = Object.values(tables).reduce((sum, table) => sum + table.jsonInvalid, 0);
  const manifestMatches = paths.manifest.documents === tables.documents.rows
    && paths.manifest.blobs === finished.blobReferences.size;
  return {
    report: {
      backend: "SQLite", integrityOk, manifestMatches, tables,
      aggregateSha256: aggregateTables(tables), jsonInvalid,
      schemaInventory, upgradedMeta,
      databaseForeignKeyViolations: Math.max(0, pragmaForeignKeyViolations),
      dataSchemaVersion: finished.dataSchemaVersion,
      invariants: finished.invariants, activity: finished.activity, vectors: finished.vectors,
    },
    internal: { ...paths, blobReferences: finished.blobReferences },
  };
}

function mysqlSelect(spec, cursor, pageSize) {
  const selected = [...(spec.seq ? [quote("seq")] : []), ...spec.columns.map(quote)].join(",");
  if (!spec.seq) return { sql: `SELECT ${selected} FROM ${quote(spec.name)} ORDER BY ${spec.primary.map(column => `BINARY ${quote(column)}`).join(",")}`, params: [] };
  return {
    sql: `SELECT ${selected} FROM ${quote(spec.name)} WHERE ${quote("seq")}>? ORDER BY ${quote("seq")} LIMIT ?`,
    params: [cursor, pageSize],
  };
}

export async function inspectMySql(executor, { expectedEmbeddingDimensions, pageSize = 200, pageVisitor, privateDataDirectory } = {}) {
  const runtimeSchema = await validateMySqlRuntimeSchema(executor);
  const [existingRows] = await executor.query(`SELECT table_name AS table_name FROM information_schema.tables
    WHERE table_schema=DATABASE()`);
  const existing = new Set(existingRows.map((row) => row.table_name));
  const missing = BUSINESS_TABLES.map((spec) => spec.name).filter((name) => !existing.has(name));
  if (missing.length) fixedError("MYSQL_SCHEMA_INCOMPLETE");

  const state = newInspectionState(expectedEmbeddingDimensions);
  const tables = {};
  state.privateDataDirectory = privateDataDirectory;
  const normalizedPageSize = Math.max(1, Math.min(1000, Number(pageSize) || 200));
  for (const spec of BUSINESS_TABLES) {
    const accumulator = newTableAccumulator(spec);
    let cursor = "0";
    let finished = false;
    while (!finished) {
      const query = mysqlSelect(spec, cursor, normalizedPageSize);
      const [rawRows] = await executor.execute(query.sql, query.params);
      for (const rawRow of rawRows) observeRow(state, spec, addTableRow(accumulator, rawRow));
      await pageVisitor?.(spec, rawRows.map((rawRow) => {
        const row = {};
        if (spec.seq) row.seq = normalizeInteger(rawRow.seq);
        for (const column of spec.columns) row[column] = normalizeCell(spec, column, rawRow[column]);
        return row;
      }));
      if (!spec.seq || rawRows.length === 0) finished = true;
      else {
        cursor = normalizeInteger(rawRows.at(-1).seq);
        if (rawRows.length < normalizedPageSize) finished = true;
      }
    }
    tables[spec.name] = finishTableAccumulator(accumulator);
  }
  const stateReport = finishInspectionState(state);
  const [migrationRows] = existing.has("schema_migrations")
    ? await executor.query("SELECT version,checksum FROM schema_migrations ORDER BY version") : [[]];
  const schemaMigrationsSha256 = mysqlSchemaMigrationsSha256(migrationRows);
  return {
    report: {
      backend: "MySQL", integrityOk: true, tables, aggregateSha256: aggregateTables(tables),
      jsonInvalid: Object.values(tables).reduce((sum, table) => sum + table.jsonInvalid, 0),
      runtimeSchemaValidated: true, runtimeSchemaVersion: runtimeSchema.version,
      dataSchemaVersion: stateReport.dataSchemaVersion,
      schemaMigrationCount: migrationRows.length, schemaMigrationsSha256,
      invariants: stateReport.invariants, activity: stateReport.activity, vectors: stateReport.vectors,
    },
    internal: { blobReferences: stateReport.blobReferences },
  };
}

function logicalBackupPaths(sourceDirectory) {
  const root = privateDirectory(path.resolve(sourceDirectory), "MYSQL_BACKUP_DIRECTORY_INVALID");
  const manifestPath = childPath(root, "manifest.json", "file", "MYSQL_BACKUP_MANIFEST_INVALID");
  const mysqlDirectory = childPath(root, "mysql", "directory", "MYSQL_BACKUP_DATA_INVALID");
  const uploadDirectory = childPath(root, "uploads", "directory", "MYSQL_BACKUP_UPLOADS_INVALID");
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch { fixedError("MYSQL_BACKUP_MANIFEST_INVALID"); }
  const backupSpecs = specsForVersion(manifest?.runtimeSchemaVersion);
  const tableNames = backupSpecs.map((spec) => spec.name).sort();
  if (manifest?.version !== 2 || manifest.completed !== true || manifest.restorable !== true || manifest.backend !== "mysql"
    || manifest.kind !== "logical-export-v1" || !manifest.tables || !manifest.files
    || stableJson(Object.keys(manifest.tables).sort()) !== stableJson(tableNames)
    || stableJson(Object.keys(manifest.files).sort()) !== stableJson(tableNames)
    || !Number.isSafeInteger(manifest.schemaMigrationCount) || manifest.schemaMigrationCount < 1
    || typeof manifest.schemaMigrationsSha256 !== "string" || !SHA256.test(manifest.schemaMigrationsSha256)
    || manifest.runtimeSchemaValidated !== true || !Number.isSafeInteger(manifest.runtimeSchemaVersion)
    || manifest.runtimeSchemaVersion < 1 || typeof manifest.dataSchemaVersion !== "string"
    || !manifest.invariants || !manifest.activity || !manifest.vectors
    || !manifest.blobs || manifest.blobs.verified !== true) fixedError("MYSQL_BACKUP_MANIFEST_INVALID");
  try {
    validateMySqlBackupSchemaSummary({
      count: manifest.schemaMigrationCount,
      sha256: manifest.schemaMigrationsSha256,
      version: manifest.runtimeSchemaVersion,
    });
  } catch { fixedError("MYSQL_BACKUP_SCHEMA_INCOMPATIBLE"); }
  const entries = readdirSync(mysqlDirectory, { withFileTypes: true });
  const expectedFiles = new Set(backupSpecs.map((spec) => `${spec.name}.ndjson`));
  if (entries.length !== expectedFiles.size || entries.some((entry) => !expectedFiles.has(entry.name)
    || !entry.isFile() || entry.isSymbolicLink())) fixedError("MYSQL_BACKUP_DATA_INVALID");
  const tableFiles = new Map();
  for (const spec of backupSpecs) {
    const file = manifest.files[spec.name];
    if (file?.file !== `mysql/${spec.name}.ndjson` || !Number.isSafeInteger(file.rows) || file.rows < 0
      || typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) fixedError("MYSQL_BACKUP_MANIFEST_INVALID");
    tableFiles.set(spec.name, childPath(mysqlDirectory, `${spec.name}.ndjson`, "file", "MYSQL_BACKUP_DATA_INVALID"));
  }
  return { root, manifest, manifestPath, mysqlDirectory, uploadDirectory, tableFiles, backupSpecs };
}

async function readLogicalRows(filename, spec, visitor) {
  const expectedKeys = [...(spec.seq ? ["seq"] : []), ...spec.columns].sort();
  const input = createReadStream(filename, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lastSequence = null;
  try {
    for await (const line of lines) {
      if (!line) fixedError("MYSQL_BACKUP_DATA_INVALID");
      let rawRow;
      try { rawRow = JSON.parse(line); } catch { fixedError("MYSQL_BACKUP_DATA_INVALID"); }
      if (!rawRow || Array.isArray(rawRow) || typeof rawRow !== "object"
        || stableJson(Object.keys(rawRow).sort()) !== stableJson(expectedKeys)) fixedError("MYSQL_BACKUP_DATA_INVALID");
      const row = normalizedImportRow(spec, rawRow);
      if (spec.seq) {
        const sequence = BigInt(row.seq);
        if (lastSequence !== null && sequence <= lastSequence) fixedError("MYSQL_BACKUP_DATA_INVALID");
        lastSequence = sequence;
      }
      await visitor(row);
    }
  } catch (error) {
    if (error instanceof OpsError) throw error;
    fixedError("MYSQL_BACKUP_DATA_INVALID");
  } finally { lines.close(); }
}

export async function inspectMySqlLogicalBackup(sourceDirectory, { expectedEmbeddingDimensions } = {}) {
  const paths = logicalBackupPaths(sourceDirectory);
  const privateFiles = await verifyPrivateDataDirectories(paths.root, paths.manifest.privateFiles);
  let upgradedMeta;
  const state = newInspectionState(expectedEmbeddingDimensions);
  state.privateDataDirectory = paths.root;
  const tables = {};
  for (const spec of paths.backupSpecs) {
    const filename = paths.tableFiles.get(spec.name);
    const beforeDigest = await fileSha256(filename);
    if (beforeDigest !== paths.manifest.files[spec.name].sha256) fixedError("MYSQL_BACKUP_FILE_HASH_MISMATCH");
    const accumulator = newTableAccumulator(spec);
    const upgraded = spec.name === "meta" ? newTableAccumulator(spec) : null;
    await readLogicalRows(filename, spec, async (row) => {
      observeRow(state, spec, addTableRow(accumulator, row));
      if (upgraded) addTableRow(upgraded, row.key === "schema_version" ? { ...row, value: String(MYSQL_SCHEMA_VERSION) } : row);
    });
    if (upgraded) upgradedMeta = finishTableAccumulator(upgraded);
    tables[spec.name] = finishTableAccumulator(accumulator);
    const afterDigest = await fileSha256(filename);
    if (afterDigest !== beforeDigest) fixedError("MYSQL_BACKUP_FILE_CHANGED");
    if (paths.manifest.files[spec.name].rows !== tables[spec.name].rows
      || stableJson(paths.manifest.tables[spec.name]) !== stableJson(tables[spec.name])) {
      fixedError("MYSQL_BACKUP_TABLE_SUMMARY_MISMATCH");
    }
  }
  const stateReport = finishInspectionState(state);
  const aggregateSha256 = aggregateTables(tables);
  const jsonInvalid = Object.values(tables).reduce((sum, table) => sum + table.jsonInvalid, 0);
  const manifestMatches = aggregateSha256 === paths.manifest.aggregateSha256
    && jsonInvalid === paths.manifest.jsonInvalid
    && stableJson(stateReport.invariants) === stableJson(paths.manifest.invariants)
    && stableJson(stateReport.activity) === stableJson(paths.manifest.activity)
    && stableJson(stateReport.vectors) === stableJson(paths.manifest.vectors)
    && stateReport.dataSchemaVersion === paths.manifest.dataSchemaVersion;
  if (!manifestMatches) fixedError("MYSQL_BACKUP_SUMMARY_MISMATCH");
  return {
    report: {
      backend: "MySQL", integrityOk: true, manifestMatches: true, tables, aggregateSha256, jsonInvalid, upgradedMeta, privateFiles,
      databaseForeignKeyViolations: stateReport.invariants.foreignKeyViolations,
      runtimeSchemaValidated: true, runtimeSchemaVersion: paths.manifest.runtimeSchemaVersion,
      dataSchemaVersion: stateReport.dataSchemaVersion,
      schemaMigrationCount: paths.manifest.schemaMigrationCount,
      schemaMigrationsSha256: paths.manifest.schemaMigrationsSha256,
      invariants: stateReport.invariants, activity: stateReport.activity, vectors: stateReport.vectors,
    },
    internal: { ...paths, blobReferences: stateReport.blobReferences },
  };
}

export async function visitMySqlLogicalBackupRows(backupInternal, visitor) {
  for (const spec of backupInternal.backupSpecs || BUSINESS_TABLES) {
    await readLogicalRows(backupInternal.tableFiles.get(spec.name), spec,
      async (row) => await visitor(spec, row));
  }
}

async function fileSha256(filename) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function verifyBlobDirectory(directory, references, { allowExtras = false } = {}) {
  const root = privateDirectory(path.resolve(directory), "BLOB_DIRECTORY_INVALID");
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); }
  catch { fixedError("BLOB_DIRECTORY_INVALID"); }
  const names = new Set();
  let unexpected = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !STORAGE_KEY.test(entry.name)) unexpected += 1;
    else names.add(entry.name);
  }
  let missing = 0;
  let sizeMismatches = 0;
  let checksumMismatches = 0;
  const manifestHash = createHash("sha256");
  for (const [key, expected] of [...references.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const filename = path.join(root, key);
    if (!names.has(key)) { missing += 1; continue; }
    let entry;
    try { entry = privateRegularFile(filename, "BLOB_FILE_INVALID"); }
    catch { unexpected += 1; continue; }
    const resolved = realpathSync(filename);
    if (path.dirname(resolved) !== root) { unexpected += 1; continue; }
    const actualHash = await fileSha256(resolved);
    if (entry.size !== expected.size) sizeMismatches += 1;
    if (actualHash !== expected.checksum) checksumMismatches += 1;
    manifestHash.update(`${key}\0${entry.size}\0${actualHash}\n`, "utf8");
  }
  const extra = [...names].filter((name) => !references.has(name)).length;
  const report = {
    referenced: references.size, files: names.size, missing, extra, unexpected,
    sizeMismatches, checksumMismatches, manifestSha256: manifestHash.digest("hex"),
  };
  report.verified = missing === 0 && (allowExtras || extra === 0) && unexpected === 0
    && sizeMismatches === 0 && checksumMismatches === 0
    && (allowExtras || names.size === references.size);
  return report;
}

export function blobReportMatches(expected, actual) {
  const fields = ["referenced", "files", "missing", "extra", "unexpected", "sizeMismatches",
    "checksumMismatches", "manifestSha256", "verified"];
  return fields.every((field) => expected?.[field] === actual?.[field]);
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stableObject(value[key])]));
  return value;
}

const stableJson = (value) => JSON.stringify(stableObject(value));

export function snapshotIsRestoreReady(snapshot, blobReport) {
  const invariantFailures = Object.values(snapshot.invariants).reduce((sum, value) => sum + Number(value || 0), 0);
  const invalidSequences = Object.values(snapshot.tables).reduce((sum, table) => sum + Number(table.seqInvalid || 0), 0);
  return snapshot.integrityOk === true && snapshot.manifestMatches !== false && snapshot.jsonInvalid === 0
    && validSchemaVersion(snapshot.dataSchemaVersion)
    && (snapshot.backend !== "SQLite" || snapshot.schemaInventory?.validated === true)
    && (snapshot.backend !== "MySQL" || snapshot.runtimeSchemaValidated === true)
    && (snapshot.backend !== "MySQL" || snapshot.runtimeSchemaVersion === Number(snapshot.dataSchemaVersion))
    && Number(snapshot.databaseForeignKeyViolations || 0) === 0 && invalidSequences === 0
    && invariantFailures === 0 && snapshot.vectors.invalid === 0 && snapshot.vectors.normalizationFailures === 0
    && snapshot.vectors.modelPresenceMismatches === 0 && snapshot.vectors.expectedDimensionMismatches === 0
    && blobReport?.verified === true;
}

export function snapshotIsMigrationReady(snapshot, blobReport) {
  return snapshotIsRestoreReady(snapshot, blobReport)
    && snapshot.activity.activeJobs === 0 && snapshot.activity.runningSyncRuns === 0
    && snapshot.activity.autoPublishSources === 0;
}

export function comparisonSourceSnapshot(source) {
  if (Number(source.dataSchemaVersion) === MYSQL_SCHEMA_VERSION) return source;
  if (!validSchemaVersion(source.dataSchemaVersion) || !source.upgradedMeta) return source;
  const tables = { ...source.tables, meta: source.upgradedMeta };
  for (const spec of BUSINESS_TABLES) if (!tables[spec.name]) tables[spec.name] = finishTableAccumulator(newTableAccumulator(spec));
  return { ...source, tables, aggregateSha256: aggregateTables(tables), dataSchemaVersion: String(MYSQL_SCHEMA_VERSION),
    runtimeSchemaVersion: source.backend === "MySQL" ? MYSQL_SCHEMA_VERSION : source.runtimeSchemaVersion,
    schemaMigrationCount: source.backend === "MySQL" ? MYSQL_SCHEMA_MIGRATION_COUNT : source.schemaMigrationCount,
    schemaMigrationsSha256: source.backend === "MySQL" ? MYSQL_SCHEMA_MIGRATION_SHA256 : source.schemaMigrationsSha256 };
}

export function compareSnapshots(source, target, sourceBlobs, targetBlobs, { requireQuiescent = true } = {}) {
  source = comparisonSourceSnapshot(source);
  const mismatchedTables = BUSINESS_TABLES.filter((spec) => {
    const left = source.tables[spec.name];
    const right = target.tables[spec.name];
    return left?.rows !== right?.rows || left?.sha256 !== right?.sha256 || left?.seqSha256 !== right?.seqSha256
      || left?.seqMin !== right?.seqMin || left?.seqMax !== right?.seqMax;
  }).map((spec) => spec.name);
  const stateMatched = source.aggregateSha256 === target.aggregateSha256
    && stableJson(source.invariants) === stableJson(target.invariants)
    && stableJson(source.activity) === stableJson(target.activity)
    && stableJson(source.vectors) === stableJson(target.vectors)
    && source.dataSchemaVersion === target.dataSchemaVersion;
  const blobsMatched = sourceBlobs?.verified === true && targetBlobs?.verified === true
    && sourceBlobs.referenced === targetBlobs.referenced
    && sourceBlobs.manifestSha256 === targetBlobs.manifestSha256;
  const schemaMatched = source.backend !== "MySQL" || (source.runtimeSchemaVersion === target.runtimeSchemaVersion
    && source.schemaMigrationCount === target.schemaMigrationCount
    && source.schemaMigrationsSha256 === target.schemaMigrationsSha256
    && source.dataSchemaVersion === String(target.runtimeSchemaVersion));
  const readiness = requireQuiescent ? snapshotIsMigrationReady : snapshotIsRestoreReady;
  const verified = mismatchedTables.length === 0 && stateMatched && blobsMatched && schemaMatched
    && readiness(source, sourceBlobs) && readiness(target, targetBlobs);
  return { verified, mismatchedTables, stateMatched, blobsMatched, schemaMatched };
}

export function publicVerificationReport({ source, target, sourceBlobs, targetBlobs, comparison }) {
  const original = source;
  source = comparisonSourceSnapshot(source);
  return {
    additiveSchemaUpgrade: original.dataSchemaVersion !== source.dataSchemaVersion ? { from: original.dataSchemaVersion, to: source.dataSchemaVersion, originalAggregateSha256: original.aggregateSha256 } : null,
    ok: comparison.verified,
    code: comparison.verified ? "SQLITE_MYSQL_ZERO_DIFF" : "SQLITE_MYSQL_MISMATCH",
    tables: Object.fromEntries(BUSINESS_TABLES.map((spec) => [spec.name, {
      rows: source.tables[spec.name].rows,
      sourceSha256: source.tables[spec.name].sha256,
      targetSha256: target.tables[spec.name].sha256,
      sourceSeqSha256: source.tables[spec.name].seqSha256,
      targetSeqSha256: target.tables[spec.name].seqSha256,
      sourceSeqMin: source.tables[spec.name].seqMin,
      targetSeqMin: target.tables[spec.name].seqMin,
      sourceSeqMax: source.tables[spec.name].seqMax,
      targetSeqMax: target.tables[spec.name].seqMax,
      sourceSeqInvalid: source.tables[spec.name].seqInvalid,
      targetSeqInvalid: target.tables[spec.name].seqInvalid,
      matched: !comparison.mismatchedTables.includes(spec.name),
    }])),
    sourceAggregateSha256: source.aggregateSha256,
    targetAggregateSha256: target.aggregateSha256,
    sourceIntegrityOk: source.integrityOk,
    sourceDatabaseForeignKeyViolations: source.databaseForeignKeyViolations,
    sourceManifestMatches: source.manifestMatches,
    targetSchemaMigrationCount: target.schemaMigrationCount,
    targetSchemaMigrationsSha256: target.schemaMigrationsSha256,
    targetRuntimeSchemaValidated: target.runtimeSchemaValidated,
    targetRuntimeSchemaVersion: target.runtimeSchemaVersion,
    sourceDataSchemaVersion: source.dataSchemaVersion,
    targetDataSchemaVersion: target.dataSchemaVersion,
    jsonInvalid: { source: source.jsonInvalid, target: target.jsonInvalid },
    invariants: { source: source.invariants, target: target.invariants },
    activity: { source: source.activity, target: target.activity },
    vectors: { source: source.vectors, target: target.vectors },
    blobs: {
      source: sourceBlobs, target: targetBlobs,
      matched: comparison.blobsMatched,
    },
    schemaMatched: comparison.schemaMatched,
    mismatchedTables: comparison.mismatchedTables,
    verified: comparison.verified,
  };
}

export function sqliteImportRows(database, spec) { return sqliteRows(database, spec); }
export function tableSpec(name) { return TABLE_BY_NAME.get(name); }
export function normalizedImportRow(spec, rawRow) {
  const row = {};
  if (spec.seq) row.seq = normalizeInteger(rawRow.seq);
  for (const column of spec.columns) row[column] = normalizeCell(spec, column, rawRow[column]);
  return row;
}
export function validBackupName(value) { return typeof value === "string" && BACKUP_NAME.test(value); }
export async function digestFile(filename) { return await fileSha256(filename); }
