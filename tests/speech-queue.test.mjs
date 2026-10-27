import assert from 'node:assert/strict';
import test from 'node:test';
import { createSpeechChunker, readAudioStream } from '../src/lib/chatStream.ts';
import { createSpeechQueue } from '../src/lib/speechQueue.ts';

const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const compact = value => value.replace(/\s/g, '');

test('a short opening sentence starts speech before the complete answer exists', () => {
  const chunker = createSpeechChunker();
  assert.deepEqual(chunker.push('你好。'), ['你好。']);
  assert.deepEqual(chunker.push('我们可以慢慢聊'), []);
  assert.deepEqual(chunker.push('', true), ['我们可以慢慢聊']);
  assert.deepEqual(chunker.push('', true), []);
});

test('opening phrase starts at a comma and does not wait for 28 characters', () => {
  const chunker = createSpeechChunker();
  assert.deepEqual(chunker.push('听起来你最近有些辛苦，'), ['听起来你最近有些辛苦，']);
});

test('long punctuation-free opening is bounded without cutting surrogate pairs', () => {
  const chunker = createSpeechChunker();
  const text = '🙂'.repeat(65);
  const parts = chunker.push(text);
  assert.ok(parts.length > 0);
  parts.push(...chunker.push('', true));
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(part => !part.includes('\ufffd') && Array.from(part).every(char => char.length === 2)));
});

test('arbitrary delta boundaries preserve ordering, content, and the 8-request budget', () => {
  const text = ('我们先慢慢呼吸，注意自己的感受。然后聊聊最近发生了什么，以及你希望得到哪些帮助。\n').repeat(10);
  for (const width of [1, 7, 39, text.length]) {
    const chunker = createSpeechChunker();
    const chunks = [];
    for (let i = 0; i < text.length; i += width) chunks.push(...chunker.push(text.slice(i, i + width)));
    chunks.push(...chunker.push('', true));
    assert.equal(compact(chunks.join('')), compact(text));
    assert.ok(chunks.length <= 8);
  }
});

function queueFixture(speak) {
  const calls = [];
  const timers = new Map();
  let index = 0;
  let enabled = true;
  const queue = createSpeechQueue({
    speak: speak || (async text => { calls.push(text); }),
    isActive: () => enabled,
    setTimer: (callback, delay) => { const id = ++index; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  return { queue, calls, timers, disable: () => { enabled = false; }, fire() {
    const [id, { callback }] = timers.entries().next().value;
    timers.delete(id); callback();
  } };
}

test('first short text has a bounded deadline even if the next model delta stalls', async () => {
  const fixture = queueFixture();
  fixture.queue.push('我听到了');
  assert.equal(fixture.timers.values().next().value.delay, 700);
  fixture.queue.push('你的感受');
  assert.equal(fixture.timers.size, 1, 'more tokens must not postpone the first deadline');
  fixture.fire();
  await tick();
  assert.deepEqual(fixture.calls, ['我听到了你的感受']);
  fixture.queue.push('后续我们一起慢慢梳理。');
  await fixture.queue.finish();
  assert.deepEqual(fixture.calls, ['我听到了你的感受', '后续我们一起慢慢梳理。']);
  assert.equal(fixture.timers.size, 0);
});

test('synthesis requests stay in order and never overlap while text continues arriving', async () => {
  const first = deferred();
  const calls = [];
  const fixture = queueFixture(async text => { calls.push(text); if (calls.length === 1) await first.promise; });
  fixture.queue.push('你好。');
  await tick();
  fixture.queue.push('我们可以聊聊');
  const finish = fixture.queue.finish();
  await tick();
  assert.deepEqual(calls, ['你好。']);
  first.resolve();
  await finish;
  assert.deepEqual(calls, ['你好。', '我们可以聊聊']);
});

test('stop aborts the active synthesis, discards the queued tail, and clears deadlines', async () => {
  const calls = [];
  let signal;
  const fixture = queueFixture(async (text, activeSignal) => {
    calls.push(text); signal = activeSignal;
    await new Promise(resolve => activeSignal.addEventListener('abort', resolve, { once: true }));
  });
  fixture.queue.push('你好。');
  await tick();
  fixture.queue.push('我们可以聊聊');
  assert.equal(fixture.timers.size, 1);
  fixture.queue.cancel();
  fixture.queue.push('再来的内容不能重新开启播报。');
  await fixture.queue.finish();
  assert.equal(signal.aborted, true);
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(calls, ['你好。']);
});

test('disabled playback prevents a delayed first fragment from being synthesized', async () => {
  const fixture = queueFixture();
  fixture.queue.push('我们可以聊聊');
  fixture.disable(); fixture.fire();
  await fixture.queue.finish();
  assert.deepEqual(fixture.calls, []);
});

test('failed synthesis ends its queue rather than leaking later speech into another turn', async () => {
  const calls = [];
  const fixture = queueFixture(async text => { calls.push(text); throw new Error('failed'); });
  fixture.queue.push('你好。');
  fixture.queue.push('我们可以聊聊');
  await fixture.queue.finish();
  assert.deepEqual(calls, ['你好。']);
});

test('audio frames are consumed before server done and cancellation closes the stream', async () => {
  let controller;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled = true; },
  }));
  const iterator = readAudioStream(response);
  const pending = iterator.next();
  controller.enqueue(new TextEncoder().encode('{"type":"audio","data":"AQI=","sampleRate":24000}\n'));
  assert.equal((await pending).value.type, 'audio');
  await iterator.return();
  assert.equal(cancelled, true);
});
