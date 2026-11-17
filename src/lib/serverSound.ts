/**
 * Tempo, key and energy of the server's songs (Jellyfin, Navidrome), measured here: the local songs are
 * measured by FFmpeg in the main process (electron/sound-library.ts), a server song from a short stretch
 * of it the server makes — about ninety seconds from a little way in, mono MP3 at 64 kbps, a few hundred
 * kilobytes whatever the file is. Chromium decodes it at the analysis' rate and the same arithmetic
 * measures it (electron/sound-analysis.ts); the result goes to the main process to be kept with the rest.
 *
 * Nothing until the media analysis was started by hand once (Settings → Library); then while it isn't
 * paused. A big pile (the first run) goes two at a time with hardly a pause, a few new songs one at a
 * time with a pause between; while a server song plays, playback goes first. The songs looked at first
 * are the ones nearest: the queue, Liked Songs, what played lately, the playlists; then the rest, newest
 * first. A song the server doesn't answer for is left for this session; when several fail in a row (the
 * server away), the work rests for a while. One whose stretch came but can't be measured is left for a
 * month and counted as looked at, so the progress gets to its end.
 */
import { analyseSamples } from "../../electron/sound-analysis";
import { useCatalog, versionsOf } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useSound, type SkipReason } from "../stores/sound";
import type { Track } from "../types";

/** The analysis' rate, as in the main process. */
const RATE = 11025;
const PAUSE_MS = 1500;
/** While a server song plays, the stretches wait longer between: playback goes first. */
const PAUSE_PLAYING_MS = 8000;
const REST_MS = 5 * 60_000;
const FAILS_BEFORE_REST = 4;

export const isServerSong = (id: string): boolean => id.startsWith("jf:") || id.startsWith("ss:");
const breathe = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const failed = new Set<string>();
/** When the server last made a stretch: a refusal soon after is about the song, not the server. */
let workedAt = 0;
const WORKED_LATELY_MS = 10 * 60_000;
/** The server's refusals that are about the song (a file it can't read or turn into MP3), not about the server or the login. */
const SONG_REFUSAL = new Set([400, 404, 415, 422, 500]);
/** Songs refused while the server didn't seem to work: decided once a stretch comes. */
const refusedEarly = new Set<string>();
let running = false;
let stopped = false;
/** A song asked for now (Klingt wie opened on it): measured next. */
let first: string | null = null;
/** The waits going on now (both workers may be waiting): each ends at once when woken. */
const waiting = new Set<() => void>();
/** Every wait ends now: a song asked for, or "Try again". */
function wakeAll(): void {
  for (const done of [...waiting]) done();
}

/** A wait that a song asked for now (measureSoon) or "Try again" cuts short. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      waiting.delete(done);
      resolve();
    }
    waiting.add(done);
  });
}

/** Klingt wie opened on a server song that isn't measured yet: it's the next one, now, even if it couldn't be measured before. */
export function measureSoon(t: Track): void {
  if (!isServerSong(t.id)) return;
  failed.delete(t.id);
  if (useSound.getState().skipped.has(t.id)) {
    useSound.setState((st) => ({ skipped: new Set([...st.skipped].filter((id) => id !== t.id)) }));
  }
  first = t.id;
  wakeAll();
}

/** A stretch of MP3, decoded and mixed down to mono samples at the analysis' rate; or why not: shorter than `minSeconds`, or it can't be read. */
async function decode(bytes: Uint8Array, minSeconds: number): Promise<Float32Array | "short" | "unreadable"> {
  try {
    const ctx = new OfflineAudioContext(1, RATE, RATE);
    const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const data = audio.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / audio.numberOfChannels;
    }
    return out.length >= RATE * minSeconds ? out : "short";
  } catch {
    return "unreadable";
  }
}

/** Where the stretch starts: past the intro, but early enough that a short song still has ninety seconds left. */
const startOf = (t: Track): number => (t.duration > 150 ? 30 : t.duration > 100 ? 10 : 0);

/**
 * How much of the stretch there must be: ten seconds, or most of what a short song has (an intro of
 * six seconds is measured from its six; it once counted as failed and kept the progress from its end).
 */
export const shortestStretch = (t: Pick<Track, "duration">): number => Math.max(2, Math.min(10, Math.round((t.duration - startOf(t as Track)) * 8) / 10));

/** A song whose stretch came but can't be measured: left for a month (electron/sound-library.ts), counted as looked at. */
function skip(id: string, reason: SkipReason): void {
  failed.add(id);
  void window.bytune?.soundSkip(id, reason).catch(() => false);
  useSound.setState((st) => ({ skipped: new Set([...st.skipped, id]), skipReasons: { ...st.skipReasons, [id]: reason } }));
}

/** "Try again" (Settings): every server song that couldn't be measured is tried once more, now. */
export function retryServerSongs(): void {
  failed.clear();
  refusedEarly.clear();
  useSound.setState({ skipped: new Set(), skipReasons: {} });
  wakeAll();
}

/**
 * Whether the server makes stretches now: it did lately, or it does of a song it made one of before.
 * Asked when it refuses a song and nothing else came lately; once only the songs it refuses are left
 * (the end of the first run), nothing else would ever come to tell.
 */
async function serverWorks(measured: ReadonlySet<string>): Promise<boolean> {
  if (Date.now() - workedAt < WORKED_LATELY_MS) return true;
  const known = [...measured].find((id) => isServerSong(id));
  if (!known) return false;
  const got = await window.bytune?.soundExcerpt(known, 0).catch(() => null);
  if (!(got instanceof Uint8Array) || !got.length) return false;
  workedAt = Date.now();
  return true;
}

/** The server works: what it refused before was about those songs. */
function settleRefused(): void {
  for (const id of refusedEarly) skip(id, "refused");
  refusedEarly.clear();
}

/** Which server songs still wait: not measured (themselves or another copy), not failed or skipped, not being measured. */
function waitingTest(measured: Set<string>, busy: Set<string>): (t: Track | undefined) => t is Track {
  const { facts, skipped } = useSound.getState();
  return (t: Track | undefined): t is Track =>
    !!t && isServerSong(t.id) && !measured.has(t.id) && !busy.has(t.id) && !failed.has(t.id) && !skipped.has(t.id) && !facts[t.id] && !versionsOf(t).some((v) => facts[v.id]);
}

/** How many server songs still wait. */
function waitingCount(measured: Set<string>, busy: Set<string>): number {
  const wanted = waitingTest(measured, busy);
  let n = 0;
  for (const t of useCatalog.getState().tracks) if (wanted(t)) n += 1;
  return n;
}

/** The next server song to measure: nearest first. */
function nextSong(measured: Set<string>, busy: Set<string>): Track | null {
  const wanted = waitingTest(measured, busy);
  const byId = useCatalog.getState().byId;
  if (first) {
    const asked = byId.get(first);
    first = null;
    if (wanted(asked)) return asked;
  }
  const { queue, index } = usePlayer.getState();
  const lib = useLibrary.getState();
  const near = [...queue.slice(index, index + 30), ...lib.liked, ...lib.history, ...lib.playlists.flatMap((p) => p.tracks)];
  for (const t of near) {
    const song = byId.get(t.id) ?? t;
    if (wanted(song)) return song;
  }
  let best: Track | null = null;
  for (const t of useCatalog.getState().tracks) {
    if (wanted(t) && (!best || (t.addedAt ?? 0) > (best.addedAt ?? 0))) best = t;
  }
  return best;
}

/** Many waiting (the first run): a second stretch is asked for alongside, with hardly a pause. */
const FAST_FROM = 20;
const PAUSE_FAST_MS = 250;
const PAUSE_FAST_PLAYING_MS = 3000;

async function run(): Promise<void> {
  const measured = new Set(await window.bytune?.soundMeasured().catch(() => [] as string[]));
  const busy = new Set<string>();
  let fails = 0;
  const worker = async (helper: boolean): Promise<void> => {
    while (!stopped) {
      const s = useSettings.getState();
      // Nothing until it was started by hand once; paused, nothing either.
      if (!s.soundAnalysis || !s.soundAnalysisStarted || !useCatalog.getState().loaded) {
        await wait(10_000);
        continue;
      }
      const fast = waitingCount(measured, busy) > FAST_FROM;
      // The second one only helps with a big pile.
      if (helper && !fast) {
        await wait(30_000);
        continue;
      }
      const song = nextSong(measured, busy);
      if (!song) {
        // Everything measured: look again now and then, for songs the server got since.
        await wait(REST_MS);
        continue;
      }
      busy.add(song.id);
      try {
        const got = await window.bytune?.soundExcerpt(song.id, startOf(song)).catch(() => null);
        const refused = typeof got === "number" && SONG_REFUSAL.has(got);
        if (refused && (await serverWorks(measured))) {
          // The server makes stretches of other songs, not of this one: it can't be measured.
          skip(song.id, "refused");
          settleRefused();
          await wait(PAUSE_MS);
          continue;
        }
        const bytes = got instanceof Uint8Array ? got : null;
        if (!bytes) {
          // No answer (the server away, or it said no to everything lately): tried again next session;
          // several in a row, a rest. An empty answer is an answer: it can't be measured (below).
          failed.add(song.id);
          // Refused while the server doesn't seem to work: decided once a stretch comes.
          if (refused) refusedEarly.add(song.id);
          fails += 1;
          const rest = fails >= FAILS_BEFORE_REST;
          if (rest) fails = 0;
          await wait(rest ? REST_MS : PAUSE_MS);
          continue;
        }
        fails = 0;
        const samples = await decode(bytes, shortestStretch(song));
        if (typeof samples === "string") {
          // The server answered with something that can't be measured: left for a month, and counted.
          skip(song.id, samples);
        } else {
          workedAt = Date.now();
          settleRefused();
          try {
            const facts = { ...(await analyseSamples(samples, RATE, breathe)), excerpt: true };
            measured.add(song.id);
            if (await window.bytune?.soundKeep(song.id, facts).catch(() => false)) useSound.getState().noteMeasured(song.id, facts);
          } catch {
            skip(song.id, "unreadable");
          }
        }
      } finally {
        busy.delete(song.id);
      }
      // Playback goes first: while a server song plays, the server gets more room.
      const { playing, queue, index } = usePlayer.getState();
      const serverPlaying = playing && isServerSong(queue[index]?.id ?? "");
      await wait(serverPlaying ? (fast ? PAUSE_FAST_PLAYING_MS : PAUSE_PLAYING_MS) : fast ? PAUSE_FAST_MS : PAUSE_MS);
    }
  };
  await Promise.all([worker(false), worker(true)]);
}

/** Mount once (App): measures in the background for as long as the app runs; the returned function stops it. */
export function watchServerSound(): () => void {
  stopped = false;
  if (!running) {
    running = true;
    // After the start has settled: the library loads first.
    const start = window.setTimeout(() => void run().finally(() => (running = false)), 20_000);
    return () => {
      window.clearTimeout(start);
      stopped = true;
    };
  }
  return () => {
    stopped = true;
  };
}
