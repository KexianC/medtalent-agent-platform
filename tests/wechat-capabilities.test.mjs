import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../wechat-miniprogram/', import.meta.url);
const requestId = 'a'.repeat(32);
const bridgeToken = 'b'.repeat(64);
const loginOptions = { v: '1', action: 'login', requestId, bridgeToken };
const capabilityResponse = { protocol: 'medtalent.wechat', version: 1, capabilities: { login: { enabled: true } } };

function harness({ hasCaller = true, callerUrl, origin, actualCaller = false } = {}) {
  const calls = [];
  const requests = [];
  const logins = [];
  const timers = new Map();
  let sequence = 0;
  let page;
  const wx = {
    hideShareMenu: () => calls.push('hide-share'), setNavigationBarTitle: () => {},
    navigateBack: (options) => calls.push(['back', options.delta]), reLaunch: (options) => calls.push(['home', options.url]),
    canIUse: () => true, getNetworkType: (options) => options.success({ networkType: 'wifi' }),
    onNetworkStatusChange: () => {}, offNetworkStatusChange: () => {},
    showNavigationBarLoading: () => {}, hideNavigationBarLoading: () => {},
    login: (options) => { logins.push(options); },
    request: (options) => {
      const task = { abort: () => { task.aborted = true; options.fail({ errMsg: 'abort' }); }, aborted: false };
      requests.push({ ...options, task });
      return task;
    }
  };
  const load = (name, requires = {}) => {
    const scope = { module: { exports: {} }, wx,
      require: (path) => { assert.ok(path in requires, path); return requires[path]; },
      setTimeout: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id) };
    vm.runInNewContext(fs.readFileSync(new URL(name, root), 'utf8'), scope);
    return scope.module.exports;
  };
  const config = load('config.js');
  if (origin) config.h5Origin = origin;
  const routes = load('utils/routes.js');
  const bridge = load('utils/capabilities.js', { '../config.js': config, './routes.js': routes });
  let previous = { route: 'pages/webview/index', data: { src: callerUrl || config.h5Origin + '/d/tang-jinsong/ask', draft: 'retained' },
    loadPage: () => calls.push('reload-caller') };
  const callerLifecycle = { mountCount: 0, destroyCount: 0, draft: 'retained' };
  if (actualCaller) {
    vm.runInNewContext(fs.readFileSync(new URL('pages/webview/index.js', root), 'utf8'), {
      wx, Page: (definition) => { previous = definition; },
      require: (path) => path.includes('routes') ? routes : config,
      setTimeout: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
      clearTimeout: (id) => timers.delete(id)
    });
    previous.route = 'pages/webview/index';
    previous.setData = (next, callback) => {
      const oldSrc = previous.data.src;
      Object.assign(previous.data, next);
      // The production wx:if removes the WebView when its src becomes empty.
      // Model that lifecycle using the real WebView page, rather than a no-op loadPage stub.
      if (oldSrc && !previous.data.src) { callerLifecycle.destroyCount++; callerLifecycle.draft = ''; }
      if (!oldSrc && previous.data.src) callerLifecycle.mountCount++;
      callback?.();
    };
    previous.onLoad({ path: encodeURIComponent('/d/tang-jinsong/ask') });
    previous.onWebLoad({ currentTarget: { dataset: { attempt: previous.data.attempt } }, detail: { src: previous.data.src } });
  }
  vm.runInNewContext(fs.readFileSync(new URL('pages/capability/index.js', root), 'utf8'), {
    Page: (value) => { page = value; }, wx,
    getCurrentPages: () => hasCaller ? [previous, {}] : [{}],
    require: (path) => path.includes('capabilities') ? bridge : path.includes('routes') ? routes : config
  });
  page.setData = (data) => Object.assign(page.data, data);
  const respond = (data, statusCode = 200) => requests.at(-1).success({ statusCode, data });
  const approveCapability = () => respond(capabilityResponse);
  return { page, previous, callerLifecycle, calls, wx, bridge, requests, logins, timers, respond, approveCapability, config };
}

test('login requires a versioned transaction plus bridge token; other actions reject the token', () => {
  const { bridge } = harness();
  assert.equal(bridge.parseRequest(loginOptions).action, 'login');
  for (const bad of [
    { ...loginOptions, v: '2' }, { ...loginOptions, action: 'requestPayment' }, { ...loginOptions, action: '__proto__' },
    { ...loginOptions, requestId: '../admin' }, { ...loginOptions, returnUrl: 'https://evil.test' },
    { ...loginOptions, code: 'sensitive' }, { ...loginOptions, enabled: true }, { ...loginOptions, bridgeToken: undefined },
    { ...loginOptions, bridgeToken: 'short' }, { ...loginOptions, bridgeToken: 'B'.repeat(64) }, null
  ]) assert.equal(bridge.parseRequest(bad), null);
  for (const action of ['phoneNumber', 'payment', 'subscribeMessage']) {
    assert.equal(bridge.parseRequest({ v: '1', action, requestId }).action, action);
    assert.equal(bridge.parseRequest({ v: '1', action, requestId, bridgeToken }), null);
  }
});

test('phone/payment/subscribe remain disabled and cannot collect credentials', async () => {
  const { bridge, logins, requests } = harness();
  const capabilities = bridge.getCapabilities();
  for (const action of ['phoneNumber', 'payment', 'subscribeMessage']) {
    assert.equal(capabilities.capabilities[action].enabled, false);
    const operation = bridge.executeCapability(bridge.parseRequest({ v: '1', action, requestId }));
    assert.equal((await operation.promise).status, 'disabled');
  }
  capabilities.capabilities.login.enabled = false;
  assert.equal(bridge.definition('login').enabled, true);
  assert.equal(logins.length, 0);
  assert.equal(requests.length, 0);
});

test('H5 login gesture continues after server confirmation and returns without reloading its caller', async () => {
  const h = harness();
  const pending = h.page.onLoad(loginOptions);
  assert.equal(h.page.data.title, '微信一键登录');
  assert.equal(h.page.data.pending, true);
  assert.equal(h.logins.length, 0);
  assert.equal(h.requests[0].url, h.config.h5Origin + '/api/wechat/capabilities');
  assert.equal(h.requests[0].method, 'GET');
  await h.page.confirm();
  assert.equal(h.requests.length, 1, 'double taps cannot start another request');
  h.approveCapability();
  assert.equal(h.logins.length, 1);
  h.logins[0].success({ code: 'one-time-code' });
  const submitted = h.requests[1];
  assert.equal(submitted.url, h.config.h5Origin + '/api/wechat/login/complete');
  assert.equal(submitted.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.data)), { requestId, bridgeToken, code: 'one-time-code' });
  assert.equal('Cookie' in submitted.header || 'Authorization' in submitted.header, false);
  h.respond({ ok: true });
  await pending;
  assert.equal(h.page.data.completed, true);
  assert.equal(h.page.data.pending, false);
  assert.equal(h.page.request, null, 'transient bridge credentials released');
  assert.deepEqual(h.calls, ['hide-share', ['back', 1]]);
  assert.equal(h.previous.data.src, h.config.h5Origin + '/d/tang-jinsong/ask');
  assert.equal(h.previous.data.draft, 'retained');
  assert.equal(h.timers.size, 0);
});

test('successful native login preserves the real WebView mount, caller path and unsent draft', async () => {
  const h = harness({ actualCaller: true });
  const originalSrc = h.previous.data.src;
  const originalAttempt = h.previous.data.attempt;
  const pending = h.page.onLoad(loginOptions);
  h.approveCapability();
  h.logins[0].success({ code: 'one-time-code' });
  h.respond({ ok: true });
  await pending;
  assert.equal(h.previous.data.src, originalSrc);
  assert.equal(h.previous.data.attempt, originalAttempt);
  assert.equal(h.callerLifecycle.mountCount, 1);
  assert.equal(h.callerLifecycle.destroyCount, 0);
  assert.equal(h.callerLifecycle.draft, 'retained');
  assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['back', 1]]);
  assert.equal(h.timers.size, 0);
  h.previous.onUnload();
});

test('returning twice cannot pop the underlying WebView or submit a cancelled identity', async () => {
  const h = harness({ actualCaller: true });
  const pending = h.page.onLoad(loginOptions);
  h.approveCapability();
  h.page.goBack();
  h.page.goBack();
  h.page.onUnload();
  h.logins[0].success({ code: 'late-code' });
  await pending;
  assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['back', 1]]);
  assert.equal(h.requests.length, 1);
  assert.equal(h.callerLifecycle.destroyCount, 0);
  assert.equal(h.callerLifecycle.mountCount, 1);
  assert.equal(h.callerLifecycle.draft, 'retained');
  assert.equal(h.timers.size, 0);
  h.previous.onUnload();
});

test('a request-domain or network failure leaves core browsing mounted and can return once', async () => {
  const h = harness({ actualCaller: true });
  const pending = h.page.onLoad(loginOptions);
  h.requests[0].fail({ errMsg: 'request:fail url not in domain list' });
  await pending;
  assert.equal(h.page.data.completed, false);
  assert.equal(h.page.data.pending, false);
  assert.equal(h.logins.length, 0);
  h.page.goBack();
  h.page.goBack();
  assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['back', 1]]);
  assert.equal(h.callerLifecycle.destroyCount, 0);
  assert.equal(h.callerLifecycle.draft, 'retained');
  assert.equal(h.previous.data.src, h.config.h5Origin + '/d/tang-jinsong/ask');
  h.previous.onUnload();
});

test('direct no-parameter capability launches reach the public home once without login or completion', async () => {
  for (const options of [undefined, null, {}]) {
    const h = harness({ hasCaller: false });
    await h.page.onLoad(options);
    assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['home', '/pages/index/index']], 'cold launch must immediately reach public content');
    h.page.goBack();
    await h.page.confirm();
    assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['home', '/pages/index/index']]);
    assert.equal(h.requests.length, 0);
    assert.equal(h.logins.length, 0);
    assert.equal(h.page.data.completed, false);
    assert.equal(h.page.request, null);
  }
});

test('no-parameter capability navigation returns to an existing WebView without replacing core content', async () => {
  const h = harness({ actualCaller: true });
  await h.page.onLoad({});
  assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['back', 1]], 'no-parameter entry must immediately restore the existing core page');
  h.page.goBack();
  assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['back', 1]]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.logins.length, 0);
  assert.equal(h.callerLifecycle.destroyCount, 0);
  assert.equal(h.callerLifecycle.mountCount, 1);
  assert.equal(h.callerLifecycle.draft, 'retained');
  h.previous.onUnload();
});

test('nonempty malformed capability launches stay rejected rather than starting or pretending login', async () => {
  for (const options of ['', [], { v: '1' }, { action: 'login' }, { ...loginOptions, bridgeToken: 'short' }, { ...loginOptions, returnUrl: 'https://evil.test' }]) {
    const h = harness({ hasCaller: false });
    await h.page.onLoad(options);
    await h.page.confirm();
    assert.deepEqual(h.calls.filter(call => Array.isArray(call)), []);
    assert.equal(h.requests.length, 0);
    assert.equal(h.logins.length, 0);
    assert.equal(h.page.data.completed, false);
    assert.equal(h.page.data.enabled, false);
    h.page.goBack();
    h.page.goBack();
    assert.deepEqual(h.calls.filter(call => Array.isArray(call)), [['home', '/pages/index/index']]);
  }
});

test('disabled, malformed, failed or mismatched capabilities never invoke wx.login', async () => {
  for (const [body, status] of [
    [{ ...capabilityResponse, capabilities: { login: { enabled: false } } }, 200],
    [{ ...capabilityResponse, version: 2 }, 200], [{ ...capabilityResponse, protocol: 'other' }, 200],
    [{ capabilities: { login: { enabled: true } } }, 200], ['not-json', 200], [capabilityResponse, 503]
  ]) {
    const h = harness();
    const pending = h.page.onLoad(loginOptions);
    h.respond(body, status);
    await pending;
    assert.equal(h.logins.length, 0);
    assert.equal(h.page.data.completed, false);
    assert.equal(h.calls.includes('reload-caller'), false);
  }
});

test('direct launches, wrong caller origins/routes and invalid tokens cannot contact backend', async () => {
  for (const options of [{ hasCaller: false }, { callerUrl: 'https://evil.test/d/tang-jinsong' },
    { callerUrl: 'https://agent.hzmwmt.com.evil.test/d/tang-jinsong' }, { callerUrl: 'https://agent.hzmwmt.com/admin' }]) {
    const h = harness(options);
    await h.page.onLoad(loginOptions);
    assert.equal(h.page.data.enabled, false);
    assert.equal(h.requests.length, 0);
    h.page.goBack();
    assert.deepEqual(h.calls.at(-1), ['home', '/pages/index/index']);
  }
  const h = harness();
  await h.page.onLoad({ ...loginOptions, bridgeToken: undefined });
  assert.equal(h.requests.length, 0);
});

test('failed login is retryable and each retry obtains a fresh wx.login code', async () => {
  const h = harness();
  let pending = h.page.onLoad(loginOptions);
  h.approveCapability();
  h.logins[0].fail({ errMsg: 'network' });
  await pending;
  assert.equal(h.page.data.pending, false);
  assert.equal(h.page.data.enabled, true);
  pending = h.page.confirm();
  h.approveCapability();
  h.logins[1].success({ code: 'fresh-code' });
  h.respond({ ok: true });
  await pending;
  assert.equal(h.logins.length, 2);
  assert.equal(h.page.data.completed, true);
});

test('complete endpoint requires explicit success; HTTP errors and expiry never report login', async () => {
  for (const [body, status] of [[{}, 200], [{ authenticated: true }, 200], [{ ok: false }, 200], [{ ok: true }, 500], [{ ok: true }, 410]]) {
    const h = harness();
    const pending = h.page.onLoad(loginOptions);
    h.approveCapability();
    h.logins[0].success({ code: 'one-time-code' });
    h.respond(body, status);
    await pending;
    assert.equal(h.page.data.completed, false);
    assert.equal(h.page.data.pending, false);
    assert.equal(h.calls.includes('reload-caller'), false);
    if (status === 410) {
      assert.equal(h.page.data.enabled, false);
      assert.match(h.page.data.description, /失效/);
    }
  }
});

test('cancel during capability check aborts its request and ignores late responses', async () => {
  const h = harness();
  const pending = h.page.onLoad(loginOptions);
  h.page.goBack();
  assert.equal(h.requests[0].task.aborted, true);
  h.approveCapability();
  await pending;
  assert.equal(h.logins.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.page.request, null);
  assert.equal(h.calls.includes('reload-caller'), false);
});

test('unloading during wx.login prevents a late code from being submitted', async () => {
  const h = harness();
  const pending = h.page.onLoad(loginOptions);
  h.approveCapability();
  h.page.onUnload();
  h.logins[0].success({ code: 'late-code' });
  await pending;
  assert.equal(h.requests.length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.calls.includes('reload-caller'), false);
});

test('unloading during completion aborts network and cannot navigate on a late success', async () => {
  const h = harness();
  const pending = h.page.onLoad(loginOptions);
  h.approveCapability();
  h.logins[0].success({ code: 'late-code' });
  h.page.onUnload();
  assert.equal(h.requests[1].task.aborted, true);
  h.respond({ ok: true });
  await pending;
  assert.equal(h.calls.includes('reload-caller'), false);
  assert.equal(h.page.data.completed, false);
  assert.equal(h.timers.size, 0);
});

test('network and wx.login deadlines allow retry while ignoring obsolete callbacks', async () => {
  for (const stage of ['capabilities', 'login', 'complete']) {
    const h = harness();
    const pending = h.page.onLoad(loginOptions);
    if (stage !== 'capabilities') h.approveCapability();
    if (stage === 'complete') h.logins[0].success({ code: 'slow-code' });
    [...h.timers.values()][0]();
    await pending;
    assert.equal(h.page.data.enabled, true);
    assert.equal(h.page.data.pending, false);
    assert.equal(h.timers.size, 0);
    if (stage === 'login') h.logins[0].success({ code: 'too-late' });
    else h.respond(stage === 'complete' ? { ok: true } : capabilityResponse);
    assert.equal(h.page.data.completed, false);
    assert.equal(h.requests.length, stage === 'complete' ? 2 : 1);
  }
});

test('invalid origin and missing credentials fail closed', async () => {
  const invalid = harness({ origin: 'http://agent.hzmwmt.com' });
  const operation = invalid.bridge.executeCapability(invalid.bridge.parseRequest(loginOptions));
  assert.equal((await operation.promise).status, 'unavailable');
  assert.equal(invalid.requests.length, 0);
  for (const code of ['', undefined, 'x'.repeat(513)]) {
    const h = harness();
    const pending = h.page.onLoad(loginOptions);
    h.approveCapability();
    h.logins[0].success({ code });
    await pending;
    assert.equal(h.requests.length, 1);
    assert.equal(h.page.data.completed, false);
  }
});
