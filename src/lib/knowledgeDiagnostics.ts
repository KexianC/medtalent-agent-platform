import type { KnowledgeDocument } from './platformApi';
export type KnowledgeBlockedReason = { code: string; message: string };
export type KnowledgeEligibility = { retrievable: boolean; blockedReasons: KnowledgeBlockedReason[] };
export type KnowledgeDocumentDiagnostic = KnowledgeEligibility & { id: string; revision: number; errorCode?: string; errorLabel?: string; errorSuggestion?: string; actualChunkCount?: number; recoveryActions?: string[] };
export type KnowledgeSourceDiagnostic = { id: string; agentSlug: string; documentCount?: number; searchableDocuments?: number; errorDocuments?: number; lastStatus?: string; scanned?: number; failed?: number; complete?: boolean; lastSyncAt?: string };
export type KnowledgeDiagnostics = { agentSlug: string; ragEnabled: boolean; summary: { documents: number; totalChunks: number; approvedDocuments: number; searchableDocuments: number; searchableChunks: number; reviewDocuments: number; errorDocuments: number; blockedDocuments: number; queuedDocuments: number; processingDocuments: number }; availability: KnowledgeDocumentDiagnostic[]; errorGroups: Array<{ code: string; label: string; count: number; suggestion: string; recoveryActions?: string[] }>; sources?: KnowledgeSourceDiagnostic[]; agentReasons?: KnowledgeBlockedReason[]; capacity?: { limit: number; currentlyApprovedChunks: number; remaining: number; reviewChunks: number; allReviewFits: boolean } };
export function documentDiagnostic(data: KnowledgeDiagnostics | undefined, document: Pick<KnowledgeDocument, 'id' | 'revision' | 'agentSlug'>) {
  if (data?.agentSlug !== document.agentSlug) return undefined;
  return data.availability.find(item => item.id === document.id && item.revision === document.revision);
}
export function knowledgeCoverage(data: KnowledgeDiagnostics) {
  const count = data.summary;
  if (!data.ragEnabled) return { title: '当前智能体已关闭知识检索', warning: true, detail: '资料审核状态仍保留；开启检索后还需满足来源、有效期和片段完整性条件。' };
  if (!count.documents) return { title: '当前智能体尚无知识资料', warning: true, detail: '请先上传已授权资料、添加文字或配置该智能体的NAS映射，再解析并人工审核。' };
  if (!count.searchableDocuments || !count.searchableChunks) return { title: '当前没有可检索的已审核知识', warning: true, detail: '请按下方待审核、处理失败和排除原因逐项处理。有向量或已解析出片段，不表示已审核或能被问答检索。' };
  return { title: '当前有 ' + count.searchableDocuments + ' 份资料、' + count.searchableChunks + ' 个片段可检索', warning: false, detail: '可检索状态来自服务端审核、来源、有效期、冲突和片段校验，不代表每个问题都能命中或答案已获医学签认。' };
}
export const recoveryLabels: Record<string, string> = { download: '下载原件核对', ocr: '扫描资料需OCR识别并人工核对', convert: '使用本地工具转为TXT或DOCX后重新上传', split: '按章节拆分后重新上传', unlock: '由有权人员移除密码后重新上传', check_source: '检查NAS来源配置和文件读取权限', retry_after_fix: '修复原件或环境后再重新解析', review: '查看内容与授权后人工审核', governance: '核对有效期与冲突设置', source: '核对来源映射' };
export function recoveryInstructions(actions: string[] = []) { return [...new Set(actions)].map(action => recoveryLabels[action]).filter((value): value is string => Boolean(value)); }
export function extractionReceipt(value: unknown) {
  const status = value && typeof value === 'object' && 'status' in value ? String(value.status) : '';
  if (status === 'error' || status === 'failed') return { error: true, message: extractionProblem(value && typeof value === 'object' && 'errorCode' in value ? String(value.errorCode) : undefined) + '本次未生成知识，原件不会自动替换或审核。' };
  if (status === 'awaiting-provider' || status === 'awaiting_provider') return { error: true, message: '识别服务尚未就绪，本次未生成知识。请先配置本地OCR语言包或授权的转录服务。' };
  if (status === 'review') return { error: false, message: '识别文字已生成，等待人工对照原件核对；尚未进入可检索知识。' };
  if (status === 'confirmed') return { error: false, message: '人工核对文字已送入知识库待处理/审核，尚未自动生效。' };
  return { error: false, message: '操作已保存，请查看最新状态。' };
}
export function summarizeReviewResults(results: Array<{ ok: boolean; document?: { eligibility?: KnowledgeEligibility } }>) {
  const approved = results.filter(item => item.ok);
  return { approved: approved.length, effective: approved.filter(item => item.document?.eligibility?.retrievable === true).length, unavailable: approved.filter(item => item.document?.eligibility?.retrievable === false).length, unverified: approved.filter(item => !item.document?.eligibility).length };
}

export type KnowledgeExtractionRecord = { id: string; agentSlug?: string; name?: string; status: string; text?: string; revision: number; sourceDocumentId?: string; sourceDocumentRevision?: number; fromPage?: number; toPage?: number; totalPages?: number };
export function ocrPageRangeError(fromPage: number, toPage: number) { if (!Number.isSafeInteger(fromPage)||!Number.isSafeInteger(toPage)||fromPage<1||toPage<fromPage) return '请输入从1开始、结束不早于开始的整数页段。'; if(toPage-fromPage+1>20) return '每次最多识别20页，请分段处理并逐段人工核对。'; return ''; }

export type KnowledgeApprovalPreflight = { agentSlug: string; requested: number; eligible: number; blocked: number; readOnly: boolean; capacity: { limit: number; currentlyApprovedChunks: number; additionalChunks: number; projectedApprovedChunks: number; remaining: number; fits: boolean }; items: Array<{id:string;revision:number;eligible:boolean;chunkCount?:number;blockedReasons:KnowledgeBlockedReason[];retrievableAfterApproval:boolean;runtimeBlockedReasons:KnowledgeBlockedReason[]}> };
export function combinedApprovalPreflight(agentSlug: string, responses: KnowledgeApprovalPreflight[]) {
 if(!responses.length||responses.some(response=>response.agentSlug!==agentSlug||response.readOnly!==true)) throw new Error('审核前检查未覆盖当前智能体，请刷新后重试。');
 const items=responses.flatMap(response=>response.items),limit=Math.min(...responses.map(response=>response.capacity.limit)),currentlyApprovedChunks=Math.max(...responses.map(response=>response.capacity.currentlyApprovedChunks)),additionalChunks=responses.reduce((sum,response)=>sum+response.capacity.additionalChunks,0);
 return {items,eligible:items.filter(item=>item.eligible).length,blocked:items.filter(item=>!item.eligible).length,retrievable:items.filter(item=>item.eligible&&item.retrievableAfterApproval).length,limit,currentlyApprovedChunks,additionalChunks,projectedApprovedChunks:currentlyApprovedChunks+additionalChunks,remaining:Math.max(0,limit-currentlyApprovedChunks),fits:currentlyApprovedChunks+additionalChunks<=limit};
}

const extractionProblems: Record<string,string> = { OCR_NOT_CONFIGURED:'本地OCR语言包尚未配置，请配置后重试。', OCR_RANGE_INVALID:'页段无效：每段最多20页，请核对起止页和原件总页数。', OCR_FILE_LIMIT:'原件超过50MiB安全限制，请人工拆分副本。', PDF_PAGE_LIMIT:'原件超过2000页安全限制，请人工拆分副本。', OCR_PAGE_DIMENSIONS:'页面尺寸超过安全范围，请重新导出或拆分。', OCR_TEXT_LIMIT:'本页段文字超过上限，请缩小页段。', OCR_TIMEOUT:'本页段识别超时，请缩小页段。', OCR_EMPTY:'本页段没有识别到有效文字，请下载核对并人工转录。', OCR_SOURCE_CHANGED:'原件已变化或移除，请刷新并核对当前版本。', OCR_ORIGINAL_INVALID:'原件缺失或完整性校验未通过，请核对原件。', OCR_PROCESS_FAILED:'识别未完成，请缩小页段或人工转换。' };
export function extractionProblem(code?: string) { return code && Object.prototype.hasOwnProperty.call(extractionProblems,code) ? extractionProblems[code] : '识别未完成，请核对文件格式、页数与服务配置后重试。'; }
