/**
 * The listening history, one line per listen — scrobbling that stays on this
 * computer. A listen is written the moment it counts as a play (half the
 * song, at least 30 s, at most 4 minutes in — the rule in stats.ts), stamped
 * with when it began, as Last.fm and ListenBrainz stamp theirs.
 *
 * It lives in data/listens.jsonl and Replay shows it and exports it as a
 * spreadsheet (CSV). With a sync service the devices share their listens
 * (src/lib/listenSync.ts): the others' plays are written here too, each with
 * the device that played it, and this computer's go out from here. The songs' plays reach a
 * Jellyfin or Navidrome server only through the separate "Count plays on the
 * server" switch (src/lib/serverSync.ts).
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { Track } from "../src/types";
import { listenKey, type ListenDevice, type SharedListen } from "../src/lib/listenSync";

export interface Listen {
  /** when the listen began, ms */
  at: number;
  id: string;
  title: string;
  artist: string;
  album: string;
  /** the song's length, seconds */
  duration: number;
  /** another device's play, taken from the shared history: which device, what it's called, what it is */
  device?: string;
  deviceName?: string;
  deviceKind?: "phone" | "computer";
}

const FILE = "listens.jsonl";
const MAX_PAGE = 500;
let pending: string[] = [];
let timer: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();

function file(): string {
  const dir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, FILE);
}

/** One listen that just counted as a play. */
export function noteListen(track: Track, startedAt: number): void {
  if (!track?.id) return;
  const entry: Listen = {
    at: Math.round(startedAt),
    id: String(track.id).slice(0, 160),
    title: String(track.title ?? "").slice(0, 200),
    artist: String(track.artist ?? "").slice(0, 200),
    album: String(track.album ?? "").slice(0, 200),
    duration: Math.max(0, Math.round(Number(track.duration) || 0)),
  };
  pending.push(JSON.stringify(entry));
  timer ??= setTimeout(() => void flushListens(), 2000);
}

/** The file may end in the middle of a line (a write broke off): the next lines start on one of their own. */
let cutShort = false;

/** Lines onto the end of the journal; a failure reaches the caller. */
async function append(lines: string[]): Promise<void> {
  const text = `${lines.join("\n")}\n`;
  try {
    await fs.promises.appendFile(file(), cutShort ? `\n${text}` : text, "utf8");
    cutShort = false;
  } catch (err) {
    cutShort = true;
    throw err;
  }
}

/**
 * Written in order, one append at a time. A write that fails keeps its lines for the next flush, in
 * front of what came since: they were dropped before, and the plays were lost (Codex's review, 2026-11-20).
 */
export function flushListens(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending.length) return writing;
  const batch = pending;
  pending = [];
  writing = writing
    .then(() => append(batch))
    .catch(() => {
      pending = [...batch, ...pending];
      timer ??= setTimeout(() => void flushListens(), 30_000);
    });
  return writing;
}

/** At quit: whatever is still waiting goes to disk now. */
export function flushListensSync(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!pending.length) return;
  try {
    const text = `${pending.join("\n")}\n`;
    fs.appendFileSync(file(), cutShort ? `\n${text}` : text, "utf8");
  } catch {
    /* a read-only profile keeps nothing */
  }
  pending = [];
}

function readAll(): Listen[] {
  let text = "";
  try {
    text = fs.readFileSync(file(), "utf8");
  } catch {
    return [];
  }
  const out: Listen[] = [];
  // A listen can stand twice when a write broke off after some lines and they were written again: once counts.
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const l = JSON.parse(line) as Partial<Listen>;
      if (typeof l.at === "number" && typeof l.title === "string" && typeof l.id === "string") {
        const key = `${typeof l.device === "string" ? l.device : ""}|${l.at}|${l.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          at: l.at,
          id: l.id,
          title: l.title,
          artist: String(l.artist ?? ""),
          album: String(l.album ?? ""),
          duration: Number(l.duration) || 0,
          ...(typeof l.device === "string" && l.device
            ? { device: l.device, deviceName: String(l.deviceName ?? ""), ...(l.deviceKind === "phone" || l.deviceKind === "computer" ? { deviceKind: l.deviceKind } : {}) }
            : {}),
        });
      }
    } catch {
      /* a line cut by a crash — the rest stands */
    }
  }
  return out;
}

/**
 * This computer's own listens from a place on (how many of them the shared history has), in the order
 * they were counted, and how many there are. By place, not by moment: one listen stamped by a clock
 * that ran ahead doesn't hold back the ones after it.
 */
export async function ownListensFrom(from: number, max: number): Promise<{ listens: Listen[]; total: number }> {
  await flushListens();
  const own = readAll().filter((l) => !l.device);
  const start = Math.max(0, Math.floor(from) || 0);
  return { listens: own.slice(start, start + Math.max(1, Math.min(1000, Math.floor(max) || 500))), total: own.length };
}

/** The other devices' listens already here, by who played them and when. */
let remoteKeys: Set<string> | null = null;

/**
 * Plays counted on other devices (the shared history), written here with the device that played
 * them; one already here is left out. The ones new here come back, for Replay's counts.
 *
 * Only what reached the disk counts as here: a failed write throws, so the reader keeps its place and
 * asks for the same page again. It used to count the plays as here and new before the write, and a
 * failed write left them out for good (Codex's review, 2026-11-20).
 */
export async function noteRemoteListens(listens: SharedListen[], devices: Record<string, ListenDevice>): Promise<SharedListen[]> {
  await flushListens();
  remoteKeys ??= new Set(readAll().filter((l) => l.device).map((l) => listenKey(l.device as string, l)));
  const keys = remoteKeys;
  // Looked up and written in one go, after any write under way: the same play arriving twice at once
  // is new only once, and written once (Codex's review of these fixes).
  const run = writing.then(async () => {
    const seen = new Set<string>();
    const fresh = listens.filter((l) => {
      const key = listenKey(l.device, l);
      if (keys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) return fresh;
    const lines = fresh.map((l) => {
      const from = devices[l.device];
      return JSON.stringify({ at: l.at, id: l.id, title: l.title, artist: l.artist, album: l.album ?? "", duration: Math.round(l.ms / 1000), device: l.device, deviceName: from?.name ?? "", ...(from?.kind ? { deviceKind: from.kind } : {}) });
    });
    await append(lines);
    for (const key of seen) keys.add(key);
    return fresh;
  });
  // The next write waits for this one, failed or not.
  writing = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Newest first, a page at a time: the listens before `before` (ms), and whether older ones exist. */
export async function readListens(before?: number, limit = 100): Promise<{ listens: Listen[]; more: boolean; total: number }> {
  await flushListens();
  const all = readAll().sort((a, b) => b.at - a.at);
  const from = typeof before === "number" && Number.isFinite(before) ? all.filter((l) => l.at < before) : all;
  const n = Math.max(1, Math.min(MAX_PAGE, Math.floor(limit) || 100));
  return { listens: from.slice(0, n), more: from.length > n, total: all.length };
}

export interface MomentScore {
  id: string;
  score: number;
}

/** Listens of the last hours belong to what plays now, not to a habit. */
const SESSION_MS = 6 * 3600_000;

/**
 * How much each song belongs to this moment of the day and week: listens
 * near this time of day count (within 2½ hours either side, the nearer the
 * more), on the same weekday most, on the same kind of day (weekday or
 * weekend) less, on the other kind a little; a listen loses half its weight
 * every 90 days and none older than two years count. Highest first.
 */
export function scoreMoments(listens: readonly Listen[], now: number): MomentScore[] {
  const here = new Date(now);
  const hour = here.getHours() + here.getMinutes() / 60;
  const weekday = here.getDay();
  const weekend = (d: number): boolean => d === 0 || d === 6;
  const scores = new Map<string, number>();
  for (const l of listens) {
    const age = now - l.at;
    if (age < SESSION_MS || age > 730 * 86_400_000) continue;
    const then = new Date(l.at);
    let apart = Math.abs(then.getHours() + then.getMinutes() / 60 - hour);
    if (apart > 12) apart = 24 - apart;
    if (apart >= 2.5) continue;
    const day = then.getDay();
    const dayWeight = day === weekday ? 1 : weekend(day) === weekend(weekday) ? 0.6 : 0.25;
    const weight = (1 - apart / 2.5) * dayWeight * Math.pow(0.5, age / (90 * 86_400_000));
    scores.set(l.id, (scores.get(l.id) ?? 0) + weight);
  }
  return [...scores]
    .map(([id, score]) => ({ id, score: Math.round(score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 150);
}

/** A pause longer than this between two plays ends a listening session. */
const SESSION_GAP_MS = 30 * 60_000;

/**
 * The songs played around a song (Klingt wie's "Often played together"): within the same listening
 * session (pauses under half an hour) on the same device, up to four songs either side, the nearer the
 * more; a session loses half its weight every 180 days. `ids` are the song's copies (a file and the
 * server's). Each device's sessions apart: the phone in the car and the computer at home playing at the
 * same time weren't one session (the shared history holds both). Pure.
 */
export function scoreTogether(listens: readonly Listen[], ids: readonly string[], now: number, limit = 40): MomentScore[] {
  const byDevice = new Map<string, Listen[]>();
  for (const l of listens) {
    const list = byDevice.get(l.device ?? "");
    if (list) list.push(l);
    else byDevice.set(l.device ?? "", [l]);
  }
  const want = new Set(ids);
  const scores = new Map<string, number>();
  for (const list of byDevice.values()) {
    const all = list.sort((a, b) => a.at - b.at);
    let start = 0;
    for (let i = 1; i <= all.length; i++) {
      const ends = i === all.length || all[i].at - (all[i - 1].at + all[i - 1].duration * 1000) > SESSION_GAP_MS;
      if (!ends) continue;
      const session = all.slice(start, i);
      start = i;
      for (let k = 0; k < session.length; k++) {
        if (!want.has(session[k].id)) continue;
        const fade = Math.pow(0.5, Math.max(0, now - session[k].at) / (180 * 86_400_000));
        for (let d = 1; d <= 4; d++) {
          for (const other of [session[k - d], session[k + d]]) {
            if (!other || want.has(other.id)) continue;
            scores.set(other.id, (scores.get(other.id) ?? 0) + fade / d);
          }
        }
      }
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score: Math.round(score * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** The songs played around a song, from the whole history (every device's, with a sync service). */
export async function togetherScores(ids: string[], limit = 40, now = Date.now()): Promise<MomentScore[]> {
  await flushListens();
  return scoreTogether(readAll(), ids, now, limit);
}

/** This moment's songs from the whole history (the home page's time-of-day mix). */
export async function momentScores(now = Date.now()): Promise<MomentScore[]> {
  await flushListens();
  return scoreMoments(readAll(), now);
}

/** The whole history as a spreadsheet: one row per listen, oldest first. */
export async function listensCsv(): Promise<{ csv: string; count: number }> {
  await flushListens();
  const cell = (v: string | number): string => {
    const s = String(v);
    // Quote what needs it; a leading =, +, - or @ is defused so a spreadsheet never runs it as a formula.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = readAll().sort((a, b) => a.at - b.at);
  const lines = ["Listened at (UTC),Title,Artist,Album,Length (s),Device"];
  for (const l of rows) lines.push([new Date(l.at).toISOString(), l.title, l.artist, l.album, l.duration, l.device ? l.deviceName || l.device : ""].map((v) => cell(v)).join(","));
  return { csv: `\ufeff${lines.join("\r\n")}\r\n`, count: rows.length };
}

/** Listens not yet on disk are forgotten (a stats reset: nothing written after it). */
export function dropPendingListens(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = [];
}

/** Forget every listen (Replay's reset, a data reset). */
export async function clearListens(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = [];
  remoteKeys = null;
  await writing;
  await fs.promises.rm(file(), { force: true });
}
