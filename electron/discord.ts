/**
 * Discord status: the song playing now on the user's Discord profile
 * ("Listening to …"). Off unless turned on in Settings. It goes out under
 * Songsta's own Discord application, or one of the user's own, and that
 * application's name is what Discord shows ("Listening to Songsta").
 *
 * Only the Discord app on this computer is talked to, over its local IPC
 * pipe: frames of [opcode u32 LE][length u32 LE][JSON]. The handshake
 * ({ v: 1, client_id }) is answered by a READY dispatch; SET_ACTIVITY then
 * sets or clears the status. Discord allows 5 updates per 20 s, so updates
 * are spaced out and only the newest one is sent.
 *
 * Pictures go by public address only: the album's cover as the open databases
 * have it (MusicBrainz's Cover Art Archive, iTunes; looked up by the caller),
 * and Songsta's logo. Covers of local files have no web address and a server's
 * would carry its token, so neither leaves the computer.
 */
import * as net from "net";
import * as path from "path";
import { randomUUID } from "crypto";

export interface DiscordActivity {
  title: string;
  artist: string;
  /** "" when the song has none */
  album: string;
  /** the album's own artist, for finding its cover; "" for the song's */
  albumArtist: string;
  /** a button to Songsta's page under the status, for others to see */
  button: boolean;
  /** epoch ms the song started, its position taken into account */
  startedAt: number;
  /** epoch ms it ends; 0 when the length is unknown */
  endsAt: number;
}

export type DiscordState = "off" | "connecting" | "connected" | "unavailable" | "error";

export interface DiscordStatus {
  state: DiscordState;
  /** the Discord account the status shows on, once connected */
  user?: string;
  /** why it isn't showing, or what Discord refused */
  message?: string;
}

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;
/** RPC close code: Discord doesn't know the Application ID */
const CLOSE_INVALID_CLIENT = 4000;

/** Songsta's logo where Discord can fetch it: the repository's own app icon. */
export const LOGO_URL = "https://raw.githubusercontent.com/steggi-bernd/Songsta/feat/local-player/build/icon.png";
export const SONGSTA_PAGE = "https://github.com/steggi-bernd/Songsta";
/** Discord takes picture addresses up to this long. */
const MAX_IMAGE_URL = 256;

const timing = {
  /** between two status updates — Discord's limit is 5 per 20 s */
  gapMs: 4_000,
  /** before looking for Discord again (not running, closed, restarted) */
  retryMs: 20_000,
  connectMs: 1_500,
  readyMs: 10_000,
};
let pipeOverride: string[] | null = null;

let enabled = false;
let clientId = "";
/** bumped on every reconfigure: a connection attempt that finishes late gives up */
let generation = 0;
let socket: net.Socket | null = null;
let ready = false;
let connecting = false;
/** Discord refused the Application ID — no retries until it changes */
let refused = false;
let inbox: Buffer = Buffer.alloc(0);
let status: DiscordStatus = { state: "off" };
let wanted: DiscordActivity | null = null;
/** the last SET_ACTIVITY sent on this connection (null: none yet) */
let sentKey: string | null = null;
let lastSentAt = 0;
/**
 * What a Discord took: 0 everything, 1 without the "Listening to <song>" fields of newer
 * Discords, 2 without pictures and button too. A refused status steps down once each.
 */
let fallback = 0;
/** the album cover found for what's shown, by the song it was found for */
let cover: { key: string; url: string } | null = null;
let sendTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let readyTimer: NodeJS.Timeout | null = null;

/** Discord's pipe on Windows; its socket elsewhere (plain, Flatpak and Snap installs). */
function pipePaths(): string[] {
  if (pipeOverride) return pipeOverride;
  const slots = Array.from({ length: 10 }, (_, i) => `discord-ipc-${i}`);
  if (process.platform === "win32") return slots.map((s) => `\\\\?\\pipe\\${s}`);
  const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
  const dirs = [base, path.join(base, "app", "com.discordapp.Discord"), path.join(base, "snap.discord")];
  return dirs.flatMap((d) => slots.map((s) => path.join(d, s)));
}

function setStatus(next: DiscordStatus): void {
  status = next;
}

function tryConnect(target: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.createConnection(target);
    // Errors after the race (a pipe that breaks) end in "close", handled there.
    s.on("error", () => undefined);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) s.destroy();
      resolve(ok ? s : null);
    };
    const timer = setTimeout(() => finish(false), timing.connectMs);
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
  });
}

async function connect(): Promise<void> {
  if (!enabled || !clientId || socket || connecting) return;
  const gen = generation;
  connecting = true;
  if (status.state !== "unavailable") setStatus({ state: "connecting" });
  let s: net.Socket | null = null;
  for (const target of pipePaths()) {
    s = await tryConnect(target);
    if (s || gen !== generation) break;
  }
  connecting = false;
  if (gen !== generation) {
    // Reconfigured meanwhile: start over with the new settings.
    s?.destroy();
    void connect();
    return;
  }
  if (!s) {
    setStatus({ state: "unavailable", message: "Discord isn't running" });
    retryLater();
    return;
  }
  const conn = s;
  socket = conn;
  ready = false;
  sentKey = null;
  inbox = Buffer.alloc(0);
  conn.on("data", (chunk: Buffer) => onData(conn, chunk));
  conn.on("close", () => onClose(conn));
  write(OP_HANDSHAKE, { v: 1, client_id: clientId });
  readyTimer = setTimeout(() => {
    readyTimer = null;
    if (socket === conn && !ready) conn.destroy();
  }, timing.readyMs);
}

function retryLater(): void {
  if (retryTimer || !enabled || refused) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, timing.retryMs);
  retryTimer.unref?.();
}

function clearTimers(): void {
  for (const t of [sendTimer, retryTimer, readyTimer]) if (t) clearTimeout(t);
  sendTimer = retryTimer = readyTimer = null;
}

function disconnect(): void {
  clearTimers();
  const s = socket;
  socket = null;
  ready = false;
  sentKey = null;
  inbox = Buffer.alloc(0);
  s?.destroy();
}

function onClose(s: net.Socket): void {
  if (socket !== s) return;
  socket = null;
  ready = false;
  sentKey = null;
  if (sendTimer) clearTimeout(sendTimer);
  if (readyTimer) clearTimeout(readyTimer);
  sendTimer = readyTimer = null;
  if (!enabled) return setStatus({ state: "off" });
  if (refused) return;
  setStatus({ state: "unavailable", message: "Discord was closed" });
  retryLater();
}

function write(op: number, payload: unknown): void {
  const s = socket;
  if (!s || s.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  s.write(Buffer.concat([head, body]));
}

function onData(s: net.Socket, chunk: Buffer): void {
  if (socket !== s) return;
  inbox = inbox.length ? Buffer.concat([inbox, chunk]) : chunk;
  while (inbox.length >= 8) {
    const op = inbox.readUInt32LE(0);
    const len = inbox.readUInt32LE(4);
    // Not Discord talking (or a broken stream): drop the connection, look again later.
    if (len > 1 << 20) return void s.destroy();
    if (inbox.length < 8 + len) return;
    let msg: unknown = null;
    try {
      msg = JSON.parse(inbox.subarray(8, 8 + len).toString("utf8"));
    } catch {
      /* an unreadable frame is skipped */
    }
    inbox = inbox.subarray(8 + len);
    onFrame(s, op, msg);
    if (socket !== s) return;
  }
}

interface Frame {
  cmd?: unknown;
  evt?: unknown;
  code?: unknown;
  message?: unknown;
  data?: { user?: { username?: unknown; global_name?: unknown }; message?: unknown };
}

function onFrame(s: net.Socket, op: number, msg: unknown): void {
  const m: Frame = msg && typeof msg === "object" ? (msg as Frame) : {};
  if (op === OP_PING) return write(OP_PONG, msg ?? {});
  if (op === OP_CLOSE) {
    if (m.code === CLOSE_INVALID_CLIENT) {
      refused = true;
      setStatus({ state: "error", message: "Discord doesn't know this Application ID" });
    }
    return void s.destroy();
  }
  if (op !== OP_FRAME) return;
  if (m.cmd === "DISPATCH" && m.evt === "READY") {
    ready = true;
    if (readyTimer) clearTimeout(readyTimer);
    readyTimer = null;
    const user = m.data?.user;
    const name = typeof user?.global_name === "string" && user.global_name ? user.global_name : user?.username;
    setStatus({ state: "connected", user: typeof name === "string" ? name.slice(0, 64) : undefined });
    scheduleSend();
    return;
  }
  if (m.cmd === "SET_ACTIVITY" && m.evt === "ERROR") {
    if (fallback < 2) {
      // An older Discord: first without the Listening fields, then the plain status (song and artist).
      fallback += 1;
      sentKey = null;
      scheduleSend();
      return;
    }
    const why = typeof m.data?.message === "string" ? m.data.message.slice(0, 200) : "unknown error";
    setStatus({ ...status, message: `Discord didn't take the status: ${why}` });
  }
}

/** Discord wants 2–128 characters per line. */
function line(text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ").trim()) {
    if (out.length + ch.length > 128) break;
    out += ch;
  }
  return out.length >= 2 ? out : out.padEnd(2, "​");
}

/** Which song a cover was found for. */
const coverKey = (a: DiscordActivity): string => `${a.title}\n${a.artist}\n${a.album}`;

function activityFor(a: DiscordActivity): Record<string, unknown> {
  const activity: Record<string, unknown> = {
    details: line(a.title),
    state: line(a.artist || "Unknown artist"),
    timestamps: a.endsAt > a.startedAt ? { start: a.startedAt, end: a.endsAt } : { start: a.startedAt },
    instance: false,
  };
  // type 2 = "Listening", status_display_type 2 = the member list names the song.
  if (fallback < 1) Object.assign(activity, { type: 2, status_display_type: 2 });
  if (fallback < 2) {
    // The album's cover with Songsta's logo in its corner; without a cover, the logo alone.
    const art = cover && cover.key === coverKey(a) ? cover.url : null;
    activity.assets = {
      large_image: art ?? LOGO_URL,
      large_text: line(a.album || "Songsta"),
      ...(art ? { small_image: LOGO_URL, small_text: "Songsta" } : {}),
    };
    if (a.button) activity.buttons = [{ label: "Songsta", url: SONGSTA_PAGE }];
  }
  return activity;
}

function scheduleSend(): void {
  if (!ready || sendTimer) return;
  const wait = Math.max(0, lastSentAt + timing.gapMs - Date.now());
  sendTimer = setTimeout(() => {
    sendTimer = null;
    send();
  }, wait);
}

function send(): void {
  if (!ready) return;
  const activity = wanted ? activityFor(wanted) : null;
  const key = JSON.stringify(activity);
  // Nothing to show and nothing shown yet on this connection: no call needed.
  if (key === sentKey || (sentKey === null && !activity)) return;
  sentKey = key;
  lastSentAt = Date.now();
  write(OP_FRAME, {
    cmd: "SET_ACTIVITY",
    args: activity ? { pid: process.pid, activity } : { pid: process.pid },
    nonce: randomUUID(),
  });
}

/** What the renderer sends, checked: anything malformed means "nothing playing". */
export function sanitizeActivity(input: unknown): DiscordActivity | null {
  if (!input || typeof input !== "object") return null;
  const a = input as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v.slice(0, 512).trim() : "");
  const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0);
  const title = text(a.title);
  if (!title) return null;
  const startedAt = time(a.startedAt) || Date.now();
  const endsAt = time(a.endsAt);
  return {
    title,
    artist: text(a.artist),
    album: text(a.album),
    albumArtist: text(a.albumArtist),
    button: a.button === true,
    startedAt,
    endsAt: endsAt > startedAt ? endsAt : 0,
  };
}

/** The cover found for a song: shown if that song is still the one on the status. Public https addresses only. */
export function setDiscordCover(forSong: DiscordActivity, url: string): void {
  if (!/^https:\/\/[^\s"']+$/.test(url) || url.length > MAX_IMAGE_URL) return;
  cover = { key: coverKey(forSong), url };
  if (enabled && ready && wanted && coverKey(wanted) === cover.key) scheduleSend();
}

/** Turn the status on or off, or change the Application ID. */
export function configureDiscord(on: boolean, id: string): DiscordStatus {
  const nextId = /^\d{15,22}$/.test(id.trim()) ? id.trim() : "";
  if (on === enabled && nextId === clientId) return discordStatus();
  generation++;
  enabled = on;
  clientId = nextId;
  refused = false;
  fallback = 0;
  disconnect();
  setStatus({ state: "off" });
  if (on && nextId) void connect();
  return discordStatus();
}

/** The song to show; null clears the status (paused, stopped). */
export function setDiscordActivity(input: unknown): void {
  wanted = sanitizeActivity(input);
  if (enabled && ready) scheduleSend();
}

export function discordStatus(): DiscordStatus {
  return { ...status };
}

/** App quit: closing the pipe makes Discord drop the status. */
export function stopDiscord(): void {
  generation++;
  enabled = false;
  disconnect();
  setStatus({ state: "off" });
}

/** Tests only: a fake Discord's pipe, quicker clocks. */
export const __testing = {
  usePipes(paths: string[] | null): void {
    pipeOverride = paths;
  },
  timing,
};
