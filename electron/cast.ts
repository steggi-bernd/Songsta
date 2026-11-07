/**
 * Casting: sessions with network players (upnp.ts and lib/castV2.ts speak to them).
 *
 *  - a session is one or several players playing the same song: the main one
 *    follows the app's queue, others are zones with their own (lib/zones.ts)
 *  - a small media server per session, listening only on the address that
 *    reaches the players, serves only the song being cast — under a random
 *    path that changes with every song — and closes when casting stops
 *  - local files are read with byte ranges (seeking works); songs on
 *    Jellyfin/Navidrome stream through it, so a player never sees a server's
 *    token. A Jellyfin at home that needs no login for a song is fetched from
 *    directly, as from the phone: no firewall in the way, and no computer needed
 *  - a player that never comes for a song going through this computer is
 *    reported once, because that's what a firewall looks like from here
 *  - the first player's state and position are read once a second; a song that
 *    played to its end is reported once, so the queue can move on
 */
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as tls from "tls";
import { Readable } from "stream";
import { randomBytes } from "crypto";
import type { AddressInfo } from "net";
import * as jellyfin from "./jellyfin";
import { jellyfinStreamPlan } from "./jellyfin-stream";
import { scanMdns } from "./net-scan";
import * as subsonic from "./subsonic";
import * as locallib from "./local-library";
import { castPlayer, EndWatch, mimeOf, upnpPlayer, type DevicePlayer as Player } from "./device-player";
import { discover, type Renderer } from "./upnp";
import type { CastSocket } from "../src/lib/castV2";
import { canSwitchOff, readPower, sendToReceiver, switchOffAt, type DevicePower } from "../src/lib/devicePower";
import { GroupSync, PLAY_AHEAD_MAX_MS } from "../src/lib/groupSync";
import * as tv from "./tv-remote";
import type { NetDevice, NetDeviceKind } from "../src/lib/netScan";

export interface CastSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  /** a cover the player can fetch by itself */
  art?: string;
}

export interface CastMember {
  id: string;
  name: string;
  /** 0–1, null when it can't be set from here */
  volume: number | null;
  muted: boolean;
}

export interface CastStatus {
  /** which session this is about */
  session: string;
  device: { id: string; name: string } | null;
  /** everyone in the session; the first is `device` */
  members: CastMember[];
  state: "idle" | "loading" | "playing" | "paused" | "stopped";
  trackId: string | null;
  position: number;
  duration: number;
  /** the player has asked this computer for the song (false: it may not reach it — a firewall) */
  fetched: boolean;
  /** the first player's volume 0–1, null when it can't be set from here */
  volume: number | null;
  muted: boolean;
  /** the song played to its end (set on the one status that says so) */
  ended?: boolean;
  /** the song goes through this computer, so `fetched` says something */
  through: boolean;
  /** this player was handed a song and never started it; if others are left it's out of the group (set on the one status that says so) */
  notStarted?: { id: string; name: string };
  /** this player should have come for the song by now and hasn't (set on the one status that says so) */
  unreachable?: { id: string; name: string };
  message?: string;
}

export interface FoundDevice {
  id: string;
  name: string;
  model: string;
  kind: NetDeviceKind;
}

const SONG_ID = /^(local|jf|ss):[\w.:-]{1,128}$/;
const MAIN = "main";
/** Long enough for a receiver to wake up and ask (they take about 20 seconds); after this it looks like a firewall. */
const COME_FOR_IT_MS = 28_000;
/** After a command a device's reports may still show the state before it. */
const SETTLE_MS = 2500;

function castSocketTo(host: string, port: number): Promise<CastSocket> {
  return new Promise((resolve, reject) => {
    // Cast devices carry certificates only Google's own apps check; this stays on the local network.
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      socket.setTimeout(0);
      resolve({
        write: (bytes) => void socket.write(bytes),
        close: () => socket.destroy(),
        onData: (listener) => void socket.on("data", (data: Buffer) => listener(new Uint8Array(data))),
        onClose: (listener) => void socket.on("close", listener),
      });
    });
    socket.once("error", reject);
    socket.setTimeout(6000, () => socket.destroy(new Error("The device doesn't answer")));
  });
}

let knownUpnp = new Map<string, Renderer>();
let knownNet = new Map<string, NetDevice>();
/** Where the receivers answer: kept when one misses a later search, fast asleep perhaps. */
const powerHosts = new Map<string, string>();
/** The same for anything that may have a remote control of its own (lib/tvRemote.ts). */
const tvHosts = new Map<string, string>();

export async function findDevices(): Promise<FoundDevice[]> {
  const [renderers, others] = await Promise.all([discover(), scanMdns().catch(() => [])]);
  knownUpnp = new Map(renderers.map((r) => [r.id, r]));
  knownNet = new Map(others.map((d) => [d.id, d]));
  for (const r of renderers) {
    const host = new URL(r.avTransport.url).hostname;
    if (canSwitchOff(r.model)) powerHosts.set(r.id, host);
    else tvHosts.set(r.id, host);
  }
  for (const d of others) tvHosts.set(d.id, d.host);
  return [
    ...renderers.map((r): FoundDevice => ({ id: r.id, name: r.name, model: r.model, kind: "upnp" })),
    ...others.map((d): FoundDevice => ({ id: d.id, name: d.name, model: d.model, kind: d.kind })),
  ];
}

const powerHost = (deviceId: string): string | null => powerHosts.get(deviceId) ?? null;

export async function devicePower(deviceId: string): Promise<DevicePower | null> {
  const host = powerHost(deviceId);
  return host ? readPower(host) : null;
}

export async function deviceSwitchOff(deviceId: string): Promise<boolean> {
  const host = powerHost(deviceId);
  return host ? switchOffAt(host) : false;
}

export async function deviceCommand(deviceId: string, word: string): Promise<boolean> {
  const host = powerHost(deviceId);
  return host ? sendToReceiver(host, word) : false;
}

function tvHost(deviceId: string): string {
  const host = tvHosts.get(deviceId);
  if (!host) throw new Error("That device isn't on the network anymore — search again");
  return host;
}

export const tvPairStart = (deviceId: string): Promise<void> => tv.startPairing(tvHost(deviceId));
export const tvPairFinish = (code: string): ReturnType<typeof tv.finishPairing> => tv.finishPairing(code);
export const tvPairCancel = (): void => tv.cancelPairing();

export async function tvPower(deviceId: string): Promise<DevicePower | null> {
  const host = tvHosts.get(deviceId);
  const state = host ? await tv.readTv(host) : null;
  return state && { on: state.on, input: "", tv: true, busy: state.busy };
}

export async function tvOff(deviceId: string): Promise<boolean> {
  const host = tvHosts.get(deviceId);
  return host ? tv.switchTvOff(host) : false;
}

async function playerFor(deviceId: string): Promise<Player> {
  const r = knownUpnp.get(deviceId);
  if (r) return upnpPlayer(r);
  const d = knownNet.get(deviceId);
  if (d?.kind === "cast") return castPlayer(d, castSocketTo);
  if (d) throw new Error(`${d.name} can only be reached over Bluetooth`);
  throw new Error("That player isn't on the network anymore — search again");
}

/** This computer's IPv4 address on the player's network. */
export function addressFor(playerHost: string, nets: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  const num = (ip: string): number => ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
  if (playerHost.startsWith("127.")) return "127.0.0.1";
  let fallback: string | null = null;
  for (const list of Object.values(nets)) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      fallback ??= a.address;
      const mask = num(a.netmask);
      const net = (ip: string): number => Number(BigInt(num(ip)) & BigInt(mask));
      if (net(a.address) === net(playerHost)) return a.address;
    }
  }
  return fallback;
}

/** A song from the renderer, checked; anything else is refused. */
export function songFrom(input: unknown): CastSong {
  const s = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown, fallback: string): string => (typeof v === "string" && v.trim() ? v.slice(0, 200) : fallback);
  if (typeof s.id !== "string" || !SONG_ID.test(s.id)) throw new Error("That song can't be cast");
  const duration = Number(s.duration);
  return {
    id: s.id,
    title: text(s.title, "Unknown title"),
    artist: text(s.artist, "Unknown artist"),
    album: text(s.album, ""),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    art: typeof s.art === "string" && /^https?:\/\//.test(s.art) ? s.art.slice(0, 800) : undefined,
  };
}

/** Byte ranges the way players ask for them; null for a range outside the file. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number; partial: boolean } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? "");
  if (!m || (!m[1] && !m[2])) return { start: 0, end: size - 1, partial: false };
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return start <= end && start < size ? { start, end, partial: true } : null;
}

const DLNA_HEADERS = {
  "transferMode.dlna.org": "Streaming",
  "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000",
};

/** The format a server song streams in — its own, or what the server converts it to (as it plays here). */
export function serverStreamExt(song: { id: string }): string {
  if (song.id.startsWith("jf:")) {
    const t = jellyfin.readLibrary().tracks.find((x) => x.id === song.id);
    const plan = jellyfinStreamPlan(t);
    if (plan !== "static") return `.${plan}`;
    const container = (t?.container ?? "").split(",")[0].trim().toLowerCase();
    return container ? `.${container}` : ".flac";
  }
  const suffix = (subsonic.readLibrary().tracks.find((x) => x.id === song.id)?.suffix ?? "").toLowerCase();
  return subsonic.SERVER_TRANSCODE.has(suffix) ? ".mp3" : suffix ? `.${suffix}` : ".mp3";
}

class Session {
  private sync = new GroupSync();
  private commands = 0;
  private alignedAt = -1;
  private lastCommandAt = 0;
  private handedWith: ReadonlyMap<string, number> | null = null;
  /** A setting was changed by hand: the next look is a close one. */
  private retuned = false;
  players: Player[] = [];
  private volumes = new Map<string, { volume: number | null; muted: boolean }>();
  private server: http.Server | null = null;
  private base = "";
  private current: {
    song: CastSong;
    token: string;
    file: string | null;
    /** where the player fetches it: this computer, or the server directly */
    url: string;
    /** what's in that address and no other song's */
    mark: string;
    ext: string;
    handedAt: number;
    /** nobody came for it, and that has been said */
    saidUnreachable: boolean;
  } | null = null;
  private poll: NodeJS.Timeout | null = null;
  private ticking = false;
  private endWatch = new EndWatch();
  status: CastStatus;

  constructor(
    readonly id: string,
    private emit: (s: CastStatus) => void
  ) {
    this.status = idleStatus(id);
  }

  private set(next: Partial<CastStatus>): void {
    this.status = { ...this.status, ...next };
    this.emit(this.status);
    if (this.status.ended || this.status.notStarted || this.status.unreachable) this.status = { ...this.status, ended: false, notStarted: undefined, unreachable: undefined };
  }

  private members(): Pick<CastStatus, "device" | "members" | "volume" | "muted"> {
    const members = this.players.map((p): CastMember => ({ id: p.id, name: p.name, ...(this.volumes.get(p.id) ?? { volume: null, muted: false }) }));
    const first = members[0];
    return { device: first ? { id: first.id, name: first.name } : null, members, volume: first?.volume ?? null, muted: first?.muted ?? false };
  }

  private async readVolume(p: Player): Promise<void> {
    // Its volume stays where it is: the slider shows it, and only moving the slider changes it.
    const [volume, muted] = await Promise.all([p.getVolume().catch(() => null), p.getMute().catch(() => false)]);
    this.volumes.set(p.id, { volume: volume == null ? null : volume / 100, muted });
  }

  private async serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const token = /^\/cast\/([a-f0-9]{32})\//.exec(req.url ?? "")?.[1];
    const current = this.current;
    if (!current || token !== current.token || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    const { song, file } = current;
    if (!this.status.fetched) this.set({ fetched: true });
    if (file) {
      const size = (await fs.promises.stat(file)).size;
      const range = byteRange(req.headers.range, size);
      if (!range) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(range.partial ? 206 : 200, {
        "Content-Type": mimeOf(path.extname(file), "application/octet-stream"),
        "Content-Length": String(range.end - range.start + 1),
        "Accept-Ranges": "bytes",
        ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
        ...DLNA_HEADERS,
      });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
      return;
    }
    // A server song: its stream, passed through with the player's range.
    const raw = song.id.slice(3);
    const upstream = song.id.startsWith("jf:") ? await jellyfin.fetchStream(raw, req.headers.range) : await subsonic.fetchStream(raw, req.headers.range);
    const headers: Record<string, string> = { ...DLNA_HEADERS };
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === "HEAD" || !upstream.body) res.end();
    else Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
  }

  private async tick(): Promise<void> {
    const leader = this.players[0];
    if (!leader || !this.current || this.ticking) return;
    this.ticking = true;
    try {
      const playing = this.current;
      const waking = leader.starting();
      // The others of a group get no reports asked for, but one still on its way up has to be looked after.
      for (const p of this.players.slice(1)) {
        if (!p.starting()) continue;
        void p.status().then(
          (at) => {
            if (at.notStarted) void this.didNotStart(p);
          },
          () => undefined
        );
      }
      const at = await leader.status();
      if (this.current !== playing) return;
      if (at.notStarted) {
        await this.didNotStart(leader);
        return;
      }
      if (this.status.through && !this.status.fetched && !playing.saidUnreachable && Date.now() - playing.handedAt > COME_FOR_IT_MS) {
        playing.saidUnreachable = true;
        this.set({ unreachable: { id: leader.id, name: leader.name } });
      }
      // A report about the song before (players switch over in their own time) says nothing about this one.
      if (at.uri && !at.uri.includes(playing.mark)) return;
      // Asleep when it was first asked, it can tell its volume now.
      if (waking && !leader.starting() && this.volumes.get(leader.id)?.volume == null) {
        void this.readVolume(leader).then(() => this.set(this.members()));
      }
      const { state, position, duration, ended } = this.endWatch.see(at, playing.song.duration);
      this.set({ state, position, duration, ended, message: undefined });
      if (state === "playing" && this.players.length > 1 && this.alignedAt !== this.commands && Date.now() - this.lastCommandAt > SETTLE_MS) this.bringTogether();
    } catch (err) {
      this.set({ message: err instanceof Error ? err.message : "The player doesn't answer" });
    } finally {
      this.ticking = false;
    }
  }

  /** Handed a song and never started it: out of the group if there are others, and the renderer hears of it. */
  private async didNotStart(player: Player): Promise<void> {
    const name = { id: player.id, name: player.name };
    if (this.players.length > 1) await this.leave(player.id);
    this.set({ state: this.players.length > 0 && this.players[0] !== player ? this.status.state : "stopped", notStarted: name, message: undefined });
  }

  async start(player: Player): Promise<void> {
    const address = addressFor(player.host);
    if (!address) throw new Error("This computer isn't on the player's network");
    const srv = http.createServer((req, res) => {
      this.serve(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(0, address, () => resolve());
    });
    this.server = srv;
    this.base = `http://${address}:${(srv.address() as AddressInfo).port}`;
    this.players = [player];
    this.poll = setInterval(() => void this.tick(), 1000);
    await this.readVolume(player);
    this.set({ ...idleStatus(this.id), ...this.members() });
  }

  async load(song: CastSong, positionSec: number, play: boolean): Promise<void> {
    if (!this.players.length || !this.server) throw new Error("Not casting");
    const file = song.id.startsWith("local:") ? locallib.localStreamPath(song.id) : null;
    if (song.id.startsWith("local:") && !file) throw new Error("That file can't be reached right now");
    const ext = file ? path.extname(file).toLowerCase() : serverStreamExt(song);
    const token = randomBytes(16).toString("hex");
    const direct = song.id.startsWith("jf:") ? await jellyfin.deviceStreamUrl(song.id.slice(3), this.players[0].host).catch(() => null) : null;
    const url = direct ?? `${this.base}/cast/${token}/song${ext}`;
    this.current = { song, token, file, url, mark: direct ? song.id.slice(3) : token, ext, handedAt: Date.now(), saidUnreachable: false };
    this.endWatch.begin(positionSec);
    this.set({ state: "loading", trackId: song.id, position: positionSec, duration: song.duration, fetched: false, through: !direct, ended: false });
    const meta = { ...song, mime: mimeOf(ext) };
    const handing = this.current;
    const delays = play && this.players.length > 1 ? this.sync.startDelays(this.players.map((p) => p.id)) : null;
    this.outOfStep();
    this.handedWith = delays;
    const results = await Promise.allSettled(
      this.players.map(async (p) => {
        const delay = delays?.get(p.id) ?? 0;
        if (delay > 0) await new Promise((done) => setTimeout(done, delay));
        if (this.current === handing) await p.load(url, meta, positionSec, play);
      })
    );
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    // The first player decides: a second one that can't follow doesn't stop the music.
    if (failed && results[0].status === "rejected") throw failed.reason;
    // Playing once it says so (see tick).
    this.set({ state: play ? "loading" : "paused" });
  }

  private for(deviceId?: string): Player[] {
    return deviceId ? this.players.filter((p) => p.id === deviceId) : this.players;
  }

  /** One of these was set by hand to play further ahead or behind. */
  retune(changed: ReadonlySet<string>): void {
    if (this.players.length < 2 || !this.players.some((p) => changed.has(p.id))) return;
    this.retuned = true;
    this.outOfStep();
  }

  /** Something happened that can put a group out of step: it gets looked at again. */
  private outOfStep(): void {
    this.commands += 1;
    this.lastCommandAt = Date.now();
    this.handedWith = null;
  }

  /** All of them playing: are they together? Once per song, seek and pause. */
  private bringTogether(): void {
    if (this.players.some((p) => p.starting())) return;
    this.alignedAt = this.commands;
    const at = this.commands;
    const delays = this.handedWith;
    this.handedWith = null;
    const closely = this.retuned;
    this.retuned = false;
    const members = this.players.map((p) => ({
      id: p.id,
      offset: (playAhead.get(p.id) ?? 0) / 1000,
      place: async () => {
        const report = await p.status();
        return report.state === "PLAYING" ? report.position : null;
      },
      seek: (sec: number) => p.seek(sec),
    }));
    void this.sync.align(members, () => at === this.commands && this.status.state === "playing", this.status.duration, delays, closely).catch(() => undefined);
  }

  async control(action: string, value: number, deviceId?: string): Promise<void> {
    if (!this.players.length) throw new Error("Not casting");
    if (action === "play" || action === "pause" || action === "seek") this.outOfStep();
    const each = (run: (p: Player) => Promise<unknown>): Promise<unknown[]> => Promise.all(this.players.map(run));
    if (action === "play") await each((p) => p.play());
    else if (action === "pause") await each((p) => p.pause());
    else if (action === "seek" && Number.isFinite(value) && value >= 0) {
      this.endWatch.moved(value);
      await each((p) => p.seek(value));
    } else if (action === "volume" && Number.isFinite(value)) {
      const v = Math.min(1, Math.max(0, value));
      for (const p of this.for(deviceId)) {
        if (this.volumes.get(p.id)?.volume == null) continue;
        await p.setVolume(v * 100);
        this.volumes.set(p.id, { volume: v, muted: this.volumes.get(p.id)?.muted ?? false });
      }
      this.set(this.members());
    } else if (action === "mute") {
      for (const p of this.for(deviceId)) {
        if (this.volumes.get(p.id)?.volume == null) continue;
        await p.setMute(value > 0);
        this.volumes.set(p.id, { volume: this.volumes.get(p.id)?.volume ?? null, muted: value > 0 });
      }
      this.set(this.members());
    } else throw new Error("Unknown cast command");
    void this.tick();
  }

  /** The way to this computer may be open now: the song on its way once more, from the start of its patience. */
  async again(): Promise<void> {
    const current = this.current;
    if (current && !this.status.fetched && this.status.through && this.status.state === "loading") await this.load(current.song, this.status.position, true);
  }

  /** Another device plays along from here on, from where the others are. */
  async join(player: Player): Promise<void> {
    if (this.players.some((p) => p.id === player.id)) return;
    await this.readVolume(player);
    this.players = [...this.players, player];
    this.outOfStep();
    if (this.current) {
      await player
        .load(this.current.url, { ...this.current.song, mime: mimeOf(this.current.ext) }, this.status.position, this.status.state === "playing" || this.status.state === "loading")
        .catch((err: unknown) => {
          this.players = this.players.filter((p) => p !== player);
          player.close();
          throw err;
        });
    }
    this.set(this.members());
  }

  /** A device stops playing along; answers whether anyone is left. */
  async leave(deviceId: string): Promise<boolean> {
    const player = this.players.find((p) => p.id === deviceId);
    if (player) {
      this.players = this.players.filter((p) => p !== player);
      await player.stop().catch(() => undefined);
      player.close();
      this.set(this.members());
    }
    return this.players.length > 0;
  }

  async stop(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const players = this.players;
    this.players = [];
    this.current = null;
    await Promise.all(
      players.map(async (p) => {
        await p.stop().catch(() => undefined);
        p.close();
      })
    );
    if (this.server) {
      const srv = this.server;
      // A player keeps its stream open: drop it, or close() waits for it forever.
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
    this.server = null;
    this.set(idleStatus(this.id));
    this.emit = () => undefined;
  }
}

function idleStatus(session: string): CastStatus {
  return { session, device: null, members: [], state: "idle", trackId: null, position: 0, duration: 0, fetched: false, through: true, volume: null, muted: false };
}

const sessions = new Map<string, Session>();

/** How far ahead each device plays in a group, in ms, as set by hand in the app (lib/groupSync.ts). */
const playAhead = new Map<string, number>();

export function setPlayAhead(input: unknown): void {
  const next = new Map<string, number>();
  if (input && typeof input === "object") {
    for (const [id, ms] of Object.entries(input as Record<string, unknown>).slice(0, 500)) {
      if (id.length > 300 || typeof ms !== "number" || !Number.isFinite(ms) || ms === 0) continue;
      next.set(id, Math.max(-PLAY_AHEAD_MAX_MS, Math.min(PLAY_AHEAD_MAX_MS, Math.round(ms))));
    }
  }
  const changed = new Set([...next.keys(), ...playAhead.keys()].filter((id) => next.get(id) !== playAhead.get(id)));
  playAhead.clear();
  for (const [id, ms] of next) playAhead.set(id, ms);
  if (changed.size) for (const s of sessions.values()) s.retune(changed);
}

export async function start(deviceId: string, onStatus: (s: CastStatus) => void, sessionId = MAIN): Promise<CastStatus> {
  const player = await playerFor(deviceId);
  await stop(sessionId);
  const session = new Session(sessionId, onStatus);
  try {
    await session.start(player);
  } catch (err) {
    player.close();
    throw err;
  }
  sessions.set(sessionId, session);
  return session.status;
}

function sessionOf(sessionId: string): Session {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("Not casting");
  return session;
}

export async function load(song: CastSong, positionSec: number, play: boolean, sessionId = MAIN): Promise<void> {
  return sessionOf(sessionId).load(song, positionSec, play);
}

export async function control(action: string, value: number, sessionId = MAIN, deviceId?: string): Promise<void> {
  return sessionOf(sessionId).control(action, value, deviceId);
}

export async function join(sessionId: string, deviceId: string): Promise<void> {
  const session = sessionOf(sessionId);
  if (session.players.some((p) => p.id === deviceId)) return;
  await session.join(await playerFor(deviceId));
}

/** Answers whether the session still has a device. */
export async function leave(sessionId: string, deviceId: string): Promise<boolean> {
  return sessionOf(sessionId).leave(deviceId);
}

export async function stop(sessionId = MAIN): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.stop();
}

/** Every song still waiting to be fetched, handed over again. */
export async function againAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => s.again().catch(() => undefined)));
}

export async function stopAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stop(id)));
}

export function castStatus(sessionId = MAIN): CastStatus {
  return sessions.get(sessionId)?.status ?? idleStatus(sessionId);
}
