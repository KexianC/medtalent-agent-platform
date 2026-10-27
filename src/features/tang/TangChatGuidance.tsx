import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, ClipboardList, Heart, RotateCcw, X } from 'lucide-react';
import { createLocalId, useDoctorLocalState, type DoctorPrivacySettings } from '../../hooks/useDoctorLocalState';
import { useConsumerSession } from '../../hooks/useConsumerSession';
import { ASSESSMENT_SOURCE, ASSESSMENT_MANUAL } from '../yuwen/assessmentModel';
import {
  buildTangAssessmentMessage, buildTangMoodMessage, createTangAssessmentResult,
  normalizeTangResults, TANG_ASSESSMENT_SECTION, TANG_MOODS, TANG_SCALES, TANG_RESULT_SCALES,
  TANG_SUPPLEMENT_LIMIT, normalizeTangSupplement, updateTangAssessmentSupplement,
  describeTangAssessment, needsPhq9Support, PHQ9_SUPPORT, type TangScale, type TangAssessmentResult,
} from './guidanceModel';
import './tang-chat-guidance.css';

type TangChatGuidanceProps = {
  disabled: boolean;
  onSend: (text: string) => Promise<boolean> | boolean;
};

function TangQuestionnaire({ scale, onComplete, onCancel }: {
  scale: TangScale;
  onComplete: (answers: number[]) => void;
  onCancel: () => void;
}) {
  const [answers, setAnswers] = useState<(number | null)[]>(() => scale.questions.map(() => null));
  const [index, setIndex] = useState(0);
  const questionHeading = useRef<HTMLLegendElement>(null);
  const completed = useRef(false);
  const radioId = useId();
  const question = scale.questions[index];
  const answered = answers.filter(value => value !== null).length;

  useEffect(() => { questionHeading.current?.focus({ preventScroll: true }); }, [index]);

  const next = () => {
    if (answers[index] === null || completed.current) return;
    if (index < scale.questions.length - 1) { setIndex(current => current + 1); return; }
    const missing = answers.findIndex(answer => answer === null);
    if (missing !== -1) { setIndex(missing); return; }
    completed.current = true;
    onComplete(answers as number[]);
  };

  return <section className="tang-guide-quiz" aria-label={scale.title}>
    <div className="tang-guide-row"><strong>{scale.title}</strong><span className="tang-guide-step">{index + 1} / {scale.questions.length}</span></div>
    <p className="tang-guide-caption">{index < scale.scoredItems ? '回顾过去 2 周（14 天），按每种感受出现的频率选择最符合你的选项；不只看今天或最严重的一天。每题选一项。' : '生活影响补充题：选择这些感受对工作、家务和人际相处造成的困难程度。本题不计入总分。'}</p>
    <progress max={scale.questions.length} value={answered} aria-label={`已完成 ${answered} 题，共 ${scale.questions.length} 题`} />
    <fieldset className="tang-guide-question" key={index}>
      <legend ref={questionHeading} tabIndex={-1}>{question.text}</legend>
      <div className="tang-guide-options">{question.options.map((option, optionIndex) => <label key={option} className={answers[index] === optionIndex ? 'is-selected' : ''}>
        <input type="radio" name={`${radioId}-${index}`} checked={answers[index] === optionIndex} value={optionIndex} onChange={() => setAnswers(current => current.map((answer, answerIndex) => answerIndex === index ? optionIndex : answer))} />
        <span>{option}</span>
      </label>)}</div>
    </fieldset>
    {needsPhq9Support(scale.id, answers) && <p className="tang-guide-feedback" role="alert">{PHQ9_SUPPORT}</p>}
    <div className="tang-guide-actions">
      <button type="button" className="tang-guide-secondary" disabled={index === 0} onClick={() => setIndex(current => current - 1)}><ArrowLeft size={15} aria-hidden="true" />上一题</button>
      <button type="button" className="tang-guide-primary" disabled={answers[index] === null} onClick={next}>{index === scale.questions.length - 1 ? '查看结果' : '下一题'}<ArrowRight size={15} aria-hidden="true" /></button>
    </div>
    <button type="button" className="tang-guide-text" onClick={onCancel}><X size={14} aria-hidden="true" />取消本次答题</button>
  </section>;
}

function TangResult({ result, storageNotice, disabled, onDiscuss, onSaveSupplement, onRepeat, onClose }: {
  result: TangAssessmentResult;
  storageNotice: string;
  disabled: boolean;
  onDiscuss: (includeSupplement: boolean) => void;
  onSaveSupplement: (supplement: string) => boolean;
  onRepeat: () => void;
  onClose: () => void;
}) {
  const scale = TANG_RESULT_SCALES.find(item => item.id === result.scaleId)!;
  const heading = useRef<HTMLHeadingElement>(null);
  const noteId = useId();
  const [draft, setDraft] = useState(result.supplement || '');
  const [includeSupplement, setIncludeSupplement] = useState(false);
  const [noteFeedback, setNoteFeedback] = useState('');
  const dirty = draft !== (result.supplement || '');
  const tooLong = draft.length > TANG_SUPPLEMENT_LIMIT;
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [result.id]);
  const saveSupplement = () => {
    if (tooLong || !onSaveSupplement(draft)) { setNoteFeedback(`补充描述最多 ${TANG_SUPPLEMENT_LIMIT} 字，请缩短后保存。`); return; }
    setDraft(normalizeTangSupplement(draft));
    setIncludeSupplement(false);
    setNoteFeedback('补充描述已更新，不计入分数。');
  };
  return <section className="tang-guide-result" aria-label="心理自评结果">
    <div className="tang-guide-row"><h3 ref={heading} tabIndex={-1}>{scale.title}</h3><button type="button" className="tang-guide-close" aria-label="返回对话引导" onClick={onClose}><X size={17} aria-hidden="true" /></button></div>
    <p className="tang-guide-result-score"><strong>{result.score}</strong><span> / {result.maxScore} 分</span></p>
    <p className="tang-guide-caption"><strong>{describeTangAssessment(result.scaleId, result.score)?.label}</strong>。{describeTangAssessment(result.scaleId, result.score)?.text}</p>
    {needsPhq9Support(result.scaleId, result.answers) && <p className="tang-guide-feedback" role="alert">{PHQ9_SUPPORT}</p>}
    <p className="tang-guide-caption">这是对近两周感受的自我记录，不能用于诊断。若困扰持续或影响生活，可以寻求专业支持。</p>
    <details className="tang-guide-answers"><summary>查看回答与计分</summary><ol>{scale.questions.map((question, index) => <li key={question.text}><span>{question.text}</span><strong>{question.options[result.answers[index]]}{index < scale.scoredItems ? ` · ${result.answers[index]} 分` : ' · 不计分'}</strong></li>)}</ol><p>{scale.scoredItems} 道计分题，每题 0–3 分，相加得到总分。{scale.questions.length > scale.scoredItems ? '生活影响补充题不计入总分。' : ''}</p></details>
    <div className="tang-guide-supplement">
      <label htmlFor={noteId}><strong>补充描述（选填，不计分）</strong></label>
      <p id={`${noteId}-hint`} className="tang-guide-caption">可以写下发生了什么、感受何时出现，或哪些情况让你舒服一些。可跳过，补充内容不会改变量表得分。</p>
      <textarea id={noteId} value={draft} maxLength={TANG_SUPPLEMENT_LIMIT} rows={4} aria-describedby={`${noteId}-hint ${noteId}-count`} onChange={event => { setDraft(event.target.value); setIncludeSupplement(false); setNoteFeedback(''); }} placeholder="例如：最近工作压力较大，晚上容易反复想白天的事…" />
      <p id={`${noteId}-count`} className="tang-guide-private">{draft.length} / {TANG_SUPPLEMENT_LIMIT} 字{dirty ? ' · 尚未保存，请先保存或取消修改，再聊聊结果。' : ''}</p>
      {dirty && <div className="tang-guide-actions"><button type="button" className="tang-guide-secondary" onClick={() => { setDraft(result.supplement || ''); setIncludeSupplement(false); setNoteFeedback('已取消补充修改。'); }}>取消修改</button><button type="button" className="tang-guide-primary" disabled={tooLong} onClick={saveSupplement}>保存补充</button></div>}
      <label className="tang-guide-share-note"><input type="checkbox" checked={includeSupplement} disabled={!result.supplement || dirty} onChange={event => setIncludeSupplement(event.target.checked)} /><span>将已保存的补充描述一起发到对话</span></label>
      <p className="tang-guide-private">补充描述默认不发送。仅勾选上方选项并点击“聊聊结果”后发送，可随时编辑或清空。</p>
      {noteFeedback && <p className="tang-guide-private" role="status">{noteFeedback}</p>}
    </div>
    <p className="tang-guide-private">{storageNotice}点击“聊聊结果”才会把分数、生活影响及 PHQ-9 第 9 题回答摘要发到对话。</p>
    <div className="tang-guide-actions"><button type="button" className="tang-guide-secondary" onClick={onRepeat}><RotateCcw size={15} aria-hidden="true" />重新自评</button><button type="button" className="tang-guide-primary" disabled={disabled || dirty} onClick={() => onDiscuss(includeSupplement)}>聊聊结果<ArrowRight size={15} aria-hidden="true" /></button></div>
  </section>;
}

export function TangChatGuidance({ disabled, onSend }: TangChatGuidanceProps) {
  const account = useConsumerSession();
  const [privacy] = useDoctorLocalState<DoctorPrivacySettings>('tang-jinsong', 'privacy', { saveChat: true, voicePlayback: true, reminders: true });
  const [storedResults, setStoredResults, persistence] = useDoctorLocalState<TangAssessmentResult[]>('tang-jinsong', TANG_ASSESSMENT_SECTION, [], privacy.saveChat);
  const [sessionResults, setSessionResults] = useState<TangAssessmentResult[]>([]);
  const [expanded, setExpanded] = useState(true);
  const [showScales, setShowScales] = useState(false);
  const [activeScale, setActiveScale] = useState<TangScale | null>(null);
  const [result, setResult] = useState<TangAssessmentResult | null>(null);
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [selectedMood, setSelectedMood] = useState<string | null>(null);
  const sendLock = useRef(false);
  const previousResult = useRef<TangAssessmentResult | null>(null);
  const contentId = useId();
  const results = useMemo(() => normalizeTangResults(privacy.saveChat ? storedResults : sessionResults), [privacy.saveChat, storedResults, sessionResults]);

  useEffect(() => {
    setSessionResults([]);
    setResult(null);
    setActiveScale(null);
    setSelectedMood(null);
    setFeedback('');
    previousResult.current = null;
  }, [account.user?.id]);

  useEffect(() => {
    if (!privacy.saveChat) {
      setStoredResults([]);
      setSessionResults([]);
      setResult(null);
      previousResult.current = null;
    }
  }, [privacy.saveChat, setStoredResults]);

  const send = async (message: string | null, moodId?: string) => {
    if (!message || disabled || sendLock.current) return;
    sendLock.current = true;
    setSending(true);
    setFeedback('');
    try {
      const accepted = await onSend(message);
      if (!accepted) { setFeedback('暂时没能发送，请稍后再试。'); return; }
      if (moodId) setSelectedMood(moodId);
      setExpanded(false);
    } catch {
      setFeedback('暂时没能发送，请稍后再试。');
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  };

  const start = (scale: TangScale) => { previousResult.current = result; setActiveScale(scale); setResult(null); setFeedback(''); };
  const saveSupplement = (supplement: string) => {
    if (!result) return false;
    const updated = updateTangAssessmentSupplement(result, supplement);
    if (!updated) return false;
    if (privacy.saveChat) setStoredResults(current => normalizeTangResults([updated, ...normalizeTangResults(current).filter(entry => entry.scaleId !== updated.scaleId)]));
    else setSessionResults(current => normalizeTangResults([updated, ...current.filter(entry => entry.scaleId !== updated.scaleId)]));
    setResult(updated);
    return true;
  };
  const finish = (answers: number[]) => {
    if (!activeScale) return;
    const entry = createTangAssessmentResult(activeScale.id, answers, createLocalId('tang-assessment'), new Date().toISOString());
    if (!entry) return;
    if (privacy.saveChat) setStoredResults(current => normalizeTangResults([entry, ...normalizeTangResults(current)]));
    else setSessionResults(current => normalizeTangResults([entry, ...current]));
    setActiveScale(null);
    setShowScales(false);
    setResult(entry);
  };
  const pending = disabled || sending;
  const storageNotice = !privacy.saveChat ? '仅在本次页面中保留。' : persistence.storage === 'cloud'
    ? persistence.status === 'ready' ? '已保存到微信账户，可跨设备查看。'
      : persistence.cloudStatus === 'conflict' ? '结果与云端记录有冲突，请到“我的”选择保留版本。'
        : ['pending', 'saving', 'loading'].includes(persistence.cloudStatus || '') ? '正在同步到微信账户，完成后可跨设备查看。'
          : '结果尚未同步到微信账户，请到“我的”重试同步。'
    : persistence.status === 'ready' ? '已保存在当前设备。' : '结果仅保留在本次页面中，尚未保存到本机。';

  return <section className={`tang-chat-guidance${expanded ? ' is-expanded' : ''}`} aria-label="对话引导">
    <button type="button" className="tang-guide-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(current => !current)}>
      <span><Heart size={16} aria-hidden="true" /><strong>{expanded ? '从此刻的感受开始' : activeScale ? '继续心理自评' : '心情记录 · 心理自评'}</strong></span>
      <span className="tang-guide-toggle-label">{expanded ? '收起' : '展开'}{expanded ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}</span>
    </button>
    <div id={contentId} hidden={!expanded} className="tang-guide-content">
      {activeScale ? <TangQuestionnaire key={activeScale.id} scale={activeScale} onComplete={finish} onCancel={() => { setActiveScale(null); setResult(previousResult.current); setShowScales(!previousResult.current); }} />
        : result ? <TangResult key={result.id} result={result} storageNotice={storageNotice} disabled={pending} onSaveSupplement={saveSupplement} onDiscuss={includeSupplement => void send(buildTangAssessmentMessage(result, includeSupplement))} onRepeat={() => start(TANG_SCALES.find(scale => scale.id === (result.scaleId === 'phq2' ? 'phq9' : result.scaleId))!)} onClose={() => setResult(null)} />
          : showScales ? <div className="tang-guide-scales">
            <div className="tang-guide-row"><strong>用一份短问卷了解自己</strong><button type="button" className="tang-guide-close" aria-label="返回心情选择" onClick={() => setShowScales(false)}><X size={17} aria-hidden="true" /></button></div>
            <p className="tang-guide-caption">面向 18 岁及以上成人，回顾近两周的感受。自评不能代替专业诊断。</p>
            <p className="tang-guide-private">量表来源：<a href={ASSESSMENT_SOURCE} target="_blank" rel="noreferrer">中文量表</a> · <a href={ASSESSMENT_MANUAL} target="_blank" rel="noreferrer">计分说明</a></p>
            <div className="tang-guide-scale-list">{TANG_SCALES.map(scale => <button type="button" key={scale.id} onClick={() => start(scale)}><span><strong>{scale.title}</strong><small>{scale.duration} · {scale.scoredItems} 题{scale.questions.length > scale.scoredItems ? ' + 1 道补充题' : ''}</small></span><ArrowRight size={16} aria-hidden="true" /></button>)}</div>
            <p className="tang-guide-private">{privacy.saveChat ? account.user ? '完成后同步到微信账户，可在“我的”关闭保存。' : '完成后保存在当前设备，可在“我的”关闭保存。' : '已关闭保存记录，问卷只在本次页面中保留。'}结果由你决定是否发到对话。</p>
          </div>
            : <>
              <p className="tang-guide-caption">今天心情怎么样？选一个，我们慢慢聊。</p>
              <div className="tang-guide-moods" role="group" aria-label="选择今天的心情并开始对话">{TANG_MOODS.map(mood => <button type="button" key={mood.id} disabled={pending} aria-pressed={selectedMood === mood.id} onClick={() => void send(buildTangMoodMessage(mood.id), mood.id)}><span className="tang-guide-mood-symbol" aria-hidden="true">{mood.symbol}</span><span>{mood.label}</span></button>)}</div>
              <button type="button" className="tang-guide-assess-link" onClick={() => setShowScales(true)}><span><ClipboardList size={17} aria-hidden="true" /><strong>做个心理自评</strong><small>约 2–3 分钟</small></span><ArrowRight size={16} aria-hidden="true" /></button>
              {results.length > 0 && <div className="tang-guide-recent"><span>最近自评</span>{results.map(entry => <button type="button" key={entry.id} onClick={() => { setResult(entry); setFeedback(''); }}>{entry.scaleId.toUpperCase().replace('GAD7', 'GAD-7').replace('PHQ2', 'PHQ-2（历史）').replace('PHQ9', 'PHQ-9')} · {entry.score}/{entry.maxScore} 分<ArrowRight size={12} aria-hidden="true" /></button>)}</div>}
            </>}
      {feedback && <p className="tang-guide-feedback" role="alert">{feedback}</p>}
      {sending && <p className="tang-guide-private" role="status">正在发送到对话…</p>}
      {privacy.saveChat && persistence.status !== 'ready' && results.length > 0 && <p className="tang-guide-feedback" role="status">{storageNotice}</p>}
    </div>
  </section>;
}
