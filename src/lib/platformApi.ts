import type { KnowledgeDiagnostics, KnowledgeEligibility, KnowledgeExtractionRecord, KnowledgeApprovalPreflight } from './knowledgeDiagnostics';
import type { DoctorProfile } from '../data/doctorProfiles';
import type { NasCapabilities, NasS3PublicConfig, NasTransport } from './nasConnectors';
import type { AgentBuilderConfig, AgentTemplate, TemplateEvaluationCase } from './agentBuilder';

export type { NasCapabilities, NasConnectorHealth, NasS3Display, NasS3PublicConfig, NasTransport } from './nasConnectors';

export type AdminUser = { id: string; username: string; name: string; role: 'admin' | 'editor' | 'viewer' };
export type AgentConfig = { systemPrompt: string; welcomeMessage: string; responseStyle: string; language: string; model: string; temperature: number; topP: number; maxTokens: number; ragEnabled: boolean; ragTopK: number; ragThreshold: number; requireCitations: boolean; healthContextEnabled: boolean };
export type PlatformAgent = DoctorProfile & { status: 'draft' | 'published' | 'archived'; version: number; updatedAt?: string; publishedAt?: string; hasUnpublishedChanges?: boolean; draftHash?: string; config: AgentConfig; builder?: AgentBuilderConfig };
export type AgentReadiness = { required: boolean; draftHash: string; ready: boolean; issues: string[]; lastModifiedBy?: string | null; qualification: { status: 'unverified' | 'verified'; reference: string; authorizationReference: string; verifiedBy?: string; verifiedAt?: string }; review: { status: 'pending' | 'submitted' | 'approved' | 'changes_requested'; draftHash?: string; assignedTo?: string; submittedBy?: string; submittedAt?: string; note?: string; reviewedBy?: string; reviewedAt?: string }; evaluation: { draftHash?: string; cases: Array<{ id: string; prompt: string; expected: string; pass: boolean | null; answer?: string; model?: string; ranAt?: string; fallback?: boolean; note?: string }>; evaluatedBy?: string; evaluatedAt?: string } };
export type KnowledgeDocument = { id: string; agentSlug: string; name: string; size: number; mimeType?: string; source: string; sourceId?: string; sourcePath?: string; status: 'queued' | 'processing' | 'review' | 'ready' | 'error' | 'deleted'; chunkCount: number; approved: boolean; revision: number; embeddingMode?: string; error?: string; parseWarnings?: string[]; eligibility?: KnowledgeEligibility; updatedAt: string };
export type KnowledgeReviewTarget = Pick<KnowledgeDocument, 'id' | 'revision'>;
export type KnowledgeBatchReviewItem = { id: string; ok: boolean; document?: KnowledgeDocument; error?: { code?: string; message: string } };
export type KnowledgeBatchReviewResponse = { action: 'approve'; requested: number; succeeded: number; failed: number; results: KnowledgeBatchReviewItem[] };
export type Citation = { documentId: string; title: string; text: string; score: number; chunkIndex: number };
export type NasSourceStatus = 'never' | 'success' | 'partial' | 'failed';
export type NasSource = { id: string; name: string; agentSlug: string; transport: NasTransport; path: string; enabled: boolean; autoPublish: boolean; intervalMinutes: number; deleteMissing: boolean; lastSyncAt?: string; lastStatus?: NasSourceStatus; lastError?: string; syncFailureCount?: number; scopeIssue?: { code: string; message: string } | null };
export type SyncRun = { id: string; sourceId: string; status: string; startedAt?: string; finishedAt?: string; createdAt?: string; error?: string; [key: string]: unknown };
export type NasAdminStatus = { configured: NasCapabilities; sources: NasSource[]; runs: SyncRun[]; s3?: NasS3PublicConfig };
export type NasTestResult = { ok: boolean; files: number | unknown[]; complete?: boolean; warning?: string | null; sample?: string[]; capabilities?: string[] | Record<string, boolean>; health?: { ok?: boolean; status?: string; checkedAt?: string } | string };
export type PlatformJob = { id: string; type: string; status: 'queued' | 'running' | 'completed' | 'failed'; progress: number; attempts: number; result?: unknown; error?: string; createdAt: string; finishedAt?: string };
export type PlatformContent = { id: string; agentSlug: string; title: string; summary: string; body: string; type: 'article' | 'faq' | 'notice' | 'service'; status: 'draft' | 'published'; tags: string[]; updatedAt?: string };
export type Audit = { id: string; action: string; actor: string; target: string; details: unknown; createdAt: string };
export type PlatformSettings = { aiConfigured: boolean; embeddingConfigured: boolean; voiceConfigured: boolean; model: string; embeddingModel: string; embeddingApiProtocol: 'openai' | 'dashscope'; embeddingDimensions: number | null; embeddingBatchSize: number; embeddingMaxRetries: number; embeddingSegmentCharacters: number | null; nas: NasCapabilities; storage: string; version: string };
export type Overview = { stats: { agents: number; publishedAgents: number; documents: number; readyDocuments: number; chunks: number; content: number; conversations: number; failedJobs: number }; recentJobs: PlatformJob[]; recentAudit: Audit[]; dailyUsage: Array<Record<string, unknown>> };

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code; }
}

export async function platformApi<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const isForm = options.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(path, { method: options.method || 'GET', credentials: 'include', signal: options.signal,
      headers: options.body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : isForm ? options.body as FormData : JSON.stringify(options.body) });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('无法连接平台服务，请确认后端已启动并检查网络。', 0);
  }
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { throw new ApiError('平台返回了非 JSON 响应，请检查 API 地址或反向代理配置。', response.status); }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('platform-auth-required'));
    const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const nestedError = payload.error && typeof payload.error === 'object' ? payload.error as Record<string, unknown> : {};
    const message = [payload.error, nestedError.message, payload.message].find(value => typeof value === 'string');
    throw new ApiError(typeof message === 'string' ? message : `请求失败（${response.status}）`, response.status, typeof payload.code === 'string' ? payload.code : undefined);
  }
  return data as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => platformApi<T>(path, { method: 'POST', body });
export const put = <T = unknown>(path: string, body: unknown) => platformApi<T>(path, { method: 'PUT', body });
export const remove = (path: string, body?: unknown) => platformApi(path, { method: 'DELETE', body });
export const getNasAdminStatus = (signal?: AbortSignal) => platformApi<NasAdminStatus>('/api/admin/nas', { signal });
export const batchReviewDocuments = (agentSlug: string, documents: KnowledgeReviewTarget[]) => post<KnowledgeBatchReviewResponse>('/api/admin/documents/batch-review', { agentSlug, documents, action: 'approve' });
export const approveKnowledgeDocument = (agentSlug: string, document: KnowledgeReviewTarget) => post<KnowledgeDocument>(`/api/admin/documents/${encodeURIComponent(document.id)}/approve`, { agentSlug, revision: document.revision });
export const reindexKnowledgeDocument = (agentSlug: string, document: KnowledgeReviewTarget) => post<PlatformJob>(`/api/admin/documents/${encodeURIComponent(document.id)}/reindex`, { agentSlug, revision: document.revision, strategy: 'full' });
export const deleteKnowledgeDocument = (agentSlug: string, document: KnowledgeReviewTarget) => remove(`/api/admin/documents/${encodeURIComponent(document.id)}`, { agentSlug, revision: document.revision });
export const agentPath = (slug: string) => `/api/admin/agents/${encodeURIComponent(slug)}`;
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
export const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export const formatBytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value || 0} B`;

export const createAgentFromTemplate = (id: string, parameters: Record<string, string>) => post<PlatformAgent>('/api/admin/templates/' + encodeURIComponent(id) + '/instantiate', parameters);
export const copyPlatformAgent = (sourceSlug: string, input: { slug: string; name: string; copyContent?: boolean; contentAuthorized?: boolean }) => post<PlatformAgent>(agentPath(sourceSlug) + '/copy', { slug: input.slug, name: input.name, copyContent: input.copyContent === true, contentAuthorized: input.copyContent === true && input.contentAuthorized === true });
export const runAgentEvaluation = (slug: string, draftHash: string, cases: Array<{ id: string; prompt: string; expected: string }>) => post<AgentReadiness>(agentPath(slug) + '/evaluation/run', { draftHash, cases: cases.map(item => ({ id: item.id, prompt: item.prompt, expected: item.expected })) });
export const gradeAgentEvaluation = (slug: string, draftHash: string, cases: Array<{ id: string; pass: boolean | null; note?: string }>) => post<AgentReadiness>(agentPath(slug) + '/evaluation', { draftHash, cases: cases.map(item => ({ id: item.id, pass: item.pass, note: item.note || '' })) });

export const updateAgentTemplateMetadata = (id: string, input: { name: string; description: string; category: string; evaluationCases?: TemplateEvaluationCase[] }) => put<AgentTemplate>('/api/admin/templates/' + encodeURIComponent(id), { name: input.name, description: input.description, category: input.category, ...(input.evaluationCases === undefined ? {} : { evaluationCases: input.evaluationCases.map(item => ({ id: item.id, prompt: item.prompt, expected: item.expected, category: item.category })) }) });

export type AgentReviewer = { username: string; name: string };
export const getAgentReviewers = (signal?: AbortSignal) => platformApi<{ reviewers: AgentReviewer[] }>('/api/admin/reviewers', { signal });
export const submitAgentReview = (slug: string, draftHash: string, reviewer: string) => post<AgentReadiness>(agentPath(slug) + '/review/submit', { draftHash, reviewer });


export type DraftChange = { path: string; before?: unknown; after?: unknown; kind: 'added' | 'removed' | 'changed' };
export type AgentDiff = { base: unknown; draftHash: string; changes: DraftChange[] };
export type CompatibilityReport = { ok: boolean; targets: string[]; components: Array<{ id: string; version?: string | number; supportedTargets: string[]; dependencies?: string[]; enabled?: boolean; issues: string[] }>; issues: string[]; warnings?: string[] };
export type BuilderSession = { id: string; revision: number; agentSlug: string | null; baseDraftHash: string | null; status: 'clarifying' | 'draft_ready' | 'applied'; messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; createdAt: string }>; questions: string[]; draft: PlatformAgent | null; changes: DraftChange[]; createdAt: string; updatedAt: string; mode: 'ai' };
export type AgentMediaAsset = { id: string; name: string; mime: string; size: number; url: string; width?: number; height?: number; createdAt: string; agentSlug: string };
export type ChannelCandidate = { id: string; channel: 'web' | 'wechat-native'; status: 'created' | 'building' | 'ready' | 'failed'; createdAt: string; manifest?: unknown; receipt?: { status: 'accepted' | 'rejected' | 'unknown'; reference: string; note?: string; [key: string]: unknown }; error?: string };
export type BulkAgentResult = { succeeded: number; failed: number; results: Array<{ slug: string; ok: boolean; agent?: PlatformAgent; draftHash?: string; error?: string | { message?: string }; code?: string }> };
export const saveAgentDraftCAS = (slug: string, agent: PlatformAgent, expectedDraftHash: string) => put<PlatformAgent>(agentPath(slug), { ...agent, expectedDraftHash });
export const runBulkAgentAction = (action: 'edit' | 'publish' | 'archive', items: Array<{ slug: string; expectedDraftHash: string; patch?: Record<string, unknown> }>) => post<BulkAgentResult>('/api/admin/agents/bulk', { action, items: items.map(item => ({ slug: item.slug, expectedDraftHash: item.expectedDraftHash, ...(item.patch ? { patch: item.patch } : {}) })) });
export const createBuilderSession = (message: string, agentSlug?: string) => post<{ session: BuilderSession }>('/api/admin/builder/sessions', { message, ...(agentSlug ? { agentSlug } : {}) });
export const messageBuilderSession = (id: string, message: string, expectedRevision: number) => post<{ session: BuilderSession }>('/api/admin/builder/sessions/' + encodeURIComponent(id) + '/messages', { message, expectedRevision });
export const applyBuilderSession = (id: string, expectedRevision: number, input: { slug?: string; expectedDraftHash?: string }) => post<PlatformAgent>('/api/admin/builder/sessions/' + encodeURIComponent(id) + '/apply', { expectedRevision, ...(input.slug ? { slug: input.slug } : {}), ...(input.expectedDraftHash ? { expectedDraftHash: input.expectedDraftHash } : {}) });

export const getKnowledgeDiagnostics = (agentSlug: string, signal?: AbortSignal) => platformApi<KnowledgeDiagnostics>('/api/admin/knowledge/diagnostics?agentSlug=' + encodeURIComponent(agentSlug), { signal });

export const recognizeKnowledgeDocumentPages = (document: KnowledgeReviewTarget, fromPage: number, toPage: number) => post<KnowledgeExtractionRecord>(`/api/admin/documents/${encodeURIComponent(document.id)}/ocr`, { expectedRevision: document.revision, fromPage, toPage });

export const preflightKnowledgeApproval = (agentSlug: string, documents: KnowledgeReviewTarget[]) => post<KnowledgeApprovalPreflight>('/api/admin/knowledge/approval-preflight', { agentSlug, documents });
