/**
 * When an album came into the library, as this computer saw it: for "Recently added" and "New on
 * the wall". The songs' own dates aren't always that moment. Jellyfin can hand out a file's date, and
 * a file that was copied or unpacked can keep one from years ago, so albums added this week sorted
 * among old ones (the user's report of 2026-11-15).
 *
 * From the day this exists, an album that turns up gets that moment. The albums there at the first
 * look keep their own dates, and so do many that turn up at once (a server signed in to, a whole
 * collection added): their own order says more than one shared moment would.
 *
 * Albums are known by the key their songs came in with, before any album edits, so renaming or
 * merging an album doesn't make it new (lib/catalogIndex.ts reads it).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";

/** More new albums than this in one look are a source joining, not albums added. */
export const MANY_AT_ONCE = 60;

export interface AlbumsSeen {
  /** album key → when it turned up (ms); 0 = there before this kept count, or one of many at once */
  seen: Record<string, number>;
  /** the first look has happened: the albums of that look are the baseline */
  started: boolean;
}

/** What a look at these album keys writes down; null when nothing changes. Pure, for tests. */
export function seenAfter(state: AlbumsSeen, keys: Iterable<string>, now: number): AlbumsSeen | null {
  const fresh = new Set<string>();
  for (const key of keys) {
    if (key && key !== "__proto__" && !Object.prototype.hasOwnProperty.call(state.seen, key)) fresh.add(key);
  }
  if (!fresh.size) return null;
  const stamp = !state.started || fresh.size > MANY_AT_ONCE ? 0 : now;
  const seen = { ...state.seen };
  for (const key of fresh) seen[key] = stamp;
  return { seen, started: true };
}

interface AlbumsSeenState extends AlbumsSeen {
  see(keys: Iterable<string>, now: number): void;
}

export const useAlbumsSeen = create<AlbumsSeenState>()(
  persist(
    (set, get) => ({
      seen: {},
      started: false,
      see(keys, now) {
        const next = seenAfter(get(), keys, now);
        if (next) set(next);
      },
    }),
    { name: "albums-seen", storage: createJSONStorage(() => storage), version: 1, partialize: (s) => ({ seen: s.seen, started: s.started }) }
  )
);
