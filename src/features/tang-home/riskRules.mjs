// Rule-based reminders from self-reported data only. Thresholds are demo values pending doctor review.
const DAY = 86400000;
const latestByScale = (results, scaleId, now) => results
  .filter((entry) => entry.scaleId === scaleId && now - new Date(entry.createdAt).getTime() <= 14 * DAY)
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

export function buildRiskItems({ records = [], results = [], now = Date.now() }) {
  const items = [];
  const phq9 = latestByScale(results, 'phq9', now);
  const gad7 = latestByScale(results, 'gad7', now);
  const recent = records.filter((record) => record.metrics && now - new Date(record.createdAt).getTime() <= 7 * DAY);
  if ((phq9?.answers?.[8] ?? 0) > 0) items.push({ level: 'high', text: '最近一次 PHQ-9 第 9 题提到不想活着或伤害自己的想法。请尽快联系精神心理专业人员，并让信任的人陪伴你。' });
  if (recent.some((record) => record.metrics.safetyConcern)) items.push({ level: 'high', text: '最近的记录里标记过安全担忧。请尽快联系精神心理专业人员，并让信任的人陪伴你。' });
  if (phq9 && phq9.score >= 10) items.push({ level: 'medium', text: `最近一次 PHQ-9 为 ${phq9.score} 分，建议预约门诊，当面和医生谈谈。` });
  if (gad7 && gad7.score >= 10) items.push({ level: 'medium', text: `最近一次 GAD-7 为 ${gad7.score} 分，建议预约门诊，当面和医生谈谈。` });
  items.push(...buildDiaryItems({ records, now }).map(text => ({ level: 'medium', text })));
  return items;
}

export function buildScaleAdvice(scaleId, score) {
  const name = scaleId === 'gad7' ? 'GAD-7' : scaleId === 'phq9' ? 'PHQ-9' : null;
  return name && score >= 10 ? `本次 ${name} 得分为${score}分。结果仅供筛查参考，不代表诊断。建议预约门诊，由医生进一步评估。` : null;
}

export function buildDiaryItems({ records = [], now = Date.now() }) {
  const items = [];
  const recent = records.filter((record) => record.metrics && now - new Date(record.createdAt).getTime() <= 7 * DAY);
  const scores = (key) => recent.map((record) => record.metrics[key]).filter((value) => typeof value === 'number');
  const mood = scores('moodScore');
  const anxiety = scores('anxietyScore');
  if (mood.length >= 3 && average(mood) <= 3) items.push('近 7 天情绪稳定度偏低，建议把这个变化告诉医生。');
  if (anxiety.length >= 3 && average(anxiety) >= 7) items.push('近 7 天焦虑程度偏高，建议把这个变化告诉医生。');
  return items;
}
