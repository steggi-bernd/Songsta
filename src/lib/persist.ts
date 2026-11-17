/** Zustand storage adapter: JSON files via the desktop bridge, localStorage fallback. */
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

export const storage: StateStorage = {
  getItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        const v = await b.readData(name);
        return v == null ? null : JSON.stringify(v);
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, JSON.parse(value));
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, null);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Write-coalescing storage for high-frequency stores (player, library). The
 * audio engine updates `position` on every `timeupdate` (~4Hz) and download
 * progress patches the library several times a second — zustand persist
 * writes on every state change, and unthrottled that serializes the whole
 * store to disk (and over IPC) several times a second. A change lands
 * immediately when the last write was ≥2s ago; otherwise 2s after the FIRST
 * deferred change, so pending state never waits longer than the interval and
 * bursty user actions (play/queue edits after an idle stretch) still persist
 * at once. The pending value is flushed on pagehide/beforeunload — the last
 * reliable hooks before the window or the app goes away. Worst case is that
 * the resume position loses the final ≤2s, which is imperceptible.
 */
const COALESCED_WRITE_MS = 2_000;

/** The write scheduler behind the coalescing storage. A value is held as a
    thunk, so its text is only produced when it is actually written. */
const coalescer = (() => {
  const pending = new Map<string, () => string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastWriteAt = 0;

  const flush = (name: string): void => {
    const t = timers.get(name);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(name);
    }
    const make = pending.get(name);
    if (make === undefined) return;
    pending.delete(name);
    lastWriteAt = Date.now();
    void storage.setItem(name, make());
  };

  if (typeof window !== "undefined") {
    const flushAll = (): void => {
      for (const name of [...pending.keys()]) flush(name);
    };
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  return {
    set(name: string, make: () => string): void {
      pending.set(name, make);
      if (Date.now() - lastWriteAt >= COALESCED_WRITE_MS) {
        flush(name);
      } else if (!timers.has(name)) {
        timers.set(
          name,
          setTimeout(() => flush(name), COALESCED_WRITE_MS)
        );
      }
    },
    remove(name: string): void {
      // A removal must not be resurrected by a pending write.
      pending.delete(name);
      const t = timers.get(name);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(name);
      }
    },
  };
})();

/**
 * The coalescing storage for zustand's persist that also serializes lazily.
 * zustand's createJSONStorage stringifies the WHOLE store on every change —
 * the player's position ticks ~4×/s, and a long queue makes that a large
 * string each time — before the coalescer ever sees it. This keeps the latest
 * state object instead (zustand state is immutable, so holding it is safe)
 * and stringifies once per actual write: at most every 2 s, and on pagehide.
 */
export function lazyJSONStorage<S>(): PersistStorage<S> {
  return {
    getItem: async (name) => {
      const raw = await storage.getItem(name);
      return raw == null ? null : (JSON.parse(raw) as StorageValue<S>);
    },
    setItem: (name, value) => {
      coalescer.set(name, () => JSON.stringify(value));
    },
    removeItem: (name) => {
      coalescer.remove(name);
      return storage.removeItem(name);
    },
  };
}
