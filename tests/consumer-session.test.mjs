import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

// Each fixture evaluates a fresh three-module bundle so singleton session/store
// state and mocked browser globals cannot leak between users or tests.
const readSources = () => new Map(['consumerSession', 'consumerData', 'wechatBridge'].map(name => [name,
  ts.transpileModule(fs.readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText]));
const sources = readSources();
const pendingKey = 'medtalent:wechat-pending-login-v1';
const requestId = 'a'.repeat(32);
const protocol = { protocol: 'medtalent.wechat', version: 1 };
const session = (user = null) => ({ ...protocol, enabled: true, authenticated: !!user,
  user: user ? { id: user, displayName: '测试账号' } : null, csrfToken: user ? `csrf-${user}` : 'csrf-guest' });
const pending = () => ({ requestId, expiresAt: new Date(Date.now() + 300000).toISOString() });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
function manualClock() {
  let now = Date.now(), next = 0;
  const timers = new Map();
  return { get now() { return now; }, setTimeout(work, delay) { const id = ++next; timers.set(id, { work, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, async advance(ms) {
      const end = now + ms;
      for (let count = 0; count < 200; count++) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].work(); await tick();
      }
      now = end; await tick();
    } };
}

function fixture(handler = async () => Response.json(session()), { abortSignalApi = AbortSignal, clock, blockedStorage = false, sdkFailure = false } = {}) {
  const items = new Map();
  const requests = [];
  const navigations = [];
  const identities = [];
  const checkStorage = () => { if (blockedStorage) throw new Error('Storage unavailable'); };
  const storage = { getItem: key => { checkStorage(); return items.get(key) ?? null; }, setItem: (key, value) => { checkStorage(); items.set(key, value); }, removeItem: key => { checkStorage(); items.delete(key); } };
  const controls = { handler };
  const fetchMock = async (url, init = {}) => {
    requests.push({ url, init });
    return controls.handler(url, init);
  };
  const browser = {
    localStorage: storage, location: { href: 'https://agent.hzmwmt.com/d/tang-jinsong/ask' },
    navigator: { userAgent: 'MicroMessenger/8.0' }, crypto: webcrypto,
    wx: { miniProgram: { getEnv: callback => callback({ miniprogram: true }), navigateTo: options => navigations.push(options) } }
  };
  const document = { visibilityState: 'visible', head: { appendChild(script) { queueMicrotask(() => script.onerror()); } },
    createElement() { return { remove() {} }; } };
  if (sdkFailure) delete browser.wx;
  const graphSources = sources;
  const context = vm.createContext({ fetch: fetchMock, localStorage: storage, window: browser, document,
    AbortController, AbortSignal: abortSignalApi, Response, URL, Uint8Array,
    Date: clock ? class extends Date { static now() { return clock.now; } } : Date,
    setTimeout: clock ? clock.setTimeout : setTimeout, clearTimeout: clock ? clock.clearTimeout : clearTimeout });
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name).exports;
    assert.ok(graphSources.has(name), name);
    const module = { exports: {} };
    modules.set(name, module);
    const execute = vm.runInContext(`(function(require, module, exports) { ${graphSources.get(name)}\n})`, context);
    execute(path => load(path.replace(/^\.\//, '')), module, module.exports);
    return module.exports;
  }
  const dataStore = load('consumerData').consumerDataStore;
  const originalIdentity = dataStore.setIdentity;
  dataStore.setIdentity = next => { identities.push(plain(next)); originalIdentity(next); };
  const api = load('consumerSession');
  return { api, dataStore, items, requests, navigations, identities, controls, browser, document };
}

test('session imports are inert and each module graph starts without a previous account', async () => {
  const first = fixture(async () => Response.json(session('account-a')));
  assert.equal(first.requests.length, 0);
  assert.equal(first.api.getConsumerSession().status, 'loading');
  await first.api.refreshConsumerSession();
  assert.equal(first.api.getConsumerSession().user.id, 'account-a');
  const second = fixture();
  assert.equal(second.api.getConsumerSession().user, null);
  assert.equal(second.requests.length, 0);
});

test('pending transaction persists only correlation and expiry and consumes with session CSRF', async () => {
  const h = fixture(async url => Response.json(url.endsWith('/consume') ? session('account-a') : session()));
  const transaction = pending();
  h.api.rememberWechatRequest(transaction.requestId, transaction.expiresAt, 'must-not-persist');
  assert.deepEqual(JSON.parse(h.items.get(pendingKey)), transaction);
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().user.id, 'account-a');
  assert.equal(h.items.has(pendingKey), false);
  const consume = h.requests.find(request => request.url.endsWith('/consume'));
  assert.equal(consume.init.method, 'POST');
  assert.equal(consume.init.credentials, 'include');
  assert.equal(consume.init.headers['X-CSRF-Token'], 'csrf-guest');
  assert.deepEqual(JSON.parse(consume.init.body), { requestId });
  assert.deepEqual(h.identities, [{ userId: 'account-a', csrfToken: 'csrf-account-a' }]);
  assert.ok([...h.items.values()].every(value => !value.includes('csrf-') && !value.includes('must-not-persist')));
});

test('not-yet-complete transactions remain retryable but expired or rejected transactions are removed', async () => {
  for (const status of [409, 425, 400, 403, 410]) {
    const h = fixture(async url => url.endsWith('/consume') ? Response.json({ code: [409, 425].includes(status) ? 'LOGIN_PENDING' : 'LOGIN_REQUEST_INVALID' }, { status }) : Response.json(session()));
    h.api.rememberWechatRequest(requestId, pending().expiresAt);
    await h.api.refreshConsumerSession();
    assert.equal(h.api.getConsumerSession().status, 'guest');
    assert.equal(h.items.has(pendingKey), [409, 425].includes(status));
  }
});

test('invalid or malformed 409/425 consume failures end waiting and stop automatic polling', async () => {
  for (const [status, code] of [[409, 'LOGIN_REQUEST_INVALID'], [425, 'LOGIN_REQUEST_INVALID'], [409, 'UNKNOWN'], [409, null]]) {
    const clock = manualClock();
    const h = fixture(async url => url.endsWith('/consume') ? code === null ? new Response('<html>error</html>', { status }) : Response.json({ code }, { status }) : Response.json(session()), { clock });
    const unsubscribe = h.api.subscribeConsumerSession(() => {});
    try {
      h.api.rememberWechatRequest(requestId, pending().expiresAt);
      await clock.advance(4000);
      assert.equal(h.api.getConsumerSession().status, 'guest');
      assert.equal(h.api.getConsumerSession().loginPending, false);
      assert.match(h.api.getConsumerSession().error, /已失效/);
      assert.equal(h.items.has(pendingKey), false);
      const count = h.requests.length;
      await clock.advance(16000);
      assert.equal(h.requests.length, count);
    } finally { unsubscribe(); }
  }
});

test('malformed or expired stored transaction identifiers never reach consume', async () => {
  for (const data of ['bad-json', { requestId: '../admin', expiresAt: pending().expiresAt },
    { requestId, expiresAt: '2000-01-01T00:00:00.000Z' }, { requestId, expiresAt: 'invalid' }]) {
    const h = fixture();
    h.items.set(pendingKey, typeof data === 'string' ? data : JSON.stringify(data));
    await h.api.refreshConsumerSession();
    assert.equal(h.api.getConsumerSession().status, 'guest');
    assert.equal(h.requests.length, 1);
  }
});

test('overlapping refreshes share a request and notify subscribers only with the resulting identity', async () => {
  const gate = deferred();
  const h = fixture(() => gate.promise);
  let notifications = 0;
  const unsubscribe = h.api.subscribeConsumerSession(() => { notifications++; });
  const one = h.api.refreshConsumerSession();
  const two = h.api.refreshConsumerSession();
  assert.equal(h.requests.length, 1);
  gate.resolve(Response.json(session('account-a')));
  await Promise.all([one, two]);
  assert.equal(notifications, 1);
  unsubscribe();
});

test('logout aborts a pending session GET and ignores its late authenticated response', async () => {
  const h = fixture(async () => Response.json(session('account-a')));
  await h.api.refreshConsumerSession();
  const gate = deferred();
  let holdNextGet = true;
  h.controls.handler = async url => {
    if (url.endsWith('/logout')) return Response.json({ ok: true });
    if (holdNextGet) { holdNextGet = false; return gate.promise; }
    return Response.json(session());
  };
  const oldRefresh = h.api.refreshConsumerSession();
  const oldSignal = h.requests.at(-1).init.signal;
  await h.api.logoutConsumer();
  assert.equal(oldSignal.aborted, true);
  gate.resolve(Response.json(session('account-a')));
  await oldRefresh;
  assert.equal(h.api.getConsumerSession().user, null);
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.equal(h.identities.at(-1), null);
});

test('logout ignores a pending consume result even when the mock network ignores abort', async () => {
  const gate = deferred();
  const h = fixture(async url => url.endsWith('/consume') ? gate.promise : Response.json(url.endsWith('/logout') ? { ok: true } : session()));
  h.api.rememberWechatRequest(requestId, pending().expiresAt);
  const oldRefresh = h.api.refreshConsumerSession();
  await tick();
  assert.ok(h.requests.some(request => request.url.endsWith('/consume')));
  await h.api.logoutConsumer();
  gate.resolve(Response.json(session('old-account')));
  await oldRefresh;
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.equal(h.api.getConsumerSession().user, null);
  assert.ok(h.identities.every(value => value === null));
});

test('a refresh started while logout is pending cannot restore the old account after logout completes', async () => {
  const h = fixture(async () => Response.json(session('account-a')));
  await h.api.refreshConsumerSession();
  const logoutGate = deferred();
  const refreshGate = deferred();
  let firstGet = true;
  h.controls.handler = async url => {
    if (url.endsWith('/logout')) return logoutGate.promise;
    if (firstGet) { firstGet = false; return refreshGate.promise; }
    return Response.json(session());
  };
  const logout = h.api.logoutConsumer();
  const duringLogout = h.api.refreshConsumerSession();
  await tick();
  logoutGate.resolve(Response.json({ ok: true }));
  await tick();
  refreshGate.resolve(Response.json(session('account-a')));
  await Promise.all([logout, duringLogout]);
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.equal(h.api.getConsumerSession().user, null);
  assert.equal(h.identities.at(-1), null);
});

test('a slow consume body cannot erase a newer pending transaction after logout', async () => {
  const bodyGate = deferred();
  const h = fixture(async url => url.endsWith('/consume') ? { ok: true, json: () => bodyGate.promise }
    : Response.json(url.endsWith('/logout') ? { ok: true } : session()));
  h.api.rememberWechatRequest(requestId, pending().expiresAt);
  const oldRefresh = h.api.refreshConsumerSession();
  await tick();
  await h.api.logoutConsumer();
  const newRequest = 'c'.repeat(32);
  h.api.rememberWechatRequest(newRequest, pending().expiresAt);
  bodyGate.resolve(session('old-account'));
  await oldRefresh;
  assert.equal(h.api.getConsumerSession().user, null);
  assert.equal(JSON.parse(h.items.get(pendingKey)).requestId, newRequest);
});

test('network failure preserves a confirmed account and does not reset the cloud store identity', async () => {
  const h = fixture(async () => Response.json(session('account-a')));
  await h.api.refreshConsumerSession();
  const identityChanges = h.identities.length;
  h.controls.handler = async () => { throw new Error('offline'); };
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().status, 'authenticated');
  assert.equal(h.api.getConsumerSession().user.id, 'account-a');
  assert.match(h.api.getConsumerSession().error, /网络/);
  assert.equal(h.identities.length, identityChanges);
});

test('initial network failure and unsuccessful logout never fabricate a successful state change', async () => {
  const offline = fixture(async () => { throw new Error('offline'); });
  await offline.api.refreshConsumerSession();
  assert.equal(offline.api.getConsumerSession().status, 'error');
  assert.equal(offline.api.getConsumerSession().user, null);
  const h = fixture(async () => Response.json(session('account-a')));
  await h.api.refreshConsumerSession();
  h.controls.handler = async () => Response.json({ ok: false }, { status: 503 });
  await assert.rejects(h.api.logoutConsumer(), /退出登录失败/);
  assert.equal(h.api.getConsumerSession().user.id, 'account-a');
});

test('inconsistent session contracts never authenticate and user state omits backend-only fields', async () => {
  for (const body of [{ ...session('account-a'), protocol: 'unexpected' }, { ...session('account-a'), version: 2 },
    { ...session('account-a'), enabled: false }, { ...session(), user: { id: 'unexpected' } },
    { ...session('account-a'), user: null }]) {
    const h = fixture(async () => Response.json(body));
    await h.api.refreshConsumerSession();
    assert.equal(h.api.getConsumerSession().user, null);
    assert.equal(h.api.getConsumerSession().status, 'error');
    assert.equal(h.identities.length, 0);
  }
  const h = fixture(async () => Response.json({ ...session('account-a'),
    user: { id: 'account-a', displayName: '显示名', openid: 'private-id', sessionKey: 'private-key' } }));
  await h.api.refreshConsumerSession();
  assert.deepEqual(plain(h.api.getConsumerSession().user), { id: 'account-a', displayName: '显示名' });
});

test('actual H5 login bridge retains only request correlation before native dispatch', async () => {
  const h = fixture(async url => {
    if (url.endsWith('/capabilities')) return Response.json({ ...protocol, capabilities: {
      login: { enabled: true }, phoneNumber: { enabled: false }, payment: { enabled: false }, subscribeMessage: { enabled: false }
    } });
    if (url.endsWith('/login')) return Response.json({ ...pending(), bridgeToken: 'b'.repeat(64) });
    return Response.json(session());
  });
  await h.api.loginWithWechat();
  assert.deepEqual(Object.keys(JSON.parse(h.items.get(pendingKey))).sort(), ['expiresAt', 'requestId']);
  assert.equal(h.navigations.length, 1);
  assert.match(h.navigations[0].url, /^\/pages\/capability\/index\?v=1&action=login&requestId=/);
  assert.equal(h.api.getConsumerSession().status, 'guest', 'dispatch alone does not authenticate');
  assert.ok([...h.items.values()].every(value => !value.includes('b'.repeat(64)) && !value.includes('csrf-')));
});

test('guest and authenticated account pages remain usable without AbortSignal.any or timeout', async () => {
  const h = fixture(async url => Response.json(url.endsWith('/logout') ? { ok: true } : session('account-a')), { abortSignalApi: {} });
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().user.id, 'account-a');
  h.controls.handler = async url => Response.json(url.endsWith('/logout') ? { ok: true } : session());
  await h.api.logoutConsumer();
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.ok(h.requests.every(item => item.init.signal instanceof AbortSignal));
});

function loginHandler(controls) {
  return async url => {
    if (url.endsWith('/capabilities')) return Response.json({ ...protocol, capabilities: {
      login: { enabled: true }, phoneNumber: { enabled: false }, payment: { enabled: false }, subscribeMessage: { enabled: false }
    } });
    if (url.endsWith('/login')) return Response.json({ ...pending(), bridgeToken: 'b'.repeat(64) });
    if (url.endsWith('/consume')) return controls.ready ? Response.json(session('account-a')) : Response.json({ code: 'LOGIN_PENDING' }, { status: 425 });
    return Response.json(session());
  };
}

test('native completion is consumed without any focus or visibility event, then polling stops', async () => {
  const clock = manualClock(), controls = { ready: false };
  const h = fixture(loginHandler(controls), { clock });
  const unsubscribe = h.api.subscribeConsumerSession(() => {});
  try {
    await h.api.loginWithWechat();
    assert.equal(h.api.getConsumerSession().loginPending, true);
    await clock.advance(4000);
    assert.equal(h.api.getConsumerSession().status, 'guest');
    assert.equal(h.api.getConsumerSession().loginPending, true, '425 remains a friendly waiting state');
    controls.ready = true;
    await clock.advance(4000);
    assert.equal(h.api.getConsumerSession().user.id, 'account-a');
    assert.equal(h.api.getConsumerSession().loginPending, false);
    const count = h.requests.length;
    await clock.advance(12000);
    assert.equal(h.requests.length, count, 'completed login must not keep polling');
    const consume = h.requests.find(item => item.url.endsWith('/consume'));
    assert.equal(consume.init.credentials, 'include');
    assert.equal(consume.init.headers['X-CSRF-Token'], 'csrf-guest');
  } finally { unsubscribe(); }
});

test('pending polling pauses while hidden and resumes on return even when the host emits no event', async () => {
  const clock = manualClock(), controls = { ready: true };
  const h = fixture(loginHandler(controls), { clock });
  const unsubscribe = h.api.subscribeConsumerSession(() => {});
  try {
    await h.api.loginWithWechat();
    const count = h.requests.length;
    h.document.visibilityState = 'hidden';
    await clock.advance(12000);
    assert.equal(h.requests.length, count);
    h.document.visibilityState = 'visible';
    await clock.advance(4000);
    assert.equal(h.api.getConsumerSession().user.id, 'account-a');
  } finally { unsubscribe(); }
});

test('polling is bounded by expiry and unsubscribing stops an unfinished transaction', async () => {
  const clock = manualClock(), h = fixture(undefined, { clock });
  const unsubscribe = h.api.subscribeConsumerSession(() => {});
  h.api.rememberWechatRequest(requestId, new Date(clock.now + 3000).toISOString());
  await clock.advance(4000);
  assert.equal(h.api.getConsumerSession().loginPending, false);
  assert.match(h.api.getConsumerSession().error, /超时/);
  assert.equal(h.items.has(pendingKey), false);
  assert.equal(h.requests.length, 0);
  h.api.rememberWechatRequest(requestId, pending().expiresAt);
  unsubscribe();
  await clock.advance(8000);
  assert.equal(h.requests.length, 0);
});

test('blocked browser storage retains only in-memory correlation and can complete in the same WebView', async () => {
  const clock = manualClock(), controls = { ready: true };
  const h = fixture(loginHandler(controls), { clock, blockedStorage: true });
  const unsubscribe = h.api.subscribeConsumerSession(() => {});
  try {
    await h.api.loginWithWechat();
    assert.equal(h.navigations.length, 1);
    assert.equal(h.items.size, 0);
    await clock.advance(4000);
    assert.equal(h.api.getConsumerSession().user.id, 'account-a');
  } finally { unsubscribe(); }
});

test('SDK failure and native dispatch failure leave a usable guest and no orphaned pending login', async () => {
  const sdk = fixture(loginHandler({ ready: false }), { sdkFailure: true });
  await assert.rejects(sdk.api.loginWithWechat(), /登录组件/);
  assert.equal(sdk.api.getConsumerSession().status, 'guest');
  assert.equal(sdk.api.getConsumerSession().user, null);
  assert.equal(sdk.api.getConsumerSession().loginPending, false);
  const navigation = fixture(loginHandler({ ready: false }));
  navigation.browser.wx.miniProgram.navigateTo = () => { throw new Error('Native unavailable'); };
  await assert.rejects(navigation.api.loginWithWechat(), /无法打开/);
  assert.equal(navigation.api.getConsumerSession().status, 'guest');
  assert.equal(navigation.api.getConsumerSession().loginPending, false);
  assert.equal(navigation.items.has(pendingKey), false);
});

test('initial session header or body hangs become an error within 12 seconds and late identity is ignored', async () => {
  for (const phase of ['headers', 'body']) {
    const clock = manualClock(), gate = deferred();
    const h = fixture(() => phase === 'headers' ? gate.promise : { ok: true, json: () => gate.promise }, { clock });
    const loading = h.api.refreshConsumerSession();
    await clock.advance(12000); await loading;
    assert.equal(h.api.getConsumerSession().status, 'error');
    assert.equal(h.requests[0].init.signal.aborted, true);
    h.controls.handler = async () => Response.json(session('current-account'));
    await h.api.refreshConsumerSession();
    gate.resolve(phase === 'headers' ? Response.json(session('late-account')) : session('late-account'));
    await tick();
    assert.equal(h.api.getConsumerSession().user.id, 'current-account');
  }
});

test('initial cloud header or body hangs become retryable errors within 12 seconds without accepting late data', async () => {
  for (const phase of ['headers', 'body']) {
    const clock = manualClock(), gate = deferred();
    const h = fixture(url => url.includes('/api/user/data/') ? phase === 'headers' ? gate.promise : { ok: true, json: () => gate.promise } : Response.json(session('account-a')), { clock });
    await h.api.refreshConsumerSession();
    const loading = h.dataStore.load('tang-jinsong'); await tick();
    await clock.advance(12000); await loading;
    assert.equal(h.dataStore.get('tang-jinsong', 'privacy', null).canEdit, false);
    assert.match(h.dataStore.get('tang-jinsong', 'privacy', null).error, /超时/);
    const current = { documents: [{ section: 'profile-name', value: 'current-name', revision: 2 }] };
    h.controls.handler = async () => Response.json(current);
    await h.dataStore.load('tang-jinsong');
    const late = { documents: [{ section: 'profile-name', value: 'late-name', revision: 1 }] };
    gate.resolve(phase === 'headers' ? Response.json(late) : late); await tick();
    assert.equal(h.dataStore.get('tang-jinsong', 'profile-name', '').value, 'current-name');
  }
});

test('reconfirming an expired account after data 401 returns to real guest state and clears active private data', async () => {
  let expired = false;
  const h = fixture(async url => url.includes('/api/user/data/') ? Response.json(expired ? { code: 'UNAUTHORIZED' } : { documents: [{ section: 'profile-name', value: 'private-account-name', revision: 1 }] }, { status: expired ? 401 : 200 }) : Response.json(session(expired ? null : 'account-a')));
  await h.api.refreshConsumerSession(); await h.dataStore.load('tang-jinsong');
  assert.equal(h.dataStore.get('tang-jinsong', 'profile-name', '').value, 'private-account-name');
  expired = true;
  await h.dataStore.load('tang-jinsong');
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.equal(h.dataStore.get('tang-jinsong', 'profile-name', '').value, '');
  assert.equal(h.dataStore.get('tang-jinsong', 'profile-name', '').canEdit, false);
});

test('URL credentials and an independent guest WebView cannot authenticate without the initiating cookie transaction', async () => {
  const h = fixture();
  h.browser.location.href += `?bridgeToken=${'b'.repeat(64)}&token=fake&user=account-a#requestId=${requestId}`;
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().status, 'guest');
  assert.ok(h.requests.every(item => item.url === '/api/wechat/session'));
  h.api.rememberWechatRequest(requestId, pending().expiresAt);
  h.controls.handler = async url => url.endsWith('/consume') ? Response.json({ code: 'WRONG_INITIATING_SESSION' }, { status: 403 }) : Response.json(session());
  await h.api.refreshConsumerSession();
  assert.equal(h.api.getConsumerSession().user, null);
  assert.equal(h.api.getConsumerSession().loginPending, false);
});

test('ready native login completes without a browser event', async () => {
  const controls = { ready: true }, clock = manualClock();
  const h = fixture(loginHandler(controls), { clock });
  const unsubscribe = h.api.subscribeConsumerSession(() => {});
  try {
    await h.api.loginWithWechat(); await clock.advance(8000);
    assert.equal(h.api.getConsumerSession().status, 'authenticated');
    assert.equal(h.api.getConsumerSession().user.id, 'account-a');
    assert.equal(h.api.getConsumerSession().loginPending, false);
    assert.equal(h.requests.filter(item => item.url.endsWith('/consume')).length, 1);
  } finally { unsubscribe(); }
});

test('a hung first cloud body reaches its deadline and stays failed when late data arrives', async () => {
  const clock = manualClock(), gate = deferred();
  const h = fixture(url => url.includes('/api/user/data/') ? { ok: true, json: () => gate.promise } : Response.json(session('account-a')), { clock });
  await h.api.refreshConsumerSession();
  let complete = false;
  const loading = h.dataStore.load('tang-jinsong').then(() => { complete = true; });
  await tick(); await clock.advance(12000); await loading;
  assert.equal(complete, true);
  const result = h.dataStore.get('tang-jinsong', 'privacy', null);
  assert.equal(result.canEdit, false);
  assert.match(result.error, /超时/);
  gate.resolve({ documents: [{ section: 'profile-name', value: 'late-name', revision: 1 }] }); await tick();
  assert.equal(h.dataStore.get('tang-jinsong', 'profile-name', '').value, '');
});
