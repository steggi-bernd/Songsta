/**
 * Navidrome / Subsonic — a self-hosted music server as a library source,
 * next to Jellyfin. Speaks the Subsonic API (plus the OpenSubsonic
 * extensions Navidrome adds: bit depth, sample rate, ReplayGain, synced
 * lyrics).
 *
 *  - sign-in uses Subsonic token auth: md5(password + salt). Only that
 *    salt/token pair is kept, sealed with the OS keychain (secrets.ts) — the
 *    password itself is never stored
 *  - the server's songs are listed page by page and cached on disk
 *  - audio streams through the local stream proxy as the original file;
 *    formats Chromium can't decode are transcoded by the server to MP3
 *  - covers go through the ssart:// scheme (fetched and disk-cached here)
 */
import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as persist from "./persist";
import { openSecret, sealSecret } from "./secrets";
import { normalizeServer } from "./jellyfin";
import { isoDate } from "./release-date";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_STORE = "subsonic";
const LIBRARY_STORE = "subsonic-library";
const PAGE_SIZE = 500;
const MAX_ITEMS = 100_000;
const API_VERSION = "1.16.1";
const CLIENT = "Songsta";
/** Bump when refreshLibrary reads new fields: an older cache then refreshes once in the background. */
const LIB_VERSION = 3;
/** Formats Chromium can't decode — the server transcodes these to MP3. */
/** Formats the server converts to MP3 on the way (the player can't open them). */
export const SERVER_TRANSCODE = new Set(["aif", "aiff", "aifc", "wma", "wv", "ape", "dsf", "dff", "alac"]);

export interface SubsonicTrack {
  /** "ss:<songId>" — the id prefix routes playback to this module */
  id: string;
  songId: string;
  title: string;
  artist: string;
  album: string;
  albumArtist?: string;
  /** the server's album id — joins the song to its album's release facts */
  albumId?: string;
  duration: number;
  trackNo?: number;
  discNo?: number;
  /** songs on the album, from the album list */
  trackTotal?: number;
  /** OpenSubsonic release types, space-separated ("album", "ep", "single", "compilation" …) */
  releaseType?: string;
  /** OpenSubsonic original release year */
  originalYear?: number;
  /** OpenSubsonic: the album's release day, and its first release's ("YYYY-MM-DD" or shorter) */
  date?: string;
  originalDate?: string;
  year?: number;
  genre?: string;
  art?: string;
  addedAt?: number;
  suffix?: string;
  codec?: string;
  sampleRate?: number;
  bitsPerSample?: number;
  bitrate?: number;
  rg?: { trackGain?: number; trackPeak?: number; albumGain?: number; albumPeak?: number };
}

export interface SubsonicLibrary {
  fetchedAt: number;
  tracks: SubsonicTrack[];
  /** LIB_VERSION the cache was listed with */
  v?: number;
}

export interface SubsonicStatus {
  connected: boolean;
  server: string | null;
  serverName: string | null;
  userName: string | null;
  trackCount: number;
  fetchedAt: number;
  /** the cached library predates fields this version reads — refresh it */
  stale: boolean;
}

interface Config {
  server: string;
  serverName: string;
  userName: string;
  /** sealed "salt:token" pair */
  auth: string;
}

function readConfig(): Config | null {
  const raw = persist.readData(CONFIG_STORE) as Config | null;
  return raw && typeof raw.server === "string" && raw.auth ? raw : null;
}

function credentials(cfg: Config): { salt: string; token: string } | null {
  const [salt, token] = openSecret(cfg.auth).split(":");
  return salt && token ? { salt, token } : null;
}

function query(user: string, salt: string, token: string, params: Record<string, string> = {}): string {
  return new URLSearchParams({ u: user, t: token, s: salt, v: API_VERSION, c: CLIENT, f: "json", ...params }).toString();
}

async function call(
  server: string,
  method: string,
  auth: { user: string; salt: string; token: string },
  params: Record<string, string> = {},
  timeoutMs = 20000
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${server}/rest/${method}.view?${query(auth.user, auth.salt, auth.token, params)}`, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 404) throw new Error("That address is not a Subsonic or Navidrome server");
    if (!res.ok) throw new Error(`The server answered HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as any;
    const reply = body?.["subsonic-response"];
    if (!reply) throw new Error("That address is not a Subsonic or Navidrome server");
    if (reply.status !== "ok") {
      const code = reply.error?.code;
      if (code === 40 || code === 41) throw new Error("The server rejected the login — check the user name and password");
      throw new Error(reply.error?.message || "The server reported an error");
    }
    return reply;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The server did not answer in time");
    if (err instanceof TypeError) throw new Error("Can't reach the server — check the address");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function session(): { cfg: Config; auth: { user: string; salt: string; token: string } } | null {
  const cfg = readConfig();
  const creds = cfg ? credentials(cfg) : null;
  return cfg && creds ? { cfg, auth: { user: cfg.userName, ...creds } } : null;
}

export function readLibrary(): SubsonicLibrary {
  const raw = persist.readData(LIBRARY_STORE) as SubsonicLibrary | null;
  return raw && Array.isArray(raw.tracks) ? raw : { fetchedAt: 0, tracks: [] };
}

export function status(): SubsonicStatus {
  const cfg = readConfig();
  const lib = readLibrary();
  return {
    connected: !!cfg,
    server: cfg?.server ?? null,
    serverName: cfg?.serverName ?? null,
    userName: cfg?.userName ?? null,
    trackCount: lib.tracks.length,
    fetchedAt: lib.fetchedAt,
    stale: !!cfg && lib.fetchedAt > 0 && lib.v !== LIB_VERSION,
  };
}

/** Whether the server answers right now; null when no server is connected. */
export async function ping(): Promise<boolean | null> {
  const s = session();
  if (!s) return null;
  try {
    await call(s.cfg.server, "ping", s.auth, {}, 4000);
    return true;
  } catch {
    return false;
  }
}

export async function connect(input: { server: string; username: string; password: string }): Promise<SubsonicStatus> {
  const server = normalizeServer(input.server);
  const user = String(input.username ?? "").trim();
  if (!user) throw new Error("Enter your user name");
  const salt = crypto.randomBytes(8).toString("hex");
  const token = crypto.createHash("md5").update(String(input.password ?? "") + salt).digest("hex");
  const reply = await call(server, "ping", { user, salt, token });
  const serverName = reply.type ? String(reply.type).replace(/^\w/, (c: string) => c.toUpperCase()) : "Subsonic";
  await persist.writeData(CONFIG_STORE, { server, serverName, userName: user, auth: sealSecret(`${salt}:${token}`) } satisfies Config);
  await persist.writeData(LIBRARY_STORE, { fetchedAt: 0, tracks: [] });
  return status();
}

export async function disconnect(): Promise<SubsonicStatus> {
  await persist.writeData(CONFIG_STORE, null);
  await persist.writeData(LIBRARY_STORE, { fetchedAt: 0, tracks: [] });
  return status();
}

function artUrl(coverId: string): string {
  return `ssart://cover/${encodeURIComponent(coverId)}`;
}

function toTrack(s: any): SubsonicTrack | null {
  if (!s?.id || s.isDir || (s.type && s.type !== "music")) return null;
  const bounded = (v: unknown): string => (typeof v === "string" ? v.slice(0, 200) : "");
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const gain = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const rgRaw = s.replayGain ?? {};
  const rg = {
    trackGain: gain(rgRaw.trackGain),
    trackPeak: num(rgRaw.trackPeak),
    albumGain: gain(rgRaw.albumGain),
    albumPeak: num(rgRaw.albumPeak),
  };
  const suffix = bounded(s.suffix).toLowerCase() || undefined;
  return {
    id: `ss:${s.id}`,
    songId: String(s.id),
    title: bounded(s.title) || "Unknown title",
    artist: bounded(s.displayArtist) || bounded(s.artist) || "Unknown artist",
    album: bounded(s.album) || "Unknown album",
    albumArtist: bounded(s.displayAlbumArtist) || bounded(s.albumArtists?.[0]?.name) || undefined,
    albumId: s.albumId ? String(s.albumId).slice(0, 128) : undefined,
    duration: Math.round(Number(s.duration) || 0),
    trackNo: num(s.track),
    discNo: num(s.discNumber),
    year: num(s.year),
    genre: bounded(s.genre) || bounded(s.genres?.[0]?.name) || undefined,
    art: s.coverArt ? artUrl(String(s.coverArt)) : undefined,
    addedAt: s.created ? Date.parse(s.created) || undefined : undefined,
    suffix,
    codec: suffix?.toUpperCase(),
    sampleRate: num(s.samplingRate),
    bitsPerSample: num(s.bitDepth),
    bitrate: num(s.bitRate) !== undefined ? (s.bitRate as number) * 1000 : undefined,
    rg: Object.values(rg).some((v) => v !== undefined) ? rg : undefined,
  };
}

/** A fresh listing, and whether its songs (or their covers) differ from the cached ones. */
export type SubsonicListing = SubsonicLibrary & { changed: boolean };

let listing: { auth: string; done: Promise<SubsonicListing> } | null = null;

/**
 * Re-list every song on the server and replace the cached library. A call while a listing
 * for the same login runs (the relist at start, the reload button) shares it.
 */
export function refreshLibrary(): Promise<SubsonicListing> {
  const auth = readConfig()?.auth ?? "";
  if (listing?.auth === auth) return listing.done;
  const done: Promise<SubsonicListing> = listLibrary().finally(() => {
    if (listing?.done === done) listing = null;
  });
  listing = { auth, done };
  return done;
}

async function listLibrary(): Promise<SubsonicListing> {
  const s = session();
  if (!s) throw new Error("Not connected to a Navidrome/Subsonic server");
  const tracks: SubsonicTrack[] = [];
  const seen = new Set<string>();
  const push = (song: any): void => {
    const t = toTrack(song);
    if (t && !seen.has(t.id)) {
      seen.add(t.id);
      tracks.push(t);
    }
  };
  /** Release facts per album id — songs carry only the album's id. */
  type AlbumFacts = Pick<SubsonicTrack, "trackTotal" | "releaseType" | "originalYear" | "date" | "originalDate">;
  const albumFacts = new Map<string, AlbumFacts>();
  const noteAlbum = (a: any): void => {
    if (!a?.id) return;
    const facts: AlbumFacts = {};
    if (typeof a.songCount === "number" && a.songCount > 0) facts.trackTotal = a.songCount;
    const types: string[] = Array.isArray(a.releaseTypes) ? a.releaseTypes.filter((x: unknown) => typeof x === "string") : [];
    if (types.length) facts.releaseType = types.join(" ").toLowerCase().slice(0, 80);
    const year = a.originalReleaseDate?.year;
    if (typeof year === "number" && year > 0) facts.originalYear = year;
    const date = isoDate(a.releaseDate);
    if (date) facts.date = date;
    const originalDate = isoDate(a.originalReleaseDate);
    if (originalDate) facts.originalDate = originalDate;
    albumFacts.set(String(a.id), facts);
  };
  // Navidrome (and most OpenSubsonic servers) list every song for an empty search.
  for (let offset = 0; offset < MAX_ITEMS; offset += PAGE_SIZE) {
    const reply = await call(s.cfg.server, "search3", s.auth, {
      query: "",
      songCount: String(PAGE_SIZE),
      songOffset: String(offset),
      artistCount: "0",
      albumCount: "0",
    });
    const songs: any[] = reply.searchResult3?.song ?? [];
    songs.forEach(push);
    if (songs.length < PAGE_SIZE) break;
  }
  // Classic Subsonic servers return nothing for an empty search: walk the albums instead.
  if (!tracks.length) {
    for (let offset = 0; offset < MAX_ITEMS; offset += PAGE_SIZE) {
      const reply = await call(s.cfg.server, "getAlbumList2", s.auth, {
        type: "alphabeticalByName",
        size: String(PAGE_SIZE),
        offset: String(offset),
      });
      const albums: any[] = reply.albumList2?.album ?? [];
      for (const album of albums) {
        noteAlbum(album);
        const full = await call(s.cfg.server, "getAlbum", s.auth, { id: String(album.id) });
        (full.album?.song ?? []).forEach(push);
      }
      if (albums.length < PAGE_SIZE) break;
    }
  } else {
    // The song search carries no release facts: list the albums once for
    // song counts, release types and original years (best-effort).
    try {
      for (let offset = 0; offset < MAX_ITEMS; offset += PAGE_SIZE) {
        const reply = await call(s.cfg.server, "getAlbumList2", s.auth, {
          type: "alphabeticalByName",
          size: String(PAGE_SIZE),
          offset: String(offset),
        });
        const albums: any[] = reply.albumList2?.album ?? [];
        albums.forEach(noteAlbum);
        if (albums.length < PAGE_SIZE) break;
      }
    } catch {
      /* the songs alone still make a library */
    }
  }
  for (const t of tracks) {
    const facts = t.albumId ? albumFacts.get(t.albumId) : undefined;
    if (facts) Object.assign(t, facts);
  }
  // Signed out, or into another server, while the songs came: they aren't this login's.
  if (readConfig()?.auth !== s.cfg.auth) throw new Error("Not connected to a Navidrome/Subsonic server");
  const before = readLibrary();
  const lib = { fetchedAt: Date.now(), tracks, v: LIB_VERSION };
  await persist.writeData(LIBRARY_STORE, lib);
  return { ...lib, changed: before.v !== LIB_VERSION || JSON.stringify(before.tracks) !== JSON.stringify(tracks) };
}

const SONG_ID = /^[\w.:-]{1,128}$/;

/** The song's original file, for an offline copy (downloads.ts); the credentials stay in this process. */
export function originalFile(songId: string): { url: string; headers: Record<string, string>; ext: string } {
  const s = session();
  if (!s || !SONG_ID.test(songId)) throw new Error("Not connected to the Navidrome server");
  const suffix = readLibrary().tracks.find((t) => t.songId === songId)?.suffix;
  return {
    url: `${s.cfg.server}/rest/download.view?${query(s.auth.user, s.auth.salt, s.auth.token, { id: songId })}`,
    headers: {},
    ext: suffix && /^[a-z0-9]{2,5}$/.test(suffix) ? `.${suffix}` : ".flac",
  };
}

/* ------------------------------------------------------------ favorites & plays */

/** The user's starred songs, as library tracks. */
export async function favoriteTracks(): Promise<SubsonicTrack[]> {
  const s = session();
  if (!s) throw new Error("Not connected to a Navidrome/Subsonic server");
  const reply = await call(s.cfg.server, "getStarred2", s.auth);
  const songs: any[] = Array.isArray(reply.starred2?.song) ? reply.starred2.song : [];
  return songs.map(toTrack).filter((t): t is SubsonicTrack => !!t);
}

export async function setStarred(songId: string, starred: boolean): Promise<void> {
  const s = session();
  if (!s || !SONG_ID.test(songId)) throw new Error("Not a song on this server");
  await call(s.cfg.server, starred ? "star" : "unstar", s.auth, { id: songId });
}

/** "Now playing" (submission false) or one play heard at `at` (true). */
export async function scrobble(songId: string, submission: boolean, at?: Date): Promise<void> {
  const s = session();
  if (!s || !SONG_ID.test(songId)) throw new Error("Not a song on this server");
  const params: Record<string, string> = { id: songId, submission: String(submission) };
  if (at) params.time = String(at.getTime());
  await call(s.cfg.server, "scrobble", s.auth, params);
}

/** Upstream audio for one song, honouring the media element's Range header. */
export async function fetchStream(songId: string, range: string | undefined): Promise<Response> {
  const s = session();
  if (!s || !SONG_ID.test(songId)) return new Response(null, { status: 404 });
  const suffix = readLibrary().tracks.find((t) => t.songId === songId)?.suffix ?? "";
  const params: Record<string, string> = SERVER_TRANSCODE.has(suffix)
    ? { id: songId, format: "mp3", maxBitRate: "320", estimateContentLength: "true" }
    : { id: songId, format: "raw" };
  const headers: Record<string, string> = {};
  if (range) headers.Range = range;
  return fetch(`${s.cfg.server}/rest/stream.view?${query(s.auth.user, s.auth.salt, s.auth.token, params)}`, { headers });
}

/** Lyrics the server has: OpenSubsonic synced lyrics first, then classic plain lyrics. */
export async function fetchLyrics(songId: string): Promise<string | null> {
  const s = session();
  if (!s || !SONG_ID.test(songId)) return null;
  try {
    const reply = await call(s.cfg.server, "getLyricsBySongId", s.auth, { id: songId });
    const list: any[] = reply.lyricsList?.structuredLyrics ?? [];
    const best = list.find((l) => l.synced) ?? list[0];
    if (best?.line?.length) {
      const stamp = (ms: number): string => {
        const sec = ms / 1000;
        const m = Math.floor(sec / 60);
        return `${String(m).padStart(2, "0")}:${(sec - m * 60).toFixed(2).padStart(5, "0")}`;
      };
      return best.line
        .map((l: any) => (best.synced && typeof l.start === "number" ? `[${stamp(l.start)}]${l.value ?? ""}` : String(l.value ?? "")))
        .join("\n");
    }
  } catch {
    /* not an OpenSubsonic server — fall through */
  }
  try {
    const track = readLibrary().tracks.find((t) => t.songId === songId);
    if (!track) return null;
    const reply = await call(s.cfg.server, "getLyrics", s.auth, { artist: track.artist, title: track.title });
    const text = reply.lyrics?.value;
    return typeof text === "string" && text.trim() ? text : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- covers */

let artDirReady = false;
function artDir(): string {
  const dir = path.join(app.getPath("userData"), "subsonic-art");
  if (!artDirReady) {
    fs.mkdirSync(dir, { recursive: true });
    artDirReady = true;
  }
  return dir;
}

/** Cover bytes for an ssart:// URL — from the disk cache, else from the server. */
export async function artBytes(url: string): Promise<{ data: Buffer; mime: string } | null> {
  const m = /^ssart:\/\/cover\/([^/?#]{1,200})\/?$/i.exec(String(url ?? "").trim());
  if (!m) return null;
  let coverId: string;
  try {
    coverId = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (!SONG_ID.test(coverId)) return null;
  const file = path.join(artDir(), `${crypto.createHash("sha1").update(coverId).digest("hex").slice(0, 24)}.jpg`);
  try {
    return { data: fs.readFileSync(file), mime: "image/jpeg" };
  } catch {
    /* not cached yet */
  }
  const s = session();
  if (!s) return null;
  try {
    const res = await fetch(
      `${s.cfg.server}/rest/getCoverArt.view?${query(s.auth.user, s.auth.salt, s.auth.token, { id: coverId, size: "600" })}`
    );
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return null;
    fs.writeFileSync(file, data);
    return { data, mime: type };
  } catch {
    return null;
  }
}
