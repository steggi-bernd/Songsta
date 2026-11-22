/**
 * Phones at home without a sync service: this computer runs the same service (sync-server/server.mjs)
 * for the devices paired with it, so playlists, the library's order, what plays where and the shared
 * listening history work as with one, while Songsta is open here.
 *
 * A phone finds it by asking the addresses of its network (GET /v1/hello), pairs once with the code
 * this computer shows (POST /v1/pair) and from then on signs its requests with the token it got. This
 * computer uses a token of its own. Only paired devices and this computer get in, and only from the
 * local network; of a token only its hash is kept, so the file says nothing that would let anyone in.
 *
 * A song only this computer has plays on a paired phone from here (GET /v1/files/<id>): its player
 * fetches it by address, so that address carries a key of its own, given at pairing, that opens the
 * songs and nothing else.
 *
 * Pure Node, no Electron: electron/home-link.ts keeps the state and starts it, the tests run it as is.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createSyncHandler } from "../sync-server/server.mjs";

export const HOME_LINK_PORT = 8197;
/** How long the code shown here lets a phone pair. */
export const PAIRING_MS = 5 * 60_000;
/** Wrong codes before the pairing closes: a code of six digits isn't guessed in five tries. */
export const PAIRING_TRIES = 5;
const MAX_PAIR_BYTES = 4096;
const DEVICE_ID = /^[A-Za-z0-9._:-]{1,80}$/;

export interface PairedDevice {
  id: string;
  name: string;
  kind: "phone" | "computer";
  /** sha256 of the token it got */
  hash: string;
  /** sha256 of the key that fetches songs from here */
  filesHash?: string;
  pairedAt: number;
}

export interface HomeLinkState {
  /** which service this is, whatever address it's reached at */
  serviceId: string;
  /** whose documents: everything here is one person's */
  userId: string;
  /** this computer's own token, for its own requests */
  ownToken: string;
  devices: PairedDevice[];
}

export interface HomeLinkHost {
  dataDir: string;
  /** this computer's name, as phones show it */
  name(): string;
  read(): HomeLinkState;
  write(state: HomeLinkState): void;
  /** a device paired, or the pairing closed */
  changed?(): void;
  /** One of this computer's songs, to a paired device's player; false: not one it can hand out. */
  serveFile?(id: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface HomeLink {
  server: Server;
  openPairing(): { code: string; until: number };
  closePairing(): void;
  pairing(): { code: string; until: number } | null;
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const hashOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export function newHomeLinkState(): HomeLinkState {
  return { serviceId: hex(8), userId: hex(16), ownToken: hex(32), devices: [] };
}

/** The header a device signs with. */
export const homeLinkAuthorization = (token: string): string => `Songsta Token="${token}"`;

function tokenOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || header.length > 512) return null;
  return /^Songsta Token="([a-f0-9]{64})"$/.exec(header)?.[1] ?? null;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A device on this network, or this computer: nothing from farther away is let in. */
export function fromHomeNetwork(remote: string | undefined): boolean {
  if (!remote) return false;
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/i.exec(remote);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const v6 = remote.toLowerCase();
  return v6 === "::1" || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readSmallBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PAIR_BYTES) {
        reject(new Error("too big"));
        req.destroy();
      } else parts.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "null"));
      } catch {
        reject(new Error("not JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createHomeLink(host: HomeLinkHost): HomeLink {
  let open: { code: string; until: number; tries: number } | null = null;
  const current = (): typeof open => (open && open.until > Date.now() ? open : null);

  const sync = createSyncHandler({
    dataDir: host.dataDir,
    authenticate(req) {
      const token = tokenOf(req);
      if (!token) return null;
      const state = host.read();
      const hash = hashOf(token);
      const known = sameText(hash, hashOf(state.ownToken)) || state.devices.some((d) => sameText(hash, d.hash));
      return known ? state.userId : null;
    },
  });

  async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = current();
    if (!now) return reply(res, 410, { error: "Pairing isn't open on the computer" });
    let body: { code?: unknown; device?: { id?: unknown; name?: unknown; kind?: unknown } } | null;
    try {
      body = (await readSmallBody(req)) as typeof body;
    } catch {
      return reply(res, 400, { error: "A pairing is a small object" });
    }
    const id = typeof body?.device?.id === "string" ? body.device.id : "";
    const name = typeof body?.device?.name === "string" ? body.device.name.trim().slice(0, 60) : "";
    if (!DEVICE_ID.test(id) || !name || typeof body?.code !== "string") return reply(res, 400, { error: "A pairing names the device and the code" });
    if (!sameText(body.code.trim(), now.code)) {
      now.tries += 1;
      if (now.tries >= PAIRING_TRIES) {
        open = null;
        host.changed?.();
      }
      return reply(res, 403, { error: "Wrong code" });
    }
    const token = hex(32);
    const filesKey = hex(32);
    const state = host.read();
    const device: PairedDevice = { id, name, kind: body.device?.kind === "computer" ? "computer" : "phone", hash: hashOf(token), filesHash: hashOf(filesKey), pairedAt: Date.now() };
    host.write({ ...state, devices: [...state.devices.filter((d) => d.id !== id), device] });
    open = null;
    host.changed?.();
    reply(res, 200, { token, filesKey, id: state.serviceId, name: host.name() });
  }

  /** A song for a paired device's player: its id in the address, the device's files key beside it. */
  async function file(req: IncomingMessage, res: ServerResponse, encoded: string, key: string | null): Promise<void> {
    if (!key || !/^[a-f0-9]{64}$/.test(key)) return reply(res, 401, { error: "No key for songs" });
    const hash = hashOf(key);
    if (!host.read().devices.some((d) => d.filesHash && sameText(hash, d.filesHash))) return reply(res, 401, { error: "Not paired with this computer" });
    let id = "";
    try {
      id = Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      /* not an id */
    }
    if (!id || id.length > 2048 || !host.serveFile || !(await host.serveFile(id, req, res))) {
      if (!res.headersSent) reply(res, 404, { error: "Not a song of this computer" });
    }
  }

  const server = createServer((req, res) => {
    if (!fromHomeNetwork(req.socket.remoteAddress)) return reply(res, 403, { error: "Only for devices at home" });
    const pathname = new URL(req.url ?? "/", "http://home").pathname;
    if (pathname === "/v1/hello" && req.method === "GET") {
      return reply(res, 200, { songsta: "home", api: 1, id: host.read().serviceId, name: host.name(), pairing: !!current() });
    }
    if (pathname === "/v1/pair" && req.method === "POST") {
      pair(req, res).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: "Something went wrong" });
      });
      return;
    }
    const song = /^\/v1\/files\/([A-Za-z0-9_-]{1,2800})$/.exec(pathname);
    if (song && (req.method === "GET" || req.method === "HEAD")) {
      file(req, res, song[1], new URL(req.url ?? "/", "http://home").searchParams.get("key")).catch(() => {
        if (!res.headersSent) reply(res, 500, { error: "Something went wrong" });
        else res.destroy();
      });
      return;
    }
    sync(req, res);
  });

  return {
    server,
    openPairing() {
      open = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), until: Date.now() + PAIRING_MS, tries: 0 };
      return { code: open.code, until: open.until };
    },
    closePairing() {
      open = null;
    },
    pairing() {
      const now = current();
      return now ? { code: now.code, until: now.until } : null;
    },
  };
}
