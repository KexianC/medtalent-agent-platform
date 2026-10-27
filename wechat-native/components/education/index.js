'use strict';
const { icon, formatText, genericExperience, sheetMaxHeight, fitSheet } = require('../../utils/presentation');
const { builderLayoutClass, canWriteBuilderData, componentEnabled, doctorExperiences } = require('../../utils/models/catalog');
const { enterSheet, exitSheet, resetSheet } = require('../../utils/sheet-motion');
const { getRuntime } = require('../../utils/runtime');
const plans = require('../../utils/models/service-plans');
const planSection = 'service-plans-v1';
function configuredServices(doctor) { return doctor.builder ? doctor.builder.servicePlans.map(plan => plan.title) : doctor.services || []; }
function configuredWorkflow(doctor, title) { const plan = doctor.builder && doctor.builder.servicePlans.find(plan => plan.title === title); return plan ? { definition:plan, description: plan.description || '整理自己的准备进度与待问问题。', steps: plan.steps.map(step => step.title), details: Object.fromEntries(plan.steps.map(step => [step.title, step.description || ''])), action: 'prepare', question: '我想进一步了解' + title } : plans.getServiceWorkflow(doctor.slug, title); }
const confirm = content => new Promise(resolve => wx.showModal({ title: '请确认', content, success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
function planFeedback(meta, account, action) {
  const noun = action === 'delete' ? '服务清单删除操作' : '服务清单';
  if (!account.user) return meta.status === 'memory-only' ? `${noun}仅临时保留在当前页面，尚未保存到本机。` : action === 'delete' ? '服务清单已从本机删除。' : '服务清单已保存到本机。';
  if (meta.status === 'synced') return action === 'delete' ? '服务清单删除已同步到微信账户。' : '服务清单已同步到微信账户。';
  if (meta.status === 'conflict') return `${noun}与云端版本有冲突，请到“我的”选择保留版本。`;
  if (['pending', 'saving', 'loading'].includes(meta.status)) return `${noun}已更新，正在同步到微信账户。`;
  return `${noun}已更新，尚未同步到微信账户，请联网后重试。`;
}
function checklistSteps(workflow, completed, values) {
  if(workflow.definition)return plans.serviceProgress(workflow.definition,{completed,values}).steps.map(step=>({...step,text:step.title,label:step.title}));
  return [...workflow.steps.map(text => ({ text, label: text, description: workflow.details && workflow.details[text] || '', checked: completed.includes(text) })), ...completed.filter(text => !workflow.steps.includes(text)).map(text => ({ text, label: '此前已整理：' + text, checked: true }))];
}
const planFingerprint = plan => JSON.stringify(plan || null);
const typeLabels = { article: '科普文章', faq: '常见问答', notice: '公告', service: '服务说明' };
const serviceDetails = {
  '睡眠与情绪记录': { description: '用结构化记录梳理入睡、夜醒、白天精力和情绪变化，便于观察趋势。', items: ['记录睡眠时间与夜醒次数', '标记焦虑、低落或压力程度', '补充学习、工作和社交影响'], question: '怎样开始记录睡眠和情绪变化？' },
  '心理状态科普评估': { description: '通过非诊断性的自我观察问题，了解哪些变化值得进一步向专业人员咨询。', items: ['识别持续时间与变化趋势', '关注日常功能是否受到影响', '了解需要及时求助的危险信号'], question: '心理状态出现哪些变化时建议及时求助？' },
  '就诊资料准备': { description: '帮助整理症状时间线、既往检查和当前用药信息，提高线下沟通效率。', items: ['整理症状首次出现和加重时间', '准备既往病历与检查报告', '记录当前药物名称和使用情况'], question: '精神心理科就诊前应该准备哪些资料？' },
  '语音健康问答': { description: '通过语音描述健康困惑，系统完成语音识别、科普回复和语音播报。', items: ['在安静环境中清楚描述问题', '避免说出身份证号等敏感信息', '急症或自伤风险请立即线下求助'], question: '请介绍语音健康问答适合咨询哪些内容。' },
};
const serviceIcons = ['stethoscope', 'file', 'heart', 'calendarCheck'];
Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    doctor: { type: Object, value: null }, experience: { type: Object, value: null },
    mode: { type: String, value: 'services' }, title: { type: String, value: '' },
    compact: { type: Boolean, value: false },
  },
  observers: { 'doctor,experience,mode': function () { this.refresh(); } },
  data: {
    content: [], services: [], savedPlans: [], isTang: false, exp: null, selected: null, selectedService: null, sheetHeight: 0, sheetMotion: '', backdropMotion: '', plan: null, planSteps: [], planDirty: false, planConflict: false, planError: '', planNotice: '', planAction: '', planPreview: '', planCanEdit: true, planStorageNotice: '',
    icons: { chevron: icon('chevron', 'muted'), shield: icon('shield', 'me-disclaimer'), boundaryShield: icon('shield', 'chat-warning'), clipboard: icon('clipboard', 'white'), chat: icon('chat', 'white'), chatFill: icon('chat-fill', 'white'), close: icon('close'), check: icon('check', 'accent') },
  },
  lifetimes: { attached() { this._alive = true; this._sheetFitUnavailable = false; this.runtime = getRuntime(); this._unsubscribe = this.runtime.subscribe(() => this.refresh()); this.refresh(); }, detached() { this._alive = false; this._sheetFitUnavailable = true; if (this._unsubscribe) this._unsubscribe(); resetSheet(this); } },
  pageLifetimes: { show() { this._sheetFitUnavailable = false; fitSheet(this, 720, true); }, resize() { fitSheet(this, 720, true); }, hide() { this._sheetFitUnavailable = true; } },
  methods: {
    owner() { const runtime = this.runtime || getRuntime(), account = runtime.session.get(); return account.user && account.user.id || (runtime.data.getVisitorId ? 'guest:' + runtime.data.getVisitorId() : 'guest'); },
    scope() { return this.properties.doctor && this.properties.doctor.slug + ':' + this.properties.mode + ':' + this.owner(); },
    scopeActive(scope) { return this._alive !== false && !this._sheetFitUnavailable && scope === this.scope(); },
    refresh() {
      if (!this.runtime) this.runtime = getRuntime();
      const doctor = this.properties.doctor;
      if (!doctor) {
        if (this._sheetScope) { resetSheet(this); this._sheetScope = ''; this.setData({ selected: null, selectedService: null }); }
        return;
      }
      const scope = this.scope();
      const changedScope = this._sheetScope !== scope;
      if (changedScope) { resetSheet(this); this._sheetScope = scope; }
      const tone = doctorExperiences[doctor.slug] ? 'theme-' + doctor.slug : 'accent';
      const content = (componentEnabled(doctor, 'content') ? doctor.content || [] : []).filter(item => this.properties.mode !== 'services' || item.type === 'service').map(item => Object.assign({}, item, { typeLabel: typeLabels[item.type] || '科普内容' }));
      const runtime = this.runtime || getRuntime(), meta = runtime.data.get(doctor.slug, planSection, plans.emptyServicePlans()), document = plans.normalizeServicePlans(meta.value);
      const patch = { layoutClass:builderLayoutClass(doctor),content, exp: this.properties.experience || genericExperience(doctor), isTang: doctor.slug === 'tang-jinsong', planReadOnly:!canWriteBuilderData(doctor,'services'),planCanDelete:meta.canEdit!==false,planCanEdit: meta.canEdit !== false&&canWriteBuilderData(doctor,'services'), planStorageNotice: runtime.storageNotice(doctor.slug, planSection) || (runtime.session.get().user && meta.status !== 'synced' ? '服务计划尚未同步完成，可在“我的”查看状态与重试。' : meta.status === 'memory-only' ? '服务计划仅临时保留在当前页面，请重试保存。' : ''), services: configuredServices(doctor).map((title, i) => { const saved = document.plans.find(plan => plan.service === title), workflow = configuredWorkflow(doctor, title); return { title, iconUrl: icon(serviceIcons[i % serviceIcons.length], tone), index: i, progress: saved ? `${saved.completed.filter(item => workflow.steps.includes(item)).length} / ${workflow.steps.length} 已整理` : '填写与保存服务清单' }; }), icons: Object.assign({}, this.data.icons, { shield: icon('shield', doctor.slug === 'tang-jinsong' ? 'me-disclaimer-tang' : 'me-disclaimer'), check: icon('check', tone), publishedArrow: icon('chevron', tone) }) };
      patch.savedPlans = document.plans.filter(plan => !configuredServices(doctor).includes(plan.service) || document.plans.find(item => item.service === plan.service).id !== plan.id);
      if (changedScope) { this._planBase = undefined; this._editPlanBase = undefined; Object.assign(patch, { selected: null, selectedService: null, plan: null, planSteps: [], planDirty: false, planConflict: false, planError: '', planNotice: '', planAction: '', planPreview: '', planRetrying: false }); }
      else if (this.data.selectedService) {
        const title = this.data.selectedService.title, planId = this.data.selectedService.planId || title, saved = document.plans.find(plan => plan.id === planId), workflow = configuredWorkflow(doctor, title);
        if (this.data.planDirty) {
          patch.planConflict = planFingerprint(saved) !== (this._savingPlanFingerprint || this._editPlanBase || this._planBase);
          if (patch.planConflict) patch.planNotice = '';
        } else {
          this._planBase = planFingerprint(saved); this._editPlanBase = undefined;
          const plan = saved || { id: planId, service: title, completed: [], note: '', targetDate: '', updatedAt: this.data.plan && this.data.plan.service === title ? this.data.plan.updatedAt : new Date().toISOString() };
          Object.assign(patch, { plan: { ...plan, completed: [...plan.completed] }, planSaved: Boolean(saved), planConflict: false, planProgress:workflow.definition?plans.serviceProgress(workflow.definition,plan):null,planSteps: checklistSteps(workflow, plan.completed, plan.values) });
          if (JSON.stringify(this.data.plan) !== JSON.stringify(plan)) patch.planPreview = '';
          if (this.data.planAction) patch.planNotice = planFeedback(meta, runtime.session.get(), this.data.planAction);
        }
      }
      this.setData(patch, () => fitSheet(this, 720, true));
    },
    manage() { this.triggerEvent('navigate', { tab: 'manage' }); },
    openContent(event) {
      const item = this.data.content.find(item => item.id === event.currentTarget.dataset.id);
      if (item) enterSheet(this, { selected: Object.assign({}, item, { displayBody: formatText(item.body || item.summary || '暂无补充正文。'), displaySummary: item.summary && item.summary !== item.body ? item.summary : '' }), selectedService: null, sheetHeight: sheetMaxHeight(720) }, () => fitSheet(this, 720, true));
    },
    async openService(event) {
      const scope = this.scope(), dataset = event.currentTarget.dataset, oldPlan = dataset.id && this.data.savedPlans.find(plan => plan.id === dataset.id), item = oldPlan ? { title: oldPlan.service } : this.data.services[dataset.index]; if (!item) return;
      if (this.data.planDirty && !await confirm('当前服务清单尚未保存，确定切换服务吗？')) return;
      if (!this.scopeActive(scope)) return;
      const title = item.title, workflow = configuredWorkflow(this.properties.doctor, title), detail = this.properties.doctor.builder ? workflow : serviceDetails[title] || workflow;
      const document = plans.normalizeServicePlans(this.runtime.data.get(this.properties.doctor.slug, planSection, plans.emptyServicePlans()).value), saved = dataset.id ? document.plans.find(plan => plan.id === dataset.id) : document.plans.find(plan => plan.service === title);
      if (dataset.id && !saved) return;
      const plan = saved || { id: (this.properties.doctor.builder && this.properties.doctor.builder.servicePlans.find(plan => plan.title === title) || {}).id || title, service: title, completed: [], note: '', targetDate: '', updatedAt: new Date().toISOString() };
      this._planBase = planFingerprint(saved); this._editPlanBase = undefined;
      enterSheet(this, { selectedService: Object.assign({ title, planId: plan.id, manage: workflow.action === 'record', items: workflow.steps }, detail), selected: null, plan: { ...plan, completed: [...plan.completed] }, planProgress:workflow.definition?plans.serviceProgress(workflow.definition,plan):null,planSteps: checklistSteps(workflow, plan.completed,plan.values), planDirty: false, planConflict: false, planError: '', planNotice: '', planAction: '', planPreview: '', planSaved: Boolean(saved), sheetHeight: sheetMaxHeight(720) }, () => fitSheet(this, 720, true));
    },
    async closeSheet() { const scope = this.scope(); if (this.data.planDirty && !await confirm('当前服务清单尚未保存，确定关闭吗？')) return false; if (!this.scopeActive(scope)) return false; exitSheet(this, () => this.setData({ selected: null, selectedService: null, plan: null, planDirty: false, planPreview: '' })); return true; },
    beginPlanEdit() { if (!this.data.planDirty) this._editPlanBase = this._planBase; },
    refreshProgress(){if(!this.data.plan)return;const workflow=configuredWorkflow(this.properties.doctor,this.data.plan.service);this.setData({planSteps:checklistSteps(workflow,this.data.plan.completed,this.data.plan.values),planProgress:workflow.definition?plans.serviceProgress(workflow.definition,this.data.plan):null});},
    togglePlanStep(event) { if(!this.data.planCanEdit||!this.data.plan)return;const text=event.currentTarget.dataset.step,workflow=configuredWorkflow(this.properties.doctor,this.data.plan.service),step=workflow.definition&&workflow.definition.steps.find(step=>step.title===text);if(!this.data.planSteps.some(step=>step.text===text))return;this.beginPlanEdit();const completed=step?plans.toggleServiceProgress(workflow.definition,this.data.plan,step.id,!this.data.plan.completed.includes(text)):this.data.plan.completed.includes(text)?this.data.plan.completed.filter(step=>step!==text):[...this.data.plan.completed,text];this.setData({'plan.completed':completed,planDirty:true,planError:'',planNotice:'',planAction:'',planPreview:''},()=>this.refreshProgress()); },
    editPlanField(event){if(!this.data.planCanEdit||!this.data.plan)return;const {step,key}=event.currentTarget.dataset,definition=configuredWorkflow(this.properties.doctor,this.data.plan.service).definition,field=definition&&((definition.steps.find(item=>item.id===step)||{}).fields||[]).find(item=>item.key===key);if(!field)return;const raw=event.detail.value,value=field.type==='number'&&raw!==''?Number(raw):raw;this.beginPlanEdit();this.setData({'plan.values':{...this.data.plan.values,[step]:{...(this.data.plan.values||{})[step],[key]:value}},planDirty:true,planError:'',planNotice:'',planAction:'',planPreview:''},()=>this.refreshProgress()); },
    editPlan(event) { const key = event.currentTarget.dataset.key; if (!this.data.planCanEdit || !this.data.plan || !['note', 'targetDate'].includes(key)) return; this.beginPlanEdit(); this.setData({ ['plan.' + key]: event.detail.value, planDirty: true, planError: '', planNotice: '', planAction: '', planPreview: '' }); },
    clearPlanDate() { this.editPlan({ currentTarget: { dataset: { key: 'targetDate' } }, detail: { value: '' } }); },
    savePlan() {
      if (!this.data.plan || !this.data.planCanEdit || this._sheetScope !== this.scope()) return false;
      const definition=configuredWorkflow(this.properties.doctor,this.data.plan.service).definition,progress=definition&&plans.serviceProgress(definition,this.data.plan);if(progress&&progress.issues.length){this.setData({planError:progress.issues.join(" ")});return false;}
      const slug = this.properties.doctor.slug, plan = { ...this.data.plan, updatedAt: new Date().toISOString() };
      try {
        const current = this.runtime.data.get(slug, planSection, plans.emptyServicePlans()).value, saved = plans.normalizeServicePlans(current).plans.find(item => item.id === plan.id);
        if (planFingerprint(saved) !== (this.data.planDirty ? this._editPlanBase : this._planBase)) { this.setData({ planConflict: true, planError: '', planNotice: '' }, () => fitSheet(this, 720, true)); return false; }
        const next = plans.saveServicePlan(current, plan);
        this._savingPlanFingerprint = planFingerprint(plan);
        if (!this.runtime.data.set(slug, planSection, next)) throw new Error(this.runtime.storageNotice(slug, planSection) || '服务计划尚未保存，请重试。');
        this._planBase = planFingerprint(plan); this._editPlanBase = undefined;
        const meta = this.runtime.data.get(slug, planSection, plans.emptyServicePlans());
        this.setData({ plan, planDirty: false, planConflict: false, planSaved: true, planError: '', planAction: 'save', planNotice: planFeedback(meta, this.runtime.session.get(), 'save') }, () => fitSheet(this, 720, true)); return true;
      } catch (error) { this.setData({ planError: error.message, planNotice: '' }); return false; }
      finally { this._savingPlanFingerprint = undefined; }
    },
    reloadSavedPlan() { if (!this.data.plan || this._sheetScope !== this.scope()) return; this.setData({ planDirty: false, planConflict: false, planError: '', planNotice: '', planAction: '', planPreview: '' }); this.refresh(); },
    confirmCurrentPlanDraft() {
      if (!this.data.plan || !this.data.planConflict || this._sheetScope !== this.scope()) return;
      const current = plans.normalizeServicePlans(this.runtime.data.get(this.properties.doctor.slug, planSection, plans.emptyServicePlans()).value).plans.find(item => item.id === this.data.plan.id);
      this._planBase = planFingerprint(current); this._editPlanBase = this._planBase;
      this.setData({ planDirty: true, planConflict: false, planError: '', planAction: '', planNotice: '已保留当前草稿，请再次点击保存清单。' });
    },
    async retryPlanStorage() { if (this.data.planRetrying) return; const scope = this.scope(); this.setData({ planRetrying: true }); try { await this.runtime.data.retry(this.properties.doctor.slug, planSection); } catch (error) { if (this.scopeActive(scope)) this.setData({ planError: error.message || '暂时无法同步，请重试。' }); } finally { if (this.scopeActive(scope)) { this.setData({ planRetrying: false }); this.refresh(); } } },
    async deletePlan() {
      const scope = this.scope(), plan = this.data.plan; if (!plan || !this.data.planCanDelete || !await confirm('删除这份已保存的服务清单？此操作无法恢复。')) return;
      if (!this.scopeActive(scope) || !this.data.plan || this.data.plan.id !== plan.id) return;
      const document = plans.normalizeServicePlans(this.runtime.data.get(this.properties.doctor.slug, planSection, plans.emptyServicePlans()).value);
      if (!this.runtime.data.set(this.properties.doctor.slug, planSection, { version: 1, plans: document.plans.filter(item => item.id !== plan.id) })) { this.setData({ planError: '删除失败，请稍后重试。' }); return; }
      const empty = { id: plan.id, service: plan.service, completed: [], note: '', targetDate: '', updatedAt: new Date().toISOString() };
      this._planBase = planFingerprint(null); this._editPlanBase = undefined;
      const meta = this.runtime.data.get(this.properties.doctor.slug, planSection, plans.emptyServicePlans());
      this.setData({ plan: empty, planSteps: checklistSteps(configuredWorkflow(this.properties.doctor, plan.service), []), planSaved: false, planDirty: false, planConflict: false, planPreview: '', planError: '', planAction: 'delete', planNotice: planFeedback(meta, this.runtime.session.get(), 'delete') }, () => fitSheet(this, 720, true));
    },
    previewPlan() { if (!this.data.plan) return; if (!plans.isServicePlanDate(this.data.plan.targetDate)) { this.setData({ planError: '请选择有效的计划日期。' }); return; } this.setData({ planPreview: plans.buildServicePlanSummary(this.properties.doctor.name, this.data.plan, configuredWorkflow(this.properties.doctor,this.data.plan.service).definition), planError: '' }, () => fitSheet(this, 720, true)); },
    consultPlan() { if (!this.data.planPreview || this._sheetScope !== this.scope()) return; const question = this.data.planPreview.replace(/\s*\n\s*/g, '；'); resetSheet(this); this.setData({ selectedService: null, selected: null, plan: null, planDirty: false, planPreview: '' }); this.triggerEvent('ask', { question }); },
    preventClose() {},
    continueContent() { const item = this.data.selected; this.closeSheet(); if (item) this.triggerEvent('ask', { question: '我想进一步了解“' + item.title + '”。' }); },
    async continueService() { const service = this.data.selectedService; if (!service || !await this.closeSheet()) return; if (service.manage) this.manage(); else this.triggerEvent('ask', { question: service.question }); },
  },
});
