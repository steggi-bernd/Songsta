/**
 * The computer's share of lists that stay whole (lib/keptLists.ts). A song counts as there
 * once a copy of it lies in the library: what's on a server only is fetched for offline.
 * It looks at the start, on Refresh, when a list or the library changes, and every so often.
 * The look at the start goes further (checkDownloadsAtStart): every offline copy is checked.
 */
import { useAlbumEdits } from "../stores/albumEdits";
import { useCatalog, versionsOf } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { buildAlbums } from "./catalogBuild";
import { downloadForOffline, downloadsReconciled, getDownload, SERVER_SONG, startDownload } from "./downloads";
import { T } from "./i18n";
import { albumListKey, KEPT_LISTS_LOOK_EVERY_MS, missingFromLists, playlistListKey } from "./keptLists";

const AFTER_A_CHANGE_MS = 3000;

/** A song's copy on a server, when there's no copy on this computer yet. */
function serverCopy(track: Track): Track | null {
  const copies = versionsOf(track);
  if (copies.some((v) => v.localPath)) return null;
  return copies.find((v) => SERVER_SONG.test(v.id)) ?? null;
}

function songsOf(key: string): Track[] {
  if (key.startsWith("playlist:")) return useLibrary.getState().playlists.find((p) => playlistListKey(p.id) === key)?.tracks ?? [];
  if (key.startsWith("album:")) {
    const { tracks } = useCatalog.getState();
    return buildAlbums(tracks, useAlbumEdits.getState().artists).find((a) => albumListKey(a.key) === key)?.tracks ?? [];
  }
  return [];
}

/** What of a kept list isn't here yet, as the copies to fetch. A song taken off by hand stays off. */
function stillToFetch(keys: readonly string[]): Track[] {
  const copies = keys.map((key) => songsOf(key).map(serverCopy).filter((t): t is Track => !!t));
  return missingFromLists(copies, (copy) => {
    const status = getDownload(copy.id)?.status;
    return status !== "queued" && status !== "downloading" && status !== "done" && status !== "removed";
  });
}

export function completeKeptLists(): void {
  const { keptLists } = useSettings.getState();
  if (!keptLists.length || !useCatalog.getState().loaded || !useLibrary.persist.hasHydrated()) return;
  const missing = stillToFetch(keptLists);
  if (missing.length) downloadForOffline(missing);
}

/**
 * The look at the start, besides the lists kept whole: an offline copy whose file is gone from
 * the disk, and a download that broke off or failed, go on their way again by themselves, with
 * one short note on how many. What was taken off by hand ("Remove download") stays off, and a
 * song the server doesn't have any more isn't asked for. Answers how many went on their way.
 */
export async function checkDownloadsAtStart(): Promise<number> {
  await downloadsReconciled();
  const bridge = window.bytune;
  const rows = Object.values(useLibrary.getState().downloads).filter((d) => SERVER_SONG.test(d.track.id));
  const done = rows.filter((d) => d.status === "done" && d.path);
  const gone = new Set<string>(done.length && bridge?.downloadsMissing ? await bridge.downloadsMissing(done.map((d) => d.path as string)).catch(() => []) : []);
  const lib = useLibrary.getState();
  for (const d of done) if (gone.has(d.path as string)) lib.patchDownload(d.track.id, { status: "failed", progress: 0 });

  const { byId } = useCatalog.getState();
  const again = new Map<string, Track>();
  for (const d of Object.values(useLibrary.getState().downloads)) {
    if (d.status !== "failed" || !SERVER_SONG.test(d.track.id)) continue;
    const current = byId.get(d.track.id);
    if (current) again.set(current.id, current);
  }
  for (const t of stillToFetch(useSettings.getState().keptLists)) again.set(t.id, t);
  for (const t of again.values()) void startDownload(t);
  if (again.size) {
    useUI.getState().toast(again.size === 1 ? T("A missing song is downloading again") : T("{count} missing songs are downloading again", { count: again.size }), "info");
  }
  return again.size;
}

/** Downloaded as a whole, and from then on kept whole. A second press stops that; the files stay. */
export function toggleKeptList(key: string, tracks: Track[]): void {
  const settings = useSettings.getState();
  if (settings.keptLists.includes(key)) {
    settings.setKeptLists(settings.keptLists.filter((k) => k !== key));
    return;
  }
  settings.setKeptLists([...settings.keptLists, key]);
  downloadForOffline(tracks.map(serverCopy).filter((t): t is Track => !!t));
}

export function watchKeptLists(): () => void {
  let timer: number | null = null;
  // The first look once the library is there is the check at start; the ones after it, the lists'.
  let started = false;
  const look = (): void => {
    if (!useCatalog.getState().loaded || !useLibrary.persist.hasHydrated()) return;
    if (started) {
      completeKeptLists();
      return;
    }
    started = true;
    void checkDownloadsAtStart();
  };
  const soon = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      look();
    }, AFTER_A_CHANGE_MS);
  };
  const offLibrary = useLibrary.subscribe((s, prev) => {
    if (s.playlists !== prev.playlists) soon();
  });
  const offCatalog = useCatalog.subscribe((s, prev) => {
    if (s.tracks !== prev.tracks || s.loaded !== prev.loaded) soon();
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.keptLists !== prev.keptLists) soon();
  });
  const offRefresh = useUI.subscribe((s, prev) => {
    if (s.viewReloadNonce !== prev.viewReloadNonce) soon();
  });
  const every = window.setInterval(soon, KEPT_LISTS_LOOK_EVERY_MS);
  soon();
  return () => {
    offLibrary();
    offCatalog();
    offSettings();
    offRefresh();
    window.clearInterval(every);
    if (timer !== null) window.clearTimeout(timer);
  };
}
