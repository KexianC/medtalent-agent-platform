import { useId, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import type { MetricKey, WellnessRecord } from './types';
import { useWellness, WELLNESS_TEMPLATE_READ_ONLY_NOTICE } from './WellnessStore';
import { useConsumerSession } from '../../hooks/useConsumerSession';
import { RecordReviewCard } from '../health/RecordReviewCard';
import { buildWellnessRecordReview } from './recordReview';
import { useWellnessDay } from './useWellnessDay';
import {
  WELLNESS_METRICS, createWellnessDraft, formatWellnessNumber, mergeWellnessRecord, metricsForMode,
  normalizeWellnessRecords, validateWellnessDraft, wellnessAssociation, wellnessDateKey, wellnessStatistics, wellnessTrend,
  type RecordMode,
} from './recordModel';
import './wellness-records.css';

function RecordDetail({ record }: { record?: WellnessRecord }) {
  if (!record) return <p className="yw-record-empty">这一天还没有记录。未填写的内容不会按 0 计算。</p>;
  return <div className="yw-record-detail">
    <dl>{WELLNESS_METRICS.flatMap(metric => {
      const value = record.values[metric.key];
      return value === undefined ? [] : [<div key={metric.key}><dt>{metric.label}</dt><dd>{formatWellnessNumber(value)} <small>{metric.unit}</small></dd></div>];
    })}</dl>
    {record.trigger && <p><b>发生了什么</b>{record.trigger}</p>}
    {record.coping && <p><b>我怎样照顾自己</b>{record.coping}</p>}
    {record.note && <p><b>想留给自己的话</b>{record.note}</p>}
  </div>;
}

function RecordForm({ mode, date }: { mode: RecordMode; date: string }) {
  const { state, setState, persistence, readOnly } = useWellness();
  const existing = normalizeWellnessRecords(state.records).find(record => record.date === date);
  const [draft, setDraft] = useState(() => createWellnessDraft(existing));
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const prefix = useId();
  const metrics = metricsForMode(mode);
  const changeMetric = (key: MetricKey, value: string) => {
    setSaved(false); setError('');
    setDraft(current => ({ ...current, values: { ...current.values, [key]: value } }));
  };
  const changeText = (key: 'note' | 'trigger' | 'coping', value: string) => {
    setSaved(false); setError(''); setDraft(current => ({ ...current, [key]: value }));
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (readOnly) { setError(WELLNESS_TEMPLATE_READ_ONLY_NOTICE); setSaved(false); return; }
    const result = validateWellnessDraft(mode, date, draft);
    if (result.error) { setError(result.error); setSaved(false); return; }
    if (!result.patch) return;
    const hasValues = Object.keys(result.patch.values).length > 0;
    const hasText = result.patch.note || result.patch.trigger || result.patch.coping;
    if (!hasValues && !hasText && !existing) { setError('先填写一项内容，就可以保存今天的记录。'); setSaved(false); return; }
    setState(current => ({ ...current, records: mergeWellnessRecord(current.records, mode, date, result.patch) }));
    setError(''); setSaved(true);
  };
  const remove = () => {
    if (readOnly) return;
    setState(current => ({ ...current, records: normalizeWellnessRecords(current.records).filter(record => record.date !== date) }));
    setDraft(createWellnessDraft()); setDeleteConfirm(false); setSaved(false); setError('');
  };
  return <form className="yw-record-form" onSubmit={save} noValidate>
    <div className="yw-record-form-heading"><h3>{existing ? '编辑这一天的记录' : date === wellnessDateKey() ? '记录今天' : '补记这一天'}</h3><span>全部选填</span></div>
    <div className="yw-record-fields">
      {metrics.map(metric => <label className="yw-record-field" key={metric.key} htmlFor={`${prefix}-${metric.key}`}>
        <span>{metric.label}</span>
        <div><input id={`${prefix}-${metric.key}`} type="number" disabled={readOnly} inputMode={metric.step === 1 ? 'numeric' : 'decimal'} min={metric.min} max={metric.max} step={metric.step} value={draft.values[metric.key] ?? ''} onChange={event => changeMetric(metric.key, event.target.value)} placeholder="未记录" aria-describedby={metric.hint ? `${prefix}-${metric.key}-hint` : undefined} /><em>{metric.unit}</em></div>
        {metric.hint && <small id={`${prefix}-${metric.key}-hint`}>{metric.hint}</small>}
      </label>)}
    </div>
    {mode === 'diary' && <div className="yw-record-writing">
      {([
        ['trigger', '发生了什么', '哪些事情影响了今天的心情？可以从一个小片段写起。'],
        ['coping', '我怎样照顾自己', '做了什么让自己舒服一点？例如散步、与朋友聊聊。'],
        ['note', '想留给自己的话', '也可以记下身体感受、睡眠变化或明天想尝试的小事。'],
      ] as const).map(([key, label, placeholder]) => <label key={key} htmlFor={`${prefix}-${key}`}><span>{label}</span><textarea id={`${prefix}-${key}`} disabled={readOnly} maxLength={600} rows={3} value={draft[key]} placeholder={placeholder} onChange={event => changeText(key, event.target.value)} /><small>{draft[key].length} / 600</small></label>)}
    </div>}
    {mode === 'health' && <p className="yw-record-hint">按实际测量或设备显示手动填写。睡眠和心情可在“睡眠情绪日记”中记录，两处按日期合并。</p>}
    {error && <p className="yw-record-error" role="alert">{error}</p>}
    {saved && <p className="yw-record-saved" role="status">{persistence.storage === 'cloud'
      ? persistence.status === 'ready' ? '这一天的记录已同步到微信账户。'
        : persistence.cloudStatus === 'conflict' ? '记录与云端版本有冲突，请到“我的”选择保留版本。'
          : ['pending', 'saving', 'loading'].includes(persistence.cloudStatus || '') ? '记录已更新，正在同步到微信账户。' : '记录已更新，尚未同步到微信账户，请到“我的”重试同步。'
      : persistence.status === 'ready' ? '这一天的记录已更新到本机。' : '记录已更新到当前页面，暂时无法保存到本机。'}</p>}
    <button className="journey-primary-button" type="submit" disabled={readOnly}>{existing ? '保存修改' : '保存记录'}</button>
    <p className="yw-record-hint">同一天只保留一份记录，修改此表单会保留另一表单已填写的内容；留空表示未记录。</p>
    {existing && !deleteConfirm && <button className="yw-record-delete" type="button" disabled={readOnly} onClick={() => setDeleteConfirm(true)}>删除这天全部记录</button>}
    {deleteConfirm && <div className="yw-record-confirm" role="group" aria-label="确认删除记录"><p>删除 {date} 的日记和健康数据？删除后无法恢复。</p><div><button type="button" onClick={() => setDeleteConfirm(false)}>保留记录</button><button className="yw-record-delete" type="button" onClick={remove}>确认删除</button></div></div>}
  </form>;
}

export function WellnessRecordEditor({ mode, initialDate }: { mode: RecordMode; initialDate?: string }) {
  const account = useConsumerSession();
  const { readOnly } = useWellness();
  const [date, setDate] = useState(initialDate ?? wellnessDateKey());
  const prefix = useId();
  return <section className="yw-record-editor">
    <header className="yw-record-intro"><span>{mode === 'diary' ? 'SLEEP & FEELINGS' : 'MY HEALTH LOG'}</span><h2>{mode === 'diary' ? '睡眠情绪日记' : '健康数据记录'}</h2><p>{mode === 'diary' ? '不必急着改变感受，先把今天的自己温柔地记下来。' : '积累属于自己的日常数据，让变化有迹可循。'}</p></header>
    <div className="yw-record-date"><label htmlFor={`${prefix}-date`}>记录日期<input id={`${prefix}-date`} type="date" min="1900-01-01" max={wellnessDateKey()} value={date} onChange={event => setDate(event.target.value)} /></label><button type="button" onClick={() => setDate(wellnessDateKey())} disabled={date === wellnessDateKey()}>回到今天</button></div>
    <RecordForm mode={mode} date={date} key={`${mode}-${date}`} />
    <p className="yw-record-footnote">{readOnly ? WELLNESS_TEMPLATE_READ_ONLY_NOTICE : account.user ? '记录会同步到微信账户，完成后可跨设备查看。' : '记录仅保存在当前设备。'}用于自我观察与沟通，不作诊断依据。</p>
  </section>;
}

export function WellnessReport({ onAsk }: { onAsk?: (question: string) => void }) {
  const { state } = useWellness();
  const [days, setDays] = useState<7 | 30>(7);
  const [metricKey, setMetricKey] = useState<MetricKey>('moodScore');
  const [selectedDate, setSelectedDate] = useState(wellnessDateKey());
  const [associationKey, setAssociationKey] = useState<MetricKey>('sleepHours');
  const today = useWellnessDay();
  const points = useMemo(() => wellnessTrend(state.records, days, today), [state.records, days, today]);
  const statistics = useMemo(() => wellnessStatistics(points), [points]);
  const metric = WELLNESS_METRICS.find(item => item.key === metricKey)!;
  const selectedStat = statistics.find(item => item.key === metricKey)!;
  const selectedPoint = points.find(point => point.date === selectedDate) ?? points.at(-1);
  const recordedDays = points.filter(point => point.record).length;
  const availableStats = statistics.filter(item => item.count > 0);
  const chartMax = Math.max(1, ...points.map(point => point.record?.values[metricKey] ?? 0));
  const association = wellnessAssociation(points, associationKey, 'moodScore');
  const [includeNotes, setIncludeNotes] = useState(false);
  const review = useMemo(() => buildWellnessRecordReview(state.records, days, today, includeNotes), [state.records, days, today, includeNotes]);
  const prefix = useId();
  return <section className="yw-record-report">
    <header className="yw-record-intro"><span>GENTLE REFLECTION</span><h2>我的健康趋势</h2><p>看看真实记录里的变化，也允许有空白的日子。</p></header>
    <div className="yw-record-period" role="group" aria-label="统计时间范围">{([7, 30] as const).map(value => <button key={value} type="button" aria-pressed={days === value} onClick={() => setDays(value)}>近 {value} 天</button>)}</div>
    <div className="yw-record-summary"><div><span>有记录的日子</span><strong>{recordedDays}<small> / {days} 天</small></strong></div><p>{points[0]?.date} — {today}<br />每项平均值只计算该项实际填写的天数。</p></div>
    {!recordedDays && <p className="yw-record-empty">这段时间还没有记录。完成日记或健康数据后，这里会按真实数据生成统计。</p>}
    {availableStats.length > 0 && <div className="yw-record-statistics" aria-label="各指标平均值">{availableStats.map(item => <button key={item.key} type="button" onClick={() => setMetricKey(item.key)} aria-pressed={metricKey === item.key}><span>平均{item.label}</span><b>{formatWellnessNumber(item.average)}<small> {item.unit}</small></b><em>{item.count} 天有填写</em></button>)}</div>}
    <div className="yw-record-chart-card">
      <label className="yw-record-chart-select" htmlFor={`${prefix}-metric`}><span>查看指标趋势</span><select id={`${prefix}-metric`} value={metricKey} onChange={event => setMetricKey(event.target.value as MetricKey)}>{WELLNESS_METRICS.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <div className="yw-record-chart-meta"><strong>{metric.label}</strong><span>{metric.unit} · {selectedStat.count} 天有填写</span></div>
      {metric.hint && <p className="yw-record-hint">{metric.hint}</p>}
      <div className="yw-record-chart-scroll"><div className={`yw-record-chart ${days === 30 ? 'is-month' : ''}`} aria-label={`${metric.label}近${days}天趋势`}>
        {points.map(point => {
          const value = point.record?.values[metricKey];
          return <button className={`yw-record-bar ${value === undefined ? 'is-empty' : ''}`} key={point.date} type="button" onClick={() => setSelectedDate(point.date)} aria-pressed={point.date === selectedPoint?.date} aria-label={`${point.date}，${metric.label}${value === undefined ? '未记录' : `${formatWellnessNumber(value)}${metric.unit}`}，查看当日明细`}><span>{formatWellnessNumber(value)}</span><i>{value !== undefined && <b style={{ '--yw-record-height': `${value / chartMax * 100}%` } as CSSProperties} />}</i><small>{point.date.slice(5).replace('-', '/')}</small></button>;
        })}
      </div></div>
      <p className="yw-record-hint">横向可查看全部日期，点击某天查看明细。— 表示未记录。</p>
    </div>
    <section className="yw-record-day-detail" aria-live="polite"><h3>{selectedPoint?.date} 记录明细</h3><RecordDetail record={selectedPoint?.record} /></section>
    <section className="yw-record-association"><h3>生活习惯与心情</h3><label htmlFor={`${prefix}-association`}>对照指标<select id={`${prefix}-association`} value={associationKey} onChange={event => setAssociationKey(event.target.value as MetricKey)}><option value="sleepHours">睡眠时长</option><option value="exerciseMin">运动时长</option><option value="steps">步数</option><option value="stressScore">压力</option></select></label>
      {association.coefficient === undefined ? <p>{association.count < 5 ? `这段时间有 ${association.count} 天同时记录了这两项，至少需要 5 天才能计算。` : '两项记录中有一项没有变化，目前无法计算相关程度。'}</p> : <p>同一天两项都有填写的记录共 <b>{association.count} 天</b>，相关系数为 <b>{association.coefficient.toFixed(2)}</b>。{Math.abs(association.coefficient) < 0.2 ? '当前记录没有呈现明显的线性关联。' : association.coefficient > 0 ? '这组记录中，两项数值较常一起升降。' : '这组记录中，两项数值较常向相反方向变化。'}</p>}
      <small>仅描述这段记录中的关联，不代表因果或健康结论；样本较少时结果可能不稳定。</small>
    </section>
    <RecordReviewCard review={review} includeNotes={includeNotes} onIncludeNotes={setIncludeNotes} onAsk={onAsk} />
  </section>;
}

export function WellnessRecordHistory() {
  const { state } = useWellness();
  const records = useMemo(() => normalizeWellnessRecords(state.records), [state.records]);
  const [selectedDate, setSelectedDate] = useState('');
  const [editMode, setEditMode] = useState<RecordMode | null>(null);
  const [limit, setLimit] = useState(20);
  return <section className="yw-record-history"><header className="yw-record-form-heading"><h3>我的记录</h3><span>{records.length} 天</span></header>
    {!records.length && <p className="yw-record-empty">还没有记录。从今天的一项感受或一个数值开始就好。</p>}
    {records.slice(0, limit).map(record => <article key={record.id} className="yw-record-history-item"><button className="yw-record-history-toggle" type="button" onClick={() => { setSelectedDate(current => current === record.date ? '' : record.date); setEditMode(null); }} aria-expanded={selectedDate === record.date}><span><b>{record.date}</b><small>{WELLNESS_METRICS.filter(metric => record.values[metric.key] !== undefined).slice(0, 3).map(metric => `${metric.label} ${formatWellnessNumber(record.values[metric.key])}${metric.unit}`).join(' · ') || '文字日记'}{record.note || record.trigger || record.coping ? ' · 有日记' : ''}</small></span><em>{selectedDate === record.date ? '收起' : '查看'}</em></button>
      {selectedDate === record.date && <div className="yw-record-history-expanded"><RecordDetail record={record} /><div className="yw-record-edit-actions"><button type="button" onClick={() => setEditMode('diary')}>编辑日记</button><button type="button" onClick={() => setEditMode('health')}>编辑健康数据</button>{editMode && <button type="button" onClick={() => setEditMode(null)}>收起编辑</button>}</div>{editMode && <WellnessRecordEditor mode={editMode} initialDate={record.date} key={`${record.date}-${editMode}`} />}</div>}
    </article>)}
    {records.length > limit && <button className="journey-secondary-button" type="button" onClick={() => setLimit(current => current + 20)}>查看更多记录</button>}
  </section>;
}
