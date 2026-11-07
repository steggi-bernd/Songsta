/**
 * About-the-artist data for the playing track — the right rail's card.
 *
 * Resolved by name through the open databases in the main process
 * (electron/metadata.ts): MusicBrainz for identity and facts, Wikidata for
 * the links, Wikipedia (in the app's language, English as fallback) for the
 * bio and Wikimedia Commons for the photo. The main process keeps the
 * answers on disk; this module only memoizes them for the session.
 */
import { useEffect, useState } from "react";
import type { ArtistMeta } from "../../electron/metadata";
import type { ArtistPicture } from "../../electron/wikimedia";
import type { Track } from "../types";
import { leadArtist } from "./libraryTracks";

export interface ArtistAbout {
  /** MusicBrainz artist id */
  artistId: string;
  name: string;
  thumb: string | null;
  /** Wikipedia lead section */
  description: string | null;
  /** "Band · Germany · since 1994" */
  facts: string | null;
  /** the Wikipedia article the bio came from */
  wikiUrl: string | null;
  genres: string[];
}

const JUNK_ARTIST = "unknown artist";

const memo = new Map<string, Promise<ArtistAbout | null>>();

export function resolveArtistAbout(artist: string): Promise<ArtistAbout | null> {
  const key = artist.trim().toLowerCase();
  if (!key || key === JUNK_ARTIST || !window.bytune?.metaArtist) return Promise.resolve(null);
  let job = memo.get(key);
  if (!job) {
    job = (window.bytune.metaArtist(artist) as Promise<ArtistMeta | null>)
      .then((m) =>
        m
          ? {
              artistId: m.mbid,
              name: m.name,
              thumb: m.image,
              description: m.description,
              facts: m.facts,
              wikiUrl: m.wikiUrl,
              genres: m.genres ?? [],
            }
          : null
      )
      .catch(() => {
        memo.delete(key); // transient failure — let the next play retry
        return null;
      });
    memo.set(key, job);
  }
  return job;
}

/** The playing track's artist about-card data — its first credited artist ("A, B" asks about A). */
export function useArtistAbout(track: Track | null): ArtistAbout | null {
  const artist = track ? leadArtist(track.artist) : "";
  const [data, setData] = useState<ArtistAbout | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void resolveArtistAbout(artist).then((res) => {
      if (!cancelled) setData(res);
    });
    return () => {
      cancelled = true;
    };
  }, [artist]);

  return data;
}

const pictures = new Map<string, Promise<ArtistPicture | null>>();

/** The artist's Wikimedia picture at banner size, with its size — for the artist page's banner (lib/artistBanner.ts). */
export function resolveArtistPicture(artist: string): Promise<ArtistPicture | null> {
  const key = artist.trim().toLowerCase();
  if (!key || key === JUNK_ARTIST || !window.bytune?.metaArtistPicture) return Promise.resolve(null);
  let job = pictures.get(key);
  if (!job) {
    job = window.bytune.metaArtistPicture(artist).catch(() => {
      pictures.delete(key); // offline for now — the next visit asks again
      return null;
    });
    pictures.set(key, job);
  }
  return job;
}

/** The artist page's banner picture; null while asking and when there is none. */
export function useArtistPicture(artist: string): ArtistPicture | null {
  const [picture, setPicture] = useState<ArtistPicture | null>(null);
  useEffect(() => {
    let alive = true;
    setPicture(null);
    void resolveArtistPicture(artist).then((p) => alive && setPicture(p));
    return () => {
      alive = false;
    };
  }, [artist]);
  return picture;
}
