import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {PlatformDatabase} from "./database.mjs";
import {PlatformAccess,scopedDatabase} from "./platform-access.mjs";
import {normalizeAgent} from "./domain.mjs";
import {listAgentTemplates,saveAgentAsTemplate,updateAgentTemplate} from "./agent-builder.mjs";

const doctor=slug=>normalizeAgent({slug,name:"合成软件隔离助手 "+slug,hospital:"合成验收机构",department:"健康科普",specialty:"通用科普"});
const denied=(status=404)=>error=>error?.status===status||error?.statusCode===status;
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),"platform-access-test-"));
 const raw=new PlatformDatabase({dataDir:dir,seedDoctors:["a-one","a-two","b-one","internal-one"].map(doctor)});
 t.after(async()=>{raw.close();if(path.dirname(dir)===path.resolve(os.tmpdir())&&path.basename(dir).startsWith("platform-access-test-"))await fs.rm(dir,{recursive:true,force:true})});
 const access=new PlatformAccess(raw),db=scopedDatabase(raw,access),users={};
 for(const username of ["root-admin","member-a","admin-a","member-b","admin-b","internal-member","unbound-user"]){users[username]=raw.insertUser({id:"user-"+username,username,name:"合成 "+username,role:"admin",active:true,passwordHash:"synthetic-not-a-login-hash"})}
 const run=async(username,fn,tenantId)=>access.run(await access.context(users[username],tenantId),fn);
 const a=await run("root-admin",()=>access.createTenant({name:"合成机构A"},"root-admin"));
 const b=await run("root-admin",()=>access.createTenant({name:"合成机构B"},"root-admin"));
 await run("root-admin",async()=>{
  for(const slug of ["a-one","a-two"])await access.assignAgent(slug,a.id,"root-admin");
  await access.assignAgent("b-one",b.id,"root-admin");
  for(const [username,tenantId,role,agentSlugs] of [["member-a",a.id,"editor",["a-one"]],["admin-a",a.id,"admin",["*"]],["member-b",b.id,"editor",["b-one"]],["admin-b",b.id,"admin",["*"]],["internal-member","internal","editor",["internal-one"]]])await access.saveMember({username,tenantId,role,agentSlugs},"root-admin");
 });
 for(const slug of ["a-one","a-two","b-one","internal-one"]){for(const table of ["documents","content","sources"])raw.saveEntity(table,{id:table+"-"+slug,agentSlug:slug,name:"合成 "+table,status:"ready",approved:true,chunkCount:1});raw.replaceChunks({id:"documents-"+slug,agentSlug:slug},[{index:0,text:"合成隔离分片 "+slug}]);}
 return {raw,db,access,users,run,a,b};
}

test("legacy unbound accounts retain their role and explicit members only see assigned doctors",async t=>{
 const {raw,db,access,users,run}=await fixture(t);
 const global=await access.context(users["root-admin"]);assert.equal(global.legacyGlobal,true);assert.equal(global.platformAdmin,true);
 const scoped=await access.context(users["member-a"]);assert.equal(scoped.legacyGlobal,false);assert.equal(scoped.platformAdmin,false);assert.equal(scoped.member.role,"editor");
 await run("member-a",async()=>{assert.deepEqual((await db.listAgents()).map(a=>a.slug),["a-one"]);assert.equal(await db.getAgent("b-one"),null);assert.throws(()=>db.requireAgent("b-one"),denied());assert.throws(()=>db.archiveAgent("b-one","member-a"),denied());assert.throws(()=>db.saveAgent(doctor("b-one"),"member-a"),denied());assert.throws(()=>access.assertRequest({path:"/api/admin/users"},access.current()),denied(403));});
 assert.equal(raw.requireAgent("b-one").status,"published");
});

test("entity reads, overwrite attempts, patches, deletes and document chunks reject foreign doctor ids",async t=>{
 const {raw,db,run}=await fixture(t);
 await run("member-a",async()=>{for(const table of ["documents","content","sources"]){assert.deepEqual((await db.listEntities(table)).map(x=>x.agentSlug),["a-one"]);assert.throws(()=>db.getEntity(table,table+"-b-one"),denied());await assert.rejects(db.saveEntity(table,{id:table+"-b-one",agentSlug:"a-one",name:"attempt"}),denied());await assert.rejects(db.patchEntity(table,table+"-b-one",{name:"attempt"}),denied());await assert.rejects(db.removeEntity(table,table+"-b-one"),denied());}await assert.rejects(db.listChunks("documents-b-one"),denied());});
 assert.equal(raw.requireEntity("documents","documents-b-one").name,"合成 documents");assert.equal(raw.listChunks("documents-b-one")[0].text,"合成隔离分片 b-one");
});

test("tenant overview and metadata registries do not expose another institution or global custom template",async t=>{
 const {db,access,run,a,b}=await fixture(t);let ta,tb,global;
 global=await run("root-admin",()=>saveAgentAsTemplate(db,{agentSlug:"internal-one",name:"内部私有模板",description:"合成"},"root-admin"));
 ta=await run("member-a",()=>saveAgentAsTemplate(db,{agentSlug:"a-one",name:"A私有模板",description:"合成"},"member-a"));
 tb=await run("member-b",()=>saveAgentAsTemplate(db,{agentSlug:"b-one",name:"B私有模板",description:"合成"},"member-b"));
 await run("member-a",async()=>{const info=await access.overview();assert.deepEqual(info.tenants.map(x=>x.id),[a.id]);assert.ok(info.members.every(m=>m.tenantId===a.id));assert.equal(Object.values(info.ownership).includes(b.id),false);assert.deepEqual((await listAgentTemplates(db)).filter(x=>!x.builtIn).map(x=>x.id),[ta.id]);await assert.rejects(updateAgentTemplate(db,tb.id,{name:"跨机构修改"},"member-a"),denied());await assert.rejects(updateAgentTemplate(db,global.id,{name:"跨范围修改"},"member-a"),denied());await db.setMeta("synthetic.registry",JSON.stringify({owner:"A"}));});
 await run("member-b",async()=>{assert.deepEqual((await listAgentTemplates(db)).filter(x=>!x.builtIn).map(x=>x.id),[tb.id]);assert.equal(await db.getMeta("synthetic.registry"),null);await db.setMeta("synthetic.registry",JSON.stringify({owner:"B"}));});
 await run("member-a",async()=>assert.equal(JSON.parse(await db.getMeta("synthetic.registry")).owner,"A"));
});

test("governance and private qualification metadata enforce doctor grants even inside internal organization",async t=>{
 const {raw,db,run}=await fixture(t);
 for(const prefix of ["agent-builder.governance.","builder.qualification-files."]){raw.setMeta(prefix+"b-one","foreign-private");await run("member-a",async()=>{assert.throws(()=>db.getMeta(prefix+"b-one"),denied());assert.throws(()=>db.setMeta(prefix+"b-one","attempt"),denied());});await run("internal-member",async()=>{assert.throws(()=>db.getMeta(prefix+"b-one"),denied());assert.throws(()=>db.setMeta(prefix+"b-one","attempt"),denied());});assert.equal(raw.getMeta(prefix+"b-one"),"foreign-private");}
});

test("inactive membership and suspended tenants never fall back to legacy global permissions",async t=>{
 const {access,users,run,a}=await fixture(t);
 await run("root-admin",()=>access.saveMember({username:"member-a",tenantId:a.id,role:"editor",agentSlugs:["a-one"],active:false},"root-admin"));
 await assert.rejects(access.context(users["member-a"]),denied(403));
 await run("root-admin",()=>access.updateTenant(a.id,{status:"suspended"},"root-admin"));
 await assert.rejects(access.context(users["admin-a"]),error=>error.code==="TENANT_SUSPENDED");
});

test("new doctor quotas are transactional and failed reservations leave no agent or ownership",async t=>{
 const {raw,db,access,run,a}=await fixture(t);
 await run("admin-a",async()=>{await db.createAgent(doctor("a-three"),"admin-a");await assert.rejects(db.createAgent(doctor("a-four"),"admin-a"),error=>error.code==="TENANT_QUOTA_EXCEEDED");assert.equal(await db.getAgent("a-four"),null);});
 assert.equal((await access.state()).owners["a-three"],a.id);assert.equal((await access.state()).owners["a-four"],undefined);assert.equal(raw.getAgent("a-four"),null);
 await run("member-a",async()=>await assert.rejects(db.createAgent(doctor("a-forbidden"),"member-a"),denied(403)));
});

test("ownership reassignment removes former explicit grants without broadening either tenant",async t=>{
 const {db,access,users,run,a,b}=await fixture(t);
 await run("root-admin",()=>access.assignAgent("a-one",b.id,"root-admin"));
 const state=await access.state();assert.deepEqual(state.members.find(m=>m.username==="member-a"&&m.tenantId===a.id).agentSlugs,[]);
 const old=await access.context(users["member-a"]);assert.equal(old.legacyGlobal,false);assert.equal(old.allowed.size,0);
 await run("admin-a",async()=>assert.deepEqual((await db.listAgents()).map(x=>x.slug),["a-two"]));
 await run("admin-b",async()=>assert.deepEqual((await db.listAgents()).map(x=>x.slug).sort(),["a-one","b-one"]));
});

test("grant changes revoke existing sessions and member quota failures do not add grants",async t=>{
 const {raw,access,users,run}=await fixture(t);const target=users["member-a"];
 raw.createLoginSession({tokenHash:"synthetic-session",userId:target.id,expiresAt:"2099-01-01T00:00:00.000Z"});assert.ok(raw.findSessionUser("synthetic-session",new Date().toISOString()));
 const own=(await access.state()).members.find(m=>m.username===target.username);await run("root-admin",()=>access.saveMember({...own,role:"viewer"},"root-admin"));assert.equal(raw.findSessionUser("synthetic-session",new Date().toISOString()),undefined);
 await run("root-admin",()=>access.savePlan({id:"one-only",name:"单人合成套餐",priceCents:0,quotas:{agents:1,users:1,storageBytes:1000,monthlyRequests:1}},"root-admin"));
 const tenant=await run("root-admin",()=>access.createTenant({name:"单人合成机构",planId:"one-only"},"root-admin"));
 await run("root-admin",()=>access.saveMember({username:"unbound-user",tenantId:tenant.id,role:"admin",agentSlugs:["*"]},"root-admin"));
 await assert.rejects(run("root-admin",()=>access.saveMember({username:"member-b",tenantId:tenant.id,role:"viewer",agentSlugs:[]},"root-admin")),error=>error.code==="TENANT_QUOTA_EXCEEDED");
 assert.equal((await access.state()).members.filter(m=>m.tenantId===tenant.id).length,1);
});

test("user lists and direct user lookups or mutations cannot cross institutions",async t=>{
 const {raw,db,users,run}=await fixture(t);const foreign=users["member-b"];
 await run("member-a",async()=>{assert.deepEqual((await db.listUsersRaw()).map(x=>x.username).sort(),["admin-a","member-a"]);assert.equal(await db.getUser(foreign.id),null);assert.equal(await db.findUserByUsername(foreign.username),null);await assert.rejects(Promise.resolve().then(()=>db.updateUser(foreign.id,{name:"attempt"})),denied());await assert.rejects(Promise.resolve().then(()=>db.deleteUserSessions(foreign.id)),denied());});
 assert.equal(raw.getUser(foreign.id).name,"合成 member-b");
});

test("same actor membership in two institutions does not leak foreign targeted audit records",async t=>{
 const {raw,db,access,run,a,b}=await fixture(t);
 await run("root-admin",()=>access.saveMember({username:"member-a",tenantId:b.id,role:"viewer",agentSlugs:["b-one"]},"root-admin"));
 raw.audit("synthetic.own","another-actor","a-one");raw.audit("synthetic.foreign","member-a","b-one");raw.audit("synthetic.foreign-document","another-actor","documents-b-one");
 await run("member-a",async()=>{const entries=await db.listAudit(1000);assert.ok(entries.some(e=>e.action==="synthetic.own"));assert.equal(entries.some(e=>e.action==="synthetic.foreign"),false);assert.equal(entries.some(e=>e.action==="synthetic.foreign-document"),false);},a.id);
});

test("chunk replacement cannot spoof an authorized doctor around a foreign document id",async t=>{
 const {raw,db,run}=await fixture(t);
 await run("member-a",async()=>await assert.rejects(Promise.resolve().then(()=>db.replaceChunks({id:"documents-b-one",agentSlug:"a-one"},[{index:0,text:"attempt"}])),denied()));
 assert.equal(raw.listChunks("documents-b-one")[0].text,"合成隔离分片 b-one");
});

test("reactivating an existing inactive member cannot bypass tenant member quota",async t=>{
 const {raw,access,run}=await fixture(t);
 await run("root-admin",()=>access.savePlan({id:"one-seat",name:"单席合成套餐",priceCents:0,quotas:{agents:3,users:1,storageBytes:1000,monthlyRequests:1}},"root-admin"));
 const tenant=await run("root-admin",()=>access.createTenant({name:"单席合成机构",planId:"one-seat"},"root-admin"));
 await run("root-admin",()=>access.saveMember({username:"unbound-user",tenantId:tenant.id,role:"viewer",agentSlugs:[],active:false},"root-admin"));
 await run("root-admin",()=>access.saveMember({username:"member-b",tenantId:tenant.id,role:"viewer",agentSlugs:[]},"root-admin"));
 await assert.rejects(run("root-admin",()=>access.saveMember({username:"unbound-user",tenantId:tenant.id,role:"viewer",agentSlugs:[],active:true},"root-admin")),error=>error.code==="TENANT_QUOTA_EXCEEDED");
 assert.equal((await access.state()).members.filter(m=>m.tenantId===tenant.id&&m.active!==false).length,1);assert.ok(raw.findUserByUsername("unbound-user"));
});

test("moving an existing doctor into a full tenant cannot bypass its agent quota",async t=>{
 const {access,run,a,b}=await fixture(t);
 await run("root-admin",()=>access.savePlan({id:"one-agent",name:"单助手合成套餐",priceCents:0,quotas:{agents:1,users:5,storageBytes:1000,monthlyRequests:1}},"root-admin"));
 await run("root-admin",()=>access.updateTenant(b.id,{planId:"one-agent"},"root-admin"));
 await assert.rejects(run("root-admin",()=>access.assignAgent("a-one",b.id,"root-admin")),error=>error.code==="TENANT_QUOTA_EXCEEDED");
 assert.equal((await access.state()).owners["a-one"],a.id);
});
