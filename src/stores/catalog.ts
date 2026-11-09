/**
 * The library catalogue as one renderer-side index: local files, Jellyfin and
 * Navidrome songs plus all-time play counts. The album/artist pages, the home
 * page, mixes and smart playlists all read from here. Scans, enrichment
 * batches, folder-watch rescans and server refreshes announce themselves with
 * window events; the catalogue reloads (debounced) on each.
 *
 * A song found in more than one place (a local file that is also on the
 * Jellyfin server, a FLAC next to an MP3 copy) is listed once — see
 * lib/duplicates.ts. Its versions stay in `versions`, in the order playback
 * tries them, and its play counts are summed across all of them.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { PlayCounts } from "../lib/catalogBuild";
import type { JellyfinStatus } from "../../electron/jellyfin";
import type { SubsonicStatus } from "../../electron/subsonic";
import { applyAlbumLooks, applyAlbumMerges, applyArtistAliases, applySongEdits } from "../lib/albumEdits";
import { mergeDuplicates } from "../lib/duplicates";
import { loadAllLibraryTracks } from "../lib/libraryTracks";
import { relistOnce } from "../lib/serverRelist";
import { useAlbumEdits } from "./albumEdits";
import { useSettings } from "./settings";
import type { Track } from "../types";

export type { PlayCounts };

interface CatalogState {
  /** one entry per song (duplicates merged), album merges applied */
  tracks: Track[];
  /** the same songs before album merges — what a merge change re-applies to */
  base: Track[];
  /** every version id of a merged song → its versions, in playback order */
  versions: Map<string, Track[]>;
  /** every copy by its own id — fresher than queue entries saved by an older version */
  byId: Map<string, Track>;
  playCounts: PlayCounts;
  loaded: boolean;
  /** bumped on every reload and play-count refresh */
  version: number;
  load(): Promise<void>;
  refreshPlayCounts(): Promise<void>;
}

/** A merged song's plays are the sum over its versions, readable under any of their ids. */
function mergeCounts(counts: PlayCounts, versions: Map<string, Track[]>): PlayCounts {
  if (!versions.size) return counts;
  const out: PlayCounts = { ...counts };
  const seen = new Set<Track[]>();
  for (const group of versions.values()) {
    if (seen.has(group)) continue;
    seen.add(group);
    let plays = 0;
    let lastAt = 0;
    for (const v of group) {
      const c = counts[v.id];
      if (!c) continue;
      plays += c.plays;
      lastAt = Math.max(lastAt, c.lastAt);
    }
    if (plays) for (const v of group) out[v.id] = { plays, lastAt };
  }
  return out;
}

/**
 * The songs as shown: the songs put on an album by hand first, then the
 * user's artist spellings, then their album merges, then the names and
 * pictures they gave albums (stores/albumEdits.ts).
 */
function shownTracks(base: Track[], versions: Map<string, Track[]>): Track[] {
  const { aliases, mergedInto, songs, titles, covers } = useAlbumEdits.getState();
  const merged = applyAlbumMerges(applyArtistAliases(applySongEdits(base, songs ?? {}, versions), aliases ?? {}), mergedInto);
  return applyAlbumLooks(merged, titles ?? {}, covers ?? {});
}

let inflight: Promise<void> | null = null;
let again = false;

export const useCatalog = create<CatalogState>((set, get) => ({
  tracks: [],
  base: [],
  versions: new Map(),
  byId: new Map(),
  playCounts: {},
  loaded: false,
  version: 0,
  load() {
    // A reload asked for mid-load runs once more afterwards — never a stale index.
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = (async () => {
      do {
        again = false;
        const [all, playCounts] = await Promise.all([
          loadAllLibraryTracks(),
          (window.bytune?.statsPlayCounts().catch(() => ({})) ?? Promise.resolve({})) as Promise<PlayCounts>,
        ]);
        const { tracks, versions } = mergeDuplicates(all);
        set((s) => ({
          tracks: shownTracks(tracks, versions),
          base: tracks,
          versions,
          byId: new Map(all.map((t) => [t.id, t])),
          playCounts: mergeCounts(playCounts ?? {}, versions),
          loaded: true,
          version: s.version + 1,
        }));
      } while (again);
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  },
  async refreshPlayCounts() {
    const playCounts = (await window.bytune?.statsPlayCounts().catch(() => null)) as PlayCounts | null;
    if (playCounts) {
      set((s) => ({ playCounts: mergeCounts(playCounts, s.versions), version: get().loaded ? s.version + 1 : s.version }));
    }
  },
}));

// An album merge, an artist spelling, songs put on an album, a name or a picture (or their undo) show at once — no reload from disk.
useAlbumEdits.subscribe((s, prev) => {
  if (s.mergedInto === prev.mergedInto && s.aliases === prev.aliases && s.songs === prev.songs && s.titles === prev.titles && s.covers === prev.covers) return;
  const c = useCatalog.getState();
  if (c.loaded) useCatalog.setState({ tracks: shownTracks(c.base, c.versions), version: c.version + 1 });
});

/**
 * A song's versions in playback order — just the track itself when it exists
 * only once (the catalogue's copy of it, when listed: a queue entry saved by
 * an older version lacks the newer fields).
 */
export function versionsOf(track: Track): Track[] {
  const s = useCatalog.getState();
  return s.versions.get(track.id) ?? [s.byId.get(track.id) ?? track];
}

/** One key per song: every copy of a merged song answers with the same key. */
export function songKey(id: string): string {
  return useCatalog.getState().versions.get(id)?.[0]?.id ?? id;
}

/** Two ids name the same song: identical, or versions of one merged song. */
export function sameSong(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return useCatalog.getState().versions.get(a)?.some((v) => v.id === b) ?? false;
}

/** Library sources announce changes with these window events. */
export const CATALOG_EVENTS = ["bytune:local-library-updated", "bytune:remote-library-updated"] as const;

/** After a listing failed (the server can't be reached yet), the waits before the next tries. */
const RELIST_WAITS_MS = [30_000, 120_000, 600_000];

/** The main process answers null when a server couldn't be listed: a failed try, to be repeated. */
function listed(changed: boolean | null): boolean {
  if (changed === null) throw new Error("The server couldn't be listed");
  return changed;
}

/**
 * In the background after each start: the servers' songs are listed again
 * (lib/serverRelist.ts), so what was added on a server and the covers it found
 * since show up by themselves, while the cached lists keep working. A local
 * library read by an older version lacks fields this one uses (release types,
 * track totals): a rescan of the folders brings it up to date once. Answers a
 * stop for relist tries still to come.
 */
async function freshenSources(): Promise<() => void> {
  const bridge = window.bytune;
  if (!bridge) return () => undefined;
  const stops: Array<() => void> = [];
  try {
    const [jf, ss] = (await Promise.all([bridge.jellyfinStatus(), bridge.subsonicStatus()])) as [
      JellyfinStatus | null,
      SubsonicStatus | null,
    ];
    if (jf?.connected) stops.push(relistOnce(() => bridge.jellyfinRelist().then(listed), announceRemoteLibraryChange, RELIST_WAITS_MS));
    if (ss?.connected) stops.push(relistOnce(() => bridge.subsonicRelist().then(listed), announceRemoteLibraryChange, RELIST_WAITS_MS));
  } catch {
    /* no word on the servers: their cached libraries stay as they are */
  }
  void (async () => {
    try {
      if (await bridge.libraryNeedsRescan()) {
        const lib = await bridge.scanLibrary(useSettings.getState().filterNonMusicAudio);
        window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: lib }));
      }
    } catch {
      /* the next scan fills the fields in */
    }
  })();
  return () => stops.forEach((stop) => stop());
}

/**
 * A rebuild (merge, albums, every list on screen) at most this often: the
 * background cover fills announce a change per batch, and rebuilding on each
 * one kept the app busy while they ran.
 */
const MIN_RELOAD_GAP_MS = 4000;

/** Mount once (App): first load, then a reload on library changes — soon after a lone change, throttled in bursts. */
export function watchCatalog(): () => void {
  let timer: number | null = null;
  let lastLoad = 0;
  const reload = (): void => {
    if (timer !== null) return; // one is already on its way and will pick this change up
    timer = window.setTimeout(() => {
      timer = null;
      lastLoad = Date.now();
      void useCatalog.getState().load();
    }, Math.max(400, lastLoad + MIN_RELOAD_GAP_MS - Date.now()));
  };
  void useCatalog.getState().load();
  for (const e of CATALOG_EVENTS) window.addEventListener(e, reload);
  let stopFreshening: (() => void) | null = null;
  let unmounted = false;
  const freshen = window.setTimeout(() => {
    void freshenSources().then((stop) => {
      if (unmounted) stop();
      else stopFreshening = stop;
    });
  }, 3000);
  return () => {
    unmounted = true;
    for (const e of CATALOG_EVENTS) window.removeEventListener(e, reload);
    if (timer !== null) window.clearTimeout(timer);
    window.clearTimeout(freshen);
    stopFreshening?.();
  };
}

/** Pages that rank by plays refresh the counts when they open. */
export function useFreshPlayCounts(): void {
  useEffect(() => {
    void useCatalog.getState().refreshPlayCounts();
  }, []);
}

/** Tell the catalogue (and the Local Music view) that a server library changed. */
export function announceRemoteLibraryChange(): void {
  window.dispatchEvent(new CustomEvent("bytune:remote-library-updated"));
}
