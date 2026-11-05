import { CaretRightIcon, ClockCountdownIcon, InfoIcon } from "@phosphor-icons/react";
import { useState } from "react";
import type { DoctorBio, DoctorCustom } from "../services/doctorCustom";
import "./tang-doctor-bio.css";

export function ClinicTimes({ times }: { times: string[] }) {
  return <dl className="tang-clinic-times">{times.map(time => {
    const split = time.indexOf(" ");
    return <div key={time}><dt>{split < 0 ? time : time.slice(0, split)}</dt><dd>{split < 0 ? "" : time.slice(split + 1)}</dd></div>;
  })}</dl>;
}

const tabs = ["专业擅长", "门诊时间", "成就"] as const;

// Name and hospital stay in the hero above, so this card only holds what the hero doesn't say.
export function TangDoctorCard({ bio, onTopic, onAll }: { bio: DoctorBio; onTopic: (topic: string) => void; onAll: () => void }) {
  const [active, setActive] = useState<typeof tabs[number]>("专业擅长");
  return <section className="tang-card" aria-label="认识医生">
    <header><h2>认识医生</h2><button type="button" onClick={onAll}>全部介绍<CaretRightIcon size={14} /></button></header>
    <div className="tang-card-tabs" role="tablist" aria-label="医生介绍分类">
      {tabs.filter(tab => tab !== "成就" || bio.achievements.length > 0).map(tab => <button key={tab} type="button" role="tab" aria-selected={tab === active} className={tab === active ? "is-active" : ""} onClick={() => setActive(tab)}>{tab}</button>)}
    </div>
    <div className="tang-card-panel" role="tabpanel" aria-label={active}>
      {active === "专业擅长" && <><p>{bio.specialty}</p><div className="tang-card-topics">{bio.topics.map(topic => <button key={topic} type="button" onClick={() => onTopic(topic)}>{topic}<CaretRightIcon size={12} /></button>)}</div><small>选择您想咨询的方向，开始对话，了解相关健康知识</small></>}
      {active === "门诊时间" && bio.clinics.filter(clinic => clinic.times.length).map(clinic => <div className="tang-card-clinic" key={clinic.campus}><b>{clinic.campus}</b><ClinicTimes times={clinic.times} /></div>)}
      {active === "门诊时间" && <small>实际号源以医院挂号页面为准</small>}
      {active === "成就" && <ul>{bio.achievements.map(item => <li key={item}>{item}</li>)}</ul>}
    </div>
  </section>;
}

// Full text behind "全部介绍": plain headed sections, closed with the confirm button.
export default function TangDoctorBio({ bio, pendingSections, onClose }: { bio: DoctorBio; pendingSections: DoctorCustom["expertSections"]; onClose: () => void }) {
  return <div className="tang-bio">
    <section><h3>专业擅长</h3><p>{bio.specialty}</p></section>
    <section><h3>{bio.academic.length ? "执业经历与学术任职" : "执业经历"}</h3><p>{bio.career}</p>{bio.academic.length > 0 && <ul>{bio.academic.map(item => <li key={item}>{item}</li>)}</ul>}</section>
    {bio.achievements.length > 0 && <section><h3>成就</h3><ul>{bio.achievements.map(item => <li key={item}>{item}</li>)}</ul></section>}
    <section><h3>门诊时间</h3>{bio.clinics.filter(clinic => clinic.times.length).map(clinic => <div className="tang-card-clinic" key={clinic.campus}><b>{clinic.campus}</b><ClinicTimes times={clinic.times} /></div>)}<p className="tang-bio-hint">实际号源以医院挂号页面为准</p></section>
    {pendingSections.map(section => <section key={section.title} className="is-empty"><h3>{section.title}</h3><p><ClockCountdownIcon size={14} />{section.body}</p></section>)}
    <footer><InfoIcon size={14} />信息仅用于健康科普与就医准备，不替代医生诊断。</footer>
    <button type="button" className="tang-bio-confirm" onClick={onClose}>确定</button>
  </div>;
}
