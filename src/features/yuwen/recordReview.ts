import { recordCsv, type RecordReview } from '../health/recordReview.ts';
import { WELLNESS_METRICS, formatWellnessNumber, wellnessStatistics, wellnessTrend } from './recordModel.ts';
import type { WellnessRecord } from './types';

export function buildWellnessRecordReview(input: WellnessRecord[], days: 7 | 30, today: string, includeNotes = false): RecordReview {
  const points = wellnessTrend(input, days, today);
  const records = points.flatMap(point => point.record ? [point.record] : []);
  const from = points[0]?.date ?? today;
  const title = '喻雯 · 睡眠与身心记录摘要';
  const lines = [title, `${from} 至 ${today}；近 ${days} 天有记录 ${records.length} 天。`, '均值仅计算实际填写的日期，缺失不按 0 计算；自评分数保留原记录含义。'];
  for (const stat of wellnessStatistics(points)) {
    if (!stat.count) continue;
    const latest = [...records].reverse().find(record => record.values[stat.key] !== undefined)!;
    lines.push(`${stat.label}：均值 ${formatWellnessNumber(stat.average)} ${stat.unit}，最近 ${formatWellnessNumber(latest.values[stat.key])} ${stat.unit}（${latest.date}）；${stat.count} 天有填写。`);
  }
  const diaries = records.filter(record => record.note || record.trigger || record.coping);
  if (includeNotes) {
    for (const record of diaries.slice(-2)) {
      const text = [record.trigger && `发生了什么：${record.trigger}`, record.coping && `怎样照顾自己：${record.coping}`, record.note && `日记：${record.note}`].filter(Boolean).join('；');
      lines.push(`${record.date} 文字记录：${text.slice(0, 160)}`);
    }
    if (diaries.length > 2) lines.push(`另有 ${diaries.length - 2} 天的文字可在历史记录或导出文件中查看。`);
  } else if (diaries.length) lines.push(`本期 ${diaries.length} 天的文字正文未包含在摘要中。`);
  return {
    title, from, to: today, recordedDays: records.length, summary: lines.join('\n').slice(0, 1800),
    csv: recordCsv([
      ['智能体', '记录日期', ...WELLNESS_METRICS.map(metric => `${metric.label}（${metric.unit}）`), ...(includeNotes ? ['发生了什么', '我怎样照顾自己', '想留给自己的话'] : [])],
      ...records.map(record => ['喻雯', record.date, ...WELLNESS_METRICS.map(metric => record.values[metric.key]), ...(includeNotes ? [record.trigger, record.coping, record.note] : [])]),
    ]),
    filename: `yu-wen-health-${from}-${today}.csv`,
  };
}
