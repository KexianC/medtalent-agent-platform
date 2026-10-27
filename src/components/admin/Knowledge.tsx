import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database, ListChecks, Plus, RefreshCw, Search, UploadCloud, X } from 'lucide-react';
import { batchReviewableDocumentIds, canBatchApproveKnowledgeDocument, reconcileKnowledgeReviewSelection, splitKnowledgeReviewTargets } from '../../lib/knowledgeBatch';
import { runGuardedKnowledgePoll, type KnowledgePollToken } from '../../lib/knowledgePolling';
import {
  agentPath,
  approveKnowledgeDocument,
  batchReviewDocuments,
  preflightKnowledgeApproval,
  deleteKnowledgeDocument,
  errorMessage,
  formatBytes,
  formatTime,
  platformApi,
  post,
  reindexKnowledgeDocument,
  recognizeKnowledgeDocumentPages,
  type Citation,
  type KnowledgeDocument,
} from '../../lib/platformApi';
import { EmptyState, ErrorBanner, Field, Loading, Panel, Status, useAction, useResource } from './shared';
import { useConfirm } from './Confirmation';

type Notify = (message: string, error?: boolean) => void;
type BatchFailure = { id: string; name: string; message: string; code?: string };
type BatchFeedback = { requested: number; succeeded: number; effective: number; unavailable: number; unverified: number; failures: BatchFailure[] };
import { documentDiagnostic, recoveryInstructions, summarizeReviewResults, combinedApprovalPreflight, extractionReceipt, ocrPageRangeError, type KnowledgeDiagnostics } from '../../lib/knowledgeDiagnostics';
import { KnowledgeCoverage } from './KnowledgeCoverage';

export function KnowledgePanel({ agentSlug, canEdit, notify: sendNotice, onOpenGovernance, onOpenNas }: { agentSlug: string; canEdit: boolean; notify: Notify; onOpenGovernance?: (tab: 'documents' | 'extractions') => void; onOpenNas?: () => void }) {
  const confirm = useConfirm();
  const documents = useResource<KnowledgeDocument[]>(`/api/admin/documents?agentSlug=${encodeURIComponent(agentSlug)}`);
  const diagnostics = useResource<KnowledgeDiagnostics>(`/api/admin/knowledge/diagnostics?agentSlug=${encodeURIComponent(agentSlug)}`);
  const reloadDiagnostics=diagnostics.reload;
  useEffect(() => { if (documents.data) reloadDiagnostics(); }, [documents.data, reloadDiagnostics]);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [textOpen, setTextOpen] = useState(false);
  const [textName, setTextName] = useState('');
  const [textValue, setTextValue] = useState('');
  const [previewId, setPreviewId] = useState<string>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ mode: string; citations: Citation[] }>();
  const [selectedRevisions, setSelectedRevisions] = useState<Map<string, number>>(() => new Map());
  const [selectionNotice, setSelectionNotice] = useState('');
  const [batchFeedback, setBatchFeedback] = useState<BatchFeedback>();
  const [preflightFeedback,setPreflightFeedback]=useState<ReturnType<typeof combinedApprovalPreflight>>();
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const pollingGeneration = useRef(0);
  const activeAgentSlug = useRef(agentSlug);
  activeAgentSlug.current = agentSlug;
  const notify:Notify=(message,error)=>{if(activeAgentSlug.current===agentSlug)sendNotice(message,error)};
  const { busy, run } = useAction(notify);

  useEffect(() => {
    const generation = ++pollingGeneration.current;
    if (!documents.data?.some(doc => ['queued', 'processing'].includes(doc.status))) return;
    const controller = new AbortController();
    const token: KnowledgePollToken = { agentSlug, generation };
    let inFlight = false;
    const isCurrent = (candidate: KnowledgePollToken) => (
      !controller.signal.aborted
      && pollingGeneration.current === candidate.generation
      && activeAgentSlug.current === candidate.agentSlug
    );
    const poll = () => {
      if (inFlight) return;
      inFlight = true;
      void runGuardedKnowledgePoll({
        token,
        signal: controller.signal,
        load: signal => platformApi<KnowledgeDocument[]>(`/api/admin/documents?agentSlug=${encodeURIComponent(token.agentSlug)}`, { signal }),
        isCurrent,
        commit: documents.setData,
      }).catch(() => undefined).finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(poll, 4000);
    return () => {
      controller.abort();
      if (pollingGeneration.current === generation) pollingGeneration.current += 1;
      window.clearInterval(timer);
    };
  }, [agentSlug, documents.data, documents.setData]);

  useEffect(() => {
    setSelectedRevisions(new Map());
    setSelectionNotice('');
    setBatchFeedback(undefined);
    setPreflightFeedback(undefined);
    setPreviewId(undefined);
    setResults(undefined);
    activeAgentSlug.current=agentSlug;
    return()=>{activeAgentSlug.current=''};
  }, [agentSlug]);

  useEffect(() => {
    if (!documents.data) return;
    const reconciled = reconcileKnowledgeReviewSelection(selectedRevisions, documents.data);
    const unchanged = reconciled.selection.size === selectedRevisions.size
      && [...reconciled.selection].every(([id, revision]) => selectedRevisions.get(id) === revision);
    if (!unchanged) setSelectedRevisions(reconciled.selection);
    if (reconciled.changedIds.length) {
      setSelectionNotice(`${reconciled.changedIds.length} 份已选知识在刷新后内容版本发生变化，系统已取消选择。请重新查看内容后再勾选审核。`);
    }
  }, [documents.data, selectedRevisions]);

  const all = (documents.data || []).filter(doc => doc.agentSlug === agentSlug && doc.status !== 'deleted');
  const shown = all.filter(doc => (
    (!filter || doc.name.toLowerCase().includes(filter.toLowerCase()))
    && (!status || doc.status === status)
  ));
  const reviewableShown = shown.filter(canBatchApproveKnowledgeDocument);
  const reviewableShownIds = batchReviewableDocumentIds(reviewableShown);
  const selectedDocuments = all.filter(doc => selectedRevisions.get(doc.id) === doc.revision && canBatchApproveKnowledgeDocument(doc));
  const selectedCount = selectedDocuments.length;
  const selectedVisibleCount = reviewableShown.filter(doc => selectedRevisions.get(doc.id) === doc.revision).length;
  const allVisibleSelected = reviewableShownIds.length > 0 && selectedVisibleCount === reviewableShownIds.length;

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
  }, [allVisibleSelected, selectedVisibleCount]);

  const clearSelection = () => {setSelectedRevisions(new Map());setPreflightFeedback(undefined)};
  const changeFilter = (value: string) => { setFilter(value); clearSelection(); };
  const changeStatus = (value: string) => { setStatus(value); clearSelection(); };
  const toggleSelected = (document: KnowledgeDocument, checked: boolean) => {
    setSelectionNotice('');
    setPreflightFeedback(undefined);
    setSelectedRevisions(current => {
      const next = new Map(current);
      if (checked) next.set(document.id, document.revision); else next.delete(document.id);
      return next;
    });
  };
  const toggleAllShown = (checked: boolean) => {
    setSelectionNotice('');
    setSelectedRevisions(current => {
      const next = new Map(current);
      for (const document of reviewableShown) {
        if (checked) next.set(document.id, document.revision); else next.delete(document.id);
      }
      return next;
    });
  };

  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files);
    void run(async () => {
      let uploaded = 0;
      try {
        for (const file of selected) {
          if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} 超过 50 MB 上限。`);
          const body = new FormData();
          body.append('file', file);
          body.append('approved', 'false');
          await post(`${agentPath(agentSlug)}/documents`, body);
          uploaded += 1;
        }
      } catch (error) {
        throw new Error(`${uploaded ? `已成功上传 ${uploaded} 份；` : ''}${errorMessage(error)}`);
      } finally {
        documents.reload();
        if (inputRef.current) inputRef.current.value = '';
      }
      return uploaded;
    }, '文件已上传并进入处理队列；解析完成后请审核生效。');
  };

  const approveSelected = async () => {
    const requestedDocuments = selectedDocuments;
    if (documents.loading || !requestedDocuments.length) return;
    const preflight = await run(async () => {const responses=[];for(const targets of splitKnowledgeReviewTargets(requestedDocuments.map(document=>({id:document.id,revision:document.revision}))))responses.push(await preflightKnowledgeApproval(agentSlug,targets));return combinedApprovalPreflight(agentSlug,responses);});
    if(!preflight||activeAgentSlug.current!==agentSlug)return;
    setPreflightFeedback(preflight);
    if(!preflight.fits){notify('所选资料审核后会超过单医生片段容量，请减少所选资料并重新核验；本次未审核。',true);return;}
    if(!preflight.eligible){notify('当前所选资料均未通过审核前检查，请按下方原因修复；本次未审核。',true);return;}
    const accepted = await confirm(
      `确认人工审核这 ${requestedDocuments.length} 份知识？检查可审核${preflight.eligible}份、阻挡${preflight.blocked}份，预计当前可检索${preflight.retrievable}份。\n\n请确认内容完整、来源已授权且适合该智能体。系统将逐项处理；个别失败不会撤销已成功项。生效后，它们会参与 AI 检索回答。`,
      { title: '批量人工审核', confirmLabel: `确认人工审核 ${requestedDocuments.length} 份` },
    );
    if (!accepted) return;
    if (activeAgentSlug.current !== agentSlug) {
      notify('智能体已切换，本次批量审核未执行。请在当前知识库重新选择。', true);
      return;
    }

    const documentsById = new Map(requestedDocuments.map(document => [document.id, document]));
    void run(async () => {
      setBatchFeedback(undefined);
      setBatchProgress({ completed: 0, total: requestedDocuments.length });
      const succeededIds = new Set<string>();
      const failures: BatchFailure[] = [];
      const approvedResults: Parameters<typeof summarizeReviewResults>[0] = [];
      let completed = 0;

      const reviewTargets = requestedDocuments.map(document => ({ id: document.id, revision: document.revision }));
      for (const batch of splitKnowledgeReviewTargets(reviewTargets)) {
        if(activeAgentSlug.current!==agentSlug)return;
        const documentIds = batch.map(document => document.id);
        try {
          const response = await batchReviewDocuments(agentSlug, batch);
          const resultsById = new Map(response.results.map(result => [result.id, result]));
          for (const id of documentIds) {
            const result = resultsById.get(id);
            if (result?.ok) { succeededIds.add(id); approvedResults.push(result); }
            else failures.push({
              id,
              name: documentsById.get(id)?.name || id,
              message: result?.error?.message || '服务端未返回该文档的审核结果。',
              code: result?.error?.code,
            });
          }
        } catch (error) {
          const message = errorMessage(error);
          failures.push(...documentIds.map(id => ({ id, name: documentsById.get(id)?.name || id, message })));
        }
        completed += documentIds.length;
        setBatchProgress({ completed, total: requestedDocuments.length });
      }

      if(activeAgentSlug.current!==agentSlug)return;
      const counts = summarizeReviewResults(approvedResults);
      const feedback = { requested: requestedDocuments.length, succeeded: succeededIds.size, effective: counts.effective, unavailable: counts.unavailable, unverified: counts.unverified, failures };
      setBatchFeedback(feedback);
      setSelectedRevisions(new Map(failures.map(failure => [failure.id, documentsById.get(failure.id)!.revision] as const)));
      documents.reload();
      notify(
        failures.length
          ? `批量审核完成：${succeededIds.size}份通过，${counts.effective}份当前可检索，${failures.length}份失败；版本未变化且仍可审核的失败项已保留选择。`
          : `${succeededIds.size}份资料审核通过，${counts.effective}份当前可检索；可用性以最新诊断为准。`,
        failures.length > 0,
      );
    }).finally(() => setBatchProgress(undefined));
  };

  return <div className="platform-stack">
    <Panel
      title="专属知识库"
      description="仅该智能体的已审核生效片段参与检索。支持 PDF、DOCX、TXT、Markdown、CSV、HTML、JSON，单文件上限 50 MB。"
      action={<button className="agent-secondary-button" type="button" disabled={documents.loading || busy} onClick={documents.reload}><RefreshCw size={14} />刷新</button>}
    >
      {diagnostics.loading ? <Loading label="正在核验当前智能体的知识可用性…" /> : diagnostics.error ? <ErrorBanner message="知识可用性核验未完成，不能仅按向量或解析数量判断生效。" onRetry={diagnostics.reload} /> : diagnostics.data?.agentSlug === agentSlug && <KnowledgeCoverage data={diagnostics.data} />}
      <div className="agent-knowledge-stats">
        {[
          [all.length, '文档总数'],
          [all.filter(doc => doc.approved).length, '审核通过'],
          [all.filter(doc => doc.status === 'review').length, '待审核'],
          [all.reduce((sum, doc) => sum + (doc.chunkCount || 0), 0), '已解析片段（含未审核）'],
        ].map(([value, label]) => <article key={label}><span><Database size={16} /></span><div><b>{value}</b><small>{label}</small></div></article>)}
      </div>

      <div className="agent-upload-zone">
        <span><UploadCloud size={20} /></span>
        <div><b>添加经过授权的知识资料</b><p>默认人工审核。扫描图片／PDF请到识别校验，核对文字后再送入知识库待审核。</p></div>
        <button type="button" disabled={!canEdit || busy} onClick={() => inputRef.current?.click()}>{busy ? '正在处理…' : '选择文件上传'}</button>
        <input ref={inputRef} className="platform-visually-hidden" type="file" multiple accept=".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm,.json" onChange={event => upload(event.target.files)} aria-label="上传知识文件" />
      </div>

      <div className="platform-toolbar">
        <button className="agent-secondary-button" type="button" disabled={!canEdit || busy} onClick={() => setTextOpen(value => !value)}><Plus size={14} />添加文本知识</button>
        {onOpenGovernance && <button type="button" disabled={busy} onClick={() => onOpenGovernance('extractions')}>识别校验／OCR待核</button>}
        {onOpenNas && <button type="button" disabled={busy} onClick={onOpenNas}>查看该医生NAS来源</button>}
      </div>
      {textOpen && <form className="platform-inline-form" onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          await post(`${agentPath(agentSlug)}/documents/text`, { name: /\.(txt|md|markdown)$/i.test(textName) ? textName : textName.slice(0, 196) + '.txt', text: textValue, approved: false });
          setTextName('');
          setTextValue('');
          setTextOpen(false);
          documents.reload();
        }, '文本已提交处理，解析完成后请审核。');
      }}>
        <Field label="知识名称 *"><input required value={textName} onChange={event => setTextName(event.target.value)} maxLength={200} /></Field>
        <Field label="知识正文 *"><textarea required rows={6} value={textValue} onChange={event => setTextValue(event.target.value)} /></Field>
        <button className="agent-primary-button" disabled={busy || !canEdit} type="submit">提交待审核知识</button>
      </form>}

      <div className="agent-knowledge-toolbar">
        <label><Search size={14} /><input value={filter} onChange={event => changeFilter(event.target.value)} placeholder="搜索文档名称或来源目录" aria-label="搜索知识文档" /></label>
        <select aria-label="文档状态" value={status} onChange={event => changeStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value="ready">审核通过（仍需核验可检索）</option>
          <option value="review">待审核（可批量审核）</option>
          <option value="queued">排队中</option>
          <option value="processing">处理中</option>
          <option value="error">处理失败</option>
        </select>
      </div>

      <div className="platform-batch-review-bar" aria-live="polite">
        <span className="platform-batch-review-icon"><ListChecks size={18} /></span>
        <div>
          <b>批量人工审核</b>
          <p>{selectedCount ? `已选择 ${selectedCount} 份待审核知识` : `当前筛选结果中有 ${reviewableShownIds.length} 份可审核知识`} · 仅已解析出片段的待审核文档可选择；批量操作逐项处理，可能部分成功</p>
        </div>
        {selectedCount > 0 && <button className="agent-secondary-button" type="button" disabled={busy} onClick={clearSelection}>取消选择</button>}
        <button className="agent-primary-button" type="button" disabled={!canEdit || documents.loading || busy || selectedCount === 0} onClick={() => void approveSelected()}>
          <CheckCircle2 size={15} />
          {batchProgress ? `正在审核 ${batchProgress.completed}/${batchProgress.total}` : `确认人工审核${selectedCount ? `（${selectedCount}）` : ''}`}
        </button>
      </div>

      {preflightFeedback&&<details open={preflightFeedback.blocked>0||!preflightFeedback.fits}><summary>本次审核前只读检查：可审核{preflightFeedback.eligible}份，阻挡{preflightFeedback.blocked}份，预计当前可检索{preflightFeedback.retrievable}份</summary><p>当前审核片段{preflightFeedback.currentlyApprovedChunks}，所选新增{preflightFeedback.additionalChunks}，审核后预计{preflightFeedback.projectedApprovedChunks}／上限{preflightFeedback.limit}。检查不会审核资料，实际操作仍逐项校验版本和容量。</p><ul>{preflightFeedback.items.filter(item=>!item.eligible||!item.retrievableAfterApproval).map(item=><li key={item.id}>{all.find(document=>document.id===item.id)?.name||'当前所选资料'}：{(item.eligible?item.runtimeBlockedReasons:item.blockedReasons).map(reason=>reason.message).join('；')||'当前可用性待核验'}</li>)}</ul></details>}
      {selectionNotice && <div className="platform-alert is-warning" role="alert"><AlertTriangle size={17} /><span>{selectionNotice}</span><button type="button" aria-label="关闭知识版本变化提示" onClick={() => setSelectionNotice('')}><X size={15} /></button></div>}
      {batchFeedback && <BatchReviewFeedback feedback={batchFeedback} onClose={() => setBatchFeedback(undefined)} />}

      {documents.loading ? <Loading /> : documents.error ? <ErrorBanner message={documents.error} onRetry={documents.reload} /> : shown.length ? <div className="platform-table-wrap">
        <table className="platform-table platform-knowledge-table">
          <thead><tr>
            <th className="platform-select-cell">
              <input
                ref={selectAllRef}
                className="platform-selection-input"
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!canEdit || busy || reviewableShownIds.length === 0}
                onChange={event => toggleAllShown(event.target.checked)}
                aria-label="全选当前筛选结果中的待审核文档"
                title={reviewableShownIds.length ? `选择当前筛选结果中的 ${reviewableShownIds.length} 份待审核知识` : '当前筛选结果中没有可审核知识'}
              />
            </th>
            <th>文档 / 来源</th><th>大小</th><th>片段</th><th>状态</th><th>更新时间</th><th>操作</th>
          </tr></thead>
          <tbody>{shown.map(doc => {
            const selectable = canBatchApproveKnowledgeDocument(doc);
            const selected = selectedRevisions.get(doc.id) === doc.revision;
            const diagnostic = documentDiagnostic(diagnostics.data, doc);
            const errorGroup = diagnostics.data?.errorGroups.find(group => group.code === diagnostic?.errorCode);
            const actions = diagnostic?.recoveryActions || errorGroup?.recoveryActions || [];
            const instructions = recoveryInstructions(actions);
            return <tr key={doc.id} className={selected ? 'is-selected' : undefined}>
              <td className="platform-select-cell">
                <input
                  className="platform-selection-input"
                  type="checkbox"
                  checked={selected}
                  disabled={!canEdit || busy || !selectable}
                  onChange={event => toggleSelected(doc, event.target.checked)}
                  aria-label={`选择知识文档：${doc.name}`}
                  title={selectable ? '选择后可批量审核生效' : '仅待审核文档可批量选择'}
                />
              </td>
              <td><b>{doc.name}</b><small>{doc.source === 'nas' ? 'NAS同步资料' : doc.source === 'content' ? '运营内容' : '上传／文本资料'}</small>{doc.parseWarnings?.includes('PDF_LAYOUT_RECOVERED') && <small className="platform-error-text">版面异常恢复草稿：请对照原件核对文字顺序、完整性和内容后审核。</small>}{doc.status === 'error' && <small className="platform-error-text">{errorGroup?.label || '资料处理失败，等待安全分类'}</small>}{errorGroup && <small>{errorGroup.suggestion}</small>}{instructions.length > 0 && <details><summary>恢复建议</summary><ul>{instructions.map(instruction => <li key={instruction}>{instruction}</li>)}</ul><p>转换或重新识别不会自动审核；原失败资料保留，确认替代版本后再人工处理。</p></details>}</td>
              <td>{formatBytes(doc.size)}</td>
              <td>{doc.chunkCount || 0}<small>{doc.embeddingMode || '尚未索引'}</small></td>
              <td>{doc.status === 'ready' ? <span className="platform-status status-review">已审核</span> : <Status value={doc.status} />}<small>{diagnostic ? diagnostic.retrievable ? '当前可检索' : diagnostic.blockedReasons.map(reason => reason.message).join('；') || '当前不可检索' : '可用性待核验'}</small></td>
              <td>{formatTime(doc.updatedAt)}</td>
              <td><div className="platform-row-actions">
                <button type="button" onClick={() => setPreviewId(doc.id)}>查看</button>
                {doc.status === 'review' && <button type="button" disabled={!canEdit || busy} onClick={async () => {
                  if (await confirm(`确认已审核“${doc.name}”的内容和授权？生效后会参与 AI 检索回答。`)) {
                    if (activeAgentSlug.current !== agentSlug) { notify('智能体已切换，本次审核未执行。', true); return; }
                    void run(async () => { const result = await approveKnowledgeDocument(agentSlug, doc); documents.reload(); notify(result.eligibility?.retrievable ? '审核通过，当前可参与检索。' : result.eligibility ? '审核通过，但当前未参与检索：' + result.eligibility.blockedReasons.map(reason => reason.message).join('；') : '审核通过；当前可用性尚未核验，请查看诊断。'); });
                  }
                }}>审核生效</button>}
                <a className="platform-link-button" href={`/api/admin/documents/${encodeURIComponent(doc.id)}/download`} download>下载原件</a>
                {doc.status === 'error' && (doc.mimeType === 'application/pdf' || /\.pdf$/i.test(doc.name)) && <DocumentOcrForm name={doc.name} disabled={!canEdit || busy} onSubmit={(fromPage,toPage) => run(async () => {const response=await recognizeKnowledgeDocumentPages(doc,fromPage,toPage);if(activeAgentSlug.current!==agentSlug)return;const receipt=extractionReceipt(response);notify(receipt.message,receipt.error);diagnostics.reload();if(response.status==='review')onOpenGovernance?.('extractions');})}/>}
                {onOpenGovernance && diagnostic && !diagnostic.retrievable && doc.status === 'ready' && <button type="button" disabled={busy} onClick={() => onOpenGovernance('documents')}>查看治理条件</button>}
                <button type="button" disabled={!canEdit || busy || ['queued', 'processing'].includes(doc.status)} onClick={async () => { if (doc.status === 'error' && !await confirm('请先按分类建议修复原件或环境。重新解析同一原件不会自动完成格式转换或OCR，也不会自动审核。确认已修复并重新解析？')) return; if(activeAgentSlug.current !== agentSlug)return; void run(async () => { await reindexKnowledgeDocument(agentSlug, doc); documents.reload(); }, '重新解析任务已提交，尚未解析或审核完成。'); }}>重新解析</button>
                <button type="button" className="platform-danger" disabled={!canEdit || busy} onClick={async () => {
                  if (await confirm(`确认从知识库删除“${doc.name}”？删除后不再参与检索，NAS 原始文件不受此操作影响。`)) {
                    if (activeAgentSlug.current !== agentSlug) { notify('智能体已切换，本次删除未执行。', true); return; }
                    void run(async () => { await deleteKnowledgeDocument(agentSlug, doc); documents.reload(); }, '知识文档已删除。');
                  }
                }}>删除</button>
              </div></td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <EmptyState title={filter || status ? '没有符合筛选条件的文档' : '知识库还没有文档'} detail="上传文件、添加文本，或在 NAS 自动同步中建立目录映射。" />}
    </Panel>

    <Panel title="检索测试" description="用真实问题检查知识命中。没有命中时不会伪造来源；测试不会生成医疗建议。">
      <form className="platform-search-form" onSubmit={event => {
        event.preventDefault();
        setResults(undefined);
        void run(async () => {
          const result = await post<{ mode: string; citations: Citation[] }>('/api/admin/knowledge/search', { agentSlug, query });
          setResults(result);
        });
      }}>
        <input aria-label="检索测试问题" required placeholder="输入一个与知识资料相关的问题" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="agent-primary-button" type="submit" disabled={busy}><Search size={15} />检索测试</button>
      </form>
      {results && <>
        <p className="platform-note">检索模式：{results.mode} · 命中 {results.citations.length} 个片段</p>
        {results.citations.length ? <div className="platform-chunks">{results.citations.map((citation, index) => <article key={`${citation.documentId}:${citation.chunkIndex}:${index}`}><header><b>{citation.title}</b><small>片段 {citation.chunkIndex + 1} · 得分 {Number(citation.score).toFixed(3)}</small></header><p>{citation.text}</p></article>)}</div> : <EmptyState title="没有匹配的已审核知识" detail="请核查资料内容、审核状态及检索阈值，或改用更具体的问题。" />}
      </>}
    </Panel>
    {previewId && <DocumentPreview id={previewId} onClose={() => setPreviewId(undefined)} />}
  </div>;
}

function BatchReviewFeedback({ feedback, onClose }: { feedback: BatchFeedback; onClose: () => void }) {
  const failed = feedback.failures.length;
  const pending = feedback.unavailable + feedback.unverified;
  const tone = failed === 0 && !pending ? 'is-success' : feedback.succeeded > 0 ? 'is-warning' : 'is-error';
  return <div className={`platform-batch-feedback ${tone}`} role={failed ? 'alert' : 'status'}>
    <span>{failed ? <AlertTriangle size={18} /> : <CheckCircle2 size={18} />}</span>
    <div>
      <b>批量审核结果与当前可检索状态</b>
      <p>本次共{feedback.requested}份：审核通过{feedback.succeeded}份，当前可检索{feedback.effective}份，失败{failed}份。{pending > 0 && `另有${feedback.unavailable}份当前排除、${feedback.unverified}份可用性待核验。`}</p>
      {failed > 0 && <details open>
        <summary>查看 {failed} 份失败明细</summary>
        <ul>{feedback.failures.map(failure => <li key={failure.id}><b>{failure.name}</b><span>{failure.message}</span></li>)}</ul>
      </details>}
    </div>
    <button type="button" className="platform-icon-button" aria-label="关闭批量审核结果" onClick={onClose}><X size={16} /></button>
  </div>;
}

function DocumentPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const resource = useResource<{ document: KnowledgeDocument; chunks: Array<{ id: string; text: string; index: number }> }>(`/api/admin/documents/${encodeURIComponent(id)}`);
  return <div className="platform-modal-mask"><section className="platform-modal platform-modal-large" role="dialog" aria-modal="true" aria-labelledby="document-preview-title">
    <header><h2 id="document-preview-title">{resource.data?.document.name || '知识预览'}</h2><button type="button" className="platform-icon-button" aria-label="关闭预览" onClick={onClose}><X size={19} /></button></header>
    {resource.loading ? <Loading /> : resource.error ? <ErrorBanner message={resource.error} onRetry={resource.reload} /> : <>
      <p className="platform-note">以下是实际提取的知识片段，请确认完整性、内容质量与来源授权；能预览不代表已审核或当前可检索。</p>
      {resource.data.document.parseWarnings?.includes('PDF_LAYOUT_RECOVERED') && <p className="platform-alert is-warning" role="alert">版面异常恢复草稿：这些文字通过兼容方式提取，请对照原件检查顺序、缺漏和医学内容，再决定是否审核。</p>}
      <a href={`/api/admin/documents/${encodeURIComponent(id)}/download`} download>下载原件核对</a>
      {resource.data?.chunks.length ? <div className="platform-chunks">{resource.data.chunks.map(chunk => <article key={chunk.id}><header><b>片段 {chunk.index + 1}</b></header><p>{chunk.text}</p></article>)}</div> : <EmptyState title="尚无可预览片段" detail="文件可能仍在处理或解析失败。请返回列表查看安全分类，下载原件核对并选择转换或OCR。" />}
    </>}
  </section></div>;
}

function DocumentOcrForm({name,disabled,onSubmit}:{name:string;disabled:boolean;onSubmit:(fromPage:number,toPage:number)=>Promise<unknown>}) {const [fromPage,setFromPage]=useState(1),[toPage,setToPage]=useState(20),[processing,setProcessing]=useState(false);const error=ocrPageRangeError(fromPage,toPage);return <details><summary>分段OCR核验</summary><form aria-label={name+'分段OCR核验'} onSubmit={async event=>{event.preventDefault();if(error)return;setProcessing(true);try{await onSubmit(fromPage,toPage)}finally{setProcessing(false)}}}><fieldset disabled={disabled||processing}><p>直接读取当前资料原件，无需重新上传。每段最多20页；尾页以服务端实际总页数校验。识别只生成待人工核对文字，不替换原件、不自动审核。</p><Field label="开始页"><input type="number" required min={1} step={1} value={fromPage} onChange={event=>setFromPage(Number(event.target.value))}/></Field><Field label="结束页"><input type="number" required min={fromPage} max={fromPage+19} step={1} value={toPage} onChange={event=>setToPage(Number(event.target.value))}/></Field>{error&&<p role="alert">{error}</p>}<button type="submit" disabled={!!error}>{processing?'正在识别该页段，请勿重复提交…':'识别该页段并人工核对'}</button></fieldset></form></details>;}
