/**
 * When each album, artist, playlist, mix and Liked Songs last played as a whole: Home's "played last"
 * tiles and Your Library's "Recently played" order. What counts is what was started, an album's page
 * or an artist's or a playlist's, not where a song comes from: a song from a playlist makes the
 * playlist recent, not its album or its artist. Only while the list started plays: what's added to the
 * queue after it, or comes by itself once it's through, isn't it. Only real plays count: nothing is
 * guessed from past plays any more (the user's wish, 2026-11-22; they know songs, not what they were
 * played from, and the guesses named the albums of single songs heard from Liked Songs).
 */
import { create } from "zustand";
import { readJson, writeJson } from "../storage";
import { usePlayer } from "./player";
import { usePlaylists } from "./playlists";
import { useSettings } from "./settings";

const FILE = "played.json";

interface Saved {
  /** "album:…", "artist:…" (lower case), "playlist:…", "mix:…", "liked" → when it last played */
  at: Record<string, number>;
  /**
   * From when the played times count (set once, 2026-11-22): Home's tiles and Your Library's Recently
   * played take only what was really played from since then. The times kept from before (guessed ones
   * among them) don't show.
   */
  homeSince?: number;
}

/** What was played from since `since`, the latest first: Home's "played last" tiles. */
export function playedSince(at: Record<string, number>, since: number): string[] {
  return Object.keys(at)
    .filter((key) => at[key] >= since)
    .sort((a, b) => at[b] - at[a]);
}

interface PlayedState extends Saved {
  restored: boolean;
  touch(key: string): void;
  /** your plays deleted (Settings → Network & privacy): when anything played is forgotten too */
  forget(): void;
  /** When things played on the other devices (lib/librarySync.ts): the later time of each stays. */
  adopt(times: Record<string, number>): void;
}

function save(): void {
  const { at, homeSince } = usePlayed.getState();
  writeJson(FILE, { at, ...(homeSince ? { homeSince } : {}) } satisfies Saved);
}

export const usePlayed = create<PlayedState>((set, get) => ({
  at: {},
  restored: false,
  touch(key) {
    set({ at: { ...get().at, [key]: Date.now() } });
    save();
  },
  forget() {
    set({ at: {} });
    save();
  },
  adopt(times) {
    const now = get().at;
    let next = now;
    for (const [key, at] of Object.entries(times)) {
      if ((next[key] ?? -1) >= at) continue;
      if (next === now) next = { ...now };
      next[key] = at;
    }
    if (next === now) return;
    set({ at: next });
    save();
  },
}));

export function watchPlayed(): void {
  void Promise.all([readJson<Saved>(FILE), usePlaylists.getState().restore()]).then(([saved]) => {
    const homeSince = typeof saved?.homeSince === "number" ? saved.homeSince : Date.now();
    usePlayed.setState({ at: { ...(saved?.at ?? {}), ...usePlayed.getState().at }, homeSince, restored: true });
    if (saved?.homeSince !== homeSince) save();
  });
  // The list as it was started.
  let list: { source: string; ids: Set<string> } | null = null;
  usePlayer.subscribe((s, prev) => {
    if (s.source !== (list?.source ?? null)) list = s.source ? { source: s.source, ids: new Set(s.queue.map((t) => t.id)) } : null;
    // Another device's music, shown here, is that device's to count.
    if (!list || s.remote) return;
    const started = s.playWhenReady && (!prev.playWhenReady || s.index !== prev.index || s.queue !== prev.queue);
    const song = s.queue[s.index];
    // Only while plays are kept here (Settings → Network & privacy).
    if (started && song && list.ids.has(song.id) && useSettings.getState().recordListening) usePlayed.getState().touch(list.source);
  });
}
