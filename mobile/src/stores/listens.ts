/**
 * What this phone played, song by song, for Replay (screens/ReplayScreen.tsx): each listen that
 * counted as a play, with its moment and the song's length. Kept on this phone only, from the day
 * this exists; the computer keeps its own (electron/stats.ts), the two aren't added up.
 */
import { create } from "zustand";
import type { Track } from "../shared";
import { readJson, writeJson } from "../storage";

const FILE = "listens.json";
/** Roughly five years of heavy listening; the oldest go first. */
const KEPT = 40_000;

export interface PhoneListen {
  id: string;
  at: number;
  /** the song's length, ms */
  ms: number;
  title: string;
  artist: string;
  album?: string;
  thumb?: string;
}

interface ListensState {
  listens: PhoneListen[];
  loaded: boolean;
  load(): Promise<void>;
  note(track: Track, at: number): void;
}

export const useListens = create<ListensState>((set, get) => ({
  listens: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const saved = await readJson<PhoneListen[]>(FILE);
    // Listens noted before the file was read stay, after what was saved.
    set((s) => ({ listens: [...(Array.isArray(saved) ? saved : []), ...s.listens], loaded: true }));
  },
  note(track, at) {
    const listen: PhoneListen = { id: track.id, at, ms: Math.round((track.duration || 0) * 1000), title: track.title, artist: track.artist, album: track.album, thumb: track.thumb };
    const listens = [...get().listens, listen].slice(-KEPT);
    set({ listens });
    if (get().loaded) writeJson(FILE, listens);
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

function top(map: Map<string, ReplayTop>, count: number): ReplayTop[] {
  return [...map.values()].sort((a, b) => b.ms - a.ms || b.plays - a.plays).slice(0, count);
}

/** The listens of a period, counted: totals, the top songs, albums and artists, and the pulse. */
export function summarize(listens: PhoneListen[], period: ReplayPeriod, now = new Date()): ReplaySummary {
  const [from, to] = periodRange(period, now);
  const tracks = new Map<string, ReplayTop>();
  const albums = new Map<string, ReplayTop>();
  const artists = new Map<string, ReplayTop>();
  const days = new Map<string, number>();
  let totalMs = 0;
  let plays = 0;
  const add = (map: Map<string, ReplayTop>, key: string, make: () => ReplayTop, ms: number): void => {
    const row = map.get(key) ?? make();
    row.ms += ms;
    row.plays += 1;
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
  return { totalMs, plays, tracks: top(tracks, 20), albums: top(albums, 7), artists: top(artists, 5), pulse };
}

// Read once at the start, so the first listen noted is written after what was saved.
void useListens.getState().load();
