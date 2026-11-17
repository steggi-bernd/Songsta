/** When leaving a song counts as skipping it, and how a skip fades (stores/skips.ts). Pure, for tests. */

const EARLY_MS = 30_000;
const HALF_LIFE_MS = 90 * 86_400_000;

/** A song's skips as they count now: each one fading by half every 90 days. */
export function skipWeight(entry: { n: number; at: number } | undefined, now: number): number {
  if (!entry) return 0;
  return entry.n * Math.pow(0.5, Math.max(0, now - entry.at) / HALF_LIFE_MS);
}

/** Leaving a song after this long counts as a skip: within the first half minute and before its half. */
export const isEarlySkip = (playedMs: number, durationS: number): boolean => playedMs < EARLY_MS && (!durationS || playedMs < (durationS * 1000) / 2);
