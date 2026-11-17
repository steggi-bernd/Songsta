import { T } from "./i18n";
/**
 * The lyric lookup's stand-in copy, BitChord mobile's own word list
 * (strings.xml `lyrics_loading_lines`).
 *
 * While a lookup is in flight the loading view shows one of the loading
 * lines instead of a bare spinner. Callers pick once per track (memo keyed on
 * the track id) and hold the line there — the way the phone keys its pick to
 * the track so the copy never flickers on recomposition.
 */

export const LYRICS_LOADING_LINES: string[] = [
  T("Getting the lyrics"),
  T("Finding the words"),
  T("Fetching the verses"),
  T("Lyrics are loading"),
  T("Checking the lyric sheet"),
  T("Searching the songbook"),
  T("Lining up the lyrics"),
  T("Words are on the way"),
  T("Checking the archives"),
  T("Finding the right words"),
  T("Lyrics are coming together"),
  T("Almost found the words"),
];

export function pickLyricsLine(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0];
}
