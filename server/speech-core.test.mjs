import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { parseTtsStream, recognizeSpeech, synthesizeSpeech, synthesizeSpeechStream } from "./speech-core.mjs";

const streamFromTextChunks = (chunks) => new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    controller.close();
  },
});

const ttsEvent = (audio, done = false) => `data: ${JSON.stringify({
  status_code: 200,
  output: { finish_reason: done ? "stop" : null, audio: { data: audio ? Buffer.from(audio).toString("base64") : "" } },
})}\n\n`;

const openTtsStream = () => {
  let controller;
  let canceled = 0;
  const body = new ReadableStream({
    start(value) { controller = value; },
    cancel() { canceled += 1; },
  });
  return {
    body,
    write(text) { controller.enqueue(new TextEncoder().encode(text)); },
    close() { controller.close(); },
    fail(error) { controller.error(error); },
    get canceled() { return canceled; },
  };
};

const nextWithin = async (iterator) => {
  let timer;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Audio frame did not arrive before upstream completion")), 1000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const wavAudio = (payload = Buffer.from([1, 2, 3, 4])) => Buffer.concat([
  Buffer.from("RIFF", "ascii"),
  Buffer.from([payload.length + 4, 0, 0, 0]),
  Buffer.from("WAVE", "ascii"),
  payload,
]);

const trustedAudioUrl = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/prod/tts/audio.wav?Expires=1999999999&OSSAccessKeyId=temporary-id&Signature=temporary-signature";

test("parseTtsStream decodes split PCM audio events", async () => {
  const first = Buffer.from([1, 2, 3, 4]);
  const second = Buffer.from([5, 6, 7, 8]);
  const body = streamFromTextChunks([
    `: keep-alive\n\ndata: {"status_code":200,"output":{"finish_reason":null,"audio":{"data":"${first.toString("base64")}"}}}`,
    `\n\ndata: {"status_code":200,"output":{"finish_reason":null,"audio":{"data":"${second.toString("base64")}"}}}\n`,
    "\ndata: {\"status_code\":200,\"output\":{\"finish_reason\":\"stop\",\"audio\":{\"data\":\"\"}}}\n\n",
  ]);
  const chunks = [];
  for await (const chunk of parseTtsStream(body)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat([first, second]));
});

test("parseTtsStream rejects an interrupted audio stream", async () => {
  const body = streamFromTextChunks([
    "data: {\"status_code\":200,\"output\":{\"finish_reason\":null,\"audio\":{\"data\":\"AQI=\"}}}\n\n",
  ]);
  await assert.rejects(async () => {
    for await (const _chunk of parseTtsStream(body)) {
      // Consume the stream so the missing stop event is validated.
    }
  }, (error) => error?.code === "TTS_STREAM_INCOMPLETE");
});

test("ASR success text cannot reflect the configured speech credential", async () => {
  const secret = "dashscope-reflection-secret-7Y";
  let authorization;
  class ReflectedTranscriptSocket extends EventEmitter {
    constructor(_url, options) {
      super();
      authorization = options.headers.Authorization;
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(data, callback) {
      if (Buffer.isBuffer(data)) { callback?.(); return; }
      const message = JSON.parse(String(data));
      if (message.header.action === "run-task") {
        queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ header: { event: "task-started" } }))));
      } else if (message.header.action === "finish-task") {
        queueMicrotask(() => {
          this.emit("message", Buffer.from(JSON.stringify({
            header: { event: "result-generated" },
            payload: { output: { sentence: { text: secret, sentence_end: true } } },
          })));
          this.emit("message", Buffer.from(JSON.stringify({ header: { event: "task-finished" } })));
        });
      }
    }

    close() { this.readyState = 3; }
  }

  const transcript = await recognizeSpeech(Buffer.alloc(600, 1), { DASHSCOPE_API_KEY: secret }, "wav", {
    WebSocketImpl: ReflectedTranscriptSocket,
  });
  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal(transcript.includes(secret), false);
  assert.match(transcript, /已过滤/);
});

test("TTS direct and split streaming audio reject reflected credentials before release", async () => {
  const secret = "dashscope-audio-secret-echo-7Y";
  const env = { DASHSCOPE_API_KEY: secret };
  await assert.rejects(synthesizeSpeech("测试播报", env, {
    fetchImpl: async () => Response.json({ output: { audio: { data: Buffer.from(secret).toString("base64") } } }),
  }), (error) => error?.code === "UNSAFE_AUDIO_OUTPUT");

  const first = Buffer.from(secret.slice(0, 12));
  const second = Buffer.from(secret.slice(12));
  const body = streamFromTextChunks([
    `data: ${JSON.stringify({ status_code: 200, output: { finish_reason: null, audio: { data: first.toString("base64") } } })}\n\n`,
    `data: ${JSON.stringify({ status_code: 200, output: { finish_reason: null, audio: { data: second.toString("base64") } } })}\n\n`,
    "data: {\"status_code\":200,\"output\":{\"finish_reason\":\"stop\",\"audio\":{\"data\":\"\"}}}\n\n",
  ]);
  let emitted = 0;
  await assert.rejects(async () => {
    for await (const _audio of synthesizeSpeechStream("测试播报", env, undefined, {
      fetchImpl: async () => new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    })) emitted += 1;
  }, (error) => error?.code === "UNSAFE_AUDIO_OUTPUT");
  assert.equal(emitted, 0);
});

test("TTS yields its first PCM frame before upstream completion and cancels the completed reader", async () => {
  const source = openTtsStream();
  const abort = new AbortController();
  const expected = Buffer.from([1, 2, 3, 4]);
  let requestSignal;
  const iterator = synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, abort.signal, {
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      assert.equal(options.headers["X-DashScope-SSE"], "enable");
      return new Response(source.body);
    },
  });
  try {
    source.write(ttsEvent(expected));
    const first = await nextWithin(iterator);
    assert.equal(first.done, false);
    assert.deepEqual(first.value, expected);
    assert.equal(requestSignal.aborted, false);
    assert.equal(source.canceled, 0);
    source.write(ttsEvent(null, true));
    assert.equal((await nextWithin(iterator)).done, true);
    assert.equal(source.canceled, 1);
    assert.equal(source.body.locked, false);
  } finally {
    abort.abort();
    await iterator.return();
  }
});

test("TTS holds reflected credential bytes across every frame split after normal audio", async () => {
  const secrets = ["dashscope-audio-secret-echo-7Y", "临时语音令牌-7Y"];
  const safe = Buffer.from([1, 2, 3, 4]);
  for (const secret of secrets) {
    const credential = Buffer.from(secret);
    for (let split = 1; split < credential.length; split += 1) {
      const source = openTtsStream();
      source.write(ttsEvent(Buffer.concat([safe, credential.subarray(0, split)])));
      source.write(ttsEvent(credential.subarray(split)));
      const emitted = [];
      await assert.rejects(async () => {
        for await (const audio of synthesizeSpeechStream("测试播报", {
          DASHSCOPE_API_KEY: "dashscope-test-key", ADMIN_SESSION_SECRET: secret,
        }, undefined, { fetchImpl: async () => new Response(source.body) })) emitted.push(audio);
      }, (error) => error?.code === "UNSAFE_AUDIO_OUTPUT");
      assert.deepEqual(Buffer.concat(emitted), safe, `credential split at byte ${split}`);
      assert.equal(source.canceled, 1);
      assert.equal(source.body.locked, false);
    }
  }
});

test("TTS joins odd PCM frame boundaries without dropping samples", async () => {
  const body = streamFromTextChunks([
    ttsEvent([1, 2, 3]), ttsEvent([4]), ttsEvent([5, 6, 7]), ttsEvent([8]), ttsEvent(null, true),
  ]);
  const chunks = [];
  for await (const audio of synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
    fetchImpl: async () => new Response(body),
  })) {
    assert.equal(audio.length % 2, 0);
    chunks.push(audio);
  }
  assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  assert.equal(body.locked, false);
});

test("TTS rejects an incomplete final PCM sample and releases the reader", async () => {
  const source = openTtsStream();
  source.write(ttsEvent([1, 2, 3]));
  source.write(ttsEvent(null, true));
  const emitted = [];
  await assert.rejects(async () => {
    for await (const audio of synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
      fetchImpl: async () => new Response(source.body),
    })) emitted.push(audio);
  }, (error) => error?.code === "INVALID_AUDIO_OUTPUT");
  assert.deepEqual(Buffer.concat(emitted), Buffer.from([1, 2]));
  assert.equal(source.canceled, 1);
  assert.equal(source.body.locked, false);
});

test("TTS releases a harmless credential prefix only after a valid stop event", async () => {
  const source = openTtsStream();
  const safe = Buffer.from([1, 2]);
  const prefix = Buffer.from("dash");
  const iterator = synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
    fetchImpl: async () => new Response(source.body),
  });
  source.write(ttsEvent(Buffer.concat([safe, prefix])));
  assert.deepEqual((await nextWithin(iterator)).value, safe);
  source.write(ttsEvent(null, true));
  assert.deepEqual((await nextWithin(iterator)).value, prefix);
  assert.equal((await nextWithin(iterator)).done, true);
  assert.equal(source.canceled, 1);
  assert.equal(source.body.locked, false);
});

test("TTS cancellation stops pending reads and paused playback without another upstream frame", async (t) => {
  for (const pausedAfterFrame of [false, true]) {
    await t.test(pausedAfterFrame ? "paused after first frame" : "waiting for first frame", async () => {
      const source = openTtsStream();
      const abort = new AbortController();
      let responseOpened;
      const opened = new Promise((resolve) => { responseOpened = resolve; });
      const iterator = synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, abort.signal, {
        fetchImpl: async () => {
          responseOpened();
          return new Response(source.body);
        },
      });
      if (pausedAfterFrame) {
        source.write(ttsEvent([1, 2]));
        assert.deepEqual((await nextWithin(iterator)).value, Buffer.from([1, 2]));
      }
      const pending = pausedAfterFrame ? undefined : nextWithin(iterator);
      await opened;
      // Let the generator acquire its reader before testing in-flight cancel.
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(source.body.locked, true);
      abort.abort();
      assert.equal(source.canceled, 1);
      await assert.rejects(pending || nextWithin(iterator), (error) => error?.name === "AbortError");
      assert.equal(source.body.locked, false);
    });
  }
});

test("TTS closes its reader when the consumer stops early", async () => {
  const source = openTtsStream();
  source.write(ttsEvent([1, 2]));
  const iterator = synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
    fetchImpl: async () => new Response(source.body),
  });
  assert.equal((await nextWithin(iterator)).done, false);
  assert.equal((await iterator.return()).done, true);
  assert.equal(source.canceled, 1);
  assert.equal(source.body.locked, false);
});

test("TTS interrupts playback and releases resources on upstream failures", async (t) => {
  const cases = [
    { name: "missing stop event", finish: (source) => source.close(), code: "TTS_STREAM_INCOMPLETE", canceled: 0 },
    { name: "upstream error event", finish: (source) => source.write('data: {"code":"UpstreamError"}\n\n'), code: "TTS_UPSTREAM_ERROR", canceled: 1 },
    { name: "invalid JSON", finish: (source) => source.write("data: invalid-json\n\n"), code: "INVALID_TTS_STREAM", canceled: 1 },
    { name: "transport failure", finish: (source) => source.fail(Object.assign(new Error("Connection interrupted"), { code: "TEST_CONNECTION_INTERRUPTED" })), code: "TEST_CONNECTION_INTERRUPTED", canceled: 0 },
  ];
  for (const { name, finish, code, canceled } of cases) {
    await t.test(name, async () => {
      const source = openTtsStream();
      source.write(ttsEvent([1, 2]));
      const iterator = synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
        fetchImpl: async () => new Response(source.body),
      });
      assert.deepEqual((await nextWithin(iterator)).value, Buffer.from([1, 2]));
      finish(source);
      await assert.rejects(nextWithin(iterator), (error) => error?.code === code);
      assert.equal(source.canceled, canceled);
      assert.equal(source.body.locked, false);
    });
  }
});

test("TTS enforces the cumulative audio size limit after yielding earlier frames", async () => {
  const limit = 20 * 1024 * 1024;
  const oneMegabyteFrame = new TextEncoder().encode(ttsEvent(Buffer.alloc(1024 * 1024, 1)));
  let frame = 0;
  let canceled = 0;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(frame++ < 20 ? oneMegabyteFrame : new TextEncoder().encode(ttsEvent([1, 2])));
    },
    cancel() { canceled += 1; },
  });
  let emittedBytes = 0;
  await assert.rejects(async () => {
    for await (const audio of synthesizeSpeechStream("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, undefined, {
      fetchImpl: async () => new Response(body),
    })) emittedBytes += audio.length;
  }, (error) => error?.code === "AUDIO_TOO_LARGE");
  assert.equal(emittedBytes, limit);
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("TTS downloads a trusted DashScope OSS audio URL without forwarding credentials", async () => {
  const secret = "dashscope-test-key";
  const expected = wavAudio();
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (calls === 1) return Response.json({ output: { audio: { url: trustedAudioUrl } } });
    assert.equal(url, trustedAudioUrl);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.stringify(options).includes(secret), false);
    return new Response(expected, {
      status: 200,
      headers: { "Content-Type": "audio/wav", "Content-Length": String(expected.length) },
    });
  };
  assert.deepEqual(await synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: secret }, { fetchImpl }), expected);
  assert.equal(calls, 2);
});

test("TTS upgrades the exact trusted DashScope HTTP result URL to HTTPS", async () => {
  const secret = "dashscope-test-key";
  const expected = wavAudio();
  const httpResultUrl = trustedAudioUrl.replace(/^https:/, "http:");
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    if (calls === 1) return Response.json({ output: { audio: { url: httpResultUrl } } });
    assert.equal(url, trustedAudioUrl);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, undefined);
    return new Response(expected, { status: 200, headers: { "Content-Type": "audio/wav" } });
  };
  assert.deepEqual(await synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: secret }, { fetchImpl }), expected);
  assert.equal(calls, 2);
});

test("TTS keeps direct base64 audio support", async () => {
  const expected = Buffer.from([1, 2, 3, 4, 5]);
  const audio = await synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, {
    fetchImpl: async () => Response.json({ output: { audio: { data: expected.toString("base64") } } }),
  });
  assert.deepEqual(audio, expected);
});

test("TTS rejects private, malicious-domain, credentialed, and nonstandard-port URLs", async (t) => {
  const unsafeUrls = [
    "https://169.254.169.254/latest/meta-data/iam/security-credentials/test-role",
    "https://127.0.0.1/audio.wav",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.test/audio.wav",
    "https://evil.test/audio.wav",
    "https://user:password@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:8443/audio.wav",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/audio.wav?Signature=dashscope-test-key",
  ];
  for (const unsafeUrl of unsafeUrls) {
    await t.test(new URL(unsafeUrl).host, async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        return Response.json({ output: { audio: { url: unsafeUrl } } });
      };
      await assert.rejects(synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, { fetchImpl }),
        (error) => error?.code === "UNSAFE_AUDIO_SOURCE");
      assert.equal(calls, 1);
    });
  }
});

test("TTS rejects redirects from an otherwise trusted audio URL", async () => {
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    if (calls === 1) return Response.json({ output: { audio: { url: trustedAudioUrl } } });
    assert.equal(options.redirect, "error");
    return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
  };
  await assert.rejects(synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, { fetchImpl }),
    (error) => error?.code === "UNSAFE_AUDIO_SOURCE");
  assert.equal(calls, 2);
});

test("TTS enforces declared and streamed audio size limits", async (t) => {
  await t.test("declared Content-Length", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ output: { audio: { url: trustedAudioUrl } } });
      return new Response(wavAudio(), { headers: { "Content-Type": "audio/wav", "Content-Length": String(20 * 1024 * 1024 + 1) } });
    };
    await assert.rejects(synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, { fetchImpl }),
      (error) => error?.code === "AUDIO_TOO_LARGE");
  });

  await t.test("streamed total", async () => {
    let calls = 0;
    const oversized = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(10 * 1024 * 1024));
        controller.enqueue(new Uint8Array(10 * 1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ output: { audio: { url: trustedAudioUrl } } });
      return new Response(oversized, { headers: { "Content-Type": "audio/wav" } });
    };
    await assert.rejects(synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: "dashscope-test-key" }, { fetchImpl }),
      (error) => error?.code === "AUDIO_TOO_LARGE");
  });
});

test("TTS rejects empty, non-audio, and credential-reflecting downloaded bodies", async (t) => {
  const secret = "dashscope-audio-secret-echo-7Y";
  const cases = [
    { name: "empty", body: Buffer.alloc(0), contentType: "audio/wav", code: "EMPTY_AUDIO" },
    { name: "non-audio", body: Buffer.from("<html>not audio</html>"), contentType: "text/html", code: "INVALID_AUDIO_OUTPUT" },
    { name: "credential reflection", body: wavAudio(Buffer.from(secret)), contentType: "audio/wav", code: "UNSAFE_AUDIO_OUTPUT" },
  ];
  for (const current of cases) {
    await t.test(current.name, async () => {
      let calls = 0;
      const fetchImpl = async () => {
        calls += 1;
        if (calls === 1) return Response.json({ output: { audio: { url: trustedAudioUrl } } });
        return new Response(current.body, { headers: { "Content-Type": current.contentType } });
      };
      await assert.rejects(synthesizeSpeech("测试播报", { DASHSCOPE_API_KEY: secret }, { fetchImpl }),
        (error) => error?.code === current.code);
    });
  }
});

test("speech calls reject short credentials before opening an upstream connection", async () => {
  let fetchCalled = false;
  const env = { DASHSCOPE_API_KEY: "abc" };
  assert.throws(() => recognizeSpeech(Buffer.alloc(600, 1), env), (error) => error?.code === "VOICE_CONFIG_INVALID");
  await assert.rejects(synthesizeSpeech("测试播报", env, {
    fetchImpl: async () => { fetchCalled = true; return Response.json({}); },
  }), (error) => error?.code === "VOICE_CONFIG_INVALID");
  assert.equal(fetchCalled, false);
});
