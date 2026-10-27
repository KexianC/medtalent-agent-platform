import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useConsumerSession } from '../../hooks/useConsumerSession';
import { consumerDataStore } from '../../lib/consumerData';
import { getConsumerSession, loginWithWechat, logoutConsumer, refreshConsumerSession } from '../../lib/consumerSession';
import { getDoctorVisitorId } from '../../hooks/useDoctorLocalState';
import './consumer-account.css';

const sections = ['privacy', 'chat-messages', 'favorites', 'health-records', 'health-daily-tasks', 'profile-name', 'voice-input-hint-dismissed', 'chat-assessments-v1', 'wellness-v1', 'service-plans-v1', 'builder-assessments-v1'] as const;

export function ConsumerDataBoundary({ doctorSlug, children }: { doctorSlug: string; children: ReactNode }) {
  const session = useConsumerSession();
  const [recovering, setRecovering] = useState(false);
  const [recoveryNotice, setRecoveryNotice] = useState('');
  useSyncExternalStore(consumerDataStore.subscribe, consumerDataStore.getVersion, consumerDataStore.getVersion);
  useEffect(() => {
    const refresh = async () => { await refreshConsumerSession(); await consumerDataStore.load(doctorSlug); };
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [doctorSlug]);
  useEffect(() => { if (session.user?.id) void consumerDataStore.load(doctorSlug); }, [doctorSlug, session.user?.id]);
  const snapshot = consumerDataStore.get(doctorSlug, 'privacy', null);
  const recover = async (exit = false) => {
    if (recovering) return;
    setRecovering(true); setRecoveryNotice('');
    try {
      if (exit) {
        if (sections.some(section => ['pending', 'saving', 'offline', 'error', 'conflict'].includes(consumerDataStore.get(doctorSlug, section, null).status))
          && !window.confirm('当前账户有尚未同步或未确认的记录。已保存的本机缓存会保留在此账户下；设备无法保存缓存时，退出或关闭页面可能丢失这些修改。建议联网确认同步后再退出。仍要退出并使用本机游客记录吗？')) return;
        await logoutConsumer();
      } else {
        // A data 401 can outlive the last session view. Confirm the cookie
        // again before retrying, so an expired account returns to real guest state.
        await refreshConsumerSession();
        if (getConsumerSession().user) await consumerDataStore.load(doctorSlug);
      }
    } catch (error) { setRecoveryNotice(error instanceof Error ? error.message : '暂时无法恢复，请检查网络后重试。'); }
    finally { setRecovering(false); }
  };
  if (session.status === 'loading') return <main className="consumer-loading" role="status">正在确认账户…</main>;
  if (session.user && !snapshot.canEdit) return <main className="consumer-loading" role="status">
    <p>{snapshot.status === 'loading' || snapshot.status === 'idle' ? '正在读取你的云端记录…' : snapshot.error || '暂时无法读取云端记录，请检查网络后重试。'}</p>
    <button disabled={recovering} onClick={() => void recover()}>重新确认账户</button>
    <button disabled={recovering} onClick={() => void recover(true)}>退出登录，使用本机</button>
    <a href="/">返回公开首页</a>
    {(recoveryNotice || session.error) && <p>{recoveryNotice || session.error}</p>}
  </main>;
  return <div key={session.user?.id || 'guest'} className="consumer-root">{children}</div>;
}

function combineImported(local: unknown, cloud: unknown): unknown {
  if (cloud === null || cloud === undefined) return local;
  if (Array.isArray(local) && Array.isArray(cloud)) {
    const identity = (item: unknown) => item && typeof item === 'object' && 'id' in item ? item.id : item && typeof item === 'object' && 'date' in item && 'goalId' in item ? `${item.date}:${item.goalId}` : JSON.stringify(item);
    const existing = new Set(cloud.map(identity));
    return [...cloud, ...local.filter(item => !existing.has(identity(item)))];
  }
  if (local && cloud && typeof local === 'object' && typeof cloud === 'object' && !Array.isArray(local) && !Array.isArray(cloud)) {
    const merged: Record<string, unknown> = { ...cloud };
    for (const [key, value] of Object.entries(local)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) continue;
      merged[key] = combineImported(value, merged[key]);
    }
    return merged;
  }
  return cloud;
}

export function ConsumerAccountCard({ doctorSlug }: { doctorSlug: string }) {
  const session = useConsumerSession();
  useSyncExternalStore(consumerDataStore.subscribe, consumerDataStore.getVersion, consumerDataStore.getVersion);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const [importAvailable, setImportAvailable] = useState(() => {
    try { return sections.some(section => localStorage.getItem(`medtalent:${getDoctorVisitorId()}:${doctorSlug}:${section}`) !== null); } catch { return false; }
  });
  const snapshots = sections.map(section => ({ section, ...consumerDataStore.get(doctorSlug, section, null) }));
  const conflicts = snapshots.filter(item => item.status === 'conflict');
  const unsaved = snapshots.some(item => ['pending', 'saving', 'offline', 'error'].includes(item.status));
  const run = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true); setNotice('');
    try { await work(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作暂未完成，请重试。'); }
    finally { setPending(false); }
  };
  const importRecords = async () => {
    const ownerId = session.user?.id;
    const visitor = getDoctorVisitorId();
    const assertOwner = () => { if (!ownerId || getConsumerSession().user?.id !== ownerId || getDoctorVisitorId() !== visitor) throw new Error('账户已切换，请在当前账户重新选择迁移。'); };
    if (!window.confirm('将当前设备在此智能体中的游客记录合并到你的微信账户？云端已有的同名资料和相同 ID 记录会保留。请确认这些记录属于你本人。')) return;
    await consumerDataStore.load(doctorSlug);
    assertOwner();
    const copied: Array<{ key: string; raw: string; section: typeof sections[number] }> = [];
    for (const section of sections) {
      const key = `medtalent:${visitor}:${doctorSlug}:${section}`;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      const value: unknown = JSON.parse(raw);
      const cloud = consumerDataStore.get(doctorSlug, section, null);
      const privacy = consumerDataStore.get<{ saveChat?: boolean }>(doctorSlug, 'privacy', { saveChat: true }).value;
      if (['chat-messages', 'chat-assessments-v1'].includes(section) && privacy?.saveChat === false) continue;
      if (!consumerDataStore.set(doctorSlug, section, combineImported(value, cloud.value))) throw new Error('云端记录尚未就绪，请重试。');
      copied.push({ key, raw, section });
    }
    await consumerDataStore.flush();
    assertOwner();
    for (const item of copied) {
      if (consumerDataStore.get(doctorSlug, item.section, null).status !== 'synced') throw new Error('部分记录尚未同步，本机原记录仍保留，请检查同步状态后重试。');
    }
    // Remove only the exact guest values successfully copied; retain new edits.
    for (const item of copied) if (localStorage.getItem(item.key) === item.raw) localStorage.removeItem(item.key);
    setImportAvailable(sections.some(section => localStorage.getItem(`medtalent:${getDoctorVisitorId()}:${doctorSlug}:${section}`) !== null)); setNotice('所选本机记录已合并到微信账户，可在其他设备登录查看。关闭保存的对话不会迁移。');
  };
  return <section className="consumer-account" aria-label="微信账户与同步">
    <strong>{session.user ? '微信账户已登录' : '微信登录，记录随你走'}</strong>
    <p>{session.user ? conflicts.length ? '其他设备也修改了记录，请选择保留哪一份。' : unsaved ? '有记录尚未同步，联网后可重试。' : '记录已同步，可在其他设备使用同一微信账号查看。' : '登录后，对话、收藏、健康记录和心理自评将保存在你的云端账户。你可在设置中关闭对话保存。'}</p>
    {!session.user ? <><button className="consumer-primary" disabled={pending || session.loginPending || session.status === 'loading'} onClick={() => void run(loginWithWechat)}>{pending ? '正在打开微信…' : session.loginPending ? '正在等待微信登录…' : '微信一键登录'}</button>
      {session.loginPending && <><p role="status">微信确认完成后会自动读取账户。科普与问答仍可继续使用。</p><button disabled={pending} onClick={() => void run(refreshConsumerSession)}>已返回，确认登录</button></>}
    </> : <div className="consumer-actions">
      <button disabled={pending} onClick={() => void run(async () => { await consumerDataStore.load(doctorSlug); await consumerDataStore.flush(); })}>刷新同步</button>
      {importAvailable && <button disabled={pending} onClick={() => void run(importRecords)}>迁移本机记录</button>}
      <button disabled={pending} onClick={() => void run(async () => { await consumerDataStore.flush(); if (sections.some(section => ['pending', 'saving', 'offline', 'error', 'conflict'].includes(consumerDataStore.get(doctorSlug, section, null).status)) && !window.confirm('尚有未同步记录；设备无法保存缓存时，退出或关闭页面可能丢失这些修改。建议联网完成同步后再退出。仍要退出吗？')) return; await logoutConsumer(); })}>退出登录</button>
    </div>}
    {conflicts.map(item => <div className="consumer-conflict" key={item.section}><span>记录冲突（{({ 'chat-messages': '对话', 'health-records': '健康记录', 'chat-assessments-v1': '心理自评', favorites: '收藏', 'wellness-v1': '身心记录', 'service-plans-v1': '服务计划', 'builder-assessments-v1': '健康自评' } as Record<string, string>)[item.section] || '个人设置'}）</span><button onClick={() => { if (window.confirm('使用云端版本将放弃当前设备尚未同步的这项修改，确定继续吗？')) void run(() => consumerDataStore.resolveConflict(doctorSlug, item.section, 'cloud')); }}>使用云端版本</button><button onClick={() => { if (window.confirm('使用本机版本将替换云端这项记录，确定继续吗？')) void run(() => consumerDataStore.resolveConflict(doctorSlug, item.section, 'local')); }}>保留本机版本</button></div>)}
    {(notice || session.error) && <p role="status">{notice || session.error}</p>}
    {session.user && [...new Set(snapshots.map(item => item.error).filter(Boolean))].map(error => <p role="status" key={error}>{error}</p>)}
    {!session.user && <small>请在 Medtalent 微信小程序内登录。本机游客记录由你选择是否迁移。</small>}
  </section>;
}
