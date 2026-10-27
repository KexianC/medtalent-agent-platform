export type NoticeCategory = "reminder" | "news";

export interface NoticeItem {
  id: string;
  category: NoticeCategory;
  title: string;
  summary?: string;
  contentMarkdown: string;
  publishedAt?: string;
}

export const noticeCatalog: NoticeItem[] = [
  {
    id: "reminder-cold",
    category: "reminder",
    title: "非医提醒：今晚降温",
    summary: "夜间气温将明显下降，请注意保暖。",
    publishedAt: "2026-04-15",
    contentMarkdown:
      "夜间气温将降至 **5°C**，请注意保暖。\n\n- 建议提前准备外套/围巾\n- 高血压患者需特别注意：低温可能引起血管收缩，导致血压波动\n\n> 这是一条生活提醒，不替代医疗建议。如出现胸闷、头痛明显等不适，请及时就医。",
  },
  {
    id: "reminder-meds",
    category: "reminder",
    title: "用药提醒：降压药",
    summary: "预计服药时间 18:30",
    publishedAt: "2026-04-15",
    contentMarkdown:
      "今天预计服药时间为 **18:30**。\n\n- 如果你经常忘记服药，建议设置固定闹钟\n- 若出现头晕、乏力、心慌等不适，请联系医生评估\n\n> 用药调整请遵医嘱。",
  },
  {
    id: "news-cardiovascular-guideline",
    category: "news",
    title: "心血管健康管理指南更新：家庭监测更重要",
    summary: "新版指南强调家庭血压监测与生活方式干预的协同作用。",
    publishedAt: "2026-04-14",
    contentMarkdown:
      "新版建议强调：\n\n1. 优先建立稳定的家庭监测习惯\n2. 复诊时提供连续记录而非单次测量\n3. 控盐、运动与体重管理依然是关键\n\n**建议**：如果你有长期血压波动，可以在互动页记录并咨询医生。",
  },
  {
    id: "news-indicators-triglycerides",
    category: "news",
    title: "了解你的体检指标：甘油三酯篇",
    summary: "甘油三酯与饮食、运动和代谢状态紧密相关。",
    publishedAt: "2026-04-12",
    contentMarkdown:
      "甘油三酯（TG）升高常见原因：\n\n- 精制碳水摄入偏多\n- 饮酒\n- 久坐缺乏运动\n\n**行动建议**：\n- 先从一周减少含糖饮料开始\n- 每天快走 20–30 分钟\n\n> 若 TG 明显升高或合并其他异常，建议就医评估。",
  },
];

export function getNoticeById(id: string) {
  return noticeCatalog.find((n) => n.id === id);
}

export function listNotices(category: NoticeCategory) {
  return noticeCatalog.filter((n) => n.category === category);
}

