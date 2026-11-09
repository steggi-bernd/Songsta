/**
 * The album edits on this phone (lib/albumEdits.ts), what the computer's album editor does: an
 * album's name, picture and artists, albums merged into one, songs put on an album by hand,
 * artists' other spellings. They travel between the devices (lib/librarySync.ts) and never touch
 * the files or the server. Each change keeps its moment, so the later one wins wherever it was
 * made. A picture is a file on the phone and travels as a small JPEG.
 */
import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";
import { EDIT_FIELDS, restamp, withAlias, withMerge, withSplit, type AlbumEdits, type EditStamps, type EditValues, type SongEdit, type Track } from "../shared";
import { readJson, removeJson, writeJson } from "../storage";
import { useLibrarySync } from "./librarySync";

const FILE = "album-edits.json";
const PICTURES = "album-pictures";

interface Saved extends AlbumEdits {
  /** when each edit was made or taken back, by field and key */
  stamps: EditStamps;
  /** when each album's picture was chosen or taken away */
  coverStamps: Record<string, number>;
}

interface AlbumEditsState extends Saved {
  restored: boolean;
  restore(): Promise<void>;
  /** an album's artist line ("A, B"); null goes back to its tags */
  setArtists(key: string, credit: string | null): void;
  merge(from: string, into: string): void;
  split(from: string): void;
  /** an artist's name shown as another spelling; null shows it as tagged again */
  setAlias(name: string, as: string | null): void;
  /** songs put on an album by hand, by song id */
  setSongs(edits: Record<string, SongEdit>): void;
  clearSongs(ids: string[]): void;
  /** the name an album is shown under; null goes back to its tags */
  setTitle(key: string, title: string | null): void;
  /** a picture chosen here, as the picker gives it (a data: JPEG); null goes back to the songs' own */
  setCover(key: string, data: string | null): void;
  /** What another device changed: the edits and their moments as they came. */
  adopt(edits: EditValues, stamps: EditStamps): void;
  /** Another device's picture for an album, or its taking one away. */
  adoptCover(key: string, data: string | null, at: number): void;
  /** An album's picture as it travels; null when it can't be read. */
  coverData(key: string): string | null;
  clear(): void;
}

const NONE: Saved = { artists: {}, mergedInto: {}, aliases: {}, songs: {}, titles: {}, covers: {}, stamps: {}, coverStamps: {} };

/** The pictures' data as read from their files, by file: they don't change once written. */
const pictureData = new Map<string, string>();

function save(): void {
  const { artists, mergedInto, aliases, songs, titles, covers, stamps, coverStamps } = useAlbumEdits.getState();
  writeJson(FILE, { artists, mergedInto, aliases, songs, titles, covers, stamps, coverStamps } satisfies Saved);
}

/** A short name from an album key, for its picture's file. */
function nameOf(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function bytesOf(data: string): Uint8Array {
  const raw = atob(data.slice(data.indexOf(",") + 1));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The picture written to the phone; its address, or null when it couldn't be. A new picture is a new file, so no cache shows the old one. */
function writePicture(key: string, data: string, at: number): string | null {
  try {
    const dir = new Directory(Paths.document, PICTURES);
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
    const file = new File(dir, `${nameOf(key)}-${at}.jpg`);
    if (file.exists) file.delete();
    // Written now, not later: the address is shown at once.
    file.writeSync(bytesOf(data));
    pictureData.set(file.uri, data);
    return file.uri;
  } catch {
    return null;
  }
}

/** A backup's picture for an album, put back (phoneBackup.ts) as one chosen here: its address, or null. */
export const writeAlbumPicture = writePicture;

function dropPicture(uri: string | undefined): void {
  if (!uri) return;
  pictureData.delete(uri);
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    /* gone already */
  }
}

let restoring: Promise<void> | null = null;

export const useAlbumEdits = create<AlbumEditsState>((set, get) => {
  /** A change made here: what it changed gets its moment, and it's kept. */
  function edit(next: Partial<EditValues>): void {
    const before = get();
    const at = useLibrarySync.getState().stamp();
    const stamps = { ...before.stamps };
    for (const field of EDIT_FIELDS) {
      if (next[field] !== undefined && next[field] !== before[field]) stamps[field] = restamp<unknown>(before[field], next[field], stamps[field], at);
    }
    set({ ...next, stamps });
    save();
  }

  return {
    ...NONE,
    restored: false,
    restore() {
      restoring ??= Promise.all([readJson<Partial<Saved>>(FILE), useLibrarySync.getState().restore()]).then(([saved]) => {
        set({ ...NONE, ...saved, restored: true });
      });
      return restoring;
    },
    setArtists(key, credit) {
      const artists = { ...get().artists };
      const clean = credit?.trim();
      if (clean) artists[key] = clean;
      else delete artists[key];
      edit({ artists });
    },
    merge(from, into) {
      edit({ mergedInto: withMerge(get().mergedInto, from, into) });
    },
    split(from) {
      edit({ mergedInto: withSplit(get().mergedInto, from) });
    },
    setAlias(name, as) {
      edit({ aliases: withAlias(get().aliases, name, as) });
    },
    setSongs(edits) {
      edit({ songs: { ...get().songs, ...edits } });
    },
    clearSongs(ids) {
      const songs = { ...get().songs };
      for (const id of ids) delete songs[id];
      edit({ songs });
    },
    setTitle(key, title) {
      const titles = { ...get().titles };
      const clean = title?.trim();
      if (clean) titles[key] = clean;
      else delete titles[key];
      edit({ titles });
    },
    setCover(key, data) {
      const at = useLibrarySync.getState().stamp();
      const { covers, coverStamps } = get();
      const uri = data ? writePicture(key, data, at) : null;
      if (data && !uri) return;
      const next = { ...covers };
      dropPicture(covers[key]);
      if (uri) next[key] = uri;
      else delete next[key];
      set({ covers: next, coverStamps: { ...coverStamps, [key]: at } });
      save();
    },
    adopt(edits, stamps) {
      set({ ...edits, stamps });
      save();
    },
    adoptCover(key, data, at) {
      const { covers, coverStamps } = get();
      const uri = data ? writePicture(key, data, at) : null;
      // Not written: it stays as it was here, and comes again with the next look.
      if (data && !uri) return;
      const next = { ...covers };
      if (covers[key] !== uri) dropPicture(covers[key]);
      if (uri) next[key] = uri;
      else delete next[key];
      set({ covers: next, coverStamps: { ...coverStamps, [key]: at } });
      save();
    },
    coverData(key) {
      const uri = get().covers[key];
      if (!uri) return null;
      const known = pictureData.get(uri);
      if (known) return known;
      try {
        const data = `data:image/jpeg;base64,${new File(uri).base64Sync()}`;
        pictureData.set(uri, data);
        return data;
      } catch {
        return null;
      }
    },
    clear() {
      for (const uri of Object.values(get().covers)) dropPicture(uri);
      removeJson(FILE);
      set({ ...NONE });
    },
  };
});

/** A song whose tags name no album, on its way onto one (components/AlbumEditSheets.tsx): opened from its menu. */
export const usePutOnAlbum = create<{ track: Track | null; open(track: Track): void; close(): void }>((set) => ({
  track: null,
  open: (track) => set({ track }),
  close: () => set({ track: null }),
}));

/** The edits as the library applies them. */
export const albumEditsNow = (): AlbumEdits => {
  const { artists, mergedInto, aliases, songs, titles, covers } = useAlbumEdits.getState();
  return { artists, mergedInto, aliases, songs, titles, covers };
};
