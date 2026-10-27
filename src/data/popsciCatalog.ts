export type PopSciType = "article" | "video";

export interface PopSciItemBase {
  id: string;
  type: PopSciType;
  title: string;
  summary: string;
  coverUrl: string;
  tags: string[];
  author?: string;
  publishedAt?: string;
  views?: number;
  likes?: number;
}

export interface PopSciArticle extends PopSciItemBase {
  type: "article";
  bodyMarkdown: string;
}

export interface PopSciVideo extends PopSciItemBase {
  type: "video";
  duration?: string;
  sourceUrl: string;
}

export type PopSciItem = PopSciArticle | PopSciVideo;

import {
  COVER_DIABETES,
  COVER_GOUT,
  COVER_WEIGHT,
  COVER_THYROID,
  COVER_PCOS,
} from "@/utils/imageUtils";

export const popsciCatalog: PopSciItem[] = [
  {
    id: "a-tcm-diabetes",
    type: "article",
    title: "经典中医如何看待糖尿病？从消渴论治谈三消辨证",
    summary: "中医将糖尿病归为消渴范畴，上消在肺、中消在胃、下消在肾，三位一体辨证论治。",
    coverUrl: COVER_DIABETES,
    tags: ["糖尿病", "消渴", "三消辨证", "中医经典"],
    author: "龚文波",
    publishedAt: "2026-04-15",
    views: 15200,
    likes: 486,
    bodyMarkdown:
      "糖尿病在中医经典中属**消渴**范畴。《黄帝内经》已有甘美多肥致消渴的论述，《金匮要略》专列消渴篇。\n\n## 三消辨证要点\n\n**上消——肺热津伤**\n- 主症：口渴多饮，咽干舌燥\n- 病机：燥热伤肺，津液不布\n- 治法：清热润肺，生津止渴\n\n**中消——胃热炽盛**\n- 主症：多食易饥，形体消瘦\n- 病机：胃火炽盛，腐熟太过\n- 治法：清胃泻火，养阴增液\n\n**下消——肾阴亏虚**\n- 主症：尿频量多，混浊如膏\n- 病机：肾阴亏损，固摄无权\n- 治法：滋阴固肾\n\n## 龚主任临证心得\n\n临床上三消往往兼夹出现，不可截然分开。**脉证结合**是辨证的关键——通过脉象把握病机的虚实寒热，远比单纯看血糖数值更能指导治疗方向。\n\n糖尿病绝非单纯降糖可治。**三分调七分治**，药物是调整的抓手，生活方式改变才是根本。",
  },
  {
    id: "a-tcm-gout",
    type: "article",
    title: "痛风反复发作？中医从湿热痹阻角度谈调理思路",
    summary: "痛风属痹证范畴，核心病机为湿热下注、痰瘀互结。从饮食起居到中药调理的完整方案。",
    coverUrl: COVER_GOUT,
    tags: ["痛风", "痹证", "湿热", "尿酸", "中医调理"],
    author: "龚文波",
    publishedAt: "2026-03-28",
    views: 11300,
    likes: 367,
    bodyMarkdown:
      "痛风发作时关节红、肿、热、痛，中医辨证属于**湿热痹阻**。但缓解期的调理更加关键——治未病才是根本。\n\n## 为什么反复发作？\n\n急性期过后关节不痛了，很多人就放松警惕。但内在的**湿热体质**并未改变：\n- 舌苔黄腻、脉滑数，是湿热内蕴的典型表现\n- 饮食不节、嗜酒厚味，湿热源源不断产生\n- 脾失健运，水湿不化，聚而成痰\n\n## 分期论治\n\n**急性发作期**：清热利湿、通络止痛为主，常用四妙散加减\n**缓解期**：健脾祛湿、化痰逐瘀为本，重在改变体质土壤\n\n## 日常生活调理\n\n1. **饮水**：每日2000ml以上，促进尿酸排泄\n2. **饮食**：严格限制高嘌呤食物，忌啤酒海鲜\n3. **运动**：适度有氧运动，避免剧烈运动（乳酸抑制尿酸排泄）\n4. **中药代茶**：玉米须、车前草、土茯苓等可辅助利湿降酸\n\n> 尿酸高不等于痛风，但持续高尿酸是肾损害和心血管事件的独立危险因素，应积极干预。",
  },
  {
    id: "a-tcm-weight-loss",
    type: "article",
    title: "中医减重：不节食不反弹的体质调理法",
    summary: "从脾虚湿盛、胃热湿阻到肝郁气滞，辨清体质才能找到减重的正确方向。",
    coverUrl: COVER_WEIGHT,
    tags: ["减重", "体质调理", "脾虚", "中医瘦身"],
    author: "龚文波",
    publishedAt: "2026-05-10",
    views: 21800,
    likes: 712,
    bodyMarkdown:
      "节食减肥的终点几乎都是**反弹**——因为只减了体重，没改变体质。龚主任以纯中医方法调理减重，**脉证结合、辨证论治**，从根源改善代谢功能。\n\n## 三种常见肥胖体质\n\n### 脾虚湿盛型\n- 特点：形体肥胖但肌肉松软，易疲劳，大便溏\n- 舌脉：舌淡胖有齿痕，脉濡缓\n- 治法：健脾益气，化湿利水\n\n### 胃热湿阻型\n- 特点：食欲亢进，口干喜冷饮，便秘\n- 舌脉：舌红苔黄腻，脉滑数\n- 治法：清胃泻火，化湿通腑\n\n### 肝郁气滞型\n- 特点：压力性进食，胸胁胀闷，月经不调\n- 舌脉：舌暗红苔薄，脉弦\n- 治法：疏肝理气，调和气血\n\n## 龚主任减重核心原则\n\n1. **一人一方**：脉证合参，量身定制\n2. **食养为先**：以药食同源食材为基础，不依赖极端节食\n3. **三分调七分治**：中药调整气机，生活方式重塑代谢\n\n减重的本质是**恢复人体正常的代谢节律**，而非简单少吃饭。",
  },
  {
    id: "v-tcm-thyroid",
    type: "video",
    title: "甲状腺结节的中医辨证思路与日常调护",
    summary: "从气滞痰凝血瘀三个环节，讲解甲状腺结节的成因、证型分类和药食调理方案。",
    coverUrl: COVER_THYROID,
    tags: ["甲状腺", "结节", "气滞痰凝", "情志调理"],
    publishedAt: "2026-05-05",
    duration: "06:30",
    views: 8700,
    likes: 245,
    sourceUrl: "https://agent.hzmwmt.com/",
  },
  {
    id: "v-tcm-pcos",
    type: "video",
    title: "多囊卵巢综合征：中医从肾虚痰瘀角度的调治思路",
    summary: "多囊的核心在肾虚为本、痰瘀为标，龚主任讲解补肾调周、化痰祛瘀的治疗要点。",
    coverUrl: COVER_PCOS,
    tags: ["多囊卵巢", "PCOS", "肾虚", "痰瘀", "调周法"],
    publishedAt: "2026-04-22",
    duration: "07:15",
    views: 9400,
    likes: 302,
    sourceUrl: "https://agent.hzmwmt.com/",
  },
];

export function getPopSciItem(type: PopSciType, id: string) {
  return popsciCatalog.find((item) => item.type === type && item.id === id);
}

export function listPopSci(type: PopSciType) {
  return popsciCatalog.filter((item) => item.type === type);
}
