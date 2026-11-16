import type { DoctorConfig } from "../lib/doctorConfig.ts";
import { doctorProfiles } from "../data/doctorProfiles.ts";
import { doctorCustoms } from "../data/doctorCustomData.ts";
import { createConfig } from "./createConfig.ts";
const base = createConfig(doctorProfiles.find(doctor => doctor.slug === "chen-zhiling")!, doctorCustoms["chen-zhiling"]);
export const chenZhiling: DoctorConfig = {
  ...base,
  home: { ...base.home, knowledgeFocus: "耳鼻喉症状记录与就诊准备" },
  chat: { ...base.chat, demoReplyStyle: "ent" },
  services: { ...base.services, preparation: ['整理鼻、耳或咽喉不适和眩晕发作的时间线', '记录接触环境、症状变化和日常影响', '整理已有检查资料和就诊问题清单'] },
  records: { ...base.records, specialty: { title: "耳鼻喉症状记录", description: "记录当天鼻塞、耳鸣、咽喉不适和眩晕的主观感受，便于就诊时回顾。可能的诱因可以写在备注里。", fieldKeys: ["nasalBlockageScore", "tinnitusScore", "throatDiscomfortScore", "vertigoAttackCount", "longestVertigoMinutes", "earFullnessScore"] }, accountHint: "登录后，对话、收藏、健康记录将保存在你的云端账户。你可在设置中关闭对话保存。", assessmentLabel: "自评记录" },
};
