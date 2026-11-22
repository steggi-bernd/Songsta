/**
 * Linked to a computer at home, in homes without a sync service: the computer runs the service
 * (electron/home-link-server.ts), this phone pairs once with the code it shows and from then on uses it
 * like any sync service (sync.ts). A computer is found by asking the addresses of this phone's network
 * on the port it listens on: only when somebody looks for one here, or when the linked one isn't at its
 * address any more (a new one from the router). A song only the computer has plays here from there, by
 * an address with the files key it gave at pairing (songFromComputer).
 */
import { randomUUID } from "expo-crypto";
import Player from "../modules/media3-player";
import { mimeOf, utf8Bytes } from "./shared";
import { readJson, removeJson, writeJson } from "./storage";

export const HOME_LINK_PORT = 8197;
const FILE = "home-link.json";
const ASK_MS = 1500;
/** Addresses asked at the same time. */
const AT_ONCE = 48;

export interface HomeLink {
  address: string;
  /** the computer's service, whatever address it's at */
  id: string;
  name: string;
  token: string;
  /** opens the computer's songs and nothing else (none from before songs came from there) */
  filesKey?: string;
}

export interface FoundComputer {
  address: string;
  id: string;
  name: string;
  /** it shows a code right now */
  pairing: boolean;
}

interface Saved {
  link?: HomeLink | null;
  /** this phone among the computer's devices, the same each time */
  deviceId?: string;
}

let saved: Saved = {};
let loaded: Promise<void> | null = null;

/** Read once; the rest of the time the link is known at once. */
export function loadHomeLink(): Promise<void> {
  loaded ??= readJson<Saved>(FILE).then((s) => {
    saved = s ?? {};
  });
  return loaded;
}

export const homeLink = (): HomeLink | null => saved.link ?? null;

export const homeAuthorization = (token: string): string => `Songsta Token="${token}"`;

/** This phone's id at the computer: its own, kept, so a Jellyfin login or none changes nothing there. */
export function homeDeviceId(): string {
  if (!saved.deviceId) {
    saved = { ...saved, deviceId: `phone-${randomUUID()}` };
    writeJson(FILE, saved);
  }
  return saved.deviceId!;
}

async function ask(url: string, init: RequestInit, ms: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function hello(address: string): Promise<FoundComputer | null> {
  const res = await ask(`${address}/v1/hello`, { headers: { Accept: "application/json" } }, ASK_MS);
  if (!res?.ok) return null;
  try {
    const body = (await res.json()) as { songsta?: unknown; id?: unknown; name?: unknown; pairing?: unknown };
    if (body.songsta !== "home" || typeof body.id !== "string" || typeof body.name !== "string") return null;
    return { address, id: body.id, name: body.name.slice(0, 60), pairing: body.pairing === true };
  } catch {
    return null;
  }
}

/** The computers at home that link phones: every address of this phone's network is asked, a few dozen at a time. */
export async function findComputers(): Promise<FoundComputer[]> {
  const lan = await Player.lanAddress().catch(() => null);
  const parts = lan?.address.split(".").map(Number);
  if (!parts || parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [];
  // A home network is a /24 nearly always; a bigger one is asked in this phone's part of it.
  const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
  const hosts = Array.from({ length: 254 }, (_, i) => i + 1).filter((n) => n !== parts[3]);
  const found: FoundComputer[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: AT_ONCE }, async () => {
      while (next < hosts.length) {
        const host = hosts[next++];
        const one = await hello(`http://${prefix}.${host}:${HOME_LINK_PORT}`);
        if (one && !found.some((f) => f.id === one.id)) found.push(one);
      }
    })
  );
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export type PairResult = "paired" | "wrong" | "closed" | "failed";

/** The code the computer shows, typed in here: linked from now on. */
export async function pairWith(computer: FoundComputer, code: string, device: { name: string }): Promise<PairResult> {
  const res = await ask(
    `${computer.address}/v1/pair`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code: code.replace(/\s+/g, ""), device: { id: homeDeviceId(), name: device.name, kind: "phone" } }),
    },
    8000
  );
  if (!res) return "failed";
  if (res.status === 403) return "wrong";
  if (res.status === 410) return "closed";
  if (!res.ok) return "failed";
  try {
    const body = (await res.json()) as { token?: unknown; filesKey?: unknown; id?: unknown; name?: unknown };
    if (typeof body.token !== "string" || typeof body.id !== "string") return "failed";
    const filesKey = typeof body.filesKey === "string" && /^[a-f0-9]{64}$/.test(body.filesKey) ? body.filesKey : undefined;
    saved = { ...saved, link: { address: computer.address, id: body.id, name: typeof body.name === "string" ? body.name : computer.name, token: body.token, filesKey } };
    writeJson(FILE, saved);
    return "paired";
  } catch {
    return "failed";
  }
}

/** Not linked any more; this phone's id stays, for a later link. */
export function forgetHomeLink(): void {
  saved = { deviceId: saved.deviceId };
  if (saved.deviceId) writeJson(FILE, saved);
  else removeJson(FILE);
}

/** The linked computer doesn't answer at its address: looked for once more, by its id. True when it moved. */
export async function findAgain(): Promise<boolean> {
  const link = homeLink();
  if (!link) return false;
  const same = (await findComputers()).find((c) => c.id === link.id);
  if (!same || same.address === link.address) return false;
  saved = { ...saved, link: { ...link, address: same.address, name: same.name } };
  writeJson(FILE, saved);
  return true;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(text: string): string {
  const bytes = utf8Bytes(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += BASE64URL[(n >> 18) & 63] + BASE64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += BASE64URL[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += BASE64URL[n & 63];
  }
  return out;
}

/**
 * Where this phone's player fetches a song the linked computer has and this phone doesn't: a local file
 * of the computer's, or a server's song through it. Null without a link, or for a song of this phone.
 */
export function songFromComputer(id: string): string | null {
  const link = homeLink();
  if (!link?.filesKey || !/^(local|jf|ss):/.test(id)) return null;
  return `${link.address}/v1/files/${base64url(id)}?key=${link.filesKey}`;
}

/** This phone's own files handed out to the linked computer, by song id: where its file server has them (FileServer.kt). */
const handedOut = new Map<string, string>();
/** Fewer than the file server keeps (2048): an address it has let go of is never passed on, the song goes out afresh. */
const HANDED_OUT_MAX = 1800;

/** A file's own extension, out of its address on the phone (a folder's songs are content:// documents). */
function extensionOf(uri: string): string | null {
  const name = decodeURIComponent(uri).split(/[/:]/).pop() ?? "";
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toLowerCase() ?? null;
}

/**
 * Songs only this phone has (files in its folders), handed out to the linked computer before they go
 * there in a queue or a list: the computer plays them from here (phase 2, the other way). A server's
 * song isn't one: the computer has its own way to the server.
 */
export async function handOutToComputer(tracks: readonly { id: string; localPath?: string; container?: string }[]): Promise<void> {
  const link = homeLink();
  if (!link) return;
  let host = "";
  try {
    host = new URL(link.address).hostname;
  } catch {
    return;
  }
  const fresh = tracks.filter((t) => t.localPath && !handedOut.has(t.id) && !/^(jf|ss):/.test(t.id));
  if (!fresh.length) return;
  const exts = fresh.map((t) => extensionOf(t.localPath!) ?? ((t.container ?? "").split(",")[0].trim().toLowerCase() || "mp3"));
  const addresses = await Player.fileShareMany(
    fresh.map((t) => t.localPath!),
    exts.map((ext) => mimeOf(`.${ext}`)),
    exts,
    host
  ).catch(() => [] as string[]);
  fresh.forEach((t, i) => {
    if (addresses[i]) handedOut.set(t.id, addresses[i]);
  });
  for (const id of handedOut.keys()) {
    if (handedOut.size <= HANDED_OUT_MAX) break;
    handedOut.delete(id);
  }
}

/** Whether any of these must go out to the linked computer first: this phone's own files not handed out yet. */
export function toHandOut(tracks: readonly { id: string; localPath?: string }[]): boolean {
  return !!homeLink() && tracks.some((t) => t.localPath && !handedOut.has(t.id) && !/^(jf|ss):/.test(t.id));
}

/** Where the linked computer fetches this phone's song; nothing for one not handed out. */
export const handedOutAddress = (id: string): string | undefined => handedOut.get(id);

/** The file server stopped: what it handed out is gone with it, and goes out afresh next time. */
export function forgetHandedOut(): void {
  handedOut.clear();
}
