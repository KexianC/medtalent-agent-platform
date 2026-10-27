import { useEffect, useRef, type ReactNode } from 'react';
import { ArrowLeftIcon, CaretRightIcon, MoonStarsIcon, HeartIcon, WindIcon, HeadphonesIcon, ClipboardTextIcon, ChartLineUpIcon, PersonSimpleRunIcon, SparkleIcon, BrainIcon, type Icon } from '@phosphor-icons/react';
import { localDateKey } from '../../hooks/useDoctorLocalState';
import { useConsumerSession } from '../../hooks/useConsumerSession';
import { useWellness, WellnessStorageNotice } from './WellnessStore';
import { WellnessRecordEditor, WellnessReport, WellnessRecordHistory } from './WellnessRecords.tsx';
import { WellnessGoals } from './WellnessGoals';
import { WellnessBreathing, WellnessMeditation } from './WellnessRelaxation';
import { WellnessAssessment, WellnessPersonality, WellnessCards } from './WellnessAssessments.tsx';
import type { WellnessView } from './types';
import { useWellnessDay } from './useWellnessDay';
import './wellness.css';

export const wellnessFeatures: { id: WellnessView; title: string; description: string; icon: Icon; section: 'manage' | 'services' }[] = [
  { id: 'diary', title: '睡眠与情绪日记', description: '记录睡眠、心情和今天的感受', icon: MoonStarsIcon, section: 'manage' },
  { id: 'breathing', title: '呼吸放松', description: '跟随节奏，给自己片刻安静', icon: WindIcon, section: 'services' },
  { id: 'meditation', title: '冥想课程', description: '聆听引导，回到当下', icon: HeadphonesIcon, section: 'services' },
  { id: 'assessment', title: '心理自评', description: '用完整问答了解近期感受', icon: ClipboardTextIcon, section: 'services' },
  { id: 'goals', title: '我的目标与打卡', description: '从一个自己能做到的小目标开始', icon: PersonSimpleRunIcon, section: 'manage' },
  { id: 'report', title: '健康趋势报告', description: '回看自己的记录与变化', icon: ChartLineUpIcon, section: 'manage' },
  { id: 'health', title: '生理健康记录', description: '记录步数、体重和日常指标', icon: HeartIcon, section: 'manage' },
  { id: 'mbti', title: 'MBTI 趣味探索', description: '了解自己的偏好，没有标准答案', icon: BrainIcon, section: 'services' },
  { id: 'cards', title: '趣味占卜卡', description: '随机抽一张卡，换个角度想一想', icon: SparkleIcon, section: 'services' },
];
function FeatureGrid({ features, onOpen }: { features: typeof wellnessFeatures; onOpen: (view: WellnessView) => void }) {
  return <div className="yw-feature-grid">{features.map(feature => { const IconComponent = feature.icon; return <button key={feature.id} onClick={() => onOpen(feature.id)}><span><IconComponent size={25} weight="duotone" /></span><b>{feature.title}</b><small>{feature.description}</small><CaretRightIcon size={15} /></button>; })}</div>;
}
export function WellnessHome({ onOpen }: { onOpen: (view: WellnessView) => void }) {
  const { state, doctorName } = useWellness();
  const today = useWellnessDay();
  const start = new Date(); start.setDate(start.getDate() - 6);
  const count = new Set(state.records.filter(record => record.date >= localDateKey(start) && record.date <= today).map(record => record.date)).size;
  const todayRecord = state.records.find(record => record.date === today);
  const moods = state.records.filter(record => record.date >= localDateKey(start) && record.date <= today && typeof record.values?.moodScore === 'number');
  const avg = moods.length ? (moods.reduce((sum, record) => sum + (record.values.moodScore ?? 0), 0) / moods.length).toFixed(1) : '—';
  return <section className="yw-home">
    <WellnessStorageNotice />
    <div className="yw-card yw-home-journal"><span className="journey-eyebrow">A MOMENT FOR YOURSELF</span><h2>今天，过得怎么样？</h2><p>慢一点，记录睡眠，也听一听自己的心情。</p><div className="yw-home-stats"><div><strong>{count}<small> / 7</small></strong><span>近七日记录天数</span></div><div><strong>{avg}<small>{moods.length ? ' / 10' : ''}</small></strong><span>{moods.length ? '近七日平均心情' : '等待第一份心情记录'}</span></div></div><button className="journey-primary-button" onClick={() => onOpen('diary')}>{todayRecord ? '继续记录今天' : '写下今日感受'}<CaretRightIcon size={18} /></button><button className="yw-text-button" onClick={() => onOpen('report')}>查看我的趋势报告</button></div>
    <div className="yw-section-title"><div><span className="journey-eyebrow">YOUR WELLNESS SPACE</span><h2>{doctorName}的身心空间</h2></div><MoonStarsIcon size={25} weight="duotone" /></div>
    <FeatureGrid features={wellnessFeatures} onOpen={onOpen} />
  </section>;
}
export function WellnessWorkspace({ section, view, onView, onAsk, servicePlans }: { section: 'manage' | 'services'; view: WellnessView | null; onView: (view: WellnessView | null) => void; onAsk: (question?: string) => void; servicePlans?: ReactNode }) {
  const account = useConsumerSession();
  const { doctorName, readOnly } = useWellness();
  const heading = useRef<HTMLHeadingElement>(null);
  const active = wellnessFeatures.find(feature => feature.id === view && feature.section === section);
  useEffect(() => { if (active) { heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' }); } }, [active]);
  return <div className="yw-workspace journey-simple-panel">
    <header><span className="journey-eyebrow">{section === 'manage' ? 'MY HEALTH JOURNAL' : 'MIND & DISCOVERY'}</span><h1 ref={heading} tabIndex={-1}>{active?.title ?? (section === 'manage' ? '我的健康管理' : '身心练习与探索')}</h1><p>{active?.description ?? (section === 'manage' ? '把每天的记录，连成自己的健康轨迹。' : '选择适合此刻的方式，与自己相处一会儿。')}</p></header>
    <WellnessStorageNotice />
    {active ? <><button className="yw-back" onClick={() => onView(null)}><ArrowLeftIcon size={16} />返回{section === 'manage' ? '管理' : '身心空间'}</button><div key={active.id}>
      {active.id === 'diary' && <WellnessRecordEditor mode="diary" />}
      {active.id === 'health' && <WellnessRecordEditor mode="health" />}
      {active.id === 'report' && <WellnessReport onAsk={onAsk} />}
      {active.id === 'goals' && <WellnessGoals />}
      {active.id === 'breathing' && <WellnessBreathing />}
      {active.id === 'meditation' && <WellnessMeditation />}
      {active.id === 'assessment' && <WellnessAssessment />}
      {active.id === 'mbti' && <WellnessPersonality />}
      {active.id === 'cards' && <WellnessCards />}
    </div></> : <><FeatureGrid features={wellnessFeatures.filter(feature => feature.section === section)} onOpen={onView} />{section === 'services' && servicePlans}{section === 'manage' && <WellnessRecordHistory />}{section === 'services' && <section className="yw-card"><h3>需要进一步聊一聊？</h3><p>可以把想了解的问题写下来，由{doctorName}智能体帮你梳理。</p><button className="journey-primary-button" onClick={() => onAsk()}>进入健康问答</button></section>}</>}
    <p className="yw-footnote">{readOnly ? '模板只读预览，创建草稿后可保存。' : account.user ? '记录会同步到微信账户，完成后可跨设备查看；在历史中删除的记录也会同步删除。' : '记录保存在当前设备的游客空间，可在各项历史中删除。'}自评与趣味探索不作为诊断依据。</p>
  </div>;
}
export function WellnessMeLinks({ onOpen }: { onOpen: (view: WellnessView) => void }) {
  const { state } = useWellness();
  return <section className="yw-me-links"><button onClick={() => onOpen('report')}><ChartLineUpIcon size={21} /><span><b>我的身心报告</b><small>{state.records.length} 天记录 · {state.sessions.length} 次练习</small></span><CaretRightIcon size={17} /></button><button onClick={() => onOpen('assessment')}><ClipboardTextIcon size={21} /><span><b>我的自评记录</b><small>{state.assessments.length} 次已完成测评</small></span><CaretRightIcon size={17} /></button></section>;
}
