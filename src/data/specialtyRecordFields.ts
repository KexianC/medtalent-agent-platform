import type { SpecialtyRecordField } from "../lib/specialtyRecords";
export const fields = {
  fastingGlucose: { key: "fastingGlucose", label: "空腹血糖", unit: "mmol/L", min: 0, max: 100, step: 0.1, hint: "按实际测量填写，未测量请留空" },
  postMealGlucose: { key: "postMealGlucose", label: "餐后2小时血糖", unit: "mmol/L", min: 0, max: 100, step: 0.1 },
  heightCm: { key: "heightCm", label: "身高", unit: "cm", min: 1, max: 300, step: 0.1 },
  weightKg: { key: "weightKg", label: "体重", unit: "kg", min: 0.1, max: 600, step: 0.1 },
  waistCm: { key: "waistCm", label: "腰围", unit: "cm", min: 1, max: 400, step: 0.1 },
  vertigoAttackCount: { key: "vertigoAttackCount", label: "眩晕发作次数", unit: "次", min: 0, max: 1000, step: 1 },
  longestVertigoMinutes: { key: "longestVertigoMinutes", label: "最长一次持续时间", unit: "分钟", min: 0, max: 1440, step: 1 },
  earFullnessScore: { key: "earFullnessScore", label: "耳闷胀感评分", unit: "分", min: 0, max: 10, step: 1, hint: "0–10" },
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

export const SPECIALTY_FIELD_KEYS: readonly string[] = Object.keys(fields);
