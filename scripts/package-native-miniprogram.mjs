import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkNative,project,root,nativeFiles } from './check-native-miniprogram.mjs';
import { buildZip } from './package-wechat-miniprogram.mjs';
const check=await checkNative();if(!check.ok)throw new Error(check.errors.join('\n'));
const entries=[];for(const name of await nativeFiles()){if(name==='project.private.config.json')continue;entries.push({name,data:await fs.readFile(path.join(project,name))});}
const zip=buildZip(entries);const output=path.join(root,'output/native/Medtalent-微信原生小程序.zip');await fs.writeFile(output,zip);await fs.writeFile(path.join(root,'output/native/package-receipt.json'),JSON.stringify({createdAt:new Date().toISOString(),path:output,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),sourceManifestSha256:createHash('sha256').update(await fs.readFile(path.join(project,'build-manifest.json'))).digest('hex'),files:entries.length,nativeVisualParityAccepted:false,uploaded:false,auditSubmitted:false,published:false},null,2)+'\n');console.log(`原生导入包已生成 ${output} (${zip.length} bytes)。未上传、提审或发布。`);
