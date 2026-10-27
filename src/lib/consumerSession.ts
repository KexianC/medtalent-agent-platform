import { consumerDataStore } from './consumerData';
import { createWechatBridge } from './wechatBridge';

export type ConsumerSession = {
  status: 'loading' | 'guest' | 'authenticated' | 'error';
  enabled: boolean;
  user: { id: string; displayName?: string } | null;
  csrfToken: string;
  error?: string;
  loginPending?: boolean;
};
let state: ConsumerSession = { status: 'loading', enabled: false, user: null, csrfToken: '' };
const listeners = new Set<() => void>();
let inFlight: Promise<void> | undefined;
let generation = 0;
let refreshController = new AbortController();
const pendingKey = 'medtalent:wechat-pending-login-v1';
const notify = (next: ConsumerSession) => { state = next; for (const listener of listeners) listener(); };
export const subscribeConsumerSession = (listener: () => void) => {
  listeners.add(listener);
  scheduleLoginCheck();
  return () => { listeners.delete(listener); if (!listeners.size) stopLoginCheck(); };
};
export const getConsumerSession = () => state;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type PendingLogin = { requestId: string; expiresAt: string };
let memoryPending: PendingLogin | null = null;
let loginTimer: ReturnType<typeof setTimeout> | undefined;
let loginDeadline = 0;

function loginStores(): Array<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>> {
  const stores: Array<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>> = [];
  try { if (typeof localStorage !== 'undefined') stores.push(localStorage); } catch { /* Use the retained WebView memory. */ }
  try { if (typeof window !== 'undefined' && window.sessionStorage) stores.push(window.sessionStorage); } catch { /* Storage can be blocked independently. */ }
  return stores;
}

function pendingLogin(): PendingLogin | null {
  for (const storage of loginStores()) {
    try {
      const value: unknown = JSON.parse(storage.getItem(pendingKey) || 'null');
      if (isRecord(value) && typeof value.requestId === 'string' && /^[a-f0-9]{32}$/.test(value.requestId)
        && typeof value.expiresAt === 'string' && Number.isFinite(Date.parse(value.expiresAt))) {
        if (memoryPending?.requestId !== value.requestId) loginDeadline = Math.min(Date.parse(value.expiresAt), Date.now() + 300000);
        memoryPending = { requestId: value.requestId, expiresAt: value.expiresAt };
        return memoryPending;
      }
      if (value !== null) storage.removeItem(pendingKey);
    } catch { /* Correlation can stay in memory without retaining credentials. */ }
  }
  return memoryPending;
}

function stopLoginCheck() {
  if (loginTimer !== undefined) clearTimeout(loginTimer);
  loginTimer = undefined;
}

function clearLoginRequest(requestId?: string) {
  if (!requestId || memoryPending?.requestId === requestId) { memoryPending = null; loginDeadline = 0; stopLoginCheck(); }
  for (const storage of loginStores()) {
    try {
      const value: unknown = JSON.parse(storage.getItem(pendingKey) || 'null');
      if (!requestId || (isRecord(value) && value.requestId === requestId)) storage.removeItem(pendingKey);
    } catch { /* no-op */ }
  }
}

function scheduleLoginCheck() {
  if (loginTimer !== undefined || !listeners.size || !memoryPending) return;
  loginTimer = setTimeout(async () => {
    loginTimer = undefined;
    const pending = pendingLogin();
    if (!pending) return;
    if (Date.now() >= loginDeadline) {
      clearLoginRequest(pending.requestId);
      notify({ ...state, loginPending: false, error: '微信登录确认已超时，请重新点击登录。你仍可继续使用科普与问答。' });
      return;
    }
    // Some hosts return without focus/visibility events. A retained WebView
    // still confirms the transaction, but hidden pages do not poll the API.
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') await refreshConsumerSession();
    scheduleLoginCheck();
  }, 4000);
}

async function sessionResponse(response: Response): Promise<ConsumerSession> {
  const data: unknown = await response.json();
  if (!response.ok || !isRecord(data) || data.protocol !== 'medtalent.wechat' || data.version !== 1 || typeof data.authenticated !== 'boolean' || typeof data.enabled !== 'boolean' || (!data.enabled && data.authenticated) || (!data.authenticated && data.user !== null)) throw new Error('暂时无法确认登录状态，请重试。');
  if (data.authenticated && (!isRecord(data.user) || typeof data.user.id !== 'string' || !data.user.id)) throw new Error('登录信息无效，请重新登录。');
  return { status: data.authenticated ? 'authenticated' : 'guest', enabled: data.enabled,
    user: data.authenticated && isRecord(data.user) ? { id: data.user.id as string, ...(typeof data.user.displayName === 'string' ? { displayName: data.user.displayName } : {}) } : null,
    csrfToken: typeof data.csrfToken === 'string' ? data.csrfToken : '' };
}

function applySession(next: ConsumerSession) {
  if (next.user) clearLoginRequest();
  consumerDataStore.setIdentity(next.user ? { userId: next.user.id, csrfToken: next.csrfToken } : null);
  notify({ ...next, loginPending: !!memoryPending });
}

function boundedSignal(parent?: AbortSignal) {
  const controller = new AbortController();
  let rejectTimeout: (reason: Error) => void;
  const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
  const expired = () => rejectTimeout(new Error('连接等待超时，请检查网络后重试。'));
  controller.signal.addEventListener('abort', expired, { once: true });
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 12000);
  return { signal: controller.signal, timeout, dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', expired); } };
}

export async function refreshConsumerSession() {
  if (inFlight) return inFlight;
  const epoch = generation;
  const bounded = boundedSignal(refreshController.signal);
  const signal = bounded.signal;
  const operation = (async () => {
      let next = await sessionResponse(await fetch('/api/wechat/session', { credentials: 'include', cache: 'no-store', signal }));
      if (epoch !== generation || signal.aborted) return;
      const pending = pendingLogin();
      if (!next.user && pending && Date.parse(pending.expiresAt) > Date.now() && Date.now() < loginDeadline && next.csrfToken) {
        const response = await fetch('/api/wechat/login/consume', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': next.csrfToken }, body: JSON.stringify({ requestId: pending.requestId }), signal });
        if (epoch !== generation || signal.aborted) return;
        if (response.ok) { next = await sessionResponse(response); if (epoch !== generation || signal.aborted) return; clearLoginRequest(pending.requestId); }
        else {
          const failure: unknown = await response.json().catch(() => null);
          if (epoch !== generation || signal.aborted) return;
          // Both a waiting request and an expired/wrong-cookie request can
          // return 409. Only the explicit server waiting code is retryable.
          if (![409, 425].includes(response.status) || !isRecord(failure) || failure.code !== 'LOGIN_PENDING') {
            clearLoginRequest(pending.requestId);
            next.error = '本次微信登录请求已失效，请重新点击登录。科普与问答仍可继续使用。';
          }
        }
      } else if (pending) { clearLoginRequest(pending.requestId); }
      if (epoch === generation) applySession(next);
  })();
  const task = Promise.race([operation, bounded.timeout]).catch(() => {
      if (epoch !== generation) return;
      // Never replace a known signed-in account with a guest on network failure.
      notify({ ...state, status: state.user ? 'authenticated' : 'error', error: '网络连接暂时不可用，请重试登录或同步。' });
  }).finally(() => { bounded.dispose(); if (inFlight === task) inFlight = undefined; scheduleLoginCheck(); });
  inFlight = task;
  return task;
}

export async function loginWithWechat() {
  await refreshConsumerSession();
  if (!state.enabled || !state.csrfToken) throw new Error('微信登录暂未开放，请稍后再试。');
  let started: string | undefined;
  const bridge = createWechatBridge({ onLoginRequest: (requestId, expiresAt) => { rememberWechatRequest(requestId, expiresAt); started = requestId; } });
  const result = await bridge.requestWechatLogin();
  if (result.status !== 'dispatched' && started) { clearLoginRequest(started); notify({ ...state, loginPending: false }); }
  if (result.status === 'unsupported') throw new Error('请在 Medtalent 微信小程序中点击登录，同一微信账号可跨设备查看记录。');
  if (result.status === 'unavailable' && (result.reason === 'sdk_error' || result.reason === 'timeout')) throw new Error('微信登录组件暂时无法连接，请检查网络后重试。科普与问答仍可继续使用。');
  if (result.status !== 'dispatched') throw new Error('暂时无法打开微信登录，请稍后重试。');
}

export function rememberWechatRequest(requestId: string, expiresAt: string) {
  // This correlation identifier alone cannot authenticate a user; the server
  // also requires the initiating HttpOnly cookie and CSRF token when consuming.
  if (!/^[a-f0-9]{32}$/.test(requestId) || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) throw new Error('登录请求已失效，请重新点击登录。');
  memoryPending = { requestId, expiresAt };
  loginDeadline = Math.min(Date.parse(expiresAt), Date.now() + 300000);
  for (const storage of loginStores()) {
    try { storage.setItem(pendingKey, JSON.stringify(memoryPending)); } catch { /* Retain correlation in this WebView, never credentials. */ }
  }
  notify({ ...state, loginPending: true, error: undefined });
  scheduleLoginCheck();
}

export async function logoutConsumer() {
  stopLoginCheck();
  generation += 1;
  refreshController.abort(); refreshController = new AbortController(); inFlight = undefined;
  const bounded = boundedSignal();
  let response: Response;
  try {
    response = await Promise.race([fetch('/api/wechat/logout', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: '{}', signal: bounded.signal }), bounded.timeout]);
  } finally { bounded.dispose(); }
  if (!response.ok) throw new Error('退出登录失败，请检查网络后重试。');
  generation += 1;
  refreshController.abort(); refreshController = new AbortController(); inFlight = undefined;
  clearLoginRequest();
  applySession({ status: 'guest', enabled: state.enabled, user: null, csrfToken: '' });
  await refreshConsumerSession();
}
