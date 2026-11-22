/**
 * Which songs, albums and artists Search shows under a source (plan section 4): every copy of a song
 * counts, so a song kept as a local file and on Jellyfin is found under both, and a source whose songs all
 * have local copies stays there to pick. Albums and artists come from the same songs: under Jellyfin an
 * album only on this computer isn't there, nor its artists. It used to go by the copy that plays first
 * alone, and showed every album and artist whatever the source.
 */
import type { LibAlbum, LibArtist } from "./catalogBuild";
import { splitCredits } from "./libraryCore";
import type { Track } from "../types";

export type SongSource = "local" | "jellyfin" | "subsonic";
export type SearchScope = "all" | SongSource;

/** Where a song can play from: its own copy and every other copy of it (stores/catalog.ts versions). */
export function sourcesOfSong(track: Track, versions: ReadonlyMap<string, readonly Track[]>): Set<SongSource> {
  const found = new Set<SongSource>([track.source ?? "local"]);
  for (const copy of versions.get(track.id) ?? []) found.add(copy.source ?? "local");
  return found;
}

export interface ScopedLibrary {
  /** every source some song can play from: the choices offered */
  sources: Set<SongSource>;
  tracks: Track[];
  albums: LibAlbum[];
  artists: LibArtist[];
}

export function scopeLibrary(library: { tracks: Track[]; albums: LibAlbum[]; artists: LibArtist[] }, versions: ReadonlyMap<string, readonly Track[]>, scope: SearchScope): ScopedLibrary {
  const sources = new Set<SongSource>();
  const inScope: Track[] = [];
  for (const t of library.tracks) {
    const from = sourcesOfSong(t, versions);
    for (const s of from) sources.add(s);
    if (scope === "all" || from.has(scope)) inScope.push(t);
  }
  if (scope === "all") return { sources, tracks: inScope, albums: library.albums, artists: library.artists };
  const ids = new Set(inScope.map((t) => t.id));
  const albums = library.albums.filter((a) => a.tracks.some((t) => ids.has(t.id)));
  const names = new Set<string>();
  for (const t of inScope) for (const name of splitCredits(t.artist)) names.add(name.toLowerCase());
  for (const a of albums) names.add(a.artist.toLowerCase());
  const artists = library.artists.filter((a) => names.has(a.name.toLowerCase()));
  return { sources, tracks: inScope, albums, artists };
}
