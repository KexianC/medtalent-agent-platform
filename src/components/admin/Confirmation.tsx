import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';

type ConfirmOptions = { title?: string; confirmLabel?: string; danger?: boolean };
type ConfirmRequest = { id: number; message: string; options: ConfirmOptions; resolve: (value: boolean) => void; signal: AbortSignal; onAbort: () => void };
type RequestConfirmation = (message: string, options: ConfirmOptions, signal: AbortSignal) => Promise<boolean>;
const ConfirmationContext = createContext<RequestConfirmation | null>(null);

/** One ordered confirmation surface. Every cancellation path resolves false. */
export function ConfirmationProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ConfirmRequest | null>(null);
  const queue = useRef<ConfirmRequest[]>([]);
  const nextId = useRef(0);
  const mounted = useRef(true);
  const settle = useCallback((id: number, accepted: boolean) => {
    const request = queue.current.find(item => item.id === id);
    if (!request) return;
    queue.current = queue.current.filter(item => item.id !== id);
    request.signal.removeEventListener('abort', request.onAbort);
    request.resolve(accepted);
    if (mounted.current) setActive(queue.current[0] || null);
  }, []);
  const requestConfirmation = useCallback<RequestConfirmation>((message, options, signal) => {
    if (!mounted.current || signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const id = ++nextId.current;
      const request: ConfirmRequest = { id, message, options, resolve, signal, onAbort: () => settle(id, false) };
      queue.current.push(request);
      signal.addEventListener('abort', request.onAbort, { once: true });
      setActive(queue.current[0]);
    });
  }, [settle]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const pending = queue.current;
      queue.current = [];
      for (const request of pending) {
        request.signal.removeEventListener('abort', request.onAbort);
        request.resolve(false);
      }
    };
  }, []);
  return <ConfirmationContext.Provider value={requestConfirmation}>{children}{active && <ConfirmationDialog key={active.id} request={active} onClose={accepted => settle(active.id, accepted)} />}</ConfirmationContext.Provider>;
}

/** Requests are cancelled when the initiating component unmounts. */
export function useConfirm() {
  const request = useContext(ConfirmationContext);
  const pending = useRef<Set<AbortController>>(new Set());
  useEffect(() => {
    const controllers = pending.current;
    return () => { for (const controller of controllers) controller.abort(); controllers.clear(); };
  }, []);
  return useCallback(async (message: string, options: ConfirmOptions = {}) => {
    if (!request || pending.current.size) return false;
    const controller = new AbortController();
    pending.current.add(controller);
    try { return await request(message, options, controller.signal); }
    finally { pending.current.delete(controller); }
  }, [request]);
}

function ConfirmationDialog({ request, onClose }: { request: ConfirmRequest; onClose: (accepted: boolean) => void }) {
  const overlay = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const danger = request.options.danger ?? /删除|归档|替换|放弃|撤销|自动审核|覆盖/.test(request.message);
  const title = request.options.title || (danger ? '确认重要操作' : '操作确认');
  const titleId = `platform-confirm-title-${request.id}`;
  const messageId = `platform-confirm-message-${request.id}`;
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay.current);
    const previousSiblings = siblings.map(element => ({ element, inert: element.inert, hidden: element.getAttribute('aria-hidden') }));
    cancel.current?.focus();
    for (const { element } of previousSiblings) { element.inert = true; element.setAttribute('aria-hidden', 'true'); }
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(false); return; }
      if (event.key !== 'Tab' || !dialog.current) return;
      const focusable = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')).filter(element => element.getClientRects().length > 0);
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialog.current.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    const keepFocus = (event: FocusEvent) => { if (event.target instanceof Node && !dialog.current?.contains(event.target)) cancel.current?.focus(); };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', keepFocus);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', keepFocus);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert, hidden } of previousSiblings) {
        element.inert = inert;
        if (hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', hidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(<div ref={overlay} className="agent-console platform-confirm-mask" onClick={event => { if (event.target === event.currentTarget) onClose(false); }}>
    <section ref={dialog} className={`platform-confirm-dialog ${danger ? 'is-danger' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId} tabIndex={-1}>
      <header><span className="platform-confirm-icon">{danger ? <AlertTriangle size={23} /> : <ShieldCheck size={23} />}</span><div><span className="agent-eyebrow">AGENT STUDIO</span><h2 id={titleId}>{title}</h2></div><button type="button" className="platform-icon-button" aria-label="取消并关闭确认" onClick={() => onClose(false)}><X size={18} /></button></header>
      <p id={messageId}>{request.message}</p>
      {danger && <div className="platform-confirm-warning">请核对操作对象及影响，确认后将执行上述变更。</div>}
      <footer><button ref={cancel} type="button" className="agent-secondary-button" onClick={() => onClose(false)}>取消</button><button type="button" className={`agent-primary-button ${danger ? 'platform-confirm-danger' : ''}`} onClick={() => onClose(true)}>{request.options.confirmLabel || '确认继续'}</button></footer>
    </section>
  </div>, document.body);
}
