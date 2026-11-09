/**
 * Songs kept on the phone. The native side fetches them (SongDownloads.kt), one
 * or two at a time, also with the app out of sight; this store knows which song
 * lies where, hands over what's asked for and follows how they stand. A kept
 * song brings its cover and lyrics along, so it has them without any connection.
 */
import { Directory, File, Paths } from "expo-file-system";
import { create } from "zustand";
import Player from "../../modules/media3-player";
import { withoutServer } from "../addresses";
import { authHeader, downloadPlan, type DownloadQuality } from "../jellyfin";
import { keepLyrics } from "../lyrics";
import type { Track } from "../shared";
import { readJson, writeJson } from "../storage";
import { useConnection } from "./connection";
import { useLibrary } from "./library";
import { here, useSession } from "./session";
import { T } from "../shared";

const FILE = "downloads.json";
/** Handed over at a time: the native side works through them while timers here stand still in the background. */
const AT_ONCE = 500;
const FOLLOW_EVERY_MS = 1000;
const TRIES = 3;

export interface KeptSong {
  file: string;
  bytes: number;
  /** the smaller copy, not the server's file */
  compact: boolean;
}

export interface LoadingSong {
  /** the native side's number; null while it waits for its turn */
  job: number | null;
  fileName: string;
  compact: boolean;
  tries: number;
  /** waits for Wi-Fi because mobile data isn't allowed */
  wantsWifi: boolean;
  failed: boolean;
}

/** How far a song is that's being fetched right now. */
export interface SongProgress {
  loaded: number;
  /** -1 when the server doesn't say, as for a copy it makes on the way */
  total: number;
}

interface Saved {
  kept?: Record<string, KeptSong>;
  loading?: Record<string, LoadingSong>;
  covers?: Record<string, string>;
  quality?: DownloadQuality;
  overMobile?: boolean;
  lists?: Record<string, true>;
  notWanted?: Record<string, true>;
  listsNoted?: boolean;
}

interface DownloadsState {
  /** by song */
  kept: Record<string, KeptSong>;
  /** by song, in the order they were asked for */
  loading: Record<string, LoadingSong>;
  /** the ones being fetched right now, by song: changes all the time, so it stays apart and isn't saved */
  progress: Record<string, SongProgress>;
  /** a cover's file by what identifies the picture */
  covers: Record<string, string>;
  quality: DownloadQuality;
  overMobile: boolean;
  /** what went wrong last, in words */
  lastProblem: string | null;
  /** what the phone remembers has been read */
  restored: boolean;
  /** lists downloaded as a whole: they stay whole (stores/keptLists.ts) */
  lists: Record<string, true>;
  /** songs somebody took off by hand: no list brings them back */
  notWanted: Record<string, true>;
  /** lists that were whole before lists were remembered have been looked for */
  listsNoted: boolean;
  restore(): Promise<void>;
  /** `byItself`: nobody asked for these songs just now, so what was taken off by hand stays off */
  add(tracks: Track[], byItself?: boolean): void;
  /** `byHand`: this one song, not a whole list */
  remove(tracks: Track[], byHand?: boolean): void;
  removeAll(): void;
  keepList(key: string): void;
  dropList(key: string): void;
  noteLists(keys: string[]): void;
  setQuality(quality: DownloadQuality): void;
  setOverMobile(on: boolean): void;
}

export const useDownloads = create<DownloadsState>((set, get) => ({
  kept: {},
  loading: {},
  progress: {},
  covers: {},
  quality: "original",
  overMobile: false,
  lastProblem: null,
  restored: false,
  lists: {},
  notWanted: {},
  listsNoted: false,

  async restore() {
    // The notification counts on the native side, in the app's language.
    void Player.downloadTexts({
      channel: T("Downloads"),
      loading: T("Downloading songs"),
      progress: T("{done} of {total}"),
      doneOne: T("1 song downloaded"),
      doneMany: T("{count} songs downloaded"),
      failed: T("{count} didn't download"),
      wifi: T("Waiting for Wi-Fi"),
    }).catch(() => undefined);
    const saved = await readJson<Saved>(FILE);
    if (!saved) {
      set({ restored: true });
      return;
    }
    const kept = saved.kept ?? {};
    // Files cleared from outside are gone; the check at opening (checkDownloads) fetches them again.
    const found = new Set(await Player.downloadExisting(Object.values(kept).map((k) => k.file)).catch(() => Object.values(kept).map((k) => k.file)));
    lost = Object.keys(kept).filter((id) => !found.has(kept[id].file));
    set({
      kept: Object.fromEntries(Object.entries(kept).filter(([, k]) => found.has(k.file))),
      loading: saved.loading ?? {},
      covers: saved.covers ?? {},
      quality: saved.quality ?? "original",
      overMobile: saved.overMobile ?? false,
      lists: saved.lists ?? {},
      notWanted: saved.notWanted ?? {},
      listsNoted: saved.listsNoted ?? false,
      restored: true,
    });
    followSoon();
  },

  add(tracks, byItself = false) {
    const { kept, loading, notWanted } = get();
    const next = { ...loading };
    const wanted = { ...notWanted };
    for (const t of tracks) {
      if (!byItself) delete wanted[t.id];
      // Already on the phone, in a folder.
      if (t.localPath) continue;
      if (kept[t.id] || (next[t.id] && !next[t.id].failed)) continue;
      next[t.id] = { job: null, fileName: "", compact: false, tries: 0, wantsWifi: false, failed: false };
    }
    set({ loading: next, notWanted: wanted });
    save();
    followSoon();
  },

  remove(tracks, byHand = true) {
    const kept = { ...get().kept };
    const loading = { ...get().loading };
    const notWanted = { ...get().notWanted };
    for (const t of tracks) {
      if (byHand) notWanted[t.id] = true;
      const job = loading[t.id]?.job;
      if (job != null) void Player.downloadCancel(job);
      delete loading[t.id];
      if (kept[t.id]) void Player.downloadDelete(kept[t.id].file);
      delete kept[t.id];
    }
    set({ kept, loading, notWanted });
    dropUnusedCovers();
    save();
  },

  keepList(key) {
    set({ lists: { ...get().lists, [key]: true } });
    save();
  },

  dropList(key) {
    const lists = { ...get().lists };
    delete lists[key];
    set({ lists });
    save();
  },

  noteLists(keys) {
    const lists = { ...get().lists };
    for (const key of keys) lists[key] = true;
    set({ lists, listsNoted: true });
    save();
  },

  removeAll() {
    const { kept, loading } = get();
    for (const song of Object.values(loading)) if (song.job !== null) void Player.downloadCancel(song.job);
    for (const song of Object.values(kept)) void Player.downloadDelete(song.file);
    set({ kept: {}, loading: {}, lists: {}, notWanted: {} });
    dropUnusedCovers();
    save();
  },

  setQuality(quality) {
    set({ quality });
    save();
  },

  setOverMobile(overMobile) {
    // What already waits for Wi-Fi was handed over under the old rule.
    const loading = Object.fromEntries(
      Object.entries(get().loading).map(([id, song]) => {
        if (song.job !== null) void Player.downloadCancel(song.job);
        return [id, { ...song, job: null, wantsWifi: false }];
      })
    );
    set({ overMobile, loading });
    save();
    followSoon();
  },
}));

function save(): void {
  const { kept, loading, covers, quality, overMobile, lists, notWanted, listsNoted } = useDownloads.getState();
  writeJson(FILE, { kept, loading, covers, quality, overMobile, lists, notWanted, listsNoted });
}

/** Kept songs whose files were found cleared from outside when the app started. */
let lost: string[] = [];

/**
 * When the app opens, and when it comes back after a while (stores/keptLists.ts): what should be
 * on the phone and isn't goes on its way again by itself. A song whose file was cleared from
 * outside comes back, unless it was taken off by hand; one that gave up after its tries gets new
 * ones. A song the server doesn't have any more isn't asked for. Answers how many went on their
 * way, or null while the phone hasn't read what it has yet.
 */
export function checkDownloads(): number | null {
  const { loading, kept, notWanted, restored } = useDownloads.getState();
  const { byId, loaded } = useLibrary.getState();
  if (!restored || !loaded) return null;
  const next = { ...loading };
  let again = 0;
  for (const [id, song] of Object.entries(loading)) {
    if (!song.failed || !byId.has(id)) continue;
    next[id] = { ...song, job: null, tries: 0, failed: false, wantsWifi: false };
    again += 1;
  }
  for (const id of lost) {
    if (notWanted[id] || kept[id] || next[id] || !byId.has(id) || byId.get(id)?.localPath) continue;
    next[id] = { job: null, fileName: "", compact: false, tries: 0, wantsWifi: false, failed: false };
    again += 1;
  }
  lost = [];
  if (again) {
    useDownloads.setState({ loading: next });
    save();
    followSoon();
  }
  return again;
}

function patch(id: string, change: Partial<LoadingSong>): void {
  const { loading } = useDownloads.getState();
  const song = loading[id];
  if (song) useDownloads.setState({ loading: { ...loading, [id]: { ...song, ...change } } });
}

function retry(id: string, song: LoadingSong): void {
  patch(id, song.tries + 1 < TRIES ? { job: null, tries: song.tries + 1, wantsWifi: false } : { job: null, failed: true, wantsWifi: false });
}

async function keepCover(track: Track): Promise<void> {
  if (!track.thumb) return;
  const key = withoutServer(track.thumb);
  if (useDownloads.getState().covers[key]) return;
  try {
    const folder = new Directory(Paths.document, "covers");
    if (!folder.exists) folder.create();
    const file = new File(folder, `${key.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 120)}.jpg`);
    if (!file.exists) await File.downloadFileAsync(here(track.thumb), file);
    useDownloads.setState({ covers: { ...useDownloads.getState().covers, [key]: file.uri } });
    save();
  } catch {
    /* the song plays without its picture */
  }
}

/** A cover stays as long as a kept song shows it. */
function dropUnusedCovers(): void {
  const { kept, covers } = useDownloads.getState();
  const { byId } = useLibrary.getState();
  const used = new Set(Object.keys(kept).map((id) => withoutServer(byId.get(id)?.thumb ?? "")));
  const next: Record<string, string> = {};
  for (const [key, uri] of Object.entries(covers)) {
    if (used.has(key)) next[key] = uri;
    else {
      try {
        new File(uri).delete();
      } catch {
        /* gone either way */
      }
    }
  }
  useDownloads.setState({ covers: next });
}

async function finished(id: string, song: LoadingSong): Promise<void> {
  const done = await Player.downloadFinish(song.job as number).catch(() => null);
  if (!done) {
    retry(id, song);
    return;
  }
  const { kept, loading } = useDownloads.getState();
  const rest = { ...loading };
  delete rest[id];
  useDownloads.setState({ kept: { ...kept, [id]: { file: done.file, bytes: done.bytes, compact: song.compact } }, loading: rest });
  save();
  const track = useLibrary.getState().byId.get(id);
  if (track) {
    void keepCover(track);
    keepLyrics(track);
  }
}

/** Hands over the next ones, as many as are allowed at a time. */
async function handOver(): Promise<void> {
  const session = useSession.getState().session;
  if (!session || useConnection.getState().reach === "offline") return;
  // Until the library is read, no song can be found: they would all count as gone.
  if (!useLibrary.getState().loaded) return;
  const { loading, quality, overMobile } = useDownloads.getState();
  let running = Object.values(loading).filter((song) => song.job !== null).length;
  for (const [id, song] of Object.entries(loading)) {
    if (running >= AT_ONCE) break;
    if (song.job !== null || song.failed) continue;
    const track = useLibrary.getState().byId.get(id);
    if (!track) {
      patch(id, { failed: true });
      continue;
    }
    const plan = downloadPlan(session, track, quality);
    try {
      const job = await Player.downloadStart(plan.url, { Authorization: authHeader(session.deviceId, session.token) }, plan.fileName, !overMobile, track.title);
      patch(id, { job, fileName: plan.fileName, compact: plan.compact });
      running += 1;
    } catch (err) {
      useDownloads.setState({ lastProblem: err instanceof Error ? err.message : T("The download didn't start") });
      retry(id, song);
    }
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let following = false;

async function follow(): Promise<void> {
  if (following) return;
  following = true;
  try {
    const before = useDownloads.getState().loading;
    const jobs = Object.values(before)
      .map((song) => song.job)
      .filter((job): job is number => job !== null);
    const report = new Map((await Player.downloadQuery(jobs).catch(() => [])).map((row) => [row.job, row]));
    const progress: Record<string, SongProgress> = {};
    for (const [id, song] of Object.entries(before)) {
      if (song.job === null) continue;
      const row = report.get(song.job);
      if (row?.status === "running") progress[id] = { loaded: row.loaded, total: row.total };
      if (!row) {
        // Handed over before the app was last closed: what's fetched so far is still there.
        void Player.downloadCancel(song.job);
        patch(id, { job: null, wantsWifi: false });
      } else if (row.status === "failed") {
        useDownloads.setState({ lastProblem: row.problem || T("The download stopped") });
        retry(id, song);
      }
      else if (row.status === "done") await finished(id, song);
      else {
        // Android often just leaves it pending on mobile data rather than say so.
        const { overMobile } = useDownloads.getState();
        const wantsWifi = row.status === "wifi" || (row.status === "waiting" && useConnection.getState().metered && !overMobile);
        if (wantsWifi !== song.wantsWifi) patch(id, { wantsWifi });
      }
    }
    useDownloads.setState({ progress });
    await handOver();
    if (useDownloads.getState().loading !== before) save();
  } finally {
    following = false;
    if (Object.values(useDownloads.getState().loading).some((song) => !song.failed)) followSoon();
  }
}

function followSoon(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void follow();
  }, FOLLOW_EVERY_MS);
}

useConnection.subscribe((s, prev) => {
  if (prev.reach === "offline" && s.reach !== "offline") followSoon();
});

/** "480 MB", "1.2 GB" */
export function sizeLine(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** Whole percent of a song being fetched; -1 when nobody knows how big it is; null when it isn't being fetched right now. */
export function percentOf(s: DownloadsState, id: string): number | null {
  const now = s.progress[id];
  if (!now) return null;
  return now.total > 0 ? Math.min(100, Math.floor((now.loaded / now.total) * 100)) : -1;
}

export type SongDownload = "kept" | "loading" | "wifi" | "failed" | null;

export function downloadOf(s: DownloadsState, id: string): SongDownload {
  if (s.kept[id]) return "kept";
  const song = s.loading[id];
  if (!song) return null;
  return song.failed ? "failed" : song.wantsWifi ? "wifi" : "loading";
}

/** How the downloads stand, in short: goes out with the playback note, for a look from afar. */
export function downloadsLine(): string {
  const { kept, loading, overMobile, lastProblem } = useDownloads.getState();
  const songs = Object.values(loading);
  if (!songs.length && !lastProblem) return "";
  const count = (test: (song: LoadingSong) => boolean): number => songs.filter(test).length;
  return `downloads ${Object.keys(kept).length} kept, ${count((song) => !song.failed)} loading, ${count((song) => song.wantsWifi)} for wifi, ${count((song) => song.failed)} failed${overMobile ? ", mobile data allowed" : ""}${lastProblem ? `, ${lastProblem}` : ""}`;
}
