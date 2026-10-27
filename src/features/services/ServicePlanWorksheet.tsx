import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { DoctorProfile } from '../../data/doctorProfiles';
import type { DoctorPersistenceMeta } from '../../hooks/useDoctorLocalState';
import { buildServicePlanSummary, serviceProgress, toggleServiceProgress, getServiceWorkflow, isServicePlanDate, normalizeServicePlans, saveServicePlan, type ServicePlan, type ServicePlans } from '../../lib/servicePlans';
import { canWriteBuilderData } from '../../lib/builderRuntime';
import './service-plans.css';

export default function ServicePlanWorksheet({ doctor, service, planId = service, stored, setStored, persistence, onAsk, onManage, onDirtyChange }: {
  doctor: DoctorProfile;
  service: string;
  planId?: string;
  stored: ServicePlans;
  setStored: Dispatch<SetStateAction<ServicePlans>>;
  persistence: DoctorPersistenceMeta;
  onAsk: (question: string) => void;
  onManage: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const saved = useMemo(() => normalizeServicePlans(stored).plans.find(plan => plan.id === planId), [stored, planId]);
  const blank = useMemo<ServicePlan>(() => ({ id: planId, service, completed: [], note: '', targetDate: '', updatedAt: new Date().toISOString() }), [service, planId]);
  const [draft, setDraft] = useState<ServicePlan>(() => saved || blank);
  const [dirty, setDirty] = useState(false);
  const [editBase, setEditBase] = useState(() => JSON.stringify(saved || null));
  const [notice, setNotice] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [lastAction, setLastAction] = useState<'save' | 'delete'>('save');
  const savedFingerprint = JSON.stringify(saved || null);
  const remoteChanged = dirty && editBase !== savedFingerprint;
  const workflow = useMemo(() => { const configured = doctor.builder?.servicePlans.find(item => item.id === planId || item.title === service); return configured ? { description: configured.description || '整理自己的准备进度和待问问题。', steps: configured.steps.map(item => item.title), action: 'prepare' as const, question: '我想了解' + service } : getServiceWorkflow(doctor.slug, service); }, [doctor.slug, doctor.builder, service, planId]);
  const definition = doctor.builder?.servicePlans.find(item => item.id === planId || item.title === service);
  const writable = canWriteBuilderData(doctor, 'services');
  const progress = definition ? serviceProgress(definition,draft) : null;
  const summary = buildServicePlanSummary(doctor.name, draft, definition);

  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { if (!dirty) setDraft(saved || blank); }, [saved, blank, dirty]); // Cloud changes are applied only while the worksheet has no unsaved edits.

  const update = (value: Partial<ServicePlan>) => {
    if (!dirty) setEditBase(savedFingerprint);
    setDraft(current => ({ ...current, ...value })); setDirty(true); setNotice(''); setAttempted(false);
  };
  const save = () => {
    if (!writable) return;
    if (progress?.issues.length) { setNotice(progress.issues.join(" ")); return; }
    if (remoteChanged) { setNotice('保存的计划在你编辑期间发生了变化，请先选择要保留的内容。'); return; }
    if (!isServicePlanDate(draft.targetDate)) { setNotice('请选择有效的计划日期（1900—2200年），也可以留空。'); return; }
    try {
      const next = { ...draft, updatedAt: new Date().toISOString() };
      // Validate before entering the persistence callback; errors must never escape into React's updater.
      saveServicePlan(stored, next);
      setStored(current => saveServicePlan(current, next));
      setDraft(next); setDirty(false); setAttempted(true); setLastAction('save'); setNotice('');
    } catch (error) { setNotice(error instanceof Error ? error.message : '保存失败，请重试。'); }
  };
  const remove = () => {
    if (!window.confirm(`确定删除“${service}”的计划与备注吗？`)) return;
    setStored(current => ({ version: 1, plans: normalizeServicePlans(current).plans.filter(plan => plan.id !== planId) }));
    setDraft(blank); setDirty(false); setAttempted(true); setLastAction('delete'); setNotice('');
  };
  const status = attempted ? persistence.status === 'ready'
    ? persistence.storage === 'cloud' ? lastAction === 'delete' ? '删除已同步到账户。' : '当前计划已同步到账户。' : lastAction === 'delete' ? '当前计划已从本机删除。' : '当前计划已保存到本机。'
    : persistence.storage === 'cloud' ? '当前修改等待同步；可在“我的”查看同步进度或处理冲突。' : '当前修改仅保留在页面中，尚未保存到本机，请重试。' : '';

  return <div className="service-plan-workspace">
    <p className="journey-feature-lead">{workflow.description}</p>
    {!writable && <p role="status">此组件为只读，可查看和删除已有记录。</p>}
    {progress && <p role="status">{progress.completed ? '准备事项已完成' : '准备事项进行中'} · {progress.count} / {progress.total} {definition?.completionRule === 'all-required' ? '必需步骤' : '全部步骤'}</p>}
    {progress && definition ? <fieldset className="service-plan-checklist" disabled={!writable}><legend>我的准备清单</legend>{progress.steps.map(step => <div key={step.id} className="service-plan-step-fields"><label><input type="checkbox" checked={step.checked} disabled={step.blocked} onChange={event => update({completed:toggleServiceProgress(definition,draft,step.id,event.target.checked)})}/><span>{step.title}{step.required === false ? '（选填）' : '（必需）'}{step.description && <small className="service-plan-step-description">{step.description}</small>}{step.blocked && <small>请先完成前置步骤</small>}</span></label>{step.fields.map(field => <label className="journey-field" key={field.key}><span>{field.label}{field.required ? ' *' : ''}</span><input type={field.type} maxLength={1000} value={field.value} disabled={step.blocked} onChange={event => update({values:{...draft.values,[step.id]:{...draft.values?.[step.id],[field.key]:field.type==='number'&&event.target.value!==''?Number(event.target.value):event.target.value}}})}/></label>)}</div>)}</fieldset> : <fieldset className="service-plan-checklist" disabled={!writable}><legend>我的准备清单</legend>
      {workflow.steps.map(step => <label key={step}><input type="checkbox" checked={draft.completed.includes(step)} onChange={event => update({ completed: event.target.checked ? [...draft.completed, step] : draft.completed.filter(item => item !== step) })} /><span>{step}{doctor.builder?.servicePlans.find(item => item.id === planId || item.title === service)?.steps.find(item => item.title === step)?.description && <small className="service-plan-step-description">{doctor.builder.servicePlans.find(item => item.id === planId || item.title === service)?.steps.find(item => item.title === step)?.description}</small>}</span></label>)}
      {draft.completed.filter(step => !workflow.steps.includes(step)).map(step => <label key={step}><input type="checkbox" checked onChange={() => update({ completed: draft.completed.filter(item => item !== step) })} /><span>此前已整理：{step}</span></label>)}
    </fieldset>}

    <label className="journey-field"><span>计划日期（选填）</span><input disabled={!writable} type="date" min="1900-01-01" max="2200-12-31" value={draft.targetDate} onChange={event => update({ targetDate: event.target.value })} /><small>日期仅用于回顾计划，不会自动预约或发送通知。</small></label>
    <label className="journey-field"><span>我的记录与待问问题</span><textarea disabled={!writable} rows={4} maxLength={2000} value={draft.note} placeholder="记录实际情况、资料准备进度或想沟通的问题" onChange={event => update({ note: event.target.value })} /></label>
    {remoteChanged && <div className="service-plan-conflict" role="alert"><p>这份计划在你编辑期间已更新或删除。当前草稿已保留，请选择要继续使用的内容。</p><div className="service-plan-actions"><button type="button" className="journey-secondary-button" onClick={() => { setDraft(saved || blank); setDirty(false); setEditBase(savedFingerprint); setNotice('已载入当前保存的版本。'); }}>载入已保存版本</button><button type="button" className="journey-secondary-button" onClick={() => { setEditBase(savedFingerprint); setNotice('已选择当前草稿，请再次点击保存计划。'); }}>确认使用当前草稿</button></div></div>}
    <div className="service-plan-actions"><button type="button" className="journey-primary-button" disabled={!writable} onClick={save}>{saved ? '更新计划' : '保存计划'}</button>{saved && <button type="button" className="journey-danger-button" onClick={remove}>删除计划</button>}</div>
    {(notice || status) && <p className="service-plan-notice" role={notice ? 'alert' : 'status'}>{notice || status}</p>}
    {attempted && persistence.status !== 'ready' && <button type="button" className="journey-secondary-button" onClick={persistence.retry}>重试保存或同步</button>}
    {workflow.action === 'record' && <button type="button" className="journey-secondary-button" onClick={onManage}>填写健康记录与查看趋势</button>}
    {workflow.action === 'assessment' && doctor.slug === 'tang-jinsong' && <button type="button" className="journey-secondary-button" onClick={() => onAsk('我想了解最近的心理状态，请带我做一次非诊断性的自我观察。')}>进入对话中的心理自评</button>}
    <details className="service-plan-summary"><summary>查看将带入咨询的摘要</summary><pre>{summary}</pre><p>摘要最多1900字；完整备注保留在计划中。</p></details>
    <div className="service-plan-actions"><button type="button" className="journey-secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(summary); setNotice('摘要已复制。'); } catch { setNotice('无法自动复制，请展开摘要后手动选择复制。'); } }}>复制摘要</button><button type="button" className="journey-primary-button" onClick={() => onAsk(summary.replace(/\s*\n\s*/g, '；'))}>带摘要咨询</button></div>
    <p className="journey-sheet-disclaimer">只有点击“带摘要咨询”后，内容才会进入问答草稿；确认发送后再提交给 AI。{dirty ? '当前修改尚未保存。' : ''}</p>
  </div>;
}
