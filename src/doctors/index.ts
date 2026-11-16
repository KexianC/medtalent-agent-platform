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
export type ConfigurableDoctor = { slug: string; builder?: unknown; doctorConfig?: DoctorConfig };
/** 后台 v2 优先，未填写时使用代码配置；未配置医生继续使用通用行为。 */
export const resolveDoctorConfig = (doctor: ConfigurableDoctor): DoctorConfig | undefined => doctor.doctorConfig ?? getDoctorConfig(doctor.slug);
/** 保留 v1 调用兼容性，页面统一使用 resolveDoctorConfig。 */
export const configForDoctor = (doctor: ConfigurableDoctor) => doctor.builder && !doctor.doctorConfig ? undefined : resolveDoctorConfig(doctor);
export function doctorModule<Id extends DoctorConfig["modules"][number]["id"]>(doctor: ConfigurableDoctor, id: Id) {
  return configForDoctor(doctor)?.modules.find((module): module is Extract<DoctorConfig["modules"][number], { id: Id }> => module.id === id);
}
