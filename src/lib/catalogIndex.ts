/**
 * The catalogue's derived views for the desktop's pages — built once per
 * catalogue version and shared by every page that needs them. The builders
 * themselves: catalogBuild.ts.
 */
import { useMemo } from "react";
import { useAlbumEdits } from "../stores/albumEdits";
import { useAlbumsSeen } from "../stores/albumsSeen";
import { useAlbumGenres } from "./albumGenres";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";
import { albumOfTrack, buildAlbums, buildArtists, buildGenres, likedAmong, withSeenDates, type LibAlbum, type LibArtist, type LibGenre } from "./catalogBuild";

export * from "./catalogBuild";


/** likedAmong for a page's songs: rebuilt when the likes or the catalogue's copies change. */
export function useLikedAmong(songs: Track[]): Track[] {
  const liked = useLibrary((s) => s.liked);
  const versions = useCatalog((s) => s.versions);
  return useMemo(
    () => likedAmong(songs, liked, songKey),
    // songKey reads the catalogue's versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [songs, liked, versions]
  );
}

let albumsMemo: { tracks: Track[]; edits: Record<string, string>; albums: LibAlbum[]; artists: LibArtist[] } | null = null;

function indexFor(tracks: Track[], edits: Record<string, string>): { albums: LibAlbum[]; artists: LibArtist[] } {
  // Play-count refreshes keep the same track list, so they never rebuild the index.
  if (!albumsMemo || albumsMemo.tracks !== tracks || albumsMemo.edits !== edits) {
    const albums = buildAlbums(tracks, edits);
    albumsMemo = { tracks, edits, albums, artists: buildArtists(tracks, albums) };
  }
  return albumsMemo;
}

let seenMemo: { albums: LibAlbum[]; seen: Record<string, number>; byId: Map<string, Track>; out: LibAlbum[] } | null = null;

/** The albums with the moment this computer first saw them, where later (stores/albumsSeen.ts). */
function albumsWithSeen(albums: LibAlbum[], seen: Record<string, number>, byId: Map<string, Track>): LibAlbum[] {
  if (seenMemo && seenMemo.albums === albums && seenMemo.seen === seen && seenMemo.byId === byId) return seenMemo.out;
  // By the album a song came in as (the catalogue's own copy, before album edits).
  const out = withSeenDates(albums, (t) => seen[albumOfTrack(byId.get(t.id) ?? t) ?? ""] ?? 0);
  seenMemo = { albums, seen, byId, out };
  return out;
}

/**
 * Albums and artists for the current song list — built once per catalogue
 * load (or album edit) and shared by all pages.
 */
export function useLibraryIndex(): { albums: LibAlbum[]; artists: LibArtist[]; tracks: Track[]; loaded: boolean } {
  const tracks = useCatalog((s) => s.tracks);
  const byId = useCatalog((s) => s.byId);
  const loaded = useCatalog((s) => s.loaded);
  const artistEdits = useAlbumEdits((s) => s.artists);
  const seen = useAlbumsSeen((s) => s.seen);
  return useMemo(() => {
    const index = indexFor(tracks, artistEdits);
    return { albums: albumsWithSeen(index.albums, seen, byId), artists: index.artists, tracks, loaded };
  }, [tracks, byId, loaded, artistEdits, seen]);
}

/**
 * Mount once (App): writes down the albums that turn up in the library, by the album their songs came
 * in as (stores/albumsSeen.ts), after each load of the catalogue.
 */
export function watchAlbumsSeen(): () => void {
  const look = (): void => {
    const { loaded, byId } = useCatalog.getState();
    if (!loaded || !byId.size || !useAlbumsSeen.persist.hasHydrated()) return;
    const keys = new Set<string>();
    for (const t of byId.values()) {
      const key = albumOfTrack(t);
      if (key) keys.add(key);
    }
    useAlbumsSeen.getState().see(keys, Date.now());
  };
  const offCatalog = useCatalog.subscribe((s, prev) => {
    if (s.byId !== prev.byId || s.loaded !== prev.loaded) look();
  });
  const offHydrated = useAlbumsSeen.persist.onFinishHydration(look);
  look();
  return () => {
    offCatalog();
    offHydrated();
  };
}

let genresMemo: { tracks: Track[]; voted: Map<string, string[]>; genres: LibGenre[] } | null = null;

/** The library's genres, built once per catalogue load (and vote: lib/albumGenres.ts) and shared (Explore, genre pages). */
export function useLibraryGenres(): LibGenre[] {
  const tracks = useCatalog((s) => s.tracks);
  const voted = useAlbumGenres((s) => s.voted);
  return useMemo(() => {
    if (!genresMemo || genresMemo.tracks !== tracks || genresMemo.voted !== voted) genresMemo = { tracks, voted, genres: buildGenres(tracks, (key) => voted.get(key)) };
    return genresMemo.genres;
  }, [tracks, voted]);
}
