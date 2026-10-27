export type ContentType = "article" | "video" | "service" | "product";

export interface ContentItem {
  id: string;
  type: ContentType;
  title: string;
  summary: string;
  keywords: string[];
  coverUrl?: string;
  sourceUrl?: string;
}

export const contentCatalog: ContentItem[] = [
  {
    id: "a-hypertension-basics",
    type: "article",
    title: "高血压基础知识：如何理解收缩压/舒张压",
    summary: "用最通俗的方式解释血压指标含义、常见误区与日常管理要点。",
    keywords: ["高血压", "血压", "收缩压", "舒张压", "降压", "心血管"],
  },
  {
    id: "v-blood-lipids-explained",
    type: "video",
    title: "血脂四项怎么读：胆固醇、甘油三酯、HDL、LDL",
    summary: "快速看懂血脂报告的关键指标与风险提示。",
    keywords: ["血脂", "胆固醇", "甘油三酯", "LDL", "HDL", "动脉粥样硬化"],
  },
  {
    id: "a-liver-function-guide",
    type: "article",
    title: "肝功能指标解读：ALT/AST 升高意味着什么",
    summary: "了解转氨酶、胆红素等常见肝功能指标及复查建议。",
    keywords: ["肝功能", "ALT", "AST", "转氨酶", "胆红素", "脂肪肝"],
  },
  {
    id: "v-thyroid-nodules",
    type: "video",
    title: "结节=癌吗？甲状腺/肺结节随访要点",
    summary: "结节常见分级、复查周期与需要就医的信号。",
    keywords: ["结节", "甲状腺", "肺结节", "复查", "随访", "影像"],
  },
  {
    id: "s-hypertension-management",
    type: "service",
    title: "慢病管理服务包：高血压 28 天干预",
    summary: "包含用药提醒、饮食运动建议、指标追踪与复诊规划。",
    keywords: ["高血压", "慢病管理", "用药", "复诊", "饮食", "运动"],
  },
  {
    id: "p-home-bp-monitor",
    type: "product",
    title: "家用上臂式电子血压计：选购与使用指南",
    summary: "如何选型号、正确测量姿势、数据记录与误差来源。",
    keywords: ["血压计", "高血压", "家庭监测", "测量", "心血管"],
  },
];

export const defaultRecommendationIds: string[] = [
  "a-hypertension-basics",
  "v-blood-lipids-explained",
  "s-hypertension-management",
  "p-home-bp-monitor",
];

export function getContentById(id: string) {
  return contentCatalog.find((item) => item.id === id);
}

export function getRecommendations(input: string, limit = 2) {
  const normalized = input.toLowerCase();
  const scored = contentCatalog
    .map((item) => {
      const score = item.keywords.reduce((acc, kw) => {
        const k = kw.toLowerCase();
        return normalized.includes(k) ? acc + 1 : acc;
      }, 0);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked: ContentItem[] = [];
  for (const s of scored) {
    if (picked.length >= limit) break;
    if (s.score <= 0) continue;
    picked.push(s.item);
  }

  if (picked.length < limit) {
    for (const id of defaultRecommendationIds) {
      if (picked.length >= limit) break;
      const item = getContentById(id);
      if (!item) continue;
      if (picked.some((p) => p.id === item.id)) continue;
      picked.push(item);
    }
  }

  return picked.slice(0, limit);
}

