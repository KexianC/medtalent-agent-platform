import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createNativeLoader } from './native-module-loader.mjs';
export const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const projectIndex=process.argv.indexOf('--project');
const projectArgument=projectIndex>=0?process.argv[projectIndex+1]:undefined;
if(projectIndex>=0&&(!projectArgument||!path.isAbsolute(projectArgument)))throw new Error('--project requires an absolute path');
export const project=projectArgument?path.resolve(projectArgument):path.join(root,'wechat-native');
export async function nativeFiles(dir=project,prefix=''){let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const name=path.posix.join(prefix,e.name);if(e.isSymbolicLink())throw new Error(`工程不允许符号链接 ${name}`);if(e.isDirectory())out.push(...await nativeFiles(path.join(dir,e.name),name));else out.push(name);}return out.sort();}
const exportProject=project;
export async function checkNative({compile=true,project:projectOverride}={}) {
  const project=projectOverride?path.resolve(projectOverride):exportProject;
  const names=await nativeFiles(project);const manifest=JSON.parse(await fs.readFile(path.join(project,'build-manifest.json'),'utf8'));
  const manifestFiles=new Map(manifest.files.map(f=>[f.path,f]));
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const app=JSON.parse(await fs.readFile(path.join(project,'app.json'),'utf8'));
  const subpackages=app.subpackages||app.subPackages||[];
  const packageRoots=subpackages.map(p=>p.root.replace(/\/$/,'')+'/');
  const subpackagesBytes=Object.fromEntries(packageRoots.map(p=>[p,0]));
  const errors=[];let bytes=0,totalProjectBytes=0;
  for(const name of names){if(name==='project.private.config.json'||name==='build-manifest.json')continue;
    if(!/^(?:app\.(?:js|json|wxss)|config\.js|project\.config\.json|sitemap\.json|README\.md|(?:pages|components|utils|assets|subpackages)\/[a-zA-Z0-9_./-]+\.(?:js|json|wxml|wxss|png|jpg|jpeg|webp))$/.test(name))errors.push(`非白名单文件 ${name}`);
    const b=await fs.readFile(path.join(project,name));totalProjectBytes+=b.length;const packageRoot=packageRoots.find(p=>name.startsWith(p));if(packageRoot)subpackagesBytes[packageRoot]+=b.length;else bytes+=b.length;const known=manifestFiles.get(name);if(!known||known.sha256!==hash(b))errors.push(`构建清单不匹配 ${name}，请重新 build:native`);
    if(name.endsWith('.wxml')){
      const text=b.toString();if(/<web-view\b/i.test(text))errors.push(`原生版包含 WebView ${name}`);
      for(const binding of text.matchAll(/wx:(?:if|elif|for)="([^"]*)"/g))if(!/^\{\{[\s\S]+\}\}$/.test(binding[1]))errors.push(`原生条件/循环缺少动态绑定 ${name}: ${binding[0]}`);
      for(const binding of text.matchAll(/\{\{[^}]+\}\}/g))if(/&(?:amp|lt|gt);/.test(binding[0]))errors.push(`WXML 表达式不允许 HTML 转义运算符 ${name}: ${binding[0]}`);
    }
    if(name.endsWith('.json')){try{JSON.parse(b.toString());}catch(e){errors.push(`JSON 无效 ${name}: ${e.message}`);}}
  }
  for(const source of manifest.sharedSources){if(hash(await fs.readFile(path.join(root,source.path)))!==source.sha256)errors.push(`共享 H5 模型已变化 ${source.path}`);}
  for(const page of [...app.pages,...subpackages.flatMap(p=>p.pages.map(page=>p.root+'/'+page))])for(const ext of ['js','json','wxml','wxss'])if(!names.includes(`${page}.${ext}`))errors.push(`缺少页面 ${page}.${ext}`);
  for(const name of names.filter(n=>n.endsWith('.json')&&(n.startsWith('pages/')||n.startsWith('components/')||n.startsWith('subpackages/')))){
    const def=JSON.parse(await fs.readFile(path.join(project,name),'utf8'));for(const [alias,p] of Object.entries(def.usingComponents||{})){
      const base=p.startsWith('/')?p.slice(1):path.posix.normalize(path.posix.join(path.posix.dirname(name),p));for(const ext of ['js','json','wxml','wxss'])if(!names.includes(`${base}.${ext}`))errors.push(`组件 ${alias} 文件不存在 ${base}.${ext}`);
    }
  }
  // Node syntax and the native CommonJS graph both catch missing model exports.
  for(const name of names.filter(n=>n.endsWith('.js'))){const run=spawnSync(process.execPath,['--check',path.join(project,name)],{encoding:'utf8'});if(run.status!==0)errors.push(`JS 语法 ${name}: ${run.stderr}`);}
  const requireNative=createNativeLoader({wx:{getStorageSync:()=>'',getStorageInfoSync:()=>({keys:[]})},App:()=>{},Page:()=>{},Component:()=>{}});
  for(const name of names.filter(n=>n.endsWith('.js'))){try{requireNative(path.join(project,name));}catch(e){errors.push(`JS 模块 ${name}: ${e.message}`);}}
  for (const template of names.filter(n=>n.endsWith('.wxml'))) {
    let definition;const script=template.replace(/\.wxml$/,'.js');
    try {const loader=createNativeLoader({wx:{getStorageSync:()=>'',getStorageInfoSync:()=>({keys:[]})},App:()=>{},Page:value=>{definition=value;},Component:value=>{definition=value;}});loader(path.join(project,script));
      if(!definition)throw new Error('缺少 Page/Component 注册');
      const handlers={...definition,...definition.methods};
      for(const event of (await fs.readFile(path.join(project,template),'utf8')).matchAll(/(?:bind|catch)(?::?[a-zA-Z]+)="([a-zA-Z_$][\w$]*)"/g))if(typeof handlers[event[1]]!=='function')errors.push(`事件处理函数不存在 ${template}: ${event[1]}`);
    }catch(e){errors.push(`模板事件校验 ${template}: ${e.message}`);}
  }
  const compilerDir=process.env.WECHAT_COMPILER_DIR||'D:/微信开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec';
  const compilation=[];if(compile){await fs.mkdir(path.join(root,'output/native/compile'),{recursive:true});
    for(const [binary,ext,args] of [['wcc.exe','.wxml',[]],['wcsc.exe','.wxss',['-lc']]]){
      const executable=path.join(compilerDir,binary);try{await fs.access(executable);}catch{errors.push(`官方编译器不可用 ${binary}；请设置 WECHAT_COMPILER_DIR`);continue;}
      const output=path.join(root,'output/native/compile',`${binary}.js`);const inputs=names.filter(n=>n.endsWith(ext));const run=spawnSync(executable,[...args,'-o',output,...inputs],{cwd:project,encoding:'utf8',maxBuffer:16*1024*1024});
      compilation.push({compiler:binary,exitCode:run.status,files:inputs.length,diagnostics:run.stderr||'',output});if(run.status!==0)errors.push(`${binary} 编译失败：${run.stderr||run.stdout}`);
    }
  }
  if(bytes>2*1024*1024)errors.push(`主包超过 2MB ${bytes}`);
  for(const [p,n] of Object.entries(subpackagesBytes))if(n>2*1024*1024)errors.push(`分包超过 2MB ${p}: ${n}`);
  if(totalProjectBytes>20*1024*1024)errors.push(`工程超过 20MB ${totalProjectBytes}`);
  const result={ok:errors.length===0,totalBytes:bytes,totalProjectBytes,subpackagesBytes,fileCount:names.length,webViews:0,pages:app.pages,compilation,errors};await fs.mkdir(path.join(root,'output/native'),{recursive:true});await fs.writeFile(path.join(root,'output/native/check-result.json'),JSON.stringify(result,null,2)+'\n');return result;
}
const invoked=process.argv[1]?await fs.realpath(process.argv[1]).catch(()=>path.resolve(process.argv[1])):'';
if(invoked.toLowerCase()===fileURLToPath(import.meta.url).toLowerCase()){const result=await checkNative();console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;}
