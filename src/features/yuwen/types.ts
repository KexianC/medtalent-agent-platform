export type MetricKey = 'sleepHours' | 'sleepQuality' | 'sleepLatencyMinutes' | 'nightAwakenings' | 'moodScore' | 'energyScore' | 'stressScore' | 'steps' | 'heartRate' | 'systolicBP' | 'diastolicBP' | 'weight' | 'calorie' | 'exerciseMin' | 'waist' | 'hip';
export type WellnessRecord = {
  id: string; date: string; createdAt: string; updatedAt: string;
  values: Partial<Record<MetricKey, number>>;
  note: string; trigger: string; coping: string;
};
export type WellnessGoal = { id: string; kind: 'steps' | 'exercise' | 'meditation' | 'sleep' | 'diary' | 'custom'; title: string; target: number; unit: string; createdAt: string };
export type GoalCheck = { date: string; goalId: string; done: boolean };
export type TrainingSession = { id: string; kind: 'breathing' | 'meditation'; courseId: string; title: string; seconds: number; completedAt: string; completed: boolean };
export type AssessmentResult = { id: string; scaleId: string; title: string; answers: number[]; score: number; maxScore: number; createdAt: string };
export type PersonalityResult = { id: string; type: string; dimensions: Record<string, number>; createdAt: string };
export type CardDraw = { id: string; cardId: string; createdAt: string };
export type WellnessState = {
  version: 1; records: WellnessRecord[]; goals: WellnessGoal[]; checks: GoalCheck[];
  sessions: TrainingSession[]; assessments: AssessmentResult[]; personalities: PersonalityResult[]; cardDraws: CardDraw[];
};
export const emptyWellnessState = (): WellnessState => ({ version: 1, records: [], goals: [], checks: [], sessions: [], assessments: [], personalities: [], cardDraws: [] });
export type WellnessView = 'diary' | 'health' | 'report' | 'goals' | 'breathing' | 'meditation' | 'assessment' | 'mbti' | 'cards';
