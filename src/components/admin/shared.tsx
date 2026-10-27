import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw } from 'lucide-react';
import { errorMessage, platformApi } from '../../lib/platformApi';
import { adminStatusLabel } from '../../lib/adminStatus';

export function useResource<T>(url: string | null, revision = 0) {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(Boolean(url));
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => {
    if (!url) { setData(undefined); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true); setError(''); setData(undefined);
    platformApi<T>(url, { signal: controller.signal }).then(setData).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [url, revision, tick]);
  return { data, loading, error, reload, setData };
}

export function Loading({ label = '正在加载…' }: { label?: string }) { return <div className="platform-empty" role="status"><LoaderCircle className="platform-spin" size={22} /><p>{label}</p></div>; }
export function EmptyState({ title = '暂无数据', detail, children }: { title?: string; detail?: string; children?: ReactNode }) { return <div className="platform-empty"><p>{title}</p>{detail && <small>{detail}</small>}{children}</div>; }
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) { return <div className="platform-alert is-error" role="alert"><AlertTriangle size={17} /><span>{message}</span>{onRetry && <button onClick={onRetry} type="button"><RefreshCw size={14} />重试</button>}</div>; }
export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) { return <label className={`agent-field ${wide ? 'platform-wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Panel({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) { return <section className="agent-config-panel platform-panel"><header className="agent-panel-header"><div><span>AGENT PLATFORM</span><h2>{title}</h2>{description && <p>{description}</p>}</div>{action && <aside>{action}</aside>}</header><div className="agent-panel-body">{children}</div></section>; }
export function Status({ value }: { value?: string }) { return <span className={`platform-status status-${value || 'idle'}`}>{adminStatusLabel(value)}</span>; }
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) { return <button className={`agent-toggle ${checked ? 'is-on' : ''}`} role="switch" aria-checked={checked} aria-label={label} disabled={disabled} type="button" onClick={() => onChange(!checked)}><span /></button>; }
export function Checks({ values, onChange, disabled }: { values: Array<{ key: string; label: string; detail: string; checked: boolean }>; onChange: (key: string, value: boolean) => void; disabled?: boolean }) { return <div className="platform-checks">{values.map(item => <div key={item.key}><section><b>{item.label}</b><p>{item.detail}</p></section><Toggle checked={item.checked} disabled={disabled} label={item.label} onChange={value => onChange(item.key, value)} /></div>)}</div>; }
export type ActionRunner = <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
export function useAction(onMessage: (message: string, error?: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const run: ActionRunner = useCallback(async <T,>(work: () => Promise<T>, success?: string) => {
    setBusy(true);
    try { const result = await work(); if (success) onMessage(success); return result; }
    catch (error) { onMessage(errorMessage(error), true); return undefined; }
    finally { setBusy(false); }
  }, [onMessage]);
  return { busy, run };
}
