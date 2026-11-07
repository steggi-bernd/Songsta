/** JSON file persistence for renderer stores (userData/data/<name>.json). */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

function dataDir(): string {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  sweepTmpFiles(dir);
  return dir;
}

/**
 * Stale `*.tmp` files from interrupted atomic writes (kill mid-rename, AV
 * races) never get reaped by the writer — sweep them occasionally so the
 * data folder doesn't fill with garbage.
 */
let lastSweep = 0;
function sweepTmpFiles(dir: string): void {
  const now = Date.now();
  if (now - lastSweep < 5 * 60 * 1000) return;
  lastSweep = now;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith(".tmp") && !activeTemps.has(path.join(dir, f))) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function safeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, "");
  return clean || "store";
}

export function readData(name: string): unknown {
  const file = path.join(dataDir(), `${safeName(name)}.json`);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Rename can lose a race with file-system filters (antivirus) on Windows —
 * retry briefly, then fall back to an in-place write so data is never lost.
 */
async function writeAtomic(file: string, json: string, current: () => boolean): Promise<void> {
  if (!current()) return;
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  activeTemps.add(tmp);
  try {
    await fs.promises.writeFile(tmp, json, "utf-8");
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!current()) return;
      try {
        // No asynchronous OS commit may outlive this generation check and
        // overwrite a newer synchronous shutdown write (or a reset).
        fs.renameSync(tmp, file);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
      }
    }
    if (current()) fs.copyFileSync(tmp, file);
  } finally {
    try { await fs.promises.unlink(tmp); } catch { /* absent after rename */ }
    activeTemps.delete(tmp);
  }
}

const pendingWrites = new Map<string, Promise<void>>();
const activeTemps = new Set<string>();
const syncVersions = new Map<string, number>();
let resetGeneration = 0;
let resetting = false;
let resetTask: Promise<void> | null = null;

/** Drain writes already accepted; callers must stop producers first. */
export async function drainWrites(): Promise<void> {
  while (pendingWrites.size) await Promise.allSettled([...pendingWrites.values()]);
}

export async function writeData(name: string, data: unknown): Promise<void> {
  if (resetting) throw new Error("App data reset in progress");
  const dir = dataDir();
  const file = path.join(dir, `${safeName(name)}.json`);
  // Capture mutable callers (notably sync-meta) before waiting for disk.
  const json = JSON.stringify(data);
  const previous = pendingWrites.get(file) ?? Promise.resolve();
  const generation = resetGeneration;
  const syncVersion = syncVersions.get(file) ?? 0;
  const current = (): boolean => !resetting && generation === resetGeneration && syncVersion === (syncVersions.get(file) ?? 0);
  const write = previous.catch(() => undefined).then(() => writeAtomic(file, json, current));
  pendingWrites.set(file, write);
  try {
    await write;
  } finally {
    if (pendingWrites.get(file) === write) pendingWrites.delete(file);
  }
}

/**
 * Synchronous twin of writeData for shutdown paths: `before-quit` cannot
 * await async work, and whatever it persists must be on disk before the
 * process exits. Same atomic temp+rename as the async path, with a copy and
 * finally an in-place write as fallbacks so the value always lands.
 */
export function writeDataSync(name: string, data: unknown): void {
  if (resetting) throw new Error("App data reset in progress");
  const dir = dataDir();
  const file = path.join(dir, `${safeName(name)}.json`);
  const json = JSON.stringify(data);
  // Invalidate older queued/in-flight snapshots. Async writes only prepare
  // temp files off-thread; their generation check + commit is synchronous.
  syncVersions.set(file, (syncVersions.get(file) ?? 0) + 1);
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, json, "utf-8");
    try {
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.copyFileSync(tmp, file);
      } catch {
        fs.writeFileSync(file, json, "utf-8");
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* absent after rename */ }
  }
}

/**
 * Erase every app-data store: renderer JSON stores, listening-history
 * buckets and extracted local covers (derived caches — rescans rebuild
 * them). Downloaded audio files are the user's files and are never touched.
 *
 * Safe against in-flight writes: first stop producers (`resetting` makes
 * writeData refuse and makes queued atomic commits no-op), then wait for
 * writes already accepted to drain, then delete. Main must call the other
 * modules' own reset/cancel primitives BEFORE this so no new writes are
 * produced during the drain. After the first reset completes, the flag
 * clears and new writes are accepted again (post-reset defaults).
 */
export async function resetAppData(): Promise<void> {
  if (resetTask) return resetTask;
  resetting = true;
  resetGeneration += 1;
  resetTask = Promise.resolve().then(async () => {
    try {
      await drainWrites();
      const dir = dataDir();
      const names = new Set([
        "player",
        "library",
        "settings",
        "recent-searches",
        "listening-signals",
        "listening-history",
        "artist-meta-cache",
        "account",
        "profile",
        "auth",
        "sync-meta",
        "approved-dirs",
        "local-library",
        "data-owner",
        "smart-playlists",
        "spotify-import",
        "album-edits",
        "library-order",
        "muted",
        "device-names",
        "server-sync",
        "song-info",
      ]);
      // Enumerate after draining so every ownership archive is accounted for.
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith("owner-") && f.endsWith(".json")) names.add(f.slice(0, -5));
      }
      for (const name of names) {
        try {
          await fs.promises.unlink(path.join(dir, `${name}.json`));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      // Do not report success for an incomplete reset (e.g. a locked file).
      await fs.promises.rm(path.join(dir, "stats"), { recursive: true, force: true });
      // Snapshots an older version kept there; a reset must not leave them
      // recoverable on disk.
      await fs.promises.rm(path.join(dir, "backups"), { recursive: true, force: true });
      await fs.promises.rm(path.join(app.getPath("userData"), "local-art"), { recursive: true, force: true });
    } finally {
      // Invalidate every async write captured before the reset. They must
      // not resurrect pre-reset content; new writes are accepted again.
      resetGeneration += 1;
      pendingWrites.clear();
      resetting = false;
      resetTask = null;
    }
  });
  return resetTask;
}

/**
 * One-time migration: carry the user's library/settings from a previous
 * install's userData location on first boot.
 */
export function migrateLegacyData(): void {
  try {
    const current = dataDir();
    const legacyRoot = app.getPath("appData");
    for (const legacyName of ["EDITH Music"]) {
      const legacyDir = path.join(legacyRoot, legacyName, "data");
      if (path.resolve(legacyDir) === path.resolve(current)) continue;
      if (!fs.existsSync(legacyDir)) continue;
      const existing = fs.readdirSync(current).filter((f) => f.endsWith(".json"));
      if (existing.length > 0) return; // already has data — never overwrite
      for (const f of fs.readdirSync(legacyDir)) {
        if (!f.endsWith(".json")) continue;
        const src = path.join(legacyDir, f);
        try {
          fs.copyFileSync(src, path.join(current, f));
        } catch {
          /* skip unreadable file */
        }
      }
      return;
    }
  } catch (err) {
    console.warn("[bytune] legacy data migration failed:", err);
  }
}
