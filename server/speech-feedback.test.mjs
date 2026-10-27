import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";
import express from "express";
import { recognizeSpeech } from "./speech-core.mjs";
import { registerSpeechRoutes } from "./speech-routes.mjs";

const env = { DASHSCOPE_API_KEY: "isolated-asr-test-key" };
const sentence = (text, begin_time, sentence_end = true, extra = {}) => ({
  header: { event: "result-generated" },
  payload: { output: { sentence: { text, begin_time, sentence_end, ...extra } } },
});
const finished = { header: { event: "task-finished" } };

function fakeAsr(events = [], options = {}) {
  const observed = { instances: 0, frames: [], commands: [], outstanding: 0, maxOutstanding: 0 };
  class Socket extends EventEmitter {
    constructor() {
      super();
      observed.instances += 1;
      observed.socket = this;
      this.readyState = 0;
      queueMicrotask(() => {
        if (this.readyState === 3) return;
        this.readyState = 1;
        this.emit("open");
      });
    }
    push(event) { this.emit("message", Buffer.from(JSON.stringify(event))); }
    send(data, callback) {
      if (Buffer.isBuffer(data)) {
        observed.frames.push(Buffer.from(data));
        observed.outstanding += 1;
        observed.maxOutstanding = Math.max(observed.maxOutstanding, observed.outstanding);
        queueMicrotask(() => {
          observed.outstanding -= 1;
          options.onFrame?.(this);
          callback?.(options.writeError);
        });
        return;
      }
      const command = JSON.parse(data);
      observed.commands.push(command.header.action);
      if (command.header.action === "run-task") queueMicrotask(() => {
        options.onStart?.(this);
        if (this.readyState !== 3) this.push({ header: { event: "task-started" } });
      });
      if (command.header.action === "finish-task") {
        assert.equal(observed.outstanding, 0, "finish-task must follow the final write acknowledgement");
        queueMicrotask(() => { for (const event of events) this.push(event); });
      }
    }
    close() { this.readyState = 3; this.emit("close"); }
    terminate() { observed.terminated = true; this.close(); }
  }
  return { observed, WebSocketImpl: Socket };
}

test("ASR keeps every sentence, replaces interim snapshots and ignores duplicate finals/heartbeats", async () => {
  const fake = fakeAsr([
    sentence("昨晚", 0, false), sentence("昨晚很晚才睡。", 0),
    sentence("昨晚很晚才睡。", 0), sentence("旧的中间结果", 0, false),
    sentence("今天", 8500, false), sentence("今天起床后很累。", 8500),
    sentence("忽略心跳", 11000, true, { heartbeat: true }),
    sentence("还有工作上的压力。", 19000), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "昨晚很晚才睡。今天起床后很累。还有工作上的压力。");
  assert.equal(fake.observed.terminated, true);
});

test("ASR orders official sentence timestamps and preserves intentional repeated phrases", async () => {
  const fake = fakeAsr([
    sentence("我很累。", 3000), sentence("我很累。", 0), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "我很累。我很累。");
});

test("ASR handles alternate sentence ids and the latest unfinished tail without appending snapshots", async () => {
  const fake = fakeAsr([
    sentence("我睡不好", undefined, false, { sentence_id: 0 }),
    sentence("我睡得不好。", undefined, true, { sentence_id: 0 }),
    sentence("白天", undefined, false, { sentence_id: 1 }),
    sentence("白天没有精神。", undefined, false, { sentence_id: 1 }), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "我睡得不好。白天没有精神。");
});

test("ASR coalesces sentence identity when a final introduces an id after a timestamp-only interim", async () => {
  const fake = fakeAsr([
    sentence("今天", 0, false),
    sentence("今天很累。", 0, true, { sentence_id: 0 }),
    sentence("今天很累。", undefined, true, { sentence_id: 0 }),
    sentence("夜里总是醒。", 4000, true, { sentence_id: 1 }), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "今天很累。夜里总是醒。");
});

test("ASR retains deterministic arrival order for mixed timestamped and unidentified sentences", async () => {
  const fake = fakeAsr([
    sentence("第一段。", 8000), sentence("中间没有时间戳。", undefined),
    sentence("第三段。", 0), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "第一段。中间没有时间戳。第三段。");
});

test("ASR preserves repeated anonymous final sentences and only replaces an active interim", async () => {
  const fake = fakeAsr([
    sentence("我很累。", undefined), sentence("我很累。", undefined),
    sentence("还有", undefined, false), sentence("还有睡不好。", undefined), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "我很累。我很累。还有睡不好。");
});

test("ASR timestamp identity remains authoritative if an alternate id is reused", async () => {
  const fake = fakeAsr([
    sentence("第一句话。", 0, true, { sentence_id: 0 }),
    sentence("第二句话。", 4000, true, { sentence_id: 0 }), finished,
  ]);
  assert.equal(await recognizeSpeech(Buffer.alloc(600), env, "wav", fake), "第一句话。第二句话。");
});

test("ASR configured timeout stays within the 100-second frontend request window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = fakeAsr();
  let result;
  const pending = recognizeSpeech(Buffer.alloc(600), { ...env, ASR_TIMEOUT_MS: "180000" }, "wav", fake)
    .catch((error) => { result = error; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(89_999);
  await Promise.resolve();
  assert.equal(result, undefined);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(result?.code, "ASR_TIMEOUT");
  assert.equal(fake.observed.terminated, true);
});

test("ASR sends a 60-second recording in bounded sequential binary frames before finish-task", async () => {
  const recording = Buffer.alloc(60 * 16_000 * 2 + 44, 1);
  const fake = fakeAsr([sentence("一分钟的三句话。", 0), finished]);
  assert.equal(await recognizeSpeech(recording, env, "wav", fake), "一分钟的三句话。");
  assert.ok(fake.observed.frames.length > 1);
  assert.ok(fake.observed.frames.every((frame) => frame.length <= 16 * 1024));
  assert.equal(fake.observed.maxOutstanding, 1);
  assert.deepEqual(Buffer.concat(fake.observed.frames), recording);
  assert.deepEqual(fake.observed.commands, ["run-task", "finish-task"]);
});

test("ASR cancellation skips connection or stops an in-flight recording and releases its socket", async () => {
  const preCancelled = new AbortController();
  preCancelled.abort();
  const unopened = fakeAsr();
  await assert.rejects(recognizeSpeech(Buffer.alloc(600), env, "wav", { ...unopened, signal: preCancelled.signal }), { code: "ASR_CANCELLED" });
  assert.equal(unopened.observed.instances, 0);

  const controller = new AbortController();
  const fake = fakeAsr([], { onFrame: () => controller.abort() });
  await assert.rejects(recognizeSpeech(Buffer.alloc(60_000), env, "wav", { ...fake, signal: controller.signal }), { code: "ASR_CANCELLED" });
  assert.equal(fake.observed.terminated, true);
  assert.equal(fake.observed.frames.length, 1);
  assert.deepEqual(fake.observed.commands, ["run-task"]);
});

test("ASR reports empty audio, upstream rejection, early close, write error and configurable timeout distinctly", async (t) => {
  for (const [name, events, options, code] of [
    ["no speech", [finished], {}, "EMPTY_TRANSCRIPT"],
    ["provider failed", [{ header: { event: "task-failed", error_message: env.DASHSCOPE_API_KEY } }], {}, "ASR_UPSTREAM_ERROR"],
    ["socket closed", [], { onStart: (socket) => socket.close() }, "ASR_CONNECTION_CLOSED"],
    ["write failed", [], { writeError: new Error("socket unavailable") }, "ASR_CONNECTION_ERROR"],
    ["timeout", [], {}, "ASR_TIMEOUT"],
  ]) await t.test(name, async () => {
    const fake = fakeAsr(events, options);
    await assert.rejects(recognizeSpeech(Buffer.alloc(600), { ...env, ASR_TIMEOUT_MS: "20" }, "wav", fake), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.message.includes(env.DASHSCOPE_API_KEY), false);
      return true;
    });
    assert.equal(fake.observed.socket.readyState, 3);
  });
});

test("ASR HTTP client disconnect aborts recognition without writing a response", async () => {
  const app = express();
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = resolve; });
  registerSpeechRoutes(app, {
    env, limit: () => (_req, _res, next) => next(),
    recognizeSpeechImpl: (_audio, _env, _format, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted(); reject(new Error("cancelled")); }, { once: true });
      entered();
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const req = http.request({ host: "127.0.0.1", port: server.address().port, path: "/api/asr", method: "POST", headers: { "Content-Type": "audio/wav", "Content-Length": "600" } });
  req.on("error", () => {});
  try {
    req.end(Buffer.alloc(600));
    await started;
    req.destroy();
    await cancelled;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
