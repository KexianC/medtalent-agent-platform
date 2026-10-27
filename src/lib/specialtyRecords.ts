import type { DoctorHealthRecord } from "../hooks/useDoctorLocalState";

export type SpecialtyRecordField = {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
  type?: "number" | "text" | "select";
  group?: string;
  options?: string[];
};

export type SpecialtyRecordConfig = {
  title: string;
  description: string;
  fields: SpecialtyRecordField[];
};

const fields = {
  fastingGlucose: { key: "fastingGlucose", label: "空腹血糖", unit: "mmol/L", min: 0, max: 100, step: 0.1, hint: "按实际测量填写，未测量请留空" },
  postMealGlucose: { key: "postMealGlucose", label: "餐后2小时血糖", unit: "mmol/L", min: 0, max: 100, step: 0.1 },
  heightCm: { key: "heightCm", label: "身高", unit: "cm", min: 1, max: 300, step: 0.1 },
  weightKg: { key: "weightKg", label: "体重", unit: "kg", min: 0.1, max: 600, step: 0.1 },
  waistCm: { key: "waistCm", label: "腰围", unit: "cm", min: 1, max: 400, step: 0.1 },
  nasalBlockageScore: { key: "nasalBlockageScore", label: "鼻塞自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无鼻塞，10分非常明显" },
  tinnitusScore: { key: "tinnitusScore", label: "耳鸣自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无耳鸣，10分非常明显" },
  throatDiscomfortScore: { key: "throatDiscomfortScore", label: "咽喉不适自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无不适，10分非常明显" },
  painScore: { key: "painScore", label: "疼痛自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无疼痛，10分非常疼痛" },
  appetiteScore: { key: "appetiteScore", label: "食欲自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分没有食欲，10分食欲很好" },
  activityMinutes: { key: "activityMinutes", label: "活动时长", unit: "分钟", min: 0, max: 1440, step: 1, hint: "记录当天实际活动或康复练习时长" },
  sleepHours: { key: "sleepHours", label: "睡眠时长", unit: "小时", min: 0, max: 24, step: 0.1 },
  menstrualStatus: { key: "menstrualStatus", label: "经期状态", unit: "", min: 0, max: 1, step: 1, hint: "0表示不在经期，1表示正在经期" },
  hotFlashCount: { key: "hotFlashCount", label: "潮热次数", unit: "次", min: 0, max: 1000, step: 1 },
  temperatureC: { key: "temperatureC", label: "体温", unit: "℃", min: 0, max: 60, step: 0.1, hint: "按体温计的实际读数填写" },
  waterMl: { key: "waterMl", label: "饮水量", unit: "mL", min: 0, max: 20000, step: 1 },
  coughScore: { key: "coughScore", label: "咳嗽自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无咳嗽，10分非常明显" },
  breathlessnessScore: { key: "breathlessnessScore", label: "气促自评分", unit: "分", min: 0, max: 10, step: 1, hint: "0分无气促，10分非常明显" },
  nightAwakeningCount: { key: "nightAwakeningCount", label: "夜间醒来次数", unit: "次", min: 0, max: 100, step: 1 },
} satisfies Record<string, SpecialtyRecordField>;

const config = (title: string, description: string, keys: Array<keyof typeof fields>): SpecialtyRecordConfig => ({
  title,
  description,
  fields: keys.map((key) => fields[key]),
});

const specialtyConfigs: Record<string, SpecialtyRecordConfig> = {
  "fu-junfen": config("儿童血糖与生长记录", "按实际测量记录血糖、身高和体重，便于回顾变化。", ["fastingGlucose", "postMealGlucose", "heightCm", "weightKg"]),
  "chen-zhiling": config("耳鼻喉症状记录", "记录当天鼻塞、耳鸣和咽喉不适的主观感受。", ["nasalBlockageScore", "tinnitusScore", "throatDiscomfortScore"]),
  "gong-wenbo": config("代谢健康记录", "记录血糖、体重和腰围，整理日常测量结果。", ["fastingGlucose", "postMealGlucose", "weightKg", "waistCm"]),
  "chen-jinbiao": config("营养与身体感受记录", "记录体重、疼痛和食欲，便于复诊时回顾。", ["weightKg", "painScore", "appetiteScore"]),
  "wu-yuqin": config("体重与生活习惯记录", "记录体重、腰围、活动和睡眠，回顾生活习惯。", ["weightKg", "waistCm", "activityMinutes", "sleepHours"]),
  "lin-jinfang": config("女性健康记录", "记录经期状态、疼痛和潮热次数。", ["menstrualStatus", "painScore", "hotFlashCount"]),
  "luo-jun": config("术后恢复记录", "按实际情况记录体温、疼痛和食欲。", ["temperatureC", "painScore", "appetiteScore"]),
  "yu-weihua": config("康复日常记录", "记录体温、疼痛、活动时长和饮水量。", ["temperatureC", "painScore", "activityMinutes", "waterMl"]),
  "zhou-yong": config("呼吸与活动记录", "记录咳嗽、气促、夜醒和活动情况。", ["coughScore", "breathlessnessScore", "nightAwakeningCount", "activityMinutes"]),
};

const fallbackConfig = config("日常健康记录", "记录体重、睡眠和活动，整理自己的日常变化。", ["weightKg", "sleepHours", "activityMinutes"]);

export const getSpecialtyRecordConfig = (slug: string): SpecialtyRecordConfig => (
  Object.prototype.hasOwnProperty.call(specialtyConfigs, slug) ? specialtyConfigs[slug] : fallbackConfig
);

const isFieldValue = (value: unknown, field: SpecialtyRecordField): value is number => (
  typeof value === "number"
  && Number.isFinite(value)
  && value >= field.min
  && value <= field.max
  && Math.abs((value - field.min) / field.step - Math.round((value - field.min) / field.step)) < 0.000001
);

export const normalizeSpecialtyMeasurements = (
  value: unknown,
  specialty?: SpecialtyRecordConfig,
): Record<string, number> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entries = (specialty?.fields || (Object.values(fields) as SpecialtyRecordField[]))
    .filter((field) => (!field.type || field.type === "number") && Object.prototype.hasOwnProperty.call(raw, field.key) && isFieldValue(raw[field.key], field))
    .map((field) => [field.key, Math.round((raw[field.key] as number) * 1000000) / 1000000]);
  return entries.length ? Object.fromEntries(entries) : undefined;
};

export function normalizeSpecialtyValues(value: unknown, specialty?: SpecialtyRecordConfig): Record<string,string> | undefined {
  if (!specialty || !value || typeof value !== 'object' || Array.isArray(value)) return;
  const raw = value as Record<string,unknown>, entries = specialty.fields.filter(field => field.type === 'text' || field.type === 'select').flatMap(field => {
    const text = raw[field.key];
    return typeof text === 'string' && text.trim() && text.length <= 1000 && (field.type !== 'select' || field.options?.includes(text)) ? [[field.key, text.trim()]] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

const dateKeyFor = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
};

const recordDate = (record: DoctorHealthRecord) => {
  if (validDate(record.dateKey)) return record.dateKey;
  if (record.dateKey !== undefined && record.dateKey !== "") return "";
  const createdAt = new Date(record.createdAt);
  return Number.isFinite(createdAt.getTime()) ? dateKeyFor(createdAt) : "";
};

export const validateSpecialtyRecordInput = (
  values: Record<string, string>,
  specialty: SpecialtyRecordConfig,
  dateKey: string,
  referenceDate = new Date(),
): { measurements?: Record<string, number>; values?: Record<string,string>; errors: Record<string, string> } => {
  const errors: Record<string, string> = {};
  const measurements: Record<string, number> = {};
  if (!validDate(dateKey) || dateKey > dateKeyFor(referenceDate)) errors._date = "请选择有效日期，不能填写未来日期";
  for (const field of specialty.fields) {
    const text = (values[field.key] ?? "").trim();
    if (!text) continue;
    if (field.type === "text" || field.type === "select") { if (text.length > 1000 || field.type === "select" && !field.options?.includes(text)) errors[field.key] = "请填写有效内容（最多1000字）"; continue; }
    // Empty, hexadecimal and exponent strings should never silently turn into a measured value.
    const value = /^-?\d+(?:\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
    if (!isFieldValue(value, field)) {
      errors[field.key] = `请填写${field.min}–${field.max}${field.unit ? ` ${field.unit}` : ""}，${field.step === 1 ? "使用整数" : `最小间隔 ${field.step}`}`;
    } else measurements[field.key] = value;
  }
  if (!Object.keys(measurements).length && !normalizeSpecialtyValues(values, specialty) && !Object.keys(errors).length) errors._form = "请至少填写一项记录或备注";
  return { measurements: Object.keys(measurements).length ? measurements : undefined, values: normalizeSpecialtyValues(values, specialty), errors };
};

export type SpecialtyTrendPoint = {
  dateKey: string;
  label: string;
  measurements?: Record<string, number>;
  hasData: boolean;
};

export type SpecialtyFieldStats = SpecialtyRecordField & {
  count: number;
  average?: number;
  latest?: number;
  minimum?: number;
  maximum?: number;
};

export type SpecialtyStats = {
  days: number;
  recordedDays: number;
  measuredDays: number;
  completionRate: number;
  fields: SpecialtyFieldStats[];
  trend: SpecialtyTrendPoint[];
};

const recordTime = (record: DoctorHealthRecord) => Date.parse(record.updatedAt || record.createdAt) || Date.parse(record.createdAt) || 0;

const hasLegacyContent = (record: DoctorHealthRecord) => {
  if (typeof record.note === "string" && record.note.trim()) return true;
  if (Array.isArray(record.completedTitles) && record.completedTitles.some((title) => typeof title === "string" && title.trim())) return true;
  if (record.values && Object.keys(record.values).length) return true;
  const metrics = record.metrics;
  if (!metrics || typeof metrics !== "object") return false;
  if (typeof metrics.safetyConcern === "boolean") return true;
  const limits = { sleepDurationMinutes: 1440, sleepLatencyMinutes: 720, nightAwakenings: 50, moodScore: 10, anxietyScore: 10, energyScore: 10, daytimeImpactScore: 10 };
  return Object.entries(limits).some(([key, maximum]) => {
    const value = metrics[key as keyof typeof metrics];
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
  });
};

export const buildSpecialtyStats = (
  records: DoctorHealthRecord[],
  specialty: SpecialtyRecordConfig,
  days = 7,
  referenceDate = new Date(),
): SpecialtyStats => {
  const count = Number.isFinite(days) ? Math.max(1, Math.min(370, Math.round(days))) : 7;
  const newestFirst = (Array.isArray(records) ? records : [])
    .filter((record) => record && typeof record === "object" && typeof record.id === "string" && record.id.trim() && (record.source === "home" || record.source === "manage"))
    .slice().sort((left, right) => recordTime(right) - recordTime(left));
  const trend: SpecialtyTrendPoint[] = Array.from({ length: count }, (_, index) => {
    const date = new Date(referenceDate);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - (count - index - 1));
    const dateKey = dateKeyFor(date);
    const measurements: Record<string, number> = {};
    let hasLegacyRecord = false;
    for (const record of newestFirst) {
      if (recordDate(record) !== dateKey) continue;
      if (hasLegacyContent(record)) hasLegacyRecord = true;
      for (const [key, value] of Object.entries(normalizeSpecialtyMeasurements(record.measurements, specialty) || {})) {
        if (measurements[key] === undefined) measurements[key] = value;
      }
    }
    const hasMeasurements = Object.keys(measurements).length > 0;
    return { dateKey, label: `${date.getMonth() + 1}/${date.getDate()}`, measurements: hasMeasurements ? measurements : undefined, hasData: hasMeasurements || hasLegacyRecord };
  });
  const recordedDays = trend.filter((point) => point.hasData).length;
  return {
    days: count,
    recordedDays,
    measuredDays: trend.filter((point) => point.measurements !== undefined).length,
    completionRate: Math.round(recordedDays / count * 100),
    fields: specialty.fields.filter(field => !field.type || field.type === "number").map((field) => {
      const values = trend.map((point) => point.measurements?.[field.key]).filter((value): value is number => value !== undefined);
      return {
        ...field,
        count: values.length,
        ...(values.length ? {
          average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10,
          latest: values[values.length - 1],
          minimum: Math.min(...values),
          maximum: Math.max(...values),
        } : {}),
      };
    }),
    trend,
  };
};

export const formatSpecialtyMeasurementsSummary = (measurements: unknown, specialty?: SpecialtyRecordConfig) => {
  const normalized = normalizeSpecialtyMeasurements(measurements, specialty);
  if (!normalized) return "";
  return (specialty?.fields || (Object.values(fields) as SpecialtyRecordField[])).flatMap((field) => {
    const value = normalized[field.key];
    if (value === undefined) return [];
    if (field.key === "menstrualStatus") return [`经期状态 ${value === 1 ? "正在经期" : "不在经期"}`];
    return [`${field.label} ${value}${field.unit ? ` ${field.unit}` : ""}`];
  }).join(" · ");
};

/** Keep all unrelated legacy records; the reporting window never deletes stored history. */
export const saveSpecialtyRecord = (
  records: DoctorHealthRecord[],
  incoming: DoctorHealthRecord,
  editingId?: string,
  referenceDate = new Date(),
  specialty?: SpecialtyRecordConfig,
): { records: DoctorHealthRecord[]; error?: string } => {
  const dateKey = incoming.dateKey;
  if (!validDate(dateKey) || dateKey > dateKeyFor(referenceDate)) return { records, error: "请选择有效日期，不能填写未来日期" };
  if (!incoming.id?.trim() || !Number.isFinite(Date.parse(incoming.createdAt))) return { records, error: "记录格式无效，请重新填写" };
  const existing = editingId ? records.find((record) => record.id === editingId) : undefined;
  if (editingId && !existing) return { records, error: "该记录已不存在，请刷新后重试" };
  if (existing && records.some((record) => record.id !== existing.id && record.source === existing.source && recordDate(record) === dateKey)) {
    return { records, error: "该日期已有记录，请编辑当天记录或选择其他日期" };
  }
  const source = existing?.source || incoming.source;
  if (source !== "home" && source !== "manage") return { records, error: "记录来源无效" };
  const sameDay = existing ? [existing] : records.filter((record) => record.source === source && recordDate(record) === dateKey)
    .sort((left, right) => recordTime(left) - recordTime(right));
  const base = existing || sameDay[sameDay.length - 1];
  if (!existing && records.some((record) => record.id === incoming.id && !sameDay.includes(record))) return { records, error: "记录标识已存在，请刷新后重试" };
  const measurements = normalizeSpecialtyMeasurements(existing
    ? incoming.measurements
    : Object.assign({}, ...sameDay.map((record) => record.measurements || {}), incoming.measurements || {}), specialty);
  const values = normalizeSpecialtyValues(existing ? incoming.values : Object.assign({}, ...sameDay.map(record => record.values || {}), incoming.values || {}), specialty);
  const legacyMetrics = Object.assign({}, ...sameDay.map((record) => record.metrics || {}), incoming.metrics || {});
  const completedTitles = [...new Set([...sameDay.flatMap((record) => record.completedTitles || []), ...(incoming.completedTitles || [])])];
  const note = (incoming.note || "").trim().slice(0, 300) || (existing ? "" : [...sameDay].reverse().find((record) => record.note?.trim())?.note || "");
  if (!measurements && !values && !note && !completedTitles.length && !base?.metrics && !incoming.metrics) return { records, error: "请至少填写一项记录或备注" };
  const next: DoctorHealthRecord = {
    ...base,
    ...incoming,
    id: base?.id || incoming.id,
    createdAt: base?.createdAt || incoming.createdAt,
    updatedAt: referenceDate.toISOString(),
    schemaVersion: 2,
    source,
    dateKey,
    completedTitles,
    measurements,
    values,
    note: note || undefined,
    metrics: Object.keys(legacyMetrics).length ? legacyMetrics : undefined,
  };
  const replacedIds = new Set(sameDay.map((record) => record.id));
  return {
    records: [next, ...records.filter((record) => !replacedIds.has(record.id))]
      .sort((left, right) => recordDate(right).localeCompare(recordDate(left)) || recordTime(right) - recordTime(left)),
  };
};
