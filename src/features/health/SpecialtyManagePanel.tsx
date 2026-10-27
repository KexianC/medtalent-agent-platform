import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { ChartLineUpIcon, ClipboardTextIcon, FloppyDiskIcon, LockKeyIcon, NotePencilIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { DoctorExperience } from "../../data/doctorExperience";
import type { DoctorProfile } from "../../data/doctorProfiles";
import { createLocalId, localDateKey, useDoctorLocalState, type DoctorHealthRecord } from "../../hooks/useDoctorLocalState";
import { useConsumerSession } from "../../hooks/useConsumerSession";
import { healthRecordDateKey, normalizeHealthRecords } from "../../lib/healthRecords";
import { buildSpecialtyStats, getSpecialtyRecordConfig, saveSpecialtyRecord, validateSpecialtyRecordInput } from "../../lib/specialtyRecords";
import { canWriteBuilderData, configuredRecordConfig } from "../../lib/builderRuntime";
import { useWellnessDay } from "../yuwen/useWellnessDay";
import { RecordReviewCard } from "./RecordReviewCard";
import { buildSpecialtyRecordReview } from "./recordReview";
import "./specialty-records.css";

type Props = {
  doctor: DoctorProfile;
  experience: DoctorExperience;
  onAsk?: (question: string, withHealthContext?: boolean) => void;
};
type Draft = { dateKey: string; values: Record<string, string>; note: string };
const emptyDraft = (): Draft => ({ dateKey: localDateKey(), values: {}, note: "" });
const displayNumber = (value: number | undefined) => value === undefined ? "暂无" : String(Math.round(value * 100) / 100);
const displayValue = (key: string, value: number | undefined) => key === "menstrualStatus" && value !== undefined ? (value === 1 ? "正在经期" : "不在经期") : displayNumber(value);
const recordDraft = (record: DoctorHealthRecord): Draft => ({
  dateKey: healthRecordDateKey(record),
  values: { ...record.values, ...Object.fromEntries(Object.entries(record.measurements ?? {}).map(([key, value]) => [key, String(value)])) },
  note: record.note ?? "",
});

export default function SpecialtyManagePanel({ doctor, onAsk }: Props) {
  const account = useConsumerSession();
  const writable = canWriteBuilderData(doctor, "records");
  const today = useWellnessDay();
  const previousDay = useRef(today);
  const config = useMemo(() => configuredRecordConfig(doctor, getSpecialtyRecordConfig(doctor.slug)), [doctor]);
  const [storedRecords, setRecords, persistence] = useDoctorLocalState<DoctorHealthRecord[]>(doctor.slug, "health-records", []);
  const cloudPending = ['pending', 'saving', 'loading'].includes(persistence.cloudStatus || '');
  const storageNotice = persistence.storage === 'cloud'
    ? persistence.status === 'ready' ? '记录已同步到微信账户，可跨设备查看。'
      : persistence.cloudStatus === 'conflict' ? '记录与云端版本有冲突，请到“我的”选择保留版本。'
        : cloudPending ? '正在同步到微信账户，完成后可跨设备查看。' : '记录尚未同步到微信账户，请联网后重试同步。'
    : persistence.status === 'ready' ? '记录保存在当前设备，仅供个人查看与整理。' : '当前更改尚未保存到本机，请重试保存。';
  const records = useMemo(() => normalizeHealthRecords(storedRecords, doctor.builder ? config : undefined).sort((a, b) => (
    healthRecordDateKey(b).localeCompare(healthRecordDateKey(a)) || (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
  )), [storedRecords, config]);
  const [days, setDays] = useState<7 | 30>(7);
  const stats = useMemo(() => buildSpecialtyStats(records, config, days, new Date(`${today}T12:00:00`)), [records, config, days, today]);
  const [includeNotes, setIncludeNotes] = useState(false);
  const review = useMemo(() => buildSpecialtyRecordReview(doctor, config, records, days, new Date(`${today}T12:00:00`), includeNotes), [doctor, config, records, days, today, includeNotes]);
  const [selectedKey, setSelectedKey] = useState(config.fields[0]?.key ?? "");
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const editorRef = useRef<HTMLFormElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const prefix = useId();
  const editing = records.find((record) => record.id === editingId);
  const sameDay = !editingId ? records.find((record) => record.source === "manage" && healthRecordDateKey(record) === draft.dateKey) : undefined;
  const selected = stats.fields.find((field) => field.key === selectedKey) ?? stats.fields[0];
  const points = stats.trend.map((point, index) => ({ ...point, value: point.measurements?.[selected?.key], x: 38 + index * 258 / Math.max(1, stats.trend.length - 1) }));
  const plotted = points.filter((point) => point.value !== undefined);
  const low = plotted.length ? Math.min(...plotted.map((point) => point.value!)) : 0;
  const high = plotted.length ? Math.max(...plotted.map((point) => point.value!)) : 1;
  const y = (value: number) => low === high ? 78 : 130 - ((value - low) / (high - low)) * 104;

  useEffect(() => {
    const oldDay = previousDay.current;
    previousDay.current = today;
    if (oldDay !== today && !dirty && !editingId) setDraft((current) => current.dateKey === oldDay ? { ...current, dateKey: today } : current);
  }, [today, dirty, editingId]);

  const changeDraft = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
    setNotice("");
    setDirty(true);
  };
  const focusEditor = () => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    dateRef.current?.focus({ preventScroll: true });
  };
  const startNew = () => {
    if (dirty && !window.confirm("当前填写内容尚未保存，确定开始新的填报吗？")) return;
    setDraft(emptyDraft());
    setEditingId("");
    setErrors({});
    setNotice("");
    setDirty(false);
    focusEditor();
  };
  const editRecord = (record: DoctorHealthRecord) => {
    if (dirty && !window.confirm("当前填写内容尚未保存，确定切换到这条记录吗？")) return;
    setDraft(recordDraft(record));
    setEditingId(record.id);
    setErrors({});
    setNotice("");
    setDirty(false);
    focusEditor();
  };
  const changeDate = (dateKey: string) => {
    if (editingId) { changeDraft({ dateKey }); return; }
    if (dirty && !window.confirm("切换日期将替换当前尚未保存的填写内容，确定继续吗？")) return;
    const existing = records.find((record) => record.source === "manage" && healthRecordDateKey(record) === dateKey);
    setDraft(existing ? recordDraft(existing) : { ...emptyDraft(), dateKey });
    setEditingId(existing?.id ?? "");
    setErrors({});
    setNotice("");
    setDirty(false);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!writable) return;
    const validated = validateSpecialtyRecordInput(draft.values, config, draft.dateKey);
    const nextErrors = { ...validated.errors };
    if (draft.note.trim() || editing?.completedTitles.length) delete nextErrors._form;
    if (draft.note.length > 300) nextErrors.note = "备注最多填写 300 字。";
    if (editingId && !editing) nextErrors._form = "这条记录已发生变化，请重新选择历史记录后编辑。";
    if (editing && healthRecordDateKey(editing) !== draft.dateKey && records.some((record) => record.id !== editing.id && healthRecordDateKey(record) === draft.dateKey)) {
      nextErrors._date = "该日期已有记录，请直接编辑该日记录，或选择其他日期。";
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors);
      setNotice("");
      return;
    }
    const now = new Date().toISOString();
    const incoming: DoctorHealthRecord = {
      schemaVersion: 2,
      id: editing?.id ?? createLocalId("specialty"),
      createdAt: editing?.createdAt ?? now,
      updatedAt: now,
      dateKey: draft.dateKey,
      source: editing?.source ?? "manage",
      completedTitles: editing?.completedTitles ?? [],
      measurements: validated.measurements,
      values: validated.values,
      note: draft.note.trim(),
    };
    const result = saveSpecialtyRecord(records, incoming, editingId || undefined, new Date(), doctor.builder ? config : undefined);
    if (result.error) {
      setErrors({ _form: result.error });
      return;
    }
    const saved = result.records.find((record) => record.id === (editing?.id ?? sameDay?.id ?? incoming.id))
      ?? result.records.find((record) => record.source === incoming.source && healthRecordDateKey(record) === draft.dateKey);
    setRecords(result.records);
    if (saved) {
      setEditingId(saved.id);
      setDraft(recordDraft(saved));
    }
    setErrors({});
    setDirty(false);
    setNotice(sameDay ? "当日记录已合并更新。" : "记录已更新。");
  };
  const remove = (record: DoctorHealthRecord) => {
    if (!window.confirm(`确定删除 ${healthRecordDateKey(record)} 的这条记录吗？此操作无法恢复。`)) return;
    setRecords((current) => normalizeHealthRecords(current, doctor.builder ? config : undefined).filter((item) => item.id !== record.id));
    if (editingId === record.id) {
      setEditingId("");
      setDraft(emptyDraft());
      setDirty(false);
      setErrors({});
    }
    setNotice("记录已从当前列表删除。");
  };
  const clear = () => {
    if (!window.confirm(`确定清空${doctor.name}智能体中${account.user ? '微信账户' : '本机'}保存的全部 ${records.length} 条记录吗？${account.user ? '其他设备也会同步删除。' : ''}此操作无法恢复。`)) return;
    setRecords([]);
    setDraft(emptyDraft());
    setEditingId("");
    setDirty(false);
    setErrors({});
    setNotice("当前智能体的记录列表已清空。");
  };
  const retry = () => {
    if (persistence.errorCode === "INVALID_DATA" && !window.confirm("原本机记录无法读取。重试将用当前页面的记录替换原存储内容，确定继续吗？")) return;
    persistence.retry();
  };

  return (
    <div className="journey-simple-panel specialty-manage">
      <header>
        <span className="journey-eyebrow">PERSONAL HEALTH LOG</span>
        <h1>{config.title}</h1>
        <p>{config.description}</p>
      </header>

      {persistence.status !== "ready" && <section className="specialty-storage" role="alert">
        <b>{persistence.storage === 'cloud' ? storageNotice : persistence.status === "error" ? "本机记录暂时无法读取" : "更改仅保留在当前页面，尚未保存到本机"}</b>
        {persistence.storage !== 'cloud' && <p>{persistence.errorCode === "INVALID_DATA" ? "原存储内容未被自动覆盖，请确认后再重试。" : "请检查设备存储空间或浏览器权限。离开或刷新页面可能丢失本次更改。"}</p>}
        {(persistence.storage !== 'cloud' || (!cloudPending && persistence.cloudStatus !== 'conflict')) && <button type="button" onClick={retry}>{persistence.storage === 'cloud' ? '重试同步' : '重试保存'}</button>}
      </section>}

      <div className="specialty-summary-heading">
        <div className="journey-range-switch" aria-label="统计时间范围">
          {([7, 30] as const).map((range) => <button type="button" key={range} aria-pressed={days === range} className={days === range ? "is-active" : ""} onClick={() => setDays(range)}>近 {range} 天</button>)}
        </div>
        <button type="button" className="specialty-text-button" onClick={focusEditor}><NotePencilIcon size={17} /> 填写记录</button>
      </div>
      <section className="journey-health-overview" aria-label={`近 ${days} 天记录统计`}>
        <article><span>已记录天数</span><strong>{stats.recordedDays}<em> / {stats.days} 天</em></strong><small>同一天的多条记录计为 1 天</small></article>
        <article><span>记录覆盖率</span><strong>{stats.completionRate}<em>%</em></strong><small>含首页记录与补充备注</small></article>
      </section>

      {!writable && <p className="specialty-help" role="status">此组件为只读，可查看和删除已有记录。</p>}
      <form ref={editorRef} className="journey-record-editor specialty-editor" onSubmit={save} noValidate aria-labelledby={`${prefix}-editor`}><fieldset className="builder-data-fields" disabled={!writable}>
        <header className="journey-editor-heading">
          <div><span className="journey-eyebrow">DAILY CHECK-IN</span><h2 id={`${prefix}-editor`}>{editingId ? "编辑健康记录" : "填写健康记录"}</h2></div>
          {editingId && <button type="button" className="specialty-text-button" onClick={startNew}><PlusIcon size={16} /> 新填一条</button>}
        </header>
        <p className="specialty-help">{editing ? `正在编辑${editing.source === "home" ? "首页状态记录" : "健康管理记录"}，留空可移除该条记录中的数值。` : "按实际情况选填；至少填写一项数值或备注。"}</p>
        <label className="journey-record-field specialty-date">
          <span>记录日期</span>
          <input ref={dateRef} type="date" value={draft.dateKey} max={today} onChange={(event) => changeDate(event.target.value)} aria-invalid={Boolean(errors._date)} aria-describedby={errors._date ? `${prefix}-date-error` : undefined} />
        </label>
        {errors._date && <p className="specialty-error" id={`${prefix}-date-error`}>{errors._date}</p>}
        {sameDay && <div className="specialty-merge-note"><p>这一天已有管理记录。再次填写将合并已填项，空项保留原值。</p><button type="button" onClick={() => editRecord(sameDay)}>载入并编辑当日记录</button></div>}
        {editing?.completedTitles.length ? <p className="specialty-legacy-note">原打卡内容保留：{editing.completedTitles.join("、")}</p> : null}
        <div className="specialty-fields">
          {config.fields.map((field,index) => <div key={field.key}>{field.group && (index === 0 || config.fields[index - 1].group !== field.group) && <h3 className="specialty-field-group">{field.group}</h3>}<label className="journey-record-field">
            <span>{field.label}</span>
            {field.type === "text" ? <input type="text" maxLength={1000} value={draft.values[field.key] || ""} onChange={event => changeDraft({values:{...draft.values,[field.key]:event.target.value}})} placeholder="按实际情况填写" /> : field.type === "select" ? <select value={draft.values[field.key] || ""} onChange={event => changeDraft({values:{...draft.values,[field.key]:event.target.value}})}><option value="">未填写</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select> : field.key === "menstrualStatus" ? <select value={draft.values[field.key] ?? ""} onChange={(event) => changeDraft({ values: { ...draft.values, [field.key]: event.target.value } })} aria-describedby={`${prefix}-${field.key}-hint`}><option value="">未填写</option><option value="0">不在经期</option><option value="1">正在经期</option></select> : <div className="specialty-number-input">
              <input type="number" inputMode={field.step < 1 ? "decimal" : "numeric"} min={field.min} max={field.max} step={field.step}
                value={draft.values[field.key] ?? ""} placeholder="未填写" aria-invalid={Boolean(errors[field.key])} aria-describedby={`${prefix}-${field.key}-hint`}
                onChange={(event) => changeDraft({ values: { ...draft.values, [field.key]: event.target.value } })} />
              <em>{field.unit}</em>
            </div>}
            <small id={`${prefix}-${field.key}-hint`} className={errors[field.key] ? "specialty-error" : ""}>{errors[field.key] ?? (field.key === "menstrualStatus" ? "按当天实际情况选择" : field.hint ?? (field.type && field.type !== "number" ? "按当天实际情况填写" : `填写范围 ${field.min}–${field.max} ${field.unit}`))}</small>
          </label></div>)}
        </div>
        <label className="specialty-note"><span>补充备注（选填）</span><textarea maxLength={300} rows={3} value={draft.note} onChange={(event) => changeDraft({ note: event.target.value })} placeholder="记录当日情况、检查时间或需要补充的信息" /><small>{draft.note.length} / 300</small></label>
        {Object.keys(errors).length > 0 && <p className="specialty-error" role="alert">{errors._form ?? errors.note ?? "请检查上方标出的日期或数值。"}</p>}
        <button type="submit" className="journey-primary-button"><FloppyDiskIcon size={18} /> {editingId ? "保存修改" : sameDay ? "合并保存当日记录" : "保存记录"}</button>
        <p className="specialty-privacy"><LockKeyIcon size={14} /> {storageNotice}</p>
        {notice && <p className="specialty-notice" role="status">{notice}{storageNotice}</p>}
      </fieldset></form>

      <section className="journey-trend-card specialty-trends" aria-labelledby={`${prefix}-trend`}>
        <header><div><span className="journey-eyebrow">YOUR RECORDS</span><h2 id={`${prefix}-trend`}>数值统计与趋势</h2></div><ChartLineUpIcon size={25} weight="duotone" /></header>
        <p className="specialty-help">每项均值按已填写的日期计算，同日取该项最近填写值。</p>
        <div className="specialty-metric-grid">
          {stats.fields.map((field) => <article key={field.key}>
            <h3>{field.label}<small>{field.unit || "当日状态"}</small></h3>
            <dl className={field.key === "menstrualStatus" ? "is-status" : ""}><div><dt>{field.key === "menstrualStatus" ? "经期记录" : "均值"}</dt><dd>{field.key === "menstrualStatus" ? `${stats.trend.filter((point) => point.measurements?.menstrualStatus === 1).length} 天` : displayNumber(field.average)}</dd></div><div><dt>最近值</dt><dd>{displayValue(field.key, field.latest)}</dd></div></dl>
            <p>近 {days} 天已填写 {field.count} 天</p>
          </article>)}
        </div>
        <label className="specialty-trend-select"><span>查看趋势</span><select value={selected?.key ?? ""} onChange={(event) => setSelectedKey(event.target.value)}>{config.fields.filter(field => !field.type || field.type === "number").map((field) => <option key={field.key} value={field.key}>{field.label}{field.unit ? `（${field.unit}）` : ""}</option>)}</select></label>
        {plotted.length ? <>
          <svg className="specialty-chart" viewBox="0 0 320 165" role="img" aria-label={`近 ${days} 天${selected?.label}趋势，${plotted.length} 个已填写日期。缺少数据的日期不连线。`}>
            <title>{selected?.label}（{selected?.unit}）</title>
            <line x1="38" y1="130" x2="296" y2="130" className="specialty-chart-grid" />
            <line x1="38" y1="26" x2="296" y2="26" className="specialty-chart-grid" />
            <text x="30" y={low === high ? 82 : 134} textAnchor="end">{selected?.key === "menstrualStatus" ? low === 1 ? "经期" : "非经期" : displayNumber(low)}</text>
            {low !== high && <text x="30" y="30" textAnchor="end">{selected?.key === "menstrualStatus" ? "经期" : displayNumber(high)}</text>}
            {points.map((point, index) => {
              const previous = points[index - 1];
              return point.value === undefined ? null : <g key={point.dateKey}>
                {previous?.value !== undefined && <line x1={previous.x} y1={y(previous.value)} x2={point.x} y2={y(point.value)} className="specialty-chart-line" />}
                <circle cx={point.x} cy={y(point.value)} r="3.8"><title>{point.dateKey}：{displayValue(selected?.key ?? "", point.value)} {selected?.unit}</title></circle>
              </g>;
            })}
            <text x="38" y="154">{points[0]?.label}</text><text x="296" y="154" textAnchor="end">{points[points.length - 1]?.label}</text>
          </svg>
          <p className="specialty-help">圆点表示实际填报值；未填写的日期留空、不连线。纵轴按本期实际数值显示。</p>
          <details className="specialty-trend-values"><summary>查看趋势明细</summary><ul>{points.map((point) => <li key={point.dateKey}><time>{point.dateKey}</time><span>{point.value === undefined ? "未填写" : `${displayValue(selected?.key ?? "", point.value)} ${selected?.unit}`}</span></li>)}</ul></details>
        </> : <div className="specialty-empty"><ChartLineUpIcon size={28} /><b>本期暂无{selected?.label}数据</b><p>填写后将显示实际趋势，未填写不会按 0 计算。</p></div>}
      </section>

      <RecordReviewCard review={review} includeNotes={includeNotes} onIncludeNotes={setIncludeNotes} onAsk={onAsk} />

      <details className="specialty-history">
        <summary><ClipboardTextIcon size={20} /><span>查看历史记录</span><em>{records.length} 条</em></summary>
        {records.length ? <>
          <div className="specialty-record-list">{records.map((record) => <article key={record.id}>
            <header><time>{healthRecordDateKey(record)}</time><small>{record.source === "home" ? "首页状态记录" : "健康管理记录"}</small></header>
            {config.fields.some((field) => record.measurements?.[field.key] !== undefined) && <dl>{config.fields.filter((field) => record.measurements?.[field.key] !== undefined).map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{displayValue(field.key, record.measurements?.[field.key])} {field.unit}</dd></div>)}</dl>}
            {record.values && <dl>{config.fields.filter(field => record.values?.[field.key]).map(field => <div key={field.key}><dt>{field.label}</dt><dd>{record.values?.[field.key]}</dd></div>)}</dl>}
            {record.completedTitles.length > 0 && <p className="specialty-legacy-note">打卡：{record.completedTitles.join("、")}</p>}
            {record.note && <p className="specialty-record-note">{record.note}</p>}
            {!record.note && !record.completedTitles.length && !Object.keys(record.measurements ?? {}).length && !Object.keys(record.values ?? {}).length && <p className="specialty-help">旧版健康记录，暂无补充数值。</p>}
            <footer><button type="button" disabled={!writable} onClick={() => editRecord(record)} aria-label={`编辑 ${healthRecordDateKey(record)} 的${record.source === "home" ? "首页" : "管理"}记录`}><NotePencilIcon size={16} /> 编辑</button><button type="button" className="specialty-danger" onClick={() => remove(record)} aria-label={`删除 ${healthRecordDateKey(record)} 的${record.source === "home" ? "首页" : "管理"}记录`}><TrashIcon size={16} /> 删除</button></footer>
          </article>)}</div>
          <button type="button" className="specialty-clear specialty-danger" onClick={clear}><TrashIcon size={16} /> 清空当前智能体的{account.user ? '账户' : '本机'}记录</button>
        </> : <div className="specialty-empty"><ClipboardTextIcon size={28} /><b>还没有健康记录</b><p>保存填报或首页打卡后，即可在这里查看和修改。</p></div>}
      </details>
    </div>
  );
}
