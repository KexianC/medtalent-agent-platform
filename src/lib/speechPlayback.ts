export class SpeechPlaybackError extends Error {
  code: "AUDIO_BLOCKED" | "AUDIO_STALLED";
  constructor(code: "AUDIO_BLOCKED" | "AUDIO_STALLED") {
    super(code === "AUDIO_BLOCKED"
      ? "浏览器暂停了声音播放，请点击“恢复播报”。"
      : "声音播放中断了，回复文字已保留，请点击“恢复播报”。");
    this.name = "SpeechPlaybackError";
    this.code = code;
  }
}

type PlaybackContext = { readonly state: string; readonly currentTime: number; resume: () => Promise<void> };

/** Invoke resume synchronously from the user's gesture, with a bounded wait. */
export async function resumeSpeechContext(context: PlaybackContext, timeoutMs = 1800) {
  if (context.state === "running") return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resume = context.resume();
    await Promise.race([
      resume,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new SpeechPlaybackError("AUDIO_BLOCKED")), timeoutMs);
      }),
    ]);
    if (context.state !== "running") throw new SpeechPlaybackError("AUDIO_BLOCKED");
  } catch (error) {
    throw error instanceof SpeechPlaybackError ? error : new SpeechPlaybackError("AUDIO_BLOCKED");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A suspended/frozen audio clock must never hold the conversation open. */
export async function waitForSpeechTimeline({
  context, scheduledUntil, isActive, signal, stallMs = 2500, maximumMs = 120_000,
  now = () => performance.now(), sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  context: Pick<PlaybackContext, "state" | "currentTime">;
  scheduledUntil: () => number;
  isActive: () => boolean;
  signal?: AbortSignal;
  stallMs?: number;
  maximumMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const started = now();
  let progressedAt = started;
  let previousTime = context.currentTime;
  while (!signal?.aborted && isActive()) {
    if (scheduledUntil() - context.currentTime <= 0.03) return;
    if (context.state !== "running") throw new SpeechPlaybackError("AUDIO_BLOCKED");
    if (context.currentTime > previousTime) {
      previousTime = context.currentTime;
      progressedAt = now();
    }
    if (now() - progressedAt >= stallMs || now() - started >= maximumMs) throw new SpeechPlaybackError("AUDIO_STALLED");
    await sleep(100);
  }
}
