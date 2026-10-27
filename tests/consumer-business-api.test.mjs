import test from 'node:test';
import assert from 'node:assert/strict';
import {consumerBusinessRequest,businessIdempotencyKey,businessStatusLabel} from '../src/lib/businessApi.ts';
const identity={userId:'synthetic-consumer',csrfToken:'synthetic-session-csrf'};
test('consumer business requests use current cookie and CSRF without accepting client-selected identity in their payload',async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,...options});return Response.json({id:'synthetic-appointment',status:'requested'})};
 await consumerBusinessRequest('doctor-one','',{identity,fetchImpl});await consumerBusinessRequest('doctor-one','/appointments',{method:'POST',identity,body:{slotId:'synthetic-slot',idempotencyKey:'synthetic-stable-token'},fetchImpl});
 assert.equal(calls[0].url,'/api/user/business/doctor-one');assert.equal(calls[0].credentials,'include');assert.equal(calls[0].cache,'no-store');assert.deepEqual(calls[0].headers,{});assert.equal(calls[1].headers['X-CSRF-Token'],identity.csrfToken);assert.equal(calls[1].headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(calls[1].body),{slotId:'synthetic-slot',idempotencyKey:'synthetic-stable-token'});assert.equal(calls[1].body.includes(identity.userId),false);
});
test('business request helper rejects missing identity, missing write CSRF, and nonlocal path forms before fetch',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return Response.json({})};
 await assert.rejects(consumerBusinessRequest('doctor-one','/appointments',{method:'POST',identity:{userId:'',csrfToken:'x'},fetchImpl}));await assert.rejects(consumerBusinessRequest('doctor-one','/appointments',{method:'POST',identity:{userId:'owner',csrfToken:''},fetchImpl}));for(const suffix of ['//external.invalid','/../other','/orders?userId=other','https://external.invalid'])await assert.rejects(consumerBusinessRequest('doctor-one',suffix,{identity,fetchImpl}));assert.equal(calls,0);
});
test('unconfigured provider errors stay errors and request cancellation is passed to fetch',async()=>{
 const controller=new AbortController();let observed;await assert.rejects(consumerBusinessRequest('doctor-one','/subscriptions',{method:'POST',identity,signal:controller.signal,body:{consent:true},fetchImpl:async(_url,options)=>{observed=options.signal;return Response.json({error:'提醒服务尚未配置',code:'BUSINESS_NOT_CONFIGURED'},{status:503})}}),/尚未配置/);assert.equal(observed,controller.signal);
});
test('idempotency keys fit the server bounded format and unknown results never display an accepted status',()=>{
 const first=businessIdempotencyKey(),second=businessIdempotencyKey();assert.match(first,/^[A-Za-z0-9_-]{8,128}$/);assert.notEqual(first,second);assert.equal(businessStatusLabel('unknown'),'结果待核对');assert.notEqual(businessStatusLabel('unknown'),businessStatusLabel('accepted'));
});
