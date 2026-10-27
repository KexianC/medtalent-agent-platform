import { useState } from 'react';
import { canWriteBuilderData } from '../../lib/builderRuntime';
import type { DoctorProfile } from '../../data/doctorProfiles';
import { createLocalId, useDoctorLocalState } from '../../hooks/useDoctorLocalState';
export type BuilderAssessmentResult = { id: string; assessmentId: string; title: string; answers: number[]; score: number; createdAt: string; source?: string; definitionVersion?: string; resultLabel?: string; resultDescription?: string };
export type BuilderAssessmentDocument = { version: 1; results: BuilderAssessmentResult[] };
export function BuilderAssessments({ doctor, onAsk }: { doctor: DoctorProfile; onAsk: (question: string) => void }) {
  const writable = canWriteBuilderData(doctor, "assessments");
  const definitions = doctor.builder?.assessments || [];
  const [stored, setStored, persistence] = useDoctorLocalState<BuilderAssessmentDocument>(doctor.slug, 'builder-assessments-v1', { version: 1, results: [] });
  const [selected, setSelected] = useState('');
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState('');
  const definition = definitions.find(item => item.id === selected);
  const results = Array.isArray(stored?.results) ? stored.results : [];
  const save = () => {
    if (!writable) return;
    if (!definition || definition.questions.some(question => answers[question.id] === undefined)) { setNotice('请完成所有问题后再保存。'); return; }
    const values = definition.questions.map(question => answers[question.id]);
    const result: BuilderAssessmentResult = { id: createLocalId('assessment'), assessmentId: definition.id, title: definition.title, answers: values, score: values.reduce((total, value) => total + value, 0), createdAt: new Date().toISOString() };
    const band = definition.resultBands?.find(band => result.score >= band.min && result.score <= band.max);
    if (definition.source) result.source = definition.source;
    if (definition.version) result.definitionVersion = definition.version;
    if (band) { result.resultLabel = band.label; result.resultDescription = band.description; }
    setStored(current => ({ version: 1, results: [result, ...(current?.results || [])].slice(0,100) }));
    setSelected(''); setAnswers({}); setNotice('自评已保存，可在下方回顾。总分仅用于记录，不构成诊断。');
  };
  return <section className="builder-assessments" aria-label="健康自评">
    {!writable && <p role="status">此组件为只读，可查看和删除已有记录。</p>}<header><span className="journey-eyebrow">PERSONAL SELF-CHECK</span><h2>健康自评</h2><p>按实际感受作答；自评用于个人观察，不用于诊断或治疗决定。</p></header>
    {definition ? <form onSubmit={event => { event.preventDefault(); save(); }}>
      <h3>{definition.title}</h3><p>{definition.source && <>来源：{definition.source} </>}{definition.version && <>版本：{definition.version}</>}</p>{definition.description && <p>{definition.description}</p>}
      {definition.questions.map((question,index) => <fieldset key={question.id}><legend>{index + 1}. {question.text}</legend>{question.options.map(option => <label key={option.value}><input disabled={!writable} type="radio" name={question.id} checked={answers[question.id] === option.value} onChange={() => setAnswers(current => ({ ...current, [question.id]: option.value }))} />{option.label}</label>)}</fieldset>)}
      <div className="service-plan-actions"><button disabled={!writable} type="submit" className="journey-primary-button">保存自评</button><button type="button" className="journey-secondary-button" onClick={() => { setSelected(''); setAnswers({}); }}>取消</button></div>
    </form> : <div className="journey-service-grid">{definitions.map(item => <button type="button" key={item.id} onClick={() => { setSelected(item.id); setAnswers({}); setNotice(''); }}><b>{item.title}</b><small>{item.questions.length} 项问题</small></button>)}</div>}
    {!definitions.length && <p>暂未配置自评量表。</p>}
    {notice && <p role="status">{notice}</p>}
    {persistence.status !== 'ready' && <p role="status">当前自评尚未保存完成。<button type="button" onClick={persistence.retry}>重试保存</button></p>}
    {results.length > 0 && <details><summary>自评记录（{results.length}）</summary>{results.map(result => <article key={result.id}><b>{result.title}</b><p>{result.source && <>来源：{result.source} </>}{result.definitionVersion && <>版本：{result.definitionVersion}</>}</p>{result.resultLabel && <p><b>{result.resultLabel}</b>{result.resultDescription && <> · {result.resultDescription}</>}（仅供个人观察，不构成诊断）</p>}<p>{new Date(result.createdAt).toLocaleString('zh-CN')} · 总分 {result.score}</p><div className="service-plan-actions"><button type="button" className="journey-secondary-button" onClick={() => onAsk('我于' + result.createdAt.slice(0,10) + '完成“' + result.title + '”，总分' + result.score + '。我想了解如何进一步观察日常感受。')}>带记录咨询</button><button type="button" className="journey-danger-button" onClick={() => { if (window.confirm('确定删除这条自评记录吗？')) setStored(current => ({version:1, results: current.results.filter(item => item.id !== result.id)})); }}>删除</button></div></article>)}</details>}
  </section>;
}
