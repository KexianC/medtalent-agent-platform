'use strict';
const { getRuntime } = require('../../utils/runtime');
const health = require('../../utils/models/health');
const { builderLayoutClass, getBuilderComponents, componentEnabled, configuredRecordConfig, realHealthReminder, usesTangRecords, usesWellness, doctorExperiences } = require('../../utils/models/catalog');
const { icon, assetUrl, genericExperience, wellnessFeatures, sheetMaxHeight, fitSheet } = require('../../utils/presentation');
const { enterSheet, exitSheet, resetSheet } = require('../../utils/sheet-motion');
const { transitionNotice, resetNotice } = require('../../utils/notice-motion');
const dateKey = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const sectionFields = [
  { id: 'sleep', title: '睡眠变化', description: '记录昨晚实际睡眠情况', icon: 'moon', fields: [
    { key: 'sleepDurationHours', label: '睡眠时长', unit: '小时', placeholder: '例如 6.5', type: 'digit' },
    { key: 'sleepLatencyMinutes', label: '入睡耗时', unit: '分钟', placeholder: '例如 40', type: 'number' },
    { key: 'nightAwakenings', label: '夜醒次数', unit: '次', placeholder: '例如 2', type: 'number' },
  ] },
  { id: 'emotion', title: '情绪感受', description: '按今天的感受选择 0–10 分；未填保持空白', icon: 'heart', fields: [
    { key: 'moodScore', label: '情绪稳定度', unit: '分', placeholder: '0–10', type: 'number' },
    { key: 'anxietyScore', label: '焦虑程度', unit: '分', placeholder: '0–10', type: 'number' },
  ] },
  { id: 'function', title: '日常功能', description: '按今天的精力和生活影响选择 0–10 分', icon: 'brain', fields: [
    { key: 'energyScore', label: '白天精力', unit: '分', placeholder: '0–10', type: 'number' },
    { key: 'daytimeImpactScore', label: '日常受影响', unit: '分', placeholder: '0–10', type: 'number' },
  ] },
];
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: { doctor: { type: Object, value: null }, experience: { type: Object, value: null }, revision: Number, enterMotion: { type: Boolean, value: false }, reduceMotion: { type: Boolean, value: false }, ownerKey: { type: String, value: 'guest' } },
  observers: {
    'doctor,experience,revision,ownerKey': function () { this.refresh(); },
    reduceMotion: function (reduced) { if (reduced) { this.setData({ homeFadeClass: '', concernsFadeClass: '' }); if (this.data.noticeMounted) transitionNotice(this, this.data.noticeOpen); } },
  },
  data: {
    exp: null, isTang: false, isYuwen: false, generic: false, noticeOpen: false, noticeMounted: false, noticeMotion: '', noticeStyle: '', noticeAnimation: {}, noticeAnimationFallback: false, homeFadeClass: '', concernsFadeClass: '', resourcesOpen: false, aboutOpen: false,
    steps: [], concerns: [], tags: [], recordedDays: 0, progress: 0, lastDate: '', reminder: '',
    title: '', subtitle: '', cta: '', heroArt: '', growthHero: '', growthMetric: '', usesGrowth: false,
    sheetOpen: false, sheetMotion: '', backdropMotion: '', saved: false, draft: {}, formError: '', savedMetricCount: 0, sheetScroll: '', sheetHeight: 0, focusField: '', focusedDraftField: '', canEdit: true, storageNotice: '',
    sections: sectionFields.map(section => Object.assign({}, section, { iconUrl: icon(section.icon, 'accent'), fields: section.fields.map(field => Object.assign({}, field, { anchors: health.tangScoreAnchors && health.tangScoreAnchors[field.key] || [] })) })),
    wellnessFeatures: wellnessFeatures.map(feature => Object.assign({}, feature, { iconUrl: icon(feature.icon, 'accent') })),
    wellnessDays: 0, wellnessMood: '—', wellnessHasMood: false, wellnessToday: false,
    icons: { baby: icon('baby', 'white'), bell: icon('bell'), chat: icon('chat', 'accent'), chatWhite: icon('chat', 'white'), chatFillWhite: icon('chat-fill', 'white'), featureChevron: icon('chevron', 'wellness-feature'), chevron: icon('chevron', 'muted'), trendChevron: icon('chevron', 'home-tang-trend'), disclosureChevron: icon('chevron', 'home-tang-disclosure'), chevronWhite: icon('chevron', 'white'), shield: icon('shield', 'muted'), clock: icon('clock', 'muted'), moon: icon('moon', 'accent'), close: icon('close'), check: icon('check', 'accent'), save: icon('save', 'white'), lock: icon('lock', 'me-disclaimer-tang') },
  },
  lifetimes: {
    attached() { this._sheetFitUnavailable = false; this._unsubscribe = getRuntime().data.subscribe(() => this.refresh()); this.refresh(); this.startHomeMotion(); this.scheduleDayRefresh(); },
    detached() { this._sheetFitUnavailable = true; this.resetNotice(); resetSheet(this); if (this._unsubscribe) this._unsubscribe(); clearTimeout(this._dayTimer); },
  },
  pageLifetimes: { show() { this._sheetFitUnavailable = false; this.refresh(); this.scheduleDayRefresh(); fitSheet(this); }, resize() { fitSheet(this); }, hide() { this._sheetFitUnavailable = true; clearTimeout(this._dayTimer); this.resetNotice(); this.setData({ noticeOpen: false, noticeMounted: false, noticeStyle: '', noticeMotion: '', focusField: '', focusedDraftField: '' }); } },
  methods: {
    startHomeMotion() {
      if (this._homeMotionInitialized) return;
      this._homeMotionInitialized = true;
      const fade = this.properties.enterMotion && !this.properties.reduceMotion ? 'home-fade-up' : '';
      this.setData({ homeFadeClass: fade, concernsFadeClass: this.data.isTang ? '' : fade });
    },
    resetNotice() { resetNotice(this); },
    scheduleDayRefresh() {
      clearTimeout(this._dayTimer);
      const now = new Date(); const next = new Date(now); next.setHours(24, 0, 0, 100);
      this._dayTimer = setTimeout(() => { this.refresh(); this.scheduleDayRefresh(); }, Math.max(100, next.getTime() - now.getTime()));
    },
    refresh() {
      const doctor = this.properties.doctor;
      if (!doctor || !doctor.slug) {
        if (this._noticeScope) { this.resetNotice(); this._noticeScope = ''; this.setData({ noticeOpen: false, noticeMounted: false, noticeMotion: '', noticeAnimation: {} }); }
        if (this._doctorScope) { resetSheet(this); this._doctorScope = ''; this.setData({ sheetOpen: false, focusField: '', focusedDraftField: '' }); }
        return;
      }
      const noticeScope = doctor.slug + ':' + (this.properties.ownerKey || 'guest');
      if (this._noticeScope !== noticeScope) {
        this.resetNotice(); this._noticeScope = noticeScope;
        resetSheet(this);
        this._recordScope = '';
        this.setData({ noticeOpen: false, noticeMounted: false, noticeMotion: '', noticeAnimation: {}, sheetOpen: false, draft: {}, saved: false, formError: '', focusField: '', focusedDraftField: '' });
      }
      if (this._doctorScope !== doctor.slug) {
        resetSheet(this); this._doctorScope = doctor.slug;
        this.setData({ sheetOpen: false, focusField: '', focusedDraftField: '' });
      }
      const runtime = getRuntime();
      const exp = this.properties.experience || doctorExperiences[doctor.slug] || genericExperience(doctor);
      const isTang = usesTangRecords(doctor);
      const isYuwen = usesWellness(doctor);
      const tone = doctorExperiences[doctor.slug] ? 'theme-' + doctor.slug : 'accent';
      const config = configuredRecordConfig(doctor, health.getSpecialtyRecordConfig(doctor.slug));
      const recordState = runtime.data.get(doctor.slug, 'health-records', []);
      const records = health.normalizeHealthRecords(recordState.value, doctor.builder ? config : undefined);
      const privacy = runtime.data.get(doctor.slug, 'privacy', { reminders: true }).value;
      const sorted = health.sortHealthRecords(records);
      const recordedDays = health.recentRecordDayCount(records);
      const usesGrowth = doctor.slug === 'fu-junfen' && exp.primaryTitle.includes('生长');
      const todayMeasurements = health.buildSpecialtyStats(records, config, 1).trend[0];
      const specialtyToday = todayMeasurements && todayMeasurements.measurements || {};
      const metrics = isTang && health.buildHealthTrend(records, 1)[0] && health.buildHealthTrend(records, 1)[0].metrics || {};
      const tangComplete = [metrics.sleepDurationMinutes !== undefined || metrics.sleepLatencyMinutes !== undefined || metrics.nightAwakenings !== undefined, metrics.moodScore !== undefined || metrics.anxietyScore !== undefined, metrics.energyScore !== undefined || metrics.daytimeImpactScore !== undefined];
      const steps = isTang ? exp.steps.map((step, i) => Object.assign({}, step, { description: ['记录时长、入睡耗时与夜醒', '记录情绪稳定度与焦虑程度', '记录白天精力与生活影响'][i] || step.description, complete: Boolean(tangComplete[i]), section: ['sleep', 'emotion', 'function'][i] })) : config.fields.slice(0, 3).map(field => ({ icon: 'clipboard', title: field.label, complete: specialtyToday[field.key] !== undefined, description: specialtyToday[field.key] === undefined ? field.hint || '按实际情况填写' + (field.unit ? '，单位：' + field.unit : '') : '今日已填：' + (field.key === 'menstrualStatus' ? specialtyToday[field.key] === 1 ? '正在经期' : '不在经期' : specialtyToday[field.key] + ' ' + field.unit) }));
      const next = {
        exp, layoutClass:builderLayoutClass(doctor), isTang, isYuwen, builderMode:Boolean(doctor.builder), builderBlocks:getBuilderComponents(doctor.builder).filter(item=>item.id!=='home'&&(item.id!=='voice'||doctor.builder&&doctor.builder.voice.enabled)), showRecords: componentEnabled(doctor, 'records'), showContent: componentEnabled(doctor, 'content'), generic: !doctorExperiences[doctor.slug], usesGrowth, doctorInitial: doctor.name.slice(0, 1),
        title: isTang ? exp.primaryTitle : config.title, subtitle: isTang ? '每天一份记录，可随时补充或修改。' : config.description,
        cta: isTang ? exp.cta : '填写今日记录', reminder: privacy && privacy.reminders !== false ? realHealthReminder(recordedDays, records.some(record => health.healthRecordDateKey(record) === dateKey())) : '健康提醒已关闭，可在“我的－隐私与设置”中重新开启。', reminderEnabled: !(privacy && privacy.reminders === false),
        heroArt: icon(exp.heroIcon, tone), growthHero: assetUrl('/subpackages/knowledge/assets/doctors/fu-growth-hero.png'), growthMetric: assetUrl('/subpackages/knowledge/assets/doctors/fu-growth-curve.png'),
        tags: (doctor.topics || []).slice(0, 3), recordedDays, progress: Math.round(recordedDays / 7 * 100),
        lastDate: sorted.length ? health.healthRecordDateKey(sorted[0]) : '',
        steps: steps.map((step, i) => Object.assign({}, step, { number: '0' + (i + 1), iconUrl: icon(step.icon, step.complete ? 'white' : tone) })),
        concerns: exp.concerns.map(concern => Object.assign({}, concern, { iconUrl: icon(concern.icon, tone) })),
        sections: sectionFields.map(section => Object.assign({}, section, { iconUrl: icon(section.icon, tone), fields: section.fields.map(field => Object.assign({}, field, { anchors: health.tangScoreAnchors[field.key] || [] })) })),
        icons: Object.assign({}, this.data.icons, { bell: icon('bell', tone), chat: icon('chat', tone), moon: icon('moon', tone), check: icon('check', tone) }),
        canEdit: recordState.canEdit !== false, storageNotice: runtime.storageNotice(doctor.slug, 'health-records'),
      };
      if (isYuwen) {
        const wellnessState = runtime.data.get(doctor.slug, 'wellness-v1', { records: [] });
        const today = dateKey(); const start = new Date(); start.setDate(start.getDate() - 6);
        const startKey = start.getFullYear() + '-' + String(start.getMonth() + 1).padStart(2, '0') + '-' + String(start.getDate()).padStart(2, '0');
        const recent = (wellnessState.value.records || []).filter(record => record.date >= startKey && record.date <= today);
        const moods = recent.filter(record => typeof (record.values || {}).moodScore === 'number');
        next.wellnessDays = new Set(recent.map(record => record.date)).size;
        next.wellnessMood = moods.length ? (moods.reduce((total, record) => total + record.values.moodScore, 0) / moods.length).toFixed(1) : '—';
        next.wellnessHasMood = Boolean(moods.length); next.wellnessToday = recent.some(record => record.date === today);
        next.storageNotice = runtime.storageNotice(doctor.slug, 'wellness-v1');
        next.wellnessFeatures = wellnessFeatures.map(feature => Object.assign({}, feature, { iconUrl: icon(feature.icon, tone) }));
      }
      this.setData(next);
    },
    toggleNotice() { transitionNotice(this, !this.data.noticeOpen); },
    toggleResources() { this.setData({ resourcesOpen: !this.data.resourcesOpen }); },
    toggleAbout() { this.setData({ aboutOpen: !this.data.aboutOpen }); },
    ask(event) { this.triggerEvent('ask', { question: event && event.currentTarget.dataset.question || '' }); },
    forwardAsk(event) { this.triggerEvent('ask', event.detail); },
    forwardNavigate(event) { this.triggerEvent('navigate', event.detail); },
    manage() { this.triggerEvent('navigate', { tab: 'manage' }); },
    wellness(event) {
      const id = event.currentTarget.dataset.view;
      const feature = wellnessFeatures.find(item => item.id === id);
      this.triggerEvent('navigate', { tab: feature && feature.section || 'manage', view: id });
    },
    openRecord(event) {
      if (!this.data.isTang) { this.manage(); return; }
      this._recordScope = this._noticeScope;
      const record = health.mergeTangDailyRecords(getRuntime().data.get(this.properties.doctor.slug, 'health-records', []).value, dateKey());
      const section = event && event.currentTarget.dataset.section || 'all';
      const selectedSection = sectionFields.find(item => item.id === section);
      enterSheet(this, { sheetOpen: true, saved: false, draft: health.createTangRecordDraft(record), formError: '', sheetScroll: section === 'all' ? '' : 'record-' + section, focusField: selectedSection ? selectedSection.fields[0].key : '', focusedDraftField: '', sheetHeight: sheetMaxHeight() }, () => fitSheet(this));
    },
    closeSheet() { this.setData({ focusField: '', focusedDraftField: '' }); exitSheet(this, () => this.setData({ sheetOpen: false })); },
    preventClose() {},
    editDraft(event) { this.setData({ ['draft.' + event.currentTarget.dataset.key]: event.detail.value, formError: '' }); },
    focusDraft(event) { if (!this.data.sheetOpen || this.data.saved || this._sheetFitUnavailable || this.data.sheetMotion === 'sheet-exit') return; const key = event.currentTarget.dataset.key; if (key && this.data.focusedDraftField !== key) this.setData({ focusedDraftField: key }); },
    blurDraft(event) { const key = event && event.currentTarget.dataset.key; this.setData(Object.assign({ focusField: '' }, !key || this.data.focusedDraftField === key ? { focusedDraftField: '' } : {})); },
    saveRecord() {
      const session = getRuntime().session.get(), owner = session.user && session.user.id || (getRuntime().data.getVisitorId ? 'guest:' + getRuntime().data.getVisitorId() : 'guest');
      if (!this.data.sheetOpen || this._recordScope !== this.properties.doctor.slug + ':' + owner) { this.refresh(); return; }
      const validated = health.validateTangRecordDraft(Object.assign({}, this.data.draft, { dateKey: dateKey() }));
      if (validated.error || !validated.metrics) { this.setData({ formError: validated.error || '记录内容无效，请检查后重试。' }); return; }
      const runtime = getRuntime(); const slug = this.properties.doctor.slug;
      const records = runtime.data.get(slug, 'health-records', []).value;
      const existing = health.mergeTangDailyRecords(records, dateKey()); const now = new Date().toISOString();
      const metrics = Object.fromEntries(Object.entries(validated.metrics).filter(pair => pair[1] !== undefined));
      const record = { schemaVersion: 2, id: existing && existing.id || 'record-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), createdAt: existing && existing.createdAt || now, updatedAt: now, dateKey: dateKey(), completedTitles: [], note: this.data.draft.note.trim(), source: existing && existing.source || 'home', metrics };
      if (!runtime.data.set(slug, 'health-records', health.upsertTangDailyRecord(records, record))) { this.setData({ formError: runtime.storageNotice(slug, 'health-records') || '记录暂时无法保存，请重试。' }); return; }
      this.setData({ saved: true, savedMetricCount: Object.keys(metrics).length, focusField: '', focusedDraftField: '' }, () => fitSheet(this));
      this.refresh(); this.triggerEvent('change', { section: 'health-records' });
    },
    askWithRecord() { this.closeSheet(); this.triggerEvent('ask', { question: '请结合我今天记录的睡眠和状态，告诉我最值得先调整的一点。', withHealthContext: true }); },
  },
});
