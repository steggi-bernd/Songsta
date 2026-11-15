/**
 * Playlists recovered from Spotify finish themselves: each remembers the songs
 * of its export, and whenever the library grows or a song to check gets its
 * answer, those found since go into it in their place (lib/spotifyImport.ts
 * completePlaylist). Nothing needs opening or adding again.
 */
import { useMemo } from "react";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useSpotifyImport } from "../stores/spotifyImport";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { T } from "./i18n";
import { applyDecisions, completePlaylist, importOrder, matchEntries, type ImportDecisions, type ImportRow, type SpotifyEntry } from "./spotifyImport";

/** A hand-picked id may be a copy the catalogue merged into another song: that song, then. */
function songById(id: string): Track | undefined {
  const { tracks, versions, byId } = useCatalog.getState();
  const primary = versions.get(id)?.[0]?.id ?? id;
  return tracks.find((t) => t.id === primary) ?? byId.get(id);
}

export function rowsOf(entries: SpotifyEntry[], tracks: Track[], decisions: ImportDecisions): ImportRow[] {
  return applyDecisions(matchEntries(entries, tracks), decisions, songById);
}

function completeAll(): void {
  const imp = useSpotifyImport.getState();
  const catalog = useCatalog.getState();
  if (!catalog.loaded || !useSpotifyImport.persist.hasHydrated() || !useLibrary.persist.hasHydrated()) return;
  const lib = useLibrary.getState();
  // Recovered before playlists remembered their export: the one still open has it.
  const open = imp.playlist;
  if (open?.playlistId && !imp.recovered[open.playlistId] && open.entries.length) {
    imp.rememberRecovered(open.playlistId, { name: open.name, fileName: open.fileName, entries: open.entries, added: [] });
  }
  for (const [id, recovered] of Object.entries(useSpotifyImport.getState().recovered)) {
    const playlist = lib.playlists.find((p) => p.id === id);
    if (!playlist) {
      useSpotifyImport.getState().forgetRecovered(id);
      continue;
    }
    const rows = rowsOf(recovered.entries, catalog.tracks, { verdicts: imp.verdicts, picks: imp.picks });
    const { tracks, done, added } = completePlaylist(playlist.tracks, rows, new Set(recovered.added), songKey);
    if (done.length) useSpotifyImport.getState().noteRecoveredAdded(id, done);
    if (!added) continue;
    lib.setPlaylistTracks(id, tracks);
    useUI.getState().toast(T("Added {added} {value} to “{name}”, in Spotify's order", { added, value: added === 1 ? T("song") : T("songs"), name: playlist.name }), "success");
  }
  completeLiked();
}

/**
 * Liked Songs brought over from Spotify finish themselves the same way: once the export's songs
 * were added to Liked Songs, every song of it found later (bought since, or answered "same song")
 * joins them in its Spotify place. A song laid out before and taken out by hand stays out.
 */
function completeLiked(): void {
  const imp = useSpotifyImport.getState();
  const catalog = useCatalog.getState();
  if (!imp.entries.length || !imp.likedIds.length) return;
  const lib = useLibrary.getState();
  const rows = rowsOf(imp.entries, catalog.tracks, { verdicts: imp.verdicts, picks: imp.picks });
  const likedSongs = new Set(lib.liked.map((t) => songKey(t.id)));
  const broughtBefore = new Set(imp.likedIds.map(songKey));
  const order = importOrder(rows, likedSongs, songKey).filter((t) => likedSongs.has(songKey(t.id)) || !broughtBefore.has(songKey(t.id)));
  if (!order.some((t) => !likedSongs.has(songKey(t.id)))) return;
  const added = lib.importLikes(order, imp.likedIds);
  imp.noteLiked(order.map((t) => t.id));
  if (added > 0) useUI.getState().toast(T("Added {added} {value} to Liked Songs, in Spotify's order", { added, value: added === 1 ? T("song") : T("songs") }), "success");
}

/** Mount once (App). Only a change in the library's songs or an answer counts, not a cover arriving. */
export function watchRecoveredPlaylists(): () => void {
  let timer: number | null = null;
  const soon = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      completeAll();
    }, 1200);
  };
  const stopCatalog = useCatalog.subscribe((s, prev) => {
    if (s.loaded && (s.tracks.length !== prev.tracks.length || !prev.loaded)) soon();
  });
  const stopImport = useSpotifyImport.subscribe((s, prev) => {
    if (s.verdicts !== prev.verdicts || s.picks !== prev.picks || s.recovered !== prev.recovered) soon();
  });
  soon();
  return () => {
    stopCatalog();
    stopImport();
    if (timer !== null) window.clearTimeout(timer);
  };
}

/** How many songs of a recovered playlist's export aren't in it yet because the library lacks them; 0 for any other playlist. */
export function useStillMissing(playlistId: string): number {
  const recovered = useSpotifyImport((s) => s.recovered[playlistId]);
  const verdicts = useSpotifyImport((s) => s.verdicts);
  const picks = useSpotifyImport((s) => s.picks);
  const tracks = useCatalog((s) => s.tracks);
  return useMemo(() => {
    if (!recovered) return 0;
    return rowsOf(recovered.entries, tracks, { verdicts, picks }).filter((r) => r.kind !== "match").length;
  }, [recovered, tracks, verdicts, picks]);
}
