type Source = { institution: string; title: string; year?: string; url?: string };
type SourceGroup = { items: Source[]; note?: string };

const insomniaGuidelines: Source[] = [
  { institution: '中国睡眠研究会', title: '失眠症诊断和治疗指南（2025 版）', year: '中华医学杂志，2025，105(34)' },
  { institution: '中华医学会神经病学分会睡眠障碍学组', title: '中国成人失眠诊断与治疗指南（2017 版）', year: '中华神经科杂志，2018，51(5):324-335', url: 'https://seleguide.yiigle.com/uploads/guide_html/%E4%B8%AD%E5%9B%BD%E6%88%90%E4%BA%BA%E5%A4%B1%E7%9C%A0%E8%AF%8A%E6%96%AD%E4%B8%8E%E6%B2%BB%E7%96%97%E6%8C%87%E5%8D%97(2017%E7%89%88).html' },
];

export const sources: Record<'breath' | 'pmr' | 'family' | 'quit', SourceGroup> = {
  breath: {
    items: insomniaGuidelines,
    note: '中国失眠指南把腹式呼吸列为常用放松训练。这里是简化体验版，完整练习建议在专业人员指导下学习。',
  },
  pmr: { items: [
    ...insomniaGuidelines,
    { institution: '北京安定医院', title: '肌肉放松技术', url: 'https://bjad.com.cn/Html/News/Articles/1975.html' },
    { institution: '香港卫生署学生健康服务', title: '渐进式肌肉松弛练习', year: '2016 修订', url: 'https://www.studenthealth.gov.hk/sc_chi/relaxation/relaxation.html' },
    { institution: 'Blackpool Teaching Hospitals', title: 'A Self Help Guide to manage anxiety（PL/1191 v3）', year: '2025', url: 'https://www.blackpoolteachinghospitals.nhs.uk/patients/patient-leaflets/PL1191' },
  ], note: '中国失眠指南把渐进性肌肉放松列为常用放松训练。这里是简化体验版，完整练习建议在专业人员指导下学习。' },
  family: { items: [
    { institution: '国家心理健康和精神卫生防治中心', title: '疫情下精神疾病患者及家属的自我心理调适要点', year: '2022', url: 'https://ncmhc.org.cn/channel/newsinfo/6877' },
    { institution: '北京大学第六医院', title: '门（急）诊诊疗告知书', year: '2014', url: 'https://www.pkuh6.cn/Html/News/Articles/691.html' },
    { institution: 'NHS Every Mind Matters', title: 'Helping others with mental health problems', url: 'https://www.nhs.uk/every-mind-matters/supporting-others/helping-others/' },
    { institution: 'NIMH', title: 'Understanding Psychosis（23-MH-8110）', url: 'https://www.nimh.nih.gov/health/publications/understanding-psychosis' },
    { institution: 'NIMH', title: 'Bipolar Disorder', year: '2025', url: 'https://www.nimh.nih.gov/health/publications/bipolar-disorder' },
    { institution: 'NHS', title: 'Memory loss', year: '2023 复核', url: 'https://www.nhs.uk/symptoms/memory-loss-amnesia/' },
    { institution: 'NHS', title: 'Sudden confusion', year: '2024 复核', url: 'https://www.nhs.uk/symptoms/confusion/' },
    { institution: 'NHS', title: 'What to ask your doctor', url: 'https://www.nhs.uk/nhs-services/gps/what-to-ask-your-doctor/' },
  ] },
  quit: { items: [
    { institution: '《中国临床戒烟指南》专家组', title: '中国临床戒烟指南（2015年版）', url: 'https://extranet.who.int/fctcapps/sites/default/files/2023-04/china_2016_annex8_clinical_smoking_cessation_guidelines_2015.pdf' },
    { institution: 'WHO', title: '居家期间保持健康：戒烟', url: 'https://www.who.int/zh/campaigns/connecting-the-world-to-combat-coronavirus/healthyathome/healthyathome---quitting-tobacco' },
    { institution: 'NHS Keeping Well', title: 'Get help to quit smoking', url: 'https://www.keepingwellnwl.nhs.uk/self-help-resources/drug-alcohol-and-tobacco-support/get-help-quit-smoking' },
  ] },
};

export type SourceKey = keyof typeof sources;
