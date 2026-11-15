/**
 * When a song joined a list: Liked Songs, or a playlist. Two sources:
 *
 *  - What this computer saw: from the day this exists, a song that turns up in a list gets that
 *    moment written down. Songs already there the first time a list is looked at have no date.
 *  - A Spotify export: a list brought over from Spotify keeps the dates of its export, the day
 *    each song was liked or added there (lib/spotifyImport.ts). They're worked out from the export
 *    itself, so a song that reaches the library later shows its Spotify date at once.
 *
 * Spotify's date wins where both exist: it's when the song was really added. What this computer
 * saw is kept by the song's id; when a list swaps a song for another copy of it (the file for the
 * server's, say), the copy takes the date over.
 */
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useSpotifyImport } from "../stores/spotifyImport";
import type { Track } from "../types";
import { storage } from "./persist";
import { rowsOf } from "./playlistRecovery";
import type { SpotifyEntry } from "./spotifyImport";

/** "liked", or a playlist's id */
export type ListKey = string;

interface ListDatesState {
  /** list → song id → when it joined (ms); 0 = it was there before dates were kept */
  dates: Record<ListKey, Record<string, number>>;
  /** What the lists hold now: new songs get this moment, songs gone lose theirs, lists gone are forgotten. */
  see(lists: Record<ListKey, string[]>, now: number): void;
}

/**
 * The dates for what the lists hold now (song ids); the same object when nothing changed. A song
 * that comes in as another copy of one that just left (`keyOf` says which songs are the same)
 * keeps that one's date.
 */
export function datesAfter(
  dates: Record<ListKey, Record<string, number>>,
  lists: Record<ListKey, string[]>,
  now: number,
  keyOf: (id: string) => string = (id) => id
): Record<ListKey, Record<string, number>> {
  let changed = Object.keys(dates).some((list) => !(list in lists));
  const out: Record<ListKey, Record<string, number>> = {};
  for (const [list, ids] of Object.entries(lists)) {
    const before = dates[list];
    const here = new Set(ids);
    const left = new Map<string, number>();
    for (const [id, at] of Object.entries(before ?? {})) if (!here.has(id)) left.set(keyOf(id), at);
    // A list seen for the first time: its songs were there already, nobody knows since when.
    const stamp = before ? now : 0;
    const next: Record<string, number> = {};
    for (const id of ids) next[id] = before?.[id] ?? left.get(keyOf(id)) ?? stamp;
    const same = !!before && Object.keys(before).length === Object.keys(next).length && Object.keys(next).every((id) => before[id] !== undefined);
    out[list] = same ? before : next;
    if (!same) changed = true;
  }
  return changed ? out : dates;
}

export const useListDatesStore = create<ListDatesState>()(
  persist(
    (set, get) => ({
      dates: {},
      see(lists, now) {
        const next = datesAfter(get().dates, lists, now, songKey);
        if (next !== get().dates) set({ dates: next });
      },
    }),
    { name: "list-dates", storage: createJSONStorage(() => storage), version: 1 }
  )
);

/** Mount once (App): keeps the dates in step with Liked Songs and the playlists. */
export function watchListDates(): () => void {
  const look = (): void => {
    if (!useLibrary.persist.hasHydrated() || !useListDatesStore.persist.hasHydrated()) return;
    const { liked, playlists } = useLibrary.getState();
    const lists: Record<ListKey, string[]> = { liked: liked.map((t) => t.id) };
    for (const p of playlists) lists[p.id] = p.tracks.map((t) => t.id);
    useListDatesStore.getState().see(lists, Date.now());
  };
  const offLibrary = useLibrary.subscribe((s, prev) => {
    if (s.liked !== prev.liked || s.playlists !== prev.playlists) look();
  });
  const offHydrated = [useLibrary.persist.onFinishHydration(look), useListDatesStore.persist.onFinishHydration(look)];
  look();
  return () => {
    offLibrary();
    for (const off of offHydrated) off();
  };
}

const NO_ENTRIES: SpotifyEntry[] = [];
const NO_DATES: ReadonlyMap<string, number> = new Map();

/** The dates of a Spotify export, by the library songs its entries lead to. */
function exportDates(entries: SpotifyEntry[], tracks: Track[], verdicts: Record<string, "same" | "different">, picks: Record<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  if (!entries.some((e) => e.addedAt)) return out;
  for (const row of rowsOf(entries, tracks, { verdicts, picks })) {
    if (!row.track || !row.entry.addedAt || row.kind === "missing") continue;
    const key = songKey(row.track.id);
    // Two entries leading to one song (a remaster and the original): the earlier day is when it was first added.
    const known = out.get(key);
    if (!known || row.entry.addedAt < known) out.set(key, row.entry.addedAt);
  }
  return out;
}

/** When each song joined this list, by songKey; songs without a known date are left out. */
export function useListDates(list: ListKey): ReadonlyMap<string, number> {
  const own = useListDatesStore((s) => s.dates[list]);
  const entries = useSpotifyImport((s) => (list === "liked" ? (s.likedIds.length ? s.entries : NO_ENTRIES) : (s.recovered[list]?.entries ?? NO_ENTRIES)));
  const verdicts = useSpotifyImport((s) => s.verdicts);
  const picks = useSpotifyImport((s) => s.picks);
  const tracks = useCatalog((s) => s.tracks);
  const fromExport = useMemo(() => (entries.length ? exportDates(entries, tracks, verdicts, picks) : NO_DATES), [entries, tracks, verdicts, picks]);
  return useMemo(() => {
    if (!own && !fromExport.size) return NO_DATES;
    const out = new Map<string, number>();
    for (const [id, at] of Object.entries(own ?? {})) if (at > 0) out.set(songKey(id), at);
    for (const [song, at] of fromExport) out.set(song, at);
    return out;
    // `tracks`: the catalogue decides which copies are one song.
  }, [own, fromExport, tracks]);
}
