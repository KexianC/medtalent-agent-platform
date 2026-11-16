import type { DoctorConfig } from "../lib/doctorConfig.ts";
import { doctorProfiles } from "../data/doctorProfiles.ts";
import { doctorCustoms } from "../data/doctorCustomData.ts";
import { createConfig } from "./createConfig.ts";
const base = createConfig(doctorProfiles.find(doctor => doctor.slug === "yu-wen")!, doctorCustoms["yu-wen"]);
export const yuWen: DoctorConfig = {
  ...base,
  home: { ...base.home, knowledgeFocus: "睡眠、情绪与认知健康科普", showNotice: false },
  services: { ...base.services, preparation: ['整理睡眠、情绪和日常状态记录', '记录变化出现的时间及生活影响', '整理既往就诊、检查和当前用药信息'] },
  records: { ...base.records, exportPrefix: base.slug },
  modules: base.modules.map(module => module.id === "wellness" ? { ...module, enabled: true } : module.id === "records" ? { ...module, variant: "legacy" } : module),
};
