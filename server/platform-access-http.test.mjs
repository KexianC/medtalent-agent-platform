import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {createPlatformApp} from './app.mjs';
const seeds=[{slug:'http-a-one',name:'合成A助手',department:'健康科普',specialty:'一般科普'},{slug:'http-b-one',name:'合成B助手',department:'健康科普',specialty:'一般科普'}];
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'platform-access-http-'));let platform,server;
 t.after(async()=>{if(server?.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});await platform?.close();if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith('platform-access-http-'))await fs.rm(dir,{recursive:true,force:true})});
 platform=await createPlatformApp({dataDir:dir,seedDoctors:seeds,startWorker:false,disableRateLimits:true,env:{},fetchImpl:async()=>{throw new Error('External calls are forbidden in access HTTP tests')}});
 let origin;for(let attempt=0;attempt<10;attempt++){server=await new Promise((resolve,reject)=>{const current=platform.app.listen(0,'127.0.0.1',()=>resolve(current));current.once('error',reject)});origin='http://127.0.0.1:'+server.address().port;try{await(await fetch(origin+'/api/health',{method:'HEAD'})).arrayBuffer();break}catch(error){await new Promise(resolve=>server.close(resolve));if(error.cause?.message!=='bad port'||attempt===9)throw error}}
 const root=await platform.rawDatabase.findUserByUsername('admin');const asRoot=async work=>platform.access.run(await platform.access.context(root),work);
 const a=await asRoot(()=>platform.access.createTenant({name:'合成HTTP机构A'},root.username));const b=await asRoot(()=>platform.access.createTenant({name:'合成HTTP机构B'},root.username));
 await asRoot(async()=>{await platform.access.assignAgent('http-a-one',a.id,root.username);await platform.access.assignAgent('http-b-one',b.id,root.username)});
 const credentials={};for(const [username,role,memberRole] of [['http-demoted','admin','viewer'],['http-editor','admin','editor'],['http-not-promoted','viewer','admin'],['http-tenant-admin','admin','admin']]){const password=randomBytes(24).toString('hex');const user=await platform.auth.saveUser({username,name:'合成 '+username,password,role,active:true},root.username);credentials[username]={password,user};await asRoot(()=>platform.access.saveMember({username,tenantId:a.id,role:memberRole,agentSlugs:['http-a-one']},root.username));}
 const login=async username=>{const response=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password:credentials[username].password})});assert.equal(response.status,200);await response.json();return response.headers.get('set-cookie').split(';')[0]};
 const request=(cookie,url,{method='GET',body,tenantId}={})=>fetch(origin+url,{method,headers:{Cookie:cookie,...(tenantId?{'x-tenant-id':tenantId}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {...platform,a,b,root,asRoot,login,request};
}
test('HTTP takes the lower global/member role and never promotes a global viewer',async t=>{
 const f=await fixture(t);
 for(const username of ['http-demoted','http-not-promoted']){const cookie=await f.login(username);const session=await f.request(cookie,'/api/admin/session');assert.equal(session.status,200);assert.equal((await session.json()).user.role,'viewer');const list=await f.request(cookie,'/api/admin/agents');assert.equal(list.status,200);assert.deepEqual((await list.json()).map(a=>a.slug),['http-a-one']);const write=await f.request(cookie,'/api/admin/agents/http-a-one',{method:'PUT',body:{intro:'must not write'}});assert.equal(write.status,403);const settings=await f.request(cookie,'/api/admin/business/http-a-one/settings',{method:'PUT',body:{enabled:true,appointmentMode:'internal',priceCents:0}});assert.equal(settings.status,403);}
 assert.equal((await f.rawDatabase.requireAgent('http-a-one')).intro,'');
});
test('HTTP editor can write its granted draft but gets 404 for foreign doctor and 403 for platform/admin mutations',async t=>{
 const f=await fixture(t),cookie=await f.login('http-editor');const own=await f.request(cookie,'/api/admin/agents/http-a-one');assert.equal(own.status,200);const agent=await own.json();assert.equal(agent.slug,'http-a-one');const saved=await f.request(cookie,'/api/admin/agents/http-a-one',{method:'PUT',body:{...agent,intro:'合成HTTP授权编辑',expectedDraftHash:agent.draftHash}});assert.equal(saved.status,200);assert.equal((await saved.json()).intro,'合成HTTP授权编辑');
 for(const method of ['GET','PUT']){const response=await f.request(cookie,'/api/admin/agents/http-b-one',{method,...(method==='PUT'?{body:{intro:'cross-tenant attempt',expectedDraftHash:'0'.repeat(64)}}:{})});assert.equal(response.status,404);}
 assert.equal((await f.request(cookie,'/api/admin/access/tenants',{method:'POST',body:{name:'forbidden'}})).status,403);assert.equal((await f.request(cookie,'/api/admin/users')).status,403);assert.equal((await f.request(cookie,'/api/admin/providers')).status,403);assert.equal((await f.rawDatabase.requireAgent('http-b-one')).intro,'');
});
test('HTTP institution admins cannot list platform channels/providers or switch into another institution',async t=>{
 const f=await fixture(t),cookie=await f.login('http-tenant-admin');for(const url of ['/api/admin/providers','/api/admin/channels','/api/admin/users'])assert.equal((await f.request(cookie,url)).status,403);
 const overview=await f.request(cookie,'/api/admin/access');assert.equal(overview.status,200);assert.deepEqual((await overview.json()).tenants.map(t=>t.id),[f.a.id]);assert.equal((await f.request(cookie,'/api/admin/agents',{tenantId:f.b.id})).status,403);
 const foreign=await f.request(cookie,'/api/admin/business/http-b-one');assert.equal(foreign.status,404);
});
test('HTTP suspend and inactive policies deny an already known account instead of returning global data',async t=>{
 const f=await fixture(t);let cookie=await f.login('http-editor');await f.asRoot(()=>f.access.updateTenant(f.a.id,{status:'suspended'},f.root.username));let response=await f.request(cookie,'/api/admin/agents');assert.equal(response.status,403);assert.equal((await response.json()).code,'TENANT_SUSPENDED');await f.asRoot(()=>f.access.updateTenant(f.a.id,{status:'active'},f.root.username));await f.asRoot(()=>f.access.saveMember({username:'http-editor',tenantId:f.a.id,role:'editor',agentSlugs:['http-a-one'],active:false},f.root.username));assert.equal((await f.request(cookie,'/api/admin/agents')).status,401);cookie=await f.login('http-editor');response=await f.request(cookie,'/api/admin/agents');assert.equal(response.status,403);
});
