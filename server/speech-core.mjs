import WebSocket from "ws";
import { credentialValues, isUsableProviderCredential, safeOutputText } from "./output-safety.mjs";

const ASR_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const TTS_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const DEFAULT_TTS_MODEL = "qwen3-tts-vc-2026-01-22";
const DEFAULT_VOICE_ID = "qwen-tts-vc-bailian-voice-20260521094447301-9db4";
const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_TTS_AUDIO_URL_LENGTH = 16_384;
const ASR_AUDIO_FRAME_BYTES = 16 * 1024;
const DEFAULT_ASR_TIMEOUT_MS = 90_000;
const TRUSTED_TTS_AUDIO_HOSTS = new Set([
  // TTS_ENDPOINT is the Beijing DashScope endpoint. Keep this an exact bucket
  // allowlist: arbitrary *.oss-*.aliyuncs.com buckets can be attacker-owned.
  "dashscope-result-bj.oss-cn-beijing.aliyuncs.com",
]);

export class SpeechServiceError extends Error {
  constructor(message, statusCode = 500, code = "SPEECH_ERROR") {
    super(message);
    this.name = "SpeechServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const requireApiKey = (env) => {
  const apiKey = env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new SpeechServiceError("语音服务尚未配置，请稍后再试。", 503, "VOICE_NOT_CONFIGURED");
  if (!isUsableProviderCredential(apiKey)) throw new SpeechServiceError("语音服务密钥配置无效，请联系平台管理员。", 503, "VOICE_CONFIG_INVALID");
  return apiKey;
};

export function recognizeSpeech(audioBuffer, env = process.env, format = "wav", { WebSocketImpl = WebSocket, signal, timeoutMs } = {}) {
  const apiKey = requireApiKey(env);
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 500) {
    throw new SpeechServiceError("没有检测到有效录音，请再说一次。", 400, "INVALID_AUDIO");
  }
  if (audioBuffer.length > 3 * 1024 * 1024) {
    throw new SpeechServiceError("录音时间过长，请控制在一分钟以内。", 413, "AUDIO_TOO_LARGE");
  }
  const cancelled = () => new SpeechServiceError("语音识别已取消。", 499, "ASR_CANCELLED");
  if (signal?.aborted) return Promise.reject(cancelled());
  const configuredTimeout = Number(timeoutMs ?? env.ASR_TIMEOUT_MS);
  const effectiveTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, DEFAULT_ASR_TIMEOUT_MS) : DEFAULT_ASR_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const taskId = crypto.randomUUID();
    const socket = new WebSocketImpl(ASR_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      maxPayload: 1_000_000,
    });
    // Paraformer sends repeated interim/final snapshots for a sentence. Its
    // begin_time is stable across updates; text alone cannot identify a sentence
    // because a user may intentionally repeat exactly the same words.
    const sentences = new Map();
    const sentenceAliases = new Map();
    let nextSentenceKey = 0;
    let activeSentenceKey;
    let sendingAudio = false;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if ((socket.readyState === 0 || socket.readyState === 1) && typeof socket.terminate === "function") socket.terminate();
      else if (socket.readyState === 1 || socket.readyState === 0) socket.close();
      callback();
    };
    const onAbort = () => finish(() => reject(cancelled()));
    const timeout = setTimeout(() => finish(() => reject(new SpeechServiceError("语音识别等待超时，录音内容尚未发送为问题，请重试。", 504, "ASR_TIMEOUT"))), effectiveTimeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    const connectionFailure = () => finish(() => reject(new SpeechServiceError("语音识别连接中断，录音内容尚未发送为问题，请重试。", 502, "ASR_CONNECTION_ERROR")));
    const sendAudio = async () => {
      if (sendingAudio || settled) return;
      sendingAudio = true;
      try {
        // Recorded files are already available. Send bounded frames in order,
        // waiting for each write rather than queueing a multi-megabyte WS packet
        // or adding a second real-time wait equal to the recording duration.
        for (let offset = 0; offset < audioBuffer.length && !settled; offset += ASR_AUDIO_FRAME_BYTES) {
          await new Promise((writeResolve, writeReject) => {
            socket.send(audioBuffer.subarray(offset, offset + ASR_AUDIO_FRAME_BYTES), (error) => error ? writeReject(error) : writeResolve());
          });
        }
        if (!settled) socket.send(JSON.stringify({
          header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
          payload: { input: {} },
        }));
      } catch { connectionFailure(); }
    };

    socket.on("open", () => {
      if (settled) return;
      try { socket.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: "paraformer-realtime-v2",
          parameters: { format: ["wav", "mp3", "opus", "aac"].includes(format) ? format : "wav", sample_rate: 16_000, language_hints: ["zh"] },
          input: {},
        },
      })); } catch { connectionFailure(); }
    });

    socket.on("message", (data) => {
      if (settled) return;
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const event = message.header?.event;
      if (message.header?.task_id && message.header.task_id !== taskId) return;
      if (event === "task-started") {
        void sendAudio();
      } else if (event === "result-generated") {
        const sentence = message.payload?.output?.sentence;
        if (sentence?.heartbeat || typeof sentence?.text !== "string" || !sentence.text.trim()) return;
        const explicitId = sentence.sentence_id ?? sentence.index;
        const beginTime = Number.isFinite(sentence.begin_time) ? sentence.begin_time : undefined;
        const aliases = [
          ...(typeof explicitId === "string" || Number.isFinite(explicitId) ? [`id:${explicitId}`] : []),
          ...(beginTime !== undefined ? [`time:${beginTime}`] : []),
        ];
        let key = beginTime !== undefined ? sentenceAliases.get(`time:${beginTime}`) : undefined;
        if (key === undefined) key = aliases.map((alias) => sentenceAliases.get(alias)).find((value) => value !== undefined
          && (beginTime === undefined || sentences.get(value)?.beginTime === undefined || sentences.get(value)?.beginTime === beginTime));
        const active = sentences.get(activeSentenceKey);
        if (key === undefined && active && !active.final
          && (aliases.length === 0 || !active.identified || sentence.sentence_end && beginTime === undefined)) key = activeSentenceKey;
        if (key === undefined) key = nextSentenceKey++;
        for (const alias of aliases) sentenceAliases.set(alias, key);
        const previous = sentences.get(key);
        if (!previous?.final || sentence.sentence_end) sentences.set(key, {
          text: sentence.text.trim(), final: sentence.sentence_end === true,
          beginTime: beginTime ?? previous?.beginTime,
          identified: Boolean(aliases.length) || Boolean(previous?.identified),
          order: previous?.order ?? sentences.size,
        });
        if (sentence.sentence_end && activeSentenceKey === key) activeSentenceKey = undefined;
        else if (!sentence.sentence_end && !previous?.final) activeSentenceKey = key;
      } else if (event === "task-finished") {
        const ordered = [...sentences.values()];
        // Without identifiers, identical final texts can be distinct spoken
        // sentences: preserve both instead of guessing a duplicate. If any
        // timestamp is missing, arrival order is the only reliable ordering for
        // that task; comparing only some pairs by time is non-transitive.
        if (ordered.every((sentence) => sentence.beginTime !== undefined)) ordered.sort((left, right) => left.beginTime - right.beginTime || left.order - right.order);
        const transcript = ordered.map((sentence) => sentence.text).join("");
        const safeTranscript = safeOutputText(transcript.trim(), credentialValues(env), 4000);
        finish(() => safeTranscript
          ? resolve(safeTranscript)
          : reject(new SpeechServiceError("没有识别到清晰语音，请再说一次。", 422, "EMPTY_TRANSCRIPT")));
      } else if (event === "task-failed") {
        finish(() => reject(new SpeechServiceError("语音识别服务暂时不可用，请稍后再试。", 502, "ASR_UPSTREAM_ERROR")));
      }
    });

    socket.on("error", connectionFailure);
    socket.on("close", () => {
      if (!settled) finish(() => reject(new SpeechServiceError("语音识别连接提前结束，录音内容尚未发送为问题，请重试。", 502, "ASR_CONNECTION_CLOSED")));
    });
  });
}

function validatedAudio(audio, env) {
  if (!Buffer.isBuffer(audio) || !audio.length) return undefined;
  if (audio.length > MAX_TTS_AUDIO_BYTES) throw new SpeechServiceError("语音服务返回内容过大。", 502, "AUDIO_TOO_LARGE");
  for (const secret of credentialValues(env)) {
    if (audio.includes(Buffer.from(secret, "utf8"))) {
      throw new SpeechServiceError("语音服务返回了异常内容，请稍后再试。", 502, "UNSAFE_AUDIO_OUTPUT");
    }
  }
  return audio;
}

function unsafeAudioSource() {
  return new SpeechServiceError("语音服务返回了不安全的外部音频地址。", 502, "UNSAFE_AUDIO_SOURCE");
}

function trustedAudioUrl(value, env) {
  if (typeof value !== "string" || !value || value.length > MAX_TTS_AUDIO_URL_LENGTH || value.trim() !== value) {
    throw unsafeAudioSource();
  }
  let url;
  try { url = new URL(value); } catch { throw unsafeAudioSource(); }
  if (!TRUSTED_TTS_AUDIO_HOSTS.has(url.hostname)
    || !["http:", "https:"].includes(url.protocol)
    || url.port
    || url.username
    || url.password
    || url.hash) {
    throw unsafeAudioSource();
  }
  // DashScope currently returns this exact OSS host with an http:// URL even
  // though OSS serves the same signed object over TLS. Never send the request
  // in cleartext: upgrade only after the exact-host and URL-shape checks pass.
  if (url.protocol === "http:") url.protocol = "https:";

  let decodedUrl = url.href;
  try { decodedUrl = decodeURIComponent(url.href); } catch { /* The parsed raw URL is still checked below. */ }
  if (credentialValues(env).some((secret) => url.href.includes(secret) || decodedUrl.includes(secret))) {
    throw unsafeAudioSource();
  }
  return url;
}

async function cancelResponseBody(response) {
  try { await response.body?.cancel(); } catch { /* Best-effort connection cleanup. */ }
}

async function readAudioChunk(reader, signal) {
  signal.throwIfAborted();
  let onAbort;
  const aborted = new Promise((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedAudio(response, signal) {
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/u.test(rawLength.trim())) {
      await cancelResponseBody(response);
      throw new SpeechServiceError("语音服务返回了无效音频。", 502, "INVALID_AUDIO_OUTPUT");
    }
    const declared = Number(rawLength);
    if (!Number.isSafeInteger(declared) || declared > MAX_TTS_AUDIO_BYTES) {
      await cancelResponseBody(response);
      throw new SpeechServiceError("语音服务返回内容过大。", 502, "AUDIO_TOO_LARGE");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readAudioChunk(reader, signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_TTS_AUDIO_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SpeechServiceError("语音服务返回内容过大。", 502, "AUDIO_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function downloadedAudioKind(audio) {
  if (audio.length >= 12
    && audio.subarray(0, 4).toString("ascii") === "RIFF"
    && audio.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (audio.length >= 3 && audio.subarray(0, 3).toString("ascii") === "ID3") return "mpeg";
  if (audio.length >= 2 && audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0) return "mpeg";
  return null;
}

function validateDownloadedAudioContent(audio, response) {
  if (!audio.length) return;
  const kind = downloadedAudioKind(audio);
  const mediaType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const genericType = !mediaType || mediaType === "application/octet-stream";
  const wavType = ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"].includes(mediaType);
  const mpegType = ["audio/mpeg", "audio/mp3"].includes(mediaType);
  if (!kind || (!genericType && !(kind === "wav" ? wavType : mpegType))) {
    throw new SpeechServiceError("语音服务返回了无效音频。", 502, "INVALID_AUDIO_OUTPUT");
  }
}

async function downloadTrustedAudio(value, env, fetchImpl) {
  const url = trustedAudioUrl(value, env);
  const signal = AbortSignal.timeout(30_000);
  let response;
  try {
    response = await fetchImpl(url.href, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      headers: { Accept: "audio/wav, audio/mpeg, application/octet-stream;q=0.5" },
      signal,
    });
  } catch {
    throw new SpeechServiceError("语音文件下载失败，请稍后再试。", 502, "TTS_AUDIO_DOWNLOAD_ERROR");
  }
  if (response.redirected || response.status >= 300 && response.status < 400) {
    await cancelResponseBody(response);
    throw unsafeAudioSource();
  }
  if (!response.ok) {
    await cancelResponseBody(response);
    throw new SpeechServiceError("语音文件下载失败，请稍后再试。", 502, "TTS_AUDIO_DOWNLOAD_ERROR");
  }

  let audio;
  try { audio = await readBoundedAudio(response, signal); }
  catch (error) {
    if (error instanceof SpeechServiceError) throw error;
    throw new SpeechServiceError("语音文件下载失败，请稍后再试。", 502, "TTS_AUDIO_DOWNLOAD_ERROR");
  }
  validateDownloadedAudioContent(audio, response);
  return audio;
}

const extractAudio = async (payload, env, fetchImpl) => {
  const output = payload?.output;
  const content = output?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item?.audio?.data) return Buffer.from(item.audio.data, "base64");
      if (item?.audio?.url) return downloadTrustedAudio(item.audio.url, env, fetchImpl);
    }
  }
  if (output?.audio?.data) return Buffer.from(output.audio.data, "base64");
  if (output?.audio?.url) return downloadTrustedAudio(output.audio.url, env, fetchImpl);
  return undefined;
};

const speechContent = (text) => {
  const content = typeof text === "string" ? text.trim().slice(0, 1200) : "";
  if (!content) throw new SpeechServiceError("缺少需要播报的文字。", 400, "INVALID_TEXT");
  return content;
};

const ttsRequestBody = (content, env) => JSON.stringify({
  model: env.TTS_MODEL || DEFAULT_TTS_MODEL,
  input: { text: content, voice: env.TTS_VOICE_ID || DEFAULT_VOICE_ID, language_type: "Chinese" },
});

const speechRequestSignal = (signal) => {
  const timeoutSignal = AbortSignal.timeout(60_000);
  if (!signal) return timeoutSignal;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeoutSignal]);
  return signal;
};

export async function synthesizeSpeech(text, env = process.env, { fetchImpl = fetch } = {}) {
  const apiKey = requireApiKey(env);
  const content = speechContent(text);

  const response = await fetchImpl(TTS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: ttsRequestBody(content, env),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new SpeechServiceError("语音播报服务暂时不可用，请稍后再试。", 502, "TTS_UPSTREAM_ERROR");
  const audio = validatedAudio(await extractAudio(await response.json(), env, fetchImpl), env);
  if (!audio?.length) throw new SpeechServiceError("语音播报服务未返回有效音频。", 502, "EMPTY_AUDIO");
  return audio;
}

function parseTtsDataLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith(":")) return null;
  if (!trimmed.startsWith("data:")) return null;
  let payload;
  try {
    payload = JSON.parse(trimmed.slice(5).trim());
  } catch {
    throw new SpeechServiceError("语音流返回了无效数据。", 502, "INVALID_TTS_STREAM");
  }
  if (payload?.code || (payload?.status_code && payload.status_code !== 200)) {
    throw new SpeechServiceError("语音播报服务暂时不可用，请稍后再试。", 502, "TTS_UPSTREAM_ERROR");
  }
  const audioData = payload?.output?.audio?.data;
  return {
    audio: typeof audioData === "string" && audioData ? Buffer.from(audioData, "base64") : undefined,
    done: payload?.output?.finish_reason === "stop",
  };
}

export async function* parseTtsStream(body, signal) {
  if (!body?.getReader) throw new SpeechServiceError("语音服务未返回可读取的数据流。", 502, "EMPTY_TTS_STREAM");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = signal ? await readAudioChunk(reader, signal) : await reader.read();
      signal?.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        signal?.throwIfAborted();
        const event = parseTtsDataLine(line);
        if (event?.audio?.length) yield event.audio;
        if (event?.done) {
          completed = true;
          return;
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      signal?.throwIfAborted();
      const event = parseTtsDataLine(buffer);
      if (event?.audio?.length) yield event.audio;
      if (event?.done) completed = true;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed) throw new SpeechServiceError("语音流意外中断，请重试。", 502, "TTS_STREAM_INCOMPLETE");
}

export async function* synthesizeSpeechStream(text, env = process.env, signal, { fetchImpl = fetch } = {}) {
  const apiKey = requireApiKey(env);
  const content = speechContent(text);
  const activeSignal = speechRequestSignal(signal);
  const response = await fetchImpl(TTS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-SSE": "enable",
    },
    body: ttsRequestBody(content, env),
    signal: activeSignal,
  });
  try {
    activeSignal.throwIfAborted();
    if (!response.ok) throw new SpeechServiceError("语音播报服务暂时不可用，请稍后再试。", 502, "TTS_UPSTREAM_ERROR");
    const protectedBytes = credentialValues(env).map((secret) => Buffer.from(secret, "utf8"));
    let pending = Buffer.alloc(0);
    let total = 0;
    for await (const chunk of parseTtsStream(response.body, activeSignal)) {
      activeSignal.throwIfAborted();
      total += chunk.length;
      if (total > MAX_TTS_AUDIO_BYTES) throw new SpeechServiceError("语音服务返回内容过大。", 502, "AUDIO_TOO_LARGE");
      const audio = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let held = 0;
      for (const secret of protectedBytes) {
        if (audio.includes(secret)) throw new SpeechServiceError("语音服务返回了无效音频。", 502, "UNSAFE_AUDIO_OUTPUT");
        // Keep only a suffix that could become a credential in a later frame.
        // Everything before it is safe to play without waiting for upstream EOF.
        for (let length = Math.min(secret.length - 1, audio.length); length > held; length -= 1) {
          if (audio.subarray(audio.length - length).equals(secret.subarray(0, length))) {
            held = length;
            break;
          }
        }
      }
      const releasable = audio.length - held;
      const aligned = releasable - (releasable % 2);
      // PCM is signed 16-bit: carry any incomplete sample into the next frame.
      pending = Buffer.from(audio.subarray(aligned));
      if (aligned) yield audio.subarray(0, aligned);
    }
    activeSignal.throwIfAborted();
    if (!total) throw new SpeechServiceError("语音播报服务未返回有效音频。", 502, "EMPTY_AUDIO");
    if (pending.length % 2) throw new SpeechServiceError("语音服务返回了无效音频。", 502, "INVALID_AUDIO_OUTPUT");
    if (pending.length) yield pending;
  } finally {
    await cancelResponseBody(response);
  }
}
