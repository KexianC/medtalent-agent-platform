export interface ServiceItem {
  slug: string;
  title: string;
  desc: string;
  highlights: string[];
  ctaLabel: string;
  ctaUrl: string;
}

export const serviceCatalog: ServiceItem[] = [
  {
    slug: "green-channel",
    title: "绿通招募",
    desc: "全国三甲医院就医绿色通道，协助加速挂号、检查、住院等关键节点。",
    highlights: ["重点科室优先协调", "就医流程指引", "检查预约协助", "专属顾问跟进"],
    ctaLabel: "立即咨询",
    ctaUrl: "/ad/dietitian",
  },
  {
    slug: "health-package",
    title: "健康套餐",
    desc: "定制化全生命周期体检与专项筛查组合，适配不同年龄段与风险人群。",
    highlights: ["体检套餐推荐", "专项筛查组合", "报告解读支持", "复查提醒计划"],
    ctaLabel: "查看套餐",
    ctaUrl: "/ad/dietitian",
  },
  {
    slug: "product-share",
    title: "产品分享",
    desc: "互联网医院与平台严选，家庭健康管理常用产品推荐。",
    highlights: ["家用检测设备", "健康日常用品", "使用方法科普", "选购建议"],
    ctaLabel: "进入选购",
    ctaUrl: "/ad/dietitian",
  },
  {
    slug: "doctor-online",
    title: "名医在线",
    desc: "线上复诊与图文问诊，帮助你快速获得专业建议与复诊规划。",
    highlights: ["图文问诊", "复诊建议", "用药咨询", "检查解读"],
    ctaLabel: "立即问诊",
    ctaUrl: "/ad/dietitian",
  },
];

export function getServiceBySlug(slug: string) {
  return serviceCatalog.find((s) => s.slug === slug);
}

