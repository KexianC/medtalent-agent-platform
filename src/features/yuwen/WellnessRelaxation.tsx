import { useCallback, useEffect, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, StopIcon, WindIcon, HeadphonesIcon } from '@phosphor-icons/react';
import { createLocalId } from '../../hooks/useDoctorLocalState';
import { useWellness } from './WellnessStore';
import { breathingPhase, formatPracticeTime } from './wellnessPractice';
import { meditationCourses } from './meditationCourses';

export function WellnessBreathing() {
  const { state, setState, readOnly } = useWellness();
  const [hold, setHold] = useState(false);
  const [minutes, setMinutes] = useState(1);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState('');
  const run = useRef<{ id: string; startedAt: number | null; elapsedMs: number; target: number; title: string; saved: boolean } | null>(null);
  const save = useCallback((completed: boolean) => {
    if (readOnly) return;
    const current = run.current;
    if (!current || current.saved) return;
    const seconds = Math.min(current.target, Math.floor((current.elapsedMs + (current.startedAt === null ? 0 : performance.now() - current.startedAt)) / 1000));
    current.saved = true;
    if (seconds < 1) return;
    setState(previous => ({ ...previous, sessions: [...previous.sessions, { id: current.id, kind: 'breathing', courseId: 'guided-breath', title: current.title, seconds, completedAt: new Date().toISOString(), completed }] }));
  }, [readOnly, setState]);
  const pause = useCallback(() => {
    const current = run.current;
    if (current?.startedAt !== null && current?.startedAt !== undefined) { current.elapsedMs += performance.now() - current.startedAt; current.startedAt = null; setElapsed(current.elapsedMs / 1000); }
    setRunning(false);
  }, []);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const current = run.current;
      if (!current || current.startedAt === null) return;
      const seconds = (current.elapsedMs + performance.now() - current.startedAt) / 1000;
      setElapsed(Math.min(seconds, current.target));
      if (seconds >= current.target) { save(true); current.elapsedMs = current.target * 1000; current.startedAt = null; setRunning(false); setMessage(readOnly ? '模板练习已结束，未保存时长；请先创建草稿。' : '本次练习已完成，时长已记录。'); }
    }, 100);
    return () => window.clearInterval(timer);
  }, [running, save, readOnly]);
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); save(false); };
  }, [pause, save]);
  function start() {
    if (!run.current || run.current.saved) run.current = { id: createLocalId('breath'), startedAt: null, elapsedMs: 0, target: minutes * 60, title: hold ? '4-4-6 呼吸练习' : '舒缓呼吸练习', saved: false };
    run.current.startedAt = performance.now(); setElapsed(run.current.elapsedMs / 1000); setMessage(''); setRunning(true);
  }
  function stop() { save(false); pause(); setMessage(readOnly ? '模板练习已结束，未保存时长；请先创建草稿。' : elapsed >= 1 ? '练习已结束，实际练习时长已记录。' : '练习已结束。'); }
  const phase = breathingPhase(elapsed, hold);
  const inProgress = Boolean(run.current && !run.current.saved);
  return <div className="yw-flow">
    <section className="yw-card"><span className="journey-eyebrow">BREATHE AT YOUR PACE</span><h2>跟着节奏，慢慢放松</h2><p>选择舒适的节奏，保持自然呼吸。停顿是可选的，任何时候都可以暂停或停止。</p>
      <div className="yw-form yw-inline-fields"><label>呼吸节奏<select value={hold ? 'hold' : 'gentle'} disabled={inProgress} onChange={event => setHold(event.target.value === 'hold')}><option value="gentle">吸气 4 秒 · 呼气 6 秒</option><option value="hold">吸气 4 秒 · 停顿 4 秒 · 呼气 6 秒</option></select></label><label>练习时长<select value={minutes} disabled={inProgress} onChange={event => setMinutes(Number(event.target.value))}><option value={1}>1 分钟</option><option value={3}>3 分钟</option><option value={5}>5 分钟</option></select></label></div>
      <div className={`yw-breathing ${running ? `is-running phase-${phase.text === '吸气' ? 'in' : phase.text === '呼气' ? 'out' : 'hold'}` : ''}`}><div className="yw-breath-orbit" aria-hidden="true" /><div className="yw-breath-label"><WindIcon size={30} /><b aria-live="polite" aria-atomic="true">{running ? phase.text : inProgress ? '已暂停' : '准备好了吗'}</b><strong>{running ? phase.remaining : formatPracticeTime(elapsed)}</strong></div></div>
      <p className="yw-center">已练习 {formatPracticeTime(elapsed)} / {formatPracticeTime(minutes * 60)}</p>
      <div className="yw-actions"><button className="journey-primary-button" onClick={running ? pause : start}>{running ? <PauseIcon size={19} /> : <PlayIcon size={19} />}{running ? '暂停练习' : inProgress ? '继续练习' : '开始练习'}</button>{inProgress && <button className="yw-button" onClick={stop}><StopIcon size={18} />结束</button>}</div>
      {message && <p role="status" className="yw-status">{message}</p>}
    </section>
    <PracticeHistory kind="breathing" />
    <p className="yw-footnote">离开练习页面会结束本次练习；切到后台会暂停计时。当前累计 {state.sessions.filter(item => item.kind === 'breathing').length} 次练习。</p>
  </div>;
}

type Course = typeof meditationCourses[number];
function MeditationPlayer({ course }: { course: Course }) {
  const { setState, readOnly } = useWellness();
  const audio = useRef<HTMLAudioElement>(null);
  const run = useRef({ id: createLocalId('meditation'), listened: 0, lastTime: 0, lastWall: performance.now(), saved: false, hasPlayed: false });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const record = useCallback((ended: boolean) => {
    if (readOnly) return;
    const current = run.current;
    if (current.saved || !current.hasPlayed) return;
    current.saved = true;
    const seconds = Math.min(86400, Math.floor(current.listened));
    if (seconds < 1) return;
    setState(previous => ({ ...previous, sessions: [...previous.sessions, { id: current.id, kind: 'meditation', courseId: course.id, title: course.title, seconds, completedAt: new Date().toISOString(), completed: ended && seconds >= course.seconds * .8 }] }));
  }, [course, readOnly, setState]);
  const tick = () => {
    const element = audio.current;
    if (!element) return;
    const current = run.current;
    const delta = element.currentTime - current.lastTime;
    const wall = performance.now();
    const wallDelta = Math.max(0, (wall - current.lastWall) / 1000);
    if (!element.seeking && delta > 0 && current.hasPlayed && !current.saved) current.listened += Math.min(delta, wallDelta + .05);
    current.lastWall = wall; current.lastTime = element.currentTime; setPosition(element.currentTime);
  };
  useEffect(() => {
    const element = audio.current;
    const onVisibility = () => { if (document.hidden) element?.pause(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); element?.pause(); record(false); };
  }, [record]);
  async function toggle() {
    const element = audio.current;
    if (!element) return;
    if (!element.paused) { element.pause(); return; }
    if (run.current.saved) { run.current = { id: createLocalId('meditation'), listened: 0, lastTime: 0, lastWall: performance.now(), saved: false, hasPlayed: false }; element.currentTime = 0; }
    setError(''); setMessage('');
    try { await element.play(); } catch { setError('音频暂时无法播放，请重试。也可以阅读下方引导文字。'); }
  }
  function finish() { tick(); audio.current?.pause(); record(false); setMessage(readOnly ? '模板聆听已结束，未保存时长；请先创建草稿。' : '本次聆听已结束，已记录实际播放时长。'); }
  return <section className="yw-card yw-player"><div className="yw-player-art"><HeadphonesIcon size={48} weight="duotone" /><span>合成语音引导</span></div><h3>{course.title}</h3><p>{course.description}</p>
    <audio ref={audio} preload="metadata" src={course.src} onPlay={() => { run.current.hasPlayed = true; run.current.lastTime = audio.current?.currentTime ?? 0; run.current.lastWall = performance.now(); setPlaying(true); }} onPause={() => { tick(); setPlaying(false); }} onTimeUpdate={tick} onSeeking={() => { run.current.lastTime = audio.current?.currentTime ?? 0; run.current.lastWall = performance.now(); }} onSeeked={() => { run.current.lastTime = audio.current?.currentTime ?? 0; run.current.lastWall = performance.now(); }} onEnded={() => { tick(); record(true); setPlaying(false); setMessage(readOnly ? '模板音频播放结束，未保存时长；请先创建草稿。' : '音频播放结束，已记录实际聆听时长。'); }} onError={() => { setPlaying(false); setError('音频加载失败，请重试或阅读引导文字。'); }} />
    <label className="yw-audio-progress">播放进度<input aria-label="冥想播放进度" type="range" min={0} max={course.seconds} step={1} value={Math.min(position, course.seconds)} onChange={event => { if (audio.current) { const next = Number(event.target.value); run.current.lastTime = next; audio.current.currentTime = next; setPosition(next); } }} /></label>
    <div className="yw-row"><time>{formatPracticeTime(position)}</time><time>{formatPracticeTime(course.seconds)}</time></div>
    <div className="yw-actions"><button className="journey-primary-button" onClick={toggle}>{playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}{playing ? '暂停播放' : '播放引导'}</button><button className="yw-button" onClick={finish} disabled={!run.current.hasPlayed || run.current.saved}><StopIcon size={18} />结束练习</button></div>
    {error && <p className="yw-error" role="alert">{error}</p>}{message && <p className="yw-status" role="status">{message}</p>}
    <details className="yw-transcript"><summary>阅读完整引导文字</summary><p>{course.transcript}</p></details>
    <p className="yw-footnote">原创练习 · 合成语音，非喻雯本人录音。请在安全、安静的环境中使用，可随时停止。拖动进度不会计入练习时长。</p>
  </section>;
}
export function WellnessMeditation() {
  const [selected, setSelected] = useState(meditationCourses[0].id);
  const [filter, setFilter] = useState('全部');
  const course = meditationCourses.find(item => item.id === selected) ?? meditationCourses[0];
  return <div className="yw-flow"><div className="yw-chips" aria-label="冥想分类">{['全部', ...new Set(meditationCourses.map(item => item.category))].map(category => <button key={category} className={filter === category ? 'is-active' : ''} aria-pressed={filter === category} onClick={() => setFilter(category)}>{category}</button>)}</div><div className="yw-course-list">{meditationCourses.filter(item => filter === '全部' || item.category === filter).map(item => <button className={`yw-course ${selected === item.id ? 'is-selected' : ''}`} key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><span><HeadphonesIcon size={23} /></span><div><b>{item.title}</b><small>{item.category} · {formatPracticeTime(item.seconds)}</small></div><PlayIcon size={18} /></button>)}</div><MeditationPlayer key={course.id} course={course} /><PracticeHistory kind="meditation" /></div>;
}
function PracticeHistory({ kind }: { kind: 'breathing' | 'meditation' }) {
  const { state, setState, readOnly } = useWellness();
  const sessions = state.sessions.filter(session => session.kind === kind).slice().reverse();
  return <section className="yw-card"><h3>我的练习记录</h3>{sessions.length ? <div className="yw-history">{sessions.slice(0, 20).map(session => <div key={session.id}><b>{session.title}</b><p>{new Date(session.completedAt).toLocaleString('zh-CN')} · {formatPracticeTime(session.seconds)} · {session.completed ? '已完成' : '本次练习'}</p><button className="yw-text-button" disabled={readOnly} onClick={() => { if (window.confirm('删除这条练习记录？')) setState(current => ({ ...current, sessions: current.sessions.filter(item => item.id !== session.id) })); }}>删除记录</button></div>)}</div> : <p className="yw-muted">完成一次练习后，在这里回看实际练习时长。</p>}</section>;
}
