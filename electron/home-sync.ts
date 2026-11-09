/**
 * The desktop's line to the sync service (sync-server/). What to say is decided
 * in the page (lib/homeSync.ts, lib/syncEngine.ts); this side holds the Jellyfin
 * login and makes the requests, so the token never reaches the page.
 */
import * as os from "os";
import { defaultSyncAddress } from "../src/lib/syncEngine";
import * as jellyfin from "./jellyfin";
import * as persist from "./persist";

const STORE = "home-sync";
const MAX_TIMEOUT_MS = 60_000;
const ALLOWED_PATH = /^\/v1\/(docs\/[a-z]+|changes\?since=-?\d+&wait=\d+(&device=[A-Za-z0-9._%:-]+)?|devices(\/[A-Za-z0-9._%:-]+(\/commands)?)?)$/;
/** What the service says about itself: its version and documents, asked once it's linked. */
const HEALTH_PATH = "/health";

export interface HomeSyncInfo {
  /** a Jellyfin login with a user to sync for */
  ready: boolean;
  /** signed in with an API key and no user chosen yet */
  needsUser: boolean;
  deviceId: string;
  deviceName: string;
  address: string | null;
  customAddress: string;
  /** which server this is, whatever address it's reached at: another server is looked for afresh */
  serverKey: string | null;
}

function customAddress(): string {
  const raw = persist.readData(STORE) as { address?: unknown } | null;
  return typeof raw?.address === "string" ? raw.address : "";
}

function addressFor(server: string | undefined): string | null {
  return customAddress() || (server ? defaultSyncAddress(server) : null);
}

export function info(): HomeSyncInfo {
  const login = jellyfin.syncLogin();
  return {
    ready: !!login?.userId,
    needsUser: !!login && !login.userId,
    deviceId: login?.deviceId ?? "",
    deviceName: os.hostname(),
    address: addressFor(login?.server),
    customAddress: customAddress(),
    serverKey: login ? `${login.serverId || login.server}|${customAddress()}` : null,
  };
}

export async function setAddress(value: string): Promise<HomeSyncInfo> {
  const address = value.trim() ? jellyfin.normalizeServer(value) : "";
  await persist.writeData(STORE, { address });
  return info();
}

export async function request(method: unknown, path: unknown, body: unknown, timeoutMs: unknown): Promise<{ status: number; body: unknown }> {
  if (method !== "GET" && method !== "PUT" && method !== "POST") throw new Error("Not a request for the sync service");
  if (typeof path !== "string" || !(ALLOWED_PATH.test(path) || (method === "GET" && path === HEALTH_PATH))) {
    throw new Error("Not a request for the sync service");
  }
  const login = jellyfin.syncLogin();
  const base = addressFor(login?.server);
  if (!login?.userId || !base) throw new Error("No login to sync with");
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: login.authorization,
      "X-Songsta-User": login.userId,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Math.min(MAX_TIMEOUT_MS, typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : MAX_TIMEOUT_MS)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
