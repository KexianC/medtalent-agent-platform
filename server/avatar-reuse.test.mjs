import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createCanvas} from '@napi-rs/canvas';
import {PlatformDatabase} from './database.mjs';
import {PlatformAccess,scopedDatabase} from './platform-access.mjs';
import {PlatformAssets} from './platform-assets.mjs';
import {copyAgentDraft} from './agent-builder.mjs';
import {normalizeAgent} from './domain.mjs';
const agent=slug=>normalizeAgent({slug,name:'合成头像助手 '+slug,department:'科普',specialty:'一般健康知识'});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'avatar-reuse-test-'));const raw=new PlatformDatabase({dataDir:dir,seedDoctors:['source-one','target-one','foreign-one'].map(agent)});
 t.after(async()=>{raw.close();if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('avatar-reuse-test-'))await fs.rm(dir,{recursive:true,force:true})});
 const access=new PlatformAccess(raw),db=scopedDatabase(raw,access),users={};for(const username of ['root-admin','creator-one','source-only','target-only','foreign-user'])users[username]=raw.insertUser({id:'id-'+username,username,name:'合成 '+username,role:username==='root-admin'?'admin':'editor',passwordHash:'synthetic-not-login-password'});
 const run=async(name,fn)=>access.run(await access.context(users[name]),fn);const a=await run('root-admin',()=>access.createTenant({name:'合成机构A'},'root-admin')),b=await run('root-admin',()=>access.createTenant({name:'合成机构B'},'root-admin'));
 await run('root-admin',async()=>{await access.assignAgent('source-one',a.id,'root-admin');await access.assignAgent('target-one',a.id,'root-admin');await access.assignAgent('foreign-one',b.id,'root-admin');for(const [username,tenantId,agentSlugs]of [['creator-one',a.id,['*']],['source-only',a.id,['source-one']],['target-only',a.id,['target-one']],['foreign-user',b.id,['foreign-one']]])await access.saveMember({username,tenantId,role:'editor',agentSlugs},'root-admin')});
 const assets=new PlatformAssets(db,{dataDir:dir,env:{},access,auth:{authenticate:async()=>users['creator-one']}});const canvas=createCanvas(18,15);canvas.getContext('2d').fillRect(2,2,9,9);const png=Buffer.from(await canvas.encode('png'));
 const uploaded=await run('creator-one',()=>assets.upload({agentSlug:'source-one',name:'合成已授权头像.png',mime:'image/png',base64:png.toString('base64')},'creator-one'));
 await run('creator-one',async()=>{const current=await db.requireAgent('source-one');await db.saveAgent(normalizeAgent({...current,portrait:uploaded.asset.url,portraitPosition:'42% 51%'},current),'creator-one')});
 return {dir,raw,db,access,users,run,a,b,assets,source:uploaded.asset,clonePortrait:(url,slug,actor)=>assets.clonePortrait(url,slug,actor)};
}
const files=async dir=>(await fs.readdir(path.join(dir,'media'))).sort();
test('authorized reuse makes a physically independent target asset while strict portrait ownership remains enforced',async t=>{
 const f=await fixture(t),before=structuredClone(await f.raw.requireAgent('source-one'));let reused;
 await f.run('creator-one',async()=>{reused=(await f.assets.reuse(f.source.id,{agentSlug:'target-one'},'creator-one')).asset;assert.notEqual(reused.id,f.source.id);assert.notEqual(reused.url,f.source.url);assert.equal(reused.agentSlug,'target-one');assert.equal(reused.width,18);assert.equal(reused.height,15);const target=await f.db.requireAgent('target-one');await assert.rejects(f.db.saveAgent(normalizeAgent({portrait:f.source.url},target),'creator-one'),{code:'MEDIA_SCOPE_MISMATCH'});await f.db.saveAgent(normalizeAgent({portrait:reused.url},target),'creator-one');});
 const sourceBytes=await fs.readFile(path.join(f.dir,'media',f.source.id+'.bin')),targetBytes=await fs.readFile(path.join(f.dir,'media',reused.id+'.bin'));assert.deepEqual(targetBytes,sourceBytes);assert.equal(await fs.stat(path.join(f.dir,'media',reused.id+'.bin')).then(s=>s.isFile()),true);assert.deepEqual(await f.raw.requireAgent('source-one'),before);
 await f.run('creator-one',()=>f.assets.remove(reused.id,'creator-one'));assert.deepEqual(await fs.readFile(path.join(f.dir,'media',f.source.id+'.bin')),sourceBytes);
});
test('reuse rejects ungranted source/target, foreign institution and registry lookup without leaking or writing files',async t=>{
 const f=await fixture(t),before=await files(f.dir);
 await assert.rejects(f.run('source-only',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'source-only')),{statusCode:404});await assert.rejects(f.run('target-only',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'target-only')),{statusCode:404});await assert.rejects(f.run('creator-one',()=>f.assets.reuse(f.source.id,{agentSlug:'foreign-one'},'creator-one')),{statusCode:404});
 await assert.rejects(f.run('foreign-user',()=>f.assets.reuse(f.source.id,{agentSlug:'foreign-one'},'foreign-user')),{code:'MEDIA_NOT_FOUND'});await assert.rejects(f.run('root-admin',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'root-admin')),{code:'MEDIA_NOT_FOUND'});assert.deepEqual(await files(f.dir),before);assert.equal((await f.run('creator-one',()=>f.assets.media())).assets.length,1);
});
test('corrupt source bytes, target storage quota and nested metadata failure leave no reused asset or orphan',async t=>{
 const f=await fixture(t),file=path.join(f.dir,'media',f.source.id+'.bin'),bytes=await fs.readFile(file),before=await files(f.dir);await fs.writeFile(file,Buffer.concat([bytes,Buffer.from('changed')]));await assert.rejects(f.run('creator-one',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'creator-one')),{code:'MEDIA_INTEGRITY_FAILED'});await fs.writeFile(file,bytes);
 const originalState=await f.access.state(),restricted=structuredClone(originalState),plan=restricted.plans.find(item=>item.id==='trial');restricted.plans.push({...plan,id:'avatar-tight',quotas:{...plan.quotas,storageBytes:f.source.size}});restricted.tenants.find(item=>item.id===f.a.id).planId='avatar-tight';await f.access.save(restricted);await assert.rejects(f.run('creator-one',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'creator-one')),{code:'TENANT_STORAGE_QUOTA_EXCEEDED'});await f.access.save(originalState);
 const audit=f.raw.audit.bind(f.raw);f.raw.audit=(action,...args)=>{if(action==='media.reuse')throw Error('synthetic-reuse-audit-failure');return audit(action,...args)};await assert.rejects(f.run('creator-one',()=>f.assets.reuse(f.source.id,{agentSlug:'target-one'},'creator-one')),/synthetic-reuse-audit-failure/);f.raw.audit=audit;assert.deepEqual(await files(f.dir),before);assert.equal((await f.run('creator-one',()=>f.assets.media())).assets.length,1);
});
test('copying an uploaded avatar uses a distinct target owner and file, preserves source and keeps the new agent unpublished',async t=>{
 const f=await fixture(t),before=structuredClone(await f.raw.requireAgent('source-one'));const copied=await f.run('creator-one',()=>copyAgentDraft(f.db,'source-one',{slug:'copied-one',name:'独立合成副本'},'creator-one',{clonePortrait:f.clonePortrait}));assert.equal(copied.status,'draft');assert.equal(await f.raw.getAgent('copied-one',true),null);assert.notEqual(copied.portrait,f.source.url);assert.match(copied.portrait,/^\/media\/avatars\/[a-f0-9]{24}$/);assert.equal(copied.portraitPosition,before.portraitPosition);const assets=(await f.run('creator-one',()=>f.assets.media('copied-one'))).assets;assert.equal(assets.length,1);assert.equal(assets[0].url,copied.portrait);assert.deepEqual(await fs.readFile(path.join(f.dir,'media',assets[0].id+'.bin')),await fs.readFile(path.join(f.dir,'media',f.source.id+'.bin')));assert.deepEqual(await f.raw.requireAgent('source-one'),before);
});
test('failure after a nested portrait clone rolls back the agent/metadata and removes the new physical file',async t=>{
 const f=await fixture(t),before=await files(f.dir),source=structuredClone(await f.raw.requireAgent('source-one'));const audit=f.raw.audit.bind(f.raw);f.raw.audit=(action,...args)=>{if(action==='agent.copy_configuration')throw Error('synthetic-final-copy-failure');return audit(action,...args)};
 await assert.rejects(f.run('creator-one',()=>copyAgentDraft(f.db,'source-one',{slug:'failed-copy',name:'失败合成副本'},'creator-one',{clonePortrait:f.clonePortrait})),/synthetic-final-copy-failure/);f.raw.audit=audit;assert.equal(await f.raw.getAgent('failed-copy'),null);assert.deepEqual(await files(f.dir),before);assert.equal((await f.run('creator-one',()=>f.assets.media())).assets.length,1);assert.deepEqual(await f.raw.requireAgent('source-one'),source);
});
test('missing clone hook fails without creating a partial copy and static asset copy keeps its previous behavior',async t=>{
 const f=await fixture(t),before=await files(f.dir);await assert.rejects(f.run('creator-one',()=>copyAgentDraft(f.db,'source-one',{slug:'missing-hook',name:'缺失hook'},'creator-one')),{code:'MEDIA_CLONE_UNAVAILABLE'});assert.equal(await f.raw.getAgent('missing-hook'),null);assert.deepEqual(await files(f.dir),before);
 await f.run('creator-one',async()=>{const source=await f.db.requireAgent('source-one');await f.db.saveAgent(normalizeAgent({portrait:'/assets/existing-doctor.png'},source),'creator-one');const copied=await copyAgentDraft(f.db,'source-one',{slug:'static-copy',name:'静态兼容'},'creator-one');assert.equal(copied.portrait,undefined)});
});
