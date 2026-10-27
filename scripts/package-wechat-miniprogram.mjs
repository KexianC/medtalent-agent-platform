import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWechatMiniProgram, DEFAULT_PROJECT_ROOT, isAllowedMiniProgramFile, printCheckResult } from './check-wechat-miniprogram.mjs';

export const DEFAULT_OUTPUT_PATH = fileURLToPath(new URL('../output/wechat/Medtalent-微信小程序.zip', import.meta.url));
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

// ZIP's stored mode is universally readable, requires no npm dependency and preserves UTF-8 names.
export function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const filename = Buffer.from(name, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x5021, 12); // 2020-01-01: deterministic artifact timestamp.
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(0x5021, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, filename, data);
    central.push(record, filename);
    offset += local.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export async function packageWechatMiniProgram({ projectRoot = DEFAULT_PROJECT_ROOT, outputPath = DEFAULT_OUTPUT_PATH } = {}) {
  const result = await checkWechatMiniProgram({ projectRoot });
  if (!result.ok) {
    const error = new Error(`小程序结构检查失败，停止打包：\n${result.errors.join('\n')}`);
    error.checkResult = result;
    throw error;
  }
  const root = await fs.realpath(projectRoot);
  const output = path.resolve(outputPath);
  const relativeOutput = path.relative(root, output);
  if (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)) throw new Error('ZIP 必须输出在小程序源码目录外');
  const entries = [];
  for (const name of result.files) {
    if (!isAllowedMiniProgramFile(name)) throw new Error(`拒绝打包非白名单文件: ${name}`);
    const absolute = path.join(root, ...name.split('/'));
    const resolved = await fs.realpath(absolute);
    const relative = path.relative(root, resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || (await fs.lstat(absolute)).isSymbolicLink()) throw new Error(`拒绝打包工程外文件: ${name}`);
    const data = await fs.readFile(absolute);
    if (data.length > 5 * 1024 * 1024) throw new Error(`文件超过 5 MB，请检查是否误放了大文件: ${name}`);
    entries.push({ name, data });
  }
  const zip = buildZip(entries);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, zip);
  return { ...result, outputPath: output, bytes: zip.length, entryCount: entries.length };
}

const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('用法: node scripts/package-wechat-miniprogram.mjs');
    const result = await packageWechatMiniProgram();
    printCheckResult(result);
    console.log(`已生成开发者工具导入包: ${result.outputPath} (${result.entryCount} 个文件，${result.bytes} 字节)`);
    console.log('解压后导入目录；提交前执行 --release --online 检查，并完成微信后台配置和真机验收。');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
