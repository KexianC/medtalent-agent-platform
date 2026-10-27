import type {
  DoctorDailyTasks,
  DoctorHealthMetrics,
  DoctorHealthRecord,
} from "../hooks/useDoctorLocalState";
import { formatSpecialtyMeasurementsSummary, normalizeSpecialtyMeasurements, normalizeSpecialtyValues, type SpecialtyRecordConfig } from "./specialtyRecords.ts";

const HEALTH_RECORD_RETENTION_DAYS = 370;
const SCORE_KEYS = ["moodScore", "anxietyScore", "energyScore", "daytimeImpactScore"] as const;
const NUMERIC_METRIC_KEYS = [
  "sleepDurationMinutes",
  "sleepLatencyMinutes",
  "nightAwakenings",
  ...SCORE_KEYS,
] as const;

export type HealthTrendPoint = {
  dateKey: string;
  label: string;
  metrics?: DoctorHealthMetrics;
  hasData: boolean;
};

export type HealthStats = {
  days: number;
  recordedDays: number;
  completionRate: number;
  averageSleepDurationMinutes?: number;
  averageSleepLatencyMinutes?: number;
  averageNightAwakenings?: number;
  averageAnxietyScore?: number;
  averageMoodScore?: number;
  averageEnergyScore?: number;
  averageDaytimeImpactScore?: number;
  safetyConcernDays: number;
};

export type HealthContextRecord = {
  dateKey: string;
  completedTitles: string[];
  note?: string;
  metrics?: DoctorHealthMetrics;
  measurements?: Record<string, number>;
  values?: Record<string, string>;
};

export type HealthContextPayload = {
  version: 1;
  consent: true;
  records: HealthContextRecord[];
};

const dateToLocalKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const dateFromKey = (dateKey: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
};

export const isValidHealthDateKey = (value: unknown): value is string => (
  typeof value === "string" && dateFromKey(value) !== null
);

const validIsoTime = (value: unknown) => (
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined
);

const normalizeNumber = (value: unknown, minimum: number, maximum: number, integer = false) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) return undefined;
  return integer ? Math.round(value) : Math.round(value * 10) / 10;
};

export const normalizeHealthMetrics = (value: unknown): DoctorHealthMetrics | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const metrics: DoctorHealthMetrics = {
    sleepDurationMinutes: normalizeNumber(raw.sleepDurationMinutes, 0, 24 * 60, true),
    sleepLatencyMinutes: normalizeNumber(raw.sleepLatencyMinutes, 0, 12 * 60, true),
    nightAwakenings: normalizeNumber(raw.nightAwakenings, 0, 50, true),
    moodScore: normalizeNumber(raw.moodScore, 0, 10),
    anxietyScore: normalizeNumber(raw.anxietyScore, 0, 10),
    energyScore: normalizeNumber(raw.energyScore, 0, 10),
    daytimeImpactScore: normalizeNumber(raw.daytimeImpactScore, 0, 10),
    safetyConcern: typeof raw.safetyConcern === "boolean" ? raw.safetyConcern : undefined,
  };
  const compact = Object.fromEntries(Object.entries(metrics).filter(([, metric]) => metric !== undefined)) as DoctorHealthMetrics;
  return Object.keys(compact).length ? compact : undefined;
};

export const healthRecordDateKey = (record: Pick<DoctorHealthRecord, "dateKey" | "createdAt">) => {
  if (isValidHealthDateKey(record.dateKey)) return record.dateKey;
  const createdAt = new Date(record.createdAt);
  return Number.isFinite(createdAt.getTime()) ? dateToLocalKey(createdAt) : "";
};

export const normalizeHealthRecord = (value: unknown, specialty?: SpecialtyRecordConfig): DoctorHealthRecord | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const rawCreatedAt = validIsoTime(raw.createdAt);
  const derivedDateKey = isValidHealthDateKey(raw.dateKey)
    ? raw.dateKey
    : rawCreatedAt
      ? dateToLocalKey(new Date(rawCreatedAt))
      : "";
  if (!id || !derivedDateKey || (raw.source !== "home" && raw.source !== "manage")) return null;

  const createdAt = rawCreatedAt || `${derivedDateKey}T12:00:00.000Z`;
  const updatedAt = validIsoTime(raw.updatedAt) || createdAt;
  const completedTitles = Array.isArray(raw.completedTitles)
    ? [...new Set(raw.completedTitles
      .filter((title): title is string => typeof title === "string")
      .map((title) => title.trim())
      .filter(Boolean))]
    : [];
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 300) : "";
  const metrics = normalizeHealthMetrics(raw.metrics);
  const measurements = normalizeSpecialtyMeasurements(raw.measurements, specialty);
  const values = normalizeSpecialtyValues(raw.values, specialty);

  return {
    schemaVersion: 2,
    id,
    createdAt,
    updatedAt,
    dateKey: derivedDateKey,
    completedTitles,
    ...(note ? { note } : {}),
    source: raw.source,
    ...(metrics ? { metrics } : {}),
    ...(measurements ? { measurements } : {}),
    ...(values ? { values } : {}),
  };
};

export const normalizeHealthRecords = (value: unknown, specialty?: SpecialtyRecordConfig): DoctorHealthRecord[] => {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  return value.flatMap((item) => {
    const record = normalizeHealthRecord(item, specialty);
    if (!record || seenIds.has(record.id)) return [];
    seenIds.add(record.id);
    return [record];
  });
};

const recordTime = (record: DoctorHealthRecord) => (
  Date.parse(record.updatedAt || record.createdAt) || Date.parse(record.createdAt) || 0
);

export const sortHealthRecords = (
  records: DoctorHealthRecord[],
  referenceDate = new Date(),
  retentionDays = HEALTH_RECORD_RETENTION_DAYS,
  specialty?: SpecialtyRecordConfig,
) => {
  const safeRetentionDays = Math.max(1, Math.min(730, Math.round(retentionDays)));
  const earliest = new Date(referenceDate);
  earliest.setHours(12, 0, 0, 0);
  earliest.setDate(earliest.getDate() - (safeRetentionDays - 1));
  const earliestKey = dateToLocalKey(earliest);

  return normalizeHealthRecords(records, specialty)
    .filter((record) => healthRecordDateKey(record) >= earliestKey)
    .sort((left, right) => {
      const dateDifference = healthRecordDateKey(right).localeCompare(healthRecordDateKey(left));
      return dateDifference || recordTime(right) - recordTime(left);
    });
};

export const updateHealthRecordById = (
  records: DoctorHealthRecord[],
  recordId: string,
  patch: Partial<Omit<DoctorHealthRecord, "id" | "createdAt">>,
  referenceDate = new Date(),
) => {
  const current = normalizeHealthRecords(records).find((record) => record.id === recordId);
  if (!current) return sortHealthRecords(records, referenceDate);
  const updated = normalizeHealthRecord({
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: patch.updatedAt || referenceDate.toISOString(),
  });
  if (!updated) return sortHealthRecords(records, referenceDate);
  return sortHealthRecords(records.map((record) => record.id === recordId ? updated : record), referenceDate);
};

export const deleteHealthRecordById = (records: DoctorHealthRecord[], recordId: string, referenceDate = new Date()) => (
  sortHealthRecords(records.filter((record) => record.id !== recordId), referenceDate)
);

export const upsertHealthRecord = (
  records: DoctorHealthRecord[],
  record: DoctorHealthRecord,
  referenceDate = new Date(),
) => {
  const normalizedRecords = normalizeHealthRecords(records);
  const nextRecord = normalizeHealthRecord(record);
  if (!nextRecord) return sortHealthRecords(normalizedRecords, referenceDate);
  const existing = normalizedRecords.find((item) => (
    item.id === nextRecord.id
    || (item.source === nextRecord.source && healthRecordDateKey(item) === healthRecordDateKey(nextRecord))
  ));
  const merged = existing
    ? normalizeHealthRecord({
      ...existing,
      ...nextRecord,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nextRecord.updatedAt || referenceDate.toISOString(),
    })
    : nextRecord;
  if (!merged) return sortHealthRecords(normalizedRecords, referenceDate);
  const next = existing
    ? normalizedRecords.map((item) => item.id === existing.id ? merged : item)
    : [merged, ...normalizedRecords];
  return sortHealthRecords(next, referenceDate);
};

const boundedDays = (days: number) => Math.max(1, Math.min(370, Math.round(days) || 1));

const buildDateKeys = (days: number, referenceDate: Date) => {
  const count = boundedDays(days);
  return Array.from({ length: count }, (_item, index) => {
    const date = new Date(referenceDate);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (count - index - 1));
    return dateToLocalKey(date);
  });
};

const latestDailyMetrics = (records: DoctorHealthRecord[]) => {
  const metrics: DoctorHealthMetrics = {};
  const newestFirst = [...records].sort((left, right) => recordTime(right) - recordTime(left));
  for (const record of newestFirst) {
    for (const key of NUMERIC_METRIC_KEYS) {
      if (metrics[key] === undefined && record.metrics?.[key] !== undefined) metrics[key] = record.metrics[key];
    }
  }
  const safetyValues = newestFirst
    .map((record) => record.metrics?.safetyConcern)
    .filter((value): value is boolean => typeof value === "boolean");
  if (safetyValues.length) metrics.safetyConcern = safetyValues.some(Boolean);
  return Object.keys(metrics).length ? metrics : undefined;
};

export const buildHealthTrend = (
  records: DoctorHealthRecord[],
  days = 7,
  referenceDate = new Date(),
): HealthTrendPoint[] => {
  const normalized = normalizeHealthRecords(records);
  return buildDateKeys(days, referenceDate).map((dateKey) => {
    const dailyRecords = normalized.filter((record) => healthRecordDateKey(record) === dateKey);
    const date = dateFromKey(dateKey)!;
    const metrics = latestDailyMetrics(dailyRecords);
    return {
      dateKey,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      metrics,
      hasData: Boolean(metrics),
    };
  });
};

const average = (values: Array<number | undefined>) => {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (!present.length) return undefined;
  return Math.round((present.reduce((total, value) => total + value, 0) / present.length) * 10) / 10;
};

export const calculateHealthStats = (
  records: DoctorHealthRecord[],
  days = 7,
  referenceDate = new Date(),
): HealthStats => {
  const trend = buildHealthTrend(records, days, referenceDate);
  const recordedDays = trend.filter((point) => point.hasData).length;
  return {
    days: trend.length,
    recordedDays,
    completionRate: Math.round((recordedDays / trend.length) * 100),
    averageSleepDurationMinutes: average(trend.map((point) => point.metrics?.sleepDurationMinutes)),
    averageSleepLatencyMinutes: average(trend.map((point) => point.metrics?.sleepLatencyMinutes)),
    averageNightAwakenings: average(trend.map((point) => point.metrics?.nightAwakenings)),
    averageAnxietyScore: average(trend.map((point) => point.metrics?.anxietyScore)),
    averageMoodScore: average(trend.map((point) => point.metrics?.moodScore)),
    averageEnergyScore: average(trend.map((point) => point.metrics?.energyScore)),
    averageDaytimeImpactScore: average(trend.map((point) => point.metrics?.daytimeImpactScore)),
    safetyConcernDays: trend.filter((point) => point.metrics?.safetyConcern === true).length,
  };
};

export const recentRecordDayCount = (records: DoctorHealthRecord[], days = 7, referenceDate = new Date()) => {
  const includedDateKeys = new Set(buildDateKeys(days, referenceDate));
  return new Set(normalizeHealthRecords(records)
    .map(healthRecordDateKey)
    .filter((dateKey) => includedDateKeys.has(dateKey))).size;
};

export const dailyTasksFromRecords = <T extends { title: string }>(
  records: DoctorHealthRecord[],
  steps: T[],
  referenceDate = new Date(),
): DoctorDailyTasks => {
  const dateKey = dateToLocalKey(referenceDate);
  const recordedTitles = new Set(normalizeHealthRecords(records)
    .filter((record) => healthRecordDateKey(record) === dateKey)
    .flatMap((record) => record.completedTitles));
  return { dateKey, completed: steps.map((step) => recordedTitles.has(step.title)) };
};

export const buildHealthContextPayload = (
  records: DoctorHealthRecord[],
  referenceDate = new Date(),
  specialty?: SpecialtyRecordConfig,
): HealthContextPayload => {
  const includedDateKeys = new Set(buildDateKeys(30, referenceDate));
  return {
    version: 1,
    consent: true,
    records: sortHealthRecords(records, referenceDate, HEALTH_RECORD_RETENTION_DAYS, specialty)
      .filter((record) => includedDateKeys.has(healthRecordDateKey(record)))
      .slice(0, 7)
      .map((record) => ({
        dateKey: healthRecordDateKey(record),
        completedTitles: [...record.completedTitles],
        ...(record.note ? { note: record.note } : {}),
        ...(record.metrics ? { metrics: { ...record.metrics } } : {}),
        ...(specialty && record.measurements ? { measurements: { ...record.measurements } } : {}),
        ...(specialty && record.values ? { values: { ...record.values } } : {}),
      })),
  };
};

const formatMinutes = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  if (!hours) return `${remainder} 分钟`;
  return remainder ? `${hours} 小时 ${remainder} 分钟` : `${hours} 小时`;
};

export const formatHealthMetricsSummary = (record: DoctorHealthRecord, specialty?: SpecialtyRecordConfig) => {
  const metrics = normalizeHealthMetrics(record.metrics) || {};
  const parts: string[] = [];
  if (metrics.sleepDurationMinutes !== undefined) parts.push(`睡眠 ${formatMinutes(metrics.sleepDurationMinutes)}`);
  if (metrics.sleepLatencyMinutes !== undefined) parts.push(`入睡耗时 ${formatMinutes(metrics.sleepLatencyMinutes)}`);
  if (metrics.nightAwakenings !== undefined) parts.push(`夜醒 ${metrics.nightAwakenings} 次`);
  if (metrics.moodScore !== undefined) parts.push(`情绪 ${metrics.moodScore}/10`);
  if (metrics.anxietyScore !== undefined) parts.push(`焦虑 ${metrics.anxietyScore}/10`);
  if (metrics.energyScore !== undefined) parts.push(`精力 ${metrics.energyScore}/10`);
  if (metrics.daytimeImpactScore !== undefined) parts.push(`白天影响 ${metrics.daytimeImpactScore}/10`);
  if (metrics.safetyConcern) parts.push("存在需及时关注的安全风险");
  const specialtySummary = formatSpecialtyMeasurementsSummary(record.measurements, specialty);
  if (specialtySummary) parts.push(specialtySummary);
  if (specialty && record.values) for (const field of specialty.fields) { const value = record.values[field.key]; if (value) parts.push(field.label + " " + value); }
  return parts.join(" · ");
};
