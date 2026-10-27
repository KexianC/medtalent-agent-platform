import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const nativeRoot = fileURLToPath(new URL('../wechat-native/', import.meta.url));
const clone = value => JSON.parse(JSON.stringify(value));
function harness(name, properties = {}) {
  const store = new Map(), events = [], listeners = new Set(), clock = { now: Date.parse('2026-10-11T04:00:00Z') }, account = { user: null }, audio = [];
  let canEdit = true, definition, status = null, errorCode = '', retryTo;
  const retries = [], modals = [], timeouts = new Map(); let timerSequence = 0;
  const schedule = (fn, delay = 0) => { const id = ++timerSequence; timeouts.set(id, { fn, at: clock.now + Number(delay) }); return id; };
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock.now])); } static now() { return clock.now; } }
  const runtime = {
    readScope: (slug, section, fallback) => clone(store.get(`${account.user?.id || 'guest'}:${slug}:${section}`) ?? fallback),
    writeScope(slug, section, value) { if (!canEdit) return false; store.set(`${account.user?.id || 'guest'}:${slug}:${section}`, clone(value)); for (const fn of listeners) fn(); return true; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, storageNotice: () => '',
    session: { get: () => account }, api: { assetUrl: src => 'https://example.test' + src },
    data: { get: (slug, section, fallback) => ({ value: runtime.readScope(slug, section, fallback), canEdit, status: status || (account.user ? 'synced' : 'ready'), errorCode }), set: (slug, section, value) => runtime.writeScope(slug, section, value), subscribe: fn => runtime.subscribe(fn), async retry(slug, section) { retries.push({ slug, section }); if (retryTo) { status = retryTo; errorCode = ''; } } },
  };
  const wx = {
    getWindowInfo: () => ({ pixelRatio: 1 }),
    showModal(options) { modals.push(options.content); options.success({ confirm: true }); }, setClipboardData(options) { events.push({ type: 'clipboard', detail: { text: options.data } }); },
    createInnerAudioContext() {
      const callbacks = {}, context = { currentTime: 0, paused: true, play() { this.paused = false; callbacks.Play?.(); }, pause() { this.paused = true; callbacks.Pause?.(); }, seek(value) { callbacks.Seeking?.(); this.currentTime = value; callbacks.Seeked?.(); }, destroy() { this.destroyed = true; }, emit(name) { callbacks[name]?.(); } };
      for (const name of ['Play', 'Pause', 'TimeUpdate', 'Seeking', 'Seeked', 'Ended', 'Error']) context['on' + name] = fn => { callbacks[name] = fn; };
      audio.push(context); return context;
    },
  };
  const cache = new Map();
  function load(filename) {
    if (filename.endsWith(path.join('utils', 'runtime.js'))) return { getRuntime: () => runtime };
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    vm.runInNewContext('(function(module,exports,require){' + fs.readFileSync(filename, 'utf8') + '\n})', { Component: input => { definition = input; }, wx, Date: ClockDate, setInterval: () => 1, clearInterval() {}, setTimeout: schedule, clearTimeout: id => timeouts.delete(id) }, { filename })(module, module.exports, specifier => { let next = path.resolve(path.dirname(filename), specifier); if (!path.extname(next)) next += '.js'; return load(next); });
    return module.exports;
  }
  load(path.join(nativeRoot, `components/${name}/index.js`));
  const data = clone(definition.data || {});
  for (const [key, prop] of Object.entries(definition.properties || {})) data[key] = prop && typeof prop === 'object' && 'value' in prop ? clone(prop.value) : prop === String ? '' : prop === Boolean ? false : prop === Array ? [] : null;
  Object.assign(data, properties);
  const instance = {
    data, properties: data, runtime,
    setData(patch, done) { for (const [key, value] of Object.entries(patch)) { const keys = key.split('.'); let target = data; for (const part of keys.slice(0, -1)) { if (target[part] === undefined) target[part] = {}; target = target[part]; } target[keys.at(-1)] = value; } if (done) done(); },
    triggerEvent(type, detail) { events.push({ type, detail: clone(detail || {}) }); },
    createSelectorQuery() { return { select() { return this; }, fields() { return this; }, ...(['home', 'education'].includes(name) ? { boundingClientRect() { return this; } } : {}), exec(fn) { if (fn) fn([]); } }; },
  };
  for (const [key, value] of Object.entries(definition.methods || {})) instance[key] = value.bind(instance);
  if (definition.lifetimes?.attached) definition.lifetimes.attached.call(instance);
  return { instance, runtime, clock, account, store, audio, events, definition, retries, modals, timeouts, wx, flushTimers() { for (const [id, timer] of [...timeouts]) if (timer.at <= clock.now) { timeouts.delete(id); timer.fn(); } }, storageStatus(value, options = {}) { status = value; errorCode = options.errorCode || ''; retryTo = options.retryTo; if (options.canEdit !== undefined) canEdit = options.canEdit; instance.load?.(); }, blockEdits() { canEdit = false; instance.load?.(); }, load };
}
const event = data => ({ currentTarget: { dataset: data }, detail: {} });
const input = (key, value) => ({ currentTarget: { dataset: { key } }, detail: { value } });

test('Tang history retains exit content and cannot close a reopened or different-owner sheet late', async () => {
  const h = harness('health', { doctor: { slug: 'tang-jinsong', name: '汤劲松' } }), c = h.instance;
  const { EXIT_DURATION } = h.load(path.join(nativeRoot, 'utils/sheet-motion.js'));
  c.openHistory(); assert.equal(c.data.sheetMotion, 'sheet-enter'); c.closeHistory(); assert.equal(c.data.historyOpen, true); assert.equal(c.data.sheetMotion, 'sheet-exit');
  h.clock.now += 200; c.closeHistory(); h.clock.now += EXIT_DURATION - 201; h.flushTimers(); assert.equal(c.data.historyOpen, true);
  h.clock.now += 1; h.flushTimers(); assert.equal(c.data.historyOpen, false);
  c.openHistory(); c.closeHistory(); h.clock.now += 200; c.openHistory(); h.clock.now += EXIT_DURATION; h.flushTimers(); assert.equal(c.data.historyOpen, true); assert.equal(c.data.sheetMotion, 'sheet-enter');
  c.closeHistory(); h.account.user = { id: 'new-owner' }; c.load(false); assert.equal(c.data.historyOpen, false);
  c.openHistory(); h.clock.now += EXIT_DURATION; h.flushTimers(); assert.equal(c.data.historyOpen, true);
  c.closeHistory(); h.definition.pageLifetimes.hide.call(c); assert.equal(c.data.historyOpen, false); h.clock.now += EXIT_DURATION; h.flushTimers(); assert.equal(c.data.historyOpen, false);
  c.openHistory(); c.closeHistory(); h.definition.lifetimes.detached.call(c); const snapshot = JSON.stringify(c.data); h.clock.now += EXIT_DURATION; h.flushTimers(); assert.equal(JSON.stringify(c.data), snapshot);
});

test('Tang floating record action follows visibility and skips only a cold first appearance', () => {
  for (const enterMotion of [false, true]) {
    const margins = { top: -64, bottom: -100, left: 0, right: 0 };
    const h = harness('health', { doctor: { slug: 'tang-jinsong', name: '汤劲松' }, enterMotion, observerMargins: margins }), c = h.instance; let observe;
    c.createIntersectionObserver = () => ({ relativeToViewport(value) { assert.deepEqual(value, margins); return this; }, observe(id, callback) { assert.equal(id, '#health-editor'); observe = callback; }, disconnect() {} });
    h.definition.lifetimes.ready.call(c); observe({ intersectionRatio: 0 });
    assert.equal(c.data.showFab, true); assert.equal(c.data.fabEntryMotion, enterMotion);
    observe({ intersectionRatio: .01 }); assert.equal(c.data.showFab, false);
    observe({ intersectionRatio: 0 }); assert.equal(c.data.showFab, true); assert.equal(c.data.fabEntryMotion, true);
    h.definition.lifetimes.detached.call(c); observe({ intersectionRatio: 1 }); assert.equal(c.data.showFab, true);
  }
});

test('native initial intersection equality still exposes an offscreen Tang record action', () => {
  const h = harness('health', { doctor: { slug: 'tang-jinsong' }, observerMargins: { top: -91, bottom: -103 } }), c = h.instance;
  let report;
  c.createIntersectionObserver = options => {
    let previous = options.initialRatio ?? 0, callback;
    report = ratio => {
      const crossed = ratio !== previous && options.thresholds.some(value => previous < value && ratio >= value || previous >= value && ratio < value);
      previous = ratio;
      if (crossed) callback({ intersectionRatio: ratio });
    };
    return { relativeToViewport() { return this; }, observe(id, fn) { callback = fn; report(0); }, disconnect() {} };
  };
  h.definition.lifetimes.ready.call(c);
  assert.equal(c.data.showFab, true);
  assert.equal(c.data.fabEntryMotion, false);
  report(.4); assert.equal(c.data.showFab, false);
  report(0); assert.equal(c.data.showFab, true); assert.equal(c.data.fabEntryMotion, true);
  h.definition.lifetimes.detached.call(c);
});

test('specialty status presentation keeps zero values and unit labels without changing selected metric identity', () => {
  const h = harness('health', { doctor: { slug: 'lin-jinfang' } }), c = h.instance;
  c.changeStatus({ detail: { value: 1 } });
  c.changeValue(input('painScore', '0')); c.saveRecord();
  const status = c.data.statsFields.find(field => field.key === 'menstrualStatus');
  assert.equal(status.isStatus, true); assert.equal(status.averageText, '0 天'); assert.equal(status.latestText, '不在经期');
  assert.equal(c.data.statsFields.find(field => field.key === 'painScore').isStatus, false);
  assert.equal(c.data.trendFields[0].optionLabel, '经期状态');
  c.changeMetric({ detail: { value: 1 } });
  assert.equal(c.data.selected.key, 'painScore'); assert.equal(c.data.selected.label, '疼痛自评分');
  assert.equal(c.data.selected.optionLabel, '疼痛自评分（分）');
  assert.equal(c.data.plot.plotPoints.find(point => point.filled).value, 0);
  assert.equal(h.runtime.readScope('lin-jinfang', 'health-records', [])[0].measurements.menstrualStatus, 0);
  h.definition.lifetimes.detached.call(c);
});

test('Tang editor observer waits for actual viewport bounds and ignores disconnected geometry callbacks', () => {
  const h = harness('health', { doctor: { slug: 'tang-jinsong', name: '汤劲松' } }), c = h.instance, observers = [];
  c.createIntersectionObserver = () => { const observer = { disconnected: false, relativeToViewport(margins) { this.margins = margins; return this; }, observe(id, callback) { this.callback = callback; }, disconnect() { this.disconnected = true; } }; observers.push(observer); return observer; };
  h.definition.lifetimes.ready.call(c); assert.equal(observers.length, 0); assert.equal(h.events.at(-1).type, 'viewport');
  c.setData({ observerMargins: { top: -64, bottom: -100, left: 0, right: 0 } }); h.definition.observers.observerMargins.call(c);
  observers[0].callback({ intersectionRatio: 0 }); assert.equal(c.data.showFab, true);
  c.setData({ observerMargins: { top: -80, bottom: -120, left: 0, right: 0 } }); h.definition.observers.observerMargins.call(c);
  assert.equal(observers[0].disconnected, true); observers[0].callback({ intersectionRatio: 1 }); assert.equal(c.data.showFab, true);
  observers[1].callback({ intersectionRatio: 1 }); assert.equal(c.data.showFab, false);
  c.setData({ observerMargins: null }); h.definition.observers.observerMargins.call(c); assert.equal(observers[1].disconnected, true); assert.equal(observers.length, 2);
  h.definition.lifetimes.detached.call(c);
});

test('specialty canvas repaints current plot on visibility and ignores superseded, hidden and detached observers', () => {
  const margins = { top: -64, bottom: -100 }, h = harness('health', { doctor: { slug: 'fu-junfen' }, observerMargins: margins }), c = h.instance;
  const ui = h.load(path.join(nativeRoot, 'utils/health-ui.js')), paints = [], observers = [];
  ui.paintPlot = (component, id, plot) => paints.push({ id, plot: clone(plot) });
  c.createIntersectionObserver = () => {
    const observer = { relativeToViewport(value) { assert.deepEqual(value, margins); return this; }, observe(id, callback) { assert.equal(id, '#health-trend'); this.callback = callback; }, disconnect() { this.disconnected = true; } };
    observers.push(observer); return observer;
  };
  h.definition.lifetimes.ready.call(c); assert.equal(observers.length, 0);
  const values = Object.fromEntries(c.data.fields.map((field, index) => [field.key, index + 1]));
  const record = { id: 'record', source: 'manage', dateKey: c.data.today, createdAt: new Date(h.clock.now).toISOString(), completedTitles: [], measurements: values };
  h.runtime.writeScope('fu-junfen', 'health-records', [record]);
  const first = observers.at(-1), before = paints.length;
  first.callback({ intersectionRatio: 0 }); assert.equal(paints.length, before);
  first.callback({ intersectionRatio: .8 }); assert.equal(paints.length, before + 1);
  assert.equal(paints.at(-1).plot.plotPoints.find(point => point.filled).value, values[c.data.fields[0].key]);
  c.changeMetric({ detail: { value: 1 } }); const second = observers.at(-1), afterChange = paints.length;
  assert.equal(first.disconnected, true); first.callback({ intersectionRatio: 1 }); assert.equal(paints.length, afterChange);
  second.callback({ intersectionRatio: 1 }); assert.equal(paints.at(-1).plot.plotPoints.find(point => point.filled).value, values[c.data.fields[1].key]);
  c.changeRange(event({ days: 30 })); const third = observers.at(-1);
  third.callback({ intersectionRatio: .5 }); assert.equal(paints.at(-1).plot.plotPoints.length, 30);
  h.definition.pageLifetimes.hide.call(c); const hiddenCount = paints.length;
  third.callback({ intersectionRatio: 1 }); assert.equal(third.disconnected, true); assert.equal(paints.length, hiddenCount);
  h.definition.pageLifetimes.show.call(c); const fourth = observers.at(-1);
  h.account.user = { id: 'other-owner' }; c.load(false); const ownerCount = paints.length;
  fourth.callback({ intersectionRatio: 1 }); assert.equal(paints.length, ownerCount);
  h.runtime.writeScope('fu-junfen', 'health-records', [{ ...record, id: 'other-record' }]); const fifth = observers.at(-1);
  h.definition.lifetimes.detached.call(c); const detachedCount = paints.length;
  fifth.callback({ intersectionRatio: 1 }); assert.equal(fifth.disconnected, true); assert.equal(paints.length, detachedCount);
});

test('Tang recorded days include home-only dates once and exclude dates beyond the chosen period', () => {
  const h = harness('health', { doctor: { slug: 'tang-jinsong' } }), c = h.instance;
  const record = (id, offset, extra = {}) => {
    const date = new Date(h.clock.now); date.setDate(date.getDate() - offset);
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { id, source: 'home', dateKey, createdAt: date.toISOString(), completedTitles: ['记录睡眠'], ...extra };
  };
  h.runtime.writeScope('tang-jinsong', 'health-records', [
    record('metrics-today', 0, { source: 'manage', completedTitles: [], metrics: { sleepDurationMinutes: 360, anxietyScore: 4 } }),
    record('home-yesterday', 1), record('home-same-day', 1), record('home-two-days-ago', 2), record('home-seven-days-ago', 7), record('home-thirty-days-ago', 30),
  ]);
  assert.equal(c.data.summary[0].value, '3天'); assert.equal(c.data.summary[0].note, '含首页状态记录，可观察变化');
  assert.equal(c.data.summary[1].value, '6.0h'); assert.equal(c.data.summary[2].value, '4.0/10'); assert.equal(c.data.structuredCount, 1);
  c.changeRange(event({ days: 30 })); assert.equal(c.data.summary[0].value, '4天');
  assert.equal(c.data.summary[1].value, '6.0h'); assert.equal(c.data.summary[2].value, '4.0/10');
  h.definition.lifetimes.detached.call(c);
});

test('both assessment source links try native document viewing and show failures without silently copying a URL', async () => {
  for (const component of ['wellness','guidance']) {
    const h=harness(component,{doctor:{slug:component==='wellness'?'yu-wen':'tang-jinsong'}});
    await h.instance.copySource(event({source:'original'}));
    assert.match(h.instance.data.sourceError,/不支持 PDF.*重试/);
    assert.equal(h.events.some(item=>item.type==='clipboard'),false);
    h.definition.lifetimes.detached.call(h.instance);
  }
});

test('flat trend draws one centered numeric axis label and variable trends retain both bounds', () => {
  const h=harness('health',{doctor:{slug:'fu-junfen',name:'傅君芬'}}),ui=h.load(path.join(nativeRoot,'utils/health-ui.js')),labels=[];
  const ctx={scale(){},clearRect(){},setLineDash(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},arc(){},fill(){},fillText(text,x,y){labels.push({text,x,y});}};
  h.instance.createSelectorQuery=()=>({select(){return this;},fields(){return this;},exec(callback){callback([{width:320,height:165,node:{getContext:()=>ctx}}]);}});
  ui.paintPlot(h.instance,'chart',ui.linePlot([{dateKey:'2026-10-11',label:'10/11',measurements:{weight:20}}],'weight'));
  assert.equal(labels.filter(item=>item.text==='20').length,1);assert.equal(labels.find(item=>item.text==='20').y,82);
  labels.length=0;ui.paintPlot(h.instance,'chart',ui.linePlot([{dateKey:'2026-10-10',label:'10/10',measurements:{weight:20}},{dateKey:'2026-10-11',label:'10/11',measurements:{weight:21}}],'weight'));
  assert.equal(labels.filter(item=>['20','21'].includes(item.text)).length,2);
  assert.deepEqual(labels.filter(item=>['20','21'].includes(item.text)).map(item=>[item.x,item.y]),[[30,134],[30,30]]);
  labels.length=0;ui.paintPlot(h.instance,'chart',ui.linePlot([{label:'10/10',measurements:{weight:20.001}},{label:'10/11',measurements:{weight:20.002}}],'weight'));
  assert.equal(labels.filter(item=>item.text==='20').length,2);
});

test('native canvas resizes before its drawing frame and only commits the latest plot on the same canvas', () => {
  const h = harness('health', { doctor: { slug: 'fu-junfen' } }), c = h.instance, ui = h.load(path.join(nativeRoot, 'utils/health-ui.js'));
  const frames = [], calls = [], labels = [];
  const ctx = { scale() { calls.push('scale'); }, clearRect() { calls.push('clear'); }, setLineDash() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {}, fillText(value) { labels.push(value); } };
  const canvas = { getContext: () => ctx, requestAnimationFrame(callback) { frames.push(callback); } };
  c.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, exec(callback) { callback([{ width: 318, height: 318 * 165 / 320, node: canvas }]); } });
  const first = ui.linePlot([{ dateKey: '2026-10-11', label: '10/11', measurements: { weight: 20 } }], 'weight');
  const latest = ui.linePlot([{ dateKey: '2026-10-10', label: '10/10', measurements: { weight: 30 } }, { dateKey: '2026-10-11', label: '10/11', measurements: { weight: 31 } }], 'weight');
  c.setData({ plot: first }); ui.paintPlot(c, 'health-trend', first);
  assert.equal(canvas.width, 318); assert.equal(canvas.height, 164); assert.equal(frames.length, 1); assert.deepEqual(calls, []);
  c.setData({ plot: latest }); ui.paintPlot(c, 'health-trend', latest);
  assert.equal(frames.length, 2); frames[0](); assert.deepEqual(calls, []);
  frames[1](); assert.deepEqual(calls, ['scale', 'clear']); assert.ok(labels.includes('30')); assert.ok(labels.includes('31')); assert.equal(labels.includes('20'), false);
  h.definition.lifetimes.detached.call(c);
});

test('queued canvas frames are invalidated by an empty plot, hidden page, changed owner or detached component', () => {
  for (const condition of ['empty', 'hidden', 'owner', 'detached']) {
    const h = harness('health', { doctor: { slug: 'fu-junfen' } }), c = h.instance, ui = h.load(path.join(nativeRoot, 'utils/health-ui.js'));
    let frame, submitted = 0;
    const canvas = { getContext: () => ({ scale() { submitted++; } }), requestAnimationFrame(callback) { frame = callback; } };
    c.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, exec(callback) { callback([{ width: 318, height: 180, node: canvas }]); } });
    const plot = ui.linePlot([{ dateKey: c.data.today, label: '10/11', measurements: { weight: 20 } }], 'weight');
    c.setData({ plot }); ui.paintPlot(c, 'health-trend', plot); assert.equal(typeof frame, 'function');
    if (condition === 'empty') c.setData({ plot: ui.linePlot([], 'weight') });
    if (condition === 'hidden') h.definition.pageLifetimes.hide.call(c);
    if (condition === 'owner') c.owner = 'other-owner';
    if (condition === 'detached') h.definition.lifetimes.detached.call(c);
    frame(); assert.equal(submitted, 0, condition);
    if (condition !== 'detached') h.definition.lifetimes.detached.call(c);
  }
});

function chartHarness() {
  const h = harness('health', { doctor: { slug: 'fu-junfen' } }), c = h.instance;
  const ui = h.load(path.join(nativeRoot, 'utils/health-ui.js')), exports = [], points = [], labels = [], frames = [], drawing = [];
  h.wx.getWindowInfo = () => ({ windowWidth: 390, pixelRatio: 3 });
  h.wx.canvasToTempFilePath = (options, component) => { assert.equal(component, c); exports.push(options); };
  let segment = [];
  const ctx = { scale(...args) { drawing.push({ type: 'scale', args }); }, clearRect() {}, setLineDash() {}, beginPath() { segment = []; }, moveTo(...args) { segment.push(args); }, lineTo(...args) { segment.push(args); }, stroke() { drawing.push({ type: 'stroke', color: ctx.strokeStyle, width: ctx.lineWidth, segment: clone(segment) }); }, arc(...args) { points.push(args); }, fill() { drawing.push({ type: 'fill', color: ctx.fillStyle }); }, fillText(value) { labels.push(value); } };
  const canvas = { getContext: () => ctx, requestAnimationFrame(callback) { frames.push(callback); } };
  c.createSelectorQuery = () => ({ select() { return this; }, fields() { return this; }, exec(callback) { callback([{ width: 318, height: 318 * 165 / 320, node: canvas }]); } });
  const plot = value => ui.linePlot([{ dateKey: '2026-10-09', label: '10/9', measurements: { weight: value } }, { dateKey: '2026-10-10', label: '10/10', measurements: { weight: value + 1 } }, { dateKey: '2026-10-11', label: '10/11', measurements: { weight: value + 2 } }], 'weight');
  const draw = value => { const data = plot(value); c.setData({ plot: data }); ui.paintPlot(c, 'health-trend', data, '#4E988F', '#236F68'); frames.at(-1)(); };
  return { ...h, ui, exports, points, labels, canvas, frames, plot, draw, drawing, imageEvent: (src, token = c.data.plotImageToken) => ({ currentTarget: { dataset: { src, token } } }) };
}

test('trend PNG presents the actual high-DPI drawing only after image loading and reuses unchanged chart content', () => {
  const h = chartHarness(), c = h.instance;
  h.draw(20);
  assert.equal(h.exports.length, 1); assert.equal(h.exports[0].canvas, h.canvas);
  assert.equal(h.exports[0].destWidth, 954); assert.equal(h.exports[0].destHeight, 492); assert.equal(h.exports[0].fileType, 'png');
  assert.equal(h.canvas.width, 954); assert.equal(h.canvas.height, 492);
  assert.equal(h.points.length, 3); assert.ok(h.labels.includes('20')); assert.ok(h.labels.includes('22'));
  assert.deepEqual(h.points.map(point => point.slice(0, 3)), [[38, 130, 3.8], [167, 78, 3.8], [296, 26, 3.8]]);
  assert.deepEqual(h.drawing[0], { type: 'scale', args: [954 / 320, 954 / 320] });
  assert.deepEqual(h.drawing.filter(item => item.type === 'stroke' && item.color === '#dfe7e3').map(item => item.segment), [[[38,130],[296,130]],[[38,26],[296,26]]]);
  assert.equal(h.drawing.filter(item => item.type === 'stroke' && item.color === '#4E988F' && item.width === 2).length, 2);
  assert.equal(h.drawing.filter(item => item.type === 'stroke' && item.color === '#fff' && item.width === 1.5).length, 3);
  assert.equal(h.drawing.filter(item => item.type === 'fill' && item.color === '#236F68').length, 3);
  h.ui.paintPlot(c, 'health-trend', c.data.plot, '#4E988F', '#236F68');
  c.setData({ plot: clone(c.data.plot) }); h.ui.paintPlot(c, 'health-trend', c.data.plot, '#4E988F', '#236F68');
  assert.equal(h.frames.length, 1); assert.equal(h.exports.length, 1);
  h.exports[0].success({ tempFilePath: 'wxfile://actual-chart.png' });
  assert.equal(c.data.plotImage, 'wxfile://actual-chart.png'); assert.equal(c.data.plotImageReady, false);
  c.plotImageLoad(h.imageEvent(c.data.plotImage, c.data.plotImageToken + 1)); assert.equal(c.data.plotImageReady, false);
  c.plotImageLoad(h.imageEvent(c.data.plotImage)); assert.equal(c.data.plotImageReady, true);
  h.ui.paintPlot(c, 'health-trend', c.data.plot, '#4E988F', '#236F68'); assert.equal(h.exports.length, 1);
  h.draw(30); assert.equal(c.data.plotImage, ''); assert.equal(c.data.plotImageReady, false);
  c.plotImageLoad(h.imageEvent('wxfile://actual-chart.png', 1)); assert.equal(c.data.plotImageReady, false);
  h.definition.lifetimes.detached.call(c);
});

test('native SVG-equivalent geometry leaves missing dates unconnected and draws a flat point at y 78', () => {
  const h = chartHarness(), c = h.instance;
  const data = h.ui.linePlot([20, undefined, 21, 22, undefined].map((weight, index) => ({ label: `10/${index + 7}`, measurements: weight === undefined ? undefined : { weight } })), 'weight');
  assert.deepEqual(clone(data.plotLines), [{ x1: 167, x2: 231.5, y1: 78, y2: 26 }]);
  c.setData({ plot: data }); h.ui.paintPlot(c, 'health-trend', data, '#4E988F', '#236F68'); h.frames.at(-1)();
  assert.equal(h.points.length, 3);
  assert.deepEqual(h.drawing.filter(item => item.type === 'stroke' && item.color === '#4E988F').map(item => item.segment), [[[167,78],[231.5,26]]]);
  const flat = h.ui.linePlot([{ label: '10/11', measurements: { weight: 20 } }], 'weight');
  assert.equal(flat.flat, true); assert.equal(flat.plotPoints[0].x, 38); assert.equal(flat.plotPoints[0].y, 78);
  h.definition.lifetimes.detached.call(c);
});

test('menstrual trend uses short status axis labels and H5 displayValue in actual date details', () => {
  const h = harness('health', { doctor: { slug: 'lin-jinfang' } }), c = h.instance;
  const record = (id, dateKey, value) => ({ id, source: 'manage', dateKey, createdAt: dateKey + 'T04:00:00Z', completedTitles: [], measurements: { menstrualStatus: value } });
  h.runtime.writeScope('lin-jinfang', 'health-records', [record('period', '2026-10-10', 1), record('non-period', '2026-10-11', 0)]);
  assert.equal(c.data.plot.low, '非经期'); assert.equal(c.data.plot.high, '经期'); assert.equal(c.data.plot.flat, false);
  assert.deepEqual(clone(c.data.plot.plotPoints.filter(point => point.filled).map(point => ({ value: point.value, display: point.display, y: point.y }))), [{ value: 1, display: '正在经期', y: 26 }, { value: 0, display: '不在经期', y: 130 }]);
  h.runtime.writeScope('lin-jinfang', 'health-records', [record('period', '2026-10-11', 1)]);
  assert.equal(c.data.plot.low, '经期'); assert.equal(c.data.plot.high, '经期'); assert.equal(c.data.plot.flat, true);
  assert.equal(c.data.plot.plotPoints.find(point => point.filled).y, 78);
  h.definition.lifetimes.detached.call(c);
});

test('late PNG exports cannot replace another plot, doctor, owner, hidden page or detached component', () => {
  for (const condition of ['plot', 'doctor', 'owner', 'hidden-returned', 'detached', 'empty']) {
    const h = chartHarness(), c = h.instance; h.draw(20); const older = h.exports[0];
    if (condition === 'plot') h.draw(30);
    if (condition === 'doctor') c.setData({ doctor: { slug: 'lin-jinfang' } });
    if (condition === 'owner') { h.account.user = { id: 'other-owner' }; c.load(false); }
    if (condition === 'hidden-returned') { h.definition.pageLifetimes.hide.call(c); c._pageHidden = false; c.setData({ plot: h.plot(20) }); }
    if (condition === 'detached') h.definition.lifetimes.detached.call(c);
    if (condition === 'empty') c.setData({ plot: h.ui.linePlot([], 'weight') });
    older.success({ tempFilePath: 'wxfile://stale.png' }); assert.equal(c.data.plotImage, '', condition);
    if (condition === 'plot') { h.exports[1].success({ tempFilePath: 'wxfile://latest.png' }); assert.equal(c.data.plotImage, 'wxfile://latest.png'); }
    if (condition !== 'detached') h.definition.lifetimes.detached.call(c);
  }
});

test('export and image failures retain the drawn canvas without an automatic export loop', () => {
  for (const failure of ['export', 'throw', 'image']) {
    const h = chartHarness(), c = h.instance;
    if (failure === 'throw') h.wx.canvasToTempFilePath = () => { throw new Error('native export failed'); };
    h.draw(20); assert.equal(h.points.length, 3);
    if (failure === 'export') h.exports[0].fail({ errMsg: 'native export failed' });
    if (failure === 'image') {
      h.exports[0].success({ tempFilePath: 'wxfile://chart.png' }); c.plotImageError(h.imageEvent(c.data.plotImage));
      c.plotImageLoad(h.imageEvent('wxfile://chart.png')); assert.equal(c.data.plotImageReady, false);
    }
    assert.equal(c.data.plotImage, ''); assert.equal(c.data.plotImageReady, false);
    h.ui.paintPlot(c, 'health-trend', c.data.plot, '#4E988F', '#236F68'); assert.equal(h.frames.length, 1);
    h.definition.lifetimes.detached.call(c);
  }
});

test('native specialties validate actual values, preserve zero, merge same-date values, edit and delete', async () => {
  const h = harness('health', { doctor: { slug: 'fu-junfen', name: '傅君芬' } }), c = h.instance;
  c.changeValue(input('fastingGlucose', '0')); c.changeNote({ detail: { value: '实际填报' } }); c.saveRecord();
  let records = h.runtime.readScope('fu-junfen', 'health-records', []);
  assert.equal(records.length, 1); assert.equal(records[0].measurements.fastingGlucose, 0); assert.equal(c.data.summary[0].value, '1 / 7 天');
  assert.equal(c.data.summary[0].number, 1); assert.equal(c.data.summary[0].unit, ' / 7 天'); assert.equal(c.data.summary[1].number, 14); assert.equal(c.data.summary[1].unit, '%');
  c.changeRange(event({ days: 30 })); assert.equal(c.data.summary[0].number, 1); assert.equal(c.data.summary[0].unit, ' / 30 天'); assert.equal(c.data.summary[1].number, 3); c.changeRange(event({ days: 7 }));
  const id = records[0].id;
  await c.startNew(); c.changeValue(input('weightKg', '24.3')); c.saveRecord();
  records = h.runtime.readScope('fu-junfen', 'health-records', []);
  assert.equal(records.length, 1); assert.equal(records[0].id, id); assert.equal(records[0].measurements.fastingGlucose, 0); assert.equal(records[0].measurements.weightKg, 24.3);
  c.changeValue(input('weightKg', '9999')); c.saveRecord(); assert.match(c.data.error, /检查/); assert.equal(h.runtime.readScope('fu-junfen', 'health-records', [])[0].measurements.weightKg, 24.3);
  c.changeValue(input('weightKg', '')); c.saveRecord(); assert.equal(h.runtime.readScope('fu-junfen', 'health-records', [])[0].measurements.weightKg, undefined);
  await c.removeRecord(event({ id })); assert.equal(h.runtime.readScope('fu-junfen', 'health-records', []).length, 0);
  assert.equal(c.data.summary[0].number, 0); assert.equal(c.data.summary[1].number, 0);
});

test('native Tang daily records use exact H5 minute conversion and create only one record per date', async () => {
  const h = harness('health', { doctor: { slug: 'tang-jinsong', name: '唐劲松' } }), c = h.instance;
  c.changeValue(input('sleepDurationHours', '6.5')); c.changeValue(input('nightAwakenings', '0')); c.changeValue(input('anxietyScore', '4')); c.saveRecord();
  let records = h.runtime.readScope('tang-jinsong', 'health-records', []);
  assert.equal(records[0].metrics.sleepDurationMinutes, 390); assert.equal(records[0].metrics.nightAwakenings, 0); assert.equal(c.data.plot.hasData, true);
  await c.changeDate({ detail: { value: c.data.today } }); c.changeValue(input('energyScore', '7')); c.saveRecord();
  records = h.runtime.readScope('tang-jinsong', 'health-records', []); assert.equal(records.length, 1); assert.equal(records[0].metrics.energyScore, 7); assert.equal(records[0].metrics.sleepDurationMinutes, 390);
  await c.startNew(); c.changeNote({ detail: { value: '没有测量，先留备注' } }); assert.doesNotThrow(() => c.saveRecord());
  assert.equal(h.runtime.readScope('tang-jinsong', 'health-records', []).length, 2);
  c.ask(); assert.equal(h.events.at(-1).detail.withHealthContext, true);
});

test('native health account changes clear unsaved visitor drafts and cloud loading rejects writes', () => {
  const h = harness('health', { doctor: { slug: 'fu-junfen', name: '傅君芬' } }), c = h.instance;
  c.changeValue(input('weightKg', '20'));
  h.account.user = { id: 'member' }; c.load(false);
  assert.equal(c.data.dirty, false); assert.equal(c.data.draft.values.weightKg, undefined);
  h.blockEdits(); c.changeValue(input('weightKg', '30')); c.saveRecord(); assert.equal(h.runtime.readScope('fu-junfen', 'health-records', []).length, 0);
});

test('specialty history preserves older records while current-period statistics exclude them', () => {
  const h = harness('health', { doctor: { slug: 'fu-junfen', name: '傅君芬' } }), c = h.instance;
  h.runtime.writeScope('fu-junfen', 'health-records', [{ schemaVersion: 2, id: 'old', source: 'manage', dateKey: '2024-01-01', createdAt: '2024-01-01T04:00:00.000Z', updatedAt: '2024-01-01T04:00:00.000Z', completedTitles: [], measurements: { weightKg: 10 } }]);
  assert.equal(c.data.records.length, 1); assert.equal(c.data.records[0].date, '2024-01-01'); assert.equal(c.data.summary[0].value, '0 / 7 天');
});

test('only an empty specialty legacy record shows the legacy hint, preserving note, completed title and zero measurement', () => {
  for (const slug of ['fu-junfen', 'tang-jinsong']) {
    const h = harness('health', { doctor: { slug } }), c = h.instance;
    const base = { source: 'home', dateKey: c.data.today, createdAt: new Date(h.clock.now).toISOString(), completedTitles: [] };
    h.runtime.writeScope(slug, 'health-records', [
      { ...base, id: 'empty' },
      { ...base, id: 'note', note: '旧记录已有备注' },
      { ...base, id: 'completed', completedTitles: ['记录睡眠'] },
      { ...base, id: 'zero', measurements: { fastingGlucose: 0 } },
    ]);
    assert.equal(c.data.records.length, 4);
    assert.deepEqual(Object.fromEntries(c.data.records.map(record => [record.id, record.legacyEmpty])), { empty: slug === 'fu-junfen', note: false, completed: false, zero: false });
    assert.equal(c.data.records.find(record => record.id === 'zero').measurements.fastingGlucose, 0);
    h.definition.lifetimes.detached.call(c);
  }
});

test('wellness prop transitions expose the diary and health editor fields in either update order', () => {
  const diaryKeys = ['sleepHours', 'sleepQuality', 'sleepLatencyMinutes', 'nightAwakenings', 'moodScore', 'energyScore', 'stressScore'];
  const healthKeys = ['steps', 'heartRate', 'systolicBP', 'diastolicBP', 'weight', 'calorie', 'exerciseMin', 'waist', 'hip'];
  for (const order of [['section', 'view'], ['view', 'section']]) {
    const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'services', view: 'assessment' }), c = h.instance;
    const props = patch => { for (const key of order) { c.setData({ [key]: patch[key] }); h.definition.observers[key].call(c, patch[key]); } };
    props({ section: 'manage', view: 'diary' });
    assert.equal(c.data.activeView, 'diary'); assert.equal(c.data.recordMode, 'diary');
    assert.deepEqual(clone(c.data.metrics.map(metric => metric.key)), diaryKeys);
    assert.deepEqual(clone(c.data.writingFields.map(field => field.key)), ['trigger', 'coping', 'note']);
    assert.equal(c.data.date, c.data.today); assert.equal(c.data.draft.note, '');
    c.metricInput(input('sleepHours', '7.5')); c.writingInput(input('note', '日记字段可以填写')); c.saveRecord();
    props({ section: 'manage', view: 'health' });
    assert.equal(c.data.recordMode, 'health'); assert.deepEqual(clone(c.data.metrics.map(metric => metric.key)), healthKeys);
    c.metricInput(input('steps', '3500')); c.saveRecord();
    props({ section: 'manage', view: 'diary' });
    assert.deepEqual(clone(c.data.metrics.map(metric => metric.key)), diaryKeys);
    assert.equal(c.data.draft.values.sleepHours, '7.5'); assert.equal(c.data.draft.note, '日记字段可以填写'); assert.equal(c.data.existing, true);
    assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).records[0].values.steps, 3500);
    h.definition.lifetimes.detached.call(c);
  }
});

test('native wellness diary and physiology merge by date and clearing one editor preserves the other', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'manage', view: 'diary' }), c = h.instance;
  c.metricInput(input('moodScore', '0')); c.metricInput(input('sleepHours', '7.5')); c.writingInput(input('note', '真实日记')); c.saveRecord();
  c.openView('health', false); c.metricInput(input('steps', '3500')); c.saveRecord();
  let state = h.runtime.readScope('yu-wen', 'wellness-v1', null);
  assert.equal(state.records.length, 1); assert.equal(state.records[0].values.moodScore, 0); assert.equal(state.records[0].values.steps, 3500); assert.equal(state.records[0].note, '真实日记');
  c.metricInput(input('steps', '')); c.saveRecord(); state = h.runtime.readScope('yu-wen', 'wellness-v1', null);
  assert.equal(state.records[0].values.steps, undefined); assert.equal(state.records[0].values.sleepHours, 7.5);
  c.openView('report', false); assert.equal(c.data.reportCount, 1); assert.equal(c.data.chart.filter(p => p.filled).length, 1); assert.equal(c.data.statistics.find(s => s.key === 'moodScore').averageText, '0');
});

test('native wellness goals use genuine records, reversible daily checks and cascading delete', async () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'diary' }), c = h.instance;
  c.writingInput(input('note', '今天散步')); c.saveRecord(); c.openView('goals', false); c.startGoal(event({})); c.saveGoal();
  const goal = c.data.goals[0]; assert.equal(goal.kind, 'diary'); assert.equal(goal.progress, 1); assert.equal(goal.done, false);
  c.checkGoal(event({ id: goal.id })); assert.equal(c.data.goals[0].done, true);
  c.startGoal(event({})); c.goalInput(input('goalTitle', '写下另一件小事')); c.saveGoal();
  const secondGoal = c.data.goals[1]; c.checkGoal(event({ id: secondGoal.id }));
  assert.equal(c.data.checkHistory.length, 2); assert.equal(new Set(c.data.checkHistory.map(item => item.key)).size, 2);
  for (const item of c.data.checkHistory) assert.equal(item.key, `${item.date}:${item.goalId}`);
  assert.ok(fs.readFileSync(path.join(nativeRoot, 'components/wellness/index.wxml'), 'utf8').includes('wx:for="{{checkHistory}}" wx:key="key"'));
  const secondKey = c.data.checkHistory.find(item => item.goalId === secondGoal.id).key;
  c.checkGoal(event({ id: goal.id })); assert.equal(c.data.goals[0].done, false); assert.equal(c.data.checkHistory.length, 1); assert.equal(c.data.checkHistory[0].key, secondKey);
  await c.deleteGoal(event({ id: goal.id })); assert.equal(c.data.goals.length, 1); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).checks.length, 1);
  await c.deleteGoal(event({ id: secondGoal.id })); assert.equal(c.data.goals.length, 0); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).checks.length, 0);
});

test('native psychological assessments consent, scoring, comparison and record deletion match shared models', async () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'assessment' }), c = h.instance;
  c.startAssessment(event({ id: 'gad7' })); assert.equal(c.data.questionnaire, null); assert.match(c.data.error, /勾选/);
  c.setConsent({ detail: { value: ['consent'] } }); c.startAssessment(event({ id: 'gad7' })); c.finishQuiz({ detail: { answers: [1, 1, 1, 1, 1, 1, 1, 3] } });
  assert.equal(c.data.assessmentResult.score, 7); assert.equal(c.data.assessmentResult.answerItems[7].scoreText, '不计分');
  h.clock.now += 1000; c.repeatAssessment(); c.finishQuiz({ detail: { answers: [0, 0, 0, 0, 0, 0, 0, 0] } }); assert.match(c.data.assessmentResult.comparison, /减少 7 分/);
  const id = c.data.assessmentResult.id; await c.deleteHistory(event({ kind: 'assessments', id })); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).assessments.length, 1);
});

test('native MBTI completes all 20 genuine questions, cards retain actual history and user changes reset draft', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'mbti' }), c = h.instance;
  c.startPersonality(); assert.equal(c.data.questionnaire.questions.length, 20); c.finishQuiz({ detail: { answers: Array(20).fill(0) } }); assert.equal(c.data.personalityResult.type.length, 4); assert.equal(c.data.personalityResult.dimensionsList.length, 4);
  c.openView('cards', false); c.drawCard(); assert.ok(c.data.currentCard.id); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).cardDraws.length, 1);
  h.account.user = { id: 'another-member' }; c.load(); assert.equal(c.data.currentCard, null); assert.equal(c.data.personalityResult, null); assert.equal(c.state.personalities.length, 0);
});

test('native breathing only counts actual foreground elapsed seconds and cannot duplicate completed sessions', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'breathing' }), c = h.instance;
  c.startBreathing(); h.clock.now += 4000; c.tickBreathing(); assert.equal(c.data.breathPhase, '呼气');
  c.pauseBreathing(); h.clock.now += 60000; c.startBreathing(); h.clock.now += 3000; c.endBreathing();
  let state = h.runtime.readScope('yu-wen', 'wellness-v1', null); assert.equal(state.sessions[0].seconds, 7); assert.equal(state.sessions[0].completed, false);
  c.endBreathing(); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).sessions.length, 1);
  c.startBreathing(); h.clock.now += 61000; c.tickBreathing(); state = h.runtime.readScope('yu-wen', 'wellness-v1', null); assert.equal(state.sessions.length, 2); assert.equal(state.sessions[1].seconds, 60); assert.equal(state.sessions[1].completed, true);
});

test('native meditation loads H5 audio, excludes seek jumps from practice time and only stores actual listening', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'meditation' }), c = h.instance, audio = h.audio[0];
  assert.match(audio.src, /^https:\/\/example.test\/assets\/yuwen\/audio\/present-moment.m4a$/);
  c.toggleAudio(); h.clock.now += 2500; audio.currentTime = 2.5; audio.emit('TimeUpdate');
  c.seekAudio({ detail: { value: 100 } }); h.clock.now += 1500; audio.currentTime = 101.5; audio.emit('TimeUpdate'); c.endAudio();
  const session = h.runtime.readScope('yu-wen', 'wellness-v1', null).sessions[0]; assert.equal(session.seconds, 4); assert.equal(session.completed, false);
  c.endAudio(); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', null).sessions.length, 1);
});

test('destroyed meditation audio events cannot finish a different course or update a new account', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'meditation' }), c = h.instance, first = h.audio[0];
  c.toggleAudio(); h.clock.now += 2000; first.currentTime = 2; first.emit('TimeUpdate');
  c.selectCourse(event({ id: 'body-relaxation' })); const second = h.audio[1]; c.toggleAudio();
  first.emit('Ended'); first.emit('Error');
  assert.equal(c.data.playing, true); assert.equal(c.data.error, ''); assert.equal(c.audioRun.saved, false);
  h.account.user = { id: 'other' }; c.load(); second.emit('Ended'); assert.equal(h.runtime.readScope('yu-wen', 'wellness-v1', { sessions: [] }).sessions.length, 0); assert.equal(c.data.playing, false);
});

test('native Tang mood immediately sends in the current chat and assessment supplement requires explicit share', () => {
  const h = harness('guidance', { doctor: { slug: 'tang-jinsong' } }), c = h.instance;
  c.sendMood(event({ id: 'tense' })); assert.equal(h.events.at(-1).detail.sendNow, true); assert.match(h.events.at(-1).detail.question, /焦虑/);
  c.resolveSend({ requestId: h.events.at(-1).detail.guidanceRequestId, accepted: true });
  c.start(event({ id: 'phq9' })); c.finish({ detail: { answers: [0, 0, 0, 0, 0, 0, 0, 0, 1, 0] } }); assert.equal(c.data.result.score, 1); assert.equal(c.data.result.needsSupport, true);
  c.changeSupplement({ detail: { value: '私人补充，不默认分享' } }); const before = h.events.length; c.discuss(); assert.equal(h.events.length, before);
  c.saveSupplement(); c.discuss(); assert.doesNotMatch(h.events.at(-1).detail.question, /私人补充/); assert.match(h.events.at(-1).detail.question, /第 9 题/);
  c.resolveSend({ requestId: h.events.at(-1).detail.guidanceRequestId, accepted: true });
  c.toggleInclude({ detail: { value: ['share'] } }); c.discuss(); assert.match(h.events.at(-1).detail.question, /私人补充/);
});

test('native questionnaire prevents missing-answer completion and repeated submission', () => {
  const h = harness('questionnaire', { questions: [{ text: '第一题', options: ['A', 'B'] }, { text: '第二题', options: ['A', 'B'] }] }), c = h.instance;
  h.definition.observers.questions.call(c, c.data.questions); c.next(); assert.equal(h.events.length, 0); assert.match(c.data.error, /选择/);
  c.choose(event({ value: 1 })); c.next(); c.choose(event({ value: 0 })); c.next(); c.next(); assert.equal(h.events.filter(e => e.type === 'complete').length, 1); assert.deepEqual(h.events[0].detail.answers, [1, 0]);
});

test('wellness history edits in place, preserves the other form and requires explicit inline daily deletion', async () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'manage', view: 'diary' }), c = h.instance;
  c.metricInput(input('sleepHours', '7')); c.writingInput(input('note', '今天的记录')); c.saveRecord();
  await c.openView('', false); const date = c.data.today;
  c.selectHistory(event({ date })); c.editHistory(event({ mode: 'health' }));
  assert.equal(c.data.activeView, ''); assert.equal(c.data.inlineRecordMode, 'health'); assert.equal(c.data.recordMode, 'health');
  assert.equal(h.events.filter(e => e.type === 'view').length, 0);
  c.metricInput(input('steps', '4200')); c.saveRecord();
  assert.equal(c.state.records[0].values.sleepHours, 7); assert.equal(c.state.records[0].note, '今天的记录');
  c.deleteDay(); assert.equal(c.state.records.length, 1); assert.equal(c.data.deleteConfirm, true);
  c.cancelDeleteDay(); assert.equal(c.state.records.length, 1); assert.equal(c.data.deleteConfirm, false);
  c.closeHistoryEditor(); assert.equal(c.data.inlineRecordMode, '');
  c.editHistory(event({ mode: 'diary' })); c.deleteDay(); c.confirmDeleteDay();
  assert.equal(c.state.records.length, 0); assert.equal(c.data.existing, false); assert.equal(c.data.deleteConfirm, false);
});

test('wellness view changes reset local exploration state while retaining saved cards and practice history', async () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'services', view: 'cards' }), c = h.instance;
  c.drawCard(); const id = c.data.currentCardId;
  c.setData({ allCardHistory: true, showTypes: true, days: 30, goalEditor: true, breathDurationIndex: 2, courseFilter: '呼吸' });
  await c.openView('breathing', false); assert.equal(c.data.currentCard, null); assert.equal(c.data.allCardHistory, false); assert.equal(c.data.days, 7); assert.equal(c.data.goalEditor, false); assert.equal(c.data.breathDurationIndex, 0);
  c.startBreathing(); h.clock.now += 2000; c.tickBreathing(); assert.equal(c.data.breathScale, 1);
  c.pauseBreathing(); assert.equal(c.data.breathScale, .8);
  await c.openView('cards', false); assert.equal(c.state.sessions.length, 1); assert.equal(c.data.currentCardId, ''); assert.equal(c.data.cardHistory[0].id, id);
  await c.openView('breathing', false); assert.equal(c.data.practiceHistoryCount, 1); assert.equal(c.data.practiceHistory.length, 1);
});

test('assessment history count follows its filter, and inline MBTI deletion falls back to the latest saved result', async () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'services', view: 'assessment' }), c = h.instance;
  c.setConsent({ detail: { value: ['consent'] } });
  for (let i = 0; i < 9; i++) { h.clock.now += 1000; c.startAssessment(event({ id: 'gad7' })); c.finishQuiz({ detail: { answers: Array(8).fill(0) } }); }
  c.filterAssessment({ detail: { value: 2 } }); assert.equal(c.data.assessmentCount, 9); assert.equal(c.data.filteredAssessmentCount, 0); assert.equal(c.data.assessmentHistory.length, 0);
  await c.openView('mbti', false);
  c.startPersonality(); c.finishQuiz({ detail: { answers: Array(20).fill(0) } }); const older = c.data.personalityResult.id;
  h.clock.now += 1000; c.startPersonality(); c.finishQuiz({ detail: { answers: Array(20).fill(1) } }); const newer = c.data.personalityResult.id;
  const deletion = event({ id: newer, kind: 'personalities' }); c.requestHistoryDelete(deletion); assert.equal(c.state.personalities.length, 2);
  c.cancelHistoryDelete(deletion); assert.equal(c.data.historyDeleteIds[newer], false);
  c.requestHistoryDelete(deletion); await c.confirmHistoryDelete(deletion); assert.equal(c.state.personalities.length, 1); assert.equal(c.data.personalityResult.id, older);
  c.togglePersonalityType(event({ type: 'INTJ' })); assert.equal(c.data.personalityTypes.find(t => t.type === 'INTJ').expanded, true); assert.equal(c.data.personalityTypes.filter(t => t.expanded).length, 1);
});

test('native record retry targets the proper doctor scope and does not discard dirty drafts or report false success', async () => {
  for (const [name, slug, section] of [['health','fu-junfen','health-records'],['wellness','yu-wen','wellness-v1']]) {
    const h = harness(name, { doctor: { slug }, section: 'manage', view: 'diary' }), c = h.instance;
    if (name === 'health') c.changeNote({ detail: { value: '未保存的填写' } }); else c.writingInput(input('note','未保存的填写'));
    h.storageStatus('memory-only'); await c.retryStorage();
    assert.deepEqual(h.retries, [{ slug, section }]); assert.equal(c.data.dirty, true); assert.equal(c.data.draft.note, '未保存的填写');
    assert.equal(name === 'health' ? c.data.storageProblem : Boolean(c.data.storageNotice), true);
    h.storageStatus('memory-only', { retryTo: 'ready' }); await c.retryStorage();
    assert.equal(name === 'health' ? c.data.storageProblem : Boolean(c.data.storageNotice), false); assert.equal(c.data.draft.note, '未保存的填写');
  }
});

test('Tang questionnaire switches to the non-scored impact prompt without altering scored answers', () => {
  const h = harness('questionnaire', { variant: 'tang', scoredItems: 1, questions: [{ text: '频率题', options: ['0','1'] }, { text: '影响题', options: ['无','有'] }] }), c = h.instance;
  h.definition.observers.questions.call(c,c.data.questions); assert.match(c.data.questionDescription,/过去 2 周/);
  c.choose(event({ value: 1 })); c.next(); assert.match(c.data.questionDescription,/本题不计入总分/);
  c.previous(); assert.match(c.data.questionDescription,/过去 2 周/); assert.equal(c.data.choice, 1);
});

test('fixed guidance glyph artwork preserves every shared mood and the message selected by its id', async () => {
  const { guidanceMoodGlyphSvg } = await import('../scripts/native-guidance-mood-glyphs.mjs');
  const h = harness('guidance', { doctor: { slug: 'tang-jinsong' } });
  const model = h.load(path.join(nativeRoot, 'utils/models/guidance.js'));
  assert.deepEqual(clone(h.instance.data.moods.map(({ symbolImage, ...mood }) => mood)), clone(model.TANG_MOODS));
  assert.deepEqual(h.instance.data.moods.filter(mood => mood.symbolImage).map(mood => mood.id), ['low', 'bright']);
  for (const mood of model.TANG_MOODS) {
    const svg = guidanceMoodGlyphSvg(mood);
    if (['low', 'bright'].includes(mood.id)) {
      assert.match(svg, /viewBox="0 0 25 25"/);
      assert.match(svg, /<path fill="#73533e"/);
      assert.doesNotMatch(svg, /<text/);
      assert.throws(() => guidanceMoodGlyphSvg({ ...mood, symbol: '?' }), /changed H5 mood symbol/);
    } else assert.equal(svg, null);
    const selected = harness('guidance', { doctor: { slug: 'tang-jinsong' } });
    selected.instance.sendMood(event({ id: mood.id }));
    assert.equal(selected.events.at(-1).detail.question, model.buildTangMoodMessage(mood.id));
    assert.equal(selected.instance.data.selectedMood, '');
    selected.instance.resolveSend({ requestId: selected.events.at(-1).detail.guidanceRequestId, accepted: true });
    assert.equal(selected.instance.data.selectedMood, mood.id);
  }
});

test('Tang guidance waits for the matching accepted send, blocks repeat taps and ignores a previous owner acknowledgement', () => {
  const h = harness('guidance', { doctor: { slug: 'tang-jinsong' } }), c = h.instance;
  c.sendMood(event({ id: 'tense' })); const first = h.events.at(-1).detail.guidanceRequestId;
  assert.equal(c.data.sending, true); assert.equal(c.data.expanded, true); assert.equal(c.data.selectedMood, '');
  c.sendMood(event({ id: 'tense' })); assert.equal(h.events.length, 1);
  c.resolveSend({ requestId: 'unrelated-request', accepted: true }); assert.equal(c.data.sending, true);
  c.resolveSend({ requestId: first, accepted: false }); assert.equal(c.data.expanded, true); assert.equal(c.data.sending, false); assert.equal(c.data.feedback, '暂时没能发送，请稍后再试。');
  c.sendMood(event({ id: 'tense' })); const second = h.events.at(-1).detail.guidanceRequestId; assert.notEqual(second, first);
  h.definition.observers.sendResult.call(c,{ requestId: second, accepted: true }); assert.equal(c.data.selectedMood, 'tense'); assert.equal(c.data.expanded, false);
  c.toggle(); c.sendMood(event({ id: 'tense' })); const oldOwnerRequest = h.events.at(-1).detail.guidanceRequestId;
  h.account.user = { id: 'new-account' }; c.load(); c.resolveSend({ requestId: oldOwnerRequest, accepted: true });
  assert.equal(c.data.sending, false); assert.equal(c.data.selectedMood, ''); assert.equal(c.data.expanded, true);
});

test('wellness date and today actions directly rebuild the selected date form like H5', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'diary' }), c = h.instance, today = c.data.today;
  c.writingInput(input('note', '今天已经保存')); c.saveRecord();
  c.writingInput(input('note', '未保存的新草稿')); c.changeDate({ detail: { value: '2026-10-10' } });
  assert.equal(c.data.date, '2026-10-10'); assert.equal(c.data.draft.note, ''); assert.equal(c.data.dirty, false); assert.equal(c.data.existing, false);
  c.writingInput(input('note','昨天未保存')); c.todayDraft();
  assert.equal(c.data.date, today); assert.equal(c.data.draft.note, '今天已经保存'); assert.equal(c.data.existing, true); assert.equal(h.modals.length, 0);
});

test('breathing completion renders the ready phase with elapsed time while preserving completed session evidence', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'breathing' }), c = h.instance;
  c.startBreathing(); h.clock.now += 61000; c.tickBreathing();
  assert.equal(c.data.breathRunning, false); assert.equal(c.data.breathInProgress, false); assert.equal(c.data.breathPhase, '准备好了吗'); assert.equal(c.data.breathCountdown, '01:00'); assert.equal(c.data.breathScale, .8);
  assert.equal(c.state.sessions[0].seconds, 60); assert.equal(c.state.sessions[0].completed, true); assert.equal(c.data.notice, '本次练习已完成，时长已记录。');
});

test('specialty midnight timer refreshes trends and rolls only a clean new draft from the previous day', () => {
  const localDay = value => { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`; };
  for (const condition of ['clean','dirty','editing','historical']) {
    const h = harness('health', { doctor: { slug: 'fu-junfen', name: '傅君芬' } }), c = h.instance, oldDay = c.data.today;
    if (condition === 'dirty') c.changeNote({ detail: { value: '尚未保存' } });
    if (condition === 'editing') { c.changeValue(input('weightKg', '24')); c.saveRecord(); }
    if (condition === 'historical') c.setData({ 'draft.dateKey': '2024-01-01' });
    const originalDate = c.data.draft.dateKey, next = new Date(h.clock.now); next.setHours(24,0,0,200); h.clock.now = next.getTime(); h.flushTimers();
    assert.notEqual(c.data.today, oldDay); assert.equal(c.data.today, localDay(h.clock.now));
    assert.equal(c.data.draft.dateKey, condition === 'clean' ? c.data.today : originalDate);
    assert.equal(c.data.plot.plotPoints.at(-1).date, c.data.today);
    if (condition === 'dirty') assert.equal(c.data.draft.note, '尚未保存');
    assert.equal(h.timeouts.size, 1);
    h.definition.lifetimes.detached.call(c); assert.equal(h.timeouts.size, 0);
  }
});

test('goal midnight refresh clears yesterday completion and daily progress, suspends in background and resumes on show', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'manage', view: 'goals' }), c = h.instance, oldDay = c.data.today;
  c.openView('diary',false); c.writingInput(input('note','今日已记录')); c.saveRecord(); c.openView('goals',false);
  c.startGoal(event({})); c.saveGoal(); c.checkGoal(event({ id: c.data.goals[0].id }));
  assert.equal(c.data.goalCompleted, 1); assert.equal(c.data.goals[0].progress, 1);
  const next = new Date(h.clock.now); next.setHours(24,0,0,200); h.clock.now = next.getTime(); h.flushTimers();
  assert.notEqual(c.data.today, oldDay); assert.equal(c.data.goalCompleted, 0); assert.equal(c.data.goals[0].done, false); assert.equal(c.data.goals[0].progress, 0); assert.equal(c.state.checks[0].date, oldDay); assert.equal(c.state.records[0].date,oldDay);
  h.definition.pageLifetimes.hide.call(c); assert.equal(h.timeouts.size, 0);
  const nextAgain = new Date(h.clock.now); nextAgain.setHours(24,0,0,200); h.clock.now = nextAgain.getTime(); h.definition.pageLifetimes.show.call(c);
  assert.equal(h.timeouts.size, 1); assert.equal(c.data.today, nextAgain.getFullYear()+'-'+String(nextAgain.getMonth()+1).padStart(2,'0')+'-'+String(nextAgain.getDate()).padStart(2,'0'));
  h.definition.lifetimes.detached.call(c); assert.equal(h.timeouts.size, 0);
});

test('native health confirmations cannot clear or delete a different owner or doctor scope', async () => {
  for (const action of ['removeRecord', 'clearRecords']) {
    const h = harness('health', { doctor: { slug: 'fu-junfen', name: '傅君芬' } }), c = h.instance;
    c.changeValue(input('weightKg', '24')); c.saveRecord(); const original = clone(c.rawRecords[0]);
    let prompt; h.wx.showModal = options => { prompt = options; };
    const pending = c[action](event({ id: original.id })); assert.ok(prompt);
    h.account.user = { id: 'another-account' }; c.load(false);
    h.runtime.writeScope('fu-junfen', 'health-records', [{ ...original, note: '新账户自己的记录' }]);
    prompt.success({ confirm: true }); await pending;
    assert.equal(c.rawRecords.length, 1); assert.equal(c.rawRecords[0].note, '新账户自己的记录');
    const pendingDoctor = c[action](event({ id: original.id }));
    c.setData({ doctor: { slug: 'gong-wenbo', name: '龚文波' } }); c.load(true);
    h.runtime.writeScope('gong-wenbo', 'health-records', [{ ...original, note: '另一智能体的记录' }]);
    prompt.success({ confirm: true }); await pendingDoctor;
    assert.equal(c.rawRecords.length, 1); assert.equal(c.rawRecords[0].note, '另一智能体的记录');
    h.definition.lifetimes.detached.call(c);
  }
});

test('wellness deletion confirmation cannot remove a different account goal or session with the same id', async () => {
  for (const kind of ['goals', 'sessions']) {
    const h = harness('wellness', { doctor: { slug: 'yu-wen' }, section: 'manage' }), c = h.instance;
    if (kind === 'goals') { c.startGoal(event({})); c.saveGoal(); }
    else { await c.openView('breathing', false); c.startBreathing(); h.clock.now += 2000; c.endBreathing(); }
    const initial = clone(c.state), id = initial[kind][0].id;
    let prompt; h.wx.showModal = options => { prompt = options; };
    const pending = kind === 'goals' ? c.deleteGoal(event({ id })) : c.deleteHistory(event({ kind, id }));
    assert.ok(prompt); h.account.user = { id: 'new-account' }; c.load();
    initial[kind][0].title = '新账户的数据'; h.runtime.writeScope('yu-wen', 'wellness-v1', initial);
    prompt.success({ confirm: true }); await pending;
    assert.equal(c.state[kind].length, 1); assert.equal(c.state[kind][0].title, '新账户的数据');
    h.definition.lifetimes.detached.call(c);
  }
});

test('failed breathing and meditation saves retain exact sessions for retry without reporting success or duplicating', async () => {
  for (const kind of ['breathing', 'meditation']) {
    const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: kind }), c = h.instance;
    if (kind === 'breathing') c.startBreathing(); else c.toggleAudio();
    h.clock.now += 4000;
    if (kind === 'meditation') { h.audio[0].currentTime = 4; h.audio[0].emit('TimeUpdate'); }
    h.blockEdits();
    if (kind === 'breathing') c.endBreathing(); else c.endAudio();
    assert.equal(c.state.sessions.length, 0); assert.equal(c.data.practiceSavePending, 1); assert.equal(c.data.notice, '');
    const pending = clone(c.pendingPractice[0]); assert.equal(pending.kind, kind); assert.equal(pending.seconds, 4);
    if (kind === 'breathing') c.endBreathing(); else c.endAudio();
    assert.equal(c.pendingPractice.length, 1); assert.equal(c.data.notice, '');
    h.storageStatus('ready', { canEdit: true }); c.retryPracticeSave(); c.retryPracticeSave();
    assert.equal(c.data.practiceSavePending, 0); assert.equal(c.state.sessions.length, 1); assert.deepEqual(clone(c.state.sessions[0]), pending);
    h.definition.lifetimes.detached.call(c);
  }
});

test('uncommitted wellness practice is scoped to its current account and is never imported to a new owner', () => {
  const h = harness('wellness', { doctor: { slug: 'yu-wen' }, view: 'breathing' }), c = h.instance;
  c.startBreathing(); h.clock.now += 2000; h.blockEdits(); c.endBreathing(); assert.equal(c.data.practiceSavePending, 1);
  h.account.user = { id: 'new-account' }; c.load(); h.storageStatus('synced', { canEdit: true }); c.retryPracticeSave();
  assert.equal(c.data.practiceSavePending, 0); assert.equal(c.state.sessions.length, 0); assert.equal(c.pendingPractice.length, 0);
  h.definition.lifetimes.detached.call(c);
});

test('Tang home closes the previous owner record draft and cannot save it to a new account', () => {
  const h = harness('home', { doctor: { slug: 'tang-jinsong', name: '唐劲松' }, ownerKey: 'guest' }), c = h.instance;
  c.openRecord(event({})); c.editDraft(input('sleepDurationHours', '6')); assert.equal(c.data.sheetOpen, true);
  h.account.user = { id: 'new-account' }; c.saveRecord();
  assert.equal(h.runtime.readScope('tang-jinsong', 'health-records', []).length, 0);
  c.setData({ ownerKey: 'new-account' }); c.refresh();
  assert.equal(c.data.sheetOpen, false); assert.deepEqual(clone(c.data.draft), {});
  h.definition.lifetimes.detached.call(c);
});

test('every native doctor service worksheet saves, reopens, previews an unsent draft and deletes within its own scope', async () => {
  const seed = harness('education', { doctor: { slug: 'fu-junfen', name: '傅君芬', services: ['血糖与胰岛素记录'] } });
  const catalog = seed.load(path.join(nativeRoot, 'utils/models/catalog.js')); seed.definition.lifetimes.detached.call(seed.instance);
  for (const doctor of catalog.doctorProfiles) {
    for (let index = 0; index < doctor.services.length; index++) {
      const h = harness('education', { doctor: clone(doctor) }), c = h.instance, service = doctor.services[index];
      await c.openService(event({ index })); assert.equal(c.data.plan.service, service); assert.ok(c.data.planSteps.length >= 3);
      c.togglePlanStep(event({ step: c.data.planSteps[0].text })); c.editPlan(input('note', '自己的记录与问题')); c.editPlan(input('targetDate', '2026-11-02'));
      assert.equal(c.savePlan(), true); assert.equal(c.data.planDirty, false); assert.equal(c.data.planSaved, true);
      const saved = h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0]; assert.equal(saved.note, '自己的记录与问题'); assert.equal(saved.targetDate, '2026-11-02'); assert.equal(saved.completed.length, 1);
      await c.closeSheet(); h.clock.now += 1000; h.flushTimers(); await c.openService(event({ index }));
      assert.equal(c.data.plan.note, '自己的记录与问题'); assert.equal(c.data.planSteps[0].checked, true);
      c.previewPlan(); assert.match(c.data.planPreview, /自己的记录与问题/); assert.equal(h.events.length, 0);
      c.consultPlan(); assert.equal(h.events.length, 1); assert.equal(h.events[0].type, 'ask'); assert.equal(h.events[0].detail.sendNow, undefined); assert.match(h.events[0].detail.question, /自己的记录与问题/);
      await c.openService(event({ index })); await c.deletePlan(); assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans.length, 0);
      h.definition.lifetimes.detached.call(c);
    }
  }
});

test('native service worksheets preserve dirty drafts on cancelled close and failed writes, and isolate delayed deletion', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理', '血糖与胰岛素记录'] }, h = harness('education', { doctor }), c = h.instance;
  await c.openService(event({ index: 0 })); c.editPlan(input('note', '未保存的内容'));
  h.wx.showModal = options => options.success({ confirm: false }); assert.equal(await c.closeSheet(), false); assert.equal(c.data.plan.note, '未保存的内容');
  h.blockEdits(); assert.equal(c.savePlan(), false); assert.equal(c.data.planDirty, true); assert.equal(c.data.plan.note, '未保存的内容'); assert.match(c.data.planError, /尚未保存/);
  h.storageStatus('ready', { canEdit: true }); c.refresh(); assert.equal(c.savePlan(), true);
  c.editPlan(input('targetDate', '2026-02-30')); assert.equal(c.savePlan(), false); assert.equal(c.data.plan.targetDate, '2026-02-30'); c.editPlan(input('targetDate', '')); c.savePlan();
  let prompt; h.wx.showModal = options => { prompt = options; }; const deletion = c.deletePlan();
  h.account.user = { id: 'new-owner' }; c.refresh();
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ id: doctor.services[0], service: doctor.services[0], completed: [], note: '新账号清单', targetDate: '', updatedAt: new Date(h.clock.now).toISOString() }] });
  prompt.success({ confirm: true }); await deletion;
  assert.equal(c.data.plan, null); assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '新账号清单');
  h.definition.lifetimes.detached.call(c);
});

test('native service worksheet follows clean cloud changes while preserving dirty edits and previous checklist wording', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理'] }, h = harness('education', { doctor }), c = h.instance;
  const saved = { id: 'imported-old-plan', service: doctor.services[0], completed: ['旧版清单中已整理的事项'], note: '原来的记录', targetDate: '', updatedAt: new Date(h.clock.now).toISOString() };
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [saved] });
  await c.openService(event({ index: 0 })); assert.equal(c.data.plan.id, saved.id); assert.deepEqual(clone(c.data.plan.completed), saved.completed);
  c.savePlan(); assert.deepEqual(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].completed, saved.completed);
  c.previewPlan(); assert.match(c.data.planPreview, /旧版清单中已整理/);
  h.clock.now += 1000;
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ ...saved, note: '另一设备更新', updatedAt: new Date(h.clock.now).toISOString() }] });
  assert.equal(c.data.plan.note, '另一设备更新'); assert.equal(c.data.planPreview, '');
  c.editPlan(input('note', '正在填写的本机草稿'));
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ ...saved, note: '再次更新' }] });
  assert.equal(c.data.plan.note, '正在填写的本机草稿'); assert.equal(c.data.planDirty, true);
  assert.equal(c.data.planConflict, true); assert.equal(c.savePlan(), false);
  assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '再次更新');
  c.confirmCurrentPlanDraft();
  c.savePlan(); assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '正在填写的本机草稿');
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [] });
  assert.equal(c.data.planSaved, false); assert.equal(c.data.plan.note, ''); assert.equal(c.data.plan.completed.length, 0);
  h.definition.lifetimes.detached.call(c);
});

test('native service save and deletion feedback distinguish pending, conflict, offline and confirmed cloud sync', async () => {
  const doctor = { slug: 'tang-jinsong', name: '唐劲松', services: ['就诊资料准备'] }, h = harness('education', { doctor }), c = h.instance;
  h.account.user = { id: 'account' }; c.refresh(); await c.openService(event({ index: 0 }));
  c.editPlan(input('note', '自己的准备'));
  h.storageStatus('pending'); c.savePlan(); assert.match(c.data.planNotice, /正在同步/);
  h.storageStatus('synced'); c.refresh(); assert.equal(c.data.planNotice, '服务清单已同步到微信账户。');
  h.storageStatus('conflict'); c.refresh(); assert.match(c.data.planNotice, /冲突/); assert.doesNotMatch(c.data.planNotice, /正在同步/);
  h.storageStatus('offline'); c.refresh(); assert.match(c.data.planNotice, /尚未同步/); assert.doesNotMatch(c.data.planNotice, /正在同步/);
  await c.deletePlan(); assert.equal(c.data.planSaved, false); assert.match(c.data.planNotice, /删除操作.*尚未同步/);
  h.storageStatus('synced'); c.refresh(); assert.equal(c.data.planNotice, '服务清单删除已同步到微信账户。');
  h.definition.lifetimes.detached.call(c);
});

test('native service history opens removed services and duplicate service plans by their immutable ids', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理'] }, h = harness('education', { doctor }), c = h.instance;
  const plan = (id, service, note) => ({ id, service, note, completed: ['此前准备的资料'], targetDate: '2026-11-01', updatedAt: '2026-10-11T12:00:00+08:00' });
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [plan('first', doctor.services[0], '第一份'), plan('duplicate', doctor.services[0], '同名第二份'), plan('retired', '旧版服务名称', '已下架服务的资料')] });
  assert.deepEqual(clone(c.data.savedPlans.map(item => item.id)), ['duplicate', 'retired']);
  await c.openService(event({ index: 0 })); assert.equal(c.data.plan.id, 'first'); assert.equal(c.data.plan.note, '第一份');
  await c.openService(event({ id: 'duplicate' })); assert.equal(c.data.plan.id, 'duplicate'); assert.equal(c.data.plan.note, '同名第二份');
  c.editPlan(input('note', '修改同名第二份')); c.savePlan(); c.refresh(); assert.equal(c.data.plan.id, 'duplicate'); assert.equal(c.data.plan.note, '修改同名第二份');
  c.togglePlanStep(event({ step: '此前准备的资料' })); assert.equal(c.data.plan.completed.length, 0); assert.equal(c.data.planSteps.some(item => item.text === '此前准备的资料'), false); c.savePlan();
  await c.deletePlan(); assert.deepEqual(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans.map(item => item.id), ['first', 'retired']);
  await c.openService(event({ id: 'retired' })); assert.equal(c.data.plan.note, '已下架服务的资料'); assert.equal(c.data.selectedService.title, '旧版服务名称');
  c.editPlan(input('note', '仍然可以更新')); c.savePlan(); assert.equal(c.data.plan.id, 'retired');
  await c.deletePlan(); assert.deepEqual(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans.map(item => item.id), ['first']);
  h.definition.lifetimes.detached.call(c);
});

test('native service stale draft protection is per plan and requires an explicit baseline choice before save', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理', '血糖与胰岛素记录'] }, h = harness('education', { doctor }), c = h.instance;
  const original = { id: 'first', service: doctor.services[0], completed: [], note: '原内容', targetDate: '', updatedAt: new Date(h.clock.now).toISOString() };
  const other = { ...original, id: 'second', service: doctor.services[1], note: '另一计划' };
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [original, other] });
  await c.openService(event({ index: 0 })); c.editPlan(input('note', '我的修改'));
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [original, { ...other, note: '另一计划的新内容' }] });
  assert.equal(c.data.planConflict, false); assert.equal(c.savePlan(), true);
  assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[1].note, '另一计划的新内容');
  c.editPlan(input('note', '我的下一版草稿'));
  const remote = { ...c.data.plan, note: '远端新的记录', updatedAt: new Date(h.clock.now + 1000).toISOString() };
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [remote, other] });
  assert.equal(c.data.planConflict, true); assert.equal(c.savePlan(), false); assert.equal(c.data.plan.note, '我的下一版草稿');
  assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '远端新的记录');
  c.reloadSavedPlan(); assert.equal(c.data.plan.note, '远端新的记录'); assert.equal(c.data.planDirty, false); assert.equal(c.data.planConflict, false);
  c.editPlan(input('note', '明确确认的草稿'));
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ ...remote, note: '远端又更新' }, other] });
  c.confirmCurrentPlanDraft(); assert.equal(c.data.plan.note, '明确确认的草稿'); assert.equal(c.data.planConflict, false);
  assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '远端又更新', 'confirming a draft only changes its baseline, never writes immediately');
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ ...remote, note: '确认之后远端再次更新' }, other] });
  assert.equal(c.savePlan(), false); assert.equal(c.data.planConflict, true);
  c.confirmCurrentPlanDraft(); assert.equal(c.savePlan(), true); assert.equal(c.data.planConflict, false);
  assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans[0].note, '明确确认的草稿');
  h.definition.lifetimes.detached.call(c);
});

test('native service concurrent remote deletion cannot be silently recreated by an old draft', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理'] }, h = harness('education', { doctor }), c = h.instance;
  await c.openService(event({ index: 0 })); c.editPlan(input('note', '最初内容')); c.savePlan(); c.editPlan(input('note', '未保存的草稿'));
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [] });
  assert.equal(c.data.planConflict, true); assert.equal(c.savePlan(), false); assert.equal(h.runtime.readScope(doctor.slug, 'service-plans-v1', null).plans.length, 0);
  c.reloadSavedPlan(); assert.equal(c.data.plan.note, ''); assert.equal(c.data.planDirty, false); assert.equal(c.data.planConflict, false); assert.equal(c.data.planSaved, false);
  c.editPlan(input('note', '新建时的草稿'));
  h.runtime.writeScope(doctor.slug, 'service-plans-v1', { version: 1, plans: [{ ...c.data.plan, note: '另一设备新建的计划' }] });
  assert.equal(c.savePlan(), false); assert.equal(c.data.planConflict, true);
  h.account.user = { id: 'another-owner' }; c.refresh(); assert.equal(c.data.plan, null); assert.equal(c.data.planConflict, false);
  h.definition.lifetimes.detached.call(c);
});

test('native service preview preserves line breaks while the single-line chat draft keeps separators', async () => {
  const doctor = { slug: 'fu-junfen', name: '傅君芬', services: ['校园与运动管理'] }, h = harness('education', { doctor }), c = h.instance;
  await c.openService(event({ index: 0 })); c.editPlan(input('note', '第一行\n第二行')); c.previewPlan();
  assert.match(c.data.planPreview, /第一行\n第二行/); c.consultPlan();
  assert.doesNotMatch(h.events[0].detail.question, /\n/); assert.match(h.events[0].detail.question, /第一行；第二行/); assert.equal(h.events[0].detail.sendNow, undefined);
  h.definition.lifetimes.detached.call(c);
});


test('builder custom peak-flow saves without a note, reloads zero and keeps authored field labels in native summaries', () => {
  const doctor = { slug: 'respiratory-builder', name: '新呼吸医生', builder: { schemaVersion:1,components:[{id:'home',enabled:true,order:0},{id:'records',enabled:true,order:1}],recordFields:[{key:'peak-flow',label:'呼气峰流量',unit:'L/min',min:0,max:1000,step:1}],assessments:[],servicePlans:[],voice:{enabled:false,autoSend:true,autoPlay:false},healthContext:true } };
  const h=harness('health',{doctor}), c=h.instance;
  c.changeValue(input('peak-flow','0'));c.saveRecord();
  let records=h.runtime.readScope(doctor.slug,'health-records',[]);assert.equal(records.length,1);assert.equal(records[0].measurements['peak-flow'],0);assert.equal(records[0].note,undefined);
  c.load(false);assert.equal(c.data.records[0].measurements['peak-flow'],0);assert.match(c.data.records[0].summary,/呼气峰流量 0 L\/min/);assert.equal(c.data.summary[0].number,1);
  c.changeValue(input('peak-flow','430'));c.saveRecord();records=h.runtime.readScope(doctor.slug,'health-records',[]);assert.equal(records.length,1);assert.equal(records[0].measurements['peak-flow'],430);c.load(false);assert.equal(c.data.records[0].measurementsList[0].label,'呼气峰流量');
});


test('native typed records retain text and selected values, group fields and calculate only numeric trends',()=>{
 const doctor={slug:'typed-doctor',name:'新医生',builder:{recordFields:[{key:'temperature',label:'体温',type:'number',group:'测量',min:0,max:60,step:0.1,unit:'℃'},{key:'feeling',label:'感受',type:'text',group:'日常'},{key:'status',label:'状态',type:'select',group:'日常',options:['稳定','加重']}],components:[],voice:{enabled:false}}};const h=harness('health',{doctor}),c=h.instance;c.changeValue(input('temperature','0'));c.changeValue(input('feeling','真实感受'));c.changeSelect({...event({key:'status'}),detail:{value:'2'}});c.saveRecord();const record=h.runtime.readScope(doctor.slug,'health-records',[])[0];assert.equal(record.values.status,'加重');assert.equal(record.values.feeling,'真实感受');c.load(false);assert.equal(c.data.statsFields.length,1);assert.equal(c.data.fields[1].showGroup,true);assert.match(c.data.records[0].summary,/感受 真实感受/);assert.equal(c.data.records[0].measurementsList.length,3);
});
test('native configured services enforce prerequisites and required input, then reopen persisted field values',async()=>{
 const doctor={slug:'service-builder',name:'新医生',builder:{components:[],recordFields:[],assessments:[],voice:{enabled:false},servicePlans:[{id:'prepare',title:'准备',completionRule:'all-required',steps:[{id:'first',title:'报告',required:true,fields:[{key:'date',label:'报告日期',type:'text',required:true}]},{id:'next',title:'问题',required:true,dependsOn:['first'],fields:[{key:'count',label:'数量',type:'number',required:true}]}]}]}};const h=harness('education',{doctor,mode:'services'}),c=h.instance;await c.openService(event({index:0}));assert.equal(c.data.planSteps[1].blocked,true);c.togglePlanStep(event({step:'问题'}));assert.equal(c.data.plan.completed.length,0);c.togglePlanStep(event({step:'报告'}));assert.equal(c.savePlan(),false);assert.match(c.data.planError,/报告日期/);c.editPlanField({...event({step:'first',key:'date'}),detail:{value:'10月23日'}});c.togglePlanStep(event({step:'问题'}));c.editPlanField({...event({step:'next',key:'count'}),detail:{value:'0'}});assert.equal(c.data.planProgress.completed,true);assert.equal(c.savePlan(),true);await c.closeSheet();await c.openService(event({index:0}));assert.equal(c.data.plan.values.next.count,0);assert.equal(c.data.planSteps[0].fields[0].value,'10月23日');
});

test('native read-only record permission blocks editing while individual deletion remains available',async()=>{
 const doctor={slug:'readonly-doctor',name:'医生',builder:{recordFields:[{key:'weight',label:'体重',min:0,max:600,step:1}],components:[],voice:{enabled:false}}};const h=harness('health',{doctor}),c=h.instance;c.changeValue(input('weight','50'));c.saveRecord();const saved=h.runtime.readScope(doctor.slug,'health-records',[])[0];doctor.builder.dataPermissions={records:'read-only'};c.load(false);assert.equal(c.data.canEdit,false);assert.equal(c.data.canDelete,true);c.changeValue(input('weight','60'));c.saveRecord();assert.equal(h.runtime.readScope(doctor.slug,'health-records',[])[0].measurements.weight,50);await c.removeRecord(event({id:saved.id}));assert.equal(h.runtime.readScope(doctor.slug,'health-records',[]).length,0);
});
