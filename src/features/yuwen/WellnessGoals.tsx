import { useState } from 'react';
import { CheckCircleIcon, PlusIcon, TrashIcon, PencilSimpleIcon } from '@phosphor-icons/react';
import { createLocalId, localDateKey } from '../../hooks/useDoctorLocalState';
import { useWellness, WELLNESS_TEMPLATE_READ_ONLY_NOTICE } from './WellnessStore';
import { goalKinds, goalProgress } from './wellnessPractice';
import type { WellnessGoal } from './types';
import { useWellnessDay } from './useWellnessDay';

export function WellnessGoals() {
  const { state, setState, readOnly } = useWellness();
  const [editing, setEditing] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<WellnessGoal['kind']>('diary');
  const [title, setTitle] = useState<string>(goalKinds.diary.title);
  const [target, setTarget] = useState('1');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const today = useWellnessDay();
  const completed = state.goals.filter(goal => state.checks.some(check => check.date === today && check.goalId === goal.id && check.done)).length;
  function startEdit(goal?: WellnessGoal) {
    setEditing(goal?.id ?? null); setKind(goal?.kind ?? 'diary'); setTitle(goal?.title ?? goalKinds.diary.title); setTarget(String(goal?.target ?? 1)); setError(''); setOpen(true);
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (readOnly) { setError(WELLNESS_TEMPLATE_READ_ONLY_NOTICE); return; }
    const value = Number(target);
    if (!title.trim() || !target.trim() || !Number.isFinite(value) || value <= 0 || value > goalKinds[kind].max || (kind !== 'sleep' && !Number.isInteger(value))) { setError(`请填写目标名称和有效数量（大于 0，不超过 ${goalKinds[kind].max}${goalKinds[kind].unit}）。`); return; }
    const goal: WellnessGoal = { id: editing ?? createLocalId('goal'), kind, title: title.trim(), target: value, unit: goalKinds[kind].unit, createdAt: state.goals.find(item => item.id === editing)?.createdAt ?? new Date().toISOString() };
    setState(current => ({ ...current, goals: editing ? current.goals.map(item => item.id === editing ? goal : item) : [...current.goals, goal] }));
    setOpen(false); setMessage('目标已更新，每天可以重新打卡。');
  }
  return <div className="yw-flow">
    <section className="yw-card yw-goal-summary"><span className="journey-eyebrow">ONE SMALL STEP</span><h2>给今天一个小目标</h2><p>目标由你设定。实际记录会显示进度，完成后由你确认打卡。</p><strong>{completed}<small> / {state.goals.length} 项已打卡</small></strong><span>{today}</span></section>
    <button className="journey-primary-button" disabled={readOnly} onClick={() => startEdit()}><PlusIcon size={18} /> 添加每日目标</button>
    {message && <p role="status" className="yw-status">{message}</p>}
    {open && <form className="yw-card yw-form" onSubmit={save}>
      <h3>{editing ? '编辑目标' : '设置每日目标'}</h3>
      <label>目标类型<select value={kind} onChange={event => { const next = event.target.value as WellnessGoal['kind']; setKind(next); setTitle(goalKinds[next].title); setTarget(String(goalKinds[next].target)); }}>{Object.entries(goalKinds).map(([key, value]) => <option key={key} value={key}>{value.title}</option>)}</select></label>
      <label>目标名称<input value={title} maxLength={40} required onChange={event => setTitle(event.target.value)} /></label>
      <label>每日数量（{goalKinds[kind].unit}）<input type="number" inputMode="decimal" value={target} min={kind === 'sleep' ? 0.1 : 1} max={goalKinds[kind].max} step={kind === 'sleep' ? 0.1 : 1} required onChange={event => setTarget(event.target.value)} /></label>
      {error && <p role="alert" className="yw-error">{error}</p>}
      <div className="yw-actions"><button className="journey-primary-button" type="submit" disabled={readOnly}>保存目标</button><button className="yw-button" type="button" onClick={() => setOpen(false)}>取消</button></div>
    </form>}
    {!state.goals.length && <div className="yw-empty"><CheckCircleIcon size={34} /><h3>从一件小事开始</h3><p>试着设定“写一篇日记”或“冥想放松”，按自己的节奏完成。</p></div>}
    {state.goals.map(goal => {
      const done = state.checks.some(check => check.date === today && check.goalId === goal.id && check.done);
      const progress = goalProgress(goal, state, today);
      return <article key={goal.id} className={`yw-card yw-goal ${done ? 'is-done' : ''}`}>
        <div className="yw-row"><h3>{goal.title}</h3><button className="yw-icon" aria-label={`编辑${goal.title}`} disabled={readOnly} onClick={() => startEdit(goal)}><PencilSimpleIcon size={18} /></button></div>
        <p>每日 {goal.target} {goal.unit}</p>
        {goal.kind !== 'custom' && <><div className="yw-progress" role="progressbar" aria-label={`${goal.title}记录进度`} aria-valuenow={Math.min(progress, goal.target)} aria-valuemin={0} aria-valuemax={goal.target}><i style={{ width: `${Math.min(progress / goal.target, 1) * 100}%` }} /></div><small>今日已记录 {progress} {goal.unit}</small></>}
        <div className="yw-actions"><button className={done ? 'yw-button is-active' : 'journey-primary-button'} aria-pressed={done} disabled={readOnly} onClick={() => setState(current => { const date = localDateKey(); const wasDone = current.checks.some(check => check.goalId === goal.id && check.date === date && check.done); return { ...current, checks: [...current.checks.filter(check => check.goalId !== goal.id || check.date !== date), { date, goalId: goal.id, done: !wasDone }] }; })}><CheckCircleIcon size={19} weight={done ? 'fill' : 'regular'} />{done ? '已打卡 · 撤销' : '完成打卡'}</button><button className="yw-icon" aria-label={`删除${goal.title}`} disabled={readOnly} onClick={() => { if (window.confirm(`删除“${goal.title}”及其打卡记录？`)) setState(current => ({ ...current, goals: current.goals.filter(item => item.id !== goal.id), checks: current.checks.filter(item => item.goalId !== goal.id) })); }}><TrashIcon size={18} /></button></div>
      </article>;
    })}
    {state.checks.some(item => item.done) && <section className="yw-card"><h3>最近打卡</h3><div className="yw-history">{[...state.checks].filter(item => item.done && state.goals.some(goal => goal.id === item.goalId)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map(item => <p key={`${item.date}:${item.goalId}`}><span>{state.goals.find(goal => goal.id === item.goalId)?.title}</span><time>{item.date}</time></p>)}</div></section>}
  </div>;
}
