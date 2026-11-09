/**
 * The phone's share of lists that stay whole (lib/keptLists.ts): it looks when the app starts or
 * comes back, after a pull-down, when a list or the library changes, when the server is back, and
 * every so often for what failed before. The look when the app opens goes further: every download
 * is checked (checkDownloads), and one short note says how many songs go on their way again.
 */
import { AppState } from "react-native";
import { completeLists, KEPT_LISTS_LOOK_EVERY_MS, LIKED_LIST, missingFromLists, albumListKey, playlistListKey, T, type Track } from "../shared";
import { useConnection } from "./connection";
import { checkDownloads, useDownloads } from "./downloads";
import { likedSongIds, useLibrary } from "./library";
import { playlistTracks, usePlaylists } from "./playlists";
import { toast } from "./popups";

const AFTER_A_CHANGE_MS = 3000;
/** Back after this long out of sight counts as opening the app again. */
const OPENING_AFTER_MS = 10 * 60_000;

/** What's on a list now; null when the list isn't there (any more). */
function songsOf(key: string): readonly Track[] | null {
  const { data, byId, albums } = useLibrary.getState();
  if (key === LIKED_LIST) return likedSongIds(data.favorites, byId).map((id) => byId.get(id)).filter((t): t is Track => !!t);
  if (key.startsWith("album:")) return albums.find((a) => albumListKey(a.key) === key)?.tracks ?? null;
  const playlist = usePlaylists.getState().playlists.find((p) => playlistListKey(p.id) === key);
  return playlist ? playlistTracks(playlist).filter((t) => !t.missing) : null;
}

/** Everything on a kept list that isn't on the phone yet goes on its way; answers how many songs. */
export function completeKeptLists(): number {
  const { lists, kept, loading, notWanted, add, restored } = useDownloads.getState();
  if (!restored || !useLibrary.getState().loaded) return 0;
  const songs = Object.keys(lists)
    .map(songsOf)
    .filter((list): list is readonly Track[] => !!list);
  const missing = missingFromLists(songs, (t) => !t.localPath && !kept[t.id] && !(loading[t.id] && !loading[t.id].failed) && !notWanted[t.id]);
  if (missing.length) add(missing, true);
  return missing.length;
}

/** Songs another kept list than this one still has. */
function keptElsewhere(key: string | undefined): Set<string> {
  const ids = new Set<string>();
  for (const other of Object.keys(useDownloads.getState().lists)) {
    if (other === key) continue;
    for (const t of songsOf(other) ?? []) ids.add(t.id);
  }
  return ids;
}

/**
 * A list's downloads taken off as a whole (its download button): what of it is on the phone
 * or on its way goes, except the songs another kept list (a playlist, Liked Songs, an album)
 * still has. Those stay, or that list would fetch them again right after.
 */
export function listDownloads(key: string | undefined, tracks: readonly Track[]): { going: Track[]; staying: Track[] } {
  const { kept, loading } = useDownloads.getState();
  const elsewhere = keptElsewhere(key);
  const going: Track[] = [];
  const staying: Track[] = [];
  const seen = new Set<string>();
  for (const t of tracks) {
    if (seen.has(t.id) || (!kept[t.id] && !loading[t.id])) continue;
    seen.add(t.id);
    (elsewhere.has(t.id) ? staying : going).push(t);
  }
  return { going, staying };
}

/** Takes a list's downloads off (listDownloads): the list isn't kept whole any more, and what no other kept list has leaves the phone. */
export function takeListOff(key: string | undefined, tracks: readonly Track[]): void {
  const { going } = listDownloads(key, tracks);
  const { dropList, remove } = useDownloads.getState();
  if (key) dropList(key);
  remove(going, false);
}

/** Lists that were whole before this was remembered: once. */
function noteWholeLists(): void {
  const { listsNoted, kept, noteLists, restored } = useDownloads.getState();
  if (listsNoted || !restored || !useLibrary.getState().loaded) return;
  const candidates: [string, readonly Track[]][] = [
    ...usePlaylists.getState().playlists.map((p): [string, readonly Track[]] => [playlistListKey(p.id), playlistTracks(p).filter((t) => !t.missing && !t.localPath)]),
    ...useLibrary.getState().albums.map((a): [string, readonly Track[]] => [albumListKey(a.key), a.tracks.filter((t) => !t.localPath)]),
  ];
  noteLists(completeLists(candidates, (t) => !!kept[t.id]));
}

export function watchKeptLists(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The app has just opened: the next look checks every download and says what goes again.
  let opening = true;
  let awayAt = 0;
  const soon = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      noteWholeLists();
      const again = opening ? checkDownloads() : 0;
      const added = completeKeptLists();
      if (again === null) return; // not read yet: the look once it is says it
      if (opening) {
        opening = false;
        const count = again + added;
        if (count) toast(count === 1 ? T("A missing song is downloading again") : T("{count} missing songs are downloading again", { count }));
      }
    }, AFTER_A_CHANGE_MS);
  };
  useLibrary.subscribe((s, prev) => {
    if (s.loaded !== prev.loaded || s.byId !== prev.byId || s.data.favorites !== prev.data.favorites) soon();
    // A pull-down, also when it found nothing new: what failed gets another go.
    if (prev.refreshing && !s.refreshing) soon();
  });
  usePlaylists.subscribe((s, prev) => {
    if (s.playlists !== prev.playlists) soon();
  });
  useDownloads.subscribe((s, prev) => {
    if (s.lists !== prev.lists || s.restored !== prev.restored) soon();
  });
  useConnection.subscribe((s, prev) => {
    if (prev.reach === "offline" && s.reach !== "offline") soon();
  });
  AppState.addEventListener("change", (state) => {
    if (state === "background") awayAt = Date.now();
    if (state !== "active") return;
    if (awayAt && Date.now() - awayAt >= OPENING_AFTER_MS) opening = true;
    soon();
  });
  setInterval(soon, KEPT_LISTS_LOOK_EVERY_MS);
  soon();
}
