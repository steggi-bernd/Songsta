/**
 * Settings → Phones at home: this computer as the sync service for phones paired with it, in homes
 * without one (home-link-server.ts runs it). Off until switched on; then it runs while Songsta is open,
 * and this computer's own sync (home-sync.ts) talks to it like a phone would.
 */
import { app } from "electron";
import * as fs from "fs";
import type { IncomingMessage, ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { byteRange } from "./cast";
import { mimeOf } from "./device-player";
import * as jellyfin from "./jellyfin";
import * as locallib from "./local-library";
import * as subsonic from "./subsonic";
import { setHomeLinkLogin } from "./home-link-login";
import { createHomeLink, homeLinkAuthorization, HOME_LINK_PORT, newHomeLinkState, type HomeLink, type HomeLinkState } from "./home-link-server";
import * as persist from "./persist";

const STORE = "home-link";

interface Saved {
  enabled: boolean;
  /** this computer's name among the devices, the same each time */
  deviceId: string;
  state: HomeLinkState;
}

export interface HomeLinkStatus {
  enabled: boolean;
  running: boolean;
  /** why it doesn't run although it's on */
  problem: "in-use" | "failed" | null;
  name: string;
  /** where phones reach it: this computer's addresses at home */
  addresses: string[];
  pairing: { code: string; until: number } | null;
  devices: { id: string; name: string; kind: "phone" | "computer"; pairedAt: number }[];
}

let saved: Saved | null = null;
let link: HomeLink | null = null;
let running = false;
let problem: HomeLinkStatus["problem"] = null;
let listener: (() => void) | null = null;

function read(): Saved {
  if (saved) return saved;
  const raw = persist.readData(STORE) as Partial<Saved> | null;
  const state = raw?.state;
  const whole =
    !!state &&
    typeof state.serviceId === "string" &&
    /^[a-f0-9]{32}$/.test(String(state.userId)) &&
    /^[a-f0-9]{64}$/.test(String(state.ownToken)) &&
    Array.isArray(state.devices);
  saved = {
    enabled: raw?.enabled === true,
    deviceId: typeof raw?.deviceId === "string" && raw.deviceId ? raw.deviceId : `pc-${newHomeLinkState().serviceId}`,
    state: whole ? (state as HomeLinkState) : newHomeLinkState(),
  };
  if (!whole || raw?.deviceId !== saved.deviceId) persist.writeDataSync(STORE, saved);
  return saved;
}

function save(next: Saved): void {
  saved = next;
  persist.writeDataSync(STORE, next);
}

const computerName = (): string => os.hostname();

function addresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push(a.address);
    }
  }
  return out;
}

function tell(): void {
  listener?.();
}

/**
 * One of this computer's songs for a paired phone's player: a local file from the library, with the
 * player's range; a server's song through this computer, so a phone without that server plays it too.
 * Only songs of the library: an id names a song, never a path.
 */
async function serveFile(id: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (id.startsWith("local:")) {
    const file = locallib.localStreamPath(id);
    if (!file) return false;
    const size = (await fs.promises.stat(file)).size;
    const range = byteRange(req.headers.range, size);
    if (!range) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return true;
    }
    res.writeHead(range.partial ? 206 : 200, {
      "Content-Type": mimeOf(path.extname(file), "application/octet-stream"),
      "Content-Length": String(range.end - range.start + 1),
      "Accept-Ranges": "bytes",
      ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` } : {}),
    });
    if (req.method === "HEAD") res.end();
    else fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
    return true;
  }
  if (id.startsWith("jf:") || id.startsWith("ss:")) {
    const raw = id.slice(3);
    const upstream = id.startsWith("jf:") ? await jellyfin.fetchStream(raw, req.headers.range) : await subsonic.fetchStream(raw, req.headers.range);
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h);
      if (v) headers[h] = v;
    }
    res.writeHead(upstream.status, headers);
    if (req.method === "HEAD" || !upstream.body) res.end();
    else Readable.fromWeb(upstream.body as import("stream/web").ReadableStream).pipe(res);
    return true;
  }
  return false;
}

/** The settings page hears when a phone paired or the code ran out. */
export function onHomeLinkChange(fn: () => void): void {
  listener = fn;
}

export function status(): HomeLinkStatus {
  const s = read();
  return {
    enabled: s.enabled,
    running,
    problem,
    name: computerName(),
    addresses: addresses(),
    pairing: link?.pairing() ?? null,
    devices: s.state.devices.map(({ id, name, kind, pairedAt }) => ({ id, name, kind, pairedAt })),
  };
}

export function start(): void {
  const s = read();
  if (!s.enabled || link) return;
  problem = null;
  const made = createHomeLink({
    dataDir: path.join(app.getPath("userData"), "home-link"),
    name: computerName,
    read: () => read().state,
    write: (state) => save({ ...read(), state }),
    changed: tell,
    serveFile,
  });
  link = made;
  made.server.on("error", (err: NodeJS.ErrnoException) => {
    console.warn("[home-link] can't run:", err.message);
    problem = err.code === "EADDRINUSE" ? "in-use" : "failed";
    running = false;
    link = null;
    setHomeLinkLogin(null);
    tell();
  });
  made.server.listen(HOME_LINK_PORT, "0.0.0.0", () => {
    running = true;
    const s = read();
    setHomeLinkLogin({ address: `http://127.0.0.1:${HOME_LINK_PORT}`, authorization: homeLinkAuthorization(s.state.ownToken), serviceId: s.state.serviceId, deviceId: s.deviceId });
    tell();
  });
}

export function stop(): void {
  const was = link;
  link = null;
  running = false;
  setHomeLinkLogin(null);
  if (!was) return;
  was.closePairing();
  was.server.close();
  // Long polls would hold it open; everything on disk is already whole.
  was.server.closeAllConnections();
}

export function setEnabled(on: boolean): HomeLinkStatus {
  save({ ...read(), enabled: on });
  if (on) start();
  else stop();
  return status();
}

export function openPairing(): HomeLinkStatus {
  if (!link) start();
  link?.openPairing();
  return status();
}

export function closePairing(): HomeLinkStatus {
  link?.closePairing();
  return status();
}

/** A phone taken off: its token doesn't get in any more. */
export function removeDevice(id: string): HomeLinkStatus {
  const s = read();
  save({ ...s, state: { ...s.state, devices: s.state.devices.filter((d) => d.id !== id) } });
  return status();
}
