/**
 * Where Songsta keeps your data (Settings → Network & privacy → Where it's kept): the usual folder, or
 * one you chose (another drive, an encrypted one). main.ts imports this right after the old name's
 * move, so the folder is settled before anything opens a file in it; a move you ask for is copied at
 * the next start, then (data-place.ts). The old place's data stays until you remove it.
 */
import { app } from "electron";
import * as path from "path";
import { readNote, removeLeftover, settlePlace, whyNot, writeNote, type PlaceNote } from "./data-place";

/** The network caches: what "Empty the caches" removes at the next start. They're asked for again when needed. */
export function networkCaches(folder: string): string[] {
  const data = path.join(folder, "data");
  return [
    path.join(data, "open-metadata.json"),
    path.join(data, "song-info.json"),
    path.join(data, "artist-meta-cache.json"),
    path.join(data, "album-genres.json"),
    path.join(folder, "lyrics-cache"),
    path.join(folder, "autoeq-index.md"),
  ];
}

const usual = app.getPath("userData");
// Chromium's own data (the key that seals logins among it) lives in the same folder unless a profile set it elsewhere.
const sessionWithIt = path.resolve(app.getPath("sessionData")) === path.resolve(usual);
const settled = settlePlace(usual, networkCaches);
if (path.resolve(settled.folder) !== path.resolve(usual)) {
  app.setPath("userData", settled.folder);
  if (sessionWithIt) app.setPath("sessionData", settled.folder);
}

export interface DataPlace {
  /** the folder in use */
  folder: string;
  /** Songsta's usual folder */
  usual: string;
  /** the data was copied from here and is still there */
  leftover: string | null;
  /** a move asked for, done at the next start */
  moving: string | null;
  /** the last move didn't work, and why */
  failed: string | null;
}

export function dataPlace(): DataPlace {
  const note = readNote(usual);
  return { folder: app.getPath("userData"), usual, leftover: note.leftover ?? null, moving: note.moveTo ?? null, failed: note.failed ?? null };
}

/** A move to `target`, carried out at the next start; null when it can go there, else why not. */
export function askMove(target: string): string | null {
  const reason = whyNot(target, app.getPath("userData"), usual);
  if (reason) return reason;
  const note: PlaceNote = readNote(usual);
  writeNote(usual, { ...note, moveTo: target, failed: undefined });
  return null;
}

/** The move asked for isn't wanted any more. */
export function cancelMove(): void {
  writeNote(usual, { ...readNote(usual), moveTo: undefined });
}

/** The old place's data goes (you asked); answers whether there was any. */
export function forgetLeftover(): boolean {
  const note = readNote(usual);
  if (!note.leftover) return false;
  // Never the folder in use.
  if (path.resolve(note.leftover).toLowerCase() === path.resolve(app.getPath("userData")).toLowerCase()) {
    writeNote(usual, { ...note, leftover: undefined });
    return false;
  }
  removeLeftover(note.leftover, usual);
  writeNote(usual, { ...note, leftover: undefined });
  return true;
}

/** The network caches go at the next start. */
export function clearCachesAtStart(): void {
  writeNote(usual, { ...readNote(usual), clearCaches: true });
}
