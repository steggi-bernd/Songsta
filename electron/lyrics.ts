/**
 * Lyrics providers for the desktop player — BitChord mobile's sweep, ported.
 *
 * Eleven sources are raced in parallel but their answers are taken in
 * BitChord's default priority order; a word-synced answer beats a line-synced
 * one from a source ahead of it when prioritizeWordSync is on (it is, by
 * default). The sweep is deadline-bounded so a slow provider chain can never
 * hold the lyrics view past a couple of seconds.
 *
 * Word-timed chain: BiniLyrics (Apple TTML, matched on the recording — it
 * also reports the ISRC every later play reuses) → BetterLyrics (Apple TTML)
 * → Portato (QQ Music karaoke timings) → PaxSenix (Apple TTML via a public
 * proxy) → LyricsPlus (syllable mirrors). Then Unison; then the
 * line-synced workhorses Megalobiz → KuGou → LRCLIB → Musixmatch (richsync,
 * signed the way Musixmatch's web client signs), with Genius scraped plain
 * text as the last resort.
 *
 * All timings are SECONDS end-to-end — providers that serve milliseconds
 * convert at the parse boundary, which is exactly where the classic "lyrics
 * don't match" bug hides.
 */
import { createHmac, randomUUID } from "node:crypto";
import { lrcRows } from "../src/lib/lrc";
import type { SyncedLyricLine, SyncedLyricWord } from "../src/types";
import { GENIUS_HEADERS, geniusFindWith } from "./genius";
import { geniusExtractLyrics } from "./genius-page";
import { cleanTitle, primaryArtist, queryTitle } from "./song-names";

export { GENIUS_HEADERS };

export interface LyricQuery {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** seconds, 0 = unknown */
  duration: number;
}

export interface ProviderResult {
  source: string;
  wordSynced: boolean;
  lines: SyncedLyricLine[];
  /** set when the provider only answered with untimed text */
  plainText?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LYRICS_AGENT = "Songsta (https://github.com/steggi-bernd/Songsta)";

export async function getText(url: string, timeoutMs = 6000, headers: Record<string, string> = {}): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": LYRICS_AGENT, Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log(`[bytune][lyrics-net] HTTP ${res.status} ${url.slice(0, 90)}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`[bytune][lyrics-net] FAIL ${url.slice(0, 90)} :: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- shared parsing ---------------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** [mm:ss.xx] or [mm:ss.xxx] → seconds. Hundredths get ×10 to ms first. */
function stampMs(min: string, sec: string, frac: string): number {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  const f = parseInt(frac.padEnd(3, frac.length === 2 ? "0" : ""), 10);
  return (m * 60 + s) * 1000 + f;
}

/** Rendition markers that change the timing itself — a match to the normal
 * studio cut can never stay in sync with these, no matter the offset. */
const EDITION_MARKERS = /(sped[ -]?up|slowed(?:\s*(?:\+|and|&)?\s*(?:down|reverb))?|reverb|nightcore|daycore|super\s*(?:sped|slowed)|remix|bootleg|live)/i;

/** The edition word on the upload's own title, when it names one. */
function editionOf(title: string): string | null {
  return EDITION_MARKERS.exec(title)?.[0]?.toLowerCase() ?? null;
}

/** How far a matched rendition's own runtime may sit from the playing track
 * before the two are different edits: offset alignment repairs a constant
 * intro, never a different tempo. Generous on purpose — an upload that runs
 * a few seconds long still lines up. */
function withinTolerance(recordSec: number | null | undefined, playingSec: number): boolean {
  if (!recordSec || !playingSec) return true;
  return Math.abs(recordSec - playingSec) <= Math.max(12, playingSec * 0.08);
}

/** Insert gap markers where ≥5s of nobody sings — instrumental sections. */
function withInstrumentalGaps(lines: SyncedLyricLine[]): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const next = lines[i + 1];
    if (!next) break;
    const lineEnd = lineEndSec(line, next.time);
    if (next.time - lineEnd >= 5) {
      out.push({ time: lineEnd, text: "", gap: true });
    }
  }
  return out;
}

function lineEndSec(line: SyncedLyricLine, nextStart: number): number {
  if (line.end != null) return line.end;
  const lastWord = line.words?.[line.words.length - 1];
  if (lastWord) return lastWord.end;
  return line.time + Math.min(8, Math.max(2, nextStart - line.time));
}

function toResult(source: string, lines: SyncedLyricLine[]): ProviderResult | null {
  if (!lines.length) return null;
  return { source, wordSynced: lines.some((l) => (l.words?.length ?? 0) > 0), lines: withInstrumentalGaps(lines) };
}

/* ------------------------------ placeholders ---------------------------- */

/**
 * "No lyrics", dressed up as lyrics. The Chinese catalogues (KuGou, and the
 * NetEase / QQ Music lines Portato and friends pass on) answer an instrumental
 * with one line — 纯音乐，请欣赏, "pure music, please enjoy" — taggers copy it
 * into files, and English sources write "[Instrumental]". On screen it is a
 * stray line of Chinese over a song without words, so it counts as none.
 */
const PLACEHOLDER_LINE =
  /^(?:此歌曲[为為])?(?:没有填词的|沒有填詞的)?[纯純]音[乐樂](?:[请請]您?欣[赏賞])?$|^(?:[该該]歌曲)?[暂暫][无無]歌[词詞]$|^instrumental$/;
/** "作曲 : 某人" — the credit lines some catalogues put around it. */
const CREDIT_LINE = /^[^:：]{1,16}[:：]/;

export function isPlaceholderLyrics(lines: readonly string[]): boolean {
  const said = lines.map((l) => l.trim()).filter(Boolean);
  if (!said.length || said.length > 4) return false;
  let placeholder = false;
  for (const line of said) {
    if (PLACEHOLDER_LINE.test(line.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ""))) placeholder = true;
    else if (!CREDIT_LINE.test(line)) return false;
  }
  return placeholder;
}

/** Fetched lyrics that only say there are none (see isPlaceholderLyrics). */
export function isPlaceholderFetched(lyrics: FetchedLyrics): boolean {
  return isPlaceholderLyrics(lyrics.synced ? lyrics.synced.map((l) => l.text) : (lyrics.plain ?? "").split(/\r?\n/));
}

/* ------------------------------ LRC parsing ----------------------------- */

/**
 * Lyrics text the user already has — a sidecar .lrc, an embedded tag, a
 * Jellyfin lyrics file — through the same parsers the providers use: rich
 * LRC (word stamps) first, then plain LRC, then untimed text.
 */
export function lyricsFromText(source: string, text: string): FetchedLyrics | null {
  const clean = text.replace(/^﻿/, "").trim();
  if (!clean) return null;
  const rich = parseEnhancedLrc(clean);
  const lines = rich.length ? rich : parseLrc(clean);
  if (lines.some((l) => l.text.trim())) {
    if (isPlaceholderLyrics(lines.map((l) => l.text))) return null;
    return { source, wordSynced: rich.length > 0, synced: withInstrumentalGaps(lines), plain: null };
  }
  // No timestamps: plain text, minus any LRC header tags ([ar:…], [ti:…]).
  const plain = clean
    .split(/\r?\n/)
    .filter((l) => !/^\[[a-z]+:.*]$/i.test(l.trim()))
    .join("\n")
    .trim();
  return plain && !isPlaceholderLyrics(plain.split("\n")) ? { source, wordSynced: false, synced: null, plain } : null;
}

/** Plain LRC → line-synced lines (seconds). Word stamps `<…>` are ignored. */
function parseLrc(lrc: string): SyncedLyricLine[] {
  return lrcRows(lrc).map((row) => ({
    time: row.at / 1000,
    text: decodeEntities(row.rest.replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim()),
  }));
}

/** Word-timed rich LRC: `[mm:ss.xx]<mm:ss.xx>word …` → seconds. */
function parseEnhancedLrc(lrc: string): SyncedLyricLine[] {
  const rows: { time: number; words: { start: number; text: string }[]; plain: string }[] = lrcRows(lrc).map((row) => {
    const rest = decodeEntities(row.rest);
    const words = [...rest.matchAll(/<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)/g)].map((w) => ({
      start: stampMs(w[1], w[2], w[3]) / 1000,
      text: w[4].trim(),
    }));
    return { time: row.at / 1000, words, plain: rest.replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim() };
  });
  if (!rows.some((r) => r.words.length > 0)) return []; // ordinary LRC, not rich
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.words.length === 0) {
      if (row.plain) out.push({ time: row.time, text: row.plain });
      continue;
    }
    const lineEnd = rows[i + 1]?.time ?? row.words[row.words.length - 1].start + 4;
    const words: SyncedLyricWord[] = row.words
      .filter((w) => w.text)
      .map((w, wi) => ({
        start: w.start,
        end: row.words[wi + 1]?.start ?? lineEnd,
        text: w.text,
      }));
    if (!words.length) continue;
    for (const w of words) if (w.end < w.start) w.end = w.start;
    out.push({
      time: Math.min(row.time, words[0].start),
      text: words.map((w) => w.text).join(" "),
      words,
      end: words[words.length - 1].end,
    });
  }
  return out;
}

/* ----------------------- Karaoke LRC (QRC / YRC) ------------------------ */

/**
 * QQ Music's karaoke format: millisecond line ranges `[start,dur]` with
 * per-word stamps, written either `(start,dur[,0])word` before the word or
 * `word(start,dur)` after it. Some producers wrap the whole thing in a
 * `LyricContent="…"` variable, which is peeled off first.
 */
const KARAOKE_LINE = /^\[(\d{1,8}),(\d{1,8})](.*)$/;
const KARAOKE_PREFIX_WORD = /\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)([^()]*)/g;
const KARAOKE_SUFFIX_WORD = /([^()]*)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g;
const KARAOKE_WORD_TIME = /\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/g;
const LYRIC_CONTENT_VAR = /LyricContent\s*=\s*"([^"]*)"/i;

function karaokeContent(raw: string): string {
  const m = LYRIC_CONTENT_VAR.exec(raw);
  if (!m) return raw;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function karaokeLooksLike(raw: string): boolean {
  for (const source of karaokeContent(raw).split(/\r?\n/)) {
    const m = KARAOKE_LINE.exec(source.trim());
    if (m && (/\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)[^()]/.test(m[3]) || /[^()]\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/.test(m[3]))) {
      return true;
    }
  }
  return false;
}

function parseKaraokeLrc(raw: string): SyncedLyricLine[] {
  const rows: SyncedLyricLine[] = [];
  for (const source of karaokeContent(raw).split(/\r?\n/)) {
    const m = KARAOKE_LINE.exec(source.trim());
    if (!m) continue;
    const lineStart = parseInt(m[1], 10) / 1000;
    const lineDur = parseInt(m[2], 10) / 1000;
    const body = m[3];
    // The stamp set that carries more text is the real convention of this
    // file; the other reading would scramble the word order.
    const prefixed = [...body.matchAll(KARAOKE_PREFIX_WORD)].map((w) => ({
      start: parseInt(w[1], 10) / 1000,
      dur: parseInt(w[2], 10) / 1000,
      text: decodeEntities(w[3]),
    }));
    const suffixed = [...body.matchAll(KARAOKE_SUFFIX_WORD)].map((w) => ({
      start: parseInt(w[2], 10) / 1000,
      dur: parseInt(w[3], 10) / 1000,
      text: decodeEntities(w[1]),
    }));
    const len = (list: { text: string }[]): number => list.reduce((a, w) => a + w.text.length, 0);
    const picked = len(prefixed) >= len(suffixed) ? prefixed : suffixed;
    const words: SyncedLyricWord[] = [];
    for (const w of picked) {
      const text = w.text.trim();
      if (!text) continue;
      words.push({ start: w.start, end: Math.max(w.start + w.dur, w.start), text });
    }
    if (!words.length) continue;
    const text = decodeEntities(body.replace(KARAOKE_WORD_TIME, "")).trim();
    if (!text) continue;
    rows.push({
      time: Math.min(lineStart, words[0].start),
      text,
      words,
      end: lineDur > 0 ? lineStart + lineDur : words[words.length - 1].end,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/* --------------------- generic provider-envelope parse ------------------- */

/**
 * Several of the smaller backends answer with the same lyric payload in
 * different wrappers: bare TTML, an LRC file, plain text, or any of those
 * nested in one or two JSON envelopes. Unwrap, then hand the string to
 * whichever parser it actually is.
 */
const PROVIDER_CONTENT_KEYS = [
  "ttml", "ttmlContent", "lyrics", "lyricContent", "lrc", "content", "text",
  "plainLyrics", "syncedLyrics", "line", "lines", "lyric",
  "data", "result", "response",
];

function providerExtractString(el: unknown, depth = 0): string | null {
  if (depth > 6 || el == null) return null;
  if (typeof el === "string") {
    const text = el.trim();
    if (!text) return null;
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        return providerExtractString(JSON.parse(text), depth + 1);
      } catch {
        return text;
      }
    }
    return text;
  }
  if (Array.isArray(el)) {
    const parts = el.map((v) => providerExtractString(v, depth + 1)).filter((s): s is string => !!s);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof el === "object") {
    const obj = el as Record<string, unknown>;
    if (obj.isError === true || obj.ok === false) return null;
    const err = obj.error;
    if (err != null && err !== false && err !== "" && err !== "false") return null;
    for (const key of PROVIDER_CONTENT_KEYS) {
      if (key in obj) {
        const found = providerExtractString(obj[key], depth + 1);
        if (found) return found;
      }
    }
    if (obj.metadata && typeof obj.metadata === "object") {
      return providerExtractString(obj.metadata, depth + 1);
    }
    return null;
  }
  return null;
}

/** Synced lines, or plain text when the payload carried no timing at all. */
function parseProviderAny(raw: string): SyncedLyricLine[] | { plain: string } | null {
  let value = raw.replace(/^\uFEFF/, "").trim();
  if (value.startsWith("```")) {
    const lines = value.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1].trim() === "```") lines.pop();
    value = lines.slice(1).join("\n").trim();
  }
  if (!value) return null;
  let content = value;
  try {
    const extracted = providerExtractString(JSON.parse(value));
    if (!extracted) return null;
    content = extracted;
  } catch {
    /* not JSON — parse as the raw text */
  }
  if (/&lt;(tt[\s>]|\/tt)/i.test(content)) content = decodeEntities(content);
  if (/<tt[\s>]/i.test(content) || content.toLowerCase().includes("http://www.w3.org/ns/ttml")) {
    const ttml = parseTtml(content);
    if (ttml.length) return ttml;
  }
  if (karaokeLooksLike(content)) {
    const karaoke = parseKaraokeLrc(content);
    if (karaoke.length) return karaoke;
  }
  if (content.trimStart().startsWith("<")) return null;
  const enhanced = parseEnhancedLrc(content);
  if (enhanced.length) return enhanced;
  const lrc = parseLrc(content);
  if (lrc.length) return lrc;
  if (/\b(lyrics? (?:not found|unavailable)|error)\b/i.test(content)) return null;
  const plain = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[[A-Za-z]+:.*]$/.test(l))
    .join("\n");
  return plain ? { plain } : null;
}

/* --------------------------------- TTML --------------------------------- */

/** TTML time → SECONDS ("27.395", "H:MM:SS.mmm", "M:SS.mmm"). */
function attrTimeSeconds(attrs: string, name: string): number | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(attrs);
  if (!m) return null;
  const v = m[1];
  if (/^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
  const clock = /^(\d+):(\d{2}):(\d{2})\.(\d{1,3})$/.exec(v);
  if (clock) {
    return (
      parseInt(clock[1], 10) * 3600 +
      parseInt(clock[2], 10) * 60 +
      parseInt(clock[3], 10) +
      parseInt(clock[4].padEnd(3, "0"), 10) / 1000
    );
  }
  const short = /^(\d+):(\d{2})\.(\d{1,3})$/.exec(v);
  if (short) {
    return parseInt(short[1], 10) * 60 + parseInt(short[2], 10) + parseInt(short[3].padEnd(3, "0"), 10) / 1000;
  }
  return null;
}

/**
 * Apple Music TTML, word-timed. A <p> per line, a timed <span> per syllable;
 * syllables of one word are adjacent spans with no whitespace between them,
 * so whitespace — not the span boundary — separates words. All times come
 * out in SECONDS.
 */
function parseTtml(ttml: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  const pBlocks = ttml.match(/<p\b[^>]*>[\s\S]*?<\/p>|<p\b[^>]*\/>/g) ?? [];
  for (const block of pBlocks) {
    const open = /<p\b([^>]*)>/.exec(block);
    if (!open) continue;
    const attrs = open[1];
    if (/(?:ttm:role|x-role)\s*=\s*"(x-translation|x-roman)"/.test(attrs)) continue;
    const begin = attrTimeSeconds(attrs, "begin");
    if (begin == null) continue;
    const end = attrTimeSeconds(attrs, "end");

    // Walk the paragraph as a sequence: each span plus the gap text BEFORE it.
    // The gap is where the word boundary usually lives ("</span> <span>") -
    // dropping it glued whole lines into single mega-words.
    const spans = [...block.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)];
    const timed: { begin: number | null; end: number | null; text: string; boundary: boolean }[] = [];
    let prevEnd = 0;
    for (const m of spans) {
      const gap = block.slice(prevEnd, m.index ?? 0);
      timed.push({
        begin: attrTimeSeconds(m[1], "begin"),
        end: attrTimeSeconds(m[1], "end"),
        text: decodeEntities(m[2].replace(/<[^>]+>/g, "")),
        boundary: /\s/.test(gap),
      });
      prevEnd = (m.index ?? 0) + m[0].length;
    }

    if (timed.length === 0) {
      // Line-synced TTML: bare text, no spans.
      const text = decodeEntities(block.replace(/<[^>]+>/g, "")).trim();
      if (!text) continue;
      lines.push({ time: begin, text, end: end != null && end > begin ? end : undefined });
      continue;
    }

    // Merge syllable spans into words: a boundary is whitespace in the gap
    // before a span or whitespace inside the span text (Apple writes it
    // inside, Lyrically-generated TTML writes it between).
    const words: SyncedLyricWord[] = [];
    let cur: { start: number; end: number; text: string } | null = null;
    const closeWord = (): void => {
      if (cur) words.push({ start: cur.start, end: cur.end, text: cur.text.trim() });
      cur = null;
    };
    for (const sp of timed) {
      const text = sp.text;
      if (!text) continue;
      if (!cur || sp.boundary || /^\s/.test(text)) {
        closeWord();
        cur = { start: sp.begin as number, end: sp.end ?? sp.begin ?? 0, text };
      } else {
        cur.text += text;
        cur.end = sp.end ?? cur.end;
      }
      if (/\s$/.test(cur.text)) closeWord();
    }
    closeWord();

    // A producer that emits no whitespace at all: each span is a word.
    if (words.length <= 1 && timed.length > 1) {
      words.length = 0;
      for (const sp of timed) {
        if (sp.begin == null || !sp.text.trim()) continue;
        const st = sp.begin;
        words.push({ start: st, end: Math.max(sp.end ?? st, st), text: sp.text.trim() });
      }
    }
    const clean = words.filter((w) => w.text.length > 0);
    if (clean.length === 0) continue;
    for (const w of clean) if (w.end < w.start) w.end = w.start;
    lines.push({
      time: Math.min(begin, clean[0].start),
      text: clean.map((w) => w.text).join(" "),
      words: clean,
      end: end != null && end > begin ? end : clean[clean.length - 1].end,
    });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/* ------------------------------ LyricsPlus ------------------------------ */

/**
 * Syllable-level lyrics from the YouLy+ backend, on community mirrors that
 * come and go — so all of them are asked in turn and the first usable answer
 * wins; the winner is remembered for the next track.
 */
const LYRICSPLUS_MIRRORS = [
  "https://lyricsplus.prjktla.my.id",
  "https://lyricsplus.atomix.one",
  "https://lyricsplus.binimum.org",
  "https://lyricsplus.prjktla.workers.dev",
  "https://lyricsplus-seven.vercel.app",
  "https://lyrics-plus-backend.vercel.app",
];
let lyricsPlusLastGood: string | null = null;

interface PlusSyllable {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
}
interface PlusLine {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
  syllabus?: PlusSyllable[];
}

/** Glue syllables back into words — a trailing space marks the boundary.
 *  If a source emits no whitespace boundaries at all, each syllable is a word. */
function mergePlusSyllables(syllables: PlusSyllable[]): SyncedLyricWord[] {
  const words: SyncedLyricWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  let boundary = false;
  for (const syl of syllables) {
    if (!syl.text?.trim() || syl.time == null) continue;
    if (!text) start = syl.time / 1000;
    text += syl.text.trim();
    end = syl.time / 1000 + (syl.duration ?? 0) / 1000;
    if (/\s$/.test(syl.text)) {
      words.push({ start, end: Math.max(end, start), text });
      text = "";
      boundary = true;
    }
  }
  if (text) {
    if (boundary) {
      words.push({ start, end: Math.max(end, start), text });
    } else {
      // Whole words with no spacing convention: keep them separate.
      for (const syl of syllables) {
        if (!syl.text?.trim() || syl.time == null) continue;
        const st = syl.time / 1000;
        words.push({ start: st, end: Math.max(st + (syl.duration ?? 0) / 1000, st), text: syl.text.trim() });
      }
    }
  }
  return words;
}

function parsePlusResponse(response: { lyrics?: PlusLine[] | null }): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (const line of response.lyrics ?? []) {
    const startSec = line.time != null ? line.time / 1000 : null;
    if (startSec == null) continue;
    const words = mergePlusSyllables(line.syllabus ?? []);
    if (words.length > 0) {
      out.push({
        time: Math.min(startSec, words[0].start),
        text: words.map((w) => w.text).join(" "),
        words,
        end: words[words.length - 1].end,
      });
    } else if (line.text && line.text.trim()) {
      out.push({
        time: startSec,
        text: line.text.trim(),
        end: line.duration && line.duration > 0 ? startSec + line.duration / 1000 : undefined,
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchLyricsPlusOne(host: string, q: LyricQuery, isrc?: string): Promise<SyncedLyricLine[] | null> {
  const parse = (body: string | null): SyncedLyricLine[] | null => {
    if (!body) return null;
    try {
      const lines = parsePlusResponse(JSON.parse(body));
      return lines.length ? lines : null;
    } catch {
      return null;
    }
  };
  // The rendition the upload names is asked for first — Apple-backed backends
  // index the actual "(Sped Up)" releases — then the stripped title.
  const stripped = queryTitle(q.title);
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];
  const attempt = (title: string, withDuration: boolean): string => {
    const params = new URLSearchParams({ title, artist: primaryArtist(q.artist || "") });
    if (withDuration && q.duration > 0) params.set("duration", String(Math.round(q.duration)));
    if (q.album) params.set("album", cleanTitle(q.album));
    // Sent alongside the name rather than instead of it: this backend
    // aggregates several catalogues, and the ones with no ISRC index still
    // need something to match on.
    if (isrc) params.set("isrc", isrc);
    return `${host}/v2/lyrics/get?${params.toString()}`;
  };

  // Strict first: the duration disambiguates remixes. But when the file
  // runs longer or shorter than every catalogue version (music videos with
  // intros, extended cuts), a hard duration filter rejects the REAL
  // song and a keyword fallback answers with someone else's lyrics — so a
  // strict miss retries once on title+artist alone.
  for (const title of titles) {
    const lines = parse(await getText(attempt(title, true), 7000));
    if (lines) return lines;
    if (q.duration > 0) {
      const loose = parse(await getText(attempt(title, false), 7000));
      if (loose) return loose;
    }
  }
  return null;
}

async function fetchLyricsPlus(q: LyricQuery, isrc?: string): Promise<ProviderResult | null> {
  const hosts = lyricsPlusLastGood
    ? [lyricsPlusLastGood, ...LYRICSPLUS_MIRRORS.filter((m) => m !== lyricsPlusLastGood)]
    : LYRICSPLUS_MIRRORS;
  // All mirrors are asked at once; the first to answer with something usable
  // wins the moment it lands — completion order, not mirror order. A slow
  // mirror that will come back empty must not hold up one that already has
  // the track. The winner is remembered for the next track.
  return new Promise((resolve) => {
    let remaining = hosts.length;
    let settled = false;
    const done = (r: ProviderResult | null): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    for (const host of hosts) {
      void fetchLyricsPlusOne(host, q, isrc).then(
        (lines) => {
          remaining -= 1;
          if (lines) {
            lyricsPlusLastGood = host;
            done(toResult("LyricsPlus", lines));
          } else if (remaining === 0) done(null);
        },
        () => {
          remaining -= 1;
          if (remaining === 0) done(null);
        }
      );
    }
  });
}

/* ------------------------------ PaxSenix -------------------------------- */

/**
 * Word-timed lyrics via lyrics.paxsenix.org — a public proxy in front of
 * Apple Music's catalogue and lyrics. Apple's own search needs a bearer
 * token, which its web player carries inside one of its JS bundles; scrape
 * it the same way the player does and keep it until Apple says no.
 */
const PAXSENIX_PROXY = "https://lyrics.paxsenix.org";
const APPLE_SEARCH = "https://amp-api.music.apple.com/v1/catalog/us/search";
let appleToken: string | null = null;

function appleClean(s: string): string {
  return s
    .replace(
      /\s*[(\[](official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster\w*|live|version|feat\.?|ft\.?)[^)\]]*[)\]]/gi,
      ""
    )
    .trim();
}

function appleScore(track: { name: string; artist: string }, title: string, artist: string): number {
  const name = track.name.trim().toLowerCase();
  const wantTitle = title.trim().toLowerCase();
  const haveArtist = track.artist.trim().toLowerCase();
  const wantArtist = artist.trim().toLowerCase();
  let score = 0;
  if (name === wantTitle) score += 80;
  else if (name.includes(wantTitle) || wantTitle.includes(name)) score += 40;
  if (haveArtist.includes(wantArtist) || wantArtist.includes(haveArtist)) score += 40;
  return score;
}

async function scrapeAppleToken(): Promise<string | null> {
  const home = await getText("https://music.apple.com/us/new", 8000, {
    "User-Agent": UA,
    Accept: "text/html",
  });
  if (!home) return null;
  const scriptPath = /\/assets\/index~[^"]+\.js/.exec(home)?.[0];
  if (!scriptPath) return null;
  const script = await getText(`https://music.apple.com${scriptPath}`, 8000, {
    "User-Agent": UA,
    Accept: "*/*",
  });
  if (!script) return null;
  return /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(script)?.[0] ?? null;
}

async function getAppleToken(): Promise<string | null> {
  if (appleToken) return appleToken;
  appleToken = await scrapeAppleToken();
  return appleToken;
}

interface AppleCandidate {
  id: string;
  name: string;
  artist: string;
  durationSec: number | null;
}

async function appleSearch(query: string, token: string): Promise<AppleCandidate[] | null> {
  const url = `${APPLE_SEARCH}?term=${encodeURIComponent(query)}&types=songs&limit=10&l=en-US`;
  const body = await getText(url, 7000, {
    Authorization: `Bearer ${token}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "User-Agent": UA,
  });
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const data = json?.results?.songs?.data;
    if (!Array.isArray(data)) return null;
    return data.map((t) => ({
      id: String(t?.id ?? ""),
      name: String(t?.attributes?.name ?? ""),
      artist: String(t?.attributes?.artistName ?? ""),
      durationSec: t?.attributes?.durationInMillis
        ? Math.round(t.attributes.durationInMillis / 1000)
        : null,
    }));
  } catch {
    return null;
  }
}

interface PaxLyricsResponse {
  ttmlContent?: string | null;
  elrc?: string | null;
  elrcMultiPerson?: string | null;
}

/**
 * PaxSenix sometimes answers with a structured Apple payload instead of a
 * TTML document: a `content` array of rows, each carrying a millisecond
 * timestamp and a `text` array of per-word rows with their own timestamps.
 * Preserve the word timing rather than flattening it.
 */
function parsePaxStructured(root: unknown): SyncedLyricLine[] {
  const findContent = (node: unknown): any[] | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findContent(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.content) && obj.content.some((row) => row && typeof row === "object" && (row as any).timestamp != null)) {
      return obj.content as any[];
    }
    for (const value of Object.values(obj)) {
      const found = findContent(value);
      if (found) return found;
    }
    return null;
  };
  const rows = findContent(root);
  if (!rows?.length) return [];
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const start = typeof row.timestamp === "number" ? row.timestamp / 1000 : null;
    const wordRows = Array.isArray(row.text) ? row.text : null;
    if (start == null || !wordRows) continue;
    const nextStart =
      typeof (rows[i + 1] as Record<string, unknown> | undefined)?.timestamp === "number"
        ? (rows[i + 1] as Record<string, unknown>).timestamp as number / 1000
        : null;
    const words: SyncedLyricWord[] = [];
    for (let w = 0; w < wordRows.length; w++) {
      const word = wordRows[w] as Record<string, unknown>;
      const text = typeof word.text === "string" ? word.text.trim() : "";
      const wordStart = typeof word.timestamp === "number" ? word.timestamp / 1000 : null;
      if (!text || wordStart == null) continue;
      const nextWord = wordRows[w + 1] as Record<string, unknown> | undefined;
      const wordEnd =
        typeof nextWord?.timestamp === "number" ? nextWord.timestamp / 1000 : nextStart ?? wordStart + 0.8;
      words.push({ start: wordStart, end: Math.max(wordEnd, wordStart), text });
    }
    if (!words.length) continue;
    out.push({
      time: Math.min(start, words[0].start),
      text: words.map((w) => w.text).join(" "),
      words,
      end: nextStart ?? words[words.length - 1].end,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchPaxSenix(q: LyricQuery): Promise<ProviderResult | null> {
  const stripped = queryTitle(q.title);
  const artist = appleClean(primaryArtist(q.artist || ""));
  if (!stripped) return null;
  const edition = editionOf(q.title || "");
  // Apple indexes the actual edits — "Song (Sped Up)" is a real release — so
  // the rendition the upload names is queried before the stripped title.
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let token = await getAppleToken();
  if (!token) return null;

  const searchOnce = async (title: string): Promise<AppleCandidate[] | null> => {
    const query = [title, artist].filter(Boolean).join(" ");
    let results = await appleSearch(query, token!);
    if (!results) {
      // Apple said no — the token went stale. Mint a fresh one, once.
      appleToken = null;
      token = await getAppleToken();
      if (!token) return null;
      results = await appleSearch(query, token);
    }
    return results;
  };

  // The file's length must never veto the real song — music videos
  // with intros run longer than the catalogue track, and a hard ±10s filter
  // rejects Despacito-style songs wholesale. Title/artist score decides;
  // duration proximity only breaks ties. One exception: an upload that names
  // an edition ("Sped Up", "Slowed + Reverb") can only take a candidate whose
  // runtime is near its own — the studio cut would sing at the wrong tempo,
  // and no offset repairs that.
  const durDelta = (t: AppleCandidate): number =>
    q.duration <= 0 || t.durationSec == null ? 99999 : Math.abs(t.durationSec - q.duration);

  let best: AppleCandidate | undefined;
  let firstResults: AppleCandidate[] | null = null;
  for (const title of titles) {
    let results = await searchOnce(title);
    if (!results?.length) continue;
    firstResults = firstResults ?? results;
    if (edition && q.duration > 0) {
      const near = results.filter((t) => withinTolerance(t.durationSec, q.duration));
      if (!near.length) continue; // this query only found the wrong edition
      results = near;
    }
    best = [...results].sort(
      (a, b) => appleScore(b, title, artist) - appleScore(a, title, artist) || durDelta(a) - durDelta(b),
    )[0];
    if (best?.id) break;
  }
  if (!best?.id) {
    // Nothing edition-compatible anywhere: fall through to the plain best
    // match only for non-edition titles.
    if (edition || !firstResults?.length) return null;
    best = [...firstResults].sort(
      (a, b) =>
        appleScore(b, stripped, artist) - appleScore(a, stripped, artist) || durDelta(a) - durDelta(b),
    )[0];
  }
  if (!best?.id) return null;

  const body = await getText(
    `${PAXSENIX_PROXY}/apple-music/lyrics?id=${encodeURIComponent(best.id)}&ttml=true`,
    8000
  );
  if (!body) return null;
  try {
    const json: PaxLyricsResponse = JSON.parse(body);
    const structured = parsePaxStructured(json);
    if (structured.length) return toResult("PaxSenix", structured);
    // ttml=true makes the `content` field the TTML document itself; older
    // responses carried it as `ttmlContent`.
    for (const ttml of [json.ttmlContent, (json as any).content]) {
      if (typeof ttml === "string" && ttml.trim() && /<tt[\s>]/i.test(ttml)) {
        const lines = parseTtml(ttml);
        if (lines.length) return toResult("PaxSenix", lines);
      }
    }
    for (const elrc of [json.elrcMultiPerson, json.elrc]) {
      if (elrc?.trim()) {
        const lines = parseEnhancedLrc(elrc);
        if (lines.length) return toResult("PaxSenix", lines);
      }
    }
    console.log(
      `[bytune][lyrics-net] paxsenix no synced content for ${best.id}: keys=${Object.keys(json).join(",")} ttmlLen=${(json.ttmlContent ?? "").length}`
    );
    return null;
  } catch {
    console.log(`[bytune][lyrics-net] paxsenix unparseable body: ${body.slice(0, 120)}`);
    return null;
  }
}

/* ---------------------------- BetterLyrics ------------------------------ */

async function fetchBetterLyrics(q: LyricQuery): Promise<ProviderResult | null> {
  // Edition-titled uploads are asked under their own name first — the backend
  // indexes Apple's actual "(Sped Up)" releases — then the stripped title.
  const blStripped = queryTitle(q.title);
  const blFull = cleanTitle(q.title).trim();
  const titles =
    blFull && blFull.toLowerCase() !== blStripped.toLowerCase() ? [blFull, blStripped] : [blStripped];
  const attempt = (title: string, withDuration: boolean): string => {
    const params = new URLSearchParams({ s: title, a: primaryArtist(q.artist || "") });
    if (withDuration && q.duration > 0) params.set("d", String(Math.round(q.duration)));
    if (q.album) params.set("al", cleanTitle(q.album));
    return `https://lyrics-api.boidu.dev/getLyrics?${params.toString()}`;
  };
  // Same rule as the other word-synced sources: a strict duration miss
  // (the file's length ≠ catalogue runtime) retries on title+artist alone.
  let body: string | null = null;
  for (const title of titles) {
    body = await getText(attempt(title, true));
    if (!body && q.duration > 0) body = await getText(attempt(title, false));
    if (body) break;
  }
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const ttml = typeof json?.ttml === "string" ? json.ttml : null;
    if (!ttml) return null;
    return toResult("BetterLyrics", parseTtml(ttml));
  } catch {
    return null;
  }
}

/* -------------------------------- KuGou --------------------------------- */

/**
 * Line-synced lyrics from KuGou's public endpoints — a Chinese catalogue
 * that also carries a great many English and Hindi tracks the western
 * sources don't. Three unauthenticated calls: search the song for its
 * fingerprint hash, search lyrics candidates for that hash, download the
 * winner; a keyword search is the fallback.
 */
const KUGOU_TOLERANCE = 8;

function kugouStripCredits(lrc: string): string {
  const STAMPED = /^\[\d{2}:\d{2}\.\d{2,3}].*/;
  const CREDIT = /.+][^\[]+[:：].+/;
  const lines = lrc.split(/\r?\n/).filter((l) => STAMPED.test(l));
  if (!lines.length) return "";
  const headLimit = Math.min(30, lines.length - 1);
  let headCut = 0;
  for (let i = headLimit; i >= 0; i--) {
    if (CREDIT.test(lines[i])) {
      headCut = i + 1;
      break;
    }
  }
  const body = lines.slice(headCut);
  let tailCut = 0;
  for (let i = 0; i <= Math.min(30, body.length - 1); i++) {
    if (CREDIT.test(body[body.length - 1 - i])) {
      tailCut = i + 1;
      break;
    }
  }
  return body.slice(0, body.length - tailCut).join("\n");
}

async function fetchKuGou(q: LyricQuery): Promise<ProviderResult | null> {
  const stripParen = (s: string): string => s.replace(/[(（].*?[)）]/g, "").trim() || s;
  // "Title - Artist", or just the title when the row carried no real credit.
  const keyword = [stripParen(cleanTitle(q.title)), stripParen(primaryArtist(q.artist || ""))]
    .filter(Boolean)
    .join(" - ");
  const seconds = Math.round(q.duration);

  const download = async (id: string, accessKey: string): Promise<string | null> => {
    const params = new URLSearchParams({
      fmt: "lrc",
      charset: "utf8",
      client: "pc",
      ver: "1",
      id,
      accesskey: accessKey,
    });
    const body = await getText(`https://lyrics.kugou.com/download?${params.toString()}`);
    if (!body) return null;
    try {
      const json = JSON.parse(body);
      if (typeof json?.content !== "string") return null;
      return Buffer.from(json.content, "base64").toString("utf-8");
    } catch {
      return null;
    }
  };

  const searchLyrics = async (opts: { hash?: string; keyword?: string; seconds?: number }) => {
    const params = new URLSearchParams({ ver: "1", man: "yes", client: "pc" });
    if (opts.hash) params.set("hash", opts.hash);
    else {
      if (!opts.keyword) return [];
      params.set("keyword", opts.keyword);
      if (opts.seconds && opts.seconds > 0) params.set("duration", String(opts.seconds * 1000));
    }
    const body = await getText(`https://lyrics.kugou.com/search?${params.toString()}`);
    if (!body) return [];
    try {
      const json = JSON.parse(body);
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      return (candidates as any[])
        .map((c: any) => ({
          id: String(c?.id ?? ""),
          accesskey: String(c?.accesskey ?? ""),
          duration: Number(c?.duration) || 0,
        }))
        .filter((c) => c.id && c.accesskey);
    } catch {
      return [];
    }
  };

  // Path 1: hash chain, restricted to cuts within tolerance.
  if (seconds > 0) {
    const songBody = await getText(
      `https://mobileservice.kugou.com/api/v3/search/song?${new URLSearchParams({
        version: "9108",
        plat: "0",
        pagesize: "8",
        showtype: "0",
        keyword,
      }).toString()}`
    );
    if (songBody) {
      try {
        const json = JSON.parse(songBody);
        const info: { hash?: string; duration?: number }[] = json?.data?.info ?? [];
        const hashes = info
          .filter((i) => i.hash && Math.abs((i.duration ?? -1) - seconds) <= KUGOU_TOLERANCE)
          .sort((a, b) => Math.abs((a.duration ?? 0) - seconds) - Math.abs((b.duration ?? 0) - seconds))
          .map((i) => i.hash as string);
        for (const hash of hashes) {
          const candidates = await searchLyrics({ hash });
          if (candidates.length) {
            const lrc = await download(candidates[0].id, candidates[0].accesskey);
            if (lrc) {
              const lines = parseLrc(kugouStripCredits(lrc));
              if (lines.length) return toResult("KuGou", lines);
            }
          }
        }
      } catch {
        /* fall through to the keyword path */
      }
    }
  }

  // Path 2: keyword search fallback, scored by runtime proximity so the
  // studio cut doesn't outrank the sped-up edit that shares its name. An
  // upload that names an edition only accepts cuts within tolerance — a
  // different tempo never syncs, no matter the offset.
  const candidates = await searchLyrics({ keyword, seconds });
  if (candidates.length) {
    let pool = candidates;
    if (seconds > 0) {
      const near = pool.filter((c) => withinTolerance(c.duration, seconds));
      if (editionOf(q.title || "")) {
        if (!near.length) return null; // only the wrong edition answered
        pool = near;
      } else if (near.length) {
        pool = near;
      }
    }
    pool = [...pool].sort(
      (a, b) =>
        Math.abs((a.duration || 1e9) - seconds) - Math.abs((b.duration || 1e9) - seconds)
    );
    for (const candidate of pool.slice(0, 3)) {
      const lrc = await download(candidate.id, candidate.accesskey);
      if (lrc) {
        const lines = parseLrc(kugouStripCredits(lrc));
        if (lines.length) return toResult("KuGou", lines);
      }
    }
  }
  return null;
}

/* -------------------------------- LRCLIB -------------------------------- */

async function lrclibGet(path: string): Promise<any | null> {
  const body = await getText(`https://lrclib.net/api${path}`, 7000);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function lyricsFromLrclibRecord(rec: any): ProviderResult | null {
  const synced = typeof rec?.syncedLyrics === "string" && rec.syncedLyrics.trim() ? parseLrc(rec.syncedLyrics) : null;
  if (synced && synced.length >= 3) return toResult("LRCLIB", synced);
  const plain = typeof rec?.plainLyrics === "string" && rec.plainLyrics.trim() ? rec.plainLyrics : null;
  if (plain) return { source: "LRCLIB", wordSynced: false, lines: [], plainText: plain };
  if (synced && synced.length) return toResult("LRCLIB", synced);
  return null;
}

async function fetchLrclib(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = primaryArtist(q.artist || "");
  const stripped = queryTitle(q.title || "");
  if (!stripped) return null;
  const enc = encodeURIComponent;
  const edition = editionOf(q.title || "");
  // The rendition the upload names is queried first: "(Sped Up)" is a real
  // catalogue entry often enough, and the stripped title can only ever
  // answer with the normal cut.
  const full = cleanTitle(q.title || "").trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  for (const title of titles) {
    if (artist && q.duration > 0) {
      const album = q.album ? `&album_name=${enc(cleanTitle(q.album))}` : "";
      const rec = await lrclibGet(
        `/get?artist_name=${enc(artist)}&track_name=${enc(title)}${album}&duration=${Math.round(q.duration)}`
      );
      const exact = lyricsFromLrclibRecord(rec);
      if (exact) return exact;
    }
    if (artist) {
      const results = await lrclibGet(`/search?track_name=${enc(title)}&artist_name=${enc(artist)}`);
      const hit = pickLrclibSearchHit(results, q, edition);
      if (hit) return hit;
    }
  }
  const qResults = await lrclibGet(`/search?q=${enc(`${artist} ${stripped}`.trim())}`);
  return pickLrclibSearchHit(qResults, q, edition);
}

/**
 * Of the search records carrying synced lyrics, take the one whose own
 * runtime sits closest to the playing track — BitChord mobile's rule, and
 * the difference between the studio cut and the sped-up edit that shares
 * its name. When the upload itself names an edition, "closest" tightens to
 * "within tolerance": the studio cut is rejected outright, because no
 * offset can repair a different tempo.
 */
function pickLrclibSearchHit(results: any, q: LyricQuery, edition: string | null): ProviderResult | null {
  if (!Array.isArray(results)) return null;
  const synced = results.filter(
    (rec: any) => typeof rec?.syncedLyrics === "string" && rec.syncedLyrics.trim()
  );
  if (!synced.length) return null;
  const seconds = Math.round(q.duration);
  if (seconds <= 0) return lyricsFromLrclibRecord(synced[0]);
  const near = synced.filter((rec: any) => withinTolerance(rec?.duration, seconds));
  if (edition && !near.length) return null; // only the wrong edition answered
  const pool = near.length ? near : synced;
  const best = pool.reduce((a: any, b: any) =>
    Math.abs((b?.duration ?? 1e9) - seconds) < Math.abs((a?.duration ?? 1e9) - seconds) ? b : a
  );
  return lyricsFromLrclibRecord(best);
}

/* ------------------------------ BiniLyrics ------------------------------- */

/**
 * Apple Music TTML from the Bini backend — and the only source here that
 * will answer to a recording rather than to a name. Its search also reports
 * the ISRC of whatever it matched, which is remembered against the video id
 * and handed to the sources that can use it (LyricsPlus takes one; Bini's own
 * re-lookups go straight to the recording).
 */
const BINI_BASE = "https://lyrics-api.binimum.org";
const IDENTIFY_TIMEOUT_MS = 2500;

interface RecordingHit {
  isrc: string | null;
  lyricsUrl: string | null;
}

const isrcCache = new Map<string, string>();
const ISRC_CACHE_MAX = 500;

function rememberIsrc(videoId: string, isrc: string): void {
  if (!videoId || !isrc) return;
  isrcCache.set(videoId, isrc);
  while (isrcCache.size > ISRC_CACHE_MAX) {
    const oldest = isrcCache.keys().next().value;
    if (oldest === undefined) break;
    isrcCache.delete(oldest);
  }
}

interface BiniSearchParams {
  isrc?: string;
  track?: string;
  artist?: string;
  album?: string;
  duration?: number;
}

async function biniSearch(opts: BiniSearchParams): Promise<RecordingHit | null> {
  const params = new URLSearchParams();
  if (opts.isrc) {
    // Nothing else is worth sending: the recording is named, and a title
    // alongside it could only ever disagree with it.
    params.set("isrc", opts.isrc);
  } else {
    if (!opts.track) return null;
    params.set("track", opts.track);
    if (opts.artist) params.set("artist", opts.artist);
    if (opts.album) params.set("album", opts.album);
    if (opts.duration && opts.duration > 0) params.set("duration", String(Math.round(opts.duration)));
  }
  const body = await getText(`${BINI_BASE}/?${params.toString()}`, 2500);
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const hit = Array.isArray(json?.results) ? json.results[0] : null;
    if (!hit) return null;
    return { isrc: hit.isrc ?? null, lyricsUrl: hit.lyricsUrl ?? null };
  } catch {
    return null;
  }
}

/**
 * Which recording this is, before anybody is asked for words. One small
 * search; its ISRC is kept against the video id so a track asked about twice
 * pays for this once. Capped well under the sweep deadline — a slow identify
 * is a skipped source, never a late lyric.
 */
function identifyRecording(q: LyricQuery): Promise<RecordingHit | null> {
  const cached = q.id ? isrcCache.get(q.id) : undefined;
  if (cached) return Promise.resolve({ isrc: cached, lyricsUrl: null });
  const search = biniSearch({
    track: cleanTitle(q.title || ""),
    artist: primaryArtist(q.artist || ""),
    album: q.album ? cleanTitle(q.album) : undefined,
    duration: q.duration,
  })
    .then((hit) => {
      if (hit?.isrc && q.id) rememberIsrc(q.id, hit.isrc);
      return hit;
    })
    .catch((): RecordingHit | null => null);
  return Promise.race([
    search,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), IDENTIFY_TIMEOUT_MS)),
  ]);
}

async function fetchBini(q: LyricQuery, hitPromise: Promise<RecordingHit | null>): Promise<ProviderResult | null> {
  const hit = await hitPromise;
  if (!hit) return null;
  let url = hit.lyricsUrl;
  // A remembered ISRC names the recording but carries no document URL — one
  // exact search fills it in.
  if (!url && hit.isrc) {
    const fresh = await biniSearch({ isrc: hit.isrc });
    if (!fresh?.lyricsUrl) return null;
    url = fresh.lyricsUrl;
  }
  if (!url) return null;
  const ttml = await getText(url, 7000, { Accept: "*/*" });
  if (!ttml) return null;
  const lines = parseTtml(ttml);
  return lines.length ? toResult("BiniLyrics", lines) : null;
}

/* -------------------------- BetterLyrics Portato ------------------------- */

/**
 * QQ Music's karaoke timings through BetterLyrics' Portato endpoint — word
 * timing for the sizable slice of the catalogue (C-pop, J-pop, regional
 * releases) Apple doesn't carry. The endpoint now demands an API key for
 * queries its cache has never seen, so a 401 saying so parks the source for
 * the session rather than burning four dead requests on every track; cached
 * queries still answer keyless, and a new session asks again.
 */
let portatoKeyGated = false;

async function fetchPortato(q: LyricQuery): Promise<ProviderResult | null> {
  if (portatoKeyGated) return null;
  const stripped = queryTitle(q.title);
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];
  const attempt = (title: string, withDuration: boolean): string => {
    const params = new URLSearchParams({ s: title, a: primaryArtist(q.artist || "") });
    if (withDuration && q.duration > 0) params.set("d", String(Math.round(q.duration)));
    if (q.album) params.set("al", cleanTitle(q.album));
    return `https://lyrics-api.boidu.dev/qq/getLyrics?${params.toString()}`;
  };
  for (const title of titles) {
    let body = await getText(attempt(title, true));
    // Same rule as the other word-synced sources: a strict duration miss
    // (the file's length ≠ catalogue runtime) retries on title+artist alone.
    if (!body && q.duration > 0) body = await getText(attempt(title, false));
    if (!body) continue;
    if (/API key required/i.test(body)) {
      portatoKeyGated = true;
      return null;
    }
    const parsed = parseProviderAny(body);
    if (!parsed) continue;
    if ("plain" in parsed) return { source: "Portato", wordSynced: false, lines: [], plainText: parsed.plain };
    return toResult("Portato", parsed);
  }
  return null;
}

/* -------------------------------- Unison --------------------------------- */

/**
 * Community-submitted lyrics — the only source here whose contents are
 * contributed rather than licensed, so it occasionally carries a track none
 * of the catalogues do. Three shapes come back, and the entry says which:
 * Apple-style TTML, stamped LRC, or plain text with no timing at all.
 */
async function fetchUnison(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = primaryArtist(q.artist || "");
  // The endpoint 400s on an empty artist rather than searching song-only.
  if (!artist) return null;
  const params = new URLSearchParams({
    song: queryTitle(q.title),
    artist,
  });
  if (q.album) params.set("album", cleanTitle(q.album));
  if (q.duration > 0) params.set("duration", String(Math.round(q.duration)));
  const body = await getText(`https://unison.boidu.dev/lyrics?${params.toString()}`);
  if (!body) return null;
  let entry: { lyrics?: unknown; format?: unknown; syncType?: unknown };
  try {
    const json = JSON.parse(body);
    if (json?.success !== true) return null;
    entry = json.data ?? {};
  } catch {
    return null;
  }
  const text = typeof entry.lyrics === "string" ? entry.lyrics : "";
  if (!text.trim()) return null;
  const plain = (): ProviderResult | null => {
    const joined = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    return joined ? { source: "Unison", wordSynced: false, lines: [], plainText: joined } : null;
  };
  if (String(entry.format ?? "").toLowerCase() === "ttml") {
    const lines = parseTtml(text);
    if (lines.length) return toResult("Unison", lines);
  }
  if (String(entry.syncType ?? "").toLowerCase() === "plain") return plain();
  const enhanced = parseEnhancedLrc(text);
  if (enhanced.length) return toResult("Unison", enhanced);
  const lrc = parseLrc(text);
  if (lrc.length) return toResult("Unison", lrc);
  return plain();
}

/* ------------------------------- Megalobiz ------------------------------- */

/** Line-synced community LRC scraped from Megalobiz. */
async function fetchMegalobiz(q: LyricQuery): Promise<ProviderResult | null> {
  const stripParen = (s: string): string => s.replace(/[(（].*?[)）]/g, "").trim() || s;
  const keyword = [stripParen(primaryArtist(q.artist || "")), stripParen(queryTitle(q.title))]
    .filter(Boolean)
    .join(" ");
  if (!keyword) return null;
  const page = await getText(
    `https://www.megalobiz.com/searchall?qry=${encodeURIComponent(keyword)}`,
    7000,
    { Accept: "text/html" }
  );
  if (!page) return null;
  const path = /href=["']([^"']*\/lrc\/maker\/download\/[^"']+)["']/i.exec(page)?.[1];
  if (!path) return null;
  const detail = await getText(`https://www.megalobiz.com${path.replace(/&amp;/g, "&")}`, 7000, {
    Accept: "text/html",
  });
  if (!detail) return null;
  const raw = /id=["']lrc_[^"']*_details["'][^>]*>([\s\S]*?)<\/span>/i.exec(detail)?.[1];
  if (!raw) return null;
  const lrc = raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  const lines = parseLrc(decodeEntities(lrc));
  return lines.some((l) => l.text.trim()) ? toResult("Megalobiz", lines) : null;
}

/* ------------------------------- Musixmatch ------------------------------ */

/**
 * Rich word timing, with a line-synced fallback, from Musixmatch's web API —
 * the biggest lyrics catalogue there is, and one none of the sources above
 * can stand in for.
 *
 * No user key: requests are signed the way Musixmatch's own web client signs
 * them — HMAC-SHA256 over `<url><UTC date>` with a rotating key scraped from
 * the client's JavaScript (a hardcoded copy stands in when the page is
 * briefly unavailable). The user token it issues is cached, and an auth
 * failure inside an otherwise-successful response mints a fresh pair once.
 */
const MUSIXMATCH_BASE = "https://apic.musixmatch.com/ws/1.1";
const MUSIXMATCH_APP_ID = "mobile-app-v1.0";
const MUSIXMATCH_FALLBACK_SECRET = "f09016176ba43a1cfd1031fbd6b3d26c";

let mxSecret: string | null = null;
let mxToken: string | null = null;
const mxGuid = randomUUID();

/** Signs `<url><UTC yyyyMMdd>` with HMAC-SHA256, matching the web client. */
function mxSign(url: string, secret: string): string {
  const normalized = url.replace(/%20/g, "+").replace(/ /g, "+");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const signature = createHmac("sha256", secret).update(`${normalized}${date}`).digest("base64");
  return `${normalized}&signature=${encodeURIComponent(signature)}&signature_protocol=sha256`;
}

async function mxBrowserGet(url: string, accept: string): Promise<string | null> {
  return getText(url, 8000, {
    "User-Agent": UA,
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: "mxm_bab=AB",
  });
}

/** Reads the rotating signing key from the JavaScript linked by the web client. */
async function mxGetSecret(): Promise<string> {
  if (mxSecret) return mxSecret;
  try {
    const page = await mxBrowserGet("https://www.musixmatch.com/search", "text/html,application/xhtml+xml");
    if (page) {
      const script = /src=["']([^"']*\/_next\/static\/chunks\/pages\/_app-[^"']+\.js)["']/i.exec(page)?.[1];
      if (script) {
        const scriptUrl = new URL(script, "https://www.musixmatch.com").toString();
        const js = await mxBrowserGet(scriptUrl, "*/*");
        if (js) {
          const encoded = /from\(\s*["']([^"']+)["']\s*\.split/.exec(js)?.[1];
          if (encoded) {
            const secret = Buffer.from(encoded.split("").reverse().join(""), "base64").toString("utf-8");
            if (secret.trim()) {
              mxSecret = secret;
              return secret;
            }
          }
        }
      }
    }
  } catch {
    /* fall through to the baked-in key */
  }
  mxSecret = MUSIXMATCH_FALLBACK_SECRET;
  return mxSecret;
}

async function mxGetToken(secret: string): Promise<string | null> {
  if (mxToken) return mxToken;
  const url = `${MUSIXMATCH_BASE}/token.get?${new URLSearchParams({
    app_id: MUSIXMATCH_APP_ID,
    guid: mxGuid,
    format: "json",
  })}`;
  const body = await getText(mxSign(url, secret), 8000, { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" });
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const token = json?.message?.body?.user_token;
    if (json?.message?.header?.status_code === 200 && typeof token === "string" && token) {
      mxToken = token;
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

/** Musixmatch reports an expired token inside a successful HTTP response. */
function mxLooksUnauthorized(body: string): boolean {
  try {
    const status = JSON.parse(body)?.message?.header?.status_code;
    return status === 401 || status === 402;
  } catch {
    return false;
  }
}

async function mxSignedGet(buildUrl: (token: string) => string): Promise<string | null> {
  const secret = await mxGetSecret();
  const token = await mxGetToken(secret);
  if (!token) return null;
  const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };
  const first = await getText(mxSign(buildUrl(token), secret), 8000, headers);
  if (first && !mxLooksUnauthorized(first)) return first;
  mxToken = null;
  mxSecret = null;
  const freshSecret = await mxGetSecret();
  const freshToken = await mxGetToken(freshSecret);
  if (!freshToken) return null;
  const second = await getText(mxSign(buildUrl(freshToken), freshSecret), 8000, headers);
  return second && !mxLooksUnauthorized(second) ? second : null;
}

interface MxTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  trackLength: number | null;
  hasSubtitles: number | null;
  hasRichsync: number | null;
}

function mxScore(track: MxTrack, title: string, artist: string, seconds: number): number {
  let score = 0;
  const name = track.trackName.trim().toLowerCase();
  const wantTitle = title.trim().toLowerCase();
  if (name === wantTitle) score += 80;
  else if (name.includes(wantTitle) || wantTitle.includes(name)) score += 40;
  const haveArtist = track.artistName.trim().toLowerCase();
  const wantArtist = artist.trim().toLowerCase();
  if (wantArtist && haveArtist.includes(wantArtist)) score += 40;
  if (track.trackLength && seconds > 0) {
    const diff = Math.abs(track.trackLength - seconds);
    score += diff <= 2 ? 30 : diff <= 5 ? 15 : diff <= 10 ? 5 : -20;
  }
  return score;
}

/**
 * Decodes Musixmatch's rich-sync JSON without flattening it through line
 * LRC. Fragment order is retained — punctuation and syllable fragments may
 * share a stamp. All times arrive in seconds.
 */
function parseMusixmatchRichSync(body: string): SyncedLyricLine[] {
  let entries: any[];
  try {
    entries = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out: SyncedLyricLine[] = [];
  for (const entry of entries) {
    const lineStart = Number(entry?.ts) || 0;
    const lineEnd = Math.max(lineStart, Number(entry?.te) || lineStart);
    const fragments: any[] = Array.isArray(entry?.l) ? entry.l : [];
    const words: SyncedLyricWord[] = [];
    let cur: { start: number; end: number; text: string } | null = null;
    let prevStart = lineStart;
    const flush = (): void => {
      if (!cur) return;
      const text = cur.text.trim();
      if (text) words.push({ start: cur.start, end: Math.max(cur.start, cur.end), text });
      cur = null;
    };
    fragments.forEach((fragment, index) => {
      const raw = typeof fragment?.c === "string" ? fragment.c : "";
      if (!raw) return;
      const start = Math.max(lineStart, prevStart, lineStart + (Number(fragment.o) || 0));
      const nextOffset = fragments[index + 1] ? Number(fragments[index + 1].o) || 0 : null;
      const next = nextOffset != null ? lineStart + nextOffset : lineEnd;
      const end = Math.max(start, Math.min(lineEnd, next));
      prevStart = start;
      if (/^\s/.test(raw)) flush();
      const content = raw.trim();
      if (content) {
        if (!cur) cur = { start, end, text: content };
        else {
          cur.text += content;
          cur.end = end;
        }
      }
      if (/\s$/.test(raw)) flush();
    });
    flush();
    const text = String(entry?.x ?? "").trim() || words.map((w) => w.text).join(" ");
    if (!text) continue;
    out.push({
      time: Math.min(lineStart, words[0]?.start ?? lineStart),
      text,
      words,
      end: lineEnd > lineStart ? lineEnd : undefined,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Musixmatch's `mxm` subtitle JSON, converted only for the line-sync fallback. */
function mxSubtitleToLrc(body: string): string | null {
  let lines: any[];
  try {
    lines = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(lines)) return null;
  const out: string[] = [];
  for (const line of lines) {
    const text = String(line?.text ?? "");
    if (!text.trim()) continue;
    const totalMs = Math.round((Number(line?.time?.total) || 0) * 1000);
    const mm = Math.floor(totalMs / 60000);
    const ss = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    out.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}]${text}`
    );
  }
  return out.length ? out.join("\n") : null;
}

async function fetchMusixmatch(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = primaryArtist(q.artist || "");
  const seconds = Math.round(q.duration);
  const stripped = queryTitle(q.title);
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let best: MxTrack | null = null;
  for (const title of titles) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.search?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        q_track: title,
        q_artist: artist,
        f_has_lyrics: "1",
        s_track_rating: "desc",
        quorum_factor: "1",
        page_size: "10",
        page: "1",
        usertoken: token,
      })}`
    );
    if (!body) continue;
    try {
      const list = JSON.parse(body)?.message?.body?.track_list ?? [];
      for (const wrapper of list) {
        const t = wrapper?.track;
        if (!t?.track_id) continue;
        const candidate: MxTrack = {
          trackId: t.track_id,
          trackName: String(t.track_name ?? ""),
          artistName: String(t.artist_name ?? ""),
          trackLength: t.track_length ?? null,
          hasSubtitles: t.has_subtitles ?? null,
          hasRichsync: t.has_richsync ?? null,
        };
        if (!best || mxScore(candidate, title, artist, seconds) > mxScore(best, title, artist, seconds)) {
          best = candidate;
        }
      }
    } catch {
      /* try the next title variant */
    }
    if (best) break;
  }
  if (!best) return null;

  // The subtitle endpoint is line-timed by design. Prefer the separate
  // rich-sync tier so tracks that have syllable data are not flattened on
  // ingestion.
  if (best.hasRichsync) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.richsync.get?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        track_id: String(best!.trackId),
        usertoken: token,
      })}`
    );
    if (body) {
      try {
        const richsyncBody = JSON.parse(body)?.message?.body?.richsync?.richsync_body;
        if (typeof richsyncBody === "string" && richsyncBody.trim()) {
          const lines = parseMusixmatchRichSync(richsyncBody);
          if (lines.some((l) => l.words?.length)) return toResult("Musixmatch", lines);
        }
      } catch {
        /* fall through to the subtitle */
      }
    }
  }

  if (best.hasSubtitles) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.subtitle.get?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        track_id: String(best!.trackId),
        subtitle_format: "mxm",
        usertoken: token,
      })}`
    );
    if (body) {
      try {
        const subtitleBody = JSON.parse(body)?.message?.body?.subtitle?.subtitle_body;
        if (typeof subtitleBody === "string" && subtitleBody.trim()) {
          const lrc = mxSubtitleToLrc(subtitleBody);
          if (lrc) {
            const lines = parseLrc(lrc);
            if (lines.length) return toResult("Musixmatch", lines);
          }
        }
      } catch {
        /* give up quietly */
      }
    }
  }
  return null;
}

/* --------------------------------- Genius -------------------------------- */

/**
 * The song's Genius page; see geniusFindWith. Lyrics and song info share it.
 */
export function geniusFindSong(songTitle: string, songArtist: string): Promise<{ id: number; url: string } | null | undefined> {
  return geniusFindWith(songTitle, songArtist, (url) => getText(url, 8000, GENIUS_HEADERS));
}

async function fetchGenius(q: LyricQuery): Promise<ProviderResult | null> {
  const song = await geniusFindSong(q.title, q.artist);
  if (!song) return null;
  const html = await getText(song.url, 9000, GENIUS_HEADERS);
  if (!html) return null;
  const text = await geniusExtractLyrics(html);
  return text ? { source: "Genius", wordSynced: false, lines: [], plainText: text } : null;
}

/* ------------------------------ repository ------------------------------ */

export interface FetchedLyrics {
  source: string;
  wordSynced: boolean;
  synced: SyncedLyricLine[] | null;
  plain: string | null;
}

/**
 * Collect the provider sweep's answers as they land, but stop waiting at the
 * deadline: healthy sources answer in a few hundred milliseconds, while the
 * slow chains (a cold Apple token scrape, Musixmatch's signed handshake, a
 * KuGou hash walk) can run for several seconds — and an all-settled wait made
 * every track's lyrics late by the slowest provider. At the deadline the pick
 * runs on whatever has landed, while the stragglers keep running in the
 * background where they still warm their session caches (Apple token,
 * Musixmatch secret, last-good LyricsPlus mirror) for the next track.
 *
 * When NOTHING has landed by the fast deadline the wait extends once: on an
 * obscure track the slow chains are often the only ones that carry it, and
 * cutting them at 1.5s would answer "no lyrics" to exactly the songs the
 * sweep was asked for. The extension is bounded (HARD_DEADLINE) so a sweep
 * can never hold the view open indefinitely; a genuinely dead network still
 * resolves fast, because its providers fail their connections rather than
 * hang.
 */
const SWEEP_DEADLINE_MS = 1500;
const SWEEP_HARD_DEADLINE_MS = 5000;

async function settledWithin(
  jobs: Promise<ProviderResult | null>[]
): Promise<{ results: (ProviderResult | null)[]; arrived: boolean[] }> {
  const results: (ProviderResult | null)[] = new Array(jobs.length).fill(null);
  const arrived: boolean[] = new Array(jobs.length).fill(false);
  return new Promise((resolve) => {
    let pending = jobs.length;
    let finished = false;
    const finish = (): void => {
      if (!finished) {
        finished = true;
        clearTimeout(fastTimer);
        clearTimeout(hardTimer);
        resolve({ results, arrived });
      }
    };
    const fastTimer = setTimeout(() => {
      // A provider that merely SETTLED isn't enough — with fourteen sources,
      // the quick failures (a gated endpoint, a 403, a miss) always beat the
      // slow chains, and settling on them would turn the extension off for
      // exactly the obscure tracks it exists for. Only a usable answer ends
      // the fast window.
      if (results.some(Boolean)) finish();
    }, SWEEP_DEADLINE_MS);
    const hardTimer = setTimeout(finish, SWEEP_HARD_DEADLINE_MS);
    // Each job already swallows its own rejections (.catch → null).
    jobs.forEach((job, i) => {
      void job.then((v) => {
        results[i] = v;
        arrived[i] = true;
        if (--pending === 0) {
          finish();
        }
      });
    });
  });
}

/**
 * Default priority order — BitChord mobile's: the word-synced sources lead
 * (BiniLyrics, BetterLyrics, Portato, PaxSenix, LyricsPlus), then Unison, then
 * the line-synced workhorses (Megalobiz, KuGou, LRCLIB, Musixmatch), with
 * Genius's plain text last. Every provider is asked at once; answers are
 * taken in priority order. The sweep is deadline-bounded (settledWithin) so
 * the lyrics land within ~1.5s of the track change even when a provider
 * chain crawls.
 */
const PROVIDER_NAMES = [
  "BiniLyrics",
  "BetterLyrics",
  "Portato",
  "PaxSenix",
  "LyricsPlus",
  "Unison",
  "Megalobiz",
  "KuGou",
  "LRCLIB",
  "Musixmatch",
  "Genius",
] as const;

export async function fetchLyrics(
  q: LyricQuery,
  opts: { prioritizeWordSync: boolean }
): Promise<FetchedLyrics | null> {
  // Which recording is this? One small ISRC search, run alongside the sweep:
  // BiniLyrics consumes its document URL, and the ISRC it reports is kept
  // against the video id for LyricsPlus and Bini's own later lookups.
  const hitPromise = identifyRecording(q);
  const cachedIsrc = q.id ? isrcCache.get(q.id) : undefined;

  const jobs: Promise<ProviderResult | null>[] = [
    fetchBini(q, hitPromise),
    fetchBetterLyrics(q),
    fetchPortato(q),
    fetchPaxSenix(q),
    fetchLyricsPlus(q, cachedIsrc),
    fetchUnison(q),
    fetchMegalobiz(q),
    fetchKuGou(q),
    fetchLrclib(q),
    fetchMusixmatch(q),
    fetchGenius(q),
  ].map((p) => p.catch((): ProviderResult | null => null));
  const { results: answers, arrived } = await settledWithin(jobs);
  // An instrumental's "纯音乐，请欣赏" is a provider saying there are no lyrics.
  const placeholder = answers.map(
    (r) => !!r && isPlaceholderLyrics(r.plainText ? r.plainText.split(/\r?\n/) : r.lines.map((l) => l.text))
  );
  const results = answers.map((r, i) => (placeholder[i] ? null : r));
  // Temporary diagnostics: which providers answered, and what won.
  results.forEach((r, i) => {
    const name = PROVIDER_NAMES[i];
    if (!arrived[i]) {
      console.log(`[bytune][lyrics] ${name}: still running at the deadline`);
    } else if (placeholder[i]) {
      console.log(`[bytune][lyrics] ${name}: no lyrics (instrumental placeholder)`);
    } else if (r) {
      const last = r.lines.length ? r.lines[r.lines.length - 1].time : null;
      console.log(`[bytune][lyrics] ${name}: ${r.lines.length} lines last=${last?.toFixed(1)} plain=${!!r.plainText} word=${r.wordSynced}`);
    } else {
      console.log(`[bytune][lyrics] ${name}: rejected/failed`);
    }
  });

  // A lyrics answer must COVER the track: crowd mirrors sometimes answer with
  // the first section only, and a complete line-synced set from a lower-priority
  // source beats a third of a word-synced one. "Complete" means the last line
  // lands past 60% of the runtime (when the runtime is known). And an upload
  // that names an edition must never take a cut that keeps singing long after
  // it ends — that is the studio cut of a sped-up upload, and every second of
  // it would drift worse than the last.
  const edition = editionOf(q.title || "");
  const covers = (r: ProviderResult): boolean => {
    if (!r.lines.length || q.duration <= 0) return true;
    const last = r.lines[r.lines.length - 1].time;
    if (last < q.duration * 0.6) return false;
    if (edition && last > q.duration + Math.max(20, q.duration * 0.15)) return false;
    return true;
  };
  const byKind = (pred: (r: ProviderResult) => boolean): ProviderResult | null =>
    results.find((r) => r && pred(r)) ?? null;

  const complete = (r: ProviderResult): boolean => r.lines.length > 0 && covers(r);
  const wordComplete = byKind((r) => r.wordSynced && complete(r));
  const lineComplete = byKind((r) => !r.wordSynced && complete(r));
  const wordPartial = byKind((r) => r.wordSynced && r.lines.length > 0);
  const linePartial = byKind((r) => r.lines.length > 0);
  const plainRanked = byKind((r) => !!r.plainText);

  // BitChord's rule: a word-timed answer wins outright; failing that, a
  // line-timed one from the highest-priority source that has it; plain text
  // only when nothing at all is timed. (ByTune keeps its completeness guard
  // on top: a whole line-synced set beats a third of a word-synced one.)
  const pick = opts.prioritizeWordSync
    ? wordComplete ?? lineComplete ?? wordPartial ?? linePartial ?? plainRanked
    : lineComplete ?? wordComplete ?? linePartial ?? wordPartial ?? plainRanked;
  console.log(`[bytune][lyrics] WINNER: ${pick?.source ?? "none"} lines=${pick?.lines.length ?? 0} plain=${!!pick?.plainText}`);

  if (pick) {
    if (pick.plainText) {
      return { source: pick.source, wordSynced: false, synced: null, plain: pick.plainText };
    }
    return { source: pick.source, wordSynced: pick.wordSynced, synced: pick.lines, plain: null };
  }
  return null;
}
