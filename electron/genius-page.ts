/**
 * Plain-text lyrics out of a Genius page: no timings, but a catalogue so large
 * it is the last resort that almost always answers. The computer's part only:
 * genius.ts next to it also goes into the phone app, which has no use for a parser.
 */
export async function geniusExtractLyrics(html: string): Promise<string | null> {
  const { parse } = await import("node-html-parser");
  const doc = parse(html);
  let containers = doc.querySelectorAll('div[data-lyrics-container="true"]');
  if (!containers.length) containers = doc.querySelectorAll("div.lyrics");
  if (!containers.length) return null;
  const parts: string[] = [];
  for (const container of containers) {
    const notLyrics = container.querySelectorAll(
      '[data-exclude-from-selection="true"], .LyricsHeader__Container, .SongBioPreview__Container, .InreadAd__Container, button, script, style'
    );
    for (const node of notLyrics) node.remove();
    for (const br of container.querySelectorAll("br")) br.replaceWith("\n");
    for (const p of container.querySelectorAll("p")) p.before("\n");
    const text = container.textContent;
    if (text.trim()) parts.push(text);
  }
  const cleaned = parts
    .join("\n")
    .replace(/ /g, " ")
    .replace(/​/g, " ")
    .replace(/﻿/g, " ")
    .replace(/\d*You might also like/gi, "")
    .trim()
    .replace(/\d*Embed\s*$/i, "")
    .trim();
  return cleaned || null;
}
