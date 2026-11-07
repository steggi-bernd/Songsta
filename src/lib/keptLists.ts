/**
 * Lists downloaded as a whole stay whole: what's added to one later, on any device, or
 * didn't make it last time, is fetched by itself. Pure, one copy for the computer and the phone.
 */

export const playlistListKey = (id: string): string => `playlist:${id}`;
export const albumListKey = (key: string): string => `album:${key}`;
export const LIKED_LIST = "liked";

/** How often it looks without any reason, for what failed before. */
export const KEPT_LISTS_LOOK_EVERY_MS = 15 * 60_000;

/** The songs still to fetch for these lists: each once, however many lists it's on. */
export function missingFromLists<T extends { id: string }>(lists: Iterable<readonly T[]>, stillToFetch: (song: T) => boolean): T[] {
  const seen = new Set<string>();
  const missing: T[] = [];
  for (const songs of lists) {
    for (const song of songs) {
      if (seen.has(song.id)) continue;
      seen.add(song.id);
      if (stillToFetch(song)) missing.push(song);
    }
  }
  return missing;
}

/** Lists that were complete before lists were remembered count as downloaded: everything on them is there, and there's something on them. */
export function completeLists<T>(lists: Iterable<readonly [string, readonly T[]]>, isThere: (song: T) => boolean): string[] {
  const whole: string[] = [];
  for (const [key, songs] of lists) if (songs.length > 0 && songs.every(isThere)) whole.push(key);
  return whole;
}
