/**
 * The Jellyfin server, as the phone talks to it: sign-in, the song list,
 * favorites, plays, lyrics, and the addresses of covers and streams.
 *
 * Streams follow the desktop's rule (electron/jellyfin-stream.ts): the
 * original file where the phone decodes it, else a server transcode. A smaller
 * copy (quality.ts) comes as HLS: a progressive transcode couldn't seek.
 */
import { randomUUID } from "expo-crypto";
import { ORIGINAL, type StreamChoice } from "./quality";
import { jellyfinItemToTrack, jellyfinStreamPlan, jellyfinToTrack, type PlayCounts, type Track } from "./shared";
import { T } from "./shared";

export interface Session {
  /** where the server answers right now: its address at home or the one away from home */
  server: string;
  home: string;
  away?: string;
  /** what the server calls itself: how another address proves it leads to the same one */
  serverId?: string;
  token: string;
  userId: string;
  userName: string;
  deviceId: string;
}

const CLIENT = "Songsta Mobile";
const VERSION = "1.5.0";
const PAGE_SIZE = 500;
const MAX_ITEMS = 100_000;

export const newDeviceId = (): string => randomUUID();

export function authHeader(deviceId: string, token?: string): string {
  const parts = [`Client="${CLIENT}"`, `Device="Phone"`, `DeviceId="${deviceId}"`, `Version="${VERSION}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

/** "nas:8096" → "http://nas:8096"; anything that is not http(s) is refused. `secure`: an address on the open internet. */
export function normalizeServer(input: string, secure = false): string {
  let s = input.trim();
  if (!s) throw new Error("Enter your server's address");
  if (!/^[a-z]+:\/\//i.test(s)) s = `${secure ? "https" : "http"}://${s}`;
  if (!/^https?:\/\//i.test(s)) throw new Error("The address must start with http:// or https://");
  return s.replace(/\/+$/, "");
}

const query = (params: Record<string, string | number | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

/** No answer at all, as opposed to the server saying no. */
function noAnswer(message: string): Error {
  const err = new Error(message);
  err.name = "NoAnswer";
  return err;
}

export const isNoAnswer = (err: unknown): boolean => err instanceof Error && err.name === "NoAnswer";

async function request(
  server: string,
  path: string,
  deviceId: string,
  init: { method?: string; token?: string; body?: unknown } = {}
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${server}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: authHeader(deviceId, init.token),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch {
    // Whatever went wrong on the way, this fetch has its own words for it: no answer came.
    throw noAnswer(ctrl.signal.aborted ? T("The server did not answer in time") : T("Can't reach the server: check the address"));
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new Error("The server rejected the login: check the user name and password");
  // A tunnel or proxy answering for a server that's down.
  if (res.status >= 500) throw noAnswer(T("The server answered HTTP {status}", { status: res.status }));
  if (!res.ok) throw new Error(T("The server answered HTTP {status}", { status: res.status }));
  return text ? JSON.parse(text) : null;
}

export async function signIn(serverInput: string, username: string, password: string): Promise<Session> {
  const server = normalizeServer(serverInput);
  if (!username.trim()) throw new Error("Enter your user name");
  const deviceId = newDeviceId();
  const info = await request(server, "/System/Info/Public", deviceId);
  if (!info?.Id) throw new Error("That address is not a Jellyfin server");
  const auth = await request(server, "/Users/AuthenticateByName", deviceId, {
    method: "POST",
    body: { Username: username.trim(), Pw: password },
  });
  if (!auth?.AccessToken || !auth?.User?.Id) throw new Error("The server did not accept the login");
  return { server, home: server, serverId: info.Id, token: auth.AccessToken, userId: auth.User.Id, userName: auth.User.Name ?? username.trim(), deviceId };
}

/** What the server at this address calls itself; null when nothing answers in time. Asks without the login. */
export async function serverIdAt(address: string, timeoutMs: number): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${address}/System/Info/Public`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const info = await res.json();
    return typeof info?.Id === "string" ? info.Id : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Whether the server at this address knows this login: for an address typed in by hand. */
export const acceptsLogin = (address: string, s: Session): Promise<boolean> =>
  request(address, "/Users/Me", s.deviceId, { token: s.token }).then(
    () => true,
    () => false
  );

export const signOut = (s: Session): Promise<void> =>
  request(s.server, "/Sessions/Logout", s.deviceId, { method: "POST", token: s.token }).catch(() => undefined);

export const itemIdOf = (t: Track): string => t.id.replace(/^jf:/, "");

const coverUrl = (server: string, itemId: string, tag: string): string =>
  `${server}/Items/${itemId}/Images/Primary?${query({ tag, maxWidth: 800, quality: 90, format: "Jpg" })}`;

/** The artist's photo on the server; a page falls back to a cover when there is none. */
export const artistPhotoUrl = (s: Session, artistItemId: string): string =>
  `${s.server}/Items/${artistItemId}/Images/Primary?${query({ maxWidth: 1200, quality: 90, format: "Jpg" })}`;

/** Past 48 kHz a smaller copy is asked for at a rate every phone's decoder knows. */
const commonRate = (t: Track): number | undefined => (!t.sampleRate || t.sampleRate <= 48000 ? undefined : t.sampleRate % 44100 === 0 ? 44100 : 48000);

export function streamUrl(s: Session, t: Track, choice: StreamChoice = ORIGINAL): string {
  const id = itemIdOf(t);
  const common = { mediaSourceId: id, deviceId: s.deviceId };
  if (choice.kind === "transcode") {
    const bitrate = choice.kbps * 1000;
    return `${s.server}/Audio/${id}/master.m3u8?${query({
      ...common,
      playSessionId: `${s.deviceId}-${id}-${choice.kbps}`,
      audioCodec: "aac",
      audioBitRate: bitrate,
      audioSampleRate: commonRate(t),
      maxStreamingBitrate: bitrate,
      segmentContainer: "ts",
      transcodingMaxAudioChannels: 2,
    })}`;
  }
  const plan = jellyfinStreamPlan(t);
  if (plan === "static") return `${s.server}/Audio/${id}/stream?${query({ ...common, static: "true" })}`;
  if (plan === "flac") return `${s.server}/Audio/${id}/stream.flac?${query({ ...common, audioCodec: "flac" })}`;
  return `${s.server}/Audio/${id}/stream.mp3?${query({ ...common, audioCodec: "mp3", audioBitRate: 320000 })}`;
}

export type DownloadQuality = "original" | "compact";
const COMPACT_DOWNLOAD_KBPS = 192;

/** A song to keep: the file itself, or a small MP3, unless the file is small already. */
export function downloadPlan(s: Session, t: Track, quality: DownloadQuality): { url: string; fileName: string; compact: boolean } {
  const id = itemIdOf(t);
  if (quality === "compact" && (!t.bitrate || t.bitrate > COMPACT_DOWNLOAD_KBPS * 1000)) {
    const params = query({
      mediaSourceId: id,
      deviceId: s.deviceId,
      playSessionId: `${s.deviceId}-keep-${id}`,
      audioCodec: "mp3",
      audioBitRate: COMPACT_DOWNLOAD_KBPS * 1000,
      audioSampleRate: commonRate(t),
    });
    return { url: `${s.server}/Audio/${id}/stream.mp3?${params}`, fileName: `${id}.mp3`, compact: true };
  }
  const plan = jellyfinStreamPlan(t);
  const container = plan === "static" ? (t.container ?? "").split(",")[0].trim().toLowerCase().replace(/[^a-z0-9]/g, "") : plan;
  return { url: streamUrl(s, t, ORIGINAL), fileName: `${id}.${container || "audio"}`, compact: false };
}

export interface ServerLibrary {
  tracks: Track[];
  /** a cover's BlurHash, by its address */
  hashes: Record<string, string>;
  favorites: string[];
  counts: PlayCounts;
  /** an artist's item on the server, by lower-case name */
  artistIds: Record<string, string>;
}

/** Every song on the server with what this user has done with it. */
export async function fetchLibrary(s: Session): Promise<ServerLibrary> {
  const out: ServerLibrary = { tracks: [], hashes: {}, favorites: [], counts: {}, artistIds: {} };
  const artUrl = (itemId: string, tag: string): string => coverUrl(s.server, itemId, tag);
  for (let start = 0; start < MAX_ITEMS; start += PAGE_SIZE) {
    const params = query({
      IncludeItemTypes: "Audio",
      Recursive: "true",
      SortBy: "AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName",
      SortOrder: "Ascending",
      Fields: "Genres,DateCreated,MediaStreams",
      EnableImageTypes: "Primary",
      EnableUserData: "true",
      UserId: s.userId,
      StartIndex: start,
      Limit: PAGE_SIZE,
    });
    const page = await request(s.server, `/Items?${params}`, s.deviceId, { token: s.token });
    const items: any[] = Array.isArray(page?.Items) ? page.Items : [];
    for (const item of items) {
      const raw = jellyfinItemToTrack(item, artUrl);
      if (!raw) continue;
      const track = jellyfinToTrack(raw);
      out.tracks.push(track);
      const tag: unknown = item.ImageTags?.Primary ?? item.AlbumPrimaryImageTag;
      const hash: unknown = typeof tag === "string" ? item.ImageBlurHashes?.Primary?.[tag] : undefined;
      if (track.thumb && typeof hash === "string") out.hashes[track.thumb] = hash;
      if (item.UserData?.IsFavorite) out.favorites.push(track.id);
      const plays = Number(item.UserData?.PlayCount) || 0;
      if (plays > 0) out.counts[track.id] = { plays, lastAt: Date.parse(item.UserData?.LastPlayedDate ?? "") || 0 };
      for (const a of Array.isArray(item.ArtistItems) ? item.ArtistItems : []) {
        if (typeof a?.Name === "string" && typeof a?.Id === "string") out.artistIds[a.Name.toLowerCase()] = a.Id;
      }
    }
    if (items.length < PAGE_SIZE) break;
  }
  return out;
}

export const setFavorite = (s: Session, t: Track, favorite: boolean): Promise<void> =>
  request(s.server, `/UserFavoriteItems/${itemIdOf(t)}?${query({ userId: s.userId })}`, s.deviceId, {
    method: favorite ? "POST" : "DELETE",
    token: s.token,
  });

export const markPlayed = (s: Session, t: Track, at: Date): Promise<void> =>
  request(s.server, `/UserPlayedItems/${itemIdOf(t)}?${query({ userId: s.userId, datePlayed: at.toISOString() })}`, s.deviceId, {
    method: "POST",
    token: s.token,
  });

export interface LyricLine {
  /** ms from the song's start; absent on lyrics that aren't timed */
  at?: number;
  text: string;
}

/** The server's lyrics for a song; none is a normal answer. */
export async function fetchLyrics(s: Session, t: Track): Promise<LyricLine[]> {
  try {
    const res = await request(s.server, `/Audio/${itemIdOf(t)}/Lyrics`, s.deviceId, { token: s.token });
    const lines: any[] = Array.isArray(res?.Lyrics) ? res.Lyrics : [];
    return lines.map((l) => ({ at: typeof l.Start === "number" ? l.Start / 10_000 : undefined, text: String(l.Text ?? "") }));
  } catch {
    return [];
  }
}
