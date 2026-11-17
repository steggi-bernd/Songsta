/**
 * Mixes that flow (the user's wish for better playlists, 2026-11-15): songs in the order a DJ would
 * play them, by what the sound analysis measured (electron/sound-analysis.ts):
 *
 *  - the next song close on the Camelot wheel (the same key, or a neighbour: lib/soundMatch.ts);
 *  - the tempo moving by little (half and double time count as close);
 *  - the energy following an arc: rising to a peak about two thirds in, easing off at the end; or,
 *    without the arc, staying near the song before;
 *  - variety: an artist not twice in a row, and seldom within a few songs; songs skipped lately later.
 *
 * Greedy: from the first song, always the cheapest next one. Songs the analysis hasn't measured keep
 * their order behind the measured ones, still kept apart by artist. Pure, for tests.
 */
import type { SoundFacts } from "../../electron/sound-analysis";
import { camelotOf, keyStep, tempoGap, type Camelot } from "./soundMatch";

export interface FlowSong<T> {
  item: T;
  /** what the analysis measured; none for a song not measured yet */
  facts?: SoundFacts;
  artist: string;
  /** how much it was skipped lately (stores/skips.ts): such songs come later */
  skips?: number;
}

export interface FlowOptions<T> {
  /** the song to begin with, if any */
  first?: T;
  /** rise to a peak and ease off (a mix), else stay near the song before (more like this) */
  arc?: boolean;
}

const usable = (f: SoundFacts | undefined): f is SoundFacts => !!f && f.loudness > -70;

function quantile(values: number[], q: number): number {
  if (!values.length) return 0.5;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** A measured song with what the comparisons need worked out once (they run for every pair). */
interface Prepared<T> {
  song: FlowSong<T>;
  facts: SoundFacts;
  camelot: Camelot | null;
  artist: string;
}

const prepare = <T>(s: FlowSong<T>): Prepared<T> => {
  const facts = s.facts as SoundFacts;
  return { song: s, facts, camelot: camelotOf(facts.key, facts.minor), artist: s.artist.toLowerCase() };
};

/** How far a song is from the one before: key, tempo, energy against where the mix should be, and the artist. */
function stepCost(prev: Prepared<unknown> | null, next: Prepared<unknown>, targetEnergy: number, recentArtists: string[]): number {
  const f = next.facts;
  let cost = Math.abs(f.energy - targetEnergy) * 4;
  if (prev) {
    cost += prev.camelot && next.camelot ? [0, 1, 3][keyStep(prev.camelot, next.camelot)] : 2;
    const gap = tempoGap(prev.facts.bpm, f.bpm, true);
    cost += Number.isFinite(gap) ? Math.min(4, gap / 6) : 2;
  }
  if (recentArtists[recentArtists.length - 1] === next.artist) cost += 6;
  else if (recentArtists.includes(next.artist)) cost += 2.5;
  return cost + Math.min(4, (next.song.skips ?? 0) * 1.5);
}

/** Unmeasured songs in their order, an artist not twice in a row where another can come between. */
export function apartByArtist<T>(songs: FlowSong<T>[], lastArtist = ""): FlowSong<T>[] {
  const rest = [...songs];
  const out: FlowSong<T>[] = [];
  let last = lastArtist.toLowerCase();
  while (rest.length) {
    const at = rest.findIndex((s) => s.artist.toLowerCase() !== last);
    const [next] = rest.splice(at === -1 ? 0 : at, 1);
    out.push(next);
    last = next.artist.toLowerCase();
  }
  return out;
}

/** The songs in an order that flows (see above). */
export function flowOrder<T>(songs: FlowSong<T>[], options: FlowOptions<T> = {}): T[] {
  const measured = songs.filter((s) => usable(s.facts)).map((s) => prepare(s));
  const unmeasured = songs.filter((s) => !usable(s.facts));
  const energies = measured.map((s) => s.facts.energy);
  const low = quantile(energies, 0.3);
  const peak = quantile(energies, 0.9);
  const out: Prepared<T>[] = [];
  const rest = [...measured];

  // The first: the one asked for, else for an arc a calm one, else the first given.
  let firstAt = options.first !== undefined ? rest.findIndex((s) => s.song.item === options.first) : -1;
  if (firstAt === -1 && options.arc && rest.length) {
    firstAt = rest.reduce((best, s, i) => (Math.abs(s.facts.energy - low) < Math.abs(rest[best].facts.energy - low) ? i : best), 0);
  }
  if (firstAt === -1 && rest.length) firstAt = 0;
  if (firstAt !== -1) out.push(...rest.splice(firstAt, 1));

  const total = measured.length;
  while (rest.length) {
    const prev = out[out.length - 1] ?? null;
    const i = out.length;
    let target: number;
    if (options.arc) {
      const climb = Math.max(1, Math.round(total * 0.65));
      target = i <= climb ? low + (peak - low) * (i / climb) : peak - ((peak - low) / 2) * ((i - climb) / Math.max(1, total - climb));
    } else target = prev ? prev.facts.energy : low;
    const recent = out.slice(-4).map((s) => s.artist);
    let best = 0;
    let bestCost = Infinity;
    for (let k = 0; k < rest.length; k++) {
      const cost = stepCost(prev, rest[k], target, recent);
      if (cost < bestCost) {
        bestCost = cost;
        best = k;
      }
    }
    out.push(...rest.splice(best, 1));
  }
  // A first song asked for that wasn't measured still comes first.
  const firstUnmeasured = options.first !== undefined ? unmeasured.findIndex((s) => s.item === options.first) : -1;
  const lead = firstUnmeasured !== -1 ? unmeasured.splice(firstUnmeasured, 1) : [];
  const ordered = out.map((s) => s.song);
  return [...lead, ...ordered, ...apartByArtist(unmeasured, ordered[ordered.length - 1]?.artist ?? "")].map((s) => s.item);
}
