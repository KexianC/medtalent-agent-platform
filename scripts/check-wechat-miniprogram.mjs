import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROJECT_ROOT = fileURLToPath(new URL('../wechat-miniprogram/', import.meta.url));
export const REQUIRED_PAGES = ['pages/index/index', 'pages/webview/index', 'pages/about/index', 'pages/policy/index', 'pages/capability/index'];
const ROOT_FILES = new Set(['app.js', 'app.json', 'app.wxss', 'config.js', 'sitemap.json', 'project.config.json']);
const REQUIRED_FILES = [...ROOT_FILES, 'utils/routes.js', 'utils/capabilities.js', ...REQUIRED_PAGES.flatMap(page => ['js', 'json', 'wxml', 'wxss'].map(ext => `${page}.${ext}`))];

export function isAllowedMiniProgramFile(relativePath) {
  return ROOT_FILES.has(relativePath)
    || /^pages\/[a-z0-9_-]+\/[a-zA-Z0-9_.-]+\.(js|json|wxml|wxss)$/.test(relativePath)
    || /^utils\/[a-zA-Z0-9_.-]+\.js$/.test(relativePath)
    || /^assets\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.(png|jpe?g|webp|gif|svg|ico)$/.test(relativePath)
    || /^[^/.][^/]*\.md$/.test(relativePath)
    || /^docs\/(?:[a-zA-Z0-9_-]+\/)*[^/]+\.md$/.test(relativePath);
}

// Parse a deliberately small literal subset. A config check must never execute config.js.
export function parseMiniProgramConfig(source) {
  const tokens = [];
  let offset = 0;
  const fail = () => { throw new Error('config.js 只能导出字符串字面量配置对象，不能包含动态代码'); };
  while (offset < source.length) {
    const rest = source.slice(offset);
    const space = rest.match(/^\s+/);
    if (space) { offset += space[0].length; continue; }
    if (rest.startsWith('//')) {
      const end = source.indexOf('\n', offset + 2);
      offset = end === -1 ? source.length : end + 1;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', offset + 2);
      if (end === -1) fail();
      offset = end + 2;
      continue;
    }
    const quote = source[offset];
    if (quote === "'" || quote === '"') {
      offset += 1;
      let value = '';
      let closed = false;
      while (offset < source.length) {
        const character = source[offset++];
        if (character === quote) { closed = true; break; }
        if (character === '\n' || character === '\r') fail();
        if (character !== '\\') { value += character; continue; }
        const escaped = source[offset++];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"' };
        if (Object.hasOwn(escapes, escaped)) { value += escapes[escaped]; continue; }
        if (escaped === 'u' || escaped === 'x') {
          const length = escaped === 'u' ? 4 : 2;
          const hex = source.slice(offset, offset + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) fail();
          value += String.fromCharCode(Number.parseInt(hex, 16));
          offset += length;
          continue;
        }
        fail();
      }
      if (!closed) fail();
      tokens.push({ kind: 'string', value });
      continue;
    }
    const identifier = rest.match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
    if (identifier) {
      tokens.push({ kind: 'identifier', value: identifier[0] });
      offset += identifier[0].length;
      continue;
    }
    if ('.=(){},:;'.includes(quote)) {
      tokens.push({ kind: 'punctuation', value: quote });
      offset += 1;
      continue;
    }
    fail();
  }
  let cursor = 0;
  const expect = value => { if (tokens[cursor++]?.value !== value) fail(); };
  expect('module'); expect('.'); expect('exports'); expect('=');
  const frozen = tokens[cursor]?.value === 'Object';
  if (frozen) { expect('Object'); expect('.'); expect('freeze'); expect('('); }
  expect('{');
  const config = Object.create(null);
  while (tokens[cursor]?.value !== '}') {
    const key = tokens[cursor++];
    if (!key || !['string', 'identifier'].includes(key.kind) || ['__proto__', 'constructor', 'prototype'].includes(key.value) || Object.hasOwn(config, key.value)) fail();
    expect(':');
    const value = tokens[cursor++];
    if (value?.kind !== 'string') fail();
    config[key.value] = value.value;
    if (tokens[cursor]?.value === '}') break;
    expect(',');
  }
  expect('}');
  if (frozen) expect(')');
  if (tokens[cursor]?.value === ';') cursor += 1;
  if (cursor !== tokens.length) fail();
  return config;
}

function validateOrigin(value) {
  if (typeof value !== 'string') return 'h5Origin 必须是 HTTPS 公网域名';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin || url.port) return 'h5Origin 必须是无端口、路径、账号、查询参数的 HTTPS 源站地址';
    const hostname = url.hostname.toLowerCase();
    if (!hostname.includes('.') || hostname === 'localhost' || /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(hostname) || /^\[/.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return 'h5Origin 必须使用公网域名，不能是本地地址或 IP';
    return null;
  } catch { return 'h5Origin 不是合法 URL'; }
}

function validateHomePath(value, origin) {
  // 与小程序 utils/routes.js 的公开入口一致；后台/查询参数不能伪装成已校验入口。
  if (typeof value !== 'string' || !/^(?:\/|\/d\/[a-z0-9][a-z0-9-]{1,62}[a-z0-9]\/?)$/.test(value)) return false;
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f<>]/.test(value)) return false;
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || /[\\\u0000-\u001f]/.test(decoded) || decoded.split(/[/?#]/).includes('..')) return false;
    return new URL(value, origin).origin === origin;
  } catch { return false; }
}

async function readJson(filename, relativePath, errors) {
  try {
    const data = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON 顶层必须为对象');
    return data;
  }
  catch (error) { errors.push(`${relativePath}: ${error.message}`); return null; }
}

async function collectFiles(root, errors) {
  const result = [];
  const walk = async (directory, prefix = '') => {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { errors.push(`无法读取工程目录 ${directory}: ${error.message}`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { errors.push(`禁止符号链接进入小程序包: ${relative}`); continue; }
      if (/^(?:\.env(?:\..*)?|node_modules|server|\.git|\.codex|\.agents)$/i.test(entry.name) || /\.(?:pem|key|pfx|p12|sqlite|db|zip|tar|gz)$/i.test(entry.name)) {
        errors.push(`禁止服务端、凭据、数据库或归档文件进入小程序包: ${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!['pages', 'utils', 'assets', 'docs'].includes(relative.split('/')[0])) { errors.push(`非白名单目录: ${relative}`); continue; }
        await walk(path.join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        if (relative === 'project.private.config.json') continue;
        if (!isAllowedMiniProgramFile(relative)) errors.push(`非白名单文件: ${relative}`);
        else result.push(relative);
      } else errors.push(`不支持的文件类型: ${relative}`);
    }
  };
  await walk(root);
  return result.sort();
}

async function checkOnline(origin, fetchImpl, errors, facts) {
  for (const endpoint of ['/', '/api/health', '/api/doctors']) {
    try {
      const response = await fetchImpl(`${origin}${endpoint}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { Accept: endpoint === '/' ? 'text/html' : 'application/json' } });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (endpoint === '/') {
        if (!contentType.includes('text/html')) throw new Error('首页未返回 HTML');
        const html = await response.text();
        if (!/<(?:html|!doctype)/i.test(html)) throw new Error('首页 HTML 内容无效');
        facts.push('HTTPS 首页返回有效 HTML (200)');
      } else {
        if (!contentType.includes('application/json')) throw new Error('API 未返回 JSON');
        const data = await response.json();
        if (endpoint === '/api/health') {
          if (!data || typeof data !== 'object' || !(data.ok === true || ['ok', 'healthy', 'up'].includes(data.status))) throw new Error('健康响应结构无效或服务报告异常');
          facts.push('HTTPS /api/health 返回正常状态 (200)');
        } else {
          const doctors = Array.isArray(data) ? data : (Array.isArray(data?.doctors) ? data.doctors : null);
          if (!doctors || doctors.length === 0) throw new Error('智能体列表为空或结构无效');
          facts.push(`HTTPS /api/doctors 返回 ${doctors.length} 个智能体 (200；未打印明细)`);
        }
      }
    } catch (error) { errors.push(`线上只读检查 ${endpoint} 失败: ${error.message}`); }
  }
}

export async function checkWechatMiniProgram({ projectRoot = DEFAULT_PROJECT_ROOT, release = false, online = false, fetchImpl = globalThis.fetch } = {}) {
  const root = path.resolve(projectRoot);
  const errors = [];
  const warnings = [];
  const facts = [];
  const files = await collectFiles(root, errors);
  for (const relative of REQUIRED_FILES) if (!files.includes(relative)) errors.push(`缺少必需文件: ${relative}`);
  const jsonFiles = new Map();
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split('/'));
    if (relative.endsWith('.json')) jsonFiles.set(relative, await readJson(absolute, relative, errors));
    if (relative.endsWith('.js')) {
      try { new vm.Script(await fs.readFile(absolute, 'utf8'), { filename: relative }); }
      catch (error) { errors.push(`JavaScript 语法错误 ${relative}: ${error.message}`); }
    }
  }
  const project = jsonFiles.get('project.config.json');
  if (project) {
    if (project.compileType !== 'miniprogram') errors.push('project.config.json compileType 必须为 miniprogram');
    if (project.miniprogramRoot && !['./', '.'].includes(project.miniprogramRoot)) errors.push('miniprogramRoot 必须指向工程自身，禁止打包外层仓库');
    const appid = project.appid;
    if (appid === 'touristappid' || appid === '') (release ? errors : warnings).push('待完成: 请将 touristappid 换成自己的微信小程序 AppID');
    else if (typeof appid !== 'string' || !/^wx[0-9a-f]{16}$/.test(appid)) errors.push('AppID 格式无效，必须为 wx 加 16 位小写十六进制字符');
    if (project.setting?.urlCheck !== true) (release ? errors : warnings).push('提交前必须将 project.config.json setting.urlCheck 设置为 true');
  }
  try {
    const privateConfig = JSON.parse(await fs.readFile(path.join(root, 'project.private.config.json'), 'utf8'));
    warnings.push('本机 project.private.config.json 不会进入发布 ZIP');
    if (privateConfig.setting?.urlCheck === false) (release ? errors : warnings).push('本机私有设置关闭了 URL 校验，请恢复 urlCheck=true 后提审');
  } catch (error) { if (error.code !== 'ENOENT') errors.push(`project.private.config.json: ${error.message}`); }
  const app = jsonFiles.get('app.json');
  if (app) {
    const pages = Array.isArray(app.pages) ? app.pages : [];
    if (pages[0] !== 'pages/index/index') errors.push('首页必须是 pages/index/index');
    for (const page of REQUIRED_PAGES) if (!pages.includes(page)) errors.push(`app.json 未注册页面: ${page}`);
    if (Array.isArray(app.pages)) {
      if (new Set(pages).size !== pages.length) errors.push('app.json 包含重复页面路由');
      for (const page of pages) {
        if (typeof page !== 'string' || !/^pages\/[a-z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(page)) { errors.push('app.json 包含不安全或无效页面路由'); continue; }
        for (const ext of ['js', 'json', 'wxml', 'wxss']) if (!files.includes(`${page}.${ext}`)) errors.push(`已注册页面缺少文件: ${page}.${ext}`);
      }
    }
    if (app.sitemapLocation !== 'sitemap.json') errors.push('app.json sitemapLocation 必须为 sitemap.json');
  }
  let config = null;
  if (files.includes('config.js')) {
    try {
      config = parseMiniProgramConfig(await fs.readFile(path.join(root, 'config.js'), 'utf8'));
      const configFields = ['appName', 'h5Origin', 'homePath', 'version', 'operatorName', 'privacyEmail', 'privacyUpdatedAt'];
      for (const field of configFields) {
        if (typeof config[field] !== 'string') errors.push(`config.js 缺少字符串配置: ${field}`);
      }
      for (const field of Object.keys(config)) if (!configFields.includes(field)) errors.push(`config.js 包含非白名单配置项: ${field}；只允许公开入口配置`);
      if (!config.appName?.trim()) errors.push('appName 不能为空');
      if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(config.version || '')) errors.push('version 必须使用类似 1.0.0 的版本号');
      const originError = validateOrigin(config.h5Origin);
      if (originError) errors.push(originError);
      if (!originError && !validateHomePath(config.homePath, config.h5Origin)) errors.push('homePath 只允许 / 或 /d/{slug} 公开入口，禁止后台、查询参数、跨域或目录回退');
      for (const [field, title] of [['operatorName', '运营主体名称'], ['privacyEmail', '隐私联系邮箱']]) {
        if (!config[field]?.trim()) (release ? errors : warnings).push(`待完成: 请填写${title} (${field})`);
      }
      if (config.operatorName && (/^(?:待填写|请填写|TODO|TBD|公司名称|运营主体|your company)$/i.test(config.operatorName.trim()) || /[<>\r\n]/.test(config.operatorName))) errors.push('operatorName 不能使用占位词或 HTML');
      if (config.privacyEmail && (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(config.privacyEmail) || /@(?:example\.(?:com|org|net)|[^@]+\.(?:invalid|test))$/i.test(config.privacyEmail))) errors.push('privacyEmail 必须为实际可联系的邮箱地址，不能使用示例域名');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(config.privacyUpdatedAt || '') || Number.isNaN(Date.parse(config.privacyUpdatedAt)) || new Date(config.privacyUpdatedAt).toISOString().slice(0, 10) !== config.privacyUpdatedAt) errors.push('privacyUpdatedAt 必须为有效的 YYYY-MM-DD 日期');
      if (!originError && online) await checkOnline(config.h5Origin, fetchImpl, errors, facts);
    } catch (error) { errors.push(`config.js: ${error.message}`); }
  }
  if (!errors.length) facts.unshift(`结构检查通过：${files.length} 个白名单文件，${REQUIRED_PAGES.length} 个必需页面，JSON 与 JavaScript 语法有效`);
  warnings.push('自动检查不代表微信审核通过、业务域名已配置或微信真机验证完成');
  return { ok: errors.length === 0, errors, warnings, facts, files, config };
}

export function printCheckResult(result) {
  for (const fact of result.facts) console.log(`[通过] ${fact}`);
  for (const warning of result.warnings) console.log(`[待确认] ${warning}`);
  for (const error of result.errors) console.error(`[错误] ${error}`);
}

// Windows workspace shortcuts can resolve to a different drive in import.meta.url.
const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--release', '--online'].includes(arg))) {
    console.error('用法: node scripts/check-wechat-miniprogram.mjs [--release] [--online]');
    process.exitCode = 1;
  } else {
    const result = await checkWechatMiniProgram({ release: args.includes('--release'), online: args.includes('--online') });
    printCheckResult(result);
    process.exitCode = result.ok ? 0 : 1;
  }
}
