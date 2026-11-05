// 每位医生的差异化内容只改这个文件；页面和流程统一。
// 模块位置固定：医生只用 off 关掉不要的功能，不能挪位置；要新增模块走定制开发。
export type DoctorVideo = { title: string; url: string; platform: string; keywords: string[] };
export type DoctorBio = {
  department: string;
  specialty: string;
  topics: string[];
  tags: string[];
  bookingDepartments: { campus: string; department: string }[];
  career: string;
  academic: string[];
  achievements: string[];
  clinics: { campus: string; times: string[]; image?: string }[];
};
export type DoctorCustom = {
  featureGroups: { title: string; items: string[] }[];
  off: string[];
  videos: DoctorVideo[];
  videoPlaceholders?: string[];
  servicesIntro?: string;
  introPhoto?: string;
  bio?: DoctorBio;
  expertSections: { title: string; body: string }[];
};

const common = { title: "常用功能", items: ["病友信息", "人工咨询", "科普宣教"] };
const pending = "待医生提供";

export const doctorCustoms: Record<string, DoctorCustom> = {
  "tang-jinsong": {
    servicesIntro: "了解怎么照顾自己，把就诊前的准备做好。",
    featureGroups: [
      { title: "心理健康支持", items: ["今日心境", "健康宣教", "家属照护"] },
      { title: "症状自评与记录", items: ["量表自评", "睡眠日记"] },
      { title: "院外健康管理", items: ["放松训练", "用药记录", "戒烟管理"] },
      { title: "门诊服务", items: ["就诊准备", "门诊指引", "留言咨询", "复诊开方", "更多服务"] },
    ],
    // 复诊开方先关（本人 11-02 定）；入口按医生定制。智能体不替代医生开处方。
    off: ["复诊开方"],
    // 只放医生本人账号或公司数字人的真实视频链接，没有就留空，页面不显示。
    // 本地 mp4 只用于本机演示，文件不进补丁；上线换成正式播放地址。
    videos: [{ title: "什么是精神分裂症", url: "/assets/doctors/videos/tang-01-schizophrenia.mp4", platform: "邵逸夫医院 唐劲松", keywords: ["精神分裂症"] }],
    videoPlaceholders: ["失眠时可以先做什么", "怎样陪伴情绪低落的家人"],
    introPhoto: "/assets/doctors/portraits/tang-jinsong-intro.jpeg",
    // 文字转录自本人 11-02 提供的医生简介图和挂号页截图，未经医生核对，上线前必须核对。
    bio: {
      department: "精神卫生科",
      specialty: "擅长处理各类精神科疾病和心理问题，尤其擅长精神分裂症、双相障碍、抑郁症、焦虑障碍、睡眠障碍、认知障碍和成瘾行为等的诊治和心理干预。",
      topics: ["睡眠障碍", "抑郁症", "焦虑障碍"],
      tags: ["博士生导师 · 研究员 · 主任医师", "精神卫生科副主任"],
      career: "毕业于中南大学湘雅医学院，先后获医学学士、硕士和博士学位，美国芝加哥大学联合培养博士研究生，美国加州大学洛杉矶博士后，美国国立精神卫生研究所、霍普金斯大学访问学者。2008年-2019年在中南大学湘雅二医院精神科工作，湖南省高层次医学人才“225”工程精神病学学科带头人。2019年入职浙江大学，聘为浙江大学“百人计划(临床医学)”研究员。入选中国精神医学杰出青年医师，浙江省高层次浙江省卫生创新人才。",
      academic: [
        "中华医学会精神医学分会精准医学研究协作组副组长",
        "中国神经科学学会学习记忆基础与临床分会委员",
        "中华医学会精神医学分会精神分裂症研究协作组委员",
        "浙江省预防医学会精神卫生专业委员会副主任委员",
        "中国药物滥用防治协会烟草依赖与戒烟分会副主任委员",
        "中国研究型医院学会神经再生与修复专业委员会神经影像与再生学组副组长",
        "Nature 集团 Scientific Reports 杂志编委",
        "Journal of Psychiatry and Brain Science 执行主编",
        "Frontiers in Psychiatry Associate Editor",
        "药物不良反应杂志编委",
        "中华精神科杂志编委",
      ],
      achievements: ["主持国家重点研发计划 1 项", "国家自然科学基金 5 项", "发表论文 80 余篇", "国家专利 2 项"],
      bookingDepartments: [
        { campus: "庆春院区", department: "精神卫生科（名医）" },
        { campus: "钱塘院区", department: "精神卫生科（名医）(钱塘)" },
        { campus: "钱塘院区", department: "精神卫生科(钱塘)" },
        { campus: "绍兴院区", department: "精神卫生科（名医）(绍兴)" },
      ],
      clinics: [
        { campus: "钱塘院区", times: ["专家门诊 周二上午", "名医门诊 周二下午"], image: "/assets/doctors/campuses/srrsh-qiantang.jpg" },
        { campus: "绍兴院区", times: ["名医门诊 周一、周四上午"], image: "/assets/doctors/campuses/srrsh-shaoxing.jpg" },
        { campus: "庆春院区", times: [], image: "/assets/doctors/campuses/srrsh-qingchun.jpg" },
      ],
    },
    expertSections: [{ title: "团队简介", body: pending }, { title: "获奖荣誉", body: pending }],
  },
  "chen-zhiling": {
    featureGroups: [
      common,
      { title: "耳鼻喉管理", items: ["耳鼻喉症状自查", "检查报告解读", "术后康复指导", "过敏季提醒"] },
      { title: "医疗服务", items: ["就诊准备", "预约挂号", "更多服务"] },
    ],
    off: [],
    videos: [],
    expertSections: [{ title: "团队简介", body: pending }, { title: "获奖荣誉", body: pending }],
  },
};

export const enabledGroups = (custom: DoctorCustom) => custom.featureGroups
  .map(group => ({ ...group, items: group.items.filter(item => !custom.off.includes(item)) }))
  .filter(group => group.items.length > 0);

export const noticeLines = [
  "本智能体围绕医生专业方向提供健康科普，回复由人工智能生成，并非医生本人回复，内容可能存在错误或遗漏。",
  "可用于了解健康知识、整理日常记录、准备就诊问题，不能替代面诊、诊断或处方。",
  "如需心理支持，可拨打全国统一心理援助热线 12356；如可能立即伤害自己或出现身体急症，请立即拨打 120 或前往急诊。",
];
