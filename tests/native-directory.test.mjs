import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const nativeRoot = fileURLToPath(new URL('../wechat-native/', import.meta.url));
const localDateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const day = offset => { const value = new Date(); value.setHours(12, 0, 0, 0); value.setDate(value.getDate() + offset); return localDateKey(value); };
const plain = value => JSON.parse(JSON.stringify(value));

// wx is replaced at the native boundary; component logic and the built H5 models execute unchanged.
function fixture(options = {}) {
  const scopes = new Map(); const events = []; const modules = new Map(); const definitions = new Map();
  const timers = new Map(); let nextTimer = 0; let now = Date.now();
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const nativeSetTimeout = options.fakeTimers ? (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; } : setTimeout;
  const nativeClearTimeout = options.fakeTimers ? id => timers.delete(id) : clearTimeout;
  let directory = []; let canEdit = true; let notice = ''; let unsubscribeCount = 0;
  const runtime = {
    api: { listDoctors: async () => directory, assetUrl: value => value ? `https://agent.hzmwmt.com${value}` : '' },
    session: { get: () => ({ user: null }) },
    subscribe: () => () => { unsubscribeCount += 1; },
    data: {
      get: (slug, section, fallback) => ({ value: scopes.has(`${slug}:${section}`) ? scopes.get(`${slug}:${section}`) : fallback, canEdit }),
      set: (slug, section, value) => { if (!canEdit) return false; scopes.set(`${slug}:${section}`, value); return true; },
      subscribe: () => () => { unsubscribeCount += 1; },
    },
    storageNotice: () => notice,
  };
  const wx = { hideKeyboard() {}, pageScrollTo() {}, navigateTo() {}, getWindowInfo: () => ({ statusBarHeight: 24 }), getMenuButtonBoundingClientRect: () => ({ bottom: 58 }) };
  const nativeAnimations = [], nativeClears = [], commits = [];
  if (options.nativeAnimation) wx.createAnimation = () => { throw Error('Queued animation exports must not be used'); };
  function load(relative) {
    const absolute = path.resolve(nativeRoot, relative.endsWith('.js') ? relative : `${relative}.js`);
    if (absolute.endsWith(path.join('utils', 'runtime.js'))) return { getRuntime: () => runtime };
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} }; modules.set(absolute, module);
    const context = {
      module, exports: module.exports,
      require: dependency => load(path.relative(nativeRoot, path.resolve(path.dirname(absolute), dependency))),
      Page: value => definitions.set(absolute, value), Component: value => definitions.set(absolute, value),
      wx, console, setTimeout: nativeSetTimeout, clearTimeout: nativeClearTimeout, Date: options.fakeClock ? ClockDate : Date, Set, Object,
    };
    vm.runInNewContext(fs.readFileSync(absolute, 'utf8'), context, { filename: absolute });
    return module.exports;
  }
  function component(file, properties = {}) {
    load(file); const definition = definitions.get(path.resolve(nativeRoot, file));
    const instance = {
      definition, properties, data: plain(definition.data),
      setData(patch, callback) {
        for (const [key, value] of Object.entries(patch)) {
          const parts = key.split('.'); let target = this.data;
          for (const part of parts.slice(0, -1)) target = target[part] || (target[part] = {});
          target[parts.at(-1)] = value;
        }
        if (callback) { if (options.deferViewCommit) commits.push(callback); else callback(); }
      },
      triggerEvent(name, detail) { events.push({ name, detail }); },
    };
    if (options.nativeAnimation) {
      instance.animate = (selector, keyFrames, duration, callback) => nativeAnimations.push({ selector, keyFrames: plain(keyFrames), duration, callback });
      instance.clearAnimation = (selector, options) => nativeClears.push({ selector, options });
    }
    for (const [key, value] of Object.entries(definition.methods || definition)) if (typeof value === 'function') instance[key] = value.bind(instance);
    return instance;
  }
  const catalog = load('utils/models/catalog.js');
  return {
    scopes, events, runtime, wx, load, component, catalog,
    flushTimers: () => { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(({ callback }) => callback()); },
    pendingTimers: () => [...timers.values()], advanceTime: milliseconds => { now += milliseconds; }, nativeAnimations, nativeClears,
    flushCommits: () => { const callbacks = commits.splice(0); callbacks.forEach(callback => callback()); },
    setDirectory: value => { directory = value; }, setEditable: value => { canEdit = value; }, setNotice: value => { notice = value; },
    unsubscribes: () => unsubscribeCount,
    doctor: slug => catalog.doctorProfiles.find(doctor => doctor.slug === slug),
  };
}
const dataset = value => ({ currentTarget: { dataset: value } });
const input = (key, value) => ({ ...dataset({ key }), detail: { value } });

test('native directory uses only published API results and supports topic + text filters, empty state, and retry', async () => {
  const f = fixture(); const tang = f.doctor('tang-jinsong'); const fu = f.doctor('fu-junfen');
  const newlyPublished = { ...fu, slug: 'newly-published-agent', name: '新发布医生' };
  f.setDirectory([tang, newlyPublished]);
  const page = f.component('pages/index/index.js'); await page.loadDirectory();
  assert.equal(page.data.doctors.length, 2);
  assert.equal(page.data.doctors[1].slug, 'newly-published-agent');
  page.inputQuery({ detail: { value: '新发布' } }); assert.equal(page.data.filteredDoctors.length, 1);
  page.chooseTopic(dataset({ key: 'mental' })); assert.equal(page.data.filteredDoctors.length, 0);
  page.clearFilters(); page.chooseTopic(dataset({ key: 'mental' }));
  assert.equal(page.data.filteredDoctors.length, 1); assert.equal(page.data.filteredDoctors[0].slug, 'tang-jinsong');
  assert.equal(page.data.activeTopicLabel, '心理健康');
  page.chooseTopic(dataset({ key: 'mental' })); assert.equal(page.data.activeTopic, 'all');
  f.setDirectory([]); await page.loadDirectory();
  assert.equal(page.data.doctors.length, 0); assert.equal(page.data.filteredDoctors.length, 0); assert.equal(page.data.error, '');
  f.runtime.api.listDoctors = async () => { throw new Error('网络暂时不可用'); }; await page.loadDirectory();
  assert.equal(page.data.loading, false); assert.equal(page.data.error, '网络暂时不可用');
  f.runtime.api.listDoctors = async () => [newlyPublished]; await page.loadDirectory();
  assert.equal(page.data.error, ''); assert.equal(page.data.filteredDoctors[0].slug, 'newly-published-agent');
});

test('clearing search preserves the topic and restores input focus, while submitting releases focus', async () => {
  const f = fixture();
  f.setDirectory([f.doctor('tang-jinsong'), f.doctor('yu-wen'), f.doctor('fu-junfen')]);
  const page = f.component('pages/index/index.js'); await page.loadDirectory();
  page.chooseTopic(dataset({ key: 'mental' }));
  page.inputQuery({ detail: { value: '唐劲松' } });
  assert.deepEqual(plain(page.data.filteredDoctors.map(item => item.slug)), ['tang-jinsong']);
  page.focusSearch(); assert.equal(page.data.searchFocused, true);
  page.blurSearch(); assert.equal(page.data.searchFocused, false);
  page.clearQuery();
  assert.equal(page.data.query, ''); assert.equal(page.data.activeTopic, 'mental');
  assert.equal(page.data.searchFocused, true);
  assert.deepEqual(plain(page.data.filteredDoctors.map(item => item.slug)), ['tang-jinsong', 'yu-wen']);
  const scrolls = []; let keyboardHides = 0;
  f.wx.hideKeyboard = () => { keyboardHides += 1; };
  f.wx.pageScrollTo = options => scrolls.push(options);
  page.inputQuery({ detail: { value: '喻雯' } }); page.search();
  assert.equal(page.data.searchFocused, false); assert.equal(page.data.query, '喻雯');
  assert.equal(page.data.activeTopic, 'mental'); assert.equal(keyboardHides, 1);
  assert.equal(scrolls.length, 1); assert.equal(scrolls[0].selector, '#doctor-agents');
  page.clearFilters();
  assert.equal(page.data.activeTopic, 'all'); assert.equal(page.data.filteredDoctors.length, 3);
});

test('a late directory response cannot replace a newer retry or mutate an unloaded page', async () => {
  const f = fixture(); const page = f.component('pages/index/index.js'); const tang = f.doctor('tang-jinsong');
  let resolveFirst; f.runtime.api.listDoctors = () => new Promise(resolve => { resolveFirst = resolve; });
  const first = page.loadDirectory();
  f.runtime.api.listDoctors = async () => []; await page.loadDirectory();
  resolveFirst([tang]); await first; assert.equal(page.data.doctors.length, 0);
  let resolveAfterUnload; f.runtime.api.listDoctors = () => new Promise(resolve => { resolveAfterUnload = resolve; });
  const pending = page.loadDirectory(); page.onUnload(); resolveAfterUnload([tang]); await pending;
  assert.equal(page.data.doctors.length, 0);
});

test('native portrait crop reproduces H5 object-position and preserves published scale/origin', async () => {
  const f = fixture(); const presentation = f.load('utils/presentation.js');
  const top = presentation.portraitCropStyle({ portraitPosition: '50% 0%' }, 400, 800, 76, 84);
  const center = presentation.portraitCropStyle({ portraitPosition: '50% 50%' }, 400, 800, 76, 84);
  assert.match(top, /width:76px;height:152px;left:0px;top:0px;/);
  assert.match(center, /top:-34px;/);
  const decorated = presentation.decorateDoctor({ name: '测试', portrait: '/assets/portrait.jpg', portraitScale: 0.88, portraitTransformOrigin: '50% 0%' });
  assert.equal(decorated.portraitUrl, 'https://agent.hzmwmt.com/assets/portrait.jpg');
  assert.match(decorated.portraitStyle, /scale\(0.88\);transform-origin:50% 0%/);
  f.setDirectory([f.doctor('fu-junfen'), f.doctor('tang-jinsong')]);
  const page = f.component('pages/index/index.js'); await page.loadDirectory();
  page.portraitLoaded({ ...dataset({ slug: 'fu-junfen' }), detail: { width: 400, height: 800 } });
  assert.match(page.data.filteredDoctors[0].portraitCropStyle, /height:152px/);
  page.portraitError(dataset({ slug: 'fu-junfen' }));
  assert.equal(page.data.filteredDoctors[0].portraitUrl, ''); assert.ok(page.data.filteredDoctors[1].portraitUrl);
});

test('Tang home records validate data and merge edits into the same day without losing existing measurements', () => {
  const f = fixture(); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.refresh(); assert.equal(home.data.recordedDays, 0);
  home.openRecord(dataset({ section: 'sleep' })); assert.equal(home.data.sheetScroll, 'record-sleep');
  home.editDraft(input('sleepDurationHours', '6.5')); home.saveRecord();
  assert.equal(home.data.saved, true); assert.equal(home.data.recordedDays, 1);
  let records = f.scopes.get('tang-jinsong:health-records');
  assert.equal(records.length, 1); assert.equal(records[0].metrics.sleepDurationMinutes, 390);
  const recordId = records[0].id;
  home.openRecord(); home.editDraft(input('moodScore', '8')); home.saveRecord();
  records = f.scopes.get('tang-jinsong:health-records');
  assert.equal(records.length, 1); assert.equal(records[0].id, recordId); assert.equal(records[0].metrics.moodScore, 8); assert.equal(records[0].metrics.sleepDurationMinutes, 390);
  home.openRecord(); home.editDraft(input('moodScore', '11')); home.saveRecord();
  assert.ok(home.data.formError); assert.equal(f.scopes.get('tang-jinsong:health-records')[0].metrics.moodScore, 8);
  home.askWithRecord(); assert.equal(f.events.at(-1).name, 'ask'); assert.equal(f.events.at(-1).detail.withHealthContext, true);
  home.definition.lifetimes.detached.call(home);
});

test('home does not report a blocked save as successful and cleans up its store subscription', () => {
  const f = fixture(); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.definition.lifetimes.attached.call(home);
  home.openRecord(); home.editDraft(input('sleepDurationHours', '6.5'));
  f.setEditable(false); f.setNotice('账户数据仍在加载，请稍候'); home.refresh(); home.saveRecord();
  assert.equal(home.data.canEdit, false); assert.equal(home.data.saved, false); assert.equal(home.data.formError, '账户数据仍在加载，请稍候');
  assert.equal(f.scopes.has('tang-jinsong:health-records'), false);
  home.definition.lifetimes.detached.call(home); assert.equal(f.unsubscribes(), 1);
});

test('specialty home completion is derived from today measurements, including a real zero value', () => {
  const f = fixture(); const doctor = f.doctor('chen-zhiling');
  f.scopes.set(`${doctor.slug}:health-records`, [{ id: 'real-record', dateKey: day(0), createdAt: new Date().toISOString(), completedTitles: [], source: 'manage', measurements: { nasalBlockageScore: 0 } }]);
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] }); home.refresh();
  assert.equal(home.data.recordedDays, 1); assert.equal(home.data.steps[0].complete, true); assert.equal(home.data.steps[1].complete, false);
  assert.match(home.data.steps[0].description, /今日已填：0/);
  home.openRecord(); assert.equal(f.events.at(-1).detail.tab, 'manage');
});

test('Yuwen home computes the same seven-day record + mood statistics and reaches all nine real feature views', () => {
  const f = fixture(); const doctor = f.doctor('yu-wen');
  f.scopes.set('yu-wen:wellness-v1', { records: [
    { date: day(0), values: { moodScore: 8 } }, { date: day(-6), values: { moodScore: 6 } },
    { date: day(-7), values: { moodScore: 1 } }, { date: day(1), values: { moodScore: 10 } },
  ] });
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] }); home.refresh();
  assert.equal(home.data.wellnessDays, 2); assert.equal(home.data.wellnessMood, '7.0'); assert.equal(home.data.wellnessToday, true);
  assert.equal(home.data.wellnessFeatures.length, 9);
  for (const feature of home.data.wellnessFeatures) {
    home.wellness(dataset({ view: feature.id }));
    assert.equal(f.events.at(-1).detail.view, feature.id); assert.equal(f.events.at(-1).detail.tab, feature.section);
  }
});

test('published content details and configured service entries keep their H5 continue-question/manage actions', async () => {
  const f = fixture({ fakeTimers: true }); const doctor = { ...f.doctor('tang-jinsong'), content: [
    { id: 'live-article', type: 'article', title: '动态文章', body: '**真实正文**' },
    { id: 'live-service', type: 'service', title: '动态服务', body: '服务正文' },
  ] };
  const education = f.component('components/education/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], mode: 'published' }); education.refresh();
  assert.equal(education.data.content.length, 2);
  education.openContent(dataset({ id: 'live-article' })); assert.equal(education.data.selected.displayBody, '真实正文');
  education.continueContent(); assert.equal(f.events.at(-1).detail.question, '我想进一步了解“动态文章”。');
  assert.equal(education.data.selected.id, 'live-article'); assert.equal(education.data.sheetMotion, 'sheet-exit');
  f.flushTimers(); assert.equal(education.data.selected, null);
  education.properties.mode = 'services'; education.refresh(); assert.equal(education.data.content.length, 1); assert.equal(education.data.content[0].id, 'live-service');
  const recordService = education.data.services.findIndex(service => service.title === '睡眠与情绪记录');
  await education.openService(dataset({ index: recordService })); await education.continueService(); assert.equal(f.events.at(-1).detail.tab, 'manage');
  const voiceService = education.data.services.findIndex(service => service.title === '语音健康问答');
  await education.openService(dataset({ index: voiceService })); await education.continueService(); assert.equal(f.events.at(-1).detail.question, '请介绍语音健康问答适合咨询哪些内容。');
  education.definition.lifetimes.detached.call(education);
});

test('shared sheets match the H5 stage limit and reserve native chrome once, while short content sizes naturally', () => {
  const f = fixture();
  const presentation = f.load('utils/presentation.js');
  for (const example of [
    { height: 844, status: 47, safe: 34, total: 666.72, scroll: 591 },
    { height: 812, status: 44, safe: 34, total: 641.2, scroll: 566 },
    { height: 568, status: 20, safe: 0, total: 443.52, scroll: 402 },
    { height: 541, status: 47, safe: 34, total: 400.08, scroll: 325 },
    { height: 1100, status: 47, safe: 34, total: 754, scroll: 679 },
  ]) {
    const layout = presentation.sheetGeometry({ windowHeight: example.height, screenHeight: example.height, statusBarHeight: example.status, safeArea: { bottom: example.height - example.safe } }, 720);
    assert.ok(Math.abs(layout.totalHeight - example.total) < .001);
    assert.equal(layout.scrollHeight, example.scroll);
  }
  f.wx.getWindowInfo = () => ({ windowHeight: 1100, screenHeight: 1100, statusBarHeight: 47, safeArea: { bottom: 1066 } });
  const doctor = { ...f.doctor('tang-jinsong'), content: [{ id: 'long-article', type: 'article', title: '长文章', body: '正文'.repeat(1000) }] };
  const education = f.component('components/education/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], mode: 'published' });
  let measuredHeight = 1000;
  education.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: callback => callback([{ height: measuredHeight }]) }) }) });
  education.refresh(); education.openContent(dataset({ id: 'long-article' }));
  assert.equal(education.data.sheetHeight, 1000);
  education.openService(dataset({ index: 0 })); assert.equal(education.data.sheetHeight, 1000);
  measuredHeight = 180;
  education.openService(dataset({ index: 0 })); assert.equal(education.data.sheetHeight, 180);
  measuredHeight = 180.25;
  education.openContent(dataset({ id: 'long-article' })); assert.equal(education.data.sheetHeight, 180.25);
  education.openService(dataset({ index: 0 })); assert.equal(education.data.sheetHeight, 180.25);
  f.wx.getWindowInfo = () => ({ windowHeight: 812, screenHeight: 812, statusBarHeight: 44, safeArea: { bottom: 778 } });
  measuredHeight = 1000;
  education.openContent(dataset({ id: 'long-article' })); assert.equal(education.data.sheetHeight, 1000);
  delete education.createSelectorQuery;
  education.openContent(dataset({ id: 'long-article' })); assert.equal(education.data.sheetHeight, 566);
  f.wx.getWindowInfo = () => ({ windowHeight: 844, screenHeight: 844, statusBarHeight: 47, safeArea: { bottom: 810 } });
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.refresh(); home.openRecord(); assert.equal(home.data.sheetHeight, 591);
});

test('open Home and Education sheets retain natural height across viewport caps and remeasure width changes', () => {
  const f = fixture({ fakeTimers: true }); const doctor = { ...f.doctor('tang-jinsong'), content: [{ id: 'long', title: '长文章', type: 'article', body: '正文' }] };
  let measuredHeight = 1000, viewport = { windowHeight: 541, screenHeight: 844, statusBarHeight: 47, safeArea: { bottom: 810 } };
  f.wx.getWindowInfo = () => viewport;
  const presentation = f.load('utils/presentation.js');
  for (const file of ['components/home/index.js', 'components/education/index.js']) {
    const c = f.component(file, { doctor, experience: f.catalog.doctorExperiences[doctor.slug], mode: 'published' });
    c.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: done => done([{ height: measuredHeight }]) }) }) });
    c.refresh();
    if (file.includes('/home/')) c.openRecord(); else c.openContent(dataset({ id: 'long' }));
    assert.equal(c.data.sheetHeight, 1000, 'JS height must not retain the initial small viewport cap');
    assert.equal(Math.min(c.data.sheetHeight, presentation.sheetGeometry(viewport, 720).scrollHeight), 325);
    viewport = { ...viewport, windowHeight: 844 };
    c.definition.pageLifetimes.resize.call(c);
    assert.equal(Math.min(c.data.sheetHeight, presentation.sheetGeometry(viewport, 720).scrollHeight), 591, 'dynamic CSS can expand an already-open long sheet');
    measuredHeight = 1250; c.definition.pageLifetimes.resize.call(c);
    assert.equal(c.data.sheetHeight, 1250, 'a width change remeasures wrapping content');
    measuredHeight = 180; c.definition.pageLifetimes.resize.call(c);
    assert.equal(c.data.sheetHeight, 180, 'short content keeps its natural height');
    measuredHeight = 180.25; c.definition.pageLifetimes.resize.call(c);
    const fractionalHeight = file.includes('/home/') ? 181 : 180.25;
    assert.equal(c.data.sheetHeight, fractionalHeight, 'Education preserves fractional CSS height while Home retains its existing rounding');
    c.definition.pageLifetimes.show.call(c);
    assert.equal(c.data.sheetHeight, fractionalHeight, 'show and resize use the same height policy');
    c.definition.lifetimes.detached.call(c);
    measuredHeight = 1000; viewport = { ...viewport, windowHeight: 541 };
  }
});

test('late sheet measurements cannot overwrite a newer selection, closing sheet, hidden page or detached component', () => {
  const f = fixture({ fakeTimers: true }); const doctor = { ...f.doctor('tang-jinsong'), content: [{ id: 'first', title: '一', type: 'article' }, { id: 'second', title: '二', type: 'article' }] };
  const education = f.component('components/education/index.js', { doctor, mode: 'published' });
  const pending = [];
  education.createSelectorQuery = () => ({ select: () => ({ boundingClientRect: () => ({ exec: done => pending.push(done) }) }) });
  education.refresh(); education.openContent(dataset({ id: 'first' })); education.openContent(dataset({ id: 'second' }));
  const initial = education.data.sheetHeight;
  pending.shift()([{ height: 999 }]); assert.equal(education.data.sheetHeight, initial);
  pending.shift()([{ height: 240 }]); assert.equal(education.data.sheetHeight, 240);
  education.definition.pageLifetimes.resize.call(education); education.closeSheet();
  pending.shift()([{ height: 999 }]); assert.equal(education.data.sheetHeight, 240);
  education.openContent(dataset({ id: 'first' }));
  const reopened = education.data.sheetHeight;
  education.definition.pageLifetimes.hide.call(education);
  pending.shift()([{ height: 999 }]); assert.equal(education.data.sheetHeight, reopened);
  education.definition.pageLifetimes.show.call(education);
  education.properties.doctor = f.doctor('fu-junfen'); education.refresh();
  pending.shift()([{ height: 999 }]); assert.equal(education.data.sheetHeight, reopened);
  education.properties.doctor = doctor; education.refresh(); education.openContent(dataset({ id: 'first' }));
  education.definition.lifetimes.detached.call(education);
  const detached = education.data.sheetHeight;
  pending.shift()([{ height: 999 }]); assert.equal(education.data.sheetHeight, detached);
});

test('Tang draft focus styles remain separate from requested focus and clear on save, close, hide and owner changes', () => {
  const f = fixture({ fakeTimers: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest' });
  home.refresh(); home.openRecord(dataset({ section: 'sleep' }));
  home.focusDraft(dataset({ key: 'sleepLatencyMinutes' }));
  assert.equal(home.data.focusField, 'sleepDurationHours', 'a focus event must not request another programmatic focus');
  assert.equal(home.data.focusedDraftField, 'sleepLatencyMinutes');
  home.focusDraft(dataset({ key: 'note' })); home.blurDraft(dataset({ key: 'sleepLatencyMinutes' }));
  assert.equal(home.data.focusedDraftField, 'note', 'late blur from the previous field cannot remove the new field halo');
  assert.equal(home.data.focusField, '');
  home.blurDraft(dataset({ key: 'note' })); assert.equal(home.data.focusedDraftField, '');
  home.focusDraft(dataset({ key: 'note' })); home.closeSheet();
  assert.equal(home.data.focusedDraftField, ''); home.focusDraft(dataset({ key: 'note' })); assert.equal(home.data.focusedDraftField, '');
  home.openRecord(); home.focusDraft(dataset({ key: 'note' })); home.definition.pageLifetimes.hide.call(home);
  assert.equal(home.data.focusedDraftField, ''); home.focusDraft(dataset({ key: 'note' })); assert.equal(home.data.focusedDraftField, '');
  home.definition.pageLifetimes.show.call(home); home.openRecord(); home.focusDraft(dataset({ key: 'note' }));
  f.runtime.session.get = () => ({ user: { id: 'account-next' } });
  home.properties.ownerKey = 'account-next'; home.refresh(); assert.equal(home.data.focusedDraftField, ''); assert.equal(home.data.focusField, '');
  home.focusDraft(dataset({ key: 'note' })); home.properties.doctor = f.doctor('fu-junfen'); home.properties.experience = f.catalog.doctorExperiences['fu-junfen']; home.refresh();
  assert.equal(home.data.focusedDraftField, ''); assert.equal(home.data.sheetOpen, false);
  home.properties.doctor = doctor; home.properties.experience = f.catalog.doctorExperiences[doctor.slug]; home.refresh(); home.openRecord();
  home.focusDraft(dataset({ key: 'note' })); home.editDraft(input('note', '本地测试备注')); home.saveRecord();
  assert.equal(home.data.saved, true); assert.equal(home.data.focusedDraftField, '');
  home.focusDraft(dataset({ key: 'note' })); assert.equal(home.data.focusedDraftField, '');
  home.definition.lifetimes.detached.call(home);
});

test('home sheet reopening cancels an earlier exit, and scope changes or detach cancel pending close callbacks', () => {
  const f = fixture({ fakeTimers: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.refresh(); home.openRecord(dataset({ section: 'sleep' })); home.closeSheet();
  assert.equal(home.data.sheetOpen, true); assert.equal(home.data.sheetMotion, 'sheet-exit');
  home.openRecord(dataset({ section: 'emotion' })); f.flushTimers();
  assert.equal(home.data.sheetOpen, true); assert.equal(home.data.sheetMotion, 'sheet-enter'); assert.equal(home.data.focusField, 'moodScore');
  home.closeSheet();
  home.properties.doctor = f.doctor('fu-junfen'); home.properties.experience = f.catalog.doctorExperiences['fu-junfen']; home.refresh();
  assert.equal(home.data.sheetOpen, false); f.flushTimers(); assert.equal(home.data.isTang, false);
  home.properties.doctor = doctor; home.properties.experience = f.catalog.doctorExperiences[doctor.slug]; home.refresh(); home.openRecord(); home.closeSheet();
  let patchesAfterDetach = 0; const setData = home.setData.bind(home);
  home.definition.lifetimes.detached.call(home);
  home.setData = (...args) => { patchesAfterDetach += 1; setData(...args); };
  f.flushTimers(); assert.equal(patchesAfterDetach, 0);
});

test('education keeps exit content mounted and a new article, mode change, or detach cannot be closed by an old timer', () => {
  const f = fixture({ fakeTimers: true }); const doctor = { ...f.doctor('tang-jinsong'), content: [
    { id: 'first', type: 'article', title: '第一篇', body: '正文一' }, { id: 'second', type: 'article', title: '第二篇', body: '正文二' },
  ] };
  const education = f.component('components/education/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], mode: 'published' });
  education.refresh(); education.openContent(dataset({ id: 'first' })); education.closeSheet();
  assert.equal(education.data.selected.id, 'first');
  education.openContent(dataset({ id: 'second' })); education.refresh(); f.flushTimers();
  assert.equal(education.data.selected.id, 'second'); assert.equal(education.data.sheetMotion, 'sheet-enter');
  education.closeSheet(); education.properties.mode = 'services'; education.refresh();
  assert.equal(education.data.selected, null);
  education.openService(dataset({ index: 0 })); f.flushTimers(); assert.equal(education.data.selectedService.title, '睡眠与情绪记录');
  education.closeSheet(); education.definition.lifetimes.detached.call(education);
  let patchesAfterDetach = 0; const setData = education.setData.bind(education);
  education.setData = (...args) => { patchesAfterDetach += 1; setData(...args); };
  f.flushTimers(); assert.equal(patchesAfterDetach, 0);
});

test('home entry fades run only at mount and reduced motion or Tang resource toggles do not replay them', () => {
  const f = fixture({ fakeTimers: true }); const doctor = f.doctor('gong-wenbo');
  const firstHome = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest', enterMotion: false, reduceMotion: false });
  firstHome.definition.lifetimes.attached.call(firstHome);
  assert.equal(firstHome.data.homeFadeClass, ''); assert.equal(firstHome.data.concernsFadeClass, '');
  firstHome.properties.enterMotion = true; firstHome.refresh(); firstHome.startHomeMotion();
  assert.equal(firstHome.data.homeFadeClass, '');
  firstHome.definition.lifetimes.detached.call(firstHome);
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest', enterMotion: true, reduceMotion: false });
  home.definition.lifetimes.attached.call(home);
  assert.equal(home.data.homeFadeClass, 'home-fade-up'); assert.equal(home.data.concernsFadeClass, 'home-fade-up');
  home.refresh(); home.startHomeMotion(); assert.equal(home.data.homeFadeClass, 'home-fade-up');
  home.properties.reduceMotion = true; home.definition.observers.reduceMotion.call(home, true);
  assert.equal(home.data.homeFadeClass, ''); assert.equal(home.data.concernsFadeClass, '');
  home.properties.reduceMotion = false; home.definition.observers.reduceMotion.call(home, false); home.refresh(); home.startHomeMotion();
  assert.equal(home.data.homeFadeClass, '');
  home.definition.lifetimes.detached.call(home);
  const tang = f.doctor('tang-jinsong');
  const tangHome = f.component('components/home/index.js', { doctor: tang, experience: f.catalog.doctorExperiences[tang.slug], enterMotion: true, reduceMotion: false });
  tangHome.definition.lifetimes.attached.call(tangHome);
  assert.equal(tangHome.data.homeFadeClass, 'home-fade-up'); assert.equal(tangHome.data.concernsFadeClass, '');
  tangHome.toggleResources(); tangHome.toggleResources(); tangHome.toggleResources();
  assert.equal(tangHome.data.concernsFadeClass, ''); assert.equal(tangHome.data.homeFadeClass, 'home-fade-up');
  tangHome.definition.lifetimes.detached.call(tangHome);
  const reducedHome = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], enterMotion: true, reduceMotion: true });
  reducedHome.definition.lifetimes.attached.call(reducedHome);
  assert.equal(reducedHome.data.homeFadeClass, ''); assert.equal(reducedHome.data.concernsFadeClass, '');
  reducedHome.definition.lifetimes.detached.call(reducedHome);
});

test('notice exit remains mounted and rapid reopening, owner or doctor changes, and detach cancel old callbacks', () => {
  const f = fixture({ fakeTimers: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest' });
  home.refresh(); home.toggleNotice();
  assert.equal(home.data.noticeAnimationFallback, true);
  assert.equal(home.data.noticeMotion, 'home-notice-enter'); assert.equal(home.data.noticeMounted, true);
  home.openRecord(); home.toggleNotice();
  assert.equal(home.data.noticeOpen, false); assert.equal(home.data.noticeMounted, true); assert.equal(home.data.noticeMotion, 'home-notice-exit');
  assert.equal(home.data.sheetMotion, 'sheet-enter');
  home.toggleNotice(); f.flushTimers(); assert.equal(home.data.noticeMounted, true); assert.equal(home.data.noticeOpen, true);
  home.toggleNotice(); f.flushTimers(); assert.equal(home.data.noticeMounted, false); assert.equal(home.data.sheetOpen, true);
  home.toggleNotice(); home.toggleNotice(); home.properties.ownerKey = 'wechat-owner'; home.refresh();
  assert.equal(home.data.noticeMounted, false);
  home.toggleNotice(); f.flushTimers(); assert.equal(home.data.noticeOpen, true); assert.equal(home.data.noticeMounted, true);
  home.toggleNotice(); home.properties.doctor = f.doctor('gong-wenbo'); home.properties.experience = f.catalog.doctorExperiences['gong-wenbo']; home.refresh();
  assert.equal(home.data.noticeMounted, false);
  home.toggleNotice(); f.flushTimers(); assert.equal(home.data.noticeMounted, true);
  home.toggleNotice(); home.definition.lifetimes.detached.call(home);
  let latePatches = 0; const setData = home.setData.bind(home);
  home.setData = (...args) => { latePatches += 1; setData(...args); };
  f.flushTimers(); assert.equal(latePatches, 0);
});

test('native notice reverses after 40ms from current H5 values and inherits sampled velocity', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  const { spring, cubicBezier } = f.load('utils/models/motion'); const config = f.load('utils/home-motion-config');
  const ease = cubicBezier(...config.noticeOpacityEase), initial = spring({ ...config.noticeSpring, keyframes: [-6, 0] });
  const previous = initial.next(24).value, current = initial.next(40).value, velocity = (current - previous) * 1000 / 16;
  home.refresh(); home.toggleNotice();
  assert.equal(home.data.noticeAnimationFallback, false); assert.equal(home.data.noticeMotion, '');
  assert.equal(f.nativeAnimations[0].keyFrames[0].translateY, -6); assert.equal(f.nativeAnimations[0].keyFrames[0].opacity, 0);
  f.advanceTime(40); home.toggleNotice();
  const close = f.nativeAnimations[1].keyFrames;
  assert.equal(close[0].offset, 0); assert.equal(close[0].translateY, current); assert.notEqual(close[0].translateY, 0);
  assert.equal(close[0].opacity, ease(40 / 300));
  const reverse = spring({ ...config.noticeSpring, keyframes: [current, -6], velocity });
  const withoutVelocity = spring({ ...config.noticeSpring, keyframes: [current, -6] });
  assert.equal(close[1].translateY, reverse.next(16).value);
  assert.ok(Math.abs(close[1].translateY - withoutVelocity.next(16).value) > 0.5);
  const beforeReopen = reverse.next(24).value, reopenY = reverse.next(40).value;
  const reopenVelocity = (reopenY - beforeReopen) * 1000 / 16;
  const reopenOpacity = close[0].opacity * (1 - ease(40 / 300));
  f.advanceTime(40); home.toggleNotice();
  const reopen = f.nativeAnimations[2].keyFrames;
  assert.equal(reopen[0].translateY, reopenY); assert.notEqual(reopen[0].translateY, -6); assert.equal(reopen[0].opacity, reopenOpacity);
  assert.equal(reopen[1].translateY, spring({ ...config.noticeSpring, keyframes: [reopenY, 0], velocity: reopenVelocity }).next(16).value);
  for (const { keyFrames, duration, selector } of f.nativeAnimations) {
    assert.equal(selector, '.journey-notice'); assert.equal(keyFrames[0].offset, 0); assert.equal(keyFrames.at(-1).offset, 1);
    assert.ok(keyFrames.slice(1).every((frame, i) => frame.offset > keyFrames[i].offset && (frame.offset - keyFrames[i].offset) * duration <= 16.000001));
    assert.ok(keyFrames.every(frame => frame.ease === 'linear' && Number.isFinite(frame.translateY) && frame.opacity >= 0 && frame.opacity <= 1));
  }
  home.definition.lifetimes.detached.call(home);
});

test('native notice waits for an inherited spring longer than the default 300ms opacity exit', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true }); const doctor = f.doctor('gong-wenbo');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  const { spring, calcGeneratorDuration } = f.load('utils/models/motion'); const { noticeSpring } = f.load('utils/home-motion-config');
  const initial = spring({ ...noticeSpring, keyframes: [-6, 0] }); const from = initial.next(5).value;
  const expectedDuration = calcGeneratorDuration(spring({ ...noticeSpring, keyframes: [from, -6], velocity: (from + 6) * 1000 / 5 }));
  assert.ok(expectedDuration > 300);
  home.refresh(); home.toggleNotice(); f.advanceTime(5); home.toggleNotice();
  assert.equal(f.pendingTimers()[0].delay, expectedDuration);
  assert.equal(f.nativeAnimations[1].duration, expectedDuration);
  assert.equal(home.data.noticeMounted, true); f.flushTimers(); assert.equal(home.data.noticeMounted, false);
});

test('native notice ignores captured exit callbacks after reopening, owner changes, doctor changes and detach', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest' });
  home.refresh(); home.toggleNotice(); f.advanceTime(40); home.toggleNotice();
  const oldClose = f.pendingTimers()[0].callback; home.toggleNotice(); oldClose();
  assert.equal(home.data.noticeOpen, true); assert.equal(home.data.noticeMounted, true);
  home.toggleNotice(); const oldOwner = f.pendingTimers()[0].callback;
  home.properties.ownerKey = 'wechat-owner'; home.refresh(); home.toggleNotice(); oldOwner();
  assert.equal(home.data.noticeMounted, true); assert.equal(f.nativeAnimations.at(-1).keyFrames[0].translateY, -6);
  home.toggleNotice(); const oldDoctor = f.pendingTimers()[0].callback;
  home.properties.doctor = f.doctor('gong-wenbo'); home.properties.experience = f.catalog.doctorExperiences['gong-wenbo'];
  home.refresh(); home.toggleNotice(); oldDoctor(); assert.equal(home.data.noticeOpen, true);
  home.toggleNotice(); const oldDetach = f.pendingTimers()[0].callback;
  home.definition.lifetimes.detached.call(home); let latePatches = 0;
  home.setData = () => { latePatches += 1; }; oldDetach(); f.flushTimers(); assert.equal(latePatches, 0);
});

test('notice keyframes wait for the mounted view and start their clock at commit, not the tap', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true, deferViewCommit: true });
  const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.refresh(); home.toggleNotice();
  assert.equal(home.data.noticeMounted, true); assert.match(home.data.noticeStyle, /opacity:0;/);
  assert.equal(f.nativeAnimations.length, 0); assert.equal(f.pendingTimers().length, 0);
  f.advanceTime(200); f.flushCommits();
  assert.equal(f.nativeAnimations.length, 1); assert.equal(f.nativeAnimations[0].keyFrames.at(-1).opacity, 1);
  assert.equal(f.nativeAnimations[0].keyFrames.at(-1).translateY, 0);
  f.advanceTime(40); home.toggleNotice(); f.flushCommits();
  const { spring } = f.load('utils/models/motion'), { noticeSpring } = f.load('utils/home-motion-config');
  assert.equal(f.nativeAnimations[1].keyFrames[0].translateY, spring({ ...noticeSpring, keyframes: [-6, 0] }).next(40).value);
  home.definition.lifetimes.detached.call(home);
});

test('notice cancels stale view commits and native completions on hide, owner reset and reopen', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true, deferViewCommit: true });
  const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug], ownerKey: 'guest' });
  home.refresh(); home.toggleNotice(); home.properties.ownerKey = 'new-owner'; home.refresh(); f.flushCommits();
  assert.equal(f.nativeAnimations.length, 0); assert.equal(home.data.noticeMounted, false);
  home.toggleNotice(); f.flushCommits(); const staleOpen = f.nativeAnimations.at(-1).callback;
  home.toggleNotice(); f.flushCommits(); const staleClose = f.nativeAnimations.at(-1).callback;
  home.toggleNotice(); f.flushCommits(); staleClose(); staleOpen();
  assert.equal(home.data.noticeMounted, true); assert.equal(home.data.noticeOpen, true);
  home.definition.pageLifetimes.hide.call(home); const cleared = f.nativeClears.length;
  f.nativeAnimations.at(-1).callback(); f.flushTimers(); f.flushCommits();
  assert.equal(home.data.noticeMounted, false); assert.equal(home.data.noticeOpen, false);
  assert.equal(f.nativeClears.length, cleared); assert.equal(f.pendingTimers().length, 0);
  home.toggleNotice(); home.definition.lifetimes.detached.call(home); f.flushCommits();
  assert.equal(f.nativeAnimations.length, 3);
});

test('notice completion settles opacity and reduced motion immediately cancels an active animation', () => {
  const f = fixture({ fakeTimers: true, fakeClock: true, nativeAnimation: true }); const doctor = f.doctor('tang-jinsong');
  const home = f.component('components/home/index.js', { doctor, experience: f.catalog.doctorExperiences[doctor.slug] });
  home.refresh(); home.toggleNotice(); const done = f.nativeAnimations[0].callback;
  done(); assert.equal(home.data.noticeStyle, 'opacity:1;transform:translateY(0px);');
  assert.equal(f.pendingTimers().length, 0); const cleared = f.nativeClears.length; done(); assert.equal(f.nativeClears.length, cleared);
  home.toggleNotice(); const oldClose = f.nativeAnimations.at(-1).callback;
  home.properties.reduceMotion = true; home.definition.observers.reduceMotion.call(home, true);
  assert.equal(home.data.noticeMounted, false); assert.equal(f.pendingTimers().length, 0);
  home.toggleNotice(); assert.equal(home.data.noticeMounted, true); assert.equal(home.data.noticeStyle, 'opacity:1;transform:translateY(0px);');
  oldClose(); assert.equal(home.data.noticeOpen, true); assert.equal(f.nativeAnimations.length, 2);
  home.toggleNotice(); assert.equal(home.data.noticeMounted, false);
  home.definition.lifetimes.detached.call(home);
});


test('portable builder home blocks follow configured order and service worksheets render authored step descriptions', async () => {
  const f=fixture({fakeTimers:true});
  const doctor={...f.doctor('fu-junfen'),slug:'copied-specialist',builder:{schemaVersion:1,components:[{id:'home',enabled:true,order:0},{id:'services',enabled:true,order:4},{id:'assessments',enabled:true,order:2},{id:'records',enabled:true,order:3},{id:'content',enabled:false,order:1}],recordFields:[{key:'peak-flow',label:'峰流量',unit:'L/min',min:0,max:1000,step:1}],assessments:[],servicePlans:[{id:'prepare',title:'自定义准备',description:'真实准备说明',steps:[{id:'report',title:'带好报告',description:'携带有日期的原始检查报告。'}]}],voice:{enabled:false,autoSend:true,autoPlay:false}}};
  const home=f.component('components/home/index.js',{doctor,ownerKey:'guest'});home.refresh();assert.deepEqual(plain(home.data.builderBlocks.map(item=>item.id)),['assessments','records','services']);assert.equal(home.data.steps[0].title,'峰流量');
  const education=f.component('components/education/index.js',{doctor,mode:'services'});education.refresh();assert.equal(education.data.services[0].title,'自定义准备');await education.openService(dataset({index:0}));assert.equal(education.data.plan.id,'prepare');assert.equal(education.data.planSteps[0].label,'带好报告');assert.equal(education.data.planSteps[0].description,'携带有日期的原始检查报告。');education.definition.lifetimes.detached.call(education);
});
