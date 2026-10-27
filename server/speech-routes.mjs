import express from "express";
import { getBuilderReadiness } from "./agent-builder.mjs";
import { SpeechServiceError, recognizeSpeech, synthesizeSpeech, synthesizeSpeechStream } from "./speech-core.mjs";
import { credentialValues, safeOutputCode, safeOutputText } from "./output-safety.mjs";

export function registerSpeechRoutes(app, { env, limit, fetchImpl = fetch, recognizeSpeechImpl = recognizeSpeech, database, knowledge, viewer }) {
  const voiceEnvironment = async (req) => {
    const slug = req.params?.slug || req.body?.doctorSlug;
    if (!slug || !database) return env;
    if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(slug)) throw new SpeechServiceError("智能体标识无效。", 400, "INVALID_DOCTOR");
    const stored = await database.getAgent(slug, !req.params?.slug);
    if (!stored) throw new SpeechServiceError("智能体不存在或尚未发布。", 404, "INVALID_DOCTOR");
    if (req.params?.slug && req.body?.draftHash !== undefined) {
      const current = await getBuilderReadiness(database, slug);
      if (current.draftHash !== req.body.draftHash) throw new SpeechServiceError("草稿已更新，请刷新预览后重试。", 409, "STALE_DRAFT");
    }
    const doctor = knowledge ? knowledge.publicAgent(stored) : stored;
    if (!doctor.builder) return env;
    if (!doctor.builder.voice.enabled || !doctor.builder.components.some(component => component.id === "voice" && component.enabled)) throw new SpeechServiceError("该智能体未启用语音播报。", 403, "VOICE_DISABLED");
    const speaker = doctor.builder.voice.speaker;
    if (speaker && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(speaker)) throw new SpeechServiceError("该智能体音色配置无效。", 400, "INVALID_VOICE");
    return speaker ? { ...env, TTS_VOICE_ID: speaker } : env;
  };
  app.post("/api/asr", limit("asr", 12), express.raw({ type: ["audio/*", "application/octet-stream"], limit: "3mb" }), async (req, res, next) => {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    req.on("aborted", close);
    res.on("close", close);
    try {
      const mediaType = req.get("content-type")?.split(";")[0];
      const format = mediaType === "audio/mpeg" ? "mp3" : mediaType === "audio/aac" ? "aac" : mediaType?.includes("opus") ? "opus" : "wav";
      const text = await recognizeSpeechImpl(req.body, env, format, { signal: controller.signal });
      if (!res.destroyed && !controller.signal.aborted) res.json({ text });
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed) next(error);
    } finally {
      req.off("aborted", close);
      res.off("close", close);
    }
  });
  const normalTts = async (req, res, next) => {
    try {
      const audio = await synthesizeSpeech(req.body?.text, await voiceEnvironment(req), { fetchImpl });
      const contentType = audio.subarray(0, 4).toString("ascii") === "RIFF" ? "audio/wav" : "audio/mpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(audio.length));
      res.send(audio);
    } catch (error) { next(error); }
  };
  app.post("/api/tts", limit("tts", 20), normalTts);
  if (viewer) app.post("/api/admin/agents/:slug/tts", viewer, limit("tts-preview", 20), normalTts);
  const streamSessions = new Map();
  const newSessionLimit = limit("tts-session", 12);
  const unscopedLimit = limit("tts-unscoped", 12);
  const streamLimit = (req, res, next) => {
    const sessionId = typeof req.body?.speechRunId === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(req.body.speechRunId) ? req.body.speechRunId : null;
    if (!sessionId) return unscopedLimit(req, res, next);
    const timestamp = Date.now();
    if (streamSessions.size > 512) for (const [key, record] of streamSessions) if (timestamp - record.startedAt >= 60000) streamSessions.delete(key);
    const key = `${req.ip}:${sessionId}`;
    const record = streamSessions.get(key);
    if (!record || timestamp - record.startedAt >= 60000) {
      return newSessionLimit(req, res, (error) => {
        if (error) return next(error);
        streamSessions.set(key, { startedAt: timestamp, count: 1 });
        next();
      });
    }
    record.count += 1;
    if (record.count > 8) return next(new SpeechServiceError("本轮语音片段过多，请稍后重试。", 429, "RATE_LIMITED"));
    next();
  };
  const streamedTts = async (req, res, next) => {
    const controller = new AbortController();
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on("close", close);
    try {
      const iterator = synthesizeSpeechStream(req.body?.text, await voiceEnvironment(req), controller.signal, { fetchImpl });
      let hasAudio = false;
      for await (const chunk of iterator) {
        if (res.destroyed) break;
        if (!res.headersSent) {
          res.status(200).set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-store, no-transform", "X-Accel-Buffering": "no" });
          res.flushHeaders();
        }
        hasAudio = true;
        res.write(`${JSON.stringify({ type: "audio", data: chunk.toString("base64"), sampleRate: 24000 })}\n`);
      }
      if (!hasAudio && !res.destroyed) throw new SpeechServiceError("语音服务未返回有效音频。", 502, "EMPTY_AUDIO");
      if (!res.writableEnded && !res.destroyed) {
        res.write(`${JSON.stringify({ type: "done" })}\n`);
        res.end();
      }
    } catch (error) {
      if (controller.signal.aborted || res.destroyed) return;
      if (res.headersSent) {
        const safeError = safeOutputText(error instanceof SpeechServiceError ? error.message : "语音播报服务暂时不可用。", credentialValues(env), 1000);
        res.write(`${JSON.stringify({ type: "error", error: safeError, code: safeOutputCode(error.code, credentialValues(env), "UPSTREAM_ERROR") })}\n`);
        res.end();
      } else next(error);
    } finally { res.off("close", close); }
  };
  app.post("/api/tts/stream", streamLimit, streamedTts);
  if (viewer) app.post("/api/admin/agents/:slug/tts/stream", viewer, streamLimit, streamedTts);
}
