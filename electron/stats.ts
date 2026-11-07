/**
 * Listening statistics.
 *
 * The renderer reports listened seconds per track on a play-event bus
 * (see src/lib/playEvents.ts); this module folds them into monthly buckets
 * persisted as the `listening-history` store:
 *
 *   listening-history.json = { state: { buckets: [MonthBucket] }, version: 1 }
 *   MonthBucket = {
 *     month, tracks: {id → {title, artist, thumb, ms, plays, lastAt}},
 *     artists: {lowercased name → {name, ms, plays}},
 *     albums: {album key → {name, artist, ms, plays}},
 *     hours: number[24] (listening ms per hour of day),
 *     days: {"YYYY-MM-DD": ms}
 *   }
 *
 * A "play" is credited once per listen, when listened time crosses
 * min(max(duration/2, 30s), 4min) — the mobile ListeningRecorder rule, so a
 * looped track earns hours but a single play. Nothing here is inferred
 * beyond what was actually reported — no fake numbers.
 *
 * Retention mirrors mobile: 36 monthly buckets, 600 tracks / 400 artists+albums
 * per bucket, lowest-listened entries pruned first.
 *
 * Replay is one store next to the library's: a backup carries it along.
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as persist from "./persist";
import { dropPendingListens, flushListensSync, noteListen } from "./listens";
import type { Track } from "../src/types";

export interface TrackEntry {
  title: string;
  artist: string;
  thumb: string;
  ms: number;
  plays: number;
  lastAt: number;
}
export interface NameEntry {
  name: string;
  artist?: string;
  /** Cover art — for albums the track's own artwork, for artists the artist photo. */
  thumb?: string;
  ms: number;
  plays: number;
}
export interface MonthBucket {
  month: string;
  tracks: Record<string, TrackEntry>;
  artists: Record<string, NameEntry>;
  albums: Record<string, NameEntry>;
  hours: number[];
  days: Record<string, number>;
}

export type ReplayPeriod = "month" | "lastMonth" | "year" | "all";

export interface ReplaySummary {
  totalMs: number;
  plays: number;
  tracks: (TrackEntry & { id: string })[];
  artists: NameEntry[];
  albums: NameEntry[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: ReplayPeriod;
  months: string[];
}

const PLAY_FLOOR_MS = 30_000;
const PLAY_CEILING_MS = 4 * 60 * 1000;
/** Retention mirrors mobile (ListeningStats prune): 36 months on disk. */
export const KEEP_MONTHS = 36;
const MAX_TRACKS = 600;
const MAX_NAMES = 400;
const FLUSH_EVERY_MS = 5000;

export const HISTORY_STORE = "listening-history";

let ready = false;
const open = new Map<string, MonthBucket>();
/** True when memory holds changes not yet written to the store. */
let dirty = false;
let loaded = false;
let flushTimer: NodeJS.Timeout | null = null;
/**
 * Play-count rule state, per mobile's ListeningRecorder: one play per track
 * once `playedMs >= min(max(duration/2, 30s), 4min)`. `ruleMs` accumulates
 * this listen; `ruleCounted` marks it credited. Both reset on track start
 * (see noteTrackStart) so replays count again but loops don't inflate.
 */
const ruleMs = new Map<string, number>();
const ruleCounted = new Set<string>();

/** A new listen of this track began — re-arm the one-play rule. */
export function noteTrackStart(trackId: string): void {
  if (!trackId) return;
  ruleMs.delete(trackId);
  ruleCounted.delete(trackId);
}

function monthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function lastMonthKey(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 1);
  return monthKey(d);
}

function newBucket(month: string): MonthBucket {
  return { month, tracks: {}, artists: {}, albums: {}, hours: new Array(24).fill(0), days: {} };
}

function coerceBucket(raw: any): MonthBucket | null {
  if (!raw || typeof raw !== "object" || !/^\d{4}-\d{2}$/.test(String(raw.month ?? ""))) return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  const rec = <T>(v: unknown): Record<string, T> => {
    const out: Record<string, T> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, e] of Object.entries(v as Record<string, any>)) {
        const t = (e?.title ?? e?.name) as unknown;
        if (typeof t === "string" && typeof e?.ms === "number") {
          out[k] = {
            title: String(t), name: String(e?.name ?? t), artist: e?.artist,
            thumb: typeof e?.thumb === "string" ? e.thumb : undefined,
            ms: num(e.ms), plays: num(e.plays), lastAt: num(e.lastAt),
          } as unknown as T;
        }
      }
    }
    return out;
  };
  return {
    month: raw.month,
    tracks: rec<TrackEntry>(raw.tracks),
    artists: rec<NameEntry>(raw.artists),
    albums: rec<NameEntry>(raw.albums),
    hours: Array.isArray(raw.hours) && raw.hours.length === 24 ? raw.hours.map(num) : new Array(24).fill(0),
    days: Object.fromEntries(
      Object.entries(raw.days && typeof raw.days === "object" && !Array.isArray(raw.days) ? raw.days : {})
        .filter(([d, ms]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof ms === "number")
        .map(([d, ms]) => [d, num(ms)])
    ),
  };
}

/** Read the persisted bucket set once. */
function loadAll(): void {
  if (loaded) return;
  loaded = true;
  const raw = persist.readData(HISTORY_STORE) as { state?: { buckets?: unknown } } | null;
  const buckets = raw?.state?.buckets;
  for (const b of Array.isArray(buckets) ? buckets : []) {
    const clean = coerceBucket(b);
    if (clean) open.set(clean.month, clean);
  }
}

function envelopePayload(): { state: { buckets: MonthBucket[] }; version: number } {
  const buckets = [...open.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  return { state: { buckets }, version: 1 };
}

/** Drop months past the retention horizon; the next flush writes the result. */
function pruneOldBuckets(): void {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - KEEP_MONTHS);
  const cutoffKey = monthKey(cutoff);
  for (const month of [...open.keys()]) {
    if (month < cutoffKey) {
      open.delete(month);
      markDirty();
    }
  }
}

function markDirty(): void { dirty = true; }

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_EVERY_MS);
}

async function flush(): Promise<void> {
  if (!ready || !dirty) return;
  pruneOldBuckets();
  dirty = false;
  await writeStore();
}

/**
 * Write the whole bucket set. One file per flush (not per month) keeps the
 * store self-consistent: a partial write can never leave months half-applied.
 */
async function writeStore(): Promise<void> {
  try {
    await persist.writeData(HISTORY_STORE, envelopePayload());
  } catch (err) {
    console.warn("[bytune] stats flush failed:", err instanceof Error ? err.message : err);
  }
}

/** Discard cached history before the store is deleted; never flush it back. */
export function resetStats(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  dropPendingListens();
  dirty = false;
  open.clear();
  loaded = false;
  ruleMs.clear();
  ruleCounted.clear();
}

export function initStats(): void {
  if (ready) return;
  ready = true;
  loadAll();
  migrateLegacyStats();
}

/**
 * One-time import of the pre-store monthly files. Replay used to live in
 * loose `data/stats/<YYYY-MM>.json` files. Any such files still on disk are
 * folded into the store here.
 *
 * The directory is consumed after a successful import: a "Reset app data"
 * empties the store, and an unconsumed legacy copy would then resurrect the
 * exact history the user just asked to erase. Live months always win, so a
 * partially-synced history is never regressed by an older snapshot.
 */
function migrateLegacyStats(): void {
  // `userData/data/stats` is where the monthly files lived; the nested
  // `userData/data/data/stats` is the same folder preserved from an older
  // userData layout that ended up inside the current one.
  const roots = [
    path.join(app.getPath("userData"), "data", "stats"),
    path.join(app.getPath("userData"), "data", "data", "stats"),
  ];
  for (const dir of roots) {
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
    } catch {
      continue; // no legacy copy here
    }
    let imported = 0;
    for (const f of files) {
      try {
        const clean = coerceBucket(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")));
        if (!clean || open.has(clean.month)) continue;
        pruneBucket(clean);
        open.set(clean.month, clean);
        imported += 1;
      } catch {
        /* unreadable file — skip it */
      }
    }
    if (imported === 0) continue;
    dirty = true;
    // Synchronous, and before the legacy dir is removed.
    try {
      persist.writeDataSync(HISTORY_STORE, envelopePayload());
      dirty = false;
    } catch (err) {
      console.warn("[bytune] stats recovery flush failed:", err instanceof Error ? err.message : err);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`[bytune] recovered ${imported} Replay month(s) from legacy stats files`);
  }
}

/** Fold one span of listening into the buckets. */
export function recordListening(track: Track, listenedMs: number, at = new Date()): void {
  if (!ready || !track?.id || listenedMs <= 0) return;
  loadAll();
  const month = monthKey(at);
  const b = open.get(month) ?? newBucket(month);
  open.set(month, b);
  const day = `${month}-${String(at.getDate()).padStart(2, "0")}`;

  const t = (b.tracks[track.id] ??= {
    title: track.title,
    artist: track.artist,
    thumb: track.thumb,
    ms: 0,
    plays: 0,
    lastAt: 0,
  });
  t.title = track.title;
  t.artist = track.artist;
  if (track.thumb) t.thumb = track.thumb;
  t.ms += listenedMs;
  t.lastAt = at.getTime();

  const key = (track.artist || "Unknown artist").toLowerCase();
  const a = (b.artists[key] ??= { name: track.artist || "Unknown artist", ms: 0, plays: 0 });
  a.name = track.artist || "Unknown artist";
  a.ms += listenedMs;

  if (track.album) {
    const ak = `${track.album.toLowerCase()}|${key}`;
    const al = (b.albums[ak] ??= { name: track.album, artist: track.artist, ms: 0, plays: 0 });
    al.ms += listenedMs;
    // A track's artwork is its album's cover — the cheapest honest source.
    if (!al.thumb && track.thumb) al.thumb = track.thumb;
  }

  b.hours[at.getHours()] += listenedMs;
  b.days[day] = (b.days[day] ?? 0) + listenedMs;

  // Play credit (mobile rule): a single play once this listen crosses
  // min(max(duration/2, floor), ceiling). ms always accrues; plays don't
  // inflate on loops — a 1-hour loop is 1 play, not 120.
  if (!ruleCounted.has(track.id)) {
    const listened = (ruleMs.get(track.id) ?? 0) + listenedMs;
    ruleMs.set(track.id, listened);
    const durMs = track.duration > 0 ? track.duration * 1000 : PLAY_FLOOR_MS;
    const threshold = Math.min(Math.max(durMs / 2, PLAY_FLOOR_MS), PLAY_CEILING_MS);
    if (listened >= threshold) {
      ruleCounted.add(track.id);
      // The listening history's line for it, stamped with when the listen began.
      noteListen(track, at.getTime() - listened);
      t.plays += 1;
      a.plays += 1;
      if (track.album) b.albums[`${track.album.toLowerCase()}|${key}`].plays += 1;
    }
  }

  dirty = true;
  pruneBucket(b);
  scheduleFlush();
}

function monthsForPeriod(period: ReplayPeriod): string[] {
  const now = new Date();
  if (period === "month") return [monthKey(now)];
  if (period === "lastMonth") return [lastMonthKey()];
  if (period === "year") {
    const out: string[] = [];
    for (let m = 0; m <= now.getMonth(); m++) out.push(`${now.getFullYear()}-${String(m + 1).padStart(2, "0")}`);
    return out;
  }
  return [...open.keys()].sort();
}

/**
 * Plays and last-played time per track id over the whole kept history — the
 * "most played" input for artist pages, home mixes and smart playlists.
 */
export function playCounts(): Record<string, { plays: number; lastAt: number }> {
  if (!ready) initStats();
  const out: Record<string, { plays: number; lastAt: number }> = {};
  for (const bucket of open.values()) {
    for (const [id, t] of Object.entries(bucket.tracks)) {
      const cur = (out[id] ??= { plays: 0, lastAt: 0 });
      cur.plays += t.plays;
      cur.lastAt = Math.max(cur.lastAt, t.lastAt);
    }
  }
  return out;
}

export function summary(period: ReplayPeriod): ReplaySummary {
  if (!ready) initStats();
  const months = monthsForPeriod(period);
  const buckets = months.map((m) => open.get(m)).filter((b): b is MonthBucket => !!b);

  const tracks = new Map<string, TrackEntry & { id: string }>();
  const artists = new Map<string, NameEntry>();
  const albums = new Map<string, NameEntry>();
  const hours = new Array(24).fill(0);
  const days = new Map<string, number>();
  let totalMs = 0;
  let plays = 0;

  for (const b of buckets) {
    for (const [id, t] of Object.entries(b.tracks)) {
      const cur = tracks.get(id) ?? { ...t, id, ms: 0, plays: 0 };
      cur.ms += t.ms;
      cur.plays += t.plays;
      if (t.lastAt > cur.lastAt) {
        cur.title = t.title;
        cur.artist = t.artist;
        cur.thumb = t.thumb || cur.thumb;
        cur.lastAt = t.lastAt;
      }
      tracks.set(id, cur);
      plays += t.plays;
      totalMs += t.ms;
    }
    for (const [k, a] of Object.entries(b.artists)) {
      // Untagged local files land here as a real artist — real listening, but
      // never an artist worth naming in a Top artists list.
      if (k === "unknown artist") continue;
      const cur = artists.get(k) ?? { ...a, ms: 0, plays: 0 };
      cur.ms += a.ms;
      cur.plays += a.plays;
      artists.set(k, cur);
    }
    for (const [k, al] of Object.entries(b.albums)) {
      const cur = albums.get(k) ?? { ...al, ms: 0, plays: 0 };
      cur.ms += al.ms;
      cur.plays += al.plays;
      albums.set(k, cur);
    }
    for (let h = 0; h < 24; h++) hours[h] += b.hours[h] ?? 0;
    for (const [d, ms] of Object.entries(b.days)) days.set(d, (days.get(d) ?? 0) + ms);
  }

  return {
    totalMs,
    plays,
    tracks: [...tracks.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    artists: [...artists.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    albums: [...albums.values()].sort((x, y) => y.ms - x.ms).slice(0, 50),
    hours,
    days: [...days.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([date, ms]) => ({ date, ms })),
    period,
    months,
  };
}

/** Synchronous persist for shutdown paths: `before-quit` cannot await. */
export function flushSync(): void {
  flushListensSync();
  if (!ready || !dirty) return;
  dirty = false;
  try {
    persist.writeDataSync(HISTORY_STORE, envelopePayload());
  } catch (err) {
    console.warn("[bytune] stats flush failed:", err instanceof Error ? err.message : err);
  }
}

/** Trim one bucket to the retention caps (lowest-listened entries go first). */
function pruneBucket(b: MonthBucket): void {
  const trim = <T>(rec: Record<string, T>, max: number, msOf: (v: T) => number): void => {
    const keys = Object.keys(rec);
    if (keys.length <= max) return;
    keys
      .sort((x, y) => msOf(rec[x]) - msOf(rec[y]))
      .slice(0, keys.length - max)
      .forEach((k) => delete rec[k]);
  };
  trim(b.tracks, MAX_TRACKS, (t) => t.ms);
  trim(b.artists, MAX_NAMES, (a) => a.ms);
  trim(b.albums, MAX_NAMES, (a) => a.ms);
}

/** Read every monthly bucket (for backup export). */
export function exportAll(): MonthBucket[] {
  if (!ready) initStats();
  return [...open.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/** Replace all monthly buckets (backup import — caller validates). */
export function importAll(buckets: MonthBucket[]): void {
  if (!ready) initStats();
  open.clear();
  dirty = false;
  ruleMs.clear();
  ruleCounted.clear();
  for (const b of buckets) {
    const clean = coerceBucket(b);
    if (!clean) continue;
    pruneBucket(clean);
    open.set(clean.month, clean);
  }
  pruneOldBuckets();
  dirty = true;
  void writeStore();
}
