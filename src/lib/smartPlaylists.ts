/**
 * Smart playlist rules: what each field means, which comparisons it offers,
 * how a rule is checked against a song, and how the matches are ordered.
 */
import type { SoundFacts } from "../../electron/sound-analysis";
import type { PlayCounts } from "../stores/catalog";
import type { RuleField, RuleOp, SmartPlaylist, SmartRule, SmartSort } from "../stores/smartPlaylists";
import type { Track } from "../types";
import { genresOfTrack } from "./albumGenres";
import { flowOrder } from "./flowOrder";
import { familyOf, GENRE_FAMILIES } from "./genres";
import { T } from "./i18n";
import { camelotLabel, camelotOf, keyLabel, keyStep } from "./soundMatch";

/** The wheel's 24 keys as choices: "8A · A minor" (in German "8A · a-Moll"). */
const CAMELOT_CHOICES = Array.from({ length: 24 }, (_, i) => ({ key: i % 12, minor: i >= 12 }))
  .map(({ key, minor }) => ({ c: camelotOf(key, minor), name: keyLabel(key, minor) }))
  .filter((k): k is { c: NonNullable<ReturnType<typeof camelotOf>>; name: string } => !!k.c)
  .sort((a, b) => a.c.n - b.c.n || a.c.ring.localeCompare(b.c.ring))
  .map((k) => ({ value: camelotLabel(k.c), label: `${camelotLabel(k.c)} · ${k.name}` }));

type Kind = "text" | "number" | "days" | "choice";

interface FieldDef {
  label: string;
  kind: Kind;
  ops: RuleOp[];
  /** unit shown after the value input */
  unit?: string;
  choices?: { value: string; label: string }[];
}

export const FIELDS: Record<RuleField, FieldDef> = {
  genre: { label: T("Genre"), kind: "text", ops: ["contains", "notContains", "is", "isNot"] },
  artist: { label: T("Artist"), kind: "text", ops: ["contains", "notContains", "is", "isNot"] },
  album: { label: T("Album"), kind: "text", ops: ["contains", "notContains", "is", "isNot"] },
  title: { label: T("Title"), kind: "text", ops: ["contains", "notContains", "is", "isNot"] },
  year: { label: T("Year"), kind: "number", ops: ["is", "gt", "lt", "between"] },
  added: { label: T("Added"), kind: "days", ops: ["inLast", "notInLast"], unit: T("days") },
  plays: { label: T("Plays"), kind: "number", ops: ["gt", "lt", "is"] },
  lastPlayed: { label: T("Last played"), kind: "days", ops: ["inLast", "notInLast"], unit: T("days") },
  duration: { label: T("Length"), kind: "number", ops: ["gt", "lt"], unit: "min" },
  format: {
    label: T("Format"),
    kind: "choice",
    ops: ["is", "isNot"],
    choices: ["FLAC", "MP3", "AAC", "ALAC", "Opus", "Vorbis", "WAV", "AIFF", "WMA", "WavPack", "APE", "DSD"].map((f) => ({ value: f, label: f })),
  },
  sampleRate: { label: T("Sample rate"), kind: "number", ops: ["gt", "lt", "is"], unit: "kHz" },
  bitDepth: { label: T("Bit depth"), kind: "number", ops: ["gt", "lt", "is"], unit: "bit" },
  source: {
    label: T("Source"),
    kind: "choice",
    ops: ["is", "isNot"],
    choices: [
      { value: "local", label: T("On this device") },
      { value: "jellyfin", label: T("Jellyfin") },
      { value: "subsonic", label: T("Navidrome") },
    ],
  },
  liked: {
    label: T("Liked"),
    kind: "choice",
    ops: ["is"],
    choices: [
      { value: "yes", label: T("Yes") },
      { value: "no", label: T("No") },
    ],
  },
  bpm: { label: T("Tempo"), kind: "number", ops: ["between", "gt", "lt", "is"], unit: "BPM" },
  energy: { label: T("Energy"), kind: "number", ops: ["gt", "lt", "between"], unit: "%" },
  camelot: { label: T("Key"), kind: "choice", ops: ["is", "near"], choices: CAMELOT_CHOICES },
  family: { label: T("Genre family"), kind: "choice", ops: ["is", "isNot"], choices: GENRE_FAMILIES.map((f) => ({ value: f, label: T(f) })) },
};

export const OP_LABEL: Record<RuleOp, string> = {
  contains: "contains",
  notContains: "doesn't contain",
  is: "is",
  isNot: "is not",
  gt: "is more than",
  lt: "is less than",
  between: "is between",
  inLast: "in the last",
  notInLast: "not in the last",
  near: "is on or next to",
};

export const SORT_LABEL: Record<SmartSort, string> = {
  random: T("Random"),
  added: T("Recently added"),
  plays: T("Most played"),
  lastPlayed: T("Recently played"),
  title: T("Title"),
  artist: T("Artist"),
  year: T("Newest first"),
  flow: T("Flow (tempo, key, energy)"),
};

/** Format family of a track's codec — "MPEG 1 Layer 3" → MP3, "MPEG-4/AAC" → AAC … */
function formatOf(t: Track): string {
  const c = `${t.codec ?? ""} ${t.localPath?.split(".").pop() ?? ""}`.toUpperCase();
  if (/FLAC/.test(c)) return "FLAC";
  if (/ALAC/.test(c)) return "ALAC";
  if (/LAYER 3|MP3/.test(c)) return "MP3";
  if (/AAC|M4A|MP4/.test(c)) return "AAC";
  if (/OPUS/.test(c)) return "Opus";
  if (/VORBIS|OGG/.test(c)) return "Vorbis";
  if (/PCM|WAV/.test(c)) return /AIF/.test(c) ? "AIFF" : "WAV";
  if (/AIF/.test(c)) return "AIFF";
  if (/WMA|WINDOWS MEDIA/.test(c)) return "WMA";
  if (/WAVPACK|\bWV\b/.test(c)) return "WavPack";
  if (/APE|MONKEY/.test(c)) return "APE";
  if (/DSD|DSF|DFF/.test(c)) return "DSD";
  return "";
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A random order that holds while the app runs: a song gets the same place on every look, so the list
 * doesn't shuffle itself after each play counted; another smart playlist, another order; another
 * start, another order.
 */
const SESSION_SEED = Math.floor(Math.random() * 2 ** 31);
export function randomKey(id: string, salt: string, seed = SESSION_SEED): number {
  let h = (2166136261 ^ seed) >>> 0;
  const text = `${salt}|${id}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // A last stir, so ids that differ only at their end still land far apart.
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 2 ** 32;
}

const shuffled = (tracks: Track[], salt: string): Track[] =>
  tracks
    .map((t) => ({ t, k: randomKey(t.id, salt) }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.t);

/** Whether a smart playlist reads the play counts: if not, a play counted changes nothing in it. */
export const readsPlays = (sp: SmartPlaylist): boolean => sp.sort === "plays" || sp.sort === "lastPlayed" || sp.rules.some((r) => r.field === "plays" || r.field === "lastPlayed");

interface Ctx {
  counts: PlayCounts;
  liked: Set<string>;
  now: number;
  /** a song's measured sound, if the analysis has it */
  sound: (t: Track) => SoundFacts | undefined;
}

function textMatch(op: RuleOp, hay: string[], needle: string): boolean {
  const n = needle.trim().toLowerCase();
  const values = hay.map((h) => h.toLowerCase());
  switch (op) {
    case "contains":
      return values.some((v) => v.includes(n));
    case "notContains":
      return !values.some((v) => v.includes(n));
    case "is":
      return values.some((v) => v === n);
    case "isNot":
      return !values.some((v) => v === n);
    default:
      return false;
  }
}

function numberMatch(op: RuleOp, value: number | undefined, a: number, b?: number): boolean {
  if (value === undefined || !Number.isFinite(value)) return false;
  switch (op) {
    case "is":
      return Math.abs(value - a) < 1e-6;
    case "gt":
      return value > a;
    case "lt":
      return value < a;
    case "between":
      return b !== undefined && value >= Math.min(a, b) && value <= Math.max(a, b);
    default:
      return false;
  }
}

function daysMatch(op: RuleOp, at: number | undefined, days: number, now: number): boolean {
  const within = !!at && now - at <= days * DAY;
  return op === "inLast" ? within : !within;
}

export function ruleMatches(rule: SmartRule, t: Track, ctx: Ctx): boolean {
  const a = Number(rule.value);
  const b = rule.value2 !== undefined && rule.value2 !== "" ? Number(rule.value2) : undefined;
  switch (rule.field) {
    case "genre":
      return textMatch(rule.op, genresOfTrack(t).length ? genresOfTrack(t) : [""], rule.value);
    case "artist":
      return textMatch(rule.op, [t.artist, t.albumArtist ?? ""], rule.value);
    case "album":
      return textMatch(rule.op, [t.album ?? ""], rule.value);
    case "title":
      return textMatch(rule.op, [t.title], rule.value);
    case "year":
      return numberMatch(rule.op, t.year, a, b);
    case "added":
      return daysMatch(rule.op, t.addedAt, a, ctx.now);
    case "plays":
      return numberMatch(rule.op, ctx.counts[t.id]?.plays ?? 0, a, b);
    case "lastPlayed":
      return daysMatch(rule.op, ctx.counts[t.id]?.lastAt, a, ctx.now);
    case "duration":
      return numberMatch(rule.op, t.duration / 60, a, b);
    case "format": {
      const f = formatOf(t);
      return rule.op === "is" ? f === rule.value : f !== rule.value;
    }
    case "sampleRate":
      return numberMatch(rule.op, t.sampleRate ? t.sampleRate / 1000 : undefined, a, b);
    case "bitDepth":
      return numberMatch(rule.op, t.bitsPerSample, a, b);
    case "source": {
      const s = t.source ?? "local";
      return rule.op === "is" ? s === rule.value : s !== rule.value;
    }
    case "liked":
      return ctx.liked.has(t.id) === (rule.value === "yes");
    case "bpm": {
      const bpm = ctx.sound(t)?.bpm || undefined;
      // A tempo "is" within two beats: nobody's measure is exact.
      return rule.op === "is" ? bpm !== undefined && Math.abs(bpm - a) <= 2 : numberMatch(rule.op, bpm, a, b);
    }
    case "energy": {
      const f = ctx.sound(t);
      return numberMatch(rule.op, f && f.loudness > -70 ? f.energy * 100 : undefined, a, b);
    }
    case "camelot": {
      const f = ctx.sound(t);
      const here = f ? camelotOf(f.key, f.minor) : null;
      const want = /^(\d{1,2})([AB])$/.exec(rule.value);
      if (!here || !want) return false;
      const step = keyStep(here, { n: Number(want[1]), ring: want[2] as "A" | "B" });
      return rule.op === "near" ? step < 2 : step === 0;
    }
    case "family": {
      const families = genresOfTrack(t).map((g) => familyOf(g));
      return rule.op === "is" ? families.includes(rule.value as never) : !families.includes(rule.value as never);
    }
    default:
      return false;
  }
}

/** A rule with an empty value is ignored (the editor shows it, the filter skips it). */
function ruleIsSet(r: SmartRule): boolean {
  if (FIELDS[r.field].kind === "text") return r.value.trim() !== "";
  if (FIELDS[r.field].kind === "choice") return r.value !== "";
  return r.value !== "" && Number.isFinite(Number(r.value));
}

export function evaluateSmartPlaylist(
  sp: SmartPlaylist,
  tracks: Track[],
  counts: PlayCounts,
  likedIds: Set<string>,
  sound: (t: Track) => SoundFacts | undefined = () => undefined,
  skips: (t: Track) => number = () => 0
): Track[] {
  const ctx: Ctx = { counts, liked: likedIds, now: Date.now(), sound };
  const rules = sp.rules.filter(ruleIsSet);
  let out = rules.length
    ? tracks.filter((t) => (sp.match === "all" ? rules.every((r) => ruleMatches(r, t, ctx)) : rules.some((r) => ruleMatches(r, t, ctx))))
    : [...tracks];
  const plays = (t: Track): number => counts[t.id]?.plays ?? 0;
  const last = (t: Track): number => counts[t.id]?.lastAt ?? 0;
  switch (sp.sort) {
    case "random":
      out = shuffled(out, sp.id);
      break;
    case "added":
      out.sort((x, y) => (y.addedAt ?? 0) - (x.addedAt ?? 0));
      break;
    case "plays":
      out.sort((x, y) => plays(y) - plays(x));
      break;
    case "lastPlayed":
      out.sort((x, y) => last(y) - last(x));
      break;
    case "title":
      out.sort((x, y) => x.title.localeCompare(y.title));
      break;
    case "artist":
      out.sort((x, y) => x.artist.localeCompare(y.artist) || (x.album ?? "").localeCompare(y.album ?? ""));
      break;
    case "year":
      out.sort((x, y) => (y.year ?? 0) - (x.year ?? 0));
      break;
    case "flow": {
      // The limit first (a random pick of that many, the same one while the app runs), then the order that flows (lib/flowOrder.ts).
      const pool = sp.limit && sp.limit > 0 ? shuffled(out, sp.id).slice(0, sp.limit) : out;
      return flowOrder(pool.map((t) => ({ item: t, facts: sound(t), artist: t.artist, skips: skips(t) })), { arc: true });
    }
  }
  return sp.limit && sp.limit > 0 ? out.slice(0, sp.limit) : out;
}

/** "Genre contains rock · Year is between 1990 and 1999" */
export function describeRules(sp: SmartPlaylist): string {
  const parts = sp.rules.filter(ruleIsSet).map((r) => {
    const f = FIELDS[r.field];
    const value = f.choices?.find((c) => c.value === r.value)?.label ?? r.value;
    const range = r.op === "between" ? `${value} ${T("and")} ${r.value2 ?? ""}` : value;
    return `${f.label} ${T(OP_LABEL[r.op])} ${range}${f.unit ? ` ${f.unit}` : ""}`;
  });
  return parts.join(sp.match === "all" ? " · " : ` ${T("or")} `) || T("All songs");
}

/** Starting points offered when a new smart playlist is created. */
export const SMART_PRESETS: { name: string; rules: SmartRule[]; sort: SmartSort; limit: number | null }[] = [
  { name: "Hi-Res", rules: [{ field: "sampleRate", op: "gt", value: "48" }], sort: "artist", limit: null },
  { name: T("Recently added"), rules: [{ field: "added", op: "inLast", value: "30" }], sort: "added", limit: null },
  { name: T("Never played"), rules: [{ field: "plays", op: "is", value: "0" }], sort: "random", limit: 100 },
  { name: T("Most played"), rules: [{ field: "plays", op: "gt", value: "2" }], sort: "plays", limit: 50 },
  { name: T("Not played in a while"), rules: [{ field: "plays", op: "gt", value: "0" }, { field: "lastPlayed", op: "notInLast", value: "90" }], sort: "random", limit: 100 },
  // Made from how songs sound, in an order that flows.
  { name: T("Workout"), rules: [{ field: "bpm", op: "between", value: "120", value2: "140" }, { field: "energy", op: "gt", value: "60" }], sort: "flow", limit: 60 },
  { name: T("Wind down"), rules: [{ field: "energy", op: "lt", value: "40" }, { field: "bpm", op: "lt", value: "100" }], sort: "flow", limit: 60 },
];
