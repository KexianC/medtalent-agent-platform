type RecorderEnvironment = {
  getStream: () => Promise<MediaStream>;
  createContext: () => AudioContext;
};

type RecorderSession = {
  cancelled: boolean;
  recording: boolean;
  ready?: Promise<void>;
  context?: AudioContext;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  processor?: ScriptProcessorNode;
  chunks: Float32Array[];
  sampleRate?: number;
};

const browserEnvironment: RecorderEnvironment = {
  getStream: () => {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前页面无法使用麦克风，请在微信 WebView 或 HTTPS 页面中打开。");
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  },
  createContext: () => {
    const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) throw new Error("当前浏览器不支持语音录制。");
    return new AudioContextClass();
  },
};

const mergeChunks = (chunks: Float32Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });
  return merged;
};

const downsample = (samples: Float32Array, sourceRate: number, targetRate = 16_000) => {
  if (sourceRate === targetRate) return samples;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.round(samples.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let cursor = start; cursor < end; cursor += 1) sum += samples[cursor];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
};

const encodeWav = (samples: Float32Array, sampleRate = 16_000) => {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const normalized = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, normalized < 0 ? normalized * 0x8000 : normalized * 0x7fff, true);
  });
  return new Blob([buffer], { type: "audio/wav" });
};

const stopTracks = (stream: MediaStream) => {
  stream.getTracks().forEach((track) => {
    try { track.stop(); } catch { /* Keep releasing the remaining tracks. */ }
  });
};

const releaseSession = async (session: RecorderSession) => {
  session.cancelled = true;
  const { processor, source, stream, context } = session;
  // Detach ownership before closing: an older close may settle after a new start.
  session.processor = undefined;
  session.source = undefined;
  session.stream = undefined;
  session.context = undefined;
  if (processor) {
    processor.onaudioprocess = null;
    try { processor.disconnect(); } catch { /* Continue with the stream and context. */ }
  }
  if (source) {
    try { source.disconnect(); } catch { /* Continue with the stream and context. */ }
  }
  if (stream) stopTracks(stream);
  if (context) {
    try { await context.close(); } catch { /* Tracks and nodes are already released. */ }
  }
};

/** Owns each acquisition attempt so cancellation also covers pending permission/resume. */
export function createWavRecorder(
  onRecordingChange: (isRecording: boolean) => void,
  environment: RecorderEnvironment = browserEnvironment,
) {
  let current: RecorderSession | undefined;

  const detach = () => {
    const session = current;
    current = undefined;
    if (session?.recording) {
      session.recording = false;
      onRecordingChange(false);
    }
    return session;
  };

  const start = () => {
    if (current) return current.ready;
    const session: RecorderSession = { cancelled: false, recording: false, chunks: [] };
    current = session;
    session.ready = (async () => {
      try {
        const stream = await environment.getStream();
        if (session.cancelled || current !== session) {
          stopTracks(stream);
          return;
        }
        session.stream = stream;
        const context = environment.createContext();
        session.context = context;
        await context.resume();
        if (session.cancelled || current !== session) return;
        session.source = context.createMediaStreamSource(stream);
        session.processor = context.createScriptProcessor(4096, 1, 1);
        session.sampleRate = context.sampleRate;
        session.processor.onaudioprocess = (event) => {
          if (current === session && session.recording) {
            session.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
          }
        };
        session.source.connect(session.processor);
        session.processor.connect(context.destination);
        session.recording = true;
        onRecordingChange(true);
      } catch (error) {
        const cancelled = session.cancelled || current !== session;
        if (current === session) detach();
        await releaseSession(session);
        // A dismissed permission prompt must not surface errors in a newer session.
        if (!cancelled) throw error;
      }
    })();
    return session.ready;
  };

  const cancel = async () => {
    const session = detach();
    if (session) await releaseSession(session);
  };

  const stop = async () => {
    const session = current;
    const wasRecording = session?.recording;
    detach();
    if (!session) return undefined;
    await releaseSession(session);
    if (!wasRecording) return undefined;
    const samples = downsample(mergeChunks(session.chunks), session.sampleRate!);
    if (samples.length < 1600) throw new Error("录音时间太短，请再说一次。");
    return encodeWav(samples);
  };

  return { start, stop, cancel };
}
