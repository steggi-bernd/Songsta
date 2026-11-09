/**
 * Offline copies of server songs — a real queue:
 *
 *   - enqueue(): one door into the queue; a track already saved, queued or
 *     running is left alone rather than duplicated
 *   - concurrency capped at 2 so the server and the network stay healthy
 *   - cancel() aborts an in-flight transfer (partial file removed) or dequeues
 *   - progress + lifecycle events stream to the renderer over download:event
 *
 * Metadata/cover embedding is deliberately not attempted — it needs a tagger
 * dependency, so the feature stays unimplemented rather than faked.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import * as jellyfin from "./jellyfin";
import { isUnderPath, samePath } from "./local-paths";
import * as subsonic from "./subsonic";
import type { Track } from "../src/types";

/** A song on Jellyfin or Navidrome: downloaded as its original file, for offline listening. */
export const SERVER_SONG = /^(jf|ss):/;

/**
 * Where offline copies of server songs go, filed as <artist>/<album>/: a
 * library folder of its own (main.ts adds it), so a copy merges with its
 * server song and plays from disk first — offline too.
 */
export function offlineDir(): string {
  return path.join(app.getPath("music"), "Songsta Offline");
}

/** A file inside the offline copies' folder, the only place "Remove download" takes one from. */
export function isOfflineCopy(file: string): boolean {
  if (!file) return false;
  const resolved = path.resolve(file);
  return isUnderPath(resolved, offlineDir()) && !samePath(resolved, offlineDir());
}

/** The extension a server names its file with (Content-Disposition), if any. */
function serverExt(res: Response): string | null {
  const cd = res.headers.get("content-disposition") ?? "";
  const name = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1] ?? /filename="?([^";]+)"?/i.exec(cd)?.[1];
  const ext = name ? path.extname(decodeURIComponent(name)).toLowerCase() : "";
  return /^\.[a-z0-9]{2,5}$/.test(ext) ? ext : null;
}

const MAX_CONCURRENT = 2;

type QueueState =
  | { phase: "queued" }
  | { phase: "running"; downloaded: number; total: number }
  | { phase: "failed"; reason: string };

const queue: { track: Track; dir?: string }[] = [];
const state = new Map<string, QueueState>();
const controllers = new Map<string, AbortController>();
let active = 0;
const workers = new Set<Promise<void>>();
let resetTask: Promise<void> | null = null;

/** Stop the queue and await partial-file cleanup; completed audio is retained. */
export function resetDownloads(): Promise<void> {
  if (resetTask) return resetTask;
  resetTask = Promise.resolve().then(async () => {
    await Promise.allSettled([...workers]);
    state.clear();
  }).finally(() => { resetTask = null; });
  // Stop producers synchronously at invocation, before any awaited cleanup.
  const queued = queue.splice(0);
  for (const ctrl of controllers.values()) ctrl.abort();
  for (const item of queued) emit({ type: "cancelled", id: item.track.id });
  return resetTask;
}

export interface DownloadEvent {
  type: "queued" | "start" | "progress" | "done" | "failed" | "cancelled";
  id: string;
  downloaded?: number;
  total?: number;
  path?: string;
  reason?: string;
}

type Listener = (e: DownloadEvent) => void;
const listeners = new Set<Listener>();

function emit(e: DownloadEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* listener errors never break the queue */
    }
  }
}

export function isDownloading(id: string): boolean {
  return queue.some((q) => q.track.id === id) || state.has(id);
}

export function queueSnapshot(): { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] {
  const out: { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] = [];
  for (const q of queue) out.push({ id: q.track.id, phase: "queued" });
  for (const [id, st] of state) {
    if (st.phase === "queued") out.push({ id, phase: "queued" });
    else if (st.phase === "running") out.push({ id, phase: "running", downloaded: st.downloaded, total: st.total });
    else out.push({ id, phase: "failed", reason: st.reason });
  }
  return out;
}

/** Exported for security regression tests — the production path is internal. */
export function sanitizeFilename(name: string): string {
  // Bidi/format controls (U+202A–U+202E etc.) would let a hostile title
  // visually masquerade the file extension in Explorer.
  const s = name.replace(/[\\/:*?"<>|\x00-\x1f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "_").replace(/\s+/g, " ").trim();
  const bounded = (s || "track").slice(0, 120);
  // A stem that is exactly a reserved Windows device name fails or misbehaves
  // on write — pad it so it becomes an ordinary file name.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(bounded) ? `_${bounded}` : bounded;
}

function uniquePath(dir: string, base: string): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let candidate = path.join(dir, base);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return candidate;
}

/** Register a listener for lifecycle events (the renderer bridge forwards). */
export function addDownloadListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Queue a track. Throws when it is already saved, queued or running — the
 * caller decides what that means for its own UI.
 */
export function enqueueDownload(track: Track, dirOverride?: string): "queued" {
  if (resetTask) throw new Error("Downloads reset in progress");
  if (!SERVER_SONG.test(track.id)) throw new Error("Only songs on a server can be downloaded");
  if (isDownloading(track.id)) throw new Error("Already downloading this track");
  queue.push({ track, dir: dirOverride });
  state.set(track.id, { phase: "queued" });
  emit({ type: "queued", id: track.id });
  void drain();
  return "queued";
}

export function cancelDownload(id: string): boolean {
  const qi = queue.findIndex((q) => q.track.id === id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    state.delete(id);
    emit({ type: "cancelled", id });
    return true;
  }
  const ctrl = controllers.get(id);
  if (ctrl) {
    ctrl.abort(); // the transfer's catch handles cleanup + event
    return true;
  }
  return false;
}

async function drain(): Promise<void> {
  // Workers pull from the shared queue up to the concurrency cap.
  while (!resetTask && active < MAX_CONCURRENT) {
    const next = queue.shift();
    if (!next) break;
    active++;
    const worker = runDownload(next.track, next.dir)
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== "cancelled") {
          // The failure is terminal for this attempt: drop the queue's own
          // bookkeeping entry so isDownloading() goes false and the track can
          // be queued again immediately. (The renderer's download registry
          // keeps the failed state for the UI; leaving the entry here made
          // every retry throw "Already downloading this track" until restart.)
          state.delete(next.track.id);
          emit({ type: "failed", id: next.track.id, reason });
        }
      })
      .finally(() => {
        active--;
        workers.delete(worker);
        if (queue.length > 0) void drain();
      });
    workers.add(worker);
  }
}

async function runDownload(track: Track, dirOverride?: string): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(track.id, ctrl);
  let dest = "";
  let ownsPartial = false;
  const checkCancelled = (): void => { if (ctrl.signal.aborted) throw new Error("cancelled"); };
  try {
    const chosen = dirOverride && dirOverride.trim() ? dirOverride : null;
    const dir = chosen ?? offlineDir();
    checkCancelled();
    await fs.promises.mkdir(dir, { recursive: true });
    checkCancelled();

    // The original file, named and filed the way a music library is: <artist>/<album>/<no> <title>.
    const original = track.id.startsWith("jf:") ? jellyfin.originalFile(track.id.slice(3)) : subsonic.originalFile(track.id.slice(3));
    const res = await fetch(original.url, { headers: original.headers, signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`The server answered HTTP ${res.status}`);
    const albumDir = path.join(
      dir,
      sanitizeFilename(track.albumArtist || track.artist || "Unknown artist"),
      sanitizeFilename(track.album || "Unknown album")
    );
    await fs.promises.mkdir(albumDir, { recursive: true });
    const no = track.trackNo ? `${String(track.trackNo).padStart(2, "0")} ` : "";
    dest = uniquePath(albumDir, `${sanitizeFilename(`${no}${track.title}`)}${serverExt(res) ?? original.ext}`);
    const total = Number(res.headers.get("content-length") ?? 0);
    checkCancelled();
    // Exclusive creation prevents a competing download/user file from being
    // overwritten or later deleted by cancellation cleanup.
    const fd = fs.openSync(dest, "wx");
    ownsPartial = true;
    const out = fs.createWriteStream(dest, { fd });
    const src = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    emit({ type: "start", id: track.id });
    state.set(track.id, { phase: "running", downloaded: 0, total });

    let downloaded = 0;
    let lastEmit = 0;
    src.on("data", (chunk: Buffer) => {
      if (ctrl.signal.aborted) return;
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        state.set(track.id, { phase: "running", downloaded, total });
        emit({ type: "progress", id: track.id, downloaded, total });
      }
    });

    await pipeline(src, out, { signal: ctrl.signal });
    ownsPartial = false; // A completed audio file belongs to the user now.
    checkCancelled();
    state.delete(track.id);
    emit({ type: "done", id: track.id, path: dest });
  } catch (err) {
    // Remove a partial file so we don't leave broken audio behind. Completed
    // files from before this transfer are never touched.
    if (dest && ownsPartial) {
      try {
        await fs.promises.unlink(dest);
      } catch {
        /* ignore */
      }
    }
    if (ctrl.signal.aborted) {
      state.delete(track.id);
      emit({ type: "cancelled", id: track.id });
      throw new Error("cancelled");
    }
    throw err;
  } finally {
    controllers.delete(track.id);
  }
}
