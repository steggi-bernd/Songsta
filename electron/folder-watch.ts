/**
 * Folder watching: new, changed and deleted audio files show up without a
 * manual rescan. Every imported folder gets one recursive fs.watch; events
 * are debounced (copying an album fires hundreds) and end in a single
 * incremental rescan — unchanged files are carried forward, so a rescan
 * costs a directory walk plus parsing of what actually changed.
 */
import * as fs from "fs";
import * as path from "path";
import * as locallib from "./local-library";
import type { LocalLibrary } from "./local-library";
import { foldPathCase } from "./local-paths";

const DEBOUNCE_MS = 4000;

const watchers = new Map<string, fs.FSWatcher>();
let enabled = true;
let timer: NodeJS.Timeout | null = null;
let scanning = false;
let pending = false;
let filterNonMusic = true;
let onRescanned: (lib: LocalLibrary) => void = () => undefined;

export function configureFolderWatch(opts: { onRescanned: (lib: LocalLibrary) => void }): void {
  onRescanned = opts.onRescanned;
}

/** The scan option the user last scanned with — watch rescans use the same. */
export function noteFilterNonMusic(value: boolean): void {
  filterNonMusic = value;
}

export function setFolderWatchEnabled(value: boolean): void {
  enabled = value;
  syncFolderWatchers();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void rescan();
  }, DEBOUNCE_MS);
}

async function rescan(): Promise<void> {
  if (scanning) {
    pending = true;
    return;
  }
  scanning = true;
  try {
    const lib = await locallib.scanLibrary(filterNonMusic);
    console.log(`[bytune] folder watch: rescanned, ${lib.tracks.length} tracks`);
    onRescanned(lib);
  } catch (err) {
    console.warn("[bytune] folder watch rescan failed:", err instanceof Error ? err.message : err);
  } finally {
    scanning = false;
    if (pending) {
      pending = false;
      schedule();
    }
  }
}

/** Watch exactly the imported folders (call after folders change). */
export function syncFolderWatchers(): void {
  const wanted = new Set(enabled ? locallib.readLocalLibrary().folders.map((f) => f.path) : []);
  for (const [folder, w] of watchers) {
    if (wanted.has(folder)) continue;
    w.close();
    watchers.delete(folder);
  }
  for (const folder of wanted) {
    if (watchers.has(folder)) continue;
    // A nested folder is already covered by its imported parent's watcher.
    if ([...wanted].some((other) => other !== folder && foldPathCase(folder).startsWith(foldPathCase(other) + path.sep))) continue;
    try {
      const w = fs.watch(folder, { recursive: true, persistent: false }, (_event, filename) => {
        const name = filename ? String(filename) : "";
        // Audio files, or extension-less paths (a folder moved/renamed/deleted).
        if (!name || locallib.isAudioFileName(name) || !path.extname(name)) schedule();
      });
      w.on("error", () => {
        w.close();
        watchers.delete(folder);
      });
      watchers.set(folder, w);
    } catch (err) {
      console.warn(`[bytune] can't watch ${path.basename(folder)}:`, err instanceof Error ? err.message : err);
    }
  }
}

