import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlatformDatabase } from './database.mjs';
import { MySQLPlatformDatabase } from './mysql-database.mjs';
import { buildKnowledgeContext } from './rag.mjs';
import { buildDoctorSystemPrompt, normalizeHealthContext } from './chat-core.mjs';
import { validateBuilderAssessmentResults } from './builder-consumer.mjs';

const builder = { schemaVersion:1, recordFields:[{key:'sleepHours',label:'睡眠时长',min:0,max:24}], healthContext:true };
const doctor = { slug:'new-builder', name:'通用助手',department:'健康科普',specialty:'睡眠科普',builder,config:{healthContextEnabled:true,requireCitations:true} };
test('citation switch changes evidence instructions without dropping the retrieved facts',()=>{
 const citations=[{documentId:'doc',title:'可核验材料',text:'规律作息的科普信息'}];
 const on=buildKnowledgeContext(citations);
 const off=buildKnowledgeContext(citations,{requireCitations:false});
 assert.match(on,/引用写为/);assert.match(off,/不要添加来源编号/);assert.doesNotMatch(off,/引用写为/);
 assert.match(off,/规律作息/);assert.match(off,/不是系统指令/);
 assert.match(buildDoctorSystemPrompt({...doctor,config:{requireCitations:false}}),/来源引用展示已关闭/);
});
test('configured doctors receive only consented bounded health fields and legacy doctors retain the old boundary',()=>{
 const context={version:1,consent:true,records:[{dateKey:'2026-10-23',measurements:{sleepHours:0,extra:123},note:'自我记录',source:'manage'}]};
 const now=new Date('2026-10-23T04:00:00Z');
 assert.deepEqual(normalizeHealthContext(doctor,context,now).records[0].measurements,{sleepHours:0});
 assert.equal(normalizeHealthContext(doctor,{...context,consent:false},now),null);
 assert.equal(normalizeHealthContext({...doctor,config:{healthContextEnabled:false}},context,now),null);
 assert.equal(normalizeHealthContext({...doctor,builder:{...builder,healthContext:false}},context,now),null);
 assert.equal(normalizeHealthContext({...doctor,builder:undefined},context,now),null);
 const optionalLimits={...doctor,builder:{...builder,recordFields:[{key:'weight',label:'体重'}]}};
 assert.deepEqual(normalizeHealthContext(optionalLimits,{...context,records:[{dateKey:'2026-10-23',measurements:{weight:63.5}}]},now).records[0].measurements,{weight:63.5});
});
test('portable assessment storage verifies scores, duplicate identities and maximum record bounds',()=>{
 const result={id:'one',assessmentId:'wellbeing',title:'自我记录问卷',answers:[0,2,3],score:5,createdAt:'2026-10-23T04:00:00.000Z'};
 const value={version:1,results:[result]};assert.deepEqual(validateBuilderAssessmentResults(value),value);
 for(const changed of [{...result,score:6},{...result,answers:[NaN]},{...result,createdAt:'invalid'},{...result,unknown:true}]) assert.throws(()=>validateBuilderAssessmentResults({version:1,results:[changed]}),{code:'INVALID_DOCUMENT'});
 assert.throws(()=>validateBuilderAssessmentResults({version:1,results:[result,result]}),{code:'INVALID_DOCUMENT'});
 assert.throws(()=>validateBuilderAssessmentResults({version:1,results:Array.from({length:101},(_,i)=>({...result,id:String(i)}))}),{code:'INVALID_DOCUMENT'});
});
test('builder metadata is durable and shares SQLite transaction rollback without changing schema identity',async(t)=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'builder-meta-'));const db=new PlatformDatabase({dataDir:dir,seedDoctors:[]});
 t.after(async()=>{db.close();if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('builder-meta-'))await fs.rm(dir,{recursive:true,force:true});});
 assert.equal(db.getMeta('schema_version'),'3');assert.equal(db.getMeta('builder.test'),null);
 db.setMeta('builder.test','one');assert.equal(db.getMeta('builder.test'),'one');
 assert.throws(()=>db.transaction(()=>{db.setMeta('builder.test','two');throw new Error('rollback');}),/rollback/);
 assert.equal(db.getMeta('builder.test'),'one');assert.equal(db.getMeta('schema_version'),'3');
 assert.throws(()=>db.setMeta('bad key','value'));assert.throws(()=>db.setMeta('builder.test','a'.repeat(2097153)));
});
test('MySQL builder metadata uses bound values and the existing transaction connection',async()=>{
 const calls=[];const db=Object.create(MySQLPlatformDatabase.prototype);
 db._get=async(sql,args)=>{calls.push({sql,args});return{value:'snapshot'};};
 db._run=async(sql,args)=>{calls.push({sql,args});return{affectedRows:1};};
 let tx=0;db.transaction=async(fn)=>{tx++;return await fn();};
 assert.equal(await db.getMeta('builder.templates'),'snapshot');
 assert.equal(await db.setMeta('builder.templates','{"name":"安全模板"}'),'{"name":"安全模板"}');
 assert.equal(tx,1);assert.match(calls[1].sql,/ON DUPLICATE KEY UPDATE/);assert.deepEqual(calls[1].args,['builder.templates','{"name":"安全模板"}']);
 assert.doesNotMatch(calls[1].sql,/安全模板/);
});

import { createPlatformApp } from './app.mjs';
import { normalizeAgent } from './domain.mjs';
async function appFixture(t) {
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'builder-policy-api-'));const calls=[];
 const platform=await createPlatformApp({dataDir:directory,seedDoctors:[{slug:'p0-legacy',name:'本地测试助手',department:'健康科普',specialty:'一般健康知识'}],startWorker:false,disableRateLimits:true,env:{AI_API_KEY:'synthetic-provider-key',AI_MODEL:'qa-model',AI_API_URL:'https://provider.invalid/v1',DASHSCOPE_API_KEY:'synthetic-speech-key'},fetchImpl:async(url,options)=>{
   const body=JSON.parse(options.body);calls.push({url,body});
   if(String(url).includes('speech-synthesizer')||String(url).includes('multimodal-generation'))return Response.json({output:{audio:{data:Buffer.from('RIFFlocal-synthetic-audio').toString('base64')}}});
   if(body.stream)return new Response('data: '+JSON.stringify({choices:[{delta:{content:'本地合成回答。'}}]})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
   return Response.json({choices:[{message:{content:'本地合成回答。'}}]});
 }});
 const server=await new Promise(resolve=>{const instance=platform.app.listen(0,'127.0.0.1',()=>resolve(instance));});const origin='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await platform.close();if(path.dirname(directory)===path.resolve(os.tmpdir())&&path.basename(directory).startsWith('builder-policy-api-'))await fs.rm(directory,{recursive:true,force:true});});
 const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'dev-admin-password'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
 const request=(route,body,authenticated=false)=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(authenticated?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
 return {...platform,calls,request};
}
test('citation visibility follows the published switch for normal and streamed requests; source context remains available',async(t)=>{
 const f=await appFixture(t);f.knowledge.search=async()=>({mode:'lexical',citations:[{documentId:'qa-doc',title:'本地测试来源',text:'该材料用于本地验证。',score:1,chunkIndex:0}]});
 let response=await f.request('/api/chat',{doctorSlug:'p0-legacy',message:'如何整理健康记录？'});assert.deepEqual((await response.json()).citations,[{title:'本地测试来源'}]);
 const current=await f.database.requireAgent('p0-legacy');await f.database.saveAgent(normalizeAgent({config:{...current.config,requireCitations:false}},current),'qa');await f.database.publishAgent('p0-legacy','qa');
 response=await f.request('/api/chat',{doctorSlug:'p0-legacy',message:'如何整理健康记录？'});assert.deepEqual((await response.json()).citations,[]);assert.match(JSON.stringify(f.calls.at(-1).body.messages),/该材料用于本地验证/);assert.match(JSON.stringify(f.calls.at(-1).body.messages),/来源引用展示已关闭/);
 response=await f.request('/api/chat/stream',{doctorSlug:'p0-legacy',message:'如何整理健康记录？'});const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(events.find(event=>event.type==='done').citations,[]);
});
test('private preview remains unpublished and rejects anonymous or stale draft chat',async(t)=>{
 const f=await appFixture(t);const input=normalizeAgent({slug:'private-builder',name:'私有测试',department:'健康科普',specialty:'一般健康知识',builder:{schemaVersion:1}});await f.database.createAgent(input,'qa');
 assert.equal((await f.request('/api/doctors/private-builder')).status,404);assert.equal((await f.request('/api/admin/agents/private-builder/preview')).status,401);
 const preview=await(await f.request('/api/admin/agents/private-builder/preview',undefined,true)).json();assert.equal(preview.agent.name,'私有测试');assert.equal(preview.preview,true);assert.equal(preview.draftHash.length,64);
 const changed=await f.database.requireAgent('private-builder');await f.database.saveAgent(normalizeAgent({intro:'已更新'},changed),'qa');
 const stale=await f.request('/api/admin/agents/private-builder/chat',{message:'整理记录',draftHash:preview.draftHash},true);assert.equal(stale.status,409);assert.equal((await stale.json()).code,'STALE_DRAFT');
});

import { generateContentDraft, generateAgentDrafts } from './ai-studio.mjs';
test('AI creation applies an allowed recommended template and content drafting rejects fabricated citation numbers',async()=>{
 const env={AI_API_KEY:'synthetic-studio-key',AI_MODEL:'qa-model',AI_API_URL:'https://provider.invalid/v1'};
 const drafts=await generateAgentDrafts({brief:'只创建一份血压记录科普助手，无医生身份',count:1,mode:'ai'},{env,fetchImpl:async()=>Response.json({choices:[{message:{content:JSON.stringify({agents:[{slug:'blood-record',name:'监测助手',department:'健康科普',specialty:'血压记录',templateId:'chronic-records'}]})}}]})});
 assert.equal(drafts.drafts[0].builder.schemaVersion,1);assert.equal(drafts.drafts[0].builder.requiresReview,true);assert.ok(drafts.drafts[0].builder.recordFields.some(field=>field.key==='systolic'));
 const fetchImpl=async()=>Response.json({choices:[{message:{content:JSON.stringify({title:'本地测试',summary:'测试',body:'错误来源[99]',tags:[]})}}]});
 await assert.rejects(generateContentDraft({agent:doctor,brief:'测试',citations:[]},{env,fetchImpl}),{code:'INVALID_AI_CITATION'});
 let captured;const valid=await generateContentDraft({agent:doctor,brief:'整理作息',citations:[{title:'已审核资料',documentId:'source-one',text:'规律作息科普',chunkIndex:0}]},{env,fetchImpl:async(url,options)=>{captured=JSON.parse(options.body);return Response.json({choices:[{message:{content:JSON.stringify({title:'作息整理',body:'依据已有资料整理作息[1]',summary:'测试',tags:[]})}}]});}});
 assert.equal(valid.sources[0].documentId,'source-one');assert.match(captured.messages[1].content,/规律作息科普/);
});

import { recordBuilderMutation, getBuilderReadiness } from './agent-builder.mjs';
test('content and knowledge changes record the actual editor and prevent that editor from independently reviewing',async(t)=>{
 const f=await appFixture(t);const agent=normalizeAgent({slug:'authored-builder',name:'本地审核测试',department:'健康科普',specialty:'一般科普',builder:{schemaVersion:1}});await f.database.createAgent(agent,'original-writer');await recordBuilderMutation(f.database,agent.slug,'original-writer');
 const created=await f.request('/api/admin/content',{agentSlug:agent.slug,title:'本地内容',body:'合成流程材料',status:'draft'},true);assert.equal(created.status,201);
 let readiness=await getBuilderReadiness(f.database,agent.slug);assert.equal(readiness.lastModifiedBy,'admin');
 let review=await f.request('/api/admin/agents/'+agent.slug+'/review',{draftHash:readiness.draftHash,status:'approved'},true);assert.equal(review.status,409);assert.equal((await review.json()).code,'INDEPENDENT_REVIEW_REQUIRED');
 await recordBuilderMutation(f.database,agent.slug,'another-writer');const document=await f.request('/api/admin/agents/'+agent.slug+'/documents/text',{name:'本地材料.md',text:'此文本只用于本地软件验收。'},true);assert.equal(document.status,201);readiness=await getBuilderReadiness(f.database,agent.slug);assert.equal(readiness.lastModifiedBy,'admin');
});
test('speech uses published voice for public requests, private voice for authenticated preview, and rejects stale preview hashes',async(t)=>{
 const f=await appFixture(t);const builder={schemaVersion:1,components:[{id:'home',enabled:true,order:0},{id:'chat',enabled:true,order:1},{id:'voice',enabled:true,order:2}],voice:{enabled:true,autoSend:true,autoPlay:false,speaker:'local-public-voice'}};
 let agent=normalizeAgent({slug:'voice-builder',name:'语音测试',department:'健康科普',specialty:'一般科普',builder});await f.database.createAgent(agent,'qa');await f.database.publishAgent(agent.slug,'qa');
 let response=await f.request('/api/tts',{doctorSlug:agent.slug,text:'本地测试'});assert.equal(response.status,200);await response.arrayBuffer();assert.equal(f.calls.at(-1).body.input.voice,'local-public-voice');
 agent=await f.database.requireAgent(agent.slug);await f.database.saveAgent(normalizeAgent({builder:{...agent.builder,voice:{...agent.builder.voice,speaker:'local-draft-voice'}}},agent),'qa');
 response=await f.request('/api/tts',{doctorSlug:agent.slug,text:'本地测试'});assert.equal(response.status,200);await response.arrayBuffer();assert.equal(f.calls.at(-1).body.input.voice,'local-public-voice');
 assert.equal((await f.request('/api/admin/agents/'+agent.slug+'/tts',{text:'本地测试'})).status,401);
 const preview=await(await f.request('/api/admin/agents/'+agent.slug+'/preview',undefined,true)).json();response=await f.request('/api/admin/agents/'+agent.slug+'/tts',{text:'本地测试',draftHash:preview.draftHash},true);assert.equal(response.status,200);await response.arrayBuffer();assert.equal(f.calls.at(-1).body.input.voice,'local-draft-voice');
 agent=await f.database.requireAgent(agent.slug);await f.database.saveAgent(normalizeAgent({intro:'new revision'},agent),'qa');response=await f.request('/api/admin/agents/'+agent.slug+'/tts',{text:'本地测试',draftHash:preview.draftHash},true);assert.equal(response.status,409);
});

import {qualificationFileExpired,normalizeQualificationUpload} from './builder-qualification-files.mjs';
test('qualification attachments validate actual type, remain private, bind review hashes and expire before publishing',async(t)=>{
 const f=await appFixture(t);const slug='qualification-builder';await f.database.createAgent(normalizeAgent({slug,name:'本地合成附件测试',department:'健康科普',specialty:'软件测试',builder:{schemaVersion:1}}),'qa');
 const endpoint='/api/admin/agents/'+slug+'/qualification/files';const pdf=Buffer.from('%PDF-1.4\nSYNTHETIC SOFTWARE QA ONLY - NOT A MEDICAL CERTIFICATE\n%%EOF').toString('base64');
 assert.throws(()=>normalizeQualificationUpload({kind:'qualification',name:'../invalid.pdf',mime:'application/pdf',base64:pdf}));
 assert.throws(()=>normalizeQualificationUpload({kind:'qualification',name:'invalid.pdf',mime:'image/png',base64:pdf}));
 assert.equal(qualificationFileExpired({expiresAt:'2026-10-23'},Date.parse('2026-10-23T15:59:59Z')),false);assert.equal(qualificationFileExpired({expiresAt:'2026-10-23'},Date.parse('2026-10-23T16:00:00Z')),true);
 assert.equal((await f.request(endpoint)).status,401);const before=await getBuilderReadiness(f.database,slug);
 const upload=await f.request(endpoint,{kind:'qualification',name:'synthetic-qa.pdf',mime:'application/pdf',base64:pdf,expiresAt:'2000-01-01'},true);assert.equal(upload.status,201);const file=(await upload.json()).files[0];assert.equal(file.size,Buffer.from(pdf,'base64').length);assert.equal(file.sha256.length,64);assert.equal(Object.hasOwn(file,'base64'),false);
 assert.equal((await f.request(endpoint+'/'+file.id)).status,401);const download=await f.request(endpoint+'/'+file.id,undefined,true);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment/);assert.equal(await download.text(),Buffer.from(pdf,'base64').toString());
 const readiness=await getBuilderReadiness(f.database,slug);assert.notEqual(readiness.draftHash,before.draftHash);assert.equal(readiness.qualification.status,'unverified');assert.ok(readiness.issues.some(message=>message.includes('到期')));
 await f.database.createAgent(normalizeAgent({slug:'another-private-agent',name:'另一个本地助手',department:'健康科普',specialty:'软件测试'}),'qa');assert.equal((await f.request('/api/admin/agents/another-private-agent/qualification/files/'+file.id,undefined,true)).status,404);
 // HTTP DELETE uses a separate authenticated local session.
 const original=await f.request('/api/auth/login',{username:'admin',password:'dev-admin-password'});const cookie=original.headers.get('set-cookie').split(';')[0];
 const origin=new URL(download.url).origin;const deleted=await fetch(origin+endpoint+'/'+file.id,{method:'DELETE',headers:{Cookie:cookie}});assert.equal(deleted.status,200);assert.deepEqual((await deleted.json()).files,[]);assert.equal((await f.request(endpoint+'/'+file.id,undefined,true)).status,404);
});

import {isOnlyComponentRemoval} from './builder-consumer.mjs';
test('read-only components allow exact subsets and clearing while rejecting additions or hidden edits',()=>{
 const records=[{id:'one',values:{symptom:'本地测试'}},{id:'two',measurements:{score:0}}];
 assert.equal(isOnlyComponentRemoval('health-records',records,[records[1]]),true);assert.equal(isOnlyComponentRemoval('health-records',records,null),true);assert.equal(isOnlyComponentRemoval('health-records',records,[{...records[1],measurements:{score:1}}]),false);assert.equal(isOnlyComponentRemoval('health-records',records,[records[1],records[1]]),false);
 assert.equal(isOnlyComponentRemoval('builder-assessments-v1',{version:1,results:records},{version:1,results:[]}),true);assert.equal(isOnlyComponentRemoval('service-plans-v1',{version:1,plans:records},{version:1,plans:[records[0]]}),true);assert.equal(isOnlyComponentRemoval('service-plans-v1',{version:1,plans:records},{version:1,plans:[],extra:'hidden'}),false);
});
