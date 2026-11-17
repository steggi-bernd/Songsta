/**
 * Pulling Home down: everything read again, as at a start of the app, while the music plays on.
 * The server is asked how it can be reached and lists its songs again (with the likes and plays
 * left to send going out first), the phone's music folders are looked through for new and changed
 * files, the downloads are checked, and the sync service is asked what's new. The phone's other
 * pulls (the pages that close) are a different gesture.
 *
 * What came of each step is told as it happens (`useRefreshReport`), a line at a time: Home shows
 * the lines where its greeting stands, one after the other (the user's wish, 2026-11-17), ending
 * with "All up to date" or that the server can't be reached.
 */
import { create } from "zustand";
import { APP_VERSION } from "./newVersion";
import { isNewerVersion, T } from "./shared";
import { checkDownloads } from "./stores/downloads";
import { useLibrary } from "./stores/library";
import { useLocalMusic } from "./stores/localMusic";
import { useSession } from "./stores/session";
import { useSettings } from "./stores/settings";
import { syncLookNow, useSync } from "./sync";

export interface ReportLine {
  id: number;
  text: string;
  /** asking still, fine, something's wrong, or the last word */
  tone: "busy" | "ok" | "warn" | "done";
}

/** `told`: Home has shown the last line (GreetingTicker says so), so for whoever watches, loading is over. */
export const useRefreshReport = create<{ lines: ReportLine[]; running: boolean; told: boolean }>(() => ({ lines: [], running: false, told: true }));

let line = 0;
const say = (text: string, tone: ReportLine["tone"] = "ok"): void => useRefreshReport.setState((s) => ({ lines: [...s.lines, { id: ++line, text, tone }] }));

/**
 * Settles once Home has shown the last line of the report, or after `atMost` should nothing show it:
 * the pull's visualizer plays until then, so it ends with "All up to date" and not lines before it.
 */
export function whenTold(atMost = 16_000): Promise<void> {
  return new Promise((resolve) => {
    if (useRefreshReport.getState().told) return resolve();
    const finish = (): void => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const stop = useRefreshReport.subscribe((s) => {
      if (s.told) finish();
    });
    const timer = setTimeout(finish, atMost);
  });
}

let running: Promise<void> | null = null;

export function refreshEverything(): Promise<void> {
  if (running) return running;
  useRefreshReport.setState({ lines: [], running: true, told: false });
  running = (async () => {
    const library = useLibrary.getState();
    const songsBefore = new Set(library.tracks.map((t) => t.id));
    const albumsBefore = new Set(library.albums.map((a) => a.key));
    const server = !!useSession.getState().session;
    const folders = useLocalMusic.getState().folders.length > 0;
    say(server ? T("Asking your server…") : T("Looking through your music…"), "busy");
    await Promise.all([library.refresh(), folders ? useLocalMusic.getState().rescan() : Promise.resolve()]);
    useLibrary.getState().applyLocal();
    const { error, tracks, albums } = useLibrary.getState();
    const unreachable = server && !!error;
    if (server) say(unreachable ? T("Server: can't be reached") : T("Server: reached"), unreachable ? "warn" : "ok");
    if (!unreachable || folders) {
      const newAlbums = albums.filter((a) => !albumsBefore.has(a.key)).length;
      const newSongs = tracks.filter((t) => !songsBefore.has(t.id)).length;
      say(newAlbums ? T("Albums: {count} new", { count: newAlbums }) : T("Albums: up to date"));
      say(newSongs ? T("Songs: {count} new", { count: newSongs }) : T("Songs: up to date"));
    }
    if (folders) say(T("Your folders: looked through"));
    const again = checkDownloads();
    say(again ? T("Downloads: {count} tried again", { count: again }) : T("Downloads: checked"));
    syncLookNow();
    const sync = useSync.getState().status;
    if (sync === "connected") say(T("Playlists and likes: in step"));
    else if (sync === "unreachable") say(T("Sync service: can't be reached"), "warn");
    const latest = useSettings.getState().newVersion.latest;
    say(isNewerVersion(latest, APP_VERSION) ? T("Songsta {version} is out", { version: latest }) : T("Songsta: up to date"));
    say(unreachable ? T("Server not reachable") : T("All up to date"), unreachable ? "warn" : "done");
  })().finally(() => {
    running = null;
    useRefreshReport.setState({ running: false });
  });
  return running;
}
