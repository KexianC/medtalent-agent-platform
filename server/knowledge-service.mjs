import { PDF_LAYOUT_RECOVERED_MESSAGE, safeParseWarnings } from "./pdf-text-recovery.mjs";
import {ocrSourceIssue} from './knowledge-recovery.mjs';
import {knowledgeFailureRecord} from "./knowledge-errors.mjs";
import {knowledgeDiagnostics,knowledgeApprovalPreflight,inspectKnowledgeDocument,knowledgeEligibility} from './knowledge-diagnostics.mjs';
import {classifyKnowledgeError} from './knowledge-errors.mjs';
import {collectReleaseBlobReferences} from './release-blob-references.mjs';
import { publicCitationReference } from './knowledge-governance.mjs';
import { normalizeAgentBuilder } from "../src/lib/agentBuilder.ts";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { id, now, MAX_AGENT_SEARCHABLE_CHUNKS, MAX_FILE_BYTES, DOCUMENT_EXTENSIONS, nasSourceScopeIssues, PlatformError, textField, validateSlug } from "./domain.mjs";
import { chunkText, embedTexts, retrieveChunks } from "./rag.mjs";
import { parseDocumentIsolated } from "./document-parser.mjs";
import { listNasFiles, readNasFile, getNasCapabilities, getNasS3PublicConfig } from "./nas.mjs";
import { DocumentBlobStorage, isDocumentStorageKey } from "./blob-storage.mjs";
import { normalizeNasRelativePath } from "./nas-path.mjs";
import { credentialValues, publicTimestamp, safeOutputText as safeNasText } from "./output-safety.mjs";

const checksum = (buffer) => createHash("sha256").update(buffer).digest("hex");

const REEMBEDDING_CONFIG = Object.freeze({
  endpoint: "https://dashscope.aliyuncs.com/api/v1/services/embeddings/text-embedding/text-embedding",
  model: "qwen3.7-text-embedding-flash",
  protocol: "dashscope",
  dimensions: 256,
  segmentCharacters: 225,
  batchSize: 8,
  maxRetries: 2,
});

function strictEnvInteger(env, name) {
  const value = env?.[name];
  return typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
}

export function assertExistingChunkEmbeddingConfig(env = {}) {
  let endpoint;
  try { endpoint = new URL(String(env.EMBEDDING_API_URL || "")); }
  catch { throw new PlatformError("现有分片向量化配置不符合本次受控运维要求。", 409, "REEMBED_CONFIG_MISMATCH"); }
  const configured = env.EMBEDDING_MODEL === REEMBEDDING_CONFIG.model
    && env.EMBEDDING_API_PROTOCOL === REEMBEDDING_CONFIG.protocol
    && strictEnvInteger(env, "EMBEDDING_DIMENSIONS") === REEMBEDDING_CONFIG.dimensions
    && strictEnvInteger(env, "EMBEDDING_SEGMENT_CHARACTERS") === REEMBEDDING_CONFIG.segmentCharacters
    && strictEnvInteger(env, "EMBEDDING_BATCH_SIZE") === REEMBEDDING_CONFIG.batchSize
    && strictEnvInteger(env, "EMBEDDING_MAX_RETRIES") === REEMBEDDING_CONFIG.maxRetries
    && typeof env.EMBEDDING_API_KEY === "string" && env.EMBEDDING_API_KEY.trim().length > 0
    && endpoint.href === REEMBEDDING_CONFIG.endpoint && !endpoint.username && !endpoint.password && !endpoint.hash;
  if (!configured) throw new PlatformError("现有分片向量化配置不符合本次受控运维要求。", 409, "REEMBED_CONFIG_MISMATCH");
  return REEMBEDDING_CONFIG;
}

function lengthPrefixedDigest(values) {
  const digest = createHash("sha256");
  const add = (value) => {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    digest.update(String(Buffer.byteLength(serialized))).update(":").update(serialized).update(";");
  };
  for (const value of values) add(value);
  return digest.digest("hex");
}

function chunkSnapshotDigest(rows) {
  return lengthPrefixedDigest(rows.flatMap((row) => [row.id, row.document_id, row.agent_slug,
    row.position, row.text]));
}

export function validateExistingChunkSnapshot(document, rows) {
  if (!document || typeof document.id !== "string" || !document.id
    || typeof document.agentSlug !== "string" || !document.agentSlug
    || typeof document.checksum !== "string" || !/^[0-9a-f]{64}$/.test(document.checksum)
    || !Number.isSafeInteger(document.revision) || document.revision < 0
    || !["review", "ready", "error"].includes(document.status)
    || document.approved !== false || document.embeddingMode !== "lexical"
    || !Number.isSafeInteger(document.chunkCount) || document.chunkCount < 1 || document.chunkCount > 3000) {
    throw new PlatformError("资料不符合从现有分片生成向量的条件。", 409, "DOCUMENT_REEMBED_NOT_ELIGIBLE");
  }
  if (!Array.isArray(rows) || rows.length !== document.chunkCount) {
    throw new PlatformError("资料分片数量与记录不一致。", 409, "DOCUMENT_CHUNKS_INVALID");
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row.id !== "string" || !row.id || row.document_id !== document.id
      || row.agent_slug !== document.agentSlug || row.position !== index
      || typeof row.text !== "string" || !row.text.trim()) {
      throw new PlatformError("资料分片结构不完整或归属不一致。", 409, "DOCUMENT_CHUNKS_INVALID");
    }
    if (row.embedding !== null || row.embedding_model !== null) {
      throw new PlatformError("资料已含向量，拒绝覆盖现有向量。", 409, "DOCUMENT_ALREADY_VECTORIZED");
    }
  }
  return {
    chunkDigest: chunkSnapshotDigest(rows),
    documentDigest: lengthPrefixedDigest([document.id, document.agentSlug, document.checksum,
      document.revision, document.status, document.approved, document.chunkCount, document.embeddingMode]),
    texts: rows.map((row) => row.text),
  };
}

export function validateExistingChunkEmbeddingResult(result, expectedCount, config = REEMBEDDING_CONFIG) {
  if (!result || result.mode !== "hybrid" || result.model !== config.model
    || !Array.isArray(result.vectors) || result.vectors.length !== expectedCount || result.warning) {
    throw new PlatformError("向量服务未完整返回本次资料的向量。", 503, "REEMBED_INCOMPLETE");
  }
  for (const vector of result.vectors) {
    if (!Array.isArray(vector) || vector.length !== config.dimensions
      || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new PlatformError("向量维度或数值格式不符合要求。", 503, "REEMBED_VECTOR_INVALID");
    }
    let normSquared = 0;
    for (const value of vector) normSquared += value ** 2;
    if (!Number.isFinite(normSquared) || Math.abs(Math.sqrt(normSquared) - 1) > 1e-6) {
      throw new PlatformError("向量归一化校验失败。", 503, "REEMBED_VECTOR_INVALID");
    }
  }
  return result.vectors;
}

const safeTaskError = (error) => safeNasText(error?.message || "处理失败，请检查文件格式或连接配置。");
const contentChecksum = (content) => checksum(Buffer.from(`# ${content.title}\n\n${content.summary}\n\n${content.body}`, "utf8"));
const boundedInteger = (value, fallback, min, max) => Number.isInteger(Number(value)) && Number(value) >= min ? Math.min(Number(value), max) : fallback;
const GIB = 1024 * 1024 * 1024;

function knowledgeQuotas(env) {
  return {
    agentDocuments: boundedInteger(env.KNOWLEDGE_MAX_DOCUMENTS_PER_AGENT, 10_000, 1, 100_000),
    agentBytes: boundedInteger(env.KNOWLEDGE_MAX_BYTES_PER_AGENT, 20 * GIB, 1, 1024 * GIB),
    sourceDocuments: boundedInteger(env.KNOWLEDGE_MAX_DOCUMENTS_PER_SOURCE, 5_000, 1, 100_000),
    sourceBytes: boundedInteger(env.KNOWLEDGE_MAX_BYTES_PER_SOURCE, 10 * GIB, 1, 1024 * GIB),
  };
}

function storedBytes(document) {
  const size = Number(document?.size);
  return Number.isSafeInteger(size) && size > 0 ? size : 0;
}

function sameDocumentSource(document, source, sourceId) {
  return document?.source === source && (document.sourceId ?? null) === (sourceId ?? null);
}

function publicNasSourceRecord(source, scopeIssue, secrets) {
  const failures = Array.isArray(source?.syncFailureOrder) ? source.syncFailureOrder.length : 0;
  return {
    id: safeNasText(source?.id || "", secrets, 100),
    name: safeNasText(source?.name || "", secrets, 100),
    agentSlug: safeNasText(source?.agentSlug || "", secrets, 100),
    transport: ["webdav", "local", "s3", "minio"].includes(source?.transport) ? source.transport : "unknown",
    path: scopeIssue?.code === "NAS_SOURCE_SCOPE_INVALID" ? "[invalid legacy path]" : safeNasText(source?.path || "", secrets, 1000),
    enabled: source?.enabled === true,
    autoPublish: source?.autoPublish === true,
    deleteMissing: source?.deleteMissing === true,
    intervalMinutes: Number.isSafeInteger(Number(source?.intervalMinutes)) ? Number(source.intervalMinutes) : null,
    revision: Number.isSafeInteger(Number(source?.revision)) ? Number(source.revision) : 0,
    createdAt: publicTimestamp(source?.createdAt),
    updatedAt: publicTimestamp(source?.updatedAt),
    lastSyncAt: publicTimestamp(source?.lastSyncAt),
    lastStatus: ["never", "success", "partial", "failed"].includes(source?.lastStatus) ? source.lastStatus : "failed",
    lastError: source?.lastError ? "上次同步失败或未完整完成；请检查服务端日志与同步记录。" : null,
    syncFailureCount: failures,
    scopeIssue: scopeIssue ? { code: scopeIssue.code, message: scopeIssue.message } : null,
  };
}

const SYNC_COUNTERS = ["created", "updated", "unchanged", "deleted", "skipped", "failed", "scanned", "attempted", "deferred"];
const SYNC_FLAGS = ["complete", "manifestComplete", "truncated"];

function publicSyncStats(value, secrets) {
  const stats = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of SYNC_COUNTERS) {
    const count = Number(stats[key]);
    if (Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  for (const key of SYNC_FLAGS) if (typeof stats[key] === "boolean") result[key] = stats[key];
  if (typeof stats.warning === "string") result.warning = "同步扫描未完整完成；请检查服务端日志。";
  if (Array.isArray(stats.errors)) result.errors = stats.errors.slice(0, 20).map((entry) => ({
    path: safeNasText(entry?.path || "", secrets, 1000),
    error: "文件处理失败；请检查服务端日志。",
  }));
  return result;
}

function publicSyncRun(run, secrets) {
  return {
    id: safeNasText(run?.id || "", secrets, 100),
    sourceId: safeNasText(run?.sourceId || "", secrets, 100),
    jobId: run?.jobId ? safeNasText(run.jobId, secrets, 100) : null,
    status: ["running", "success", "partial", "failed"].includes(run?.status) ? run.status : "failed",
    stats: publicSyncStats(run?.stats, secrets),
    error: run?.error ? "同步任务失败；请检查服务端日志。" : null,
    startedAt: publicTimestamp(run?.startedAt),
    finishedAt: publicTimestamp(run?.finishedAt),
  };
}

function safeJobResult(job, secrets) {
  const result = job?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  if (["document.ingest", "document.reembed"].includes(job.type)) {
    const projected = {};
    if (typeof result.documentId === "string") projected.documentId = safeNasText(result.documentId, secrets, 100);
    if (Number.isSafeInteger(Number(result.chunks)) && Number(result.chunks) >= 0) projected.chunks = Number(result.chunks);
    if (typeof result.mode === "string") projected.mode = safeNasText(result.mode, secrets, 80);
    if (typeof result.status === "string") projected.status = safeNasText(result.status, secrets, 40);
    if (typeof result.skipped === "boolean") projected.skipped = result.skipped;
    if (typeof result.reason === "string") projected.reason = "任务已安全跳过；请查看对应资料状态。";
    if (typeof result.warning === "string") projected.warning = "任务完成但存在警告；请查看对应资料状态。";
    return projected;
  }
  if (job.type === "nas.sync") {
    const projected = publicSyncStats(result, secrets);
    if (typeof result.sourceId === "string") projected.sourceId = safeNasText(result.sourceId, secrets, 100);
    if (typeof result.runId === "string") projected.runId = safeNasText(result.runId, secrets, 100);
    return projected;
  }
  return null;
}

export function publicJob(job, env = process.env) {
  const secrets = credentialValues(env);
  const type = ["document.ingest", "document.reembed", "nas.sync"].includes(job?.type) ? job.type : "unknown";
  return {
    id: safeNasText(job?.id || "", secrets, 100),
    type,
    status: ["queued", "running", "completed", "failed"].includes(job?.status) ? job.status : "failed",
    progress: Number.isSafeInteger(Number(job?.progress)) ? Math.min(100, Math.max(0, Number(job.progress))) : 0,
    attempts: Number.isSafeInteger(Number(job?.attempts)) ? Math.max(0, Number(job.attempts)) : 0,
    maxAttempts: Number.isSafeInteger(Number(job?.maxAttempts)) ? Math.max(0, Number(job.maxAttempts)) : 0,
    result: safeJobResult({ ...job, type }, secrets),
    error: job?.error ? "任务执行失败；请检查对应资料、NAS 同步记录或服务端日志。" : null,
    createdAt: publicTimestamp(job?.createdAt),
    startedAt: publicTimestamp(job?.startedAt),
    finishedAt: publicTimestamp(job?.finishedAt),
  };
}

function publicAuditDetails(action, value, secrets) {
  const details = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const string = (key, max = 200) => typeof details[key] === "string" ? safeNasText(details[key], secrets, max) : undefined;
  const integer = (key) => Number.isSafeInteger(Number(details[key])) && Number(details[key]) >= 0 ? Number(details[key]) : undefined;
  const compact = (entries) => Object.fromEntries(entries.filter(([, entry]) => entry !== undefined));
  if (["user.create", "user.update"].includes(action)) return compact([["role", string("role", 40)], ["active", typeof details.active === "boolean" ? details.active : undefined]]);
  if (["agent.publish", "agent.restore_version_to_draft"].includes(action)) return compact([["version", integer("version")]]);
  if (action === "agent.generate_preview") return compact([["count", integer("count")], ["mode", string("mode", 40)]]);
  if (action === "nas.source_create") return compact([["agentSlug", string("agentSlug", 100)], ["path", string("path", 1000)]]);
  if (action === "nas.source_remove") return compact([["documentsRetained", typeof details.documentsRetained === "boolean" ? details.documentsRetained : undefined]]);
  if (["content.create", "content.update"].includes(action)) return compact([["agentSlug", string("agentSlug", 100)], ["status", string("status", 40)]]);
  if (["document.create", "document.update"].includes(action)) return compact([
    ["agentSlug", string("agentSlug", 100)], ["name", string("name", 240)], ["source", string("source", 40)],
  ]);
  if (["document.indexed", "document.reembedded"].includes(action)) return compact([["chunks", integer("chunks")], ["mode", string("mode", 80)]]);
  if (action === "document.batch_review") return compact([
    ["action", string("action", 40)], ["requested", integer("requested")],
    ["succeeded", integer("succeeded")], ["failed", integer("failed")],
  ]);
  if (action === "nas.sync") return publicSyncStats(details, secrets);
  if (action === "job.failed") return compact([["type", string("type", 80)], ["error", details.error ? "任务执行失败；请检查服务端日志。" : undefined]]);
  return null;
}

export function publicAudit(record, env = process.env) {
  const secrets = credentialValues(env);
  return {
    id: safeNasText(record?.id || "", secrets, 100),
    action: safeNasText(record?.action || "unknown", secrets, 100),
    actor: safeNasText(record?.actor || "unknown", secrets, 100),
    target: record?.target ? safeNasText(record.target, secrets, 200) : null,
    details: publicAuditDetails(record?.action, record?.details, secrets),
    createdAt: publicTimestamp(record?.createdAt),
  };
}

function safeStringArray(value, secrets, maxItems = 30, maxLength = 300) {
  return Array.isArray(value) ? value.slice(0, maxItems)
    .filter((entry) => typeof entry === "string").map((entry) => safeNasText(entry, secrets, maxLength)) : [];
}

function publicAgentRecord(agent, secrets, admin) {
  const string = (value, max) => typeof value === "string" ? safeNasText(value, secrets, max) : "";
  const profile = {
    slug: string(agent?.slug, 64), name: string(agent?.name, 80), hospital: string(agent?.hospital, 200),
    department: string(agent?.department, 100), title: string(agent?.title, 100), specialty: string(agent?.specialty, 500),
    intro: string(agent?.intro, 2000),
    accent: /^#[\da-f]{6}$/i.test(agent?.accent || "") ? agent.accent : "#2f8f65",
    accentSoft: /^#[\da-f]{6}$/i.test(agent?.accentSoft || "") ? agent.accentSoft : "#eaf6ef",
    quickQuestions: safeStringArray(agent?.quickQuestions, secrets), topics: safeStringArray(agent?.topics, secrets),
    services: safeStringArray(agent?.services, secrets),
    articles: Array.isArray(agent?.articles) ? agent.articles.slice(0, 50).filter((article) => article && typeof article === "object").map((article) => ({
      id: string(article.id, 100), title: string(article.title, 200), summary: string(article.summary, 2000),
      tag: string(article.tag, 80), readTime: string(article.readTime, 40),
    })) : [],
  };
  if (agent?.builder !== undefined) {
    try {
      const scrub = (value) => typeof value === "string" ? safeNasText(value, secrets, 100000)
        : typeof value === "number" && secrets.includes(String(value)) ? undefined
        : Array.isArray(value) ? value.map(scrub)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
      profile.builder = normalizeAgentBuilder(scrub(normalizeAgentBuilder(agent.builder)));
    } catch { /* Invalid legacy extension data is never reflected to clients. */ }
  }
  profile.healthContextEnabled = agent?.config?.healthContextEnabled !== false && profile.builder?.healthContext !== false;
  profile.citationsEnabled = agent?.config?.requireCitations !== false;
  const portrait = string(agent?.portrait, 1500);
  if (/^\/media\/avatars\/[a-f0-9]{24}$/.test(portrait) || /^\/assets\/[A-Za-z0-9_./%-]+$/.test(portrait) || /^https:\/\//i.test(portrait)) profile.portrait = portrait;
  for (const key of ["portraitPosition", "portraitTranslateY", "portraitBackground", "portraitTransformOrigin"]) {
    if (typeof agent?.[key] === "string") profile[key] = string(agent[key], 100);
  }
  if (Number.isFinite(Number(agent?.portraitScale)) && Number(agent.portraitScale) >= 0.5 && Number(agent.portraitScale) <= 2) profile.portraitScale = Number(agent.portraitScale);
  const metadata = {
    version: Number.isSafeInteger(Number(agent?.version)) && Number(agent.version) >= 0 ? Number(agent.version) : 0,
    updatedAt: publicTimestamp(agent?.updatedAt), publishedAt: publicTimestamp(agent?.publishedAt),
  };
  if (!admin) return { ...profile, ...metadata, welcomeMessage: string(agent?.config?.welcomeMessage, 1000) };
  const config = agent?.config && typeof agent.config === "object" && !Array.isArray(agent.config) ? agent.config : {};
  const number = (value, fallback, min, max, integer = false) => Number.isFinite(Number(value)) && Number(value) >= min
    && Number(value) <= max && (!integer || Number.isInteger(Number(value))) ? Number(value) : fallback;
  return { ...profile, ...metadata,
    status: ["draft", "published", "archived"].includes(agent?.status) ? agent.status : "draft",
    createdAt: publicTimestamp(agent?.createdAt), hasUnpublishedChanges: agent?.hasUnpublishedChanges === true,
    config: {
      systemPrompt: string(config.systemPrompt, 5000), welcomeMessage: string(config.welcomeMessage, 1000),
      responseStyle: string(config.responseStyle, 100), language: string(config.language, 100), model: string(config.model, 160),
      temperature: number(config.temperature, 0.3, 0, 2), topP: number(config.topP, 0.9, 0.01, 1),
      maxTokens: number(config.maxTokens, 900, 128, 8192, true), ragEnabled: config.ragEnabled === true,
      ragTopK: number(config.ragTopK, 5, 1, 12, true), ragThreshold: number(config.ragThreshold, 0.12, 0, 1),
      requireCitations: config.requireCitations === true, healthContextEnabled: config.healthContextEnabled === true,
    },
  };
}

function publicContentRecord(content, secrets) {
  const string = (value, max) => typeof value === "string" ? safeNasText(value, secrets, max) : "";
  return {
    id: string(content?.id, 100), agentSlug: string(content?.agentSlug, 64), title: string(content?.title, 200),
    summary: string(content?.summary, 2000), body: string(content?.body, 100000),
    type: ["article", "faq", "notice", "service"].includes(content?.type) ? content.type : "article",
    status: ["draft", "published"].includes(content?.status) ? content.status : "draft",
    tags: safeStringArray(content?.tags, secrets), createdAt: publicTimestamp(content?.createdAt),
    updatedAt: publicTimestamp(content?.updatedAt), publishedAt: publicTimestamp(content?.publishedAt),
  };
}

export function publicDocument(document, env = process.env) {
  const secrets = credentialValues(env);
  const safeString = (value, maxLength) => typeof value === "string" ? safeNasText(value, secrets, maxLength) : null;
  const failure = classifyKnowledgeError(document);
  return {
    ...(failure ? { errorCode: failure.code, errorLabel: failure.label, errorSuggestion: failure.suggestion, recoveryActions: failure.recoveryActions } : {}),
    id: safeString(document?.id, 100) || "",
    agentSlug: safeString(document?.agentSlug, 100) || "",
    name: safeString(document?.name, 240) || "",
    mimeType: safeString(document?.mimeType, 200) || "application/octet-stream",
    size: Number.isSafeInteger(Number(document?.size)) && Number(document.size) >= 0 ? Number(document.size) : 0,
    source: safeString(document?.source, 40) || "unknown",
    sourceId: safeString(document?.sourceId, 100),
    sourcePath: safeString(document?.sourcePath, 1000),
    status: ["queued", "processing", "review", "ready", "error", "deleted"].includes(document?.status) ? document.status : "error",
    approved: document?.approved === true,
    chunkCount: Number.isSafeInteger(Number(document?.chunkCount)) && Number(document.chunkCount) >= 0 ? Number(document.chunkCount) : 0,
    embeddingMode: safeString(document?.embeddingMode, 100),
    parseWarnings: safeParseWarnings(document?.parseWarnings),
    warning: document?.warning ? "资料处理存在警告；请检查资料状态或服务端日志。" : null,
    error: document?.error ? "资料处理失败；请检查文件格式、来源连接或服务端日志。" : null,
    revision: Number.isSafeInteger(Number(document?.revision)) && Number(document.revision) >= 0 ? Number(document.revision) : 0,
    createdAt: publicTimestamp(document?.createdAt),
    updatedAt: publicTimestamp(document?.updatedAt),
    indexedAt: publicTimestamp(document?.indexedAt),
    approvedAt: publicTimestamp(document?.approvedAt),
    approvedBy: safeString(document?.approvedBy, 100),
  };
}

export class KnowledgeService {
  constructor(database, { env = process.env, fetchImpl = fetch, s3ClientFactory, fileSystem = fs, instanceLease = null, blobReferenceDatabase = database } = {}) {
    this.database = database;
    this.blobReferenceDatabase = blobReferenceDatabase;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.s3ClientFactory = s3ClientFactory;
    this.uploadDir = path.join(database.dataDir, "uploads");
    this.fileSystem = fileSystem;
    this.instanceLease = instanceLease;
    this.leaseCompromised = null;
    this.blobStorage = new DocumentBlobStorage(this.uploadDir, { fileSystem, instanceLease });
    this.blobGcSweepPending = true;
    this.busy = false;
    this.stopped = false;
    this.timer = null;
    this.active = null;
  }

  publicJob(job) { return publicJob(job, this.env); }

  publicAudit(record) { return publicAudit(record, this.env); }

  publicDocument(document) { return publicDocument(document, this.env); }

  publicAgent(agent, { admin = true } = {}) { return publicAgentRecord(agent, credentialValues(this.env), admin); }

  publicContent(content) { return publicContentRecord(content, credentialValues(this.env)); }

  publicChunks(chunks) {
    const secrets = credentialValues(this.env);
    return (Array.isArray(chunks) ? chunks : []).slice(0, 3000).map((chunk) => ({
      id: safeNasText(chunk?.id || "", secrets, 100),
      index: Number.isSafeInteger(Number(chunk?.index)) && Number(chunk.index) >= 0 ? Number(chunk.index) : 0,
      text: safeNasText(chunk?.text || "", secrets, 5000),
    }));
  }

  publicVersion(version) {
    const secrets = credentialValues(this.env);
    return {
      version: Number.isSafeInteger(Number(version?.version)) && Number(version.version) >= 0 ? Number(version.version) : 0,
      publishedAt: publicTimestamp(version?.publishedAt),
      name: typeof version?.name === "string" ? safeNasText(version.name, secrets, 80) : "",
      actor: typeof version?.actor === "string" ? safeNasText(version.actor, secrets, 100) : "",
    };
  }

  publicDailyUsage(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => typeof row?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && Number.isFinite(Date.parse(`${row.date}T00:00:00.000Z`))).map((row) => ({
      date: row.date,
      total: Number.isSafeInteger(Number(row.total)) && Number(row.total) >= 0 ? Number(row.total) : 0,
      successful: Number.isSafeInteger(Number(row.successful)) && Number(row.successful) >= 0 ? Number(row.successful) : 0,
    }));
  }

  async publicNasSource(source) {
    const issue = nasSourceScopeIssues(await this.database.listEntities("sources")).get(source?.id);
    return publicNasSourceRecord(source, issue, credentialValues(this.env));
  }

  async assertDocumentQuota({ agentSlug, source, sourceId, size }, existing = null) {
    await this.database.assertTenantStorage?.(agentSlug,size,{documentId:existing?.id});
    const quotas = knowledgeQuotas(this.env);
    const others = (await this.database.listEntities("documents", agentSlug))
      .filter((document) => document.status !== "deleted" && document.id !== existing?.id);
    const agentDocuments = others.length + 1;
    const agentBytes = others.reduce((total, document) => total + storedBytes(document), 0) + size;
    if (agentDocuments > quotas.agentDocuments) throw new PlatformError(`该智能体的文档数量已达到 ${quotas.agentDocuments} 个上限。`, 413, "KNOWLEDGE_AGENT_DOCUMENT_QUOTA");
    if (agentBytes > quotas.agentBytes) throw new PlatformError(`该智能体的文档累计大小已超过 ${quotas.agentBytes} 字节上限。`, 413, "KNOWLEDGE_AGENT_BYTES_QUOTA");
    const sameSource = others.filter((document) => sameDocumentSource(document, source, sourceId));
    const sourceDocuments = sameSource.length + 1;
    const sourceBytes = sameSource.reduce((total, document) => total + storedBytes(document), 0) + size;
    if (sourceDocuments > quotas.sourceDocuments) throw new PlatformError(`该知识来源的文档数量已达到 ${quotas.sourceDocuments} 个上限。`, 413, "KNOWLEDGE_SOURCE_DOCUMENT_QUOTA");
    if (sourceBytes > quotas.sourceBytes) throw new PlatformError(`该知识来源的文档累计大小已超过 ${quotas.sourceBytes} 字节上限。`, 413, "KNOWLEDGE_SOURCE_BYTES_QUOTA");
  }

  async blobIsReferenced(storageKey, { indexedOnly = false } = {}) {
    if (!isDocumentStorageKey(storageKey)) return false;
    if ((await this.blobReferenceDatabase.listEntities("documents")).some((document) => document.status !== "deleted" && document.storageKey === storageKey)) return true;
    return (await collectReleaseBlobReferences(this.blobReferenceDatabase, { fileSystem: this.fileSystem, migrateLegacy: !indexedOnly })).some(reference => reference.storageKey === storageKey);
  }

  async garbageCollectBlobs({ sweep = false, force = false } = {}) {
    if (sweep) this.blobGcSweepPending = true;
    if (this.busy && !force) return { deferred: true };
    const shouldSweep = this.blobGcSweepPending;
    try {
      // Migrate legacy indexes once before considering any deletion. Each candidate then rechecks fresh small SQL indexes.
      await collectReleaseBlobReferences(this.blobReferenceDatabase, { fileSystem: this.fileSystem });
      const result = await this.blobStorage.collect({ sweep: shouldSweep, isReferenced: (storageKey) => this.blobIsReferenced(storageKey, { indexedOnly: true }) });
      if (shouldSweep && !result.sweepFailed && !result.deferred) this.blobGcSweepPending = false;
      return result;
    } catch (error) {
      if (["LEASE_COMPROMISED", "LEASE_RELEASED"].includes(error?.code)) throw error;
      return { deleted: 0, failed: 1, queued: this.blobStorage.retired.size, error: safeTaskError(error) };
    }
  }

  async storeDocument({ agentSlug, name, buffer, mimeType = "application/octet-stream", approved = false, source = "upload", sourceId = null, sourcePath = null, sourceSignature = null, existing = null }, actor = "system") {
    this.instanceLease?.assertOwned();
    await this.database.requireAgent(agentSlug);
    name = textField(name, "文件名", { max: 240, required: true }).replace(/[\\/\u0000-\u001f]/g, "_");
    if (!DOCUMENT_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new PlatformError("支持 PDF、DOCX、TXT、Markdown、CSV、HTML 与 JSON 文件。", 415, "UNSUPPORTED_DOCUMENT");
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new PlatformError("文件为空。", 400, "EMPTY_DOCUMENT");
    if (buffer.length > MAX_FILE_BYTES) throw new PlatformError("单个文件不能超过50 MB。", 413, "FILE_TOO_LARGE");
    const hash = checksum(buffer);
    const nasSource = source === "nas" ? await this.database.getEntity("sources", sourceId) : null;
    if (source === "nas" && (!nasSource || nasSource.agentSlug !== agentSlug)) throw new PlatformError("NAS 映射已移除或不属于此智能体。", 409, "SOURCE_CHANGED");
    const lookupSourceDocument = async () => sourceId && ["nas", "content"].includes(source)
      ? (await this.database.listEntities("documents", agentSlug)).find((document) => document.source === source && document.sourceId === sourceId && (source !== "nas" || document.sourcePath === sourcePath))
      : null;
    existing = existing || await lookupSourceDocument();
    const observed = existing;
    if (observed && (observed.agentSlug !== agentSlug || observed.source !== source || observed.sourceId !== sourceId || (source === "nas" && observed.sourcePath !== sourcePath))) throw new PlatformError("不能把已有资料移入其他智能体或替换为不同来源。", 409, "DOCUMENT_SOURCE_MISMATCH");
    const validateReference = async () => {
      if (source === "nas") {
        await this.ensureSourceUnchanged(nasSource);
        const issue = await this.documentProvenanceIssue({ source, sourceId, agentSlug, sourcePath }, { requirePublishedContent: false });
        if (issue) throw new PlatformError(issue.message, 409, issue.code);
      }
      if (source !== "content") return;
      const content = await this.database.getEntity("content", sourceId);
      if (!content || content.agentSlug !== agentSlug || contentChecksum(content) !== hash) throw new PlatformError("关联内容已被删除或更新，请按最新内容重新入库。", 409, "CONTENT_CHANGED");
      approved = Boolean(approved && content.status === "published");
    };
    const currentExisting = async () => {
      const current = observed ? await this.database.getEntity("documents", observed.id) : await lookupSourceDocument();
      if (observed && (!current || current.revision !== observed.revision || (current.status === "deleted" && observed.status !== "deleted"))) throw new PlatformError("资料在写入期间已被修改或移除，请刷新后重试。", 409, "DOCUMENT_CHANGED");
      if (!observed && current && current.checksum !== hash) throw new PlatformError("同一来源的其他版本已先完成写入，请刷新后重试。", 409, "DOCUMENT_CHANGED");
      return current;
    };
    await validateReference();
    existing = await currentExisting();
    if (existing && existing.checksum === hash && existing.status !== "deleted") return this.unchangedDocument(existing, { sourceSignature, sourcePath });
    await this.assertDocumentQuota({ agentSlug, source, sourceId, size: buffer.length }, existing);
    const storageKey = `${id()}.bin`;
    try { await this.blobStorage.write(storageKey, buffer); }
    catch (error) {
      this.blobStorage.finishWrite(storageKey);
      this.blobStorage.retire(storageKey);
      if (!this.busy) await this.garbageCollectBlobs();
      throw error;
    }
    let retained = false;
    let retiredStorageKey = null;
    let result;
    try {
      result = await this.database.transaction(async () => {
        // Re-check after async disk I/O. Removal, source edits and two concurrent
        // first-time index requests must not revive or duplicate old knowledge.
        await validateReference();
        existing = await currentExisting();
        if (existing && existing.checksum === hash && existing.status !== "deleted") return this.unchangedDocument(existing, { sourceSignature, sourcePath });
        await this.assertDocumentQuota({ agentSlug, source, sourceId, size: buffer.length }, existing);
        const timestamp = now();
        const document = {
          id: existing?.id || id(), agentSlug, name, mimeType, size: buffer.length,
          checksum: hash, storageKey, source, sourceId, sourcePath, sourceSignature,
          status: "queued", approved: Boolean(approved), chunkCount: 0, embeddingMode: null,
          ...(existing?.governance ? {governance:{...existing.governance,sharePolicy:"private"}} : {}),
          error: null, errorCode: null, warning: null, revision: (existing?.revision || 0) + 1,
          createdAt: existing?.createdAt || timestamp, updatedAt: timestamp, indexedAt: null,
        };
        await this.database.saveEntity("documents", document);
        const job = await this.database.enqueue("document.ingest", { documentId: document.id, checksum: hash });
        await this.database.audit(existing ? "document.update" : "document.create", actor, document.id, { agentSlug, name, source });
        if (isDocumentStorageKey(existing?.storageKey) && existing.storageKey !== storageKey) retiredStorageKey = existing.storageKey;
        return { document: this.publicDocument(document), job, unchanged: false };
      });
      retained = !result.unchanged;
    } finally {
      this.blobStorage.finishWrite(storageKey);
      if (!retained) this.blobStorage.retire(storageKey);
      if (retiredStorageKey) this.blobStorage.retire(retiredStorageKey);
      if (!this.busy) await this.garbageCollectBlobs();
    }
    return result;
  }

  async unchangedDocument(existing, { sourceSignature, sourcePath }) {
    const retract = !await this.documentProvenanceAllowsPublishing(existing) ? { approved: false, status: existing.chunkCount ? "review" : existing.status } : {};
    const document = await this.database.patchEntity("documents", existing.id, { sourceSignature, sourcePath, ...retract, updatedAt: now() });
    return { document: this.publicDocument(document), unchanged: true };
  }

  async documentProvenanceIssue(document, { requirePublishedContent = true, nasIssues, ocrDepth = 0 } = {}) {
    if(document.ocrSource){const issue=await ocrSourceIssue(this,document,{requirePublishedContent,nasIssues,ocrDepth});if(issue)return issue;}
    if (document.source === "content") {
      const content = await this.database.getEntity("content", document.sourceId);
      if (!content || content.agentSlug !== document.agentSlug || contentChecksum(content) !== document.checksum || (requirePublishedContent && content.status !== "published")) {
        return { code: "CONTENT_NOT_PUBLISHED", message: "关联内容尚未发布、已更新或已删除，不能作为公开知识来源。" };
      }
      return null;
    }
    if (document.source !== "nas") return null;
    const source = await this.database.getEntity("sources", document.sourceId);
    if (!source || source.agentSlug !== document.agentSlug) {
      return { code: "SOURCE_CHANGED", message: "NAS 映射已移除或不属于此智能体，不能作为知识来源。" };
    }
    const issues = nasIssues || nasSourceScopeIssues(await this.database.listEntities("sources"));
    const scopeIssue = issues.get(source.id);
    if (scopeIssue) return scopeIssue;
    try {
      const transport = source.transport === "minio" ? "s3" : source.transport;
      const sourcePath = normalizeNasRelativePath(source.path ?? "", { allowEmpty: transport !== "s3", maxLength: 1000 });
      const documentPath = normalizeNasRelativePath(document.sourcePath, { allowEmpty: false, maxLength: 4096 });
      // Mirror the exact boundary used by local/WebDAV/S3 reads. S3 prefixes
      // are case-sensitive, so case-folding here could authorize a path that
      // the configured source never produced.
      if (documentPath === sourcePath || (sourcePath && !documentPath.startsWith(`${sourcePath}/`))) throw new Error("outside source");
    } catch {
      return { code: "NAS_DOCUMENT_SOURCE_INVALID", message: "NAS 文档路径不在当前映射目录内，不能作为知识来源。" };
    }
    return null;
  }

  async documentProvenanceAllowsPublishing(document, options) {
    return !await this.documentProvenanceIssue(document, options);
  }

  async retractInvalidProvenance(document, issue = null) {
    issue ||= await this.documentProvenanceIssue(document, { requirePublishedContent: false });
    const latest = await this.database.getEntity("documents", document.id);
    const contentSource = document.source === "content";
    if (latest && latest.status !== "deleted" && latest.checksum === document.checksum) await this.database.patchEntity("documents", document.id, {
      approved: false,
      status: "review",
      warning: contentSource ? "关联内容已被删除或更新，旧资料不会用于回答。" : "NAS 来源映射无效或目录范围冲突，旧资料不会用于回答。",
      updatedAt: now(),
    });
    return { skipped: true, reason: issue?.message || (contentSource ? "关联内容已被删除或更新" : "NAS 来源映射无效") };
  }

  assertDocumentMutationBinding(document, binding) {
    if (!binding) return;
    if (document.agentSlug !== binding.agentSlug) {
      throw new PlatformError("资料不属于当前智能体，未执行操作。", 409, "DOCUMENT_AGENT_MISMATCH");
    }
    const currentRevision = Number.isSafeInteger(document.revision) && document.revision >= 0 ? document.revision : 0;
    if (currentRevision !== binding.revision) {
      throw new PlatformError("资料已在查看后更新，请刷新列表并重新操作。", 409, "DOCUMENT_REVISION_CONFLICT");
    }
  }

  async diagnostics(agentSlug) { return knowledgeDiagnostics(this.database, this, agentSlug); }

  async approvalPreflight(input) { return knowledgeApprovalPreflight(this.database, this, input); }

  async approveDocument(documentId, actor, binding) {
    return this.database.transaction(async () => {
      const document = await this.database.requireEntity("documents", documentId);
      this.assertDocumentMutationBinding(document, binding);
      const provenanceIssue = await this.documentProvenanceIssue(document);
      if (provenanceIssue) throw new PlatformError(provenanceIssue.message, 409, provenanceIssue.code);
      if (!["review", "ready"].includes(document.status) || !document.chunkCount) throw new PlatformError("资料解析完成后才能审核生效。", 409, "DOCUMENT_NOT_INDEXED");
      const draft = await this.database.requireAgent(document.agentSlug);
      const agent = await this.database.getAgent(document.agentSlug, true) || draft;
      const eligibility = await inspectKnowledgeDocument(this.database, this, document, { afterApproval: true, ragEnabled: true });
      if (!eligibility.retrievable) {
        const blocked = eligibility.blockedReasons[0];
        throw new PlatformError(blocked.message, 409, blocked.code);
      }
      const alreadySearchable = document.status === "ready" && document.approved === true;
      const indexedChunks = eligibility.actualChunkCount;
      const currentChunks = await this.database.countSearchableChunks(document.agentSlug);
      if (currentChunks + (alreadySearchable ? 0 : indexedChunks) > MAX_AGENT_SEARCHABLE_CHUNKS) {
        throw new PlatformError(`审核后该智能体的生效知识片段将超过单节点上限（${MAX_AGENT_SEARCHABLE_CHUNKS}），请精选知识或扩展受控检索。`, 409, "INDEX_CAPACITY_EXCEEDED");
      }
      const updated = await this.database.patchEntity("documents", documentId, { approved: true, status: "ready", updatedAt: now(), approvedAt: now(), approvedBy: actor });
      await this.database.audit("document.approve", actor, documentId);
      return { ...this.publicDocument(updated), eligibility: knowledgeEligibility(updated, { actualChunkCount: indexedChunks, ragEnabled: agent.config?.ragEnabled !== false }) };
    });
  }

  async batchReviewDocuments({ action, agentSlug, documents }, actor) {
    return this.database.transaction(async () => {
      const results = [];
      for (const { id: documentId, revision } of documents) {
        try {
          const document = await this.database.requireEntity("documents", documentId);
          if (document.agentSlug !== agentSlug) throw new PlatformError("资料不属于当前智能体，未执行审核。", 409, "DOCUMENT_AGENT_MISMATCH");
          const currentRevision = Number.isSafeInteger(document.revision) && document.revision >= 0 ? document.revision : 0;
          if (currentRevision !== revision) throw new PlatformError("资料已在勾选后更新，请刷新列表并重新审核。", 409, "DOCUMENT_REVISION_CONFLICT");
          results.push({ id: documentId, revision, ok: true, document: await this.approveDocument(documentId, actor, { agentSlug, revision }) });
        } catch (error) {
          if (!(error instanceof PlatformError)) throw error;
          results.push({ id: documentId, revision, ok: false, error: { code: error.code, message: error.message } });
        }
      }
      const succeeded = results.filter((result) => result.ok).length;
      const retrievableSucceeded = results.filter((result) => result.ok && result.document.eligibility?.retrievable === true).length;
      const summary = { action, agentSlug, requested: documents.length, succeeded, failed: documents.length - succeeded, retrievableSucceeded, approvedButNotRetrievable: succeeded - retrievableSucceeded, results };
      await this.database.audit("document.batch_review", actor, agentSlug, {
        action, requested: summary.requested, succeeded: summary.succeeded, failed: summary.failed,
      });
      return summary;
    });
  }

  async deleteDocument(documentId, actor, binding) {
    let storageKey;
    const updated = await this.database.transaction(async () => {
      const document = await this.database.requireEntity("documents", documentId);
      this.assertDocumentMutationBinding(document, binding);
      storageKey = document.storageKey;
      const deleted = await this.database.patchEntity("documents", documentId, { storageKey: null, status: "deleted", approved: false, deletedAt: now(), updatedAt: now() });
      await this.database.audit("document.soft_delete", actor, documentId);
      return deleted;
    });
    this.blobStorage.retire(storageKey);
    if (!this.busy) await this.garbageCollectBlobs();
    return this.publicDocument(updated);
  }

  async reindexDocument(documentId, actor, binding) {
    return this.database.transaction(async () => {
      const document = await this.database.requireEntity("documents", documentId);
      this.assertDocumentMutationBinding(document, binding);
      if (document.status === "deleted") throw new PlatformError("已移除的资料不能重新索引，请重新上传。", 409);
      await this.database.patchEntity("documents", documentId, { status: "queued", error: null, errorCode: null, updatedAt: now() });
      await this.database.audit("document.reindex", actor, documentId);
      return this.database.enqueue("document.ingest", { documentId, checksum: document.checksum });
    });
  }

  async reembedDocument(documentId, actor = "system", binding) {
    return this.database.transaction(async () => {
      assertExistingChunkEmbeddingConfig(this.env);
      const document = await this.database.requireEntity("documents", documentId);
      this.assertDocumentMutationBinding(document, binding);
      const snapshot = validateExistingChunkSnapshot(document, await this.database.listStoredChunkRows(document.id));
      const payload = {
        operation: "reuseExistingChunks",
        documentId: document.id,
        checksum: document.checksum,
        revision: document.revision,
        chunkCount: document.chunkCount,
        chunkDigest: snapshot.chunkDigest,
        exclusive: true,
      };
      const activeCount = await this.database.countActiveJobs();
      if (activeCount) {
        const active = await this.database.listActiveJobs(Math.min(activeCount, 2));
        const duplicate = activeCount === 1 && active[0]?.type === "document.reembed"
          && JSON.stringify(active[0].payload) === JSON.stringify(payload);
        if (!duplicate) throw new PlatformError("当前仍有排队或运行中的任务，不能开始独占向量化。", 409, "ACTIVE_JOBS_PRESENT");
      }
      const job = await this.database.enqueue("document.reembed", payload);
      await this.database.audit("document.reembed", actor, document.id);
      return job;
    });
  }

  async search(agentSlug, query, { published = false } = {}) {
    agentSlug = validateSlug(agentSlug);
    const agent = await this.database.getAgent(agentSlug, published);
    if (!agent) throw new PlatformError("智能体不存在或尚未发布。", 404, "AGENT_NOT_FOUND");
    query = textField(query, "检索问题", { required: true, max: 2000 });
    if (!agent.config.ragEnabled) return { mode: "none", citations: [] };
    const nasIssues = nasSourceScopeIssues(await this.database.listEntities("sources"));
    const documents = await this.database.listEntities("documents", agentSlug);
    const provenance = await Promise.all(documents.map(async (document) => ({
      id: document.id,
      allowed: document.status === "ready" && document.approved === true && (await inspectKnowledgeDocument(this.database, this, document, { nasIssues })).retrievable,
    })));
    const blocked = new Set(provenance.filter((entry) => !entry.allowed).map((entry) => entry.id));
    const chunks = (await this.database.searchableChunks(agentSlug)).filter((chunk) => !blocked.has(chunk.documentId));
    if (!chunks.length) return { mode: "none", citations: [] };
    const retrieval = await retrieveChunks({ query, chunks, topK: agent.config.ragTopK, threshold: agent.config.ragThreshold, env: this.env, fetchImpl: this.fetchImpl });
    const secrets = credentialValues(this.env);
    return {
      mode: ["none", "lexical", "hybrid"].includes(retrieval.mode) ? retrieval.mode : "none",
      citations: await Promise.all(retrieval.citations.map(async (citation) => ({
        id: safeNasText(citation?.id || "", secrets, 100),
        documentId: safeNasText(citation?.documentId || "", secrets, 100),
        title: safeNasText(citation?.title || "未命名文档", secrets, 300),
        text: safeNasText(citation?.text || "", secrets, 5000),
        chunkIndex: Number.isSafeInteger(Number(citation?.chunkIndex)) && Number(citation.chunkIndex) >= 0 ? Number(citation.chunkIndex) : 0,
        score: Number.isFinite(Number(citation?.score)) ? Math.max(0, Math.min(1, Number(citation.score))) : 0,
        shareUrl: await publicCitationReference(this.database, documents.find(document=>document.id===citation.documentId), citation),
      }))),
      ...(retrieval.warning ? { warning: safeNasText(retrieval.warning, secrets, 1000) } : {}),
    };
  }

  async ingest(job) {
    const document = await this.database.requireEntity("documents", job.payload.documentId);
    if (document.status === "deleted" || document.checksum !== job.payload.checksum) return { skipped: true, reason: "资料已移除或有更新版本" };
    const initialProvenanceIssue = await this.documentProvenanceIssue(document, { requirePublishedContent: false });
    if (initialProvenanceIssue) return this.retractInvalidProvenance(document, initialProvenanceIssue);
    await this.database.patchEntity("documents", document.id, { status: "processing", error: null, errorCode: null, updatedAt: now() });
    try {
      if (!/^[\da-f-]{36}\.bin$/.test(document.storageKey || "")) throw new PlatformError("文档存储标识无效。", 500);
      const buffer = await this.fileSystem.readFile(path.join(this.uploadDir, document.storageKey));
      const { text, parseWarnings } = await parseDocumentIsolated(buffer, { name: document.name, mimeType: document.mimeType }, { includeDiagnostics: true });
      if (text.length > 2000000) throw new PlatformError("文档抽取内容超过200万字符，请拆分后上传。", 413, "DOCUMENT_TEXT_LIMIT");
      await this.database.progressJob(job.id, 35);
      const chunks = chunkText(text);
      if (!chunks.length) throw new PlatformError("文档中没有可检索文字，扫描文件请先进行OCR。", 422, "PDF_OCR_REQUIRED");
      if (chunks.length > 3000) throw new PlatformError("文档片段过多，请拆分后上传。", 413, "DOCUMENT_CHUNK_LIMIT");
      const embeddings = await embedTexts(chunks.map((chunk) => chunk.text), { env: this.env, fetchImpl: this.fetchImpl });
      await this.database.progressJob(job.id, 85);
      const latest = await this.database.requireEntity("documents", document.id);
      if (latest.status === "deleted" || latest.checksum !== document.checksum) return { skipped: true, reason: "索引期间资料已更新" };
      const latestProvenanceIssue = await this.documentProvenanceIssue(latest, { requirePublishedContent: false });
      if (latestProvenanceIssue) return this.retractInvalidProvenance(latest, latestProvenanceIssue);
      const approved = !parseWarnings.length && latest.approved && await this.documentProvenanceAllowsPublishing(latest);
      const warning = [parseWarnings.length ? PDF_LAYOUT_RECOVERED_MESSAGE : null, embeddings.warning].filter(Boolean).join(" ") || null;
      await this.database.transaction(async () => {
        await this.database.replaceChunks(document, chunks, embeddings.vectors, embeddings.model);
        await this.database.patchEntity("documents", document.id, {
          status: approved ? "ready" : "review", approved, chunkCount: chunks.length,
          embeddingMode: embeddings.mode, warning, parseWarnings,
          ...(parseWarnings.length ? { approvedAt: null, approvedBy: null } : {}),
          error: null, errorCode: null, indexedAt: now(), updatedAt: now(),
        });
      });
      await this.database.audit("document.indexed", "worker", document.id, { chunks: chunks.length, mode: embeddings.mode });
      return { documentId: document.id, chunks: chunks.length, mode: embeddings.mode, status: approved ? "ready" : "review", warning, parseWarnings };
    } catch (error) {
      const latest = await this.database.getEntity("documents", document.id);
      if (latest && latest.status !== "deleted" && latest.checksum === document.checksum) {
        await this.database.patchEntity("documents", document.id, { status: "error", ...knowledgeFailureRecord(error), updatedAt: now() });
      }
      throw error;
    }
  }

  async assertExclusiveReembedJob(job) {
    if (job?.type !== "document.reembed" || job.payload?.operation !== "reuseExistingChunks"
      || job.payload?.exclusive !== true
      || typeof job.payload.documentId !== "string" || typeof job.payload.checksum !== "string"
      || !Number.isSafeInteger(job.payload.revision)
      || !Number.isSafeInteger(job.payload.chunkCount) || job.payload.chunkCount < 1 || job.payload.chunkCount > 3000
      || typeof job.payload.chunkDigest !== "string" || !/^[0-9a-f]{64}$/.test(job.payload.chunkDigest)) {
      throw new PlatformError("现有分片向量化任务载荷无效。", 409, "REEMBED_JOB_INVALID");
    }
    if (await this.database.countActiveJobs(job.id) !== 0) {
      throw new PlatformError("现有分片向量化期间出现其他活动任务，已停止写入。", 409, "REEMBED_EXCLUSIVITY_LOST");
    }
  }

  async reembedExistingChunks(job) {
    const config = assertExistingChunkEmbeddingConfig(this.env);
    await this.assertExclusiveReembedJob(job);
    const document = await this.database.requireEntity("documents", job.payload.documentId);
    if (document.checksum !== job.payload.checksum || document.revision !== job.payload.revision) {
      throw new PlatformError("资料在向量化开始前已发生变化。", 409, "DOCUMENT_CHANGED");
    }
    const provenanceIssue = await this.documentProvenanceIssue(document, { requirePublishedContent: false });
    if (provenanceIssue) throw new PlatformError(provenanceIssue.message, 409, provenanceIssue.code);
    const initialRows = await this.database.listStoredChunkRows(document.id);
    const initial = validateExistingChunkSnapshot(document, initialRows);
    if (document.chunkCount !== job.payload.chunkCount || initial.chunkDigest !== job.payload.chunkDigest) {
      throw new PlatformError("资料分片在任务排队后已发生变化。", 409, "DOCUMENT_CHANGED");
    }
    await this.database.progressJob(job.id, 20);

    const embeddings = await embedTexts(initial.texts, { env: this.env, fetchImpl: this.fetchImpl });
    const vectors = validateExistingChunkEmbeddingResult(embeddings, initialRows.length, config);
    await this.database.progressJob(job.id, 85);

    const timestamp = now();
    const result = { documentId: document.id, chunks: initialRows.length, mode: "hybrid", status: "review" };
    await this.database.transaction(async () => {
      await this.assertExclusiveReembedJob(job);
      const latest = await this.database.requireEntity("documents", document.id);
      if (latest.checksum !== document.checksum || latest.revision !== document.revision
        || latest.status !== document.status || latest.approved !== false) {
        throw new PlatformError("资料在向量化期间已发生变化。", 409, "DOCUMENT_CHANGED");
      }
      const latestIssue = await this.documentProvenanceIssue(latest, { requirePublishedContent: false });
      if (latestIssue) throw new PlatformError(latestIssue.message, 409, latestIssue.code);
      const currentRows = await this.database.listStoredChunkRows(document.id);
      const current = validateExistingChunkSnapshot(latest, currentRows);
      if (current.chunkDigest !== initial.chunkDigest || current.documentDigest !== initial.documentDigest) {
        throw new PlatformError("资料分片在向量化期间已发生变化。", 409, "DOCUMENT_CHANGED");
      }

      await this.database.updateChunkEmbeddings(currentRows, vectors, config.model);
      await this.database.patchEntity("documents", document.id, {
        status: "review", approved: false, errorCode: null, chunkCount: currentRows.length,
        embeddingMode: "hybrid", error: null, warning: null,
        indexedAt: timestamp, updatedAt: timestamp,
      });
      await this.database.audit("document.reembedded", "worker", document.id, { chunks: currentRows.length, mode: "hybrid" });
      // The document/vector commit and terminal job state share one IMMEDIATE
      // transaction, so a process restart cannot replay an already-written set
      // of vectors merely because finishJob had not run yet.
      await this.database.finishJob(job.id, result);
    });
    return result;
  }

  async ensureSourceUnchanged(source) {
    const current = await this.database.getEntity("sources", source.id);
    if (!current || current.revision !== source.revision) throw new PlatformError("同步过程中目录映射已修改或移除，请按新配置重新同步。", 409, "SOURCE_CHANGED");
    const issue = nasSourceScopeIssues(await this.database.listEntities("sources")).get(current.id);
    if (issue) throw new PlatformError(issue.message, 409, issue.code);
    return current;
  }

  async sync(job) {
    const source = await this.database.getEntity("sources", job.payload.sourceId);
    if (!source) return { skipped: true, reason: "映射已移除" };
    await this.ensureSourceUnchanged(source);
    const runId = await this.database.beginSyncRun(source.id, job.id);
    const stats = { created: 0, updated: 0, unchanged: 0, deleted: 0, skipped: 0, failed: 0, scanned: 0, attempted: 0, deferred: 0, complete: false, truncated: false, warning: null, errors: [] };
    try {
      const manifest = await listNasFiles(source, { env: this.env, fetchImpl: this.fetchImpl, s3ClientFactory: this.s3ClientFactory });
      await this.ensureSourceUnchanged(source);
      stats.complete = manifest.complete;
      stats.manifestComplete = manifest.complete;
      const warnings = manifest.warning ? [safeTaskError({ message: manifest.warning })] : [];
      stats.scanned = manifest.files.length;
      const previous = (await this.database.listEntities("documents", source.agentSlug)).filter((document) => document.sourceId === source.id);
      const previousByPath = new Map(previous.map((document) => [document.sourcePath, document]));
      const present = new Set(manifest.files.map((file) => file.path));
      const pending = [];
      for (const file of manifest.files) {
        if (!DOCUMENT_EXTENSIONS.has(path.extname(file.name).toLowerCase())) { stats.skipped += 1; continue; }
        const existing = previousByPath.get(file.path);
        if (existing && existing.status !== "deleted" && existing.sourceSignature === file.signature) {
          stats.unchanged += 1;
          continue;
        }
        pending.push(file);
      }
      const maxFiles = boundedInteger(this.env.NAS_SYNC_MAX_FILES_PER_RUN, 100, 1, 1000);
      const maxDuration = boundedInteger(this.env.NAS_SYNC_MAX_DURATION_MS, 60_000, 100, 60_000);
      const deadline = Date.now() + maxDuration;
      const pendingByPath = new Map(pending.map((file) => [file.path, file]));
      // This is a fair retry order, not a scan cursor: every run obtains a fresh
      // manifest and successful versions are skipped by signature. Persistent
      // failures move behind never-attempted or older-failed files, so one bad
      // file cannot occupy a small batch forever. State is pruned to current
      // changed versions and reset by editing the source configuration.
      const failureOrder = new Map();
      for (const entry of Array.isArray(source.syncFailureOrder) ? source.syncFailureOrder : []) {
        if (typeof entry?.path === "string" && pendingByPath.get(entry.path)?.signature === entry.signature) failureOrder.set(entry.path, entry.signature);
      }
      const failureRank = new Map([...failureOrder.keys()].map((key, index) => [key, index]));
      pending.sort((a, b) => (failureRank.get(a.path) ?? -1) - (failureRank.get(b.path) ?? -1) || a.path.localeCompare(b.path));
      for (const file of pending) {
        if (stats.attempted >= maxFiles || Date.now() >= deadline) break;
        await this.ensureSourceUnchanged(source);
        const existing = previousByPath.get(file.path);
        stats.attempted += 1;
        try {
          if (file.size > MAX_FILE_BYTES) throw new PlatformError("文件超过50 MB。", 413);
          const readTimeout = Math.max(10, Math.min(boundedInteger(this.env.NAS_TIMEOUT_MS, 20_000, 10, 60_000), deadline - Date.now()));
          const buffer = await readNasFile(source, file, { env: { ...this.env, NAS_TIMEOUT_MS: String(readTimeout) }, fetchImpl: this.fetchImpl, s3ClientFactory: this.s3ClientFactory });
          await this.ensureSourceUnchanged(source);
          const result = await this.storeDocument({
            agentSlug: source.agentSlug, name: file.name, buffer, source: "nas", sourceId: source.id,
            sourcePath: file.path, sourceSignature: file.signature, approved: source.autoPublish, existing,
          }, "nas-sync");
          if (result.unchanged) stats.unchanged += 1;
          else if (existing) stats.updated += 1;
          else stats.created += 1;
          failureOrder.delete(file.path);
        } catch (error) {
          if (error.code === "SOURCE_CHANGED" || error.code === "NAS_SOURCE_SCOPE_INVALID" || error.code === "NAS_SOURCE_SCOPE_CONFLICT") throw error;
          stats.failed += 1;
          failureOrder.delete(file.path);
          failureOrder.set(file.path, file.signature);
          if (stats.errors.length < 20) stats.errors.push({ path: file.path, error: safeTaskError(error) });
        }
        await this.database.progressJob(job.id, Math.min(95, Math.round(stats.attempted / Math.max(1, Math.min(pending.length, maxFiles)) * 95)));
      }
      stats.deferred = pending.length - stats.attempted;
      stats.truncated = stats.deferred > 0;
      if (stats.truncated) {
        stats.complete = false;
        warnings.push(`本轮下载预算已用尽，剩余 ${stats.deferred} 个变更将在下轮同步继续处理；本轮不移除缺失文件。`);
      }
      stats.warning = warnings.length ? warnings.join("；") : null;
      await this.ensureSourceUnchanged(source);
      // A complete, error-free manifest is mandatory before removing missing sources.
      if (source.deleteMissing && stats.complete && stats.failed === 0) {
        for (const document of previous) {
          if (document.status !== "deleted" && !present.has(document.sourcePath)) {
            await this.deleteDocument(document.id, "nas-sync");
            stats.deleted += 1;
          }
        }
      }
      const status = !stats.complete || stats.failed ? "partial" : "success";
      const errors = [stats.failed ? `${stats.failed} 个文件读取失败，请查看同步记录。` : null, stats.warning || (!stats.complete ? "目录扫描不完整，本轮未执行缺失文件移除。" : null)].filter(Boolean);
      await this.database.patchEntity("sources", source.id, {
        lastSyncAt: now(), lastStatus: status, lastError: errors.length ? errors.join("；").slice(0, 2000) : null,
        syncFailureOrder: [...failureOrder].map(([filePath, signature]) => ({ path: filePath, signature })),
      });
      await this.database.finishSyncRun(runId, status, stats);
      await this.database.audit("nas.sync", "worker", source.id, stats);
      return { sourceId: source.id, runId, ...stats };
    } catch (error) {
      const current = await this.database.getEntity("sources", source.id);
      if (current?.revision === source.revision) await this.database.patchEntity("sources", source.id, { lastSyncAt: now(), lastStatus: "failed", lastError: safeTaskError(error) });
      await this.database.finishSyncRun(runId, "failed", stats, safeTaskError(error));
      throw error;
    }
  }

  async scheduleDueSources() {
    // A queued reembed must be claimed before due NAS work. Reembedding is
    // deliberately exclusive so its pre/post chunk snapshots cannot overlap
    // with another knowledge job; the next scheduler tick resumes NAS work.
    if (await this.database.hasActiveJobType("document.reembed")) return;
    const sources = await this.database.listEntities("sources");
    const issues = nasSourceScopeIssues(sources);
    for (const source of sources) {
      if (!source.enabled) continue;
      if (issues.has(source.id)) continue;
      if (!source.lastSyncAt || Date.now() - new Date(source.lastSyncAt).getTime() >= source.intervalMinutes * 60000) {
        await this.database.enqueue("nas.sync", { sourceId: source.id });
      }
    }
  }

  async runOne() {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    let job;
    try { job = await this.database.claimJob(); }
    catch (error) { this.busy = false; throw error; }
    if (!job) {
      try { await this.garbageCollectBlobs({ force: true }); }
      finally { this.busy = false; }
      return false;
    }
    try {
      const result = job.type === "document.ingest" ? await this.ingest(job)
        : job.type === "document.reembed" ? await this.reembedExistingChunks(job)
        : job.type === "nas.sync" ? await this.sync(job) : (() => { throw new PlatformError("未知任务类型。", 400); })();
      if (job.type !== "document.reembed") await this.database.finishJob(job.id, result);
    } catch (error) {
      await this.database.failJob(job.id, safeTaskError(error));
      await this.database.audit("job.failed", "worker", job.id, { type: job.type, error: safeTaskError(error) });
    } finally {
      this.busy = false;
      await this.garbageCollectBlobs({ force: true });
    }
    return true;
  }

  start() {
    this.instanceLease?.assertOwned();
    if (this.leaseCompromised) throw this.leaseCompromised;
    this.stopped = false;
    const tick = () => {
      if (this.active || this.busy || this.stopped) return;
      this.active = (async () => {
        await this.scheduleDueSources();
        await this.runOne();
      })().catch((error) => console.error("Job worker:", safeTaskError(error)))
        .finally(() => { this.active = null; });
    };
    this.timer = setInterval(tick, 1000);
    this.timer.unref();
    void tick();
  }

  handleLeaseCompromised(error) {
    this.leaseCompromised = error;
    this.stopped = true;
    clearInterval(this.timer);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.active;
    await this.blobStorage.collecting?.catch(() => {});
  }

  async testSource(sourceId) {
    const source = await this.database.requireEntity("sources", sourceId);
    await this.ensureSourceUnchanged(source);
    const result = await listNasFiles(source, { env: this.env, fetchImpl: this.fetchImpl, s3ClientFactory: this.s3ClientFactory });
    await this.ensureSourceUnchanged(source);
    const secrets = credentialValues(this.env);
    return { ok: true, files: result.files.length, complete: result.complete === true,
      warning: result.warning ? safeNasText(result.warning, secrets, 1000) : null,
      sample: result.files.slice(0, 5).map((file) => safeNasText(file.path, secrets, 1000)) };
  }

  async nasStatus() {
    const sources = await this.database.listEntities("sources");
    const issues = nasSourceScopeIssues(sources);
    const secrets = credentialValues(this.env);
    return {
      configured: getNasCapabilities(this.env),
      s3: getNasS3PublicConfig(this.env),
      sources: sources.map((source) => publicNasSourceRecord(source, issues.get(source.id), secrets)),
      runs: (await this.database.listSyncRuns()).map((run) => publicSyncRun(run, secrets)),
    };
  }
}
