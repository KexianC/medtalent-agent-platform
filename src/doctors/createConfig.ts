import { BLANK_DOCTOR_CONFIG, type DoctorConfig } from "../lib/doctorConfig.ts";
import type { DoctorProfile } from "../data/doctorProfiles.ts";
import type { DoctorCustom } from "../data/doctorCustomData.ts";

/** 只搬运现有资料；未有核对、知识库状态证据的字段沿用空白草稿默认。 */
export function createConfig(doctor: DoctorProfile, custom?: DoctorCustom): DoctorConfig {
  const base = structuredClone(BLANK_DOCTOR_CONFIG);
  const bio = custom?.bio;
  return { ...base, slug: doctor.slug,
    profile: { ...base.profile, name: doctor.name, hospital: doctor.hospital, department: doctor.department,
      displayDepartment: bio?.department || doctor.department, title: doctor.title, tags: bio?.tags || [],
      specialty: bio?.specialty || doctor.specialty, topics: bio?.topics || doctor.topics,
      portrait: doctor.portrait || "", portraitPosition: doctor.portraitPosition,
      ...(bio ? { career: bio.career, academic: bio.academic, achievements: bio.achievements,
        bookingDepartments: bio.bookingDepartments, clinics: bio.clinics } : {}),
      ...(custom?.introPhoto ? { introPhoto: custom.introPhoto } : {}), expertSections: custom?.expertSections || [] },
    theme: { accent: doctor.accent, accentSoft: doctor.accentSoft, homeStyle: custom?.unifiedTemplate ? "tang-home" : "standard" },
    home: { heroTitle: doctor.specialty, showNotice: true, showStartCard: Boolean(custom?.unifiedTemplate),
      resourcesCollapsed: Boolean(custom?.unifiedTemplate), showExpertNote: !custom?.unifiedTemplate,
      quickQuestions: doctor.quickQuestions.slice(0, 4), startHint: doctor.intro },
    chat: { title: custom?.unifiedTemplate ? "健康问答" : doctor.name,
      aiLabel: base.chat.aiLabel, showAiLabel: Boolean(custom?.unifiedTemplate),
      showTagline: !custom?.unifiedTemplate, replyFooter: Boolean(custom?.unifiedTemplate),
      citations: { enabled: true, hideWhenEmpty: Boolean(custom?.unifiedTemplate), style: "standard" },
      quickQuestions: doctor.quickQuestions, demoReplyWhenModelMissing: Boolean(custom?.unifiedTemplate) },
    modules: base.modules.map(module => ({ ...module, enabled: module.id === "wellness" ? false : module.id === "voice" ? Boolean(custom?.unifiedTemplate) : true,
      ...(module.id === "records" ? { variant: "standard" as const } : {}),
      ...(module.id === "voice" ? { autoPlay: "text-and-voice" as const, requirePlaybackOptIn: Boolean(custom?.unifiedTemplate), hint: custom?.unifiedTemplate ? "文字或语音提问后自动播放科普回复。" : "语音提问后自动播放科普回复。" } : {}) })),
    services: { groups: custom?.featureGroups || [], off: custom?.off || [], intro: custom?.servicesIntro,
      showPlanStatus: true, showBoundaryTagline: true },
    content: { articles: doctor.articles, videos: custom?.videos || [], ...(custom?.videoPlaceholders ? { videoPlaceholders: custom.videoPlaceholders } : {}) },
    knowledgeBase: { ...base.knowledgeBase, id: `kb-${doctor.slug}` },
  };
}
