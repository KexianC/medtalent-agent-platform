import { useEffect, useRef, useState } from 'react';
import { useConsumerSession } from '../../hooks/useConsumerSession';
import { ArrowLeft, ArrowRight, Check, ClipboardList, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { useWellness, WELLNESS_TEMPLATE_READ_ONLY_NOTICE } from './WellnessStore';
import type { AssessmentResult, PersonalityResult } from './types';
import {
  ASSESSMENT_MANUAL, ASSESSMENT_SOURCE, describeAssessment, PERSONALITY_DESCRIPTIONS, PERSONALITY_DIMENSIONS,
  PERSONALITY_QUESTIONS, pickWellnessCard, scoreAssessment, scorePersonality, WELLNESS_CARDS, WELLNESS_SCALES,
  type WellnessQuestion,
} from './assessmentModel';
import './wellness-assessments.css';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `yw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const displayDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '日期未知';
const newestFirst = (a: { createdAt: string }, b: { createdAt: string }) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);

function DeleteRecord({ onDelete, label }: { onDelete: () => void; label: string }) {
  const { readOnly } = useWellness();
  const [confirm, setConfirm] = useState(false);
  return confirm ? <div className="yw-a-delete-confirm"><span>删除这条记录？</span><button type="button" disabled={readOnly} onClick={onDelete}>确认删除</button><button type="button" onClick={() => setConfirm(false)}>取消</button></div>
    : <button type="button" className="yw-a-icon-button" aria-label={`删除${label}`} disabled={readOnly} onClick={() => setConfirm(true)}><Trash2 size={17} /></button>;
}

function Questionnaire({ title, description, questions, onComplete, onExit }: {
  title: string; description: string; questions: WellnessQuestion[]; onComplete: (answers: number[]) => void; onExit: () => void;
}) {
  const { readOnly } = useWellness();
  const [answers, setAnswers] = useState<(number | null)[]>(() => questions.map(() => null));
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const legend = useRef<HTMLLegendElement>(null);
  useEffect(() => { legend.current?.focus(); }, [index]);
  const question = questions[index];
  const answered = answers.filter(value => value !== null).length;
  const next = () => {
    if (answers[index] === null) { setError('请先选择本题的答案。'); return; }
    if (index < questions.length - 1) { setIndex(index + 1); setError(''); return; }
    const missing = answers.findIndex(value => value === null);
    if (missing !== -1) { setIndex(missing); setError('还有问题未作答，请补充后查看结果。'); return; }
    if (readOnly) { setError(WELLNESS_TEMPLATE_READ_ONLY_NOTICE); return; }
    if (submitted.current) return;
    submitted.current = true;
    onComplete(answers as number[]);
  };
  return <section className="yw-a-panel yw-a-questionnaire" aria-label={title}>
    <div className="yw-a-row"><h3>{title}</h3><span className="yw-a-badge">{index + 1} / {questions.length}</span></div>
    <p className="yw-a-muted">{description}</p>
    <progress max={questions.length} value={answered} aria-label={`已答 ${answered} 题，共 ${questions.length} 题`} />
    <fieldset className="yw-a-question" key={index}>
      <legend ref={legend} tabIndex={-1}><span>第 {index + 1} 题</span>{question.text}</legend>
      <div className="yw-a-options">{question.options.map((option, optionIndex) => <label key={option} className={answers[index] === optionIndex ? 'is-selected' : ''}>
        <input type="radio" name={`wellness-question-${index}`} value={optionIndex} checked={answers[index] === optionIndex} onChange={() => { setAnswers(previous => previous.map((value, answerIndex) => answerIndex === index ? optionIndex : value)); setError(''); }} />
        <span>{option}</span>{answers[index] === optionIndex && <Check size={17} aria-hidden="true" />}
      </label>)}</div>
    </fieldset>
    {error && <p className="yw-a-error" role="alert">{error}</p>}
    <div className="yw-a-question-actions"><button type="button" className="yw-a-secondary" disabled={index === 0} onClick={() => { setIndex(index - 1); setError(''); }}><ArrowLeft size={16} />上一题</button>
      <button type="button" className="yw-a-primary" disabled={readOnly && index === questions.length - 1} onClick={next}>{index === questions.length - 1 ? '查看结果' : '下一题'}<ArrowRight size={16} /></button></div>
    <button type="button" className="yw-a-text-button" onClick={onExit}>退出答题（不保存）</button>
  </section>;
}

function AssessmentResultCard({ result, previous, onRepeat }: { result: AssessmentResult; previous?: AssessmentResult; onRepeat: () => void }) {
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { resultHeading.current?.focus(); }, [result.id]);
  const scale = WELLNESS_SCALES.find(item => item.id === result.scaleId)!;
  const description = describeAssessment(result.scaleId, result.score)!;
  const difference = previous ? result.score - previous.score : 0;
  return <section className="yw-a-panel yw-a-result" aria-label="自评结果">
    <span className="yw-a-eyebrow">本次自评 · {displayDate(result.createdAt)}</span><h3 ref={resultHeading} tabIndex={-1}>{result.title}</h3>
    <div className="yw-a-score"><strong>{result.score}</strong><span>/ {result.maxScore} 分</span></div>
    <h4>{description.label}</h4><p>{description.text}</p>
    <p className="yw-a-comparison">{previous ? `与上次同量表（${displayDate(previous.createdAt)}）相比，${difference === 0 ? '分数相同' : `${difference > 0 ? '增加' : '减少'} ${Math.abs(difference)} 分`}。仅呈现分数变化。` : '首次记录。之后可在这里查看同量表的分数变化。'}</p>
    <details className="yw-a-details"><summary>查看本次回答与计分说明</summary><ol>{scale.questions.map((question, index) => <li key={question.text}><span>{question.text}</span><strong>{question.options[result.answers[index]]}{index < scale.scoredItems ? ` · ${result.answers[index]} 分` : ' · 不计分'}</strong></li>)}</ol>
      <p>{scale.id === 'gad7' ? '前 7 题每题 0–3 分，相加得到 0–21 分；补充生活影响题不计分。5、10、15 分分别是轻、中、重度症状范围的分界。' : '2 题每题 0–3 分，相加得到 0–6 分；3 分是进一步完整评估的参考分值，不作为病情严重程度分级。'}</p></details>
    <button type="button" className="yw-a-secondary" onClick={onRepeat}><RotateCcw size={16} />重新自评</button>
  </section>;
}

export function WellnessAssessment() {
  const account = useConsumerSession();
  const { state, setState, readOnly } = useWellness();
  const [activeScale, setActiveScale] = useState<string | null>(null);
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [consentError, setConsentError] = useState('');
  const [filter, setFilter] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const history = state.assessments.filter(result => {
    const computed = scoreAssessment(result.scaleId, result.answers);
    return computed && computed.score === result.score && computed.maxScore === result.maxScore;
  }).sort(newestFirst);
  const result = history.find(item => item.id === selectedResult);
  const sameScale = result ? history.filter(item => item.scaleId === result.scaleId) : [];
  const previous = result ? sameScale[sameScale.findIndex(item => item.id === result.id) + 1] : undefined;
  const filteredHistory = history.filter(item => filter === 'all' || item.scaleId === filter);
  const scale = WELLNESS_SCALES.find(item => item.id === activeScale);
  const start = (id: string) => {
    if (!readOnly && !consent) { setConsentError('请先阅读并勾选下方自评说明。'); return; }
    setActiveScale(id); setSelectedResult(null); setConsentError('');
  };
  const finish = (answers: number[]) => {
    if (readOnly) { setConsentError(WELLNESS_TEMPLATE_READ_ONLY_NOTICE); return; }
    const computed = scoreAssessment(scale!.id, answers);
    if (!computed) return;
    const entry: AssessmentResult = { id: newId(), scaleId: scale!.id, title: scale!.title, answers, ...computed, createdAt: new Date().toISOString() };
    setState(previousState => ({ ...previousState, assessments: [entry, ...previousState.assessments] }));
    setSelectedResult(entry.id); setActiveScale(null);
  };
  return <div className="yw-assessments">
    <div className="yw-a-heading"><ClipboardList size={22} /><div><h2>心理自评</h2><p>用一份记录，了解近两周的自己</p></div></div>
    {scale ? <Questionnaire key={scale.id} title={scale.title} description="过去 2 周内，下列问题是如何困扰你的？请选择最符合实际情况的一项。" questions={scale.questions} onComplete={finish} onExit={() => setActiveScale(null)} /> : <>
      {result && <AssessmentResultCard result={result} previous={previous} onRepeat={() => { setConsent(true); setActiveScale(result.scaleId); setSelectedResult(null); }} />}
      <section className="yw-a-panel">
        <p className="yw-a-muted">面向 18 岁及以上成人的自我记录。自评只提供筛查参考，不能代替专业诊断或治疗，也不能用于判断是否需要自行调整药物。若困扰持续或影响生活，可与专业人员讨论。</p>
        <label className="yw-a-consent"><input type="checkbox" disabled={readOnly} checked={consent} onChange={event => { setConsent(event.target.checked); setConsentError(''); }} /><span>我已满 18 岁，了解上述说明，并同意{readOnly ? '创建草稿后再保存自评记录' : account.user ? '将本次自评记录保存到微信账户' : '在当前设备保存本次自评记录'}。</span></label>
        {consentError && <p className="yw-a-error" role="alert">{consentError}</p>}
        <div className="yw-a-scale-list">{WELLNESS_SCALES.map(item => <div className="yw-a-scale" key={item.id}><div><h3>{item.title}</h3><p>{item.subtitle}</p><small>{item.duration} · {item.scoredItems} 道计分题{item.id === 'gad7' ? ' + 1 道补充题' : ''}</small></div><button type="button" className="yw-a-primary" onClick={() => start(item.id)}>开始自评<ArrowRight size={16} /></button></div>)}</div>
      </section>
    </>}
    {!scale && <section className="yw-a-panel">
      <div className="yw-a-row"><h3>自评历史</h3><label className="yw-a-filter"><span className="yw-a-sr-only">筛选量表</span><select value={filter} onChange={event => { setFilter(event.target.value); setShowAll(false); }}><option value="all">全部量表</option>{WELLNESS_SCALES.map(item => <option value={item.id} key={item.id}>{item.id.toUpperCase()}</option>)}</select></label></div>
      {!filteredHistory.length ? <p className="yw-a-empty">还没有{filter === 'all' ? '' : ` ${filter.toUpperCase()} `}自评记录。完成后可查看得分与历史对比。</p> : <ul className="yw-a-history">{filteredHistory.slice(0, showAll ? undefined : 8).map(item => <li key={item.id}><button type="button" className="yw-a-history-open" onClick={() => setSelectedResult(item.id)}><strong>{item.title}</strong><span>{displayDate(item.createdAt)} · {item.score} / {item.maxScore} 分</span><small>查看回答与对比</small></button><DeleteRecord label={`${item.title}记录`} onDelete={() => { setState(previousState => ({ ...previousState, assessments: previousState.assessments.filter(entry => entry.id !== item.id) })); if (selectedResult === item.id) setSelectedResult(null); }} /></li>)}</ul>}
      {filteredHistory.length > 8 && <button type="button" className="yw-a-text-button" onClick={() => setShowAll(!showAll)}>{showAll ? '收起记录' : `查看全部 ${filteredHistory.length} 条记录`}</button>}
    </section>}
    <details className="yw-a-source"><summary>量表来源与使用说明</summary><p>GAD-7 与 PHQ 由 Robert L. Spitzer、Janet B.W. Williams、Kurt Kroenke 等开发，获 Pfizer 教育资助。PHQ-2 取 PHQ-9 前两题。</p><p>简体中文题干：Fu KY、Yap AU、Lei J、Liu MQ、Fan XF 译，INfORM 中文评价工具第 50、52 页。原页面注明可免费复制、翻译、展示与分发。</p><a href={ASSESSMENT_SOURCE} target="_blank" rel="noreferrer">查看简体中文原文</a><a href={ASSESSMENT_MANUAL} target="_blank" rel="noreferrer">查看 Pfizer 计分手册</a><p>分数只与同一量表比较；不同量表的得分不能直接比较。当前页面不会向医生发送结果。</p></details>
  </div>;
}

function PersonalityResultCard({ result }: { result: PersonalityResult }) {
  const resultHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { resultHeading.current?.focus(); }, [result.id]);
  const description = PERSONALITY_DESCRIPTIONS[result.type];
  return <section className="yw-a-panel yw-a-result" aria-label="人格探索结果"><span className="yw-a-eyebrow">本次偏好 · {displayDate(result.createdAt)}</span>
    <div className="yw-a-personality-type">{result.type}</div><h3 ref={resultHeading} tabIndex={-1}>{description.title}</h3><p>{description.description}</p>
    <div className="yw-a-dimensions">{PERSONALITY_DIMENSIONS.map(dimension => {
      const first = result.dimensions[dimension.key];
      return <div key={dimension.key}><span className="yw-a-dimension-title">{dimension.title}</span><div className="yw-a-row"><span>{dimension.first} {dimension.firstLabel} {first}%</span><span>{100 - first}% {dimension.secondLabel} {dimension.second}</span></div><div className="yw-a-dimension-bar" role="img" aria-label={`${dimension.title}：${dimension.firstLabel} ${first}%，${dimension.secondLabel} ${100 - first}%`}><span style={{ width: `${first}%` }} /></div></div>;
    })}</div><p className="yw-a-muted">百分比表示本次 5 道相关题目中两侧选项的占比，不是人格强度或心理测量常模。</p><p className="yw-a-comparison">一个小练习：{description.practice}</p>
    <p className="yw-a-muted">自编题目，仅作 MBTI 风格的趣味偏好探索；未经心理测量验证，不属于正式 MBTI 测评。偏好会随情境变化，不用于诊疗、择业或给自己和他人定型。</p>
  </section>;
}

export function WellnessPersonality() {
  const account = useConsumerSession();
  const { state, setState, readOnly } = useWellness();
  const [running, setRunning] = useState(false);
  const [selectedResult, setSelectedResult] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const history = state.personalities.filter(result => Object.prototype.hasOwnProperty.call(PERSONALITY_DESCRIPTIONS, result.type) && result.dimensions && PERSONALITY_DIMENSIONS.every(dimension => Number.isInteger(result.dimensions[dimension.key]) && result.dimensions[dimension.key] >= 0 && result.dimensions[dimension.key] <= 100)).sort(newestFirst);
  const result = history.find(item => item.id === selectedResult) ?? (selectedResult === null ? history[0] : undefined);
  return <div className="yw-assessments">
    <div className="yw-a-heading"><Sparkles size={22} /><div><h2>MBTI 趣味探索</h2><p>认识偏好，也给变化留一点空间</p></div></div>
    {running ? <Questionnaire title="20 题人格偏好探索" description="以下题目为原创趣味问答。没有好坏或标准答案，请选择平时更接近自己的一项。" questions={PERSONALITY_QUESTIONS} onExit={() => setRunning(false)} onComplete={answers => {
      if (readOnly) return;
      const computed = scorePersonality(answers);
      if (!computed) return;
      const entry: PersonalityResult = { id: newId(), ...computed, createdAt: new Date().toISOString() };
      setState(previousState => ({ ...previousState, personalities: [entry, ...previousState.personalities] })); setSelectedResult(entry.id); setRunning(false);
    }} /> : <>
      <section className="yw-a-panel"><h3>20 个生活里的小选择</h3><p>从精力来源、关注信息、做决定和安排生活四个角度，看看此刻的自己更接近哪一种偏好。</p><p className="yw-a-muted">自编题目，仅作 MBTI 风格趣味探索，未经心理测量验证，不属于正式 MBTI 测评。约 3–5 分钟，{readOnly ? '模板只读预览，创建草稿后可保存结果' : account.user ? '将结果同步到微信账户' : '在当前设备保存结果'}。</p><button type="button" className="yw-a-primary" onClick={() => setRunning(true)}>{history.length ? <RotateCcw size={16} /> : <Sparkles size={16} />}{history.length ? '重新探索' : '开始探索'}</button></section>
      {result && <PersonalityResultCard result={result} />}
      <section className="yw-a-panel"><h3>探索历史</h3>{!history.length ? <p className="yw-a-empty">完成问答后，会在这里留下属于你的偏好记录。</p> : <ul className="yw-a-history">{history.slice(0, showAll ? undefined : 8).map(item => <li key={item.id}><button type="button" className="yw-a-history-open" onClick={() => setSelectedResult(item.id)}><strong>{item.type} · {PERSONALITY_DESCRIPTIONS[item.type].title}</strong><span>{displayDate(item.createdAt)}</span></button><DeleteRecord label={`${item.type}探索记录`} onDelete={() => { setState(previousState => ({ ...previousState, personalities: previousState.personalities.filter(entry => entry.id !== item.id) })); if (selectedResult === item.id) setSelectedResult(null); }} /></li>)}</ul>}{history.length > 8 && <button type="button" className="yw-a-text-button" onClick={() => setShowAll(!showAll)}>{showAll ? '收起记录' : `查看全部 ${history.length} 条记录`}</button>}</section>
      <details className="yw-a-source"><summary>看看全部 16 种偏好</summary><div className="yw-a-type-list">{Object.entries(PERSONALITY_DESCRIPTIONS).map(([type, item]) => <details key={type}><summary>{type} · {item.title}</summary><p>{item.description}</p></details>)}</div></details>
    </>}
  </div>;
}

export function WellnessCards() {
  const account = useConsumerSession();
  const { state, setState, readOnly } = useWellness();
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const cardHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (currentId) cardHeading.current?.focus(); }, [currentId]);
  const history = state.cardDraws.filter(draw => WELLNESS_CARDS.some(card => card.id === draw.cardId)).sort(newestFirst);
  const current = history.find(draw => draw.id === currentId);
  const card = WELLNESS_CARDS.find(item => item.id === current?.cardId);
  const draw = () => {
    if (readOnly) return;
    const entry = { id: newId(), cardId: pickWellnessCard().id, createdAt: new Date().toISOString() };
    setState(previousState => ({ ...previousState, cardDraws: [entry, ...previousState.cardDraws] })); setCurrentId(entry.id);
  };
  return <div className="yw-assessments">
    <div className="yw-a-heading"><Sparkles size={22} /><div><h2>趣味抽卡</h2><p>翻开一张卡，留一个温柔的小思考</p></div></div>
    <p className="yw-a-card-notice">8 张象征卡，每次随机抽取，带来一个日常反思的小提示。仅供娱乐，不用于预测未来、健康或作出重要决定。</p>
    <section className={`yw-a-card-stage ${card ? 'is-revealed' : ''}`} aria-live="polite">
      {card ? <><span className="yw-a-card-symbol" aria-hidden="true">{card.symbol}</span><span className="yw-a-eyebrow">你翻开的象征卡</span><h3 ref={cardHeading} tabIndex={-1}>{card.name}</h3><h4>{card.theme}</h4><p>{card.text}</p><div className="yw-a-card-action">{card.action}</div></>
        : <><span className="yw-a-card-symbol" aria-hidden="true">✧</span><h3>为此刻留一点空间</h3><p>8 张卡，8 个日常思考的方向。<br />没有吉凶，也没有命定的答案。</p></>}
      <button type="button" className="yw-a-primary" disabled={readOnly} onClick={draw}><Sparkles size={17} />{card ? '再抽一张' : '翻开一张卡'}</button>
      <small>每张卡机会相同 · 可能重复抽到</small>
    </section>
    <section className="yw-a-panel"><h3>抽卡记录</h3>{!history.length ? <p className="yw-a-empty">{readOnly ? WELLNESS_TEMPLATE_READ_ONLY_NOTICE : '翻开的卡会'}{readOnly ? '' : account.user ? '同步到微信账户，完成后可跨设备查看' : '保存在当前设备，随时可以回来看看'}。</p> : <ul className="yw-a-history">{history.slice(0, showAll ? undefined : 8).map(item => {
      const itemCard = WELLNESS_CARDS.find(entry => entry.id === item.cardId)!;
      return <li key={item.id}><button type="button" className="yw-a-history-open" onClick={() => setCurrentId(item.id)}><strong>{itemCard.name} · {itemCard.theme}</strong><span>{displayDate(item.createdAt)}</span></button><DeleteRecord label={`${itemCard.name}抽卡记录`} onDelete={() => { setState(previousState => ({ ...previousState, cardDraws: previousState.cardDraws.filter(entry => entry.id !== item.id) })); if (currentId === item.id) setCurrentId(null); }} /></li>;
    })}</ul>}{history.length > 8 && <button type="button" className="yw-a-text-button" onClick={() => setShowAll(!showAll)}>{showAll ? '收起记录' : `查看全部 ${history.length} 条记录`}</button>}</section>
  </div>;
}
