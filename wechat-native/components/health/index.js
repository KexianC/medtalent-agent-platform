const { builderLayoutClass, canWriteBuilderData, configuredRecordConfig, usesTangRecords, doctorExperiences } = require('../../utils/models/catalog.js');
const model = require('../../utils/models/health.js');
const { getRuntime } = require('../../utils/runtime.js');
const ui = require('../../utils/health-ui.js');
const { icon } = require('../../utils/presentation.js');
const { enterSheet, exitSheet, resetSheet } = require('../../utils/sheet-motion.js');
const tangFields = [
  { key: 'sleepDurationHours', label: '睡眠时长', unit: '小时', min: 0, max: 24, step: .5, hint: '记录昨晚实际睡眠情况' },
  { key: 'sleepLatencyMinutes', label: '入睡耗时', unit: '分钟', min: 0, max: 720, step: 1 },
  { key: 'nightAwakenings', label: '夜醒次数', unit: '次', min: 0, max: 20, step: 1 },
  { key: 'moodScore', label: '情绪稳定度', unit: '分', min: 0, max: 10, step: 1 },
  { key: 'anxietyScore', label: '焦虑程度', unit: '分', min: 0, max: 10, step: 1 },
  { key: 'energyScore', label: '白天精力', unit: '分', min: 0, max: 10, step: 1 },
  { key: 'daytimeImpactScore', label: '日常受影响', unit: '分', min: 0, max: 10, step: 1 },
].map(field => ({ ...field, hint: model.tangScoreAnchors[field.key] ? model.tangScoreAnchors[field.key].join(' · ') : field.hint || (field.type&&field.type!=='number'?'按当天实际情况填写':`填写范围 ${field.min}–${field.max} ${field.unit}`) }));
const tangTrendFields = [ { key: 'sleepDurationMinutes', label: '睡眠', unit: '小时', max: 720 }, { key: 'moodScore', label: '情绪', unit: '分', max: 10 }, { key: 'anxietyScore', label: '焦虑', unit: '分', max: 10 }, { key: 'energyScore', label: '精力', unit: '分', max: 10 } ];
function emptyDraft() { return { dateKey: ui.today(), values: {}, note: '' }; }
function draftFor(record, tang) {
  if (tang) { const d = model.createTangRecordDraft(record); return { dateKey: d.dateKey, values: Object.fromEntries(tangFields.map(f => [f.key, d[f.key]])), note: d.note }; }
  return record ? { dateKey: model.healthRecordDateKey(record), values: { ...record.values, ...Object.fromEntries(Object.entries(record.measurements || {}).map(([k, v]) => [k, String(v)])) }, note: record.note || '' } : emptyDraft();
}
Component({
  options:{styleIsolation:'apply-shared'},
  properties: { doctor: { type: Object, value: null }, experience: { type: Object, value: null }, reduceMotion: { type: Boolean, value: false }, enterMotion: { type: Boolean, value: false }, observerMargins: { type: Object, value: null } },
  data: { today: ui.today(), tang: false, showFab: false, fabEntryMotion: false, config: { fields: [] }, fields: [], records: [], draft: emptyDraft(), editingId: '', days: 7, selectedIndex: 0, selected: {}, summary: [], statsFields: [], plot: {}, plotImage: '', plotImageReady: false, plotImageToken: 0, historyOpen: false, sheetMotion: '', backdropMotion: '', detailsOpen: false, errors: {}, error: '', notice: '', storageNotice: '', dirty: false, canEdit: true },
  observers: { 'doctor.slug': function () { if (this.runtime) this.load(true); }, 'observerMargins': function () { this.startEditorObserver(); this.startPlotObserver(); } },
  lifetimes: {
    attached() { this._alive = true; this.runtime = getRuntime(); this.load(true); this.unsubscribe = this.runtime.subscribe(() => this.load(false)); this.scheduleDayRefresh(); },
    ready() { this._observerReady = true; this.startEditorObserver(); this.startPlotObserver(); if (this.data.tang) this.triggerEvent('viewport'); },
    detached() { this._alive = false; ui.invalidatePlot(this, 'health-trend'); this.stopPlotObserver(); resetSheet(this); clearTimeout(this.dayTimer); if (this.unsubscribe) this.unsubscribe(); if (this.editorObserver) this.editorObserver.disconnect(); },
  },
  pageLifetimes: { show() { this._pageHidden = false; this.load(false); this.scheduleDayRefresh(); }, hide() { this._pageHidden = true; ui.invalidatePlot(this, 'health-trend'); this.stopPlotObserver(); resetSheet(this); clearTimeout(this.dayTimer); this.setData({ historyOpen: false, sheetMotion: '', backdropMotion: '' }); } },
  methods: {
    actionScope() { return { owner: this.owner, slug: this.data.doctor && this.data.doctor.slug }; },
    isActionScope(scope) {
      const account = this.runtime.session.get(), owner = account.user && account.user.id || (this.runtime.data.getVisitorId ? 'guest:' + this.runtime.data.getVisitorId() : 'guest');
      return this._alive && !this._pageHidden && scope.owner === owner && scope.owner === this.owner && scope.slug === (this.data.doctor && this.data.doctor.slug);
    },
    startEditorObserver() {
      if (!this._observerReady || !this._alive) return;
      if (this.editorObserver) this.editorObserver.disconnect(); this.editorObserver = null; const run = this._editorObserverRun = (this._editorObserverRun || 0) + 1;
      const margins = this.data.observerMargins; if (!this.data.tang || !this.createIntersectionObserver || !margins || !Number.isFinite(margins.top) || !Number.isFinite(margins.bottom)) return;
      // Native observers can skip an initial 0-to-0 report when the editor starts offscreen.
      this.editorObserver = this.createIntersectionObserver({ thresholds: [.02], initialRatio: 1 });
      this.editorObserver.relativeToViewport(margins).observe('#health-editor', result => { if (!this._alive || run !== this._editorObserverRun) return; const showFab = !(result.intersectionRatio > 0), patch = { showFab }; if (showFab && !this.data.showFab) patch.fabEntryMotion = this._fabObserved ? true : Boolean(this.data.enterMotion); this._fabObserved = true; this.setData(patch); });
    },
    stopPlotObserver() {
      this._plotObserverRun = (this._plotObserverRun || 0) + 1;
      if (this.plotObserver) this.plotObserver.disconnect();
      this.plotObserver = null;
    },
    paintCurrentPlot() {
      if (!this._alive || this._pageHidden || this.data.tang || !this.data.plot.hasData) return;
      const theme = this.data.experience && this.data.experience.theme;
      ui.paintPlot(this, 'health-trend', this.data.plot, theme && theme.accent, theme && theme.accentStrong);
    },
    plotImageLoad(event) { ui.plotImageState(this, 'health-trend', event, false); },
    plotImageError(event) { ui.plotImageState(this, 'health-trend', event, true); },
    startPlotObserver() {
      this.stopPlotObserver();
      if (!this._alive || !this._observerReady || this._pageHidden || this.data.tang || !this.data.plot.hasData || !this.createIntersectionObserver) return;
      const run = this._plotObserverRun, owner = this.owner, slug = this.data.doctor.slug;
      this.plotObserver = this.createIntersectionObserver({ thresholds: [.01], initialRatio: 0 });
      // Retry a not-yet-mounted canvas once it enters the scroll viewport.
      this.plotObserver.relativeToViewport(this.data.observerMargins || {}).observe('#health-trend', result => {
        if (!this._alive || this._pageHidden || run !== this._plotObserverRun || owner !== this.owner || slug !== this.data.doctor.slug || !(result.intersectionRatio > 0)) return;
        this.paintCurrentPlot();
      });
    },
    scheduleDayRefresh() { clearTimeout(this.dayTimer); const now = new Date(), next = new Date(now); next.setHours(24,0,0,100); this.dayTimer = setTimeout(() => { this.load(false); this.scheduleDayRefresh(); }, Math.max(100,next.getTime() - now.getTime())); },
    load(reset) {
      const doctor = this.data.doctor; if (!doctor || !doctor.slug) return;
      const account = this.runtime.session.get(), owner = account.user && account.user.id || (this.runtime.data.getVisitorId ? 'guest:' + this.runtime.data.getVisitorId() : 'guest');
      if (this.owner !== undefined && owner !== this.owner) reset = true;
      this.owner = owner;
      const tang = usesTangRecords(doctor), config = tang ? { title: '睡眠与情绪管理', description: '按天记录睡眠、情绪和日常状态；登录微信后可跨设备查看，并可选择让智能体参考摘要。', fields: tangFields } : configuredRecordConfig(doctor, model.getSpecialtyRecordConfig(doctor.slug));
      this.rawRecords = model.normalizeHealthRecords(this.runtime.readScope(doctor.slug, 'health-records', []), doctor.builder ? config : undefined);
      const meta = this.runtime.data.get(doctor.slug, 'health-records', []);
      const artworkSlug = doctorExperiences[doctor.slug] ? doctor.slug : 'tang-jinsong';
      const icons = Object.fromEntries(['edit','save','plus','lock','chart','clipboard','delete','chat','moon','brain','clock','sparkle','chevron','close'].map(name => [name, icon(name, 'theme-' + artworkSlug)])); icons.saveWhite = icon('save', 'white'); icons.plusWhite = icon('plus', 'white'); icons.chevronWhite = icon('chevron', 'white');
      icons.chartHeader = icon('chart', 'accent-' + artworkSlug);
      icons.chartEmpty = tang ? icons.chartHeader : icon('chart-regular', 'accent-' + doctor.slug);
      icons.clockSecondary = icon('clock', 'secondary-tang-jinsong');
      icons.edit = icon('edit', 'me-regular-' + artworkSlug);
      icons.historyDelete = icon('delete', tang ? 'health-tang-danger' : 'health-specialty-danger');
      icons.historyClipboard = icon('clipboard', tang ? 'me-accent-tang-jinsong' : 'health-' + artworkSlug);
      icons.emptyHistoryClipboard = tang ? icons.historyClipboard : icon('clipboard-regular', 'accent-' + doctor.slug);
      icons.historyChat = icon('chat', 'health-tang');
      icons.historyClose = icon('close', 'health-sheet');
      icons.historyShield = icon('shield', 'me-disclaimer-tang');
      const fields = config.fields.map((field,index) => ({ ...field, showGroup:field.group&&(index===0||config.fields[index-1].group!==field.group), choices:['未填写',...(field.options||[])], hint: field.key === 'menstrualStatus' ? '按当天实际情况选择' : field.hint || `填写范围 ${field.min}–${field.max} ${field.unit}` }));
      const minDate = new Date(); minDate.setFullYear(minDate.getFullYear() - 1);
      const patch = { layoutClass:builderLayoutClass(doctor),icons, tang, config, fields, sleepFields: fields.slice(0, 3).map((f, i) => ({ ...f, placeholder: ['例如 6.5', '例如 40', '例如 2'][i] })), scoreFields: fields.slice(3).map(f => ({ ...f, anchors: model.tangScoreAnchors[f.key] || [] })), today: ui.today(), minDate: ui.today(minDate), storageLabel: account.user ? '账户' : '本机', readOnly:!canWriteBuilderData(doctor,'records'),canDelete:meta.canEdit!==false,canEdit: meta.canEdit !== false && canWriteBuilderData(doctor,'records'), storageNotice: ui.scopeNotice(this.runtime, doctor.slug, 'health-records') };
      Object.assign(patch, { storageIsError: ['error','unavailable'].includes(meta.status), storageProblem: account.user ? meta.status !== 'synced' : meta.status !== 'ready', storageCanRetry: tang || !account.user || !['pending','saving','loading','conflict'].includes(meta.status), storageRetryLabel: account.user ? '重试同步' : '重试保存', storageTitle: account.user ? patch.storageNotice : meta.errorCode === 'INVALID_DATA' ? '本机记录暂时无法读取' : '更改仅保留在当前页面，尚未保存到本机', storageDetail: account.user ? '' : meta.errorCode === 'INVALID_DATA' ? '原存储内容未被自动覆盖，请确认后再重试。' : '请检查设备存储空间或浏览器权限。离开或刷新页面可能丢失本次更改。' });
      if (tang) { icons.shield = icon('shield','theme-' + doctor.slug); patch.storageTitle = account.user ? '云端记录尚未同步完成' : meta.status === 'memory-only' ? '当前记录仅临时保存' : '本机记录读取异常'; patch.storageDetail = account.user ? '请检查网络后重试；记录冲突可在“我的”中处理。' : '请检查微信存储权限或设备空间，重新打开页面前不要清理当前会话。'; patch.storageRetryLabel = '重试保存'; }
      if (reset) { ui.invalidatePlot(this, 'health-trend'); resetSheet(this); const existing = tang ? model.mergeTangDailyRecords(this.rawRecords, ui.today()) : null; patch.plot = {}; patch.draft = draftFor(existing, tang); patch.editingId = existing && existing.id || ''; patch.selectedIndex = 0; patch.dirty = false; patch.historyOpen = false; patch.sheetMotion = ''; patch.backdropMotion = ''; }
      else if (!tang && this.data.today !== patch.today && !this.data.dirty && !this.data.editingId && this.data.draft.dateKey === this.data.today) patch.draft = { ...this.data.draft, dateKey: patch.today };
      this.setData(patch, () => this.refresh());
    },
    refresh() {
      const tang = this.data.tang, config = this.data.config, records = this.rawRecords || [], days = this.data.days;
      const stats = tang ? model.calculateHealthStats(records, days) : model.buildSpecialtyStats(records, config, days);
      const trends = tang ? model.buildHealthTrend(records, days) : stats.trend;
      const trendFields = (tang ? tangTrendFields : config.fields.filter(field=>!field.type||field.type==='number')).map(field => ({ ...field, optionLabel: field.label + (field.unit ? `（${field.unit}）` : '') })), selected = trendFields[this.data.selectedIndex] || trendFields[0] || {key:'',label:'数值',unit:''};
      let plot = ui.linePlot(trends, selected.key);
      if (tang && selected.key === 'sleepDurationMinutes') plot = { ...plot, low: (Number(plot.low) / 60).toFixed(1), high: (Number(plot.high) / 60).toFixed(1), plotPoints: plot.plotPoints.map(p => ({ ...p, display: p.filled ? `${(p.value / 60).toFixed(1)}小时` : '未填写' })) };
      if (!tang && selected.key === 'menstrualStatus') plot = { ...plot, low: Number(plot.low) === 1 ? '经期' : '非经期', high: Number(plot.high) === 1 ? '经期' : '非经期', plotPoints: plot.plotPoints.map(p => ({ ...p, display: this.display(selected.key, p.value) })) };
      const recordedDays = tang ? model.recentRecordDayCount(records, days) : stats.recordedDays;
      const summary = tang ? [
        { label: `${days}日记录`, value: `${recordedDays}天`, note: recordedDays >= 3 ? '含首页状态记录，可观察变化' : '首页与管理页记录会同步计入' },
        { label: '平均睡眠', value: stats.averageSleepDurationMinutes === undefined ? '暂无' : `${(stats.averageSleepDurationMinutes / 60).toFixed(1)}h`, note: '仅统计已填写日期' },
        { label: '平均焦虑', value: stats.averageAnxietyScore === undefined ? '暂无' : `${stats.averageAnxietyScore.toFixed(1)}/10`, note: '分数越高表示越明显' },
        { label: '平均精力', value: stats.averageEnergyScore === undefined ? '暂无' : `${stats.averageEnergyScore.toFixed(1)}/10`, note: '分数越高表示越充足' },
      ] : [ { label: '已记录天数', value: `${stats.recordedDays} / ${days} 天`, number: stats.recordedDays, unit: ` / ${days} 天`, note: '同一天的多条记录计为 1 天' }, { label: '记录覆盖率', value: `${stats.completionRate}%`, number: stats.completionRate, unit: '%', note: '含首页记录与补充备注' } ];
      const statsFields = tang ? [] : stats.fields.map(field => ({ ...field, isStatus: field.key === 'menstrualStatus', averageText: field.key === 'menstrualStatus' ? `${stats.trend.filter(p => p.measurements && p.measurements.menstrualStatus === 1).length} 天` : ui.number(field.average), latestText: this.display(field.key, field.latest) }));
      const sorted = tang ? model.sortHealthRecords(records) : [...records].sort((a, b) => model.healthRecordDateKey(b).localeCompare(model.healthRecordDateKey(a)) || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
      const listed = sorted.map(record => ({ ...record, date: model.healthRecordDateKey(record), summary: model.formatHealthMetricsSummary(record, config) || record.completedTitles.join('、') || '自我记录', timeLabel: new Date(record.updatedAt || record.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), sourceText: record.source === 'home' ? '首页状态记录' : tang ? '管理记录' : '健康管理记录', completedText: record.completedTitles.join('、'), legacyEmpty: !tang && !record.note && !record.completedTitles.length && !Object.keys(record.measurements || {}).length && !Object.keys(record.values || {}).length, measurementsList: config.fields.flatMap(field => record.measurements && record.measurements[field.key] !== undefined ? [{ label: field.label, value: this.display(field.key, record.measurements[field.key]), unit: field.unit }] : record.values && record.values[field.key] ? [{label:field.label,value:record.values[field.key],unit:''}] : []) }));
      const sameDay = !this.data.editingId && !tang ? records.find(r => r.source === 'manage' && model.healthRecordDateKey(r) === this.data.draft.dateKey) : null;
      const editing = records.find(r => r.id === this.data.editingId);
      const trendBars = tang ? trends.map((point, index) => { const value = point.metrics && point.metrics[selected.key]; return { date: point.dateKey, filled: value !== undefined, label: days === 7 || index % 5 === 0 || index === trends.length - 1 ? point.label : '', display: value === undefined ? '—' : selected.key === 'sleepDurationMinutes' ? `${(value / 60).toFixed(1)}小时` : `${value}/10`, percent: value === undefined ? 0 : Math.max(8, Math.min(100, value / selected.max * 100)) }; }) : [];
      if (tang || !plot.hasData || JSON.stringify(plot) !== JSON.stringify(this.data.plot)) ui.invalidatePlot(this, 'health-trend');
      this.setData({ summary, statsFields, selected, trendFields, trendBars, structuredCount: sorted.filter(r => r.metrics && Object.values(r.metrics).some(v => v !== undefined)).length, canShare: model.buildHealthContextPayload(records, new Date(), config).records.length > 0, plot, records: listed, sameDayId: sameDay && sameDay.id || '', completedText: editing && editing.completedTitles.join('、') || '', editorHelp: editing ? `正在编辑${editing.source === 'home' ? '首页状态记录' : '健康管理记录'}，留空可移除该条记录中的数值。` : '按实际情况选填；至少填写一项数值或备注。' }, () => { this.paintCurrentPlot(); this.startPlotObserver(); });
    },
    display(key, value) { return key === 'menstrualStatus' && value !== undefined ? value === 1 ? '正在经期' : '不在经期' : ui.number(value); },
    async retryStorage() { if (this.data.storageRetrying) return; this.setData({ storageRetrying: true }); try { await this.runtime.data.retry(this.data.doctor.slug, 'health-records'); } finally { this.setData({ storageRetrying: false }); this.load(false); } },
    changeRange(event) { this.setData({ days: Number(event.currentTarget.dataset.days) }, () => this.refresh()); },
    changeMetric(event) { this.setData({ selectedIndex: Number(event.detail.value) }, () => this.refresh()); },
    selectTangMetric(event) { this.changeMetric({ detail: { value: event.currentTarget.dataset.index } }); },
    changeValue(event) { const key = event.currentTarget.dataset.key; this.setData({ [`draft.values.${key}`]: event.detail.value, dirty: true, errors: {}, error: '', notice: '' }); },
    changeSelect(event) { const key=event.currentTarget.dataset.key,field=this.data.config.fields.find(field=>field.key===key);this.changeValue({currentTarget:{dataset:{key}},detail:{value:Number(event.detail.value)===0?'':field.options[Number(event.detail.value)-1]}}); },
    changeStatus(event) { this.setData({ 'draft.values.menstrualStatus': ['', '0', '1'][Number(event.detail.value)], dirty: true, errors: {}, error: '', notice: '' }); },
    changeNote(event) { this.setData({ 'draft.note': event.detail.value, dirty: true, errors: {}, error: '', notice: '' }); },
    async changeDate(event) {
      const scope = this.actionScope();
      const date = event.detail.value;
      if (!this.data.tang && this.data.editingId) { this.setData({ 'draft.dateKey': date, dirty: true, errors: {}, error: '', notice: '' }); return; }
      if (this.data.dirty && !await ui.confirm('切换日期将替换当前尚未保存的填写内容，确定继续吗？')) return;
      if (!this.isActionScope(scope)) return;
      const found = this.data.tang ? model.mergeTangDailyRecords(this.rawRecords, date) : this.rawRecords.find(r => r.source === 'manage' && model.healthRecordDateKey(r) === date);
      this.setData({ draft: found ? draftFor(found, this.data.tang) : { ...emptyDraft(), dateKey: date }, editingId: found && found.id || '', dirty: false, errors: {}, error: '', notice: '' }, () => this.refresh());
    },
    newRecordDraft(records = this.rawRecords) { const draft = emptyDraft(); if (this.data.tang) { const dates = new Set(records.map(model.healthRecordDateKey)); for (let offset = 0; offset < 370; offset++) { const date = new Date(); date.setHours(12,0,0,0); date.setDate(date.getDate() - offset); if (!dates.has(ui.today(date))) { draft.dateKey = ui.today(date); break; } } } return draft; },
    async startNew() {
      const scope = this.actionScope();
      if (this.data.dirty && !await ui.confirm('当前填写内容尚未保存，确定开始新的填报吗？')) return;
      if (!this.isActionScope(scope)) return;
      const draft = this.newRecordDraft();
      this.closeHistory(); this.setData({ draft, editingId: '', dirty: false, errors: {}, error: '', notice: '' }, () => this.refresh()); this.focusEditor();
    },
    async editRecord(event) {
      const scope = this.actionScope();
      const id = event.currentTarget.dataset.id || this.data.sameDayId;
      if (this.data.dirty && !await ui.confirm('当前填写内容尚未保存，确定切换到这条记录吗？')) return;
      if (!this.isActionScope(scope)) return;
      let record = this.rawRecords.find(r => r.id === id); if (!record) return;
      if (this.data.tang) record = model.mergeTangDailyRecords(this.rawRecords, model.healthRecordDateKey(record));
      this.closeHistory(); this.setData({ draft: draftFor(record, this.data.tang), editingId: record.id, dirty: false, error: '', errors: {}, notice: '' }, () => this.refresh()); this.focusEditor();
    },
    focusEditor() {
      const query = this.createSelectorQuery(), target = query.select('#health-editor');
      if (!target.boundingClientRect) { this.triggerEvent('focus', { anchor: 'health-editor' }); return; }
      target.boundingClientRect(rect => this.triggerEvent('focus', { anchor: 'health-editor', top: rect && rect.top })).exec();
    },
    saveRecord() {
      if (!this.data.canEdit) return;
      const records = this.rawRecords, draft = this.data.draft, editing = records.find(r => r.id === this.data.editingId), now = new Date().toISOString();
      let incoming, result;
      if (this.data.tang) {
        const validated = model.validateTangRecordDraft({ ...Object.fromEntries(tangFields.map(f => [f.key, ''])), ...draft.values, dateKey: draft.dateKey, note: draft.note });
        if (validated.error) { this.setData({ error: validated.error }); return; }
        if (editing && model.healthRecordDateKey(editing) !== draft.dateKey && records.some(r => r.id !== editing.id && model.healthRecordDateKey(r) === draft.dateKey)) { this.setData({ error: `${draft.dateKey} 已有一条记录，请从历史记录中编辑该记录，或改选其他日期。` }); return; }
        const existing = editing || model.mergeTangDailyRecords(records, draft.dateKey);
        incoming = { schemaVersion: 2, id: existing && existing.id || ui.id('record'), createdAt: existing && existing.createdAt || now, updatedAt: now, dateKey: draft.dateKey, completedTitles: [], source: 'manage', metrics: validated.metrics, note: draft.note.trim() };
        result = { records: model.upsertTangDailyRecord(records, incoming) };
      } else {
        const validated = model.validateSpecialtyRecordInput(draft.values, this.data.config, draft.dateKey), errors = { ...validated.errors };
        if (draft.note.trim() || editing && editing.completedTitles.length) delete errors._form;
        if (draft.note.length > 300) errors.note = '备注最多填写 300 字。';
        if (this.data.editingId && !editing) errors._form = '这条记录已发生变化，请重新选择历史记录后编辑。';
        if (editing && model.healthRecordDateKey(editing) !== draft.dateKey && records.some(r => r.id !== editing.id && model.healthRecordDateKey(r) === draft.dateKey)) errors._date = '该日期已有记录，请直接编辑该日记录，或选择其他日期。';
        if (Object.keys(errors).length) { this.setData({ errors, error: errors._form || errors._date || errors.note || '请检查上方标出的日期或数值。' }); return; }
        incoming = { schemaVersion: 2, id: editing && editing.id || ui.id('specialty'), createdAt: editing && editing.createdAt || now, updatedAt: now, dateKey: draft.dateKey, source: editing && editing.source || 'manage', completedTitles: editing && editing.completedTitles || [], measurements: validated.measurements, values:validated.values, note: draft.note.trim() };
        result = model.saveSpecialtyRecord(records, incoming, this.data.editingId || undefined, new Date(), this.data.doctor.builder ? this.data.config : undefined);
      }
      if (result.error) { this.setData({ error: result.error }); return; }
      if (!this.runtime.writeScope(this.data.doctor.slug, 'health-records', result.records)) { this.setData({ error: this.runtime.storageNotice(this.data.doctor.slug, 'health-records') || '保存失败，请重试。' }); return; }
      this.rawRecords = result.records;
      const saved = result.records.find(r => r.id === incoming.id) || result.records.find(r => model.healthRecordDateKey(r) === draft.dateKey && r.source === incoming.source);
      this.setData({ editingId: saved && saved.id || incoming.id, draft: saved ? draftFor(saved, this.data.tang) : draft, dirty: false, errors: {}, error: '', notice: this.data.tang ? `已于 ${ui.dateTime(now).split(' ')[1]} 保存到${this.runtime.session.get().user ? '账户' : '本机'}` : this.data.sameDayId ? '当日记录已合并更新。' : '记录已更新。' }, () => this.refresh());
    },
    async removeRecord(event) {
      const scope = this.actionScope(); if (!this.data.canDelete) return;
      const id = event.currentTarget.dataset.id, record = this.rawRecords.find(r => r.id === id); if (!record) return;
      if (!await ui.confirm(`确定删除 ${model.healthRecordDateKey(record)} 的这条记录吗？此操作无法恢复。`)) return;
      if (!this.isActionScope(scope) || !this.data.canDelete) return;
      const next = this.rawRecords.filter(r => r.id !== id); if (!this.runtime.writeScope(this.data.doctor.slug, 'health-records', next)) return;
      this.rawRecords = next; if (this.data.editingId === id) this.setData({ editingId: '', draft: this.newRecordDraft(next), dirty: false }); this.setData({ notice: '记录已从当前列表删除。' }, () => this.refresh());
    },
    async clearRecords() { const scope = this.actionScope(); if (!this.data.canDelete || !await ui.confirm(`确定清空${this.data.doctor.name}智能体中保存的全部 ${this.rawRecords.length} 条记录吗？此操作无法恢复。`)) return; if (!this.isActionScope(scope) || !this.data.canDelete) return; if (this.runtime.writeScope(scope.slug, 'health-records', [])) { this.rawRecords = []; this.setData({ editingId: '', draft: emptyDraft(), dirty: false, notice: '当前智能体的记录列表已清空。' }, () => this.refresh()); } },
    toggleHistory() { this.setData({ historyOpen: !this.data.historyOpen }); },
    openHistory() { if (this.data.tang) enterSheet(this, { historyOpen: true }); else this.setData({ historyOpen: true }); },
    closeHistory() { if (!this.data.historyOpen) return; if (!this.data.tang) { this.setData({ historyOpen: false }); return; } const owner = this.owner; exitSheet(this, () => { if (this._alive && owner === this.owner) this.setData({ historyOpen: false, sheetMotion: '', backdropMotion: '' }); }); },
    noop() {},
    toggleDetails() { this.setData({ detailsOpen: !this.data.detailsOpen }); },
    ask() { this.closeHistory(); this.triggerEvent('ask', { question: '请结合我最近记录的睡眠、情绪、焦虑和白天状态，帮我看看最值得先调整的一点。', withHealthContext: true }); },
  },
});
