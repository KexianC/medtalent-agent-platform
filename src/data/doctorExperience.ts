export type JourneyIconKey =
  | "ruler"
  | "bone"
  | "sparkle"
  | "ear"
  | "wave"
  | "leaf"
  | "pulse"
  | "drop"
  | "heart"
  | "fork"
  | "run"
  | "moon"
  | "flower"
  | "calendar"
  | "firstAid"
  | "needle"
  | "clipboard"
  | "thermometer"
  | "stethoscope"
  | "brain";

export type JourneyStep = {
  icon: JourneyIconKey;
  title: string;
  description: string;
};

export type DoctorExperience = {
  tagline: string;
  eyebrow: string;
  heroIcon: JourneyIconKey;
  primaryTitle: string;
  primarySubtitle: string;
  cta: string;
  metric: {
    label: string;
    value: string;
    note: string;
    progress: number;
  };
  steps: JourneyStep[];
  concerns: { icon: JourneyIconKey; title: string; description: string }[];
  reminder: string;
  theme: {
    accent: string;
    accentStrong: string;
    accentRgb: string;
    surface: string;
    canvas: string;
    ink: string;
  };
};

export const doctorExperiences: Record<string, DoctorExperience> = {
  "fu-junfen": {
    tagline: "控糖日常 · 关注成长",
    eyebrow: "PEDIATRIC DIABETES CARE",
    heroIcon: "drop",
    primaryTitle: "儿童糖尿病管理评估",
    primarySubtitle: "围绕血糖、胰岛素、饮食运动与低血糖风险，梳理日常管理，并同步关注生长发育。",
    cta: "开始糖尿病管理评估",
    metric: { label: "近 7 日血糖记录完成度", value: "5 / 7 天", note: "记录用于复诊沟通，请勿自行调整用药或胰岛素", progress: 71 },
    steps: [
      { icon: "drop", title: "血糖与症状", description: "整理监测时段、数值与身体感受" },
      { icon: "needle", title: "胰岛素与用药", description: "按医嘱记录剂量、时间与漏用情况" },
      { icon: "ruler", title: "饮食运动与成长", description: "补充三餐、活动及身高体重变化" },
    ],
    concerns: [
      { icon: "drop", title: "孩子血糖偏高或偏低时，家长先记录什么？", description: "梳理数值、症状、进食、运动与用药等关键信息" },
      { icon: "run", title: "上学和运动日，怎样预防低血糖？", description: "了解随身准备、监测和及时求助的基本要点" },
    ],
    reminder: "本周糖尿病管理记录已完成 5 天，可继续记录血糖、胰岛素、饮食运动与不适症状。",
    theme: { accent: "#4E988F", accentStrong: "#236F68", accentRgb: "78, 152, 143", surface: "#EAF5EF", canvas: "#F7F3EA", ink: "#143C38" },
  },
  "chen-zhiling": {
    tagline: "畅快呼吸 · 清晰聆听",
    eyebrow: "ENT CARE JOURNEY",
    heroIcon: "ear",
    primaryTitle: "耳鼻喉症状评估",
    primarySubtitle: "把部位、持续时间与影响记录清楚，让就诊沟通更高效。",
    cta: "开始症状评估",
    metric: { label: "近 7 天症状天数", value: "3 天", note: "连续记录有助于发现诱因与变化", progress: 43 },
    steps: [
      { icon: "ear", title: "症状部位", description: "区分耳、鼻、咽喉不适" },
      { icon: "calendar", title: "时间与诱因", description: "记录出现时段和环境线索" },
      { icon: "wave", title: "功能影响", description: "补充呼吸、睡眠与听力变化" },
    ],
    concerns: [
      { icon: "wave", title: "孩子鼻塞打鼾，需要关注什么？", description: "观察呼吸、睡眠与白天精神状态" },
      { icon: "ear", title: "突然耳鸣或听力下降，何时就医？", description: "识别不宜等待的听力变化信号" },
    ],
    reminder: "过敏季已开启，可提前整理近期鼻塞、喷嚏与用药记录。",
    theme: { accent: "#4E879C", accentStrong: "#2D667D", accentRgb: "78, 135, 156", surface: "#EAF3F6", canvas: "#F5F1EA", ink: "#173A46" },
  },
  "gong-wenbo": {
    tagline: "调好代谢 · 养成日常",
    eyebrow: "METABOLIC BALANCE",
    heroIcon: "leaf",
    primaryTitle: "代谢体质评估",
    primarySubtitle: "结合现代指标与日常体感，形成更容易坚持的调养线索。",
    cta: "开始代谢评估",
    metric: { label: "代谢习惯完成率", value: "72%", note: "本周饮水与作息记录较稳定", progress: 72 },
    steps: [
      { icon: "pulse", title: "代谢指标", description: "整理血糖、尿酸与体重趋势" },
      { icon: "fork", title: "饮食作息", description: "记录三餐、饮水与睡眠节律" },
      { icon: "leaf", title: "体质感受", description: "补充冷热、乏力与消化感受" },
    ],
    concerns: [
      { icon: "fork", title: "糖尿病饮食，怎样搭配更稳妥？", description: "从餐盘结构理解一日三餐的安排" },
      { icon: "drop", title: "尿酸偏高，日常需要注意什么？", description: "梳理饮水、饮食、体重与复查重点" },
    ],
    reminder: "本周代谢记录已完成 5 天，再坚持 2 天即可形成周报。",
    theme: { accent: "#9A7455", accentStrong: "#6F4C32", accentRgb: "154, 116, 85", surface: "#F4EDE3", canvas: "#F6F2E9", ink: "#433224" },
  },
  "chen-jinbiao": {
    tagline: "治疗路上 · 安心有序",
    eyebrow: "TREATMENT SUPPORT",
    heroIcon: "firstAid",
    primaryTitle: "治疗支持计划",
    primarySubtitle: "把治疗阶段、症状与随访资料放在一处，减少过程中的不确定。",
    cta: "创建支持计划",
    metric: { label: "症状记录完成度", value: "4 / 7", note: "完整记录有助于复诊时准确沟通", progress: 57 },
    steps: [
      { icon: "firstAid", title: "治疗阶段", description: "标记当前治疗节点与安排" },
      { icon: "heart", title: "症状与营养", description: "记录不适、体重与进食变化" },
      { icon: "clipboard", title: "随访资料", description: "汇总报告、用药与待问事项" },
    ],
    concerns: [
      { icon: "clipboard", title: "第一次治疗前，需要准备什么？", description: "用清单整理资料与生活用品" },
      { icon: "heart", title: "治疗期间体重下降，怎样应对？", description: "先识别营养风险与需要反馈的变化" },
    ],
    reminder: "下次复查前建议补齐本周症状与体重记录。",
    theme: { accent: "#777EA5", accentStrong: "#555D87", accentRgb: "119, 126, 165", surface: "#EEEFFA", canvas: "#F6F2ED", ink: "#30354E" },
  },
  "wu-yuqin": {
    tagline: "改变一点 · 健康多一点",
    eyebrow: "LIFESTYLE RESET",
    heroIcon: "run",
    primaryTitle: "生活方式评估",
    primarySubtitle: "从饮食、活动、睡眠与压力找到最值得先改变的一件小事。",
    cta: "开始生活方式评估",
    metric: { label: "健康习惯完成率", value: "78%", note: "本周活动目标已连续完成 4 天", progress: 78 },
    steps: [
      { icon: "fork", title: "饮食节律", description: "了解三餐结构与外食频率" },
      { icon: "run", title: "活动水平", description: "记录步数、久坐与运动习惯" },
      { icon: "moon", title: "睡眠压力", description: "关注睡眠时长与压力感受" },
    ],
    concerns: [
      { icon: "pulse", title: "减重进入平台期，先检查什么？", description: "从记录、睡眠和活动变化寻找原因" },
      { icon: "fork", title: "经常外食，怎样选择更合理？", description: "掌握点餐顺序与餐盘搭配方法" },
    ],
    reminder: "今天还差 12 分钟即可完成活动目标，量力而行即可。",
    theme: { accent: "#718F5A", accentStrong: "#4E7136", accentRgb: "113, 143, 90", surface: "#EEF4E9", canvas: "#F7F3E9", ink: "#314126" },
  },
  "lin-jinfang": {
    tagline: "理解周期 · 照顾每一程",
    eyebrow: "WOMEN'S HEALTH",
    heroIcon: "flower",
    primaryTitle: "女性周期健康评估",
    primarySubtitle: "温和记录周期与身体感受，看见不同生命阶段的真实需求。",
    cta: "开始周期评估",
    metric: { label: "近 6 个月周期规律度", value: "83%", note: "已记录 5 个完整周期", progress: 83 },
    steps: [
      { icon: "calendar", title: "周期记录", description: "补充日期、时长与规律变化" },
      { icon: "flower", title: "相关症状", description: "记录疼痛、潮热与情绪感受" },
      { icon: "heart", title: "健康需求", description: "选择备孕、调经或围绝经关注" },
    ],
    concerns: [
      { icon: "calendar", title: "月经不规律，就诊前如何记录？", description: "整理周期日期、症状与既往检查" },
      { icon: "moon", title: "围绝经期潮热失眠，怎样管理？", description: "了解可以主动改善的生活环节" },
    ],
    reminder: "下一次周期记录预计在 6 天后，可提前开启提醒。",
    theme: { accent: "#B26E88", accentStrong: "#8B4F68", accentRgb: "178, 110, 136", surface: "#F8EDF1", canvas: "#F8F2ED", ink: "#533241" },
  },
  "luo-jun": {
    tagline: "介入有序 · 康复安心",
    eyebrow: "INTERVENTION CARE",
    heroIcon: "needle",
    primaryTitle: "介入治疗准备",
    primarySubtitle: "按步骤核对资料、术前准备与术后观察，让重要事项不遗漏。",
    cta: "生成准备清单",
    metric: { label: "准备事项完成度", value: "6 / 8", note: "还需补充近期影像与用药信息", progress: 75 },
    steps: [
      { icon: "clipboard", title: "资料核对", description: "整理影像、检验与用药信息" },
      { icon: "needle", title: "术前准备", description: "确认禁食、陪护与到院安排" },
      { icon: "thermometer", title: "术后观察", description: "记录体温、疼痛与穿刺点情况" },
    ],
    concerns: [
      { icon: "needle", title: "什么情况下会考虑介入治疗？", description: "了解常见方式与评估所需资料" },
      { icon: "thermometer", title: "术后发热，何时需要联系医生？", description: "区分常见反应与需要反馈的信号" },
    ],
    reminder: "准备清单还有 2 项未完成，建议术前一天再次核对。",
    theme: { accent: "#527E7B", accentStrong: "#325F5D", accentRgb: "82, 126, 123", surface: "#EAF3F1", canvas: "#F5F2EB", ink: "#25413F" },
  },
  "yu-weihua": {
    tagline: "围手术期 · 每一步有准备",
    eyebrow: "SURGERY RECOVERY",
    heroIcon: "stethoscope",
    primaryTitle: "围手术期康复计划",
    primarySubtitle: "从术前准备到饮食与活动恢复，按阶段看清接下来的一步。",
    cta: "制定康复计划",
    metric: { label: "康复任务完成率", value: "68%", note: "今日活动与饮食记录待补充", progress: 68 },
    steps: [
      { icon: "clipboard", title: "术前准备", description: "核对检查、用药与入院资料" },
      { icon: "fork", title: "饮食恢复", description: "按阶段记录耐受与进食量" },
      { icon: "run", title: "活动进阶", description: "循序增加下床与日常活动" },
    ],
    concerns: [
      { icon: "firstAid", title: "胆囊结石没有疼痛，也要处理吗？", description: "结合症状与风险理解处理原则" },
      { icon: "run", title: "腹腔镜术后，多久可以活动？", description: "了解不同阶段的安全活动边界" },
    ],
    reminder: "康复计划已进入第 3 阶段，请按身体耐受调整活动量。",
    theme: { accent: "#4C829C", accentStrong: "#2E627C", accentRgb: "76, 130, 156", surface: "#EAF3F7", canvas: "#F5F1EA", ink: "#203E4C" },
  },
  "zhou-yong": {
    tagline: "呼吸顺畅 · 生活更从容",
    eyebrow: "BREATHE BETTER",
    heroIcon: "wave",
    primaryTitle: "呼吸健康评估",
    primarySubtitle: "记录症状频率、用药与活动耐受，形成清晰的呼吸健康时间线。",
    cta: "开始呼吸评估",
    metric: { label: "近 7 天症状记录", value: "5 / 7", note: "夜间咳嗽较上周减少 1 天", progress: 71 },
    steps: [
      { icon: "wave", title: "症状频率", description: "记录咳嗽、气促与夜间不适" },
      { icon: "firstAid", title: "用药装置", description: "补充用药时间与吸入体验" },
      { icon: "run", title: "活动耐受", description: "观察步行与日常活动的变化" },
    ],
    concerns: [
      { icon: "wave", title: "咳嗽持续多久，需要就医？", description: "结合持续时间与伴随症状判断" },
      { icon: "firstAid", title: "吸入装置怎样使用更规范？", description: "掌握容易忽略的关键步骤" },
    ],
    reminder: "今日呼吸记录尚未完成，可用 30 秒标记症状与活动感受。",
    theme: { accent: "#4F8984", accentStrong: "#2F6662", accentRgb: "79, 137, 132", surface: "#EAF4F2", canvas: "#F5F2EA", ink: "#21433F" },
  },
  "yu-wen": {
    tagline: "安稳睡眠 · 温柔看见自己",
    eyebrow: "SLEEP & EMOTION",
    heroIcon: "moon",
    primaryTitle: "睡眠情绪评估",
    primarySubtitle: "在尊重隐私的前提下，记录睡眠节律、情绪感受与日常影响。",
    cta: "开始睡眠情绪评估",
    metric: { label: "平均入睡用时", value: "28 分", note: "比上周平均缩短 6 分钟", progress: 66 },
    steps: [
      { icon: "moon", title: "睡眠节律", description: "记录入睡、醒来与白天困倦" },
      { icon: "heart", title: "情绪感受", description: "温和标记焦虑、低落与压力" },
      { icon: "brain", title: "日常影响", description: "关注专注、工作与社交变化" },
    ],
    concerns: [
      { icon: "moon", title: "失眠持续多久，建议寻求帮助？", description: "从频率与日间影响理解求助时机" },
      { icon: "heart", title: "焦虑来临时，如何先稳定下来？", description: "跟随三分钟练习回到当下" },
    ],
    reminder: "今晚睡前可完成 1 分钟放松练习，避免追求“必须马上睡着”。",
    theme: { accent: "#7D72AD", accentStrong: "#5C528B", accentRgb: "125, 114, 173", surface: "#F0EDFA", canvas: "#F6F1EE", ink: "#38334E" },
  },
  "tang-jinsong": {
    tagline: "安心表达 · 专业倾听",
    eyebrow: "MENTAL HEALTH COMPANION",
    heroIcon: "brain",
    primaryTitle: "睡眠与情绪状态记录",
    primarySubtitle: "用简短记录梳理睡眠、情绪和日常功能变化，为进一步沟通准备更清晰的信息。",
    cta: "开始状态记录",
    metric: { label: "近 7 日记录完成度", value: "4 / 7 天", note: "记录仅用于健康科普与就医准备，不构成诊断", progress: 57 },
    steps: [
      { icon: "moon", title: "睡眠变化", description: "记录入睡、夜醒与白天精力" },
      { icon: "heart", title: "情绪感受", description: "标记焦虑、低落与压力程度" },
      { icon: "brain", title: "日常功能", description: "关注学习、工作与社交影响" },
    ],
    concerns: [
      { icon: "moon", title: "长期失眠，需要关注哪些信号？", description: "结合持续时间与白天影响判断" },
      { icon: "heart", title: "怎样陪伴情绪低落的家人？", description: "从倾听、支持与及时求助开始" },
    ],
    reminder: "今晚可以用 1 分钟记录入睡时间、夜醒次数和白天精力。",
    theme: { accent: "#3B9A70", accentStrong: "#246D50", accentRgb: "59, 154, 112", surface: "#E8F5EE", canvas: "#F3F7F2", ink: "#214437" },
  },
};

export const findDoctorExperience = (slug?: string) =>
  (slug && doctorExperiences[slug]) || doctorExperiences["fu-junfen"];
