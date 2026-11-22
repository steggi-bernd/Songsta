/**
 * Music in folders on this phone, as on the computer: one or several picked with
 * Android's picker, looked through, each file read once. The library store mixes
 * these songs in; a song the server has too stays one song and plays from the file.
 */
import { create } from "zustand";
import Player, { type LocalFileInfo } from "../../modules/media3-player";
import { albumRoute, libraryAlbumKey, type Track } from "../shared";
import { readJson, writeJson } from "../storage";
import { toast } from "./popups";
import { useSettings } from "./settings";
import { T } from "../shared";

const FILE = "local-music.json";

export interface LocalFolder {
  uri: string;
  name: string;
}

type LocalFile = LocalFileInfo & { folder: string };

interface LocalMusicState {
  restored: boolean;
  folders: LocalFolder[];
  files: LocalFile[];
  /** how far the look through the folders has come */
  scanning: { read: number; total: number } | null;
  /** the app is used with no server at all */
  withoutServer: boolean;
  /** on the way to the server's sign-in from Settings */
  addingServer: boolean;
  restore(): Promise<void>;
  /** Answers whether one was picked. */
  addFolder(): Promise<boolean>;
  removeFolder(uri: string): void;
  rescan(): Promise<void>;
  setWithoutServer(on: boolean): void;
  setAddingServer(on: boolean): void;
}

function save(): void {
  const { folders, files, withoutServer } = useLocalMusic.getState();
  writeJson(FILE, { folders, files, withoutServer });
}

/**
 * Each pick of a folder, by its uri: picked anew (also one taken out a moment ago), it's another pick.
 * A scan writes what it read only for the pick it read, into the files as they are by then; a folder
 * taken out or picked anew meanwhile keeps what's there now (plan section 4: a folder taken out during
 * its scan came back with the scan's old list, and one added meanwhile wasn't read at all).
 */
const picks = new Map<string, number>();
let pickCount = 0;
const pick = (uri: string): void => {
  picks.set(uri, ++pickCount);
};
/** A scan asked for while one runs: it runs again after, for what changed meanwhile. */
let scanAgain = false;

export const useLocalMusic = create<LocalMusicState>((set, get) => ({
  restored: false,
  folders: [],
  files: [],
  scanning: null,
  withoutServer: false,
  addingServer: false,

  async restore() {
    const saved = await readJson<{ folders?: LocalFolder[]; files?: LocalFile[]; withoutServer?: boolean }>(FILE).catch(() => null);
    for (const folder of saved?.folders ?? []) pick(folder.uri);
    set({ folders: saved?.folders ?? [], files: saved?.files ?? [], withoutServer: !!saved?.withoutServer, restored: true });
    // New and changed files since last time, in the background.
    if (saved?.folders?.length) void get().rescan();
  },

  async addFolder() {
    const picked = await Player.pickFolder().catch(() => null);
    if (!picked) return false;
    pick(picked.uri);
    if (!get().folders.some((f) => f.uri === picked.uri)) set({ folders: [...get().folders, picked] });
    save();
    void get().rescan();
    return true;
  },

  removeFolder(uri) {
    void Player.localForget(uri).catch(() => undefined);
    picks.delete(uri);
    set({ folders: get().folders.filter((f) => f.uri !== uri), files: get().files.filter((f) => f.folder !== uri) });
    save();
  },

  async rescan() {
    if (get().scanning) {
      scanAgain = true;
      return;
    }
    set({ scanning: { read: 0, total: 0 } });
    const progress = Player.addListener("onLocalScan", ({ read, total }) => set({ scanning: { read, total } }));
    try {
      do {
        scanAgain = false;
        for (const folder of [...get().folders]) {
          const reading = picks.get(folder.uri);
          const before = get().files.filter((f) => f.folder === folder.uri);
          const known: Record<string, number> = {};
          for (const f of before) known[f.uri] = f.modified;
          const byUri = new Map(before.map((f) => [f.uri, f]));
          const found = await Player.localScan(folder.uri, known);
          // Taken out, or picked anew, while it was read: what was read is from before.
          if (!get().folders.some((f) => f.uri === folder.uri) || picks.get(folder.uri) !== reading) continue;
          const now: LocalFile[] = [];
          for (const f of found) {
            if (f.unchanged) {
              const old = byUri.get(f.uri);
              if (old) now.push(old);
            } else now.push({ ...f, folder: folder.uri });
          }
          set({ files: [...get().files.filter((f) => f.folder !== folder.uri), ...now] });
          save();
        }
      } while (scanAgain);
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : T("A folder couldn't be read"));
    } finally {
      progress.remove();
      set({ scanning: null });
    }
  },

  setWithoutServer(withoutServer) {
    set({ withoutServer, addingServer: false });
    save();
  },

  setAddingServer: (addingServer) => set({ addingServer }),
}));

/* ------------------------------------------------------------- as songs */

const NON_MUSIC_PATHS = ["recordings", "voice recorder", "sound_recorder", "voicenotes", "whatsapp voice notes", "telegram", "screen recorder", "call recordings", "call_rec", "alarms", "notifications", "ringtones", "podcasts", "audiobooks"];
const NON_MUSIC_NAMES = ["voice", "recording", "record_", "call_", "memo", "note", "audio_", "clip"];

/** The computer's rule: clips, recordings and voice notes aren't music. */
function isNonMusic(path: string, name: string): boolean {
  const where = path.toLowerCase();
  if (NON_MUSIC_PATHS.some((part) => where.includes(part))) return true;
  const file = name.toLowerCase();
  return NON_MUSIC_NAMES.some((part) => file.startsWith(part) || file.includes(` ${part} `));
}

function hashOf(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 31);
  }
  return `${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`;
}

const clean = (text: string | null | undefined): string | undefined => text?.trim() || undefined;
const LOSSLESS = new Set(["flac", "wav"]);

function songOf(f: LocalFile): Track {
  const ext = f.name.includes(".") ? f.name.split(".").pop()?.toLowerCase() : undefined;
  const song: Track = {
    id: `local:${hashOf(f.uri)}`,
    title: clean(f.title) ?? f.name.replace(/\.[^.]+$/, ""),
    artist: clean(f.artist) ?? "Unknown artist",
    album: clean(f.album),
    albumArtist: clean(f.albumArtist),
    duration: Math.round(f.durationMs / 1000),
    thumb: f.cover ?? "",
    source: "local",
    localPath: f.uri,
    year: f.year ?? undefined,
    genre: clean(f.genre),
    trackNo: f.track ?? undefined,
    discNo: f.disc ?? undefined,
    addedAt: f.modified || undefined,
    bitrate: f.bitrate ?? undefined,
    sampleRate: f.sampleRate ?? undefined,
    bitsPerSample: f.bits ?? undefined,
    container: ext,
    lossless: ext ? LOSSLESS.has(ext) : undefined,
  };
  const key = libraryAlbumKey(song);
  return key ? { ...song, albumId: albumRoute(key) } : song;
}

/** The songs in the folders, as Settings wants them filtered. */
export function localSongs(): Track[] {
  const { files } = useLocalMusic.getState();
  const { filterNonMusic } = useSettings.getState();
  return (filterNonMusic ? files.filter((f) => !isNonMusic(f.path, f.name)) : files).map(songOf);
}

/** A server's song that's also in a folder: its id to the file. The library store works that out. */
let serverSongFiles = new Map<string, string>();
export function setServerSongFiles(files: Map<string, string>): void {
  serverSongFiles = files;
}

/** Where a song is on this phone, by way of the folders. */
export function fileOfSong(track: { id: string; localPath?: string }): string | undefined {
  return track.localPath ?? serverSongFiles.get(track.id);
}

/** A .lrc beside the song's file. */
export function lyricsFileOf(track: { id: string; localPath?: string }): string | undefined {
  const file = fileOfSong(track);
  return file ? useLocalMusic.getState().files.find((f) => f.uri === file)?.lyrics ?? undefined : undefined;
}
