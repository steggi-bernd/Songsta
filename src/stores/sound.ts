/**
 * The sound analysis' results (electron/sound-library.ts) on this side:
 * loaded at start, and again — a few seconds after the main process says
 * more songs are measured. The mood mixes, the song details, Automix and the
 * seamless transitions (lib/continuity.ts) read them.
 */
import { create } from "zustand";
import type { SoundFacts } from "../../electron/sound-analysis";
import type { Track } from "../types";
import { versionsOf } from "./catalog";
import { useKeyEdits, withKeyEdits } from "./keyEdits";

interface SoundState {
  /** what the analysis measured, by song copy */
  measured: Record<string, SoundFacts>;
  /** the same with the keys set by hand put in (stores/keyEdits.ts): what everything reads */
  facts: Record<string, SoundFacts>;
  /** songs that can't be measured (a file that can't be read, a server stretch that's empty): looked at all the same */
  skipped: ReadonlySet<string>;
  /** why each of them can't be */
  skipReasons: Readonly<Record<string, SkipReason>>;
  load(): Promise<void>;
  /** a song measured here just now (a server song's stretch) */
  noteMeasured(id: string, facts: SoundFacts): void;
}

export type SkipReason = "unreadable" | "refused" | "short";

export const useSound = create<SoundState>((set, get) => ({
  measured: {},
  facts: {},
  skipped: new Set(),
  skipReasons: {},
  async load() {
    const [facts, skipped] = await Promise.all([window.bytune?.soundFacts().catch(() => null), window.bytune?.soundSkipped().catch(() => null)]);
    if (facts && typeof facts === "object") set({ measured: facts, facts: withKeyEdits(facts, useKeyEdits.getState().keys) });
    if (Array.isArray(skipped)) set({ skipped: new Set(skipped.map((s) => s.id)), skipReasons: Object.fromEntries(skipped.map((s) => [s.id, s.reason])) });
  },
  noteMeasured(id, facts) {
    const measured = { ...get().measured, [id]: facts };
    set({ measured, facts: withKeyEdits(measured, useKeyEdits.getState().keys) });
  },
}));

/** Loads now and follows the main process' word of new results, and the keys set by hand; the returned function stops. */
export function watchSound(): () => void {
  void useSound.getState().load();
  let timer: number | null = null;
  const off = window.bytune?.onSoundUpdated(() => {
    timer ??= window.setTimeout(() => {
      timer = null;
      void useSound.getState().load();
    }, 3000);
  });
  const rekey = (): void => {
    const { measured } = useSound.getState();
    useSound.setState({ facts: withKeyEdits(measured, useKeyEdits.getState().keys) });
  };
  const offKeys = useKeyEdits.subscribe((s, prev) => {
    if (s.keys !== prev.keys) rekey();
  });
  const offHydrated = useKeyEdits.persist.onFinishHydration(rekey);
  return () => {
    off?.();
    offKeys();
    offHydrated();
    if (timer !== null) window.clearTimeout(timer);
  };
}

/** A song's energy for the mood mixes — none for one that wasn't measured or measured silent (an empty file). */
export function energyOf(track: Track, facts: Record<string, SoundFacts> = useSound.getState().facts): number | undefined {
  const f = soundOf(track, facts);
  return f && f.loudness > -70 ? f.energy : undefined;
}

/** A song's facts, from whichever of its copies was measured (the local file of a merged song). */
export function soundOf(track: Track | null | undefined, facts: Record<string, SoundFacts> = useSound.getState().facts): SoundFacts | undefined {
  if (!track) return undefined;
  return facts[track.id] ?? versionsOf(track).map((v) => facts[v.id]).find(Boolean);
}

export interface SoundCount {
  /** measured, or looked at and can't be (`skipped`): what the analysis is through with */
  done: number;
  /** of those, the ones that can't be measured */
  skipped: number;
  total: number;
}

/** How many of the library's songs the analysis is through with, the local files and the server's songs apart (Settings). */
export function soundCounts(tracks: Track[], facts: Record<string, SoundFacts>, skipped: ReadonlySet<string> = new Set()): { local: SoundCount; server: SoundCount } {
  const local = { done: 0, skipped: 0, total: 0 };
  const server = { done: 0, skipped: 0, total: 0 };
  for (const t of tracks) {
    const side = t.id.startsWith("local:") ? local : t.id.startsWith("jf:") || t.id.startsWith("ss:") ? server : null;
    if (!side) continue;
    side.total += 1;
    if (soundOf(t, facts)) side.done += 1;
    else if (skipped.has(t.id)) {
      side.done += 1;
      side.skipped += 1;
    }
  }
  return { local, server };
}
