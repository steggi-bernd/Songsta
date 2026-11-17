/**
 * Songs skipped early: left within the first half minute (and before their half) for another one,
 * by Next or by picking something else. Counted per song, so mixes play them less (lib/flowOrder.ts
 * puts them later, Klingt wie further down). A skip fades: after 90 days it counts half. Kept on this
 * computer; a song played through again doesn't undo it, but time does.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { isEarlySkip, skipWeight } from "../lib/skipRules";
import { songKey } from "./catalog";
import { usePlayer } from "./player";
import { useSettings } from "./settings";

/** Songs remembered at most; the least skipped and oldest go first. */
const KEPT = 3000;

interface SkipsState {
  /** song key → how often, and the last time */
  skips: Record<string, { n: number; at: number }>;
  skip(id: string, at: number): void;
  /** every skip forgotten (Settings → Network & privacy) */
  forget(): void;
}

export const useSkips = create<SkipsState>()(
  persist(
    (set, get) => ({
      skips: {},
      skip(id, at) {
        const key = songKey(id);
        const was = get().skips[key];
        const next = { ...get().skips, [key]: { n: (was ? skipWeight(was, at) : 0) + 1, at } };
        const keys = Object.keys(next);
        if (keys.length > KEPT) {
          for (const k of keys.sort((a, b) => skipWeight(next[a], at) - skipWeight(next[b], at)).slice(0, keys.length - KEPT)) delete next[k];
        }
        set({ skips: next });
      },
      forget: () => set({ skips: {} }),
    }),
    { name: "skips", storage: createJSONStorage(() => storage), version: 1, partialize: (s) => ({ skips: s.skips }) as SkipsState }
  )
);

/** How much a song was skipped lately (0 for never). */
export const skipsOf = (id: string, now = Date.now()): number => skipWeight(useSkips.getState().skips[songKey(id)], now);

/**
 * Mount once (App): notes a skip whenever the song changes early. Early by how far into the song it
 * was, not by how long it was on: a song restored at the start, or one paused a while, was never
 * skipped by being left. Only a song that played here counts.
 */
export function watchSkips(): () => void {
  let current: { id: string; played: boolean } | null = null;
  return usePlayer.subscribe((s, prev) => {
    const now = s.queue[s.index];
    const before = prev.queue[prev.index];
    if (now?.id === before?.id) {
      if (current && s.playing) current.played = true;
      return;
    }
    // Left for another song (a queue emptied isn't a skip). Not kept while that's switched off (Settings → Network & privacy).
    if (now && current?.played && before && current.id === before.id && useSettings.getState().recordSkips && isEarlySkip(prev.position * 1000, before.duration)) useSkips.getState().skip(before.id, Date.now());
    current = now ? { id: now.id, played: s.playing } : null;
  });
}
