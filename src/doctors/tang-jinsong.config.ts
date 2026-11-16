import type { DoctorConfig } from "../lib/doctorConfig.ts";
import { doctorProfiles } from "../data/doctorProfiles.ts";
import { doctorCustoms } from "../data/doctorCustomData.ts";
import { createConfig } from "./createConfig.ts";
const base = createConfig(doctorProfiles.find(doctor => doctor.slug === "tang-jinsong")!, doctorCustoms["tang-jinsong"]);
export const tangJinsong: DoctorConfig = {
  ...base,
  home: { ...base.home, knowledgeFocus: "精神心理、睡眠与早期干预科普", heroTitle: "一起梳理困扰，找到下一步", startHint: "聊聊最近的睡眠、情绪，或你正在经历的困扰。" },
  chat: { ...base.chat, demoReplyStyle: "mental", citations: { enabled: true, hideWhenEmpty: true, style: "tang" }, welcomeMessage: "你好，我先听你说。可以聊睡眠、情绪和日常状态；我会尽量用短话讲清楚，再给你一两个能做的建议。这里仅做科普，不能替代面诊。" },
  services: { ...base.services, preparation: ['整理睡眠、情绪和日常功能变化', '记录变化开始的时间及家人观察', '整理既往就诊、检查和当前用药信息'], showPlanStatus: false, showBoundaryTagline: false, assessmentPrompt: "我想了解最近的心理状态，请带我做一次非诊断性的自我观察。", shareHint: '这些内容默认不会发给 AI。点“带摘要咨询”后才放进问答输入框，你确认发送才会提交。' },
  records: { steps: ["记录时长、入睡耗时与夜醒", "记录情绪稳定度与焦虑程度", "记录白天精力与生活影响"],
    placeholder: "例如：入睡约 30 分钟、夜醒 2 次，焦虑 6/10，白天工作效率下降",
    privacyHint: "将对话与心理自评保存在当前设备；关闭时清除本机副本。",
    askWithRecords: { label: "带近期记录咨询", prompt: "请结合我最近的睡眠、情绪和日常状态记录，帮我看看最值得先调整的一点。", share: "summary" } },
  modules: [...base.modules.map(module => module.id === "records" ? { ...module, variant: "sleep-mood-function" as const } : module),
    { id: "diaryAdvice", enabled: true, order: 8 }, { id: "visitSummary", enabled: true, order: 9, days: 30, numbersOnly: true }],
};
