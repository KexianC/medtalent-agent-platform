/**
 * Optional H5-to-mini-program entry points. Importing this module does no work.
 * Native capabilities are disabled until the server and native page enable them.
 * Dispatching a native page never authenticates the H5; read the server session
 * explicitly after returning. requestId is correlation only, never a credential.
 */
export const WECHAT_BRIDGE_PROTOCOL = 'medtalent.wechat' as const;
export const WECHAT_BRIDGE_VERSION = 1 as const;
export const WECHAT_JS_SDK_URL = 'https://res.wx.qq.com/open/js/jweixin-1.6.0.js';
export const WECHAT_APP_ORIGIN = 'https://agent.hzmwmt.com';
export const WECHAT_ACTIONS = ['login', 'phoneNumber', 'payment', 'subscribeMessage'] as const;

export type WechatAction = typeof WECHAT_ACTIONS[number];
export type WechatCapabilities = {
  protocol: typeof WECHAT_BRIDGE_PROTOCOL;
  version: typeof WECHAT_BRIDGE_VERSION;
  capabilities: Record<WechatAction, { enabled: boolean }>;
};
export type WechatUser = { id: string; displayName?: string; avatarUrl?: string };
export type WechatSession = {
  protocol: typeof WECHAT_BRIDGE_PROTOCOL;
  version: typeof WECHAT_BRIDGE_VERSION;
  enabled: boolean;
  authenticated: boolean;
  user: WechatUser | null;
  csrfToken?: string;
};
export type WechatBridgeReason = 'unsupported_environment' | 'unsafe_origin' | 'invalid_action'
  | 'network_error' | 'timeout' | 'http_error' | 'invalid_response' | 'protocol_mismatch'
  | 'sdk_error' | 'random_unavailable' | 'navigation_error' | 'invalid_return_path';
export type WechatUnavailable = { status: 'unavailable'; reason: WechatBridgeReason };
export type WechatRequestResult =
  | { status: 'disabled'; action: WechatAction }
  | { status: 'unsupported'; action: WechatAction; reason: 'unsupported_environment' | 'unsafe_origin' }
  | { status: 'unavailable'; action: WechatAction; reason: WechatBridgeReason }
  | { status: 'dispatched'; action: WechatAction; requestId: string };

type MiniProgramSdk = {
  getEnv: (callback: (result: { miniprogram?: boolean }) => void) => void;
  navigateTo: (options: { url: string }) => void;
};
export type WechatBridgeWindow = {
  location: Pick<Location, 'href'>;
  navigator: Pick<Navigator, 'userAgent'>;
  crypto: Pick<Crypto, 'getRandomValues'>;
  wx?: { miniProgram?: MiniProgramSdk };
};
export type WechatBridgeOptions = {
  fetchImpl?: typeof fetch;
  window?: WechatBridgeWindow;
  document?: Document;
  /** Bounded network, script-load and environment-check wait, in milliseconds. */
  timeoutMs?: number;
  onLoginRequest?: (requestId: string, expiresAt: string) => void;
};

class BridgeFailure extends Error {
  reason: WechatBridgeReason;
  constructor(reason: WechatBridgeReason) {
    super(reason);
    this.reason = reason;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reasonOf(error: unknown, fallback: WechatBridgeReason): WechatBridgeReason {
  return error instanceof BridgeFailure ? error.reason : fallback;
}

function validateProtocol(value: unknown): asserts value is Record<string, unknown> {
  if (!record(value)) throw new BridgeFailure('invalid_response');
  if (value.protocol !== WECHAT_BRIDGE_PROTOCOL || value.version !== WECHAT_BRIDGE_VERSION) {
    throw new BridgeFailure('protocol_mismatch');
  }
}

function validateCapabilities(value: unknown): WechatCapabilities {
  validateProtocol(value);
  if (!record(value.capabilities)) throw new BridgeFailure('invalid_response');
  const capabilities = {} as WechatCapabilities['capabilities'];
  for (const action of WECHAT_ACTIONS) {
    const capability = value.capabilities[action];
    if (!record(capability) || typeof capability.enabled !== 'boolean') {
      throw new BridgeFailure('invalid_response');
    }
    capabilities[action] = { enabled: capability.enabled };
  }
  return { protocol: WECHAT_BRIDGE_PROTOCOL, version: WECHAT_BRIDGE_VERSION, capabilities };
}

function validateSession(value: unknown): WechatSession {
  validateProtocol(value);
  if (typeof value.enabled !== 'boolean' || typeof value.authenticated !== 'boolean') {
    throw new BridgeFailure('invalid_response');
  }
  if ((!value.enabled && value.authenticated) || (!value.authenticated && value.user !== null)) {
    throw new BridgeFailure('invalid_response');
  }
  let user: WechatUser | null = null;
  if (value.authenticated) {
    if (!record(value.user) || typeof value.user.id !== 'string' || !value.user.id.trim()) {
      throw new BridgeFailure('invalid_response');
    }
    user = { id: value.user.id };
    if (typeof value.user.displayName === 'string') user.displayName = value.user.displayName;
    if (typeof value.user.avatarUrl === 'string') user.avatarUrl = value.user.avatarUrl;
  }
  return {
    protocol: WECHAT_BRIDGE_PROTOCOL, version: WECHAT_BRIDGE_VERSION,
    enabled: value.enabled, authenticated: value.authenticated, user,
    ...(typeof value.csrfToken === 'string' ? { csrfToken: value.csrfToken } : {}),
  };
}

function hasMiniProgramSdk(browser: WechatBridgeWindow): boolean {
  return typeof browser.wx?.miniProgram?.getEnv === 'function'
    && typeof browser.wx?.miniProgram?.navigateTo === 'function';
}

function loginReturnPath(href: string): string {
  const pathname = new URL(href).pathname;
  if (pathname === '/') return '/';
  // Match the server allowlist exactly, while accepting the public page's
  // optional trailing slash. Query/hash values never enter the login request.
  const match = /^\/d\/([a-z0-9][a-z0-9-]{1,62}[a-z0-9])(\/ask)?\/?$/.exec(pathname);
  if (!match) throw new BridgeFailure('invalid_return_path');
  return `/d/${match[1]}${match[2] || ''}`;
}

export function createWechatBridge(options: WechatBridgeOptions = {}) {
  const configuredTimeout = options.timeoutMs ?? 8000;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, 30000) : 8000;
  let sdkPending: Promise<MiniProgramSdk> | undefined;

  // Resolve browser dependencies at call time, so SSR and imports stay inert.
  function browserWindow(): WechatBridgeWindow | undefined {
    return options.window ?? (typeof window === 'undefined' ? undefined : window as WechatBridgeWindow);
  }

  function source(): { browser: WechatBridgeWindow; origin: string; production: boolean } {
    const browser = browserWindow();
    if (!browser) throw new BridgeFailure('unsupported_environment');
    let url: URL;
    try { url = new URL(browser.location.href); } catch { throw new BridgeFailure('unsafe_origin'); }
    const production = url.origin === WECHAT_APP_ORIGIN;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && ['http:', 'https:'].includes(url.protocol);
    if ((!production && !local) || url.username || url.password) throw new BridgeFailure('unsafe_origin');
    return { browser, origin: url.origin, production };
  }

  function bounded<T>(operation: Promise<T>, onTimeout?: () => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onTimeout?.();
        reject(new BridgeFailure('timeout'));
      }, timeoutMs);
      operation.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  async function readJson(path: '/api/wechat/capabilities' | '/api/wechat/session'): Promise<unknown> {
    const { origin } = source();
    const fetchImpl = options.fetchImpl ?? (typeof fetch === 'undefined' ? undefined : fetch);
    if (!fetchImpl) throw new BridgeFailure('unsupported_environment');
    const controller = new AbortController();
    const url = `${origin}${path}`;
    return bounded((async () => {
      const response = await fetchImpl(url, {
        method: 'GET', credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json' }, signal: controller.signal,
      });
      if (!response.ok) throw new BridgeFailure('http_error');
      if (response.redirected || (response.url && response.url !== url)) throw new BridgeFailure('invalid_response');
      try { return await response.json(); } catch { throw new BridgeFailure('invalid_response'); }
    })(), () => controller.abort());
  }

  async function readWechatCapabilities(): Promise<WechatCapabilities | WechatUnavailable> {
    try { return validateCapabilities(await readJson('/api/wechat/capabilities')); }
    catch (error) { return { status: 'unavailable', reason: reasonOf(error, 'network_error') }; }
  }

  async function readWechatSession(): Promise<WechatSession | WechatUnavailable> {
    try { return validateSession(await readJson('/api/wechat/session')); }
    catch (error) { return { status: 'unavailable', reason: reasonOf(error, 'network_error') }; }
  }

  async function loadSdk(browser: WechatBridgeWindow): Promise<MiniProgramSdk> {
    if (hasMiniProgramSdk(browser)) return browser.wx!.miniProgram!;
    if (sdkPending) return sdkPending;
    const doc = options.document ?? (typeof document === 'undefined' ? undefined : document);
    if (!doc?.head) throw new BridgeFailure('sdk_error');
    const script = doc.createElement('script');
    script.src = WECHAT_JS_SDK_URL;
    script.async = true;
    script.referrerPolicy = 'no-referrer';
    const load = new Promise<MiniProgramSdk>((resolve, reject) => {
      script.onload = () => hasMiniProgramSdk(browser)
        ? resolve(browser.wx!.miniProgram!) : reject(new BridgeFailure('sdk_error'));
      script.onerror = () => reject(new BridgeFailure('sdk_error'));
      doc.head.appendChild(script);
    });
    const pending = bounded(load).catch(error => {
      script.remove();
      throw error;
    }).finally(() => {
      script.onload = null;
      script.onerror = null;
      sdkPending = undefined;
    });
    sdkPending = pending;
    return pending;
  }

  async function requestWechatCapability(action: WechatAction): Promise<WechatRequestResult> {
    if (!(WECHAT_ACTIONS as readonly string[]).includes(action)) {
      return { status: 'unavailable', action, reason: 'invalid_action' };
    }
    // Query every time: a cached enabled flag must never bypass server disablement.
    const capabilities = await readWechatCapabilities();
    if ('status' in capabilities) return { ...capabilities, action };
    if (!capabilities.capabilities[action].enabled) return { status: 'disabled', action };
    let current: ReturnType<typeof source>;
    try { current = source(); }
    catch (error) { return { status: 'unavailable', action, reason: reasonOf(error, 'unsafe_origin') }; }
    if (!current.production) return { status: 'unsupported', action, reason: 'unsafe_origin' };
    if (!/MicroMessenger/i.test(current.browser.navigator?.userAgent || '')) {
      return { status: 'unsupported', action, reason: 'unsupported_environment' };
    }
    try {
      const returnPath = action === 'login' ? loginReturnPath(current.browser.location.href) : undefined;
      const sdk = await loadSdk(current.browser);
      const isMiniProgram = await bounded(new Promise<boolean>((resolve, reject) => {
        try { sdk.getEnv(result => resolve(result?.miniprogram === true)); }
        catch { reject(new BridgeFailure('sdk_error')); }
      }));
      if (!isMiniProgram) return { status: 'unsupported', action, reason: 'unsupported_environment' };
      if (action === 'login') {
        const session = await readWechatSession();
        if ('status' in session || !session.csrfToken) throw new BridgeFailure('invalid_response');
        const fetchImpl = options.fetchImpl ?? fetch;
        const controller = new AbortController();
        const url = `${current.origin}/api/wechat/login`;
        const ticket: unknown = await bounded((async () => {
        const response = await fetchImpl(url, {
          method: 'POST', credentials: 'include', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
          body: JSON.stringify({ returnPath }),
        });
        if (!response.ok) throw new BridgeFailure('http_error');
        if (response.redirected || (response.url && response.url !== url)) throw new BridgeFailure('invalid_response');
        try { return await response.json(); } catch { throw new BridgeFailure('invalid_response'); }
        })(), () => controller.abort());
        if (!record(ticket) || typeof ticket.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(ticket.requestId)
          || typeof ticket.bridgeToken !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.bridgeToken)
          || typeof ticket.expiresAt !== 'string' || !Number.isFinite(Date.parse(ticket.expiresAt))) throw new BridgeFailure('invalid_response');
        options.onLoginRequest?.(ticket.requestId, ticket.expiresAt);
        try { sdk.navigateTo({ url: `/pages/capability/index?v=1&action=login&requestId=${ticket.requestId}&bridgeToken=${ticket.bridgeToken}` }); }
        catch { throw new BridgeFailure('navigation_error'); }
        return { status: 'dispatched', action, requestId: ticket.requestId };
      }
      const random = new Uint8Array(16);
      try { current.browser.crypto.getRandomValues(random); }
      catch { return { status: 'unavailable', action, reason: 'random_unavailable' }; }
      const requestId = Array.from(random, value => value.toString(16).padStart(2, '0')).join('');
      // miniProgram.navigateTo does not provide a reliable completion callback.
      // This status means dispatch only; it says nothing about login or consent.
      try { sdk.navigateTo({ url: `/pages/capability/index?v=1&action=${action}&requestId=${requestId}` }); }
      catch { return { status: 'unavailable', action, reason: 'navigation_error' }; }
      return { status: 'dispatched', action, requestId };
    } catch (error) {
      return { status: 'unavailable', action, reason: reasonOf(error, 'sdk_error') };
    }
  }

  function requestWechatLogin(): Promise<WechatRequestResult> {
    return requestWechatCapability('login');
  }

  return { readWechatCapabilities, readWechatSession, requestWechatCapability, requestWechatLogin };
}

const defaultBridge = createWechatBridge();
export const readWechatCapabilities = defaultBridge.readWechatCapabilities;
export const readWechatSession = defaultBridge.readWechatSession;
export const requestWechatCapability = defaultBridge.requestWechatCapability;
export const requestWechatLogin = defaultBridge.requestWechatLogin;
