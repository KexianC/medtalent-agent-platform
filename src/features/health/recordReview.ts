import type { DoctorHealthRecord } from '../../hooks/useDoctorLocalState';
import { formatHealthMetricsSummary, healthRecordDateKey, normalizeHealthRecords } from '../../lib/healthRecords.ts';
import { buildSpecialtyStats, normalizeSpecialtyMeasurements, type SpecialtyRecordConfig } from '../../lib/specialtyRecords.ts';

export type RecordReview = {
  title: string;
  from: string;
  to: string;
  recordedDays: number;
  summary: string;
  csv: string;
  filename: string;
};

const numberText = (value: number) => String(Math.round(value * 10) / 10);

/** Quoting alone does not stop spreadsheet applications from evaluating text as formulas. */
export function recordCsvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  let start = 0;
  while (start < text.length && (text.charCodeAt(start) <= 31 || /\s/.test(text[start]))) start += 1;
  const formula = start < text.length && ['=', '+', '-', '@'].includes(text[start]);
  const safe = formula ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function recordCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map(row => row.map(recordCsvCell).join(',')).join('\r\n');
}

export function recordReviewQuestion(review: RecordReview): string {
  return `请根据以下实际记录，帮我整理变化、还需要补充的信息，以及下次就诊可以沟通的问题。 ${review.summary.replace(/\n/g, ' ')}`.slice(0, 2000);
}

export function buildSpecialtyRecordReview(
  doctor: { name: string; slug: string },
  specialty: SpecialtyRecordConfig,
  input: DoctorHealthRecord[],
  days: 7 | 30,
  referenceDate = new Date(),
  includeNotes = false,
): RecordReview {
  const normalized = normalizeHealthRecords(input, specialty);
  const stats = buildSpecialtyStats(normalized, specialty, days, referenceDate);
  const from = stats.trend[0].dateKey;
  const to = stats.trend.at(-1)!.dateKey;
  const activeDates = new Set(stats.trend.filter(point => point.hasData).map(point => point.dateKey));
  const records = normalized.filter(record => activeDates.has(healthRecordDateKey(record)))
    .sort((a, b) => healthRecordDateKey(a).localeCompare(healthRecordDateKey(b)) || (a.updatedAt ?? a.createdAt).localeCompare(b.updatedAt ?? b.createdAt));
  const title = `${doctor.name} · ${specialty.title}摘要`;
  const lines = [title, `${from} 至 ${to}；近 ${days} 天有记录 ${stats.recordedDays} 天。`, '均值仅计算实际填写的日期；同日每项取最近值，缺失不按 0 计算。'];
  for (const field of stats.fields) {
    if (!field.count) continue;
    if (field.key === 'menstrualStatus') {
      const count = stats.trend.filter(point => point.measurements?.menstrualStatus === 1).length;
      lines.push(`${field.label}：${field.count} 天有填写，其中经期 ${count} 天；最近记录为${field.latest === 1 ? '正在经期' : '不在经期'}。`);
    } else lines.push(`${field.label}：均值 ${numberText(field.average!)} ${field.unit}，最近 ${numberText(field.latest!)} ${field.unit}；${field.count} 天有填写。`);
  }
  for (const field of specialty.fields.filter(field => field.type === 'text' || field.type === 'select')) { const latest = [...records].reverse().find(record => record.values?.[field.key]); if (latest) lines.push(field.label + '：' + latest.values![field.key] + '（' + healthRecordDateKey(latest) + '）。'); }
  const notes = records.filter(record => record.note?.trim());
  if (includeNotes) {
    for (const record of notes.slice(-3)) lines.push(`${healthRecordDateKey(record)} 备注：${record.note!.slice(0, 160)}`);
    if (notes.length > 3) lines.push(`另有 ${notes.length - 3} 条备注可在历史记录或导出文件中查看。`);
  } else if (notes.length) lines.push(`本期 ${notes.length} 条备注正文未包含在摘要中。`);
  const tasks = [...new Set(records.flatMap(record => record.completedTitles))];
  if (tasks.length) lines.push(`已记录的打卡内容：${tasks.slice(0, 8).join('、')}`);
  const csv = recordCsv([
    ['智能体', '记录日期', '来源', ...specialty.fields.map(field => `${field.label}${field.unit ? `（${field.unit}）` : ''}`), '历史睡眠情绪指标', '打卡内容', ...(includeNotes ? ['备注'] : [])],
    ...records.map(record => {
      const measurements = normalizeSpecialtyMeasurements(record.measurements, specialty);
      return [doctor.name, healthRecordDateKey(record), record.source === 'home' ? '首页状态记录' : '健康管理记录', ...specialty.fields.map(field => field.key === 'menstrualStatus' && measurements?.[field.key] !== undefined ? measurements[field.key] === 1 ? '正在经期' : '不在经期' : measurements?.[field.key] ?? record.values?.[field.key]), formatHealthMetricsSummary({ ...record, measurements: undefined }), record.completedTitles.join('、'), ...(includeNotes ? [record.note ?? ''] : [])];
    }),
  ]);
  return { title, from, to, recordedDays: stats.recordedDays, summary: lines.join('\n').slice(0, 1800), csv, filename: `${doctor.slug}-health-${from}-${to}.csv` };
}
