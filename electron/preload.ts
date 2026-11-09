/** Preload — exposes a minimal, typed API to the renderer via contextBridge. */
import type { UpdateState } from "../src/lib/newVersion";
import type { HomeSyncInfo } from "./home-sync";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { Track } from "../src/types";
import type { DiscordStatus } from "./discord";
import type { StartupState } from "./startup";
import type { JellyfinStatus, JellyfinTrack, JellyfinUser } from "./jellyfin";
import type { SubsonicTrack } from "./subsonic";
import type { ArchiveImport } from "./archive-import";
import type { M3uEntry } from "./m3u";
import type { CastStatus, FoundDevice } from "./cast";
import type { ArtistImages, SongInfo } from "./song-info";
import type { ArtistPicture } from "./wikimedia";
import type { Listen, MomentScore } from "./listens";
import type { LyricMatch } from "./lyrics-index";
import type { SoundFacts } from "./sound-analysis";
import type { SoundStatus } from "./sound-library";

// The PiP window loads this same preload but its scope requests are rejected
// by design (main-window-only handler) — an eager invoke there would leave an
// unhandled rejection on every PiP open. The scope is captured lazily on the
// first read/write instead, and reads resolve to null if it can't be had.
let documentScopePromise: Promise<string> | null = null;
const documentScope = (): Promise<string> => {
  if (documentScopePromise === null) {
    documentScopePromise = ipcRenderer.invoke("data:scope") as Promise<string>;
    documentScopePromise.catch(() => {
      // Leave the cached promise rejected-free: retry on the next call (a
      // transient failure shouldn't poison the scope for the page lifetime).
      documentScopePromise = null;
    });
  }
  return documentScopePromise;
};

const api = {
  platform: process.platform,
  versions: {
    app: "1.5.0",
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
    node: process.versions.node ?? "",
  },

  getLyrics: (track: { id: string; title: string; artist: string; album?: string; duration?: number }) =>
    ipcRenderer.invoke("music:lyrics", track),
  playbackEvent: (event: { type: string; track?: unknown; positionSec: number; playedSec: number; deltaMs: number }) =>
    ipcRenderer.send("playback:event", event),
  statsSummary: (period: string) => ipcRenderer.invoke("stats:summary", period),
  /** all-time plays + last played per track id */
  statsPlayCounts: () =>
    ipcRenderer.invoke("stats:playcounts") as Promise<Record<string, { plays: number; lastAt: number }>>,
  localLibrary: () => ipcRenderer.invoke("library:get"),
  scanLibrary: (filterNonMusic = true) => ipcRenderer.invoke("library:scan", filterNonMusic),
  /** Folder watching on/off (new, changed and deleted files appear without a rescan). */
  setFolderWatch: (enabled: boolean) => ipcRenderer.invoke("library:watch", enabled),
  setLibraryFolders: (folders: string[]) => ipcRenderer.invoke("library:setFolders", folders),
  /** Import folders: a parent expands into itself + its music-bearing subfolders. */
  addLibraryFolders: (paths: string[]) => ipcRenderer.invoke("library:addFolders", paths),
  renameLibraryFolder: (folderPath: string, displayName: string) =>
    ipcRenderer.invoke("library:renameFolder", folderPath, displayName),
  removeLibraryFolder: (folderPath: string) => ipcRenderer.invoke("library:removeFolder", folderPath),
  libraryFolderStatuses: () => ipcRenderer.invoke("library:folderStatuses"),
  /** What can play right now: each imported folder's existence, and whether the servers answer (null = none connected). */
  libraryAvailability: () =>
    ipcRenderer.invoke("library:availability") as Promise<{
      folders: { path: string; exists: boolean }[];
      jellyfin: boolean | null;
      subsonic: boolean | null;
    }>,
  /** True when songs were read with an older scan schema — one rescan fills the new fields. */
  libraryNeedsRescan: () => ipcRenderer.invoke("library:needsRescan") as Promise<boolean>,
  localTrackUrl: (id: string) => ipcRenderer.invoke("library:trackurl", id),
  /** Why localTrackUrl answered null: "missing" | "ffmpeg-missing" | "transcode-failed". */
  localTrackError: (id: string) => ipcRenderer.invoke("library:trackerror", id) as Promise<string | null>,
  /** FFmpeg (needed for AIFF, ALAC, WMA, WavPack, APE, DSD): where it is and which version. */
  ffmpegStatus: (recheck = false) =>
    ipcRenderer.invoke("ffmpeg:status", recheck) as Promise<{ path: string | null; version: string | null }>,
  localArtBytes: (thumb: string) => ipcRenderer.invoke("library:artbytes", thumb),
  /** Background cover/album fills for the local library land here, batch by batch. */
  /** the mouse's back/forward buttons, where the system reports them as app commands (Windows) */
  onNavCommand: (cb: (dir: "back" | "forward") => void): (() => void) => {
    const listener = (_e: unknown, dir: "back" | "forward"): void => cb(dir);
    ipcRenderer.on("nav:command", listener as never);
    return () => ipcRenderer.removeListener("nav:command", listener as never);
  },
  onLibraryEnriched: (cb: (lib: unknown) => void): (() => void) => {
    const listener = (_e: unknown, lib: unknown): void => cb(lib);
    ipcRenderer.on("library:enriched", listener as never);
    return () => ipcRenderer.removeListener("library:enriched", listener as never);
  },
  getCanvas: (q: { title: string; artist: string; album?: string }) =>
    ipcRenderer.invoke("canvas:get", q),

  // Discord status (optional): the song playing now on the user's Discord profile
  discordConfigure: (enabled: boolean, clientId: string) =>
    ipcRenderer.invoke("discord:configure", enabled, clientId) as Promise<DiscordStatus>,
  discordStatus: () => ipcRenderer.invoke("discord:status") as Promise<DiscordStatus>,
  /** null clears it (paused, nothing playing); the main process spaces updates out */
  discordActivity: (
    activity: { title: string; artist: string; album: string; albumArtist: string; startedAt: number; endsAt: number; button: boolean } | null
  ) => ipcRenderer.send("discord:activity", activity),

  // Songsta at sign-in (Windows)
  startupState: () => ipcRenderer.invoke("startup:state") as Promise<StartupState>,
  setOpenAtLogin: (on: boolean) => ipcRenderer.invoke("startup:setOpenAtLogin", on) as Promise<StartupState>,

  // Open metadata (MusicBrainz · Cover Art Archive · iTunes · Wikidata/Wikipedia)
  metaArtist: (name: string) => ipcRenderer.invoke("meta:artist", name),
  /** The listening history, kept on this computer (electron/listens.ts): newest first, a page at a time; or all of it as CSV */
  /** songs by a line of their lyrics, from the lyrics already on this computer */
  searchLyrics: (query: string) => ipcRenderer.invoke("lyrics:search", query) as Promise<LyricMatch[]>,
  /** the sound analysis: its progress, its results by song id, the Settings switch, and word when more are measured */
  soundStatus: () => ipcRenderer.invoke("sound:status") as Promise<SoundStatus>,
  soundFacts: () => ipcRenderer.invoke("sound:facts") as Promise<Record<string, SoundFacts>>,
  setSoundAnalysis: (on: boolean) => ipcRenderer.invoke("sound:enabled", on),
  onSoundUpdated: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("sound:updated", listener);
    return () => ipcRenderer.removeListener("sound:updated", listener);
  },
  /** how much each song belongs to this moment of the day and week, from the listening history */
  listensMoment: () => ipcRenderer.invoke("listens:moment") as Promise<MomentScore[]>,
  listensPage: (before?: number, limit = 100) =>
    ipcRenderer.invoke("listens:page", before, limit) as Promise<{ listens: Listen[]; more: boolean; total: number }>,
  listensExport: () => ipcRenderer.invoke("listens:export") as Promise<{ path: string; count: number } | null>,
  /** About a song — its story and credits — and an artist's photo and banner (Genius, electron/song-info.ts) */
  metaSong: (title: string, artist: string) => ipcRenderer.invoke("meta:song", title, artist) as Promise<SongInfo | null>,
  metaArtistImages: (name: string) => ipcRenderer.invoke("meta:artistImages", name) as Promise<ArtistImages | null>,
  /** an artist's Wikimedia picture at banner size, with its size (electron/wikimedia.ts) */
  metaArtistPicture: (name: string) => ipcRenderer.invoke("meta:artistPicture", name) as Promise<ArtistPicture | null>,

  // Jellyfin server (token stays in the main process)
  jellyfinStatus: () => ipcRenderer.invoke("jellyfin:status"),
  /** the server's address away from home (a tunnel or proxy); empty takes it back */
  jellyfinSetAway: (address: string) => ipcRenderer.invoke("jellyfin:setAway", address) as Promise<JellyfinStatus>,
  /** home or away changed: the server's other address answers now */
  onJellyfinReach: (listener: (s: JellyfinStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: JellyfinStatus): void => listener(s);
    ipcRenderer.on("jellyfin:reach", handler);
    return () => ipcRenderer.removeListener("jellyfin:reach", handler);
  },
  jellyfinConnect: (input: { server: string; username?: string; password?: string; apiKey?: string }) =>
    ipcRenderer.invoke("jellyfin:connect", input),
  jellyfinDisconnect: () => ipcRenderer.invoke("jellyfin:disconnect"),
  jellyfinLibrary: () => ipcRenderer.invoke("jellyfin:library"),
  jellyfinRefresh: () => ipcRenderer.invoke("jellyfin:refresh"),
  /** the server's songs listed again (the relist at start): whether anything changed; null when they couldn't be listed */
  jellyfinRelist: () => ipcRenderer.invoke("jellyfin:relist") as Promise<boolean | null>,

  // AutoEQ headphone profiles (index cached for a week in the main process)
  autoEqSearch: (q: string) =>
    ipcRenderer.invoke("autoeq:search", q) as Promise<{ name: string; source: string; rig?: string; path: string }[]>,
  autoEqFetch: (p: string) => ipcRenderer.invoke("autoeq:fetch", p),

  // Navidrome / Subsonic server (only a hashed token is kept, in the main process)
  subsonicStatus: () => ipcRenderer.invoke("subsonic:status"),
  subsonicConnect: (input: { server: string; username: string; password: string }) =>
    ipcRenderer.invoke("subsonic:connect", input),
  subsonicDisconnect: () => ipcRenderer.invoke("subsonic:disconnect"),
  subsonicLibrary: () => ipcRenderer.invoke("subsonic:library"),
  subsonicRefresh: () => ipcRenderer.invoke("subsonic:refresh"),
  subsonicRelist: () => ipcRenderer.invoke("subsonic:relist") as Promise<boolean | null>,

  // The sync service: playlists and where playback stopped (lib/homeSync.ts); the login stays in the main process
  homeSyncInfo: () => ipcRenderer.invoke("homeSync:info") as Promise<HomeSyncInfo>,
  homeSyncSetAddress: (address: string) => ipcRenderer.invoke("homeSync:setAddress", address) as Promise<HomeSyncInfo>,
  homeSyncRequest: (method: "GET" | "PUT" | "POST", path: string, body?: unknown, timeoutMs?: number) =>
    ipcRenderer.invoke("homeSync:request", method, path, body, timeoutMs) as Promise<{ status: number; body: any }>,
  // Server sync: favorites ↔ Liked Songs, plays reported (what to change is decided in the renderer)
  jellyfinUsers: () => ipcRenderer.invoke("jellyfin:users") as Promise<JellyfinUser[]>,
  jellyfinSetSyncUser: (id: string | null) => ipcRenderer.invoke("jellyfin:setSyncUser", id) as Promise<JellyfinStatus>,
  serverFavorites: () =>
    ipcRenderer.invoke("server:favorites") as Promise<{
      jellyfin: { ok: boolean; tracks: JellyfinTrack[]; error?: string } | null;
      subsonic: { ok: boolean; tracks: SubsonicTrack[]; error?: string } | null;
    }>,
  serverSetFavorite: (id: string, favorite: boolean) => ipcRenderer.invoke("server:setFavorite", id, favorite) as Promise<void>,
  serverPlayed: (id: string, at: number) => ipcRenderer.invoke("server:played", id, at) as Promise<void>,
  serverNowPlaying: (id: string) => ipcRenderer.invoke("server:nowPlaying", id) as Promise<void>,

  // Window controls (frameless window — chrome drawn by the renderer)
  windowMinimize: () => ipcRenderer.send("window:minimize"),
  windowMaximizeToggle: () => ipcRenderer.send("window:maximizeToggle"),
  windowClose: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  setOverlayChrome: (visible: boolean) => ipcRenderer.invoke("window:setOverlayChrome", visible),
  setFullScreen: (fs: boolean) => ipcRenderer.invoke("window:setFullScreen", fs),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized);
    ipcRenderer.on("window:maximized", listener as never);
    return () => ipcRenderer.removeListener("window:maximized", listener as never);
  },
  onFullScreenChange: (cb: (fullscreen: boolean) => void): (() => void) => {
    const listener = (_e: unknown, fullscreen: boolean): void => cb(fullscreen);
    ipcRenderer.on("window:fullscreen", listener as never);
    return () => ipcRenderer.removeListener("window:fullscreen", listener as never);
  },

  // Native miniplayer (PiP) window — a separate always-on-top BrowserWindow.
  // The main window broadcasts playback snapshots and executes transport
  // commands; the PiP window renders them. Closing the PiP never touches
  // playback.
  pipToggle: () => ipcRenderer.invoke("pip:toggle"),
  pipIsOpen: () => ipcRenderer.invoke("pip:isOpen"),
  pipClose: () => ipcRenderer.send("pip:close"),
  // Real native minimize (the window stays alive and restorable from the
  // Windows taskbar) — playback and the main window are untouched.
  pipMinimize: () => ipcRenderer.send("pip:minimize"),
  pipShowMain: () => ipcRenderer.send("pip:show-main"),
  pipSendState: (snapshot: unknown) => ipcRenderer.send("pip:state", snapshot),
  pipSendCommand: (command: unknown) => ipcRenderer.send("pip:command", command),
  onPipState: (cb: (snapshot: unknown) => void): (() => void) => {
    const listener = (_e: unknown, snapshot: unknown): void => cb(snapshot);
    ipcRenderer.on("pip:state", listener as never);
    return () => ipcRenderer.removeListener("pip:state", listener as never);
  },
  onPipCommand: (cb: (command: unknown) => void): (() => void) => {
    const listener = (_e: unknown, command: unknown): void => cb(command);
    ipcRenderer.on("pip:command", listener as never);
    return () => ipcRenderer.removeListener("pip:command", listener as never);
  },
  onPipOpenChange: (cb: (open: boolean) => void): (() => void) => {
    const listener = (_e: unknown, open: boolean): void => cb(open);
    ipcRenderer.on("pip:open-changed", listener as never);
    return () => ipcRenderer.removeListener("pip:open-changed", listener as never);
  },
  onPipNeedState: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("pip:need-state", listener as never);
    return () => ipcRenderer.removeListener("pip:need-state", listener as never);
  },
  // Native cursor watch: the main process polls the OS pointer against the
  // PiP bounds — the one reliable inside/outside signal, because renderer
  // pointer events stop over the window's app-region drag pad.
  onPipCursorInside: (cb: (inside: boolean) => void): (() => void) => {
    const listener = (_e: unknown, inside: boolean): void => cb(inside);
    ipcRenderer.on("pip:cursor-inside", listener as never);
    return () => ipcRenderer.removeListener("pip:cursor-inside", listener as never);
  },

  // Persistence (JSON files in userData)
  readData: async (name: string) => {
    try {
      return await ipcRenderer.invoke("data:read", name, await documentScope());
    } catch {
      return null;
    }
  },
  writeData: async (name: string, data: unknown) => {
    const scope = await documentScope();
    return ipcRenderer.invoke("data:write", name, data, scope);
  },
  resetData: () => ipcRenderer.invoke("app:resetData"),

  // Backup export / import (native save/open pickers in main)
  backupExport: () => ipcRenderer.invoke("backup:export"),
  backupImport: () => ipcRenderer.invoke("backup:import"),

  // macOS application menu: commands flow menu → renderer, playback state
  // flows renderer → menu (checkmarks). No-ops on other platforms.
  onMenuCommand: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, command: string): void => cb(command);
    ipcRenderer.on("menu:command", listener as never);
    return () => ipcRenderer.removeListener("menu:command", listener as never);
  },
  menuPushState: (state: { playing: boolean; shuffle: boolean; repeat: "off" | "all" | "one" }) =>
    ipcRenderer.send("menu:push-state", state),

  /** The newest release's version number, asked of GitHub (lib/newVersion.ts); null without an answer. */
  latestVersion: () => ipcRenderer.invoke("app:latestVersion") as Promise<string | null>,
  updateState: () => ipcRenderer.invoke("update:state") as Promise<UpdateState>,
  startUpdate: () => ipcRenderer.invoke("update:start") as Promise<void>,
  installUpdate: () => ipcRenderer.invoke("update:install") as Promise<void>,
  onUpdateState: (callback: (state: UpdateState) => void) => {
    const listener = (_e: unknown, state: UpdateState): void => callback(state);
    ipcRenderer.on("update:state", listener as never);
    return () => ipcRenderer.removeListener("update:state", listener as never);
  },

  // Filesystem helpers
  pickFolder: () => ipcRenderer.invoke("app:pickFolder"),
  /** Keeps a picture chosen for an album; resolves to its localart:// address. */
  saveArtwork: (bytes: Uint8Array) => ipcRenderer.invoke("art:save", bytes) as Promise<string | null>,
  /** Save text the app composed (e.g. a CSV list) where the user picks; resolves to the path, or null if cancelled. */
  saveTextFile: (suggestedName: string, content: string) =>
    ipcRenderer.invoke("file:saveText", suggestedName, content) as Promise<string | null>,
  revealPath: (p: string) => ipcRenderer.invoke("app:revealPath", p),
  openPath: (p: string) => ipcRenderer.invoke("app:openPath", p),
  /** Casting to a network player (electron/cast.ts): find, start, load a song, steer, stop. */
  castFind: () => ipcRenderer.invoke("cast:find") as Promise<FoundDevice[]>,
  castStart: (id: string, session?: string) => ipcRenderer.invoke("cast:start", id, session) as Promise<CastStatus>,
  castLoad: (song: { id: string; title: string; artist: string; album?: string; duration: number; art?: string }, position: number, play: boolean, session?: string) =>
    ipcRenderer.invoke("cast:load", song, position, play, session) as Promise<void>,
  castControl: (action: "play" | "pause" | "seek" | "volume" | "mute", value = 0, session?: string, device?: string) =>
    ipcRenderer.invoke("cast:control", action, value, session, device) as Promise<void>,
  castJoin: (session: string, device: string) => ipcRenderer.invoke("cast:join", session, device) as Promise<void>,
  /** how far ahead each device plays in a group, in ms, set by hand */
  castPlayAhead: (map: Record<string, number>) => ipcRenderer.invoke("cast:playAhead", map) as Promise<void>,
  castLeave: (session: string, device: string) => ipcRenderer.invoke("cast:leave", session, device) as Promise<boolean>,
  castAgain: () => ipcRenderer.invoke("cast:again") as Promise<void>,
  devicePower: (id: string) => ipcRenderer.invoke("device:power", id) as Promise<{ on: boolean; input: string } | null>,
  deviceSwitchOff: (id: string) => ipcRenderer.invoke("device:switchOff", id) as Promise<boolean>,
  deviceCommand: (id: string, word: string) => ipcRenderer.invoke("device:command", id, word) as Promise<boolean>,
  tvPairStart: (id: string) => ipcRenderer.invoke("tv:pairStart", id) as Promise<void>,
  tvPairFinish: (code: string) => ipcRenderer.invoke("tv:pairFinish", code) as Promise<"ok" | "mistyped" | "refused" | "failed">,
  tvPairCancel: () => ipcRenderer.invoke("tv:pairCancel") as Promise<void>,
  tvPower: (id: string) => ipcRenderer.invoke("tv:power", id) as Promise<{ on: boolean; input: string; tv?: boolean; busy?: boolean } | null>,
  tvOff: (id: string) => ipcRenderer.invoke("tv:off", id) as Promise<boolean>,
  firewallMatters: () => ipcRenderer.invoke("firewall:matters") as Promise<boolean>,
  firewallHasRule: () => ipcRenderer.invoke("firewall:hasRule") as Promise<boolean>,
  firewallAllow: () => ipcRenderer.invoke("firewall:allow") as Promise<boolean>,
  castStop: (session?: string) => ipcRenderer.invoke("cast:stop", session) as Promise<void>,
  onCastStatus: (listener: (s: CastStatus) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, s: CastStatus): void => listener(s);
    ipcRenderer.on("cast:status", handler);
    return () => ipcRenderer.removeListener("cast:status", handler);
  },
  /** M3U playlists (electron/m3u.ts): a picked file's entries, paths resolved; or a written one. */
  openM3u: () => ipcRenderer.invoke("playlist:openM3u") as Promise<{ name: string; entries: M3uEntry[] } | null>,
  saveM3u: (suggestedName: string, content: string) =>
    ipcRenderer.invoke("playlist:saveM3u", suggestedName, content) as Promise<string | null>,
  /** Bought music: a store's ZIP, unpacked into a library folder (electron/archive-import.ts). */
  pickArchive: () => ipcRenderer.invoke("library:pickArchive") as Promise<string | null>,
  importArchive: (zipPath: string, folder: string) =>
    ipcRenderer.invoke("library:importArchive", zipPath, folder) as Promise<ArchiveImport>,
  /** A dropped file's path on disk ("" when it has none). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  // Downloads
  startDownload: (track: Track, dir?: string) => ipcRenderer.invoke("download:start", track, dir),
  cancelDownload: (id: string) => ipcRenderer.invoke("download:cancel", id),
  downloadQueue: () => ipcRenderer.invoke("download:queue"),
  /** of these offline copies, the ones gone from the disk (the check at start) */
  downloadsMissing: (paths: string[]) => ipcRenderer.invoke("download:missing", paths) as Promise<string[]>,
  /** "Remove download": the offline copy goes to the recycle bin */
  removeOfflineCopy: (path: string) => ipcRenderer.invoke("download:remove", path) as Promise<boolean>,
  onDownloadEvent: (cb: (e: { type: string; id: string; downloaded?: number; total?: number; path?: string; reason?: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { type: string; id: string }): void => cb(ev);
    ipcRenderer.on("download:event", listener as never);
    return () => ipcRenderer.removeListener("download:event", listener as never);
  },
};

contextBridge.exposeInMainWorld("bytune", api);

export type ByTuneApi = typeof api;
