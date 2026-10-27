import {analyticsSqliteSchema,analyticsRow,analyticsEventFromRow,buildAnalyticsQuery,buildAnalyticsRetentionQuery,assertAnalyticsQuerySize,ANALYTICS_QUERY_MAX_EVENTS,analyticsDate} from './analytics-store.mjs';
import { buildAuditQuery, sqliteAuditSql } from './audit-query.mjs';
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { id, MAX_AGENT_SEARCHABLE_CHUNKS, now, normalizeAgent, PlatformError } from "./domain.mjs";
import { consumerSqliteSchema } from "./consumer-schema.mjs";

const ENTITY_TABLES = new Set(["documents", "sources", "content"]);
const parse = (value) => value ? JSON.parse(value) : null;
const EXHAUSTED_JOB_ERROR = "任务已达到最大重试次数，未继续自动执行。";
const EXHAUSTED_DOCUMENT_ERROR = "文档处理在服务中断后已达到最大重试次数，请检查文件后手动重试。";
const KNOWLEDGE_JOB_TYPES = new Set(["document.ingest", "document.reembed", "nas.sync"]);
const promiseLike = (value) => value && typeof value.then === "function";

function guardedSqlite(database, sqlite) {
  return new Proxy(sqlite, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        if (database.depth && database.transactionContext.getStore() !== database) {
          throw new PlatformError("SQLite 异步事务仍在执行，请稍后重试。", 503, "SQLITE_TRANSACTION_BUSY");
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
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

export class PlatformDatabase {
  constructor({ dataDir, databasePath, seedDoctors = [], writeGuard, testHooks } = {}) {
    this.storageKind = "SQLite";
    this.dataDir = path.resolve(dataDir || "data");
    this.writeGuard = typeof writeGuard === "function" ? writeGuard : null;
    this.closed = false;
    this.sqlite = null;
    this.sqliteConnection = null;
    this.depth = 0;
    this.activeTransaction = null;
    this.transactionContext = new AsyncLocalStorage();
    this.assertWritable();
    mkdirSync(this.dataDir, { recursive: true });
    this.databasePath = databasePath || path.join(this.dataDir, "platform.sqlite");
    try {
      this.sqliteConnection = new DatabaseSync(this.databasePath, { timeout: 5000 });
      this.sqlite = guardedSqlite(this, this.sqliteConnection);
      this.assertWritable();
      this.sqlite.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA busy_timeout=5000;
      `);
      this.assertWritable();
      this.transaction(() => {
        testHooks?.beforeSchemaMutation?.();
        this.sqlite.exec(`
          CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS agents (
            slug TEXT PRIMARY KEY, draft TEXT NOT NULL, published TEXT,
            status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
          );
          CREATE TABLE IF NOT EXISTS agent_versions (
            agent_slug TEXT NOT NULL REFERENCES agents(slug), version INTEGER NOT NULL,
            snapshot TEXT NOT NULL, published_at TEXT NOT NULL, actor TEXT NOT NULL,
            PRIMARY KEY(agent_slug, version)
          );
          CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, agent_slug TEXT NOT NULL REFERENCES agents(slug), payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
            agent_slug TEXT NOT NULL REFERENCES agents(slug), position INTEGER NOT NULL,
            text TEXT NOT NULL, embedding TEXT, embedding_model TEXT
          );
          CREATE INDEX IF NOT EXISTS chunks_agent ON chunks(agent_slug);
          CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id);
          CREATE TABLE IF NOT EXISTS sources (
            id TEXT PRIMARY KEY, agent_slug TEXT NOT NULL REFERENCES agents(slug), payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS content (
            id TEXT PRIMARY KEY, agent_slug TEXT NOT NULL REFERENCES agents(slug), payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
            result TEXT, error TEXT, progress INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
            run_after TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
          );
          CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(status, run_after);
          CREATE TABLE IF NOT EXISTS sync_runs (
            id TEXT PRIMARY KEY, source_id TEXT NOT NULL, job_id TEXT NOT NULL,
            status TEXT NOT NULL, stats TEXT NOT NULL, error TEXT,
            started_at TEXT NOT NULL, finished_at TEXT
          );
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            role TEXT NOT NULL, password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS audit (
            id TEXT PRIMARY KEY, action TEXT NOT NULL, actor TEXT NOT NULL,
            target TEXT, details TEXT, created_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS usage (
            id TEXT PRIMARY KEY, agent_slug TEXT NOT NULL, model TEXT, retrieval_mode TEXT,
            latency_ms INTEGER NOT NULL, success INTEGER NOT NULL, error_code TEXT, created_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS usage_created ON usage(created_at);
          INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1');
        `);
        this.sqlite.exec(consumerSqliteSchema);
        this.sqlite.exec(analyticsSqliteSchema);
        this.sqlite.prepare("UPDATE meta SET value='3' WHERE key='schema_version'").run();
      });
      const seeded = this.sqlite.prepare("SELECT value FROM meta WHERE key='seeded'").get();
      if (!seeded) this.transaction(() => {
        for (const doctor of seedDoctors) this.createAgent(normalizeAgent(doctor), "system", true);
        this.sqlite.prepare("INSERT INTO meta(key,value) VALUES('seeded',?)").run(now());
      });
      // Work interrupted by process restart is safely replayed; handlers are idempotent.
      this.transaction(() => {
        testHooks?.beforeRecoveryMutation?.();
        const timestamp = now();
        this.settleExhaustedJobs("running", ["processing"], timestamp);
        this.sqlite.prepare("UPDATE jobs SET status='queued', run_after=?, error='服务重启后恢复任务' WHERE status='running' AND attempts<max_attempts").run(timestamp);
        this.sqlite.prepare("UPDATE sync_runs SET status='interrupted', finished_at=? WHERE status='running'").run(timestamp);
      });
    } catch (error) {
      this.closed = true;
      try { this.sqliteConnection?.close(); } catch { /* preserve the initialization failure */ }
      throw error;
    }
  }

  transaction(callback) {
    if (this.depth && this.transactionContext.getStore() === this) {
      if (this.closed) this.assertWritable();
      return callback();
    }
    if (this.depth) {
      if (!this.activeTransaction) throw new PlatformError("SQLite 事务正忙。", 503, "SQLITE_TRANSACTION_BUSY");
      return this.activeTransaction.then(
        () => this.transaction(callback),
        () => this.transaction(callback),
      );
    }
    this.assertWritable();
    this.sqliteConnection.exec("BEGIN IMMEDIATE");
    this.depth += 1;
    const commit = (value) => {
      try {
        this.assertWritable();
        this.sqliteConnection.exec("COMMIT");
        return value;
      } catch (error) { return rollback(error); }
    };
    const rollback = (error) => {
      if (!this.closed && this.sqliteConnection.isTransaction) this.sqliteConnection.exec("ROLLBACK");
      throw error;
    };
    let result;
    try {
      result = this.transactionContext.run(this, callback);
    } catch (error) {
      try { return rollback(error); }
      finally { this.depth -= 1; }
    }
    if (promiseLike(result)) {
      const pending = Promise.resolve(result).then(commit, rollback).finally(() => {
        this.depth -= 1;
        if (this.activeTransaction === pending) this.activeTransaction = null;
      });
      this.activeTransaction = pending;
      return pending;
    }
    try { return commit(result); }
    finally { this.depth -= 1; }
  }

  assertWritable() {
    if (this.closed) throw new PlatformError("平台数据目录已关闭。", 503, "PLATFORM_DATA_CLOSED");
    this.writeGuard?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.sqliteConnection.close();
  }

  ping() {
    this.assertWritable();
    return this.sqlite.prepare("SELECT 1 ok").get()?.ok === 1;
  }

  hasAnyUser() {
    return Boolean(this.sqlite.prepare("SELECT 1 found FROM users LIMIT 1").get());
  }

  bootstrapUser(record) {
    return this.insertUser(record);
  }

  listActivePasswordHashes() {
    return this.sqlite.prepare("SELECT password_hash FROM users WHERE active=1").all().map((row) => row.password_hash);
  }

  findSessionUser(tokenHash, timestamp) {
    return this.sqlite.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1")
      .get(tokenHash, timestamp);
  }

  findUserByUsername(username) {
    return this.sqlite.prepare("SELECT * FROM users WHERE username=?").get(username);
  }

  createLoginSession({ tokenHash, userId, expiresAt, now: timestamp = now() }) {
    return this.transaction(() => {
      this.sqlite.prepare("DELETE FROM sessions WHERE expires_at<=?").run(timestamp);
      this.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").run(tokenHash, userId, expiresAt);
    });
  }

  deleteSession(tokenHash) {
    return this.transaction(() => this.sqlite.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash).changes);
  }

  listUsersRaw() {
    return this.sqlite.prepare("SELECT * FROM users ORDER BY created_at,id").all();
  }

  getUser(userId) {
    return this.sqlite.prepare("SELECT * FROM users WHERE id=?").get(userId);
  }

  countActiveAdmins() {
    return Number(this.sqlite.prepare("SELECT COUNT(*) total FROM users WHERE role='admin' AND active=1").get().total);
  }

  insertUser(record) {
    return this.transaction(() => {
      const createdAt = record.createdAt || record.created_at || now();
      const updatedAt = record.updatedAt || record.updated_at || createdAt;
      const passwordHash = record.passwordHash || record.password_hash;
      this.sqlite.prepare("INSERT INTO users(id,username,name,role,active,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(record.id, record.username, record.name, record.role || "editor", record.active === undefined ? 1 : Number(record.active), passwordHash, createdAt, updatedAt);
      return this.getUser(record.id);
    });
  }

  updateUser(userId, patch) {
    return this.transaction(() => {
      const existing = this.getUser(userId);
      if (!existing) return null;
      const passwordHash = patch.passwordHash || patch.password_hash || existing.password_hash;
      this.sqlite.prepare("UPDATE users SET name=?,role=?,active=?,password_hash=?,updated_at=? WHERE id=?")
        .run(patch.name ?? existing.name, patch.role ?? existing.role, patch.active === undefined ? existing.active : Number(patch.active),
          passwordHash, patch.updatedAt || patch.updated_at || now(), userId);
      return this.getUser(userId);
    });
  }

  deleteUserSessions(userId) {
    return this.transaction(() => this.sqlite.prepare("DELETE FROM sessions WHERE user_id=?").run(userId).changes);
  }

  getMeta(key) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key)) throw new PlatformError("元数据标识无效。");
    return this.sqlite.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ?? null;
  }

  setMeta(key, value) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(key) || typeof value !== "string" || Buffer.byteLength(value, "utf8") > 2 * 1024 * 1024) throw new PlatformError("元数据格式或大小无效。");
    return this.transaction(() => { this.sqlite.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); return value; });
  }

  agentFromRow(row, published = false) {
    if (!row || (published && (row.status !== "published" || !row.published))) return null;
    return {
      ...parse(published ? row.published : row.draft),
      status: row.status,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: published ? row.published_at : row.updated_at,
      publishedAt: row.published_at,
      hasUnpublishedChanges: row.draft !== row.published,
    };
  }

  getAgent(slug, published = false) {
    return this.agentFromRow(this.sqlite.prepare("SELECT * FROM agents WHERE slug=?").get(slug), published);
  }

  requireAgent(slug) {
    const agent = this.getAgent(slug);
    if (!agent) throw new PlatformError("智能体不存在。", 404, "AGENT_NOT_FOUND");
    return agent;
  }

  listAgents(published = false) {
    return this.sqlite.prepare("SELECT * FROM agents ORDER BY created_at, slug").all()
      .map((row) => this.agentFromRow(row, published)).filter(Boolean);
  }

  createAgent(record, actor, publish = false) {
    return this.transaction(() => {
      if (this.getAgent(record.slug)) throw new PlatformError(`智能体标识 ${record.slug} 已存在。`, 409, "DUPLICATE_SLUG");
      const timestamp = now();
      this.sqlite.prepare("INSERT INTO agents(slug,draft,status,created_at,updated_at) VALUES(?,?,'draft',?,?)")
        .run(record.slug, JSON.stringify(record), timestamp, timestamp);
      this.audit("agent.create", actor, record.slug);
      if (publish) return this.publishAgent(record.slug, actor);
      return this.getAgent(record.slug);
    });
  }

  saveAgent(record, actor) {
    return this.transaction(() => {
      this.requireAgent(record.slug);
      this.sqlite.prepare("UPDATE agents SET draft=?,updated_at=? WHERE slug=?")
        .run(JSON.stringify(record), now(), record.slug);
      this.audit("agent.save_draft", actor, record.slug);
      return this.getAgent(record.slug);
    });
  }

  publishAgent(slug, actor) {
    return this.transaction(() => {
      const agent = this.requireAgent(slug);
      const snapshot = JSON.stringify(normalizeAgent(agent));
      const version = agent.version + 1;
      const timestamp = now();
      this.sqlite.prepare("UPDATE agents SET draft=?,published=?,status='published',version=?,published_at=?,updated_at=? WHERE slug=?")
        .run(snapshot, snapshot, version, timestamp, timestamp, slug);
      this.sqlite.prepare("INSERT INTO agent_versions(agent_slug,version,snapshot,published_at,actor) VALUES(?,?,?,?,?)")
        .run(slug, version, snapshot, timestamp, actor);
      this.audit("agent.publish", actor, slug, { version });
      return this.getAgent(slug);
    });
  }

  archiveAgent(slug, actor) {
    return this.transaction(() => {
      this.requireAgent(slug);
      this.sqlite.prepare("UPDATE agents SET status='archived',updated_at=? WHERE slug=?").run(now(), slug);
      this.audit("agent.archive", actor, slug);
      return this.getAgent(slug);
    });
  }

  getAgentVersionSnapshot(slug, version) {
    this.requireAgent(slug);
    const row = this.sqlite.prepare("SELECT snapshot FROM agent_versions WHERE agent_slug=? AND version=?").get(slug, version);
    return row ? parse(row.snapshot) : null;
  }

  listVersions(slug) {
    this.requireAgent(slug);
    return this.sqlite.prepare("SELECT version,published_at,snapshot,actor FROM agent_versions WHERE agent_slug=? ORDER BY version DESC").all(slug)
      .map((row) => ({ version: row.version, publishedAt: row.published_at, name: parse(row.snapshot).name, actor: row.actor }));
  }

  rollbackAgent(slug, version, actor) {
    return this.transaction(() => {
      const row = this.sqlite.prepare("SELECT snapshot FROM agent_versions WHERE agent_slug=? AND version=?").get(slug, version);
      if (!row) throw new PlatformError("发布版本不存在。", 404, "VERSION_NOT_FOUND");
      const agent = this.saveAgent(parse(row.snapshot), actor);
      this.audit("agent.restore_version_to_draft", actor, slug, { version });
      return agent;
    });
  }

  checkTable(table) { if (!ENTITY_TABLES.has(table)) throw new Error("Invalid entity table"); }

  getEntity(table, entityId) {
    this.checkTable(table);
    return parse(this.sqlite.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(entityId)?.payload);
  }

  requireEntity(table, entityId) {
    const entity = this.getEntity(table, entityId);
    if (!entity) throw new PlatformError("记录不存在。", 404, "NOT_FOUND");
    return entity;
  }

  listEntities(table, agentSlug) {
    this.checkTable(table);
    const rows = agentSlug
      ? this.sqlite.prepare(`SELECT payload FROM ${table} WHERE agent_slug=? ORDER BY rowid DESC`).all(agentSlug)
      : this.sqlite.prepare(`SELECT payload FROM ${table} ORDER BY rowid DESC`).all();
    return rows.map((row) => parse(row.payload));
  }

  saveEntity(table, entity) {
    return this.transaction(() => {
      this.checkTable(table);
      this.sqlite.prepare(`INSERT INTO ${table}(id,agent_slug,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload`)
        .run(entity.id, entity.agentSlug, JSON.stringify(entity));
      return entity;
    });
  }

  patchEntity(table, entityId, patch) {
    return this.transaction(() => {
      const existing = this.requireEntity(table, entityId);
      return this.saveEntity(table, { ...existing, ...patch, id: existing.id, agentSlug: existing.agentSlug });
    });
  }

  removeEntity(table, entityId) {
    return this.transaction(() => {
      this.checkTable(table);
      this.sqlite.prepare(`DELETE FROM ${table} WHERE id=?`).run(entityId);
    });
  }

  listChunks(documentId) {
    return this.sqlite.prepare("SELECT id,position,text FROM chunks WHERE document_id=? ORDER BY position").all(documentId)
      .map((row) => ({ id: row.id, index: row.position, text: row.text }));
  }

  listStoredChunkRows(documentId) {
    return this.sqlite.prepare(`SELECT id,document_id,agent_slug,position,text,embedding,embedding_model
      FROM chunks WHERE document_id=? ORDER BY position`).all(documentId);
  }

  countDocumentChunks(documentId) {
    return this.sqlite.prepare("SELECT COUNT(*) total FROM chunks WHERE document_id=?").get(documentId).total;
  }

  countSearchableChunks(agentSlug) {
    return this.sqlite.prepare(`SELECT COUNT(*) total FROM chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.agent_slug=? AND json_extract(d.payload,'$.status')='ready' AND json_extract(d.payload,'$.approved')=1`).get(agentSlug).total;
  }

  replaceChunks(document, chunks, vectors, embeddingModel) {
    return this.transaction(() => {
      this.sqlite.prepare("DELETE FROM chunks WHERE document_id=?").run(document.id);
      const statement = this.sqlite.prepare("INSERT INTO chunks(id,document_id,agent_slug,position,text,embedding,embedding_model) VALUES(?,?,?,?,?,?,?)");
      for (const [index, chunk] of chunks.entries()) statement.run(
        id(), document.id, document.agentSlug, chunk.index, chunk.text,
        vectors?.[index] ? JSON.stringify(vectors[index]) : null, embeddingModel || null,
      );
    });
  }

  updateChunkEmbeddings(rows, vectors, model) {
    return this.transaction(() => {
      if (!Array.isArray(rows) || !Array.isArray(vectors) || rows.length !== vectors.length) {
        throw new PlatformError("资料分片向量结果数量不匹配。", 409, "DOCUMENT_CHANGED");
      }
      const update = this.sqlite.prepare(`UPDATE chunks SET embedding=?,embedding_model=?
        WHERE id=? AND document_id=? AND agent_slug=? AND position=? AND text=?
          AND embedding IS NULL AND embedding_model IS NULL`);
      for (const [index, row] of rows.entries()) {
        const result = update.run(JSON.stringify(vectors[index]), model, row.id,
          row.document_id, row.agent_slug, row.position, row.text);
        if (result.changes !== 1) throw new PlatformError("资料分片在写入期间已发生变化。", 409, "DOCUMENT_CHANGED");
      }
      return rows.length;
    });
  }

  searchableChunks(agentSlug, maxChunks = MAX_AGENT_SEARCHABLE_CHUNKS) {
    const rows = this.sqlite.prepare(`SELECT c.*,d.payload FROM chunks c JOIN documents d ON d.id=c.document_id
      WHERE c.agent_slug=? AND json_extract(d.payload,'$.status')='ready' AND json_extract(d.payload,'$.approved')=1
      ORDER BY c.document_id,c.position LIMIT ?`).all(agentSlug, maxChunks + 1);
    if (rows.length > maxChunks) throw new PlatformError(`该智能体已生效片段超过单节点检索上限（${maxChunks}）。请拆分知识库或扩展向量存储，平台不会静默忽略超出部分。`, 503, "INDEX_CAPACITY_EXCEEDED");
    return rows.map((row) => ({
        id: row.id, documentId: row.document_id, title: parse(row.payload).name,
        index: row.position, text: row.text, embedding: parse(row.embedding), embeddingModel: row.embedding_model,
      }));
  }

  audit(action, actor = "system", target = null, details = null) {
    return this.transaction(() => {
      this.sqlite.prepare("INSERT INTO audit(id,action,actor,target,details,created_at) VALUES(?,?,?,?,?,?)")
        .run(id(), action, actor, target, details ? JSON.stringify(details) : null, now());
    });
  }

  appendAnalyticsEvents(events) {
    if(!Array.isArray(events))throw new TypeError('Analytics events must be an array.');
    const rows=events.map(analyticsRow);
    return this.transaction(()=>{const statement=this.sqlite.prepare('INSERT OR IGNORE INTO analytics_events(id,event_type,agent_slug,tenant_id,actor_kind,actor_hash,created_at,test_traffic,safe_json) VALUES(?,?,?,?,?,?,?,?,?)');let inserted=0;for(const row of rows)inserted+=Number(statement.run(...row).changes);return {inserted};});
  }

  queryAnalyticsEvents(options={}) {
    const query=buildAnalyticsQuery(options),total=Number(this.sqlite.prepare('SELECT COUNT(*) total FROM analytics_events e'+query.where).get(...query.parameters).total);
    assertAnalyticsQuerySize(total);
    const rows=this.sqlite.prepare('SELECT e.* FROM analytics_events e'+query.where+' ORDER BY e.created_at,e.id LIMIT ?').all(...query.parameters,ANALYTICS_QUERY_MAX_EVENTS+1);
    assertAnalyticsQuerySize(rows.length);
    return {items:rows.map(analyticsEventFromRow),total,truncated:false};
  }

  queryAnalyticsRetention(options={}) {
    return [1,7,30].map(day=>{const query=buildAnalyticsRetentionQuery(options,day),row=this.sqlite.prepare(query.sql).get(...query.parameters),eligible=Number(row.eligible),returned=Number(row.returned);return {day,eligible,returned,rate:eligible?returned/eligible:null};});
  }

  pruneAnalyticsEvents(before) {
    const cutoff=analyticsDate(before);
    return this.transaction(()=>Number(this.sqlite.prepare('DELETE FROM analytics_events WHERE created_at<?').run(cutoff).changes));
  }

  queryAudit(options = {}) {
    const query=buildAuditQuery(options),where=sqliteAuditSql(query.where);
    const total=Number(this.sqlite.prepare('SELECT COUNT(*) total FROM audit a'+where).get(...query.parameters).total);
    const items=this.sqlite.prepare('SELECT a.* FROM audit a'+where+' ORDER BY a.created_at DESC,a.rowid DESC LIMIT ? OFFSET ?').all(...query.parameters,query.limit,query.offset)
      .map(row=>({id:row.id,action:row.action,actor:row.actor,target:row.target,details:parse(row.details),createdAt:row.created_at}));
    return {items,total,limit:query.limit,offset:query.offset,truncated:false};
  }

  listAudit(limit = 100) {
    return this.sqlite.prepare("SELECT * FROM audit ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit)
      .map((row) => ({ id: row.id, action: row.action, actor: row.actor, target: row.target, details: parse(row.details), createdAt: row.created_at }));
  }

  jobFromRow(row) {
    if (!row) return null;
    return { id: row.id, type: row.type, status: row.status, payload: parse(row.payload), result: parse(row.result), error: row.error,
      progress: row.progress, attempts: row.attempts, maxAttempts: row.max_attempts, runAfter: row.run_after,
      createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at };
  }

  enqueue(type, payload, { deduplicate = true } = {}) {
    return this.transaction(() => {
      const serialized = JSON.stringify(payload);
      if (["document.ingest", "document.reembed"].includes(type)) {
        if (typeof payload?.documentId !== "string" || !payload.documentId) throw new Error("Invalid document job payload");
        const active = this.sqlite.prepare(`SELECT * FROM jobs
          WHERE type IN ('document.ingest','document.reembed') AND status IN ('queued','running')
          ORDER BY created_at,rowid`).all();
        for (const row of active) {
          const activePayload = parsedJobPayload(row.payload);
          if (activePayload?.documentId !== payload.documentId) continue;
          if (deduplicate && row.type === type && row.payload === serialized) return this.jobFromRow(row);
          if (type === "document.reembed" || row.type === "document.reembed") {
            throw new PlatformError("该资料已有排队或运行中的处理任务。", 409, "DOCUMENT_JOB_ACTIVE");
          }
        }
      }
      if (KNOWLEDGE_JOB_TYPES.has(type)) {
        const activeKnowledge = this.sqlite.prepare(`SELECT * FROM jobs
          WHERE type IN ('document.ingest','document.reembed','nas.sync') AND status IN ('queued','running')
          ORDER BY created_at,rowid`).all();
        if (type === "document.reembed" && activeKnowledge.length) {
          throw new PlatformError("当前仍有排队或运行中的知识任务，不能开始独占向量化。", 409, "ACTIVE_JOBS_PRESENT");
        }
        if (type !== "document.reembed" && activeKnowledge.some((row) => row.type === "document.reembed")) {
          throw new PlatformError("现有分片向量化正在独占运行，请完成任务完成后重试。", 409, "REEMBED_EXCLUSIVE_ACTIVE");
        }
      }
      if (deduplicate) {
        const pending = this.sqlite.prepare("SELECT * FROM jobs WHERE type=? AND payload=? AND status IN ('queued','running') LIMIT 1").get(type, serialized);
        if (pending) return this.jobFromRow(pending);
      }
      const jobId = id();
      const timestamp = now();
      this.sqlite.prepare("INSERT INTO jobs(id,type,status,payload,run_after,created_at) VALUES(?,?,'queued',?,?,?)")
        .run(jobId, type, serialized, timestamp, timestamp);
      return this.getJob(jobId);
    });
  }

  getJob(jobId) { return this.jobFromRow(this.sqlite.prepare("SELECT * FROM jobs WHERE id=?").get(jobId)); }

  listJobs(limit = 100) {
    return this.sqlite.prepare("SELECT * FROM jobs ORDER BY created_at DESC,rowid DESC LIMIT ?").all(limit).map((row) => this.jobFromRow(row));
  }

  listActiveJobs(limit = 100) {
    return this.sqlite.prepare(`SELECT * FROM jobs WHERE status IN ('queued','running')
      ORDER BY created_at,rowid LIMIT ?`).all(limit).map((row) => this.jobFromRow(row));
  }

  countActiveJobs(excludeJobId = null) {
    return excludeJobId
      ? this.sqlite.prepare("SELECT COUNT(*) total FROM jobs WHERE status IN ('queued','running') AND id<>?").get(excludeJobId).total
      : this.sqlite.prepare("SELECT COUNT(*) total FROM jobs WHERE status IN ('queued','running')").get().total;
  }

  hasActiveJobType(type) {
    return Boolean(this.sqlite.prepare("SELECT 1 found FROM jobs WHERE type=? AND status IN ('queued','running') LIMIT 1").get(type));
  }

  settleExhaustedJobs(status, documentStatuses, timestamp = now()) {
    if (!["queued", "running"].includes(status)) throw new Error("Invalid exhausted job status");
    const exhausted = this.sqlite.prepare("SELECT id,type,payload FROM jobs WHERE status=? AND attempts>=max_attempts").all(status);
    if (!exhausted.length) return 0;

    const eligibleIngestKeys = new Set(this.sqlite.prepare(`SELECT payload FROM jobs
      WHERE type='document.ingest' AND status IN ('queued','running') AND attempts<max_attempts`).all()
      .map((row) => ingestJobKey(parsedJobPayload(row.payload))).filter(Boolean));
    const allowedDocumentStatuses = new Set(documentStatuses);
    for (const job of exhausted) {
      if (job.type !== "document.ingest") continue;
      const payload = parsedJobPayload(job.payload);
      const key = ingestJobKey(payload);
      if (!key || eligibleIngestKeys.has(key)) continue;
      const document = this.getEntity("documents", payload.documentId);
      if (!document || document.checksum !== payload.checksum || !allowedDocumentStatuses.has(document.status)) continue;
      this.saveEntity("documents", { ...document, status: "error", error: EXHAUSTED_DOCUMENT_ERROR, updatedAt: timestamp });
    }
    return this.sqlite.prepare(`UPDATE jobs SET status='failed',error=?,finished_at=?
      WHERE status=? AND attempts>=max_attempts`).run(EXHAUSTED_JOB_ERROR, timestamp, status).changes;
  }

  claimJob() {
    return this.transaction(() => {
      const timestamp = now();
      this.settleExhaustedJobs("queued", ["queued", "processing"], timestamp);
      const row = this.sqlite.prepare("SELECT id FROM jobs WHERE status='queued' AND attempts<max_attempts AND run_after<=? ORDER BY created_at,rowid LIMIT 1").get(timestamp);
      if (!row) return null;
      this.sqlite.prepare("UPDATE jobs SET status='running',started_at=?,finished_at=NULL,attempts=attempts+1,progress=0 WHERE id=?").run(timestamp, row.id);
      return this.getJob(row.id);
    });
  }

  progressJob(jobId, progress) {
    return this.transaction(() => { this.sqlite.prepare("UPDATE jobs SET progress=? WHERE id=?").run(progress, jobId); });
  }

  finishJob(jobId, result) {
    return this.transaction(() => {
      this.sqlite.prepare("UPDATE jobs SET status='completed',progress=100,result=?,error=NULL,finished_at=? WHERE id=?")
        .run(JSON.stringify(result || {}), now(), jobId);
    });
  }

  failJob(jobId, error) {
    return this.transaction(() => {
      this.sqlite.prepare("UPDATE jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(String(error).slice(0, 1000), now(), jobId);
    });
  }

  retryJob(jobId) {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (!job) throw new PlatformError("任务不存在。", 404);
      if (job.status !== "failed") throw new PlatformError("仅失败的任务可以重试。", 409);
      if (["document.ingest", "document.reembed"].includes(job.type)) {
        const documentId = job.payload?.documentId;
        if (typeof documentId !== "string" || !documentId) throw new PlatformError("资料任务载荷无效。", 409, "DOCUMENT_JOB_INVALID");
        const conflict = this.sqlite.prepare(`SELECT payload FROM jobs
          WHERE id<>? AND type IN ('document.ingest','document.reembed') AND status IN ('queued','running')`).all(job.id)
          .some((row) => parsedJobPayload(row.payload)?.documentId === documentId);
        if (conflict) throw new PlatformError("该资料已有排队或运行中的处理任务。", 409, "DOCUMENT_JOB_ACTIVE");
      }
      if (KNOWLEDGE_JOB_TYPES.has(job.type)) {
        const activeKnowledge = this.sqlite.prepare(`SELECT type FROM jobs
          WHERE id<>? AND type IN ('document.ingest','document.reembed','nas.sync')
            AND status IN ('queued','running')`).all(job.id);
        if (job.type === "document.reembed" && activeKnowledge.length) {
          throw new PlatformError("当前仍有排队或运行中的知识任务，不能开始独占向量化。", 409, "ACTIVE_JOBS_PRESENT");
        }
        if (job.type !== "document.reembed" && activeKnowledge.some((row) => row.type === "document.reembed")) {
          throw new PlatformError("现有分片向量化正在独占运行，请完成任务完成后重试。", 409, "REEMBED_EXCLUSIVE_ACTIVE");
        }
      }
      // An explicit operator retry starts a fresh bounded attempt cycle. Keeping
      // an exhausted counter would make claimJob immediately fail it again.
      this.sqlite.prepare("UPDATE jobs SET status='queued',progress=0,attempts=0,run_after=?,started_at=NULL,finished_at=NULL WHERE id=?").run(now(), jobId);
      return this.getJob(jobId);
    });
  }

  beginSyncRun(sourceId, jobId) {
    return this.transaction(() => {
      const runId = id();
      this.sqlite.prepare("INSERT INTO sync_runs(id,source_id,job_id,status,stats,started_at) VALUES(?,?,?,'running','{}',?)")
        .run(runId, sourceId, jobId, now());
      return runId;
    });
  }

  finishSyncRun(runId, status, stats, error = null) {
    return this.transaction(() => {
      this.sqlite.prepare("UPDATE sync_runs SET status=?,stats=?,error=?,finished_at=? WHERE id=?")
        .run(status, JSON.stringify(stats), error, now(), runId);
    });
  }

  listSyncRuns(limit = 50) {
    return this.sqlite.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC,rowid DESC LIMIT ?").all(limit).map((row) => ({
      id: row.id, sourceId: row.source_id, jobId: row.job_id, status: row.status, stats: parse(row.stats), error: row.error,
      startedAt: row.started_at, finishedAt: row.finished_at,
    }));
  }

  recordUsage({ agentSlug, model = null, retrievalMode = "none", latencyMs = 0, success = true, errorCode = null }) {
    return this.transaction(() => {
      this.sqlite.prepare("INSERT INTO usage(id,agent_slug,model,retrieval_mode,latency_ms,success,error_code,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(id(), agentSlug, model, retrievalMode, Math.max(0, Math.round(latencyMs)), success ? 1 : 0, errorCode, now());
    });
  }

  overview() {
    const count = (sql) => this.sqlite.prepare(sql).get().total;
    return {
      stats: {
        agents: count("SELECT COUNT(*) total FROM agents WHERE status!='archived'"),
        publishedAgents: count("SELECT COUNT(*) total FROM agents WHERE status='published'"),
        documents: count("SELECT COUNT(*) total FROM documents WHERE json_extract(payload,'$.status')!='deleted'"),
        readyDocuments: count("SELECT COUNT(*) total FROM documents WHERE json_extract(payload,'$.status')='ready'"),
        chunks: count("SELECT COUNT(*) total FROM chunks c JOIN documents d ON c.document_id=d.id WHERE json_extract(d.payload,'$.status')='ready'"),
        content: count("SELECT COUNT(*) total FROM content"),
        conversations: count("SELECT COUNT(*) total FROM usage"),
        failedJobs: count("SELECT COUNT(*) total FROM jobs WHERE status='failed'"),
      },
      recentJobs: this.listJobs(8), recentAudit: this.listAudit(10),
      dailyUsage: this.sqlite.prepare("SELECT substr(created_at,1,10) date,COUNT(*) total,SUM(success) successful FROM usage WHERE created_at>=? GROUP BY date ORDER BY date")
        .all(new Date(Date.now() - 7 * 86400000).toISOString()),
    };
  }
}
