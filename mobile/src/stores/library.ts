/**
 * The library on this phone: a copy of the server's song list, so the app
 * opens at once and works without the server, refreshed in the background;
 * and what the desktop's own builders make of it (albums, artists, mixes).
 */
import { create } from "zustand";
import { blurhashColor, type Rgb } from "../color";
import { artistPhotoUrl, fetchLibrary, isNoAnswer, markPlayed, setFavorite, type ServerLibrary, type Session } from "../jellyfin";
import { allMixes, applyAlbumLooks, applyAlbumMerges, applyArtistAliases, applySongEdits, buildAlbums, buildArtists, buildGenres, likedInOrder, oneCopyEach, sameSong, songFinder, songIdentity, toWireTrack, type LibAlbum, type LibArtist, type LibGenre, type Mix, type Track, type WireTrack } from "../shared";
import { readJson, removeJson, writeJson } from "../storage";
import { albumEditsNow, useAlbumEdits } from "./albumEdits";
import { useConnection } from "./connection";
import { useLibrarySync } from "./librarySync";
import { localSongs, setServerSongFiles, useLocalMusic } from "./localMusic";
import { useSession } from "./session";
import { useSettings } from "./settings";
import { T } from "../shared";

const FILE = "library.json";
const LIKED_ORDER_FILE = "liked-order.json";
const OUTBOX_FILE = "outbox.json";
const MUTED_FILE = "muted.json";

/** Likes and plays from while the server was out of reach, for when it's back. */
interface Outbox {
  likes: Record<string, boolean>;
  plays: { id: string; at: number }[];
}

let outbox: Outbox = { likes: {}, plays: [] };

interface LibraryState {
  loaded: boolean;
  refreshing: boolean;
  error: string | null;
  data: ServerLibrary;
  /** the songs as shown, with the album edits applied (stores/albumEdits.ts); `data` keeps what the server says */
  tracks: Track[];
  byId: Map<string, Track>;
  albums: LibAlbum[];
  artists: LibArtist[];
  genres: LibGenre[];
  mixes: Mix[];
  favorites: Set<string>;
  /** Liked Songs as the computer arranged them; the server's favorites have no order */
  likedOrder: WireTrack[];
  /** songs that are skipped unless asked for by name: every copy's id */
  muted: Set<string>;
  /** the same as a list for other devices, one entry per song */
  mutedTracks: WireTrack[];
  /** when that list last changed; the newest list wins */
  mutedAt: number;
  /** Mutes the song or takes that back; answers whether it's muted now. */
  toggleMuted(track: Track): boolean;
  /** A newer list from another device. */
  applyMuted(tracks: WireTrack[], at: number): void;
  restore(): Promise<void>;
  refresh(): Promise<void>;
  /** The folders on this phone changed. */
  applyLocal(): void;
  setLikedOrder(order: WireTrack[]): void;
  toggleFavorite(track: Track): void;
  notePlayed(track: Track): void;
  clear(): void;
}

const EMPTY: ServerLibrary = { tracks: [], hashes: {}, favorites: [], counts: {}, artistIds: {} };

/**
 * The songs as shown, as on the computer: put on albums by hand, artists as spelled, albums merged,
 * named and pictured as edited (stores/albumEdits.ts). What's kept on the phone is what the server says.
 */
function shown(tracks: Track[]): Track[] {
  const { songs, aliases, mergedInto, titles, covers } = albumEditsNow();
  return applyAlbumLooks(applyAlbumMerges(applyArtistAliases(applySongEdits(tracks, songs), aliases), mergedInto), titles, covers);
}

function derive(data: ServerLibrary) {
  const tracks = shown(data.tracks);
  const albums = buildAlbums(tracks, albumEditsNow().artists);
  return {
    data,
    tracks,
    byId: new Map(tracks.map((t) => [t.id, t])),
    albums,
    artists: buildArtists(tracks, albums),
    genres: buildGenres(tracks),
    // The sound analysis lives on the desktop: no Calm and Upbeat mixes here yet.
    mixes: allMixes(tracks, data.counts, () => undefined),
    favorites: new Set(data.favorites),
  };
}

const session = (): Session | null => useSession.getState().session;

/** The server's songs and what only this phone has. A song on both stays one: the server's, playing from the file. */
function withLocal(data: ServerLibrary): ServerLibrary {
  const onServer = data.tracks.filter((t) => !t.localPath);
  const identities = new Map<string, Track[]>();
  for (const t of onServer) {
    const key = songIdentity(t);
    const list = identities.get(key);
    if (list) list.push(t);
    else identities.set(key, [t]);
  }
  const files = new Map<string, string>();
  const onlyHere: Track[] = [];
  for (const local of localSongs()) {
    const same = identities.get(songIdentity(local))?.filter((t) => sameSong(t, local));
    if (same?.length) for (const t of same) files.set(t.id, local.localPath as string);
    else onlyHere.push(local);
  }
  setServerSongFiles(files);
  return { ...data, tracks: [...onServer, ...onlyHere] };
}

/** What's in the file is the server's copy: the folders are read anew. */
const forFile = (data: ServerLibrary): ServerLibrary => ({ ...data, tracks: data.tracks.filter((t) => !t.localPath) });
const isLocalId = (id: string): boolean => id.startsWith("local:");

/** What the server hears next time; its list until then doesn't know yet. */
function withOutbox(favorites: string[]): string[] {
  const liked = Object.keys(outbox.likes).filter((id) => outbox.likes[id] && !favorites.includes(id));
  return [...liked, ...favorites.filter((id) => outbox.likes[id] !== false)];
}

/** Whatever the server refuses is dropped: only no answer at all keeps a thing for later. */
async function sendOutbox(s: Session, byId: Map<string, Track>): Promise<void> {
  if (!Object.keys(outbox.likes).length && !outbox.plays.length) return;
  try {
    for (const [id, liked] of Object.entries(outbox.likes)) {
      const track = byId.get(id);
      if (track) await setFavorite(s, track, liked).catch((err) => { if (isNoAnswer(err)) throw err; });
      delete outbox.likes[id];
    }
    while (outbox.plays.length) {
      const { id, at } = outbox.plays[0];
      const track = byId.get(id);
      if (track) await markPlayed(s, track, new Date(at)).catch((err) => { if (isNoAnswer(err)) throw err; });
      outbox.plays.shift();
    }
  } catch {
    /* gone again: the rest next time */
  }
  writeJson(OUTBOX_FILE, outbox);
}

/** The server lists its favorites by artist and album: what stood here keeps its place, what's new comes on top. */
function keepPlaces(before: string[], listed: string[]): string[] {
  const known = new Set(before);
  const still = new Set(listed);
  // The server has never heard of the phone's own files.
  return [...listed.filter((id) => !known.has(id)), ...before.filter((id) => still.has(id) || isLocalId(id))];
}

function arranged(data: ServerLibrary, order: WireTrack[]): ServerLibrary {
  if (!order.length) return data;
  const byId = new Map(data.tracks.map((t) => [t.id, t]));
  return { ...data, favorites: likedInOrder(data.favorites, order, songFinder(data.tracks), (id) => byId.get(id)) };
}

/** Every copy of a song on the server: what the computer counts as one song counts as one here too. */
function copiesOf(track: Track, tracks: Track[]): Track[] {
  const key = songIdentity(track);
  const copies = tracks.filter((t) => t.id === track.id || (songIdentity(t) === key && sameSong(t, track)));
  return copies.length ? copies : [track];
}

/** Liked Songs as a list: two copies of one song show once. */
export const likedSongIds = (favorites: string[], byId: Map<string, Track>): string[] => oneCopyEach(favorites, (id) => byId.get(id));

function mutedIds(wires: WireTrack[], tracks: Track[]): Set<string> {
  const find = songFinder(tracks);
  const ids = new Set<string>();
  for (const wire of wires) {
    const song = find(wire);
    if (song) for (const copy of copiesOf(song, tracks)) ids.add(copy.id);
    else ids.add(wire.id);
  }
  return ids;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  loaded: false,
  refreshing: false,
  error: null,
  likedOrder: [],
  muted: new Set<string>(),
  mutedTracks: [],
  mutedAt: 0,
  ...derive(EMPTY),

  async restore() {
    const [saved, likedOrder, savedOutbox, savedMuted] = await Promise.all([
      readJson<ServerLibrary>(FILE),
      readJson<WireTrack[]>(LIKED_ORDER_FILE),
      readJson<Outbox>(OUTBOX_FILE),
      readJson<{ at: number; tracks: WireTrack[] }>(MUTED_FILE),
      // The albums are shown as edited from the first look.
      useAlbumEdits.getState().restore(),
    ]);
    if (likedOrder) set({ likedOrder });
    if (savedOutbox) outbox = savedOutbox;
    if (saved?.tracks) set({ ...derive(withLocal(saved)), loaded: true });
    else set(derive(withLocal(EMPTY)));
    if (savedMuted) set({ mutedTracks: savedMuted.tracks, mutedAt: savedMuted.at, muted: mutedIds(savedMuted.tracks, saved?.tracks ?? []) });
    void get().refresh();
  },

  async refresh() {
    if (!session()) {
      get().applyLocal();
      set({ loaded: true, error: null });
      return;
    }
    if (get().refreshing) return;
    set({ refreshing: true, error: null });
    try {
      // The address may have moved, or there may be no way to the server at all.
      const reach = await useConnection.getState().check();
      const s = session();
      if (!s || reach === "offline") {
        set({ refreshing: false, loaded: true, error: T("Can't reach your server") });
        return;
      }
      await sendOutbox(s, get().byId);
      const listed = await fetchLibrary(s);
      // Plays of the phone's own files aren't the server's to know.
      const counts = { ...listed.counts };
      for (const [id, count] of Object.entries(get().data.counts)) if (isLocalId(id)) counts[id] = count;
      const data = arranged(withLocal({ ...listed, counts, favorites: withOutbox(keepPlaces(get().data.favorites, listed.favorites)) }), get().likedOrder);
      writeJson(FILE, forFile(data));
      set({ ...derive(data), loaded: true, refreshing: false, muted: mutedIds(get().mutedTracks, data.tracks) });
    } catch (err) {
      set({ refreshing: false, loaded: true, error: err instanceof Error ? err.message : T("The library did not load") });
    }
  },

  applyLocal() {
    const data = withLocal(get().data);
    set({ ...derive(data), muted: mutedIds(get().mutedTracks, data.tracks) });
  },

  setLikedOrder(likedOrder) {
    writeJson(LIKED_ORDER_FILE, likedOrder);
    const data = arranged(get().data, likedOrder);
    writeJson(FILE, forFile(data));
    set({ likedOrder, data });
  },

  toggleFavorite(track) {
    const s = session();
    const { data } = get();
    const liked = !data.favorites.includes(track.id);
    // Every copy on the server: the computer counts them as one song.
    const copies = copiesOf(track, data.tracks);
    const copyIds = new Set(copies.map((t) => t.id));
    const others = data.favorites.filter((id) => !copyIds.has(id));
    // The latest like comes first, as in Liked Songs on the desktop.
    const favorites = liked ? [...copyIds, ...others] : others;
    const next = { ...data, favorites };
    writeJson(FILE, forFile(next));
    set({ data: next, favorites: new Set(favorites) });
    // Changed again before the server heard: the older wish must not come back after a restart.
    if (copies.some((t) => t.id in outbox.likes)) {
      for (const t of copies) delete outbox.likes[t.id];
      writeJson(OUTBOX_FILE, outbox);
    }
    for (const copy of copies) {
      // The phone's own files have no server to tell.
      if (!s || copy.localPath) continue;
      void setFavorite(s, copy, liked)
        .then(() => tellLikes?.())
        .catch((err) => {
          if (isNoAnswer(err)) {
            outbox.likes[copy.id] = liked;
            writeJson(OUTBOX_FILE, outbox);
            return;
          }
          // The server said no: back to what it holds.
          const now = get().data;
          const restored = liked ? now.favorites.filter((id) => id !== copy.id) : [copy.id, ...now.favorites];
          set({ data: { ...now, favorites: restored }, favorites: new Set(restored) });
        });
    }
  },

  toggleMuted(track) {
    const { muted, mutedTracks, data } = get();
    const nowMuted = !muted.has(track.id);
    const copies = copiesOf(track, data.tracks);
    const copyIds = new Set(copies.map((t) => t.id));
    const next = new Set(muted);
    for (const id of copyIds) {
      if (nowMuted) next.add(id);
      else next.delete(id);
    }
    const others = mutedTracks.filter((wire) => !copyIds.has(wire.id));
    const tracks = nowMuted ? [toWireTrack(track), ...others] : others;
    const at = Date.now();
    writeJson(MUTED_FILE, { at, tracks });
    set({ muted: next, mutedTracks: tracks, mutedAt: at });
    return nowMuted;
  },

  applyMuted(tracks, at) {
    writeJson(MUTED_FILE, { at, tracks });
    set({ mutedTracks: tracks, mutedAt: at, muted: mutedIds(tracks, get().data.tracks) });
  },

  notePlayed(track) {
    const s = session();
    const { data } = get();
    const plays = (data.counts[track.id]?.plays ?? 0) + 1;
    const at = Date.now();
    const next = { ...data, counts: { ...data.counts, [track.id]: { plays, lastAt: at } } };
    set({ data: next });
    writeJson(FILE, forFile(next));
    if (!s || track.localPath || !useSettings.getState().serverPlays) return;
    void markPlayed(s, track, new Date(at)).catch((err) => {
      if (!isNoAnswer(err)) return;
      outbox.plays.push({ id: track.id, at });
      writeJson(OUTBOX_FILE, outbox);
    });
  },

  clear() {
    removeJson(FILE);
    removeJson(LIKED_ORDER_FILE);
    removeJson(OUTBOX_FILE);
    removeJson(MUTED_FILE);
    // The album edits belong to the account, like its playlists: the next login brings its own.
    useAlbumEdits.getState().clear();
    useLibrarySync.getState().clear();
    outbox = { likes: {}, plays: [] };
    set({ muted: new Set<string>(), mutedTracks: [], mutedAt: 0 });
    set({ ...derive(withLocal(EMPTY)), likedOrder: [], loaded: false, error: null });
  },
}));

/** A like went to the server: the computer may want to look at once rather than in ten minutes. */
let tellLikes: (() => void) | null = null;
export function onLikesSent(listener: (() => void) | null): void {
  tellLikes = listener;
}

// Another folder, a rescan, or the filter for what's music.
useLocalMusic.subscribe((s, prev) => {
  if (s.files !== prev.files) useLibrary.getState().applyLocal();
});

// An album merged, renamed, given a picture or other artists, here or on another device: shown at once.
useAlbumEdits.subscribe((s, prev) => {
  if (s.artists === prev.artists && s.mergedInto === prev.mergedInto && s.aliases === prev.aliases && s.songs === prev.songs && s.titles === prev.titles && s.covers === prev.covers) return;
  const { data, loaded } = useLibrary.getState();
  if (loaded || data.tracks.length) useLibrary.setState(derive(data));
});
useSettings.subscribe((s, prev) => {
  if (s.filterNonMusic !== prev.filterNonMusic) useLibrary.getState().applyLocal();
});

// Back within reach: what changed in the meantime.
useConnection.subscribe((s, prev) => {
  if (prev.reach === "offline" && s.reach !== "offline") void useLibrary.getState().refresh();
});

/** The cover's colour for tints, when the server listed one. */
export function useCoverColor(thumb: string | undefined): Rgb | null {
  const hash = useLibrary((s) => (thumb ? s.data.hashes[thumb] : undefined));
  return blurhashColor(hash);
}

/** The artist's photo on the server, when it knows the artist. */
export function useArtistPhoto(name: string): string | null {
  const id = useLibrary((s) => s.data.artistIds[name.toLowerCase()]);
  const current = useSession((s) => s.session);
  return id && current ? artistPhotoUrl(current, id) : null;
}
