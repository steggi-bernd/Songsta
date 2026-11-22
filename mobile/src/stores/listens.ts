/**
 * What was played, song by song, for Replay (screens/ReplayScreen.tsx): each listen that counted as
 * a play, with its moment and the song's length.
 *
 *  - This phone's own plays, from the day this exists.
 *  - With a sync service, the other devices' too (the computer's, mostly): the listening history all
 *    devices share (lib/listenSync.ts). This phone sends its plays and takes the others' in, so Replay
 *    counts every play everywhere; how far it sent and read is kept per sync service.
 */
import { create } from "zustand";
import { listenKey, type ListenDevice, type SharedListen, type Track, type WireListen } from "../shared";
import { readJson, writeJson } from "../storage";
import { useSettings } from "./settings";

const FILE = "listens.json";
const SHARED_FILE = "listens-shared.json";
/** Roughly five years of heavy listening on this phone; the oldest go first. */
const KEPT = 40_000;
/** The other devices' plays: a computer plays more. */
const KEPT_SHARED = 150_000;
/** The others' plays are written after this long, together. */
const WRITE_AFTER_MS = 4000;

export interface PhoneListen {
  id: string;
  at: number;
  /** the song's length, ms */
  ms: number;
  title: string;
  artist: string;
  album?: string;
  thumb?: string;
  /** another device's play: which device, and what it's called */
  device?: string;
  deviceName?: string;
}

interface SharedSaved {
  /** the sync service these were read from (its server key); another one starts over */
  server?: string;
  /** how many of this phone's plays (the ones kept, oldest first) the service has */
  sentCount?: number;
  /** this phone's plays before this place were taken off the service on asking: never sent again */
  sentFloor?: number;
  /** how far the shared history was read (the service's count) */
  readUpTo: number;
  /** the version (generation) of the service's history read to its end: another one is read afresh */
  generation?: string;
  listens: PhoneListen[];
}

interface ListensState {
  /** this phone's plays, in the order they counted */
  listens: PhoneListen[];
  /** the other devices' plays, from the shared history */
  shared: PhoneListen[];
  server?: string;
  /**
   * How many of this phone's plays, from the oldest kept, the service has. By place, not by moment:
   * one play stamped by a clock that ran ahead doesn't hold back the ones after it.
   */
  sentCount: number;
  /** this phone's plays before this place were taken off the service on asking (sync.ts removeSharedListens): never sent again */
  sentFloor: number;
  readUpTo: number;
  /** the version (generation) of the service's history read to its end */
  generation: string | null;
  /** the sync service keeps no shared history (one from before 1.8) */
  missing: boolean;
  loaded: boolean;
  load(): Promise<void>;
  /** This phone's plays were taken off the sync service: none of those so far goes there again. */
  keepOwnHere(): void;
  /** "Delete" (Settings → Network & privacy): every play kept on this phone, its own and the others', goes. */
  clearAll(): void;
  note(track: Track, at: number): void;
  /** Linked to this sync service: another one starts the shared history over. */
  useServer(server: string): void;
  /** This phone's plays the service doesn't have yet, in the order they counted. */
  pending(max: number): WireListen[];
  /** The service has them, up to and with this one. */
  markSent(last: { at: number; id: string }): void;
  /** The other devices' plays from the service, and how far that reads; with startOver, read it all again and send this phone's plays again. */
  take(listens: SharedListen[], devices: Record<string, ListenDevice>, upTo: number, startOver?: boolean): void;
  setMissing(missing: boolean): void;
  /** The version of the history read to its end, and the one being read afresh right now. */
  versionRead(): { read: string | null; afresh: string | null };
  /** Another version of the service's history: read it from its start; this phone's plays go again. What came in stays. */
  readAfresh(generation: string): void;
  /** That version read to its end. */
  readThrough(generation: string): void;
}

let sharedKeys: Set<string> | null = null;
/** the version of the shared history being read afresh, from its start */
let afresh: string | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function saveShared(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const { server, sentCount, sentFloor, readUpTo, generation, shared } = useListens.getState();
    writeJson(SHARED_FILE, { server, sentCount, sentFloor, readUpTo, ...(generation ? { generation } : {}), listens: shared } satisfies SharedSaved);
  }, WRITE_AFTER_MS);
}

/** Listeners for a play noted here: the sync sends it out (sync.ts). */
const noted = new Set<() => void>();
export function onListenNoted(listener: () => void): () => void {
  noted.add(listener);
  return () => noted.delete(listener);
}

export const useListens = create<ListensState>((set, get) => ({
  listens: [],
  shared: [],
  sentCount: 0,
  sentFloor: 0,
  readUpTo: 0,
  generation: null,
  missing: false,
  loaded: false,
  async load() {
    if (get().loaded) return;
    const [saved, shared] = await Promise.all([readJson<PhoneListen[]>(FILE), readJson<SharedSaved>(SHARED_FILE)]);
    // Listens noted before the files were read stay, after what was saved.
    set((s) => {
      const listens = [...(Array.isArray(saved) ? saved : []), ...s.listens];
      const sentCount = typeof shared?.sentCount === "number" && shared.sentCount >= 0 ? Math.floor(shared.sentCount) : 0;
      const sentFloor = typeof shared?.sentFloor === "number" && shared.sentFloor >= 0 ? Math.floor(shared.sentFloor) : 0;
      // More sent than there are: the plays here were lost; what's here goes again (kept once there).
      const lost = sentCount > listens.length || sentFloor > listens.length;
      return {
        listens,
        shared: Array.isArray(shared?.listens) ? shared.listens : [],
        server: shared?.server,
        sentCount: lost ? 0 : sentCount,
        sentFloor: lost ? 0 : sentFloor,
        readUpTo: typeof shared?.readUpTo === "number" ? shared.readUpTo : 0,
        generation: typeof shared?.generation === "string" && shared.generation ? shared.generation : null,
        loaded: true,
      };
    });
    sharedKeys = null;
  },
  keepOwnHere() {
    const n = get().listens.length;
    set((s) => ({ sentFloor: n, sentCount: Math.max(s.sentCount, n) }));
    saveShared();
  },
  clearAll() {
    sharedKeys = null;
    // How far the shared history was read stays: what's gone doesn't come in again.
    set({ listens: [], shared: [], sentCount: 0, sentFloor: 0 });
    writeJson(FILE, []);
    saveShared();
  },
  note(track, at) {
    // Plays aren't kept while that's switched off (Settings → Network & privacy).
    if (!useSettings.getState().recordListening) return;
    const listen: PhoneListen = { id: track.id, at, ms: Math.round((track.duration || 0) * 1000), title: track.title, artist: track.artist, album: track.album, thumb: track.thumb };
    const all = [...get().listens, listen];
    // The oldest go first; the place of what was sent moves with them.
    const dropped = Math.max(0, all.length - KEPT);
    const listens = dropped ? all.slice(dropped) : all;
    set((s) => ({ listens, sentCount: Math.max(0, s.sentCount - dropped), sentFloor: Math.max(0, s.sentFloor - dropped) }));
    if (get().loaded) writeJson(FILE, listens);
    if (dropped) saveShared();
    for (const listener of noted) listener();
  },
  useServer(server) {
    if (get().server === server) return;
    // Another service: it hasn't got this phone's plays, and it's read from the start. What came from
    // the old one stays; the same plays coming again are left out.
    set({ server, sentCount: 0, sentFloor: 0, readUpTo: 0, generation: null });
    afresh = null;
    saveShared();
  },
  pending(max) {
    const from = Math.max(get().sentCount, get().sentFloor);
    return get()
      .listens.slice(from, from + max)
      .map((l) => ({ at: l.at, id: l.id, title: l.title, artist: l.artist, ...(l.album ? { album: l.album } : {}), ms: l.ms, ...(l.thumb && /^https?:\/\//i.test(l.thumb) ? { thumb: l.thumb } : {}) }));
  },
  markSent(last) {
    // Found by itself, as the oldest may have gone while it was on its way.
    const { listens, sentCount, sentFloor } = get();
    for (let i = listens.length - 1; i >= Math.max(sentCount, sentFloor); i--) {
      if (listens[i].at === last.at && listens[i].id === last.id) {
        set({ sentCount: i + 1 });
        saveShared();
        return;
      }
    }
  },
  take(listens, devices, upTo, startOver) {
    if (startOver) {
      // The service started over: it reads from the start and gets this phone's plays again, apart from
      // the ones taken off it on asking.
      set((s) => ({ readUpTo: 0, sentCount: s.sentFloor, missing: false }));
      saveShared();
      return;
    }
    sharedKeys ??= new Set(get().shared.map((l) => listenKey(l.device ?? "", l)));
    const keys = sharedKeys;
    const fresh: PhoneListen[] = [];
    for (const l of listens) {
      const key = listenKey(l.device, l);
      if (keys.has(key)) continue;
      keys.add(key);
      fresh.push({ id: l.id, at: l.at, ms: l.ms, title: l.title, artist: l.artist, ...(l.album ? { album: l.album } : {}), ...(l.thumb ? { thumb: l.thumb } : {}), device: l.device, deviceName: devices[l.device]?.name ?? "" });
    }
    set((s) => ({ shared: fresh.length ? [...s.shared, ...fresh].slice(-KEPT_SHARED) : s.shared, readUpTo: upTo, missing: false }));
    saveShared();
  },
  setMissing(missing) {
    if (get().missing !== missing) set({ missing });
  },
  versionRead: () => ({ read: get().generation, afresh }),
  readAfresh(generation) {
    afresh = generation;
    set((s) => ({ readUpTo: 0, sentCount: s.sentFloor, missing: false }));
    saveShared();
  },
  readThrough(generation) {
    if (afresh === generation) afresh = null;
    set({ generation });
    saveShared();
  },
}));

export type ReplayPeriod = "month" | "lastMonth" | "year" | "all";

export interface ReplayTop {
  name: string;
  sub: string;
  thumb: string;
  ms: number;
  plays: number;
  /** a song's id, for playing it */
  id?: string;
}

export interface ReplaySummary {
  totalMs: number;
  plays: number;
  tracks: ReplayTop[];
  albums: ReplayTop[];
  artists: ReplayTop[];
  /** up to twelve stretches of the period, for the pulse */
  pulse: { label: string; ms: number }[];
  /** listened per hour of the day, and per weekday (Monday first) */
  hours: number[];
  weekdays: number[];
  /** how many different songs and artists */
  counts: { tracks: number; artists: number };
}

/** Where a period starts and ends, ms. */
export function periodRange(period: ReplayPeriod, now: Date): [number, number] {
  const y = now.getFullYear();
  const m = now.getMonth();
  if (period === "month") return [new Date(y, m, 1).getTime(), Infinity];
  if (period === "lastMonth") return [new Date(y, m - 1, 1).getTime(), new Date(y, m, 1).getTime()];
  if (period === "year") return [new Date(y, 0, 1).getTime(), Infinity];
  return [0, Infinity];
}

function top(map: Map<string, ReplayTop>, count: number, byPlays = false): ReplayTop[] {
  return [...map.values()].sort((a, b) => (byPlays ? b.plays - a.plays || b.ms - a.ms : b.ms - a.ms || b.plays - a.plays)).slice(0, count);
}

/** The listens of a period, counted: totals, the top songs, albums and artists, and the pulse. */
export function summarize(listens: PhoneListen[], period: ReplayPeriod, now = new Date()): ReplaySummary {
  const [from, to] = periodRange(period, now);
  const tracks = new Map<string, ReplayTop>();
  const albums = new Map<string, ReplayTop>();
  const artists = new Map<string, ReplayTop>();
  const days = new Map<string, number>();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  let totalMs = 0;
  let plays = 0;
  const add = (map: Map<string, ReplayTop>, key: string, make: () => ReplayTop, ms: number): void => {
    const row = map.get(key) ?? make();
    row.ms += ms;
    row.plays += 1;
    if (!row.thumb && make().thumb) row.thumb = make().thumb;
    if (!map.has(key)) map.set(key, row);
  };
  for (const l of listens) {
    if (l.at < from || l.at >= to) continue;
    totalMs += l.ms;
    plays += 1;
    add(tracks, l.id, () => ({ name: l.title, sub: l.artist, thumb: l.thumb ?? "", ms: 0, plays: 0, id: l.id }), l.ms);
    if (l.album) add(albums, `${l.album.toLowerCase()}|${l.artist.toLowerCase()}`, () => ({ name: l.album as string, sub: l.artist, thumb: l.thumb ?? "", ms: 0, plays: 0 }), l.ms);
    // The first name of a credit: "A feat. B" counts for A.
    const lead = l.artist.split(/\s*(?:,|;| feat\.? | ft\.? | & )\s*/i)[0] || l.artist;
    add(artists, lead.toLowerCase(), () => ({ name: lead, sub: "", thumb: l.thumb ?? "", ms: 0, plays: 0 }), l.ms);
    const d = new Date(l.at);
    hours[d.getHours()] += l.ms;
    weekdays[(d.getDay() + 6) % 7] += l.ms;
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    days.set(day, (days.get(day) ?? 0) + l.ms);
  }
  const sorted = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const pulse: { label: string; ms: number }[] = [];
  if (period === "year" || period === "all") {
    const months = new Map<string, number>();
    for (const [day, ms] of sorted) months.set(day.slice(0, 7), (months.get(day.slice(0, 7)) ?? 0) + ms);
    for (const [month, ms] of [...months.entries()].slice(-12)) pulse.push({ label: new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" }), ms });
  } else {
    const size = Math.max(1, Math.ceil(sorted.length / 8));
    for (let i = 0; i < sorted.length; i += size) {
      const run = sorted.slice(i, i + size);
      pulse.push({ label: new Date(`${run[0][0]}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" }), ms: run.reduce((sum, r) => sum + r[1], 0) });
    }
  }
  return { totalMs, plays, tracks: top(tracks, 20, true), albums: top(albums, 7), artists: top(artists, 5), pulse, hours, weekdays, counts: { tracks: tracks.size, artists: artists.size } };
}

// Read once at the start, so the first listen noted is written after what was saved.
void useListens.getState().load();
