import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PlatformError,validateSlug,now} from './domain.mjs';
const keyFor=slug=>'builder.qualification-files.'+validateSlug(slug);
const fail=(message,status=400,code='INVALID_QUALIFICATION_FILE')=>{throw new PlatformError(message,status,code)};
export async function getQualificationFiles(database,slug){const raw=await database.getMeta(keyFor(slug));if(!raw)return [];const files=JSON.parse(raw);if(!Array.isArray(files))throw new Error('Qualification attachment metadata is invalid');return files;}
export const qualificationFileExpired=(file,nowMs=Date.now())=>!!file.expiresAt&&Date.parse(file.expiresAt+'T23:59:59.999+08:00')<nowMs;
const safeId=id=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))fail('附件不存在。',404,'QUALIFICATION_FILE_NOT_FOUND');return id};
const date=value=>{if(value===undefined||value==='')return '';if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('附件到期日无效。');return value};
const text=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f\u007f\/\\]/.test(value))fail('附件名称无效。');return value.trim()};
export function normalizeQualificationUpload(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['kind','name','mime','base64','expiresAt'].includes(key)))fail('附件请求无效。');
 if(!['qualification','authorization'].includes(input.kind))fail('附件类型无效。');const name=text(input.name,150);const mime=input.mime;
 if(!['application/pdf','image/png','image/jpeg'].includes(mime)||typeof input.base64!=='string'||!input.base64.length||input.base64.length>2796204||!/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64))fail('只支持2MiB以内的PDF、PNG或JPEG附件。');
 const bytes=Buffer.from(input.base64,'base64');if(!bytes.length||bytes.length>2097152||bytes.toString('base64')!==input.base64)fail('附件编码或大小无效。');
 const signature=mime==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
 if(!signature)fail('文件实际类型与声明不一致。');
 return {bytes,file:{id:randomUUID(),kind:input.kind,name,mime,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),expiresAt:date(input.expiresAt),createdAt:now()}};
}
const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
export function registerQualificationFileRoutes(app,{database,dataDir,viewer,admin,recordMutation}){
 const folder=path.resolve(dataDir,'qualification-files');
 const filePath=(slug,id)=>{const target=path.resolve(folder,validateSlug(slug),safeId(id)+'.bin');if(!target.startsWith(folder+path.sep))fail('附件路径无效。');return target};
 const invalidate=async(slug,actor)=>{const key='agent-builder.governance.'+slug;const state=JSON.parse(await database.getMeta(key)||'{}');const qualification={...(state.qualification||{}),status:'unverified'};delete qualification.verifiedBy;delete qualification.verifiedAt;await database.setMeta(key,JSON.stringify({...state,qualification}));await recordMutation(database,slug,actor)};
 const prefix='/api/admin/agents/:slug/qualification/files';
 app.get(prefix,viewer,route(async(req,res)=>{await database.requireAgent(validateSlug(req.params.slug));res.json({files:await getQualificationFiles(database,req.params.slug)})}));
 app.post(prefix,admin,route(async(req,res)=>{const slug=validateSlug(req.params.slug);const upload=normalizeQualificationUpload(req.body);const target=filePath(slug,upload.file.id);let written=false;try{const files=await database.transaction(async()=>{await database.requireAgent(slug);const current=await getQualificationFiles(database,slug);if(current.length>=20)fail('最多保存20份资质与授权附件。');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,upload.bytes,{flag:'wx',mode:0o600});written=true;const next=[...current,upload.file];await database.setMeta(keyFor(slug),JSON.stringify(next));await invalidate(slug,req.user.username);await database.audit('agent.qualification_file_add',req.user.username,slug,{id:upload.file.id,kind:upload.file.kind,sha256:upload.file.sha256,size:upload.file.size});return next});res.status(201).json({files});}catch(error){if(written)await fs.unlink(target).catch(()=>{});throw error}}));
 app.get(prefix+'/:id',viewer,route(async(req,res)=>{const slug=validateSlug(req.params.slug);const file=(await getQualificationFiles(database,slug)).find(file=>file.id===safeId(req.params.id));if(!file)fail('附件不存在。',404,'QUALIFICATION_FILE_NOT_FOUND');const bytes=await fs.readFile(filePath(slug,file.id)).catch(()=>fail('附件文件不可用。',404,'QUALIFICATION_FILE_NOT_FOUND'));if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)fail('附件完整性校验未通过。',409,'QUALIFICATION_FILE_CHANGED');res.setHeader('Content-Type',file.mime);res.setHeader('Content-Disposition',"attachment; filename*=UTF-8''"+encodeURIComponent(file.name));res.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");res.send(bytes)}));
 app.delete(prefix+'/:id',admin,route(async(req,res)=>{const slug=validateSlug(req.params.slug);const id=safeId(req.params.id);const target=filePath(slug,id);const files=await database.transaction(async()=>{await database.requireAgent(slug);const current=await getQualificationFiles(database,slug);if(!current.some(file=>file.id===id))fail('附件不存在。',404,'QUALIFICATION_FILE_NOT_FOUND');const next=current.filter(file=>file.id!==id);await database.setMeta(keyFor(slug),JSON.stringify(next));await invalidate(slug,req.user.username);await database.audit('agent.qualification_file_delete',req.user.username,slug,{id});return next});await fs.unlink(target).catch(error=>{if(error.code!=='ENOENT')throw error});res.json({files})}));
}
