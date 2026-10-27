import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlatformApp } from './app.mjs';

// Entirely synthetic: no environment files, production database or provider.
const env = Object.freeze({
  NODE_ENV: 'test', ADMIN_USERNAME: 'tsc-scope-synthetic-admin',
  ADMIN_PASSWORD: 'Tsc-scope-synthetic-admin-password-20261008',
  AI_API_URL: 'https://tsc-scope-provider.invalid/v1', AI_API_KEY: 'tsc-scope-synthetic-provider-key',
  AI_MODEL: 'tsc-scope-synthetic-model',
});
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function fixture(t, { failSearch = true } = {}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'tsc-scope-http-'));
  const calls = { search: [], provider: [] };
  let platform;
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await platform?.close();
    const target = path.resolve(directory);
    const relative = path.relative(temporaryRoot, target);
    assert.match(relative, /^tsc-scope-http-[^\\/]+$/u);
    assert.equal(path.isAbsolute(relative), false);
    await fs.rm(target, { recursive: true, force: true });
  });
  platform = await createPlatformApp({
    env, dataDir: path.join(directory, 'data'), startWorker: false, disableRateLimits: true,
    seedDoctors: ['tang-jinsong', 'other-doctor'].map(slug => ({
      slug, name: '模拟健康助手', hospital: '', department: '合成测试', specialty: '睡眠与情绪',
      intro: '仅用于独立 HTTP 边界验收', config: { ragEnabled: true, systemPrompt: '这是合成测试角色。' },
    })),
    fetchImpl: async (url, options) => {
      assert.equal(url, `${env.AI_API_URL}/chat/completions`, 'Unexpected provider or RAG request');
      const body = JSON.parse(options.body);
      calls.provider.push(body);
      assert.ok(body.messages.some(message => message.content.includes('模拟检索引用')));
      const reply = '先保持规律作息，并观察白天的精力变化。';
      return body.stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`)
        : Response.json({ choices: [{ message: { content: reply } }] });
    },
  });
  assert.equal((await platform.database.getAgent('tang-jinsong', true)).config.ragEnabled, true);
  platform.knowledge.search = async (slug, message) => {
    calls.search.push({ slug, message });
    if (failSearch) throw Object.assign(new Error('模拟检索异常'), { statusCode: 500, code: 'SYNTHETIC_RETRIEVAL_ERROR' });
    return { mode: 'lexical', citations: [{ id: 'synthetic-citation', documentId: 'synthetic-document', title: '模拟检索引用', text: '模拟检索引用：规律作息。', chunkIndex: 0 }] };
  };
  await new Promise(resolve => { server = platform.app.listen(0, '127.0.0.1', resolve); });
  const post = (route, body) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    const request = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, Connection: 'close' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, headers: response.headers, text });
      });
      response.on('error', reject);
    });
    request.setTimeout(2500, () => request.destroy(new Error('Synthetic HTTP request timed out')));
    request.on('error', reject);
    request.end(bytes);
  });
  return { calls, post };
}

const unpack = (response, stream) => {
  assert.equal(response.status, 200, response.text);
  if (!stream) return JSON.parse(response.text);
  assert.match(response.headers['content-type'], /application\/x-ndjson/u);
  const events = response.text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events[0].type, 'meta');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(events.some(event => event.type === 'error'), false);
  return { ...events.at(-1), reply: events.filter(event => event.type === 'delta').map(event => event.text).join('') };
};

test('Tang unrelated and clarification replies bypass failing RAG through ordinary and streaming HTTP', async t => {
  const f = await fixture(t);
  for (const stream of [false, true]) for (const [message, scope] of [
    ['学习 Python 怎么入门？', 'unrelated'], ['你能帮我吗？', 'clarify'],
  ]) {
    const response = await f.post(stream ? '/api/chat/stream' : '/api/chat', { doctorSlug: 'tang-jinsong', message });
    const result = unpack(response, stream);
    assert.equal(result.scope, scope);
    assert.equal(result.model, 'scope-guidance');
    assert.equal(result.retrievalMode, 'none');
    assert.deepEqual(result.citations, []);
    assert.match(result.reply, /睡眠|情绪/u);
  }
  assert.deepEqual(f.calls.search, []);
  assert.deepEqual(f.calls.provider, []);
});

test('Tang crisis and consented record safety remain ahead of scope and failing RAG in both HTTP paths', async t => {
  const f = await fixture(t);
  const cases = [
    { message: '帮我写一个程序，我已经吞了很多药' },
    { message: '今天杭州气温多少？', healthContext: { consent: true, records: [{ dateKey: today(), completedTitles: ['情绪感受'], metrics: { safetyConcern: true } }] } },
  ];
  for (const stream of [false, true]) for (const body of cases) {
    const result = unpack(await f.post(stream ? '/api/chat/stream' : '/api/chat', { doctorSlug: 'tang-jinsong', ...body }), stream);
    assert.equal(result.crisis, true);
    assert.equal(result.model, 'safety-intervention');
    assert.equal(result.retrievalMode, 'none');
    assert.deepEqual(result.citations, []);
    assert.match(result.reply, /120/u);
  }
  assert.deepEqual(f.calls.search, []);
  assert.deepEqual(f.calls.provider, []);
});

test('related Tang context and other doctors retain RAG and provider execution in both HTTP paths', async t => {
  const f = await fixture(t, { failSearch: false });
  const cases = [
    { doctorSlug: 'tang-jinsong', message: '那我该怎么办？', history: [{ role: 'user', content: '最近经常失眠' }, { role: 'user', content: '已经两周了' }] },
    { doctorSlug: 'tang-jinsong', message: '请推荐程序员减轻焦虑的方法' },
    { doctorSlug: 'other-doctor', message: '请介绍一般健康知识' },
  ];
  for (const stream of [false, true]) for (const body of cases) {
    const result = unpack(await f.post(stream ? '/api/chat/stream' : '/api/chat', body), stream);
    assert.equal(result.scope, undefined);
    assert.equal(result.model, env.AI_MODEL);
    assert.equal(result.retrievalMode, 'lexical');
    assert.deepEqual(result.citations, [{ title: '模拟检索引用' }]);
  }
  assert.equal(f.calls.search.length, 6);
  assert.equal(f.calls.provider.length, 6);
});
