import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { formatMedicalText } from '../src/lib/medicalText.ts';

const root = fileURLToPath(new URL('../wechat-native/', import.meta.url));
const doctor = doctorProfiles.find(item => item.slug === 'tang-jinsong');
const clone = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
function fixture(t, initial = {}, options = {}) {
  const subscriptions = { session: new Set(), data: new Set() };
  const records = new Map();
  const writes = [];
  const chats = [];
  const playbacks = [];
  const speechQueues = [];
  let account = { status: 'guest', enabled: true, user: null, csrfToken: 'local-test-csrf' };
  const owner = () => account.user ? account.user.id : 'guest';
  const documentKey = (slug, section, key = owner()) => key + ':' + slug + ':' + section;
  for (const [section, value] of Object.entries(initial)) records.set(documentKey(doctor.slug, section), clone(value));
  const get = (slug, section, fallback) => ({ value: records.has(documentKey(slug, section)) ? clone(records.get(documentKey(slug, section))) : clone(fallback), status: account.user ? 'synced' : 'ready', canEdit: !account.user || !account.blocked, revision: account.user ? 1 : null });
  const set = (slug, section, value) => {
    if (account.user && account.blocked) return false;
    writes.push({ owner: owner(), slug, section, value: clone(value) }); records.set(documentKey(slug, section), clone(value));
    for (const callback of [...subscriptions.data]) callback(); return true;
  };
  const runtime = {
    api: { getDoctor: async () => clone(doctor), assetUrl: value => 'https://test.invalid' + value },
    session: { get: () => account, subscribe(callback) { subscriptions.session.add(callback); return () => subscriptions.session.delete(callback); }, refresh: async () => account, login: async () => {}, logout: async () => {} },
    data: { get, set, subscribe(callback) { subscriptions.data.add(callback); return () => subscriptions.data.delete(callback); }, load: async () => {}, flush: async () => {}, hasGuestData: slug => [...records.keys()].some(key => key.startsWith('guest:' + slug + ':')), importGuest: async () => {}, resetGuest: slug => { for (const key of records.keys()) if (key.startsWith('guest:' + slug + ':')) records.delete(key); }, resolveConflict: async () => {} },
    chat: { send(body, handlers) { const deferred = defer(); const handle = { body, handlers, ...deferred, cancelled: false, cancel() { handle.cancelled = true; } }; chats.push(handle); return handle; } },
    speech: {
      speak(text, handlers) { const deferred = defer(); const handle = { text, handlers, ...deferred, cancelled: false, cancel() { handle.cancelled = true; const error = new Error('cancelled'); error.name = 'AbortError'; deferred.reject(error); } }; playbacks.push(handle); return handle; },
      createQueue(options) { const queue = { options, chunks: [], cancelled: false, push(text) { queue.chunks.push(text); }, finish: async () => {}, cancel() { queue.cancelled = true; } }; speechQueues.push(queue); return queue; },
      stopPlayback() {}, cancelRecording() {}, startRecording: async () => {}, stopRecording: async () => ({ text: '语音文本', durationSeconds: 2 })
    }
  };
  const modules = new Map();
  function load(filename) {
    if (filename === path.join(root, 'utils/runtime.js')) return { getRuntime: () => runtime };
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} }; modules.set(filename, module);
    const execute = vm.runInThisContext('(function(module,exports,require){\n' + fs.readFileSync(filename, 'utf8') + '\n})', { filename });
    execute(module, module.exports, specifier => load(path.resolve(path.dirname(filename), specifier)));
    return module.exports;
  }
  let definition;
  const windowInfo = options.windowInfo || { statusBarHeight: 20, windowWidth: 390, windowHeight: 800 };
  const wx = { getWindowInfo: () => windowInfo, getMenuButtonBoundingClientRect: () => ({ left: 292 }), showModal: options => options.success({ confirm: true }), showToast() {}, setClipboardData:options=>options.success&&options.success(), navigateBack() {}, reLaunch() {}, navigateTo() {}, ...(options.wx || {}), ...(options.nextTick ? { nextTick: options.nextTick } : {}) };
  const filename = path.join(root, 'pages/doctor/index.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: specifier => load(path.resolve(path.dirname(filename), specifier)), Page: value => { definition = value; }, wx, setTimeout, clearTimeout, setInterval, clearInterval, Date }, { filename });
  function createPage(query = { slug: doctor.slug, tab: 'ask' }) {
  const page = Object.assign({}, definition, { data: clone(definition.data), writes: [] });
  page.setData = (patch, callback) => {
    page.writes.push(patch);
    for (const [name, value] of Object.entries(patch)) {
      const keys = name.split('.'); let target = page.data;
      for (const key of keys.slice(0, -1)) { if (!target[key]) target[key] = {}; target = target[key]; }
      target[keys.at(-1)] = value;
    }
    if (callback) callback();
  };
  page.onLoad(query);
  t.after(() => page.onUnload());
  return page;
  }
  const page = createPage();
  const switchAccount = next => { account = { ...account, user: next && { id: next }, status: next ? 'authenticated' : 'guest' }; for (const callback of [...subscriptions.session]) callback(); };
  return { page, createPage, loadModule: relative => load(path.join(root,relative)), runtime, writes, chats, records, playbacks, speechQueues, subscriptions, switchAccount, get owner() { return owner(); } };
}
test('about portrait crops inside its white border without changing chat avatar geometry', async t => {
  const f = fixture(t); await tick(); const page = f.page;
  page.data.doctor = { ...page.data.doctor, portraitPosition: '50% 50%' };
  const assertCrop = (style, width, height, left, top) => {
    for (const [key, expected] of Object.entries({ width, height, left, top })) {
      const value = Number(style.match(new RegExp('(?:^|;)' + key + ':([^;]+)px;'))?.[1]);
      assert.ok(Number.isFinite(value) && Math.abs(value - expected) < 1e-8, `${key}: ${value} vs ${expected}`);
    }
  };
  page.portraitLoaded({ detail: { width: 400, height: 800 } });
  assertCrop(page.data.doctor.avatar62Style, 56, 112, 0, -28);
  assertCrop(page.data.doctor.avatar48Style, 48, 96, 0, -24);
  assertCrop(page.data.doctor.avatar36Style, 36, 72, 0, -18);
  const chatCrop = page.data.doctor.avatar48Style;
  page.data.doctor.avatar62Style = 'stale-about-crop';
  page.portraitLoaded({ detail: { width: 400, height: 800 } });
  assertCrop(page.data.doctor.avatar62Style, 56, 112, 0, -28);
  assert.equal(page.data.doctor.avatar48Style, chatCrop);
});

test('privacy checkbox taps preserve other preferences and cancelled clearing, then clear only after confirmation', async t => {
  const confirmations = [false, true], prompts = [];
  const storedMessages = [{ id: 'saved-user', role: 'user', text: '已保存的问题', createdAt: '2026-10-10T04:00:00Z' }];
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: true, reminders: true }, 'chat-messages': storedMessages, 'chat-assessments-v1': { saved: true } }, { wx: { showModal(options) { prompts.push(options.content); options.success({ confirm: confirmations.shift() }); } } });
  await tick();
  const tap = key => f.page.togglePrivacy({ currentTarget: { dataset: { key } } });
  await tap('reminders'); assert.deepEqual(clone(f.page.data.privacy), { saveChat: true, voicePlayback: true, reminders: false });
  await tap('reminders'); assert.equal(f.page.data.privacy.reminders, true);
  await tap('saveChat'); assert.equal(prompts.length, 1); assert.equal(f.page.data.privacy.saveChat, true);
  assert.deepEqual(f.runtime.data.get(doctor.slug, 'chat-messages', []).value, storedMessages);
  assert.deepEqual(f.runtime.data.get(doctor.slug, 'chat-assessments-v1', null).value, { saved: true });
  await tap('saveChat'); assert.equal(prompts.length, 2); assert.equal(f.page.data.privacy.saveChat, false);
  assert.deepEqual(f.runtime.data.get(doctor.slug, 'chat-messages', []).value, []);
  assert.equal(f.runtime.data.get(doctor.slug, 'chat-assessments-v1', null).value, null);
  assert.equal(f.page.data.privacy.voicePlayback, true); assert.equal(f.page.data.privacy.reminders, true);
  const writes = f.writes.length; await tap('unknown-key'); assert.equal(f.writes.length, writes);
  f.page.openPanel('privacy'); assert.equal(f.page.data.privacyParagraphs.length, 4);
});

test('recommended questions stay collapsed at entry, pause automatic follow and reset across tab or owner changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await tick(); const page = f.page;
  assert.equal(page.data.suggestionsOpen, false);
  page._messages = [...page._messages, { id: 'reading-user', role: 'user', text: '已有问题', createdAt: new Date().toISOString() }];
  page.scrollBottom(true); const before = page.writes.length;
  page.toggleSuggestions(); assert.equal(page.data.suggestionsOpen, true); assert.equal(page._followChat, false);
  t.mock.timers.tick(100);
  assert.equal(page.writes.slice(before).some(patch => patch.scrollTarget === 'chat-bottom'), false);
  page.refreshData(); assert.equal(page.data.suggestionsOpen, true);
  page.toggleSuggestions(); assert.equal(page.data.suggestionsOpen, false);
  page.toggleSuggestions(); page.switchTab('home'); t.mock.timers.tick(200); page.switchTab('ask');
  assert.equal(page.data.suggestionsOpen, false);
  page.toggleSuggestions(); f.switchAccount('another-owner');
  assert.equal(page.data.suggestionsOpen, false);
});

test('doctor panels retain their content through exit, ignore duplicate close and cancel an old exit when reopened', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await tick();
  const { EXIT_DURATION } = f.loadModule('utils/sheet-motion.js');
  for (const panel of ['profile', 'privacy', 'about', 'favorites', 'history', 'records']) {
    f.page.openPanel(panel); assert.equal(f.page.data.activePanel, panel); assert.equal(f.page.data.sheetMotion, 'sheet-enter'); assert.equal(f.page.data.backdropMotion, 'backdrop-enter');
    f.page.closePanel(); assert.equal(f.page.data.activePanel, panel); assert.equal(f.page.data.sheetMotion, 'sheet-exit'); assert.equal(f.page.data.backdropMotion, 'backdrop-exit');
    t.mock.timers.tick(200); f.page.closePanel(); t.mock.timers.tick(EXIT_DURATION - 201); assert.equal(f.page.data.activePanel, panel);
    t.mock.timers.tick(1); assert.equal(f.page.data.activePanel, '');
  }
  f.page.openPanel('privacy'); f.page.closePanel(); t.mock.timers.tick(200); f.page.openPanel('about'); t.mock.timers.tick(EXIT_DURATION);
  assert.equal(f.page.data.activePanel, 'about'); assert.equal(f.page.data.sheetMotion, 'sheet-enter');
  f.page.openLegacyRecords(); assert.equal(f.page.data.activePanel, 'records'); assert.equal(f.page.data.panelTitle, '健康档案'); assert.equal(f.page.data.sheetMotion, 'sheet-enter');
});

test('doctor tab, owner, hide and unload cancel delayed panel cleanup before another panel can open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await tick();
  const { EXIT_DURATION } = f.loadModule('utils/sheet-motion.js');
  f.page.openPanel('privacy'); f.page.closePanel(); f.switchAccount('other'); assert.equal(f.page.data.activePanel, '');
  f.page.openPanel('profile'); t.mock.timers.tick(EXIT_DURATION); assert.equal(f.page.data.activePanel, 'profile');
  f.page.closePanel(); f.page.switchTab('home'); assert.equal(f.page.data.activePanel, '');
  f.page.openPanel('about'); t.mock.timers.tick(EXIT_DURATION); assert.equal(f.page.data.activePanel, 'about');
  f.page.closePanel(); f.page.onHide(); assert.equal(f.page.data.activePanel, ''); f.page.onShow(); await tick();
  f.page.openPanel('favorites'); t.mock.timers.tick(EXIT_DURATION); assert.equal(f.page.data.activePanel, 'favorites');
  f.page.closePanel(); f.page.onUnload(); const mutations = f.page.writes.length; t.mock.timers.tick(EXIT_DURATION); assert.equal(f.page.writes.length, mutations);
});

test('doctor tabs retain exiting content, coalesce quick targets and keep wellness view with its mounted tab', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await tick(); const page = f.page;
  assert.equal(page.data.renderedTab, 'ask'); assert.equal(page.data.tabMotion, ''); assert.equal(page.data.contentEntryMotion, false);
  page.switchTab('home'); assert.equal(page.data.tab, 'home'); assert.equal(page.data.renderedTab, 'ask'); assert.equal(page.data.tabMotion, 'tab-exit');
  t.mock.timers.tick(90); page.openWellness('assessment');
  assert.equal(page.data.tab, 'services'); assert.equal(page.data.wellnessView, 'assessment'); assert.equal(page.data.renderedWellnessView, '');
  t.mock.timers.tick(109); assert.equal(page.data.renderedTab, 'ask');
  t.mock.timers.tick(1); assert.equal(page.data.renderedTab, 'services'); assert.equal(page.data.renderedWellnessView, 'assessment'); assert.equal(page.data.tabMotion, 'tab-initial');
  t.mock.timers.tick(16); assert.equal(page.data.tabMotion, 'tab-enter');
  assert.equal(page.writes.some(patch => patch.renderedTab === 'home'), false);
  page.openWellness('diary'); t.mock.timers.tick(80); page.openWellness('health');
  assert.equal(page.data.renderedTab, 'services'); assert.equal(page.data.renderedWellnessView, 'assessment');
  t.mock.timers.tick(120); assert.equal(page.data.renderedTab, 'manage'); assert.equal(page.data.renderedWellnessView, 'health');
  page.openWellness('goals'); assert.equal(page.data.renderedWellnessView, 'goals'); assert.equal(page.data.tabMotion, '');
  page.switchTab('home'); t.mock.timers.tick(100); page.openWellness('goals');
  assert.equal(page.data.renderedTab, 'manage'); assert.equal(page.data.tabMotion, '');
  const mounted = page.writes.filter(patch => 'renderedTab' in patch).length;
  t.mock.timers.tick(300); assert.equal(page.data.renderedTab, 'manage'); assert.equal(page.writes.filter(patch => 'renderedTab' in patch).length, mounted);
});

test('tab next-frame entry cannot overwrite an interrupted exit, reversed tab, new owner or hidden page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const frames = [];
  const f = fixture(t, {}, { nextTick: callback => frames.push(callback) }); await tick(); const page = f.page;
  page.switchTab('home'); t.mock.timers.tick(200); assert.equal(page.data.tabMotion, 'tab-initial'); assert.equal(frames.length, 1);
  page.switchTab('manage'); frames.shift()(); assert.equal(page.data.tabMotion, 'tab-exit'); assert.equal(page.data.renderedTab, 'home');
  page.switchTab('home'); assert.equal(page.data.tabMotion, ''); t.mock.timers.tick(250); assert.equal(page.data.renderedTab, 'home');
  page.switchTab('services'); t.mock.timers.tick(200); const formerOwnerFrame = frames.shift(); f.switchAccount('new-owner'); const ownerWrites = page.writes.length; formerOwnerFrame(); assert.equal(page.writes.length, ownerWrites); assert.equal(page.data.contentEntryMotion, false);
  page.switchTab('manage'); t.mock.timers.tick(200); const hiddenFrame = frames.shift(); page.onHide(); const hiddenWrites = page.writes.length; hiddenFrame(); assert.equal(page.writes.length, hiddenWrites); assert.equal(page.data.tabMotion, '');
  page.onShow(); await tick(); page.switchTab('me'); t.mock.timers.tick(200); const unloadFrame = frames.shift(); page.onUnload(); const unloadWrites = page.writes.length; unloadFrame(); assert.equal(page.writes.length, unloadWrites);
});

test('chat smooth requests are superseded by streaming auto in the same frame and require a user message', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false } }); await tick(); const page = f.page;
  const greetingWrites = page.writes.filter(patch => 'scrollTarget' in patch).length; page.scrollBottom(); t.mock.timers.tick(30); assert.equal(page.writes.filter(patch => 'scrollTarget' in patch).length, greetingWrites);
  const sending = page.sendQuestion('滚动到新问题'); assert.equal(page.data.chatScrollAnimated, true);
  t.mock.timers.tick(10); f.chats[0].handlers.onDelta('第一段'); assert.equal(page.data.chatScrollAnimated, false);
  t.mock.timers.tick(10); f.chats[0].handlers.onDelta('第二段'); t.mock.timers.tick(10);
  assert.equal(page.data.scrollTarget, 'chat-bottom'); assert.equal(page.data.chatScrollAnimated, false);
  assert.equal(page.writes.some(patch => patch.scrollTarget === 'chat-bottom' && patch.chatScrollAnimated === true), false);
  f.chats[0].resolve({ reply: '完整回复' }); await sending; t.mock.timers.tick(30); assert.equal(page.data.chatScrollAnimated, true);
  const unchangedWrites = page.writes.filter(patch => 'scrollTarget' in patch).length; page.refreshData(); t.mock.timers.tick(30); assert.equal(page.writes.filter(patch => 'scrollTarget' in patch).length, unchangedWrites);
  page.scrollBottom(false); page.switchTab('home'); const leavingWrites = page.writes.filter(patch => patch.scrollTarget === 'chat-bottom').length; t.mock.timers.tick(250); assert.equal(page.writes.filter(patch => patch.scrollTarget === 'chat-bottom').length, leavingWrites);
});

test('health viewport margins use measured content bounds and discard stale measurements', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const f = fixture(t); await tick(); const page = f.page, queries = [];
  page.createSelectorQuery = () => ({ select(selector) { assert.equal(selector, '.panel-scroll'); return this; }, boundingClientRect(callback) { queries.push(callback); return this; }, exec() {} });
  page.switchTab('manage'); t.mock.timers.tick(200); const initial = queries.at(-1); page.measurePanelViewport(); const current = queries.at(-1);
  initial({ top: 10, bottom: 790 }); assert.equal(page.data.panelViewportMargins, null);
  current({ top: 64, bottom: 700 }); assert.deepEqual(clone(page.data.panelViewportMargins), { top: -64, bottom: -100, left: 0, right: 0 });
  page.onResize(); const resizing = queries.at(-1); page.switchTab('home'); resizing({ top: 80, bottom: 680 }); assert.equal(page.data.panelViewportMargins.top, -64);
  t.mock.timers.tick(200); page.switchTab('manage'); t.mock.timers.tick(200); const formerOwner = queries.at(-1); f.switchAccount('new-owner'); formerOwner({ top: 80, bottom: 680 }); assert.equal(page.data.panelViewportMargins, null);
});

test('doctor tab timers cannot mount stale content after owner changes, blocked recovery, hide or unload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t); await tick(); const page = f.page;
  page.switchTab('manage'); t.mock.timers.tick(100); f.switchAccount('new-owner');
  assert.equal(page.data.renderedTab, 'home'); assert.equal(page.data.contentEntryMotion, false);
  page.switchTab('services'); t.mock.timers.tick(100); assert.equal(page.data.renderedTab, 'home'); t.mock.timers.tick(100); assert.equal(page.data.renderedTab, 'services');
  page.switchTab('me'); f.runtime.session.get().blocked = true; page.refreshData();
  assert.equal(page.data.dataBlocked, true); assert.equal(page.data.tabMotion, '');
  t.mock.timers.tick(500); f.runtime.session.get().blocked = false; page.refreshData();
  assert.equal(page.data.dataBlocked, false); assert.equal(page.data.renderedTab, 'me'); assert.equal(page.data.contentEntryMotion, false);
  page.switchTab('manage'); t.mock.timers.tick(50); page.onHide(); assert.equal(page.data.renderedTab, 'manage'); assert.equal(page.data.tabMotion, '');
  page.onShow(); await tick(); page.switchTab('home'); t.mock.timers.tick(150); assert.equal(page.data.renderedTab, 'manage');
  t.mock.timers.tick(50); assert.equal(page.data.renderedTab, 'home');
  page.switchTab('ask'); page.onUnload(); const mutations = page.writes.length; t.mock.timers.tick(1000); assert.equal(page.writes.length, mutations);
});

test('message motion skips first restored rows, enters new rows once and re-enters after remount without persisting presentation flags', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false }, 'chat-messages': [{ id: 'old-user', role: 'user', text: '之前的问题', createdAt: '2026-10-10T04:00:00Z' }, { id: 'old-reply', role: 'assistant', text: '之前的回复', createdAt: '2026-10-10T04:01:00Z' }] }); await tick();
  const page = f.page; assert.ok(page.data.messages.every(message => message.enterMotion === false));
  const sending = page.sendQuestion('新的问题'); const newUser = page.data.messages.at(-1); assert.equal(newUser.enterMotion, true);
  f.chats[0].handlers.onDelta('正在回答'); page.refreshData(); assert.equal(page.data.messages.find(message => message.id === newUser.id).enterMotion, true); assert.equal(page.data.messages.find(message => message.id === 'old-user').enterMotion, false);
  f.chats[0].resolve({ reply: '新的回复' }); await sending; assert.equal(page.data.messages.at(-1).enterMotion, true);
  assert.equal(f.writes.filter(write => write.section === 'chat-messages').some(write => write.value.some(message => 'enterMotion' in message)), false);
  page.switchTab('home'); t.mock.timers.tick(200); page.switchTab('ask'); t.mock.timers.tick(200); assert.ok(page.data.messages.every(message => message.enterMotion === true));
  page.setData({ reduceMotion: true }); page.switchTab('home'); page.switchTab('ask'); assert.equal(page.data.renderedTab, 'ask'); assert.equal(page.data.tabMotion, ''); assert.equal(page.data.contentEntryMotion, false); assert.ok(page.data.messages.every(message => message.enterMotion === true));
  f.switchAccount('another-owner'); assert.equal(page.data.messages.some(message => message.id === 'old-user'), false); assert.ok(page.data.messages.every(message => message.enterMotion === false));
});

test('doctor page rejects incomplete/errored streams, retries without a duplicate user question, and keeps title-only citations', async t => {
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false, reminders: true } }); await tick();
  const first = f.page.sendQuestion('最近睡不好'); assert.equal(f.chats.length, 1);
  f.chats[0].handlers.onDelta('还未完成'); assert.equal(f.page.data.streamingReply, '还未完成');
  f.chats[0].reject(new Error('智能问答流意外中断，请点击重试。')); await first;
  assert.equal(f.page.data.busy, false); assert.equal(f.page.data.streamingReply, '');
  const failed = f.page._messages.find(message => message.error); assert.equal(failed.retryText, '最近睡不好');
  f.page.retryMessage({ currentTarget: { dataset: { id: failed.id } } });
  assert.equal(f.chats.length, 2);
  f.chats[1].resolve({ reply: '建议先记录睡眠变化。', citations: [{ title: '公开资料' }], retrievalMode: 'lexical' }); await tick();
  assert.equal(f.page._messages.filter(message => message.role === 'user' && message.text === '最近睡不好').length, 1);
  assert.equal(f.page._messages.filter(message => message.error).length, 0);
  assert.equal(f.page._messages.at(-1).text, '建议先记录睡眠变化。');
  assert.deepEqual(clone(f.page.data.messages.at(-1).citations.map(item => item.title)), ['公开资料']);
});

test('guidance receives acceptance only after a real reply and failure leaves its request unaccepted', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false,reminders:true}});await tick();
  f.page.openAsk({detail:{question:'从心情展开',sendNow:true,guidanceRequestId:'failed-request'}});
  assert.equal(f.page.data.guidanceAck,null);f.chats[0].reject(new Error('回复暂时不可用'));await tick();
  assert.deepEqual(clone(f.page.data.guidanceAck),{requestId:'failed-request',accepted:false});
  f.page.openAsk({detail:{question:'再次发送',sendNow:true,guidanceRequestId:'accepted-request'}});
  f.chats[1].resolve({reply:'收到，先记录今天的感受。'});await tick();
  assert.deepEqual(clone(f.page.data.guidanceAck),{requestId:'accepted-request',accepted:true});
  f.page.setData({dataBlocked:true});assert.equal(await f.page.sendQuestion('不能发送'),false);
});
test('typing and sending remain available while TTS plays and a new send cancels playback', async t => {
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false, reminders: true } }); await tick();
  const message = { id: 'read-aloud', role: 'assistant', text: '播报中的回复', createdAt: new Date().toISOString() };
  const speaking = f.page.speak(message); f.playbacks[0].handlers.onState('playing');
  assert.equal(f.page.data.playbackStatus, 'playing'); assert.equal(f.page.data.interactionLocked, false);
  f.page.inputChanged({ detail: { value: '继续提问' } }); assert.equal(f.page.data.input, '继续提问');
  const sending = f.page.sendQuestion(f.page.data.input);
  assert.equal(f.chats.length, 1); assert.equal(f.playbacks[0].cancelled, true);
  f.chats[0].resolve({ reply: '下一轮回复。' }); await sending; await speaking;
  assert.equal(f.page.data.busy, false); assert.equal(f.page.data.interactionLocked, false);
});

test('switching from voice to keyboard preserves ongoing playback and generation but cancels capture', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false,reminders:true}});await tick();
  f.page.setData({voiceMode:true});const speaking=f.page.speak({id:'voice-response',text:'语音回复'});
  f.playbacks[0].handlers.onState('playing');f.page.toggleVoice();
  assert.equal(f.page.data.voiceMode,false);assert.equal(f.page.data.playbackStatus,'playing');assert.equal(f.playbacks[0].cancelled,false);
  f.page.inputChanged({detail:{value:'边听边写'}});assert.equal(f.page.data.input,'边听边写');
  f.playbacks[0].resolve();await speaking;
  const sending=f.page.sendQuestion('生成中继续输入');f.page.setData({voiceMode:true,voiceStatus:'thinking'});f.page.toggleVoice();
  assert.equal(f.chats[0].cancelled,false);assert.equal(f.page.data.busy,true);
  f.chats[0].resolve({reply:'回复完成。'});await sending;
  f.page.setData({voiceMode:true,voiceStatus:'recording',interactionLocked:true});f.page.toggleVoice();
  assert.equal(f.page.data.voiceStatus,'ready');assert.equal(f.page.data.interactionLocked,false);
});

test('native response text uses the shared H5 formatter, including bullets, rules and links', async t => {
  const text='## 建议\n**先记录**\n---\n- 睡眠\n* 情绪\n[资料](https://example.invalid)\n**未闭合  ';
  const f=fixture(t,{'chat-messages':[{id:'formatted',role:'assistant',text,createdAt:new Date().toISOString()}]});await tick();
  assert.equal(f.page.data.messages[0].body,formatMedicalText(text));
  assert.equal(f.page.data.messages[0].body,'建议\n先记录\n\n• 睡眠\n• 情绪\n[资料](https://example.invalid)\n未闭合');
});

test('expanded transcript and references survive favorite writes and incoming messages within the chat', async t => {
  const createdAt=new Date().toISOString();const f=fixture(t,{'chat-messages':[{id:'voice',role:'user',text:'识别结果',inputMode:'voice',createdAt},{id:'reply',role:'assistant',text:'科普回复',citations:[{title:'资料'}],createdAt}]});await tick();
  f.page.toggleTranscript({currentTarget:{dataset:{id:'voice'}}});f.page.toggleCitations({currentTarget:{dataset:{id:'reply'}}});
  f.page.toggleFavorite({currentTarget:{dataset:{id:'reply'}}});
  f.page.saveMessages([...f.page._messages,{id:'next',role:'user',text:'继续咨询',createdAt}]);
  assert.equal(f.page.data.messages.find(m=>m.id==='voice').expanded,true);assert.equal(f.page.data.messages.find(m=>m.id==='reply').citationsExpanded,true);
  assert.equal(f.writes.filter(w=>w.section==='chat-messages').some(w=>w.value.some(m=>'expanded' in m||'citationsExpanded' in m)),false);
  f.page.setData({voiceMode:true,shareHealthRecords:true});f.page.switchTab('manage');
  assert.equal(f.page.data.voiceMode,false);assert.equal(f.page.data.shareHealthRecords,false);
  assert.equal(f.page.data.messages.find(m=>m.id==='voice').expanded,false);
  f.switchAccount('other');assert.equal(Object.keys(f.page._messageDisclosure).length,0);
});

test('returning to a doctor restores this session tab and draft, with shared ask links and account isolation', async t => {
  const f=fixture(t);await tick();f.page.inputChanged({detail:{value:'返回后继续写'}});f.page.switchTab('manage');f.page.onUnload();
  const reopened=f.createPage({slug:doctor.slug});await tick();assert.equal(reopened.data.tab,'manage');assert.equal(reopened.data.input,'返回后继续写');
  reopened.openAsk({detail:{}});assert.equal(reopened.data.input,'返回后继续写');
  const linked=f.createPage({slug:doctor.slug,tab:'ask',question:'外部链接不能填入'});await tick();assert.equal(linked.data.tab,'ask');assert.equal(linked.data.input,'返回后继续写');
  const views=f.loadModule('utils/session-view.js');assert.equal(views.read('guest','yu-wen','chat-draft'),'');
  linked.setData({voiceMode:true});f.switchAccount('different-account');assert.equal(linked.data.input,'');assert.equal(linked.data.voiceMode,false);
  f.switchAccount(null);assert.equal(linked.data.input,'返回后继续写');
  views.write('guest','yu-wen','chat-draft','另一个医生的旧草稿');views.write('different-account','yu-wen','chat-draft','账户草稿');
  await linked.resetGuest();assert.equal(views.read('guest',doctor.slug,'chat-draft'),'');assert.equal(views.read('guest','yu-wen','chat-draft'),'');assert.equal(views.read('different-account','yu-wen','chat-draft'),'账户草稿');assert.equal(linked.data.tab,'home');
});

test('missing health records uses an inline hint and copy feedback clears when the account changes', async t => {
  const f=fixture(t);await tick();f.page.toggleHealth();assert.equal(f.page.data.shareHealthRecords,false);
  assert.equal(f.page.data.healthContextNotice,'暂无健康记录，请先到“管理”添加');
  f.page.copyMessage({currentTarget:{dataset:{id:f.page.greeting.id}}});assert.equal(f.page.data.copiedId,f.page.greeting.id);
  f.switchAccount('other');assert.equal(f.page.data.healthContextNotice,'');assert.equal(f.page.data.copiedId,'');
});

test('rotating a guest cancels old requests and excludes former visitor drafts and late answers', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false,reminders:true}});await tick();
  let visitor='old-visitor';f.runtime.data.getVisitorId=()=>visitor;f.page.refreshData();
  f.page.inputChanged({detail:{value:'旧游客草稿'}});const sending=f.page.sendQuestion('旧游客问题');
  visitor='new-visitor';f.page.refreshData();assert.equal(f.chats[0].cancelled,true);assert.equal(f.page.data.input,'');
  f.chats[0].handlers.onDelta('旧游客迟到内容');f.chats[0].resolve({reply:'旧游客迟到答复'});await sending;
  assert.equal(f.page._messages.some(m=>m.text.includes('迟到')),false);
  const views=f.loadModule('utils/session-view.js');assert.equal(views.read('guest:old-visitor',doctor.slug,'chat-draft'),'旧游客草稿');
  await f.page.resetGuest();assert.equal(views.read('guest:old-visitor',doctor.slug,'chat-draft'),'');
});
test('saveChat false retains current-session history without persisting questions or replies', async t => {
  const f = fixture(t, { privacy: { saveChat: false, voicePlayback: false, reminders: true } }); await tick();
  const sending = f.page.sendQuestion('仅在当前会话的问题'); f.chats[0].resolve({ reply: '当前会话回复。' }); await sending;
  assert.equal(f.page.data.history[0].text, '仅在当前会话的问题');
  assert.equal(f.page._volatile.at(-1).text, '当前会话回复。');
  assert.equal(f.writes.some(write => write.section === 'chat-messages'), false);
  assert.equal(f.runtime.data.hasGuestData(doctor.slug), true);
  f.page.refreshData(); assert.equal(f.page.data.messages.at(-1).text, '当前会话回复。');
});
test('session switch cancels requests and blocks late deltas, answers, replay and former-account drafts', async t => {
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false, reminders: true } }); await tick();
  f.page.inputChanged({ detail: { value: '游客私密草稿' } });
  f.page._replay = { id: 'old-private-reply', text: '旧账户私密内容' };
  const sending = f.page.sendQuestion('游客私密问题'); assert.equal(f.chats.length, 1);
  f.switchAccount('account-b');
  assert.equal(f.chats[0].cancelled, true); assert.equal(f.page.data.input, ''); assert.equal(f.page._replay, null);
  f.chats[0].handlers.onDelta('旧请求的迟到文字'); f.chats[0].resolve({ reply: '旧请求的迟到回复' }); await sending;
  assert.equal(f.page.data.streamingReply, ''); assert.equal(f.page._messages.some(message => /迟到|游客私密/.test(message.text)), false);
  assert.equal(f.writes.some(write => write.owner === 'account-b' && write.section === 'chat-messages'), false);
  f.page.retrySpeaking(); assert.equal(f.playbacks.length, 0);
  f.switchAccount(null); assert.equal(f.page.data.input, '游客私密草稿');
});
test('clearing chat from history cancels in-flight work and delayed answers cannot restore deleted history', async t => {
  const f = fixture(t, { privacy: { saveChat: true, voicePlayback: false, reminders: true } }); await tick();
  const sending = f.page.sendQuestion('将被清除的问题');
  await f.page.clearSection({ currentTarget: { dataset: { section: 'chat-messages' } } });
  assert.equal(f.chats[0].cancelled, true);
  f.chats[0].resolve({ reply: '清空后的迟到回复' }); await sending;
  assert.equal(f.page._messages.length, 1); assert.equal(f.page._messages[0].id, f.page.greeting.id);
  assert.equal(f.page.data.history.length, 0);
});
test('unloading cancels active work, releases listeners and prevents subsequent UI mutations', async t => {
  const f = fixture(t); await tick();
  const sending = f.page.sendQuestion('离开页面'); const count = f.page.writes.length;
  f.page.onUnload(); assert.equal(f.chats[0].cancelled, true);
  assert.equal(f.subscriptions.session.size, 0); assert.equal(f.subscriptions.data.size, 0);
  f.chats[0].handlers.onDelta('不应显示'); f.chats[0].resolve({ reply: '不应保存' }); await sending;
  assert.equal(f.page.writes.length, count);
});

test('automatic speech queues the first text before chat completion and strips the fixed notice', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:true,reminders:true}});await tick();
  const sending=f.page.sendQuestion('如何整理睡眠变化？');assert.equal(f.speechQueues.length,1);
  const queue=f.speechQueues[0];f.chats[0].handlers.onDelta('可以先记录入睡时间。');
  assert.equal(queue.chunks.join(''),'可以先记录入睡时间。');
  queue.options.onState('loading');assert.equal(f.page.data.playbackStatus,'preparing');
  queue.options.onState('playing');assert.equal(f.page.data.playbackStatus,'playing');
  f.chats[0].handlers.onDelta('以上内容仅供健康科普参考，不构成诊断或治疗建议。');
  f.chats[0].resolve({reply:'可以先记录入睡时间。以上内容仅供健康科普参考，不构成诊断或治疗建议。'});await sending;
  assert.equal(queue.chunks.join(''),'可以先记录入睡时间。');assert.equal(f.page.data.interactionLocked,false);
  assert.equal(f.page._messages.at(-1).text,'可以先记录入睡时间。');
});

test('one-turn health context is sent only with explicit choice and resets after a successful reply', async t=>{
  const now=new Date();const dateKey=now.getFullYear()+'-'+String(now.getMonth()+1).padStart(2,'0')+'-'+String(now.getDate()).padStart(2,'0');
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false,reminders:true},'health-records':[{id:'day',createdAt:now.toISOString(),dateKey,completedTitles:['睡眠变化'],metrics:{sleepDurationMinutes:390},source:'manage'}]});await tick();
  assert.equal(f.page.data.healthCount,1);const first=f.page.sendQuestion('一般建议');assert.equal(f.chats[0].body.healthContext,undefined);f.chats[0].resolve({reply:'先整理近期变化。'});await first;
  f.page.toggleHealth();const second=f.page.sendQuestion('结合我的记录');assert.equal(f.chats[1].body.healthContext.records.length,1);f.chats[1].resolve({reply:'记录显示已填写睡眠信息。'});await second;
  assert.equal(f.page.data.shareHealthRecords,false);
  const third=f.page.sendQuestion('再问一般知识');assert.equal(f.chats[2].body.healthContext,undefined);f.chats[2].resolve({reply:'一般健康知识。'});await third;
});

test('health editor focus accounts for existing scrolling and keeps the editor below native navigation', async t=>{
  const f=fixture(t);await tick();f.page.switchTab('manage');
  f.page.panelScrolled({detail:{scrollTop:250}});f.page.focusHealthEditor({detail:{top:420}});
  assert.equal(f.page.data.panelScrollTop,590);
  f.page.focusHealthEditor({detail:{top:null}});assert.equal(f.page.data.panelScrollTop,590);
  f.page.panelScrolled({detail:{scrollTop:0}});f.page.focusHealthEditor({detail:{top:50}});
  assert.equal(f.page.data.panelScrollTop,0);
  f.page.switchTab('home');assert.equal(f.page.data.panelScrollTop,0);
});


test('chat keyboard uses the visible window once for overlay and resized hosts, then restores navigation space', async t => {
  const windowInfo = {statusBarHeight:20,windowWidth:390,windowHeight:800,screenHeight:844,safeArea:{bottom:810}};
  const callbacks=[];let removed;
  const f=fixture(t, {}, {windowInfo,wx:{onKeyboardHeightChange:cb=>callbacks.push(cb),offKeyboardHeightChange:cb=>removed=cb}});await tick();const page=f.page;
  assert.equal(page.data.windowHeight,800);assert.equal(page.data.safeBottom,34);assert.equal(callbacks.length,1);
  const expandedSheetMax = page.data.sheetTotalMax;
  callbacks[0]({height:300});assert.equal(page.data.windowHeight,500);assert.equal(page.data.keyboardHeight,300);
  assert.ok(page.data.sheetTotalMax < expandedSheetMax);
  windowInfo.windowHeight=500;page.onResize({size:{windowHeight:500}});assert.equal(page.data.windowHeight,500,'host resize must not subtract keyboard twice');
  callbacks[0]({height:0});assert.equal(page.data.windowHeight,800);assert.equal(page.data.keyboardHeight,0);
  assert.equal(page.data.sheetTotalMax,expandedSheetMax,'sheet limits restore even while the host still reports its keyboard-sized window');
  assert.equal(page.data.sheetFeatureMax,expandedSheetMax);
  windowInfo.windowHeight=800;page.onResize({size:{windowHeight:800}});assert.equal(page.data.windowHeight,800);
  callbacks[0]({height:300});page.onHide();assert.equal(page.data.keyboardHeight,0);assert.equal(page.data.windowHeight,800);
  page.onUnload();assert.equal(removed,callbacks[0]);const writes=page.writes.length;callbacks[0]({height:300});assert.equal(page.writes.length,writes);
});

test('reading history stops streaming follow, citation expansion stays in place and a new question resumes follow', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false}});await tick();const page=f.page;
  const sending=page.sendQuestion('布局验证问题');t.mock.timers.tick(30);page._messageViewportHeight=300;
  page.messagesDragStarted();page.messagesScrolled({detail:{scrollHeight:1500,scrollTop:100}});assert.equal(page._followChat,false);
  const before=page.writes.filter(p=>'scrollTarget' in p).length;f.chats[0].handlers.onDelta('长回复片段');t.mock.timers.tick(30);assert.equal(page.writes.filter(p=>'scrollTarget' in p).length,before);
  f.chats[0].resolve({reply:'长回复正文',citations:[{title:'参考资料一'}]});await sending;t.mock.timers.tick(30);assert.equal(page.writes.filter(p=>'scrollTarget' in p).length,before);
  const reply=page.data.messages.at(-1);page.toggleCitations({currentTarget:{dataset:{id:reply.id}}});assert.equal(page.data.messages.at(-1).citationsExpanded,true);assert.equal(page._followChat,false);
  page.messagesDragStarted();page.messagesAtBottom();f.chats[0].handlers.onDelta('后续内容');assert.equal(page._followChat,true);
  page.messagesDragStarted();page.messagesScrolled({detail:{scrollHeight:1500,scrollTop:100}});const next=page.sendQuestion('新问题');assert.equal(page._followChat,true);t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom');f.chats[1].resolve({reply:'下一条回复'});await next;
});

test('dismissing speech errors clears the compact status without deleting a reply or its replay action', async t => {
  const f=fixture(t);await tick();const page=f.page;const messages=clone(page.data.messages);const replay={id:'replay',text:'保留原回复'};page._replay=replay;
  page.setData({voiceError:'详细播报失败原因',voiceErrorExpanded:true,playbackStatus:'error',voiceStatus:'error'});page.dismissVoiceError();
  assert.equal(page.data.voiceError,'');assert.equal(page.data.voiceErrorExpanded,false);assert.equal(page.data.playbackStatus,'idle');assert.equal(page.data.voiceStatus,'ready');assert.deepEqual(clone(page.data.messages),messages);assert.equal(page._replay,replay);
  assert.equal(page.data.voiceStatusShown,false,'closing an error also dismisses the initial ready hint, as in H5');
  assert.equal(f.runtime.data.get(doctor.slug,'voice-input-hint-dismissed',false).value,true);
});

test('manual playback failure keeps the answer, uses the H5 recovery copy and retries the same text', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false,reminders:true}});await tick();const page=f.page;
  const answer={id:'readable-reply',role:'assistant',text:'保留可阅读的完整回答',createdAt:'2026-10-21T00:00:00Z'};page.saveMessages([page.greeting,answer]);
  const before=clone(page._messages),speaking=page.speak(answer);f.playbacks[0].reject(new Error('local provider internal failure'));await speaking;
  assert.equal(page.data.playbackStatus,'error');assert.equal(page.data.voiceError,'暂时无法播报，回复文字已保留，可点击“重试播报”。');assert.equal(page.data.voiceErrorExpanded,false);assert.equal(page.data.interactionLocked,false);assert.deepEqual(clone(page._messages),before);
  page.inputChanged({detail:{value:'仍能继续打字'}});assert.equal(page.data.input,'仍能继续打字');page.retrySpeaking();assert.equal(f.playbacks.length,2);assert.equal(f.playbacks[1].text,answer.text);assert.equal(page.data.voiceError,'');assert.equal(page.data.playbackStatus,'preparing');
  f.switchAccount('another-owner');f.playbacks[1].reject(new Error('late failure'));await tick();assert.equal(page.data.voiceError,'');assert.equal(page.data.playbackStatus,'idle');
});

test('queued speech failure preserves the completed reply and sending still works after the error', async t => {
  const f=fixture(t,{privacy:{saveChat:true,voicePlayback:true,reminders:true}});await tick();const page=f.page,playback=defer();
  const sending=page.sendQuestion('请保留文字回复');f.speechQueues[0].finish=()=>playback.promise;f.chats[0].resolve({reply:'可继续阅读和收藏的回复'});assert.equal(await sending,true);const reply=page._messages.at(-1);
  playback.reject(new Error('synthetic local TTS rejection'));await tick();assert.equal(page.data.voiceError,'暂时无法播报，回复文字已保留，可点击“重试播报”。');assert.equal(page.data.playbackStatus,'error');assert.equal(page.data.interactionLocked,false);assert.equal(page._messages.at(-1).id,reply.id);assert.equal(page._replay.id,reply.id);
  page.inputChanged({detail:{value:'继续提问'}});const next=page.sendQuestion(page.data.input);assert.equal(f.chats.length,2);assert.equal(page.data.voiceError,'');f.chats[1].resolve({reply:'下一条回复'});await next;
  assert.equal(page._messages.filter(message=>message.role==='user'&&message.text==='请保留文字回复').length,1);assert.equal(page._messages.filter(message=>message.error).length,0);
});

test('new speech error summaries follow a live conversation but leave paused history in place', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{'chat-messages':[{id:'question',role:'user',text:'已有问题'},{id:'answer',role:'assistant',text:'已有回答'}]});await tick();const page=f.page;
  page.updateVoiceStatus({playbackStatus:'preparing'});t.mock.timers.tick(30);page.setData({scrollTarget:''});
  page.updateVoiceStatus({playbackStatus:'error',voiceError:'新的失败说明'});t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom','an appended collapsed summary is visible when automatic follow is active');
  page.messagesDragStarted();page.setData({scrollTarget:'',chatScrollTop:120});page.updateVoiceStatus({voiceError:'重试后的另一条失败说明'});t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'');assert.equal(page.data.chatScrollTop,120);assert.equal(page._followChat,false);
});

test('manual playback remeasures the chat only when its status bar appears or disappears and preserves history', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const reply={id:'layout-reply',role:'assistant',text:'保留这条长回复',createdAt:'2026-10-11T00:00:01Z'};
  const f=fixture(t,{'voice-input-hint-dismissed':true,'chat-messages':[{id:'layout-question',role:'user',text:'布局问题',createdAt:'2026-10-11T00:00:00Z'},reply]});await tick();const page=f.page;
  let measurements=0;
  page.createSelectorQuery=()=>({select(selector){assert.equal(selector,'.messages');return this;},boundingClientRect(callback){measurements+=1;callback({height:page.voiceStatusVisible()?260:300});return this;},exec(){}});
  page._messageViewportHeight=300;page._followChat=true;
  const speaking=page.speak(reply);assert.equal(measurements,1);assert.equal(page._messageViewportHeight,260);t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom');
  f.playbacks[0].handlers.onState('loading');f.playbacks[0].handlers.onState('playing');assert.equal(measurements,1,'visible status text changes must not query every playback event');
  f.playbacks[0].resolve();await speaking;assert.equal(measurements,2);assert.equal(page._messageViewportHeight,300);t.mock.timers.tick(30);
  page.messagesDragStarted();page.messagesScrolled({detail:{scrollHeight:1000,scrollTop:100}});const before=page.writes.filter(p=>'scrollTarget' in p).length;
  const reading=page.speak(reply);assert.equal(measurements,3);assert.equal(page._messageViewportHeight,260);
  page.messagesScrolled({detail:{scrollHeight:1000,scrollTop:650}});assert.equal(page._followChat,false,'use the smaller visible viewport when checking the distance to the bottom');
  f.playbacks[1].reject(new Error('播报暂不可用'));await reading;assert.equal(measurements,3);page.dismissVoiceError();assert.equal(page._messageViewportHeight,300);t.mock.timers.tick(30);
  assert.equal(page.writes.filter(p=>'scrollTarget' in p).length,before,'playback and error dismissal must not pull a reader away from history');assert.deepEqual(clone(page.data.messages).map(m=>m.id),['layout-question','layout-reply']);
});

test('streamed autoplay status uses the new viewport without adding measurements for each token', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{'voice-input-hint-dismissed':true,privacy:{saveChat:true,voicePlayback:true}});await tick();const page=f.page;
  let measurements=0;
  page.createSelectorQuery=()=>({select(selector){assert.equal(selector,'.messages');return this;},boundingClientRect(callback){measurements+=1;callback({height:page.voiceStatusVisible()?260:300});return this;},exec(){}});
  const sending=page.sendQuestion('检查播报状态栏');const before=measurements;f.speechQueues[0].options.onState('loading');assert.equal(measurements,before+1);assert.equal(page._messageViewportHeight,260);
  f.speechQueues[0].options.onState('playing');f.chats[0].handlers.onDelta('第一段');f.chats[0].handlers.onDelta('第二段');assert.equal(measurements,before+1);
  f.chats[0].resolve({reply:'完整回复'});await sending;await tick();assert.equal(page.data.playbackStatus,'idle');assert.equal(page._messageViewportHeight,300);t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom');
});

test('host resize may precede keyboard events without double shrinking or leaving space on keyboard close', async t => {
  const windowInfo={statusBarHeight:20,windowWidth:390,windowHeight:800};const f=fixture(t,{}, {windowInfo});await tick();const page=f.page;
  page.inputFocused();windowInfo.windowHeight=500;page.onResize({size:{windowHeight:500,windowWidth:390}});
  page.keyboardChanged({detail:{height:300}});assert.equal(page.data.windowHeight,500);assert.equal(page._fullWindowHeight,800);
  windowInfo.windowHeight=800;page.onResize({size:{windowHeight:800,windowWidth:390}});page.keyboardChanged({detail:{height:0}});assert.equal(page.data.windowHeight,800);
  page.inputBlurred();windowInfo.windowHeight=700;page.onResize({size:{windowHeight:700,windowWidth:390}});assert.equal(page.data.windowHeight,700);assert.equal(page._fullWindowHeight,700);
});

test('programmatic scrolling and a growing reply cannot stop follow, while disclosures explicitly pause it', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false}});await tick();const page=f.page;
  const sending=page.sendQuestion('长回复自动滚动');page._messageViewportHeight=300;t.mock.timers.tick(30);
  for(let part=0;part<20;part+=1){page.messagesScrolled({detail:{scrollHeight:1000+part*100,scrollTop:part*20}});assert.equal(page._followChat,true);f.chats[0].handlers.onDelta('第'+part+'段长回复。');t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom');}
  f.chats[0].resolve({reply:'完整长回复',citations:[{title:'参考资料'}]});await sending;t.mock.timers.tick(30);
  const reply=page.data.messages.at(-1);page.toggleCitations({currentTarget:{dataset:{id:reply.id}}});assert.equal(page._followChat,false);const writes=page.writes.filter(p=>'scrollTarget' in p).length;
  page.messagesScrolled({detail:{scrollHeight:3000,scrollTop:2700}});page.messagesAtBottom();page.scrollBottom(false);t.mock.timers.tick(30);assert.equal(page._followChat,false);assert.equal(page.writes.filter(p=>'scrollTarget' in p).length,writes);
});

test('vertical gestures pause follow through inertia, return to bottom resumes, and sending clears old manual intent', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});const f=fixture(t,{privacy:{saveChat:true,voicePlayback:false}});await tick();const page=f.page;
  const sending=page.sendQuestion('用户滚动意图');page._messageViewportHeight=300;t.mock.timers.tick(30);
  page.messagesTouchStarted({touches:[{clientX:100,clientY:100}]});page.messagesTouchMoved({touches:[{clientX:150,clientY:101}]});assert.equal(page._followChat,true,'horizontal quick-question swipes must not pause vertical follow');
  page.messagesTouchMoved({touches:[{clientX:100,clientY:150}]});page.messagesScrolled({detail:{scrollHeight:2000,scrollTop:100}});assert.equal(page._followChat,false);
  t.mock.timers.tick(1900);page.messagesScrolled({detail:{scrollHeight:2000,scrollTop:300}});t.mock.timers.tick(1900);page.messagesScrolled({detail:{scrollHeight:2000,scrollTop:600}});assert.equal(page._followChat,false);
  page.messagesAtBottom();assert.equal(page._followChat,true);page.messagesScrolled({detail:{scrollHeight:2500,scrollTop:1700}});assert.equal(page._followChat,true,'program scroll after reaching the bottom must not revive an old gesture');
  page.messagesDragStarted();page.messagesScrolled({detail:{scrollHeight:2500,scrollTop:100}});f.chats[0].resolve({reply:'保留历史位置'});await sending;assert.equal(page._followChat,false);
  const next=page.sendQuestion('明确发送新问题');assert.equal(page._followChat,true);assert.equal(page._manualChatScrollUntil,0);page.messagesScrolled({detail:{scrollHeight:2800,scrollTop:300}});assert.equal(page._followChat,true,'late inertia from the old gesture must not cancel the new question');t.mock.timers.tick(30);assert.equal(page.data.scrollTarget,'chat-bottom');f.chats[1].resolve({reply:'新回复'});await next;
});

test('explicit speech error details locate themselves from paused history without resuming automatic follow', async t => {
  t.mock.timers.enable({apis:['setTimeout']});const frames=[];
  const f=fixture(t,{'chat-messages':[{id:'history-q',role:'user',text:'旧问题',createdAt:'2026-10-11T00:00:00Z'}]}, {nextTick:callback=>frames.push(callback)});await tick();const page=f.page;
  page._lastChatScrollTop=400;page.messagesDragStarted();page.updateVoiceStatus({voiceError:'完整语音失败原因',playbackStatus:'error'});
  page.createSelectorQuery=()=>{let selected;return{select(selector){selected=selector;return this;},boundingClientRect(callback){callback(selected==='.messages'?{top:100,height:300}:{top:1200,height:150});return this;},exec(callback){if(callback)callback();}};};
  page.toggleVoiceError();assert.equal(page.data.voiceErrorExpanded,true);assert.equal(page._followChat,false);assert.equal(frames.length,1);
  frames.shift()();assert.equal(page.data.chatScrollTop,1492,'place the error eight pixels below the visible conversation top');assert.equal(page.data.scrollTarget,'');assert.equal(page.data.chatScrollAnimated,false);assert.equal(page._followChat,false);
  const writes=page.writes.length;page.scrollBottom(false);t.mock.timers.tick(30);assert.equal(page.writes.length,writes,'future automatic follow remains paused');
  page.toggleVoiceError();assert.equal(page.data.voiceErrorExpanded,false);assert.equal(frames.length,0);assert.equal(page.data.chatScrollTop,1492,'closing details keeps the current reading position');
});

test('delayed speech error geometry cannot move a closed view, changed owner, hidden page or newer gesture', async t => {
  for(const action of ['close','owner','hide','unload','error','gesture']) {
    const frames=[],pending=[];const f=fixture(t,{}, {nextTick:callback=>frames.push(callback)});await tick();const page=f.page;
    page.updateVoiceStatus({voiceError:'原错误',playbackStatus:'error'});
    page.createSelectorQuery=()=>{let selected;const nodes=[];return{select(selector){selected=selector;return this;},boundingClientRect(callback){nodes.push({selector:selected,callback});return this;},exec(callback){const complete=()=>{for(const node of nodes)node.callback(node.selector==='.messages'?{top:100,height:300}:{top:900,height:120});if(callback)callback();};if(nodes.length===1)complete();else pending.push(complete);}};};
    page.toggleVoiceError();frames.shift()();assert.equal(pending.length,1);
    if(action==='close')page.toggleVoiceError();else if(action==='owner')f.switchAccount('new-owner');else if(action==='hide')page.onHide();else if(action==='unload')page.onUnload();else if(action==='error')page.updateVoiceStatus({voiceError:'新的错误'});else page.messagesDragStarted();
    const writes=page.writes.length;pending.shift()();assert.equal(page.writes.length,writes,action+' must invalidate old explicit scroll results');
  }
});

test('voice ready hints use the same rendered condition as H5 in voice mode, keyboard mode and restored history', async t => {
  const f=fixture(t,{'chat-messages':[{id:'asked',role:'user',text:'已有对话',createdAt:'2026-10-11T00:00:00Z'}]});await tick();const page=f.page;
  assert.equal(page.data.voiceStatusShown,false);assert.equal(page.voiceStatusVisible(),false);
  page.updateVoiceStatus({voiceMode:true});assert.equal(page.data.voiceStatusShown,true);assert.equal(page.voiceStatusVisible(),true);
  page.keyboardChanged({detail:{height:300}});assert.equal(page.data.voiceStatusShown,true,'an available voice-mode hint also remains visible with an open keyboard');
  page.toggleVoice();assert.equal(page.data.voiceStatusShown,false);assert.equal(page.voiceStatusVisible(),false);
  page.updateVoiceStatus({voiceMode:true});page.dismissHint();assert.equal(page.data.voiceStatusShown,false);
  await page.startVoice();assert.equal(page.data.voiceStatusShown,true,'recording state is visible even after dismissing the ready hint');page.cancelWork();assert.equal(page.data.voiceStatusShown,false);
  f.switchAccount('new-owner');assert.equal(page.data.voiceMode,false);assert.equal(page.data.voiceStatusShown,true,'a new account without a user message gets the initial ready hint');
  const restored=fixture(t,{'chat-messages':[{id:'one',role:'assistant',text:'问候一'},{id:'two',role:'assistant',text:'问候二'}]});await tick();assert.equal(restored.page.data.voiceStatusShown,true,'assistant-only restoration is not treated as a prior user conversation');
  const wxml=fs.readFileSync(path.join(root,'pages/doctor/index.wxml'),'utf8');assert.match(wxml,/wx:if="\{\{voiceStatusShown\}\}" class="voice-status/);assert.match(wxml,/class="messages" scroll-top="\{\{chatScrollTop\}\}"/);
});
