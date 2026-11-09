/**
 * A server's songs, listed again once per start (stores/catalog.ts): songs added on the server
 * and covers it found since then come in by themselves. Tried at once and, while the server
 * can't be reached yet (Windows has just started and the network isn't up, or there's no way in
 * from where the computer is), again after each of `waits`. A listing that came back the same
 * changes nothing on screen; one that differs is announced. Answers a stop for the tries to come.
 */
export interface RelistTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: RelistTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function relistOnce(
  relist: () => Promise<boolean>,
  onChanged: () => void,
  waits: readonly number[],
  timers: RelistTimers = realTimers
): () => void {
  let stopped = false;
  let pending: unknown = null;
  const attempt = (tried: number): void => {
    Promise.resolve()
      .then(relist)
      .then(
        (changed) => {
          if (!stopped && changed) onChanged();
        },
        () => {
          if (stopped || tried >= waits.length) return;
          pending = timers.set(() => {
            pending = null;
            attempt(tried + 1);
          }, waits[tried]);
        }
      );
  };
  attempt(0);
  return () => {
    stopped = true;
    if (pending !== null) timers.clear(pending);
    pending = null;
  };
}
