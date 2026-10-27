import { normalizeAgentBuilder } from "../src/lib/agentBuilder.ts";
import { randomUUID } from "node:crypto";
import { nasRelativeScopesOverlap, normalizeNasRelativePath } from "./nas-path.mjs";

export class PlatformError extends Error {
  constructor(message, statusCode = 400, code = "INVALID_INPUT") {
    super(message);
    this.name = "PlatformError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_DOCUMENT_BATCH_REVIEW = 100;
export const MAX_AGENT_SEARCHABLE_CHUNKS = 25000;
export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".txt", ".md", ".markdown", ".csv", ".html", ".htm", ".json"]);

export function textField(value, name, { max = 500, required = false, fallback = "" } = {}) {
  if (value === undefined || value === null) value = fallback;
  if (typeof value !== "string") throw new PlatformError(`${name}必须是文本。`);
  const result = value.replace(/\u0000/g, "").trim();
  if (required && !result) throw new PlatformError(`请填写${name}。`);
  if (result.length > max) throw new PlatformError(`${name}不能超过 ${max} 个字符。`);
  return result;
}

function numberField(value, name, min, max, fallback, integer = false) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new PlatformError(`${name}须为 ${min} 至 ${max} 之间的${integer ? "整数" : "数字"}。`);
  }
  return number;
}

function booleanField(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new PlatformError("开关字段必须为布尔值。");
  return value;
}

function listField(value, name, fallback = []) {
  if (value === undefined) return fallback;
  if (typeof value === "string") value = value.split(/[\n,，]/);
  if (!Array.isArray(value) || value.length > 30) throw new PlatformError(`${name}最多支持 30 项。`);
  return [...new Set(value.map((item) => textField(item, name, { max: 300 })).filter(Boolean))];
}

export function validateSlug(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(value)) {
    throw new PlatformError("智能体标识须为 3—64 位小写英文、数字或连字符，且不能以连字符开头或结尾。");
  }
  return value;
}

export function normalizeDocumentBatchReview(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PlatformError("批量审核请求格式无效。", 400, "INVALID_BATCH_REVIEW");
  }
  if (input.action !== "approve") {
    throw new PlatformError("当前仅支持批量审核生效。", 400, "INVALID_BATCH_REVIEW_ACTION");
  }
  const agentSlug = validateSlug(input.agentSlug);
  if (!Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > MAX_DOCUMENT_BATCH_REVIEW) {
    throw new PlatformError(`一次可审核 1—${MAX_DOCUMENT_BATCH_REVIEW} 份资料。`, 400, "INVALID_BATCH_DOCUMENT_IDS");
  }
  const documents = [];
  const seen = new Map();
  for (const item of input.documents) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || item.id.length < 1 || item.id.length > 100
      || item.id !== item.id.trim() || /[\u0000-\u001f\u007f]/u.test(item.id)
      || !Number.isSafeInteger(item.revision) || item.revision < 0) {
      throw new PlatformError("资料标识格式无效。", 400, "INVALID_BATCH_DOCUMENT_IDS");
    }
    if (seen.has(item.id) && seen.get(item.id) !== item.revision) {
      throw new PlatformError("同一资料不能提交不同版本进行审核。", 400, "CONFLICTING_BATCH_DOCUMENT_REVISION");
    }
    if (!seen.has(item.id)) {
      seen.set(item.id, item.revision);
      documents.push({ id: item.id, revision: item.revision });
    }
  }
  return { action: "approve", agentSlug, documents };
}

function normalizeDocumentMutation(input, { allowed = [], message, code }) {
  const allowedKeys = new Set(["agentSlug", "revision", ...allowed]);
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new PlatformError(message, 400, code);
  }
  const hasAgentSlug = Object.hasOwn(input, "agentSlug");
  const hasRevision = Object.hasOwn(input, "revision");
  if (hasAgentSlug !== hasRevision) throw new PlatformError(message, 400, code);
  if (!hasAgentSlug) return undefined;
  const agentSlug = validateSlug(input.agentSlug);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new PlatformError("资料版本格式无效。", 400, "INVALID_DOCUMENT_REVISION");
  }
  return { agentSlug, revision: input.revision };
}

export function normalizeDocumentApproval(input) {
  return normalizeDocumentMutation(input, { message: "知识审核请求格式无效。", code: "INVALID_DOCUMENT_APPROVAL" });
}

export function normalizeDocumentDeletion(input) {
  return normalizeDocumentMutation(input, { message: "知识删除请求格式无效。", code: "INVALID_DOCUMENT_DELETION" });
}

export function normalizeDocumentReindex(input) {
  const binding = normalizeDocumentMutation(input, { allowed: ["strategy"], message: "重新索引策略无效。", code: "INVALID_REINDEX_STRATEGY" });
  const strategy = input && Object.hasOwn(input, "strategy") ? input.strategy : "full";
  if (!["full", "reuseExistingChunks"].includes(strategy)) {
    throw new PlatformError("重新索引策略无效。", 400, "INVALID_REINDEX_STRATEGY");
  }
  return { binding, strategy };
}

export function defaultConfig(doctor) {
  return {
    systemPrompt: `你是以${doctor.name}的专业方向配置的健康科普智能助手，不是医生本人。\n专业范围：${doctor.specialty || doctor.department || "健康科普"}。\n使用清晰、温和的中文，先理解用户问题；依据审核通过的知识库提供可核验的科普信息。\n信息不足时说明局限，提出必要的澄清问题。不得诊断、开处方、承诺疗效或替代线下就医。`,
    welcomeMessage: `你好，我是${doctor.name}的健康科普智能助手。你可以咨询${doctor.specialty || "一般健康知识"}，我的回答仅供参考，不能替代医生面诊。`,
    responseStyle: "专业清晰",
    language: "简体中文",
    model: "",
    temperature: 0.3,
    topP: 0.9,
    maxTokens: doctor.slug === "tang-jinsong" ? 300 : 900,
    ragEnabled: true,
    ragTopK: 5,
    ragThreshold: 0.12,
    requireCitations: true,
    healthContextEnabled: true,
  };
}

export function normalizeConfig(input = {}, base) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PlatformError("智能体配置格式无效。");
  const defaults = base || defaultConfig({ name: "专业", specialty: "健康科普" });
  const value = { ...defaults, ...input };
  return {
    systemPrompt: textField(value.systemPrompt, "系统提示词", { max: 5000, required: true }),
    welcomeMessage: textField(value.welcomeMessage, "欢迎语", { max: 1000 }),
    responseStyle: textField(value.responseStyle, "表达风格", { max: 100 }),
    language: textField(value.language, "回复语言", { max: 100 }),
    model: textField(value.model, "模型名称", { max: 160 }),
    temperature: numberField(value.temperature, "Temperature", 0, 2, 0.3),
    topP: numberField(value.topP, "Top P", 0.01, 1, 0.9),
    maxTokens: numberField(value.maxTokens, "最大输出长度", 128, 8192, 900, true),
    ragEnabled: booleanField(value.ragEnabled, true),
    ragTopK: numberField(value.ragTopK, "检索片段数量", 1, 12, 5, true),
    ragThreshold: numberField(value.ragThreshold, "检索阈值", 0, 1, 0.12),
    requireCitations: booleanField(value.requireCitations, true),
    healthContextEnabled: booleanField(value.healthContextEnabled, true),
  };
}

export function normalizeAgent(input = {}, existing) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PlatformError("智能体资料格式无效。");
  const value = { ...(existing || {}), ...input };
  const slug = validateSlug(existing?.slug || value.slug);
  const record = {
    slug,
    name: textField(value.name, "智能体名称", { max: 80, required: true }),
    hospital: textField(value.hospital, "机构名称", { max: 200 }),
    department: textField(value.department, "专业/科室", { max: 100, required: true }),
    title: textField(value.title, "展示身份", { max: 100, fallback: "专业健康空间" }),
    specialty: textField(value.specialty, "专业方向", { max: 500, required: true }),
    intro: textField(value.intro, "简介", { max: 2000 }),
    accent: /^#[\da-f]{6}$/i.test(value.accent || "") ? value.accent : "#2f8f65",
    accentSoft: /^#[\da-f]{6}$/i.test(value.accentSoft || "") ? value.accentSoft : "#eaf6ef",
    quickQuestions: listField(value.quickQuestions, "快捷问题"),
    topics: listField(value.topics, "专业标签"),
    services: listField(value.services, "服务名称"),
    articles: [],
  };
  if (value.portrait) {
    const portrait = textField(value.portrait, "头像地址", { max: 1500 });
    if (!/^\/assets\/[A-Za-z0-9_./%-]+$/.test(portrait) && !/^\/media\/avatars\/[a-f0-9]{24}$/.test(portrait) && !/^https:\/\//i.test(portrait)) throw new PlatformError("头像仅支持本站素材路径或 HTTPS 地址。");
    record.portrait = portrait;
  }
  for (const key of ["portraitPosition", "portraitTranslateY", "portraitBackground", "portraitTransformOrigin"]) {
    if (value[key]) record[key] = textField(value[key], "头像样式", { max: 100 });
  }
  if (value.portraitScale !== undefined) record.portraitScale = numberField(value.portraitScale, "头像比例", 0.5, 2, 1);
  if (Array.isArray(value.articles)) record.articles = value.articles.slice(0, 50).map((article) => ({
    id: textField(article.id || id(), "内容标识", { max: 100 }),
    title: textField(article.title, "文章标题", { max: 200, required: true }),
    summary: textField(article.summary, "文章摘要", { max: 2000 }),
    tag: textField(article.tag, "文章标签", { max: 80 }),
    readTime: textField(article.readTime, "阅读时长", { max: 40 }),
  }));
  record.config = normalizeConfig(input.config || {}, existing?.config || defaultConfig(record));
  if (value.builder !== undefined) {
    try { record.builder = normalizeAgentBuilder(value.builder); }
    catch (error) { throw new PlatformError(error.message, 400, "INVALID_BUILDER_CONFIG"); }
    if (record.builder) record.builder.requiresReview = true;
  }
  if (existing?.builder && !record.builder) throw new PlatformError("已有组件配置不能删除，请通过组件开关调整。", 400, "BUILDER_CONFIG_REQUIRED");
  return record;
}

export function publicAgent(agent) {
  const { config, hasUnpublishedChanges, status, ...safe } = agent;
  return { ...safe, welcomeMessage: config?.welcomeMessage || "" };
}

export function normalizeContent(input, existing) {
  const value = { ...existing, ...input };
  const type = value.type || "article";
  const status = value.status || "draft";
  if (!["article", "faq", "notice", "service"].includes(type)) throw new PlatformError("内容类型无效。");
  if (!["draft", "published"].includes(status)) throw new PlatformError("内容状态无效。");
  return {
    id: existing?.id || id(),
    agentSlug: validateSlug(existing?.agentSlug || value.agentSlug || value.doctorSlug),
    title: textField(value.title, "内容标题", { max: 200, required: true }),
    summary: textField(value.summary, "内容摘要", { max: 2000 }),
    body: textField(value.body, "内容正文", { max: 100000, required: status === "published" }),
    type, status,
    tags: listField(value.tags, "内容标签"),
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    publishedAt: status === "published" ? (existing?.publishedAt || now()) : null,
  };
}

export const NAS_SOURCE_SERVER_ONLY_FIELDS = Object.freeze([
  "url", "endpoint", "baseUrl", "username", "password", "region", "bucket", "prefix", "forcePathStyle",
  "accessKeyId", "secretAccessKey", "sessionToken", "credentials",
]);

export function hasNasSourceServerOnlyFields(source) {
  return Boolean(source && typeof source === "object" && NAS_SOURCE_SERVER_ONLY_FIELDS.some((key) => Object.hasOwn(source, key)));
}

export function normalizeSource(input, existing) {
  if (hasNasSourceServerOnlyFields(input)) throw new PlatformError("NAS 地址、存储桶与凭据只能通过服务器环境变量配置。", 400, "NAS_CONFIG_FROM_ENV_ONLY");
  const value = { ...existing, ...input };
  const requestedTransport = value.transport || "webdav";
  if (!["webdav", "local", "s3", "minio"].includes(requestedTransport)) throw new PlatformError("NAS 连接方式无效。");
  const transport = requestedTransport === "minio" ? "s3" : requestedTransport;
  let sourcePath;
  try { sourcePath = normalizeNasRelativePath(value.path ?? "", { allowEmpty: transport !== "s3", maxLength: 1000 }); }
  catch { throw new PlatformError("NAS 目录必须是连接根目录以内的安全相对路径；S3 来源不能为空，且路径不能包含重复分隔符、特殊路径字符、尾随空格/点、.. 或绝对路径。", 400, "INVALID_NAS_PATH"); }
  return {
    id: existing?.id || id(),
    name: textField(value.name, "映射名称", { required: true, max: 100 }),
    agentSlug: validateSlug(existing?.agentSlug || value.agentSlug),
    transport,
    path: sourcePath,
    enabled: booleanField(value.enabled, true),
    autoPublish: booleanField(value.autoPublish, false),
    deleteMissing: booleanField(value.deleteMissing, false),
    intervalMinutes: numberField(value.intervalMinutes, "同步间隔", 1, 1440, 5, true),
    revision: (existing?.revision || 0) + 1,
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    lastSyncAt: existing?.lastSyncAt || null,
    lastStatus: existing?.lastStatus || "never",
    lastError: existing?.lastError || null,
  };
}

function canonicalNasTransport(transport) {
  if (!['webdav', 'local', 's3', 'minio'].includes(transport)) return null;
  return transport === 'minio' ? 's3' : transport;
}

export function nasSourceScopeIssues(sources = []) {
  const issues = new Map();
  const normalized = [];
  for (const source of sources) {
    if (hasNasSourceServerOnlyFields(source)) {
      issues.set(source?.id, { code: "NAS_SOURCE_SCOPE_INVALID", message: "已有 NAS 来源包含不应持久化的连接配置，必须先通过编辑保存清理或移除该映射。" });
      continue;
    }
    const transport = canonicalNasTransport(source?.transport);
    if (!transport) {
      issues.set(source?.id, { code: "NAS_SOURCE_SCOPE_INVALID", message: "已有 NAS 来源目录不符合当前安全规则，必须先修正或移除该映射。" });
      continue;
    }
    let sourcePath;
    try { sourcePath = normalizeNasRelativePath(source?.path ?? "", { allowEmpty: transport !== "s3", maxLength: 1000 }); }
    catch {
      issues.set(source?.id, { code: "NAS_SOURCE_SCOPE_INVALID", message: "已有 NAS 来源目录不符合当前安全规则，必须先修正或移除该映射。" });
      continue;
    }
    normalized.push({ source, transport, path: sourcePath });
  }
  for (let leftIndex = 0; leftIndex < normalized.length; leftIndex += 1) {
    const left = normalized[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < normalized.length; rightIndex += 1) {
      const right = normalized[rightIndex];
      if (left.transport !== right.transport || !nasRelativeScopesOverlap(left.path, right.path)) continue;
      const message = left.source.agentSlug === right.source.agentSlug
        ? "同一智能体的 NAS 来源目录发生重叠；重复同步会造成索引与缺失文件处理竞态，必须先修正映射。"
        : "不同智能体的 NAS 来源目录发生重叠；为防止知识跨智能体混入，必须先修正映射。";
      const issue = { code: "NAS_SOURCE_SCOPE_CONFLICT", message };
      if (!issues.has(left.source.id)) issues.set(left.source.id, issue);
      if (!issues.has(right.source.id)) issues.set(right.source.id, issue);
    }
  }
  return issues;
}

export function assertSourceScopeAvailable(candidate, sources = []) {
  const candidateTransport = candidate.transport === "minio" ? "s3" : candidate.transport;
  for (const source of sources) {
    if (!source || source.id === candidate.id) continue;
    const sourceTransport = source.transport === "minio" ? "s3" : source.transport;
    if (sourceTransport !== candidateTransport) continue;
    let existingPath;
    try { existingPath = normalizeNasRelativePath(source.path ?? "", { allowEmpty: sourceTransport !== "s3", maxLength: 1000 }); }
    catch { throw new PlatformError("已有 NAS 来源目录不符合当前安全规则，请先修正或移除该映射。", 409, "NAS_SOURCE_SCOPE_INVALID"); }
    if (!nasRelativeScopesOverlap(candidate.path, existingPath)) continue;
    const ownership = source.agentSlug === candidate.agentSlug ? "同一智能体" : "不同智能体";
    throw new PlatformError(`${ownership}的 NAS 来源目录不能相同或相互包含，请选择互不重叠的子目录。`, 409, "NAS_SOURCE_SCOPE_CONFLICT");
  }
  return candidate;
}
