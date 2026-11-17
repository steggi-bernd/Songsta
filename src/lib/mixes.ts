/**
 * Mixes built from the user's own library (Symfonium's "mixes", Spotify's
 * "Made for you"): one per big genre and decade, "On repeat" (most played),
 * "Rediscover" (never played yet) and one for this time of day and week
 * ("Sunday Evening", from the listening history). Each mix is shuffled with a
 * seed of its id + today's date, so it stays put through the day and changes
 * daily. Where the songs are measured (the sound analysis), the day's pick plays
 * in an order that flows (lib/flowOrder.ts): close in key and tempo, the energy
 * rising and easing off, an artist not twice in a row.
 */
import type { SoundFacts } from "../../electron/sound-analysis";
import type { Track } from "../types";
import { decadeOf, genresOf, type PlayCounts } from "./catalogBuild";
import { flowOrder } from "./flowOrder";
import { T } from "./i18n";

export interface Mix {
  id: string;
  title: string;
  subtitle: string;
  tracks: Track[];
}

const MIX_SIZE = 50;
const MIN_TRACKS = 8;

function seededShuffle<T>(items: T[], seedText: string): T[] {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i++) seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619);
  const rand = (): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Today, as the clock on the wall says it: the mixes change at midnight here, not at midnight in London. */
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

function make(id: string, title: string, subtitle: string, pool: Track[]): Mix {
  return { id, title, subtitle, tracks: seededShuffle(pool, `${id}|${today()}`).slice(0, MIX_SIZE) };
}

/** `genres`: a song's genres as the library shows them (lib/albumGenres.ts genresOfTrack), so a genre's mix holds its page's songs; its own tags without. */
export function genreMixes(tracks: Track[], limit = 8, genres: (t: Track) => string[] = genresOf): Mix[] {
  const byGenre = new Map<string, { name: string; tracks: Track[] }>();
  for (const t of tracks) {
    for (const g of genres(t)) {
      const key = g.toLowerCase();
      const cur = byGenre.get(key) ?? { name: g, tracks: [] };
      cur.tracks.push(t);
      byGenre.set(key, cur);
    }
  }
  return [...byGenre.entries()]
    .filter(([, v]) => v.tracks.length >= MIN_TRACKS)
    .sort((a, b) => b[1].tracks.length - a[1].tracks.length)
    .slice(0, limit)
    .map(([key, v]) => make(`genre:${key}`, `${v.name} Mix`, T("{count} songs", { count: v.tracks.length }), v.tracks));
}

export function decadeMixes(tracks: Track[]): Mix[] {
  const byDecade = new Map<string, Track[]>();
  for (const t of tracks) {
    const d = decadeOf(t.year);
    if (!d) continue;
    const list = byDecade.get(d);
    if (list) list.push(t);
    else byDecade.set(d, [t]);
  }
  return [...byDecade.entries()]
    .filter(([, list]) => list.length >= MIN_TRACKS)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, list]) => make(`decade:${d}`, `${d} Mix`, T("{count} songs from the {d}", { count: list.length, d }), list));
}

export function onRepeatMix(tracks: Track[], counts: PlayCounts): Mix | null {
  const played = tracks.filter((t) => (counts[t.id]?.plays ?? 0) >= 2);
  if (played.length < MIN_TRACKS) return null;
  const top = [...played].sort((a, b) => (counts[b.id]?.plays ?? 0) - (counts[a.id]?.plays ?? 0)).slice(0, MIX_SIZE);
  // Ranked, not shuffled: this one is literally your most played songs.
  return { id: "onrepeat", title: T("On Repeat"), subtitle: T("Your most played songs"), tracks: top };
}

export function rediscoverMix(tracks: Track[], counts: PlayCounts): Mix | null {
  const unplayed = tracks.filter((t) => !counts[t.id]?.plays);
  if (unplayed.length < MIN_TRACKS) return null;
  return make("rediscover", T("Rediscover"), T("Songs you haven't played yet"), unplayed);
}

const WEEKDAYS = [T("Sunday"), T("Monday"), T("Tuesday"), T("Wednesday"), T("Thursday"), T("Friday"), T("Saturday")];

/** "Sunday Evening": the weekday and the part of the day; past midnight it is still the night before. */
export function momentTitle(now: number): string {
  const d = new Date(now);
  const h = d.getHours();
  const part = h < 5 || h >= 22 ? T("Night") : h >= 18 ? T("Evening") : h >= 14 ? T("Afternoon") : h >= 11 ? T("Midday") : T("Morning");
  return `${WEEKDAYS[h < 5 ? (d.getDay() + 6) % 7 : d.getDay()]} ${part}`;
}

/**
 * What you usually play around now: the songs the listening history ties to
 * this time of day and week (scores from listens.ts scoreMoments), best
 * first, in an order that holds through this part of the day. `keyOf` turns
 * a played copy's id into its song's (merged duplicates).
 */
export function momentMix(
  tracks: Track[],
  scores: readonly { id: string; score: number }[],
  keyOf: (id: string) => string = (id) => id,
  now = Date.now()
): Mix | null {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const picked: Track[] = [];
  const seen = new Set<string>();
  for (const s of scores) {
    const t = byId.get(keyOf(s.id)) ?? byId.get(s.id);
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    picked.push(t);
    if (picked.length >= MIX_SIZE) break;
  }
  if (picked.length < MIN_TRACKS) return null;
  const title = momentTitle(now);
  return { id: "moment", title, subtitle: T("What you usually play around now"), tracks: seededShuffle(picked, `moment|${title}|${today()}`) };
}

/**
 * Two mixes by sound (the sound analysis' energy): the calmest and the most
 * energetic fifth of the measured songs — relative to this library, so a
 * loud collection still gets its calm mix. Both need eight songs each.
 */
export function moodMixes(tracks: Track[], energyOf: (t: Track) => number | undefined): Mix[] {
  const measured = tracks
    .map((t) => ({ t, e: energyOf(t) }))
    .filter((x): x is { t: Track; e: number } => typeof x.e === "number")
    .sort((a, b) => a.e - b.e);
  if (measured.length < MIN_TRACKS * 2) return [];
  const fifth = Math.max(MIN_TRACKS, Math.floor(measured.length / 5));
  return [
    make("mood:calm", T("Calm Mix"), T("Quiet, gentle songs from your library"), measured.slice(0, fifth).map((x) => x.t)),
    make("mood:upbeat", T("Upbeat Mix"), T("Your most energetic songs"), measured.slice(-fifth).map((x) => x.t)),
  ];
}

const noEnergy = (): undefined => undefined;

type SoundOf = (t: Track) => SoundFacts | undefined;

/** What the mixes may know about the songs beyond the library itself. */
export interface MixSense {
  /** a song's energy (the mood mixes) */
  energyOf?: (t: Track) => number | undefined;
  /** what the analysis measured (the order that flows) */
  sound?: SoundOf;
  /** how much a song was skipped lately: such songs come later */
  skips?: (t: Track) => number;
  /** a song's genres as the library shows them; its own tags without */
  genres?: (t: Track) => string[];
}

/**
 * A mix in an order that flows, where its songs are measured; as drawn where none are. Songs skipped
 * lately come later. On Repeat stays as it is: it's a ranking, your most played first.
 */
export function inFlow<M extends Mix | null>(mix: M, sound?: SoundOf, skips?: (t: Track) => number): M {
  if (!mix || mix.id === "onrepeat" || !sound || !mix.tracks.some((t) => sound(t))) return mix;
  return { ...mix, tracks: flowOrder(mix.tracks.map((t) => ({ item: t, facts: sound(t), artist: t.artist, skips: skips?.(t) })), { arc: true }) } as M;
}

/** Every mix for the home page, personal ones first. */
export function allMixes(tracks: Track[], counts: PlayCounts, sense: MixSense = {}): Mix[] {
  return [
    onRepeatMix(tracks, counts),
    rediscoverMix(tracks, counts),
    ...moodMixes(tracks, sense.energyOf ?? noEnergy),
    ...genreMixes(tracks, 8, sense.genres),
    ...decadeMixes(tracks),
  ]
    .filter((m): m is Mix => !!m)
    .map((m) => inFlow(m, sense.sound, sense.skips));
}

/** Rebuild one mix by id (the mix page). */
export function mixById(id: string, tracks: Track[], counts: PlayCounts, sense: MixSense = {}): Mix | null {
  const mix =
    id === "onrepeat"
      ? onRepeatMix(tracks, counts)
      : id === "rediscover"
        ? rediscoverMix(tracks, counts)
        : id.startsWith("mood:")
          ? (moodMixes(tracks, sense.energyOf ?? noEnergy).find((m) => m.id === id) ?? null)
          : id.startsWith("genre:")
            ? (genreMixes(tracks, Infinity, sense.genres).find((m) => m.id === id) ?? null)
            : id.startsWith("decade:")
              ? (decadeMixes(tracks).find((m) => m.id === id) ?? null)
              : null;
  return inFlow(mix, sense.sound, sense.skips);
}
