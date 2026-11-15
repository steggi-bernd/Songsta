/**
 * Pulling Home down: everything read again, as at a start of the app, while the music plays on.
 * The server is asked how it can be reached and lists its songs again (with the likes and plays
 * left to send going out first), the phone's music folders are looked through for new and changed
 * files, the downloads are checked, and the sync service is asked what's new. A note says what
 * came of it. The phone's other pulls (the pages that close) are a different gesture.
 */
import { checkDownloads } from "./stores/downloads";
import { useLibrary } from "./stores/library";
import { useLocalMusic } from "./stores/localMusic";
import { toast } from "./stores/popups";
import { syncLookNow } from "./sync";
import { plural, T } from "./shared";

let running: Promise<void> | null = null;

export function refreshEverything(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const before = new Set(useLibrary.getState().tracks.map((t) => t.id));
    await Promise.all([useLibrary.getState().refresh(), useLocalMusic.getState().folders.length ? useLocalMusic.getState().rescan() : Promise.resolve()]);
    useLibrary.getState().applyLocal();
    checkDownloads();
    syncLookNow();
    const { error, tracks } = useLibrary.getState();
    const added = tracks.filter((t) => !before.has(t.id)).length;
    if (error) return; // Home shows what went wrong
    if (added > 0) toast(T("Refreshed: {count} new", { count: plural(added, T("song"), T("songs")) }));
    else toast(T("Everything is up to date"));
  })().finally(() => {
    running = null;
  });
  return running;
}
