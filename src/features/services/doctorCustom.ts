import { getDoctorConfig } from "../../doctors/index.ts";
import { doctorCustoms as originalCustoms, type DoctorCustom } from "../../data/doctorCustomData.ts";
export { noticeLines } from "../../data/doctorCustomData.ts";
export type { DoctorVideo, DoctorBio, DoctorMaterial, DoctorCustom } from "../../data/doctorCustomData.ts";

// 保留原有调用接口，差异化展示统一来自已校验的医生配置。
export const doctorCustoms: Record<string, DoctorCustom> = Object.fromEntries(Object.entries(originalCustoms).map(([slug, original]) => {
  const config = getDoctorConfig(slug)!;
  const { profile } = config;
  return [slug, { ...original, unifiedTemplate: config.theme.homeStyle === "tang-home",
    featureGroups: config.services.groups, off: config.services.off, servicesIntro: config.services.intro,
    videos: config.content.videos, videoPlaceholders: config.content.videoPlaceholders,
    introPhoto: profile.introPhoto, expertSections: profile.expertSections,
    bio: { department: profile.displayDepartment, specialty: profile.specialty, topics: profile.topics, tags: profile.tags,
      career: profile.career || "", academic: profile.academic || [], achievements: profile.achievements || [],
      bookingDepartments: profile.bookingDepartments, clinics: profile.clinics } }];
}));

export const enabledGroups = (custom: DoctorCustom) => custom.featureGroups
  .map(group => ({ ...group, items: group.items.filter(item => !custom.off.includes(item)) }))
  .filter(group => group.items.length > 0);
export const usesUnifiedTemplate = (doctor: { slug: string; builder?: unknown }) => !doctor.builder && getDoctorConfig(doctor.slug)?.theme.homeStyle === "tang-home";
