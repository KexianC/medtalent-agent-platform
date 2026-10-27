const { abortError } = require('./cancel.js');
function normalizeOrigin(value) {
  if (typeof value !== 'string') throw new Error('服务地址未配置。');
  const origin = value.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(origin) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) throw new Error('服务地址无效。');
  return origin;
}
function responseError(response) {
  const body = response.data;
  const error = new Error(body && (body.error || body.message) || '网络服务暂时不可用，请稍后重试。');
  error.status = response.statusCode;
  error.code = body && body.code;
  return error;
}
function createApi({ wx, origin, storage }) {
  origin = normalizeOrigin(origin);
  const cookieKey = 'medtalent:native-session:v1:' + origin;
  const jar = new Map();
  const requests = new Set();
  let cookieEpoch = 0;
  try {
    const saved = JSON.parse(storage.getItem(cookieKey) || 'null');
    if (saved && typeof saved.value === 'string' && /^[a-f0-9]{64}$/.test(saved.value) && saved.expiresAt > Date.now()) jar.set('medtalent_consumer', saved);
  } catch (_) { /* No cached login. */ }
  function persistCookie() {
    try {
      const item = jar.get('medtalent_consumer');
      if (item) storage.setItem(cookieKey, JSON.stringify(item));
      else storage.removeItem(cookieKey);
    } catch (_) { /* Requests remain available for this app session. */ }
  }
  function readCookies(response, epoch) {
    if (cookieEpoch !== epoch) return;
    let cookies = response.cookies;
    if (!Array.isArray(cookies)) {
      const header = response.header || {};
      const value = header['Set-Cookie'] || header['set-cookie'];
      cookies = typeof value === 'string' ? value.split(/,(?=\s*[A-Za-z_][\w-]*=)/) : Array.isArray(value) ? value : [];
    }
    for (const raw of cookies) {
      if (typeof raw !== 'string') continue;
      const parts = raw.split(';').map(value => value.trim());
      const pair = /^medtalent_consumer=([a-f0-9]*)$/.exec(parts[0]);
      if (!pair) continue;
      let expiresAt = Date.now() + 30 * 86400000;
      const expiry = parts.find(value => /^expires=/i.test(value));
      if (expiry) expiresAt = Date.parse(expiry.slice(8));
      const age = parts.find(value => /^max-age=/i.test(value));
      if (age) expiresAt = Date.now() + Number(age.slice(8)) * 1000;
      if (!pair[1] || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) jar.delete('medtalent_consumer');
      else if (/^[a-f0-9]{64}$/.test(pair[1])) jar.set('medtalent_consumer', { value: pair[1], expiresAt });
    }
    persistCookie();
  }
  function headers(value) {
    const header = { 'content-type': 'application/json', Accept: 'application/json' };
    for (const key of Object.keys(value || {})) {
      for (const existing of Object.keys(header)) if (existing.toLowerCase() === key.toLowerCase()) delete header[existing];
      if (key.toLowerCase() !== 'cookie') header[key] = value[key];
    }
    const cookie = jar.get('medtalent_consumer');
    if (cookie && cookie.expiresAt > Date.now()) header.Cookie = 'medtalent_consumer=' + cookie.value;
    else if (cookie) { jar.delete('medtalent_consumer'); persistCookie(); }
    return header;
  }
  function request(path, options = {}) {
    if (typeof path !== 'string' || !/^\/api\//.test(path) || /[\r\n\\]/.test(path)) throw new Error('请求地址无效。');
    let task;
    let settled = false;
    let rejectOperation;
    const epoch = cookieEpoch;
    const signal = options.signal;
    const cleanup = () => { signal && signal.removeEventListener('abort', cancel); requests.delete(cancel); };
    const cancel = () => {
      if (settled) return;
      settled = true; cleanup();
      rejectOperation(abortError());
      if (task && typeof task.abort === 'function') task.abort();
    };
    const promise = new Promise((resolve, reject) => {
      rejectOperation = reject;
      if (signal && signal.aborted) { settled = true; reject(abortError()); return; }
      requests.add(cancel);
      if (signal) signal.addEventListener('abort', cancel);
      try {
        task = wx.request({
          url: origin + path, method: options.method || 'GET', data: options.data,
          header: headers(options.header), timeout: options.timeout || 15000,
          responseType: options.responseType || 'text', dataType: options.dataType || 'json',
          success(response) {
            if (settled) return;
            settled = true; cleanup(); readCookies(response, epoch); resolve(response);
          },
          fail() { if (!settled) { settled = true; cleanup(); reject(new Error('网络连接暂时不可用，请检查网络后重试。')); } }
        });
      } catch (error) { settled = true; cleanup(); reject(error); }
    });
    return { promise, cancel };
  }
  async function json(path, options) {
    const response = await request(path, options).promise;
    if (response.statusCode < 200 || response.statusCode >= 300) throw responseError(response);
    return response.data;
  }
  // Fetch-shaped adapter lets the tested H5 CAS data store use wx.request.
  async function fetchImpl(path, options = {}) {
    const response = await request(path, { method: options.method, header: options.headers, data: options.body === undefined ? undefined : JSON.parse(options.body), signal: options.signal }).promise;
    return { status: response.statusCode, ok: response.statusCode >= 200 && response.statusCode < 300, json: async () => response.data };
  }
  const assetUrl = path => {
    if (!path || typeof path !== 'string') return '';
    if (/^https:\/\//i.test(path)) return path;
    if (path.startsWith('/assets/native/')) return path;
    if (/^\//.test(path) && !path.startsWith('//') && !/[\r\n\\]/.test(path)) return origin + path;
    return '';
  };
  return {
    origin, headers, request, json, fetchImpl, readCookies, responseError, assetUrl,
    listDoctors: () => json('/api/doctors'),
    getDoctor: slug => json('/api/doctors/' + encodeURIComponent(slug)),
    invalidateRequests() { cookieEpoch += 1; for (const cancel of [...requests]) cancel(); },
    clearSession() { cookieEpoch += 1; jar.clear(); persistCookie(); },
    dispose() { cookieEpoch += 1; for (const cancel of [...requests]) cancel(); }
  };
}
module.exports = { createApi, normalizeOrigin, responseError };
