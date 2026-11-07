/**
 * Audio engine — two HTMLAudioElements wired to the player store.
 *
 * The store holds pure state; this module owns all playback side effects:
 * stream resolution (via the main process), play/pause/seek application,
 * error recovery with client rotation, history logging, MediaSession
 * integration (Windows media keys / SMTC, with double-press recognition for
 * headset play/pause buttons and pause-on-output-loss), and transitions.
 *
 * Transitions (crossfade controller):
 *   - "standard" crossfade: when a setting duration is configured, the next
 *     track is resolved and started on the standby element a beat before the
 *     current one ends, and the two are blended with an equal-power curve
 *     (out·cosθ + in·sinθ) — no dip in the middle, the standard crossfade law.
 *   - "smart" (automix-lite): when enabled, the next track's opening seconds
 *     are decoded and analysed for tempo (onset-energy BPM) in a worker; the
 *     fade is armed so it *starts* on a beat multiple inside the configured
 *     window. Analysis failing ⇒ honest fallback to the standard fade.
 *   - manual next/prev/seek aborts any fade in flight.
 *
 * Transition states, and the invariant they exist to protect:
 *
 *   idle     — one live deck; the session player is the only one playing.
 *   armed    — the next track is resolved and sits on the standby deck.
 *   blending — the standby deck is PLAYING and audible while the session
 *              player fades out. Two decks are live, and the standby's media
 *              clock is authoritative for the track it is playing.
 *   settled  — the standby deck was promoted to session player.
 *
 *   IF A TRACK IS ALREADY PLAYING DURING A BLEND, THE TRANSITION'S COMPLETION
 *   MUST PROMOTE THAT DECK. Re-running the fresh-track path would reload the
 *   same track from 0:00 and replay the seconds the listener just heard.
 *
 * Two independent signals mean "the transition is over": the blend timer
 * reaching the end of its curve, and the outgoing element's `ended`. They race
 * by a few milliseconds — the fade timeline starts after an async resolve and a
 * play(), so `ended` usually lands first — so both funnel through one
 * idempotent completion, and the deck that is already playing wins either way.
 */
import { useLibrary } from "../stores/library";
import { setQueueRanOut, usePlayer } from "../stores/player";
import { placeOf } from "./queueSections";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { emitPlayEvent } from "./playEvents";
import { analyseTrackHead, detectEdgeSilence } from "./analysis";
import { runsOn } from "./continuity";
import { soundOf } from "../stores/sound";
import { upgradeArtwork } from "./artwork";
import { createMediaKeyTap } from "./media-key-tap";
import { isLibraryTrack, loadAllLibraryTracks } from "./libraryTracks";
import { playableVersions, resolveLibrarySource } from "./librarySource";
import { sourceOf, trackAvailable, useAvailability, versionAvailable } from "../stores/availability";
import { songKey, useCatalog, versionsOf } from "../stores/catalog";
import {
  deviceChoices,
  outputChangeAction,
  snapshotOutputs,
  type OutputDeviceChoice,
  type OutputSnapshot,
} from "./audio-output";
import { T } from "./i18n";

let elements: [HTMLAudioElement, HTMLAudioElement] | null = null;
/** which element is the session player right now */
let mainIdx: 0 | 1 = 0;
let loadedId: string | null = null;
/** the song whose source is still being looked up; it goes by `playing` and `pendingSeek` when it arrives */
let loadingId: string | null = null;
/** bumped by every load, so one that was overtaken gives way instead of cutting the newer one off */
let loadTurn = 0;
let pendingSeek = 0;
/** retries (with client rotation) for the current track */
let retryCount = 0;
/** consecutive tracks that failed to play — stops auto-skipping eventually */
let consecutiveFailures = 0;
/** the unlinked-local-folder explainer fires once per failing streak, not per skip */
let localMissingToasted = false;
/** the "isn't reachable right now" note fires once per failing streak, too */
let unreachableToasted = false;
/** versions of the loading song that already failed this play — the next one is tried instead */
const failedVersions = new Set<string>();
let historyForId: string | null = null;
/** track id the engine itself is advancing to via crossfade — suppresses reload */
let advancingToId: string | null = null;

const MAX_SKIPS = 5;

interface FadeState {
  /** ids, to detect the fade's own completion vs an interrupting change */
  fromId: string;
  toId: string;
  startTs: number;
  durMs: number;
  /** main element's currentTime when the fade began */
  anchorSec: number;
  smart: boolean;
  reason: string;
  /** performance.now() when playback paused mid-fade; null while playing.
      The blend freezes with playback — see the pause branch and driveFade. */
  pausedAt: number | null;
}
let fade: FadeState | null = null;
let fadeTimer: number | null = null;
/** arming window: resolve/start the next track this long before the fade point */
const ARM_LEAD_MS = 4000;
let armed: { toId: string } | null = null;
/**
 * Bumped whenever something invalidates an in-flight arming (a track change, a
 * completed or aborted transition). `beginFade` awaits several times before it
 * starts the standby deck; without this its continuation could wake up after
 * the world moved on and start a track the user already skipped past.
 */
let transitionToken = 0;
/** True while a completion is promoting a deck — makes completion idempotent. */
let settling = false;

/** Derived phase, for callers that must not fight an in-flight transition. */
function transitioning(): boolean {
  return fade !== null || armed !== null;
}
/** silence trims per track id — seconds to skip at the start / before the end */
const silenceTrims = new Map<string, { head: number; tail: number }>();
const MAX_TRIMS = 400;
function setTrim(trackId: string, trims: { head: number; tail: number }): void {
  silenceTrims.delete(trackId);
  silenceTrims.set(trackId, trims);
  while (silenceTrims.size > MAX_TRIMS) {
    const first = silenceTrims.keys().next().value;
    if (first === undefined) break;
    silenceTrims.delete(first);
  }
}
let silenceAnalysing = new Set<string>();

function el(): HTMLAudioElement {
  return elements![mainIdx];
}

/** Live element clock for consumers needing sub-`timeupdate` resolution (lyrics sweep). */
export function getPlaybackPosition(): number {
  // Casting or following: the other side's last report, run on between its reports. The silent deck knows nothing.
  if (castFollower) {
    if (!castClock) return usePlayer.getState().position;
    const pos = castClock.running ? castClock.pos + (performance.now() - castClock.at) / 1000 : castClock.pos;
    const d = usePlayer.getState().duration;
    return d > 0 ? Math.min(pos, d) : pos;
  }
  return elements ? el().currentTime : 0;
}
function standbyEl(): HTMLAudioElement {
  return elements![mainIdx === 0 ? 1 : 0];
}

/**
 * play() promises reject with "AbortError" when pause() or a src change wins
 * the race — that is a normal interruption, not a playback failure. Treating
 * it as one made handleFailure force-rotate the stream and restart audio the
 * user had just stopped.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

/* ============================ loudness normalisation ============================ */

/**
 * Each song's level: its ReplayGain where it has one (replayGainFor), its
 * original level otherwise. track id → gain, insertion-ordered as an LRU.
 */
const loudnessGains = new Map<string, number>();
const GAINS_MAX = 600;

function rememberGain(trackId: string, gain: number): void {
  loudnessGains.delete(trackId);
  loudnessGains.set(trackId, gain);
  while (loudnessGains.size > GAINS_MAX) {
    const first = loudnessGains.keys().next().value;
    if (first === undefined) break;
    loudnessGains.delete(first);
  }
}

function gainForTrack(trackId: string | null): number {
  return trackId ? loudnessGains.get(trackId) ?? 1 : 1;
}

/**
 * ReplayGain for library songs: tag values for local files, Jellyfin's own
 * loudness gain, Navidrome's OpenSubsonic values. Gains are referenced to
 * −18 LUFS; the target setting shifts them (−14 LUFS = +4 dB). It only ever
 * attenuates: loud masters come down, quieter ones stay as they are, so
 * nothing can clip. Songs without gain information keep their original level.
 */
function replayGainFor(track: Track): number {
  const { replayGainMode, replayGainTarget } = useSettings.getState();
  if (replayGainMode === "off" || !track.rg) return 1;
  const { trackGain, albumGain } = track.rg;
  const db = replayGainMode === "album" ? albumGain ?? trackGain : trackGain ?? albumGain;
  if (db === undefined || !Number.isFinite(db)) return 1;
  return Math.min(1, Math.pow(10, (db + replayGainTarget + 18) / 20));
}

/**
 * The volume slider is perceptual: hearing is logarithmic, so a linear gain
 * crams nearly all the audible change into the bottom fifth of the slider
 * and leaves "very low" still loud. A cube law spreads it evenly — ¾ of the
 * way is −7.5 dB, half −18 dB, a tenth −60 dB.
 */
function userVolume(): number {
  const s = usePlayer.getState();
  return s.muted ? 0 : Math.pow(Math.min(1, Math.max(0, s.volume)), 3);
}

/* ------------------- play/pause volume ramp ------------------- */

/**
 * Spotify-style pause/resume: the volume glides to silence over ~150ms before
 * the element actually pauses, and glides back up on resume, so play/pause
 * never clicks. Deliberately separate from the crossfade controller — it only
 * shapes the main element around a play/pause flip and stands down the moment
 * anything else (a crossfade, a track change, a fresh load) touches volumes.
 */
const PP_RAMP_MS = 150;

/** Active ramp: dir 0 = gliding down to a pause, 1 = gliding up on resume.
 * `from` lets a reversed ramp continue from its current level instead of
 * snapping (pause pressed mid fade-in, play pressed mid fade-out). */
let ppRamp: { dir: 0 | 1; from: number; startTs: number; timer: number } | null = null;

function stopPpRamp(): void {
  if (ppRamp) {
    window.clearInterval(ppRamp.timer);
    ppRamp = null;
  }
}

/** Ramp multiplier for the main element — 1 (neutral) when no ramp runs. */
function ppRampGain(): number {
  if (!ppRamp) return 1;
  const p = Math.min(1, Math.max(0, (performance.now() - ppRamp.startTs) / PP_RAMP_MS));
  const eased = (1 - Math.cos(Math.PI * p)) / 2;
  return ppRamp.dir === 0 ? ppRamp.from * (1 - eased) : ppRamp.from + (1 - ppRamp.from) * eased;
}

function startPpRamp(dir: 0 | 1): void {
  const from = ppRamp ? ppRampGain() : dir === 1 ? 0 : 1;
  stopPpRamp();
  if (!elements) return;
  ppRamp = { dir, from, startTs: performance.now(), timer: 0 };
  ppRamp.timer = window.setInterval(() => {
    if (!ppRamp || !elements) {
      stopPpRamp();
      return;
    }
    // A crossfade owns the volume curve while it runs — stand down.
    if (fade) {
      stopPpRamp();
      return;
    }
    const d = ppRamp.dir;
    if ((d === 0 && ppRampGain() <= 0) || (d === 1 && ppRampGain() >= 1)) {
      stopPpRamp();
      // The fade-out's whole point: pause only once silence is reached —
      // and never if a resume already won the race.
      if (d === 0 && !usePlayer.getState().playing) el().pause();
      refreshVolumes();
      return;
    }
    refreshVolumes();
  }, 25);
}

/** Re-apply element volumes for the current state (fade curve, ramp or steady). */
function refreshVolumes(): void {
  if (fade) {
    // Same clock driveFade uses: while paused the blend holds its frozen
    // point instead of drifting to the end of the curve.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
  } else {
    applyElementVolumes(ppRampGain(), 0);
  }
}

/**
 * Set both elements' volumes from the user volume, the crossfade curve and
 * each element's own track loudness gain (main = current track, standby =
 * the track being faded in).
 */
function applyElementVolumes(mainGain: number, standbyGain: number): void {
  if (!elements) return;
  const v = userVolume();
  const state = usePlayer.getState();
  const mainId = state.queue[state.index]?.id ?? null;
  const standbyId = fade?.toId ?? null;
  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
  elements[mainIdx].volume = clamp01(v * mainGain * gainForTrack(mainId));
  elements[mainIdx === 0 ? 1 : 0].volume = clamp01(v * standbyGain * gainForTrack(standbyId));
}

function applySpeed(): void {
  if (!elements) return;
  const rate = useSettings.getState().playbackSpeed || 1;
  for (const e of elements) {
    try {
      e.playbackRate = rate;
      // Chromium honours pitch preservation separately; keep speech/music natural.
      (e as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Route both decks to the user's chosen output device (settings.audioSinkId).
 * An empty string is the spec's "system default". A vanished device makes
 * setSinkId reject — fall back to the default so resume stays audible; the
 * output watch independently resets the setting when the chosen device
 * disappears from enumeration.
 */
function applySink(): void {
  if (!elements) return;
  const target = useSettings.getState().audioSinkId || "";
  // Once the EQ graph owns the decks, the element sinks are bypassed: the
  // context's own sink is the one that reaches the speakers.
  if (eqCtx) {
    const ctx = eqCtx as AudioContext & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId === "function" && ctx.sinkId !== target) {
      ctx.setSinkId(target).catch(() => ctx.setSinkId!("").catch(() => undefined));
    }
    return;
  }
  for (const e of elements) {
    // setSinkId is Chromium-only; test harnesses and exotic embeds mock plain
    // elements — degrade to the default rather than throw.
    if (typeof e.setSinkId !== "function") continue;
    const current = (e as HTMLAudioElement & { readonly sinkId: string }).sinkId;
    if (current === target) continue;
    e.setSinkId(target).catch(() => {
      if (!target) return;
      // Windows re-issues endpoint ids around device switches, so a just-set
      // sink can reject transiently. Retry once the enumeration settles;
      // only then fall back to the default.
      window.setTimeout(() => {
        e.setSinkId(target).catch(() => e.setSinkId("").catch(() => undefined));
      }, 300);
    });
  }
}

/* ============================ equalizer ============================ */

/** Band centres (Hz) of the 10-band graphic EQ; settings.eqGains maps 1:1. */
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

let eqCtx: AudioContext | null = null;
/** Both decks feed this node; its gain is the parametric profile's preamp. */
let eqInput: GainNode | null = null;
let eqFilters: BiquadFilterNode[] = [];
/** Last node of the chain (eqInput when no band is active). */
let eqTail: AudioNode | null = null;
let eqLimiter: DynamicsCompressorNode | null = null;
let eqLimited = false;
/** Filter types of the built chain — a different shape means a rebuild. */
let eqShape = "";

interface EqBandPlan {
  type: BiquadFilterType;
  freq: number;
  gain: number;
  q: number;
}

/** What the graph should run: the 10-band sliders or the parametric/AutoEQ profile (null = EQ off). */
function eqPlan(): { preampDb: number; bands: EqBandPlan[] } | null {
  const s = useSettings.getState();
  if (!s.eqEnabled) return null;
  if (s.eqMode === "parametric") {
    return { preampDb: s.peq.preamp, bands: s.peq.bands.map((b) => ({ type: b.type, freq: b.freq, gain: b.gain, q: b.q })) };
  }
  return {
    preampDb: 0,
    bands: EQ_BANDS.map((freq, i) => ({
      type: i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking",
      freq,
      gain: s.eqGains[i] ?? 0,
      q: 1.41, // one-octave bands
    })),
  };
}

/**
 * Both decks → preamp → EQ bands → (limiter while the curve can boost) →
 * speakers. Element volume is applied before a MediaElementSource (verified
 * on Electron's Chromium), so the gain/fade/normalisation logic above keeps
 * working through the graph. Built on first enable only: a deck can never be
 * detached from its source node again, so turning the EQ off afterwards
 * leaves an empty, transparent chain (preamp at 0 dB, no bands).
 */
function applyEq(): void {
  if (!elements) return;
  const plan = eqPlan();
  if (!eqCtx) {
    if (!plan) return;
    const ctx = new AudioContext();
    eqCtx = ctx;
    // Brick-wall-ish limiter for boosts the preamp doesn't cover (the
    // 10-band sliders have no preamp: it pulled everything down by the
    // largest boost). It only touches peaks pushed past full scale.
    eqLimiter = ctx.createDynamicsCompressor();
    eqLimiter.threshold.value = -0.5;
    eqLimiter.knee.value = 0;
    eqLimiter.ratio.value = 20;
    eqLimiter.attack.value = 0.002;
    eqLimiter.release.value = 0.15;
    eqLimiter.connect(ctx.destination);
    eqInput = ctx.createGain();
    for (const e of elements) ctx.createMediaElementSource(e).connect(eqInput);
    applySink();
  }
  const ctx = eqCtx;
  const input = eqInput!;
  const bands = plan?.bands ?? [];
  const nyquist = ctx.sampleRate / 2;

  // Rebuild the chain only when its shape changes; parameters glide below.
  const shape = bands.map((b) => b.type).join(",");
  if (shape !== eqShape || !eqTail) {
    input.disconnect();
    for (const f of eqFilters) f.disconnect();
    eqFilters = bands.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      return f;
    });
    let node: AudioNode = input;
    for (const f of eqFilters) {
      node.connect(f);
      node = f;
    }
    node.connect(ctx.destination);
    eqTail = node;
    eqLimited = false;
    eqShape = shape;
  }

  const t = ctx.currentTime;
  const preampDb = plan?.preampDb ?? 0;
  input.gain.setTargetAtTime(Math.pow(10, preampDb / 20), t, 0.02);
  eqFilters.forEach((f, i) => {
    const b = bands[i];
    f.frequency.setTargetAtTime(Math.min(Math.max(b.freq, 10), nyquist - 100), t, 0.02);
    f.Q.setTargetAtTime(b.q, t, 0.02);
    f.gain.setTargetAtTime(b.gain, t, 0.02);
  });

  // The limiter sits in the path only while the curve can push past full
  // scale, so a flat, cut-only or preamp-compensated EQ (and EQ off) stays
  // untouched by it.
  const boosts = bands.filter((b) => b.type !== "lowpass" && b.type !== "highpass").map((b) => b.gain);
  const limit = preampDb + Math.max(0, ...boosts) > 0.05;
  if (limit !== eqLimited && eqTail) {
    eqTail.disconnect();
    eqTail.connect(limit ? eqLimiter! : ctx.destination);
    eqLimited = limit;
  }
  if (ctx.state === "suspended") void ctx.resume();
}

let labelsUnlocked = false;

/** Chromium hides labels AND hands out empty deviceIds until the page has
    held capture permission once — without the unlock the picker can list
    endpoints it cannot route to. */
function needsLabelUnlock(devices: readonly MediaDeviceInfo[]): boolean {
  return devices.some((d) => d.kind === "audiooutput" && (!d.deviceId || !d.label));
}

/**
 * The pickable output list for the settings menu. Chromium hides device
 * labels until the page has held capture permission once, so the first open
 * asks for it (tracks stopped immediately) — only on explicit user intent
 * (opening the picker), never at startup. Failure degrades to generic
 * "Speaker N" labels, and the unlock retries on later opens (e.g. after the
 * user enables microphone access in Windows settings) instead of being
 * permanently written off after one failure.
 */
export async function listOutputDevices(): Promise<OutputDeviceChoice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!labelsUnlocked && needsLabelUnlock(devices)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      // Only retire the unlock when it actually produced ids + labels —
      // an OS-level refusal (Windows microphone privacy) stays retryable.
      labelsUnlocked = !needsLabelUnlock(devices);
    } catch {
      /* keep whatever labels we have; retry on the next open */
    }
  }
  return deviceChoices(devices);
}

function updateBuffered(): void {
  const a = el();
  if (!a) return;
  try {
    if (a.buffered.length > 0 && Number.isFinite(a.duration) && a.duration > 0) {
      usePlayer.getState()._setBuffered(a.buffered.end(a.buffered.length - 1) / a.duration);
    }
  } catch {
    /* ignore */
  }
}

function onTimeUpdate(): void {
  const a = el();
  if (!a) return;
  usePlayer.getState()._setTime(a.currentTime, a.duration);
  updateBuffered();
  const cur = usePlayer.getState().queue[usePlayer.getState().index];
  if (cur) accumulate(cur.id, a.currentTime);
  maybeArmTransition();
}

/* ============================ transitions ============================ */

function fadeMsForNext(): number {
  const s = useSettings.getState();
  // Automix owns transitions, so it works out of the box: no crossfade
  // duration set means a sensible 6s blend rather than no transition at all.
  const fallback = s.smartFade ? 6 : 0;
  return Math.max(0, Math.round((s.crossfadeSeconds || fallback) * 1000));
}

/**
 * Transition planner, desktop scale: when smart mode is on and the
 * next track's tempo is known, slide the fade start so it lands on a beat
 * (or a bar) inside the arming window — a transition that begins on the grid
 * instead of an arbitrary sample. Everything else is a standard fade.
 */
function planFadeStart(nextId: string, fadeMs: number): { delayMs: number; smart: boolean; reason: string } {
  const smartOn = useSettings.getState().smartFade;
  const a = el();
  const duration = Number.isFinite(a.duration) ? a.duration : 0;
  const remainingMs = Math.max(0, (duration - a.currentTime) * 1000);
  if (!smartOn || remainingMs <= fadeMs) return { delayMs: Math.max(0, remainingMs - fadeMs), smart: false, reason: "standard" };

  // The head analysis' tempo, or else the whole song's from the sound analysis.
  const bpm = analyseTrackHead.getCached(nextId)?.bpm || soundOf(usePlayer.getState().queue.find((t) => t.id === nextId))?.bpm || 0;
  if (!bpm || bpm < 50 || bpm > 220) {
    return { delayMs: Math.max(0, remainingMs - fadeMs), smart: false, reason: "no tempo — standard fade" };
  }
  const beatMs = 60000 / bpm;
  const beatDist = (ms: number): number => {
    const m = Math.abs(ms % beatMs);
    return Math.min(m, beatMs - m);
  };
  // Slide the fade start so both its start and its end sit close to beats —
  // the blend then opens and lands on the grid instead of between them.
  const idealStart = Math.max(0, remainingMs - fadeMs);
  const earliest = Math.max(0, idealStart - beatMs * 2);
  let best = idealStart;
  let bestErr = Infinity;
  for (let t = earliest; t <= remainingMs; t += beatMs) {
    const err = beatDist(t) + beatDist(t + fadeMs);
    if (err < bestErr) {
      bestErr = err;
      best = t;
    }
  }
  return { delayMs: Math.max(0, best), smart: true, reason: `beat-aligned @ ${bpm} BPM` };
}

/**
 * Gapless: with no crossfade set, the next song takes over in a blend this
 * short, ending where this one does — no silence between songs of an album
 * that runs on (a live set, a soundtrack, a concept record). The standby deck
 * is armed and buffered seconds ahead like a crossfade's; only its start is
 * timed on the playing element's own clock (untilRemaining), not a timer.
 */
const GAPLESS_MS = 15;

function gaplessNext(): boolean {
  const s = useSettings.getState();
  // Skip silence trims song ends itself — the end it plays to isn't the file's.
  return s.gapless && !s.skipSilence && fadeMsForNext() === 0;
}

/** Wait until the playing deck has `ms` (wall time, at its speed) left — halving the wait each step, ~4 ms close. */
async function untilRemaining(ms: number, stale: () => boolean): Promise<void> {
  for (;;) {
    const a = el();
    const duration = Number.isFinite(a.duration) ? a.duration : 0;
    const left = ((duration - a.currentTime) * 1000) / (a.playbackRate || 1) - ms;
    if (left <= 4 || stale() || a.paused || !duration) return;
    await new Promise<void>((r) => window.setTimeout(r, Math.min(Math.max(left / 2, 2), 250)));
  }
}

/**
 * The next song runs on from this one (lib/continuity.ts) — the next track of
 * a live album or a mix, or a pair that meets sounding: it takes over
 * seamlessly, whatever the crossfade or Automix would do.
 */
function seamlessNext(): boolean {
  const state = usePlayer.getState();
  const cur = state.queue[state.index];
  const next = state.queue[state.index + 1];
  if (!useSettings.getState().seamlessAlbums || !cur || !next || state.repeat === "one") return false;
  return runsOn(cur, next, { cur: soundOf(cur), next: soundOf(next) });
}

function maybeArmTransition(): void {
  if (fade || armed) return;
  const gapless = gaplessNext() || seamlessNext();
  const fadeMs = gapless ? GAPLESS_MS : fadeMsForNext();
  if (!gapless && fadeMs < 500) return;
  const state = usePlayer.getState();
  if (state.repeat === "one") return;
  if (!state.queue.length || state.index >= state.queue.length - 1) return;
  const a = el();
  const duration = Number.isFinite(a.duration) ? a.duration : 0;
  if (!duration || !state.playing) return;
  const remainingMs = (duration - a.currentTime) * 1000;
  if (remainingMs > fadeMs + ARM_LEAD_MS || remainingMs <= 250) return;

  const nextTrack = state.queue[state.index + 1];
  if (!nextTrack) return;
  armed = { toId: nextTrack.id };
  void beginFade(nextTrack, fadeMs);
}

async function beginFade(nextTrack: Track, fadeMs: number): Promise<void> {
  const stand = standbyEl();
  const token = ++transitionToken;
  /** The arming this continuation belongs to is still the live one. */
  const stale = (): boolean => token !== transitionToken;
  try {
    // A song found in several places fades in from the copy it plays from
    // (the local file before a server stream).
    const source = isLibraryTrack(nextTrack) ? await resolveLibrarySource(nextTrack) : null;
    if (!source) {
      armed = null;
      return;
    }
    const { url } = source;
    // The fade's standby element carries the incoming track's own gain.
    rememberGain(nextTrack.id, replayGainFor(source.version));
    usePlayer.getState()._setSource(nextTrack.id, source.version);
    // The world may have moved on while we resolved.
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (stale() || !armed || armed.toId !== nextTrack.id || fade || cur?.id === nextTrack.id) {
      armed = null;
      return;
    }
    // Smart mode needs the next track's tempo; if it isn't analysed yet this
    // is the moment it gets fetched and decoded (bounded by the arm window).
    if (useSettings.getState().smartFade && fadeMs > GAPLESS_MS) {
      await Promise.race([
        analyseTrackHead.ensure(nextTrack.id),
        new Promise<void>((r) => window.setTimeout(r, 2200)),
      ]);
    }
    if (stale() || !armed || armed.toId !== nextTrack.id || fade) {
      armed = null;
      return;
    }
    // A seamless takeover is timed on the playing deck's clock below, never on a beat plan.
    const plan = fadeMs > GAPLESS_MS ? planFadeStart(nextTrack.id, fadeMs) : { delayMs: 0, smart: false, reason: "seamless" };
    const startAt = performance.now() + plan.delayMs;
    stand.preload = "auto";
    stand.src = url;
    stand.currentTime = 0;
    applySpeed();
    armed = null;
    if (fadeMs <= GAPLESS_MS) {
      await untilRemaining(fadeMs, stale);
    } else {
      const waitMs = startAt - performance.now();
      if (waitMs > 30) await new Promise<void>((r) => window.setTimeout(r, waitMs));
    }
    if (stale() || fade) return;
    // If the user interacted meanwhile, re-check.
    const s2 = usePlayer.getState();
    if (s2.index >= s2.queue.length - 1 || s2.queue[s2.index + 1]?.id !== nextTrack.id) return;
    const main = el();
    if (!s2.playing) {
      try {
        stand.pause();
      } catch {
        /* ignore */
      }
      return;
    }
    const anchorSec = main.currentTime;
    fade = {
      fromId: s2.queue[s2.index].id,
      toId: nextTrack.id,
      startTs: performance.now(),
      durMs: fadeMs,
      anchorSec,
      smart: plan.smart,
      reason: plan.reason,
      pausedAt: null,
    };
    if (plan.smart) {
      useUI.getState().toast(T("Automix: {reason}", { reason: plan.reason }), "info");
    }
    try {
      void stand.play();
    } catch {
      /* fade falls back below if the standby refuses */
    }
    stopPpRamp();
    applyElementVolumes(1, 0);
    driveFade();
  } catch {
    // Resolution failed — the natural end path handles playback.
    armed = null;
  }
}

/** One 25ms tick of the equal-power ramp; finalizes the transition at the end. */
function driveFade(): void {
  if (fadeTimer != null) return;
  fadeTimer = window.setInterval(() => {
    if (!fade || !elements) {
      stopFadeTimer();
      return;
    }
    const state = usePlayer.getState();
    const cur = state.queue[state.index];
    // Interrupted by anything that changed the current track identity.
    if (!cur || cur.id !== fade.fromId) {
      abortFade(false);
      return;
    }
    // A track shorter than the blend runs out mid-transition. Promoting it
    // there is the only outcome that isn't a silent gap: the blend would
    // otherwise keep fading a deck with nothing left to fade in.
    if (standbyEl().ended) {
      completeTransition("incoming-ended");
      return;
    }
    // The blend freezes while paused (see the pause branch): hold the curve
    // and never finalize — finalize swaps roles and sets playing: true, which
    // force-resumed the next track after the user had paused.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
    if (p >= 1) {
      if (!state.playing) return;
      completeTransition("blend-complete");
    }
  }, 25);
}

function stopFadeTimer(): void {
  if (fadeTimer != null) {
    window.clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

/**
 * The single, idempotent end of a transition.
 *
 * Both completion signals — the blend timer and the outgoing element's
 * `ended` — land here, so whichever wins, the deck that is already playing
 * the incoming track is the one that becomes the session player. Its media
 * element is kept as-is: same src, same playback position, still running.
 * Nothing is reloaded and `currentTime` is never rewritten.
 */
function completeTransition(reason: "blend-complete" | "outgoing-ended" | "incoming-ended"): void {
  if (settling) return;
  const f = fade;
  if (!f) return;
  settling = true;
  fade = null;
  armed = null;
  stopFadeTimer();
  try {
    const state = usePlayer.getState();
    const ni = placeOf(state.queue, f.toId, state.index, 1);
    if (ni < 0) {
      // The incoming track left the queue mid-blend (it was removed, or the
      // queue was truncated). Nothing owns that deck any more, so stop it —
      // leaving it playing would put a track in the air that the UI has no
      // record of — and hand the volume back to the outgoing one.
      const orphan = standbyEl();
      try {
        orphan.pause();
        orphan.removeAttribute("src");
        orphan.load();
      } catch {
        /* ignore */
      }
      applyElementVolumes(1, 0);
      return;
    }
    // Role swap FIRST: the standby element IS the session player now, and the
    // outgoing main gets cleaned up only after it has been demoted.
    const oldMain = el();
    mainIdx = mainIdx === 0 ? 1 : 0;
    loadedId = f.toId;
    historyForId = f.toId;
    try {
      oldMain.pause();
      oldMain.removeAttribute("src");
      oldMain.load();
    } catch {
      /* ignore */
    }
    // The promoted deck's own clock is the authority for where this track is.
    // Read it before touching the store, and clamp: a deck that ran out early
    // can report a position at or past its duration, and a store position
    // beyond the media duration is what makes a later seek jump.
    const stand = el();
    const raw = stand.currentTime;
    const dur = Number.isFinite(stand.duration) ? stand.duration : Infinity;
    const pos = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), Number.isFinite(dur) ? dur : Math.max(raw, 0)) : 0;
    flushAccum("stop");
    accum = { id: f.toId, playedMs: 0, pendingMs: 0, lastPos: pos };
    emitPlayEvent("start", state.queue[ni], pos, 0, 0);
    useLibrary.getState().pushHistory(state.queue[ni]);
    advancingToId = f.toId;
    usePlayer.setState({ index: ni, position: pos, playing: true, error: null });
    advancingToId = null;
    // Volumes after the index update: the loudness gain is keyed by the current
    // track, and the engine-driven advance short-circuits the store subscription,
    // so this is the one place the new main's gain gets applied. The last fade
    // tick already left the elements at these levels — no jump.
    applyElementVolumes(1, 0);
    silenceAnalysing.delete(f.toId);
    const t = silenceTrims.get(f.toId);
    if (t && t.tail > 0) armSilenceTail(t.tail);
  } finally {
    settling = false;
    transitionToken += 1;
  }
  // A deck promoted after it already ran out would stall the queue: its
  // `ended` fired while it was still the standby and nothing re-arms it. Hand
  // straight to the normal end path so playback keeps moving.
  if (reason === "incoming-ended") onTrackEnded();
}

function abortFade(keepRoles: boolean): void {
  const f = fade;
  fade = null;
  armed = null;
  stopFadeTimer();
  // Invalidate any arming still awaiting its start — its continuation must
  // not wake up and start a deck for a track the user already moved past.
  transitionToken += 1;
  if (!f || !elements) return;
  const oldStandby = standbyEl();
  try {
    oldStandby.pause();
    oldStandby.removeAttribute("src");
    oldStandby.load();
  } catch {
    /* ignore */
  }
  if (!keepRoles) applyElementVolumes(1, 0);
}

/* ============================ casting ============================ */

type PlayerSnapshot = ReturnType<typeof usePlayer.getState>;
/** Set while a network player plays (lib/cast.ts): store changes go to it instead of the decks. */
let castFollower: ((state: PlayerSnapshot, prev: PlayerSnapshot) => void) | null = null;
/** The network player's clock as last reported. */
let castClock: { pos: number; at: number; running: boolean } | null = null;

/** The network player takes over: transitions end, the decks fall silent where they are. */
export function handOverToCast(follower: (state: PlayerSnapshot, prev: PlayerSnapshot) => void): void {
  castFollower = follower;
  castClock = null;
  // A load still on its way would start the song here, under the other side's.
  loadTurn += 1;
  loadingId = null;
  abortFade(false);
  stopPpRamp();
  flushAccum("pause");
  disarmSilenceTail();
  for (const e of elements ?? []) {
    try {
      e.pause();
    } catch {
      /* ignore */
    }
  }
}

/** Back from the network player: this computer plays on from the store's position. */
export function takeBackFromCast(): void {
  castFollower = null;
  castClock = null;
  const s = usePlayer.getState();
  const cur = s.queue[s.index];
  if (!cur || !elements) return;
  // The same listening, moved: the song isn't heard "again" (history, stats).
  const heard = historyForId;
  void loadTrack(cur, s.playing);
  historyForId = heard;
}

/** Where another device being followed stands: the clock only, what's heard there counts there. */
export function followClock(position: number, running: boolean): void {
  if (castFollower) castClock = { pos: position, at: performance.now(), running };
}

/**
 * What the network player reports, once a second: its clock (seek bar,
 * lyrics) and what was heard there — a song heard on the player counts in
 * the history and stats like one heard here.
 */
export function castHeard(trackId: string, position: number, playing: boolean): void {
  const s = usePlayer.getState();
  const cur = s.queue[s.index];
  if (!castFollower || !cur || cur.id !== trackId) return;
  const wasRunning = castClock?.running ?? false;
  castClock = { pos: position, at: performance.now(), running: playing };
  if (!playing) {
    flushAccum("pause");
    return;
  }
  if (historyForId !== cur.id) {
    flushAccum("stop");
    historyForId = cur.id;
    useLibrary.getState().pushHistory(cur);
    accum = { id: cur.id, playedMs: 0, pendingMs: 0, lastPos: position };
    emitPlayEvent("start", cur, position, 0, 0);
    return;
  }
  if (!wasRunning) emitPlayEvent("resume", cur, position, (accum?.playedMs ?? 0) / 1000, 0);
  accumulate(cur.id, position);
}

/**
 * The network player finished the song: the queue moves on as at a local end
 * (AutoPlay included). Repeat-one never gets here — lib/cast.ts replays the
 * song on the player itself.
 */
export function castTrackEnded(): void {
  const state = usePlayer.getState();
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd && state.repeat === "off" && useSettings.getState().autoplay) {
    void autoplayNext();
    return;
  }
  state.next(false);
}

/* ============================ skip silence ============================ */

let silenceTailTimer: number | null = null;

/* -------- listening telemetry (feeds stats, scrobblers, Discord) -------- */
const PROGRESS_EVERY_MS = 5000;
interface Accum {
  id: string;
  /** total listening time on this track (drives scrobble thresholds) */
  playedMs: number;
  /** listening time not yet reported (never double-counted on pause) */
  pendingMs: number;
  lastPos: number;
}
let accum: Accum | null = null;

/** Fold a span of element time into the accumulator; emit on 5s boundaries. */
function accumulate(trackId: string, nowPos: number): void {
  const state = usePlayer.getState();
  if (!state.playing) return;
  const track = state.queue[state.index];
  if (!track || track.id !== trackId) return;
  if (!accum || accum.id !== trackId) accum = { id: trackId, playedMs: 0, pendingMs: 0, lastPos: nowPos };
  const delta = nowPos - accum.lastPos;
  // Seeks backwards / element resets must not register as listening time.
  if (delta > 0 && delta < 2.5) {
    accum.playedMs += delta * 1000;
    accum.pendingMs += delta * 1000;
  }
  accum.lastPos = nowPos;
  if (accum.pendingMs >= PROGRESS_EVERY_MS) {
    emitPlayEvent("progress", track, nowPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
}

/** The current track stopped being heard — flush what it earned. */
function flushAccum(type: "stop" | "pause"): void {
  if (!accum) return;
  const track = usePlayer.getState().queue.find((t) => t.id === accum!.id) ?? null;
  if (track && accum.pendingMs >= 500) {
    emitPlayEvent(type, track, accum.lastPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
  if (type === "stop") accum = null;
}

function armSilenceTail(tailSec: number): void {
  disarmSilenceTail();
  const check = (): void => {
    // A paused element holds its position inside the tail zone — advancing
    // then would start the next track while the user asked for silence.
    if (!usePlayer.getState().playing) return;
    // A blend in flight owns the transition. Advancing here would land on the
    // track already fading in, tear the standby deck down and restart it from
    // zero — the same double-play the blend exists to prevent. The promoted
    // track re-arms its own tail when the blend completes.
    if (transitioning()) return;
    const cur = el();
    if (!Number.isFinite(cur.duration)) return;
    if (cur.currentTime >= cur.duration - tailSec - 0.05) {
      usePlayer.getState().next(false);
    }
  };
  silenceTailTimer = window.setInterval(check, 500);
  void check();
}

function disarmSilenceTail(): void {
  if (silenceTailTimer != null) {
    window.clearInterval(silenceTailTimer);
    silenceTailTimer = null;
  }
}

/** Request edge-silence analysis for the track that just started loading. */
function requestSilenceAnalysis(track: Track): void {
  const s = useSettings.getState();
  if (!s.skipSilence) return;
  if (silenceTrims.has(track.id) || silenceAnalysing.has(track.id)) return;
  if (!track.duration || track.duration < 10) return;
  if (!isLibraryTrack(track)) return;
  silenceAnalysing.add(track.id);
  void (async () => {
    try {
      // Decoded through the same proxy route (and copy) the element plays.
      const url = (await resolveLibrarySource(track))?.url ?? null;
      if (!url) return;
      const res = await fetch(url);
      if (!res.ok || !res.body) return;
      const buf = await res.arrayBuffer();
      const trims = await detectEdgeSilence(buf);
      if (trims && (trims.head > 0.05 || trims.tail > 0.05)) {
        setTrim(track.id, trims);
        const state = usePlayer.getState();
        const cur = state.queue[state.index];
        const a = el();
        // Apply the head trim if this track is still the one playing and just started.
        if (cur?.id === track.id && loadedId === track.id && a.currentTime < Math.max(0.6, trims.head)) {
          try {
            a.currentTime = trims.head;
          } catch {
            /* ignore */
          }
        }
        if (cur?.id === track.id && state.playing && trims.tail > 0) armSilenceTail(trims.tail);
      }
    } catch {
      /* analysis is best-effort */
    } finally {
      silenceAnalysing.delete(track.id);
    }
  })();
}

/* ============================ engine boot ============================ */

export function initAudioEngine(): void {
  if (elements) return;
  const mk = (): HTMLAudioElement => {
    const a = new Audio();
    a.preload = "auto";
    // CORS mode, so the EQ graph can read the proxy's audio: a no-cors
    // cross-origin source feeds Web Audio silence. The proxy answers
    // Access-Control-Allow-Origin: * on every route.
    a.crossOrigin = "anonymous";
    return a;
  };
  elements = [mk(), mk()];
  applyElementVolumes(1, 0);
  applySpeed();
  applySink();

  for (let i = 0; i < 2; i++) {
    const e = elements[i];
    // Only the session player's clock drives the tick: onTimeUpdate and
    // updateBuffered read the main element, so standby events would run them
    // against the wrong element twice per update.
    // While something else has the music (castFollower) the decks stand aside: whatever
    // they still report isn't about what plays, and a stream of theirs that dies is no broken song.
    const speaks = (): boolean => i === mainIdx && !castFollower;
    e.addEventListener("timeupdate", () => {
      if (speaks()) onTimeUpdate();
    });
    e.addEventListener("progress", () => {
      if (speaks()) updateBuffered();
    });
    e.addEventListener("waiting", () => {
      if (speaks()) usePlayer.getState()._setBuffering(true);
    });
    e.addEventListener("canplay", () => {
      if (speaks()) usePlayer.getState()._setBuffering(false);
    });
    e.addEventListener("playing", () => {
      if (eqCtx?.state === "suspended") void eqCtx.resume();
      if (!speaks()) return;
      usePlayer.getState()._setBuffering(false);
      consecutiveFailures = 0;
      localMissingToasted = false;
      unreachableToasted = false;
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (cur && historyForId !== cur.id) {
        historyForId = cur.id;
        useLibrary.getState().pushHistory(cur);
        accum = { id: cur.id, playedMs: 0, pendingMs: 0, lastPos: el().currentTime };
        emitPlayEvent("start", cur, el().currentTime, 0, 0);
      } else if (cur) {
        emitPlayEvent("resume", cur, el().currentTime, (accum?.playedMs ?? 0) / 1000, 0);
      }
    });
    // Errors and natural ends must be caught on BOTH elements: after a
    // crossfade the other element becomes the session player.
    e.addEventListener("error", () => {
      if (!speaks()) return;
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (!cur || loadedId !== cur.id) return;
      handleFailure(cur);
    });
    e.addEventListener("ended", () => {
      if (!speaks()) return;
      onTrackEnded();
    });
  }



  setQueueRanOut(() => void autoplayNext());

  usePlayer.subscribe((state, prev) => {
    if (!elements) return;
    // A network player has the music (lib/cast.ts): it follows the store, the decks stay silent.
    if (castFollower) {
      castFollower(state, prev);
      return;
    }
    const cur = state.queue[state.index] ?? null;
    const prevCur = prev.queue[prev.index] ?? null;

    if (cur?.id !== prevCur?.id) {
      if (advancingToId && cur && advancingToId === cur.id) {
        // Engine-driven advance: roles already swapped; nothing to load.
        return;
      }
      // A jump to the track that is already fading in is not a new track — it
      // is the transition being called early. `next()` from the outgoing
      // track resolves to exactly that track, so the skip would otherwise
      // tear down a deck the listener is already hearing and replay it from
      // the top. Promote it instead: it becomes active once, where it is.
      if (fade && cur && cur.id === fade.toId) {
        completeTransition("outgoing-ended");
        return;
      }
      // Anything else is the user (or a settings/queue change) steering to a
      // different track. That is a deliberate cancellation, not a completion:
      // tear the standby deck down so its half-heard track cannot go on
      // playing alongside the new one.
      abortFade(false);
      stopPpRamp();
      flushAccum("stop");
      void loadTrack(cur, state.playing);
      return;
    }

    if (fade) {
      // Manual interference during a fade: anything other than pure play-state
      // changes on the same track aborts the blend.
      if (state.seekNonce !== prev.seekNonce) abortFade(false);
    }

    if (state.queue !== prev.queue && cur && cur.id === prevCur?.id && state.position === 0 && prev.position > 3) {
      moveWithin(cur.id, 0);
    }

    if (state.playing !== prev.playing) {
      if (state.playing) {
        // Resuming mid-crossfade: shift the frozen fade timeline by the
        // paused span and bring the standby element back, so the blend
        // continues from where it froze instead of jumping to its end.
        const f = fade;
        if (f && f.pausedAt != null) {
          fade = { ...f, startTs: f.startTs + (performance.now() - f.pausedAt), pausedAt: null };
          const stand = standbyEl();
          if (stand.src) void stand.play().catch(() => undefined);
        }
        if (loadedId === cur?.id && el().src) {
          el().play().catch((err: unknown) => {
            // An aborted play() is a pause() or src change winning the race —
            // not a failure (see isAbortError).
            if (isAbortError(err)) return;
            handleFailure(cur, err);
          });
          // Spotify-style resume: the sound glides back in. Mid-crossfade the
          // blend owns the volumes — leave it alone.
          if (!fade) startPpRamp(1);
        } else if (cur) {
          stopPpRamp();
          // Already on its way, it looks at `playing` when it arrives. A second load would throw
          // away the place in the song and cut the first one's play() off.
          if (loadingId !== cur.id) void loadTrack(cur, true);
        }
      } else {
        flushAccum("pause");
        const f = fade;
        if (f) {
          stopPpRamp();
          el().pause();
          // Pausing holds both elements and freezes the blend: the fade
          // timeline stops with playback (pausedAt) and completes after
          // resume. Left running, the timer reached its end while paused and
          // finalizeFade force-resumed the next track over the pause.
          f.pausedAt = performance.now();
          standbyEl().pause();
          const t = Math.min(1, Math.max(0, (f.pausedAt - f.startTs) / f.durMs));
          const theta = t * (Math.PI / 2);
          applyElementVolumes(Math.cos(theta), Math.sin(theta));
        } else {
          // Spotify-style pause: glide to silence first; the ramp tick pauses
          // the element once it bottoms out (~PP_RAMP_MS later).
          startPpRamp(0);
        }
        if (state.position === 0 && state.duration === 0) disarmSilenceTail();
      }
    }

    refreshVolumes();

    if (state.seekNonce !== prev.seekNonce) {
      disarmSilenceTail();
      moveWithin(cur?.id, state.position);
      const t = cur ? silenceTrims.get(cur.id) : null;
      if (t && t.tail > 0 && state.playing) armSilenceTail(t.tail);
    }
  });

  // Playback speed lives in settings — re-apply whenever they change.
  useSettings.subscribe(() => applySpeed());
  // Same for the chosen output device.
  useSettings.subscribe(() => applySink());
  applyEq();
  useSettings.subscribe((st, prev) => {
    if (st.eqEnabled !== prev.eqEnabled || st.eqGains !== prev.eqGains || st.eqMode !== prev.eqMode || st.peq !== prev.peq) {
      applyEq();
    }
    // ReplayGain settings re-level the songs on both decks right away.
    if (st.replayGainMode !== prev.replayGainMode || st.replayGainTarget !== prev.replayGainTarget) {
      const state = usePlayer.getState();
      for (const t of [state.queue[state.index], state.queue[state.index + 1]]) {
        if (t && isLibraryTrack(t)) rememberGain(t.id, replayGainFor(state.sources[t.id] ?? t));
      }
      refreshVolumes();
    }
  });

  // A queue saved before a song's copies were merged — or filled from a list
  // holding both copies — keeps one copy of each song once the catalogue
  // knows them. The playing entry stays as it is, so nothing restarts.
  usePlayer.getState().collapseCopies();
  useCatalog.subscribe((s, prev) => {
    if (s.versions !== prev.versions) usePlayer.getState().collapseCopies();
  });

  setupMediaSession();
  setupAudioOutputWatch();
}

/** To a place in the song: now, or when the load on its way arrives. */
function moveWithin(trackId: string | undefined, position: number): void {
  if (trackId && loadingId === trackId) {
    pendingSeek = position;
    return;
  }
  try {
    el().currentTime = position;
  } catch {
    /* ignore */
  }
}

function onTrackEnded(): void {
  const state = usePlayer.getState();
  const current = state.queue[state.index] ?? null;
  // The user (or a fade) already chose the next track while this element was
  // finishing - its natural end must not advance the queue again.
  if (!current || loadedId !== current.id) return;
  // A blend owns this transition: the next track is already PLAYING on the
  // standby deck and its media clock is authoritative. This element reaching
  // its natural end IS the transition completing, so promote that deck.
  //
  // Advancing the queue here instead re-entered the fresh-track path — it
  // reloaded the very track the listener is already hearing, on the deck that
  // had just been demoted, and restarted it at 0:00. That is the audible
  // "Auto Mix plays the first seconds of the next song twice" bug.
  if (fade && fade.fromId === current.id) {
    completeTransition("outgoing-ended");
    return;
  }
  if (state.repeat === "one") {
    const a = el();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
    return;
  }
  // Queue exhausted with repeat off: keep the music going if the user has
  // AutoPlay on by pulling one more suggestion into the queue.
  const atEnd = state.index >= state.queue.length - 1;
  if (atEnd && state.repeat === "off" && useSettings.getState().autoplay) {
    void autoplayNext();
    return;
  }
  state.next(false);
  // Repeat came round to this very song — a single on repeat, or a queue that
  // starts with the song it ends on. The same song loads nothing new and the
  // finished element stays paused at its end, so it starts over here, as
  // repeat-one does.
  const after = usePlayer.getState();
  if (after.playing && after.queue[after.index]?.id === current.id) {
    const a = el();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
  }
}

/** Guards against overlapping AutoPlay fetches when tracks end back-to-back. */
let autoplaying = false;

/**
 * AutoPlay: the queue ran out, so pick a song from the user's own library
 * (local files + Jellyfin) that this session hasn't played yet, append it
 * and jump straight to it.
 */
async function autoplayNext(): Promise<void> {
  if (autoplaying) return;
  autoplaying = true;
  try {
    // The catalogue lists every song once (duplicates merged); only songs that can play right now.
    const catalog = useCatalog.getState();
    const pool = (catalog.loaded ? catalog.tracks : await loadAllLibraryTracks()).filter((t) => trackAvailable(t));
    const state = usePlayer.getState();
    // Never append a track the queue already holds. "Don't repeat
    // suggestions" additionally keeps everything from recent history out.
    // By song, not by copy: a song queued as its Jellyfin copy is the same song as its local file.
    const heard = new Set(state.queue.map((t) => songKey(t.id)));
    if (useSettings.getState().dontRepeatSuggestions) {
      for (const t of useLibrary.getState().history) heard.add(songKey(t.id));
    }
    const fresh = pool.filter((t) => !heard.has(songKey(t.id)));
    const from = fresh.length ? fresh : pool;
    const pick = from[Math.floor(Math.random() * from.length)];
    if (!pick) {
      usePlayer.setState({ playing: false });
      return;
    }
    state.addToQueue(pick);
    usePlayer.setState({
      index: usePlayer.getState().queue.length - 1,
      playing: true,
      position: 0,
      error: null,
    });
  } catch {
    usePlayer.setState({ playing: false });
  } finally {
    autoplaying = false;
  }
}

/** Called once after persisted state has been rehydrated. */
export function engineBoot(): void {
  initAudioEngine();
  const state = usePlayer.getState();
  const cur = state.queue[state.index] ?? null;
  if (cur) void loadTrack(cur, false);
}

async function loadTrack(track: Track | null, autoplay: boolean): Promise<void> {
  if (!elements) return;
  disarmSilenceTail();
  // A fresh load is a new playback session: any arming still waiting on a
  // start belongs to the previous track and must not fire.
  transitionToken += 1;
  if (!track) {
    loadTurn += 1;
    loadingId = null;
    loadedId = null;
    historyForId = null;
    el().pause();
    el().removeAttribute("src");
    el().load();
    usePlayer.setState({ position: 0, duration: 0, buffered: 0, buffering: false, error: null });
    updateMediaSession(null);
    return;
  }
  loadedId = null;
  historyForId = null;
  retryCount = 0;
  failedVersions.clear();
  pendingSeek = usePlayer.getState().position;
  // The place in the song stands until the element has it: others read it from here meanwhile.
  usePlayer.setState({
    buffering: true,
    position: pendingSeek,
    error: null,
    duration: track.duration || 0,
  });
  requestSilenceAnalysis(track);
  await loadUrl(track, autoplay);
}

async function loadUrl(track: Track, autoplay: boolean): Promise<void> {
  if (!elements) return;
  const turn = ++loadTurn;
  loadingId = track.id;
  try {
    // A song from before this was a local player: it has no place to play from.
    if (!isLibraryTrack(track)) throw new LibrarySourceError("missing");
    // Local files stream through the main-process proxy (a file:// src is
    // blocked from the http renderer origin). Always resolve fresh — the
    // proxy port changes between launches, so cached URLs would go stale,
    // and the IPC lookup is a local roundtrip. A song found in several
    // places plays its local file first, a server stream when that's away.
    const found = await resolveLibrarySource(track, failedVersions);
    if (turn !== loadTurn) return; // another load took over while we were resolving
    if (!found) throw await librarySourceError(track);
    const { url: src, version } = found;
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id) return; // user moved on while we were resolving
    const a = el();
    usePlayer.getState()._setSource(track.id, version);
    // Songs are levelled by ReplayGain (when tagged and enabled); otherwise
    // they play at their original level.
    rememberGain(track.id, replayGainFor(version));
    // Apply immediately: without this the element keeps the PREVIOUS track's gain.
    refreshVolumes();
    a.src = src;
    loadedId = track.id;
    loadingId = null;
    const trim = silenceTrims.get(track.id);
    if (pendingSeek > 0) {
      try {
        a.currentTime = pendingSeek;
      } catch {
        /* ignore */
      }
      pendingSeek = 0;
    } else if (trim && trim.head > 0.05) {
      try {
        a.currentTime = trim.head;
      } catch {
        /* ignore */
      }
    }
    applySpeed();
    updateMediaSession(track);
    if (autoplay || usePlayer.getState().playing) {
      await a.play();
    } else {
      usePlayer.setState({ buffering: false });
    }
    const t = silenceTrims.get(track.id);
    if (t && t.tail > 0 && usePlayer.getState().playing) armSilenceTail(t.tail);
  } catch (err) {
    // Overtaken by a newer load: what happens now is that one's business.
    if (turn !== loadTurn) return;
    loadingId = null;
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id) return;
    // A pause or a new source won the race with play(): nothing is wrong with the song.
    if (isAbortError(err)) {
      usePlayer.setState({ buffering: false });
      return;
    }
    handleFailure(track, err);
  }
}

/**
 * Why a library song produced no stream URL: "missing" | "ffmpeg-missing" |
 * "transcode-failed" (its local file), or "unreachable" — no copy can be
 * reached right now (the folder's drive is away, the server doesn't answer).
 */
class LibrarySourceError extends Error {
  constructor(readonly reason: string) {
    super(`library source unavailable: ${reason}`);
  }
}

async function librarySourceError(track: Track): Promise<LibrarySourceError> {
  const versions = versionsOf(track);
  const local = versions.find((v) => sourceOf(v) === "local");
  if (local && versionAvailable(local)) {
    const reason = (await requireBridge().localTrackError(local.id).catch(() => null)) ?? "missing";
    // A conversion problem says the most; a vanished file only when no server copy could stand in.
    if (reason !== "missing" || versions.length === 1) return new LibrarySourceError(reason);
  }
  return new LibrarySourceError("unreachable");
}

function handleFailure(track: Track, err?: unknown): void {
  const state = usePlayer.getState();
  if (state.queue[state.index]?.id !== track.id) return;
  usePlayer.setState({ buffering: false });
  // A failure while paused must never force playback: the retry used to load
  // with autoplay=true and start audio the user had stopped (also the landing
  // spot for play() promises aborted by an immediate pause). The next play
  // re-attempts the load from the top.
  if (!state.playing) return;
  const reason = err instanceof LibrarySourceError ? err.reason : null;
  if (isLibraryTrack(track)) {
    // Something may have gone away (drive unplugged, server down): look
    // again, so the lists grey it out.
    void useAvailability.getState().refresh();
    // The copy that failed sits out the rest of this play while another
    // copy of the song gets its turn (a server stream for a broken file).
    const playingFrom = state.sources[track.id];
    if (!reason && playingFrom && loadedId === track.id) {
      const tried = new Set([...failedVersions, playingFrom.id]);
      if (playableVersions(track, tried).length) {
        failedVersions.add(playingFrom.id);
        // The failed source says nothing more; `playing` decides when the new one is there.
        loadedId = null;
        void loadUrl(track, false);
        return;
      }
    }
  }
  if (retryCount < 1 && reason !== "unreachable") {
    retryCount += 1;
    loadedId = null;
    void loadUrl(track, false);
    return;
  }
  consecutiveFailures += 1;
  // A local: track that resolves to nothing means the file's folder is gone
  // from the library — a data reset, or the drive is away. The entries
  // survive in synced playlists, and re-importing the
  // folder relinks them (ids are hashes of the file's absolute path).
  const isLocal = !!track.localPath || track.id.startsWith("local:");
  const ext = (track.localPath?.split(".").pop() ?? "").toUpperCase();
  const localGoneMsg =
    reason === "ffmpeg-missing"
      ? T('"{title}" is a {ext} file — playing it needs FFmpeg. Install it (for example with "winget install ffmpeg"), then play it again.', { title: track.title, ext })
      : reason === "transcode-failed"
        ? T('Couldn\'t convert "{title}" for playback — the file may be damaged.', { title: track.title })
        : T('Couldn\'t play "{title}" — its local file can\'t be reached on this device. Re-add the folder in Local Music to relink your songs.', { title: track.title });
  const unreachableMsg = T('"{title}" can\'t be reached right now — its drive or server is away.', { title: track.title });
  if (state.playing && consecutiveFailures <= MAX_SKIPS) {
    console.warn(`[bytune] playback failed for ${track.id}`, err);
    if (reason === "unreachable") {
      // One note per streak: a queue full of away songs must not stack toasts.
      if (!unreachableToasted) {
        unreachableToasted = true;
        useUI.getState().toast(T("{unreachableMsg} Skipping what can't play.", { unreachableMsg }), "warning", 6000);
      }
    } else if (isLocal) {
      // One explainer per failing streak — a whole playlist of unlinked
      // locals must not stack five identical toasts.
      if (!localMissingToasted) {
        localMissingToasted = true;
        useUI.getState().toast(localGoneMsg, "warning", 7000);
      }
    } else {
      useUI.getState().toast(T("Couldn't play \"{title}\" — skipping", { title: track.title }), "error");
    }
    state.next(false);
  } else {
    usePlayer.setState({ playing: false, error: T("Playback failed") });
    if (reason === "unreachable") {
      unreachableToasted = false;
      useUI.getState().toast(unreachableMsg, "warning", 6000);
    } else if (isLocal) {
      localMissingToasted = false;
      useUI.getState().toast(localGoneMsg, "warning", 7000);
    } else {
      useUI.getState().toast(T("Couldn't play \"{title}\"", { title: track.title }), "error");
    }
  }
}

/* ------------------------- MediaSession ------------------------- */

let lastPositionState = 0;

function updateMediaSession(track: Track | null): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || "Songsta",
      artwork: [96, 192, 512].map((size) => ({
        src: upgradeArtwork(track.thumb),
        sizes: `${size}x${size}`,
        type: "image/jpeg",
      })),
    });
  } catch {
    /* ignore */
  }
}

function syncPositionState(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const a = el();
  if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
  // Throttle: SMTC only needs coarse updates.
  if (Math.abs(a.currentTime - lastPositionState) < 0.75) return;
  lastPositionState = a.currentTime;
  try {
    navigator.mediaSession.setPositionState({
      duration: a.duration,
      playbackRate: a.playbackRate || 1,
      position: Math.min(a.currentTime, a.duration),
    });
  } catch {
    /* ignore */
  }
}

function setupMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const set = (name: MediaSessionAction, fn: MediaSessionActionHandler): void => {
    try {
      ms.setActionHandler(name, fn);
    } catch {
      /* unsupported action */
    }
  };
  // Physical media play/pause buttons (headset middle buttons, BT AVRCP, the
  // Windows media flyout) all arrive here as absolute play/pause actions —
  // there is no native double-press event, so repeated presses are recognized
  // as next-track at this layer (see media-key-tap.ts). The pressed command
  // is replayed rather than a toggle: the player's state may have moved
  // during the recognition window, and a stale absolute command is a no-op
  // against it while a toggle would fight it.
  const tap = createMediaKeyTap(
    {
      schedule: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
    },
    {
      single: (kind) => usePlayer.getState().setPlaying(kind === "play"),
      multi: () => usePlayer.getState().next(true),
    },
  );
  set("play", () => tap.press("play"));
  set("pause", () => tap.press("pause"));
  // A pending single press belongs to the pre-skip context; applying it after
  // the user already moved (or seeked) elsewhere would stop what they chose.
  set("previoustrack", () => {
    tap.cancelPending();
    usePlayer.getState().prev();
  });
  set("nexttrack", () => {
    tap.cancelPending();
    usePlayer.getState().next(true);
  });
  set("seekbackward", () => {
    tap.cancelPending();
    const s = usePlayer.getState();
    s.seek(Math.max(0, s.position - 10));
  });
  set("seekforward", () => {
    tap.cancelPending();
    const s = usePlayer.getState();
    s.seek(s.position + 10);
  });
  set("seekto", (details) => {
    tap.cancelPending();
    if (details.seekTime != null) usePlayer.getState().seek(details.seekTime);
  });
  window.setInterval(syncPositionState, 1000);
}

/**
 * Pause when the output the listener is hearing disappears.
 *
 * Chromium re-routes live audio to the new Windows default endpoint on its
 * own — that's why audio used to fall back to the PC speakers when a
 * headset was unplugged mid-song. There is no removal event; `devicechange`
 * fires and enumeration tells us whether the previous default's backing
 * device is still connected (the logic lives in audio-output.ts). Every
 * other case — connecting a device, intentional switching while both stay
 * alive, an unrelated microphone leaving — leaves the old default's group
 * in the list and playback untouched.
 *
 * The pause goes through setPlaying(false): the same path as the UI button,
 * so an in-flight crossfade freezes cleanly with it and resume stays valid.
 */
function setupAudioOutputWatch(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  const md = navigator.mediaDevices;
  let prev: OutputSnapshot | null = null;
  let running = false;
  let rerun = false;
  const refresh = async (): Promise<void> => {
    // Serialize: overlapping enumerations could apply an older view last.
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        // "The output the listener is hearing" is the user's chosen sink when
        // one is set, else the system default — see snapshotOutputs.
        const sink = useSettings.getState().audioSinkId;
        const snap = snapshotOutputs(await md.enumerateDevices(), sink);
        // Playing is read after the await — it may have moved while enumerating.
        if (outputChangeAction(prev, snap, usePlayer.getState().playing, sink) === "pause") {
          usePlayer.getState().setPlaying(false);
          if (sink) {
            // The chosen device is gone; fall back to the system default so
            // the next resume is audible instead of routing into the void.
            useSettings.getState().setAudioSinkId("");
          }
        }
        // Re-assert the chosen sink after any device-list change — Windows
        // hands a reconnecting Bluetooth device a NEW endpoint id, which
        // quietly invalidates the previously-applied sink.
        applySink();
        prev = snap;
      } while (rerun);
    } catch {
      /* enumeration is best-effort; keep the last snapshot */
    } finally {
      running = false;
    }
  };
  md.addEventListener("devicechange", () => void refresh());
  void refresh();
}
