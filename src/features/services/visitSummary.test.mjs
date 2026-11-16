import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMedicationLines, buildTangExtraLines, buildVisitSummary } from './visitSummary.mjs';

const rec = (dateKey, metrics, note) => ({ id: dateKey, createdAt: `${dateKey}T08:00:00Z`, dateKey, completedTitles: [], source: 'manage', metrics, ...(note ? { note } : {}) });

test('no records in range gives no summary', () => {
  assert.equal(buildVisitSummary([], { today: '2026-11-02' }), null);
  assert.equal(buildVisitSummary([rec('2026-01-01', { moodScore: 5 })], { today: '2026-11-02' }), null);
});
test('averages only filled values and states the range', () => {
  const text = buildVisitSummary([rec('2026-11-01', { sleepDurationMinutes: 360, moodScore: 4 }), rec('2026-11-02', { sleepDurationMinutes: 420 })], { today: '2026-11-02' });
  assert.match(text, /2026-10-04 至 2026-11-02，有记录 2 天/);
  assert.match(text, /睡眠时长：6\.5 小时/);
  assert.match(text, /情绪稳定度：4\.0 \/ 10/);
  assert.match(text, /焦虑程度：未填写/);
});
test('lists newest first, at most seven, with notes and questions', () => {
  const records = Array.from({ length: 9 }, (_, i) => rec(`2026-10-${String(i + 10)}`, { moodScore: 5 }, i === 8 ? '夜里醒' : undefined));
  const text = buildVisitSummary(records, { today: '2026-11-02', questions: '要不要复查？' });
  assert.equal((text.match(/^- 2026-10-/gm) || []).length, 7);
  assert.ok(text.indexOf('2026-10-18') < text.indexOf('2026-10-17'));
  assert.match(text, /备注：夜里醒/);
  assert.match(text, /想问医生：\n要不要复查？/);
});
test('flags safety concern and never interprets', () => {
  const text = buildVisitSummary([rec('2026-11-02', { moodScore: 1, safetyConcern: true })], { today: '2026-11-02' });
  assert.match(text, /安全担忧：1 天/);
  assert.match(text, /不是诊断/);
  assert.doesNotMatch(text, /建议|改善|加重|好转/);
});

test('medication and smoking lines only count, and work without sleep records', () => {
  const lines = buildMedicationLines([{ date: '2026-11-02', status: '按时服用' }, { date: '2026-11-01', status: '部分漏服', note: '头晕' }], { startDate: '2026-11-01', days: { '2026-11-02': { cigarettes: 2, urges: 3 } } }, { today: '2026-11-02' });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /按时服用 1 天，部分漏服 1 天/);
  assert.match(lines[2], /合计 2 支；想吸烟 3 次/);
  const summary = buildVisitSummary([], { today: '2026-11-02', extraLines: lines });
  assert.match(summary, /用药与戒烟/);
  assert.equal(buildVisitSummary([], { today: '2026-11-02' }), null);
});

test('Tang relaxation days are unique and limited to the inclusive 30-day range', () => {
  const lines = buildTangExtraLines(['2026-10-03', '2026-10-04', '2026-11-02', '2026-11-02', '2026-11-03'], [], { today: '2026-11-02' });
  assert.deepEqual(lines, ['放松打卡 2 天']);
  assert.match(buildVisitSummary([], { today: '2026-11-02', extraLines: lines }), /放松打卡 2 天/);
});

test('Tang assessment-only summary includes zero scores, date and denominator without notes or interpretation', () => {
  const lines = buildTangExtraLines([], [
    { title: '焦虑自评 GAD-7', score: 0, maxScore: 21, date: '2026-11-02', severity: '轻度', supplement: '不应分享的补充' },
    { title: '抑郁症状自评 PHQ-9', score: 9, maxScore: 27, date: '2026-10-04' },
    { title: '过期结果', score: 8, maxScore: 21, date: '2026-10-03' },
    { title: '未来结果', score: 8, maxScore: 21, date: '2026-11-03' },
  ], { today: '2026-11-02' });
  assert.deepEqual(lines, ['焦虑自评 GAD-7：0/21 分，2026-11-02', '抑郁症状自评 PHQ-9：9/27 分，2026-10-04']);
  const summary = buildVisitSummary([], { today: '2026-11-02', extraLines: lines, extraTitle: '量表（本人自填）：' });
  assert.match(summary, /量表（本人自填）：/);
  assert.doesNotMatch(summary, /轻度|补充|过期|未来|改善|恶化/);
  assert.equal(buildVisitSummary([], { today: '2026-11-02', extraLines: buildTangExtraLines([], [], { today: '2026-11-02' }) }), null);
});
