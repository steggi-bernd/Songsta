/**
 * The user's corrections to how songs group into albums. Tags are often wrong
 * or split one release in two — "Album (Disc 1)" and "Album (Disc 2)", a song
 * tagged with a different album artist. These edits never touch the files or
 * the servers: the catalogue applies them whenever it builds its albums.
 *
 *  - artists: an album's artist credit line, replacing what its tags say
 *  - mergedInto: an album (by its tag key, see albumKeyOf) shown as part of
 *    another one
 *  - aliases: an artist's other spellings, read as the chosen one ("Beyonce"
 *    as "Beyoncé") wherever they are credited (the library check)
 *  - songs: songs whose tags name no album, put on one by hand
 *    (views/LooseSongsView.tsx)
 *  - titles, covers: an album's name and picture as the user wants them
 *
 * Pure, so the grouping rules are testable on their own, and one copy for the
 * desktop and the phone; they travel between them (lib/librarySync.ts).
 */
import type { Track } from "../types";
import { foldTag } from "./duplicates";
import { albumKeyOf, albumRoute, artistRoute, leadArtist, parseRoute, splitCredits } from "./libraryCore";

export interface AlbumEdits {
  /** album key → artist credit line ("A, B") */
  artists: Record<string, string>;
  /** album key → the album it is shown as part of */
  mergedInto: Record<string, string>;
  /** an artist name as tagged → the spelling it is shown as */
  aliases: Record<string, string>;
  /** a song put on an album by hand → what it carries, under every id of the song */
  songs: Record<string, SongEdit>;
  /** album key → the name it's shown under */
  titles: Record<string, string>;
  /** album key → its picture, a file kept on this computer (localart://) */
  covers: Record<string, string>;
}

/** What a song put on an album by hand carries, as if tagged. */
export interface SongEdit {
  album: string;
  /** the album's artist */
  albumArtist?: string;
  /** the song's artist, where its tags name none */
  artist?: string;
  trackNo?: number;
  year?: number;
}

/** A song whose tags name no album — it shows on no album page until it's put on one. */
export const isLoose = (t: Track): boolean => !albumKeyOf(t);

/**
 * Songs put on an album by hand carry it as if tagged — the album, its
 * artist, their number and year, and an artist where their tags name none —
 * and group with it. An edit is kept under every id of a song, so a song
 * found twice keeps it whichever copy leads.
 */
export function applySongEdits(tracks: Track[], songs: Record<string, SongEdit>, versions?: Map<string, Track[]>): Track[] {
  if (!songs || !Object.keys(songs).length) return tracks;
  return tracks.map((t) => {
    const edit = songs[t.id] ?? versions?.get(t.id)?.map((v) => songs[v.id]).find((e) => !!e);
    if (!edit) return t;
    const next: Track = {
      ...t,
      album: edit.album,
      albumArtist: edit.albumArtist ?? t.albumArtist,
      artist: edit.artist ?? t.artist,
      trackNo: edit.trackNo ?? t.trackNo,
      year: edit.year ?? t.year,
    };
    const key = albumKeyOf(next);
    const lead = leadArtist(next.artist);
    return {
      ...next,
      albumId: key ? albumRoute(key) : t.albumId,
      artistId: edit.artist && lead && lead.toLowerCase() !== "unknown artist" ? artistRoute(lead) : t.artistId,
    };
  });
}

/** The title without disc/edition markers: "Album (Disc 2)", "Album [CD1]", "Album (Deluxe)" → "album". */
export function baseTitle(title: string): string {
  return foldTag(
    title
      .replace(/\s*[([][^)\]]*\b(?:disc|disk|cd|deluxe|bonus|edition|remaster(?:ed)?|expanded|anniversary|b-sides?)\b[^)\]]*[)\]]/gi, "")
      .replace(/\s*[-–:]\s*(?:disc|disk|cd)\s*\d+\s*$/i, "")
  );
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every credit of an aliased name reads as its chosen spelling — artist and album artist, the rest of the line as it was. */
export function applyArtistAliases(tracks: Track[], aliases: Record<string, string>): Track[] {
  if (!Object.keys(aliases).length) return tracks;
  const rewrite = (credit: string | undefined): string | undefined => {
    if (!credit) return credit;
    let out = credit;
    for (const name of splitCredits(credit)) {
      const to = aliases[name];
      if (!to || to === name) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u"), () => to);
    }
    return out;
  };
  return tracks.map((t) => {
    const artist = rewrite(t.artist) ?? t.artist;
    const albumArtist = rewrite(t.albumArtist);
    return artist === t.artist && albumArtist === t.albumArtist ? t : { ...t, artist, albumArtist };
  });
}

/** The album a key ends up in, following chained merges (a cycle stops where it started). */
export function resolveAlbumKey(key: string, mergedInto: Record<string, string>): string {
  let at = key;
  for (let hops = 0; hops < 32; hops++) {
    const next = mergedInto[at];
    if (!next || next === key) return at;
    at = next;
  }
  return at;
}

/** Merge `from` into `into` (wherever that one already went); albums merged into `from` follow it. */
export function withMerge(mergedInto: Record<string, string>, from: string, into: string): Record<string, string> {
  const target = resolveAlbumKey(into, mergedInto);
  if (!from || target === from) return mergedInto;
  const next: Record<string, string> = { ...mergedInto, [from]: target };
  for (const [k, v] of Object.entries(next)) if (v === from) next[k] = target;
  return next;
}

/** `name` shown as `as` (null: as tagged again); a name others pointed at now points on, so there are no chains. */
export function withAlias(aliases: Record<string, string>, name: string, as: string | null): Record<string, string> {
  const next = { ...aliases };
  if (as && as !== name) next[name] = as;
  else delete next[name];
  for (const [from, to] of Object.entries(next)) if (to === name && as && as !== name) next[from] = as;
  return next;
}

/** The album's artist line from these names; none left goes back to its tags. */
export function creditLine(names: readonly string[]): string | null {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  return clean.length ? clean.join(", ") : null;
}

/** Show `from` as its own album again — albums merged into it stay with it. */
export function withSplit(mergedInto: Record<string, string>, from: string): Record<string, string> {
  if (!(from in mergedInto)) return mergedInto;
  const next = { ...mergedInto };
  delete next[from];
  return next;
}

/**
 * Songs of an album shown under another name or with another picture carry it,
 * so every list says the same. The album stays the one it was: its page link
 * keeps its key, and `albumTag` keeps the name its other edits go by.
 */
export function applyAlbumLooks(tracks: Track[], titles: Record<string, string>, covers: Record<string, string>): Track[] {
  if (!Object.keys(titles).length && !Object.keys(covers).length) return tracks;
  return tracks.map((t) => {
    const key = (t.albumId ? parseRoute(t.albumId, "album") : null) ?? albumKeyOf(t);
    if (!key) return t;
    const title = titles[key];
    const cover = covers[key];
    if (!title && !cover) return t;
    return {
      ...t,
      ...(title ? { album: title, albumTag: t.albumTag ?? t.album, albumId: albumRoute(key) } : {}),
      ...(cover ? { thumb: cover } : {}),
    };
  });
}

/** Songs of merged albums point at the album they're shown in (their album page link follows). */
export function applyAlbumMerges(tracks: Track[], mergedInto: Record<string, string>): Track[] {
  if (!Object.keys(mergedInto).length) return tracks;
  return tracks.map((t) => {
    const key = albumKeyOf(t);
    if (!key) return t;
    const target = resolveAlbumKey(key, mergedInto);
    return target === key ? t : { ...t, albumId: albumRoute(target) };
  });
}
