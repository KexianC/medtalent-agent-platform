import assert from 'node:assert/strict';
import test from 'node:test';
import { createPcmStreamDecoder, getPcmStartTime, readAudioStream } from '../src/lib/chatStream.ts';

// Exact header observed from the production provider, with unknown streaming lengths.
const streamingHeader = Buffer.from('52494646bfffff7f57415645666d74201000000001000100c05d000080bb000002001000646174619bffff7f', 'hex');
const pcm = Buffer.from([1, 0, 255, 255, 0, 128, 255, 127, 82, 73, 70, 70, 87, 65, 86, 69]);
const collectDecoder = (parts, sampleRate = 24000) => {
  const decoder = createPcmStreamDecoder(sampleRate);
  return Buffer.concat([...parts.map(part => Buffer.from(decoder.push(part))), Buffer.from(decoder.finish())]);
};
const audioLine = (bytes, sampleRate = 24000) => JSON.stringify({ type: 'audio', data: Buffer.from(bytes).toString('base64'), sampleRate }) + '\n';
const doneLine = JSON.stringify({ type: 'done' }) + '\n';
const responseFrom = lines => new Response(lines.join(''), { headers: { 'Content-Type': 'application/x-ndjson' } });
const collectStream = async response => {
  const events = [];
  for await (const event of readAudioStream(response)) events.push(event);
  return events;
};

test('the observed streaming WAV header is removed and every signed PCM sample is preserved', () => {
  const input = Buffer.concat([streamingHeader, pcm]);
  assert.equal(input.readInt16LE(0), 18770, 'RIFF was previously played as an audible sample');
  const output = collectDecoder([input]);
  assert.deepEqual(output, pcm);
  assert.equal(input.length - output.length, 44);
  assert.equal(output.readInt16LE(0), 1);
});

test('every split through the observed WAV header and sample payload preserves the PCM bytes', () => {
  const input = Buffer.concat([streamingHeader, pcm]);
  for (let split = 1; split < input.length; split += 1) {
    assert.deepEqual(collectDecoder([input.subarray(0, split), input.subarray(split)]), pcm, `split ${split}`);
  }
  assert.deepEqual(collectDecoder([...input].map(byte => Buffer.from([byte]))), pcm);
});

test('raw PCM remains unchanged across odd event boundaries, including RIFF-like sample bytes', () => {
  assert.deepEqual(collectDecoder([pcm.subarray(0, 1), pcm.subarray(1, 4), pcm.subarray(4)]), pcm);
  for (const raw of [Buffer.from('RI'), Buffer.from('RIFF'), Buffer.from('RIFFabcd'), Buffer.from('RIFFabcdNOPE')]) {
    assert.deepEqual(collectDecoder([...raw].map(byte => Buffer.from([byte]))), raw);
  }
});

test('WAV extensions and odd-sized metadata before data are skipped without deleting audio', () => {
  const riff = streamingHeader.subarray(0, 12);
  const format = Buffer.concat([streamingHeader.subarray(12, 36), Buffer.alloc(2)]);
  format.writeUInt32LE(18, 4);
  const junk = Buffer.concat([Buffer.from('JUNK'), Buffer.from([3, 0, 0, 0]), Buffer.from([7, 8, 9, 0])]);
  const data = Buffer.from(streamingHeader.subarray(36));
  data.writeUInt32LE(pcm.length, 4);
  const trailing = Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('info')]);
  const input = Buffer.concat([riff, junk, format, data, pcm, trailing]);
  for (const width of [1, 3, 19, input.length]) {
    const parts = [];
    for (let offset = 0; offset < input.length; offset += width) parts.push(input.subarray(offset, offset + width));
    assert.deepEqual(collectDecoder(parts), pcm, `event width ${width}`);
  }
});

test('unsupported WAV encodings, channel counts, rates and sample sizes are rejected', () => {
  const mutations = [
    header => header.writeUInt16LE(3, 20),
    header => header.writeUInt16LE(2, 22),
    header => header.writeUInt32LE(48000, 24),
    header => header.writeUInt32LE(96000, 28),
    header => header.writeUInt16LE(4, 32),
    header => header.writeUInt16LE(8, 34),
  ];
  for (const mutate of mutations) {
    const header = Buffer.from(streamingHeader);
    mutate(header);
    assert.throws(() => collectDecoder([Buffer.concat([header, pcm])]), /格式无效/);
  }
  for (const rate of [0, NaN, Infinity, 23999.5, 7999, 96001]) {
    assert.throws(() => createPcmStreamDecoder(rate), /采样率无效/);
  }
});

test('malformed or incomplete WAV and odd PCM endings fail without being played as headers', () => {
  assert.throws(() => collectDecoder([streamingHeader.subarray(0, 30)]), /格式无效/);
  assert.throws(() => collectDecoder([Buffer.concat([streamingHeader.subarray(0, 12), streamingHeader.subarray(36), pcm])]), /格式无效/);
  const tooLarge = Buffer.concat([streamingHeader.subarray(0, 12), Buffer.from('JUNK'), Buffer.from([255, 255, 1, 0])]);
  assert.throws(() => collectDecoder([tooLarge]), /格式无效/);
  const finiteHeader = Buffer.from(streamingHeader);
  finiteHeader.writeUInt32LE(pcm.length + 2, 40);
  assert.throws(() => collectDecoder([Buffer.concat([finiteHeader, pcm])]), /格式无效/);
  assert.throws(() => collectDecoder([Buffer.from([1, 2, 3])]), /格式无效/);
});

test('audio is released before the upstream done event and returning cancels its reader', async () => {
  let controller;
  let cancelled = 0;
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { cancelled += 1; },
  });
  const iterator = readAudioStream(new Response(body));
  controller.enqueue(new TextEncoder().encode(audioLine(streamingHeader.subarray(0, 17))));
  controller.enqueue(new TextEncoder().encode(audioLine(Buffer.concat([streamingHeader.subarray(17), pcm]))));
  let timer;
  try {
    const first = await Promise.race([
      iterator.next(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Decoder waited for EOF')), 1000); }),
    ]);
    assert.equal(first.value.type, 'audio');
    assert.deepEqual(Buffer.from(first.value.data, 'base64'), pcm);
    assert.equal(cancelled, 0);
  } finally {
    clearTimeout(timer);
    await iterator.return();
  }
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('each synthesis response detects its own header and retains header-like bytes inside PCM', async () => {
  for (let request = 0; request < 3; request += 1) {
    const events = await collectStream(responseFrom([
      audioLine(Buffer.concat([streamingHeader, pcm.subarray(0, 8)])),
      audioLine(pcm.subarray(8)), doneLine,
    ]));
    assert.deepEqual(Buffer.concat(events.filter(event => event.type === 'audio').map(event => Buffer.from(event.data, 'base64'))), pcm);
    assert.equal(events.at(-1).type, 'done');
  }
});

test('sample-rate changes and incomplete audio at done are rejected before unsafe playback', async () => {
  await assert.rejects(collectStream(responseFrom([audioLine(pcm), audioLine(pcm, 48000), doneLine])), /采样率发生变化/);
  await assert.rejects(collectStream(responseFrom([audioLine(Buffer.from([1, 2, 3])), doneLine])), /格式无效/);
  await assert.rejects(collectStream(responseFrom([audioLine(streamingHeader.subarray(0, 30)), doneLine])), /格式无效/);
  await assert.rejects(collectStream(responseFrom([audioLine(pcm), doneLine, audioLine(pcm)])), /结束后仍收到音频/);
});

test('small network jitter never inserts a silence gap into a future PCM timeline', () => {
  let end = 0;
  let arrival = 0;
  const duration = 0.05;
  for (let packet = 0; packet < 60; packet += 1) {
    if (packet) arrival += [0.065, 0.035, 0.055, 0.045][(packet - 1) % 4];
    const start = getPcmStartTime(arrival, end);
    if (packet) assert.equal(start, end, `packet ${packet} must append without a gap`);
    else assert.equal(start, 0.25);
    end = start + duration;
  }
  assert.equal(getPcmStartTime(0.09, 0.12), 0.12, '30 ms remaining must not cause the old 50 ms gap');
});

test('initial playback, an actual underrun and a stopped timeline receive a bounded prebuffer', () => {
  assert.equal(getPcmStartTime(10, 0), 10.25);
  assert.equal(getPcmStartTime(10, 9.99), 10.25);
  assert.equal(getPcmStartTime(10, 10), 10.25);
  assert.equal(getPcmStartTime(10, 10.004), 10.25);
  assert.equal(getPcmStartTime(10, 10.006), 10.006);
});
