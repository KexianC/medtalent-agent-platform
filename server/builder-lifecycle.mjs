import {randomUUID} from "node:crypto";
import {normalizeAgent,PlatformError,validateSlug,textField,now} from "./domain.mjs";
import {getBuilderReadiness,recordBuilderMutation,assertBuilderPublishable,materializeLegacyBuilder} from "./agent-builder.mjs";
import {fieldDiff,getBuilderCompatibility,exportConfigurationPackage as exportPortableConfiguration,inspectConfigurationPackage,deidentifiedAgent} from "./builder-lifecycle-schema.mjs";
import {reviseAgentBuilderPlan} from "./ai-studio.mjs";
const clone=value=>structuredClone(value);
const fail=(message,status=400,code="INVALID_BUILDER_LIFECYCLE")=>{throw new PlatformError(message,status,code)};
const strict=(input,keys)=>{if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))fail("请求字段或格式无效。");return input};
const stored=(raw,fallback)=>{if(raw===null||raw===undefined)return clone(fallback);try{return JSON.parse(raw)}catch{fail("构建生命周期存储格式异常。",503,"BUILDER_STORAGE_INVALID")}};
export async function withAgentDraftHash(database,agent,knowledge){return {...(knowledge?knowledge.publicAgent(agent):agent),draftHash:(await getBuilderReadiness(database,agent.slug)).draftHash}}
export async function assertExpectedDraftHash(database,slug,expected,{allowLegacyMissingHash=false}={}){
 const readiness=await getBuilderReadiness(database,validateSlug(slug));
 if(expected===undefined&&allowLegacyMissingHash)return readiness;
 if(expected===undefined)fail("请先读取当前草稿版本后再保存。",428,"DRAFT_HASH_REQUIRED");
 if(typeof expected!=="string"||!/^[a-f0-9]{64}$/.test(expected))fail("草稿版本格式无效。",400,"INVALID_DRAFT_HASH");
 if(expected!==readiness.draftHash){const error=new PlatformError("其他编辑者或关联资料已更新草稿，请比较差异后重新保存。",409,"DRAFT_CONFLICT");error.currentDraftHash=readiness.draftHash;error.currentVersion=(await database.requireAgent(slug)).version;throw error}
 return readiness;
}
export async function saveAgentWithCAS(database,slug,input,actor,{allowLegacyMissingHash=true}={}){
 if(!input||typeof input!=="object"||Array.isArray(input))fail("智能体资料格式无效。");
 return database.transaction(async()=>{
  await assertExpectedDraftHash(database,slug,input.expectedDraftHash,{allowLegacyMissingHash});
  const existing=await database.requireAgent(slug),agent=await database.saveAgent(normalizeAgent(input,existing),actor);
  await recordBuilderMutation(database,slug,actor);return agent;
 });
}
export async function getAgentFieldDiff(database,slug,against="published"){
 return database.transaction(async()=>{
  const current=await database.requireAgent(validateSlug(slug));let base;
  if(against==="published")base=await database.getAgent(slug,true);
  else if(/^[1-9]\d*$/.test(String(against))&&typeof database.getAgentVersionSnapshot==="function")base=await database.getAgentVersionSnapshot(slug,Number(against));
  else fail("请选择已发布版本或有效历史版本。");
  if(!base)fail("所选对比版本不存在。",404,"VERSION_NOT_FOUND");
  const before=normalizeAgent(base),after=normalizeAgent(current);
  return {base:against,draftHash:(await getBuilderReadiness(database,slug)).draftHash,changes:fieldDiff(before,after)};
 });
}
const PATCH_KEYS=["name","hospital","department","specialty","title","intro","accent","accentSoft","quickQuestions","topics","services","config","builder"];
export async function bulkMutateAgents(database,input,actor,{authorize,publish}={}){
 strict(input,["action","items"]);
 if(!["edit","publish","archive"].includes(input.action)||!Array.isArray(input.items)||!input.items.length||input.items.length>50)fail("一次可操作1—50个智能体，请选择有效操作。");
 const slugs=input.items.map(item=>validateSlug(item?.slug));if(new Set(slugs).size!==slugs.length)fail("批量请求不能重复选择同一智能体。");
 const results=[];
 for(const item of input.items){
  try{
   strict(item,["slug","expectedDraftHash","patch"]);
   if(authorize)await authorize(item.slug,input.action);
   const agent=await database.transaction(async()=>{
    await assertExpectedDraftHash(database,item.slug,item.expectedDraftHash);
    if(input.action==="edit"){strict(item.patch,PATCH_KEYS);return saveAgentWithCAS(database,item.slug,{...item.patch,expectedDraftHash:item.expectedDraftHash},actor,{allowLegacyMissingHash:false})}
    if(item.patch!==undefined)fail("发布或归档不接受编辑补丁。");
    if(input.action==="archive")return database.archiveAgent(item.slug,actor);
    if(publish)return publish(item.slug,actor);
    await assertBuilderPublishable(database,item.slug);return database.publishAgent(item.slug,actor);
   });
   results.push({slug:item.slug,ok:true,agent,draftHash:(await getBuilderReadiness(database,item.slug)).draftHash});
  }catch(error){results.push({slug:item.slug,ok:false,error:error.statusCode?error.message:"该项处理失败，请稍后重试。",code:error.code||"ITEM_FAILED",...(error.currentDraftHash?{currentDraftHash:error.currentDraftHash}:{})})}
 }
 return {results,succeeded:results.filter(item=>item.ok).length,failed:results.filter(item=>!item.ok).length};
}
export async function importConfigurationPackage(database,input,actor,env={}){
 strict(input,["package","slug","name","hospital"]);
 const inspected=inspectConfigurationPackage(input.package),safe=deidentifiedAgent(inspected.agent,env),slug=validateSlug(input.slug),name=textField(input.name,"智能体名称",{required:true,max:80});
 const config=Object.fromEntries(Object.entries(safe.config).map(([key,value])=>[key,typeof value==="string"?value.split(safe.name).join(name):value]));
 return database.transaction(async()=>{const agent=await database.createAgent(normalizeAgent({...safe,slug,name,hospital:textField(input.hospital,"机构名称",{max:200}),config,builder:{...safe.builder,requiresReview:true}}),actor);await recordBuilderMutation(database,slug,actor);await database.audit("agent.configuration_import",actor,slug,{packageSha256:input.package.sha256});return agent});
}
const SESSION_INDEX="builder.sessions.v1";
const sessionKey=id=>{if(typeof id!=="string"||!/^[a-f0-9-]{36}$/.test(id))fail("搭建会话不存在。",404,"BUILDER_SESSION_NOT_FOUND");return "builder.session."+id};
function checkSessionOwner(session,actor,admin){if(!session||(!admin&&session.createdBy!==actor))fail("搭建会话不存在或无权访问。",404,"BUILDER_SESSION_NOT_FOUND");return session}
export async function getBuilderSession(database,id,actor,{admin=false}={}){const session=checkSessionOwner(stored(await database.getMeta(sessionKey(id)),null),actor,admin);if(session.agentSlug)await database.requireAgent(session.agentSlug);return session}
export async function listBuilderSessions(database,actor,{admin=false}={}){
 const index=stored(await database.getMeta(SESSION_INDEX),[]),sessions=[];
 for(const id of index){const session=stored(await database.getMeta(sessionKey(id)),null);if(session&&(admin||session.createdBy===actor)&&(!session.agentSlug||!database.scopeAllowsAgent||database.scopeAllowsAgent(session.agentSlug)))sessions.push(session)}
 return sessions.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
const messageRecord=(role,text)=>({id:randomUUID(),role,text,createdAt:now()});
export async function createBuilderSession(database,input,actor,options={}){
 strict(input,["message","agentSlug"]);
 let draft=null,baseDraftHash=null,agentSlug=null;
 if(input.agentSlug){agentSlug=validateSlug(input.agentSlug);const capture=await database.transaction(async()=>({agent:await database.requireAgent(agentSlug),state:await getBuilderReadiness(database,agentSlug)}));draft=options.knowledge?options.knowledge.publicAgent(capture.agent):capture.agent;baseDraftHash=capture.state.draftHash}
 const message=textField(input.message,"搭建需求",{required:true,max:8000}),answer=await reviseAgentBuilderPlan({draft,messages:[],message},options);
 return database.transaction(async()=>{const index=stored(await database.getMeta(SESSION_INDEX),[]);if(index.length>=200)fail("搭建会话数量已达上限，请先删除不再需要的会话。",409,"BUILDER_SESSION_LIMIT");
 const session={id:randomUUID(),revision:1,agentSlug,baseDraftHash,status:answer.questions.length?"clarifying":"draft_ready",messages:[messageRecord("user",message),messageRecord("assistant",answer.reply)],questions:answer.questions,draft:answer.draft,changes:fieldDiff(draft?normalizeAgent(draft):{},answer.draft||{}),mode:"ai",createdBy:actor,createdAt:now(),updatedAt:now()};
 await database.setMeta(sessionKey(session.id),JSON.stringify(session));await database.setMeta(SESSION_INDEX,JSON.stringify([...index,session.id]));await database.audit("builder.session_create",actor,agentSlug,{sessionId:session.id});return session});
}
export async function appendBuilderSessionMessage(database,id,input,actor,options={}){
 strict(input,["message","expectedRevision"]);const current=await getBuilderSession(database,id,actor,options);
 if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==current.revision)fail("搭建方案已变化，请刷新会话后重试。",409,"BUILDER_SESSION_CONFLICT");
 if(current.messages.length>=80)fail("会话已达到40轮，请创建新会话或应用当前方案。",409,"BUILDER_SESSION_LIMIT");
 const message=textField(input.message,"本轮修改",{required:true,max:8000}),answer=await reviseAgentBuilderPlan({draft:current.draft,messages:current.messages,message},options);
 return database.transaction(async()=>{const latest=await getBuilderSession(database,id,actor,options);if(latest.revision!==input.expectedRevision)fail("另一个修改已先保存，本轮结果未覆盖原方案。",409,"BUILDER_SESSION_CONFLICT");
 const session={...latest,revision:latest.revision+1,status:answer.questions.length?"clarifying":"draft_ready",messages:[...latest.messages,messageRecord("user",message),messageRecord("assistant",answer.reply)],questions:answer.questions,draft:answer.draft,changes:fieldDiff(latest.draft||{},answer.draft||{}),updatedAt:now()};await database.setMeta(sessionKey(id),JSON.stringify(session));await database.audit("builder.session_turn",actor,session.agentSlug,{sessionId:id,revision:session.revision});return session});
}
export async function applyBuilderSession(database,id,input,actor,options={}){
 strict(input,["expectedRevision","slug","expectedDraftHash"]);
 return database.transaction(async()=>{const session=await getBuilderSession(database,id,actor,options);if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==session.revision)fail("搭建方案已变化，请刷新后应用。",409,"BUILDER_SESSION_CONFLICT");if(!session.draft)fail("当前会话尚无可应用的方案。");
 let agent;
 if(session.agentSlug){if(input.slug&&input.slug!==session.agentSlug)fail("已有智能体会话不能切换标识。");agent=await saveAgentWithCAS(database,session.agentSlug,{...session.draft,expectedDraftHash:input.expectedDraftHash??session.baseDraftHash},actor,{allowLegacyMissingHash:false})}
 else {const slug=validateSlug(input.slug||session.draft.slug);agent=await database.createAgent(normalizeAgent({...session.draft,slug}),actor);await recordBuilderMutation(database,slug,actor)}
 const draftHash=(await getBuilderReadiness(database,agent.slug)).draftHash;await database.setMeta(sessionKey(id),JSON.stringify({...session,agentSlug:agent.slug,baseDraftHash:draftHash,revision:session.revision+1,status:"applied",updatedAt:now()}));await database.audit("builder.session_apply",actor,agent.slug,{sessionId:id});return {...agent,draftHash};
 });
}
export async function deleteBuilderSession(database,id,actor,options={}){return database.transaction(async()=>{await getBuilderSession(database,id,actor,options);const index=stored(await database.getMeta(SESSION_INDEX),[]);await database.setMeta(SESSION_INDEX,JSON.stringify(index.filter(item=>item!==id)));await database.setMeta(sessionKey(id),"null");await database.audit("builder.session_delete",actor,null,{sessionId:id});return {ok:true}})}
export function exportConfigurationPackage(agent,env={}){return exportPortableConfiguration({...agent,builder:materializeLegacyBuilder(agent)},env)}
export {getBuilderCompatibility,inspectConfigurationPackage,fieldDiff};
