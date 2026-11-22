/**
 * Songs only a phone linked to this computer has (the other way of phase 2): with its queue or a list,
 * the phone says where its own file server hands each of them out (WireTrack.src), and this computer
 * plays them from there, through the stream proxy (electron/stream-proxy.ts proxyUrlForPeer): the page
 * may only load media from this computer itself. Known by the phone's id for the song, while this runs.
 */
import type { WireTrack } from "./playlistSync";
import type { Track } from "../types";

/** A phone's file server at home (mobile FileServer.kt): http, a private address, /song/<token>.<ext>. */
const PHONE_SONG = /^http:\/\/(10|172|192|169)(\.\d{1,3}){3}:\d{2,5}\/song\/[0-9a-f]{32}\.[a-z0-9]{1,5}$/;

const fromPhone = new Map<string, string>();

/** The phone's song as this computer plays it, when the phone said where it hands it out. */
export function songFromPhone(wire: WireTrack): Track | undefined {
  const src = wire.src;
  if (typeof src !== "string" || !PHONE_SONG.test(src)) return undefined;
  fromPhone.set(wire.id, src);
  const { src: _where, ...song } = wire;
  return { thumb: "", ...song } as Track;
}

/** Where a song only the phone has is fetched; nothing for any other song. */
export const phoneAddressOf = (id: string): string | undefined => fromPhone.get(id);
