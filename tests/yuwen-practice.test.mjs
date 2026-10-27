import test from 'node:test';
import assert from 'node:assert/strict';
import { breathingPhase, formatPracticeTime, goalProgress, localSessionDay } from '../src/features/yuwen/wellnessPractice.ts';

const date = '2026-09-08';
const empty = () => ({ version: 1, records: [], goals: [], checks: [], sessions: [], assessments: [], personalities: [], cardDraws: [] });
const goal = kind => ({ id: `goal-${kind}`, kind, title: kind, target: 10, unit: '', createdAt: new Date(2026, 8, 8).toISOString() });
const record = (day, values = {}, text = {}) => ({ id: `record-${day}`, date: day, values, note: '', trigger: '', coping: '', ...text });
const session = (id, kind, seconds, completedAt) => ({ id, kind, seconds, courseId: 'test-course', title: '练习', completedAt, completed: false });

test('optional 4-4-6 rhythm enters each phase exactly at its boundary and repeats without a zero countdown', () => {
  const cases = [
    [0, '吸气', 4], [3.999, '吸气', 1], [4, '停顿', 4],
    [7.999, '停顿', 1], [8, '呼气', 6], [13.999, '呼气', 1],
    [14, '吸气', 4], [18, '停顿', 4], [28, '吸气', 4],
  ];
  for (const [elapsed, text, remaining] of cases) {
    const actual = breathingPhase(elapsed, true);
    assert.equal(actual.text, text, `phase at ${elapsed}s`);
    assert.equal(actual.remaining, remaining, `countdown at ${elapsed}s`);
  }
});

test('default breathing goes directly from inhalation to exhalation and restarts after ten seconds', () => {
  for (const [elapsed, text, remaining] of [[0, '吸气', 4], [3.9, '吸气', 1], [4, '呼气', 6], [9.9, '呼气', 1], [10, '吸气', 4], [64, '呼气', 6]]) {
    const actual = breathingPhase(elapsed, false);
    assert.equal(actual.text, text);
    assert.equal(actual.remaining, remaining);
  }
  assert.equal(breathingPhase(-5, false).text, '吸气');
  assert.equal(breathingPhase(-5, false).remaining, 4);
});

test('displayed practice time uses completed seconds and retains minutes beyond one hour', () => {
  for (const [seconds, expected] of [[-1, '00:00'], [0, '00:00'], [59.999, '00:59'], [60, '01:00'], [157.733, '02:37'], [3600, '60:00']]) {
    assert.equal(formatPracticeTime(seconds), expected);
  }
});

test('daily step, exercise and sleep progress includes only records for the requested day', () => {
  const state = { ...empty(), records: [
    record('2026-09-07', { steps: 90000, exerciseMin: 120, sleepHours: 9 }),
    record(date, { steps: 3200, exerciseMin: 25, sleepHours: 6.5 }),
    record('2026-09-09', { steps: 99000, exerciseMin: 180, sleepHours: 10 }),
  ] };
  assert.equal(goalProgress(goal('steps'), state, date), 3200);
  assert.equal(goalProgress(goal('exercise'), state, date), 25);
  assert.equal(goalProgress(goal('sleep'), state, date), 6.5);
  assert.equal(goalProgress(goal('steps'), state, '2026-09-06'), 0);
  assert.equal(goalProgress(goal('custom'), state, date), 0);
});

test('diary progress accepts written feelings or a legitimate zero rating and excludes physiology-only or other-day records', () => {
  for (const text of [{ note: '今天的感受' }, { trigger: '忙碌的一天' }, { coping: '散步' }]) {
    assert.equal(goalProgress(goal('diary'), { ...empty(), records: [record(date, {}, text)] }, date), 1);
  }
  assert.equal(goalProgress(goal('diary'), { ...empty(), records: [record(date, { moodScore: 0 })] }, date), 1);
  assert.equal(goalProgress(goal('diary'), { ...empty(), records: [record(date, { steps: 8000 }), record('2026-09-07', { sleepHours: 8 }, { note: '昨天' })] }, date), 0);
});

test('saving only sleep latency or nighttime awakenings still completes a diary goal, including zero awakenings', () => {
  for (const values of [{ sleepLatencyMinutes: 20 }, { nightAwakenings: 2 }, { nightAwakenings: 0 }]) {
    assert.equal(goalProgress(goal('diary'), { ...empty(), records: [record(date, values)] }, date), 1, JSON.stringify(values));
  }
});

test('meditation minutes sum actual listening sessions for the local day and exclude breathing and neighboring dates', () => {
  const state = { ...empty(), sessions: [
    session('a', 'meditation', 100, new Date(2026, 8, 8, 0, 1).toISOString()),
    session('b', 'meditation', 79, new Date(2026, 8, 8, 23, 59).toISOString()),
    session('previous', 'meditation', 600, new Date(2026, 8, 7, 23, 59).toISOString()),
    session('next', 'meditation', 600, new Date(2026, 8, 9, 0, 1).toISOString()),
    session('breathing', 'breathing', 600, new Date(2026, 8, 8, 12).toISOString()),
  ] };
  assert.equal(goalProgress(goal('meditation'), state, date), 2);
  state.sessions.push(session('c', 'meditation', 1, new Date(2026, 8, 8, 14).toISOString()));
  assert.equal(goalProgress(goal('meditation'), state, date), 3);
});

test('local session day respects local midnight, year boundaries and invalid timestamps', () => {
  assert.equal(localSessionDay(new Date(2026, 8, 8, 0, 0).toISOString()), '2026-09-08');
  assert.equal(localSessionDay(new Date(2026, 8, 7, 23, 59, 59).toISOString()), '2026-09-07');
  assert.equal(localSessionDay(new Date(2027, 0, 1, 0, 0).toISOString()), '2027-01-01');
  assert.equal(localSessionDay('invalid'), '');
});
