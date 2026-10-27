export type ChatCitation = {
  title: string;
  shareUrl?: string;
};

export type ChatRetrievalMetadata = {
  citations?: ChatCitation[];
  retrievalMode?: "hybrid" | "lexical" | "none";
};

export function parseChatRetrieval(value: unknown): ChatRetrievalMetadata {
  if (!value || typeof value !== "object") return {};
  const item = value as Record<string, unknown>;
  const seenCitationTitles = new Set<string>();
  const citations = Array.isArray(item.citations) ? item.citations.flatMap((citation) => {
    if (!citation || typeof citation !== "object" || typeof citation.title !== "string" || !citation.title.trim()) return [];
    const title = citation.title.trim();
    if (seenCitationTitles.has(title)) return [];
    seenCitationTitles.add(title);
    const shareUrl = typeof citation.shareUrl === "string" && /^\/api\/citations\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/\d+$/.test(citation.shareUrl) ? citation.shareUrl : undefined;
    return [{ title, ...(shareUrl ? { shareUrl } : {}) }];
  }) : undefined;
  const retrievalMode = item.retrievalMode === "hybrid" || item.retrievalMode === "lexical" || item.retrievalMode === "none" ? item.retrievalMode : undefined;
  return { ...(citations ? { citations } : {}), ...(retrievalMode ? { retrievalMode } : {}) };
}

export function stripChatCitationDetails<T extends ChatRetrievalMetadata>(value: T): T {
  if (!Array.isArray(value.citations)) return value;
  const citations = parseChatRetrieval(value).citations || [];
  const raw = value.citations as unknown as Array<Record<string, unknown>>;
  const alreadyTitleOnly = raw.length === citations.length && raw.every((citation, index) => (
    citation && typeof citation === "object"
    && Object.keys(citation).every(key => key === "title" || key === "shareUrl")
    && citation.title === citations[index]?.title && citation.shareUrl === citations[index]?.shareUrl
  ));
  return alreadyTitleOnly ? value : { ...value, citations };
}

export type ChatStreamEvent =
  | { type: "meta"; model?: string; crisis?: boolean; crisisCategory?: string }
  | { type: "delta"; text: string }
  | ({ type: "result"; reply?: string; text?: string; model?: string } & ChatRetrievalMetadata)
  | ({ type: "done"; model?: string; crisis?: boolean; crisisCategory?: string } & ChatRetrievalMetadata)
  | { type: "error"; error: string; code?: string };

export type AudioStreamEvent =
  | { type: "audio"; data: string; sampleRate: number }
  | { type: "done" }
  | { type: "error"; error: string; code?: string };

const parseEventLine = (line: string): ChatStreamEvent | undefined => {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    throw new Error("流式回复格式无效，请重试。");
  }
  if (!value || typeof value !== "object" || !("type" in value)) return undefined;
  const event = value as Record<string, unknown>;
  if (event.type === "delta" && typeof event.text === "string") return event as ChatStreamEvent;
  if (event.type === "error" && typeof event.error === "string") return event as ChatStreamEvent;
  if (event.type === "meta") return event as ChatStreamEvent;
  if (event.type === "done") return {
    type: "done",
    model: typeof event.model === "string" ? event.model : undefined,
    crisis: typeof event.crisis === "boolean" ? event.crisis : undefined,
    crisisCategory: typeof event.crisisCategory === "string" ? event.crisisCategory : undefined,
    ...parseChatRetrieval(event),
  };
  if (event.type === "result") return {
    type: "result",
    model: typeof event.model === "string" ? event.model : undefined,
    reply: typeof event.reply === "string" ? event.reply : undefined,
    text: typeof event.text === "string" ? event.text : undefined,
    ...parseChatRetrieval(event),
  };
  return undefined;
};

async function* readNdjsonLines(response: Response): AsyncGenerator<string> {
  if (!response.body?.getReader) {
    for (const line of (await response.text()).split(/\r?\n/)) if (line.trim()) yield line;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) yield line;
      if (done) break;
    }
    if (buffer.trim()) yield buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function* readChatStream(response: Response): AsyncGenerator<ChatStreamEvent> {
  for await (const line of readNdjsonLines(response)) {
    const event = parseEventLine(line);
    if (event) yield event;
  }
}

/** One decoder per synthesis request: the provider may prefix PCM with a streamed WAV header. */
export function createPcmStreamDecoder(sampleRate = 24_000) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new Error("语音采样率无效。");
  let pending = new Uint8Array(0);
  let mode: 'detect' | 'header' | 'pcm' = 'detect';
  let headerBytes = 0;
  let hasFormat = false;
  let remaining = Infinity;
  let closed = false;
  const invalid = () => new Error("语音流音频格式无效，请重试。");
  const tag = (offset: number) => String.fromCharCode(...pending.subarray(offset, offset + 4));
  const samples = () => {
    const length = pending.length - pending.length % 2;
    const output = pending.slice(0, length);
    pending = pending.slice(length);
    return output;
  };
  return {
    push(bytes: Uint8Array): Uint8Array {
      if (closed) throw invalid();
      if (mode === 'pcm' && remaining !== Infinity) {
        bytes = bytes.subarray(0, remaining);
        remaining -= bytes.length;
      }
      const joined = new Uint8Array(pending.length + bytes.length);
      joined.set(pending); joined.set(bytes, pending.length); pending = joined;
      if (mode === 'detect') {
        const riff = [82, 73, 70, 70];
        const possibleWave = pending.subarray(0, 4).every((byte, index) => byte === riff[index]);
        if (!possibleWave) mode = 'pcm';
        else {
          if (pending.length < 12) return new Uint8Array(0);
          if (tag(8) !== 'WAVE') { mode = 'pcm'; return samples(); }
          mode = 'header'; headerBytes = 12; pending = pending.slice(12);
        }
      }
      while (mode === 'header') {
        if (pending.length < 8) return new Uint8Array(0);
        const name = tag(0);
        const view = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
        const size = view.getUint32(4, true);
        if (name === 'data') {
          if (!hasFormat) throw invalid();
          // DashScope uses a large sentinel length until streaming has completed.
          remaining = size === 0 || size >= 0x7fff0000 ? Infinity : size;
          pending = pending.slice(8, remaining === Infinity ? undefined : 8 + remaining);
          if (remaining !== Infinity) remaining -= pending.length;
          mode = 'pcm';
          break;
        }
        const chunkLength = 8 + size + size % 2;
        if (headerBytes + chunkLength > 65_536) throw invalid();
        if (pending.length < chunkLength) return new Uint8Array(0);
        if (name === 'fmt ') {
          if (size < 16 || view.getUint16(8, true) !== 1 || view.getUint16(10, true) !== 1
            || view.getUint32(12, true) !== sampleRate || view.getUint32(16, true) !== sampleRate * 2
            || view.getUint16(20, true) !== 2 || view.getUint16(22, true) !== 16) throw invalid();
          hasFormat = true;
        }
        headerBytes += chunkLength;
        pending = pending.slice(chunkLength);
      }
      return samples();
    },
    finish(): Uint8Array {
      closed = true;
      // A short raw PCM sample can coincidentally spell RIFF; only RIFF + WAVE
      // establishes a container. Preserve those raw samples at end of stream.
      if (mode === 'header' || (remaining !== Infinity && remaining !== 0) || pending.length % 2) throw invalid();
      return samples();
    },
  };
}

/** Buffer once; a packet must not insert another 80 ms gap into an ongoing timeline. */
export function getPcmStartTime(now: number, scheduledUntil: number) {
  return scheduledUntil > now + 0.005 ? scheduledUntil : now + 0.25;
}

export async function* readAudioStream(response: Response): AsyncGenerator<AudioStreamEvent> {
  let decoder: ReturnType<typeof createPcmStreamDecoder> | undefined;
  let sampleRate: number | undefined;
  let ended = false;
  const encode = (bytes: Uint8Array) => {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  for await (const line of readNdjsonLines(response)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("语音流格式无效，请重试。");
    }
    if (!value || typeof value !== "object" || !("type" in value)) continue;
    const event = value as Record<string, unknown>;
    if (event.type === "audio" && typeof event.data === "string") {
      if (ended) throw new Error("语音流结束后仍收到音频。");
      const rate = typeof event.sampleRate === "number" ? event.sampleRate : 24_000;
      if (sampleRate !== undefined && rate !== sampleRate) throw new Error("语音流采样率发生变化。");
      sampleRate = rate;
      decoder ??= createPcmStreamDecoder(rate);
      const bytes = decoder.push(Uint8Array.from(atob(event.data), char => char.charCodeAt(0)));
      if (bytes.length) yield { type: "audio", data: encode(bytes), sampleRate: rate };
    } else if (event.type === "done") {
      const tail = decoder?.finish();
      if (tail?.length) yield { type: "audio", data: encode(tail), sampleRate: sampleRate! };
      ended = true;
      yield { type: "done" };
    }
    else if (event.type === "error" && typeof event.error === "string") {
      yield { type: "error", error: event.error, code: typeof event.code === "string" ? event.code : undefined };
    }
  }
}

const speakableLength = (value: string) => value.replace(/[\s*_#>`~•-]/g, "").length;

export function createSpeechChunker({ firstMinChars = 8, firstMaxChars = 24, minChars = 36, maxChars = 90, maxChunks = 8 } = {}) {
  let pending = "";
  let emitted = 0;
  let finished = false;

  const take = (length: number, output: string[]) => {
    const chunk = pending.slice(0, length);
    pending = pending.slice(length);
    if (!speakableLength(chunk)) return;
    output.push(chunk);
    emitted += 1;
  };
  const drain = () => {
    const output: string[] = [];
    // Reserve the last request for the tail; the server allows 8 per speech run.
    while (pending && emitted < maxChunks - 1) {
      const first = emitted === 0;
      const minimum = first ? firstMinChars : minChars;
      const maximum = first ? firstMaxChars : maxChars;
      let end = 0;
      let length = 0;
      for (const character of pending) {
        end += character.length;
        if (speakableLength(character)) length += 1;
        const sentenceEnd = /[。！？!?；;\n]/u.test(character);
        const phraseEnd = sentenceEnd || /[，,：:]/u.test(character);
        if ((sentenceEnd && first && length >= 2) || (phraseEnd && length >= minimum) || length >= maximum) break;
      }
      const chunk = pending.slice(0, end);
      const sentenceEnd = /[。！？!?；;\n]$/u.test(chunk);
      const phraseEnd = /[。！？!?；;\n，,：:]$/u.test(chunk);
      if (!(sentenceEnd && first && length >= 2) && !(phraseEnd && length >= minimum) && length < maximum) break;
      take(end, output);
    }
    return output;
  };

  return {
    push(delta: string, flush = false) {
      if (finished) return [];
      pending += delta;
      const output = drain();
      if (flush) {
        finished = true;
        if (emitted < maxChunks) take(pending.length, output);
      }
      return output;
    },
    flushPending() {
      const output: string[] = [];
      if (!finished && emitted < maxChunks - 1 && speakableLength(pending) >= 2) take(pending.length, output);
      return output;
    },
    hasPending: () => !finished && emitted < maxChunks - 1 && speakableLength(pending) >= 2,
    hasEmitted: () => emitted > 0,
  };
}
