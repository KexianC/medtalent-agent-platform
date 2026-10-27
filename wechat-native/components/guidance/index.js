const model = require('../../utils/models/guidance.js');
const wellness = require('../../utils/models/wellness.js');
const { getRuntime } = require('../../utils/runtime.js');
const ui = require('../../utils/health-ui.js');
const { icon } = require('../../utils/presentation.js');
const { openReferenceDocument } = require('../../utils/reference-document.js');
const icons = Object.fromEntries(['heart','clipboard','close','rotate','arrowRight'].map(name => [name, icon(name, 'theme-tang-jinsong')])); icons.arrowWhite = icon('arrowRight','white');
icons.heart = '/assets/icons/guidance-heart.png'; icons.clipboard = '/assets/icons/guidance-clipboard.png';
icons.rotate = '/assets/icons/guidance-repeat.png'; icons.arrowRight = '/assets/icons/guidance-arrow.png'; icons.arrowWhite = '/assets/icons/guidance-arrow-white.png';
icons.scaleArrow = '/assets/icons/guidance-arrow-ink.png'; icons.close = '/assets/icons/guidance-close.png'; icons.chevronUp = '/assets/icons/guidance-chevron-up.png'; icons.chevronDown = '/assets/icons/guidance-chevron-down.png';
const moodSymbolImages = { low: '/assets/icons/guidance-mood-low.png', bright: '/assets/icons/guidance-mood-bright.png' };
const moods = model.TANG_MOODS.map(mood => ({ ...mood, symbolImage: moodSymbolImages[mood.id] || '' }));
Component({
  properties: { doctor: { type: Object, value: null }, disabled: { type: Boolean, value: false }, sendResult: { type: Object, value: null } },
  data: { icons, expanded: true, showScales: false, moods, scales: model.TANG_SCALES, activeScale: null, selectedMood: '', result: null, results: [], supplement: '', supplementDirty: false, includeSupplement: false, noteFeedback: '', answerDetails: false, storageNotice: '', saveChat: true, canEdit: true, sending: false, feedback: '', supportText: model.PHQ9_SUPPORT },
  observers: { sendResult(result) { this.resolveSend(result); } },
  lifetimes: { attached() { this._referenceAlive = true; this.runtime = getRuntime(); this.load(); this.unsubscribe = this.runtime.subscribe(() => this.load()); }, detached() { this._referenceAlive = false; if (this._referenceHandle) this._referenceHandle.cancel(); if (this.unsubscribe) this.unsubscribe(); } },
  methods: {
    slug() { return this.data.doctor && this.data.doctor.slug || 'tang-jinsong'; },
    load() {
      const account = this.runtime.session.get(), owner = account.user && account.user.id || (this.runtime.data.getVisitorId ? 'guest:' + this.runtime.data.getVisitorId() : 'guest');
      if (this.owner !== undefined && owner !== this.owner) { this.previousResult = null; this.pendingSend = null; this.setData({ result: null, activeScale: null, selectedMood: '', supplement: '', supplementDirty: false, includeSupplement: false, noteFeedback: '', sending: false, feedback: '' }); }
      this.owner = owner;
      const privacy = this.runtime.readScope(this.slug(), 'privacy', { saveChat: true }), results = model.normalizeTangResults(this.runtime.readScope(this.slug(), model.TANG_ASSESSMENT_SECTION, [])), meta = this.runtime.data.get(this.slug(), model.TANG_ASSESSMENT_SECTION, []);
      if (this.data.saveChat && privacy.saveChat === false) { this.previousResult = null; this.setData({ result: null, activeScale: null, supplement: '', supplementDirty: false }); }
      const storageNotice = privacy.saveChat === false ? '仅在本次页面中保留。' : account.user ? meta.status === 'synced' ? '已保存到微信账户，可跨设备查看。' : meta.status === 'conflict' ? '结果与云端记录有冲突，请到“我的”选择保留版本。' : ['pending','saving','loading'].includes(meta.status) ? '正在同步到微信账户，完成后可跨设备查看。' : '结果尚未同步到微信账户，请到“我的”重试同步。' : meta.status === 'ready' ? '已保存在当前设备。' : '结果仅保留在本次页面中，尚未保存到本机。';
      this.results = results;
      this.setData({ accountUser: Boolean(account.user), saveChat: privacy.saveChat !== false, canEdit: meta.canEdit !== false, storageNotice, results: results.map(r => ({ ...r, label: r.scaleId === 'gad7' ? 'GAD-7' : r.scaleId === 'phq9' ? 'PHQ-9' : 'PHQ-2（历史）' })) });
    },
    async copySource(event) {
      if (this._referenceHandle) this._referenceHandle.cancel();
      const run = this._referenceRun = (this._referenceRun || 0) + 1;
      this.setData({ sourceError: '' });
      const handle = this._referenceHandle = openReferenceDocument(event.currentTarget.dataset.source === 'manual' ? wellness.ASSESSMENT_MANUAL : wellness.ASSESSMENT_SOURCE);
      try { await handle.promise; } catch (e) { if (this._referenceAlive && run === this._referenceRun) this.setData({ sourceError: e.message }); }
      finally { if (this._referenceHandle === handle) this._referenceHandle = null; }
    },
    toggle() { this.setData({ expanded: !this.data.expanded }); },
    showScales() { this.setData({ showScales: true }); },
    closeScales() { this.setData({ showScales: false }); },
    start(event) {
      const scale = model.TANG_SCALES.find(s => s.id === event.currentTarget.dataset.id); if (!scale) return;
      this.previousResult = this.data.result;
      this.setData({ activeScale: scale, result: null, supplement: '', supplementDirty: false, includeSupplement: false, noteFeedback: '', feedback: '' });
    },
    cancelQuiz() { const previous = this.previousResult; this.setData({ activeScale: null, result: previous, showScales: !previous, supplement: previous && previous.supplement || '', supplementDirty: false, includeSupplement: false }); },
    finish(event) {
      const scale = this.data.activeScale; if (!scale || !this.data.canEdit) return;
      const entry = model.createTangAssessmentResult(scale.id, event.detail.answers, ui.id('tang-assessment'), new Date().toISOString()); if (!entry) return;
      const results = model.normalizeTangResults([entry, ...this.results]);
      if (!this.runtime.writeScope(this.slug(), model.TANG_ASSESSMENT_SECTION, results)) { this.setData({ noteFeedback: '结果暂时无法保存，请重试。' }); return; }
      this.results = results; this.setData({ activeScale: null, showScales: false }); this.showResult(entry); this.load();
    },
    resultView(result) { const scale = model.TANG_RESULT_SCALES.find(s => s.id === result.scaleId); return { ...result, title: scale.title, description: model.describeTangAssessment(result.scaleId, result.score), needsSupport: model.needsPhq9Support(result.scaleId, result.answers), scoredItems: scale.scoredItems, hasImpact: scale.questions.length > scale.scoredItems, answerItems: scale.questions.map((q, index) => ({ question: q.text, answer: q.options[result.answers[index]], scoreText: index < scale.scoredItems ? `${result.answers[index]} 分` : '不计分' })) }; },
    showResult(result) { this.setData({ result: this.resultView(result), supplement: result.supplement || '', supplementDirty: false, includeSupplement: false, noteFeedback: '', answerDetails: false, feedback: '' }); },
    selectResult(event) { const result = this.results.find(r => r.id === event.currentTarget.dataset.id); if (result) this.showResult(result); },
    closeResult() { this.setData({ result: null, supplement: '', supplementDirty: false, includeSupplement: false }); },
    repeat() { if (!this.data.result) return; this.start({ currentTarget: { dataset: { id: this.data.result.scaleId === 'phq2' ? 'phq9' : this.data.result.scaleId } } }); },
    changeSupplement(event) { this.setData({ supplement: event.detail.value, supplementDirty: event.detail.value !== (this.data.result.supplement || ''), includeSupplement: false, noteFeedback: '' }); },
    cancelSupplement() { this.setData({ supplement: this.data.result.supplement || '', supplementDirty: false, includeSupplement: false, noteFeedback: '已取消补充修改。' }); },
    saveSupplement() {
      const result = model.updateTangAssessmentSupplement(this.data.result, this.data.supplement);
      if (!result) { this.setData({ noteFeedback: `补充描述最多 ${model.TANG_SUPPLEMENT_LIMIT} 字，请缩短后保存。` }); return; }
      const results = model.normalizeTangResults([result, ...this.results.filter(r => r.scaleId !== result.scaleId)]);
      if (!this.runtime.writeScope(this.slug(), model.TANG_ASSESSMENT_SECTION, results)) { this.setData({ noteFeedback: '补充描述暂时无法保存，请重试。' }); return; }
      this.results = results; this.showResult(result); this.setData({ noteFeedback: '补充描述已更新，不计入分数。' }); this.load();
    },
    toggleInclude(event) { this.setData({ includeSupplement: event.detail.value.length > 0 }); },
    toggleAnswers() { this.setData({ answerDetails: !this.data.answerDetails }); },
    send(question, moodId) { if (!question || this.data.disabled || this.pendingSend) return; const requestId = ui.id('guidance'); this.pendingSend = { requestId, moodId, owner: this.owner }; this.setData({ sending: true, feedback: '' }); this.triggerEvent('ask', { question, sendNow: true, guidanceRequestId: requestId }); },
    resolveSend(result) { const pending = this.pendingSend; if (!pending || !result || result.requestId !== pending.requestId || pending.owner !== this.owner) return; this.pendingSend = null; this.setData(result.accepted === true ? { sending: false, expanded: false, selectedMood: pending.moodId || this.data.selectedMood, feedback: '' } : { sending: false, feedback: '暂时没能发送，请稍后再试。' }); },
    sendMood(event) { const id = event.currentTarget.dataset.id; this.send(model.buildTangMoodMessage(id), id); },
    discuss() { if (this.data.supplementDirty) return; this.send(model.buildTangAssessmentMessage(this.data.result, this.data.includeSupplement)); },
  },
});
