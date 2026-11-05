import { CaretRightIcon, CheckIcon, MapPinIcon, PlayCircleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { localDateKey, useDoctorLocalState } from "../../hooks/useDoctorLocalState";
import { noticeLines, type DoctorBio, type DoctorVideo } from "../services/doctorCustom";
import { sources, type SourceKey } from "./sources";
import { useUiPrivacy } from "./useUiPrivacy";
import { normalizeTangResults, TANG_ASSESSMENT_SECTION, TANG_RESULT_SCALES, type TangAssessmentResult } from "../tang/guidanceModel";
import { buildMedicationLines, buildTangExtraLines, buildVisitSummary } from "../services/visitSummary.mjs";
import { ClinicTimes } from "./TangDoctorBio";
import { buildHealthTrend } from "../../lib/healthRecords";
import type { DoctorHealthRecord } from "../../hooks/useDoctorLocalState";
import "./tang-services.css";

export const MEDICATION_SECTION = "tang-medication-v1";
export const SMOKING_SECTION = "tang-smoking-v1";
export const RELAX_SECTION = "tang-relax-v1";
const EMERGENCY = "目前留言只保存在这台设备上，如遇紧急情况，请立即拨打 120 或前往急诊。";

// Demo data stays in this browser only; it never goes through the account sync.
export function useTangLocal<T>(section: string, fallback: T): [T, (next: T) => void] {
  const key = `medtalent:tang-demo:${section}`;
  const [value, setValue] = useState<T>(() => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } });
  const save = useCallback((next: T) => { setValue(next); try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 本次页面内仍然有效。 */ } }, [key]);
  return [value, save];
}

const SavedCheck = () => <CheckIcon className="tang-svc-saved-check" aria-hidden="true" weight="bold" />;
export function SourceNote({ keys }: { keys: SourceKey[] }) {
  return <details className="tang-source-note"><summary>查看依据</summary>
    <ul>{keys.flatMap(key => sources[key].items).map(source => <li key={`${source.institution}:${source.title}`}>{source.institution}《{source.title}》{source.year ? `，${source.year}` : ""}{source.url && <> · <a href={source.url} target="_blank" rel="noreferrer">链接</a></>}</li>)}</ul>
    {keys.map(key => sources[key].note && <p key={key}>{sources[key].note}</p>)}
    <p>以上为公开资料，用于健康科普，不是治疗方案。</p>
  </details>;
}

export function DoctorVideoItem({ video, iconSize, linkSuffix = "" }: { video: DoctorVideo; iconSize: number; linkSuffix?: string }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!video.url) return <div className="tang-media-placeholder"><PlayCircleIcon size={iconSize} aria-hidden="true" /><span><b>{video.title}</b><small>{video.platform} · 视频待上传</small></span></div>;
  if (!/\.mp4(\?|$)/i.test(video.url)) return <a href={video.url} target="_blank" rel="noreferrer"><PlayCircleIcon size={iconSize} weight={iconSize > 24 ? "fill" : "regular"} aria-hidden="true" /><span><b>{video.title}</b><small>{video.platform}{linkSuffix}</small></span></a>;
  return <>
    <button type="button" className="tang-video-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><PlayCircleIcon size={iconSize} weight={iconSize > 24 ? "fill" : "regular"} aria-hidden="true" /><span><b>{video.title}</b><small>{video.platform} · {open ? "收起视频" : "点击播放"}</small></span></button>
    {open && (failed ? <p className="tang-svc-note" role="alert">视频暂时无法播放，请稍后再试。</p> : <video className="tang-video-inline" controls autoPlay playsInline preload="metadata" src={video.url} aria-label={video.title} onError={() => setFailed(true)} />)}
  </>;
}

export function TangEducationPanel({ videos, children }: { videos: DoctorVideo[]; children: ReactNode }) {
  const [active, setActive] = useState("科普文章");
  const id = useId();
  const tabs = ["科普文章", "科普视频"];
  return <section className="tang-card tang-education">
    <div className="tang-card-tabs" role="tablist" aria-label="健康宣教分类">{tabs.map((tab, index) => <button key={tab} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={active === tab} aria-controls={`${id}-panel-${index}`} tabIndex={active === tab ? 0 : -1} className={active === tab ? "is-active" : ""} onClick={() => setActive(tab)} onKeyDown={event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
      setActive(tabs[next]);
      document.getElementById(`${id}-tab-${next}`)?.focus();
    }}>{tab}</button>)}</div>
    <div className="tang-card-panel" role="tabpanel" id={`${id}-panel-0`} aria-labelledby={`${id}-tab-0`} hidden={active !== "科普文章"}>{children}</div>
    <div className="tang-card-panel tang-education-videos" role="tabpanel" id={`${id}-panel-1`} aria-labelledby={`${id}-tab-1`} hidden={active !== "科普视频"}>{videos.length ? videos.map(video => <DoctorVideoItem video={video} iconSize={24} key={video.url} />) : <p>科普视频待医生提供</p>}</div>
  </section>;
}

export function TangVisitSummary({ records, questions }: { records: DoctorHealthRecord[]; questions: string }) {
  const [copied, setCopied] = useState(false);
  const [medication] = useTangLocal<MedicationEntry[]>(MEDICATION_SECTION, []);
  const [smoking] = useTangLocal<SmokingData>(SMOKING_SECTION, { days: {} });
  const [relaxDays] = useTangLocal<string[]>(RELAX_SECTION, []);
  const [privacy] = useUiPrivacy("tang-jinsong");
  const [assessments] = useDoctorLocalState<TangAssessmentResult[]>("tang-jinsong", TANG_ASSESSMENT_SECTION, [], privacy.saveChat);
  const today = localDateKey();
  const assessmentNumbers = privacy.saveChat ? normalizeTangResults(assessments).map(result => ({
    title: TANG_RESULT_SCALES.find(scale => scale.id === result.scaleId)!.title,
    score: result.score, maxScore: result.maxScore, date: localDateKey(new Date(result.createdAt)),
  })) : [];
  const summary = buildVisitSummary(records, { today, questions,
    extraLines: [...buildMedicationLines(medication, smoking, { today }), ...buildTangExtraLines(relaxDays, assessmentNumbers, { today })],
    extraTitle: "用药、戒烟、放松与量表（本人自填）：",
  });
  return <section className="tang-visit-summary" aria-label="复诊摘要">{summary ? <><TangVisitTrends records={records} />
    <pre>{summary}</pre><div><button type="button" onClick={async () => { try { await navigator.clipboard.writeText(summary); setCopied(true); } catch { setCopied(false); } }}>{copied ? "已复制" : "复制"}</button><button type="button" onClick={() => window.print()}>打印</button></div>
  </> : <><h3>复诊摘要</h3><p>还没有近 30 天的记录。填写睡眠日记、用药、戒烟或量表后，这里会自动整理成一页。</p></>}</section>;
}

export function TangVisitTrends({ records }: { records: DoctorHealthRecord[] }) {
  const trend = buildHealthTrend(records, 30);
  const metrics = [
    { key: "sleepDurationMinutes", label: "睡眠时长", max: 720, unit: "小时", format: (v: number) => (v / 60).toFixed(1) },
    { key: "moodScore", label: "情绪稳定度", max: 10, unit: "/ 10", format: (v: number) => v.toFixed(1) },
  ] as const;
  return <section className="tang-summary-trends" aria-label="近 30 天趋势">{metrics.map(metric => {
    const points = trend.flatMap((point, index) => {
      const value = point.metrics?.[metric.key];
      return typeof value === "number" && Number.isFinite(value) ? [{ date: point.dateKey, index, value }] : [];
    });
    const x = (index: number) => 34 + index / 29 * 252;
    const ceiling = Math.max(metric.max, ...points.map(point => point.value));
    const y = (value: number) => 104 - Math.max(0, value) / ceiling * 80;
    // Missing dates stay empty; each new run starts a separate line segment.
    const path = points.map((point, i) => `${i && points[i - 1].index === point.index - 1 ? "L" : "M"}${x(point.index)},${y(point.value)}`).join(" ");
    return <section className="journey-trend-card tang-summary-trend" key={metric.key}><h3>近 30 天{metric.label}</h3>{points.length < 2 ? <p>记录满 2 天后显示趋势</p> : <>
      <svg viewBox="0 0 310 140" role="img" aria-label={`近 30 天${metric.label}（${metric.unit}）：${points.map(p => `${p.date} ${metric.format(p.value)}`).join("；")}`}>
        <path className="tang-trend-axis" d="M34 24V104H286" fill="none" />
        <text x="28" y="28" textAnchor="end">{metric.format(ceiling)}</text><text x="28" y="108" textAnchor="end">0</text>
        <path className="tang-trend-line" d={path} fill="none" strokeWidth="2" />
        {points.map(point => <circle key={point.date} cx={x(point.index)} cy={y(point.value)} r="3"><title>{`${point.date}：${metric.format(point.value)} ${metric.unit}`}</title></circle>)}
        <text x="34" y="126">{trend[0]?.label}</text><text x="286" y="126" textAnchor="end">{trend[trend.length - 1]?.label}</text>
      </svg><p>{metric.unit}</p>
    </>}</section>;
  })}</section>;
}
const shiftDate = (dateKey: string, days: number) => { const date = new Date(`${dateKey}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); };

const BREATH_IN = 4;
const BREATH_OUT = 6;
const MUSCLE_STEPS = ["手和手臂：轻握拳，感受紧张，再松开。", "肩膀：轻轻耸肩，再让肩膀落下。", "面部：轻皱眉，再舒展眉眼和下巴。", "腹部：轻收腹，再松开，保持自然呼吸。", "腿和脚：先轻收紧大腿，再松开；随后轻蜷脚趾，再松开。"];

export function TangRelaxPanel() {
  const [days, setDays] = useTangLocal<string[]>(RELAX_SECTION, []);
  const [checkInFeedback, setCheckInFeedback] = useState(0);
  const [mode, setMode] = useState<"breath" | "muscle">("breath");
  const [minutes, setMinutes] = useState(1);
  const [left, setLeft] = useState(0);
  const timer = useRef<number>();
  const today = localDateKey();
  const running = left > 0;
  const checkIn = useCallback(() => { setDays(days.includes(today) ? days : [...days, today].slice(-365)); setCheckInFeedback(value => value + 1); }, [days, setDays, today]);
  useEffect(() => () => window.clearInterval(timer.current), []);
  useEffect(() => { if (left === 0 && timer.current !== undefined) { window.clearInterval(timer.current); timer.current = undefined; checkIn(); } }, [left, checkIn]);
  const start = () => { setLeft(minutes * 60); window.clearInterval(timer.current); timer.current = window.setInterval(() => setLeft(value => Math.max(0, value - 1)), 1000); };
  const stop = () => { window.clearInterval(timer.current); timer.current = undefined; setLeft(0); };
  const cycle = BREATH_IN + BREATH_OUT;
  const phase = (minutes * 60 - left) % cycle;
  const breathingIn = running && phase < BREATH_IN;
  const week = Array.from({ length: 7 }, (_, index) => shiftDate(today, index - 6));
  return <div className="tang-svc">
    <div className="tang-svc-actions" role="group" aria-label="放松方式"><button type="button" className="tang-svc-btn" aria-pressed={mode === "breath"} onClick={() => setMode("breath")}>呼吸放松</button><button type="button" className="tang-svc-btn" aria-pressed={mode === "muscle"} onClick={() => { stop(); setMode("muscle"); }}>肌肉放松</button>{checkInFeedback > 0 && <SavedCheck key={checkInFeedback} />}</div>
    {mode === "breath" ? <>
      <section className="tang-svc-box"><h3>为什么要呼吸放松</h3><p>人紧张时，呼吸容易变快、变浅。慢慢地呼吸，把注意力放在一呼一吸上，能帮身体慢下来，减轻紧张的感觉。吸 4 秒、呼 6 秒只是方便跟着练的节奏，不用追求分秒不差。练熟之后，紧张时随时可以用，睡前做也有助于放松入睡。它不能代替治疗；如果困扰持续或影响生活，建议到门诊当面评估。</p></section>
      <section className="tang-svc-box">
      <div className="tang-breath"><div className={`tang-breath-ring${breathingIn ? " is-in" : ""}`} style={{ transitionDuration: `${breathingIn ? BREATH_IN : BREATH_OUT}s` }} role="status">{running ? breathingIn ? "吸气" : "呼气" : "准备"}</div>{running && <small>还剩 {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</small>}</div>
      <div className="tang-svc-actions">{!running && [1, 3, 5].map(value => <button key={value} type="button" className="tang-svc-btn" aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value} 分钟</button>)}{running ? <button type="button" className="tang-svc-btn" onClick={stop}>结束（不打卡）</button> : <button type="button" className="tang-svc-btn is-primary" onClick={start}>开始</button>}</div>
      <p>坐稳，肩膀放松。轻轻吸气约 4 秒，再缓缓呼气约 6 秒。不憋气，跟不上时按舒服的节奏呼吸。完成后自动打卡。</p>
      <p className="tang-svc-note">如果头晕、发麻或更紧张，请停下来，恢复自然呼吸；休息后仍不舒服，请就医。如有胸痛、严重呼吸困难或昏厥，请立即拨打 120 或前往急诊。</p>
      <SourceNote keys={["breath"]} />
    </section></> : <>
      <section className="tang-svc-box"><h3>为什么要肌肉放松</h3><p>长期紧张时，肌肉会不自觉地绷紧，自己却不容易察觉。这个练习是一组一组地收紧再放松肌肉，帮你分辨紧张和放松的感觉。练熟之后，紧张时更容易让身体松下来，睡前做也有助于放松入睡。它不能代替治疗；如果困扰持续或影响生活，建议到门诊当面评估。</p></section>
      <section className="tang-svc-box"><h3>肌肉放松 · 简短体验</h3><p>轻轻绷紧约 5 秒，再松开约 10 秒，感受前后的不同。全程自然呼吸，不要憋气。疼痛或不适时立即停止；有伤患时先不要练习。</p>
        <ol>{MUSCLE_STEPS.map(step => <li key={step}>{step}</li>)}</ol>
        <section className="tang-svc-video"><h3>跟着视频练习</h3>
          <p className="tang-media-placeholder">视频待提供，先按上面的文字步骤练习。</p>
        </section>
        <div className="tang-svc-actions"><button type="button" className="tang-svc-btn is-primary" disabled={days.includes(today)} onClick={checkIn}>{days.includes(today) ? "今天已打卡" : "完成并打卡"}</button></div>
        <SourceNote keys={["pmr"]} />
      </section>
    </>}
    <section className="tang-svc-box"><div className="tang-svc-stat"><b>{days.length}</b><span>天累计练习</span></div><div className="tang-svc-week" aria-label="近 7 天打卡">{week.map(date => <span key={date}><i className={days.includes(date) ? "is-done" : ""} />{date.slice(8)}</span>)}</div></section>
  </div>;
}

type MedicationEntry = { date: string; status: string; note?: string };
const MEDICATION_OPTIONS = ["按时服用", "部分漏服", "未服用", "今天无需服药"];

export function TangMedicationPanel() {
  const [entries, setEntries] = useTangLocal<MedicationEntry[]>(MEDICATION_SECTION, []);
  const today = localDateKey();
  const existing = entries.find(entry => entry.date === today);
  const [status, setStatus] = useState(existing?.status || "");
  const [note, setNote] = useState(existing?.note || "");
  const [saved, setSaved] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(0);
  const save = () => { setEntries([{ date: today, status, ...(note.trim() ? { note: note.trim() } : {}) }, ...entries.filter(entry => entry.date !== today)].slice(0, 90)); setSaved(true); setSaveFeedback(value => value + 1); };
  return <div className="tang-svc">
    <p className="tang-svc-alert" role="note">本页只做记录。请勿自行加药、减药或停药，有疑问请问医生。如出现严重不适，请立即就医。</p>
    <section className="tang-svc-box"><h3>今天的用药情况</h3>
      <div className="tang-svc-actions" role="group" aria-label="今天的用药情况">{MEDICATION_OPTIONS.map(option => <button key={option} type="button" className="tang-svc-btn" aria-pressed={status === option} onClick={() => { setStatus(option); setSaved(false); }}>{option}</button>)}</div>
      <label style={{ display: "block", marginTop: 10 }}><span>不适或想问医生的（选填）</span><textarea rows={2} maxLength={200} value={note} onChange={event => { setNote(event.target.value); setSaved(false); }} /></label>
      <div className="tang-svc-actions" style={{ marginTop: 10 }}><button type="button" className="tang-svc-btn is-primary" disabled={!status} onClick={save}>保存</button>{saved && <span role="status">已保存在当前设备<SavedCheck key={saveFeedback} /></span>}</div>
    </section>
    {entries.length > 0 && <section className="tang-svc-box"><h3>最近记录</h3><ul className="tang-svc-list">{entries.slice(0, 14).map(entry => <li key={entry.date}><span>{entry.date}</span><span>{entry.status}{entry.note ? `；${entry.note}` : ""}</span></li>)}</ul></section>}
    <p className="tang-svc-note">记录会出现在“就诊准备”的复诊摘要里。</p>
  </div>;
}

type SmokingData = { startDate?: string; days: Record<string, { cigarettes?: number; urges?: number }> };
const COPING = ["先等 5 分钟，给自己一点缓冲；还想吸烟时，再换一种方法。", "喝点水，或轻轻做几次慢呼吸。", "离开让你想吸烟的地方，走一走。", "告诉身边的人你在戒烟，请他们支持你，不递烟、不劝烟。"];

export function TangSmokingPanel() {
  const [data, setData] = useTangLocal<SmokingData>(SMOKING_SECTION, { days: {} });
  const today = localDateKey();
  const todayData = data.days[today] || {};
  const [startFeedback, setStartFeedback] = useState(false);
  const [cigaretteFeedback, setCigaretteFeedback] = useState(0);
  const [urgeFeedback, setUrgeFeedback] = useState(0);
  const update = (patch: { cigarettes?: number; urges?: number }) => setData({ ...data, days: { ...data.days, [today]: { ...todayData, ...patch } } });
  const elapsed = data.startDate ? Math.max(0, Math.round((new Date(`${today}T12:00:00Z`).getTime() - new Date(`${data.startDate}T12:00:00Z`).getTime()) / 86400000)) + 1 : 0;
  return <div className="tang-svc">
    <section className="tang-svc-box">{data.startDate ? <div className="tang-svc-stat"><b>{elapsed}</b><span>天，从 {data.startDate} 开始{startFeedback && <SavedCheck />}</span></div> : <><h3>准备开始戒烟？</h3><div className="tang-svc-actions"><button type="button" className="tang-svc-btn is-primary" onClick={() => { setData({ ...data, startDate: today }); setStartFeedback(true); }}>今天开始</button></div></>}</section>
    <section className="tang-svc-box"><h3>今天的记录</h3>
      <label style={{ display: "block" }}><span>今天吸了几支{cigaretteFeedback > 0 && <SavedCheck key={cigaretteFeedback} />}</span><input type="number" inputMode="numeric" min={0} max={100} value={todayData.cigarettes ?? ""} onChange={event => { const value = Number(event.target.value); update({ cigarettes: event.target.value === "" || !Number.isFinite(value) ? undefined : Math.min(100, Math.max(0, Math.round(value))) }); setCigaretteFeedback(value => value + 1); }} /></label>
      <div className="tang-svc-actions" style={{ marginTop: 10, alignItems: "center" }}><button type="button" className="tang-svc-btn" onClick={() => { update({ urges: (todayData.urges || 0) + 1 }); setUrgeFeedback(value => value + 1); }}>刚才想吸烟 +1</button><span role="status">今天 {todayData.urges || 0} 次{urgeFeedback > 0 && <SavedCheck key={urgeFeedback} />}</span></div>
    </section>
    <section className="tang-svc-box"><h3>想吸烟的时候，可以试试</h3><ul>{COPING.map(item => <li key={item}>{item}</li>)}</ul><SourceNote keys={["quit"]} /></section>
    <p className="tang-svc-note">戒烟药物和方案请在门诊咨询，本页不做推荐。记录会出现在“就诊准备”的复诊摘要里。</p>
  </div>;
}

export function TangFamilyPanel({ onAsk }: { onAsk: (question: string) => void }) {
  return <div className="tang-svc">
    <details open><summary>怎样沟通</summary><ul><li>先听听对方的感受。可以说：“最近好像很辛苦，你愿意说说吗？”不急着给建议。</li><li>少评价，不责备。避免“想开点”“别矫情”，先了解对方正在经历什么。</li><li>问问对方希望怎样获得帮助。能一起商量的事，一起决定下一步。</li></ul></details>
    <details><summary>哪些变化要尽快就医</summary><ul><li>睡眠和平时明显不同，如明显少睡、几乎不睡。</li><li>情绪或言行明显改变，如异常兴奋、明显多疑，或说话让人难以理解。</li><li>日常生活明显受影响，如很少与人来往，或难以照顾自己的清洁和起居。</li><li>记忆或思考能力明显变差，已经影响日常生活。</li></ul><p className="tang-svc-note">这些变化值得尽快向医生咨询，不能据此判断是什么病，也不用等到全部出现。</p></details>
    <details><summary>紧急情况怎么办</summary><p>如果家人提到不想活、伤害自己或他人，或突然意识混乱、认不清人或地方，请不要让对方独处，收好危险物品，并立即拨打 120 或前往急诊。</p></details>
    <details><summary>怎样陪诊</summary><ul><li>提前记下变化：什么时候开始、具体发生过什么、对生活有什么影响。</li><li>带上用药清单和相关就诊资料，也可以带药盒，方便医生核对。</li><li>先问家人是否愿意你陪同。让家人先表达，你再补充观察到的情况；也尊重其单独与医生交流的意愿。</li></ul></details>
    <section className="tang-svc-box"><h3>照顾好你自己</h3><p>长期照护很累，你也可以寻求支持。心理援助热线：96525、12356。</p></section>
    <div className="tang-svc-actions"><button type="button" className="tang-svc-btn is-primary" onClick={() => onAsk("家人情绪低落时怎样沟通？")}>问一问：家人情绪低落时怎样沟通</button></div>
    <SourceNote keys={["family"]} />
  </div>;
}

export function TangClinicPanel({ bio, onPrepare }: { bio: DoctorBio; onPrepare: () => void }) {
  const campuses = [...new Set([...bio.clinics.map(clinic => clinic.campus), ...bio.bookingDepartments.map(item => item.campus)])];
  return <div className="tang-svc">
    <p className="tang-svc-alert" role="note">本页不能挂号，请通过医院官方渠道预约。实际号源以医院挂号页面为准。</p>
    {campuses.map(campus => {
      const clinics = bio.clinics.filter(item => item.campus === campus);
      const image = clinics.find(item => item.image)?.image;
      const times = clinics.flatMap(item => item.times);
      const departments = bio.bookingDepartments.filter(item => item.campus === campus);
      return <section className="tang-svc-box tang-clinic-card" key={campus} aria-label={campus}>
        <header className="tang-clinic-cover">{image ? <><img src={image} alt={campus} /><h3>{campus}</h3></> : <><h3><MapPinIcon size={24} aria-hidden="true" />{campus}</h3><small className="tang-clinic-placeholder">院区图待提供</small></>}</header>
        <div className="tang-clinic-body"><h4>门诊时间</h4><div className="tang-svc-clinic">{times.length ? <ClinicTimes times={times} /> : <p className="tang-svc-note">门诊时间待确认</p>}</div>
        {departments.length > 0 && <><h4>挂号科室</h4><ul>{departments.map(item => <li key={item.department}>{item.department}</li>)}</ul></>}</div>
      </section>;
    })}
    <div className="tang-svc-actions"><button type="button" className="tang-svc-btn is-primary" onClick={onPrepare}>去做就诊准备</button></div>
  </div>;
}

// 接医院接口时替换 onSubmit，并同步改 EMERGENCY 和成功提示；接通前不要写成“已发送给医生”。
export function TangMessagePanel({ onSubmit, onPrepare }: { onSubmit: (text: string) => void; onPrepare: () => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const submit = () => { try { onSubmit(text.trim()); setError(""); setSent(true); } catch { setError("保存失败，请缩短内容后重试。"); } };
  return <div className="tang-svc">
    <p className="tang-svc-intro">把想问医生的问题写下来，帮你整理进就诊准备，看诊时一个也不漏。</p>
    <p className="tang-svc-alert" role="note">{EMERGENCY}</p>
    {sent ? <section className="tang-svc-box" role="status"><h3>已放进就诊准备</h3><p>看诊时可以直接带给医生。需要找医生，请通过医院官方渠道预约。</p><div className="tang-svc-actions" style={{ marginTop: 10 }}><button type="button" className="tang-svc-btn is-primary" onClick={onPrepare}>去就诊准备</button><button type="button" className="tang-svc-btn" onClick={() => { setText(""); setSent(false); }}>再写一条</button></div></section>
      : <section className="tang-svc-box"><label style={{ display: "block" }}><span>想问医生的问题</span><textarea rows={4} maxLength={500} value={text} placeholder="请不要填写姓名、电话、病历号等个人信息" onChange={event => setText(event.target.value)} /></label>{error && <p className="tang-svc-note" role="alert">{error}</p>}<div className="tang-svc-actions" style={{ marginTop: 10 }}><button type="button" className="tang-svc-btn is-primary" disabled={!text.trim()} onClick={submit}>保存到就诊准备</button></div></section>}
  </div>;
}

export function TangMorePanel({ onOpen, onMe }: { onOpen: (panel: string) => void; onMe: () => void }) {
  const [showNotice, setShowNotice] = useState(false);
  const Row = ({ label, onClick }: { label: string; onClick: () => void }) => <button type="button" onClick={onClick}>{label}<CaretRightIcon size={16} /></button>;
  return <div className="tang-svc">
    <div className="tang-svc-more">
      <Row label="专家介绍" onClick={() => onOpen("专家介绍")} />
      <Row label="复诊摘要" onClick={() => onOpen("就诊准备")} />
      <Row label="隐私与设置" onClick={onMe} />
      <Row label="使用说明" onClick={() => setShowNotice(value => !value)} />
    </div>
    {showNotice && <section className="tang-svc-box"><ul>{noticeLines.map(line => <li key={line}>{line}</li>)}</ul></section>}
  </div>;
}
