/**
 * Every request Songsta makes to the internet passes here (Settings → Network & privacy): those of this
 * process (globalThis.fetch, wrapped once at the start) and those of its pages, pictures and videos
 * included (the session's webRequest). A service switched off gets none; with "only my own servers"
 * nothing outside the home network and your own servers does. Each request to the internet is noted
 * for the connection log: when, which service, which address name. No paths, no queries, no tokens,
 * and nothing of it is written to disk.
 */
import type { Session } from "electron";
import { hostsOf, judgeRequest, readPolicy, type NetPolicy } from "../src/lib/netServices";
import * as persist from "./persist";

export interface PrivacyPolicy extends NetPolicy {
  /** plays are counted: the listening history, Replay, play counts */
  recordListening: boolean;
}

export interface NetLogEntry {
  at: number;
  /** a service's id, or "other" */
  service: string;
  host: string;
  blocked: boolean;
}

export interface NetActivity {
  log: NetLogEntry[];
  /** by service id ("other" for the rest): requests let through, blocked, the last one */
  services: Record<string, { count: number; blocked: number; last: number }>;
  /** your own servers and the home network: not logged one by one */
  own: { count: number; last: number };
  since: number;
}

/** The newest this many requests are kept for the log. */
const LOG_KEPT = 400;
/** Your own servers' names are read again after this long (a new login, another address). */
const OWN_FRESH_MS = 20_000;

let policy: PrivacyPolicy | null = null;
let ownAddresses: () => (string | null | undefined)[] = () => [];
let own: { hosts: Set<string>; at: number } = { hosts: new Set(), at: 0 };
const log: NetLogEntry[] = [];
const services = new Map<string, { count: number; blocked: number; last: number }>();
const ownCount = { count: 0, last: 0 };
const since = Date.now();

/** What the saved settings say, before the page has said anything. */
export function privacyFromSettings(raw: unknown): PrivacyPolicy {
  const s = (raw && typeof raw === "object" && "state" in raw ? (raw as { state: unknown }).state : raw) as { recordListening?: unknown } | null;
  return { ...readPolicy(raw), recordListening: s?.recordListening !== false };
}

export function privacy(): PrivacyPolicy {
  policy ??= privacyFromSettings(persist.readData("settings"));
  return policy;
}

/** The page says what's switched on (at the start and on every change). */
export function setPrivacy(raw: unknown): PrivacyPolicy {
  const r = raw as Partial<PrivacyPolicy> | null;
  policy = privacyFromSettings({ netOwnOnly: r?.ownOnly, netOff: r?.off, recordListening: r?.recordListening });
  return policy;
}

/** Addresses you just typed in for a server of your own, by name → until when: trusted while it's set up, before it's saved. */
const entered = new Map<string, number>();
const ENTERED_FOR_MS = 10 * 60_000;

function ownHosts(): Set<string> {
  const now = Date.now();
  if (now - own.at > OWN_FRESH_MS) {
    let addresses: (string | null | undefined)[] | null = null;
    try {
      addresses = ownAddresses();
    } catch {
      /* a login being written: the last list stands */
    }
    // An empty list is a list: the last server signed out of is no longer yours.
    own = { hosts: addresses ? hostsOf(addresses) : own.hosts, at: now };
  }
  if (!entered.size) return own.hosts;
  const hosts = new Set(own.hosts);
  for (const [host, until] of entered) {
    if (until > now) hosts.add(host);
    else entered.delete(host);
  }
  return hosts;
}

/** A new login or address: your own servers are read again at the next request. */
export function ownServersChanged(): void {
  own.at = 0;
}

/**
 * An address you typed in for a server of your own (a login, the address away, the sync service's): it
 * goes through even with "only my own servers" on, while it's being set up and saved.
 */
export function trustEntered(address: unknown): void {
  if (typeof address !== "string" || !address.trim()) return;
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim()) ? address.trim() : `http://${address.trim()}`;
  for (const host of hostsOf([value])) entered.set(host, Date.now() + ENTERED_FOR_MS);
  own.at = 0;
}

function note(service: string, host: string, blocked: boolean): void {
  const now = Date.now();
  log.push({ at: now, service, host, blocked });
  if (log.length > LOG_KEPT) log.splice(0, log.length - LOG_KEPT);
  const s = services.get(service) ?? { count: 0, blocked: 0, last: 0 };
  if (blocked) s.blocked += 1;
  else s.count += 1;
  s.last = now;
  services.set(service, s);
}

/** Whether a request may go out; noted either way. */
export function passes(url: string): boolean {
  const verdict = judgeRequest(url, privacy(), ownHosts());
  if (verdict.kind === "own") {
    ownCount.count += 1;
    ownCount.last = Date.now();
    return true;
  }
  note(verdict.kind === "service" ? verdict.service.id : "other", verdict.host, !verdict.allowed);
  return verdict.allowed;
}

/** A request a switch in Settings held back. */
export class NetBlocked extends Error {
  constructor(url: string) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* none */
    }
    super(`Switched off in Settings → Network & privacy: ${host}`);
    this.name = "NetBlocked";
  }
}

const urlOf = (input: unknown): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : String((input as { url?: unknown } | null)?.url ?? "");

/** Once, first thing: this process' requests go through the gate. `addresses` names your own servers. */
export function installNetGate(addresses: () => (string | null | undefined)[]): void {
  ownAddresses = addresses;
  const real = globalThis.fetch;
  if ((real as { netGate?: boolean }).netGate) return;
  const gated = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = urlOf(input);
    if (/^https?:/i.test(url) && !passes(url)) return Promise.reject(new NetBlocked(url));
    return real(input, init);
  }) as typeof fetch & { netGate?: boolean };
  gated.netGate = true;
  globalThis.fetch = gated;
}

/** The pages' requests (pictures, videos, what they fetch) through the same gate. */
export function gatePages(target: Session): void {
  target.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    callback({ cancel: !passes(details.url) });
  });
}

/** For the connection log in Settings. */
export function netActivity(): NetActivity {
  return { log: log.slice(-200).reverse(), services: Object.fromEntries(services), own: { ...ownCount }, since };
}
