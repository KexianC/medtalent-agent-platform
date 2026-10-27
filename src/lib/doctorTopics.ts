export const doctorTopics = [
  { key: "child", label: "儿童健康", pattern: /儿童|儿科|小儿|婴幼儿|新生儿|生长发育/ },
  { key: "endocrine", label: "内分泌", pattern: /内分泌|糖尿病|血糖|甲状腺|代谢|肥胖|体重管理|减重/ },
  { key: "ent", label: "耳鼻喉", pattern: /耳鼻喉|耳鼻咽喉|鼻炎|鼻窦|听力|耳鸣|腺样体/ },
  { key: "respiratory", label: "呼吸健康", pattern: /呼吸|肺|哮喘|咳嗽/ },
  { key: "oncology", label: "肿瘤科普", pattern: /肿瘤|癌|放疗|化疗/ },
  { key: "digestive", label: "消化健康", pattern: /消化|胃|肠|肝胆|胆囊|肝癌|肝炎|肝硬化/ },
  { key: "women", label: "女性健康", pattern: /女性|妇科|妇产|生殖|月经|不孕|备孕|卵巢|围绝经/ },
  { key: "mental", label: "心理健康", pattern: /精神|心理|情绪|认知|焦虑|抑郁|失眠|睡眠障碍|压力管理/ },
] as const;

export type TopicKey = "all" | (typeof doctorTopics)[number]["key"];

type TopicProfile = {
  department: string;
  specialty: string;
  topics: readonly string[];
};

export function matchesDoctorTopic(doctor: TopicProfile, topicKey: TopicKey): boolean {
  if (topicKey === "all") return true;
  const topic = doctorTopics.find(({ key }) => key === topicKey);
  // Match published areas of focus; names, hospitals and promotional copy do not define a specialty.
  // A doctor may cover multiple topics, such as both children's health and endocrinology.
  return topic?.pattern.test([doctor.department, doctor.specialty, ...doctor.topics].join(" ")) ?? false;
}
