/**
 * An album's genres by a vote (the user's wish for smarter genres, 2026-11-15): its songs' tags,
 * MusicBrainz's community-voted genres for it and the genres Wikidata states for it
 * (electron/album-genres.ts), each spelling folded into one genre (lib/genres.ts). The tags count
 * most where most songs carry them; MusicBrainz by its votes; Wikidata a little. Where neither
 * database knows the album, its tags stand as they are.
 */
import { create } from "zustand";
import type { AlbumGenreEntry } from "../../electron/album-genres";
import { useCatalog } from "../stores/catalog";
import { useSettings } from "../stores/settings";
import type { Track } from "../types";
import { albumKeyOf } from "./libraryCore";
import { serviceOn } from "./netPolicy";
import { genreKey, genreName, splitGenres } from "./genres";

/** At most this many genres for an album. */
const MOST = 3;

/**
 * The vote, for one album: its songs' tags (how many of `songs` carry each), and what the databases
 * said. Null where they said nothing: the tags stand. Pure, for tests.
 */
export function voteAlbumGenres(tags: Map<string, number>, songs: number, entry: Pick<AlbumGenreEntry, "mb" | "wikidata"> | undefined): string[] | null {
  const mb = entry?.mb ?? [];
  const wikidata = entry?.wikidata ?? [];
  if (!mb.length && !wikidata.length) return null;
  const scores = new Map<string, { name: string; score: number }>();
  const add = (raw: string, score: number): void => {
    const name = genreName(raw);
    const key = genreKey(name);
    if (!key) return;
    const was = scores.get(key);
    if (was) was.score += score;
    else scores.set(key, { name, score });
  };
  // A tag on every song counts 3, on half of them 1.5.
  for (const [tag, count] of tags) add(tag, 3 * Math.min(1, count / Math.max(1, songs)));
  const most = Math.max(1, ...mb.map((g) => g.count));
  for (const g of mb) add(g.name, 3 * Math.max(0.2, g.count / most));
  for (const g of wikidata) add(g, 1.5);
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  const top = ranked[0]?.score ?? 0;
  const kept = ranked.filter((g) => g.score >= Math.max(1.5, top * 0.4)).slice(0, MOST);
  return kept.length ? kept.map((g) => g.name) : null;
}

interface AlbumGenresState {
  known: Record<string, AlbumGenreEntry>;
  /** album key → its voted genres, where the databases knew it */
  voted: Map<string, string[]>;
}

export const useAlbumGenres = create<AlbumGenresState>(() => ({ known: {}, voted: new Map() }));

/** The votes for the catalogue's albums, from what the databases said. */
function votesFor(tracks: Track[], known: Record<string, AlbumGenreEntry>): Map<string, string[]> {
  const byAlbum = new Map<string, Track[]>();
  for (const t of tracks) {
    const key = albumKeyOf(t);
    if (!key || !known[key]) continue;
    const list = byAlbum.get(key);
    if (list) list.push(t);
    else byAlbum.set(key, [t]);
  }
  const out = new Map<string, string[]>();
  for (const [key, songs] of byAlbum) {
    const tags = new Map<string, number>();
    for (const t of songs) for (const g of splitGenres(t.genre)) tags.set(g, (tags.get(g) ?? 0) + 1);
    const vote = voteAlbumGenres(tags, songs.length, known[key]);
    if (vote) out.set(key, vote);
  }
  return out;
}

/**
 * A song's genres as the library shows them: its album's vote where there is one, else its own tags
 * (lib/genres.ts). Read by the genre pages, Klingt wie, smart playlists and Replay.
 */
export function genresOfTrack(t: Track): string[] {
  const key = albumKeyOf(t);
  return (key && useAlbumGenres.getState().voted.get(key)) || splitGenres(t.genre);
}

/**
 * Mount once (App): reads what's known, asks the databases about the albums they weren't asked about
 * (while the setting allows), and votes again when answers come or the catalogue changes.
 */
export function watchAlbumGenres(): () => void {
  let asked = false;
  const revote = (): void => {
    const { known } = useAlbumGenres.getState();
    useAlbumGenres.setState({ voted: useSettings.getState().albumGenresOnline ? votesFor(useCatalog.getState().tracks, known) : new Map() });
  };
  const read = async (): Promise<void> => {
    const known = (await window.bytune?.albumGenresKnown().catch(() => null)) ?? {};
    useAlbumGenres.setState({ known });
    revote();
  };
  const ask = (): void => {
    // MusicBrainz switched off (Settings → Network & privacy): nobody is asked.
    if (!useSettings.getState().albumGenresOnline || !serviceOn("musicbrainz") || !useCatalog.getState().loaded) return;
    const albums = new Map<string, { key: string; title: string; artist: string }>();
    for (const t of useCatalog.getState().tracks) {
      const key = albumKeyOf(t);
      if (key && t.album && !albums.has(key)) albums.set(key, { key, title: t.album, artist: t.albumArtist || t.artist });
    }
    void window.bytune?.albumGenresAsk([...albums.values()]).catch(() => 0);
    asked = true;
  };
  void read().then(() => ask());
  const offAnswers = window.bytune?.onAlbumGenres(() => void read());
  const offCatalog = useCatalog.subscribe((s, prev) => {
    if (s.tracks === prev.tracks) return;
    revote();
    // New albums in the library are asked about too (the known ones are left out in the main process).
    if (s.loaded && (!asked || s.tracks.length !== prev.tracks.length)) ask();
  });
  const offSettings = useSettings.subscribe((s, prev) => {
    const on = s.albumGenresOnline && serviceOn("musicbrainz", s);
    if (on === (prev.albumGenresOnline && serviceOn("musicbrainz", prev))) return;
    revote();
    if (on) ask();
    else void window.bytune?.albumGenresStop().catch(() => undefined);
  });
  return () => {
    offAnswers?.();
    offCatalog();
    offSettings();
  };
}
