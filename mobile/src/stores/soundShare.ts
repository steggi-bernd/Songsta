/**
 * Tempo, key and energy as your computer measured them, and the keys set there by hand, as they came
 * through the sync service (src/lib/soundShare.ts, the "sounds" and "keys" documents; libraryDocs.ts
 * takes them in). The phone measures nothing itself: its mixes read these (stores/library.ts), the
 * Calm and Upbeat ones and the order that flows. Kept in a file of the app's own, for the account
 * signed in: signing out lets it go.
 */
import { create } from "zustand";
import { fromWireSound, soundKeysOf, type KeysDoc, type SoundFacts, type SoundsDoc, type Track } from "../shared";
import { readJson, removeJson, writeJson } from "../storage";

const FILE = "sound-share.json";

interface SoundShareState {
  sounds: SoundsDoc;
  keys: KeysDoc;
  restored: boolean;
  restore(): Promise<void>;
  keepSounds(doc: SoundsDoc): void;
  keepKeys(doc: KeysDoc): void;
  /** signed out: none of it stays */
  clear(): void;
}

const save = (): void => {
  const { sounds, keys } = useSoundShare.getState();
  writeJson(FILE, { sounds, keys });
};

export const useSoundShare = create<SoundShareState>((set, get) => ({
  sounds: {},
  keys: {},
  restored: false,
  async restore() {
    if (get().restored) return;
    const saved = await readJson<{ sounds?: SoundsDoc; keys?: KeysDoc }>(FILE);
    // Something taken in before the file was read stays.
    set((s) => ({
      sounds: s.sounds.songs ? s.sounds : (saved?.sounds ?? {}),
      keys: s.keys.keys ? s.keys : (saved?.keys ?? {}),
      restored: true,
    }));
  },
  keepSounds(doc) {
    set({ sounds: doc });
    save();
  },
  keepKeys(doc) {
    set({ keys: doc });
    save();
  },
  clear() {
    set({ sounds: {}, keys: {} });
    removeJson(FILE);
  },
}));

/** The measurements by song key, worked out once per document (a song's facts are asked for often). */
let made: { sounds: SoundsDoc; keys: KeysDoc; facts: Map<string, SoundFacts> } | null = null;
function factsByKey(): Map<string, SoundFacts> {
  const { sounds, keys } = useSoundShare.getState();
  if (made && made.sounds === sounds && made.keys === keys) return made.facts;
  const facts = new Map<string, SoundFacts>();
  for (const [key, w] of Object.entries(sounds.songs ?? {})) {
    const f = fromWireSound(w);
    const set = keys.keys?.[key]?.v;
    facts.set(key, set ? { ...f, key: set.k, minor: set.m === 1, measuredKey: { key: f.key, minor: f.minor } } : f);
  }
  made = { sounds, keys, facts };
  return facts;
}

/**
 * What the computer measured of this song (a key set by hand put in), if anything: under the server song's
 * id, or else under its artist, title and length, where the computer measured it as a file of its own.
 */
export function sharedSoundOf(t: Track): SoundFacts | undefined {
  const facts = factsByKey();
  for (const key of soundKeysOf(t)) {
    const found = facts.get(key);
    if (found) return found;
  }
  return undefined;
}

/** A song's energy for the Calm and Upbeat mixes; none for one not measured, or measured silent. */
export function sharedEnergyOf(t: Track): number | undefined {
  const f = sharedSoundOf(t);
  return f && f.loudness > -70 ? f.energy : undefined;
}

void useSoundShare.getState().restore();
