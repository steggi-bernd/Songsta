/**
 * When each album, playlist, Liked Songs and artist last played — the library
 * panel's "Recently played" order and Home's tiles of what played last (the
 * panel has no artists; Home shows them). A new queue is matched against them
 * (lib/libraryOrder.ts collectionOf) and its match is touched whenever one
 * of its songs starts; a queue that plays none of them touches nothing. Only
 * real plays count: nothing is guessed from the listening history (it knows
 * songs, not what they were played from).
 */
import { create } from "zustand";
import { songKey, useCatalog } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useLibraryOrder } from "../stores/libraryOrder";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import type { Track } from "../types";
import { artistRoute, leadArtist } from "./libraryCore";
import { collectionOf, type Collection, type Shelves } from "./libraryOrder";

const albumOf = (t: Track): string | null => (t.albumId?.startsWith("lib:album:") ? t.albumId : null);

let sizes: { tracks: Track[]; byAlbum: Map<string, number> } | null = null;
function albumSize(album: string): number {
  const tracks = useCatalog.getState().tracks;
  if (sizes?.tracks !== tracks) {
    const byAlbum = new Map<string, number>();
    for (const t of tracks) {
      const a = albumOf(t);
      if (a) byAlbum.set(a, (byAlbum.get(a) ?? 0) + 1);
    }
    sizes = { tracks, byAlbum };
  }
  return sizes.byAlbum.get(album) ?? 0;
}

/** Each list's song keys, until the catalog's versions change what a key is. */
let keySets = new WeakMap<Track[], Set<string>>();
let keyedWith: unknown = null;
function keysOf(list: Track[]): Set<string> {
  const versions = useCatalog.getState().versions;
  if (keyedWith !== versions) {
    keySets = new WeakMap();
    keyedWith = versions;
  }
  let keys = keySets.get(list);
  if (!keys) {
    keys = new Set(list.map((t) => songKey(t.id)));
    keySets.set(list, keys);
  }
  return keys;
}

function shelves(): Shelves {
  const { playlists, liked } = useLibrary.getState();
  const collections: Collection[] = [
    ...playlists.map((p) => ({ id: p.id, keys: keysOf(p.tracks) })),
    { id: "__liked__", keys: keysOf(liked) },
  ];
  return { keyOf: (t) => songKey(t.id), albumOf, albumSize, collections, artistOf: (t) => (t.artist ? artistRoute(leadArtist(t.artist)) : null) };
}

/**
 * Where the music playing now was started from, for the right rail: an album, a playlist or Liked
 * Songs, matched as above. It stays through what's done to the queue after (songs added, a branch,
 * shuffle), and goes with a new list that is none of them.
 */
export const usePlayingFrom = create<{ from: string | null }>(() => ({ from: null }));

/** The queue now still holds most of the one before it: an edit, not a new list. */
function sharesMost(before: readonly Track[] | null, now: readonly Track[]): boolean {
  if (!before?.length || !now.length) return false;
  const ids = new Set(now.map((t) => t.id));
  let kept = 0;
  for (const t of before) if (ids.has(t.id)) kept += 1;
  return kept * 2 >= before.length;
}

/** Subscribe once from App — returns an unsubscribe fn. */
export function watchRecentlyPlayed(): () => void {
  let fromQueue: Track[] | null = null;
  const lookFrom = (): void => {
    const { queue } = usePlayer.getState();
    if (queue === fromQueue && usePlayingFrom.getState().from) return;
    const found = queue.length ? collectionOf(queue, shelves()) : null;
    if (found) usePlayingFrom.setState({ from: found });
    else if (queue !== fromQueue && !sharesMost(fromQueue, queue)) usePlayingFrom.setState({ from: null });
    fromQueue = queue;
  };
  const offFrom = usePlayer.subscribe((s, prev) => {
    if (s.queue !== prev.queue) lookFrom();
  });
  // A queue from before the library had loaded is matched once it has.
  const offFromCatalog = useCatalog.subscribe(() => {
    if (!usePlayingFrom.getState().from) lookFrom();
  });
  lookFrom();
  let seen: Track[] | null = null;
  // What the queue plays, worked out when its first song starts (by then the
  // library and the catalog are loaded); undefined until then.
  let plays: string | null | undefined;
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (s.queue !== seen) {
      seen = s.queue;
      plays = undefined;
    }
    const started = s.playing && (!prev.playing || s.index !== prev.index || s.queue !== prev.queue || s.seekNonce !== prev.seekNonce);
    if (!started) return;
    if (plays === undefined) plays = collectionOf(s.queue, shelves());
    // Only while plays are kept (Settings → Network & privacy).
    if (plays && useSettings.getState().recordListening) useLibraryOrder.getState().touch(plays);
  });

  // Once these times are loaded: from when they count (homeSince, set the first time). Nothing is guessed
  // from the history any more (the user's wish, 2026-11-22): it knows songs, not what they were played
  // from, and its guesses named the albums of single songs heard from a playlist.
  const startCounting = (): void => {
    if (useLibraryOrder.persist.hasHydrated() && useLibraryOrder.getState().homeSince === null) useLibraryOrder.setState({ homeSince: Date.now() });
  };
  const offOrder = useLibraryOrder.persist.onFinishHydration(startCounting);
  startCounting();
  return () => {
    offFrom();
    offFromCatalog();
    offPlayer();
    offOrder();
  };
}
