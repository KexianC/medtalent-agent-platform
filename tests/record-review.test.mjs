import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSpecialtyRecordReview, recordCsv, recordCsvCell, recordReviewQuestion } from '../src/features/health/recordReview.ts';
import { buildWellnessRecordReview } from '../src/features/yuwen/recordReview.ts';
import { getSpecialtyRecordConfig } from '../src/lib/specialtyRecords.ts';

const reference = new Date(2026, 9, 22, 12);
const doctor = { name: '吴玉琴', slug: 'wu-yuqin' };
const specialty = getSpecialtyRecordConfig(doctor.slug);
const record = (dateKey, measurements, extra = {}) => ({
  id: `r-${dateKey}`, dateKey, createdAt: `${dateKey}T01:00:00.000Z`, updatedAt: `${dateKey}T01:00:00.000Z`,
  source: 'manage', completedTitles: [], measurements, ...extra,
});
const wellnessRecord = (date, values, extra = {}) => ({ id: `yw-${date}`, date, values, createdAt: `${date}T01:00:00Z`, updatedAt: `${date}T01:00:00Z`, note: '', trigger: '', coping: '', ...extra });

test('specialty review follows current window, keeps zeros, merges per-day statistics and exports every source row', () => {
  const input = [
    record('2026-10-15', { weightKg: 90 }, { note: '窗口外备注' }),
    record('2026-10-16', { weightKg: 80, activityMinutes: 0 }, { note: '本期私密备注' }),
    record('2026-10-16', { weightKg: 60 }, { id: 'newer', source: 'home', updatedAt: '2026-10-16T02:00:00Z', completedTitles: ['已散步'] }),
    record('2026-10-22', { weightKg: 50 }),
    record('2026-10-23', { weightKg: 200 }, { note: '未来备注' }),
  ];
  const review = buildSpecialtyRecordReview(doctor, specialty, input, 7, reference);
  assert.equal(review.from, '2026-10-16');
  assert.equal(review.to, '2026-10-22');
  assert.equal(review.recordedDays, 2);
  assert.match(review.summary, /体重：均值 55 kg，最近 50 kg；2 天有填写/);
  assert.match(review.summary, /活动时长：均值 0 分钟，最近 0 分钟；1 天有填写/);
  assert.match(review.summary, /已散步/);
  assert.doesNotMatch(review.summary + review.csv, /本期私密备注|窗口外备注|未来备注/);
  assert.equal(review.csv.split('\r\n').length, 4);
  assert.match(review.csv, /"0"/);
  const monthly = buildSpecialtyRecordReview(doctor, specialty, input, 30, reference, true);
  assert.match(monthly.summary, /窗口外备注/);
  assert.match(monthly.csv, /本期私密备注/);
  assert.doesNotMatch(monthly.csv, /未来备注/);
  assert.equal(input.length, 5);
});

test('every specialty review preserves the relevant fields and does not export another specialty measurement', () => {
  for (const slug of ['fu-junfen', 'chen-zhiling', 'gong-wenbo', 'chen-jinbiao', 'wu-yuqin', 'lin-jinfang', 'luo-jun', 'yu-weihua', 'zhou-yong']) {
    const config = getSpecialtyRecordConfig(slug);
    const values = Object.fromEntries(config.fields.map(field => [field.key, field.min]));
    const review = buildSpecialtyRecordReview({ name: slug, slug }, config, [record('2026-10-22', { ...values, unknown: 100 })], 7, reference);
    assert.equal(review.recordedDays, 1, slug);
    for (const field of config.fields) assert.ok(review.summary.includes(field.label), `${slug}: ${field.label}`);
    assert.doesNotMatch(review.csv, /unknown/);
    if (slug !== 'fu-junfen' && slug !== 'gong-wenbo') assert.doesNotMatch(review.csv, /空腹血糖/);
    if (slug === 'lin-jinfang') assert.match(review.summary, /其中经期 0 天；最近记录为不在经期/);
  }
});

test('CSV protects formulas, quotes multiline values, preserves Chinese text and missing measurements', () => {
  for (const input of ['=1+1', '+SUM(A1:A2)', '-1+2', '@SUM(A1:A2)', ' \t=HYPERLINK("example")', '\n=1']) {
    assert.ok(recordCsvCell(input).startsWith('"\''), input);
  }
  assert.equal(recordCsvCell('文字,"引号"\n第二行'), '"文字,""引号""\n第二行"');
  assert.equal(recordCsvCell(undefined), '""');
  assert.equal(recordCsvCell(0), '"0"');
  assert.ok(recordCsv([['中文', 0, undefined]]).startsWith('\uFEFF"中文","0",""'));
  const review = buildSpecialtyRecordReview(doctor, specialty, [record('2026-10-22', undefined, { note: '=1+1' })], 7, reference, true);
  assert.match(review.csv, /"'=1\+1"/);
});

test('wellness summary normalizes duplicate dates, respects notes choice and reports latest measured date', () => {
  const input = [
    wellnessRecord('2026-10-16', { moodScore: 0, sleepHours: 6 }, { note: '私密日记' }),
    wellnessRecord('2026-10-16', { sleepHours: 8 }, { id: 'newer', updatedAt: '2026-10-16T02:00:00Z' }),
    wellnessRecord('2026-10-22', { moodScore: 2, steps: 0 }, { trigger: '发生的事情', coping: '自己的应对' }),
    wellnessRecord('2026-10-23', { moodScore: 10 }, { note: '未来日记' }),
  ];
  const review = buildWellnessRecordReview(input, 7, '2026-10-22');
  assert.equal(review.recordedDays, 2);
  assert.match(review.summary, /心情：均值 1 分，最近 2 分（2026-10-22）；2 天有填写/);
  assert.match(review.summary, /睡眠时长：均值 8 小时，最近 8 小时（2026-10-16）/);
  assert.match(review.summary, /步数：均值 0 步/);
  assert.doesNotMatch(review.summary + review.csv, /私密日记|发生的事情|自己的应对|未来日记/);
  assert.equal(review.csv.split('\r\n').length, 3);
  const withNotes = buildWellnessRecordReview(input, 7, '2026-10-22', true);
  assert.match(withNotes.summary, /发生的事情/);
  assert.match(withNotes.csv, /自己的应对/);
  assert.doesNotMatch(withNotes.csv, /未来日记/);
});

test('empty reviews contain no invented measurements and long diary questions stay within chat contract', () => {
  const empty = buildSpecialtyRecordReview(doctor, specialty, [], 30, reference);
  assert.equal(empty.recordedDays, 0);
  assert.doesNotMatch(empty.summary, /均值 0|最近 0/);
  assert.equal(empty.csv.split('\r\n').length, 1);
  const wellness = buildWellnessRecordReview([], 30, '2026-01-01');
  assert.equal(wellness.from, '2025-12-03');
  assert.equal(wellness.recordedDays, 0);
  const long = buildWellnessRecordReview(Array.from({ length: 7 }, (_, index) => wellnessRecord(`2026-10-${16 + index}`, { sleepHours: 8, moodScore: 5 }, { note: '长文字'.repeat(200), trigger: '细节'.repeat(200) })), 7, '2026-10-22', true);
  assert.ok(recordReviewQuestion(long).length <= 2000);
  assert.match(recordReviewQuestion(long), /请根据以下实际记录/);
});
