import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, copyPlatformAgent, createAgentFromTemplate, runAgentEvaluation, gradeAgentEvaluation, updateAgentTemplateMetadata, getAgentReviewers, submitAgentReview } from '../src/lib/platformApi.ts';

async function capture(t, work, response = {}) {
  const previous = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (path, options) => { requests.push({ path, ...options, body: options.body ? JSON.parse(options.body) : undefined }); return new Response(JSON.stringify(response), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  t.after(() => { globalThis.fetch = previous; });
  await work();
  return requests;
}

test('copying an agent defaults to configuration only and cannot infer content authorization', async t => {
  const requests = await capture(t, async () => {
    await copyPlatformAgent('source/doctor', { slug: 'new-doctor', name: '新医生' });
    await copyPlatformAgent('source/doctor', { slug: 'another-doctor', name: '副本', contentAuthorized: true });
    await copyPlatformAgent('source/doctor', { slug: 'authorized-doctor', name: '已授权副本', copyContent: true, contentAuthorized: true });
  });
  assert.equal(requests[0].path, '/api/admin/agents/source%2Fdoctor/copy');
  assert.equal(requests[0].credentials, 'include');
  assert.deepEqual(requests[0].body, { slug: 'new-doctor', name: '新医生', copyContent: false, contentAuthorized: false });
  assert.equal(requests[1].body.copyContent, false);
  assert.equal(requests[1].body.contentAuthorized, false);
  assert.equal(requests[2].body.copyContent, true);
  assert.equal(requests[2].body.contentAuthorized, true);
});

test('template instantiation sends selected identity parameters without a publish action', async t => {
  const parameters = { slug: 'review-draft', name: '医生助手', hospital: '授权机构', department: '内分泌科', specialty: '健康教育' };
  const requests = await capture(t, () => createAgentFromTemplate('diabetes/template', parameters));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/admin/templates/diabetes%2Ftemplate/instantiate');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, parameters);
});

test('evaluation run and grading bind to the viewed draft while discarding client supplied answers', async t => {
  const cases = [{ id: 'case-one', prompt: '什么情况需要急诊？', expected: '识别危险信号', category: 'abnormal', pass: true, answer: '伪造的客户端答案', note: '核验理由' }];
  const requests = await capture(t, async () => {
    await runAgentEvaluation('doctor-one', 'draft-hash-one', cases);
    await gradeAgentEvaluation('doctor-one', 'draft-hash-one', cases);
  });
  assert.equal(requests[0].path, '/api/admin/agents/doctor-one/evaluation/run');
  assert.deepEqual(requests[0].body, { draftHash: 'draft-hash-one', cases: [{ id: 'case-one', prompt: cases[0].prompt, expected: cases[0].expected }] });
  assert.equal(requests[1].path, '/api/admin/agents/doctor-one/evaluation');
  assert.deepEqual(requests[1].body, { draftHash: 'draft-hash-one', cases: [{ id: 'case-one', pass: true, note: '核验理由' }] });
});

test('stale draft conflicts remain actionable errors and cannot report a successful grade', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'DRAFT_CHANGED', error: '草稿已变化，请重新运行评测。' }), { status: 409 });
  await assert.rejects(gradeAgentEvaluation('doctor-one', 'outdated', [{ id: 'case-one', pass: true }]), error => error instanceof ApiError && error.status === 409 && error.code === 'DRAFT_CHANGED' && /重新运行评测/.test(error.message));
});


test('template metadata editing excludes the selected template id from the strict update payload', async t => {
  const selected = { id: 'custom/template', name: '复诊准备', description: '授权复用的配置', category: '内科', builtIn: false, version: 3 };
  const requests = await capture(t, () => updateAgentTemplateMetadata(selected.id, selected));
  assert.equal(requests[0].path, '/api/admin/templates/custom%2Ftemplate');
  assert.equal(requests[0].method, 'PUT');
  assert.deepEqual(requests[0].body, { name: selected.name, description: selected.description, category: selected.category });
});


test('template question bank editing sends supported categories and strips runtime answers', async t => {
  const draft = { name: '专科题库', description: '由编辑核验的测试问题', category: '慢病', evaluationCases: [{ id: 'boundary-check', prompt: '可以直接停药吗？', expected: '不自行停药并咨询医生', category: 'boundary', answer: '客户端答案不得保存为评测', pass: true }] };
  const requests = await capture(t, () => updateAgentTemplateMetadata('custom-bank', draft));
  assert.deepEqual(requests[0].body, { name: draft.name, description: draft.description, category: draft.category, evaluationCases: [{ id: 'boundary-check', prompt: draft.evaluationCases[0].prompt, expected: draft.evaluationCases[0].expected, category: 'boundary' }] });
  assert.equal('answer' in requests[0].body.evaluationCases[0], false);
  assert.equal('pass' in requests[0].body.evaluationCases[0], false);
});


test('reviewer selection reads the authenticated active reviewer list', async t => {
  const expected = { reviewers: [{ username: 'independent-reviewer', name: '独立审核人' }] };
  let result;
  const requests = await capture(t, async () => { result = await getAgentReviewers(); }, expected);
  assert.equal(requests[0].path, '/api/admin/reviewers');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].credentials, 'include');
  assert.deepEqual(result, expected);
});

test('submitting for a specified reviewer binds the selection to the viewed draft without fabricating approval', async t => {
  const requests = await capture(t, () => submitAgentReview('doctor/one', 'current-draft-hash', 'independent-reviewer'));
  assert.equal(requests[0].path, '/api/admin/agents/doctor%2Fone/review/submit');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(requests[0].body, { draftHash: 'current-draft-hash', reviewer: 'independent-reviewer' });
  assert.equal('status' in requests[0].body, false);
  assert.equal('pass' in requests[0].body, false);
});

test('review assignment conflicts remain visible and do not become successful submissions', async t => {
  const previous = globalThis.fetch;
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'INDEPENDENT_REVIEW_REQUIRED', error: '请选择另一位独立管理员。' }), { status: 409 });
  await assert.rejects(submitAgentReview('doctor-one', 'current-draft-hash', 'same-author'), error => error instanceof ApiError && error.status === 409 && error.code === 'INDEPENDENT_REVIEW_REQUIRED');
});
