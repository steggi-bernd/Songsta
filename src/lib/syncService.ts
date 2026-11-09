/**
 * Whether the sync service a device is linked to keeps everything this app syncs: what it says
 * about itself at /health (sync-server/server.mjs), its version and its documents. Only asked of a
 * service a device has reached (lib/syncEngine.ts): without one, nothing is looked up or said.
 * Pure, one copy for the desktop and the phone.
 */
import { LIBRARY_DOCS, type LibraryDocName } from "./librarySync";
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
}

export interface SyncServiceProblem {
  /** the documents this app syncs that the service doesn't keep: they stay on each device */
  missing: LibraryDocName[];
  version?: string;
}

/** What a service's /health answer says, if it is one. */
export function readServiceInfo(body: unknown): SyncServiceInfo | null {
  const b = body as { service?: unknown; version?: unknown; docs?: unknown } | null;
  if (!b || typeof b !== "object" || b.service !== "songsta-sync") return null;
  const info: SyncServiceInfo = {};
  if (typeof b.version === "string" && b.version.trim()) info.version = b.version.trim();
  if (Array.isArray(b.docs)) info.docs = b.docs.filter((d): d is string => typeof d === "string");
  return info;
}

/** Why the service is too old for this app, or null when it isn't (or can't be judged). */
export function serviceProblem(info: SyncServiceInfo | null): SyncServiceProblem | null {
  if (!info) return null;
  const missing = LIBRARY_DOCS.filter((name) => !info.docs?.includes(name));
  const behind = !!info.version && isNewerVersion(SYNC_SERVICE_MIN_VERSION, info.version);
  if (!missing.length && !behind) return null;
  return { missing: behind && !missing.length ? [...LIBRARY_DOCS] : missing, ...(info.version ? { version: info.version } : {}) };
}

/** The same problem, as one word to remember it was told: told once, not again until it changes. */
export const problemKey = (problem: SyncServiceProblem): string => `${problem.version ?? "?"}:${problem.missing.join(",")}`;
