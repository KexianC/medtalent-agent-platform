import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlatformApp } from '../server/app.mjs';

// Deliberately independent of .env, process.env and real provider credentials.
const env = Object.freeze({
  NODE_ENV: 'test',
  ADMIN_USERNAME: 'synthetic-http-stream-admin',
  ADMIN_PASSWORD: 'Synthetic-http-stream-admin-password-20260922',
  AI_API_URL: 'https://streaming-http-provider.invalid/v1',
  AI_API_KEY: 'synthetic-chat-http-stream-credential-20260922',
  AI_MODEL: 'synthetic-http-stream-model',
  DASHSCOPE_API_KEY: 'synthetic-speech-http-stream-credential-20260922',
});
const chatEndpoint = `${env.AI_API_URL}/chat/completions`;
const ttsEndpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
// Exercise the provider streaming path with an in-scope health question rather
// than a generic request for test text that the Tang scope gate should clarify.
const syntheticHealthQuestion = '【模拟验收】最近很难入睡，白天很疲惫，请给我一般健康科普建议。';
const firstSentence = '【模拟验收】第一句已经输出，现在检查文字尚未结束时语音是否已经开始。';
const remainder = '【模拟验收】这段文字是在收到首段音频后才允许继续输出的。';
const pcm = Buffer.from(Array.from({ length: 96 }, (_, index) => index % 2 ? 2 : 1));
const encoder = new TextEncoder();
const sse = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const ttsEvent = (data, done = false) => sse({ status_code: 200, output: { finish_reason: done ? 'stop' : null, audio: { data: data?.toString('base64') || '' } } });

async function within(promise, label, timeoutMs = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not arrive before the controlled ${timeoutMs}ms deadline; an upstream done gate is still closed.`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function controlledSse(first, final) {
  let controller;
  let closed = false;
  let signal;
  let resolveAbort;
  const gate = {
    doneSent: false,
    canceled: false,
    aborted: false,
    abortObserved: new Promise(resolve => { resolveAbort = resolve; }),
    body: new ReadableStream({
      start(value) { controller = value; controller.enqueue(encoder.encode(first)); },
      cancel() { gate.canceled = true; closed = true; signal?.removeEventListener('abort', onAbort); },
    }),
    attachSignal(value) {
      signal = value;
      assert.ok(signal instanceof AbortSignal);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    releaseDone() {
      if (closed) return;
      gate.doneSent = true;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      controller.enqueue(encoder.encode(final));
      controller.close();
    },
    dispose() {
      signal?.removeEventListener('abort', onAbort);
      if (!closed) { closed = true; controller.close(); }
    },
  };
  function onAbort() {
    gate.aborted = true;
    resolveAbort();
    if (!closed) { closed = true; controller.error(signal.reason || new DOMException('Synthetic upstream canceled', 'AbortError')); }
  }
  return gate;
}

function ndjsonReader(response, resources) {
  const reader = response.body.getReader();
  resources.readers.push(reader);
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const events = [];
  async function next() {
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === 'error') throw new Error(`Unexpected HTTP stream error: ${event.code || event.error}`);
        return event;
      }
      if (ended) {
        assert.equal(buffer.trim(), '', 'HTTP stream should end on an NDJSON line boundary');
        return null;
      }
      const { done, value } = await reader.read();
      ended = done;
      buffer += decoder.decode(value, { stream: !done });
    }
  }
  const until = async (type, label) => within((async () => {
    while (true) {
      const event = await next();
      assert.ok(event, `HTTP stream closed without ${type}`);
      if (event.type === type) return event;
    }
  })(), label);
  return { events, next, until };
}

function assertStreamHeaders(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/x-ndjson/);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  assert.match(response.headers.get('cache-control') || '', /no-transform/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(), geolocation=(), microphone=(self)');
  assert.equal(response.headers.get('x-powered-by'), null);
}

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'tang-streaming-http-'));
  const resources = { controllers: [], readers: [] };
  const chatGate = controlledSse(
    sse({ choices: [{ delta: { content: firstSentence } }] }),
    sse({ choices: [{ delta: { content: remainder } }] }) + sse('[DONE]'),
  );
  const ttsGate = controlledSse(ttsEvent(pcm), ttsEvent(null, true));
  const providerRequests = [];
  let platform;
  let server;

  t.after(async () => {
    // Aborts and explicit stream closure also run when an early-byte assertion
    // times out, so a regression cannot leave an open gated server hanging.
    resources.controllers.forEach(controller => controller.abort());
    chatGate.dispose();
    ttsGate.dispose();
    await Promise.all(resources.readers.map(reader => reader.cancel().catch(() => {})));
    resources.readers.forEach(reader => { try { reader.releaseLock(); } catch { /* Already released. */ } });
    if (server?.listening) {
      await within(new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      }), 'Loopback server cleanup');
    }
    if (platform) await platform.close();
    const target = path.resolve(directory);
    const relative = path.relative(temporaryRoot, target);
    assert.match(relative, /^tang-streaming-http-[^\\/]+$/);
    assert.equal(path.isAbsolute(relative), false);
    await fs.rm(target, { recursive: true, force: true });
  });

  platform = await createPlatformApp({
    env,
    dataDir: path.join(directory, 'data'),
    startWorker: false,
    disableRateLimits: true,
    seedDoctors: [{
      slug: 'tang-jinsong', name: '模拟流式验收助手', hospital: '', department: '合成测试',
      specialty: '仅验证 HTTP 流交付时序', intro: '不提供实际咨询的合成测试资料',
      config: { ragEnabled: false, systemPrompt: '仅回复合成测试内容。' },
    }],
    fetchImpl: async (url, options) => {
      providerRequests.push(url);
      assert.equal(options.method, 'POST');
      if (url === chatEndpoint) {
        assert.equal(options.headers.Authorization, `Bearer ${env.AI_API_KEY}`);
        const request = JSON.parse(options.body);
        assert.equal(request.stream, true);
        assert.equal(request.messages.at(-1).content, syntheticHealthQuestion);
        chatGate.attachSignal(options.signal);
        return new Response(chatGate.body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      assert.equal(url, ttsEndpoint, 'Every upstream call must use the synthetic chat or TTS stub; RAG/NAS calls are forbidden');
      assert.equal(options.headers.Authorization, `Bearer ${env.DASHSCOPE_API_KEY}`);
      assert.equal(options.headers['X-DashScope-SSE'], 'enable');
      ttsGate.attachSignal(options.signal);
      return new Response(ttsGate.body, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  const doctor = await platform.database.getAgent('tang-jinsong', true);
  assert.equal(doctor.config.ragEnabled, false);
  assert.equal(platform.database.storageKind, 'SQLite');

  let base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    server = await new Promise((resolve, reject) => {
      const instance = platform.app.listen(0, '127.0.0.1');
      instance.once('error', reject);
      instance.once('listening', () => resolve(instance));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    try {
      const probe = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500) });
      assert.equal(probe.status, 200);
      await probe.arrayBuffer();
      break;
    } catch (error) {
      await new Promise(resolve => server.close(resolve));
      if (error?.cause?.message !== 'bad port' || attempt === 19) throw error;
    }
  }

  const post = (route, body) => {
    const controller = new AbortController();
    resources.controllers.push(controller);
    return {
      controller,
      response: within(fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
      }), `${route} response headers`),
    };
  };
  return { chatGate, ttsGate, providerRequests, post, read: response => ndjsonReader(response, resources) };
}

test('real chat and TTS HTTP streams deliver first PCM while both upstream done gates remain closed', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const chatResponse = await f.post('/api/chat/stream', { doctorSlug: 'tang-jinsong', message: syntheticHealthQuestion }).response;
  assertStreamHeaders(chatResponse);
  const chat = f.read(chatResponse);
  const firstDelta = await chat.until('delta', 'First chat delta before upstream chat done');
  assert.ok(firstDelta.text.length > 0);
  assert.equal(f.chatGate.doneSent, false);

  const ttsResponse = await f.post('/api/tts/stream', { doctorSlug: 'tang-jinsong', text: firstDelta.text, speechRunId: 'synthetic-http-stream-first-run' }).response;
  assertStreamHeaders(ttsResponse);
  const tts = f.read(ttsResponse);
  const firstAudio = await tts.until('audio', 'First HTTP PCM before either upstream done');
  assert.deepEqual(Buffer.from(firstAudio.data, 'base64'), pcm);
  assert.equal(firstAudio.sampleRate, 24000);
  assert.equal(f.chatGate.doneSent, false, 'Chat upstream must still be gated when audio reaches the HTTP client');
  assert.equal(f.ttsGate.doneSent, false, 'TTS upstream must still be gated when audio reaches the HTTP client');
  assert.equal(chat.events.some(event => event.type === 'done'), false);
  assert.equal(tts.events.some(event => event.type === 'done'), false);

  // Completion is permitted only after all early delivery assertions above.
  f.ttsGate.releaseDone();
  f.chatGate.releaseDone();
  await Promise.all([chat.until('done', 'Chat HTTP completion'), tts.until('done', 'TTS HTTP completion')]);
  assert.equal(await within(chat.next(), 'Chat EOF'), null);
  assert.equal(await within(tts.next(), 'TTS EOF'), null);
  const combinedText = chat.events.filter(event => event.type === 'delta').map(event => event.text).join('');
  assert.ok(combinedText.includes(firstSentence));
  assert.ok(combinedText.includes(remainder));
  assert.equal(chat.events.filter(event => event.type === 'done').length, 1);
  assert.equal(tts.events.filter(event => event.type === 'done').length, 1);
  assert.deepEqual(f.providerRequests, [chatEndpoint, ttsEndpoint]);
  const exposed = JSON.stringify([...chat.events, ...tts.events]);
  for (const secret of [env.AI_API_KEY, env.DASHSCOPE_API_KEY, env.ADMIN_PASSWORD]) assert.equal(exposed.includes(secret), false);
});

test('canceling a real TTS HTTP client aborts the pending upstream before its done gate is released', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const request = f.post('/api/tts/stream', { doctorSlug: 'tang-jinsong', text: '【模拟验收】这条音频会由客户端主动中断。', speechRunId: 'synthetic-http-stream-cancel-run' });
  const response = await request.response;
  assertStreamHeaders(response);
  const tts = f.read(response);
  await tts.until('audio', 'First PCM before cancellation');
  assert.equal(f.ttsGate.doneSent, false);
  request.controller.abort();
  await within(f.ttsGate.abortObserved, 'Upstream abort after HTTP client cancellation');
  assert.equal(f.ttsGate.aborted, true);
  assert.equal(f.ttsGate.doneSent, false);
  assert.deepEqual(f.providerRequests, [ttsEndpoint]);
});
