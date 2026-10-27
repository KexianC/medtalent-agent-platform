import type { MetricKey, WellnessRecord } from './types';

export type RecordMode = 'diary' | 'health';
export type MetricDefinition = { key: MetricKey; label: string; unit: string; min: number; max: number; step: number; hint?: string };
export const DIARY_METRICS: MetricDefinition[] = [
  { key: 'sleepHours', label: '睡眠时长', unit: '小时', min: 0, max: 24, step: 0.1 },
  { key: 'sleepQuality', label: '睡眠质量', unit: '分', min: 0, max: 10, step: 1, hint: '0 很差 · 10 很好' },
  { key: 'sleepLatencyMinutes', label: '入睡耗时', unit: '分钟', min: 0, max: 1440, step: 1 },
  { key: 'nightAwakenings', label: '夜醒次数', unit: '次', min: 0, max: 100, step: 1 },
  { key: 'moodScore', label: '心情', unit: '分', min: 0, max: 10, step: 1, hint: '0 很低落 · 10 很愉快' },
  { key: 'energyScore', label: '精力', unit: '分', min: 0, max: 10, step: 1, hint: '0 很疲惫 · 10 很充足' },
  { key: 'stressScore', label: '压力', unit: '分', min: 0, max: 10, step: 1, hint: '0 无压力 · 10 压力很大' },
];
export const HEALTH_METRICS: MetricDefinition[] = [
  { key: 'steps', label: '步数', unit: '步', min: 0, max: 200000, step: 1 },
  { key: 'heartRate', label: '心率', unit: '次/分', min: 1, max: 300, step: 1 },
  { key: 'systolicBP', label: '收缩压', unit: 'mmHg', min: 1, max: 350, step: 1 },
  { key: 'diastolicBP', label: '舒张压', unit: 'mmHg', min: 1, max: 250, step: 1 },
  { key: 'weight', label: '体重', unit: 'kg', min: 1, max: 500, step: 0.1 },
  { key: 'calorie', label: '饮食摄入热量', unit: '千卡', min: 0, max: 20000, step: 1 },
  { key: 'exerciseMin', label: '运动时长', unit: '分钟', min: 0, max: 1440, step: 1 },
  { key: 'waist', label: '腰围', unit: 'cm', min: 1, max: 300, step: 0.1 },
  { key: 'hip', label: '臀围', unit: 'cm', min: 1, max: 300, step: 0.1 },
];
export const WELLNESS_METRICS = [...DIARY_METRICS, ...HEALTH_METRICS];
export const metricsForMode = (mode: RecordMode) => mode === 'diary' ? DIARY_METRICS : HEALTH_METRICS;
export const wellnessDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function validWellnessDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01') return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function validMetricValue(definition: MetricDefinition, value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= definition.min && value <= definition.max
    && (definition.step !== 1 || Number.isInteger(value));
}

const safeText = (value: unknown) => typeof value === 'string' ? value.slice(0, 600) : '';
const hasRecordContent = (record: WellnessRecord) => Object.keys(record.values).length > 0 || Boolean(record.note || record.trigger || record.coping);

/** One record per local date; tolerate stale or malformed persisted data without inventing values. */
export function normalizeWellnessRecords(input: unknown): WellnessRecord[] {
  if (!Array.isArray(input)) return [];
  const byDate = new Map<string, WellnessRecord>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || !validWellnessDate(item.date)) continue;
    const values: WellnessRecord['values'] = {};
    for (const definition of WELLNESS_METRICS) {
      const value = item.values?.[definition.key];
      if (validMetricValue(definition, value)) values[definition.key] = value;
    }
    const record: WellnessRecord = {
      id: typeof item.id === 'string' ? item.id : `yw-record-${item.date}`,
      date: item.date,
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
      values, note: safeText(item.note), trigger: safeText(item.trigger), coping: safeText(item.coping),
    };
    if (!hasRecordContent(record)) continue;
    const previous = byDate.get(record.date);
    if (!previous) byDate.set(record.date, record);
    else {
      const [older, newer] = previous.updatedAt > record.updatedAt ? [record, previous] : [previous, record];
      byDate.set(record.date, { ...newer, values: { ...older.values, ...newer.values }, note: newer.note || older.note, trigger: newer.trigger || older.trigger, coping: newer.coping || older.coping });
    }
  }
  return [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export type WellnessDraft = { values: Partial<Record<MetricKey, string>>; note: string; trigger: string; coping: string };
export function createWellnessDraft(record?: WellnessRecord): WellnessDraft {
  const values: WellnessDraft['values'] = {};
  for (const definition of WELLNESS_METRICS) {
    const value = record?.values[definition.key];
    if (validMetricValue(definition, value)) values[definition.key] = String(value);
  }
  return { values, note: record?.note ?? '', trigger: record?.trigger ?? '', coping: record?.coping ?? '' };
}

export type RecordPatch = { values: Partial<Record<MetricKey, number>>; note?: string; trigger?: string; coping?: string };
export function validateWellnessDraft(mode: RecordMode, date: string, draft: WellnessDraft, today = wellnessDateKey()): { patch: RecordPatch; error?: never } | { error: string; patch?: never } {
  if (!validWellnessDate(date) || date > today) return { error: '请选择今天或更早的有效日期。' };
  const values: RecordPatch['values'] = {};
  for (const definition of metricsForMode(mode)) {
    const raw = (draft.values[definition.key] ?? '').trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!validMetricValue(definition, value)) return { error: `${definition.label}请填写 ${definition.min}–${definition.max} ${definition.unit}${definition.step === 1 ? '之间的整数' : '之间的数值'}。` };
    values[definition.key] = definition.step === 1 ? value : Math.round(value * 10) / 10;
  }
  if (mode === 'diary') {
    if ([draft.note, draft.trigger, draft.coping].some(value => value.length > 600)) return { error: '每项文字最多填写 600 字。' };
    return { patch: { values, note: draft.note.trim(), trigger: draft.trigger.trim(), coping: draft.coping.trim() } };
  }
  return { patch: { values } };
}

/** Blank fields remove only metrics owned by this editor; another editor's data survives. */
export function mergeWellnessRecord(records: WellnessRecord[], mode: RecordMode, date: string, patch: RecordPatch, now = new Date().toISOString()): WellnessRecord[] {
  if (!validWellnessDate(date)) throw new Error('记录日期无效。');
  const normalized = normalizeWellnessRecords(records);
  const previous = normalized.find(record => record.date === date);
  const values = { ...previous?.values };
  for (const definition of metricsForMode(mode)) {
    delete values[definition.key];
    const value = patch.values[definition.key];
    if (validMetricValue(definition, value)) values[definition.key] = value;
  }
  const next: WellnessRecord = {
    id: previous?.id ?? `yw-record-${date}`, date, createdAt: previous?.createdAt || now, updatedAt: now, values,
    note: mode === 'diary' ? safeText(patch.note) : previous?.note ?? '',
    trigger: mode === 'diary' ? safeText(patch.trigger) : previous?.trigger ?? '',
    coping: mode === 'diary' ? safeText(patch.coping) : previous?.coping ?? '',
  };
  return [...normalized.filter(record => record.date !== date), ...(hasRecordContent(next) ? [next] : [])].sort((a, b) => b.date.localeCompare(a.date));
}

export type WellnessTrendPoint = { date: string; record?: WellnessRecord };
export function wellnessTrend(records: WellnessRecord[], days: 7 | 30, endDate = wellnessDateKey()): WellnessTrendPoint[] {
  if (!validWellnessDate(endDate)) return [];
  const byDate = new Map(normalizeWellnessRecords(records).map(record => [record.date, record]));
  const [year, month, day] = endDate.split('-').map(Number);
  return Array.from({ length: days }, (_, index) => {
    const date = wellnessDateKey(new Date(year, month - 1, day - days + 1 + index, 12));
    return { date, record: byDate.get(date) };
  });
}

export function wellnessStatistics(points: WellnessTrendPoint[]) {
  return WELLNESS_METRICS.map(definition => {
    const values = points.flatMap(point => {
      const value = point.record?.values[definition.key];
      return validMetricValue(definition, value) ? [value] : [];
    });
    return { ...definition, count: values.length, average: values.length ? values.reduce((total, value) => total + value, 0) / values.length : undefined };
  });
}

export function formatWellnessNumber(value: number | undefined): string {
  return value === undefined ? '—' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 1 }).format(value);
}

/** Descriptive association only; pairs are dates containing both metrics. */
export function wellnessAssociation(points: WellnessTrendPoint[], xKey: MetricKey, yKey: MetricKey) {
  const pairs = points.flatMap(point => {
    const x = point.record?.values[xKey];
    const y = point.record?.values[yKey];
    return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) ? [[x, y]] : [];
  });
  if (pairs.length < 5) return { count: pairs.length, coefficient: undefined };
  const meanX = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length;
  const meanY = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let covariance = 0; let varianceX = 0; let varianceY = 0;
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
    varianceY += (y - meanY) ** 2;
  }
  return { count: pairs.length, coefficient: varianceX && varianceY ? Math.max(-1, Math.min(1, covariance / Math.sqrt(varianceX * varianceY))) : undefined };
}
