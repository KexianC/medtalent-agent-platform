import { completeAnswers, describeAssessment, FREQUENCY_OPTIONS, IMPACT_OPTIONS, WELLNESS_SCALES, type WellnessQuestion, type WellnessScale } from '../yuwen/assessmentModel.ts';

export type TangScale = Omit<WellnessScale, 'id'> & { id: WellnessScale['id'] | 'phq9' };

// INfORM Chinese PHQ-9, page 50; PHQ Screeners scoring manual, page 6.
const PHQ9: TangScale = {
  id: 'phq9', title: '抑郁症状自评 PHQ-9', subtitle: '回顾近两周的兴趣与情绪变化', duration: '约 3 分钟', scoredItems: 9, maxScore: 27,
  questions: [
    '做事没有兴趣或愉悦感', '感觉低落、郁闷或没有希望', '很难入睡或容易醒，或睡眠过多',
    '感觉疲劳或没有精力', '食欲不佳或饮食过量', '自我感觉差——或觉得自己很失败，或令自己或家人失望',
    '做事很难集中注意力，比如阅读报纸或看电视',
    '行动或说话过于迟缓，以致他人能够觉察到了，或正好相反——过于多动或不安分以致活动比平常要多得多',
    '觉得自己死掉会更好，或想以某种方式伤害自己',
  ].map<WellnessQuestion>(text => ({ text, options: FREQUENCY_OPTIONS })).concat([
    { text: '这些问题对你完成工作、照料家事或与他人相处造成了多大困难？（补充题，不计入总分；没有上述问题时请选择“一点也不困难”）', options: IMPACT_OPTIONS },
  ]),
};

export const TANG_SCALES: TangScale[] = [WELLNESS_SCALES.find(scale => scale.id === 'gad7')!, PHQ9];
// Preserve PHQ-2 history under its original name and score; never convert two answers into PHQ-9.
export const TANG_RESULT_SCALES: TangScale[] = [...TANG_SCALES, WELLNESS_SCALES.find(scale => scale.id === 'phq2')!];
export const PHQ9_SUPPORT = '你提到近两周出现过不想活着或伤害自己的想法，这值得认真对待，无论总分多少。请尽快联系精神心理专业人员，并让信任的人陪伴你。如果此刻有伤害自己的冲动、计划，或无法保证安全，请立即拨打 120 或前往最近的急诊，不要独自等待聊天回复。';

export function needsPhq9Support(scaleId: string, answers: readonly (number | null)[]) {
  return scaleId === 'phq9' && typeof answers[8] === 'number' && answers[8] > 0;
}

export function describeTangAssessment(scaleId: string, score: number) {
  if (scaleId !== 'phq9') return describeAssessment(scaleId, score);
  if (!Number.isInteger(score) || score < 0 || score > 27) return null;
  const label = score >= 20 ? '重度抑郁症状范围' : score >= 15 ? '中重度抑郁症状范围' : score >= 10 ? '中度抑郁症状范围' : score >= 5 ? '轻度抑郁症状范围' : '无或极轻度抑郁症状范围';
  return { label, text: '分数反映近两周自报症状的频率，不能确认或排除抑郁症。若困扰持续或影响生活，请寻求专业评估；第 9 题需单独关注，不能仅依据总分判断安全。' };
}

export const TANG_ASSESSMENT_SECTION = 'chat-assessments-v1';
export const TANG_SUPPLEMENT_LIMIT = 500;

// Supplementary text is a personal note, separate from every scored answer.
// Strip invisible controls on restore and cap untrusted persisted strings.
export function normalizeTangSupplement(value: unknown): string {
  if (typeof value !== 'string') return '';
  return Array.from(value.replace(/\r\n?/g, '\n')).filter(character => {
    const code = character.charCodeAt(0);
    return character === '\n' || code >= 32 && code !== 127
      && !(code >= 0x200b && code <= 0x200f)
      && !(code >= 0x202a && code <= 0x202e)
      && !(code >= 0x2066 && code <= 0x2069);
  }).join('').trim().slice(0, TANG_SUPPLEMENT_LIMIT).replace(/[\uD800-\uDBFF]$/u, '');
}

export const TANG_MOODS = [
  { id: 'low', label: '很低落', symbol: '☁', message: '我今天心情很低落，想找人聊聊。请先陪我说说此刻的感受。' },
  { id: 'tense', label: '有点焦虑', symbol: '≋', message: '我今天有点焦虑，想一起梳理让我不安的事情。' },
  { id: 'neutral', label: '还算平静', symbol: '○', message: '我今天心情还算平静，想聊聊最近的状态。' },
  { id: 'good', label: '心情不错', symbol: '◡', message: '我今天心情不错，想分享一件让我感觉好的小事。' },
  { id: 'bright', label: '很开心', symbol: '☀', message: '我今天很开心，想和你分享这份心情。' },
] as const;

export function buildTangMoodMessage(moodId: string): string | null {
  return TANG_MOODS.find(mood => mood.id === moodId)?.message ?? null;
}

export type TangAssessmentResult = {
  id: string;
  scaleId: TangScale['id'];
  createdAt: string;
  answers: number[];
  score: number;
  maxScore: number;
  supplement?: string;
};

export function createTangAssessmentResult(
  scaleId: string,
  answers: readonly unknown[],
  id: string,
  createdAt: string,
  supplement?: string,
): TangAssessmentResult | null {
  const scale = TANG_RESULT_SCALES.find(item => item.id === scaleId);
  if (!scale || !Array.isArray(answers) || !id || !Number.isFinite(Date.parse(createdAt))) return null;
  if (!completeAnswers(answers, scale.questions.length, 3)) return null;
  const result = { score: answers.slice(0, scale.scoredItems).reduce((sum, value) => sum + value, 0), maxScore: scale.maxScore };
  const note = normalizeTangSupplement(supplement);
  return { id, scaleId: scale.id, createdAt, answers: [...answers] as number[], ...result, ...(note ? { supplement: note } : {}) };
}

export function updateTangAssessmentSupplement(value: TangAssessmentResult, supplement: string): TangAssessmentResult | null {
  if (typeof supplement !== 'string' || supplement.length > TANG_SUPPLEMENT_LIMIT) return null;
  return createTangAssessmentResult(value.scaleId, value.answers, value.id, value.createdAt, supplement);
}

// Keep only the latest valid result per scale. Recompute scores from the answers
// so a stale or edited local snapshot cannot introduce a misleading result.
export function normalizeTangResults(value: unknown): TangAssessmentResult[] {
  if (!Array.isArray(value)) return [];
  const results: TangAssessmentResult[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.id !== 'string' || typeof candidate.scaleId !== 'string' || typeof candidate.createdAt !== 'string') continue;
    const result = createTangAssessmentResult(candidate.scaleId, candidate.answers, candidate.id, candidate.createdAt, candidate.supplement);
    if (result) results.push(result);
  }
  results.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return results.filter((result, index) => results.findIndex(item => item.scaleId === result.scaleId) === index);
}

export function buildTangAssessmentMessage(value: TangAssessmentResult, includeSupplement = false): string | null {
  const result = normalizeTangResults([value])[0];
  if (!result) return null;
  const scale = TANG_RESULT_SCALES.find(item => item.id === result.scaleId)!;
  const impact = scale.questions.length > scale.scoredItems
    ? `；生活影响补充题选择“${scale.questions[scale.scoredItems].options[result.answers[scale.scoredItems]]}”（该题不计分）`
    : '';
  const safety = result.scaleId === 'phq9' ? `；第 9 题（不想活着或伤害自己的想法）选择“${scale.questions[8].options[result.answers[8]]}”${needsPhq9Support(result.scaleId, result.answers) ? '，请先关注我的安全并引导我寻求现实中的专业支持' : ''}` : '';
  const supplement = includeSupplement === true && result.supplement
    ? `\n我主动选择分享的补充描述（个人记录，不计入量表分数）：\n${result.supplement}` : '';
  return `我完成了${scale.title}，回顾的是近两周的感受，得分 ${result.score}/${result.maxScore} 分${impact}${safety}。我知道自评不能用于诊断，想结合这些感受聊聊接下来怎样照顾自己。${supplement}`;
}
