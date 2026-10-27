import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  createWechatBridge,
  WECHAT_ACTIONS,
  WECHAT_APP_ORIGIN,
  WECHAT_JS_SDK_URL,
} from '../src/lib/wechatBridge.ts';

function capabilities(enabled = false) {
  return {
    protocol: 'medtalent.wechat', version: 1,
    capabilities: Object.fromEntries(WECHAT_ACTIONS.map(action => [action, { enabled }])),
  };
}

function loginTicket() {
  return { requestId: 'a'.repeat(32), bridgeToken: 'b'.repeat(64), expiresAt: new Date(Date.now() + 300000).toISOString() };
}

function fixture(options = {}) {
  const requests = [];
  const navigations = [];
  const scripts = [];
  const loginRequests = [];
  const browser = {
    location: Object.freeze({ href: options.href ?? `${WECHAT_APP_ORIGIN}/d/tang-jinsong/ask?question=private#draft` }),
    navigator: { userAgent: 'Mozilla/5.0 MicroMessenger/8.0' },
    crypto: webcrypto,
  };
  // Any unexpected session persistence or URL rewrite makes the test fail.
  Object.defineProperty(browser, 'localStorage', { get() { throw new Error('No credential storage'); } });
  Object.defineProperty(browser, 'history', { get() { throw new Error('No navigation rewrites'); } });
  const sdk = {
    getEnv(callback) { callback({ miniprogram: true }); },
    navigateTo(request) { navigations.push(request); },
  };
  const doc = {
    head: { appendChild(script) { scripts.push(script); options.onScript?.(script, browser, sdk); } },
    createElement(tag) {
      assert.equal(tag, 'script');
      return { removed: false, remove() { this.removed = true; } };
    },
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    if (options.fetchImpl) {
      const custom = await options.fetchImpl(url, init, requests.length);
      if (custom !== undefined) return custom;
    }
    const body = url.endsWith('/session')
      ? { protocol: 'medtalent.wechat', version: 1, enabled: options.enabled ?? false, authenticated: false, user: null,
        ...(options.enabled ? { csrfToken: 'test-csrf-token' } : {}) }
      : url.endsWith('/login') ? loginTicket()
      : capabilities(options.enabled ?? false);
    return Response.json(body);
  };
  const bridge = (options.createBridge ?? createWechatBridge)({ fetchImpl, window: browser, document: doc, timeoutMs: 30,
    onLoginRequest: (...args) => { loginRequests.push(args); options.onLoginRequest?.(...args); } });
  return { bridge, browser, sdk, doc, requests, navigations, scripts, loginRequests };
}

test('constructing the optional bridge causes no network, SDK, or navigation activity', () => {
  const state = fixture();
  assert.equal(state.requests.length, 0);
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
});

test('all disabled capabilities return structured disabled results without loading the SDK', async () => {
  const state = fixture();
  state.browser.wx = { login() { assert.fail('H5 must never call wx.login'); }, miniProgram: state.sdk };
  for (const action of WECHAT_ACTIONS) {
    assert.deepEqual(await state.bridge.requestWechatCapability(action), { status: 'disabled', action });
  }
  assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'disabled', action: 'login' });
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
});

test('capability reads use fixed same-origin GET endpoints, credentials, and no redirects or cache', async () => {
  const state = fixture();
  assert.deepEqual(await state.bridge.readWechatCapabilities(), capabilities());
  assert.deepEqual(await state.bridge.readWechatSession(), {
    protocol: 'medtalent.wechat', version: 1, enabled: false, authenticated: false, user: null,
  });
  assert.deepEqual(state.requests.map(item => item.url), [
    `${WECHAT_APP_ORIGIN}/api/wechat/capabilities`, `${WECHAT_APP_ORIGIN}/api/wechat/session`,
  ]);
  for (const { init } of state.requests) {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'include');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.body, undefined);
  }
});

test('missing, malformed, and mismatched capability contracts fail closed', async () => {
  const bodies = [null, {}, { ...capabilities(true), version: 2 },
    { ...capabilities(true), protocol: 'other' },
    { ...capabilities(true), capabilities: { login: { enabled: true } } },
    { ...capabilities(true), capabilities: { ...capabilities(true).capabilities, login: { enabled: 'true' } } }];
  for (const body of bodies) {
    const state = fixture({ fetchImpl: async () => Response.json(body) });
    state.browser.wx = { miniProgram: state.sdk };
    assert.equal((await state.bridge.requestWechatLogin()).status, 'unavailable');
    assert.equal(state.navigations.length, 0);
    assert.equal(state.scripts.length, 0);
  }
});

test('a network failure does not enable a capability and a subsequent explicit call can retry', async () => {
  const state = fixture({ fetchImpl: async (_url, _init, attempt) => {
    if (attempt === 1) throw new Error('offline');
    return Response.json(capabilities());
  } });
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'network_error',
  });
  assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'disabled', action: 'login' });
  assert.equal(state.navigations.length, 0);
});

test('a hung network request is bounded and aborted even when fetch ignores its signal', async () => {
  const state = fixture({ fetchImpl: async () => new Promise(() => {}) });
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'timeout',
  });
  assert.equal(state.requests[0].init.signal.aborted, true);
  assert.equal(state.navigations.length, 0);
});

test('HTTP errors, invalid JSON, and redirected responses are rejected', async () => {
  const responses = [
    new Response('unavailable', { status: 503 }),
    new Response('<html>application fallback</html>'),
    { ok: true, redirected: true, json: async () => capabilities(true) },
    { ok: true, url: 'https://unexpected.example/api/wechat/capabilities', json: async () => capabilities(true) },
  ];
  for (const response of responses) {
    const state = fixture({ fetchImpl: async () => response });
    assert.equal((await state.bridge.requestWechatLogin()).status, 'unavailable');
    assert.equal(state.navigations.length, 0);
  }
});

test('ordinary browsers do not load the SDK or navigate even if a capability is enabled', async () => {
  const state = fixture({ enabled: true });
  state.browser.navigator.userAgent = 'Mozilla/5.0 Chrome/140.0';
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unsupported', action: 'login', reason: 'unsupported_environment',
  });
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
});

test('ordinary WeChat browser is rejected using getEnv rather than its user agent', async () => {
  const state = fixture({ enabled: true });
  state.sdk.getEnv = callback => callback({ miniprogram: false });
  state.browser.wx = { miniProgram: state.sdk };
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unsupported', action: 'login', reason: 'unsupported_environment',
  });
  assert.equal(state.navigations.length, 0);
});

test('localhost can inspect the development API but never opens a real WeChat channel', async () => {
  const state = fixture({ enabled: true });
  state.browser.location = { href: 'http://localhost:5173/#/doctor/example' };
  assert.equal((await state.bridge.readWechatCapabilities()).capabilities.login.enabled, true);
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unsupported', action: 'login', reason: 'unsafe_origin',
  });
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
  assert.ok(state.requests.every(item => item.url.startsWith('http://localhost:5173/api/wechat/')));
});

test('HTTP production, foreign domains, and credential-bearing URLs are rejected before fetch', async () => {
  for (const href of ['http://agent.hzmwmt.com/', 'https://example.com/', 'https://agent.hzmwmt.com.evil.test/',
    'https://name:password@agent.hzmwmt.com/']) {
    const state = fixture({ enabled: true });
    state.browser.location = { href };
    assert.deepEqual(await state.bridge.readWechatCapabilities(), { status: 'unavailable', reason: 'unsafe_origin' });
    assert.equal(state.requests.length, 0);
    assert.equal(state.scripts.length, 0);
  }
});

test('login creates a CSRF protected server transaction and dispatches only its native bridge token', async () => {
  const state = fixture({ enabled: true, onScript(script, browser, sdk) {
    browser.wx = { miniProgram: sdk };
    queueMicrotask(() => script.onload());
  } });
  const beforeUrl = state.browser.location.href;
  const result = await state.bridge.requestWechatLogin();
  assert.equal(result.status, 'dispatched');
  assert.equal(result.action, 'login');
  assert.match(result.requestId, /^[a-f0-9]{32}$/);
  assert.equal(result.authenticated, undefined);
  assert.equal(result.code, undefined);
  assert.equal(result.token, undefined);
  assert.equal(result.bridgeToken, undefined);
  assert.equal(state.scripts.length, 1);
  assert.equal(state.scripts[0].src, WECHAT_JS_SDK_URL);
  assert.equal(state.navigations[0].url, `/pages/capability/index?v=1&action=login&requestId=${result.requestId}&bridgeToken=${'b'.repeat(64)}`);
  assert.equal(state.browser.location.href, beforeUrl);
  assert.deepEqual(state.requests.map(request => new URL(request.url).pathname), ['/api/wechat/capabilities', '/api/wechat/session', '/api/wechat/login']);
  const init = state.requests[2].init;
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers['X-CSRF-Token'], 'test-csrf-token');
  assert.deepEqual(JSON.parse(init.body), { returnPath: '/d/tang-jinsong/ask' });
  assert.equal(state.loginRequests.length, 1);
  assert.equal(state.loginRequests[0][0], result.requestId);
  assert.equal(state.loginRequests[0].length, 2, 'persistence callback never receives bridge token');
  assert.ok(Number.isFinite(Date.parse(state.loginRequests[0][1])));
  assert.equal((await state.bridge.readWechatSession()).authenticated, false);
});

test('login POST canonicalizes public home/ask trailing slashes and excludes URL credentials', async () => {
  for (const [pathname, expected] of [['/', '/'], ['/d/tang-jinsong/', '/d/tang-jinsong'], ['/d/tang-jinsong/ask/', '/d/tang-jinsong/ask']]) {
    const state = fixture({ enabled: true, href: `${WECHAT_APP_ORIGIN}${pathname}?token=ignored&returnPath=/admin#private`, fetchImpl: async (url, init) => {
      if (!url.endsWith('/login')) return;
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { returnPath: expected });
      assert.match(body.returnPath, /^(?:\/|\/d\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9](?:\/ask)?)$/);
      return Response.json(loginTicket());
    } });
    state.browser.wx = { miniProgram: state.sdk };
    assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
    assert.equal(state.navigations.length, 1);
  }
});

test('non-public return paths cannot create a login transaction or dispatch native code', async () => {
  for (const pathname of ['/admin', '/d/tang-jinsong/my', '/d/tang-jinsong//', '/d/Tang-Jinsong/', '/d/x/', '/d/tang%2fjinsong/', '/d/tang-jinsong/ask/extra']) {
    const state = fixture({ enabled: true, href: `${WECHAT_APP_ORIGIN}${pathname}` });
    state.browser.wx = { miniProgram: state.sdk };
    assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'unavailable', action: 'login', reason: 'invalid_return_path' });
    assert.equal(state.requests.some(request => request.init.method === 'POST'), false);
    assert.equal(state.navigations.length, 0);
    assert.equal(state.loginRequests.length, 0);
  }
});

test('public trailing-slash login dispatches through the unchanged server return-path allowlist', async () => {
  const postPaths = [];
  const state = fixture({ enabled: true, href: `${WECHAT_APP_ORIGIN}/d/tang-jinsong/`, fetchImpl: async (url, init) => {
    if (!url.endsWith('/login')) return;
    const returnPath = JSON.parse(init.body).returnPath;
    postPaths.push(returnPath);
    return /^(?:\/|\/d\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9](?:\/ask)?)$/.test(returnPath)
      ? Response.json(loginTicket()) : Response.json({ code: 'INVALID_RETURN_PATH' }, { status: 400 });
  } });
  state.browser.wx = { miniProgram: state.sdk };
  assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
  assert.equal(state.navigations.length, 1);
  assert.deepEqual(postPaths, ['/d/tang-jinsong']);
});

test('request ids use fresh crypto randomness and remain correlation-only values', async () => {
  const state = fixture({ enabled: true });
  state.browser.wx = { miniProgram: state.sdk };
  const first = await state.bridge.requestWechatCapability('phoneNumber');
  const second = await state.bridge.requestWechatCapability('payment');
  assert.equal(first.status, 'dispatched');
  assert.equal(second.status, 'dispatched');
  assert.notEqual(first.requestId, second.requestId);
  assert.match(state.navigations[0].url, /^\/pages\/capability\/index\?v=1&action=phoneNumber&requestId=[a-f0-9]{32}$/);
  assert.match(state.navigations[1].url, /^\/pages\/capability\/index\?v=1&action=payment&requestId=[a-f0-9]{32}$/);
});

test('arbitrary actions cannot cause a fetch, SDK load, or injected native route', async () => {
  const state = fixture({ enabled: true });
  for (const action of ['../../other', 'login&returnUrl=https://evil.test', '__proto__', '', null]) {
    const result = await state.bridge.requestWechatCapability(action);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.reason, 'invalid_action');
  }
  assert.equal(state.requests.length, 0);
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
});

test('SDK script failure is cleaned up and a subsequent explicit request can retry', async () => {
  let attempt = 0;
  const state = fixture({ enabled: true, onScript(script, browser, sdk) {
    attempt++;
    queueMicrotask(() => {
      if (attempt === 1) script.onerror();
      else { browser.wx = { miniProgram: sdk }; script.onload(); }
    });
  } });
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'sdk_error',
  });
  assert.equal(state.scripts[0].removed, true);
  assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
  assert.equal(state.scripts.length, 2);
  assert.equal(state.navigations.length, 1);
});

test('SDK timeout is bounded and an explicit retry can load a fresh script', async () => {
  const state = fixture({ enabled: true });
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'timeout',
  });
  assert.equal(state.scripts[0].removed, true);
  assert.equal(state.scripts[0].onload, null);
  const retry = state.bridge.requestWechatLogin();
  await new Promise(resolve => setImmediate(resolve));
  state.browser.wx = { miniProgram: state.sdk };
  state.scripts[1].onload();
  assert.equal((await retry).status, 'dispatched');
  assert.equal(state.navigations.length, 1);
});

test('getEnv timeout fails closed and later retries can recover without reloading the SDK', async () => {
  const state = fixture({ enabled: true });
  state.browser.wx = { miniProgram: state.sdk };
  const getEnv = state.sdk.getEnv;
  state.sdk.getEnv = () => {};
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'timeout',
  });
  state.sdk.getEnv = getEnv;
  assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
  assert.equal(state.navigations.length, 1);
});

test('server disablement is honored after an earlier enabled request', async () => {
  let capabilityReads = 0;
  const state = fixture({ enabled: true, fetchImpl: async (url) => {
    if (url.endsWith('/capabilities')) return Response.json(capabilities(++capabilityReads === 1));
  } });
  state.browser.wx = { miniProgram: state.sdk };
  assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
  assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'disabled', action: 'login' });
  assert.equal(state.navigations.length, 1);
});

test('non-login correlation IDs require crypto while login uses server-issued IDs', async () => {
  const state = fixture({ enabled: true });
  state.browser.wx = { miniProgram: state.sdk };
  state.browser.crypto = undefined;
  assert.deepEqual(await state.bridge.requestWechatCapability('phoneNumber'), {
    status: 'unavailable', action: 'phoneNumber', reason: 'random_unavailable',
  });
  assert.equal(state.navigations.length, 0);
  assert.equal((await state.bridge.requestWechatLogin()).status, 'dispatched');
  assert.equal(state.navigations.length, 1);
});

test('synchronous native login dispatch errors never claim success', async () => {
  const state = fixture({ enabled: true });
  state.browser.wx = { miniProgram: state.sdk };
  state.sdk.navigateTo = () => { throw new Error('Native dispatch unavailable'); };
  assert.deepEqual(await state.bridge.requestWechatLogin(), {
    status: 'unavailable', action: 'login', reason: 'navigation_error',
  });
});

test('inconsistent or version-mismatched session data never yields an authenticated session', async () => {
  const base = { protocol: 'medtalent.wechat', version: 1, enabled: false, authenticated: false, user: null };
  for (const body of [{ ...base, authenticated: true, user: { id: 'forged' } },
    { ...base, user: { id: 'unexpected' } }, { ...base, version: 2 },
    { ...base, enabled: true, authenticated: true, user: null }]) {
    const state = fixture({ fetchImpl: async () => Response.json(body) });
    const result = await state.bridge.readWechatSession();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.authenticated, undefined);
  }
});

test('server-authenticated session projects only public user fields and never saves tokens', async () => {
  const state = fixture({ fetchImpl: async () => Response.json({
    protocol: 'medtalent.wechat', version: 1, enabled: true, authenticated: true,
    user: { id: 'user-public-id', displayName: '用户', sessionKey: 'must-not-leak' }, token: 'must-not-leak',
  }) });
  assert.deepEqual(await state.bridge.readWechatSession(), {
    protocol: 'medtalent.wechat', version: 1, enabled: true, authenticated: true,
    user: { id: 'user-public-id', displayName: '用户' },
  });
  assert.equal(state.scripts.length, 0);
  assert.equal(state.navigations.length, 0);
});

test('login requires a server CSRF token before creating the pending transaction', async () => {
  const state = fixture({ enabled: true, fetchImpl: async (url) => {
    if (url.endsWith('/session')) return Response.json({ protocol: 'medtalent.wechat', version: 1,
      enabled: true, authenticated: false, user: null });
  } });
  state.browser.wx = { miniProgram: state.sdk };
  assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'unavailable', action: 'login', reason: 'invalid_response' });
  assert.equal(state.requests.some(request => request.init.method === 'POST'), false);
  assert.equal(state.navigations.length, 0);
});

test('malformed or unsafe login tickets cannot be persisted or passed to native code', async () => {
  const ticket = loginTicket();
  for (const body of [null, {}, { ...ticket, requestId: '../admin' }, { ...ticket, bridgeToken: 'short' },
    { ...ticket, bridgeToken: 'B'.repeat(64) }, { ...ticket, expiresAt: 'invalid' }]) {
    const state = fixture({ enabled: true, fetchImpl: async (url) => {
      if (url.endsWith('/login')) return Response.json(body);
    } });
    state.browser.wx = { miniProgram: state.sdk };
    assert.equal((await state.bridge.requestWechatLogin()).status, 'unavailable');
    assert.equal(state.navigations.length, 0);
    assert.equal(state.loginRequests.length, 0);
  }
});

test('login POST rejects HTTP errors, redirects, changed response origins and invalid JSON', async () => {
  const responses = [
    new Response('unavailable', { status: 503 }), new Response('<html>fallback</html>'),
    { ok: true, redirected: true, json: async () => loginTicket() },
    { ok: true, url: 'https://evil.test/api/wechat/login', json: async () => loginTicket() }
  ];
  for (const response of responses) {
    const state = fixture({ enabled: true, fetchImpl: async (url) => {
      if (url.endsWith('/login')) return response;
    } });
    state.browser.wx = { miniProgram: state.sdk };
    assert.equal((await state.bridge.requestWechatLogin()).status, 'unavailable');
    assert.equal(state.navigations.length, 0);
    assert.equal(state.loginRequests.length, 0);
  }
});

test('both login response headers and body have a deadline and abort the underlying request', { timeout: 1000 }, async () => {
  for (const phase of ['headers', 'body']) {
    const state = fixture({ enabled: true, fetchImpl: async (url) => {
      if (!url.endsWith('/login')) return;
      if (phase === 'headers') return new Promise(() => {});
      return { ok: true, json: async () => new Promise(() => {}) };
    } });
    state.browser.wx = { miniProgram: state.sdk };
    assert.deepEqual(await state.bridge.requestWechatLogin(), { status: 'unavailable', action: 'login', reason: 'timeout' });
    assert.equal(state.requests.at(-1).init.signal.aborted, true);
    assert.equal(state.navigations.length, 0);
    assert.equal(state.loginRequests.length, 0);
  }
});

test('failure to retain a pending request prevents navigation into an unrecoverable login flow', async () => {
  const state = fixture({ enabled: true, onLoginRequest: () => { throw new Error('Storage unavailable'); } });
  state.browser.wx = { miniProgram: state.sdk };
  assert.equal((await state.bridge.requestWechatLogin()).status, 'unavailable');
  assert.equal(state.navigations.length, 0);
});
