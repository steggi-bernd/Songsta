/**
 * Genres as people mean them, not as tags spell them (the user wasn't happy with how genres were
 * sorted, 2026-11-15):
 *
 *  - a tag holding several genres splits at ";" and "," and at "/" between genres, but a name that
 *    has a slash in it stays whole ("Singer/Songwriter", "R&B/Soul", "Hip-Hop/Rap");
 *  - spellings that mean the same are one genre: "Hip Hop", "Hip-Hop" and "HipHop", "RnB" and "R&B",
 *    "Drum n Bass" and "Drum & Bass" (genreKey folds case, spaces, dashes and "&"/"and");
 *  - every genre belongs to one family (familyOf), for a rougher look and for Klingt wie's filter.
 *
 * Pure, one copy for the desktop and the phone.
 */

/** Names with a slash in them that are one genre. */
const WHOLE = ["singer/songwriter", "r&b/soul", "hip-hop/rap", "hip hop/rap", "rap/hip-hop", "dance/electronic", "electronic/dance", "christian/gospel", "children's music/kids", "new age/meditation", "reggae/dancehall"];
const WHOLE_KEYS = new Set(WHOLE.map((w) => w.replace(/\s+/g, "")));

/** One key for the spellings of one genre: "Hip-Hop", "hip hop", "HipHop" → "hiphop". */
export function genreKey(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\band\b|\bn\b|'n'|&/g, "and")
    .replace(/[\s\-_.'’]+/g, "");
}

/** How a few well-known genres are written, whatever the tag said. */
const SPELLED: Record<string, string> = {
  hiphop: "Hip-Hop",
  hiphoprap: "Hip-Hop/Rap",
  raphiphop: "Hip-Hop/Rap",
  rnb: "R&B",
  randb: "R&B",
  rhythmandblues: "R&B",
  randbsoul: "R&B/Soul",
  rnbsoul: "R&B/Soul",
  drumandbass: "Drum & Bass",
  dnb: "Drum & Bass",
  lofi: "Lo-Fi",
  lofihiphop: "Lo-Fi Hip-Hop",
  synthpop: "Synth-Pop",
  kpop: "K-Pop",
  jpop: "J-Pop",
  edm: "EDM",
  idm: "IDM",
  ost: "Soundtrack",
  soundtracks: "Soundtrack",
  originalsoundtrack: "Soundtrack",
  filmscore: "Film Score",
  singersongwriter: "Singer/Songwriter",
  postrock: "Post-Rock",
  postpunk: "Post-Punk",
  triphop: "Trip-Hop",
  electronica: "Electronica",
  electronic: "Electronic",
  electro: "Electro",
  danceandelectronic: "Dance/Electronic",
  electronicanddance: "Dance/Electronic",
};

/** A genre as it's shown: the well-known spelling, else the tag's own, tidied. */
export function genreName(raw: string): string {
  const tidy = raw.replace(/\s+/g, " ").trim();
  return SPELLED[genreKey(tidy)] ?? tidy;
}

/** The genres a tag holds: "Rock; Indie", "Rock/Indie" → two; "Singer/Songwriter" → one. */
export function splitGenres(tag: string | undefined): string[] {
  if (!tag) return [];
  const out: string[] = [];
  for (const part of tag.split(/\s*[;,]\s*/)) {
    if (!part.trim()) continue;
    if (!part.includes("/") || WHOLE_KEYS.has(part.toLowerCase().replace(/\s+/g, ""))) {
      out.push(genreName(part));
      continue;
    }
    for (const piece of part.split(/\s*\/\s*/)) if (piece.trim()) out.push(genreName(piece));
  }
  // One genre once, however it was spelled.
  const seen = new Set<string>();
  return out.filter((g) => {
    const key = genreKey(g);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type GenreFamily = "Electronic" | "Hip-Hop" | "R&B & Soul" | "Pop" | "Rock" | "Metal" | "Jazz & Blues" | "Folk & Country" | "Classical" | "Soundtrack" | "World" | "Other";

/** The families in the order they're shown. */
export const GENRE_FAMILIES: readonly GenreFamily[] = ["Electronic", "Pop", "Rock", "Hip-Hop", "R&B & Soul", "Folk & Country", "Jazz & Blues", "Classical", "Soundtrack", "Metal", "World", "Other"];

// First match wins: the more particular words come before the general ones ("synth-pop" is electronic before it's pop).
const FAMILY_WORDS: [GenreFamily, RegExp][] = [
  ["Soundtrack", /soundtrack|score|\bost\b|musical|video ?game|anime|filmmusik/],
  ["Classical", /classic(al)?|baroque|orchestr|symphon|chamber|opera|choral|romantic era|piano solo|contemporary classical|klassik/],
  ["Metal", /metal|core\b|grindcore|deathcore|djent/],
  ["Hip-Hop", /hip.?hop|\brap\b|trap|drill|grime|boom.?bap/],
  ["R&B & Soul", /r&b|rnb|soul|funk|motown|neo.?soul|disco/],
  ["Jazz & Blues", /jazz|blues|swing|bebop|bossa|big band/],
  ["Folk & Country", /folk|country|americana|bluegrass|singer.?songwriter|acoustic|celtic|liedermacher/],
  ["Electronic", /electro|techno|house|trance|edm|idm|dubstep|drum ?& ?bass|dnb|ambient|downtempo|chill|lo.?fi|synth|trip.?hop|breakbeat|garage|dance|vaporwave|synthwave|club/],
  ["Rock", /rock|punk|grunge|shoegaze|emo|garage rock|post.?rock|alternative|indie(?! pop| folk)/],
  ["Pop", /pop|schlager|chanson|easy listening|adult contemporary/],
  ["World", /latin|reggae|ska|dub\b|afro|world|k-?pop|j-?pop|samba|flamenco|cumbia|salsa|bossa|fado|bollywood/],
];

/** The family a genre belongs to. */
export function familyOf(genre: string): GenreFamily {
  const g = genre.toLowerCase();
  for (const [family, words] of FAMILY_WORDS) if (words.test(g)) return family;
  return "Other";
}
