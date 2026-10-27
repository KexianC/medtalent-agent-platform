import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns';
import {Readable} from 'node:stream';
import {validateProviderEndpoint} from './provider-registry.mjs';
export function pinnedProviderFetch(url,options={}, {allowLocal=false,lookupImpl=lookup}={}){
 const parsed=new URL(url);if(parsed.username||parsed.password||parsed.hash)throw new Error('Provider URL credentials and fragments are disabled');validateProviderEndpoint(parsed.origin,{allowLocal});
 if(options.redirect&&options.redirect!=='error')throw new Error('Provider redirects are disabled');
 return new Promise((resolve,reject)=>{
  const request=(parsed.protocol==='https:'?https:http).request(parsed,{method:options.method||'GET',headers:options.headers,agent:false,signal:options.signal,lookup(host,lookupOptions,callback){lookupImpl(host,{all:true,verbatim:true},(error,addresses)=>{if(error)return callback(error);try{if(!addresses?.length)throw new Error('No provider address');for(const address of addresses)validateProviderEndpoint((parsed.protocol+'//'+(address.family===6?'['+address.address+']':address.address)),{allowLocal});const selected=addresses[0];callback(null,lookupOptions?.all?addresses:selected.address,selected.family)}catch(error){callback(error)}})}},incoming=>{
   try{const headers=new Headers();for(let i=0;i<incoming.rawHeaders.length;i+=2)headers.append(incoming.rawHeaders[i],incoming.rawHeaders[i+1]);
   const noBody=[204,205,304].includes(incoming.statusCode);if(noBody)incoming.resume();resolve(new Response(noBody?null:Readable.toWeb(incoming),{status:incoming.statusCode,statusText:incoming.statusMessage,headers}));}catch(error){incoming.destroy();reject(error)}
  });request.once('error',reject);if(options.body!==undefined){if(typeof options.body!=='string'&&!Buffer.isBuffer(options.body)){request.destroy(new Error('Unsupported provider payload'));return}request.end(options.body)}else request.end();
 });
}
