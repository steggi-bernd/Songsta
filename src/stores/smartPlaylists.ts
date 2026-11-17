/**
 * Smart playlists (Symfonium/Aideo style): playlists defined by rules instead
 * of a fixed track list — "FLAC above 48 kHz", "added in the last 30 days",
 * "rock from the 90s I haven't played". Only the definitions are stored; the
 * songs are worked out live from the catalogue (lib/smartPlaylists.ts).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";

export type RuleField =
  | "genre"
  | "artist"
  | "album"
  | "title"
  | "year"
  | "added"
  | "plays"
  | "lastPlayed"
  | "duration"
  | "format"
  | "sampleRate"
  | "bitDepth"
  | "source"
  | "liked"
  // How it sounds (lib/soundMatch.ts, electron/sound-analysis.ts) and its genre family (lib/genres.ts).
  | "bpm"
  | "energy"
  | "camelot"
  | "family";

export type RuleOp = "contains" | "notContains" | "is" | "isNot" | "gt" | "lt" | "between" | "inLast" | "notInLast" | "near";

export interface SmartRule {
  field: RuleField;
  op: RuleOp;
  value: string;
  /** upper bound for "between" */
  value2?: string;
}

export type SmartSort = "random" | "added" | "plays" | "lastPlayed" | "title" | "artist" | "year" | "flow";

export interface SmartPlaylist {
  id: string;
  name: string;
  match: "all" | "any";
  rules: SmartRule[];
  sort: SmartSort;
  /** cap on the number of songs, null = no cap */
  limit: number | null;
  createdAt: number;
}

interface SmartState {
  playlists: SmartPlaylist[];
  save(p: SmartPlaylist): void;
  remove(id: string): void;
}

export const useSmartPlaylists = create<SmartState>()(
  persist(
    (set) => ({
      playlists: [],
      save: (p) =>
        set((s) => ({
          playlists: s.playlists.some((x) => x.id === p.id)
            ? s.playlists.map((x) => (x.id === p.id ? p : x))
            : [...s.playlists, p],
        })),
      remove: (id) => set((s) => ({ playlists: s.playlists.filter((x) => x.id !== id) })),
    }),
    { name: "smart-playlists", storage: createJSONStorage(() => storage) }
  )
);

export function newSmartPlaylist(): SmartPlaylist {
  return {
    id: `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    match: "all",
    rules: [{ field: "genre", op: "contains", value: "" }],
    sort: "random",
    limit: 100,
    createdAt: Date.now(),
  };
}
