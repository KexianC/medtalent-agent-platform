import { createSpeechChunker } from "./chatStream.ts";

type Timer = ReturnType<typeof setTimeout>;

/** Serial synthesis keeps PCM on one timeline; synthesis does not wait for playback. */
export function createSpeechQueue({
  speak,
  isActive,
  firstWaitMs = 700,
  nextWaitMs = 1800,
  setTimer = (callback: () => void, delay: number): Timer => setTimeout(callback, delay),
  clearTimer = (timer: Timer) => clearTimeout(timer),
}: {
  speak: (text: string, signal: AbortSignal) => Promise<void>;
  isActive: () => boolean;
  firstWaitMs?: number;
  nextWaitMs?: number;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  const chunker = createSpeechChunker();
  const controller = new AbortController();
  let closed = false;
  let timer: Timer | undefined;
  let chain = Promise.resolve();
  const active = () => !controller.signal.aborted && isActive();
  const clearDeadline = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const enqueue = (chunks: string[]) => {
    if (chunks.length) clearDeadline();
    for (const chunk of chunks) {
      chain = chain.then(async () => {
        if (active()) await speak(chunk, controller.signal);
      }).catch(() => { controller.abort(); clearDeadline(); });
    }
  };
  return {
    push(delta: string) {
      if (closed || !active()) return;
      enqueue(chunker.push(delta));
      if (timer === undefined && chunker.hasPending()) {
        timer = setTimer(() => {
          timer = undefined;
          if (!closed && active()) enqueue(chunker.flushPending());
        }, chunker.hasEmitted() ? nextWaitMs : firstWaitMs);
      }
    },
    async finish() {
      if (!closed) {
        closed = true;
        clearDeadline();
        if (active()) enqueue(chunker.push("", true));
      }
      await chain;
    },
    cancel() {
      closed = true;
      clearDeadline();
      controller.abort();
    },
  };
}
