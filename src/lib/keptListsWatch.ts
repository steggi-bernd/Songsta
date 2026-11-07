/**
 * The computer's share of lists that stay whole (lib/keptLists.ts). A song counts as there
 * once a copy of it lies in the library: what's on a server only is fetched for offline.
 * It looks at the start, on Refresh, when a list or the library changes, and every so often.
 */
import { useAlbumEdits } from "../stores/albumEdits";
import { useCatalog, versionsOf } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { buildAlbums } from "./catalogBuild";
import { downloadForOffline, getDownload, SERVER_SONG } from "./downloads";
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

/** What of a kept list isn't here yet, as the copies to fetch. */
function stillToFetch(keys: readonly string[]): Track[] {
  const copies = keys.map((key) => songsOf(key).map(serverCopy).filter((t): t is Track => !!t));
  return missingFromLists(copies, (copy) => {
    const status = getDownload(copy.id)?.status;
    return status !== "queued" && status !== "downloading" && status !== "done";
  });
}

export function completeKeptLists(): void {
  const { keptLists } = useSettings.getState();
  if (!keptLists.length || !useCatalog.getState().loaded || !useLibrary.persist.hasHydrated()) return;
  const missing = stillToFetch(keptLists);
  if (missing.length) downloadForOffline(missing);
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
  const soon = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      completeKeptLists();
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
