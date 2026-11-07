/**
 * Test harness for the real audio engine (src/lib/audio.ts).
 *
 * The engine is bundled with esbuild and run against:
 *   - a virtual clock (so crossfade timing is deterministic and instant),
 *   - fake HTMLAudioElements whose clock is authoritative, exactly like the
 *     real thing: setting `src` publishes a duration, playing advances
 *     `currentTime`, reaching duration fires `timeupdate` then `ended`.
 *
 * Nothing about the transition logic is simulated — the code under test is
 * the shipped engine, so a regression here is a real regression.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

/* ------------------------------ virtual clock ------------------------------ */

export class Clock {
  constructor(start = 0) {
    this.t = start;
    this.timers = new Map();
    this.seq = 1;
  }
  now() {
    return this.t;
  }
  #add(fn, ms, every) {
    const id = this.seq++;
    this.timers.set(id, { fn, at: this.t + (every == null ? Math.max(0, ms || 0) : Math.max(1, ms || 1)), every });
    return id;
  }
  setTimeout(fn, ms) {
    return this.#add(fn, ms, null);
  }
  setInterval(fn, ms) {
    return this.#add(fn, ms, ms);
  }
  clearTimeout(id) {
    this.timers.delete(id);
  }
  clearInterval(id) {
    this.timers.delete(id);
  }
  /** Run the clock forward, firing due callbacks in chronological order. */
  async advance(ms, step = 5) {
    const target = this.t + ms;
    while (this.t < target) {
      const next = Math.min(target, this.t + step);
      let due = null;
      let dueId = -1;
      for (const [id, tm] of this.timers) {
        if (tm.at <= next && (due === null || tm.at < due.at)) {
          due = tm;
          dueId = id;
        }
      }
      if (due) {
        this.t = Math.max(this.t, due.at);
        due.fn();
        if (this.timers.get(dueId) === due) {
          if (due.every != null) due.at = this.t + due.every;
          else this.timers.delete(dueId);
        }
      } else {
        this.t = next;
      }
      await flushMicrotasks();
    }
    this.t = target;
  }
}

/** Let queued promise jobs and their microtask chains settle. */
export async function flushMicrotasks(rounds = 6) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/* ----------------------------- fake media element ----------------------------- */

class FakeAudio {
  constructor(registry, tickMs) {
    this.__registry = registry;
    this.__tickMs = tickMs;
    this.__listeners = new Map();
    this.__srcValue = "";
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.playbackRate = 1;
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.preload = "";
    this.buffered = { length: 0, end: () => 0 };
    this.plays = 0; // play() calls actually accepted
    registry.push(this);
  }
  get src() {
    return this.__srcValue;
  }
  set src(v) {
    this.__abortPlay();
    this.__srcValue = v == null ? "" : String(v);
    // Assigning a source resets the element, exactly like the real API.
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
    const d = globalThis.__durations?.[this.__srcValue];
    this.duration = d == null ? NaN : d;
    this.__endAt = globalThis.__streamEnds?.[this.__srcValue] ?? d;
  }
  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
  addEventListener(type, fn) {
    if (!this.__listeners.has(type)) this.__listeners.set(type, []);
    this.__listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const l = this.__listeners.get(type);
    if (l) this.__listeners.set(type, l.filter((f) => f !== fn));
  }
  emit(type) {
    (this.__registry.emits ??= []).push({
      t: globalThis.__clock?.now() ?? 0,
      el: this.__registry.indexOf(this),
      type,
      src: this.__srcValue,
      currentTime: this.currentTime,
    });
    for (const fn of (this.__listeners.get(type) ?? []).slice()) fn({ type, target: this });
  }
  load() {
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }
  play() {
    if (!this.__srcValue) return Promise.reject(Object.assign(new Error("no source"), { name: "NotSupportedError" }));
    this.paused = false;
    this.ended = false;
    // A test can ask for a song that takes a moment to start: until then a new source or a pause
    // cuts the promise off with an AbortError, as in a browser.
    if (globalThis.__playTakesMs) {
      return new Promise((resolve, reject) => {
        const pending = { reject };
        this.__pendingPlay = pending;
        globalThis.__clock.setTimeout(() => {
          if (this.__pendingPlay !== pending) return;
          this.__pendingPlay = null;
          this.plays += 1;
          this.emit("playing");
          resolve();
        }, globalThis.__playTakesMs);
      });
    }
    this.plays += 1;
    this.emit("playing");
    return Promise.resolve();
  }
  __abortPlay() {
    const pending = this.__pendingPlay;
    this.__pendingPlay = null;
    pending?.reject(Object.assign(new Error("The play() request was interrupted"), { name: "AbortError" }));
  }
  pause() {
    this.__abortPlay();
    this.paused = true;
  }
  /** Called by the harness ticker: the media clock is authoritative. */
  tick() {
    if (this.paused || !this.__srcValue || !Number.isFinite(this.duration)) return;
    const endAt = Number.isFinite(this.__endAt) ? this.__endAt : this.duration;
    const step = (this.__tickMs / 1000) * (this.playbackRate || 1);
    const before = this.currentTime;
    this.currentTime = Math.min(this.duration, this.currentTime + step);
    this.emit("timeupdate");
    if (this.currentTime >= endAt && !this.ended) {
      this.ended = true;
      this.paused = true;
      this.emit("ended");
    }
    return before;
  }
}

/* ------------------------------- esbuild bundle ------------------------------- */

const STUB_DIR = "src";
let cachedBundle = null;

async function bundleEngine() {
  if (cachedBundle) return cachedBundle;
  const stubs = {
    bridge: `
      export function hasBridge() { return true; }
      export function requireBridge() {
        return {
          localTrackUrl: async (id) => "fake:" + id,
        };
      }`,
    playEvents: `
      export function emitPlayEvent(type, track, position, playedMs, pendingMs) {
        (globalThis.__events ||= []).push({ type, id: track && track.id, position });
      }`,
    analysis: `
      export const analyseTrackHead = {
        getCached: () => (globalThis.__tempo ?? null),
        ensure: async () => {},
      };
      export async function detectEdgeSilence() { return globalThis.__trims ?? null; }`,
    artwork: `export function upgradeArtwork(t) { return t || ""; }`,
    persist: `
      export const storage = globalThis.__storage;
      export const coalescedStorage = globalThis.__storage;
      export const lazyJSONStorage = () => ({
        getItem: (n) => globalThis.__storage.getItem(n).then((raw) => (raw == null ? null : JSON.parse(raw))),
        setItem: (n, v) => globalThis.__storage.setItem(n, JSON.stringify(v)),
        removeItem: (n) => globalThis.__storage.removeItem(n),
      });`,
  };
  const out = await build({
    // A virtual entry so the test shares the engine's *own* store instances
    // (separate bundles would mean two unrelated zustand stores).
    stdin: {
      contents: `
        export * from "./src/lib/audio";
        export { usePlayer } from "./src/stores/player";
        export { useSettings } from "./src/stores/settings";
        export { useLibrary } from "./src/stores/library";
      `,
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      sourcefile: "engine-harness.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [
      {
        name: "stub-engine-deps",
        setup(b) {
          const re = new RegExp(`[\\\\/](${Object.keys(stubs).join("|")})\\.ts$`);
          b.onLoad({ filter: re }, (args) => {
            return { contents: stubs[path.basename(args.path, ".ts")], loader: "js" };
          });
        },
      },
    ],
  });
  fs.mkdirSync(".test-build", { recursive: true });
  // Per-process: `node --test` runs the test files in parallel processes, and a
  // shared path lets one process `require` a bundle another is still writing.
  // A half-written module loads with its re-exports unset, which surfaces as a
  // store arriving as `undefined` in a test that passed a moment earlier.
  const outfile = path.resolve(`.test-build/audio-engine-${process.pid}.cjs`);
  fs.writeFileSync(outfile, out.outputFiles[0].text);
  cachedBundle = outfile;
  return outfile;
}

/* ---------------------------------- harness ---------------------------------- */

/**
 * Boot a fresh engine against a fresh set of fake media elements.
 *
 * `tickMs` is the media element's clock granularity (default 20ms, like a
 * browser's timeupdate cadence).
 */
export async function createEngine({ tickMs = 20 } = {}) {
  const outfile = await bundleEngine();
  const clock = new Clock();
  const elements = [];
  const events = [];
  const durations = {};
  const streamEnds = {};
  const storage = {
    async getItem() {
      return null;
    },
    async setItem() {},
    async removeItem() {},
  };

  globalThis.__durations = durations;
  globalThis.__streamEnds = streamEnds;
  globalThis.__storage = storage;
  globalThis.__events = events;
  globalThis.__clock = clock;
  delete globalThis.__tempo;
  delete globalThis.__trims;
  delete globalThis.__playTakesMs;
  globalThis.__registry = elements;

  const prev = {
    window: globalThis.window,
    performance: globalThis.performance,
    Audio: globalThis.Audio,
    fetch: globalThis.fetch,
  };
  globalThis.performance = { now: () => clock.now() };
  globalThis.window = {
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.Audio = class extends FakeAudio {
    constructor() {
      super(elements, tickMs);
    }
  };
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

  // The media clock ticks first so a boundary `ended` and a fade completion
  // landing on the same millisecond resolve the way a browser resolves them.
  const trace = [];
  clock.setInterval(() => {
    for (const e of elements) e.tick();
    record();
  }, tickMs);

  function record() {
    elements.forEach((e, el) => {
      trace.push({ t: clock.now(), el, src: e.src, currentTime: e.currentTime, paused: e.paused, ended: e.ended });
    });
  }

  delete require.cache[require.resolve(outfile)];
  const engine = require(outfile);

  const api = {
    engine,
    clock,
    events,
    elements,
    durations,
    trace,
    record,
    /** declare the duration a fake stream reports, e.g. setDuration("A", 210) */
    setDuration(id, seconds) {
      durations[`fake:${id}`] = seconds;
    },
    /**
     * Declare where the stream actually runs out, when that differs from the
     * duration it reports. Real streams do this: the engine plans the blend
     * from `duration`, but the element can reach its `ended` a beat earlier.
     * This is what decides which of the two completion paths wins the race.
     */
    setStreamEnd(id, seconds) {
      streamEnds[`fake:${id}`] = seconds;
    },
    advance: (ms) => clock.advance(ms),
    restore() {
      globalThis.performance = prev.performance;
      globalThis.window = prev.window;
      globalThis.Audio = prev.Audio;
      globalThis.fetch = prev.fetch;
    },
  };
  return api;
}

export const track = (id, duration) => ({ id, title: id, artist: "Test", album: "T", duration, thumb: null, localPath: `${id}.flac` });

/* ------------------------------ query helpers ------------------------------ */

export const FADE_SEC = 0.6;

/** Boot a fresh engine with a crossfade configured the way Auto Mix sets it up. */
export async function boot(opts = {}) {
  const h = await createEngine(opts);
  const { usePlayer, useSettings, useLibrary } = h.engine;
  useSettings.setState({
    crossfadeSeconds: opts.fadeSeconds ?? FADE_SEC,
    smartFade: opts.smartFade ?? false,
    skipSilence: opts.skipSilence ?? false,
    // Off unless a test asks: the crossfade tests time what plays without it.
    gapless: opts.gapless ?? false,
    autoplay: false,
    playbackSpeed: 1,
  });
  useLibrary.setState({ history: [] });
  while (!usePlayer.persist.hasHydrated()) await flushMicrotasks(2);
  h.engine.initAudioEngine();
  return h;
}

/** The store's view of what is playing. */
export function read(h) {
  const s = h.engine.usePlayer.getState();
  return { index: s.index, id: s.queue[s.index]?.id ?? null, position: s.position, duration: s.duration, playing: s.playing };
}

/** Every media element currently carrying `id`. */
export function decksOf(h, id) {
  const url = `fake:${id}`;
  return h.elements
    .map((e, el) => ({ el, src: e.src, currentTime: e.currentTime, paused: e.paused, volume: e.volume }))
    .filter((d) => d.src === url);
}

/** Decks that are actually producing sound right now. */
export function sounding(h) {
  return h.elements
    .map((e, el) => ({ el, src: e.src, currentTime: e.currentTime, paused: e.paused }))
    .filter((e) => e.src && !e.paused);
}

/** The first moment `id` was audible, per element. */
export function firstAudible(h, id, after = 0.05) {
  const url = `fake:${id}`;
  const first = new Map();
  for (const s of h.trace) {
    if (s.src !== url || s.currentTime < after) continue;
    if (!first.has(s.el)) first.set(s.el, s);
  }
  return first;
}

/** Clock time at which `id` first became audible, or Infinity. */
export function firstSoundAt(h, id) {
  const url = `fake:${id}`;
  for (const s of h.trace) if (s.src === url && s.currentTime > 0.01) return s.t;
  return Infinity;
}

/** Clock time at which a deck carrying `id` fired `ended`, or Infinity. */
export function endedAt(h, id) {
  const url = `fake:${id}`;
  for (const e of h.elements.emits ?? []) if (e.type === "ended" && e.src === url) return e.t;
  return Infinity;
}

/** Media events of one type for a track, in order. */
export function mediaEvents(h, id, type) {
  const url = `fake:${id}`;
  return (h.elements.emits ?? []).filter((e) => e.type === type && e.src === url);
}

/**
 * True when a track that had already played past `floor` seconds is later seen
 * near zero again — i.e. it was restarted instead of promoted.
 */
export function restartedFrom(h, id, floor = 0.15) {
  const url = `fake:${id}`;
  const peak = new Map();
  for (const s of h.trace) {
    if (s.src !== url) continue;
    const p = peak.get(s.el) ?? 0;
    if (p >= floor && s.currentTime < floor - 0.01) return true;
    peak.set(s.el, Math.max(p, s.currentTime));
  }
  return false;
}

/** Telemetry "start" events emitted for a track. */
export function startsOf(h, id) {
  return h.events.filter((e) => e.type === "start" && e.id === id);
}

/** Start a queue and reset the recording, so a test only sees its own run. */
export async function play(h, tracks, startIndex = 0) {
  h.engine.usePlayer.getState().playQueue(tracks, startIndex);
  await flushMicrotasks();
  h.trace.length = 0;
  (h.elements.emits ?? []).length = 0;
  h.record();
}
