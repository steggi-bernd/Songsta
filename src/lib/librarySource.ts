/**
 * Where a library song plays from. A song found in several places is tried
 * in its playback order (lib/duplicates.ts): the local file first, then the
 * servers' streams. Server copies whose server is known to be away right now
 * are skipped up front — an unanswered stream would only fail after a
 * network timeout — while local copies are always tried, because the main
 * process checks the file itself and answers at once.
 */
import { requireBridge } from "./bridge";
import { versionsOf } from "../stores/catalog";
import { sourceOf, useAvailability, versionAvailable } from "../stores/availability";
import { phoneAddressOf } from "./peerSongs";
import type { Track } from "../types";

export interface LibrarySource {
  url: string;
  /** the copy that answered (its codec, resolution and gain are what plays) */
  version: Track;
}

/** The versions worth trying, in order, minus any the caller rules out (e.g. one that already failed). */
export function playableVersions(track: Track, exclude?: ReadonlySet<string>): Track[] {
  const s = useAvailability.getState();
  return versionsOf(track).filter(
    (v) => !exclude?.has(v.id) && (sourceOf(v) === "local" || versionAvailable(v, s))
  );
}

export async function resolveLibrarySource(track: Track, exclude?: ReadonlySet<string>): Promise<LibrarySource | null> {
  const bridge = requireBridge();
  // Only a linked phone has it: from the phone, through this computer's stream proxy.
  const phone = phoneAddressOf(track.id);
  if (phone && !exclude?.has(track.id)) {
    const url = await bridge.peerTrackUrl?.(phone);
    if (url) return { url, version: track };
  }
  for (const version of playableVersions(track, exclude)) {
    const url = await bridge.localTrackUrl(version.id);
    if (url) return { url, version };
  }
  return null;
}
