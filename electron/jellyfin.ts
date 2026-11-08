/**
 * Jellyfin — the user's own media server as a second library source.
 *
 *  - connect with username + password (the password is sent once to
 *    /Users/AuthenticateByName and never stored) or with an API key from the
 *    server dashboard; only the resulting token is kept, sealed with the OS
 *    keychain (secrets.ts)
 *  - the server's audio items are listed page by page and cached on disk, so
 *    the view renders instantly and only refreshes on request
 *  - audio streams through the local stream proxy and covers through the
 *    jfart:// scheme: the token stays in the main process, and plain-http
 *    LAN servers work without loosening the renderer's CSP
 *
 * Streams are the original file wherever the player can decode it, and a
 * server transcode otherwise — FLAC for lossless sources, MP3 for lossy ones
 * (jellyfin-stream.ts). Never the universal endpoint: it needs a user, which
 * API-key logins don't have.
 */
import { app } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as persist from "./persist";
import { jellyfinStreamPlan } from "./jellyfin-stream";
import { isLanUrl } from "./upnp-control";
import { openSecret, sealSecret } from "./secrets";
import { jellyfinItemToTrack, type JellyfinTrack } from "../src/lib/jellyfinItem";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CONFIG_STORE = "jellyfin";
const LIBRARY_STORE = "jellyfin-library";
const PAGE_SIZE = 500;
const MAX_ITEMS = 100_000;
const CLIENT = "Songsta";
const VERSION = "1.5.0";
/** Bump when refreshLibrary reads new fields: an older cache then refreshes once in the background. */
const LIB_VERSION = 3;

export type { JellyfinTrack };
import { pickAddress, type Addresses, type Reach } from "../src/lib/serverAddresses";

export interface JellyfinLibrary {
  fetchedAt: number;
  tracks: JellyfinTrack[];
  /** LIB_VERSION the cache was listed with */
  v?: number;
}

export interface JellyfinStatus {
  connected: boolean;
  server: string | null;
  serverName: string | null;
  userName: string | null;
  trackCount: number;
  fetchedAt: number;
  /** the cached library predates fields this version reads — refresh it */
  stale: boolean;
  /** signed in with an API key, which belongs to no user */
  apiKey: boolean;
  /** whose favorites and plays Server sync uses (see syncUser) */
  syncUserId: string | null;
  syncUserName: string | null;
  /** the address at home, and one that works from anywhere (a tunnel or proxy); `server` is the one in use */
  home: string | null;
  away: string | null;
  reach: Reach | null;
}

interface Config {
  /** the address in use now: the one at home, or the one away when only that answers */
  server: string;
  /** the address at home, as signed in with (older logins: server) */
  home?: string;
  /** an address that works from anywhere: a tunnel or proxy */
  away?: string;
  /** the server's own id: another server at the same private address, in somebody else's home, doesn't count */
  serverId?: string;
  serverName: string;
  userId: string | null;
  userName: string | null;
  token: string; // sealed
  deviceId: string;
  /** an API-key login syncs favorites and plays for this server user */
  syncUserId?: string | null;
  syncUserName?: string | null;
}

function readConfig(): Config | null {
  const raw = persist.readData(CONFIG_STORE) as Config | null;
  return raw && typeof raw.server === "string" && raw.token ? raw : null;
}

function deviceId(): string {
  return readConfig()?.deviceId ?? crypto.randomUUID();
}

function authHeader(token?: string, device = deviceId()): string {
  const parts = [`Client="${CLIENT}"`, `Device="Desktop"`, `DeviceId="${device}"`, `Version="${VERSION}"`];
  if (token) parts.push(`Token="${token}"`);
  return `MediaBrowser ${parts.join(", ")}`;
}

/** "nas:8096" → "http://nas:8096"; anything that is not http(s) is refused. An address away from home is https unless it says otherwise. */
export function normalizeServer(input: string, away = false): string {
  let s = String(input ?? "").trim();
  if (!s) throw new Error("Enter your Jellyfin server address");
  if (!/^[a-z]+:\/\//i.test(s)) s = `${away ? "https" : "http"}://${s}`;
  const url = new URL(s);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The server address must start with http:// or https://");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

async function request(
  server: string,
  pathAndQuery: string,
  init: { method?: string; token?: string; body?: unknown; device?: string } = {}
): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`${server}${pathAndQuery}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: authHeader(init.token, init.device),
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new Error("Jellyfin rejected the login — check the user name and password");
    if (!res.ok) throw new Error(`Jellyfin answered HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("The Jellyfin server did not answer in time");
    if (err instanceof TypeError) throw new Error("Can't reach the Jellyfin server — check the address");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function status(): JellyfinStatus {
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
    apiKey: !!cfg && !cfg.userId,
    syncUserId: cfg ? syncUser(cfg) : null,
    syncUserName: cfg ? (cfg.userId ? cfg.userName : (cfg.syncUserName ?? null)) : null,
    home: cfg ? (cfg.home ?? cfg.server) : null,
    away: cfg?.away ?? null,
    reach: cfg ? reach : null,
  };
}

/* ------------------------------------------------------------ home and away */

/** Which of the server's addresses answers: the one at home whenever it does (checkReach). */
let reach: Reach = "home";
const REACH_TIMEOUT_MS = 3500;

const addressesOf = (cfg: Config): Addresses => ({ home: cfg.home ?? cfg.server, away: cfg.away });

/** The id the server at this address answers with; null when nothing does in time. */
async function serverIdAt(address: string): Promise<string | null> {
  try {
    const res = await fetch(`${address}/System/Info/Public`, { signal: AbortSignal.timeout(REACH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const info = (await res.json()) as { Id?: unknown } | null;
    return typeof info?.Id === "string" ? info.Id : null;
  } catch {
    return null;
  }
}

/**
 * Which address answers now, the one at home first (lib/serverAddresses.ts pickAddress, as on the
 * phone); the address in use follows it, and with it every song, cover and sync request. Answers
 * whether anything changed that the page should show.
 */
export async function checkReach(): Promise<boolean> {
  const cfg = readConfig();
  if (!cfg?.away) {
    const changed = reach !== "home";
    reach = "home";
    return changed;
  }
  const addresses = addressesOf(cfg);
  const [homeAnswer, awayAnswer] = await Promise.all([serverIdAt(addresses.home), serverIdAt(cfg.away)]);
  const picked = pickAddress(addresses, cfg.serverId, homeAnswer, awayAnswer);
  const before = reach;
  reach = picked.reach;
  const latest = readConfig();
  // Changed meanwhile (signed out, another address): this look is out of date.
  if (!latest || latest.away !== cfg.away) return false;
  if (picked.server && (picked.server !== latest.server || (!latest.serverId && picked.serverId))) {
    await persist.writeData(CONFIG_STORE, { ...latest, home: addresses.home, server: picked.server, serverId: latest.serverId ?? picked.serverId } satisfies Config);
    return true;
  }
  return before !== reach;
}

/** An address that works from anywhere, once it proved to lead to this same server. Empty takes it back. */
export async function setAway(input: unknown): Promise<JellyfinStatus> {
  const cfg = readConfig();
  if (!cfg) throw new Error("Connect to your Jellyfin server first");
  const home = cfg.home ?? cfg.server;
  if (!String(input ?? "").trim()) {
    await persist.writeData(CONFIG_STORE, { ...cfg, home, away: undefined, server: home } satisfies Config);
    reach = "home";
    return status();
  }
  const away = normalizeServer(String(input).slice(0, 500), true);
  const awayId = await serverIdAt(away);
  if (!awayId) throw new Error("Nothing answers at that address");
  const ownId = cfg.serverId ?? (await serverIdAt(home));
  if (ownId && ownId !== awayId) throw new Error("That address leads to another Jellyfin server");
  await persist.writeData(CONFIG_STORE, { ...cfg, home, away, serverId: ownId ?? awayId } satisfies Config);
  await checkReach();
  return status();
}

/** Whether the server answers right now; null when no server is connected. */
export async function ping(): Promise<boolean | null> {
  const cfg = readConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(`${cfg.server}/System/Ping`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function connect(input: {
  server: string;
  username?: string;
  password?: string;
  apiKey?: string;
}): Promise<JellyfinStatus> {
  const server = normalizeServer(input.server);
  const device = deviceId();
  const info = await request(server, "/System/Info/Public", { device });
  if (!info?.Id) throw new Error("That address is not a Jellyfin server");

  let token: string;
  let userId: string | null = null;
  let userName: string | null = null;
  const apiKey = String(input.apiKey ?? "").trim();
  if (apiKey) {
    token = apiKey;
    // Validate the key with a call that needs authentication.
    await request(server, "/System/Info", { token, device });
  } else {
    const username = String(input.username ?? "").trim();
    if (!username) throw new Error("Enter your Jellyfin user name");
    const auth = await request(server, "/Users/AuthenticateByName", {
      method: "POST",
      body: { Username: username, Pw: String(input.password ?? "") },
      device,
    });
    if (!auth?.AccessToken) throw new Error("Jellyfin did not return a session");
    token = String(auth.AccessToken);
    userId = auth.User?.Id ?? null;
    userName = auth.User?.Name ?? username;
  }

  await persist.writeData(CONFIG_STORE, {
    server,
    home: server,
    serverId: typeof info.Id === "string" ? info.Id : undefined,
    serverName: String(info.ServerName ?? "Jellyfin"),
    userId,
    userName,
    token: sealSecret(token),
    deviceId: device,
  } satisfies Config);
  await persist.writeData(LIBRARY_STORE, { fetchedAt: 0, tracks: [] });
  return status();
}

export async function disconnect(): Promise<JellyfinStatus> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  // Log the session out server-side too; API keys are left alone.
  if (cfg && token && cfg.userId) {
    await request(cfg.server, "/Sessions/Logout", { method: "POST", token, device: cfg.deviceId }).catch(() => undefined);
  }
  await persist.writeData(CONFIG_STORE, null);
  await persist.writeData(LIBRARY_STORE, { fetchedAt: 0, tracks: [] });
  return status();
}

export function readLibrary(): JellyfinLibrary {
  const raw = persist.readData(LIBRARY_STORE) as JellyfinLibrary | null;
  return raw && Array.isArray(raw.tracks) ? raw : { fetchedAt: 0, tracks: [] };
}

function artUrl(itemId: string, tag: string): string {
  return `jfart://${itemId.toLowerCase()}/${encodeURIComponent(tag)}`;
}

const toTrack = (item: any): JellyfinTrack | null => jellyfinItemToTrack(item, artUrl);

/** Re-list every audio item on the server and replace the cached library. */
export async function refreshLibrary(): Promise<JellyfinLibrary> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token) throw new Error("Not connected to a Jellyfin server");
  const tracks: JellyfinTrack[] = [];
  for (let start = 0; start < MAX_ITEMS; start += PAGE_SIZE) {
    const params = new URLSearchParams({
      IncludeItemTypes: "Audio",
      Recursive: "true",
      SortBy: "AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName",
      SortOrder: "Ascending",
      Fields: "Genres,DateCreated,MediaStreams",
      EnableImageTypes: "Primary",
      StartIndex: String(start),
      Limit: String(PAGE_SIZE),
    });
    if (cfg.userId) params.set("UserId", cfg.userId);
    const page = await request(cfg.server, `/Items?${params}`, { token, device: cfg.deviceId });
    const items: any[] = Array.isArray(page?.Items) ? page.Items : [];
    for (const item of items) {
      const t = toTrack(item);
      if (t) tracks.push(t);
    }
    const total = Number(page?.TotalRecordCount) || 0;
    if (items.length < PAGE_SIZE || tracks.length >= total) break;
  }
  const lib = { fetchedAt: Date.now(), tracks, v: LIB_VERSION };
  await persist.writeData(LIBRARY_STORE, lib);
  return lib;
}

/* ------------------------------------------------------------ favorites & plays */

const ITEM_ID = /^[a-f0-9-]{32,36}$/i;

/**
 * Whose favorites and plays Server sync uses: the signed-in user — or,
 * signed in with an API key (which belongs to no user), the server user
 * chosen in Settings. Without one, Jellyfin isn't synced.
 */
function syncUser(cfg: Config): string | null {
  return cfg.userId ?? cfg.syncUserId ?? null;
}

/** What the sync service needs of this login (home-sync.ts): the same header Jellyfin itself gets. */
export function syncLogin(): { server: string; authorization: string; userId: string | null; deviceId: string } | null {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token) return null;
  return { server: cfg.server, authorization: authHeader(token, cfg.deviceId), userId: syncUser(cfg), deviceId: cfg.deviceId };
}

export interface JellyfinUser {
  id: string;
  name: string;
}

/** The users an API-key login can sync for; a signed-in user is the only choice. */
export async function listUsers(): Promise<JellyfinUser[]> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token) return [];
  if (cfg.userId) return [{ id: cfg.userId, name: cfg.userName ?? "You" }];
  const users = await request(cfg.server, "/Users", { token, device: cfg.deviceId });
  return (Array.isArray(users) ? users : [])
    .filter((u: any) => typeof u?.Id === "string" && ITEM_ID.test(u.Id))
    .map((u: any) => ({ id: String(u.Id), name: typeof u.Name === "string" && u.Name ? u.Name.slice(0, 80) : "User" }));
}

export async function setSyncUser(userId: string | null): Promise<JellyfinStatus> {
  const cfg = readConfig();
  if (!cfg) throw new Error("Not connected to a Jellyfin server");
  if (cfg.userId) return status(); // a signed-in user syncs as themselves
  let pick: JellyfinUser | undefined;
  if (userId !== null) {
    pick = (await listUsers()).find((u) => u.id === userId);
    if (!pick) throw new Error("That user isn't on this server");
  }
  await persist.writeData(CONFIG_STORE, { ...cfg, syncUserId: pick?.id ?? null, syncUserName: pick?.name ?? null } satisfies Config);
  return status();
}

/** A per-user call: Jellyfin 10.9 moved these routes and keeps the old ones for a while. */
async function userCall(method: "POST" | "DELETE", route: string, legacy: string): Promise<void> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  const user = cfg ? syncUser(cfg) : null;
  if (!cfg || !token || !user) throw new Error("No Jellyfin user to sync with");
  const withUser = `${route}${route.includes("?") ? "&" : "?"}userId=${user}`;
  try {
    await request(cfg.server, withUser, { method, token, device: cfg.deviceId });
  } catch (err) {
    if (!(err instanceof Error) || !/HTTP 40[45]\b/.test(err.message)) throw err;
    await request(cfg.server, legacy.replace("{user}", user), { method, token, device: cfg.deviceId });
  }
}

/** The sync user's favorite songs, as library tracks. */
export async function favoriteTracks(): Promise<JellyfinTrack[]> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  const user = cfg ? syncUser(cfg) : null;
  if (!cfg || !token || !user) throw new Error("No Jellyfin user to sync with");
  const tracks: JellyfinTrack[] = [];
  for (let start = 0; start < MAX_ITEMS; start += PAGE_SIZE) {
    const params = new URLSearchParams({
      IncludeItemTypes: "Audio",
      Recursive: "true",
      Filters: "IsFavorite",
      UserId: user,
      Fields: "Genres,DateCreated,MediaStreams",
      EnableImageTypes: "Primary",
      StartIndex: String(start),
      Limit: String(PAGE_SIZE),
    });
    const page = await request(cfg.server, `/Items?${params}`, { token, device: cfg.deviceId });
    const items: any[] = Array.isArray(page?.Items) ? page.Items : [];
    for (const item of items) {
      const t = toTrack(item);
      if (t) tracks.push(t);
    }
    if (items.length < PAGE_SIZE) break;
  }
  return tracks;
}

export async function setFavorite(itemId: string, favorite: boolean): Promise<void> {
  if (!ITEM_ID.test(itemId)) throw new Error("Not a Jellyfin item");
  await userCall(favorite ? "POST" : "DELETE", `/UserFavoriteItems/${itemId}`, `/Users/{user}/FavoriteItems/${itemId}`);
}

/** One play for the sync user: play count +1, last played at `at`. */
export async function markPlayed(itemId: string, at: Date): Promise<void> {
  if (!ITEM_ID.test(itemId)) throw new Error("Not a Jellyfin item");
  const date = encodeURIComponent(at.toISOString());
  await userCall("POST", `/UserPlayedItems/${itemId}?datePlayed=${date}`, `/Users/{user}/PlayedItems/${itemId}?datePlayed=${date}`);
}

/** The item's original file, for an offline copy (downloads.ts); the token stays in this process. */
export function originalFile(itemId: string): { url: string; headers: Record<string, string>; ext: string } {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token || !ITEM_ID.test(itemId)) throw new Error("Not connected to the Jellyfin server");
  const container = readLibrary().tracks.find((t) => t.itemId === itemId)?.container?.split(",")[0];
  return {
    url: `${cfg.server}/Items/${itemId}/Download`,
    headers: { Authorization: authHeader(token, cfg.deviceId) },
    ext: container && /^[a-z0-9]{2,5}$/.test(container) ? `.${container}` : ".flac",
  };
}

/** Where on the server a song streams from, in its own format or one that plays. */
function streamPath(itemId: string, deviceId: string): string {
  const plan = jellyfinStreamPlan(readLibrary().tracks.find((t) => t.itemId === itemId));
  const params = new URLSearchParams({ mediaSourceId: itemId, deviceId });
  if (plan === "static") {
    params.set("static", "true");
    return `/Audio/${itemId}/stream?${params}`;
  }
  if (plan === "flac") {
    params.set("audioCodec", "flac");
    return `/Audio/${itemId}/stream.flac?${params}`;
  }
  params.set("audioCodec", "mp3");
  params.set("audioBitRate", "320000");
  return `/Audio/${itemId}/stream.mp3?${params}`;
}

/** Upstream audio for one item, honouring the media element's Range header. */
export async function fetchStream(itemId: string, range: string | undefined): Promise<Response> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token || !/^[a-f0-9-]{32,36}$/i.test(itemId)) return new Response(null, { status: 404 });
  const headers: Record<string, string> = { Authorization: authHeader(token, cfg.deviceId) };
  if (range) headers.Range = range;
  return fetch(`${cfg.server}${streamPath(itemId, cfg.deviceId)}`, { headers });
}

/** As far as their addresses can tell. */
const sameNetwork = (a: string, b: string): boolean => a.split(".").slice(0, 3).join(".") === b.split(".").slice(0, 3).join(".");

/** Whether the server hands a song to somebody without a login, as Jellyfin does for players like these. A no is asked again later. */
const handsOutSongs = new Map<string, { yes: boolean; at: number }>();
const ASK_AGAIN_MS = 5 * 60_000;

/**
 * Where a device on the network can fetch a song by itself, with this computer out of the way, as it
 * does from the phone: nothing has to get through this computer's firewall, and the computer may sleep.
 * Only for a server on that same network, and only when it needs no login: a device never sees a token.
 * What lies elsewhere may only be reachable from here (a container's own network, a VPN, this very computer).
 */
export async function deviceStreamUrl(itemId: string, deviceHost: string): Promise<string | null> {
  const cfg = readConfig();
  if (!cfg || !/^[a-f0-9-]{32,36}$/i.test(itemId) || !isLanUrl(cfg.server)) return null;
  if (!sameNetwork(new URL(cfg.server).hostname, deviceHost)) return null;
  const known = handsOutSongs.get(cfg.server);
  if (known?.yes || (known && Date.now() - known.at < ASK_AGAIN_MS)) return known.yes ? `${cfg.server}${streamPath(itemId, cfg.deviceId)}` : null;
  const params = new URLSearchParams({ mediaSourceId: itemId, deviceId: cfg.deviceId, static: "true" });
  const yes = await fetch(`${cfg.server}/Audio/${itemId}/stream?${params}`, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(2500) }).then(
    (res) => res.ok,
    () => false
  );
  handsOutSongs.set(cfg.server, { yes, at: Date.now() });
  return yes ? `${cfg.server}${streamPath(itemId, cfg.deviceId)}` : null;
}

/**
 * Lyrics the server already has for an item (Jellyfin 10.9+ serves the
 * .lrc files and embedded lyrics of its library), rebuilt as LRC text so
 * the shared parser handles timed and untimed answers alike.
 */
export async function fetchLyrics(itemId: string): Promise<string | null> {
  const cfg = readConfig();
  const token = openSecret(cfg?.token);
  if (!cfg || !token || !/^[a-f0-9-]{32,36}$/i.test(itemId)) return null;
  try {
    const res = await request(cfg.server, `/Audio/${itemId}/Lyrics`, { token, device: cfg.deviceId });
    const lines: any[] = Array.isArray(res?.Lyrics) ? res.Lyrics : [];
    if (!lines.length) return null;
    const timed = lines.every((l) => typeof l.Start === "number");
    const stamp = (ticks: number): string => {
      const sec = ticks / 10_000_000;
      const m = Math.floor(sec / 60);
      return `${String(m).padStart(2, "0")}:${(sec - m * 60).toFixed(2).padStart(5, "0")}`;
    };
    return lines.map((l) => (timed ? `[${stamp(l.Start)}]${l.Text ?? ""}` : String(l.Text ?? ""))).join("\n");
  } catch {
    return null; // 404 = the server has none
  }
}

/* ------------------------------------------------------------- covers */

const ART_RE = /^jfart:\/\/([a-f0-9]{32})\/([A-Za-z0-9%._-]{1,80})$/i;
let artDirReady = false;

function artDir(): string {
  const dir = path.join(app.getPath("userData"), "jellyfin-art");
  if (!artDirReady) {
    fs.mkdirSync(dir, { recursive: true });
    artDirReady = true;
  }
  return dir;
}

/**
 * Cover bytes for a jfart:// URL — from the disk cache, else from the
 * server. The tag is part of the cache name, so a changed cover on the
 * server is a new file, never a stale one.
 */
export async function artBytes(url: string): Promise<{ data: Buffer; mime: string } | null> {
  const m = ART_RE.exec(String(url ?? "").trim());
  if (!m) return null;
  const itemId = m[1].toLowerCase();
  const tag = decodeURIComponent(m[2]).replace(/[^A-Za-z0-9_-]/g, "");
  const file = path.join(artDir(), `${itemId}-${tag}.jpg`);
  try {
    return { data: fs.readFileSync(file), mime: "image/jpeg" };
  } catch {
    /* not cached yet */
  }
  const cfg = readConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(
      `${cfg.server}/Items/${itemId}/Images/Primary?tag=${encodeURIComponent(tag)}&maxWidth=800&quality=90&format=Jpg`,
      { headers: { Authorization: authHeader(openSecret(cfg.token), cfg.deviceId) } }
    );
    if (!res.ok) return null;
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length || data.length > 8 * 1024 * 1024) return null;
    fs.writeFileSync(file, data);
    return { data, mime: res.headers.get("content-type") ?? "image/jpeg" };
  } catch {
    return null;
  }
}
