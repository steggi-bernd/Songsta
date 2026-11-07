/**
 * How a song's credit and title are put to the lyric and song databases. Pure
 * code: the desktop and the phone share it.
 */

/** Placeholders the mixed search page prints when a row carries no credit
 * links ("Unknown artist", same as BitChord mobile) — never a real credit,
 * so the lyric databases must not be asked with it: they key on artist +
 * title and miss every such track. An empty artist degrades each provider
 * to title-based matching instead. */
const PLACEHOLDER_ARTISTS = new Set(["", "unknown artist", "unknown", "various artists", "artist"]);

export function primaryArtist(artist: string): string {
  const lead = artist
    .split(/,|;| & | feat\. | ft\. | featuring /i)[0]
    .replace(/\s*\(.*?\)\s*/g, "")
    .trim();
  return PLACEHOLDER_ARTISTS.has(lead.toLowerCase()) ? "" : lead;
}

/**
 * Title for provider QUERIES: strips any parenthetical/bracket too — YT Music
 * titles carry credit noise like "WILDFLOWER (BILLIE BY FINNEAS)", and every
 * catalogue 401s or mismatches on it. The display title stays untouched.
 */
export function queryTitle(title: string): string {
  const base = cleanTitle(title)
    .replace(/\([^)]*\)|\[[^\]]*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return base || cleanTitle(title);
}

/** Strip the noise titles from the web carry: "(Official Video)", "[HD]" … */
export function cleanTitle(title: string): string {
  return title
    .replace(/\((official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|visualizer?|mv)\)/gi, "")
    .replace(/\[(official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|hd|4k)\]/gi, "")
    .replace(/\s*-\s*(official|lyric|audio|video).*$/i, "")
    .replace(/\|.*$/, "")
    .trim();
}
