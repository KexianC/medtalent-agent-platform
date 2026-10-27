import { emptyWellnessState, type AssessmentResult, type CardDraw, type GoalCheck, type PersonalityResult, type TrainingSession, type WellnessGoal, type WellnessState } from './types.ts';
import { normalizeWellnessRecords, validWellnessDate } from './recordModel.ts';
import { PERSONALITY_DIMENSIONS, WELLNESS_CARDS, WELLNESS_SCALES, scoreAssessment } from './assessmentModel.ts';
import { goalKinds } from './wellnessPractice.ts';

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 200): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && validWellnessDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
const entries = (value: unknown) => Array.isArray(value) ? value.filter(isObject) : [];

function uniqueLast<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) { const id = key(item); byKey.delete(id); byKey.set(id, item); }
  return [...byKey.values()];
}

function goalsFrom(value: unknown): WellnessGoal[] {
  const goals: WellnessGoal[] = [];
  for (const item of entries(value)) {
    if (!text(item.id) || !text(item.title) || !timestamp(item.createdAt) || typeof item.kind !== 'string' || !Object.prototype.hasOwnProperty.call(goalKinds, item.kind)) continue;
    const kind = item.kind as WellnessGoal['kind'];
    const definition = goalKinds[kind];
    if (!finite(item.target) || item.target <= 0 || item.target > definition.max || (kind !== 'sleep' && !Number.isInteger(item.target)) || item.unit !== definition.unit) continue;
    goals.push({ id: item.id, kind, title: item.title, target: item.target, unit: definition.unit, createdAt: item.createdAt });
  }
  return uniqueLast(goals, item => item.id);
}

function checksFrom(value: unknown, goals: WellnessGoal[]): GoalCheck[] {
  const ids = new Set(goals.map(goal => goal.id));
  const checks: GoalCheck[] = [];
  for (const item of entries(value)) {
    if (!validWellnessDate(item.date) || typeof item.goalId !== 'string' || !ids.has(item.goalId) || typeof item.done !== 'boolean') continue;
    checks.push({ date: item.date, goalId: item.goalId, done: item.done });
  }
  return uniqueLast(checks, item => `${item.date}:${item.goalId}`);
}

function sessionsFrom(value: unknown): TrainingSession[] {
  const sessions: TrainingSession[] = [];
  for (const item of entries(value)) {
    if (!text(item.id) || !text(item.courseId) || !text(item.title) || !timestamp(item.completedAt) || typeof item.completed !== 'boolean'
      || (item.kind !== 'breathing' && item.kind !== 'meditation') || !finite(item.seconds) || !Number.isInteger(item.seconds) || item.seconds < 1 || item.seconds > 86400) continue;
    sessions.push({ id: item.id, kind: item.kind, courseId: item.courseId, title: item.title, seconds: item.seconds, completedAt: item.completedAt, completed: item.completed });
  }
  return uniqueLast(sessions, item => item.id);
}

function assessmentsFrom(value: unknown): AssessmentResult[] {
  const results: AssessmentResult[] = [];
  for (const item of entries(value)) {
    if (!text(item.id) || !text(item.title) || !timestamp(item.createdAt) || typeof item.scaleId !== 'string' || !Array.isArray(item.answers)) continue;
    if (!WELLNESS_SCALES.some(scale => scale.id === item.scaleId)) continue;
    const actual = scoreAssessment(item.scaleId, item.answers);
    // Never replace a damaged/incomplete result with a fabricated zero score.
    if (!actual || item.score !== actual.score || item.maxScore !== actual.maxScore) continue;
    results.push({ id: item.id, scaleId: item.scaleId, title: item.title, answers: [...item.answers] as number[], score: actual.score, maxScore: actual.maxScore, createdAt: item.createdAt });
  }
  return uniqueLast(results, item => item.id);
}

function personalitiesFrom(value: unknown): PersonalityResult[] {
  const results: PersonalityResult[] = [];
  for (const item of entries(value)) {
    if (!text(item.id) || !timestamp(item.createdAt) || typeof item.type !== 'string' || !/^[EI][SN][TF][JP]$/.test(item.type) || !isObject(item.dimensions)) continue;
    const dimensions: Record<string, number> = {};
    let expectedType = '';
    for (const dimension of PERSONALITY_DIMENSIONS) {
      const score = item.dimensions[dimension.key];
      if (!finite(score) || score < 0 || score > 100 || score % 20 !== 0) break;
      dimensions[dimension.key] = score;
      expectedType += score >= 60 ? dimension.first : dimension.second;
    }
    if (expectedType.length !== PERSONALITY_DIMENSIONS.length || item.type !== expectedType) continue;
    results.push({ id: item.id, type: item.type, dimensions, createdAt: item.createdAt });
  }
  return uniqueLast(results, item => item.id);
}

function cardsFrom(value: unknown): CardDraw[] {
  const cards: CardDraw[] = [];
  for (const item of entries(value)) {
    if (!text(item.id) || !timestamp(item.createdAt) || typeof item.cardId !== 'string' || !WELLNESS_CARDS.some(card => card.id === item.cardId)) continue;
    cards.push({ id: item.id, cardId: item.cardId, createdAt: item.createdAt });
  }
  return uniqueLast(cards, item => item.id);
}

/** Project only validated fields from device storage; each collection fails independently. */
export function normalizeState(stored: unknown): WellnessState {
  const base = emptyWellnessState();
  if (!isObject(stored) || (stored.version !== undefined && stored.version !== 1)) return base;
  const goals = goalsFrom(stored.goals);
  return {
    version: 1, records: normalizeWellnessRecords(stored.records), goals, checks: checksFrom(stored.checks, goals),
    sessions: sessionsFrom(stored.sessions), assessments: assessmentsFrom(stored.assessments),
    personalities: personalitiesFrom(stored.personalities), cardDraws: cardsFrom(stored.cardDraws),
  };
}
