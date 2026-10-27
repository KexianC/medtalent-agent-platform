// Isolated local fixture. Never reads .env.local or the production database.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatformApp } from '../server/app.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args=process.argv.slice(2);
if(args.length>1||args.length===1&&!args[0].startsWith('--reuse-qa-dir='))throw new Error('Use --reuse-qa-dir=<existing .tmp/native-qa-* directory> or no arguments.');
let dataDir;
if(args.length){
  const selected=path.resolve(root,args[0].slice('--reuse-qa-dir='.length)),temporaryRoot=path.resolve(root,'.tmp');
  if(path.dirname(selected).toLowerCase()!==temporaryRoot.toLowerCase()||!/^native-qa-[a-zA-Z0-9]+$/.test(path.basename(selected)))throw new Error('Only an existing disposable native QA directory inside this workspace may be reused.');
  dataDir=await fs.realpath(selected);
  if(dataDir.toLowerCase()!==selected.toLowerCase()||!(await fs.lstat(path.join(dataDir,'platform.sqlite'))).isFile()||(await fs.lstat(path.join(dataDir,'platform.sqlite'))).isSymbolicLink())throw new Error('QA directory or database boundary changed.');
}else dataDir=await fs.mkdtemp(path.join(root,'.tmp/native-qa-'));
const app=await createPlatformApp({dataDir,env:{NODE_ENV:'development',WECHAT_APP_ID:'wx7a4c71565eeee4b9',WECHAT_APP_SECRET:'native-local-only-test-secret'},startWorker:false,disableRateLimits:true,fetchImpl:async url=>{
  if(new URL(url).hostname==='api.weixin.qq.com')return Response.json({openid:'native-local-only-openid',session_key:'not-for-use'});throw new Error('本地验收不调用外部模型或语音供应商');
}});
const server=app.app.listen(8788,'127.0.0.1',()=>console.log('Native local QA API http://127.0.0.1:8788 (isolated SQLite, simulated WeChat; AI/speech unconfigured)'));
async function close(){await new Promise(r=>server.close(r));await app.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
