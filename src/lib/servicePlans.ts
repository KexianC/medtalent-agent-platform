import type { BuilderServicePlan } from './agentBuilder';
/** Shared service worksheets. All entries are the user's own preparation, never clinical decisions. */
export type ServicePlan = {
  id: string;
  service: string;
  completed: string[];
  note: string;
  targetDate: string;
  updatedAt: string;
  values?: Record<string, Record<string, string | number>>;
};
export type ServicePlans = { version: 1; plans: ServicePlan[] };
export type ServiceWorkflow = { description: string; steps: string[]; action: 'record' | 'prepare' | 'learn' | 'voice' | 'assessment'; question: string };
export const emptyServicePlans = (): ServicePlans => ({ version: 1, plans: [] });

const preparation: Record<string, string[]> = {
  'fu-junfen': ['整理带日期的血糖与生长记录', '记录校园、运动或生活中想沟通的问题', '整理已有检查与正在使用的药物信息'],
  'chen-zhiling': ['整理鼻、耳或咽喉不适的时间线', '记录接触环境与症状变化', '整理已有检查报告与使用过的药物信息'],
  'gong-wenbo': ['整理带日期的代谢指标记录', '记录饮食、活动和身体感受', '整理已有检查与当前用药信息'],
  'chen-jinbiao': ['整理已有病理、影像和治疗资料', '记录食欲、体重与身体感受变化', '列出复诊时想向医生确认的问题'],
  'wu-yuqin': ['整理体重、腰围与活动记录', '记录饮食、睡眠和日常习惯', '选择一个自己愿意尝试的生活习惯'],
  'lin-jinfang': ['整理月经日期与身体感受记录', '整理已有检查、用药及相关病史', '列出备孕或围绝经期想咨询的问题'],
  'luo-jun': ['整理已有影像、治疗与出院资料', '记录体温、疼痛和食欲变化', '记录医疗机构已安排的复查事项'],
  'yu-weihua': ['整理已有检查与手术相关资料', '记录饮食、活动和恢复中的感受', '记录医疗机构已交代的复诊事项'],
  'zhou-yong': ['整理咳嗽、气促与活动记录', '记录吸烟、接触环境及装置使用疑问', '整理已有影像与肺功能检查资料'],
  'yu-wen': ['整理睡眠、情绪和日常状态记录', '记录变化出现的时间及生活影响', '整理既往就诊、检查和当前用药信息'],
  'tang-jinsong': ['整理睡眠、情绪和日常功能变化', '记录变化开始的时间及家人观察', '整理既往就诊、检查和当前用药信息'],
};

export function getServiceWorkflow(slug: string, service: string): ServiceWorkflow {
  const focus = Object.prototype.hasOwnProperty.call(preparation, slug) ? preparation[slug] : ['整理相关健康记录与已有资料', '记录变化时间和日常感受', '列出希望咨询的问题'];
  if (/语音/.test(service)) return { action: 'voice', description: '先整理想说的问题，再进入当前对话使用语音输入。', steps: ['写下最想了解的问题', '确认内容中没有不必要的个人身份信息', '进入问答后选择语音输入'], question: '我想通过语音了解健康问题。' };
  if (/记录|日记|打卡|趋势|进度|不良反应/.test(service)) return { action: 'record', description: `使用健康管理中的真实记录回顾${service}；未测量的项目可留空。`, steps: [focus[0], '补充当天的实际感受和备注', '保存记录并回顾历史变化'], question: `我想了解怎样使用${service}整理日常情况。` };
  if (/准备|清单|就诊/.test(service)) return { action: 'prepare', description: '保存自己的资料准备进度和待问问题，方便就诊前检查。', steps: [...focus, '列出本次最想沟通的问题'], question: `请帮我梳理${service}时还可以准备哪些信息。` };
  if (/提醒|随访|复查|计划/.test(service)) return { action: 'prepare', description: '记录自己确认过的安排、目标日期和完成情况。日期仅用于本页回顾。', steps: [focus[0], '记录已经确认的安排或自己选择的目标', '填写计划日期与待确认问题', '完成后回来更新清单'], question: `我想整理${service}，请帮我梳理需要记录的信息。` };
  if (/评估|自查|筛查|辨识|自评/.test(service)) return { action: 'assessment', description: '通过记录和提问整理自己的情况，具体评估由专业人员结合实际资料完成。', steps: [...focus, '写下希望进一步了解的健康知识'], question: `我想了解${service}，请先告诉我需要整理哪些信息。` };
  return { action: 'learn', description: `围绕${service}整理已有资料和问题，再进入科普问答。`, steps: [...focus, '写下需要解释的术语或疑问'], question: `我想进一步了解${service}。` };
}

export function isServicePlanDate(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 2200) return false;
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function normalizeServicePlans(value: unknown): ServicePlans {
  const result = emptyServicePlans();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.plans)) return result;
  const seen = new Set<string>();
  for (const entry of raw.plans.slice(0, 32)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const plan = entry as Record<string, unknown>;
    if (typeof plan.id !== 'string' || !plan.id.trim() || plan.id.length > 120 || seen.has(plan.id)
      || typeof plan.service !== 'string' || !plan.service.trim() || plan.service.length > 120
      || typeof plan.note !== 'string' || plan.note.length > 2000 || !isServicePlanDate(plan.targetDate)
      || typeof plan.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(plan.updatedAt)
      || !isServicePlanDate(plan.updatedAt.slice(0, 10)) || !Number.isFinite(Date.parse(plan.updatedAt))
      || !Array.isArray(plan.completed) || plan.completed.length > 16
      || plan.completed.some(item => typeof item !== 'string' || !item.trim() || item.length > 160)) continue;
    seen.add(plan.id);
    result.plans.push({ id: plan.id, service: plan.service, completed: [...new Set(plan.completed)] as string[], note: plan.note, targetDate: plan.targetDate, updatedAt: plan.updatedAt, ...(normalizeServiceValues(plan.values) ? { values: normalizeServiceValues(plan.values) } : {}) });
  }
  return result;
}

export function saveServicePlan(value: unknown, plan: ServicePlan): ServicePlans {
  const document = normalizeServicePlans(value);
  const normalized = normalizeServicePlans({ version: 1, plans: [plan] }).plans[0];
  if (!normalized) throw new Error('服务计划格式不正确，请检查日期与填写内容。');
  const index = document.plans.findIndex(item => item.id === plan.id);
  if (index >= 0) document.plans[index] = normalized;
  else {
    if (document.plans.length >= 32) throw new Error('最多保存32份服务计划，请先删除不再需要的计划。');
    document.plans.push(normalized);
  }
  return document;
}

/** Explicitly chosen content only; the caller previews this before opening an unsent chat draft. */
export function buildServicePlanSummary(doctorName: string, plan: ServicePlan, definition?: BuilderServicePlan): string {
  return [`${doctorName}智能体 · ${plan.service}`, plan.targetDate ? `计划日期：${plan.targetDate}` : '',
    plan.completed.length ? `已整理：${plan.completed.join('；')}` : '尚未勾选完成事项',
    plan.note.trim() ? `我的记录与问题：${plan.note.trim()}` : '', ...(definition?.steps || []).flatMap(step => (step.fields || []).flatMap(field => plan.values?.[step.id]?.[field.key] !== undefined ? [step.title + ' - ' + field.label + '：' + plan.values[step.id][field.key]] : [])), '请根据这些个人记录帮我梳理信息和待问问题，仅作科普与就诊准备。']
    .filter(Boolean).join('\n').slice(0, 1900);
}

export function normalizeServiceValues(value: unknown): Record<string,Record<string,string|number>> | undefined {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return;
 const safeKey=(key:string)=>/^[a-z][a-zA-Z0-9_-]{0,63}$/.test(key)&&!['constructor','prototype','__proto__'].includes(key);
 const result:Record<string,Record<string,string|number>>={};
 for (const [step,fields] of Object.entries(value).slice(0,16)) { if (!safeKey(step)||!fields||typeof fields!=='object'||Array.isArray(fields)) continue; const entries=Object.entries(fields).slice(0,20).filter(([key,value])=>safeKey(key)&&(typeof value==='string'&&value.length<=1000||typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e9)); if(entries.length)result[step]=Object.fromEntries(entries) as Record<string,string|number>; }
 return Object.keys(result).length?result:undefined;
}
export function serviceProgress(definition: BuilderServicePlan, plan: ServicePlan) {
 const checked=(id:string)=>{const step=definition.steps.find(step=>step.id===id);return Boolean(step&&(plan.completed.includes(step.title)||plan.completed.includes(id)));};
 const issues:string[]=[];
 const steps=definition.steps.map(step=>{const blocked=(step.dependsOn||[]).some(id=>!checked(id)),done=checked(step.id),fields=(step.fields||[]).map(field=>({...field,value:plan.values?.[step.id]?.[field.key]??''}));if(done&&blocked)issues.push(step.title+'：请先完成前置步骤。');if(done)for(const field of fields){if(field.required&&(field.value===''||typeof field.value==='string'&&!field.value.trim()))issues.push(step.title+'：请填写'+field.label);else if(field.value!==''&&field.type==='number'&&(typeof field.value!=='number'||!Number.isFinite(field.value)||Math.abs(field.value)>1e9))issues.push(field.label+'须为有效数字。');}return {...step,blocked,checked:done,fields};});
 const required=definition.completionRule==='all-required'?steps.filter(step=>step.required!==false):steps;
 return {steps,issues,completed:!issues.length&&required.every(step=>step.checked),count:required.filter(step=>step.checked).length,total:required.length};
}
export function toggleServiceProgress(definition: BuilderServicePlan, plan: ServicePlan, id:string, checked:boolean): string[] {
 const step=definition.steps.find(step=>step.id===id);if(!step)return plan.completed;
 const completed=new Set(plan.completed);if(checked){if(serviceProgress(definition,plan).steps.find(step=>step.id===id)?.blocked)return plan.completed;completed.add(step.title);}else{completed.delete(step.title);completed.delete(step.id);let changed=true;while(changed){changed=false;for(const dependent of definition.steps){if((completed.has(dependent.title)||completed.has(dependent.id))&&(dependent.dependsOn||[]).some(id=>{const parent=definition.steps.find(step=>step.id===id);return parent&&!completed.has(parent.title)&&!completed.has(parent.id);})){completed.delete(dependent.title);completed.delete(dependent.id);changed=true;}}}}
 return [...completed];
}
