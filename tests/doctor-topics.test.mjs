import test from "node:test";
import assert from "node:assert/strict";
import { matchesDoctorTopic } from "../src/lib/doctorTopics.ts";

const profile = (department, specialty = "", topics = []) => ({ department, specialty, topics });

test("adult endocrine and metabolic agents are not classified as children's health", () => {
  for (const doctor of [profile("内分泌科", "糖尿病与甲状腺健康"), profile("内科", "体重管理与代谢健康")]) {
    assert.equal(matchesDoctorTopic(doctor, "child"), false);
    assert.equal(matchesDoctorTopic(doctor, "endocrine"), true);
  }
});

test("published areas of focus allow genuine overlap without merging child and endocrine categories", () => {
  const childEndocrine = profile("儿童内分泌科", "儿童糖尿病与生长发育管理");
  assert.equal(matchesDoctorTopic(childEndocrine, "child"), true);
  assert.equal(matchesDoctorTopic(childEndocrine, "endocrine"), true);
  const childEnt = profile("耳鼻咽喉科", "", ["儿童鼻炎", "鼻窦炎"]);
  assert.equal(matchesDoctorTopic(childEnt, "child"), true);
  assert.equal(matchesDoctorTopic(childEnt, "ent"), true);
  assert.equal(matchesDoctorTopic(childEnt, "endocrine"), false);
});

test("ear nose throat and respiratory filters select their own areas of focus", () => {
  const ent = profile("耳鼻咽喉科", "听力与鼻窦炎");
  const respiratory = profile("呼吸与危重症医学科", "慢阻肺、哮喘与肺部疾病管理");
  assert.equal(matchesDoctorTopic(ent, "ent"), true);
  assert.equal(matchesDoctorTopic(ent, "respiratory"), false);
  assert.equal(matchesDoctorTopic(respiratory, "respiratory"), true);
  assert.equal(matchesDoctorTopic(respiratory, "ent"), false);
});

test("rehabilitation, intervention and general surgery alone do not imply cancer or digestive topics", () => {
  assert.equal(matchesDoctorTopic(profile("康复科", "术后康复"), "oncology"), false);
  assert.equal(matchesDoctorTopic(profile("介入科", "肝胆疾病"), "oncology"), false);
  assert.equal(matchesDoctorTopic(profile("外科", "关节健康"), "digestive"), false);
  const digestiveCancer = profile("介入科", "肝胆肿瘤微创介入治疗");
  assert.equal(matchesDoctorTopic(digestiveCancer, "oncology"), true);
  assert.equal(matchesDoctorTopic(digestiveCancer, "digestive"), true);
});

test("new directory profiles are classified by public metadata rather than known slugs or names", () => {
  assert.equal(matchesDoctorTopic({ ...profile("", "", ["月经管理"]), slug: "new-profile" }, "women"), true);
  assert.equal(matchesDoctorTopic({ ...profile("内科"), name: "儿童健康", hospital: "儿童医院" }, "child"), false);
  assert.equal(matchesDoctorTopic(profile("", "心理健康", ["失眠"]), "mental"), true);
  assert.equal(matchesDoctorTopic(profile("呼吸科", "睡眠呼吸暂停"), "mental"), false);
  assert.equal(matchesDoctorTopic(profile(""), "all"), true);
});
