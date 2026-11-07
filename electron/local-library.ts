/**
 * Local music library — folder scan, tags, artwork, and the non-music filter
 * for real desktop filesystems.
 *
 *  - scans the user's imported folders recursively for audio files
 *  - reads tags (title/artist/album/genre/duration/cover) with music-metadata,
 *    falling back to filename parsing when tags are empty
 *  - filters non-music audio: files under 30
 *    seconds, and recordings/voice-notes by path and name
 *  - extracts cover art once into userData/local-art and serves it to the
 *    renderer over the localart:// protocol
 *
 * Folders are entries, not bare strings, so ByTune can hold several
 * independent (and even nested/overlapping) roots with display metadata:
 * renaming a folder in ByTune only edits the entry — the directory on disk
 * is never renamed, moved or deleted, and removing a folder only drops its
 * index. The scan result is persisted in the `local-library` store, so the
 * view renders instantly from cache and only rescans on request.
 */
import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as persist from "./persist";
import { titleFromFile } from "./file-title";
import { foldPathCase, isUnderPath } from "./local-paths";
import { isoDate } from "./release-date";

export interface LocalTrack {
  /** stable id — hash of the absolute path */
  id: string;
  path: string;
  title: string;
  artist: string;
  album: string;
  genre?: string;
  duration: number;
  /** seconds, 0 = unknown */
  size: number;
  mtime: number;
  /** localart:// URL for the extracted cover, when one was found */
  art?: string;
  /** codec the tags report ("ALAC", "MPEG-4/AAC" …) — decides FFmpeg conversion */
  codec?: string;
  year?: number;
  albumArtist?: string;
  trackNo?: number;
  discNo?: number;
  /** songs on the release (TRACKTOTAL), when tagged */
  trackTotal?: number;
  /** MusicBrainz release type tags, space-separated ("album", "ep", "single", "album compilation" …) */
  releaseType?: string;
  /** first release year (ORIGINALYEAR) — a reissue's own year can be decades later */
  originalYear?: number;
  /** the release's day (RELEASEDATE, else DATE): "YYYY-MM-DD", or "YYYY-MM" / "YYYY" */
  date?: string;
  /** the first release's day (ORIGINALDATE) */
  originalDate?: string;
  /** ReplayGain 2.0 values (dB, linear peak), from the tags; Opus R128 tags converted */
  rg?: ReplayGainTags;
  sampleRate?: number;
  bitsPerSample?: number;
  /** bits per second */
  bitrate?: number;
  lossless?: boolean;
  /** when ByTune first saw the file (file creation time on the first scan) */
  addedAt?: number;
  /** scan schema the record was read with — older records are re-read once */
  v?: number;
}

export interface ReplayGainTags {
  trackGain?: number;
  trackPeak?: number;
  albumGain?: number;
  albumPeak?: number;
}

/** Bump when the scan reads new fields: unchanged files are then re-read once. */
const SCAN_VERSION = 5;

/**
 * A record that needs no new read: this scan's, or one of the previous
 * scan's that has an album — 5 only reads an untagged file's name better
 * (electron/file-title.ts), so just the songs without an album are read again.
 */
const isCurrent = (t: LocalTrack): boolean => t.v === SCAN_VERSION || (t.v === 4 && t.album !== "Unknown album");

/** ReplayGain from the tags; Opus files carry R128 gains (Q7.8 dB, −23 LUFS) instead. */
function readReplayGain(meta: import("music-metadata").IAudioMetadata): ReplayGainTags | undefined {
  const c = meta.common;
  const finite = (n: number | undefined): number | undefined => (typeof n === "number" && Number.isFinite(n) ? n : undefined);
  const rg: ReplayGainTags = {
    trackGain: finite(c.replaygain_track_gain?.dB),
    trackPeak: finite(c.replaygain_track_peak?.ratio),
    albumGain: finite(c.replaygain_album_gain?.dB),
    albumPeak: finite(c.replaygain_album_peak?.ratio),
  };
  if (rg.trackGain === undefined && rg.albumGain === undefined) {
    for (const tags of Object.values(meta.native ?? {})) {
      for (const tag of tags) {
        const id = String(tag.id).toUpperCase();
        const q78 = Number(tag.value);
        if (!Number.isFinite(q78)) continue;
        // R128 gains target −23 LUFS, ReplayGain 2.0 −18 LUFS: +5 dB aligns them.
        if (id === "R128_TRACK_GAIN") rg.trackGain = q78 / 256 + 5;
        if (id === "R128_ALBUM_GAIN") rg.albumGain = q78 / 256 + 5;
      }
    }
  }
  return Object.values(rg).some((v) => v !== undefined) ? rg : undefined;
}

export interface LocalFolderEntry {
  /** normalized absolute path on the user's machine — the reference only */
  path: string;
  /** the folder's own name at import time (fallback display name) */
  name: string;
  /** ByTune-only display name set by a rename; the disk folder is untouched */
  displayName?: string;
  /** 0 for entries carried over from the pre-1.1 single-folder format */
  addedAt: number;
}

export interface LocalLibrary {
  folders: LocalFolderEntry[];
  scannedAt: number;
  tracks: LocalTrack[];
}

export interface AddFoldersResult {
  lib: LocalLibrary;
  /** entries actually stored (picked roots + their music-bearing subfolders) */
  added: LocalFolderEntry[];
  /** inputs ignored: already imported, missing, or not a directory */
  skipped: string[];
}

export interface FolderStatus {
  path: string;
  exists: boolean;
}

// AIFF, ALAC, WMA, WavPack, APE and DSD play through an FFmpeg conversion
// (see transcode.ts); everything else Chromium decodes itself.
const AUDIO_EXT = new Set([
  ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus", ".wma", ".aiff", ".aif", ".aifc", ".alac",
  ".wv", ".ape", ".dsf", ".dff",
]);
const MIN_DURATION_SEC = 30;

/** Whether a file name has one of the indexed audio extensions. */
export function isAudioFileName(name: string): boolean {
  return AUDIO_EXT.has(path.extname(name).toLowerCase());
}
/** Hard ceiling on stored folder entries — protects against pathological picks. */
const MAX_FOLDERS = 200;
/** Same depth limit the scan walk uses. */
const MAX_WALK_DEPTH = 8;
/**
 * Path fragments that are recordings/voice notes/ringtones, not music —
 * the desktop port of mobile's ineligible-local-music gates (MediaStore
 * IS_ALARM/IS_NOTIFICATION/IS_RINGTONE/IS_PODCAST plus its path denylist).
 */
const NON_MUSIC_PATHS = [
  "recordings",
  "voice recorder",
  "sound_recorder",
  "voicenotes",
  "whatsapp voice notes",
  "telegram",
  "screen recorder",
  "call recordings",
  "call_rec",
  "alarms",
  "notifications",
  "ringtones",
  "podcasts",
  "audiobooks",
];
const NON_MUSIC_NAMES = ["voice", "recording", "record_", "call_", "memo", "note", "audio_", "clip"];

function hashPath(p: string): string {
  // Lower-cased off Linux, as it always was: every track id depends on it.
  return crypto.createHash("sha1").update(foldPathCase(p)).digest("hex").slice(0, 16);
}

/**
 * Canonical folder identity: absolute, separator-clean, compared with the
 * track-id hash's case rule (lowercase where the system ignores case —
 * erring toward "same folder" there can never create duplicate indexes).
 */
function normalizeFolderPath(p: string): string | null {
  if (typeof p !== "string" || !p.trim()) return null;
  try {
    const abs = path.resolve(p.trim());
    // A drive root must remain C:\\, never C: (which is drive-relative).
    const root = path.parse(abs).root;
    return abs.length === root.length ? root : abs.replace(/[\\/]+$/, "");
  } catch {
    return null;
  }
}

function folderKey(p: string): string {
  return foldPathCase(p);
}

function isNonMusic(relPath: string, fileName: string): boolean {
  const rp = relPath.toLowerCase();
  if (NON_MUSIC_PATHS.some((frag) => rp.includes(frag))) return true;
  const name = fileName.toLowerCase();
  return NON_MUSIC_NAMES.some((frag) => name.startsWith(frag) || name.includes(` ${frag} `));
}

/** Accept both the current entry shape and the legacy bare-string folders. */
function toFolderEntry(raw: unknown): LocalFolderEntry | null {
  if (typeof raw === "string") {
    const norm = normalizeFolderPath(raw);
    return norm ? { path: norm, name: path.basename(norm) || norm, addedAt: 0 } : null;
  }
  if (raw && typeof raw === "object") {
    const o = raw as { path?: unknown; name?: unknown; displayName?: unknown; addedAt?: unknown };
    const norm = normalizeFolderPath(typeof o.path === "string" ? o.path : "");
    if (!norm) return null;
    const entry: LocalFolderEntry = {
      path: norm,
      name: typeof o.name === "string" && o.name.trim() ? o.name : path.basename(norm) || norm,
      addedAt: typeof o.addedAt === "number" ? o.addedAt : 0,
    };
    if (typeof o.displayName === "string" && o.displayName.trim()) entry.displayName = o.displayName;
    return entry;
  }
  return null;
}

/**
 * Parsed-store cache. The hot path is local playback: every media range
 * request funnels through localTrackById → readLocalLibrary, and re-reading +
 * JSON.parsing the whole store file per request (seeks issue several) is pure
 * overhead. Writes update the cache directly; a generation bump (reset)
 * invalidates it.
 */
let cachedRawLibrary: LocalLibrary | null = null;
let cachedLibraryGeneration = -1;

function readRawLibrary(): LocalLibrary | null {
  if (cachedLibraryGeneration === libraryGeneration && cachedRawLibrary) return cachedRawLibrary;
  const raw = persist.readData("local-library") as LocalLibrary | null;
  cachedRawLibrary = raw && Array.isArray(raw.tracks) ? raw : null;
  cachedLibraryGeneration = libraryGeneration;
  return cachedRawLibrary;
}

export function readLocalLibrary(): LocalLibrary {
  const raw = readRawLibrary();
  if (raw && Array.isArray(raw.tracks)) {
    const byKey = new Map<string, LocalFolderEntry>();
    for (const f of (Array.isArray(raw.folders) ? raw.folders : []).map(toFolderEntry)) {
      if (f && !byKey.has(folderKey(f.path))) byKey.set(folderKey(f.path), f);
    }
    return {
      folders: [...byKey.values()],
      scannedAt: typeof raw.scannedAt === "number" ? raw.scannedAt : 0,
      tracks: raw.tracks,
    };
  }
  return { folders: [], scannedAt: 0, tracks: [] };
}

/**
 * Serialized store writes. Mutations must land in call order and the last
 * one must win — unordered overlapping writes could persist a stale snapshot
 * over a newer one, and a follow-up read (the scan re-reads the store) must
 * never race the write before it. Every mutator awaits its own save, so by
 * the time the IPC response reaches the renderer the disk copy is current.
 */
let writeChain: Promise<void> = Promise.resolve();
let mutationChain: Promise<unknown> = Promise.resolve();
let libraryGeneration = 0;

/** Serialize the entire read-modify-save, not just writes of stale snapshots. */
function mutateLibrary<T>(work: () => Promise<T>): Promise<T> {
  const generation = libraryGeneration;
  const result = mutationChain.catch(() => undefined).then(() => {
    checkGeneration(generation);
    return work();
  });
  mutationChain = result;
  return result;
}
function checkGeneration(generation: number): void {
  if (generation !== libraryGeneration) throw new Error("Local library operation cancelled by reset");
}
function saveLocalLibrary(lib: LocalLibrary, generation = libraryGeneration): Promise<void> {
  const write = writeChain.then(() => {
    checkGeneration(generation);
    return persist.writeData("local-library", lib);
  });
  writeChain = write.catch((err) => console.warn("[bytune] local-library save failed:", err));
  // A successful save IS the new on-disk state; keep the read cache hot
  // instead of re-parsing the file on the next local-media request.
  void write.then(() => {
    if (generation === libraryGeneration) {
      cachedRawLibrary = lib;
      cachedLibraryGeneration = generation;
    }
  });
  return write;
}

/**
 * Cancel scans and queued saves, and drain a save already writing to disk.
 * Call before persist.resetAppData(), with new IPC mutations blocked. A
 * metadata parser cannot be aborted, but its late result cannot extract art,
 * emit progress or save the old index. User folders/audio are never touched.
 */
export async function resetLocalLibrary(): Promise<void> {
  libraryGeneration += 1;
  await writeChain;
}

function newFolderEntry(norm: string): LocalFolderEntry {
  return { path: norm, name: path.basename(norm) || norm, addedAt: Date.now() };
}

/** Only real directories become entries — a removed drive or a typo must not. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether any music file sits anywhere under dir (depth-limited like scan). */
function containsAudio(dir: string, root: string, depth: number): boolean {
  if (depth > MAX_WALK_DEPTH) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (containsAudio(abs, root, depth + 1)) return true;
    } else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
      // An organization convenience only — a folder of recordings/voice
      // notes is not a music collection, so mirror the scan's path filter
      // here and never seed an entry the scan would leave empty.
      if (!isNonMusic(path.relative(root, abs).replace(/\\/g, "/"), e.name)) return true;
    }
  }
  return false;
}

/**
 * Immediate subfolders of root that contain music anywhere inside. Importing
 * a parent keeps its own entry (the aggregate) and additionally pins one
 * entry per music-bearing child; deeper structure stays inside those
 * collections — the scan is always recursive, so nothing is ever flattened
 * and no empty subfolder entries are created.
 */
function musicSubfolders(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || !e.isDirectory()) continue;
    const abs = path.join(root, e.name);
    if (containsAudio(abs, abs, 0)) out.push(abs);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

/**
 * Import folders for the Local library. A picked parent expands into itself
 * plus its immediate music-bearing subfolders, so one import can represent a
 * whole organized tree. Selecting the same folder twice is a no-op; a parent
 * and its child may BOTH be imported — the scan deduplicates the physical
 * files, and each collection scopes its own view.
 */
export function addLibraryFolders(paths: unknown): Promise<AddFoldersResult> {
  return mutateLibrary(() => addLibraryFoldersExclusive(paths));
}

async function addLibraryFoldersExclusive(paths: unknown): Promise<AddFoldersResult> {
  const lib = readLocalLibrary();
  const existing = new Set(lib.folders.map((f) => folderKey(f.path)));
  const added: LocalFolderEntry[] = [];
  const skipped: string[] = [];
  const list = Array.isArray(paths) ? paths.slice(0, MAX_FOLDERS) : [];

  const store = (norm: string): void => {
    const key = folderKey(norm);
    if (existing.has(key) || lib.folders.length >= MAX_FOLDERS) {
      skipped.push(norm);
      return;
    }
    const entry = newFolderEntry(norm);
    lib.folders.push(entry);
    existing.add(key);
    added.push(entry);
  };

  for (const raw of list) {
    const norm = normalizeFolderPath(typeof raw === "string" ? raw : "");
    if (!norm || !isDirectory(norm)) {
      if (norm) skipped.push(norm);
      continue;
    }
    const before = added.length;
    store(norm);
    if (added.length > before || existing.has(folderKey(norm))) {
      // Fresh root (or already present): recognize its music-bearing
      // subfolders as their own collections too.
      for (const sub of musicSubfolders(norm)) store(sub);
    }
  }

  if (added.length > 0) await saveLocalLibrary(lib);
  return { lib, added, skipped };
}

/**
 * Set a ByTune-only display name for an imported folder. Empty/blank clears
 * the custom name (back to the folder's own). Never touches the filesystem.
 */
export function renameLibraryFolder(p: string, displayName: unknown): Promise<LocalLibrary> {
  return mutateLibrary(() => renameLibraryFolderExclusive(p, displayName));
}

async function renameLibraryFolderExclusive(p: string, displayName: unknown): Promise<LocalLibrary> {
  const lib = readLocalLibrary();
  const norm = normalizeFolderPath(p);
  const entry = norm ? lib.folders.find((f) => folderKey(f.path) === folderKey(norm)) : undefined;
  if (entry) {
    const name = typeof displayName === "string" ? displayName.trim().slice(0, 80) : "";
    if (name) entry.displayName = name;
    else delete entry.displayName;
    await saveLocalLibrary(lib);
  }
  return lib;
}

/**
 * Drop a folder from the library: the entry goes and its tracks with it,
 * unless another remaining root still covers them (parent imported alongside
 * a child). The disk folder and its files are never touched.
 */
export function removeLibraryFolder(p: string): Promise<LocalLibrary> {
  return mutateLibrary(() => removeLibraryFolderExclusive(p));
}

async function removeLibraryFolderExclusive(p: string): Promise<LocalLibrary> {
  const lib = readLocalLibrary();
  const norm = normalizeFolderPath(p);
  if (!norm) return lib;
  const key = folderKey(norm);
  if (!lib.folders.some((f) => folderKey(f.path) === key)) return lib;
  lib.folders = lib.folders.filter((f) => folderKey(f.path) !== key);
  lib.tracks = lib.tracks.filter((t) => lib.folders.some((f) => isUnderPath(t.path, f.path)));
  await saveLocalLibrary(lib);
  return lib;
}

/**
 * Existence of each imported folder's directory — the renderer marks moved/
 * deleted/unmounted roots instead of crashing on them.
 */
export function folderStatuses(): FolderStatus[] {
  return readLocalLibrary().folders.map((f) => ({ path: f.path, exists: isDirectory(f.path) }));
}

/** Records read with an older scan schema: one rescan fills in the fields they lack. */
export function hasStaleScanRecords(): boolean {
  return readLocalLibrary().tracks.some((t) => !isCurrent(t));
}

/** Legacy replace-all shape (pre-multi-folder callers). Entries are reused so a re-set never wipes display names. */
export function setLibraryFolders(folders: string[]): Promise<LocalLibrary> {
  return mutateLibrary(() => setLibraryFoldersExclusive(folders));
}

async function setLibraryFoldersExclusive(folders: string[]): Promise<LocalLibrary> {
  const lib = readLocalLibrary();
  const byKey = new Map(lib.folders.map((f) => [folderKey(f.path), f]));
  const next: LocalFolderEntry[] = [];
  for (const f of Array.isArray(folders) ? folders : []) {
    const norm = normalizeFolderPath(typeof f === "string" ? f : "");
    if (!norm || !isDirectory(norm)) continue;
    const key = folderKey(norm);
    if (next.some((e) => folderKey(e.path) === key)) continue;
    next.push(byKey.get(key) ?? newFolderEntry(norm));
  }
  lib.folders = next;
  lib.tracks = lib.tracks.filter((t) => next.some((e) => isUnderPath(t.path, e.path)));
  await saveLocalLibrary(lib);
  return lib;
}

/** Extract the cover; a changed file re-extracts instead of reusing stale art. */
let artDirEnsured = false;
function extractArt(
  hash: string,
  picture: { data: Uint8Array; format: string } | undefined,
  refresh: boolean
): string | undefined {
  // A crafted APIC frame can be hundreds of MB — hard-cap the extracted cover
  // so one hostile file cannot blow up main-process memory or the disk cache.
  const MAX_ART_BYTES = 8 * 1024 * 1024;
  if (!picture?.data?.length || picture.data.length > MAX_ART_BYTES) return undefined;
  try {
    const dir = path.join(app.getPath("userData"), "local-art");
    // One mkdir per process, not one per parsed track — the directory only
    // disappears if something deletes it while we hold userData.
    if (!artDirEnsured) {
      fs.mkdirSync(dir, { recursive: true });
      artDirEnsured = true;
    }
    const ext = picture.format.includes("png") ? "png" : "jpg";
    const file = path.join(dir, `${hash}.${ext}`);
    if (refresh) {
      for (const e of ["jpg", "png"]) {
        try {
          fs.unlinkSync(path.join(dir, `${hash}.${e}`));
        } catch {
          /* absent */
        }
      }
    }
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(picture.data));
    return `localart://${hash}.${ext}`;
  } catch {
    return undefined;
  }
}

export async function scanLibrary(
  filterNonMusic: boolean,
  onProgress?: (done: number, total: number) => void
): Promise<LocalLibrary> {
  const generation = libraryGeneration;
  const existing = readLocalLibrary();
  const folders = existing.folders;
  const files: { abs: string; rel: string }[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_WALK_DEPTH) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(abs, depth + 1);
        } else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
          // One physical file reachable through two imported roots (a parent
          // and its child both added) is indexed once.
          const key = foldPathCase(abs);
          if (seen.has(key)) continue;
          seen.add(key);
          files.push({ abs, rel: path.relative(folder.path, abs) });
        }
      }
    };
    try {
      walk(folder.path, 0);
    } catch {
      /* unreadable folder → skip */
    }
  }

  const { parseFile } = await import("music-metadata");
  checkGeneration(generation);
  const tracks: LocalTrack[] = [];

  /**
   * Tag duration in whole seconds. `music-metadata` reports NaN (not
   * undefined) for files with damaged or absent headers, and `?? 0` does not
   * catch NaN — a NaN duration serializes to JSON `null`, which would make
   * the song unreadable wherever it travels.
   */
  const parsedDuration = (value: number | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;

  const prevByPath = new Map(existing.tracks.map((t) => [t.path, t]));
  let done = 0;
  for (const f of files) {
    checkGeneration(generation);
    done++;
    if (onProgress && done % 10 === 0) onProgress(done, files.length);
    const prev = prevByPath.get(f.abs);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(f.abs);
    } catch {
      continue;
    }
    // Unchanged since the last scan — carry the previous record forward
    // (records from an older scan schema are re-read once for the new fields).
    const unchanged = !!prev && prev.mtime === Math.floor(stat.mtimeMs);
    if (prev && unchanged && isCurrent(prev)) {
      tracks.push(prev);
      continue;
    }
    const nameParts = titleFromFile(path.basename(f.abs));
    let track: LocalTrack = {
      id: `local:${hashPath(f.abs)}`,
      path: f.abs,
      title: nameParts.title || path.basename(f.abs),
      artist: nameParts.artist ?? "Unknown artist",
      album: "Unknown album",
      trackNo: nameParts.trackNo,
      duration: 0,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      addedAt: prev?.addedAt ?? Math.floor(stat.birthtimeMs || stat.mtimeMs),
      v: SCAN_VERSION,
    };
    try {
      const meta = await parseFile(f.abs, { duration: true, skipCovers: false });
      checkGeneration(generation);
      const c = meta.common;
      // Tag text is untrusted (crafted ID3 frames can be multi-MB); bound every
      // string that lands in the persisted store.
      const bounded = (value: string | undefined): string | undefined =>
        typeof value === "string" ? value.slice(0, 200) : undefined;
      const num = (n: number | null | undefined): number | undefined =>
        typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
      const art = extractArt(hashPath(f.abs), c.picture?.[0], true);
      const album = bounded(c.album?.trim());
      track = {
        ...track,
        title: bounded(c.title?.trim()) || track.title,
        artist: bounded(c.artist?.trim()) || bounded(c.albumartist?.trim()) || track.artist,
        // A schema re-read keeps what open metadata filled in for an unchanged file.
        album: album || (unchanged ? prev?.album : undefined) || track.album,
        genre: bounded(c.genre?.[0]),
        codec: bounded(meta.format.codec),
        duration: parsedDuration(meta.format.duration),
        year: num(c.year) ?? num(c.originalyear),
        albumArtist: bounded(c.albumartist?.trim()),
        trackNo: num(c.track?.no) ?? track.trackNo,
        discNo: num(c.disk?.no),
        trackTotal: num(c.track?.of),
        releaseType: bounded(c.releasetype?.join(" ").toLowerCase()),
        originalYear: num(c.originalyear),
        date: isoDate(c.releasedate) ?? isoDate(c.date),
        originalDate: isoDate(c.originaldate),
        rg: readReplayGain(meta),
        sampleRate: num(meta.format.sampleRate),
        bitsPerSample: num(meta.format.bitsPerSample),
        bitrate: num(meta.format.bitrate),
        lossless: meta.format.lossless,
        // Re-parsed (mtime changed) → refresh the extracted cover too.
        art: art ?? (unchanged ? prev?.art : undefined),
      };
    } catch (err) {
      checkGeneration(generation);
      /* untagged or unreadable — filename fallback stands */
    }
    // Mobile parity: sub-30s clips are ineligible, and a track whose duration
    // couldn't be read at all is excluded rather than guessed about.
    if (track.duration < MIN_DURATION_SEC) continue;
    if (filterNonMusic && isNonMusic(f.rel.replace(/\\/g, "/"), path.basename(f.abs))) continue;
    tracks.push(track);
  }

  checkGeneration(generation);
  const lib: LocalLibrary = { folders, scannedAt: Date.now(), tracks };
  // The scan is long-lived; a rename/add/remove that ran while files were
  // being parsed must survive the scan's save. Serialized with the other
  // mutations, and the folder list is re-read at commit time — the scan
  // contributes its tracks, never a stale folder snapshot.
  await mutateLibrary(async () => {
    await saveLocalLibrary({ ...lib, folders: readLocalLibrary().folders }, generation);
  });
  checkGeneration(generation);
  onProgress?.(files.length, files.length);
  return lib;
}

/**
 * Store a cover fetched from an open database in the same cache the tag
 * covers live in, so it is served (and palette-read) exactly like they are.
 * `key` names the release, so every track of one album shares one file.
 */
export function storeFetchedArt(key: string, picture: { data: Uint8Array; format: string }): string | undefined {
  return extractArt(hashPath(`meta:${key}`), picture, false);
}

/**
 * Fill what a file's tags left empty — cover, album — from open metadata.
 * Only gaps are written: a value the file's own tags carry always wins. The
 * fill rides on the track record, so an unchanged file keeps it across
 * rescans; a re-tagged file is re-parsed and looked up again.
 */
export function applyTrackFills(fills: Map<string, { art?: string; album?: string }>): Promise<LocalLibrary> {
  return mutateLibrary(async () => {
    const lib = readLocalLibrary();
    let changed = false;
    const tracks = lib.tracks.map((t) => {
      const fill = fills.get(t.id);
      if (!fill) return t;
      const next = { ...t };
      if (fill.art && !t.art) next.art = fill.art;
      if (fill.album && (!t.album || t.album === "Unknown album")) next.album = fill.album;
      if (next.art !== t.art || next.album !== t.album) changed = true;
      return next;
    });
    const out = { ...lib, tracks };
    if (changed) await saveLocalLibrary(out);
    return out;
  });
}

/** A picture chosen by hand for an album, kept with the covers read from files. */
export function saveChosenArt(bytes: Uint8Array): string | null {
  const MAX_CHOSEN_BYTES = 8 * 1024 * 1024;
  // The page makes a JPEG of whatever was picked (lib/pickPicture.ts).
  if (!bytes?.length || bytes.length > MAX_CHOSEN_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  try {
    const dir = path.join(app.getPath("userData"), "local-art");
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    fs.writeFileSync(path.join(dir, `${hash}.jpg`), Buffer.from(bytes));
    return `localart://${hash}.jpg`;
  } catch {
    return null;
  }
}

/** Read one extracted cover off disk for the localart:// protocol. */
export function readArtFile(name: string): { data: Buffer; mime: string } | null {
  if (!/^[a-f0-9]{16}\.(jpg|png)$/.test(name)) return null;
  try {
    const file = path.join(app.getPath("userData"), "local-art", name);
    return { data: fs.readFileSync(file), mime: name.endsWith(".png") ? "image/png" : "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Cover bytes for a localart:// thumb URL (palette extraction IPC). The name
 * is strictly validated: only the app's own extracted-cover cache is
 * addressable, never arbitrary files.
 */
export function readLocalArtThumb(thumb: string): { data: Buffer; mime: string } | null {
  const m = /^localart:\/\/([a-f0-9]{16}\.(jpg|png))$/i.exec(String(thumb ?? "").trim());
  if (!m) return null;
  return readArtFile(m[1].toLowerCase());
}

export function localTrackById(id: string): LocalTrack | null {
  return readLocalLibrary().tracks.find((t) => t.id === id) ?? null;
}

export function localStreamPath(id: string): string | null {
  const t = localTrackById(id);
  if (!t) return null;
  try {
    fs.accessSync(t.path);
    return t.path;
  } catch {
    return null;
  }
}
