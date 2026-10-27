import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { builderLayoutClass, canWriteBuilderData, configuredNavigation, configuredRecordConfig, componentEnabled, healthContextEnabled, realHealthReminder, usesTangRecords, usesWellness, voiceEnabled } from '../src/lib/builderRuntime.ts';
import { normalizeHealthRecords, buildHealthContextPayload, formatHealthMetricsSummary } from '../src/lib/healthRecords.ts';
import { validateSpecialtyRecordInput, saveSpecialtyRecord, buildSpecialtyStats } from '../src/lib/specialtyRecords.ts';
import { buildSpecialtyRecordReview } from '../src/features/health/recordReview.ts';
import { serviceProgress, toggleServiceProgress, normalizeServicePlans, buildServicePlanSummary } from '../src/lib/servicePlans.ts';
import { normalizeAgentBuilder } from '../src/lib/agentBuilder.ts';
import { parseDraftDoctorDetail, parsePublicDoctorDetail, parseTemplatePreviewDetail, safePortraitUrl } from '../src/hooks/useDoctorDirectory.ts';
const nativeRoot = fileURLToPath(new URL('../wechat-native/', import.meta.url));
const builder = normalizeAgentBuilder({schemaVersion:1,components:[{id:'home',enabled:true,order:4},{id:'chat',enabled:true,order:0,label:'咨询'},{id:'records',enabled:true,order:2},{id:'services',enabled:false,order:3},{id:'content',enabled:false,order:4},{id:'assessments',enabled:true,order:1},{id:'wellness',enabled:false,order:5},{id:'voice',enabled:true,order:6}],recordFields:[{key:'pain',label:'疼痛程度',unit:'分',min:0,max:10,step:1}],assessments:[{id:'check',title:'今日感受',questions:[{id:'q1',text:'程度',options:[{label:'无',value:0},{label:'明显',value:2}]},{id:'q2',text:'影响',options:[{label:'无',value:0},{label:'明显',value:3}]}]}],servicePlans:[],voice:{enabled:true,autoSend:false,autoPlay:true},healthContext:true});
const doctor = {slug:'new-specialist',name:'新医生',builder};
test('builder navigation keeps authored order and labels and omits disabled services for a new slug',()=>{
 const nav=configuredNavigation(doctor,[{id:'home',label:'首页'},{id:'ask',label:'问医生'},{id:'manage',label:'管理'},{id:'services',label:'服务'},{id:'me',label:'我的'}]);
 assert.deepEqual(nav.map(item=>item.id),['ask','manage','home','me']);assert.equal(nav[0].label,'咨询');assert.equal(componentEnabled(doctor,'content'),false);assert.equal(voiceEnabled(doctor),true);assert.equal(healthContextEnabled(doctor),true);
 assert.equal(usesTangRecords(doctor),false);assert.equal(usesWellness(doctor),false);
 const config=configuredRecordConfig(doctor,{title:'legacy',description:'legacy',fields:[]});assert.deepEqual(config.fields[0],{key:'pain',label:'疼痛程度',unit:'分',min:0,max:10,step:1});
});
test('legacy doctors retain their existing tabs and specialty modes without builder migration',()=>{
 const items=[{id:'home',label:'首页'},{id:'services',label:'服务'}];assert.equal(configuredNavigation({slug:'fu-junfen'},items),items);assert.equal(usesTangRecords({slug:'tang-jinsong'}),true);assert.equal(voiceEnabled({slug:'tang-jinsong'}),true);assert.equal(usesWellness({slug:'yu-wen'}),true);assert.equal(voiceEnabled({slug:'fu-junfen'}),false);
});
test('disabled health sharing and voice override slug privileges while reminders use actual record coverage',()=>{
 const custom={slug:'tang-jinsong',builder:{...builder,voice:{...builder.voice,enabled:false},healthContext:false}};assert.equal(healthContextEnabled(custom),false);assert.equal(voiceEnabled(custom),false);assert.equal(usesTangRecords(custom),false);assert.match(realHealthReminder(0,false),/还没有近期/);assert.match(realHealthReminder(2,false),/2 天/);assert.match(realHealthReminder(2,true),/今天已有/);assert.doesNotMatch(realHealthReminder(0,false),/21|28|进入.*阶段/);
});
test('private full draft parsing uses draft config and draft content; public parser still excludes draft content',()=>{
 const preview=parseDraftDoctorDetail({preview:true,draftHash:'hash-a',agent:{slug:'new-specialist',name:'草稿医生',builder,config:{welcomeMessage:'草稿欢迎',requireCitations:false,healthContextEnabled:false}},contents:[{id:'draft-1',title:'未发布文章',type:'article',body:'完整草稿正文',status:'draft'}]});
 assert.equal(preview.preview,true);assert.equal(preview.draftHash,'hash-a');assert.equal(preview.welcomeMessage,'草稿欢迎');assert.equal(preview.citationsEnabled,false);assert.equal(preview.healthContextEnabled,false);assert.equal(preview.content[0].body,'完整草稿正文');assert.equal(preview.builder.recordFields[0].key,'pain');
 assert.equal(parsePublicDoctorDetail({slug:'published',name:'公开医生',content:[{id:'draft-1',title:'未发布文章',type:'article',body:'private',status:'draft'}]}).content.length,0);assert.throws(()=>parseDraftDoctorDetail({agent:{slug:'published',name:'公开医生'}}),/草稿预览数据无效/);
});
function assessmentFixture(profile=doctor){
 const values=new Map(),events=[],account={user:null};let definition,canEdit=true,confirmCallback;
 const runtime={session:{get:()=>account},subscribe:()=>()=>{},storageNotice:()=>'',data:{getVisitorId:()=> 'visitor',get:(slug,section,fallback)=>({value:values.get((account.user?.id||'guest')+':'+slug+':'+section)||fallback,canEdit}),set:(slug,section,value)=>{if(!canEdit)return false;values.set((account.user?.id||'guest')+':'+slug+':'+section,value);return true;},retry(){}}};
 const wx={showModal(options){confirmCallback=options.success;}};
 vm.runInNewContext(fs.readFileSync(path.join(nativeRoot,'components/assessments/index.js'),'utf8'),{require:specifier=>specifier.includes('catalog')?{builderLayoutClass,canWriteBuilderData}:{getRuntime:()=>runtime},Component:value=>{definition=value;},wx,Date,Math});
 const data={...JSON.parse(JSON.stringify(definition.data)),doctor:profile},instance={properties:{doctor:profile},data,setData(patch){Object.assign(data,patch);},triggerEvent(name,detail){events.push({name,detail});}};
 for(const [name,method] of Object.entries(definition.methods))instance[name]=method.bind(instance);definition.lifetimes.attached.call(instance);
 return {instance,values,events,account,editable:value=>{canEdit=value;instance.refresh();},confirm:()=>confirmCallback({confirm:true})};
}
const event=id=>({currentTarget:{dataset:{id}}});
test('native configurable assessments require every answer, save real zero values and share only on explicit action',()=>{
 const f=assessmentFixture(),c=f.instance;c.open(event('check'));c.save();assert.equal(f.values.size,0);assert.match(c.data.notice,/完成所有/);c.answer({...event('q1'),detail:{value:'0'}});c.answer({...event('q2'),detail:{value:'1'}});c.save();const saved=[...f.values.values()][0].results[0];assert.equal(saved.score,3);assert.deepEqual([...saved.answers],[0,3]);assert.equal(f.events.length,0);c.ask(event(saved.id));assert.equal(f.events.length,1);assert.match(f.events[0].detail.question,/总分3/);
});
test('native configurable assessments keep account drafts isolated and reject blocked writes and stale confirmations',async()=>{
 const f=assessmentFixture(),c=f.instance;c.open(event('check'));c.answer({...event('q1'),detail:{value:'1'}});c.answer({...event('q2'),detail:{value:'1'}});f.editable(false);c.save();assert.equal(f.values.size,0);f.editable(true);c.save();const id=c.data.results[0].id;const pending=c.remove(event(id));f.account.user={id:'another-user'};c.refresh();assert.equal(c.data.active,null);assert.equal(c.data.results.length,0);f.confirm();await pending;assert.equal([...f.values.values()][0].results.length,1);
});

test('custom peak-flow survives validation, save, JSON refresh, statistics, report and consented health payload',()=>{
 const reference=new Date('2026-10-23T04:00:00Z'),config={title:'呼吸记录',description:'实际测量',fields:[{key:'peak-flow',label:'呼气峰流量',unit:'L/min',min:0,max:1000,step:1}]};
 const validated=validateSpecialtyRecordInput({'peak-flow':'0'},config,'2026-10-23',reference);assert.deepEqual(validated.errors,{});
 const saved=saveSpecialtyRecord([],{id:'peak1',source:'manage',dateKey:'2026-10-23',createdAt:reference.toISOString(),completedTitles:[],measurements:validated.measurements},undefined,reference,config);assert.equal(saved.error,undefined);
 const refreshed=normalizeHealthRecords(JSON.parse(JSON.stringify(saved.records)),config);assert.equal(refreshed[0].measurements['peak-flow'],0);assert.match(formatHealthMetricsSummary(refreshed[0],config),/呼气峰流量 0 L\/min/);assert.equal(buildSpecialtyStats(refreshed,config,7,reference).fields[0].latest,0);
 const review=buildSpecialtyRecordReview({name:'呼吸医生'},config,refreshed,7,reference);assert.match(review.summary,/呼气峰流量/);
 const payload=buildHealthContextPayload(refreshed,reference,config);assert.equal(payload.consent,true);assert.equal(payload.records[0].measurements['peak-flow'],0);assert.equal(buildHealthContextPayload(refreshed,reference).records[0].measurements,undefined);
});

test('typed text and select records survive refresh and never enter numerical averages',()=>{
 const config={title:'健康记录',description:'记录',fields:[{key:'temperature',label:'体温',type:'number',group:'测量',unit:'℃',min:0,max:60,step:0.1},{key:'feeling',label:'感受',type:'text',group:'日常',unit:'',min:0,max:0,step:1},{key:'status',label:'状态',type:'select',group:'日常',options:['稳定','加重'],unit:'',min:0,max:0,step:1}]};
 const reference=new Date('2026-10-23T04:00:00Z'),valid=validateSpecialtyRecordInput({temperature:'0',feeling:'如实记录',status:'稳定'},config,'2026-10-23',reference);assert.deepEqual(valid.errors,{});assert.deepEqual(valid.measurements,{temperature:0});assert.deepEqual(valid.values,{feeling:'如实记录',status:'稳定'});const saved=saveSpecialtyRecord([],{id:'typed1',source:'manage',dateKey:'2026-10-23',createdAt:reference.toISOString(),completedTitles:[],measurements:valid.measurements,values:valid.values},undefined,reference,config).records;const refreshed=normalizeHealthRecords(JSON.parse(JSON.stringify(saved)),config);assert.equal(refreshed[0].values.status,'稳定');assert.deepEqual(buildSpecialtyStats(refreshed,config,7,reference).fields.map(field=>field.key),['temperature']);assert.match(formatHealthMetricsSummary(refreshed[0],config),/感受 如实记录/);assert.match(validateSpecialtyRecordInput({status:'invalid'},config,'2026-10-23',reference).errors.status,/有效/);
});
test('service dependencies, required fields and completion rules preserve values and cascade reversible steps',()=>{
 const definition={id:'prepare',title:'准备',completionRule:'all-required',steps:[{id:'first',title:'整理报告',required:true,fields:[{key:'report',label:'报告日期',type:'text',required:true}]},{id:'next',title:'确认问题',required:true,dependsOn:['first'],fields:[{key:'count',label:'问题数',type:'number',required:true}]},{id:'optional',title:'补充',required:false}]};
 let plan={id:'prepare',service:'准备',completed:[],note:'',targetDate:'',updatedAt:'2026-10-23T04:00:00Z'};assert.equal(serviceProgress(definition,plan).steps[1].blocked,true);assert.deepEqual(toggleServiceProgress(definition,plan,'next',true),[]);plan={...plan,completed:toggleServiceProgress(definition,plan,'first',true)};assert.match(serviceProgress(definition,plan).issues[0],/报告日期/);plan={...plan,values:{first:{report:'10月23日'},next:{count:0}}};plan.completed=toggleServiceProgress(definition,plan,'next',true);assert.equal(serviceProgress(definition,plan).completed,true);assert.equal(serviceProgress({...definition,completionRule:'all-steps'},plan).completed,false);const refreshed=normalizeServicePlans({version:1,plans:[JSON.parse(JSON.stringify(plan))]}).plans[0];assert.equal(refreshed.values.next.count,0);assert.match(buildServicePlanSummary('医生',refreshed,definition),/报告日期：10月23日/);assert.deepEqual(toggleServiceProgress(definition,plan,'first',false),[]);
});
test('layout and data permissions keep default access while readonly assessments retain historical snapshots',()=>{
 assert.equal(canWriteBuilderData(doctor,'records'),true);assert.equal(builderLayoutClass({slug:'legacy'}),'');const custom={...doctor,builder:{...builder,layout:{density:'compact',cards:'list'},dataPermissions:{records:'read-only',assessments:'read-only',services:'read-only'}}};assert.match(builderLayoutClass(custom),/builder-density-compact builder-cards-list/);assert.equal(canWriteBuilderData(custom,'records'),false);const f=assessmentFixture(custom),c=f.instance;c.open(event('check'));c.answer({...event('q1'),detail:{value:'1'}});c.answer({...event('q2'),detail:{value:'1'}});c.save();assert.equal(f.values.size,0);assert.equal(c.data.canEdit,false);assert.equal(c.data.canDelete,true);
});
test('native result bands save source and version with outcome instead of relabeling older scores',()=>{
 const custom={...doctor,builder:{...builder,assessments:builder.assessments.map(item=>({...item,source:'院内审核题库',version:'v2',resultBands:[{min:0,max:2,label:'持续观察',description:'记录日常变化'},{min:3,max:5,label:'建议沟通',description:'向专业人员进一步了解'}]}))}};
 const f=assessmentFixture(custom),c=f.instance;c.open(event('check'));c.answer({...event('q1'),detail:{value:'0'}});c.answer({...event('q2'),detail:{value:'1'}});c.save();const saved=[...f.values.values()][0].results[0];assert.equal(saved.source,'院内审核题库');assert.equal(saved.definitionVersion,'v2');assert.equal(saved.resultLabel,'建议沟通');assert.equal(saved.resultDescription,'向专业人员进一步了解');custom.builder.assessments[0].version='v3';c.refresh();assert.equal(c.data.results[0].definitionVersion,'v2');
});

test('template preview requires admin session and short-lived matching payload, forcing isolated readonly scope',()=>{const at=Date.now(),payload={preview:true,templateId:'template-one',agent:{slug:'fu-junfen',name:'模板医生',builder},contents:[]};const stored=JSON.stringify({payload,ownerId:'admin-id',expiresAt:at+600000});assert.throws(()=>parseTemplatePreviewDetail('template-one',null,stored,at));assert.throws(()=>parseTemplatePreviewDetail('other',{user:{}},stored,at));assert.throws(()=>parseTemplatePreviewDetail('template-one',{user:{id:'admin-id'}},stored,at+600001));assert.throws(()=>parseTemplatePreviewDetail('template-one',{user:{}},JSON.stringify({payload,expiresAt:at+600001}),at));assert.throws(()=>parseTemplatePreviewDetail('template-one',{user:{id:'other-account'}},stored,at));const result=parseTemplatePreviewDetail('template-one',{user:{id:'admin-id',username:'admin'}},stored,at);assert.equal(result.slug,'template~template-one');assert.equal(result.builder.voice.enabled,false);assert.equal(result.builder.dataPermissions.records,'read-only');assert.equal(result.builder.dataPermissions.services,'read-only');assert.equal(result.builder.dataPermissions.assessments,'read-only');});
test('server managed portrait URLs accept safe media identifiers and reject unsafe schemes or traversal',()=>{assert.equal(safePortraitUrl('/media/avatars/'+'a'.repeat(24)),'/media/avatars/'+'a'.repeat(24));assert.equal(safePortraitUrl('/media/avatars/not-id'),undefined);assert.equal(safePortraitUrl('/assets/../secret'),undefined);assert.equal(safePortraitUrl('javascript:alert(1)'),undefined);assert.equal(safePortraitUrl('https://user:pass@example.com/photo'),undefined);assert.equal(safePortraitUrl('https://example.com/photo'),'https://example.com/photo');});
