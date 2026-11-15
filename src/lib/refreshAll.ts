/**
 * The top bar's Refresh: everything read again, as at a start of the app, while the music plays on.
 * The music folder is looked through for new and changed files (and their covers), every server
 * lists its songs again, the catalogue is built anew from all of it, the sync service is asked
 * what's new, and the page on screen (Home's feed included) loads afresh. A note says what came of it.
 */
import { announceRemoteLibraryChange, useCatalog } from "../stores/catalog";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { syncLookNow } from "./homeSync";
import { T } from "./i18n";
import { plural } from "./format";

let running: Promise<void> | null = null;

/** Whether a refresh is under way: the button turns while it is. */
export const refreshing = (): boolean => running !== null;

export function refreshEverything(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const bridge = window.bytune;
    const before = new Set(useCatalog.getState().tracks.map((t) => t.id));
    const failed: string[] = [];
    if (bridge) {
      const [jf, ss] = await Promise.all([bridge.jellyfinStatus().catch(() => null), bridge.subsonicStatus().catch(() => null)]);
      const folder = useSettings.getState().localMusicFolder;
      await Promise.all([
        // New, changed and deleted files in the music folder; unchanged ones are only looked at.
        folder
          ? bridge
              .scanLibrary(useSettings.getState().filterNonMusicAudio)
              .then((lib) => window.dispatchEvent(new CustomEvent("bytune:local-library-updated", { detail: lib })))
              .catch(() => failed.push(T("your music folder")))
          : Promise.resolve(),
        (jf as { connected?: boolean } | null)?.connected
          ? bridge
              .jellyfinRelist()
              .then((changed) => {
                if (changed === null) failed.push("Jellyfin");
                else if (changed) announceRemoteLibraryChange();
              })
              .catch(() => failed.push("Jellyfin"))
          : Promise.resolve(),
        (ss as { connected?: boolean } | null)?.connected
          ? bridge
              .subsonicRelist()
              .then((changed) => {
                if (changed === null) failed.push(T("your Navidrome or Subsonic server"));
                else if (changed) announceRemoteLibraryChange();
              })
              .catch(() => failed.push(T("your Navidrome or Subsonic server")))
          : Promise.resolve(),
      ]);
    }
    // Built anew whatever the sources said: covers found meanwhile, edits, play counts.
    await useCatalog.getState().load();
    await useCatalog.getState().refreshPlayCounts();
    syncLookNow();
    // The page on screen loads afresh: Home drops its feed and puts it together again.
    useUI.getState().bumpViewReload();
    const added = useCatalog.getState().tracks.filter((t) => !before.has(t.id)).length;
    const toast = useUI.getState().toast;
    if (failed.length) toast(T("Refreshed, but {what} couldn't be read just now", { what: failed.join(", ") }), "warning");
    else if (added > 0) toast(T("Refreshed: {count} new", { count: plural(added, T("song"), T("songs")) }), "success");
    else toast(T("Everything is up to date"), "success");
  })().finally(() => {
    running = null;
  });
  return running;
}
