/**
 * Songs that run on: the next track of the same album when that album is one
 * that runs on by nature — a live recording, a DJ or continuous mix — or
 * when the two measurably meet sounding (the sound analysis: this one ends
 * loud without silence, the next starts loud). Such a pair plays seamlessly,
 * never with a crossfade or a gap (audio.ts, Settings → Playback → Seamless
 * albums).
 */
import type { Track } from "../types";
import { albumKeyOf } from "./libraryTracks";

/** The ends of a song, from the sound analysis. */
export interface SongEdges {
  introSilence: number;
  outroSilence: number;
  headDb: number;
  tailDb: number;
  /** measured from a stretch in the middle (a server song): its ends are not known */
  excerpt?: boolean;
}

/** Louder than this at the very start or end, a song is sounding there. */
const SOUNDING_DB = -30;
/** Shorter than this, silence at an end doesn't count as a pause. */
const BRIEF_SILENCE_S = 0.3;

const LIVE_TITLE = /\b(live|unplugged|in concert|mixed by|dj[- ]?mix|continuous mix|nonstop|non-stop)\b/i;
const LIVE_TYPE = /\b(live|dj-?mix|mixtape|continuous)\b/i;

/** An album that runs on from song to song by nature: live, a DJ or continuous mix. */
export function runsOnByNature(track: Track): boolean {
  return LIVE_TYPE.test(track.releaseType ?? "") || LIVE_TITLE.test(track.album ?? "");
}

/** `next` is the song after `cur` on the same album (the next disc's first, too). */
export function followsOnAlbum(cur: Track, next: Track): boolean {
  const key = albumKeyOf(cur);
  if (!key || key !== albumKeyOf(next) || !cur.trackNo || !next.trackNo) return false;
  const curDisc = cur.discNo ?? 1;
  const nextDisc = next.discNo ?? 1;
  if (nextDisc === curDisc) return next.trackNo === cur.trackNo + 1;
  return nextDisc === curDisc + 1 && next.trackNo === 1;
}

/** Whether `next` runs on from `cur`: seamless, never crossfaded. */
export function runsOn(cur: Track, next: Track, edges: { cur?: SongEdges; next?: SongEdges } = {}): boolean {
  if (!followsOnAlbum(cur, next)) return false;
  if (runsOnByNature(cur)) return true;
  const a = edges.cur;
  const b = edges.next;
  if (a?.excerpt || b?.excerpt) return false;
  return !!a && !!b && a.tailDb > SOUNDING_DB && a.outroSilence < BRIEF_SILENCE_S && b.headDb > SOUNDING_DB && b.introSilence < BRIEF_SILENCE_S;
}
