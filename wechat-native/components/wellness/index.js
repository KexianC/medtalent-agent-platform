const model = require('../../utils/models/wellness.js');
const { getRuntime } = require('../../utils/runtime.js');
const ui = require('../../utils/health-ui.js');
const { icon, wellnessFeatures } = require('../../utils/presentation.js');
const { openReferenceDocument } = require('../../utils/reference-document.js');
const features = wellnessFeatures.map(feature => ({ ...feature, iconUrl: icon(feature.icon, 'theme-yu-wen') }));
const icons = Object.fromEntries(['back','arrowRight','headphones','wind','play','pause','stop','plus','edit','delete','check','rotate','clipboard','sparkle'].map(name => [name, icon(name, 'theme-yu-wen')]));
icons.goalEdit = '/assets/icons/goalEdit-theme-yu-wen.png'; icons.checkFill = '/assets/icons/check-fill-theme-yu-wen.png';
icons.featureArrow = '/assets/icons/chevron-wellness-feature.png';
icons.goalEmpty = '/assets/icons/check-wellness-empty.png';
icons.courseHeadphones = '/assets/icons/headphones-wellness-ink.png';
icons.coursePlay = '/assets/icons/play-wellness-ink.png';
icons.playerHeadphones = icons.headphones;
for (const name of ['play','pause','plus','check','rotate','arrowRight','sparkle']) icons[name + 'White'] = icon(name,'white');
const writingFields = [ { key: 'trigger', label: '发生了什么', placeholder: '哪些事情影响了今天的心情？可以从一个小片段写起。' }, { key: 'coping', label: '我怎样照顾自己', placeholder: '做了什么让自己舒服一点？例如散步、与朋友聊聊。' }, { key: 'note', label: '想留给自己的话', placeholder: '也可以记下身体感受、睡眠变化或明天想尝试的小事。' } ];
const courses = model.meditationCourses.map(course => ({ ...course, durationText: model.formatPracticeTime(course.seconds) }));
const newestFirst = (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt);
function displayRecord(record) {
  if (!record) return null;
  const fields = model.WELLNESS_METRICS.flatMap(metric => record.values[metric.key] === undefined ? [] : [{ label: metric.label, value: model.formatWellnessNumber(record.values[metric.key]), unit: metric.unit }]);
  return { ...record, fields, summary: fields.slice(0, 3).map(v => `${v.label} ${v.value}${v.unit}`).join(' · ') || '文字日记', writing: writingFields.flatMap(f => record[f.key] ? [{ label: f.label, value: record[f.key] }] : []) };
}
Component({
  properties: { doctor: { type: Object, value: null }, view: { type: String, value: '' }, section: { type: String, value: 'manage' } },
  data: {
    icons, accentColor: '#7D72AD', accentStrong: '#5C528B', activeView: '', activeFeature: null, visibleFeatures: features, state: null, today: ui.today(), storageNotice: '', canEdit: true, homeStats: {}, records: [], historyLimit: 20, selectedDate: '', selectedRecord: null,
    date: ui.today(), draft: { values: {}, note: '', trigger: '', coping: '' }, metrics: [], writingFields, dirty: false, error: '', notice: '', existing: false, recordMode: '', inlineRecordMode: '', deleteConfirm: false,
    days: 7, metricIndex: 4, metricsAll: model.WELLNESS_METRICS, chart: [], statistics: [], reportCount: 0, reportDate: ui.today(), reportRecord: null, associationIndex: 0, associationOptions: [ { key: 'sleepHours', label: '睡眠时长' }, { key: 'exerciseMin', label: '运动时长' }, { key: 'steps', label: '步数' }, { key: 'stressScore', label: '压力' } ], associationText: '',
    goalKinds: Object.entries(model.goalKinds).map(([key, value]) => ({ key, ...value })), goals: [], checkHistory: [], goalCompleted: 0, goalEditor: false, goalEditing: '', goalKindIndex: 0, goalTitle: '', goalTarget: '1',
    consent: false, scales: model.WELLNESS_SCALES, questionnaire: null, selectedAssessment: '', assessmentResult: null, assessmentHistory: [], assessmentFilter: 0, assessmentFilters: [ '全部量表', 'GAD7', 'PHQ2' ], allAssessmentHistory: false, answerDetails: false, assessmentSourceOpen: false,
    personalityResult: null, personalityHistory: [], personalityTypes: Object.entries(model.PERSONALITY_DESCRIPTIONS).map(([type, item]) => ({ type, ...item, expanded: false })), allPersonalityHistory: false, showTypes: false,
    currentCardId: '', currentCard: null, cardHistory: [], allCardHistory: false, historyDeleteIds: {},
    breathHoldIndex: 0, breathDurationIndex: 0, breathHoldOptions: ['吸气 4 秒 · 呼气 6 秒', '吸气 4 秒 · 停顿 4 秒 · 呼气 6 秒'], breathDurationOptions: ['1 分钟', '3 分钟', '5 分钟'], breathRunning: false, breathInProgress: false, breathPhase: '准备好了吗', breathCountdown: '00:00', breathElapsed: '00:00', breathTotal: '01:00', breathScale: .8,
    courses, courseCategories: ['全部', ...new Set(model.meditationCourses.map(c => c.category))], courseFilter: '全部', visibleCourses: courses, course: model.meditationCourses[0], playing: false, position: 0, positionText: '00:00', courseTotal: model.formatPracticeTime(model.meditationCourses[0].seconds), audioCanFinish: false, transcriptOpen: false, practiceHistory: [], practiceSavePending: 0,
  },
  observers: {
    view(view) { if (this.runtime && view !== this.data.activeView) this.openView(view || '', false); },
    section() { if (this.runtime) this.refresh(); },
    'doctor.slug'() { if (this.runtime) this.load(); },
  },
  lifetimes: {
    attached() { this._referenceAlive = true; this.runtime = getRuntime(); this.load(); this.openView(this.data.view || '', false); this.unsubscribe = this.runtime.subscribe(() => this.load()); this.scheduleDayRefresh(); },
    detached() { this._referenceAlive = false; if (this._referenceHandle) this._referenceHandle.cancel(); clearTimeout(this.dayTimer); this.stopBreathing(false); this.disposeAudio(); if (this.unsubscribe) this.unsubscribe(); },
  },
  pageLifetimes: { hide() { this._pageHidden = true; clearTimeout(this.dayTimer); this.pauseBreathing(); if (this.audio) this.audio.pause(); }, show() { this._pageHidden = false; if (this.runtime) { this.load(); this.scheduleDayRefresh(); } } },
  methods: {
    slug() { return this.data.doctor && this.data.doctor.slug || 'yu-wen'; },
    actionScope() { return { owner: this.owner, slug: this.slug() }; },
    isActionScope(scope) {
      const account = this.runtime.session.get(), owner = account.user && account.user.id || (this.runtime.data.getVisitorId ? 'guest:' + this.runtime.data.getVisitorId() : 'guest');
      return this._referenceAlive && !this._pageHidden && scope.owner === owner && scope.owner === this.owner && scope.slug === this.slug();
    },
    scheduleDayRefresh() { clearTimeout(this.dayTimer); const now = new Date(), next = new Date(now); next.setHours(24,0,0,100); this.dayTimer = setTimeout(() => { this.load(); this.scheduleDayRefresh(); }, Math.max(100,next.getTime() - now.getTime())); },
    load() {
      const account = this.runtime.session.get(), owner = account.user && account.user.id || (this.runtime.data.getVisitorId ? 'guest:' + this.runtime.data.getVisitorId() : 'guest'), ownerChanged = this.owner !== undefined && (owner !== this.owner || this._loadedSlug !== this.slug());
      this.owner = owner; this._loadedSlug = this.slug();
      if (ownerChanged) {
        this.pendingPractice = [];
        clearInterval(this.breathTimer); this.breathRun = null;
        if (this.audio) { this.audio.destroy(); this.audio = null; this.audioRun = null; }
        this.setData({ questionnaire: null, selectedAssessment: '', assessmentResult: null, selectedPersonality: '', personalityResult: null, currentCardId: '', currentCard: null, goalEditor: false, inlineRecordMode: '', recordMode: '', selectedDate: '', deleteConfirm: false, draft: model.createWellnessDraft(), error: '', notice: '', dirty: false, breathRunning: false, breathInProgress: false, playing: false, audioCanFinish: false, practiceSavePending: 0 });
      }
      const state = model.normalizeState(this.runtime.readScope(this.slug(), 'wellness-v1', model.emptyWellnessState())); this.state = state;
      const meta = this.runtime.data.get(this.slug(), 'wellness-v1', model.emptyWellnessState());
      this.setData({ state, today: ui.today(), accountUser: Boolean(account.user), canEdit: meta.canEdit !== false, storageCanRetry: !account.user || !['pending','saving','loading','conflict'].includes(meta.status), storageRetryLabel: account.user ? '重试同步' : '重试保存', storageNotice: (account.user && meta.status !== 'synced') || (!account.user && meta.status !== 'ready') ? account.user ? meta.status === 'conflict' || ['pending','saving','loading'].includes(meta.status) ? ui.scopeNotice(this.runtime, this.slug(), 'wellness-v1') : '记录尚未同步到微信账户，请联网后重试；同步完成前可在当前设备继续查看。' : meta.errorCode === 'INVALID_DATA' ? '本机记录暂时无法读取。原存储内容未被自动覆盖，请确认后再重试。' : '当前浏览器暂时无法保存，新增内容仅保留在本次页面中。' : '' }, () => this.refresh());
      if (ownerChanged && ['diary', 'health'].includes(this.data.activeView)) this.loadDraft(ui.today());
    },
    update(updater) {
      const current = model.normalizeState(this.runtime.readScope(this.slug(), 'wellness-v1', model.emptyWellnessState())), next = model.normalizeState(updater(current));
      if (!this.runtime.writeScope(this.slug(), 'wellness-v1', next)) { this.setData({ error: this.runtime.storageNotice(this.slug(), 'wellness-v1') || '保存失败，请重试。' }); return false; }
      this.state = next; this.setData({ state: next }, () => this.refresh()); return true;
    },
    refresh() {
      if (!this.state) return;
      const state = this.state, today = ui.today(), points = model.wellnessTrend(state.records, 7, today), moods = points.flatMap(p => typeof (p.record && p.record.values.moodScore) === 'number' ? [p.record.values.moodScore] : []);
      const records = model.normalizeWellnessRecords(state.records).map(displayRecord);
      const goals = state.goals.map(goal => { const progress = model.goalProgress(goal, state, today), done = state.checks.some(c => c.date === today && c.goalId === goal.id && c.done); return { ...goal, progress, percent: Math.min(progress / goal.target, 1) * 100, done }; });
      const checkHistory = state.checks.filter(c => c.done).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30).map(c => ({ ...c, key: `${c.date}:${c.goalId}`, title: state.goals.find(g => g.id === c.goalId).title }));
      const assessmentHistory = state.assessments.slice().sort(newestFirst).map(a => ({ ...a, displayDate: ui.dateTime(a.createdAt) }));
      const personalityHistory = state.personalities.slice().sort(newestFirst).map(p => ({ ...p, displayDate: ui.dateTime(p.createdAt), title: model.PERSONALITY_DESCRIPTIONS[p.type].title }));
      const cardHistory = state.cardDraws.slice().sort(newestFirst).map(d => ({ ...d, displayDate: ui.dateTime(d.createdAt), card: model.WELLNESS_CARDS.find(c => c.id === d.cardId) }));
      const section = this.data.section, active = this.data.activeView, filteredAssessments = assessmentHistory.filter(a => this.data.assessmentFilter === 0 || a.scaleId === ['all', 'gad7', 'phq2'][this.data.assessmentFilter]);
      const patch = {
        visibleFeatures: features.filter(f => section === 'home' || f.section === section), records: records.slice(0, this.data.historyLimit), recordCount: records.length, selectedRecord: records.find(r => r.date === this.data.selectedDate) || null,
        homeStats: { count: points.filter(p => p.record).length, average: moods.length ? (moods.reduce((s, v) => s + v, 0) / moods.length).toFixed(1) : '—', hasMood: moods.length > 0, hasToday: state.records.some(r => r.date === today) },
        goals, checkHistory, goalCompleted: goals.filter(g => g.done).length,
        assessmentHistory: filteredAssessments.slice(0, this.data.allAssessmentHistory ? undefined : 8), filteredAssessmentCount: filteredAssessments.length, assessmentCount: assessmentHistory.length,
        personalityHistory: personalityHistory.slice(0, this.data.allPersonalityHistory ? undefined : 8), personalityCount: personalityHistory.length,
        cardHistory: cardHistory.slice(0, this.data.allCardHistory ? undefined : 8), cardCount: cardHistory.length,
        practiceHistoryCount: state.sessions.filter(s => s.kind === (active === 'breathing' ? 'breathing' : 'meditation')).length,
        practiceHistory: state.sessions.filter(s => s.kind === (active === 'breathing' ? 'breathing' : 'meditation')).slice().reverse().slice(0, 20).map(s => ({ ...s, displayDate: new Date(s.completedAt).toLocaleString('zh-CN'), displayTime: model.formatPracticeTime(s.seconds) })),
      };
      if (this.data.selectedAssessment) patch.assessmentResult = this.assessmentView(state.assessments.find(a => a.id === this.data.selectedAssessment));
      const personality = state.personalities.find(p => p.id === this.data.selectedPersonality) || (!this.data.selectedPersonality && personalityHistory[0]); patch.personalityResult = personality ? this.personalityView(personality) : null;
      const currentDraw = state.cardDraws.find(d => d.id === this.data.currentCardId); patch.currentCard = currentDraw ? model.WELLNESS_CARDS.find(c => c.id === currentDraw.cardId) : null;
      this.setData(patch); if (active === 'report') this.refreshReport();
    },
    async open(event) { await this.openView(event.currentTarget.dataset.view, true); },
    async openView(view, emit) {
      if (view !== this.data.activeView) { this.stopBreathing(false); this.disposeAudio(); this.breathRun = null; }
      this.setData({ selectedAssessment: '', assessmentResult: null, selectedPersonality: '', personalityResult: null, currentCardId: '', currentCard: null, goalEditor: false, allAssessmentHistory: false, allPersonalityHistory: false, allCardHistory: false, showTypes: false, answerDetails: false, assessmentSourceOpen: false, assessmentFilter: 0, days: 7, metricIndex: 4, reportDate: ui.today(), associationIndex: 0, goalEditing: '', goalKindIndex: 0, goalTitle: model.goalKinds.diary.title, goalTarget: '1', personalityTypes: this.data.personalityTypes.map(item => ({ ...item, expanded: false })), inlineRecordMode: '', recordMode: '', deleteConfirm: false, historyLimit: 20, breathHoldIndex: 0, breathDurationIndex: 0, breathRunning: false, breathInProgress: false, breathElapsed: '00:00', breathCountdown: '00:00', breathTotal: '01:00', breathPhase: '准备好了吗', breathScale: .8, courseFilter: '全部', visibleCourses: courses, course: courses[0], courseTotal: courses[0].durationText, historyDeleteIds: {}, activeView: view, activeFeature: features.find(f => f.id === view) || null, questionnaire: null, error: '', notice: '', dirty: false, date: ui.today(), selectedDate: '', draft: model.createWellnessDraft(), consent: false, transcriptOpen: false });
      if (view === 'diary' || view === 'health') this.loadDraft(ui.today(), view);
      if (view === 'meditation') this.setupAudio(this.data.course);
      this.refresh();
      if (emit) this.triggerEvent('view', { view });
    },
    back() { this.openView('', true); this.triggerEvent('close'); },
    async retryStorage() { if (this.data.storageRetrying) return; this.setData({ storageRetrying: true }); try { await this.runtime.data.retry(this.slug(), 'wellness-v1'); } finally { this.setData({ storageRetrying: false }); this.load(); } },
    loadDraft(date, mode) {
      mode = mode || this.data.inlineRecordMode || this.data.activeView;
      const record = this.state.records.find(r => r.date === date);
      this.setData({ date, recordMode: mode, draft: model.createWellnessDraft(record), metrics: model.metricsForMode(mode), existing: Boolean(record), deleteConfirm: false, error: '', notice: '', dirty: false });
    },
    changeDate(event) { this.loadDraft(event.detail.value); },
    todayDraft() { this.loadDraft(ui.today()); },
    metricInput(event) { this.setData({ [`draft.values.${event.currentTarget.dataset.key}`]: event.detail.value, dirty: true, error: '', notice: '' }); },
    writingInput(event) { this.setData({ [`draft.${event.currentTarget.dataset.key}`]: event.detail.value, dirty: true, error: '', notice: '' }); },
    saveRecord() {
      const result = model.validateWellnessDraft(this.data.recordMode || this.data.activeView, this.data.date, this.data.draft);
      if (result.error) { this.setData({ error: result.error }); return; }
      if (!Object.keys(result.patch.values).length && !result.patch.note && !result.patch.trigger && !result.patch.coping && !this.data.existing) { this.setData({ error: '先填写一项内容，就可以保存今天的记录。' }); return; }
      if (this.update(s => ({ ...s, records: model.mergeWellnessRecord(s.records, this.data.recordMode || this.data.activeView, this.data.date, result.patch) }))) { this.setData({ notice: this.recordSavedNotice(), dirty: false, error: '', existing: this.state.records.some(r => r.date === this.data.date) }); }
    },
    deleteDay() { this.setData({ deleteConfirm: true }); },
    cancelDeleteDay() { this.setData({ deleteConfirm: false }); },
    confirmDeleteDay() { const date = this.data.date; if (this.update(s => ({ ...s, records: s.records.filter(r => r.date !== date) }))) this.loadDraft(date); },
    selectHistory(event) { const date = event.currentTarget.dataset.date; this.setData({ selectedDate: this.data.selectedDate === date ? '' : date, inlineRecordMode: '', deleteConfirm: false }, () => this.refresh()); },
    editHistory(event) { const date = this.data.selectedDate, mode = event.currentTarget.dataset.mode; this.setData({ inlineRecordMode: mode }); this.loadDraft(date, mode); },
    closeHistoryEditor() { this.setData({ inlineRecordMode: '', dirty: false, error: '', notice: '', deleteConfirm: false }); },
    recordSavedNotice() { const meta = this.runtime.data.get(this.slug(), 'wellness-v1', null); if (!this.runtime.session.get().user) return meta.status === 'ready' ? '这一天的记录已更新到本机。' : '记录已更新到当前页面，暂时无法保存到本机。'; return meta.status === 'synced' ? '这一天的记录已同步到微信账户。' : meta.status === 'conflict' ? '记录与云端版本有冲突，请到“我的”选择保留版本。' : ['pending','saving','loading'].includes(meta.status) ? '记录已更新，正在同步到微信账户。' : '记录已更新，尚未同步到微信账户，请到“我的”重试同步。'; },
    moreRecords() { this.setData({ historyLimit: this.data.historyLimit + 20 }, () => this.refresh()); },
    changeRange(event) { this.setData({ days: Number(event.currentTarget.dataset.days) }, () => this.refreshReport()); },
    reportMetric(event) { this.setData({ metricIndex: Number(event.detail.value) }, () => this.refreshReport()); },
    selectReportDate(event) { this.setData({ reportDate: event.currentTarget.dataset.date }, () => this.refreshReport()); },
    changeAssociation(event) { this.setData({ associationIndex: Number(event.detail.value) }, () => this.refreshReport()); },
    refreshReport() {
      const points = model.wellnessTrend(this.state.records, this.data.days), statistics = model.wellnessStatistics(points), metric = model.WELLNESS_METRICS[this.data.metricIndex] || model.WELLNESS_METRICS[4], max = Math.max(1, ...points.map(p => p.record && p.record.values[metric.key] || 0));
      const selected = points.find(p => p.date === this.data.reportDate) || points[points.length - 1], association = model.wellnessAssociation(points, this.data.associationOptions[this.data.associationIndex].key, 'moodScore');
      let associationText = association.coefficient === undefined ? association.count < 5 ? `这段时间有 ${association.count} 天同时记录了这两项，至少需要 5 天才能计算。` : '两项记录中有一项没有变化，目前无法计算相关程度。' : `同一天两项都有填写的记录共 ${association.count} 天，相关系数为 ${association.coefficient.toFixed(2)}。${Math.abs(association.coefficient) < .2 ? '当前记录没有呈现明显的线性关联。' : association.coefficient > 0 ? '这组记录中，两项数值较常一起升降。' : '这组记录中，两项数值较常向相反方向变化。'}`;
      this.setData({ reportCount: points.filter(p => p.record).length, reportStart: points[0].date, reportMetric: metric, reportMetricCount: statistics.find(s => s.key === metric.key).count, reportRecord: displayRecord(selected.record), reportDate: selected.date, statistics: statistics.filter(s => s.count).map(s => ({ ...s, averageText: model.formatWellnessNumber(s.average) })), chart: points.map(p => { const value = p.record && p.record.values[metric.key]; return { date: p.date, label: p.date.slice(5).replace('-', '/'), valueText: model.formatWellnessNumber(value), filled: value !== undefined, percent: value === undefined ? 0 : value / max * 100 }; }), associationText });
    },
    reportStat(event) { this.setData({ metricIndex: model.WELLNESS_METRICS.findIndex(m => m.key === event.currentTarget.dataset.key) }, () => this.refreshReport()); },
    startGoal(event) { const goal = this.state.goals.find(g => g.id === event.currentTarget.dataset.id), kind = goal && goal.kind || 'diary', index = this.data.goalKinds.findIndex(g => g.key === kind); this.setData({ goalEditor: true, goalEditing: goal && goal.id || '', goalKindIndex: index, goalTitle: goal && goal.title || model.goalKinds.diary.title, goalTarget: String(goal && goal.target || 1), error: '' }); },
    changeGoalKind(event) { const index = Number(event.detail.value), kind = this.data.goalKinds[index]; this.setData({ goalKindIndex: index, goalTitle: kind.title, goalTarget: String(kind.target), error: '' }); },
    goalInput(event) { this.setData({ [event.currentTarget.dataset.key]: event.detail.value, error: '' }); },
    cancelGoal() { this.setData({ goalEditor: false, error: '' }); },
    saveGoal() {
      const kind = this.data.goalKinds[this.data.goalKindIndex], target = Number(this.data.goalTarget), title = this.data.goalTitle.trim();
      if (!title || !this.data.goalTarget.trim() || !Number.isFinite(target) || target <= 0 || target > kind.max || kind.key !== 'sleep' && !Number.isInteger(target)) { this.setData({ error: `请填写目标名称和有效数量（大于 0，不超过 ${kind.max}${kind.unit}）。` }); return; }
      const existing = this.state.goals.find(g => g.id === this.data.goalEditing), goal = { id: existing && existing.id || ui.id('goal'), title, target, kind: kind.key, unit: kind.unit, createdAt: existing && existing.createdAt || new Date().toISOString() };
      if (this.update(s => ({ ...s, goals: existing ? s.goals.map(g => g.id === goal.id ? goal : g) : [...s.goals, goal] }))) this.setData({ goalEditor: false, notice: '目标已更新，每天可以重新打卡。' });
    },
    checkGoal(event) { const goalId = event.currentTarget.dataset.id, date = ui.today(); this.update(s => ({ ...s, checks: [...s.checks.filter(c => c.goalId !== goalId || c.date !== date), { date, goalId, done: !s.checks.some(c => c.goalId === goalId && c.date === date && c.done) }] })); },
    async deleteGoal(event) { const scope = this.actionScope(), id = event.currentTarget.dataset.id, goal = this.state.goals.find(g => g.id === id); if (!this.data.canEdit || !goal || !await ui.confirm(`删除“${goal.title}”及其打卡记录？`)) return; if (!this.isActionScope(scope) || !this.data.canEdit) return; this.update(s => ({ ...s, goals: s.goals.filter(g => g.id !== id), checks: s.checks.filter(c => c.goalId !== id) })); },
    setConsent(event) { this.setData({ consent: event.detail.value.length > 0, error: '' }); },
    startAssessment(event) { if (!this.data.consent) { this.setData({ error: '请先阅读并勾选下方自评说明。' }); return; } const scale = model.WELLNESS_SCALES.find(s => s.id === event.currentTarget.dataset.id); this.setData({ questionnaire: { ...scale, description: '过去 2 周内，下列问题是如何困扰你的？请选择最符合实际情况的一项。' }, selectedAssessment: '', assessmentResult: null, error: '' }); },
    startPersonality() { this.setData({ questionnaire: { id: 'mbti', title: '20 题人格偏好探索', description: '以下题目为原创趣味问答。没有好坏或标准答案，请选择平时更接近自己的一项。', questions: model.PERSONALITY_QUESTIONS }, error: '' }); },
    finishQuiz(event) {
      const quiz = this.data.questionnaire; if (!quiz || !this.data.canEdit) return; const answers = event.detail.answers;
      if (quiz.id === 'mbti') { const computed = model.scorePersonality(answers); if (!computed) return; const entry = { id: ui.id('personality'), ...computed, createdAt: new Date().toISOString() }; if (this.update(s => ({ ...s, personalities: [entry, ...s.personalities] }))) this.setData({ selectedPersonality: entry.id, personalityResult: this.personalityView(entry), questionnaire: null }); }
      else { const computed = model.scoreAssessment(quiz.id, answers); if (!computed) return; const entry = { id: ui.id('assessment'), scaleId: quiz.id, title: quiz.title, answers, ...computed, createdAt: new Date().toISOString() }; if (this.update(s => ({ ...s, assessments: [entry, ...s.assessments] }))) this.setData({ selectedAssessment: entry.id, assessmentResult: this.assessmentView(entry), questionnaire: null }); }
    },
    closeQuiz() { this.setData({ questionnaire: null }); },
    assessmentView(result) {
      if (!result) return null; const scale = model.WELLNESS_SCALES.find(s => s.id === result.scaleId), history = this.state.assessments.filter(r => r.scaleId === result.scaleId).sort(newestFirst), previous = history[history.findIndex(r => r.id === result.id) + 1], difference = previous && result.score - previous.score;
      return { ...result, displayDate: ui.dateTime(result.createdAt), description: model.describeAssessment(result.scaleId, result.score), comparison: previous ? `与上次同量表（${ui.dateTime(previous.createdAt)}）相比，${difference === 0 ? '分数相同' : `${difference > 0 ? '增加' : '减少'} ${Math.abs(difference)} 分`}。仅呈现分数变化。` : '首次记录。之后可在这里查看同量表的分数变化。', answerItems: scale.questions.map((q, index) => ({ question: q.text, answer: q.options[result.answers[index]], scoreText: index < scale.scoredItems ? `${result.answers[index]} 分` : '不计分' })), scoringText: scale.id === 'gad7' ? '前 7 题每题 0–3 分，相加得到 0–21 分；补充生活影响题不计分。5、10、15 分分别是轻、中、重度症状范围的分界。' : '2 题每题 0–3 分，相加得到 0–6 分；3 分是进一步完整评估的参考分值，不作为病情严重程度分级。' };
    },
    selectAssessment(event) { this.setData({ selectedAssessment: event.currentTarget.dataset.id, answerDetails: false }, () => this.refresh()); },
    repeatAssessment() { const result = this.data.assessmentResult; this.setData({ consent: true }); this.startAssessment({ currentTarget: { dataset: { id: result.scaleId } } }); },
    filterAssessment(event) { this.setData({ assessmentFilter: Number(event.detail.value), allAssessmentHistory: false, historyDeleteIds: {} }, () => this.refresh()); },
    toggleAnswers() { this.setData({ answerDetails: !this.data.answerDetails }); },
    personalityView(result) { return { ...result, description: model.PERSONALITY_DESCRIPTIONS[result.type], displayDate: ui.dateTime(result.createdAt), dimensionsList: model.PERSONALITY_DIMENSIONS.map(d => ({ ...d, firstPercent: result.dimensions[d.key], secondPercent: 100 - result.dimensions[d.key] })) }; },
    selectPersonality(event) { this.setData({ selectedPersonality: event.currentTarget.dataset.id }, () => this.refresh()); },
    drawCard() { const entry = { id: ui.id('card'), cardId: model.pickWellnessCard().id, createdAt: new Date().toISOString() }; if (this.update(s => ({ ...s, cardDraws: [entry, ...s.cardDraws] }))) this.setData({ currentCardId: entry.id, currentCard: model.WELLNESS_CARDS.find(c => c.id === entry.cardId) }); },
    selectCard(event) { this.setData({ currentCardId: event.currentTarget.dataset.id }, () => this.refresh()); },
    requestHistoryDelete(event) { this.setData({ historyDeleteIds: { ...this.data.historyDeleteIds, [event.currentTarget.dataset.id]: true } }); },
    cancelHistoryDelete(event) { this.setData({ historyDeleteIds: { ...this.data.historyDeleteIds, [event.currentTarget.dataset.id]: false } }); },
    confirmHistoryDelete(event) { return this.deleteHistory(event, true); },
    async deleteHistory(event, confirmed) {
      const scope = this.actionScope();
      const { kind, id } = event.currentTarget.dataset; if (!confirmed && !await ui.confirm(kind === 'sessions' ? '删除这条练习记录？' : '删除这条记录？')) return;
      if (!this.isActionScope(scope) || !this.data.canEdit || !['sessions', 'assessments', 'personalities', 'cardDraws'].includes(kind)) return;
      if (this.update(s => ({ ...s, [kind]: s[kind].filter(item => item.id !== id) }))) {
        if (this.data.selectedAssessment === id) this.setData({ selectedAssessment: '', assessmentResult: null });
        if (this.data.selectedPersonality === id) this.setData({ selectedPersonality: '', personalityResult: null }, () => this.refresh());
        if (this.data.currentCardId === id) this.setData({ currentCardId: '', currentCard: null });
        this.setData({ historyDeleteIds: { ...this.data.historyDeleteIds, [id]: false } });
      }
    },
    togglePersonalityType(event) { const type = event.currentTarget.dataset.type; this.setData({ personalityTypes: this.data.personalityTypes.map(item => item.type === type ? { ...item, expanded: !item.expanded } : item) }); },
    toggleHistory(event) { const key = event.currentTarget.dataset.key; this.setData({ [key]: !this.data[key] }, () => this.refresh()); },
    savePracticeSession(entry) {
      if (this.update(s => ({ ...s, sessions: [...s.sessions.filter(item => item.id !== entry.id), entry] }))) return true;
      this.pendingPractice = [...(this.pendingPractice || []).filter(item => item.id !== entry.id), entry];
      this.setData({ practiceSavePending: this.pendingPractice.length, notice: '' }); return false;
    },
    retryPracticeSave() {
      const pending = this.pendingPractice || []; if (!pending.length) return;
      const ids = new Set(pending.map(item => item.id));
      if (!this.update(s => ({ ...s, sessions: [...s.sessions.filter(item => !ids.has(item.id)), ...pending] }))) return;
      this.pendingPractice = []; this.setData({ practiceSavePending: 0, error: '', notice: '练习记录已补充保存，可在练习历史中查看。' });
    },
    breathingSetting(event) { if (this.breathRun && !this.breathRun.saved) return; this.setData({ [event.currentTarget.dataset.key]: Number(event.detail.value) }, () => this.setData({ breathTotal: model.formatPracticeTime([1, 3, 5][this.data.breathDurationIndex] * 60) })); },
    toggleBreathing() { if (this.data.breathRunning) this.pauseBreathing(); else this.startBreathing(); },
    startBreathing() {
      if (!this.breathRun || this.breathRun.saved) this.breathRun = { id: ui.id('breath'), accumulated: 0, started: 0, target: [1, 3, 5][this.data.breathDurationIndex] * 60, saved: false, hold: this.data.breathHoldIndex === 1 };
      this.breathRun.started = Date.now(); this.setData({ breathRunning: true, breathInProgress: true, notice: '' });
      clearInterval(this.breathTimer); this.breathTimer = setInterval(() => this.tickBreathing(), 100); this.tickBreathing();
    },
    tickBreathing() {
      const run = this.breathRun; if (!run || !run.started) return;
      const seconds = Math.min(run.target, run.accumulated + (Date.now() - run.started) / 1000), phase = model.breathingPhase(seconds, run.hold);
      this.setData({ breathElapsed: model.formatPracticeTime(seconds), breathPhase: phase.text, breathCountdown: String(phase.remaining), breathScale: phase.text === '呼气' ? .8 : 1 });
      if (seconds >= run.target) { const saved = this.saveBreathing(true); this.pauseBreathing(); this.setData({ breathInProgress: false, notice: saved ? '本次练习已完成，时长已记录。' : '' }); }
    },
    pauseBreathing() { const run = this.breathRun; if (run && run.started) { run.accumulated += (Date.now() - run.started) / 1000; run.started = 0; } clearInterval(this.breathTimer); this.setData({ breathRunning: false, breathScale: .8, breathPhase: run && !run.saved ? '已暂停' : '准备好了吗', breathCountdown: model.formatPracticeTime(run ? Math.min(run.target, run.accumulated) : 0) }); },
    saveBreathing(completed) {
      const run = this.breathRun; if (!run || run.saved) return true; const seconds = Math.min(run.target, Math.floor(run.accumulated + (run.started ? (Date.now() - run.started) / 1000 : 0))); run.saved = true; if (seconds < 1) return true;
      return this.savePracticeSession({ id: run.id, kind: 'breathing', courseId: 'guided-breath', title: run.hold ? '4-4-6 呼吸练习' : '舒缓呼吸练习', seconds, completedAt: new Date().toISOString(), completed });
    },
    stopBreathing(completed) { const saved = this.saveBreathing(completed === true); this.pauseBreathing(); this.setData({ breathInProgress: false, notice: saved && !this.data.practiceSavePending && this.breathRun ? this.breathRun.accumulated >= 1 ? '练习已结束，实际练习时长已记录。' : '练习已结束。' : '' }); },
    endBreathing() { this.stopBreathing(false); },
    filterCourses(event) { const category = event.currentTarget.dataset.category; this.setData({ courseFilter: category, visibleCourses: courses.filter(c => category === '全部' || c.category === category) }); },
    selectCourse(event) { const course = model.meditationCourses.find(c => c.id === event.currentTarget.dataset.id); if (!course || course.id === this.data.course.id) return; this.disposeAudio(); this.setData({ course, courseTotal: model.formatPracticeTime(course.seconds), transcriptOpen: false }); this.setupAudio(course); },
    setupAudio(course) {
      if (!wx.createInnerAudioContext) { this.setData({ error: '当前环境无法播放音频，可阅读下方完整引导文字。' }); return; }
      const audio = wx.createInnerAudioContext(); this.audio = audio; this.audioRun = { id: ui.id('meditation'), listened: 0, lastTime: 0, lastWall: Date.now(), saved: false, hasPlayed: false, seeking: false, course };
      // Use the same published AAC file as H5 without increasing the native package size.
      audio.src = this.runtime.api.assetUrl(course.src); audio.obeyMuteSwitch = false;
      audio.onPlay(() => { const r = this.audioRun; if (!r || this.audio !== audio) return; r.hasPlayed = true; r.lastTime = audio.currentTime; r.lastWall = Date.now(); this.setData({ playing: true, audioCanFinish: true, error: '' }); });
      audio.onPause(() => { if (this.audio !== audio) return; this.tickAudio(); this.setData({ playing: false }); });
      audio.onTimeUpdate(() => { if (this.audio === audio) this.tickAudio(); }); audio.onSeeking(() => { if (this.audio === audio && this.audioRun) this.audioRun.seeking = true; }); audio.onSeeked(() => { const r = this.audioRun; if (this.audio === audio && r) { r.seeking = false; r.lastTime = audio.currentTime; r.lastWall = Date.now(); } });
      audio.onEnded(() => { if (this.audio !== audio) return; this.tickAudio(); const saved = this.saveAudio(true); this.setData({ playing: false, audioCanFinish: false, notice: saved ? '音频播放结束，已记录实际聆听时长。' : '' }); });
      audio.onError(() => { if (this.audio === audio) this.setData({ playing: false, error: '音频加载失败，请重试或阅读引导文字。' }); });
      this.setData({ playing: false, position: 0, positionText: '00:00', audioCanFinish: false, error: '' });
    },
    tickAudio() {
      const audio = this.audio, r = this.audioRun; if (!audio || !r) return; const position = audio.currentTime, now = Date.now(), delta = position - r.lastTime, wall = Math.max(0, (now - r.lastWall) / 1000);
      if (!r.seeking && delta > 0 && r.hasPlayed && !r.saved) r.listened += Math.min(delta, wall + .05);
      r.lastTime = position; r.lastWall = now; this.setData({ position, positionText: model.formatPracticeTime(position) });
    },
    toggleAudio() {
      if (this.data.playing) { this.audio.pause(); return; }
      if (!this.audio || this.audioRun.saved) { this.disposeAudio(); this.setupAudio(this.data.course); }
      this.setData({ notice: '', error: '' }); if (this.audio) this.audio.play();
    },
    seekAudio(event) { if (!this.audio || !this.audioRun) return; this.tickAudio(); const position = Number(event.detail.value); this.audioRun.lastTime = position; this.audioRun.lastWall = Date.now(); this.audioRun.seeking = true; this.audio.seek(position); this.setData({ position, positionText: model.formatPracticeTime(position) }); },
    saveAudio(ended) { const r = this.audioRun; if (!r || r.saved || !r.hasPlayed) return true; r.saved = true; const seconds = Math.min(86400, Math.floor(r.listened)); if (seconds < 1) return true; return this.savePracticeSession({ id: r.id, kind: 'meditation', courseId: r.course.id, title: r.course.title, seconds, completedAt: new Date().toISOString(), completed: Boolean(ended && seconds >= r.course.seconds * .8) }); },
    endAudio() { this.tickAudio(); if (this.audio) this.audio.pause(); const saved = this.saveAudio(false); this.setData({ playing: false, audioCanFinish: false, notice: saved && !this.data.practiceSavePending ? '本次聆听已结束，已记录实际播放时长。' : '' }); },
    disposeAudio() { if (this.audio) { this.tickAudio(); this.audio.pause(); this.saveAudio(false); this.audio.destroy(); this.audio = null; this.audioRun = null; } },
    toggleTranscript() { this.setData({ transcriptOpen: !this.data.transcriptOpen }); },
    ask() { this.triggerEvent('ask', { question: '' }); },
    async copySource(event) {
      if (this._referenceHandle) this._referenceHandle.cancel();
      const run = this._referenceRun = (this._referenceRun || 0) + 1;
      this.setData({ sourceError: '' });
      const handle = this._referenceHandle = openReferenceDocument(event.currentTarget.dataset.source === 'manual' ? model.ASSESSMENT_MANUAL : model.ASSESSMENT_SOURCE);
      try { await handle.promise; } catch (e) { if (this._referenceAlive && run === this._referenceRun) this.setData({ sourceError: e.message }); }
      finally { if (this._referenceHandle === handle) this._referenceHandle = null; }
    },
  },
});
