// Turn self-reported records into a plain visit summary: numbers only, no interpretation.
const ITEMS = [
  ['sleepDurationMinutes', '睡眠时长', (v) => `${(v / 60).toFixed(1)} 小时`],
  ['sleepLatencyMinutes', '入睡耗时', (v) => `${Math.round(v)} 分钟`],
  ['nightAwakenings', '夜醒', (v) => `${v.toFixed(1)} 次`],
  ['moodScore', '情绪稳定度', (v) => `${v.toFixed(1)} / 10`],
  ['anxietyScore', '焦虑程度', (v) => `${v.toFixed(1)} / 10`],
  ['energyScore', '白天精力', (v) => `${v.toFixed(1)} / 10`],
  ['daytimeImpactScore', '日常受影响', (v) => `${v.toFixed(1)} / 10`],
];
const dateOf = (record) => record.dateKey || String(record.createdAt || '').slice(0, 10);
const shiftDate = (dateKey, days) => {
  const date = new Date(`${dateKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

export function buildVisitSummary(records, { today, days = 30, questions = '', extraLines = [], extraTitle = '用药与戒烟（本人自填）：' }) {
  const from = shiftDate(today, days - 1);
  const inRange = records
    .filter((record) => record.metrics && dateOf(record) >= from && dateOf(record) <= today)
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  if (!inRange.length && !extraLines.length) return null;

  const lines = ['复诊摘要（本人自填，未经医生核实）', `统计范围：${from} 至 ${today}，有记录 ${new Set(inRange.map(dateOf)).size} 天`, '', '平均值（只算填写过的日期）：'];
  for (const [key, label, format] of ITEMS) {
    const values = inRange.map((record) => record.metrics[key]).filter((value) => typeof value === 'number');
    lines.push(`- ${label}：${values.length ? format(values.reduce((sum, value) => sum + value, 0) / values.length) : '未填写'}`);
  }
  const safetyDays = new Set(inRange.filter((record) => record.metrics.safetyConcern).map(dateOf)).size;
  if (safetyDays) lines.push(`- 记录中标记过安全担忧：${safetyDays} 天，请当面告诉医生`);

  if (extraLines.length) lines.push('', extraTitle, ...extraLines.map((line) => `- ${line}`));

  lines.push('', '最近记录：');
  for (const record of inRange.slice(0, 7)) {
    const parts = ITEMS.filter(([key]) => typeof record.metrics[key] === 'number').map(([key, label, format]) => `${label} ${format(record.metrics[key])}`);
    lines.push(`- ${dateOf(record)}：${parts.join('，') || '无数值'}${record.note ? `；备注：${record.note}` : ''}`);
  }
  if (!inRange.length) lines.push('- 暂无');
  if (questions.trim()) lines.push('', '想问医生：', questions.trim());
  lines.push('', '本摘要由自填记录自动整理，不是诊断，也不代表疗效判断。');
  return lines.join('\n');
}

// Medication and smoking are listed as counts only; the summary never comments on them.
export function buildMedicationLines(entries, smoking, { today, days = 30 }) {
  const from = shiftDate(today, days - 1);
  const inRange = (date) => date >= from && date <= today;
  const lines = [];
  const medication = (entries || []).filter((entry) => inRange(entry.date));
  if (medication.length) {
    const counts = {};
    for (const entry of medication) counts[entry.status] = (counts[entry.status] || 0) + 1;
    lines.push(`用药记录 ${medication.length} 天：${Object.entries(counts).map(([status, count]) => `${status} ${count} 天`).join('，')}`);
    const notes = medication.filter((entry) => entry.note).slice(0, 3).map((entry) => `${entry.date} ${entry.note}`);
    if (notes.length) lines.push(`用药备注：${notes.join('；')}`);
  }
  const smokingDays = Object.entries(smoking?.days || {}).filter(([date]) => inRange(date));
  if (smoking?.startDate || smokingDays.length) {
    const cigarettes = smokingDays.map(([, day]) => day.cigarettes).filter((value) => typeof value === 'number');
    const urges = smokingDays.reduce((sum, [, day]) => sum + (day.urges || 0), 0);
    lines.push(`戒烟${smoking?.startDate ? `开始于 ${smoking.startDate}` : '记录'}；填写吸烟支数 ${cigarettes.length} 天，合计 ${cigarettes.reduce((sum, value) => sum + value, 0)} 支；想吸烟 ${urges} 次`);
  }
  return lines;
}

// Tang-only additions; callers pass normalized assessment results, never interpretation text.
export function buildTangExtraLines(relaxDays, assessments, { today, days = 30 }) {
  const from = shiftDate(today, days - 1);
  const inRange = date => typeof date === 'string' && date >= from && date <= today;
  const count = new Set((relaxDays || []).filter(inRange)).size;
  const lines = count ? [`放松打卡 ${count} 天`] : [];
  for (const result of assessments || []) {
    if (!inRange(result.date) || !result.title || !Number.isFinite(result.score) || !Number.isFinite(result.maxScore)) continue;
    lines.push(`${result.title}：${result.score}/${result.maxScore} 分，${result.date}`);
  }
  return lines;
}

// Specialty records use configured fields. Same rule: numbers only, no interpretation.
export function buildFieldVisitSummary(records, { today, fields, days = 30, questions = '' }) {
  const from = shiftDate(today, days - 1);
  const inRange = records
    .filter((record) => dateOf(record) >= from && dateOf(record) <= today)
    .filter((record) => record.note || fields.some((field) => typeof record.measurements?.[field.key] === 'number'))
    .sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
  if (!inRange.length && !questions.trim()) return null;

  const format = (value, field) => `${Number.isInteger(value) ? value : value.toFixed(1)}${field.unit ? ` ${field.unit}` : ''}`;
  const lines = ['复诊摘要（本人自填，未经医生核实）', `统计范围：${from} 至 ${today}，有记录 ${new Set(inRange.map(dateOf)).size} 天`, '', '平均值（只算填写过的）：'];
  for (const field of fields) {
    const values = inRange.map((record) => record.measurements?.[field.key]).filter((value) => typeof value === 'number');
    lines.push(`- ${field.label}：${values.length ? format(values.reduce((sum, value) => sum + value, 0) / values.length, field) : '未填写'}`);
  }
  lines.push('', '最近记录：');
  for (const record of inRange.slice(0, 7)) {
    const parts = fields.filter((field) => typeof record.measurements?.[field.key] === 'number').map((field) => `${field.label} ${format(record.measurements[field.key], field)}`);
    lines.push(`- ${dateOf(record)}：${parts.join('，') || '无数值'}${record.note ? `；备注：${record.note}` : ''}`);
  }
  if (!inRange.length) lines.push('- 暂无');
  if (questions.trim()) lines.push('', '想问医生：', questions.trim());
  lines.push('', '本摘要由自填记录自动整理，不是诊断，也不代表疗效判断。');
  return lines.join('\n');
}
