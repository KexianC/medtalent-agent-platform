import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSpecialtyStats,
  getSpecialtyRecordConfig,
  normalizeSpecialtyMeasurements,
  saveSpecialtyRecord,
  validateSpecialtyRecordInput,
} from '../src/lib/specialtyRecords.ts';
import {
  formatHealthMetricsSummary,
  normalizeHealthRecord,
  normalizeHealthRecords,
} from '../src/lib/healthRecords.ts';

const reference = new Date(2026, 8, 9, 12);
const record = (dateKey, measurements, extra = {}) => ({
  id: `record-${dateKey}`,
  dateKey,
  createdAt: `${dateKey}T03:00:00.000Z`,
  updatedAt: `${dateKey}T03:00:00.000Z`,
  source: 'manage',
  completedTitles: [],
  measurements,
  ...extra,
});

test('all nine specialty configurations expose relevant fields without inventing measurements', () => {
  const expected = {
    'fu-junfen': ['fastingGlucose', 'postMealGlucose', 'heightCm', 'weightKg'],
    'chen-zhiling': ['nasalBlockageScore', 'tinnitusScore', 'throatDiscomfortScore'],
    'gong-wenbo': ['fastingGlucose', 'postMealGlucose', 'weightKg', 'waistCm'],
    'chen-jinbiao': ['weightKg', 'painScore', 'appetiteScore'],
    'wu-yuqin': ['weightKg', 'waistCm', 'activityMinutes', 'sleepHours'],
    'lin-jinfang': ['menstrualStatus', 'painScore', 'hotFlashCount'],
    'luo-jun': ['temperatureC', 'painScore', 'appetiteScore'],
    'yu-weihua': ['temperatureC', 'painScore', 'activityMinutes', 'waterMl'],
    'zhou-yong': ['coughScore', 'breathlessnessScore', 'nightAwakeningCount', 'activityMinutes'],
  };
  for (const [slug, keys] of Object.entries(expected)) {
    const config = getSpecialtyRecordConfig(slug);
    assert.deepEqual(config.fields.map(field => field.key), keys, slug);
    const empty = buildSpecialtyStats([], config, 7, reference);
    assert.equal(empty.recordedDays, 0);
    assert.equal(empty.completionRate, 0);
    assert.ok(empty.fields.every(field => field.count === 0 && field.average === undefined && field.latest === undefined));
  }
  assert.deepEqual(getSpecialtyRecordConfig('__proto__').fields.map(field => field.key), ['weightKg', 'sleepHours', 'activityMinutes']);
});

test('blank fields stay absent, real zero survives, and malformed/unsupported values are rejected', () => {
  const config = getSpecialtyRecordConfig('lin-jinfang');
  const result = validateSpecialtyRecordInput({ menstrualStatus: '0', painScore: ' ', hotFlashCount: '0' }, config, '2026-09-09', reference);
  assert.deepEqual(result.errors, {});
  assert.deepEqual(result.measurements, { menstrualStatus: 0, hotFlashCount: 0 });
  assert.equal(validateSpecialtyRecordInput({}, config, '2026-09-09', reference).measurements, undefined);
  for (const value of ['NaN', 'Infinity', '-1', '1.5', '0x1', '1e0', '11']) {
    const invalid = validateSpecialtyRecordInput({ painScore: value }, config, '2026-09-09', reference);
    assert.ok(invalid.errors.painScore, value);
  }
  for (const date of ['', '2026-02-29', '2026-09-31', '2026-9-9', '2026-09-10']) {
    assert.ok(validateSpecialtyRecordInput({ painScore: '0' }, config, date, reference).errors._date, date);
  }
  assert.deepEqual(normalizeSpecialtyMeasurements({ menstrualStatus: 0, painScore: 0, waterMl: NaN, unknown: 6, sleepHours: '7', temperatureC: Infinity }), { painScore: 0, menstrualStatus: 0 });
  assert.equal(normalizeSpecialtyMeasurements({ sleepHours: 7 }, config), undefined);
  assert.equal(normalizeSpecialtyMeasurements([]), undefined);
});

test('measurement reload and archive summaries preserve original tasks and Tang health metrics', () => {
  const legacy = record('2026-09-09', { fastingGlucose: 0, heightCm: 123.4, unknown: 100 }, {
    source: 'home', completedTitles: ['记录睡眠', '记录睡眠'], note: ' 保留备注 ',
    metrics: { sleepDurationMinutes: 420, moodScore: 0 },
  });
  const reloaded = normalizeHealthRecord(JSON.parse(JSON.stringify(legacy)));
  assert.deepEqual(reloaded.measurements, { fastingGlucose: 0, heightCm: 123.4 });
  assert.deepEqual(reloaded.completedTitles, ['记录睡眠']);
  assert.deepEqual(reloaded.metrics, { sleepDurationMinutes: 420, moodScore: 0 });
  assert.equal(reloaded.note, '保留备注');
  assert.match(formatHealthMetricsSummary(reloaded), /睡眠 7 小时/);
  assert.match(formatHealthMetricsSummary(reloaded), /情绪 0\/10/);
  assert.match(formatHealthMetricsSummary(reloaded), /空腹血糖 0 mmol\/L/);
  assert.match(formatHealthMetricsSummary(record('2026-09-09', { menstrualStatus: 0 })), /不在经期/);
  assert.deepEqual(normalizeHealthRecords([legacy, null])[0].metrics, reloaded.metrics);
});

test('daily statistics merge duplicate dates by latest field, preserve zeros and exclude absent and future dates', () => {
  const config = getSpecialtyRecordConfig('wu-yuqin');
  const records = [
    record('2026-09-03', { weightKg: 70 }),
    record('2026-09-04', { weightKg: 80, sleepHours: 8 }, { id: 'old', updatedAt: '2026-09-04T04:00:00.000Z' }),
    record('2026-09-04', { weightKg: 60, activityMinutes: 0 }, { id: 'new', updatedAt: '2026-09-04T05:00:00.000Z' }),
    record('2026-09-08', undefined, { note: '仅备注' }),
    record('2026-09-09', { weightKg: 50 }),
    record('2026-09-10', { weightKg: 200 }),
    record('2026-09-02', { weightKg: 300 }),
    record('2026-09-31', { weightKg: 400 }),
    null,
  ];
  const stats = buildSpecialtyStats(records, config, 7, reference);
  assert.equal(stats.recordedDays, 4);
  assert.equal(stats.measuredDays, 3);
  assert.equal(stats.completionRate, 57);
  const weight = stats.fields.find(field => field.key === 'weightKg');
  assert.deepEqual([weight.count, weight.average, weight.latest, weight.minimum, weight.maximum], [3, 60, 50, 50, 70]);
  assert.equal(stats.fields.find(field => field.key === 'sleepHours').average, 8);
  assert.equal(stats.fields.find(field => field.key === 'activityMinutes').average, 0);
  assert.equal(stats.fields.find(field => field.key === 'waistCm').average, undefined);
  assert.equal(stats.trend[2].measurements, undefined);
  assert.equal(stats.trend[5].hasData, true);
  assert.equal(stats.trend[5].measurements, undefined);
  assert.equal(buildSpecialtyStats(records, config, 1, reference).trend[0].measurements.weightKg, 50);
});

test('seven and thirty day windows cross year/month/leap boundaries with exactly the requested dates', () => {
  const config = getSpecialtyRecordConfig('zhou-yong');
  const weekly = buildSpecialtyStats([], config, 7, new Date(2026, 0, 1, 12));
  assert.deepEqual(weekly.trend.map(point => point.dateKey), ['2025-12-26', '2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01']);
  const monthly = buildSpecialtyStats([], config, 30, new Date(2024, 2, 1, 12));
  assert.equal(monthly.trend.length, 30);
  assert.equal(monthly.trend[0].dateKey, '2024-02-01');
  assert.equal(monthly.trend[28].dateKey, '2024-02-29');
  assert.equal(monthly.trend[29].dateKey, '2024-03-01');
});

test('same-day saves consolidate measurements while keeping home entries and old archives intact', () => {
  const archive = record('2020-01-01', undefined, { completedTitles: ['旧任务'], note: '早期档案' });
  const home = record('2026-09-09', undefined, { id: 'home', source: 'home', completedTitles: ['今日任务'] });
  const previous = record('2026-09-09', { weightKg: 60 }, { id: 'older', note: '昨日复查', metrics: { moodScore: 0, sleepDurationMinutes: 420 }, updatedAt: '2026-09-09T03:00:00.000Z' });
  const duplicate = record('2026-09-09', { sleepHours: 7 }, { id: 'latest', updatedAt: '2026-09-09T04:00:00.000Z' });
  const input = [archive, home, previous, duplicate];
  const saved = saveSpecialtyRecord(input, record('2026-09-09', { activityMinutes: 0 }, { id: 'incoming', note: '' }), undefined, reference);
  assert.equal(saved.error, undefined);
  assert.equal(saved.records.length, 3);
  assert.deepEqual(saved.records.find(item => item.source === 'manage' && item.dateKey === '2026-09-09').measurements, { weightKg: 60, activityMinutes: 0, sleepHours: 7 });
  assert.equal(saved.records.find(item => item.id === 'latest').note, '昨日复查');
  assert.deepEqual(saved.records.find(item => item.id === 'latest').metrics, { moodScore: 0, sleepDurationMinutes: 420 });
  assert.strictEqual(saved.records.find(item => item.id === archive.id), archive);
  assert.strictEqual(saved.records.find(item => item.id === home.id), home);
  assert.equal(input.length, 4);
});

test('editing clears optional values, keeps legacy content, and refuses occupied/future dates without changes', () => {
  const old = record('2026-09-08', { weightKg: 60, sleepHours: 7 }, { id: 'edit-me', completedTitles: ['历史任务'], note: '旧备注', metrics: { moodScore: 0 } });
  const other = record('2026-09-09', { weightKg: 70 });
  const input = [old, other];
  const cleared = saveSpecialtyRecord(input, { ...old, measurements: undefined, note: '', completedTitles: [] }, old.id, reference);
  assert.equal(cleared.error, undefined);
  const result = cleared.records.find(item => item.id === old.id);
  assert.equal(result.measurements, undefined);
  assert.equal(result.note, undefined);
  assert.deepEqual(result.completedTitles, ['历史任务']);
  assert.deepEqual(result.metrics, { moodScore: 0 });
  assert.equal(result.createdAt, old.createdAt);
  const collision = saveSpecialtyRecord(input, { ...old, dateKey: '2026-09-09' }, old.id, reference);
  assert.ok(collision.error);
  assert.strictEqual(collision.records, input);
  const future = saveSpecialtyRecord(input, record('2026-09-10', { weightKg: 70 }), undefined, reference);
  assert.ok(future.error);
  assert.strictEqual(future.records, input);
  assert.ok(saveSpecialtyRecord([], record('2026-09-09', undefined), undefined, reference).error);
  assert.ok(saveSpecialtyRecord([], record('', { weightKg: 70 }, { createdAt: '2026-09-09T03:00:00.000Z' }), undefined, reference).error);
  assert.ok(saveSpecialtyRecord(input, record('2026-09-07', { weightKg: 70 }, { id: old.id }), undefined, reference).error);
  assert.equal(saveSpecialtyRecord([], record('2026-09-09', undefined, { note: '仅备注也可保存' }), undefined, reference).error, undefined);
});

test('recorded days include legacy check-ins, remarks and zero health metrics while field averages remain measurement-only', () => {
  const records = [
    record('2026-09-03', undefined, { source: 'home', completedTitles: ['今日打卡'] }),
    record('2026-09-04', undefined, { note: '备注' }),
    record('2026-09-05', undefined, { metrics: { moodScore: 0 } }),
    record('2026-09-06', { weightKg: 60 }),
    record('2026-09-07', undefined, { metrics: { unknown: 20, moodScore: Infinity }, note: ' ', completedTitles: [' '] }),
  ];
  const stats = buildSpecialtyStats(records, getSpecialtyRecordConfig('wu-yuqin'), 7, reference);
  assert.equal(stats.recordedDays, 4);
  assert.equal(stats.measuredDays, 1);
  assert.equal(stats.fields.find(field => field.key === 'weightKg').average, 60);
  assert.equal(stats.fields.find(field => field.key === 'weightKg').count, 1);
});
