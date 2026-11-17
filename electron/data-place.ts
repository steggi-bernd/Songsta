/**
 * Where Songsta's data lives, as file work alone (no Electron): the note in the usual folder that names
 * another one, the copy into a new place, what a move may go to, how big a folder is. The move itself
 * happens at a start (data-location.ts), before anything opens a file: nothing is half-written then.
 */
import * as fs from "fs";
import * as path from "path";

/** In the usual folder: where the data is now, a move asked for, the old place still holding data. */
export const NOTE = "data-location.json";

export interface PlaceNote {
  /** the folder in use, when it isn't the usual one */
  path?: string;
  /** a move asked for: copied there at the next start */
  moveTo?: string;
  /** the folder the data was copied from, still holding it until you remove it */
  leftover?: string;
  /** the last move that didn't work, and why */
  failed?: string;
  /** the network caches go at the next start (Settings → Network & privacy) */
  clearCaches?: boolean;
}

export function readNote(usual: string): PlaceNote {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(usual, NOTE), "utf8")) as PlaceNote;
    if (!raw || typeof raw !== "object") return {};
    const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    return { path: text(raw.path), moveTo: text(raw.moveTo), leftover: text(raw.leftover), failed: text(raw.failed), clearCaches: raw.clearCaches === true || undefined };
  } catch {
    return {};
  }
}

export function writeNote(usual: string, note: PlaceNote): void {
  const kept = Object.fromEntries(Object.entries(note).filter(([, v]) => v !== undefined && v !== false && v !== ""));
  const file = path.join(usual, NOTE);
  if (!Object.keys(kept).length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(usual, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(kept, null, 1));
}

/** Chromium's caches build themselves again; locks belong to a running app; the note stays where it is. */
const LEFT_OUT = new Set(["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "Crashpad", "lockfile", "SingletonLock", "SingletonCookie", "SingletonSocket", NOTE]);

const same = (a: string, b: string): boolean => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const inside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** Everything of the data folder `from` into `to` (made if need be), but caches and locks. */
export function copyData(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    if (LEFT_OUT.has(name) || name.endsWith(".tmp")) continue;
    fs.cpSync(path.join(from, name), path.join(to, name), { recursive: true, force: true, filter: (src) => !src.endsWith(".tmp") });
  }
}

/**
 * Why the data can't go to `target`, or null when it can: a folder of its own (empty or new), not inside
 * the one in use nor holding it. The usual folder can always take it back.
 */
export function whyNot(target: string, current: string, usual: string): string | null {
  if (!target || !path.isAbsolute(target)) return "Choose a whole folder";
  if (same(target, current)) return "Your data is there already";
  if (same(target, usual)) return null;
  if (inside(target, current) || inside(current, target)) return "That folder holds your data folder, or lies inside it";
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) return "That's a file, not a folder";
    if (fs.readdirSync(target).length) return "Choose an empty folder, or make a new one";
  }
  return null;
}

/** A folder's size in bytes, the folders in it too. */
export async function folderSize(dir: string): Promise<number> {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await folderSize(p);
    else {
      try {
        total += (await fs.promises.stat(p)).size;
      } catch {
        /* gone meanwhile */
      }
    }
  }
  return total;
}

/** A file's or folder's size; nothing there is 0. */
export async function sizeOf(p: string): Promise<number> {
  try {
    const st = await fs.promises.stat(p);
    return st.isDirectory() ? folderSize(p) : st.size;
  } catch {
    return 0;
  }
}

/**
 * At a start, before anything opens a file: a move asked for is carried out, the caches asked to go
 * are removed. Answers the folder to use from now on and the note as it stands after.
 */
export function settlePlace(usual: string, cachesOf: (folder: string) => string[]): { folder: string; note: PlaceNote } {
  const note = readNote(usual);
  let folder = note.path && fs.existsSync(note.path) ? note.path : usual;
  if (note.moveTo) {
    const target = note.moveTo;
    const reason = whyNot(target, folder, usual);
    try {
      if (reason) throw new Error(reason);
      const back = same(target, usual);
      // Back to the usual folder: what it still holds is the old copy from before the move.
      if (back) removeLeftover(usual, usual);
      copyData(folder, target);
      note.leftover = folder;
      note.path = back ? undefined : target;
      folder = target;
      note.failed = undefined;
    } catch (err) {
      note.failed = err instanceof Error ? err.message : String(err);
    }
    note.moveTo = undefined;
  }
  if (note.clearCaches) {
    for (const p of cachesOf(folder)) fs.rmSync(p, { recursive: true, force: true });
    note.clearCaches = undefined;
  }
  try {
    writeNote(usual, note);
  } catch {
    /* read-only: the same move is tried at the next start */
  }
  return { folder, note };
}

/**
 * The old place's data, removed when you ask: a folder of its own goes whole; the usual folder keeps the
 * note, the rest goes.
 */
export function removeLeftover(leftover: string, usual: string): void {
  if (same(leftover, usual)) {
    for (const name of fs.readdirSync(usual)) if (name !== NOTE) fs.rmSync(path.join(usual, name), { recursive: true, force: true });
  } else {
    fs.rmSync(leftover, { recursive: true, force: true });
  }
}
