/**
 * Panel-level drop routing — the whole middle surface (the rounded panel)
 * accepts song drops whenever the open page is a container that can hold
 * them: a playlist, Liked Songs, or the local folder view. Everything else
 * (home, search, artist pages…) stays a non-target and keeps the OS
 * "blocked" cursor.
 *
 * Only TRACK drags are accepted — playlist drags pass through untouched
 * (see useTrackDrop). The hovering flag drives the full-panel
 * highlight App renders inside the main surface, same design as the
 * sidebar's row highlight (ring-accent/60 + ink tint).
 */
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { LocalFolderEntry } from "../../electron/local-library";
import type { Track } from "../types";
import { getDownload, SERVER_SONG, startDownload } from "./downloads";
import { useTrackDrop } from "./dnd";
import { T } from "./i18n";

function addToOpenPlaylist(playlistId: string, track: Track): void {
  const lib = useLibrary.getState();
  const name = lib.playlists.find((p) => p.id === playlistId)?.name ?? "playlist";
  const added = lib.addToPlaylist(playlistId, track);
  useUI.getState().toast(added ? T("Added to \"{name}\"", { name }) : T("Already in \"{name}\"", { name }), added ? "success" : "info");
}

function likeTrack(track: Track): void {
  const lib = useLibrary.getState();
  if (lib.liked.some((t) => t.id === track.id)) {
    useUI.getState().toast(T("Already in Liked Songs"), "info");
    return;
  }
  lib.toggleLike(track);
  useUI.getState().toast(T("Added to Liked Songs"), "success");
}

/** A server song dropped on the folder page downloads straight into it. */
function downloadIntoLocalFolder(track: Track, target?: string | null): void {
  void (async () => {
    const lib = await window.bytune?.localLibrary();
    const entries = lib?.folders ?? [];
    // The open collection is the drop target; the overall fallback is the
    // first imported folder. Entries may still be legacy bare-string paths.
    const first = entries[0] as LocalFolderEntry | string | undefined;
    const fallback = typeof first === "string" ? first : first?.path;
    const folder = target && target !== "all" ? target : fallback;
    if (!folder) {
      useUI.getState().toast(T("Set up a local folder first"), "info");
      return;
    }
    if (!SERVER_SONG.test(track.id)) {
      useUI.getState().toast(T("That song is already in your local library"), "info");
      return;
    }
    await startDownload(track, folder);
    // startDownload refuses silently when the track is already saved or
    // already in flight — only claim the toast and watch for the file when a
    // download actually began, or the toast lied and the listener lingered
    // (rescanning on some future, unrelated download).
    if (getDownload(track.id)?.status !== "queued") {
      return;
    }
    useUI.getState().toast(T("Downloading \"{title}\" into the folder", { title: track.title }), "success");
    // Rescan when the file lands, then tell the open view to refresh. Cancel
    // counts as terminal too — the listener must not outlive its download.
    const off = window.bytune?.onDownloadEvent?.((e) => {
      if (e.type === "done" || e.type === "failed" || e.type === "cancelled") {
        off?.();
        if (e.type === "done") {
          void window.bytune
            ?.scanLibrary(useSettings.getState().filterNonMusicAudio)
            .then((res) => window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: res })));
        }
      }
    });
  })().catch(() => undefined);
}

export function usePanelDrop(): {
  hovering: boolean;
  props: {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
  };
} {
  // The panel is only a target while the open page can hold songs.
  const accepts = (): boolean => {
    const v = useUI.getState().view;
    return (
      (v.name === "playlist" && !!v.param) ||
      (v.name === "library" && v.param === "liked") ||
      v.name === "local"
    );
  };
  return useTrackDrop((track) => {
    const view = useUI.getState().view;
    if (view.name === "playlist" && view.param) addToOpenPlaylist(view.param, track);
    else if (view.name === "library" && view.param === "liked") likeTrack(track);
    else if (view.name === "local") downloadIntoLocalFolder(track, view.param);
  }, accepts);
}
