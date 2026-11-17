/**
 * The phone's side of Settings → Network & privacy: every request of the app's own (fetch, wrapped once
 * at the start, index.ts) to a service switched off is held back; your server, the sync service and the
 * home network always go (src/lib/netServices.ts). The phone asks few services: MusicBrainz, Wikipedia,
 * Genius, LRCLIB, and GitHub for new versions.
 */
import { defaultSyncAddress, hostsOf, judgeRequest } from "./shared";
import { useSettings } from "./stores/settings";

/** Addresses you just typed in for a server of your own, by name → until when: trusted while it's set up, before it's saved. */
const entered = new Map<string, number>();
const ENTERED_FOR_MS = 10 * 60_000;

/**
 * An address you typed in for a server of your own (a login, the address away, a logout once the login
 * is gone): it goes through even with "only my own servers" on, while it's being set up.
 */
export function trustEntered(address: unknown): void {
  if (typeof address !== "string" || !address.trim()) return;
  const raw = address.trim();
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  for (const host of hostsOf([value])) entered.set(host, Date.now() + ENTERED_FOR_MS);
}

/** Your own servers' names, read when asked (the stores load after this module). */
function ownHosts(): Set<string> {
  const { useSession } = require("./stores/session") as typeof import("./stores/session");
  const { useSync } = require("./sync") as typeof import("./sync");
  const session = useSession.getState().session;
  const custom = useSync.getState().customAddress;
  const hosts = hostsOf([session?.server, session?.home, session?.away, custom, session?.server ? defaultSyncAddress(session.server) : null]);
  const now = Date.now();
  for (const [host, until] of entered) {
    if (until > now) hosts.add(host);
    else entered.delete(host);
  }
  return hosts;
}

/** Whether a request may go out now. */
export function allowedUrl(url: string): boolean {
  const s = useSettings.getState();
  return judgeRequest(url, { ownOnly: s.netOwnOnly, off: s.netOff }, ownHosts()).allowed;
}

/** Once, after the settings are read: the app's requests go through the switches. */
export function installNetGate(): void {
  const real = globalThis.fetch;
  if ((real as { netGate?: boolean }).netGate) return;
  const gated = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown } | null)?.url ?? "");
    if (/^https?:/i.test(url) && !allowedUrl(url)) return Promise.reject(new TypeError("Switched off in Settings → Network & privacy"));
    return real(input, init);
  }) as typeof fetch & { netGate?: boolean };
  gated.netGate = true;
  globalThis.fetch = gated;
}
