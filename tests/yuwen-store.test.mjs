import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from '../src/features/yuwen/stateModel.ts';
import { emptyWellnessState } from '../src/features/yuwen/types.ts';
import { goalProgress } from '../src/features/yuwen/wellnessPractice.ts';

const time = '2026-09-08T04:00:00.000Z';
const goal = { id: 'g1', kind: 'steps', title: '散步', target: 5000, unit: '步', createdAt: time };
const session = { id: 's1', kind: 'meditation', courseId: 'body-scan', title: '身体扫描', seconds: 60, completedAt: time, completed: false };
const assessment = { id: 'a1', scaleId: 'phq2', title: '情绪简筛 PHQ-2', answers: [1, 2], score: 3, maxScore: 6, createdAt: time };
const personality = { id: 'p1', type: 'ESTJ', dimensions: { EI: 80, SN: 60, TF: 100, JP: 60 }, createdAt: time };
const card = { id: 'c1', cardId: 'strength', createdAt: time };

test('malformed root and collections return complete safe empty state', () => {
  for (const input of [undefined, null, '', 4, [], { version: 99 }, { records: {}, goals: 'x', assessments: [null, 2, {}, []], sessions: [undefined, {}] }]) assert.deepEqual(normalizeState(input), emptyWellnessState());
});

test('valid records and zero-valued metrics survive while malformed fields cannot become NaN', () => {
  const state = normalizeState({ records: [
    { id: 'r1', date: '2026-09-08', values: { moodScore: 0, steps: 0, sleepHours: Infinity, energyScore: '4' }, note: '', trigger: {}, coping: [], createdAt: time, updatedAt: time },
    { date: '2026-02-30', values: { moodScore: 5 } }, { date: '2026-09-07', values: null },
  ] });
  assert.equal(state.records.length, 1);
  assert.deepEqual(state.records[0].values, { moodScore: 0, steps: 0 });
  assert.equal(state.records[0].trigger, '');
  assert.equal(state.records[0].coping, '');
});

test('goal kinds, targets, units and timestamps are validated, checks bind existing goals and deduplicate by day', () => {
  const state = normalizeState({ goals: [goal, { ...goal, id: 'bad1', kind: '__proto__' }, { ...goal, id: 'bad2', target: 0 }, { ...goal, id: 'bad3', target: NaN }, { ...goal, id: 'bad4', unit: null }, { ...goal, id: 'bad5', createdAt: '2026-02-30T04:00:00Z' }], checks: [
    { date: '2026-09-08', goalId: 'g1', done: true }, { date: '2026-09-08', goalId: 'g1', done: false },
    { date: '2026-09-08', goalId: 'missing', done: true }, { date: '2026-09-09', goalId: 'g1', done: 'true' },
  ] });
  assert.deepEqual(state.goals, [goal]);
  assert.deepEqual(state.checks, [{ date: '2026-09-08', goalId: 'g1', done: false }]);
  assert.equal(goalProgress(goal, state, '2026-09-08'), 0);
});

test('invalid practice durations and duplicate IDs cannot poison progress totals', () => {
  const state = normalizeState({ sessions: [session, { ...session, seconds: 90 }, { ...session, id: 'bad1', seconds: Infinity }, { ...session, id: 'bad2', seconds: -1 }, { ...session, id: 'bad3', completedAt: 'not-time' }, { ...session, id: 'bad4', completed: 'false' }] });
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].seconds, 90);
  assert.equal(goalProgress({ ...goal, kind: 'meditation', target: 5, unit: '分钟' }, state, '2026-09-08'), 1);
});

test('replayed meditation keeps actual duration beyond the course length up to one day', () => {
  const state = normalizeState({ sessions: [{ ...session, seconds: 7200 }, { ...session, id: 'day', seconds: 86400 }, { ...session, id: 'over', seconds: 86401 }] });
  assert.deepEqual(state.sessions.map(item => item.seconds), [7200, 86400]);
});

test('damaged assessments are discarded instead of being converted to zero or trusted scores', () => {
  const sparse = new Array(2); sparse[0] = 0;
  const state = normalizeState({ assessments: [assessment,
    { ...assessment, id: 'bad1', answers: [] }, { ...assessment, id: 'bad2', answers: [NaN, 0] },
    { ...assessment, id: 'bad3', score: 0 }, { ...assessment, id: 'bad4', maxScore: 21 },
    { ...assessment, id: 'bad5', scaleId: 'unknown' }, { ...assessment, id: 'bad6', answers: sparse },
    { ...assessment, id: 'bad7', createdAt: {} },
  ] });
  assert.deepEqual(state.assessments, [assessment]);
  assert.notEqual(state.assessments[0].answers, assessment.answers);
});

test('personality requires four valid matching dimensions and known cards remain usable', () => {
  const state = normalizeState({ personalities: [personality, { ...personality, id: 'bad1', dimensions: {} }, { ...personality, id: 'bad2', dimensions: { ...personality.dimensions, EI: NaN } }, { ...personality, id: 'bad3', type: 'ISTJ' }, { ...personality, id: 'bad4', dimensions: { ...personality.dimensions, EI: 50 } }], cardDraws: [card, { ...card, id: 'bad1', cardId: 'missing' }, { ...card, id: 'bad2', createdAt: 0 }] });
  assert.deepEqual(state.personalities, [personality]);
  assert.deepEqual(state.cardDraws, [card]);
});

test('normalization projects cloned data and keeps unrelated valid collections', () => {
  const input = { ...emptyWellnessState(), goals: [goal], sessions: [session], assessments: [assessment], personalities: [personality], cardDraws: [card], unknown: 'drop' };
  const before = JSON.stringify(input);
  const normalized = normalizeState(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal('unknown' in normalized, false);
  assert.deepEqual(normalizeState(normalized), normalized);
  normalized.personalities[0].dimensions.EI = 0;
  assert.equal(personality.dimensions.EI, 80);
});
