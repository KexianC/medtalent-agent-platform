export type WellnessQuestion = { text: string; options: readonly string[] };
export type WellnessScale = {
  id: 'gad7' | 'phq2'; title: string; subtitle: string; duration: string;
  scoredItems: number; maxScore: number; questions: WellnessQuestion[];
};

export const ASSESSMENT_SOURCE = 'https://inform-iadr.com/wp-content/uploads/2024/03/DC-TMD-Chinese-Assessment-Instruments_revised-2017_11_18.pdf';
export const ASSESSMENT_MANUAL = 'https://www.phqscreeners.com/images/sites/g/files/g10016261/f/201412/instructions.pdf';
export const FREQUENCY_OPTIONS = ['根本没有', '有几天', '一半以上的时间', '几乎每天'] as const;
export const IMPACT_OPTIONS = ['一点也不困难', '有点困难', '非常困难', '极度困难'] as const;

// Item text and response labels follow the INfORM Chinese translation (pp. 50, 52).
// Pfizer's manual explicitly permits reproducing/deriving the PHQ-2 (pp. 3, 7, 8).
export const WELLNESS_SCALES: WellnessScale[] = [
  {
    id: 'gad7', title: '焦虑自评 GAD-7', subtitle: '回顾近两周的焦虑相关感受', duration: '约 2 分钟', scoredItems: 7, maxScore: 21,
    questions: [
      '感到紧张、焦虑或不安', '无法停止或控制的忧虑', '对各种事情过于担心', '很难放松',
      '过于焦躁不安，以致难以平静地坐着', '容易恼怒或被激惹', '害怕会发生不好的事情',
    ].map<WellnessQuestion>(text => ({ text, options: FREQUENCY_OPTIONS })).concat([
      { text: '这些问题对你完成工作、照料家事或与他人相处造成了多大困难？（补充题，不计入总分；没有上述问题时请选择“一点也不困难”）', options: IMPACT_OPTIONS },
    ]),
  },
  {
    id: 'phq2', title: '情绪简筛 PHQ-2', subtitle: '回顾近两周的兴趣与情绪变化', duration: '约 1 分钟', scoredItems: 2, maxScore: 6,
    questions: ['做事没有兴趣或愉悦感', '感觉低落、郁闷或没有希望'].map(text => ({ text, options: FREQUENCY_OPTIONS })),
  },
];

export function completeAnswers(answers: readonly unknown[], count: number, max: number): answers is number[] {
  return Array.isArray(answers) && answers.length === count && Array.from(answers).every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max);
}

export function scoreAssessment(scaleId: string, answers: readonly unknown[]) {
  const scale = WELLNESS_SCALES.find(item => item.id === scaleId);
  if (!scale || !completeAnswers(answers, scale.questions.length, 3)) return null;
  return { score: answers.slice(0, scale.scoredItems).reduce((sum, value) => sum + value, 0), maxScore: scale.maxScore };
}

export function describeAssessment(scaleId: string, score: number) {
  const scale = WELLNESS_SCALES.find(item => item.id === scaleId);
  if (!scale || !Number.isInteger(score) || score < 0 || score > scale.maxScore) return null;
  if (scaleId === 'phq2') return score >= 3
    ? { label: '达到进一步评估的参考分值', text: '这份简筛不能判断是否患有抑郁症。可把近两周的感受和结果带给专业人员，结合完整问卷与访谈进一步了解。' }
    : { label: '低于进一步评估的参考分值', text: '本次两项简筛得分低于 3 分，不能排除其他情绪困扰。若困扰持续、加重或影响生活，仍可以向专业人员寻求支持。' };
  const label = score >= 15 ? '重度焦虑症状范围' : score >= 10 ? '中度焦虑症状范围' : score >= 5 ? '轻度焦虑症状范围' : '无或极轻度焦虑症状范围';
  return { label, text: score >= 10
    ? '分数反映自报症状的频率，不能确认焦虑障碍或其原因。可与专业人员讨论近两周的感受及生活影响，由其结合访谈进一步评估。'
    : '分数反映本次自报感受，不能确认或排除焦虑障碍。可以继续记录变化；若困扰持续或影响生活，可以向专业人员寻求支持。' };
}

export const PERSONALITY_DIMENSIONS = [
  { key: 'EI', first: 'E', second: 'I', firstLabel: '互动充电', secondLabel: '独处充电', title: '精力来源' },
  { key: 'SN', first: 'S', second: 'N', firstLabel: '具体经验', secondLabel: '可能联想', title: '关注信息' },
  { key: 'TF', first: 'T', second: 'F', firstLabel: '逻辑权衡', secondLabel: '感受价值', title: '做出决定' },
  { key: 'JP', first: 'J', second: 'P', firstLabel: '计划推进', secondLabel: '灵活探索', title: '安排生活' },
] as const;
type DimensionKey = typeof PERSONALITY_DIMENSIONS[number]['key'];
export type PersonalityQuestion = WellnessQuestion & { dimension: DimensionKey; firstOptionLetter: string };

// Original, binary preference prompts. Five per dimension avoid arbitrary tie-breaking.
export const PERSONALITY_QUESTIONS: PersonalityQuestion[] = [
  { dimension: 'EI', firstOptionLetter: 'E', text: '忙碌的一周结束后，你更想怎样恢复精力？', options: ['约熟悉的人聊聊近况', '留一段安静的独处时间'] },
  { dimension: 'SN', firstOptionLetter: 'S', text: '开始了解一个新领域时，你通常先关注什么？', options: ['具体例子和已有的做法', '整体概念和可能的发展'] },
  { dimension: 'TF', firstOptionLetter: 'F', text: '朋友向你倾诉困扰时，你更自然的第一反应是？', options: ['理解对方此刻的感受', '梳理事情的原因与可选办法'] },
  { dimension: 'JP', firstOptionLetter: 'J', text: '准备一次短途旅行，你更喜欢怎样安排？', options: ['提前确定行程与主要时间', '只定大方向，途中再决定'] },
  { dimension: 'EI', firstOptionLetter: 'I', text: '参加陌生人较多的活动时，你通常会？', options: ['先观察，再找少数人慢慢聊', '主动打招呼，在交流中熟悉大家'] },
  { dimension: 'SN', firstOptionLetter: 'N', text: '听到一个有趣的想法时，你更容易想到？', options: ['它还可能延伸出哪些新方向', '它在现实中有哪些具体用途'] },
  { dimension: 'TF', firstOptionLetter: 'T', text: '选择一个共同使用的方案时，你更看重？', options: ['标准是否一致、理由是否充分', '是否照顾参与者的需求和感受'] },
  { dimension: 'JP', firstOptionLetter: 'P', text: '面对一个尚有余裕的周末，你更享受？', options: ['留出空白，跟随当时的兴趣', '提前安排好想完成的事情'] },
  { dimension: 'EI', firstOptionLetter: 'E', text: '思考一个还没想清楚的问题时，你倾向于？', options: ['边和人讨论边整理思路', '先独自想一想，再表达想法'] },
  { dimension: 'SN', firstOptionLetter: 'S', text: '复述一次难忘的经历时，你更常提到？', options: ['当时的细节、人物和发生顺序', '这件事带来的感悟与联想'] },
  { dimension: 'TF', firstOptionLetter: 'F', text: '当两种做法都可行时，你更愿意依据什么取舍？', options: ['哪一种更符合自己的价值与在意的人', '哪一种利弊更清晰、效率更高'] },
  { dimension: 'JP', firstOptionLetter: 'J', text: '一个任务还有一周截止，你通常偏好？', options: ['分成几步，逐项完成后更安心', '保持多种思路，再集中完成'] },
  { dimension: 'EI', firstOptionLetter: 'I', text: '一天中社交很多之后，接下来你更想？', options: ['减少交流，让自己安静一会儿', '继续与投缘的人相处一会儿'] },
  { dimension: 'SN', firstOptionLetter: 'N', text: '解决熟悉的问题时，你更有兴趣尝试？', options: ['换一个角度，探索新的可能', '沿用可靠方法，再改进细节'] },
  { dimension: 'TF', firstOptionLetter: 'T', text: '给同伴提出反馈时，你更倾向先说？', options: ['哪些环节可以具体改进', '哪些努力值得理解与肯定'] },
  { dimension: 'JP', firstOptionLetter: 'P', text: '当计划出现临时变化时，你更接近哪种感受？', options: ['可能会有新体验，愿意顺势调整', '希望尽快重新确定安排'] },
  { dimension: 'EI', firstOptionLetter: 'E', text: '分享一件令你兴奋的小事时，你通常会？', options: ['很快找人分享，在回应中更开心', '先自己回味，再择机告诉亲近的人'] },
  { dimension: 'SN', firstOptionLetter: 'S', text: '判断一条建议是否有用时，你更在意？', options: ['有没有清楚的事实与操作步骤', '能不能打开新的理解与思路'] },
  { dimension: 'TF', firstOptionLetter: 'F', text: '讨论中出现分歧时，你更自然地关注？', options: ['怎样让彼此被理解、保留尊重', '怎样把论点和证据逐条讲清楚'] },
  { dimension: 'JP', firstOptionLetter: 'J', text: '面对多个感兴趣的选择，你更偏好？', options: ['作出决定，专心推进选定的方向', '保留选项，收集更多体验再决定'] },
];

export function scorePersonality(answers: readonly unknown[]) {
  if (!completeAnswers(answers, PERSONALITY_QUESTIONS.length, 1)) return null;
  const dimensions: Record<string, number> = {};
  let type = '';
  for (const dimension of PERSONALITY_DIMENSIONS) {
    let firstCount = 0;
    PERSONALITY_QUESTIONS.forEach((question, index) => {
      if (question.dimension !== dimension.key) return;
      const firstChosen = answers[index] === 0;
      if (firstChosen === (question.firstOptionLetter === dimension.first)) firstCount += 1;
    });
    dimensions[dimension.key] = firstCount * 20;
    type += firstCount >= 3 ? dimension.first : dimension.second;
  }
  return { type, dimensions };
}

export const PERSONALITY_DESCRIPTIONS: Record<string, { title: string; description: string; practice: string }> = {
  ISTJ: { title: '细致的践行者', description: '你可能偏好安静思考、依据经验，按清晰的步骤推进事情。可靠与秩序感常让你感到踏实。', practice: '给计划留一点空白，也听听当下的感受。' },
  ISFJ: { title: '体贴的守护者', description: '你可能留意实际细节，也重视身边人的需要。熟悉的关系和有序的安排常给你支持。', practice: '照顾别人时，也为自己的需要留出位置。' },
  INFJ: { title: '温和的洞察者', description: '你可能喜欢独处整理想法，寻找经历背后的意义，也希望行动与内心价值一致。', practice: '把长远想法拆成今天能完成的一小步。' },
  INTJ: { title: '独立的规划者', description: '你可能习惯从整体寻找规律，独自推演，再用结构化的方式实现想法。', practice: '交流时多说明思考过程，并留意伙伴的反馈。' },
  ISTP: { title: '灵活的实践者', description: '你可能偏好观察事实、亲手尝试，遇到问题时灵活拆解，重视自主空间。', practice: '及时表达自己的安排，让身边人更容易配合。' },
  ISFP: { title: '自在的感受者', description: '你可能对当下的细节与感受敏锐，珍惜个人价值，也愿意按自己的节奏体验生活。', practice: '将重要的期待说出来，不必都放在心里。' },
  INFP: { title: '真诚的探索者', description: '你可能拥有丰富联想，在意真诚与意义，愿意保留多种可能并理解不同感受。', practice: '选择一个具体的小行动，让珍视的想法落地。' },
  INTP: { title: '好奇的思考者', description: '你可能喜欢独立研究问题，从概念和逻辑中发现新联系，也享受开放的探索过程。', practice: '给探索设置一个小节点，尝试分享阶段性发现。' },
  ESTP: { title: '敏捷的行动者', description: '你可能在互动与实践中获得精力，重视眼前信息，善于根据现场情况快速调整。', practice: '行动前给长期影响留一分钟思考。' },
  ESFP: { title: '热情的体验者', description: '你可能享受与人共同体验当下，留意真实感受，愿意让生活保持活力与弹性。', practice: '把一件重要但不紧急的事安排进日程。' },
  ENFP: { title: '开朗的联想者', description: '你可能通过交流产生新灵感，关注人的可能性，喜欢探索符合个人价值的新方向。', practice: '从许多灵感中选一个，给它一次完整尝试。' },
  ENTP: { title: '活跃的创想者', description: '你可能喜欢讨论想法、检验逻辑、挑战既有路径，在开放探索中找到乐趣。', practice: '讨论前确认对方此刻想要建议还是倾听。' },
  ESTJ: { title: '务实的组织者', description: '你可能习惯通过交流协调行动，依据经验和标准建立秩序，重视事情如期完成。', practice: '为不同节奏的人留一点弹性，也让自己休息。' },
  ESFJ: { title: '热心的协调者', description: '你可能重视共同参与和具体需要，喜欢把事情安排妥当，让身边的人感到被照顾。', practice: '先问问自己的精力，再决定答应多少事情。' },
  ENFJ: { title: '温暖的推动者', description: '你可能在交流中关注共同愿景与他人的成长，愿意有计划地推进有意义的事情。', practice: '尊重每个人的选择，也给自己的感受一点空间。' },
  ENTJ: { title: '果断的统筹者', description: '你可能喜欢组织资源、讨论方向，以清晰的逻辑和计划推动长远目标。', practice: '在明确目标之外，主动了解伙伴的真实处境。' },
};

export const WELLNESS_CARDS = [
  { id: 'fool', name: '愚者', symbol: '✦', theme: '给开始一点勇气', text: '这张卡邀请你想一想：有没有一件愿意从小处尝试的事？', action: '为它写下一个今天就能开始的小步骤。' },
  { id: 'magician', name: '魔术师', symbol: '✧', theme: '看见手中的资源', text: '回想最近一次解决问题的经历，你已经用过哪些能力和支持？', action: '写下一项自己已有的资源，今天试着用一用。' },
  { id: 'priestess', name: '女祭司', symbol: '☾', theme: '给感受一个名字', text: '停一会儿，留意此刻身体的感受和心情，不急着解释它们。', action: '用一两个词记录此刻的感受。' },
  { id: 'empress', name: '皇后', symbol: '❋', theme: '照顾日常的小需要', text: '一杯水、一顿饭、一段休息，也可以是认真照顾自己的方式。', action: '选一件舒适的小事，留几分钟给自己。' },
  { id: 'emperor', name: '皇帝', symbol: '◇', theme: '让生活有一点秩序', text: '面对很多待办时，可以先分清今天最想完成的一件事。', action: '整理一个小角落，或者写下一个清楚的优先项。' },
  { id: 'strength', name: '力量', symbol: '✺', theme: '允许自己慢一点', text: '有时耐心地陪伴自己，就是一种力量。困难时也可以寻求支持。', action: '对自己说一句具体、温和而真实的话。' },
  { id: 'hermit', name: '隐士', symbol: '✩', theme: '留一刻安静', text: '暂时放下外界的声音，看看什么事情值得你现在花心思。', action: '放下手机片刻，安静地整理一个想法。' },
  { id: 'wheel', name: '命运之轮', symbol: '◎', theme: '为变化留出空间', text: '生活会有变化。你可以区分哪些能调整，哪些暂时需要接纳。', action: '选一件能由自己决定的小事，做出一个温和的调整。' },
] as const;

export function pickWellnessCard(randomValue = Math.random()) {
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) throw new RangeError('随机值须在 0（含）至 1（不含）之间');
  return WELLNESS_CARDS[Math.floor(randomValue * WELLNESS_CARDS.length)];
}
