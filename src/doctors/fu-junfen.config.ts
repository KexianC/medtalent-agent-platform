import type { DoctorConfig } from "../lib/doctorConfig.ts";
import { doctorProfiles } from "../data/doctorProfiles.ts";
import { doctorCustoms } from "../data/doctorCustomData.ts";
import { createConfig } from "./createConfig.ts";
const base = createConfig(doctorProfiles.find(doctor => doctor.slug === "fu-junfen")!, doctorCustoms["fu-junfen"]);
export const fuJunfen: DoctorConfig = {
  ...base,
  home: { ...base.home, knowledgeFocus: "儿童糖尿病与生长发育科普" },
  theme: { ...base.theme, heroArtwork: "growth" },
  services: { ...base.services, preparation: ['整理带日期的血糖与生长记录', '记录校园、运动或生活中想沟通的问题', '整理已有检查与正在使用的药物信息'] },
  records: { ...base.records, specialty: { title: "儿童血糖与生长记录", description: "按实际测量记录血糖、身高和体重，便于回顾变化。", fieldKeys: ["fastingGlucose", "postMealGlucose", "heightCm", "weightKg"] } },
};
