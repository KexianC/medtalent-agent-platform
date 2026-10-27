export type KnowledgePollToken = { agentSlug: string; generation: number };

export async function runGuardedKnowledgePoll<T>({
  token,
  signal,
  load,
  isCurrent,
  commit,
}: {
  token: KnowledgePollToken;
  signal: AbortSignal;
  load: (signal: AbortSignal) => Promise<T>;
  isCurrent: (token: KnowledgePollToken) => boolean;
  commit: (value: T) => void;
}) {
  let value: T;
  try {
    value = await load(signal);
  } catch (error) {
    if (signal.aborted || !isCurrent(token)) return false;
    throw error;
  }
  if (signal.aborted || !isCurrent(token)) return false;
  commit(value);
  return true;
}
