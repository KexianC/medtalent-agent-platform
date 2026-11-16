import { normalizeDoctorConfig, type DoctorConfig } from "../lib/doctorConfig.ts";
import { tangJinsong } from "./tang-jinsong.config.ts";
import { chenZhiling } from "./chen-zhiling.config.ts";
import { yuWen } from "./yu-wen.config.ts";
import { fuJunfen } from "./fu-junfen.config.ts";

// 模块加载时校验全部配置；任何错误立即抛出，不静默退回默认。
const configs = new Map([tangJinsong, chenZhiling, yuWen, fuJunfen].map(config => {
  const normalized = normalizeDoctorConfig(config);
  return [normalized.slug, normalized];
}));
export const getDoctorConfig = (slug: string): DoctorConfig | undefined => configs.get(slug);
/** 后台搭建器 v1 保持优先；未配置医生继续使用现有通用行为。 */
export const configForDoctor = (doctor: { slug: string; builder?: unknown }) => doctor.builder ? undefined : getDoctorConfig(doctor.slug);
export function doctorModule<Id extends DoctorConfig["modules"][number]["id"]>(doctor: { slug: string; builder?: unknown }, id: Id) {
  return configForDoctor(doctor)?.modules.find((module): module is Extract<DoctorConfig["modules"][number], { id: Id }> => module.id === id);
}
