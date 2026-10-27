import {readReleaseBlobSnapshot,assertReleaseOriginalsAvailable,attachReleaseBlobIndex} from './release-blob-references.mjs';
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {normalizeAgent,validateSlug,PlatformError,now} from "./domain.mjs";
import {digest} from "./builder-lifecycle-schema.mjs";
import {getBuilderReadiness,assertBuilderPublishable,recordBuilderMutation} from "./agent-builder.mjs";
import {retrieveChunks} from "./rag.mjs";
import {credentialValues,safeOutputText} from "./output-safety.mjs";
const fail=(message,status=400,code="INVALID_AGENT_RELEASE")=>{throw new PlatformError(message,status,code)};
const parse=(raw,fallback)=>{if(raw===null||raw===undefined)return structuredClone(fallback);try{return JSON.parse(raw)}catch{fail("应用版本元数据格式异常。",503,"INVALID_RELEASE_METADATA")}};
const listKey=slug=>"builder.releases."+validateSlug(slug),pendingKey=slug=>"builder.release-pending."+validateSlug(slug);
const releaseId=id=>{if(typeof id!=="string"||!/^[a-f0-9-]{36}$/.test(id))fail("应用版本标识无效。");return id};
function releasePath(database,slug,id){const base=path.resolve(database.dataDir,"builder-releases",validateSlug(slug)),target=path.resolve(base,releaseId(id)+".json");if(path.dirname(target)!==base)fail("应用版本路径无效。");return target}
async function readSnapshot(database,slug,descriptor){return readReleaseBlobSnapshot(database,slug,descriptor)}
export async function listAgentReleases(database,slug){await database.requireAgent(validateSlug(slug));return parse(await database.getMeta(listKey(slug)),[]).map(({id,version,publishedAt,summary,sha256})=>({id,version,publishedAt,summary,sha256}))}
async function physicalStateFingerprint(database,slug){const contents=await database.listEntities("content",slug),documents=await database.listEntities("documents",slug),sources=await database.listEntities("sources",slug),chunks=[];for(const document of documents)chunks.push(...await database.listStoredChunkRows(document.id));return digest({chunks:chunks.sort((a,b)=>a.id.localeCompare(b.id)),contents:contents.slice().sort((a,b)=>a.id.localeCompare(b.id)),documents:documents.slice().sort((a,b)=>a.id.localeCompare(b.id)),sources:sources.slice().sort((a,b)=>a.id.localeCompare(b.id))})}
export async function getPendingReleaseSnapshot(database,slug){
 validateSlug(slug);const pending=parse(await database.getMeta(pendingKey(slug)),null);if(!pending)return null;await database.requireAgent(slug);const snapshot=await readSnapshot(database,slug,pending);
 return {...snapshot,sourceReleaseId:pending.id,pending:true,physicalStateMatches:pending.physicalFingerprint===await physicalStateFingerprint(database,slug)};
}
export async function stageAgentReleaseRestore(database,slug,id,input,actor){
 if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>key!=="expectedDraftHash"))fail("恢复请求格式无效。");
 return database.transaction(async()=>{await database.requireAgent(validateSlug(slug));const readiness=await getBuilderReadiness(database,slug);if(input.expectedDraftHash!==readiness.draftHash)fail("草稿已变化，请刷新后恢复。",409,"DRAFT_CONFLICT");
 const descriptor=parse(await database.getMeta(listKey(slug)),[]).find(item=>item.id===releaseId(id));if(!descriptor)fail("应用版本不存在。",404,"RELEASE_NOT_FOUND");const snapshot=await readSnapshot(database,slug,descriptor);await assertReleaseOriginalsAvailable(database,snapshot);const physicalFingerprint=await physicalStateFingerprint(database,slug);
 const agent=await database.saveAgent(normalizeAgent(snapshot.agent),actor);const governanceKey="agent-builder.governance."+slug,state=parse(await database.getMeta(governanceKey),{});await database.setMeta(governanceKey,JSON.stringify({...state,required:true,lastModifiedBy:actor,lastModifiedAt:now()}));await recordBuilderMutation(database,slug,actor);
 await database.setMeta(pendingKey(slug),JSON.stringify({...descriptor,physicalFingerprint,stagedBy:actor,stagedAt:now()}));await database.audit("agent.release_restore_staged",actor,slug,{releaseId:id,version:descriptor.version,contentCount:snapshot.contents.length,documentCount:snapshot.documents.length});return agent;
 });
}
async function currentSnapshot(database,slug,actor,knowledge){
 const agent=await database.requireAgent(slug),contents=await database.listEntities("content",slug),all=await database.listEntities("documents",slug),documents=[],chunks=[];
 for(const document of all){if(document.approved!==true||document.status!=="ready")continue;if(knowledge&&!(await knowledge.documentProvenanceAllowsPublishing(document)))continue;const rows=await database.listStoredChunkRows(document.id);if(!rows.length)continue;if(rows.length!==document.chunkCount)fail("已审核知识的片段数量不一致，请先重新验收。",409,"KNOWLEDGE_SNAPSHOT_INCONSISTENT");documents.push(document);chunks.push(...rows)}
 return {format:"doctor-agent-release",schemaVersion:1,id:randomUUID(),agentSlug:slug,agent:normalizeAgent(agent),contents,documents,chunks,templateBinding:parse(await database.getMeta("builder.template.binding."+slug),null),createdAt:now(),actor};
}
function pendingKnowledgeContext(knowledge,database,pending){if(!knowledge)return null;const context=Object.create(knowledge);context.database=new Proxy(database,{get(target,property){if(property==="getEntity")return (table,id)=>table==="content"&&pending.contents.some(content=>content.id===id)?structuredClone(pending.contents.find(content=>content.id===id)):target.getEntity(table,id);const value=target[property];return typeof value==="function"?value.bind(target):value}});return context}
async function applyPendingSnapshot(database,slug,pending,knowledge){
 if(!pending.physicalStateMatches)fail("准备恢复后，内容或知识又被修改，请重新比较并选择应用版本。",409,"PENDING_RELEASE_SOURCE_CHANGED");
 await assertReleaseOriginalsAvailable(database,pending);
 const provenance=pendingKnowledgeContext(knowledge,database,pending);
 if(provenance)for(const document of pending.documents)if(!(await provenance.documentProvenanceAllowsPublishing(document)))fail("历史知识来源当前已失效或无权发布，请重新核验。",409,"RELEASE_KNOWLEDGE_NOT_ALLOWED");
 const contents=await database.listEntities("content",slug),savedContentIds=new Set(pending.contents.map(content=>content.id));
 for(const content of contents)if(!savedContentIds.has(content.id))await database.removeEntity("content",content.id);
 for(const content of pending.contents){const existing=await database.getEntity("content",content.id);if(existing&&existing.agentSlug!==slug)fail("历史内容归属不一致。",409,"RELEASE_SCOPE_INVALID");await database.saveEntity("content",structuredClone(content));}
 const documents=await database.listEntities("documents",slug),savedDocumentIds=new Set(pending.documents.map(document=>document.id));
 for(const document of documents)if(document.approved===true&&!savedDocumentIds.has(document.id))await database.patchEntity("documents",document.id,{approved:false,status:document.chunkCount?"review":document.status,updatedAt:now()});
 for(const document of pending.documents){
  const existing=await database.getEntity("documents",document.id);if(existing&&existing.agentSlug!==slug)fail("历史知识归属不一致。",409,"RELEASE_SCOPE_INVALID");await database.saveEntity("documents",structuredClone(document));
  const rows=pending.chunks.filter(row=>row.document_id===document.id).sort((a,b)=>a.position-b.position),models=[...new Set(rows.map(row=>row.embedding_model).filter(Boolean))];if(models.length>1)fail("历史知识包含混合向量模型，不能自动恢复。",409,"RELEASE_VECTOR_INCONSISTENT");
  const vectors=rows.map(row=>{if(row.embedding===null||row.embedding===undefined)return null;const value=typeof row.embedding==="string"?JSON.parse(row.embedding):row.embedding;if(!Array.isArray(value)||!value.length||value.length>16384||value.some(number=>typeof number!=="number"||!Number.isFinite(number)))fail("历史向量数据无效。",409,"RELEASE_VECTOR_INCONSISTENT");return value});
  await database.replaceChunks(document,rows.map(row=>({index:row.position,text:row.text})),vectors,models[0]||null);if(await database.countDocumentChunks(document.id)!==rows.length)fail("知识恢复片段数量核验失败。",409,"RELEASE_RESTORE_INCOMPLETE");
 }
 await database.setMeta("builder.template.binding."+slug,pending.templateBinding?JSON.stringify({...pending.templateBinding,mode:"pinned",updatedAt:now()}):"null");
 await database.setMeta(pendingKey(slug),"null");
}
export async function publishAgentRelease(database,slug,actor,{expectedDraftHash,knowledge,allowLegacyMissingHash=true}={}){
 let createdFile;
 try{return await database.transaction(async()=>{validateSlug(slug);const readiness=await getBuilderReadiness(database,slug);if(expectedDraftHash===undefined&&!allowLegacyMissingHash)fail("请先读取当前草稿版本。",428,"DRAFT_HASH_REQUIRED");if(expectedDraftHash!==undefined&&expectedDraftHash!==readiness.draftHash)fail("草稿已变化，请刷新后发布。",409,"DRAFT_CONFLICT");await assertBuilderPublishable(database,slug);
 const releases=parse(await database.getMeta(listKey(slug)),[]);if(releases.length>=100)fail("单个智能体整套版本达到100个，请先执行版本归档维护。",409,"RELEASE_VERSION_LIMIT");const pending=await getPendingReleaseSnapshot(database,slug);if(pending)await applyPendingSnapshot(database,slug,pending,knowledge);
 const published=await database.publishAgent(slug,actor),snapshot=await currentSnapshot(database,slug,actor,knowledge),sha256=digest(snapshot),file=releasePath(database,slug,snapshot.id);await assertReleaseOriginalsAvailable(database,snapshot);if(Buffer.byteLength(JSON.stringify(snapshot))>256*1024*1024)fail("应用快照超过单节点安全上限。",413,"RELEASE_TOO_LARGE");await fs.mkdir(path.dirname(file),{recursive:true});const handle=await fs.open(file,"wx",0o600);createdFile=file;try{await handle.writeFile(JSON.stringify(snapshot))}finally{await handle.close()}
 const descriptor=attachReleaseBlobIndex(slug,{id:snapshot.id,version:published.version,publishedAt:published.publishedAt,sha256,summary:{contentCount:snapshot.contents.length,documentCount:snapshot.documents.length,chunkCount:snapshot.chunks.length}},snapshot);await database.setMeta(listKey(slug),JSON.stringify([descriptor,...releases]));await database.audit("agent.release_snapshot",actor,slug,{releaseId:snapshot.id,version:published.version,...descriptor.summary});return published;
 })}catch(error){if(createdFile)await fs.unlink(createdFile).catch(()=>{});throw error}
}
export async function searchPendingRelease(database,slug,query,options={}){
 const {knowledge,env={},fetchImpl=fetch}=options;
 const pending=Object.prototype.hasOwnProperty.call(options,"pendingSnapshot")?options.pendingSnapshot:await getPendingReleaseSnapshot(database,slug);if(!pending)return null;if(!pending.physicalStateMatches)fail("恢复候选关联数据已变化，请重新选择版本。",409,"PENDING_RELEASE_SOURCE_CHANGED");if((options.agent||pending.agent).config?.ragEnabled===false)return {mode:"none",citations:[]};
 const provenance=pendingKnowledgeContext(knowledge,database,pending);
 const allowed=new Set();for(const document of pending.documents)if(!provenance||await provenance.documentProvenanceAllowsPublishing(document))allowed.add(document.id);
 const chunks=pending.chunks.filter(row=>allowed.has(row.document_id)).map(row=>({id:row.id,documentId:row.document_id,title:pending.documents.find(document=>document.id===row.document_id)?.name||"知识资料",index:row.position,text:row.text,embedding:null,embeddingModel:null}));
 const retrieval=await retrieveChunks({query,chunks,topK:(options.agent||pending.agent).config?.ragTopK||5,threshold:(options.agent||pending.agent).config?.ragThreshold??0.12,env:{},fetchImpl});const secrets=credentialValues(env);
 return {...retrieval,citations:retrieval.citations.map(citation=>({...citation,title:safeOutputText(citation.title,secrets,300),text:safeOutputText(citation.text,secrets,5000)})),source:"pending-release"};
}
