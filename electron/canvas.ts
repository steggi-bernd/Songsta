/**
 * Canvas — looping video artwork behind the player.
 *
 * Two public providers today (the community index and Tidal's embed-player
 * endpoint); Apple Music's token scraping is deliberately absent rather than
 * half-faked, and the provider shape takes it later. Every answer is verified
 * against what was asked for — all three of them will confidently answer a
 * search with the wrong record — and misses are cached, because nothing
 * having a canvas is the common case.
 */
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const COMMUNITY_MANIFEST = "https://vivimusicanvas.mkmdevilmi.workers.dev/canvas.json";
const COMMUNITY_TTL_MS = 30 * 60 * 1000;
const TIDAL_SEARCH = "https://api.tidal.com/v1/search";
const TIDAL_EMBED_TOKEN = "vNVdglQOjFJJGG2U";

interface CanvasHit {
  url: string;
  source: "community" | "tidal";
}

/* ------------------------------ matching ------------------------------- */

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?]/g, " ")
    .replace(/\b(feat|ft|featuring|with)\b.*$/, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtists(artist: string): string[] {
  return artist
    .split(/,|;| & | x | and /i)
    .map((a) => normalizeForMatch(a))
    .filter((a) => a.length > 1);
}

/* ----------------------------- community -------------------------------- */

/**
 * Only https video URLs may enter the manifest — the community index is
 * third-party content, and the result is handed to a media element. A file:/UNC
 * or other-scheme URL would make the app perform local/network requests at
 * playback time (e.g. an SMB auth leak). Exported for regression tests.
 */
export function canvasUrlOk(url: string): boolean {
  try {
    return new URL(url, "https://invalid.invalid").protocol === "https:"
      && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

let communityEntries: { song: string; artist: string; album: string; url: string }[] = [];
let communityFetchedAt = 0;

async function communityManifest(): Promise<typeof communityEntries> {
  const now = Date.now();
  if (communityEntries.length && now - communityFetchedAt < COMMUNITY_TTL_MS) return communityEntries;
  try {
    const res = await fetch(COMMUNITY_MANIFEST, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const arr = (await res.json()) as any[];
      communityEntries = (Array.isArray(arr) ? arr : [])
        .map((o) => ({
          song: String(o?.song ?? ""),
          artist: String(o?.artist ?? ""),
          album: String(o?.album ?? ""),
          url: String(o?.url ?? ""),
        }))
        .filter((e) => e.song && e.artist && canvasUrlOk(e.url));
      communityFetchedAt = now;
    } else {
      communityFetchedAt = now; // serve what we have rather than dropping canvas
    }
  } catch {
    communityFetchedAt = now;
  }
  return communityEntries;
}

async function communityCanvas(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  const index = await communityManifest();
  const wantTitle = normalizeForMatch(title);
  const wantArtist = normalizeForMatch(artist);
  const wantAlbum = album ? normalizeForMatch(album) : null;
  const hit = index.find((e) => {
    const song = normalizeForMatch(e.song);
    const credited = normalizeForMatch(e.artist);
    const listed = normalizeForMatch(e.album);
    const titleOk = song !== "" && (wantTitle.includes(song) || song.includes(wantTitle));
    const artistOk = credited !== "" && (wantArtist.includes(credited) || credited.includes(wantArtist));
    const albumOk = listed === "" || !wantAlbum || listed === wantAlbum;
    return titleOk && artistOk && albumOk;
  });
  return hit ? { url: hit.url, source: "community" } : null;
}

/* ------------------------------- tidal ---------------------------------- */

function tidalCoverUrl(id: string): string | null {
  const parts = id.split("-");
  if (parts.length !== 5) return null;
  return `https://resources.tidal.com/videos/${parts.join("/")}/1280x1280.mp4`;
}

/** Exact normalized title, every wanted artist credited. */
function tidalIsMatch(gotName: string, gotArtists: string[], wantName: string, wantArtist: string): boolean {
  if (normalizeForMatch(gotName) !== normalizeForMatch(wantName)) return false;
  const wanted = splitArtists(wantArtist);
  const credited = gotArtists.map(normalizeForMatch).filter((a) => a !== "");
  if (!wanted.length || !credited.length) return false;
  return wanted.every((w) => credited.some((c) => c === w));
}

async function tidalGet(query: string, types: "TRACKS" | "ALBUMS"): Promise<any[] | null> {
  const qs = new URLSearchParams({ query, limit: "10", types, countryCode: "US" });
  try {
    const res = await fetch(`${TIDAL_SEARCH}?${qs.toString()}`, {
      headers: { "X-Tidal-Token": TIDAL_EMBED_TOKEN, "User-Agent": UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const section = types === "TRACKS" ? json?.tracks?.items : json?.albums?.items;
    return Array.isArray(section) ? section : null;
  } catch {
    return null;
  }
}

async function tidalCanvas(title: string, artist: string, album?: string): Promise<CanvasHit | null> {
  // Album-level first when we know the release: the cover belongs to the
  // album in Tidal's model, and an album query can't settle on a wrong song.
  if (album) {
    const albums = await tidalGet(`${album} ${artist}`, "ALBUMS");
    for (const rec of albums ?? []) {
      const name = String(rec?.title ?? "");
      const artists = (rec?.artists ?? []).map((a: any) => String(a?.name ?? ""));
      if (!tidalIsMatch(name, artists, album, artist)) continue;
      const id = rec?.videoCover;
      if (typeof id !== "string" || !id) continue;
      const url = tidalCoverUrl(id);
      if (url) return { url, source: "tidal" };
    }
  }
  const tracks = await tidalGet(`${artist} ${title}`, "TRACKS");
  for (const item of tracks ?? []) {
    const trackTitle = String(item?.title ?? "");
    const artists = (item?.artists ?? []).map((a: any) => String(a?.name ?? ""));
    if (!tidalIsMatch(trackTitle, artists, title, artist)) continue;
    const id = item?.album?.videoCover;
    if (typeof id !== "string" || !id) continue;
    const url = tidalCoverUrl(id);
    if (url) return { url, source: "tidal" };
  }
  return null;
}

/* ------------------------------- cache ---------------------------------- */

interface Entry {
  hit: CanvasHit | null;
}
const cache = new Map<string, Entry>();
const CACHE_MAX = 64;
let inFlight: Promise<CanvasHit | null> | null = null;
let inFlightKey = "";

/**
 * The canvas for a track, or null. Never throws. Found by title, artist and
 * album, so a file of the user's own finds it as a server song does.
 */
export async function canvasFor(
  title: string,
  artist: string,
  album?: string
): Promise<{ url: string; source: string } | null> {
  const key = `${normalizeForMatch(title)}|${normalizeForMatch(artist)}|${album ? normalizeForMatch(album) : ""}`;
  if (!normalizeForMatch(title) || !normalizeForMatch(artist)) return null;
  const cached = cache.get(key);
  if (cached) return cached.hit;
  if (inFlight && inFlightKey === key) return inFlight;

  inFlightKey = key;
  inFlight = (async (): Promise<CanvasHit | null> => {
    const community = await communityCanvas(title, artist, album).catch((): CanvasHit | null => null);
    const hit = community ?? (await tidalCanvas(title, artist, album).catch((): CanvasHit | null => null));
    cache.set(key, { hit });
    while (cache.size > CACHE_MAX) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      cache.delete(first);
    }
    return hit;
  })().finally(() => {
    inFlight = null;
    inFlightKey = "";
  });
  return inFlight;
}
