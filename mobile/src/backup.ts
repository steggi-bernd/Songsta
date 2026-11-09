/**
 * This phone's own things in one file, for a new start: an app signed anew goes in only after the
 * old one is uninstalled, and with it go the playlists, the library's order, the groups, the album
 * edits and the settings. The server's songs and likes stay on the server, so a backup holds what
 * the phone keeps for itself, as the files the stores already read: a backup from an older version
 * reads like an update from it. Pure, so it's tested as it is (tests/phone-backup.test.mjs);
 * phoneBackup.ts reads and writes the files and asks Android for the place.
 */

export const BACKUP_APP = "songsta-phone";
export const BACKUP_VERSION = 1;
/** A file larger than this is no backup of ours. */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

/** Kept as they are: the stores read them back as at any start. */
const WHOLE_FILES = ["playlists.json", "album-edits.json", "library-sync.json", "explore.json", "played.json", "liked-order.json", "muted.json", "quality.json", "devices.json"];
/** Of these only a part travels; the rest is this phone's. */
const PART_FILES = ["settings.json", "downloads.json", "sync-settings.json", "library.json"];
export const BACKUP_FILES = [...WHOLE_FILES, ...PART_FILES];

/** Settings that are this install's: never in a backup, never taken from one. */
export const INSTALL_SETTINGS = ["setupDone", "lastVersion", "newVersion", "pairedTvs", "pairHinted"];
/** Downloads: which songs and lists were kept, and how. The files themselves come again from the server. */
const DOWNLOAD_PARTS = ["kept", "quality", "overMobile", "lists", "notWanted"];
const LINKED_KEPT = 20;

export interface BackupFolder {
  uri: string;
  name: string;
}

export interface PhoneBackup {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  /** the app's version that made it */
  appVersion: string;
  /** by file, as far as each travels */
  files: Record<string, unknown>;
  /** the album pictures chosen here or on the computer, by album, as data: JPEGs */
  pictures: Record<string, string>;
  /** the music folders on the phone: Android lets an app read one only after it's picked again */
  folders: BackupFolder[];
}

export type BackupProblem = "not-a-backup" | "computer-backup" | "too-new" | "too-big";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const isLocalId = (id: string): boolean => id.startsWith("local:");

function pick(from: Obj, keys: string[]): Obj {
  const out: Obj = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

function without(from: Obj, keys: string[]): Obj {
  const out: Obj = { ...from };
  for (const key of keys) delete out[key];
  return out;
}

/** Of the library's copy only what the server doesn't know: likes and plays of the phone's own files. */
function localPart(library: Obj): Obj {
  const counts = Object.fromEntries(Object.entries(obj(library.counts)).filter(([id, c]) => isLocalId(id) && isObj(c)));
  return { favorites: strings(library.favorites).filter(isLocalId), counts };
}

export interface BackupSource {
  /** one of the phone's files as the stores wrote it; null when there's none */
  read(name: string): unknown;
  /** an album's picture as a data: JPEG; null when it can't be read */
  picture(key: string): string | null;
  folders: BackupFolder[];
  appVersion: string;
  now: Date;
}

export function makeBackup(src: BackupSource): PhoneBackup {
  const files: Obj = {};
  for (const name of WHOLE_FILES) {
    const value = src.read(name);
    if (value !== null && value !== undefined) files[name] = value;
  }
  const settings = src.read("settings.json");
  if (isObj(settings)) files["settings.json"] = without(settings, INSTALL_SETTINGS);
  const downloads = src.read("downloads.json");
  if (isObj(downloads)) files["downloads.json"] = pick(downloads, DOWNLOAD_PARTS);
  const sync = src.read("sync-settings.json");
  if (isObj(sync)) files["sync-settings.json"] = pick(sync, ["customAddress", "linked"]);
  const library = src.read("library.json");
  if (isObj(library)) files["library.json"] = localPart(library);

  const pictures: Record<string, string> = {};
  for (const key of Object.keys(obj(obj(files["album-edits.json"]).covers))) {
    const data = src.picture(key);
    if (data) pictures[key] = data;
  }
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: src.now.toISOString(),
    appVersion: src.appVersion,
    files,
    pictures,
    folders: src.folders.map(({ uri, name }) => ({ uri, name })),
  };
}

/** The backup in a file, or what's wrong with it. Only what can be one of ours is taken. */
export function readBackup(text: string): PhoneBackup | BackupProblem {
  if (text.length > MAX_BACKUP_BYTES) return "too-big";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not-a-backup";
  }
  if (!isObj(raw)) return "not-a-backup";
  // The computer's own backup ("Export data" there): another app's things.
  if (raw.app === "bytune" || raw.app === "songsta") return "computer-backup";
  if (raw.app !== BACKUP_APP || typeof raw.version !== "number") return "not-a-backup";
  if (raw.version > BACKUP_VERSION) return "too-new";
  const files: Obj = {};
  for (const name of BACKUP_FILES) {
    const value = obj(raw.files)[name];
    if (isObj(value) || Array.isArray(value)) files[name] = value;
  }
  const pictures: Record<string, string> = {};
  for (const [key, data] of Object.entries(obj(raw.pictures))) {
    if (typeof data === "string" && data.startsWith("data:image/")) pictures[key] = data;
  }
  const folders = (Array.isArray(raw.folders) ? raw.folders : [])
    .filter((f): f is BackupFolder => isObj(f) && typeof f.uri === "string" && typeof f.name === "string")
    .map(({ uri, name }) => ({ uri, name }));
  return {
    app: BACKUP_APP,
    version: raw.version,
    exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : "",
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    files,
    pictures,
    folders,
  };
}

/** What a backup holds, in numbers, for the question before it's put back. */
export function backupSummary(backup: PhoneBackup): { playlists: number; albumEdits: number; groups: number; at: number | null } {
  const playlists = obj(backup.files["playlists.json"]).playlists;
  const edits = obj(backup.files["album-edits.json"]);
  const albumEdits = new Set(["artists", "mergedInto", "titles", "covers"].flatMap((field) => Object.keys(obj(edits[field])))).size;
  const libraryGroups = obj(backup.files["settings.json"]).libraryGroups;
  const exploreGroups = Object.values(obj(obj(backup.files["explore.json"]).groups));
  const groups = (Array.isArray(libraryGroups) ? libraryGroups.length : 0) + exploreGroups.reduce<number>((n, g) => n + (Array.isArray(g) ? g.length : 0), 0);
  const at = Date.parse(backup.exportedAt);
  return { playlists: Array.isArray(playlists) ? playlists.length : 0, albumEdits, groups, at: Number.isFinite(at) ? at : null };
}

export interface RestoreTarget {
  /** this phone's file as it is now; null when there's none */
  read(name: string): unknown;
  /** writes an album's picture; its address, or null when it couldn't be */
  placePicture(key: string, data: string, at: number): string | null;
}

/**
 * What's written to the phone for a backup, by file. What the backup holds takes the place of
 * what's here; files it has nothing of stay. What belongs to this phone stays with it: the install's
 * own settings, the downloads whose files are here, the likes and plays of its own files, the
 * services it found. A sync service then merges as for a phone that was away a while: the moments
 * come along, and what changed elsewhere since is later.
 */
export function restoreFiles(backup: PhoneBackup, here: RestoreTarget): Obj {
  const { files } = backup;
  const out: Obj = {};
  for (const name of ["playlists.json", "explore.json", "liked-order.json", "muted.json", "quality.json", "devices.json"]) {
    if (files[name] !== undefined) out[name] = files[name];
  }

  const edits = files["album-edits.json"];
  if (isObj(edits)) {
    const covers: Record<string, string> = {};
    const coverStamps = { ...obj(edits.coverStamps) };
    for (const key of Object.keys(obj(edits.covers))) {
      const data = backup.pictures[key];
      const uri = data ? here.placePicture(key, data, num(coverStamps[key])) : null;
      if (uri) covers[key] = uri;
      // No picture to show: nothing is said about it, so another device's stays.
      else delete coverStamps[key];
    }
    out["album-edits.json"] = { ...edits, covers, coverStamps };
  }

  const order = files["library-sync.json"];
  if (isObj(order)) {
    // Merged afresh at the next look: what the service had then says nothing about this phone now.
    out["library-sync.json"] = { ...order, clock: Math.max(num(order.clock), num(obj(here.read("library-sync.json")).clock)), merges: {} };
  }

  const played = files["played.json"];
  if (isObj(played)) {
    const now = obj(here.read("played.json"));
    const at: Record<string, number> = {};
    for (const times of [obj(now.at), obj(played.at)]) {
      for (const [key, t] of Object.entries(times)) if (num(t) > (at[key] ?? 0)) at[key] = num(t);
    }
    out["played.json"] = { at, seeded: !!played.seeded || !!now.seeded };
  }

  const settings = files["settings.json"];
  if (isObj(settings)) {
    out["settings.json"] = { ...without(settings, INSTALL_SETTINGS), ...pick(obj(here.read("settings.json")), INSTALL_SETTINGS), setupDone: true };
  }

  const downloads = files["downloads.json"];
  if (isObj(downloads)) {
    const now = obj(here.read("downloads.json"));
    out["downloads.json"] = {
      ...now,
      // What's on this phone stays known, its files are here; the rest comes again at the next opening.
      kept: { ...obj(downloads.kept), ...obj(now.kept) },
      lists: { ...obj(now.lists), ...obj(downloads.lists) },
      notWanted: { ...obj(now.notWanted), ...obj(downloads.notWanted) },
      quality: downloads.quality ?? now.quality,
      overMobile: downloads.overMobile ?? now.overMobile,
      listsNoted: true,
    };
  }

  const sync = files["sync-settings.json"];
  if (isObj(sync)) {
    const now = obj(here.read("sync-settings.json"));
    const nowLinked = strings(now.linked);
    const address = typeof sync.customAddress === "string" && sync.customAddress ? sync.customAddress : now.customAddress;
    out["sync-settings.json"] = {
      ...now,
      customAddress: typeof address === "string" ? address : "",
      linked: [...strings(sync.linked).filter((key) => !nowLinked.includes(key)), ...nowLinked].slice(-LINKED_KEPT),
    };
  }

  const library = files["library.json"];
  if (isObj(library)) {
    const { favorites: liked, counts } = localPart(library) as { favorites: string[]; counts: Obj };
    if (liked.length || Object.keys(counts).length) {
      const now = here.read("library.json");
      const base: Obj = isObj(now) ? now : { tracks: [], hashes: {}, favorites: [], counts: {}, artistIds: {} };
      const favorites = strings(base.favorites);
      const merged: Obj = { ...obj(base.counts) };
      for (const [id, count] of Object.entries(counts)) {
        const mine = obj(merged[id]);
        const theirs = obj(count);
        merged[id] = { plays: Math.max(num(mine.plays), num(theirs.plays)), lastAt: Math.max(num(mine.lastAt), num(theirs.lastAt)) };
      }
      out["library.json"] = { ...base, favorites: [...liked.filter((id) => !favorites.includes(id)), ...favorites], counts: merged };
    }
  }
  return out;
}

/** The backup's music folders this phone can't read yet, by name: they're to be picked again. */
export function foldersToPick(backup: PhoneBackup, picked: BackupFolder[]): string[] {
  const have = new Set(picked.map((f) => f.uri));
  return backup.folders.filter((f) => !have.has(f.uri)).map((f) => f.name);
}

/** The file's name: the day it was made. */
export function backupFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `songsta-phone-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}
