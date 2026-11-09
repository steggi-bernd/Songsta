/** Library state: liked tracks, playlists, history and download registry. */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { lazyJSONStorage } from "../lib/persist";
import { recordDeletionChanges } from "../lib/deletion-sync";
import type { DeletionChange, DeletionSync } from "../lib/deletion-sync";
import type { Track } from "../types";
import { songKey } from "./catalog";
import { T } from "../lib/i18n";

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
  /** pinned playlists sort first */
  pinned?: boolean;
  /** library folder this playlist lives in, when filed */
  folderId?: string;
  /** set when the playlist was imported from an artist drop — clicking it
      opens the artist page and the artist's photo stands in as cover */
  artistId?: string;
  artistThumb?: string;
  /** the picture chosen for it, a small data: image that travels with it */
  cover?: string;
}

/** An artist the user dropped into their library — a follow, not a playlist. */
export interface FollowedArtist {
  id: string;
  name: string;
  thumb?: string;
  followedAt: number;
}

/** A user-created library folder that groups playlists. */
export interface LibraryFolder {
  id: string;
  name: string;
  createdAt: number;
}

/** `removed`: taken off by hand ("Remove download"); neither the check at start nor a kept list brings it back. */
export type DownloadStatus = "queued" | "downloading" | "done" | "failed" | "removed";

export interface DownloadItem {
  track: Track;
  path: string | null;
  status: DownloadStatus;
  /** 0..1, only meaningful while downloading */
  progress: number;
  downloaded: number;
  total: number;
}

/** Pinnable library shortcuts — Liked Songs, Downloads, Local Music. */
export type PinnedSingleKey = "liked" | "downloads" | "local";

interface LibraryState {
  liked: Track[];
  playlists: Playlist[];
  folders: LibraryFolder[];
  /** artists the user dropped into their library */
  followedArtists: FollowedArtist[];
  history: Track[];
  downloads: Record<string, DownloadItem>;
  /** pin state for the Liked / Downloads / Local shortcut rows — all pinned by default */
  pinnedSingles: Record<PinnedSingleKey, boolean>;
  /** deletion/version metadata replicated with the library (see deletion-sync.ts) */
  deletionSync?: DeletionSync;

  isLiked(id: string): boolean;
  toggleLike(track: Track): void;
  /**
   * likes brought over from another service, in its order — `previous` are the
   * song ids the last import brought; returns how many songs are newly liked
   */
  importLikes(tracks: Track[], previous?: string[]): number;
  /** Server sync (lib/serverSync.ts): likes from the servers' favorites, and the ones taken back there. */
  applyServerLikes(top: Track[], bottom: Track[], remove: string[]): void;
  togglePinSingle(key: PinnedSingleKey): void;
  createPlaylist(name: string): Playlist;
  renamePlaylist(id: string, name: string): void;
  /** the picture chosen for a playlist; null goes back to its songs' covers */
  setPlaylistCover(id: string, cover: string | null): void;
  togglePinPlaylist(id: string): void;
  deletePlaylist(id: string): void;
  addToPlaylist(playlistId: string, track: Track): boolean;
  /** a playlist's songs in a new order and makeup — one brought over from another service */
  setPlaylistTracks(playlistId: string, tracks: Track[]): void;
  removeFromPlaylist(playlistId: string, trackId: string): void;
  getPlaylist(id: string): Playlist | null;
  createFolder(name: string): LibraryFolder;
  renameFolder(id: string, name: string): void;
  deleteFolder(id: string): void;
  setPlaylistFolder(playlistId: string, folderId: string | null): void;
  pushHistory(track: Track): void;
  clearHistory(): void;
  setDownload(id: string, item: DownloadItem): void;
  patchDownload(id: string, patch: Partial<DownloadItem>): void;
  removeDownload(id: string): void;
}

/** A song is liked once: of repeated entries the first stays. */
function uniqueById(list: Track[]): Track[] {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(t.id) && !!seen.add(t.id));
}

/** The liked ids as a Set, rebuilt only when the liked list changes — rows ask "liked?" in O(1). */
let likedSetMemo: { list: Track[]; ids: Set<string> } | null = null;
export function likedIdSet(list: Track[]): Set<string> {
  if (likedSetMemo?.list !== list) likedSetMemo = { list, ids: new Set(list.map((t) => t.id)) };
  return likedSetMemo.ids;
}

function uid(): string {
  return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

let hydrationLikes: Map<string, { track: Track; liked: boolean }> | null = null;
let hydrationHistory: Array<Track | null> | null = null;

/** Membership and its version must persist atomically in the same write. */
function withChanges(
  set: (partial: Partial<LibraryState>) => void,
  get: () => LibraryState,
  next: Partial<LibraryState>,
  changes: DeletionChange[]
): void {
  set({ ...next, deletionSync: recordDeletionChanges(get(), next, changes) });
}

export const useLibrary = create<LibraryState>()(
  persist(
    (set, get) => ({
      liked: [],
      playlists: [],
      folders: [],
      followedArtists: [],
      history: [],
      downloads: {},
      pinnedSingles: { liked: true, downloads: true, local: true },

      togglePinSingle(key) {
        const current = get().pinnedSingles ?? { liked: true, downloads: true, local: true };
        set({ pinnedSingles: { ...current, [key]: !current[key] } });
      },

      isLiked(id) {
        return get().liked.some((t) => t.id === id);
      },

      toggleLike(track) {
        const { liked } = get();
        const wasLiked = liked.some((t) => t.id === track.id);
        // Replay the desired value, not a toggle against the restored value.
        hydrationLikes?.set(track.id, { track, liked: !wasLiked });
        if (wasLiked) {
          withChanges(set, get, { liked: liked.filter((t) => t.id !== track.id) },
            [{ kind: "delete", group: "liked", id: track.id }]);
        } else {
          withChanges(set, get, { liked: [track, ...liked] },
            [{ kind: "add", group: "liked", id: track.id }]);
        }
      },

      importLikes(tracks, previous = []) {
        // The import's order, newest first, one copy per song. Songs liked
        // here that no import brought stay on top — they're the newer likes;
        // songs an earlier import brought that this one no longer holds go
        // to the bottom. A song liked here as its other copy (the Jellyfin
        // one, say) is the same like: the imported copy takes its place.
        // Two entries of an import can lead to one song here (a remaster and
        // the original, a song picked by hand): the first one counts.
        const { liked } = get();
        const importedSongs = new Set<string>();
        const imported = tracks.filter((t) => !importedSongs.has(songKey(t.id)) && !!importedSongs.add(songKey(t.id)));
        const importedKeys = new Set(imported.map((t) => songKey(t.id)));
        const importedIds = new Set(imported.map((t) => t.id));
        const previousKeys = new Set(previous.map(songKey));
        const likedKeys = new Set(liked.map((t) => songKey(t.id)));
        const likedIds = new Set(liked.map((t) => t.id));
        const others = liked.filter((t) => !importedKeys.has(songKey(t.id)));
        const ownLikes = others.filter((t) => !previousKeys.has(songKey(t.id)));
        const earlierImports = others.filter((t) => previousKeys.has(songKey(t.id)));
        const replaced = liked.filter((t) => importedKeys.has(songKey(t.id)) && !importedIds.has(t.id));
        const added = imported.filter((t) => !likedIds.has(t.id));
        for (const t of imported) hydrationLikes?.set(t.id, { track: t, liked: true });
        for (const t of replaced) hydrationLikes?.set(t.id, { track: t, liked: false });
        withChanges(set, get, { liked: uniqueById([...ownLikes, ...imported, ...earlierImports]) }, [
          ...added.map((t): DeletionChange => ({ kind: "add", group: "liked", id: t.id })),
          ...replaced.map((t): DeletionChange => ({ kind: "delete", group: "liked", id: t.id })),
        ]);
        return imported.filter((t) => !likedKeys.has(songKey(t.id))).length;
      },

      applyServerLikes(top, bottom, remove) {
        // Favorites made on a server: new ones on top like any new like, a
        // server's first sync below (its favorites have no order to keep);
        // favorites taken back there leave. One copy per song.
        const { liked } = get();
        const gone = new Set(remove);
        const kept = liked.filter((t) => !gone.has(t.id));
        const have = new Set(kept.map((t) => songKey(t.id)));
        const fresh = (list: Track[]): Track[] =>
          list.filter((t) => !have.has(songKey(t.id)) && !!have.add(songKey(t.id)));
        const above = fresh(top);
        const below = fresh(bottom);
        const dropped = liked.filter((t) => gone.has(t.id));
        if (!above.length && !below.length && !dropped.length) return;
        for (const t of [...above, ...below]) hydrationLikes?.set(t.id, { track: t, liked: true });
        for (const t of dropped) hydrationLikes?.set(t.id, { track: t, liked: false });
        withChanges(set, get, { liked: [...above, ...kept, ...below] }, [
          ...[...above, ...below].map((t): DeletionChange => ({ kind: "add", group: "liked", id: t.id })),
          ...dropped.map((t): DeletionChange => ({ kind: "delete", group: "liked", id: t.id })),
        ]);
      },

      createPlaylist(name) {
        const playlist: Playlist = { id: uid(), name: name.trim() || T("New Playlist"), tracks: [], createdAt: Date.now() };
        withChanges(set, get, { playlists: [playlist, ...get().playlists] },
          [{ kind: "add", group: "playlists", id: playlist.id }]);
        return playlist;
      },

      renamePlaylist(id, name) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      setPlaylistCover(id, cover) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => {
            if (p.id !== id) return p;
            const { cover: _old, ...rest } = p;
            return cover ? { ...rest, cover } : rest;
          }),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      togglePinPlaylist(id) {
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === id ? { ...p, pinned: !p.pinned } : p)),
        }, [{ kind: "edit", group: "playlists", id }]);
      },

      deletePlaylist(id) {
        const deleted = get().playlists.find((p) => p.id === id);
        const changes: DeletionChange[] = [{ kind: "delete", group: "playlists", id }];
        // Keep explicit child deletions too, in case this id is later recreated.
        for (const track of deleted?.tracks ?? []) changes.push({ kind: "delete", group: "tracks", id: track.id, parent: id });
        withChanges(set, get, { playlists: get().playlists.filter((p) => p.id !== id) }, changes);
      },

      addToPlaylist(playlistId, track) {
        const playlists = get().playlists.map((p) => {
          if (p.id !== playlistId) return p;
          if (p.tracks.some((t) => t.id === track.id)) return p;
          return { ...p, tracks: [...p.tracks, track] };
        });
        const target = get().playlists.find((p) => p.id === playlistId);
        const dup = target?.tracks.some((t) => t.id === track.id) ?? false;
        if (!target || dup) return false;
        withChanges(set, get, { playlists },
          [{ kind: "add", group: "tracks", id: track.id, parent: playlistId }]);
        return true;
      },

      setPlaylistTracks(playlistId, tracks) {
        const target = get().playlists.find((p) => p.id === playlistId);
        if (!target) return;
        const next = uniqueById(tracks);
        const had = new Set(target.tracks.map((t) => t.id));
        const kept = new Set(next.map((t) => t.id));
        const changes: DeletionChange[] = [{ kind: "edit", group: "playlists", id: playlistId }];
        for (const t of next) if (!had.has(t.id)) changes.push({ kind: "add", group: "tracks", id: t.id, parent: playlistId });
        for (const t of target.tracks) if (!kept.has(t.id)) changes.push({ kind: "delete", group: "tracks", id: t.id, parent: playlistId });
        withChanges(set, get, { playlists: get().playlists.map((p) => (p.id === playlistId ? { ...p, tracks: next } : p)) }, changes);
      },

      removeFromPlaylist(playlistId, trackId) {
        const target = get().playlists.find((p) => p.id === playlistId);
        if (!target || !target.tracks.some((t) => t.id === trackId)) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) =>
            p.id === playlistId ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p
          ),
        }, [{ kind: "delete", group: "tracks", id: trackId, parent: playlistId }]);
      },

      getPlaylist(id) {
        return get().playlists.find((p) => p.id === id) ?? null;
      },

      createFolder(name) {
        const folder: LibraryFolder = { id: uid(), name: name.trim() || T("New Folder"), createdAt: Date.now() };
        withChanges(set, get, { folders: [...get().folders, folder] },
          [{ kind: "add", group: "folders", id: folder.id }]);
        return folder;
      },

      renameFolder(id, name) {
        withChanges(set, get, {
          folders: get().folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)),
        }, [{ kind: "edit", group: "folders", id }]);
      },

      deleteFolder(id) {
        if (!get().folders.some((f) => f.id === id)) return;
        // The folder goes; its playlists come back to the top level.
        withChanges(set, get, {
          folders: get().folders.filter((f) => f.id !== id),
          playlists: get().playlists.map((p) => (p.folderId === id ? { ...p, folderId: undefined } : p)),
        }, [{ kind: "delete", group: "folders", id }]);
      },

      setPlaylistFolder(playlistId: string, folderId: string | null) {
        const target = get().playlists.find((p) => p.id === playlistId);
        const nextFolderId = folderId ?? undefined;
        if (target?.folderId === nextFolderId) return;
        withChanges(set, get, {
          playlists: get().playlists.map((p) => (p.id === playlistId ? { ...p, folderId: nextFolderId } : p)),
        }, [{ kind: "edit", group: "playlists", id: playlistId }]);
      },

      pushHistory(track) {
        hydrationHistory?.push(track);
        const rest = get().history.filter((t) => t.id !== track.id);
        withChanges(set, get, { history: [track, ...rest].slice(0, 200) },
          [{ kind: "add", group: "history", id: track.id }]);
      },

      clearHistory() {
        hydrationHistory?.push(null);
        withChanges(set, get, { history: [] }, [{ kind: "clear", group: "history" }]);
      },

      setDownload(id, item) {
        set({ downloads: { ...get().downloads, [id]: item } });
      },

      patchDownload(id, patch) {
        const existing = get().downloads[id];
        if (!existing) return;
        set({ downloads: { ...get().downloads, [id]: { ...existing, ...patch } } });
      },

      removeDownload(id) {
        const next = { ...get().downloads };
        delete next[id];
        set({ downloads: next });
      },
    }),
    {
      name: "library",
      // Coalesced and lazily serialized like the player store: download
      // progress patches the downloads registry several times a second, and
      // the whole library (liked + playlists + history + the full Track
      // objects) is only stringified when a write actually lands — at most
      // every 2 s. Pending writes still flush on pagehide/beforeunload, so
      // close-time durability is unchanged.
      storage: lazyJSONStorage<LibraryState>(),
      version: 1,
      onRehydrateStorage: () => {
        const likes = hydrationLikes ?? new Map<string, { track: Track; liked: boolean }>();
        const history = hydrationHistory ?? [];
        hydrationLikes = likes;
        hydrationHistory = history;
        return (state) => {
          if (hydrationLikes !== likes) return;
          hydrationLikes = null;
          hydrationHistory = null;
          if (!state) return;
          if (likes.size === 0 && history.length === 0) {
            // 1.0.4's import could like one song twice; the same id twice is the
            // same like, so membership (and its sync metadata) stays as it is.
            const liked = uniqueById(state.liked ?? []);
            if (liked.length !== (state.liked ?? []).length) useLibrary.setState({ liked });
            return;
          }
          // Hydration replaced the intermediate metadata too. Replay explicit
          // user intents against the restored clock, preserving their order.
          // These are real buffered actions, not newly inferred additions.
          let replay = state;
          for (const action of likes.values()) {
            const rest = replay.liked.filter((track) => track.id !== action.track.id);
            const next = { liked: action.liked ? [action.track, ...rest] : rest };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [{ kind: action.liked ? "add" : "delete", group: "liked", id: action.track.id }]) };
          }
          for (const track of history) {
            const next = { history: track === null ? [] : [track, ...replay.history.filter((item) => item.id !== track.id)].slice(0, 200) };
            replay = { ...replay, ...next, deletionSync: recordDeletionChanges(replay, next,
              [track === null ? { kind: "clear", group: "history" } : { kind: "add", group: "history", id: track.id }]) };
          }
          useLibrary.setState({ liked: uniqueById(replay.liked), history: replay.history, deletionSync: replay.deletionSync });
        };
      },
      migrate: (persisted: unknown, version: number) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 1 || state.pinnedSingles == null) {
          return {
            ...state,
            pinnedSingles: { liked: true, downloads: true, local: true },
          } as unknown as LibraryState;
        }
        return state as unknown as LibraryState;
      },
    }
  )
);
