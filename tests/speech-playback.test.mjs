import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeSpeechContext, waitForSpeechTimeline } from '../src/lib/speechPlayback.ts';

test('resume is called in the gesture and a blocked or rejected context is actionable', async () => {
  let called = false;
  const context = { state: 'suspended', currentTime: 0, resume() { called = true; this.state = 'running'; return Promise.resolve(); } };
  const operation = resumeSpeechContext(context);
  assert.equal(called, true);
  await operation;
  for (const resume of [async () => {}, async () => { throw new Error('not allowed'); }]) {
    await assert.rejects(resumeSpeechContext({ state: 'suspended', currentTime: 0, resume }), { code: 'AUDIO_BLOCKED' });
  }
  await assert.rejects(resumeSpeechContext({ state: 'suspended', currentTime: 0, resume: () => new Promise(() => {}) }, 5), { code: 'AUDIO_BLOCKED' });
});

test('a suspended or frozen audio clock cannot wait forever', async () => {
  let elapsed = 0;
  const options = { scheduledUntil: () => 20, isActive: () => true, now: () => elapsed, sleep: async ms => { elapsed += ms; }, stallMs: 300 };
  await assert.rejects(waitForSpeechTimeline({ ...options, context: { state: 'suspended', currentTime: 0 } }), { code: 'AUDIO_BLOCKED' });
  await assert.rejects(waitForSpeechTimeline({ ...options, context: { state: 'running', currentTime: 0 } }), { code: 'AUDIO_STALLED' });
  assert.equal(elapsed, 300);
});

test('playing finishes on its timeline and cancellation ends a frozen wait', async () => {
  let elapsed = 0;
  const context = { state: 'running', currentTime: 0 };
  await waitForSpeechTimeline({ context, scheduledUntil: () => 0.5, isActive: () => true, now: () => elapsed, sleep: async ms => { elapsed += ms; context.currentTime += ms / 1000; } });
  assert.equal(context.currentTime, 0.5);
  const controller = new AbortController();
  context.currentTime = 0;
  await waitForSpeechTimeline({ context, scheduledUntil: () => 20, isActive: () => true, signal: controller.signal, sleep: async () => controller.abort() });
  await waitForSpeechTimeline({ context, scheduledUntil: () => 20, isActive: () => false });
});
