/** Offline copies of server songs, on the renderer's side. */
import { useLibrary, type DownloadItem } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { staleDownloadIds } from "./download-reconcile";
import { T } from "./i18n";

export function getDownload(id: string): DownloadItem | undefined {
  return useLibrary.getState().downloads[id];
}

export async function startDownload(track: Track, dirOverride?: string): Promise<void> {
  const lib = useLibrary.getState();
  const existing = lib.downloads[track.id];
  if (existing?.status === "downloading" || existing?.status === "queued") return;
  if (existing?.status === "done") {
    useUI.getState().toast(T("Already downloaded"), "info");
    return;
  }

  lib.setDownload(track.id, {
    track,
    path: existing?.path ?? null,
    status: "queued",
    progress: 0,
    downloaded: 0,
    total: 0,
  });

  try {
    // The copy goes to its offline library folder unless a folder was chosen for it.
    // The main process queues it; lifecycle arrives over download:event.
    await requireBridge().startDownload(track, dirOverride);
  } catch (err) {
    useLibrary.getState().patchDownload(track.id, { status: "failed", progress: 0 });
    useUI.getState().toast(
      T("Download failed: {value}", { value: err instanceof Error ? err.message : T("unknown error") }),
      "error"
    );
  }
}

export function cancelDownload(id: string): void {
  void window.bytune?.cancelDownload(id);
  useLibrary.getState().patchDownload(id, { status: "failed", progress: 0 });
}

/**
 * Per-id progress coalescer: keep the latest payload per id and apply it at
 * most once per tick. Main already throttles file progress to 250ms, but
 * every event used to patch the library store directly — re-rendering rows
 * and (before persist coalescing) rewriting the whole library at ~4Hz per
 * download. 500ms is still smooth for progress UI. Terminal events must
 * bypass the buffer (flush(id)) so state is never stale at completion.
 */
export function createProgressBuffer(
  apply: (id: string, downloaded: number, total: number) => void,
  tickMs: number
): { push: (id: string, downloaded: number, total: number) => void; flush: (id: string) => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const args = new Map<string, { downloaded: number; total: number }>();
  return {
    push(id, downloaded, total) {
      args.set(id, { downloaded, total });
      if (timers.has(id)) return;
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          const a = args.get(id);
          args.delete(id);
          if (a) apply(id, a.downloaded, a.total);
        }, tickMs)
      );
    },
    flush(id) {
      const t = timers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.delete(id);
      }
      args.delete(id);
    },
  };
}

/**
 * "Remove download": the offline copy goes to the recycle bin and stays off.
 * Neither the check at start nor a list kept whole brings it back
 * (lib/keptListsWatch.ts), until it's downloaded by hand again.
 */
export async function removeOfflineCopy(serverId: string): Promise<void> {
  const item = getDownload(serverId);
  if (!item) return;
  try {
    if (item.path) await requireBridge().removeOfflineCopy(item.path);
  } catch {
    useUI.getState().toast(T("The download couldn't be removed"), "error");
    return;
  }
  useLibrary.getState().patchDownload(serverId, { status: "removed", progress: 0 });
  useUI.getState().toast(T("Download removed"), "info");
  // The copy leaves the library, and the song plays from the server again.
  void requireBridge()
    .scanLibrary(useSettings.getState().filterNonMusicAudio)
    .then((lib) => window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: lib })))
    .catch(() => undefined);
}

/** Done once the rows of the last session are reconciled (listenForDownloadProgress). */
let reconciled: Promise<void> = Promise.resolve();
export function downloadsReconciled(): Promise<void> {
  return reconciled;
}

/**
 * Boot reconciliation: the main process queue is memory-only, so registry
 * rows persisted as "queued"/"downloading" describe work that died with the
 * previous session — no event will ever update them, and startDownload
 * refuses to retry while a row claims to be active. Fail the stale rows
 * (failed stays retryable); rows still present in the live queue snapshot
 * are left alone.
 */
async function reconcileStaleDownloads(): Promise<void> {
  const bridge = window.bytune;
  if (!bridge?.downloadQueue) return;
  try {
    const snapshot = (await bridge.downloadQueue()) as { id?: unknown }[];
    const live = (Array.isArray(snapshot) ? snapshot : [])
      .map((row) => (typeof row?.id === "string" ? row.id : ""))
      .filter(Boolean);
    const lib = useLibrary.getState();
    for (const id of staleDownloadIds(lib.downloads, live)) {
      lib.patchDownload(id, { status: "failed", progress: 0 });
    }
  } catch {
    /* bridge unavailable — stale rows keep their status; cancel still works */
  }
}

/** A song on Jellyfin or Navidrome: its download is an offline copy in the library (electron/downloads.ts). */
export const SERVER_SONG = /^(jf|ss):/;

/**
 * Offline copies land in a library folder of their own: once a batch is
 * through (nothing queued or running), one rescan merges them with their
 * server songs — from then on they play from disk — and one note says so.
 */
let offlineReady = 0;
let offlineTimer: number | null = null;
function scheduleOfflineScan(): void {
  if (offlineTimer !== null) window.clearTimeout(offlineTimer);
  offlineTimer = window.setTimeout(() => {
    offlineTimer = null;
    const pending = Object.values(useLibrary.getState().downloads).some(
      (d) => SERVER_SONG.test(d.track.id) && (d.status === "queued" || d.status === "downloading")
    );
    if (pending || offlineReady === 0) return;
    const n = offlineReady;
    offlineReady = 0;
    void requireBridge()
      .scanLibrary(useSettings.getState().filterNonMusicAudio)
      .then((lib) => {
        window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: lib }));
        useUI.getState().toast(T("{n} song{value} ready offline", { n, value: n === 1 ? "" : "s" }), "success");
      })
      .catch(() => undefined);
  }, 800);
}

/** Every song of `tracks` that lives only on a server, downloaded for offline listening. */
export function downloadForOffline(tracks: Track[]): number {
  const wanted = tracks.filter((t) => SERVER_SONG.test(t.id) && getDownload(t.id)?.status !== "done");
  for (const t of wanted) void startDownload(t);
  if (wanted.length) {
    useUI.getState().toast(T("Downloading {count} song{value} for offline listening", { count: wanted.length, value: wanted.length === 1 ? "" : "s" }), "info");
  }
  return wanted.length;
}

/** Subscribe to queue lifecycle events from the main process. */
export function listenForDownloadProgress(): () => void {
  if (!window.bytune) return () => undefined;
  reconciled = reconcileStaleDownloads();
  const applyProgress = (id: string, downloaded: number, total: number): void => {
    useLibrary.getState().patchDownload(id, {
      status: "downloading",
      progress: total > 0 ? Math.min(1, downloaded / total) : 0,
      downloaded,
      total,
    });
  };
  const buffer = createProgressBuffer(applyProgress, 500);
  const offEvent = window.bytune.onDownloadEvent?.((e) => {
    const lib = useLibrary.getState();
    if (e.type === "start") {
      applyProgress(e.id, 0, 0);
    } else if (e.type === "progress") {
      buffer.push(e.id, e.downloaded ?? 0, e.total ?? 0);
    } else if (e.type === "done" && e.path) {
      buffer.flush(e.id);
      const item = lib.downloads[e.id];
      lib.setDownload(e.id, {
        track: item?.track ?? { id: e.id, title: e.id, artist: "", duration: 0, thumb: "" },
        path: e.path,
        status: "done",
        progress: 1,
        downloaded: 0,
        total: 0,
      });
      offlineReady += 1;
      scheduleOfflineScan();
    } else if (e.type === "failed") {
      buffer.flush(e.id);
      lib.patchDownload(e.id, { status: "failed", progress: 0 });
      useUI.getState().toast(T("Download failed: {value}", { value: e.reason ?? T("unknown error") }), "error");
      scheduleOfflineScan();
    } else if (e.type === "cancelled") {
      buffer.flush(e.id);
      lib.patchDownload(e.id, { status: "failed", progress: 0 });
      scheduleOfflineScan();
    }
  });
  return () => offEvent?.();
}
