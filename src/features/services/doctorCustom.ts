import { resolveDoctorConfig, type ConfigurableDoctor } from "../../doctors/index.ts";
import { doctorCustoms as originalCustoms, type DoctorCustom } from "../../data/doctorCustomData.ts";
export { noticeLines } from "../../data/doctorCustomData.ts";
export type { DoctorVideo, DoctorBio, DoctorMaterial, DoctorCustom } from "../../data/doctorCustomData.ts";

// 保留原有调用接口，差异化展示统一来自已校验的医生配置。
export function getDoctorCustom(doctor: ConfigurableDoctor): DoctorCustom | undefined {
  const original = originalCustoms[doctor.slug];
  // 代码配置也覆盖通用医生；没有原定制内容时，不能凭空创建定制对象，
  // 否则空 services.groups 会替换通用服务，并多出专家介绍入口。
  if (!original && !doctor.doctorConfig) return undefined;
  const config = resolveDoctorConfig(doctor);
  if (!config) return original;
  const { profile } = config;
  return { ...original, unifiedTemplate: config.theme.homeStyle === "tang-home",
    featureGroups: config.services.groups, off: config.services.off, servicesIntro: config.services.intro,
    videos: config.content.videos, videoPlaceholders: config.content.videoPlaceholders,
    introPhoto: profile.introPhoto, expertSections: profile.expertSections,
    bio: { department: profile.displayDepartment, specialty: profile.specialty, topics: profile.topics, tags: profile.tags,
      career: profile.career || "", academic: profile.academic || [], achievements: profile.achievements || [],
      bookingDepartments: profile.bookingDepartments, clinics: profile.clinics } };
}
export const doctorCustoms: Record<string, DoctorCustom> = Object.fromEntries(Object.keys(originalCustoms).map(slug => [slug, getDoctorCustom({ slug })!]));

export const enabledGroups = (custom: DoctorCustom) => custom.featureGroups
  .map(group => ({ ...group, items: group.items.filter(item => !custom.off.includes(item)) }))
  .filter(group => group.items.length > 0);
export const usesUnifiedTemplate = (doctor: ConfigurableDoctor) => (!doctor.builder || !!doctor.doctorConfig) && resolveDoctorConfig(doctor)?.theme.homeStyle === "tang-home";
