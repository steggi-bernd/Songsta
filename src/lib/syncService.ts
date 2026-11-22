/**
 * Whether the sync service a device is linked to keeps everything this app syncs: what it says
 * about itself at /health (sync-server/server.mjs), its version and its documents. Only asked of a
 * service a device has reached (lib/syncEngine.ts): without one, nothing is looked up or said.
 * Pure, one copy for the desktop and the phone.
 */
import { REQUIRED_LIBRARY_DOCS, type LibraryDocName } from "./librarySync";
import { isNewerVersion } from "./newVersion";

/**
 * The oldest service this app is content with. Services say their version from this one on, and
 * every one that does keeps the library's documents; a later app that needs more raises it.
 */
export const SYNC_SERVICE_MIN_VERSION = "1.5.0";

/** What updates a service run from the ready image (sync-server/docker-compose.yml), in its folder. */
export const SYNC_UPDATE_COMMAND = "docker compose pull && docker compose up -d";

export interface SyncServiceInfo {
  /** the release it came with; older services don't say */
  version?: string;
  /** the documents it keeps; services from before the library's documents don't say */
  docs?: string[];
  /** what else it can do: "commands-kept", "command-results", "lists" (2026-11-21); older ones say less */
  features?: string[];
}

export interface SyncServiceProblem {
  /** the documents this app syncs that the service doesn't keep: they stay on each device */
  missing: LibraryDocName[];
  version?: string;
}

/** What a service's /health answer says, if it is one. */
export function readServiceInfo(body: unknown): SyncServiceInfo | null {
  const b = body as { service?: unknown; version?: unknown; docs?: unknown; features?: unknown } | null;
  if (!b || typeof b !== "object" || b.service !== "songsta-sync") return null;
  const info: SyncServiceInfo = {};
  if (typeof b.version === "string" && b.version.trim()) info.version = b.version.trim();
  if (Array.isArray(b.docs)) info.docs = b.docs.filter((d): d is string => typeof d === "string");
  if (Array.isArray(b.features)) info.features = b.features.filter((f): f is string => typeof f === "string");
  return info;
}

/** Why the service is too old for this app, or null when it isn't (or can't be judged). */
export function serviceProblem(info: SyncServiceInfo | null): SyncServiceProblem | null {
  if (!info) return null;
  // The sound documents (lib/soundShare.ts) are left out: without them a service is no older than it was.
  const missing = REQUIRED_LIBRARY_DOCS.filter((name) => !info.docs?.includes(name));
  const behind = !!info.version && isNewerVersion(SYNC_SERVICE_MIN_VERSION, info.version);
  if (!missing.length && !behind) return null;
  return { missing: behind && !missing.length ? [...REQUIRED_LIBRARY_DOCS] : missing, ...(info.version ? { version: info.version } : {}) };
}

/** The same problem, as one word to remember it was told: told once, not again until it changes. */
export const problemKey = (problem: SyncServiceProblem): string => `${problem.version ?? "?"}:${problem.missing.join(",")}`;
