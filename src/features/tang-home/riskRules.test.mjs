import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDiaryItems, buildRiskItems, buildScaleAdvice } from './riskRules.mjs';

const now = new Date('2026-11-02T12:00:00Z').getTime();
const at = (days) => new Date(now - days * 86400000).toISOString();
const phq9 = (score, item9, days = 1) => ({ scaleId: 'phq9', score, answers: [0, 0, 0, 0, 0, 0, 0, 0, item9], createdAt: at(days) });

test('PHQ-9 item 9 raises a high reminder even at a low total score', () => {
  assert.equal(buildRiskItems({ results: [phq9(1, 1)], now })[0].level, 'high');
});

test('no data produces no reminder', () => {
  assert.deepEqual(buildRiskItems({ now }), []);
});

test('scale results older than two weeks are ignored', () => {
  assert.deepEqual(buildRiskItems({ results: [phq9(20, 2, 20)], now }), []);
});

test('low mood needs at least three recent days', () => {
  const record = (days, moodScore) => ({ createdAt: at(days), metrics: { moodScore } });
  assert.deepEqual(buildRiskItems({ records: [record(1, 2), record(2, 2)], now }), []);
  assert.equal(buildRiskItems({ records: [record(1, 2), record(2, 2), record(3, 3)], now })[0].level, 'medium');
});

test('scale advice starts at 10 for GAD-7 and PHQ-9', () => {
  for (const [id, name] of [['gad7', 'GAD-7'], ['phq9', 'PHQ-9']]) {
    assert.equal(buildScaleAdvice(id, 9), null);
    assert.equal(buildScaleAdvice(id, 10), `本次 ${name} 得分为10分。结果仅供筛查参考，不代表诊断。建议预约门诊，由医生进一步评估。`);
  }
  assert.equal(buildScaleAdvice('gad7', 12), '本次 GAD-7 得分为12分。结果仅供筛查参考，不代表诊断。建议预约门诊，由医生进一步评估。');
  assert.equal(buildScaleAdvice('phq2', 12), null);
  assert.equal(buildScaleAdvice('other', 12), null);
});

const diaryRecord = (days, metrics) => ({ createdAt: at(days), metrics });
const moodText = '近 7 天情绪稳定度偏低，建议把这个变化告诉医生。';
const anxietyText = '近 7 天焦虑程度偏高，建议把这个变化告诉医生。';

test('diary reminders require three numeric entries per metric', () => {
  assert.deepEqual(buildDiaryItems({ now }), []);
  const records = [diaryRecord(1, { moodScore: 1, anxietyScore: 9 }), diaryRecord(2, { moodScore: 1, anxietyScore: 9 }), diaryRecord(3, {}), { createdAt: at(4) }];
  assert.deepEqual(buildDiaryItems({ records, now }), []);
  assert.deepEqual(buildDiaryItems({ records: [...records, diaryRecord(3, { moodScore: 1 })], now }), [moodText]);
  assert.deepEqual(buildDiaryItems({ records: [...records, diaryRecord(3, { anxietyScore: 9 })], now }), [anxietyText]);
});

test('diary reminders preserve inclusive mean thresholds and seven day window', () => {
  const records = [diaryRecord(1, { moodScore: 2, anxietyScore: 6 }), diaryRecord(2, { moodScore: 3, anxietyScore: 7 }), diaryRecord(7, { moodScore: 4, anxietyScore: 8 })];
  assert.deepEqual(buildDiaryItems({ records, now }), [moodText, anxietyText]);
  assert.deepEqual(buildRiskItems({ records, now }), [{ level: 'medium', text: moodText }, { level: 'medium', text: anxietyText }]);
  assert.deepEqual(buildDiaryItems({ records: records.map(record => ({ ...record, metrics: { moodScore: 4, anxietyScore: 6 } })), now }), []);
  assert.deepEqual(buildDiaryItems({ records: [...records.slice(0, 2), diaryRecord(7.001, { moodScore: 1, anxietyScore: 9 })], now }), []);
});

test('diary reminders exclude safety and scale reminders', () => {
  assert.deepEqual(buildDiaryItems({ records: [diaryRecord(1, { safetyConcern: true })], results: [phq9(20, 2)], now }), []);
});
