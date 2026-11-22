/**
 * The library panel's order (components/Sidebar.tsx), kept pure for the
 * tests: the pinned rows on top in the order they were dragged into, then —
 * sorted by "Recently played" — the rest by when they last played; and which
 * album, playlist or Liked Songs a queue plays, so that time can be kept
 * (lib/recentlyPlayed.ts).
 */
import type { Track } from "../types";

/**
 * Rows in the panel's order: the pinned ones first, as they were placed (any
 * not placed yet after them, in their own order), then the rest — the latest
 * played first where `playedAt` is given, the never played in their own
 * order below.
 */
export function orderRows<R extends { id: string }>(
  rows: readonly R[],
  o: { isPinned(r: R): boolean; pinOrder: readonly string[]; playedAt?: (r: R) => number }
): R[] {
  const place = new Map(o.pinOrder.map((id, i) => [id, i] as const));
  const placeOf = (r: R): number => place.get(r.id) ?? Number.MAX_SAFE_INTEGER;
  const pinned = rows.filter((r) => o.isPinned(r)).sort((a, b) => placeOf(a) - placeOf(b));
  const rest = rows.filter((r) => !o.isPinned(r));
  if (o.playedAt) {
    const at = new Map(rest.map((r) => [r, o.playedAt!(r)] as const));
    rest.sort((a, b) => (at.get(b) ?? 0) - (at.get(a) ?? 0));
  }
  return [...pinned, ...rest];
}

/** The pinned rows' order after one was dragged onto another — above it, or below. */
export function movePinned(order: readonly string[], id: string, target: string, below: boolean): string[] {
  if (id === target || !order.includes(id)) return [...order];
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return [...order];
  rest.splice(below ? at + 1 : at, 0, id);
  return rest;
}

/** A collection a queue may play: a playlist or Liked Songs, by its songs' keys. */
export interface Collection {
  id: string;
  keys: ReadonlySet<string>;
}

export interface Shelves {
  /** a song's key — one for all versions of it */
  keyOf(t: Track): string;
  /** a song's album, as the panel's album row names it */
  albumOf(t: Track): string | null;
  /** how many songs an album has */
  albumSize(album: string): number;
  /** the playlists, then Liked Songs */
  collections: readonly Collection[];
  /** a song's lead artist, as an artist's page names it (Home's "played last" counts artists too) */
  artistOf?(t: Track): string | null;
}

/**
 * Which album, playlist or Liked Songs a queue plays: the album when every
 * song is of one and it plays at least half of it (a single by itself
 * counts); else the collection holding every song of it that it covers best,
 * at least half; else, where the shelves know artists, the artist when every
 * song is theirs and it spans two albums or five songs (an artist page's Play
 * or Shuffle). A song from elsewhere — a search, a mix — plays none.
 */
export function collectionOf(queue: readonly Track[], s: Shelves): string | null {
  if (!queue.length) return null;
  const keys = new Set(queue.map((t) => s.keyOf(t)));
  const album = s.albumOf(queue[0]);
  if (album && queue.every((t) => s.albumOf(t) === album)) {
    const size = s.albumSize(album);
    if (size === 1 || (size > 1 && keys.size >= 2 && keys.size * 2 >= size)) return album;
  }
  let best: { id: string; cover: number } | null = null;
  for (const c of s.collections) {
    if (!c.keys.size || keys.size * 2 < c.keys.size || (keys.size < 2 && c.keys.size > 1)) continue;
    let all = true;
    for (const k of keys) {
      if (!c.keys.has(k)) {
        all = false;
        break;
      }
    }
    const cover = keys.size / c.keys.size;
    if (all && (!best || cover > best.cover)) best = { id: c.id, cover };
  }
  if (best) return best.id;
  const artistOf = s.artistOf;
  if (artistOf && keys.size >= 2) {
    const artist = artistOf(queue[0]);
    if (artist && queue.every((t) => artistOf(t) === artist)) {
      const albums = new Set(queue.map((t) => s.albumOf(t) ?? t.album ?? ""));
      if (albums.size >= 2 || keys.size >= 5) return artist;
    }
  }
  return null;
}
