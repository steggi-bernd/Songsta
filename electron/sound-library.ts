/**
 * The library's sound analysis (sound-analysis.ts) in the background: every
 * local song decoded once by FFmpeg into a mono 11 025 Hz stream and
 * measured, one song at a time with a pause in between, and measured again
 * only when its file changes. The results live beside the other caches
 * (analysis-cache/sound.json) — derived data, rebuilt when lost, outside the
 * backups — and reach the renderer as a map (sound:facts) and an event when
 * more are ready (sound:updated). Without FFmpeg nothing is measured;
 * Settings says so.
 */
import { app } from "electron";
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { readLocalLibrary, type LocalTrack } from "./local-library";
import * as persist from "./persist";
import { ffmpegStatus } from "./transcode";
import { analyseSamples, type SoundFacts } from "./sound-analysis";

const RATE = 11025;
/** Decoded at most; a longer file's end is read on its own. */
const MAX_SECONDS = 720;
/** Bump when the measurements change: every song is measured again. */
const VERSION = 1;
const PAUSE_MS = 250;
const DECODE_TIMEOUT_MS = 120_000;

interface Entry extends SoundFacts {
  sig: string;
}

export interface SoundStatus {
  enabled: boolean;
  ffmpeg: boolean;
  /** songs measured (of the local songs) */
  done: number;
  total: number;
  running: boolean;
  /** server songs measured from a stretch of them */
  server?: number;
}

let entries: Map<string, Entry> | null = null;
/**
 * Songs that can't be measured, so they aren't tried at every start and the count gets to its end (a
 * song left out of it kept the progress short of done for good): a file FFmpeg can't read, a server
 * song whose stretch is empty or unreadable. "<signature>@<when>|<why>" for a local file, tried again
 * once the file changes; "server@<when>|<why>" for a server song; either tried again after a month, or
 * when "Try again" is pressed.
 */
const skipped = new Map<string, string>();
const SKIPPED_FOR_MS = 30 * 86_400_000;
/** Why a song can't be measured, as Settings says it. */
export type SkipReason = "unreadable" | "refused" | "short";
const REASONS = new Set<string>(["unreadable", "refused", "short"]);
const stampOf = (mark: string): string => mark.split("|")[0];
const markAt = (mark: string): number => {
  const stamp = stampOf(mark);
  return Number(stamp.slice(stamp.lastIndexOf("@") + 1));
};
const reasonOf = (mark: string): SkipReason => {
  const why = mark.split("|")[1] ?? "";
  return (REASONS.has(why) ? why : "unreadable") as SkipReason;
};
let dirty = false;
/** Until the page says: what the saved settings say (started by hand once, and not paused). */
let enabledNow: boolean | null = null;
const isEnabled = (): boolean => {
  if (enabledNow === null) {
    const s = (persist.readData("settings") as { state?: { soundAnalysis?: unknown; soundAnalysisStarted?: unknown } } | null)?.state;
    enabledNow = s?.soundAnalysisStarted === true && s?.soundAnalysis !== false;
  }
  return enabledNow;
};
/** A first, big pass goes at full speed: two songs at a time, no pause between. */
const FAST_FROM = 20;
let running: Promise<void> | null = null;
let again = false;
let status = { done: 0, total: 0, running: false };
/** Files FFmpeg couldn't read this session (a drive away): not retried until the next start. */
const failed = new Set<string>();
let onUpdate: () => void = () => undefined;

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const breathe = (): Promise<void> => new Promise((r) => setImmediate(r));
const sigOf = (t: LocalTrack): string => `${Math.floor(t.mtime)}:${t.size}`;

function cacheFile(): string {
  return path.join(app.getPath("userData"), "analysis-cache", "sound.json");
}

function load(): Map<string, Entry> {
  if (entries) return entries;
  entries = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), "utf8")) as { v?: number; songs?: Record<string, Entry>; skipped?: Record<string, unknown> };
    if (raw?.v === VERSION && raw.songs && typeof raw.songs === "object") {
      for (const [id, e] of Object.entries(raw.songs)) if (e && typeof e.sig === "string") entries.set(id, e);
      const now = Date.now();
      for (const [id, mark] of Object.entries(raw.skipped && typeof raw.skipped === "object" ? raw.skipped : {})) {
        // A month on, it's tried again.
        if (typeof mark === "string" && now - markAt(mark) < SKIPPED_FOR_MS) skipped.set(id, mark);
      }
    }
  } catch {
    /* none yet, or unreadable: measured again */
  }
  return entries;
}

function serialized(): string {
  return JSON.stringify({ v: VERSION, songs: Object.fromEntries(load()), skipped: Object.fromEntries(skipped) });
}

/** This file can't be measured, as it is now. */
const skippedAsIs = (t: LocalTrack): boolean => skipped.get(t.id)?.startsWith(`${sigOf(t)}@`) === true;

/** One write at a time: two songs measured together may both ask. */
let saving: Promise<void> = Promise.resolve();
function save(): Promise<void> {
  saving = saving.then(writeIndex, writeIndex);
  return saving;
}

async function writeIndex(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const target = cacheFile();
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(`${target}.tmp`, serialized());
    await fs.promises.rename(`${target}.tmp`, target);
  } catch (err) {
    dirty = true;
    console.warn("[bytune] sound analysis write failed:", err instanceof Error ? err.message : err);
  }
}

/** At quit: what is still waiting goes to disk now. */
export function saveSoundIndexSync(): void {
  if (!dirty) return;
  try {
    const target = cacheFile();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, serialized());
    fs.renameSync(`${target}.tmp`, target);
    dirty = false;
  } catch {
    /* measured again next time */
  }
}

/** Every measured song's facts, by id (the renderer's mixes, details and transitions). */
export function soundFacts(): Record<string, SoundFacts> {
  const out: Record<string, SoundFacts> = {};
  for (const [id, { sig: _sig, ...facts }] of load()) out[id] = facts;
  return out;
}

export function soundStatus(): SoundStatus {
  let server = 0;
  for (const id of load().keys()) if (!id.startsWith("local:")) server++;
  return { enabled: isEnabled(), ffmpeg: !!ffmpegStatus().path, ...status, server };
}

const SERVER_ID = /^(jf|ss):[\w.:-]{1,128}$/;
const finite = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * A server song measured by the renderer from a stretch of it (src/lib/serverSound.ts): kept beside the
 * local songs' facts, marked as an excerpt so its unknown ends aren't taken for measured ones.
 */
export function keepServerSound(id: unknown, facts: unknown): boolean {
  const f = facts as Partial<SoundFacts> | null;
  if (typeof id !== "string" || !SERVER_ID.test(id) || !f || typeof f !== "object") return false;
  if (!finite(f.bpm, 0, 400) || !finite(f.key, -1, 11) || typeof f.minor !== "boolean" || !finite(f.energy, 0, 1) || !finite(f.loudness, -200, 20)) return false;
  load().set(id, { sig: "server", bpm: f.bpm, key: Math.round(f.key), minor: f.minor, energy: f.energy, loudness: f.loudness, introSilence: 0, outroSilence: 0, headDb: f.loudness, tailDb: f.loudness, excerpt: true });
  skipped.delete(id);
  dirty = true;
  serverSince += 1;
  if (serverSince >= 10) {
    serverSince = 0;
    void save();
    onUpdate();
  }
  return true;
}
let serverSince = 0;

/** A measurement from elsewhere, read with care; the ends only where they came. */
function readFacts(raw: unknown): SoundFacts | null {
  const f = raw as Partial<SoundFacts> | null;
  if (!f || typeof f !== "object") return null;
  if (!finite(f.bpm, 0, 400) || !finite(f.key, -1, 11) || typeof f.minor !== "boolean" || !finite(f.energy, 0, 1) || !finite(f.loudness, -200, 20)) return null;
  const whole = f.excerpt !== true && finite(f.introSilence, 0, 7200) && finite(f.outroSilence, 0, 7200) && finite(f.headDb, -200, 20) && finite(f.tailDb, -200, 20);
  return {
    bpm: f.bpm,
    key: Math.round(f.key),
    minor: f.minor,
    energy: f.energy,
    loudness: f.loudness,
    introSilence: whole ? (f.introSilence as number) : 0,
    outroSilence: whole ? (f.outroSilence as number) : 0,
    headDb: whole ? (f.headDb as number) : f.loudness,
    tailDb: whole ? (f.tailDb as number) : f.loudness,
    ...(whole ? {} : { excerpt: true }),
  };
}

/**
 * Measurements another device made, taken in through the sync service (src/lib/soundShare.ts): a file
 * here gets one with its own signature, so it isn't measured again (a second computer is spared the
 * long first run); a server song is kept as one measured from a stretch here would be. Only songs not
 * measured here yet; what doesn't read, or isn't a song here, is left out. How many were taken.
 */
export function adoptSounds(entries: unknown): number {
  if (!Array.isArray(entries)) return 0;
  const index = load();
  const local = new Map(readLocalLibrary().tracks.map((t) => [t.id, t]));
  let taken = 0;
  for (const raw of entries.slice(0, 100_000)) {
    const { id, facts } = (raw ?? {}) as { id?: unknown; facts?: unknown };
    if (typeof id !== "string" || index.has(id)) continue;
    const f = readFacts(facts);
    if (!f) continue;
    const track = id.startsWith("local:") ? local.get(id) : undefined;
    if (track) index.set(id, { sig: sigOf(track), ...f });
    else if (SERVER_ID.test(id)) index.set(id, { sig: "server", ...f });
    else continue;
    skipped.delete(id);
    taken += 1;
  }
  if (taken) {
    dirty = true;
    void save().then(() => onUpdate());
  }
  return taken;
}

/** Which server songs are measured already, so the renderer doesn't ask again. */
export function measuredServerSongs(): string[] {
  return [...load().keys()].filter((id) => !id.startsWith("local:"));
}

/** A server song whose stretch was empty, too short or refused (src/lib/serverSound.ts): left for a month, counted as looked at. */
export function skipServerSound(id: unknown, reason?: unknown): boolean {
  if (typeof id !== "string" || !SERVER_ID.test(id) || load().has(id)) return false;
  const why = typeof reason === "string" && REASONS.has(reason) ? reason : "unreadable";
  skipped.set(id, `server@${Date.now()}|${why}`);
  dirty = true;
  void save();
  return true;
}

/** The songs that can't be measured and why (Settings counts them as looked at, says how many, and lists them). */
export function skippedSongs(): { id: string; reason: SkipReason }[] {
  load();
  return [...skipped].map(([id, mark]) => ({ id, reason: reasonOf(mark) }));
}

/** "Try again": every song that couldn't be measured is tried once more, now. */
export function retrySkipped(): number {
  load();
  const n = skipped.size + failed.size;
  skipped.clear();
  failed.clear();
  dirty = true;
  void save().then(() => onUpdate());
  void analyseLibrarySound();
  return n;
}

export function configureSoundAnalysis(opts: { onUpdate: () => void }): void {
  onUpdate = opts.onUpdate;
}

/**
 * The Settings switch: off stops after the song being measured; switching it
 * on starts at once. (The renderer reports the setting at every start —
 * that alone starts nothing: the first pass waits until the start is over.)
 */
export function setSoundAnalysisEnabled(on: boolean): void {
  const was = isEnabled();
  enabledNow = on !== false;
  if (enabledNow && !was) void analyseLibrarySound();
}

/** A file — or, with `-sseof`, its last seconds — as mono samples at RATE. */
function decode(ffmpeg: string, file: string, before: string[] = []): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ["-hide_banner", "-loglevel", "error", "-nostdin", ...before, "-i", file, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-t", String(MAX_SECONDS), "-f", "f32le", "-"];
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
      size += d.length;
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 1000) stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill(), DECODE_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${code}`));
      // Copied into a fresh buffer: Float32Array needs 4-byte alignment.
      const bytes = Buffer.concat(chunks, size);
      const aligned = new Uint8Array(bytes.length - (bytes.length % 4));
      aligned.set(bytes.subarray(0, aligned.length));
      resolve(new Float32Array(aligned.buffer));
    });
  });
}

async function measure(ffmpeg: string, track: LocalTrack): Promise<SoundFacts> {
  const facts = await analyseSamples(await decode(ffmpeg, track.path), RATE, breathe);
  if (track.duration <= MAX_SECONDS - 5) return facts;
  // Only the first twelve minutes were decoded: the real end comes from the last seconds.
  const end = await analyseSamples(await decode(ffmpeg, track.path, ["-sseof", "-3"]), RATE);
  return { ...facts, tailDb: end.tailDb, outroSilence: Math.min(end.outroSilence, 3) };
}

/**
 * Measures what isn't measured yet (or changed since), one pass at a time;
 * a call during a pass makes it go round once more.
 */
export function analyseLibrarySound(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    do {
      again = false;
      await pass();
    } while (again);
  })()
    .catch((err) => console.warn("[bytune] sound analysis:", err instanceof Error ? err.message : err))
    .finally(() => {
      running = null;
      status.running = false;
    });
  return running;
}

async function pass(): Promise<void> {
  const ffmpeg = ffmpegStatus().path;
  const tracks = readLocalLibrary().tracks;
  const index = load();
  const present = new Set(tracks.map((t) => t.id));
  for (const id of [...index.keys(), ...skipped.keys()]) {
    // A server song's facts come from the renderer (keepServerSound) and stay.
    if (present.has(id) || !id.startsWith("local:")) continue;
    index.delete(id);
    skipped.delete(id);
    dirty = true;
  }
  const todo = tracks.filter((t) => index.get(t.id)?.sig !== sigOf(t) && !skippedAsIs(t) && !failed.has(t.id));
  status = { done: tracks.length - todo.length, total: tracks.length, running: isEnabled() && !!ffmpeg && todo.length > 0 };
  if (!status.running || !ffmpeg) {
    await save();
    return;
  }
  // Many waiting (the first run): two at a time and no pause; a few new ones: one, with a breath between.
  const fast = todo.length > FAST_FROM;
  let next = 0;
  let sinceSave = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && isEnabled()) {
      const track = todo[next++];
      try {
        index.set(track.id, { sig: sigOf(track), ...(await measure(ffmpeg, track)) });
        skipped.delete(track.id);
        dirty = true;
      } catch {
        // A file that's there but can't be read is left until it changes (or for a month); one that
        // isn't there (a drive away) until the next start.
        if (fs.existsSync(track.path)) {
          skipped.set(track.id, `${sigOf(track)}@${Date.now()}|unreadable`);
          dirty = true;
        } else {
          failed.add(track.id);
        }
      }
      status.done++;
      if (++sinceSave >= 20) {
        sinceSave = 0;
        await save();
        onUpdate();
      }
      if (!fast) await pause(PAUSE_MS);
    }
  };
  await Promise.all(Array.from({ length: fast ? 2 : 1 }, worker));
  status.running = false;
  await save();
  onUpdate();
}
