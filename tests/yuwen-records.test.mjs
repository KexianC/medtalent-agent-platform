import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWellnessDraft, mergeWellnessRecord, normalizeWellnessRecords, validateWellnessDraft,
  validWellnessDate, wellnessAssociation, wellnessStatistics, wellnessTrend,
} from '../src/features/yuwen/recordModel.ts';

const today = '2026-09-08';
const now = '2026-09-08T03:00:00.000Z';
const record = (date, values, extra = {}) => ({ id: `record-${date}`, date, values, createdAt: now, updatedAt: now, note: '', trigger: '', coping: '', ...extra });

test('diary and health editors merge one date while preserving each other, identity and creation time', () => {
  const start = mergeWellnessRecord([], 'health', today, { values: { steps: 7000, weight: 62.5, heartRate: 70 } }, now);
  const diary = mergeWellnessRecord(start, 'diary', today, { values: { moodScore: 0, sleepHours: 6.5 }, note: '散步后舒服一些', trigger: '工作压力', coping: '与朋友聊聊' }, '2026-09-08T05:00:00.000Z');
  assert.equal(diary.length, 1);
  assert.equal(diary[0].values.steps, 7000);
  assert.equal(diary[0].values.moodScore, 0);
  const health = mergeWellnessRecord(diary, 'health', today, { values: { steps: 8000 } }, '2026-09-08T06:00:00.000Z');
  assert.equal(health.length, 1);
  assert.equal(health[0].id, start[0].id);
  assert.equal(health[0].createdAt, now);
  assert.equal(health[0].values.weight, undefined);
  assert.equal(health[0].values.moodScore, 0);
  assert.equal(health[0].note, diary[0].note);
  assert.equal(health[0].trigger, diary[0].trigger);
  assert.equal(health[0].coping, diary[0].coping);
});

test('blank numeric input stays absent, and legitimate zero survives reload', () => {
  const draft = { ...createWellnessDraft(), values: { sleepHours: ' ', moodScore: '0', nightAwakenings: '0' } };
  const result = validateWellnessDraft('diary', today, draft, today);
  assert.equal(result.error, undefined);
  assert.equal(result.patch.values.sleepHours, undefined);
  assert.equal(result.patch.values.moodScore, 0);
  assert.equal(createWellnessDraft(record(today, result.patch.values)).values.moodScore, '0');
  assert.equal(createWellnessDraft(record(today, result.patch.values)).values.sleepHours, undefined);
});

test('clearing diary fields preserves physiological data, and clearing the final content removes empty record', () => {
  const start = [record(today, { moodScore: 6, steps: 0 }, { note: '旧备注' })];
  const cleared = mergeWellnessRecord(start, 'diary', today, { values: {}, note: '', trigger: '', coping: '' }, now);
  assert.deepEqual(cleared[0].values, { steps: 0 });
  assert.equal(cleared[0].note, '');
  assert.deepEqual(mergeWellnessRecord(cleared, 'health', today, { values: {} }, now), []);
});

test('date and numeric boundaries reject future, impossible, non-finite and fractional counts', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-00-01', '2026-09-31', '', '2026-9-8']) assert.equal(validWellnessDate(date), false, date);
  assert.equal(validWellnessDate('2024-02-29'), true);
  assert.match(validateWellnessDraft('diary', '2026-09-09', createWellnessDraft(), today).error, /日期/);
  for (const value of ['NaN', 'Infinity', '-1', '25']) assert.ok(validateWellnessDraft('diary', today, { ...createWellnessDraft(), values: { sleepHours: value } }, today).error, value);
  assert.ok(validateWellnessDraft('health', today, { ...createWellnessDraft(), values: { steps: '1.5' } }, today).error);
  assert.ok(validateWellnessDraft('diary', today, { ...createWellnessDraft(), values: { moodScore: '10.1' } }, today).error);
  assert.equal(validateWellnessDraft('diary', today, { ...createWellnessDraft(), values: { sleepHours: '24', moodScore: '10' } }, today).error, undefined);
});

test('seven-day statistics cross month and year boundaries and do not treat missing dates or metrics as zero', () => {
  const records = [record('2025-12-26', { moodScore: 10 }), record('2025-12-27', { moodScore: 0 }), record('2025-12-30', { moodScore: 8 }), record('2026-01-01', { steps: 3000 }), record('2026-01-02', { moodScore: 1 })];
  const points = wellnessTrend(records, 7, '2026-01-01');
  assert.deepEqual(points.map(point => point.date), ['2025-12-26', '2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01']);
  assert.equal(points[2].record, undefined);
  const stats = wellnessStatistics(points);
  assert.equal(stats.find(item => item.key === 'moodScore').count, 3);
  assert.equal(stats.find(item => item.key === 'moodScore').average, 6);
  assert.equal(stats.find(item => item.key === 'steps').average, 3000);
  assert.equal(stats.find(item => item.key === 'sleepHours').average, undefined);
  assert.equal(wellnessTrend([], 30, '2024-03-01')[0].date, '2024-02-01');
});

test('malformed saved data is ignored and duplicated dates cannot inflate averages', () => {
  const records = normalizeWellnessRecords([null, {}, record('2026-02-30', { steps: 100 }), record(today, { steps: NaN, moodScore: 20, sleepHours: '7' }), record('2026-09-07', { steps: 5000 }), record('2026-09-07', { moodScore: 5 })]);
  assert.equal(records.length, 1);
  assert.equal(records[0].values.steps, 5000);
  assert.equal(records[0].values.moodScore, 5);
  assert.equal(wellnessStatistics(wellnessTrend(records, 7, today)).find(item => item.key === 'moodScore').count, 1);
});

test('association uses only paired dates, requires five pairs and handles constant data', () => {
  const points = wellnessTrend([1, 2, 3, 4, 5].map(index => record(`2026-09-0${index}`, { sleepHours: index, moodScore: index * 2 })), 7, '2026-09-07');
  assert.deepEqual(wellnessAssociation(points, 'sleepHours', 'moodScore'), { count: 5, coefficient: 1 });
  assert.equal(wellnessAssociation(points.slice(0, 4), 'sleepHours', 'moodScore').coefficient, undefined);
  const constant = wellnessTrend([1, 2, 3, 4, 5].map(index => record(`2026-09-0${index}`, { sleepHours: 7, moodScore: index })), 7, '2026-09-07');
  assert.equal(wellnessAssociation(constant, 'sleepHours', 'moodScore').coefficient, undefined);
});
