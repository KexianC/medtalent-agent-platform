import type { DoctorHealthMetrics, DoctorHealthRecord } from "../hooks/useDoctorLocalState";
import { healthRecordDateKey, isValidHealthDateKey, sortHealthRecords, upsertHealthRecord } from "./healthRecords";
const localDateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;

export type TangRecordDraft = {
  dateKey: string;
  sleepDurationHours: string;
  sleepLatencyMinutes: string;
  nightAwakenings: string;
  moodScore: string;
  anxietyScore: string;
  energyScore: string;
  daytimeImpactScore: string;
  note: string;
};

const displayHours = (minutes?: number) => minutes === undefined ? "" : (minutes / 60).toFixed(1).replace(/\.0$/, "");

export const createTangRecordDraft = (record?: DoctorHealthRecord): TangRecordDraft => ({
  dateKey: record ? healthRecordDateKey(record) : localDateKey(),
  sleepDurationHours: displayHours(record?.metrics?.sleepDurationMinutes),
  sleepLatencyMinutes: record?.metrics?.sleepLatencyMinutes?.toString() ?? "",
  nightAwakenings: record?.metrics?.nightAwakenings?.toString() ?? "",
  moodScore: record?.metrics?.moodScore?.toString() ?? "",
  anxietyScore: record?.metrics?.anxietyScore?.toString() ?? "",
  energyScore: record?.metrics?.energyScore?.toString() ?? "",
  daytimeImpactScore: record?.metrics?.daytimeImpactScore?.toString() ?? "",
  note: record?.note ?? "",
});

export const validateTangRecordDraft = (draft: TangRecordDraft) => {
  if (!isValidHealthDateKey(draft.dateKey) || draft.dateKey > localDateKey()) {
    return { error: "请选择今天或更早的有效日期。" };
  }
  const errors: string[] = [];
  const parse = (value: string, minimum: number, maximum: number, label: string, integer = false) => {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
      errors.push(`${label}应在 ${minimum}–${maximum} 之间${integer ? "，并填写整数" : ""}`);
      return undefined;
    }
    return parsed;
  };
  const sleepHours = parse(draft.sleepDurationHours, 0, 24, "睡眠时长");
  const metrics: DoctorHealthMetrics = {
    sleepDurationMinutes: sleepHours === undefined ? undefined : Math.round(sleepHours * 60),
    sleepLatencyMinutes: parse(draft.sleepLatencyMinutes, 0, 720, "入睡耗时", true),
    nightAwakenings: parse(draft.nightAwakenings, 0, 20, "夜醒次数", true),
    moodScore: parse(draft.moodScore, 0, 10, "情绪评分", true),
    anxietyScore: parse(draft.anxietyScore, 0, 10, "焦虑评分", true),
    energyScore: parse(draft.energyScore, 0, 10, "精力评分", true),
    daytimeImpactScore: parse(draft.daytimeImpactScore, 0, 10, "日间影响评分", true),
  };
  if (errors.length) return { error: `${errors[0]}。` };
  const hasMetrics = Object.values(metrics).some((value) => value !== undefined);
  if (!hasMetrics && !draft.note.trim()) {
    return { error: "请至少填写一项睡眠、状态、日常影响或备注。" };
  }
  return { metrics };
};

const tangVisibleMetricKeys = [
  "sleepDurationMinutes",
  "sleepLatencyMinutes",
  "nightAwakenings",
  "moodScore",
  "anxietyScore",
  "energyScore",
  "daytimeImpactScore",
] as const;

export const mergeTangDailyRecords = (records: DoctorHealthRecord[], dateKey: string) => {
  const sameDayRecords = sortHealthRecords(records).filter((record) => healthRecordDateKey(record) === dateKey);
  if (!sameDayRecords.length) return undefined;
  const metrics: DoctorHealthMetrics = {};
  for (const record of sameDayRecords) {
    for (const key of tangVisibleMetricKeys) {
      if (metrics[key] === undefined && record.metrics?.[key] !== undefined) metrics[key] = record.metrics[key];
    }
  }
  const note = [...new Set(sameDayRecords.map((record) => record.note?.trim()).filter((value): value is string => Boolean(value)))]
    .join("\n")
    .slice(0, 300);
  const latest = sameDayRecords[0];
  return {
    ...latest,
    completedTitles: [],
    ...(note ? { note } : { note: undefined }),
    ...(Object.keys(metrics).length ? { metrics } : { metrics: undefined }),
  };
};

export const upsertTangDailyRecord = (records: DoctorHealthRecord[], record: DoctorHealthRecord) => {
  const targetDateKey = healthRecordDateKey(record);
  const normalizedRecords = sortHealthRecords(records);
  const sameDayRecords = normalizedRecords.filter((item) => healthRecordDateKey(item) === targetDateKey);
  const currentById = normalizedRecords.find((item) => item.id === record.id);
  const keeper = sameDayRecords.find((item) => item.id === record.id) ?? sameDayRecords[0] ?? currentById;
  const canonicalRecord: DoctorHealthRecord = {
    ...record,
    id: keeper?.id ?? record.id,
    createdAt: keeper?.createdAt ?? record.createdAt,
  };
  const remainingRecords = normalizedRecords.filter((item) => (
    item.id !== record.id
    && item.id !== canonicalRecord.id
    && healthRecordDateKey(item) !== targetDateKey
  ));
  return upsertHealthRecord(remainingRecords, canonicalRecord);
};

export const tangScoreAnchors = {
  moodScore: ["0：情绪很不稳定", "5：有起伏，部分时间稳定", "10：情绪平稳、安心"],
  anxietyScore: ["0：没有焦虑感", "5：明显焦虑，仍能应对", "10：焦虑强烈，难以应对"],
  energyScore: ["0：几乎没有精力", "5：能完成部分日常事务", "10：精力充足"],
  daytimeImpactScore: ["0：日常生活未受影响", "5：部分事务需要努力完成", "10：日常事务难以完成"],
} as const;

