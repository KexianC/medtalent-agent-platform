import {createHash} from "node:crypto";
import {normalizeAgent,PlatformError} from "./domain.mjs";
import {normalizeAgentBuilder,BUILDER_COMPONENT_LABELS} from "../src/lib/agentBuilder.ts";
import {credentialValues,safeOutputText} from "./output-safety.mjs";
export const COMPONENT_REGISTRY=Object.freeze(Object.fromEntries(Object.keys(BUILDER_COMPONENT_LABELS).map(id=>[id,{id,version:"1.0.0",supportedTargets:["h5","native"],requires:id==="voice"?["chat"]:[]}])));
const plain=value=>value&&typeof value==="object"&&!Array.isArray(value);
export const canonicalValue=value=>Array.isArray(value)?value.map(canonicalValue):plain(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonicalValue(value[key])])):value;
export const digest=value=>createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
export function fieldDiff(before,after,path=""){
 if(JSON.stringify(canonicalValue(before))===JSON.stringify(canonicalValue(after)))return [];
 if(plain(before)&&plain(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().flatMap(key=>fieldDiff(before[key],after[key],path?path+"."+key:key));
 if(Array.isArray(before)&&Array.isArray(after))return Array.from({length:Math.max(before.length,after.length)},(_,index)=>fieldDiff(before[index],after[index],path+"["+index+"]")).flat();
 return [{path:path||"$",kind:before===undefined?"added":after===undefined?"removed":"changed",before:before===undefined?null:before,after:after===undefined?null:after}];
}
export function getBuilderCompatibility(agent,{targets=["h5","native"]}={}){
 const issues=[],warnings=[];let builder;
 try{builder=normalizeAgentBuilder(agent?.builder)}catch(error){return {ok:false,targets,components:[],issues:[error.message],warnings}}
 if(!builder)return {ok:true,targets,components:[],issues:[],warnings:["旧智能体未启用可装配配置，保留既有运行方式。"]};
 if(!Array.isArray(targets)||!targets.length||targets.some(target=>!["h5","native"].includes(target)))return {ok:false,targets:[],components:[],issues:["目标端无效。"],warnings};
 const enabled=new Set(builder.components.filter(item=>item.enabled).map(item=>item.id));
 const components=builder.components.map(component=>{
  const registered=COMPONENT_REGISTRY[component.id],version=component.version||"1.0.0",own=[];
  const dependencies=[...new Set([...registered.requires,...(component.dependsOn||[])])];
  if(component.enabled){
   if(version!==registered.version)own.push("组件"+component.id+"的版本"+version+"尚不受当前运行端支持。");
   for(const target of targets)if(!registered.supportedTargets.includes(target))own.push("组件"+component.id+"不支持"+target+"。");
   for(const dependency of dependencies)if(!enabled.has(dependency))own.push("组件"+component.id+"需要启用"+dependency+"。");
   if(component.id==="assessments"&&!builder.assessments.length)own.push("已启用自评组件，但尚无问卷定义。");
   if(component.id==="records"&&!builder.recordFields.length)warnings.push("健康记录尚未定义结构化字段，可仅保存备注。");
   if(component.id==="services"&&!builder.servicePlans.length)warnings.push("服务组件尚无计划定义，可在后台补充。");
   if(component.id==="voice"&&!builder.voice.enabled)own.push("语音组件已显示，但语音配置开关未开启。");
  }
  issues.push(...own);return {id:component.id,version,enabled:component.enabled,supportedTargets:registered.supportedTargets,dependencies,issues:own};
 });
 const visiting=new Set(),visited=new Set(),byId=new Map(components.map(item=>[item.id,item]));
 const visit=id=>{if(visiting.has(id)){issues.push("组件依赖不能形成循环。");return}if(visited.has(id))return;visiting.add(id);for(const dependency of byId.get(id)?.dependencies||[])if(enabled.has(dependency))visit(dependency);visiting.delete(id);visited.add(id)};
 for(const id of enabled)visit(id);
 return {ok:issues.length===0,targets:[...new Set(targets)],components,issues:[...new Set(issues)],warnings:[...new Set(warnings)]};
}
export function deidentifiedAgent(input,env={}){
 const source=normalizeAgent(input),secrets=credentialValues(env);
 const replacements=[[source.name,"健康科普助手"],[source.hospital,""]].filter(([identity])=>identity).sort((a,b)=>b[0].length-a[0].length);
 const clean=(value,key="")=>typeof value==="string"?safeOutputText(["id","key","model","speaker","version"].includes(key)?value:replacements.reduce((text,[identity,replacement])=>text.split(identity).join(replacement),value),secrets,100000).replace(/\b1[3-9]\d{9}\b/g,"[已脱敏手机号]").replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[已脱敏邮箱]"):Array.isArray(value)?value.map(item=>clean(item)):plain(value)?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item,key)])):value;
 const result=clean(source);Object.assign(result,{slug:"import-preview",name:"健康科普助手",hospital:"",title:"健康科普智能助手",articles:[]});
 for(const key of ["portrait","portraitPosition","portraitScale","portraitTranslateY","portraitBackground","portraitTransformOrigin"])delete result[key];
 if(result.builder)result.builder.requiresReview=true;
 return normalizeAgent(result);
}
export function exportConfigurationPackage(agent,env={}){
 const snapshot=deidentifiedAgent(agent,env),compatibility=getBuilderCompatibility(snapshot);
 const body={format:"doctor-agent-package",schemaVersion:1,agent:snapshot,dependencies:compatibility.components.map(({id,version,dependencies,supportedTargets})=>({id,version,requires:dependencies,targets:supportedTargets}))};
 return {...body,sha256:digest(body)};
}
export function inspectConfigurationPackage(input){
 const fail=(message,code="INVALID_CONFIG_PACKAGE")=>{throw new PlatformError(message,400,code)};
 if(!plain(input)||Object.keys(input).some(key=>!["format","schemaVersion","agent","dependencies","sha256"].includes(key))||input.format!=="doctor-agent-package"||input.schemaVersion!==1)fail("配置包类型或版本无效。");
 if(Buffer.byteLength(JSON.stringify(input))>2*1024*1024)fail("配置包超过2MiB。");
 const {sha256,...body}=input;if(typeof sha256!=="string"||!/^[a-f0-9]{64}$/.test(sha256)||digest(body)!==sha256)fail("配置包摘要不匹配，文件可能已变化。","CONFIG_PACKAGE_CHECKSUM_MISMATCH");
 let agent;try{agent=normalizeAgent(input.agent)}catch(error){fail(error.message)}
 if(!agent.builder)fail("配置包必须包含可移植组件定义。");
 const compatibility=getBuilderCompatibility(agent);
 const expected=compatibility.components.map(({id,version,dependencies,supportedTargets})=>({id,version,requires:dependencies,targets:supportedTargets}));
 if(JSON.stringify(canonicalValue(input.dependencies))!==JSON.stringify(canonicalValue(expected)))fail("配置包依赖清单与实际配置不一致。");
 if(!compatibility.ok)fail(compatibility.issues.join(" "),"INCOMPATIBLE_CONFIG_PACKAGE");
 return {valid:true,agent,issues:[],compatibility};
}
