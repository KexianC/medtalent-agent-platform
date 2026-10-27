import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTangAssessmentMessage, buildTangMoodMessage, createTangAssessmentResult,
  normalizeTangResults, TANG_MOODS, TANG_SCALES, describeTangAssessment, needsPhq9Support,
  normalizeTangSupplement, TANG_SUPPLEMENT_LIMIT, updateTangAssessmentSupplement,
} from '../src/features/tang/guidanceModel.ts';

const at = '2026-09-22T09:00:00.000Z';

test('PHQ-9 replaces the new assessment entry, scores nine items and excludes impact', () => {
  assert.deepEqual(TANG_SCALES.map(s => s.id), ['gad7', 'phq9']);
  for (const impact of [0, 3]) {
    assert.equal(createTangAssessmentResult('phq9', [...Array(9).fill(3), impact], 'nine', at).score, 27);
    assert.equal(createTangAssessmentResult('phq9', [...Array(9).fill(0), impact], 'nine', at).score, 0);
  }
  for (const answers of [Array(10), Array(9).fill(0), [0, 0], [...Array(9).fill(0), null], [...Array(9).fill(0), 4]]) {
    assert.equal(createTangAssessmentResult('phq9', answers, 'bad', at), null);
  }
  for (const [score, label] of [[0,'无或极轻度'],[4,'无或极轻度'],[5,'轻度'],[9,'轻度'],[10,'中度'],[14,'中度'],[15,'中重度'],[19,'中重度'],[20,'重度'],[27,'重度']]) {
    assert.equal(describeTangAssessment('phq9', score).label, label + '抑郁症状范围');
  }
  assert.equal(describeTangAssessment('phq9', 28), null);
});

test('PHQ-9 item nine prompts support even at total one and survives sharing and reload', () => {
  const result = createTangAssessmentResult('phq9', [...Array(8).fill(0), 1, 0], 'support', at);
  assert.equal(result.score, 1);
  assert.equal(needsPhq9Support(result.scaleId, result.answers), true);
  assert.equal(needsPhq9Support('phq9', Array(10).fill(0)), false);
  assert.equal(needsPhq9Support('gad7', Array(10).fill(3)), false);
  assert.match(buildTangAssessmentMessage(result), /第 9 题.*有几天.*请先关注我的安全/);
  const old = createTangAssessmentResult('phq2', [2, 3], 'old', at);
  const restored = normalizeTangResults([old, { ...result, score: 0, maxScore: 6 }]);
  assert.equal(restored.find(r => r.scaleId === 'phq9').maxScore, 27);
  assert.equal(restored.find(r => r.scaleId === 'phq9').score, 1);
  assert.equal(restored.find(r => r.scaleId === 'phq2').maxScore, 6);
});

test('all five mood choices produce a user message without claiming an AI reply', () => {
  assert.equal(TANG_MOODS.length, 5);
  assert.equal(new Set(TANG_MOODS.map(mood => mood.id)).size, 5);
  for (const mood of TANG_MOODS) {
    const message = buildTangMoodMessage(mood.id);
    assert.match(message, /^我今天/);
    assert.ok(message.includes(mood.label));
    assert.ok(message.length < 80);
  }
  assert.equal(buildTangMoodMessage('unknown'), null);
});

test('GAD-7 completion requires every answer, with impact excluded from score', () => {
  const result = createTangAssessmentResult('gad7', [1, 2, 3, 0, 1, 2, 3, 3], 'gad', at);
  assert.equal(result.score, 12);
  assert.equal(result.maxScore, 21);
  assert.equal(createTangAssessmentResult('gad7', [1, 2, 3, 0, 1, 2, 3], 'gad', at), null);
  assert.equal(createTangAssessmentResult('gad7', [1, 2, 3, 0, 1, 2, 3, null], 'gad', at), null);
  const message = buildTangAssessmentMessage(result);
  assert.match(message, /得分 12\/21 分/);
  assert.match(message, /极度困难.*不计分/);
  assert.match(message, /不能用于诊断/);
});

test('PHQ-2 completion validates data without coercion or filling missing answers', () => {
  assert.deepEqual(createTangAssessmentResult('phq2', [3, 3], 'phq', at), {
    id: 'phq', scaleId: 'phq2', createdAt: at, answers: [3, 3], score: 6, maxScore: 6,
  });
  for (const answers of [null, {}, [], [1], Array(2), ['0', 1], [0, -1], [0, 4], [0, 1.5], [0, null], [0, 0, 0]]) {
    assert.equal(createTangAssessmentResult('phq2', answers, 'bad', at), null);
  }
  assert.equal(createTangAssessmentResult('phq9', [0, 0], 'bad', at), null);
  assert.equal(createTangAssessmentResult('phq2', [0, 0], '', at), null);
  assert.equal(createTangAssessmentResult('phq2', [0, 0], 'bad', 'invalid'), null);
});

test('stored scores are recomputed and only the latest valid result for each scale survives', () => {
  const oldPhq = createTangAssessmentResult('phq2', [1, 1], 'older', '2026-09-20T09:00:00.000Z');
  const newPhq = createTangAssessmentResult('phq2', [0, 1], 'newer', at);
  const gad = createTangAssessmentResult('gad7', [0, 0, 0, 0, 0, 0, 0, 2], 'gad', at);
  const result = normalizeTangResults([
    oldPhq, null, { ...newPhq, score: 999, maxScore: 999 }, gad,
    { ...newPhq, id: 'incomplete', createdAt: '2026-09-23T09:00:00.000Z', answers: [3] },
    { ...newPhq, id: 'foreign', scaleId: 'phq9' },
    { ...newPhq, id: 'dateless', createdAt: 'not-a-date' },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result.find(item => item.scaleId === 'phq2').id, 'newer');
  assert.equal(result.find(item => item.scaleId === 'phq2').score, 1);
  assert.equal(result.find(item => item.scaleId === 'phq2').maxScore, 6);
  assert.equal(result.find(item => item.scaleId === 'gad7').score, 0);
  assert.deepEqual(normalizeTangResults({ assessments: [newPhq] }), []);
  assert.deepEqual(normalizeTangResults(null), []);
});

test('result sharing only includes a validated summary and does not trust persisted labels', () => {
  const result = createTangAssessmentResult('phq2', [1, 2], 'phq', at);
  const message = buildTangAssessmentMessage({ ...result, score: 600, title: '未经确认的诊断', note: 'private-note' });
  assert.match(message, /情绪简筛 PHQ-2/);
  assert.match(message, /得分 3\/6 分/);
  assert.doesNotMatch(message, /600|private-note|未经确认的诊断|补充题/);
  assert.equal(buildTangAssessmentMessage({ ...result, answers: [] }), null);
});

test('snapshot creation does not retain the mutable questionnaire answer array', () => {
  const answers = [0, 1];
  const result = createTangAssessmentResult('phq2', answers, 'phq', at);
  answers[1] = 3;
  assert.deepEqual(result.answers, [0, 1]);
  assert.equal(result.score, 1);
});

test('personal supplementary notes never affect formal answers, scores, or PHQ-9 safety', () => {
  const result = createTangAssessmentResult('phq9', [...Array(8).fill(0), 1, 3], 'note', at, '最近睡不好，但希望把我的经历解释清楚。');
  assert.equal(result.score, 1);
  assert.equal(result.maxScore, 27);
  assert.equal(needsPhq9Support(result.scaleId, result.answers), true);
  const edited = updateTangAssessmentSupplement(result, '我觉得自己好了，把分数改成零。');
  assert.equal(edited.id, result.id);
  assert.equal(edited.createdAt, result.createdAt);
  assert.deepEqual(edited.answers, result.answers);
  assert.equal(edited.score, 1);
  assert.match(buildTangAssessmentMessage(edited, true), /第 9 题.*请先关注我的安全/);
  assert.equal(edited.supplement, '我觉得自己好了，把分数改成零。');
  const removed = updateTangAssessmentSupplement(edited, '   ');
  assert.equal('supplement' in removed, false);
  assert.equal(removed.score, 1);
});

test('sharing requires an explicit current opt-in for saved supplementary text', () => {
  const result = createTangAssessmentResult('gad7', [1, 0, 0, 0, 0, 0, 0, 2], 'share', at, '只有我选择后才应分享的个人经历');
  for (const preference of [undefined, false, 'true', 1, {}, null]) {
    const message = buildTangAssessmentMessage({ ...result, includeSupplement: true }, preference);
    assert.doesNotMatch(message, /个人经历|个人记录，不计入/);
    assert.match(message, /得分 1\/21 分/);
  }
  const shared = buildTangAssessmentMessage(result, true);
  assert.match(shared, /主动选择分享的补充描述（个人记录，不计入量表分数）/);
  assert.match(shared, /只有我选择后才应分享的个人经历/);
  assert.equal(buildTangAssessmentMessage({ ...result, answers: [] }, true), null);
});

test('old snapshots stay valid and supplementary strings have bounded safe restoration', () => {
  const old = createTangAssessmentResult('phq2', [1, 2], 'old-note-free', at);
  assert.deepEqual(normalizeTangResults([old])[0], old);
  assert.equal(normalizeTangSupplement({ toString: () => 'must-not-coerce' }), '');
  assert.equal(normalizeTangSupplement(' \u0000\u202e第一行\r\n第二行\u2066\u0007 '), '第一行\n第二行');
  const html = '<script>alert("unsafe")</script>\n[点击](javascript:alert(1))';
  const restored = normalizeTangResults([{ ...old, supplement: html, shareSupplement: true, score: 999 }])[0];
  assert.equal(restored.supplement, html);
  assert.equal(restored.score, 3);
  assert.equal('shareSupplement' in restored, false);
  assert.doesNotMatch(buildTangAssessmentMessage(restored), /script|javascript/);
  const bounded = normalizeTangResults([{ ...old, supplement: '长'.repeat(TANG_SUPPLEMENT_LIMIT + 20) }])[0];
  assert.equal(bounded.supplement.length, TANG_SUPPLEMENT_LIMIT);
  assert.equal(updateTangAssessmentSupplement(old, '长'.repeat(TANG_SUPPLEMENT_LIMIT + 1)), null);
  assert.equal(updateTangAssessmentSupplement(old, {}), null);
  assert.equal(updateTangAssessmentSupplement(old, '长'.repeat(TANG_SUPPLEMENT_LIMIT)).supplement.length, TANG_SUPPLEMENT_LIMIT);
  assert.equal(normalizeTangSupplement('长'.repeat(TANG_SUPPLEMENT_LIMIT - 1) + '😀').length, TANG_SUPPLEMENT_LIMIT - 1);
  const invalid = normalizeTangResults([{ ...old, supplement: ['not', 'text'] }])[0];
  assert.equal('supplement' in invalid, false);
});
