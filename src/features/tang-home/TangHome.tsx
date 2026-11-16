import { useRef, useState, type ReactNode } from 'react';
import type { DoctorProfile } from '../../data/doctorProfiles';
import './tang-home.css';

export type TangHomeAction = '病友信息' | '人工咨询' | '科普宣教' | '量表测试' | '报告解读' | '睡眠日记' | '情绪预警' | '放松练习' | '就诊准备' | '练习打卡' | '预约挂号' | '复诊开方' | '报告查询' | '更多服务' | '专家介绍';
const groups: { title: string; items: [TangHomeAction, string][] }[] = [
  { title: '常用功能', items: [['病友信息', '📒'], ['人工咨询', '🧑‍⚕️'], ['科普宣教', '📖']] },
  { title: '智能测试', items: [['量表测试', '📊'], ['报告解读', '📋'], ['睡眠日记', '🌙']] },
  { title: '情绪与睡眠管理', items: [['情绪预警', '🚨'], ['放松练习', '🌿'], ['就诊准备', '🗂️'], ['练习打卡', '📈']] },
  { title: '医疗服务', items: [['预约挂号', '🗓️'], ['复诊开方', '💊'], ['报告查询', '🔎'], ['更多服务', '➕']] },
];

export function TangHome({ doctor, onOpen, onMe }: { doctor: DoctorProfile; onOpen: (action: TangHomeAction) => void; onMe: () => void }) {
  return <div className="tang-home-v02">
    <header className="tang-home-top"><span>A01</span><h1>唐劲松睡眠情绪智能体</h1><button onClick={onMe}>我的</button></header>
    {doctor.articles.length > 0 && <div className="tang-home-ticker"><b>文章</b><div className="tang-home-ticker-window"><div className="tang-home-ticker-track">
      {[0, 1].map(copy => <div className="tang-home-ticker-copy" key={copy} aria-hidden={copy === 1 || undefined}>{doctor.articles.map(article => <span key={article.id}>{article.title}</span>)}</div>)}
    </div></div></div>}
    <section className="tang-home-hero" aria-label="医生团队介绍">
      {doctor.portrait && <img src={doctor.portrait} alt={`${doctor.name}医生`} style={{ objectPosition: doctor.portraitPosition }} />}
      <div className="tang-home-greeting">您好，我是<br />唐劲松医生团队的 <strong>AI 助手</strong></div>
      <div className="tang-home-tags">{[doctor.department, doctor.title, ...doctor.topics.slice(0, 2)].map((tag, index) => <span key={`${index}:${tag}`}>{tag}</span>)}</div>
    </section>
    <div className="tang-home-groups">{groups.map(group => <section key={group.title}><h2>{group.title}</h2><div className="tang-home-tiles">{group.items.map(([label, icon]) => <button key={label} onClick={() => onOpen(label)}><span aria-hidden="true">{icon}</span>{label}</button>)}</div></section>)}</div>
  </div>;
}

export function TangHomeDock({ onExpert, onAsk }: { onExpert: () => void; onAsk: () => void }) {
  return <div className="tang-home-dock"><button onClick={onExpert}>专家介绍</button><button onClick={onAsk}>AI 咨询</button></div>;
}

// Render the application only after consent, including direct /ask entries.
export function TangConsent({ storageKey, lines, children, isTang = false }: { isTang?: boolean; storageKey: string; lines: string[]; children: ReactNode }) {
  const [agreed, setAgreed] = useState(() => { try { return localStorage.getItem(storageKey) === 'agreed'; } catch { return false; } });
  const [declined, setDeclined] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  if (agreed) return <>{children}</>;
  return <div className={`tang-consent-stage${isTang ? " is-tang-agent" : ""}`}><section className="tang-consent" role="dialog" aria-modal="true" aria-labelledby="tang-consent-title">
    <h1 id="tang-consent-title" ref={heading} tabIndex={-1}>使用前请了解</h1>
    {lines.map(line => <p key={line} className="tang-consent-text">{line}</p>)}
    <p>使用前，请阅读《用户协议》和《隐私政策》。</p>
    {declined && <p role="status">需同意以上说明后才能开始使用。</p>}
    <div><button onClick={() => { setDeclined(true); heading.current?.focus(); }}>暂不使用</button><button onClick={() => { try { localStorage.setItem(storageKey, 'agreed'); } catch { /* 此次同意有效，下次进入重新询问。 */ } setAgreed(true); }}>同意并开始</button></div>
  </section></div>;
}
