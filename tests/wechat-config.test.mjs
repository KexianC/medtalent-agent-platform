import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkWechatMiniProgram, parseMiniProgramConfig, REQUIRED_PAGES } from '../scripts/check-wechat-miniprogram.mjs';
import { packageWechatMiniProgram } from '../scripts/package-wechat-miniprogram.mjs';

const configuration = {
  appName: 'Medtalent智能体', h5Origin: 'https://agent.hzmwmt.com', homePath: '/', version: '1.0.0',
  operatorName: '杭州测试科技有限公司', privacyEmail: 'privacy@hzmwmt.com', privacyUpdatedAt: '2026-09-07',
};
async function fixture(t, changes = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-config-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, 'wechat-miniprogram');
  const write = async (name, data) => {
    const filename = path.join(projectRoot, ...name.split('/'));
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, data, 'utf8');
  };
  const config = { ...configuration, ...changes };
  await write('config.js', `module.exports = Object.freeze(${JSON.stringify(config, null, 2)});\n`);
  await write('project.config.json', JSON.stringify({ appid: 'wx1234567890abcdef', compileType: 'miniprogram', miniprogramRoot: './', setting: { urlCheck: true } }));
  await write('app.json', JSON.stringify({ pages: REQUIRED_PAGES, sitemapLocation: 'sitemap.json' }));
  await write('sitemap.json', JSON.stringify({ rules: [{ action: 'disallow', page: '*' }] }));
  await write('app.js', 'App({});');
  await write('app.wxss', 'page { color: #000; }');
  await write('utils/routes.js', 'module.exports = {};');
  await write('utils/capabilities.js', 'module.exports = {};');
  for (const page of REQUIRED_PAGES) {
    await write(`${page}.js`, 'Page({});');
    await write(`${page}.json`, '{}');
    await write(`${page}.wxml`, '<view>入口</view>');
    await write(`${page}.wxss`, 'view { display: block; }');
  }
  return { temporary, projectRoot, write, config };
}

test('literal config accepts comments and quotes without executing JavaScript', () => {
  assert.equal(parseMiniProgramConfig("// 说明\nmodule.exports = { appName: 'Medtalent智能体', homePath: '/', }; ").appName, 'Medtalent智能体');
  assert.throws(() => parseMiniProgramConfig('module.exports = { appName: process.env.SECRET };'));
  assert.throws(() => parseMiniProgramConfig('module.exports = { appName: "a" }; process.exit(0);'));
  assert.throws(() => parseMiniProgramConfig('module.exports = { __proto__: "a" };'));
  assert.throws(() => parseMiniProgramConfig('module.exports = { h5Origin: "a", h5Origin: "b" };'));
});

test('fully configured source passes release structure checks without a network call', async t => {
  const { projectRoot } = await fixture(t);
  const result = await checkWechatMiniProgram({ projectRoot, release: true, fetchImpl: () => assert.fail('network must be opt-in') });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.warnings.some(item => item.includes('不代表微信审核通过')), true);
});

test('unconfigured identity packages for review but blocks release', async t => {
  const { projectRoot, write } = await fixture(t, { operatorName: '', privacyEmail: '' });
  await write('project.config.json', JSON.stringify({ appid: 'touristappid', compileType: 'miniprogram', setting: { urlCheck: true } }));
  const normal = await checkWechatMiniProgram({ projectRoot });
  assert.equal(normal.ok, true, normal.errors.join('\n'));
  assert.equal(normal.warnings.filter(item => item.startsWith('待完成')).length, 3);
  const release = await checkWechatMiniProgram({ projectRoot, release: true });
  assert.equal(release.ok, false);
  assert.equal(release.errors.filter(item => item.startsWith('待完成')).length, 3);
});

test('malicious AppID and unsafe developer URL settings are rejected', async t => {
  const { projectRoot, write } = await fixture(t);
  await write('project.config.json', JSON.stringify({ appid: 'wx1234567890abcdef\"; process.exit()', compileType: 'miniprogram', setting: { urlCheck: false } }));
  const result = await checkWechatMiniProgram({ projectRoot, release: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes('AppID')));
  assert.ok(result.errors.some(item => item.includes('urlCheck')));
});

test('local private override cannot silently bypass release domain validation', async t => {
  const { projectRoot, write } = await fixture(t);
  await write('project.private.config.json', JSON.stringify({ setting: { urlCheck: false } }));
  const result = await checkWechatMiniProgram({ projectRoot, release: true });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes('私有设置')));
  assert.ok(!result.files.includes('project.private.config.json'));
});

test('WebView refuses non-HTTPS, credentials, local IPs and disguised hostnames', async t => {
  const { projectRoot, write, config } = await fixture(t);
  for (const h5Origin of ['http://agent.hzmwmt.com', 'https://user:secret@agent.hzmwmt.com', 'https://127.0.0.1', 'https://2130706433', 'https://agent.hzmwmt.com@evil.com', 'https://agent.hzmwmt.com/path', 'https://agent.hzmwmt.com?redirect=x', 'https://agent.local', 'https://agent.hzmwmt.com:8443']) {
    await write('config.js', `module.exports = ${JSON.stringify({ ...config, h5Origin })};`);
    const result = await checkWechatMiniProgram({ projectRoot });
    assert.equal(result.ok, false, h5Origin);
    assert.ok(result.errors.some(item => item.includes('h5Origin')), result.errors.join('\n'));
  }
});

test('entry path cannot escape its origin or contain encoded traversal', async t => {
  const { projectRoot, write, config } = await fixture(t);
  for (const homePath of ['//evil.com', '/%2fevil.com', '/\\evil.com', '/../admin', '/%2e%2e/admin', '/%0ahello', '/admin', '/?token=secret', '/d/tang-jinsong?question=private']) {
    await write('config.js', `module.exports = ${JSON.stringify({ ...config, homePath })};`);
    const result = await checkWechatMiniProgram({ projectRoot });
    assert.equal(result.ok, false, homePath);
    assert.ok(result.errors.some(item => item.includes('homePath')));
  }
});

test('missing registered page and broken JavaScript block package generation', async t => {
  const { projectRoot, write, temporary } = await fixture(t);
  await fs.unlink(path.join(projectRoot, 'pages/webview/index.wxml'));
  await write('pages/about/index.js', 'Page({ broken: );');
  const result = await checkWechatMiniProgram({ projectRoot });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes('index.wxml')));
  assert.ok(result.errors.some(item => item.includes('JavaScript 语法')));
  const outputPath = path.join(temporary, 'output.zip');
  await assert.rejects(packageWechatMiniProgram({ projectRoot, outputPath }), /结构检查失败/);
  await assert.rejects(fs.access(outputPath));
});

test('valid JSON with invalid structural types reports errors instead of bypassing checks', async t => {
  const { projectRoot, write } = await fixture(t);
  await write('app.json', JSON.stringify({ pages: 42, sitemapLocation: 'sitemap.json' }));
  await write('project.config.json', 'null');
  const result = await checkWechatMiniProgram({ projectRoot });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes('JSON 顶层')));
  assert.ok(result.errors.some(item => item.includes('未注册页面')));
});

test('unrecognized config fields cannot smuggle server credentials into the client', async t => {
  const { projectRoot } = await fixture(t, { appSecret: 'fixture-secret-do-not-ship' });
  const result = await checkWechatMiniProgram({ projectRoot });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(item => item.includes('非白名单配置项: appSecret')));
  assert.ok(!result.errors.some(item => item.includes('fixture-secret-do-not-ship')));
});

test('credentials and server files fail inspection before any ZIP is written', async t => {
  const { projectRoot, write, temporary } = await fixture(t);
  await write('.env.local', 'SECRET=fixture-only');
  await write('server/index.mjs', 'console.log("server-only");');
  await write('assets/private.key', 'fixture-only');
  const result = await checkWechatMiniProgram({ projectRoot });
  assert.equal(result.ok, false);
  for (const name of ['.env.local', 'server', 'private.key']) assert.ok(result.errors.some(item => item.includes(name)));
  await assert.rejects(packageWechatMiniProgram({ projectRoot, outputPath: path.join(temporary, 'output.zip') }), /结构检查失败/);
});

test('packaging produces a UTF-8 ZIP with only checked files and no machine-local settings', async t => {
  const { projectRoot, write, temporary } = await fixture(t, { operatorName: '', privacyEmail: '' });
  await write('project.private.config.json', JSON.stringify({ setting: { urlCheck: false }, localOnly: 'do-not-distribute' }));
  await write('README.md', '# 导入说明');
  const outputPath = path.join(temporary, 'output', 'Medtalent-微信小程序.zip');
  const result = await packageWechatMiniProgram({ projectRoot, outputPath });
  const zip = await fs.readFile(outputPath);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt16LE(6) & 0x0800, 0x0800);
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), result.entryCount);
  assert.ok(zip.includes(Buffer.from('project.config.json')));
  assert.ok(zip.includes(Buffer.from('pages/webview/index.wxml')));
  assert.ok(!zip.includes(Buffer.from('project.private.config.json')));
  assert.ok(!zip.includes(Buffer.from('do-not-distribute')));
  await assert.rejects(packageWechatMiniProgram({ projectRoot, outputPath: path.join(projectRoot, 'output.zip') }), /源码目录外/);
});

test('online checks use public GET endpoints and summarize counts without doctor records', async t => {
  const { projectRoot } = await fixture(t);
  const requests = [];
  const result = await checkWechatMiniProgram({ projectRoot, online: true, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: true, service: 'medtalent-agent-platform' }), { headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/api/doctors')) return new Response(JSON.stringify([{ name: 'SHOULD_NOT_BE_PRINTED' }]), { headers: { 'content-type': 'application/json' } });
    return new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } });
  } });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.deepEqual(requests.map(item => item.url), ['https://agent.hzmwmt.com/', 'https://agent.hzmwmt.com/api/health', 'https://agent.hzmwmt.com/api/doctors']);
  assert.ok(requests.every(item => item.options.redirect === 'error' && !item.options.method && !item.options.body));
  assert.ok(result.facts.some(item => item.includes('1 个智能体')));
  assert.ok(!JSON.stringify(result).includes('SHOULD_NOT_BE_PRINTED'));
});

test('online failures and invalid health results cannot report success', async t => {
  const { projectRoot } = await fixture(t);
  const result = await checkWechatMiniProgram({ projectRoot, online: true, fetchImpl: async url => {
    if (url.endsWith('/api/health')) return new Response(JSON.stringify({ ok: false }), { headers: { 'content-type': 'application/json' } });
    return new Response('unavailable', { status: 503 });
  } });
  assert.equal(result.ok, false);
  assert.equal(result.errors.filter(item => item.includes('线上只读检查')).length, 3);
});
