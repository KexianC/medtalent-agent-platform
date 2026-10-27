import test from 'node:test';
import assert from 'node:assert/strict';
import { createWavRecorder } from '../src/lib/wavRecorder.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function microphone() {
  const tracks = [{ stops: 0, stop() { this.stops += 1; } }, { stops: 0, stop() { this.stops += 1; } }];
  return { tracks, getTracks: () => tracks };
}

function audioContext({ fail, resume, close } = {}) {
  const failure = (stage) => { if (fail === stage) throw new Error(stage); };
  const node = (name) => ({
    disconnects: 0,
    connects: 0,
    onaudioprocess: null,
    connect() { this.connects += 1; failure(`${name}Connect`); },
    disconnect() { this.disconnects += 1; failure(`${name}Disconnect`); },
  });
  const source = node('source');
  const processor = node('processor');
  return {
    source, processor, sampleRate: 48_000, destination: {}, closes: 0, sources: 0, processors: 0,
    async resume() { failure('resume'); await resume; },
    async close() { this.closes += 1; failure('close'); await close; },
    createMediaStreamSource() { this.sources += 1; failure('source'); return source; },
    createScriptProcessor() { this.processors += 1; failure('processor'); return processor; },
    capture(samples = new Float32Array(4800).fill(0.25)) {
      processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
    },
  };
}

function setup(options = {}) {
  const stream = microphone();
  const context = audioContext(options);
  const changes = [];
  let acquisitions = 0;
  let contexts = 0;
  const recorder = createWavRecorder((value) => changes.push(value), {
    getStream: () => { acquisitions += 1; return options.permission ?? Promise.resolve(stream); },
    createContext: () => {
      contexts += 1;
      if (options.fail === 'constructor') throw new Error('constructor');
      return context;
    },
  });
  return { recorder, stream, context, changes, acquisitions: () => acquisitions, contexts: () => contexts };
}

for (const action of ['cancel', 'stop']) {
  test(`${action} during permission stops a late stream without starting the audio graph`, async () => {
    const permission = deferred();
    const fixture = setup({ permission: permission.promise });
    const first = fixture.recorder.start();
    const duplicate = fixture.recorder.start();
    assert.equal(fixture.acquisitions(), 1);
    await fixture.recorder[action]();
    permission.resolve(fixture.stream);
    await Promise.all([first, duplicate]);
    assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(fixture.contexts(), 0);
    assert.deepEqual(fixture.changes, []);
  });
}

test('cancel during AudioContext resume releases resources and prevents later recording', async () => {
  const resume = deferred();
  const fixture = setup({ resume: resume.promise });
  const pending = fixture.recorder.start();
  await Promise.resolve();
  assert.equal(fixture.contexts(), 1);
  await fixture.recorder.cancel();
  resume.resolve();
  await pending;
  assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(fixture.context.closes, 1);
  assert.equal(fixture.context.sources, 0);
  assert.deepEqual(fixture.changes, []);
});

for (const fail of ['constructor', 'resume', 'source', 'processor', 'sourceConnect', 'processorConnect']) {
  test(`${fail} failure releases every acquired resource and allows a new attempt`, async () => {
    const fixture = setup({ fail });
    await assert.rejects(fixture.recorder.start(), new RegExp(fail));
    assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(fixture.context.closes, fail === 'constructor' ? 0 : 1);
    if (['processor', 'sourceConnect', 'processorConnect'].includes(fail)) assert.equal(fixture.context.source.disconnects, 1);
    if (['sourceConnect', 'processorConnect'].includes(fail)) assert.equal(fixture.context.processor.disconnects, 1);
    assert.equal(fixture.context.processor.onaudioprocess, null);
    assert.deepEqual(fixture.changes, []);
    await assert.rejects(fixture.recorder.start(), new RegExp(fail));
    assert.equal(fixture.acquisitions(), 2);
  });
}

for (const fail of ['sourceDisconnect', 'processorDisconnect', 'close']) {
  test(`${fail} cannot prevent remaining nodes and microphone from being released`, async () => {
    const fixture = setup({ fail });
    await fixture.recorder.start();
    await fixture.recorder.cancel();
    assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
    assert.equal(fixture.context.source.disconnects, 1);
    assert.equal(fixture.context.processor.disconnects, 1);
    assert.equal(fixture.context.processor.onaudioprocess, null);
    assert.equal(fixture.context.closes, 1);
    assert.deepEqual(fixture.changes, [true, false]);
  });
}

test('finishing an older stop cannot clear or stop a newer recording', async () => {
  const closing = deferred();
  const first = { stream: microphone(), context: audioContext({ close: closing.promise }) };
  const second = { stream: microphone(), context: audioContext() };
  const sessions = [first, second];
  const changes = [];
  let index = -1;
  const recorder = createWavRecorder(value => changes.push(value), {
    getStream: async () => sessions[++index].stream,
    createContext: () => sessions[index].context,
  });
  await recorder.start();
  first.context.capture();
  const oldStop = recorder.stop();
  await recorder.start();
  closing.resolve();
  assert.equal((await oldStop).type, 'audio/wav');
  assert.deepEqual(changes, [true, false, true]);
  assert.deepEqual(first.stream.tracks.map(track => track.stops), [1, 1]);
  assert.deepEqual(second.stream.tracks.map(track => track.stops), [0, 0]);
  second.context.capture();
  assert.equal((await recorder.stop()).type, 'audio/wav');
  assert.deepEqual(second.stream.tracks.map(track => track.stops), [1, 1]);
  assert.deepEqual(changes, [true, false, true, false]);
});

test('a cancelled permission rejection is silent and does not disturb a new acquisition', async () => {
  const oldPermission = deferred();
  const stream = microphone();
  const context = audioContext();
  const changes = [];
  let acquisitions = 0;
  const recorder = createWavRecorder(value => changes.push(value), {
    getStream: () => ++acquisitions === 1 ? oldPermission.promise : Promise.resolve(stream),
    createContext: () => context,
  });
  const oldStart = recorder.start();
  await recorder.cancel();
  await recorder.start();
  oldPermission.reject(new Error('Permission dismissed'));
  await oldStart;
  assert.deepEqual(changes, [true]);
  assert.deepEqual(stream.tracks.map(track => track.stops), [0, 0]);
  await recorder.cancel();
});

test('late permission from a cancelled start only stops its own stream while a new session records', async () => {
  const oldPermission = deferred();
  const oldStream = microphone();
  const newStream = microphone();
  const context = audioContext();
  const changes = [];
  let acquisitions = 0;
  let contexts = 0;
  const recorder = createWavRecorder(value => changes.push(value), {
    getStream: () => ++acquisitions === 1 ? oldPermission.promise : Promise.resolve(newStream),
    createContext: () => { contexts += 1; return context; },
  });
  const oldStart = recorder.start();
  await recorder.cancel();
  await recorder.start();
  oldPermission.resolve(oldStream);
  await oldStart;
  assert.equal(contexts, 1);
  assert.deepEqual(changes, [true]);
  assert.deepEqual(oldStream.tracks.map(track => track.stops), [1, 1]);
  assert.deepEqual(newStream.tracks.map(track => track.stops), [0, 0]);
  await recorder.cancel();
  assert.deepEqual(newStream.tracks.map(track => track.stops), [1, 1]);
});

test('stop creates mono PCM WAV at 16 kHz, and simultaneous cancellation releases only once', async () => {
  const fixture = setup();
  await fixture.recorder.start();
  fixture.context.capture();
  const [blob] = await Promise.all([fixture.recorder.stop(), fixture.recorder.cancel()]);
  assert.equal(blob.type, 'audio/wav');
  const buffer = await blob.arrayBuffer();
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(40, true), 3200);
  assert.equal(view.getInt16(44, true), 8191);
  assert.equal(buffer.byteLength, 3244);
  assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(fixture.context.closes, 1);
  assert.deepEqual(fixture.changes, [true, false]);
});

test('too-short recordings fail after releasing microphone and audio graph', async () => {
  const fixture = setup();
  await fixture.recorder.start();
  fixture.context.capture(new Float32Array(100));
  await assert.rejects(fixture.recorder.stop(), /录音时间太短/);
  assert.deepEqual(fixture.stream.tracks.map(track => track.stops), [1, 1]);
  assert.equal(fixture.context.closes, 1);
  assert.equal(fixture.context.processor.onaudioprocess, null);
  assert.deepEqual(fixture.changes, [true, false]);
});
