import type { AgentBuilderConfig } from "../lib/agentBuilder";
export type Article = {
  id: string;
  title: string;
  summary: string;
  tag: string;
  readTime: string;
};

export type DoctorProfile = {
  slug: string;
  name: string;
  portrait?: string;
  portraitPosition?: string;
  portraitScale?: number;
  portraitTranslateY?: string;
  portraitBackground?: string;
  portraitTransformOrigin?: string;
  hospital: string;
  department: string;
  title: string;
  specialty: string;
  intro: string;
  accent: string;
  accentSoft: string;
  quickQuestions: string[];
  topics: string[];
  services: string[];
  articles: Article[];
  builder?: AgentBuilderConfig;
};

const profile = (
  base: Omit<DoctorProfile, "title" | "accentSoft"> & { title?: string; accentSoft?: string },
): DoctorProfile => ({ title: "专业健康空间", accentSoft: "#ecf5f3", ...base });

export const doctorProfiles: DoctorProfile[] = [
  profile({
    slug: "fu-junfen", name: "傅君芬", portrait: "/assets/doctors/portraits/fu-junfen.png", portraitPosition: "51% 50%", hospital: "浙江大学医学院附属儿童医院", department: "儿童内分泌科",
    specialty: "儿童糖尿病与生长发育管理", accent: "#3b8d88", intro: "以儿童糖尿病日常管理为核心，帮助家庭整理血糖、胰岛素、饮食运动和低血糖风险信息，同时关注身高、体重与青春期发育。",
    quickQuestions: ["儿童血糖记录要包含哪些信息？", "孩子出现低血糖症状时该怎么办？", "上学和运动时怎样做好控糖准备？", "糖尿病儿童如何关注身高体重变化？"],
    topics: ["儿童糖尿病", "血糖管理", "低血糖应对", "生长发育"], services: ["糖尿病日常管理评估", "血糖与胰岛素记录", "校园与运动管理", "生长发育随访"],
    articles: [
      { id: "fu-1", title: "儿童血糖日记，怎样记得更有用？", summary: "把监测时段、饮食运动、胰岛素与不适症状放在同一条时间线上。", tag: "血糖管理", readTime: "4 分钟" },
      { id: "fu-2", title: "识别儿童低血糖：家庭和校园都要知道", summary: "了解常见表现、日常准备与需要立即求助的情况。", tag: "低血糖", readTime: "5 分钟" },
      { id: "fu-3", title: "控糖同时，也别忽略孩子的生长曲线", summary: "定期记录身高体重，为复诊沟通提供连续的成长信息。", tag: "生长发育", readTime: "5 分钟" },
    ],
  }),
  profile({
    slug: "chen-zhiling", name: "陈志凌", portrait: "/assets/doctors/portraits/chen-zhiling.jpg", portraitPosition: "50% 50%", hospital: "杭州市中医院", department: "耳鼻咽喉科",
    specialty: "耳鼻喉疾病的中西医结合诊治", accent: "#477b91", accentSoft: "#eef5f8", intro: "聚焦儿童鼻炎、腺样体肥大、耳鸣眩晕及鼻窦炎，帮助患者做好症状判断与长期管理。",
    quickQuestions: ["孩子鼻塞打鼾是腺样体肥大吗？", "过敏性鼻炎怎么减少复发？", "突然耳鸣耳闷需要马上就医吗？", "慢性鼻窦炎日常怎么护理？"],
    topics: ["儿童鼻炎", "腺样体", "耳鸣眩晕", "鼻窦炎"], services: ["耳鼻喉症状自查", "检查报告解读", "术后康复指导", "过敏季提醒"],
    articles: [
      { id: "czl-1", title: "孩子长期张口呼吸，别只当成习惯", summary: "识别鼻炎、扁桃体和腺样体问题的常见表现。", tag: "儿童鼻病", readTime: "5 分钟" },
      { id: "czl-2", title: "突发耳聋的黄金就诊时间", summary: "突然听力下降、耳鸣或眩晕时，哪些情况不能等待。", tag: "听力", readTime: "3 分钟" },
      { id: "czl-3", title: "鼻腔冲洗做对了吗？", summary: "盐水选择、操作姿势和使用频率一次讲清。", tag: "鼻炎", readTime: "4 分钟" },
    ],
  }),
  profile({
    slug: "gong-wenbo", name: "龚文波", portrait: "/assets/doctors/portraits/gong-wenbo.jpg", portraitPosition: "50% 50%", hospital: "宁波市中医院", department: "内科",
    specialty: "内分泌代谢病与中医调理", accent: "#8b5e3c", accentSoft: "#f7efe8", intro: "传承原 demo 的中医表达，围绕糖尿病、痛风、甲状腺与代谢综合征提供辨证调养建议。",
    quickQuestions: ["糖尿病饮食怎么控制？", "尿酸高了怎么办？", "中医减重会反弹吗？", "甲状腺结节怎么调理？"],
    topics: ["糖尿病", "痛风", "体重管理", "甲状腺"], services: ["体质辨识", "代谢指标解读", "膳食调养计划", "复诊与用药提醒"],
    articles: [
      { id: "gwb-1", title: "从‘三消’认识糖尿病的中医调养", summary: "结合现代监测指标，理解饮食、运动与辨证调理的关系。", tag: "糖尿病", readTime: "6 分钟" },
      { id: "gwb-2", title: "痛风缓解期也不能放松管理", summary: "从饮水、饮食、体重与复查四方面降低复发风险。", tag: "痛风", readTime: "5 分钟" },
      { id: "gwb-3", title: "代谢管理不是单纯减体重", summary: "腰围、血脂、血糖与生活节律同样重要。", tag: "代谢", readTime: "4 分钟" },
    ],
  }),
  profile({
    slug: "chen-jinbiao", name: "陈金标", portrait: "/assets/doctors/portraits/chen-jinbiao.png", portraitPosition: "50% 2%", hospital: "杭州市西溪医院", department: "肿瘤科",
    specialty: "实体肿瘤综合治疗与康复支持", accent: "#6d7397", accentSoft: "#f0f1f7", intro: "面向肺癌、肝癌及消化道肿瘤患者，提供治疗流程、营养康复、癌痛与随访知识支持。",
    quickQuestions: ["化疗前需要做哪些准备？", "肿瘤患者怎么补充营养？", "靶向治疗出现皮疹怎么办？", "复查时要带哪些资料？"],
    topics: ["肺癌", "肝癌", "消化道肿瘤", "康复营养"], services: ["治疗方案知识解读", "不良反应记录", "营养风险筛查", "复查随访计划"],
    articles: [
      { id: "cjb-1", title: "第一次化疗前，患者和家属要准备什么", summary: "从检查资料到生活用品，减少治疗前的不确定感。", tag: "治疗准备", readTime: "6 分钟" },
      { id: "cjb-2", title: "肿瘤治疗期间，体重下降要重视", summary: "识别营养风险，避免盲目忌口和不恰当进补。", tag: "营养", readTime: "5 分钟" },
      { id: "cjb-3", title: "癌痛不是必须忍耐的症状", summary: "学会记录疼痛程度，及时与医疗团队沟通。", tag: "症状管理", readTime: "4 分钟" },
    ],
  }),
  profile({
    slug: "wu-yuqin", name: "吴玉琴", portrait: "/assets/doctors/portraits/wu-yuqin.png", portraitPosition: "50% 50%", portraitScale: 0.88, portraitBackground: "#f6f4f7", hospital: "浙江中医药大学附属第二医院", department: "生活方式医学门诊",
    specialty: "体重管理与慢病生活方式干预", accent: "#668b4f", accentSoft: "#f1f6ed", intro: "把抽象的‘管住嘴、迈开腿’变成每日可执行的饮食、运动、睡眠与压力管理处方。",
    quickQuestions: ["减重平台期怎么突破？", "外食多的人怎么控制热量？", "四高人群适合什么运动？", "怎样记录饮食更有效？"],
    topics: ["科学减重", "饮食记录", "运动处方", "慢病逆转"], services: ["生活方式评估", "饮食打卡", "体重趋势分析", "21 天习惯计划"],
    articles: [
      { id: "wyq-1", title: "减重不是挨饿，而是重建生活节律", summary: "从三餐结构、睡眠和活动量找到真正可持续的方法。", tag: "减重", readTime: "5 分钟" },
      { id: "wyq-2", title: "饮料里的糖，比你想象得更多", summary: "学会看营养成分表，识别常见的隐形糖。", tag: "饮食", readTime: "4 分钟" },
      { id: "wyq-3", title: "体重平台期，先检查这四件事", summary: "记录误差、睡眠不足、压力与运动适应都可能影响进度。", tag: "体重管理", readTime: "6 分钟" },
    ],
  }),
  profile({
    slug: "lin-jinfang", name: "林金芳", portrait: "/assets/doctors/portraits/lin-jinfang.jpg", portraitPosition: "50% 0%", portraitTransformOrigin: "50% 0%", hospital: "上海计生所医院", department: "妇科内分泌与不孕症",
    specialty: "女性生殖内分泌与全生命周期健康", accent: "#a55d78", accentSoft: "#fbf0f4", intro: "关注月经异常、多囊卵巢综合征、不孕与围绝经期健康，提供有温度的女性健康知识。",
    quickQuestions: ["月经不规律需要做哪些检查？", "多囊卵巢怎么长期管理？", "备孕多久没怀上需要就诊？", "围绝经期失眠潮热怎么办？"],
    topics: ["多囊卵巢", "月经管理", "科学备孕", "围绝经期"], services: ["月经周期记录", "备孕评估清单", "检查报告解读", "围绝经期管理"],
    articles: [
      { id: "ljf-1", title: "多囊卵巢综合征，管理目标不只是一张化验单", summary: "月经、代谢、皮肤表现和生育需求需要一起考虑。", tag: "多囊", readTime: "6 分钟" },
      { id: "ljf-2", title: "月经推迟多久需要看医生？", summary: "排除妊娠后，了解常见原因和建议检查。", tag: "月经", readTime: "4 分钟" },
      { id: "ljf-3", title: "围绝经期不是只能‘熬过去’", summary: "睡眠、骨骼、情绪与心血管健康都值得主动管理。", tag: "更年期", readTime: "5 分钟" },
    ],
  }),
  profile({
    slug: "luo-jun", name: "罗君", portrait: "/assets/doctors/portraits/luo-jun-avatar.jpg", portraitPosition: "50% 44%", portraitScale: 1.08, hospital: "中国科学院大学附属肿瘤医院（浙江省肿瘤医院）", department: "介入治疗科",
    specialty: "肝胆肿瘤微创介入治疗", accent: "#496f70", accentSoft: "#edf4f4", intro: "围绕肝胆系统恶性肿瘤的血管介入、消融与粒子治疗，帮助患者理解流程与术后管理。",
    quickQuestions: ["什么情况适合肿瘤介入治疗？", "消融治疗前要做哪些检查？", "介入术后发热正常吗？", "术后多久复查影像？"],
    topics: ["肝癌介入", "肿瘤消融", "粒子植入", "术后随访"], services: ["介入治疗知识评估", "术前准备清单", "术后症状记录", "影像复查提醒"],
    articles: [
      { id: "lj-1", title: "肿瘤介入治疗到底‘介入’在哪里？", summary: "用通俗语言理解血管介入和非血管介入的区别。", tag: "介入科普", readTime: "5 分钟" },
      { id: "lj-2", title: "肝癌消融治疗前后注意事项", summary: "检查、禁食、疼痛和复查安排的实用清单。", tag: "消融", readTime: "6 分钟" },
      { id: "lj-3", title: "介入术后发热，哪些情况要联系医生", summary: "区分常见术后反应与需要及时处理的危险信号。", tag: "术后", readTime: "4 分钟" },
    ],
  }),
  profile({
    slug: "yu-weihua", name: "于卫华", portrait: "/assets/doctors/portraits/yu-weihua.jpg", portraitPosition: "50% 0%", hospital: "浙江大学医学院附属邵逸夫医院", department: "普外科",
    specialty: "胃肠肝胆疾病与减重代谢微创外科", accent: "#3c7792", accentSoft: "#edf5f8", intro: "聚焦胃肠肿瘤、胆石症、肝胆胰疾病及减重代谢手术，提供围手术期健康管理支持。",
    quickQuestions: ["胆囊结石一定要手术吗？", "胃肠手术后怎么恢复饮食？", "减重手术适合哪些人？", "腹腔镜术后多久能运动？"],
    topics: ["胃肠肿瘤", "胆囊结石", "微创手术", "减重代谢"], services: ["手术适应证知识评估", "术前准备清单", "术后饮食计划", "康复进度记录"],
    articles: [
      { id: "ywh-1", title: "胆囊结石不痛，也需要处理吗？", summary: "结合症状、结石特点和并发症风险理解处理原则。", tag: "胆石症", readTime: "5 分钟" },
      { id: "ywh-2", title: "腹腔镜手术后，怎样循序恢复活动", summary: "从下床到运动，按阶段安排康复节奏。", tag: "术后康复", readTime: "4 分钟" },
      { id: "ywh-3", title: "减重代谢手术不是‘一切了之’", summary: "术后营养补充、饮食重建和长期随访同样关键。", tag: "减重外科", readTime: "6 分钟" },
    ],
  }),
  profile({
    slug: "zhou-yong", name: "周勇", portrait: "/assets/doctors/portraits/zhou-yong.jpg", portraitPosition: "50% 0%", hospital: "浙江大学医学院附属邵逸夫医院", department: "呼吸与危重症医学科",
    specialty: "慢阻肺、哮喘与肺部疾病管理", accent: "#467b78", accentSoft: "#edf5f4", intro: "服务慢性咳嗽、慢阻肺、哮喘、睡眠呼吸与肺结节人群，重视呼吸康复和戒烟支持。",
    quickQuestions: ["咳嗽超过多久需要就诊？", "哮喘吸入药怎么正确使用？", "肺结节多久复查一次？", "慢阻肺怎样做呼吸训练？"],
    topics: ["慢性咳嗽", "哮喘", "慢阻肺", "肺结节"], services: ["呼吸症状评估", "吸入装置指导", "戒烟计划", "肺结节随访提醒"],
    articles: [
      { id: "zy-1", title: "咳嗽超过八周，可能不只是感冒", summary: "了解慢性咳嗽的常见原因和就诊准备。", tag: "慢性咳嗽", readTime: "5 分钟" },
      { id: "zy-2", title: "吸入药有效的前提是动作做对", summary: "常见吸入装置的关键步骤与容易忽略的细节。", tag: "哮喘", readTime: "4 分钟" },
      { id: "zy-3", title: "体检发现肺结节，先别慌", summary: "大小、形态和变化趋势比单次结果更重要。", tag: "肺结节", readTime: "6 分钟" },
    ],
  }),
  profile({
    slug: "yu-wen", name: "喻雯", portrait: "/assets/doctors/portraits/yu-wen-user-web.jpg", portraitPosition: "50% 50%", hospital: "浙江省人民医院", department: "精神卫生科",
    specialty: "睡眠、情绪与认知健康", accent: "#756aa3", accentSoft: "#f2f0f8", intro: "围绕睡眠障碍、焦虑抑郁、认知变化与更年期情绪困扰，提供温和、尊重隐私的心理健康支持。",
    quickQuestions: ["失眠多久需要专业帮助？", "焦虑发作时怎么让自己平静？", "如何区分情绪低落和抑郁？", "家人记忆力下降怎么评估？"],
    topics: ["睡眠障碍", "焦虑抑郁", "认知健康", "压力管理"], services: ["睡眠日记", "情绪自评", "压力调节练习", "就诊资料准备"],
    articles: [
      { id: "yw-1", title: "睡不着时，越努力入睡可能越清醒", summary: "建立稳定睡眠驱动力，减少对失眠的过度关注。", tag: "睡眠", readTime: "5 分钟" },
      { id: "yw-2", title: "焦虑发作时可以做的三分钟练习", summary: "通过呼吸、感官定位和自我对话恢复当下感。", tag: "焦虑", readTime: "3 分钟" },
      { id: "yw-3", title: "记忆力下降，什么时候需要评估", summary: "观察对日常生活的影响，并记录变化的时间线。", tag: "认知", readTime: "5 分钟" },
    ],
  }),
  profile({
    slug: "tang-jinsong", name: "唐劲松", portrait: "/assets/doctors/portraits/tang-jinsong.png", portraitPosition: "50% 44%", hospital: "浙江大学医学院附属邵逸夫医院", department: "精神科",
    title: "主任医师 · 博士生导师", specialty: "精神心理健康、睡眠障碍与早期干预", accent: "#2f8f65", accentSoft: "#eaf6ef",
    intro: "围绕睡眠、焦虑抑郁、精神心理早期识别与家庭支持，提供清晰、尊重隐私的健康科普，并支持便捷的语音交流。",
    quickQuestions: ["长期失眠需要关注哪些信号？", "焦虑和普通紧张有什么不同？", "家人情绪低落时怎样沟通？", "第一次精神科就诊要准备什么？"],
    topics: ["睡眠障碍", "焦虑抑郁", "早期识别", "家庭支持"], services: ["睡眠与情绪记录", "心理状态科普评估", "就诊资料准备", "语音健康问答"],
    articles: [
      { id: "tjs-1", title: "睡眠问题持续多久，建议寻求专业帮助？", summary: "从持续时间、白天功能和伴随情绪变化理解求助时机。", tag: "睡眠", readTime: "5 分钟" },
      { id: "tjs-2", title: "焦虑不只是“想太多”", summary: "认识情绪、身体反应与回避行为之间的关系。", tag: "焦虑", readTime: "5 分钟" },
      { id: "tjs-3", title: "陪伴情绪低落的家人，可以从倾听开始", summary: "减少指责和说教，识别需要及时求助的危险信号。", tag: "家庭支持", readTime: "6 分钟" },
    ],
  }),
];

export const findDoctor = (slug?: string) => doctorProfiles.find((item) => item.slug === slug);
