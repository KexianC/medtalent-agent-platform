import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  KNOWLEDGE_BATCH_LIMIT,
  batchReviewableDocumentIds,
  canBatchApproveKnowledgeDocument,
  reconcileKnowledgeReviewSelection,
  splitKnowledgeReviewTargets,
} from '../src/lib/knowledgeBatch.ts';
import { approveKnowledgeDocument, batchReviewDocuments, deleteKnowledgeDocument, reindexKnowledgeDocument } from '../src/lib/platformApi.ts';
import { runGuardedKnowledgePoll } from '../src/lib/knowledgePolling.ts';

function document(overrides = {}) {
  return {
    id: 'doc-review',
    agentSlug: 'agent-one',
    name: '待审核知识',
    size: 128,
    source: 'upload',
    status: 'review',
    chunkCount: 2,
    approved: false,
    revision: 7,
    updatedAt: '2026-09-07T00:00:00.000Z',
    ...overrides,
  };
}

test('only current unapproved review documents can be selected for batch approval', () => {
  const candidates = [
    document(),
    document({ id: 'already-approved', approved: true }),
    document({ id: 'ready', status: 'ready', approved: true }),
    document({ id: 'processing', status: 'processing' }),
    document({ id: 'error', status: 'error' }),
    document({ id: 'empty-review', chunkCount: 0 }),
  ];

  assert.equal(canBatchApproveKnowledgeDocument(candidates[0]), true);
  assert.deepEqual(batchReviewableDocumentIds(candidates), ['doc-review']);
});

test('large selections are deduplicated and split to the server batch limit with revisions intact', () => {
  const targets = Array.from({ length: 205 }, (_, index) => ({ id: `doc-${index}`, revision: index }));
  targets.push({ id: 'doc-0', revision: 999 });
  const batches = splitKnowledgeReviewTargets(targets);

  assert.equal(KNOWLEDGE_BATCH_LIMIT, 100);
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 5]);
  assert.deepEqual(batches[0][0], { id: 'doc-0', revision: 999 });
  assert.equal(new Set(batches.flat().map(target => target.id)).size, 205);
});

test('a selected document is removed when the same id refreshes to a new revision', () => {
  const staleSelection = new Map([['doc-review', 7]]);
  const unchanged = reconcileKnowledgeReviewSelection(staleSelection, [document({ revision: 7 })]);
  assert.deepEqual([...unchanged.selection], [['doc-review', 7]]);
  assert.deepEqual(unchanged.changedIds, []);

  const refreshed = reconcileKnowledgeReviewSelection(staleSelection, [document({ revision: 8 })]);
  assert.equal(refreshed.selection.size, 0);
  assert.deepEqual(refreshed.changedIds, ['doc-review']);
});

test('a delayed poll from the previous agent cannot overwrite the current agent list', async () => {
  let resolveOldRequest;
  const oldResponse = new Promise(resolve => { resolveOldRequest = resolve; });
  let current = { agentSlug: 'agent-old', generation: 1 };
  const committed = [];
  const controller = new AbortController();
  const pending = runGuardedKnowledgePoll({
    token: current,
    signal: controller.signal,
    load: () => oldResponse,
    isCurrent: token => token.agentSlug === current.agentSlug && token.generation === current.generation,
    commit: value => committed.push(value),
  });

  current = { agentSlug: 'agent-new', generation: 2 };
  resolveOldRequest([document({ id: 'old-document', agentSlug: 'agent-old' })]);
  assert.equal(await pending, false);
  assert.deepEqual(committed, []);
});

test('aborting an in-flight knowledge poll prevents a late commit', async () => {
  let resolveRequest;
  const delayedResponse = new Promise(resolve => { resolveRequest = resolve; });
  const token = { agentSlug: 'agent-old', generation: 1 };
  const committed = [];
  const controller = new AbortController();
  const pending = runGuardedKnowledgePoll({
    token,
    signal: controller.signal,
    load: () => delayedResponse,
    isCurrent: () => true,
    commit: value => committed.push(value),
  });

  controller.abort();
  resolveRequest([document()]);
  assert.equal(await pending, false);
  assert.deepEqual(committed, []);
});

test('batch review API binds every approval to agent and document revision', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request;
  globalThis.fetch = async (path, options) => {
    request = { path, options };
    return new Response(JSON.stringify({
      action: 'approve',
      requested: 2,
      succeeded: 1,
      failed: 1,
      results: [
        { id: 'doc-a', ok: true, document: document({ id: 'doc-a', status: 'ready', approved: true, revision: 4 }) },
        { id: 'doc-b', ok: false, error: { code: 'DOCUMENT_REVISION_CONFLICT', message: '文档已更新，请刷新后重新审核。' } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const result = await batchReviewDocuments('agent-one', [{ id: 'doc-a', revision: 3 }, { id: 'doc-b', revision: 8 }]);
  assert.equal(request.path, '/api/admin/documents/batch-review');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.deepEqual(JSON.parse(request.options.body), {
    agentSlug: 'agent-one',
    documents: [{ id: 'doc-a', revision: 3 }, { id: 'doc-b', revision: 8 }],
    action: 'approve',
  });
  assert.equal(result.succeeded, 1);
  assert.equal(result.results[1].error.code, 'DOCUMENT_REVISION_CONFLICT');
});

test('single approve, reindex and delete requests bind agent and viewed revision', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return new Response(JSON.stringify(path.endsWith('/reindex')
      ? { id: 'job-id', type: 'document.ingest', status: 'queued', progress: 0, attempts: 0, createdAt: '2026-09-07T00:00:00.000Z' }
      : document({ status: 'ready', approved: true })), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const target = { id: 'doc-review', revision: 7 };

  await approveKnowledgeDocument('agent-one', target);
  await reindexKnowledgeDocument('agent-one', target);
  await deleteKnowledgeDocument('agent-one', target);

  assert.deepEqual(requests.map(request => ({
    path: request.path,
    method: request.options.method,
    body: JSON.parse(request.options.body),
  })), [
    { path: '/api/admin/documents/doc-review/approve', method: 'POST', body: { agentSlug: 'agent-one', revision: 7 } },
    { path: '/api/admin/documents/doc-review/reindex', method: 'POST', body: { agentSlug: 'agent-one', revision: 7, strategy: 'full' } },
    { path: '/api/admin/documents/doc-review', method: 'DELETE', body: { agentSlug: 'agent-one', revision: 7 } },
  ]);
});

test('knowledge panel exposes accessible filtered selection and retained per-item failures', async () => {
  const panel = await readFile(new URL('../src/components/admin/Knowledge.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/pages/admin.css', import.meta.url), 'utf8');
  const operations = await readFile(new URL('../src/components/admin/Operations.tsx', import.meta.url), 'utf8');

  assert.match(panel, /aria-label="全选当前筛选结果中的待审核文档"/u);
  assert.match(panel, /canBatchApproveKnowledgeDocument\(doc\)/u);
  assert.match(panel, /requestedDocuments\.map\(document => \(\{ id: document\.id, revision: document\.revision \}\)\)/u);
  assert.match(panel, /batchReviewDocuments\(agentSlug, batch\)/u);
  assert.match(panel, /activeAgentSlug\.current !== agentSlug/u);
  assert.match(panel, /doc\.agentSlug === agentSlug && doc\.status !== 'deleted'/u);
  assert.match(panel, /approveKnowledgeDocument\(agentSlug, doc\)/u);
  assert.match(panel, /reindexKnowledgeDocument\(agentSlug, doc\)/u);
  assert.match(panel, /deleteKnowledgeDocument\(agentSlug, doc\)/u);
  assert.match(panel, /selectedRevisions\.get\(doc\.id\) === doc\.revision/u);
  assert.match(panel, /reconcileKnowledgeReviewSelection\(selectedRevisions, documents\.data\)/u);
  assert.match(panel, /setSelectedRevisions\(new Map\(failures\.map/u);
  assert.match(panel, /版本未变化且仍可审核的失败项已保留选择/u);
  assert.match(panel, /个别失败不会撤销已成功项/u);
  assert.match(panel, /查看 \{failed\} 份失败明细/u);
  assert.match(css, /\.platform-table tr\.is-selected td/u);
  assert.match(css, /\.platform-batch-feedback\.is-warning/u);
  assert.match(operations, /'document\.batch_review': '批量审核知识资料'/u);
});
