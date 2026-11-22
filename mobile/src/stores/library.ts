/**
 * The library on this phone: a copy of the server's song list, so the app
 * opens at once and works without the server, refreshed in the background;
 * and what the desktop's own builders make of it (albums, artists, mixes).
 */
import { create } from "zustand";
import { blurhashColor, type Rgb } from "../color";
import { artistPhotoUrl, fetchLibrary, isUnsure, markPlayed, playedSince, setFavorite, type ServerLibrary, type Session } from "../jellyfin";
import { forgetLikes, keptOnFailure, owedAfter, owedLikes, oweLike, owePlay, restoreOutbox, sendOutbox, type OutboxActions } from "../outbox";
import { allMixes, applyAlbumLooks, applyAlbumMerges, applyArtistAliases, applySongEdits, buildAlbums, buildArtists, buildGenres, likedInOrder, oneCopyEach, sameSong, songFinder, songIdentity, toWireTrack, type LibAlbum, type LibArtist, type LibGenre, type Mix, type Track, type WireTrack } from "../shared";
import { readJson, removeJson, writeJson } from "../storage";
import { useListens } from "./listens";
import { albumEditsNow, useAlbumEdits } from "./albumEdits";
import { useConnection } from "./connection";
import { useLibrarySync } from "./librarySync";
import { localSongs, setServerSongFiles, useLocalMusic } from "./localMusic";
import { useSession } from "./session";
import { useSettings } from "./settings";
import { sharedEnergyOf, sharedSoundOf, useSoundShare } from "./soundShare";
import { T } from "../shared";

const FILE = "library.json";
const LIKED_ORDER_FILE = "liked-order.json";
const MUTED_FILE = "muted.json";

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
    // Tempo, key and energy as the computer measured them (stores/soundShare.ts): Calm and Upbeat mixes, and an order that flows.
    mixes: allMixes(tracks, data.counts, { energyOf: sharedEnergyOf, sound: sharedSoundOf }),
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
  const owed = owedLikes(session());
  const liked = Object.keys(owed).filter((id) => owed[id] && !favorites.includes(id));
  return [...liked, ...favorites.filter((id) => owed[id] !== false)];
}

/** What the outbox asks of the server, for this login. */
const actionsFor = (s: Session): OutboxActions => ({
  setFavorite: (t, liked) => setFavorite(s, t, liked),
  markPlayed: (t, at) => markPlayed(s, t, at),
  playedSince: (t, at) => playedSince(s, t, at),
});

/** A busy server named a time: what's owed goes again then. */
let owedTimer: ReturnType<typeof setTimeout> | null = null;
function owedAgainIn(ms: number): void {
  if (owedTimer) clearTimeout(owedTimer);
  owedTimer = setTimeout(() => {
    owedTimer = null;
    const s = session();
    if (s) void sendOwed(s, useLibrary.getState().byId, true);
  }, ms);
}

/**
 * What's owed goes out, unless a busy server asked this account to wait (429): then once that wait is over,
 * from the refresh and the timer alike, also after another 429 (Codex, 2026-11-21: the refresh sent it again
 * right after the library came, 0 ms after it was told to wait 5 s).
 */
async function sendOwed(s: Session, byId: ReadonlyMap<string, Track>, final: boolean): Promise<void> {
  const wait = owedAfter(s) - Date.now();
  if (wait > 0) {
    owedAgainIn(wait);
    return;
  }
  const owed = await sendOutbox(s, byId, actionsFor(s), final).catch(() => null);
  if (owed?.retryInMs !== undefined) owedAgainIn(owed.retryInMs);
}

/** The newest wish for each song's like: the answer to an older one doesn't undo it (plan section 5). */
const likeWishes = new Map<string, number>();
let likeWish = 0;

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
    const [saved, likedOrder, , savedMuted] = await Promise.all([
      readJson<ServerLibrary>(FILE),
      readJson<WireTrack[]>(LIKED_ORDER_FILE),
      restoreOutbox(),
      readJson<{ at: number; tracks: WireTrack[] }>(MUTED_FILE),
      // The albums are shown as edited from the first look.
      useAlbumEdits.getState().restore(),
    ]);
    if (likedOrder) set({ likedOrder });
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
      // What's owed goes first; a song the library doesn't know yet waits for the list below.
      await sendOwed(s, get().byId, false);
      const listed = await fetchLibrary(s);
      await sendOwed(s, new Map(listed.tracks.map((t) => [t.id, t])), true);
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
    if (s) forgetLikes(s, copies.map((t) => t.id));
    for (const copy of copies) {
      // The phone's own files have no server to tell.
      if (!s || copy.localPath) continue;
      // A busy server asked to wait: the like goes with what's owed, when the wait is over (Codex, section 17).
      const wait = owedAfter(s) - Date.now();
      if (wait > 0) {
        oweLike(s, copy.id, liked);
        owedAgainIn(wait);
        continue;
      }
      const wish = ++likeWish;
      likeWishes.set(copy.id, wish);
      void setFavorite(s, copy, liked)
        .then(() => {
          if (likeWishes.get(copy.id) === wish) likeWishes.delete(copy.id);
          tellLikes?.();
        })
        .catch((err) => {
          // Liked or unliked again since: that wish counts, not this answer.
          if (likeWishes.get(copy.id) !== wish) return;
          likeWishes.delete(copy.id);
          // No answer, a login it doesn't take now, a busy server: it goes later (outbox.ts).
          if (keptOnFailure(err)) {
            oweLike(s, copy.id, liked);
            return;
          }
          // The server said no for good: back to what it holds.
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
    const at = Date.now();
    // Kept on this phone only while plays are (Settings → Network & privacy); the server hears of it by its own switch.
    if (useSettings.getState().recordListening) {
      const { data } = get();
      const plays = (data.counts[track.id]?.plays ?? 0) + 1;
      const next = { ...data, counts: { ...data.counts, [track.id]: { plays, lastAt: at } } };
      set({ data: next });
      writeJson(FILE, forFile(next));
      useListens.getState().note(track, at);
    }
    if (!s || track.localPath || !useSettings.getState().serverPlays) return;
    // A busy server asked to wait: the play goes with what's owed, when the wait is over.
    const wait = owedAfter(s) - Date.now();
    if (wait > 0) {
      owePlay(s, { id: track.id, at });
      owedAgainIn(wait);
      return;
    }
    void markPlayed(s, track, new Date(at)).catch((err) => {
      if (!keptOnFailure(err)) return;
      // Asked and no answer in time: it may be counted already, and is asked about before it goes again.
      owePlay(s, { id: track.id, at, ...(isUnsure(err) ? { unsure: true } : {}) });
    });
  },

  clear() {
    removeJson(FILE);
    removeJson(LIKED_ORDER_FILE);
    removeJson(MUTED_FILE);
    // The album edits belong to the account, like its playlists: the next login brings its own.
    useAlbumEdits.getState().clear();
    useLibrarySync.getState().clear();
    useSoundShare.getState().clear();
    // What's owed to the server stays, kept with its account (outbox.ts): signed in to it again, it goes.
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

// The computer measured more, or a key was set there: the mixes are made again.
useSoundShare.subscribe((s, prev) => {
  if (s.sounds === prev.sounds && s.keys === prev.keys) return;
  const { data, loaded } = useLibrary.getState();
  if (loaded || data.tracks.length) useLibrary.setState(derive(data));
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
