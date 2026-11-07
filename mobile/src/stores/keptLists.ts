/**
 * The phone's share of lists that stay whole (lib/keptLists.ts): it looks when the app starts or
 * comes back, after a pull-down, when a list or the library changes, when the server is back, and
 * every so often for what failed before.
 */
import { AppState } from "react-native";
import { completeLists, KEPT_LISTS_LOOK_EVERY_MS, LIKED_LIST, missingFromLists, albumListKey, playlistListKey, type Track } from "../shared";
import { useConnection } from "./connection";
import { useDownloads } from "./downloads";
import { likedSongIds, useLibrary } from "./library";
import { playlistTracks, usePlaylists } from "./playlists";

const AFTER_A_CHANGE_MS = 3000;

/** What's on a list now; null when the list isn't there (any more). */
function songsOf(key: string): readonly Track[] | null {
  const { data, byId, albums } = useLibrary.getState();
  if (key === LIKED_LIST) return likedSongIds(data.favorites, byId).map((id) => byId.get(id)).filter((t): t is Track => !!t);
  if (key.startsWith("album:")) return albums.find((a) => albumListKey(a.key) === key)?.tracks ?? null;
  const playlist = usePlaylists.getState().playlists.find((p) => playlistListKey(p.id) === key);
  return playlist ? playlistTracks(playlist).filter((t) => !t.missing) : null;
}

/** Everything on a kept list that isn't on the phone yet goes on its way. */
export function completeKeptLists(): void {
  const { lists, kept, loading, notWanted, add, restored } = useDownloads.getState();
  if (!restored || !useLibrary.getState().loaded) return;
  const songs = Object.keys(lists)
    .map(songsOf)
    .filter((list): list is readonly Track[] => !!list);
  const missing = missingFromLists(songs, (t) => !t.localPath && !kept[t.id] && !(loading[t.id] && !loading[t.id].failed) && !notWanted[t.id]);
  if (missing.length) add(missing, true);
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
  const soon = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      noteWholeLists();
      completeKeptLists();
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
    if (state === "active") soon();
  });
  setInterval(soon, KEPT_LISTS_LOOK_EVERY_MS);
  soon();
}
