const { NativeAbortController, abortError } = require('./cancel.js');
function parseSession(body) {
  if (!body || body.protocol !== 'medtalent.wechat' || body.version !== 1 || typeof body.enabled !== 'boolean' || typeof body.authenticated !== 'boolean' || (!body.enabled && body.authenticated) || (!body.authenticated && body.user !== null)) throw new Error('暂时无法确认登录状态，请重试。');
  if (body.authenticated && (!body.user || typeof body.user.id !== 'string' || !body.user.id)) throw new Error('登录信息无效，请重新登录。');
  return {
    status: body.authenticated ? 'authenticated' : 'guest', enabled: body.enabled,
    user: body.authenticated ? { id: body.user.id, displayName: typeof body.user.displayName === 'string' ? body.user.displayName : '' } : null,
    csrfToken: typeof body.csrfToken === 'string' ? body.csrfToken : ''
  };
}
function createSession({ api, wx, cloud }) {
  let state = { status: 'loading', enabled: false, user: null, csrfToken: '' };
  let epoch = 0;
  let controller = new NativeAbortController();
  let refreshing;
  let signingIn;
  const listeners = new Set();
  const notify = next => { state = next; for (const listener of [...listeners]) listener(); };
  const apply = next => { cloud.setIdentity(next.user ? { userId: next.user.id, csrfToken: next.csrfToken } : null); notify(next); };
  function refresh() {
    if (signingIn) return signingIn;
    if (refreshing) return refreshing;
    const generation = epoch;
    const operation = api.json('/api/wechat/session', { signal: controller.signal }).then(parseSession).then(next => {
      if (generation === epoch) apply(next);
      return state;
    }).catch(error => {
      if (generation === epoch && error.name !== 'AbortError') notify(Object.assign({}, state, { status: state.user ? 'authenticated' : 'error', error: error.message }));
      return state;
    }).finally(() => { if (refreshing === operation) refreshing = undefined; });
    refreshing = operation;
    return operation;
  }
  function loginCode(signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); callback(value); };
      const abort = () => finish(reject, abortError());
      const timer = setTimeout(() => finish(reject, new Error('微信登录等待超时，请重试。')), 10000);
      signal.addEventListener('abort', abort);
      if (signal.aborted) return abort();
      try {
        wx.login({ timeout: 10000, success(result) {
          if (result && typeof result.code === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(result.code)) finish(resolve, result.code);
          else finish(reject, new Error('微信未返回有效登录凭证，请重试。'));
        }, fail() { finish(reject, new Error('微信登录未完成，请重试。')); } });
      } catch (error) { finish(reject, error); }
    });
  }
  function login(slug) {
    if (signingIn) return signingIn;
    const generation = epoch;
    const signal = controller.signal;
    const check = () => { if (generation !== epoch || signal.aborted) throw abortError(); };
    const operation = (async () => {
      await refresh(); check();
      if (!state.enabled || !/^[a-f0-9]{64}$/.test(state.csrfToken)) throw new Error('微信登录暂未开放，请稍后再试。');
      notify(Object.assign({}, state, { loginPending: true, error: undefined }));
      const transaction = await api.json('/api/wechat/login', { method: 'POST', header: { 'X-CSRF-Token': state.csrfToken }, data: { returnPath: slug ? '/d/' + slug : '/' }, signal });
      check();
      if (!transaction || !/^[a-f0-9]{32}$/.test(transaction.requestId) || !/^[a-f0-9]{64}$/.test(transaction.bridgeToken) || Date.parse(transaction.expiresAt) <= Date.now()) throw new Error('登录请求已失效，请重新点击登录。');
      const code = await loginCode(signal); check();
      const completed = await api.json('/api/wechat/login/complete', { method: 'POST', data: { requestId: transaction.requestId, bridgeToken: transaction.bridgeToken, code }, signal });
      check();
      if (!completed || completed.ok !== true) throw new Error('微信登录结果未确认，请重试。');
      const next = parseSession(await api.json('/api/wechat/login/consume', { method: 'POST', header: { 'X-CSRF-Token': state.csrfToken }, data: { requestId: transaction.requestId }, signal }));
      check();
      if (!next.user) throw new Error('微信登录结果未确认，请重试。');
      apply(next);
      if (slug) await cloud.load(slug);
      check(); return state;
    })().catch(error => { if (generation === epoch) notify(Object.assign({}, state, { loginPending: false, error: error.name === 'AbortError' ? undefined : error.message })); throw error; }).finally(() => { if (signingIn === operation) signingIn = undefined; });
    signingIn = operation;
    return operation;
  }
  function cancelLogin() {
    epoch += 1; controller.abort(); controller = new NativeAbortController(); refreshing = undefined; signingIn = undefined;
    notify(Object.assign({}, state, { loginPending: false }));
  }
  async function logout() {
    cancelLogin();
    api.invalidateRequests();
    await api.json('/api/wechat/logout', { method: 'POST', header: { 'X-CSRF-Token': state.csrfToken }, data: {} });
    api.clearSession();
    apply({ status: 'guest', enabled: state.enabled, user: null, csrfToken: '' });
    await refresh();
  }
  return { get: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, refresh, login, logout, cancelLogin, dispose: cancelLogin };
}
module.exports = { createSession, parseSession };
