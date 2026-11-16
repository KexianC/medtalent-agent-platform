import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import { createPlatformApp } from './app.mjs';
import { PlatformDatabase } from './database.mjs';
import { MySQLPlatformDatabase } from './mysql-database.mjs';
import { normalizeAgent, publicAgent } from './domain.mjs';
import { BLANK_DOCTOR_CONFIG, normalizeDoctorConfig } from '../src/lib/doctorConfig.ts';
import { getBuilderReadiness, recordBuilderMutation, saveBuilderQualification, storeBuilderEvaluationRun, saveBuilderEvaluation, saveBuilderReview, copyAgentDraft, saveAgentAsTemplate, instantiateTemplateDraft } from './agent-builder.mjs';

const input = slug => ({ slug, name: '测试助手', department: '健康科普', specialty: '健康知识', doctorConfig: { ...structuredClone(BLANK_DOCTOR_CONFIG), slug, profile: { ...structuredClone(BLANK_DOCTOR_CONFIG.profile), name: '测试助手' } } });

// 真实 Express 中间件和路由在内存 HTTP 流上运行，避免测试依赖监听端口权限。
function request(app, method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(method + ' ' + url + ' 内存请求超时')), 5000);
    const chunks = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    const req = new IncomingMessage(socket);
    const res = new ServerResponse(req);
    req.complete = true;
    req.method = method;
    req.url = url;
    const payload = body === undefined ? '' : JSON.stringify(body);
    req.headers = { host: 'localhost', ...(cookie ? { cookie } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}) };
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { resolve({ status: res.statusCode, data: text ? JSON.parse(text) : null, cookie: [res.getHeader('set-cookie')].flat()[0]?.split(';')[0] }); }
      catch (error) { reject(error); }
      socket.destroy();
    });
    app.handle(req, res, reject);
    if (payload) req.push(payload);
    req.push(null);
  });
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-config-server-'));
  const platform = await createPlatformApp({ dataDir: dir, seedDoctors: [], disableRateLimits: true, startWorker: false, env: { NODE_ENV: 'test', ADMIN_PASSWORD: 'synthetic-safe-password' } });
  t.after(async () => { await platform.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const login = await request(platform.app, 'POST', '/api/auth/login', { username: 'admin', password: 'synthetic-safe-password' });
  assert.equal(login.status, 200);
  return { ...platform, api: (method, url, body) => request(platform.app, method, url, body, login.cookie), public: url => request(platform.app, 'GET', url) };
}
async function approve(f, slug) {
  await saveBuilderQualification(f.database, slug, { status: 'verified', reference: '测试引用', authorizationReference: '测试授权引用' }, 'admin');
  const { draftHash } = await getBuilderReadiness(f.database, slug);
  const cases = ['范围', '急症', '来源'].map((question, index) => ({ id: `case-${index}`, question, expected: '安全回答', answer: '测试回答', model: 'test-model', ranAt: new Date().toISOString() }));
  await storeBuilderEvaluationRun(f.database, slug, draftHash, cases, 'admin');
  await saveBuilderEvaluation(f.database, slug, { draftHash, cases: cases.map(item => ({ id: item.id, pass: true, note: '已核对' })) }, 'admin');
  await saveBuilderReview(f.database, slug, { draftHash, status: 'approved', note: '独立复核' }, 'reviewer');
}

test('doctorConfig POST, batch and PUT persist validated drafts; public routes follow reviewed releases', async t => {
  const f = await fixture(t);
  const single = await f.api('POST', '/api/admin/agents', input('config-single'));
  assert.equal(single.status, 201);
  assert.deepEqual(single.data.doctorConfig, normalizeDoctorConfig(input('config-single').doctorConfig));
  const batch = await f.api('POST', '/api/admin/agents/batch', { agents: [input('config-batch-one'), input('config-batch-two')] });
  assert.equal(batch.status, 201);
  for (const agent of [single.data, ...batch.data.agents]) {
    assert.equal((await f.public('/api/doctors/' + agent.slug)).status, 404);
    assert.equal((await f.api('POST', `/api/admin/agents/${agent.slug}/publish`)).status, 409);
    await approve(f, agent.slug);
    assert.equal((await f.api('POST', `/api/admin/agents/${agent.slug}/publish`)).status, 200);
    const published = await f.public('/api/doctors/' + agent.slug);
    assert.equal(published.status, 200);
    assert.deepEqual(published.data.doctorConfig, agent.doctorConfig);
    assert.equal('config' in published.data, false);
    assert.equal('draftHash' in published.data, false);
  }
  assert.equal((await f.api('PUT', '/api/admin/agents/config-single', { intro: '保留已有医生配置' })).status, 200);
  assert.ok((await f.database.requireAgent('config-single')).doctorConfig);
  const original = (await f.public('/api/doctors/config-single')).data.doctorConfig;
  const doctorConfig = { ...original, home: { ...original.home, heroTitle: '后台草稿标题' } };
  const before = await getBuilderReadiness(f.database, 'config-single');
  const updated = await f.api('PUT', '/api/admin/agents/config-single', { doctorConfig, expectedDraftHash: before.draftHash });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.data.doctorConfig, doctorConfig);
  const after = await getBuilderReadiness(f.database, 'config-single');
  assert.equal(after.required, true);
  assert.notEqual(after.draftHash, before.draftHash);
  assert.equal(after.ready, false);
  assert.deepEqual((await f.public('/api/doctors/config-single')).data.doctorConfig, original);
  assert.equal((await f.api('POST', '/api/admin/agents/config-single/publish')).status, 409);
  await approve(f, 'config-single');
  assert.equal((await f.api('POST', '/api/admin/agents/config-single/publish')).status, 200);
  assert.deepEqual((await f.public('/api/doctors/config-single')).data.doctorConfig, doctorConfig);
  const directory = await f.public('/api/doctors');
  assert.deepEqual(directory.data.find(item => item.slug === 'config-single').doctorConfig, doctorConfig);
});

const invalid = [
  ['关闭危机卡', c => { c.safety.crisisCard = false; }],
  ['删热线', c => { c.safety.hotlines = ['120', '110']; }],
  ['缺 safety', c => { delete c.safety; }],
  ['标识不一致', c => { c.slug = 'another-doctor'; }],
  ['未知字段', c => { c.internal = '不能公开'; }],
  ['关闭安全', c => { c.safety.enabled = false; }],
  ['关闭边界热线', c => { c.safety.showHotlinesInBoundary = false; }],
  ['削弱说明', c => { c.safety.noticeLines = []; }],
  ['嵌套未知字段', c => { c.safety.bypass = true; }],
  ['清空配置', (_c, record) => { record.doctorConfig = null; }],
];
test('invalid doctorConfig returns 400 INVALID_DOCTOR_CONFIG unchanged Chinese errors and no database writes on all three routes', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('POST', '/api/admin/agents', input('config-existing'))).status, 201);
  for (const [label, mutate] of invalid) {
    for (const method of ['POST', 'PUT', 'batch']) {
      const record = input(method === 'PUT' ? 'config-existing' : 'config-invalid');
      mutate(record.doctorConfig, record);
      let message;
      try { normalizeAgent(record); assert.fail(label + ' should fail validation'); } catch (error) { message = error.message; }
      const before = f.rawDatabase.sqlite.prepare('SELECT * FROM agents ORDER BY slug').all();
      const audit = f.rawDatabase.sqlite.prepare('SELECT * FROM audit').all();
      const meta = f.rawDatabase.sqlite.prepare('SELECT * FROM meta ORDER BY key').all();
      const result = method === 'batch' ? await f.api('POST', '/api/admin/agents/batch', { agents: [input('config-valid-first'), record] })
        : await f.api(method, '/api/admin/agents' + (method === 'PUT' ? '/config-existing' : ''), record);
      assert.equal(result.status, 400, `${method}: ${label}`);
      assert.equal(result.data.code, 'INVALID_DOCTOR_CONFIG', `${method}: ${label}`);
      assert.equal(result.data.error, message);
      assert.deepEqual(f.rawDatabase.sqlite.prepare('SELECT * FROM agents ORDER BY slug').all(), before);
      assert.deepEqual(f.rawDatabase.sqlite.prepare('SELECT * FROM audit').all(), audit);
      assert.deepEqual(f.rawDatabase.sqlite.prepare('SELECT * FROM meta ORDER BY key').all(), meta);
    }
  }
  // 即使后项在写入阶段才失败，已有事务也会回滚前项及其审核元数据。
  const duplicate = await f.api('POST', '/api/admin/agents/batch', { agents: [input('config-rollback'), input('config-existing')] });
  assert.equal(duplicate.status, 409);
  assert.equal(await f.database.getAgent('config-rollback'), null);
  assert.equal(await f.database.getMeta('agent-builder.governance.config-rollback'), null);
});

test('SQLite and MySQL adapters retain doctorConfig across JSON draft, publication, version and rollback snapshots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doctor-config-storage-'));
  const sqlite = new PlatformDatabase({ dataDir: dir });
  t.after(async () => { sqlite.close(); await fs.rm(dir, { recursive: true, force: true }); });
  // 使用真实 MySQL 适配器的存取方法，以 SQLite 执行公共 SQL；无需外部数据库或凭据。
  const mysql = new MySQLPlatformDatabase({ pool: {}, dataDir: dir });
  mysql.transaction = fn => sqlite.transaction(fn);
  mysql._get = async (sql, params) => sqlite.sqlite.prepare(sql).get(...params);
  mysql._rows = async (sql, params) => sqlite.sqlite.prepare(sql).all(...params);
  mysql._run = async (sql, params) => sqlite.sqlite.prepare(sql).run(...params);
  for (const [index, db] of [sqlite, mysql].entries()) {
    const record = normalizeAgent(input(index ? 'config-mysql' : 'config-sqlite'));
    const original = record.doctorConfig;
    await db.createAgent(record, 'editor');
    assert.deepEqual((await db.requireAgent(record.slug)).doctorConfig, original);
    await db.publishAgent(record.slug, 'reviewer');
    record.doctorConfig.home.heroTitle = '待发布修改';
    await db.saveAgent(record, 'editor');
    assert.deepEqual((await db.getAgent(record.slug, true)).doctorConfig.home.heroTitle, BLANK_DOCTOR_CONFIG.home.heroTitle);
    assert.equal((await db.requireAgent(record.slug)).doctorConfig.home.heroTitle, '待发布修改');
    assert.deepEqual((await db.getAgentVersionSnapshot(record.slug, 1)).doctorConfig.home.heroTitle, BLANK_DOCTOR_CONFIG.home.heroTitle);
    await db.rollbackAgent(record.slug, 1, 'editor');
    assert.deepEqual((await db.requireAgent(record.slug)).doctorConfig, normalizeDoctorConfig(input(record.slug).doctorConfig));
  }
});

test('public projections omit invalid extension data and internal fields; doctorConfig always requires review', async t => {
  const f = await fixture(t);
  const record = normalizeAgent(input('config-public'));
  assert.deepEqual(publicAgent(record).doctorConfig, record.doctorConfig);
  const projected = publicAgent({ ...record, internal: 'private', version: 3, publishedAt: '2026-11-16T00:00:00.000Z' });
  assert.equal('internal' in projected, false);
  assert.equal(projected.version, 3);
  assert.equal(projected.publishedAt, '2026-11-16T00:00:00.000Z');
  const safe = f.knowledge.publicAgent({ ...record, internal: 'private', config: { systemPrompt: 'private' } }, { admin: false });
  assert.equal('internal' in safe, false);
  assert.equal('config' in safe, false);
  for (const [, mutate] of invalid) {
    const bad = structuredClone(record);
    mutate(bad.doctorConfig, bad);
    assert.equal('doctorConfig' in f.knowledge.publicAgent(bad, { admin: false }), false);
  }
  await f.database.createAgent(record, 'editor');
  assert.equal((await getBuilderReadiness(f.database, record.slug)).required, true);
  await recordBuilderMutation(f.database, record.slug, 'editor');
  assert.equal(JSON.parse(await f.database.getMeta('agent-builder.governance.' + record.slug)).required, true);
});

test('publicAgent tolerates legacy fields while projecting only known public fields and validating doctorConfig independently', () => {
  const record = normalizeAgent(input('config-legacy'));
  const legacy = { ...record, name: '旧'.repeat(81), portraitScale: '1.2',
    config: { ...record.config, maxTokens: 'old-format', systemPrompt: 'private' },
    articles: [{ id: 'old-article', title: '旧文章', internal: 'private' }],
    status: 'published', hasUnpublishedChanges: true, internal: 'private' };
  assert.throws(() => normalizeAgent(legacy));
  let projected;
  assert.doesNotThrow(() => { projected = publicAgent(legacy); });
  assert.equal(projected.name, legacy.name);
  assert.deepEqual(projected.doctorConfig, record.doctorConfig);
  assert.equal(projected.articles[0].title, '旧文章');
  for (const key of ['config', 'status', 'hasUnpublishedChanges', 'internal']) assert.equal(key in projected, false);
  assert.equal('internal' in projected.articles[0], false);
  for (const [, mutate] of invalid) {
    const bad = structuredClone(legacy);
    mutate(bad.doctorConfig, bad);
    assert.doesNotThrow(() => publicAgent(bad));
    const safe = publicAgent(bad);
    assert.equal('doctorConfig' in safe, false);
    assert.equal(safe.name, legacy.name);
    assert.deepEqual(safe.articles, projected.articles);
  }
});

test('existing copy and reusable template flows preserve v2 validation with the new agent slug', async t => {
  const f = await fixture(t);
  await f.database.createAgent(normalizeAgent(input('config-source')), 'editor');
  const copied = await copyAgentDraft(f.database, 'config-source', { slug: 'config-copy', name: '测试副本' }, 'editor');
  assert.equal(copied.doctorConfig.slug, 'config-copy');
  assert.equal(copied.doctorConfig.profile.name, '测试副本');
  assert.equal((await getBuilderReadiness(f.database, copied.slug)).required, true);
  const template = await saveAgentAsTemplate(f.database, { agentSlug: 'config-source', name: '测试模板' }, 'editor');
  const instantiated = instantiateTemplateDraft(template, { slug: 'config-template', name: '模板测试助手' });
  assert.equal(instantiated.doctorConfig.slug, instantiated.slug);
  assert.deepEqual(instantiated.doctorConfig.safety, normalizeDoctorConfig(input('config-template').doctorConfig).safety);
});
