import type { WellnessGoal, WellnessState } from './types';
export const goalKinds = {
  diary: { title: '写一篇日记', target: 1, unit: '次', max: 1 },
  meditation: { title: '冥想放松', target: 5, unit: '分钟', max: 120 },
  exercise: { title: '日常运动', target: 20, unit: '分钟', max: 1440 },
  steps: { title: '步行活动', target: 6000, unit: '步', max: 100000 },
  sleep: { title: '记录睡眠', target: 7, unit: '小时', max: 24 },
  custom: { title: '我的小目标', target: 1, unit: '次', max: 100000 },
} as const;
export function goalProgress(goal: WellnessGoal, state: WellnessState, date: string) {
  const records = state.records.filter(record => record.date === date);
  const last = records[records.length - 1];
  if (goal.kind === 'diary') return records.some(record => record.note || record.trigger || record.coping || ['sleepHours', 'sleepQuality', 'sleepLatencyMinutes', 'nightAwakenings', 'moodScore', 'stressScore', 'energyScore'].some(key => typeof record.values?.[key] === 'number')) ? 1 : 0;
  if (goal.kind === 'meditation') return Math.floor(state.sessions.filter(session => session.kind === 'meditation' && localSessionDay(session.completedAt) === date).reduce((sum, item) => sum + item.seconds, 0) / 60);
  if (goal.kind === 'custom') return 0;
  return last?.values?.[{ steps: 'steps', exercise: 'exerciseMin', sleep: 'sleepHours' }[goal.kind]] ?? 0;
}
export function localSessionDay(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function breathingPhase(elapsedSeconds: number, hold: boolean) {
  const phases = hold ? [{ text: '吸气', seconds: 4 }, { text: '停顿', seconds: 4 }, { text: '呼气', seconds: 6 }] : [{ text: '吸气', seconds: 4 }, { text: '呼气', seconds: 6 }];
  const cycle = phases.reduce((sum, item) => sum + item.seconds, 0);
  let offset = Math.max(0, elapsedSeconds) % cycle;
  for (let i = 0; i < phases.length; i++) {
    if (offset < phases[i].seconds) return { ...phases[i], remaining: Math.ceil(phases[i].seconds - offset), index: i };
    offset -= phases[i].seconds;
  }
  return { ...phases[0], remaining: phases[0].seconds, index: 0 };
}
export function formatPracticeTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}
