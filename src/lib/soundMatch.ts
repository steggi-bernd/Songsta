/**
 * Klingt wie (views/SoundsLikeView.tsx): the songs that sound like one song, by what the sound analysis
 * measured (electron/sound-analysis.ts): tempo, key and energy. Pure, for tests.
 *
 *  - Tempo: within a window of beats per minute; half and double time count too (a 92 BPM song
 *    fits one at 184), since that's how they play together.
 *  - Key: by the Camelot wheel DJs use: the same key, or its neighbours (one step round the wheel,
 *    or the same number in the other ring: the relative major or minor).
 *  - Energy: calm to driving, 0 to 1.
 */
import type { SoundFacts } from "../../electron/sound-analysis";
import { keyName } from "../../electron/sound-analysis";
import { currentLanguage } from "./i18n";

/** The notes as German says them: English B is H there, and B is B♭. */
const GERMAN_NOTES = ["C", "Cis", "D", "Es", "E", "F", "Fis", "G", "As", "A", "B", "H"];

/** A key as the app's language says it: "A minor", "B major"; in German "a-Moll", "H-Dur". */
export function keyLabel(key: number, minor: boolean): string {
  if (!(key >= 0 && key < 12)) return "";
  if (currentLanguage() === "de") {
    const note = GERMAN_NOTES[key];
    return minor ? `${note.toLowerCase()}-Moll` : `${note}-Dur`;
  }
  return keyName(key, minor);
}

export interface Camelot {
  /** 1 to 12 round the wheel */
  n: number;
  /** A minor, B major */
  ring: "A" | "B";
}

/** A key on the Camelot wheel: C major is 8B, A minor 8A; null for no clear key. */
export function camelotOf(key: number, minor: boolean): Camelot | null {
  if (key < 0 || key > 11) return null;
  // Minor keys sit with their relative major, three semitones up.
  const tonic = minor ? (key + 3) % 12 : key;
  return { n: ((tonic * 7 + 7) % 12) + 1, ring: minor ? "A" : "B" };
}

export const camelotLabel = (c: Camelot): string => `${c.n}${c.ring}`;

/** The key a place on the wheel stands for (camelotOf the other way round): 8B is C major, 8A A minor. */
export function keyOfCamelot(c: Camelot): { key: number; minor: boolean } {
  // 7 is its own inverse modulo 12: n = 7·tonic + 8 (mod 12) gives tonic = 7·(n − 8).
  const tonic = (((7 * (c.n - 8)) % 12) + 12) % 12;
  return c.ring === "B" ? { key: tonic, minor: false } : { key: (tonic + 9) % 12, minor: true };
}

/** Two places on the wheel are the same. */
export const sameCamelot = (a: Camelot | null | undefined, b: Camelot | null | undefined): boolean => !!a && !!b && a.n === b.n && a.ring === b.ring;

/**
 * Songs to hear a key by, when Klingt wie's wheel turns to it: the library's songs measured in just that
 * key, the most played first so the ones you know come up, each artist once before any comes twice.
 */
export function songsInKey<T extends { id: string; artist?: string }>(
  tracks: readonly T[],
  soundOf: (t: T) => { key: number; minor: boolean } | undefined,
  key: Camelot,
  playsOf: (t: T) => number,
  count = 3,
  skip?: (t: T) => boolean
): T[] {
  const inKey: { t: T; plays: number }[] = [];
  for (const t of tracks) {
    if (skip?.(t)) continue;
    const f = soundOf(t);
    if (f && sameCamelot(camelotOf(f.key, f.minor), key)) inKey.push({ t, plays: playsOf(t) });
  }
  inKey.sort((a, b) => b.plays - a.plays);
  const picked: T[] = [];
  const artists = new Set<string>();
  for (const { t } of inKey) {
    const artist = (t.artist ?? "").toLowerCase();
    if (picked.length < count && !artists.has(artist)) {
      picked.push(t);
      artists.add(artist);
    }
  }
  for (const { t } of inKey) if (picked.length < count && !picked.includes(t)) picked.push(t);
  return picked;
}

/** 0 the same key, 1 a neighbour on the wheel, 2 anything further. */
export function keyStep(a: Camelot, b: Camelot): 0 | 1 | 2 {
  if (a.n === b.n && a.ring === b.ring) return 0;
  if (a.n === b.n) return 1;
  const round = Math.min((a.n - b.n + 12) % 12, (b.n - a.n + 12) % 12);
  return a.ring === b.ring && round === 1 ? 1 : 2;
}

/** How far two tempos are apart in BPM, half and double time counted as the same when asked. */
export function tempoGap(a: number, b: number, halfAndDouble: boolean): number {
  if (!a || !b) return Infinity;
  const direct = Math.abs(a - b);
  if (!halfAndDouble) return direct;
  return Math.min(direct, Math.abs(a - b * 2), Math.abs(a * 2 - b));
}

export type MatchMode = "tempo" | "key" | "both" | "energy";
export type KeyRule = "same" | "near" | "any";
export type EnergyRule = "any" | "calmer" | "similar" | "lift";

export interface MatchOptions {
  mode: MatchMode;
  /** ± BPM */
  window: number;
  halfAndDouble: boolean;
  keyRule: KeyRule;
  energy: EnergyRule;
}

export const DEFAULT_MATCH: MatchOptions = { mode: "both", window: 4, halfAndDouble: true, keyRule: "near", energy: "any" };

export interface MatchResult {
  /** 0 to 1 */
  score: number;
  /** the tempo difference as shown: "+2", "−3", "±0", "½ time", "2× time" */
  tempoNote: string;
  keyStep: 0 | 1 | 2;
}

const usable = (f: SoundFacts | undefined): f is SoundFacts => !!f && f.loudness > -70;

/**
 * How well a song sounds like the seed under these options; null when it doesn't fit at all. Each
 * part counts only where the mode asks for it; energy also tips the order a little.
 */
export function matchSong(seed: SoundFacts, other: SoundFacts | undefined, o: MatchOptions): MatchResult | null {
  if (!usable(other)) return null;
  const wantsTempo = o.mode === "tempo" || o.mode === "both";
  const wantsKey = o.mode === "key" || o.mode === "both";
  const parts: number[] = [];

  let tempoNote = "";
  if (seed.bpm && other.bpm) {
    const direct = Math.abs(seed.bpm - other.bpm);
    const gap = tempoGap(seed.bpm, other.bpm, o.halfAndDouble);
    const delta = Math.round(other.bpm - seed.bpm);
    tempoNote = gap < direct ? (other.bpm > seed.bpm ? "2×" : "½") : delta === 0 ? "±0" : delta > 0 ? `+${delta}` : `−${-delta}`;
    if (wantsTempo) {
      if (gap > o.window) return null;
      parts.push(1 - (gap / Math.max(1, o.window)) * 0.5);
    }
  } else if (wantsTempo) return null;

  const a = camelotOf(seed.key, seed.minor);
  const b = camelotOf(other.key, other.minor);
  const step = a && b ? keyStep(a, b) : 2;
  if (wantsKey) {
    if (!a || !b) return null;
    if (o.keyRule === "same" && step !== 0) return null;
    if (o.keyRule === "near" && step === 2) return null;
    parts.push(step === 0 ? 1 : step === 1 ? 0.85 : 0.6);
  }

  const lift = other.energy - seed.energy;
  if (o.energy === "calmer" && lift > -0.05) return null;
  if (o.energy === "lift" && lift < 0.05) return null;
  if (o.energy === "similar" && Math.abs(lift) > 0.12) return null;
  if (o.mode === "energy") {
    if (Math.abs(lift) > 0.15 && o.energy !== "calmer" && o.energy !== "lift") return null;
    parts.push(1 - Math.min(1, Math.abs(lift) / 0.3));
  }
  // Closer in energy sorts first among equals.
  const closeness = 1 - Math.min(1, Math.abs(lift));
  const base = parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : closeness;
  return { score: Math.max(0, Math.min(1, base * 0.9 + closeness * 0.1)), tempoNote, keyStep: step };
}

export interface MixRule {
  id: "late" | "run" | "focus" | "sunlit" | "key";
  /** does a song fit */
  fits(f: SoundFacts): boolean;
}

/** The mixes made from how songs sound; "key" is the seed's key and its neighbours. */
export function mixRules(seed: SoundFacts | null): MixRule[] {
  const rules: MixRule[] = [
    { id: "late", fits: (f) => f.minor && f.energy < 0.45 && within(f.bpm, 70, 95) },
    { id: "run", fits: (f) => f.energy > 0.6 && (within(f.bpm, 150, 178) || within(f.bpm * 2, 150, 178)) },
    { id: "focus", fits: (f) => f.energy < 0.45 && within(f.bpm, 100, 122) },
    { id: "sunlit", fits: (f) => !f.minor && f.key >= 0 && f.energy > 0.5 },
  ];
  const c = seed ? camelotOf(seed.key, seed.minor) : null;
  if (c) rules.push({ id: "key", fits: (f) => !!camelotOf(f.key, f.minor) && keyStep(c, camelotOf(f.key, f.minor) as Camelot) < 2 });
  return rules.map((r) => ({ ...r, fits: (f: SoundFacts) => usable(f) && r.fits(f) }));
}

const within = (bpm: number, low: number, high: number): boolean => bpm >= low && bpm <= high;
