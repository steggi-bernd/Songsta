/**
 * Keys set by hand (Klingt wie's wheel, "Correct the key"): where the analysis heard a song in the wrong
 * key, the key you chose counts everywhere the key does (Klingt wie, mixes that flow, smart playlists'
 * key rules). Kept on this computer, by the ids of the song's copies, and shared with your other devices
 * through the sync service (lib/soundShare.ts, the "keys" document): the later setting wins. A key given
 * back to the measurement keeps its moment (`gone`), so the old one doesn't come back from elsewhere.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SoundFacts } from "../../electron/sound-analysis";
import type { KeyChanges } from "../lib/soundShare";
import { storage } from "../lib/persist";

export interface KeyEdit {
  /** pitch class, 0 = C */
  key: number;
  minor: boolean;
  /** when it was set */
  at: number;
}

interface KeyEditsState {
  keys: Record<string, KeyEdit>;
  /** copies whose key was given back to the measurement, and when */
  gone: Record<string, number>;
  /** sets these copies' key, or (null) gives them back to the measurement */
  setKey(ids: string[], key: { key: number; minor: boolean } | null): void;
  /** what another device set or gave back later (lib/libraryDocs.ts) */
  applyRemote(changes: KeyChanges): void;
}

export const useKeyEdits = create<KeyEditsState>()(
  persist(
    (set, get) => ({
      keys: {},
      gone: {},
      setKey(ids, key) {
        const keys = { ...get().keys };
        const gone = { ...get().gone };
        const at = Date.now();
        for (const id of ids) {
          if (key && key.key >= 0 && key.key <= 11) {
            keys[id] = { key: Math.round(key.key), minor: !!key.minor, at };
            delete gone[id];
          } else if (!key) {
            if (keys[id]) gone[id] = at;
            delete keys[id];
          }
        }
        set({ keys, gone });
      },
      applyRemote(changes) {
        if (!changes.set.length && !changes.back.length) return;
        const keys = { ...get().keys };
        const gone = { ...get().gone };
        for (const c of changes.set) {
          if (c.key < 0 || c.key > 11) continue;
          keys[c.id] = { key: c.key, minor: c.minor, at: c.at };
          delete gone[c.id];
        }
        for (const c of changes.back) {
          delete keys[c.id];
          gone[c.id] = c.at;
        }
        set({ keys, gone });
      },
    }),
    { name: "key-edits", storage: createJSONStorage(() => storage), version: 1, partialize: (s) => ({ keys: s.keys, gone: s.gone }) as KeyEditsState }
  )
);

/**
 * The measured facts with the keys set by hand put in; each such song carries what was measured
 * (`measuredKey`), so the page can say so and give the key back. The same object when nothing changes.
 */
export function withKeyEdits(facts: Record<string, SoundFacts>, keys: Record<string, KeyEdit>): Record<string, SoundFacts> {
  let out: Record<string, SoundFacts> | null = null;
  for (const [id, edit] of Object.entries(keys)) {
    const f = facts[id];
    if (!f || (f.key === edit.key && f.minor === edit.minor)) continue;
    out ??= { ...facts };
    out[id] = { ...f, key: edit.key, minor: edit.minor, measuredKey: { key: f.key, minor: f.minor } };
  }
  return out ?? facts;
}
