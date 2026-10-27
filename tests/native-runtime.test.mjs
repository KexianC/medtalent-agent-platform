import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { once } from 'node:events';
import { createPlatformApp } from '../server/app.mjs';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import express from 'express';
import { registerSpeechRoutes } from '../server/speech-routes.mjs';

const nativeRoot = new URL('../wechat-native/', import.meta.url);
const modules = new Map();
function nativeModule(relative) {
  const filename = new URL(relative, nativeRoot);
  if (modules.has(filename.href)) return modules.get(filename.href).exports;
  const module = { exports: {} };
  modules.set(filename.href, module);
  const execute = vm.runInThisContext('(function(module,exports,require){\n' + fs.readFileSync(filename, 'utf8') + '\n})', { filename: filename.pathname });
  execute(module, module.exports, specifier => {
    assert.ok(specifier.startsWith('.'), 'native runtime dependencies must be local');
    return nativeModule(path.posix.relative(new URL('.', nativeRoot).pathname, new URL(specifier, filename).pathname));
  });
  return module.exports;
}
const { createRuntime, createStorage } = nativeModule('utils/runtime.js');
const { createApi, normalizeOrigin } = nativeModule('utils/api.js');
const { createUtf8Decoder } = nativeModule('utils/chat.js');
const { createSpeech } = nativeModule('utils/speech.js');
function memoryStorage() {
  const values = new Map();
  return { values, get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
let loginCodeSequence = 0;
function requestHost(options = {}) {
  const state = { code: options.code || 'same', counter: 0, requests: [], disabledChunks: options.disabledChunks || false };
  const wx = {
    login({ success }) { state.counter += 1; queueMicrotask(() => success({ code: state.code + '-' + ++loginCodeSequence })); },
    request(input) {
      state.requests.push(input);
      const controller = new AbortController();
      let chunkCallback;
      let headerCallback;
      queueMicrotask(async () => {
        try {
          const response = await fetch(input.url, {
            method: input.method, headers: input.header, signal: controller.signal,
            body: input.data === undefined ? undefined : input.data instanceof ArrayBuffer ? input.data : JSON.stringify(input.data)
          });
          const headers = Object.fromEntries(response.headers);
          if (headerCallback) headerCallback({ statusCode: response.status, header: headers });
          let data;
          if (input.enableChunked && chunkCallback && response.ok) {
            for await (const bytes of response.body) chunkCallback({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
            data = new ArrayBuffer(0);
          } else data = input.responseType === 'arraybuffer' ? await response.arrayBuffer() : input.dataType === 'text' ? await response.text() : await response.json();
          input.success({ statusCode: response.status, data, header: headers, cookies: response.headers.getSetCookie() });
        } catch (error) { input.fail(error); }
      });
      return {
        abort: () => controller.abort(),
        ...(state.disabledChunks ? {} : { onChunkReceived: callback => { chunkCallback = callback; } }),
        onHeadersReceived: callback => { headerCallback = callback; }
      };
    }
  };
  return { wx, state };
}
async function platformFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'medtalent-native-qa-'));
  const doctor = doctorProfiles.find(item => item.slug === 'tang-jinsong');
  const platform = await createPlatformApp({ dataDir: directory, seedDoctors: [doctor], startWorker: false, disableRateLimits: true,
    env: { WECHAT_APP_ID: 'wx7a4c71565eeee4b9', WECHAT_APP_SECRET: 'native-local-test-secret' },
    fetchImpl: async url => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://api.weixin.qq.com');
      return Response.json({ openid: parsed.searchParams.get('js_code').startsWith('other') ? 'openid-other' : 'openid-same', session_key: 'server-only-secret' });
    }
  });
  const server = platform.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await platform.close();
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('medtalent-native-qa-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { origin: 'http://127.0.0.1:' + server.address().port, doctor };
}
test('native login uses existing cookie + CSRF transaction, syncs two devices, isolates accounts and guests', async t => {
  const fixture = await platformFixture(t);
  const firstHost = requestHost();
  const firstStorage = memoryStorage();
  const first = createRuntime({ wx: firstHost.wx, storage: firstStorage, origin: fixture.origin });
  const second = createRuntime({ wx: requestHost().wx, storage: memoryStorage(), origin: fixture.origin });
  const other = createRuntime({ wx: requestHost({ code: 'other' }).wx, storage: memoryStorage(), origin: fixture.origin });
  t.after(() => { first.dispose(); second.dispose(); other.dispose(); });
  assert.equal(first.data.set(fixture.doctor.slug, 'profile-name', '游客名字'), true);
  const doctors = await first.api.listDoctors();
  assert.equal(doctors.length, 1);
  assert.equal((await first.api.getDoctor(fixture.doctor.slug)).slug, fixture.doctor.slug);
  await first.session.login(fixture.doctor.slug);
  assert.equal(first.session.get().status, 'authenticated');
  assert.throws(() => first.data.resetGuest(), /请先退出账户/);
  assert.equal(first.data.get(fixture.doctor.slug, 'profile-name', '').value, '');
  assert.equal(first.data.set(fixture.doctor.slug, 'profile-name', '微信账户名字'), true);
  await first.data.flush();
  assert.equal(first.data.get(fixture.doctor.slug, 'profile-name', '').status, 'synced', JSON.stringify(first.data.get(fixture.doctor.slug, 'profile-name', '')));
  await second.session.login(fixture.doctor.slug);
  assert.equal(second.session.get().user.id, first.session.get().user.id);
  assert.equal(second.readScope(fixture.doctor.slug, 'profile-name', ''), '微信账户名字');
  await other.session.login(fixture.doctor.slug);
  assert.notEqual(other.session.get().user.id, first.session.get().user.id);
  assert.equal(other.readScope(fixture.doctor.slug, 'profile-name', ''), '');
  const paths = firstHost.state.requests.map(input => new URL(input.url).pathname);
  const begin = paths.indexOf('/api/wechat/login');
  assert.deepEqual(paths.slice(begin, begin + 3), ['/api/wechat/login', '/api/wechat/login/complete', '/api/wechat/login/consume']);
  const request = firstHost.state.requests[begin];
  assert.match(request.header.Cookie, /^medtalent_consumer=[a-f0-9]{64}$/);
  assert.match(request.header['X-CSRF-Token'], /^[a-f0-9]{64}$/);
  for (const [key, value] of firstStorage.values) {
    assert.ok(!value.includes('server-only-secret'));
    if (key.startsWith('medtalent:consumer-data:')) assert.ok(!value.includes('csrfToken'));
  }
  await first.session.logout();
  assert.equal(first.readScope(fixture.doctor.slug, 'profile-name', ''), '游客名字');
});
test('native CAS conflicts require explicit resolution and privacy disables both saved chat sections', async t => {
  const fixture = await platformFixture(t);
  const create = () => createRuntime({ wx: requestHost().wx, storage: memoryStorage(), origin: fixture.origin });
  const first = create(); const second = create();
  t.after(() => { first.dispose(); second.dispose(); });
  await first.session.login(fixture.doctor.slug); await second.session.login(fixture.doctor.slug);
  first.data.set(fixture.doctor.slug, 'profile-name', '甲'); await first.data.flush();
  second.data.set(fixture.doctor.slug, 'profile-name', '乙'); await second.data.flush();
  const conflict = second.data.get(fixture.doctor.slug, 'profile-name', '');
  assert.equal(conflict.status, 'conflict'); assert.equal(conflict.value, '乙'); assert.equal(conflict.cloudValue, '甲');
  await second.data.resolveConflict(fixture.doctor.slug, 'profile-name', 'local');
  await first.data.load(fixture.doctor.slug); assert.equal(first.readScope(fixture.doctor.slug, 'profile-name', ''), '乙');
  const message = { id: 'native-message', role: 'user', text: '测试问题', createdAt: new Date().toISOString() };
  first.data.set(fixture.doctor.slug, 'chat-messages', [message]);
  first.data.set(fixture.doctor.slug, 'chat-assessments-v1', [{ id: 'assessment' }]);
  await first.data.flush();
  first.data.set(fixture.doctor.slug, 'privacy', { saveChat: false, voicePlayback: true, reminders: false });
  await first.data.flush();
  first.data.set(fixture.doctor.slug, 'chat-messages', [{ ...message, text: '仅当前会话' }]);
  await first.session.refresh();
  assert.equal(first.readScope(fixture.doctor.slug, 'chat-messages', [])[0].text, '仅当前会话');
  await second.data.load(fixture.doctor.slug);
  assert.deepEqual(second.readScope(fixture.doctor.slug, 'chat-messages', []), []);
  assert.deepEqual(second.readScope(fixture.doctor.slug, 'chat-assessments-v1', []), []);
});
test('guest import is explicit, merges existing IDs and removes guest copies only after confirmed sync', async t => {
  const fixture = await platformFixture(t);
  const runtime = createRuntime({ wx: requestHost().wx, storage: memoryStorage(), origin: fixture.origin });
  t.after(() => runtime.dispose());
  runtime.writeScope(fixture.doctor.slug, 'favorites', [{ id: 'guest-favorite', text: '本机收藏', createdAt: '2026-10-11T00:00:00.000Z' }]);
  await runtime.session.login(fixture.doctor.slug);
  assert.deepEqual(runtime.readScope(fixture.doctor.slug, 'favorites', []), []);
  assert.equal(runtime.data.hasGuestData(fixture.doctor.slug), true);
  await runtime.data.importGuest(fixture.doctor.slug);
  assert.equal(runtime.readScope(fixture.doctor.slug, 'favorites', [])[0].id, 'guest-favorite');
  assert.equal(runtime.data.hasGuestData(fixture.doctor.slug), false);
});
test('cancelled native login ignores a late wx.login callback and never completes or consumes identity', async t => {
  const fixture = await platformFixture(t);
  const host = requestHost(); let loginCallback;
  host.wx.login = ({ success }) => { loginCallback = success; };
  const runtime = createRuntime({ wx: host.wx, storage: memoryStorage(), origin: fixture.origin });
  t.after(() => runtime.dispose());
  const operation = runtime.session.login(fixture.doctor.slug);
  for (let attempt = 0; !loginCallback && attempt < 60; attempt += 1) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(typeof loginCallback, 'function');
  runtime.session.cancelLogin();
  loginCallback({ code: 'late-code-must-not-be-submitted' });
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(runtime.session.get().user, null);
  assert.equal(host.state.requests.some(input => /\/login\/(?:complete|consume)$/.test(input.url)), false);
});
test('cookie jar only forwards consumer session to the configured origin and rejects unsafe origins', async () => {
  for (const value of ['https://safe.test/path', 'https://user:pass@safe.test', 'http://safe.test', '//evil.test', 'https://safe.test?url=evil']) assert.throws(() => normalizeOrigin(value));
  const host = { request(input) { queueMicrotask(() => input.success({ statusCode: 200, data: {}, header: { 'Set-Cookie': 'admin_session=secret; Path=/, medtalent_consumer=' + 'a'.repeat(64) + '; Max-Age=1800; HttpOnly; SameSite=Lax' } })); return { abort() {} }; } };
  const api = createApi({ wx: host, storage: memoryStorage(), origin: 'https://safe.test' });
  await api.json('/api/wechat/session');
  assert.equal(api.headers().Cookie, 'medtalent_consumer=' + 'a'.repeat(64));
  assert.throws(() => api.request('https://evil.test/api/data'));
  assert.throws(() => api.request('//evil.test/api/data'));
  assert.equal(api.assetUrl('/api/assets/image.png'), 'https://safe.test/api/assets/image.png');
  api.clearSession(); assert.equal(api.headers().Cookie, undefined);
});
test('malformed native guest cache is preserved until explicit recovery and cannot be overwritten by editing', async () => {
  const storage = memoryStorage(); storage.setItem('medtalent:visitor-id', 'guest-test');
  const key = 'medtalent:guest-test:tang-jinsong:health-records'; storage.setItem(key, '{broken-original');
  const runtime = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
  const snapshot = runtime.data.get('tang-jinsong', 'health-records', []);
  assert.equal(snapshot.canEdit, false); assert.equal(snapshot.errorCode, 'INVALID_DATA');
  assert.equal(runtime.data.set('tang-jinsong', 'health-records', [{ id: 'would-overwrite' }]), false);
  assert.equal(storage.getItem(key), '{broken-original');
  await runtime.data.retry('tang-jinsong', 'health-records');
  assert.equal(storage.getItem(key), '{broken-original');
  assert.equal(runtime.data.get('tang-jinsong', 'health-records', []).canEdit, false);
  storage.setItem(key, JSON.stringify([{ id: 'repaired-record' }])); await runtime.data.retry('tang-jinsong', 'health-records');
  assert.equal(runtime.data.get('tang-jinsong', 'health-records', []).canEdit, true);
  assert.equal(runtime.readScope('tang-jinsong', 'health-records', [])[0].id, 'repaired-record');
  runtime.dispose();
});
test('guest save retries preserve memory-only records and recover the visitor namespace for a later launch', async t => {
  const durable = memoryStorage();
  let blocked = true;
  const storage = {
    getItem(key) { if (blocked) throw new Error('storage blocked'); return durable.getItem(key); },
    setItem(key, value) { if (blocked) throw new Error('storage blocked'); durable.setItem(key, value); },
    removeItem(key) { if (blocked) throw new Error('storage blocked'); durable.removeItem(key); }
  };
  const runtime = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
  t.after(() => runtime.dispose());
  const records = [{ id: 'pending-record', schemaVersion: 2, dateKey: '2026-10-11', createdAt: '2026-10-11T00:00:00Z', source: 'manage', completedTitles: [], metrics: { sleepDurationMinutes: 420 }, note: '尚未落盘' }];
  assert.equal(runtime.data.set('tang-jinsong', 'health-records', records), true);
  assert.equal(runtime.data.get('tang-jinsong', 'health-records', []).status, 'memory-only');
  await runtime.data.retry('tang-jinsong', 'health-records');
  assert.deepEqual(runtime.readScope('tang-jinsong', 'health-records', []), records);
  assert.equal(runtime.data.get('tang-jinsong', 'health-records', []).status, 'memory-only');
  blocked = false;
  await runtime.data.retry('tang-jinsong', 'health-records');
  assert.equal(runtime.data.get('tang-jinsong', 'health-records', []).status, 'ready');
  assert.ok(durable.getItem('medtalent:visitor-id'));
  const nextLaunch = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
  t.after(() => nextLaunch.dispose());
  assert.deepEqual(nextLaunch.readScope('tang-jinsong', 'health-records', []), records);
});
test('starting a new native guest clears every doctor scope and rotates identity without changing account caches', t => {
  const durable = memoryStorage();
  durable.setItem('medtalent:visitor-id', 'guest-original');
  durable.setItem('medtalent:guest-original:fu-rongfeng:health-records', JSON.stringify([{ id: 'unopened-doctor' }]));
  durable.setItem('medtalent:session:guest-original:yu-wen:chat-draft', 'former-private-draft');
  const retained = new Map([
    ['medtalent:consumer-data:v1:account-a', 'account-cache'],
    ['medtalent:native-session:v1:https://local-test.invalid', 'account-session'],
    ['medtalent:guest-other:yu-wen:health-records', 'other-visitor'],
    ['unrelated-preference', 'preference']
  ]);
  for (const [key, value] of retained) durable.setItem(key, value);
  const storage = createStorage({ getStorageSync: durable.getItem, setStorageSync: durable.setItem, removeStorageSync: durable.removeItem, getStorageInfoSync: () => ({ keys: [...durable.values.keys()] }) });
  const runtime = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
  t.after(() => runtime.dispose());
  runtime.data.set('tang-jinsong', 'profile-name', '旧游客名字');
  runtime.data.set('yu-wen', 'health-records', [{ id: 'loaded-doctor' }]);
  runtime.data.set('tang-jinsong', 'privacy', { saveChat: false });
  runtime.data.set('tang-jinsong', 'chat-messages', [{ id: 'temporary-private-reply' }]);
  assert.equal(runtime.data.resetGuest('tang-jinsong'), true);
  const nextVisitor = durable.getItem('medtalent:visitor-id');
  assert.notEqual(nextVisitor, 'guest-original');
  assert.equal([...durable.values.keys()].some(key => key.startsWith('medtalent:guest-original:') || key.startsWith('medtalent:session:guest-original:')), false);
  for (const [key, value] of retained) assert.equal(durable.getItem(key), value);
  assert.equal(runtime.readScope('tang-jinsong', 'profile-name', ''), '');
  assert.deepEqual(runtime.readScope('tang-jinsong', 'chat-messages', []), []);
  assert.deepEqual(runtime.readScope('yu-wen', 'health-records', []), []);
  assert.equal(runtime.data.hasGuestData('fu-rongfeng'), false);
  runtime.data.set('tang-jinsong', 'profile-name', '新游客名字');
  assert.equal(durable.getItem('medtalent:' + nextVisitor + ':tang-jinsong:profile-name'), JSON.stringify('新游客名字'));
  const nextLaunch = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
  t.after(() => nextLaunch.dispose());
  assert.equal(nextLaunch.readScope('tang-jinsong', 'profile-name', ''), '新游客名字');
});
test('guest reset reports unreadable storage, failed deletion and failed identity writes instead of reporting success', t => {
  for (const failure of ['enumerate', 'delete', 'rotate', 'silent-delete']) {
    const durable = memoryStorage();
    durable.setItem('medtalent:visitor-id', 'guest-original');
    durable.setItem('medtalent:guest-original:tang-jinsong:profile-name', JSON.stringify('仍属于原游客'));
    durable.setItem('medtalent:guest-original:yu-wen:health-records', JSON.stringify([{ id: 'still-private' }]));
    let armed = false;
    const storage = {
      getItem: durable.getItem,
      listKeys() { if (armed && failure === 'enumerate') throw new Error('unreadable'); return [...durable.values.keys()]; },
      setItem(key, value) { if (armed && failure === 'rotate' && key === 'medtalent:visitor-id' && value !== 'guest-original') throw new Error('no write'); durable.setItem(key, value); },
      removeItem(key) { if (armed && failure === 'delete' && key.includes(':yu-wen:')) throw new Error('no delete'); if (armed && failure === 'silent-delete') return; durable.removeItem(key); }
    };
    const runtime = createRuntime({ wx: requestHost().wx, storage, origin: 'https://local-test.invalid' });
    t.after(() => runtime.dispose());
    assert.equal(runtime.readScope('tang-jinsong', 'profile-name', ''), '仍属于原游客');
    const before = new Map(durable.values); armed = true;
    assert.throws(() => runtime.data.resetGuest(), /尚未开始清除|未完成清除/);
    assert.deepEqual(durable.values, before, failure);
    assert.equal(runtime.readScope('tang-jinsong', 'profile-name', ''), '仍属于原游客');
    armed = false;
    assert.equal(runtime.data.resetGuest(), true);
    assert.equal(runtime.readScope('tang-jinsong', 'profile-name', ''), '');
  }
});
async function streamFixture(t, route) {
  const app = express(); app.use(express.json()); app.post('/api/chat/stream', route);
  app.post('/api/chat', (_req, res) => res.json({ reply: '降级完整回复。', citations: [{ title: '公开来源', filename: 'private.pdf' }], retrievalMode: 'lexical' }));
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}
test('native chat handles split Chinese UTF-8, buffered fallback, notice filtering and citation projection', async t => {
  const origin = await streamFixture(t, (_req, res) => {
    res.set('content-type', 'application/x-ndjson');
    const bytes = Buffer.from(JSON.stringify({ type: 'delta', text: '中文回答。以上内容仅供健康科普参考，不构成诊断或治疗建议。' }) + '\n' + JSON.stringify({ type: 'done', citations: [{ title: '公开资料', filename: 'private-path.pdf' }], retrievalMode: 'hybrid' }) + '\n');
    for (let offset = 0; offset < bytes.length; offset += 2) res.write(bytes.subarray(offset, offset + 2));
    res.end();
  });
  for (const disabledChunks of [false, true]) {
    const runtime = createRuntime({ wx: requestHost({ disabledChunks }).wx, storage: memoryStorage(), origin });
    t.after(() => runtime.dispose());
    let incremental = '';
    const result = await runtime.chat.send({ doctorSlug: 'tang-jinsong', message: '你好' }, { onDelta: text => { incremental += text; } }).promise;
    assert.equal(result.reply, '中文回答。'); assert.equal(incremental, '中文回答。');
    assert.deepEqual(result.citations, [{ title: '公开资料' }]); assert.equal(result.retrievalMode, 'hybrid');
  }
  const decoder = createUtf8Decoder(); const bytes = new TextEncoder().encode('中文😀');
  let text = ''; for (const byte of bytes) text += decoder.push(Uint8Array.of(byte).buffer);
  text += decoder.push(undefined, true); assert.equal(text, '中文😀');
});
test('native chat falls back only on missing streaming route and cancellation prevents later UI events', async t => {
  const origin = await streamFixture(t, (req, res) => {
    if (req.body.message === 'fallback') return res.status(404).json({ error: 'missing' });
    res.set('content-type', 'application/x-ndjson'); res.flushHeaders();
    setTimeout(() => { if (!res.destroyed) res.end(JSON.stringify({ type: 'delta', text: '不应显示' }) + '\n' + JSON.stringify({ type: 'done' }) + '\n'); }, 20);
  });
  const runtime = createRuntime({ wx: requestHost().wx, storage: memoryStorage(), origin });
  t.after(() => runtime.dispose());
  assert.equal((await runtime.chat.send({ doctorSlug: 'tang-jinsong', message: 'fallback' }).promise).reply, '降级完整回复。');
  let count = 0; const operation = runtime.chat.send({ doctorSlug: 'tang-jinsong', message: 'cancel' }, { onDelta: () => { count += 1; } });
  operation.cancel(); await assert.rejects(operation.promise, { name: 'AbortError' });
  await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(count, 0);
});
function speechHost(httpHost) {
  const callbacks = {};
  const paths = new Map();
  const state = { permissions: [], recorderOptions: undefined, deleted: [], contexts: [] };
  const recorder = {
    onStart: callback => { callbacks.start = callback; }, onStop: callback => { callbacks.stop = callback; }, onError: callback => { callbacks.error = callback; },
    start(options) { state.recorderOptions = options; queueMicrotask(() => callbacks.start()); },
    stop() { const filePath = '/test/record.mp3'; const bytes = Uint8Array.of(73, 68, 51, 4).buffer; paths.set(filePath, bytes); queueMicrotask(() => callbacks.stop({ tempFilePath: filePath, duration: 1600, fileSize: bytes.byteLength })); }
  };
  const wx = Object.assign({}, httpHost || {}, {
    env: { USER_DATA_PATH: '/test' },
    getFileSystemManager: () => ({ readFile({ filePath, success }) { queueMicrotask(() => success({ data: paths.get(filePath) })); }, writeFile({ filePath, data, success }) { paths.set(filePath, data); queueMicrotask(success); }, unlink({ filePath, success }) { paths.delete(filePath); state.deleted.push(filePath); success(); } }),
    requirePrivacyAuthorize({ success }) { state.permissions.push('privacy'); queueMicrotask(success); },
    authorize({ scope, success }) { state.permissions.push(scope); queueMicrotask(success); },
    getRecorderManager: () => recorder,
    createInnerAudioContext() {
      const events = {}; const context = { onPlay: callback => { events.play = callback; }, onEnded: callback => { events.ended = callback; }, onError: callback => { events.error = callback; }, play() { queueMicrotask(() => { if (state.neverStarts) return; events.play(); if (!state.holdPlayback) events.ended(); }); }, stop() { context.stopped = true; }, destroy() { context.destroyed = true; } }; state.contexts.push(context); return context;
    }
  });
  return { wx, state };
}
test('native recorder requests privacy + microphone consent and existing ASR route receives raw supported MP3', async t => {
  let format; let received;
  const app = express();
  registerSpeechRoutes(app, { env: {}, limit: () => (_req, _res, next) => next(), recognizeSpeechImpl: async (bytes, _env, value) => { received = bytes; format = value; return '真实链路测试文本'; } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const host = speechHost(requestHost().wx); const origin = 'http://127.0.0.1:' + server.address().port;
  const runtime = createRuntime({ wx: host.wx, storage: memoryStorage(), origin }); t.after(() => runtime.dispose());
  await runtime.speech.startRecording(); const result = await runtime.speech.stopRecording();
  assert.deepEqual(host.state.permissions, ['privacy', 'scope.record']);
  assert.equal(host.state.recorderOptions.format, 'mp3'); assert.equal(host.state.recorderOptions.sampleRate, 16000);
  assert.equal(format, 'mp3'); assert.deepEqual([...received], [73, 68, 51, 4]);
  assert.equal(result.text, '真实链路测试文本'); assert.equal(result.durationSeconds, 2);
  assert.ok(host.state.deleted.includes('/test/record.mp3'));
});
test('cancelling recording never recognizes or submits the cancelled audio', async () => {
  const host = speechHost(); let requests = 0;
  const speech = createSpeech({ wx: host.wx, api: { json: async () => { requests += 1; return { text: '不应发送' }; } } });
  await speech.startRecording(); speech.cancelRecording();
  await assert.rejects(speech.stopRecording(), { name: 'AbortError' });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(requests, 0);
});
test('native TTS plays with InnerAudioContext, preserves long replies and cleans audio on cancellation', async () => {
  const host = speechHost(); const texts = [];
  const speech = createSpeech({ wx: host.wx, api: { request(_path, input) { texts.push(input.data.text); return { promise: Promise.resolve({ statusCode: 200, data: Uint8Array.of(73, 68, 51, 4).buffer }) }; } } });
  const content = '科普回复'.repeat(360);
  await speech.speak(content).promise;
  assert.equal(texts.join(''), content); assert.ok(texts.every(text => text.length <= 1200));
  assert.ok(host.state.contexts.every(context => context.destroyed));
  host.state.holdPlayback = true;
  const operation = speech.speak('可以取消播放');
  await new Promise(resolve => setImmediate(resolve));
  operation.cancel(); await assert.rejects(operation.promise, { name: 'AbortError' });
  assert.ok(host.state.contexts.at(-1).stopped); assert.ok(host.state.contexts.at(-1).destroyed);
  speech.dispose();
});
test('native audio that never starts fails with a bounded deadline and releases the context', async () => {
  const host = speechHost(); host.state.neverStarts = true;
  const speech = createSpeech({ wx: host.wx, api: { request() { return { promise: Promise.resolve({ statusCode: 200, data: Uint8Array.of(73, 68, 51, 4).buffer }) }; } } });
  await assert.rejects(speech.speak('超时测试', { startTimeoutMs: 5 }).promise, /等待超时/);
  assert.equal(host.state.contexts.at(-1).destroyed, true);
  speech.dispose();
});
