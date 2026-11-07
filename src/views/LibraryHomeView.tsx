/**
 * Home, Spotify-style, built only from the user's own library: a greeting
 * with quick-access tiles (recently played albums, then mixes), "Made for
 * you" mixes (On Repeat, Rediscover, genre and decade mixes), recently added
 * albums, top artists by plays and recently played songs. An empty library
 * gets a start screen pointing at Local Music, Jellyfin and Navidrome.
 */
import { useMemo } from "react";
import { FolderPlus, Server } from "lucide-react";
import { AlbumTile, ArtistTile, CoverCollage, MixTile, QuickTile } from "../components/LibraryCards";
import { TrackCard } from "../components/Cards";
import { ShelfScroller } from "../components/primitives";
import { useLibraryIndex, type LibAlbum } from "../lib/catalogIndex";
import { albumKeyOf, splitCredits } from "../lib/libraryTracks";
import { allMixes, momentMix } from "../lib/mixes";
import { useMomentScores } from "../lib/moments";
import { energyOf, useSound } from "../stores/sound";
import { songKey, useCatalog, useFreshPlayCounts } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { T } from "../lib/i18n";

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return T("Good morning");
  if (h >= 12 && h < 18) return T("Good afternoon");
  return T("Good evening");
}

function Shelf({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[21px] mb-4">{title}</h2>
      <ShelfScroller>{children}</ShelfScroller>
    </section>
  );
}

export function LibraryHomeView() {
  const { tracks, albums, artists, loaded } = useLibraryIndex();
  const playCounts = useCatalog((s) => s.playCounts);
  const history = useLibrary((s) => s.history);
  const navigate = useUI((s) => s.navigate);
  useFreshPlayCounts();

  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const albumByKey = useMemo(() => new Map(albums.map((a) => [a.key, a])), [albums]);

  /** Distinct albums from the listening history, most recent first. */
  const recentAlbums = useMemo(() => {
    const out: LibAlbum[] = [];
    const seen = new Set<string>();
    for (const h of history) {
      const key = albumKeyOf(byId.get(h.id) ?? h);
      const album = key ? albumByKey.get(key) : undefined;
      if (!album || seen.has(album.key)) continue;
      seen.add(album.key);
      out.push(album);
      if (out.length >= 8) break;
    }
    return out;
  }, [history, byId, albumByKey]);

  /** History entries still in the library, with their current cover/route data. */
  const recentTracks = useMemo(() => {
    const out: Track[] = [];
    const seen = new Set<string>();
    for (const h of history) {
      const t = byId.get(h.id);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= 14) break;
    }
    return out;
  }, [history, byId]);

  const recentlyAdded = useMemo(() => [...albums].sort((a, b) => b.addedAt - a.addedAt).slice(0, 14), [albums]);
  // The time-of-day mix leads: it's the one that changes with the hour.
  const moment = useMomentScores();
  const sound = useSound((s) => s.facts);
  const mixes = useMemo(() => {
    const now = momentMix(tracks, moment.scores, songKey, moment.at || Date.now());
    const rest = allMixes(tracks, playCounts, (t) => energyOf(t, sound));
    return now ? [now, ...rest] : rest;
  }, [tracks, playCounts, moment.scores, moment.at, sound]);

  const topArtists = useMemo(() => {
    const plays = new Map<string, number>();
    for (const t of tracks) {
      const n = playCounts[t.id]?.plays ?? 0;
      if (!n) continue;
      // Every credited artist earns the plays — "A, B" counts for A and for B.
      for (const name of splitCredits(t.artist)) {
        const key = name.toLowerCase();
        plays.set(key, (plays.get(key) ?? 0) + n);
      }
    }
    return artists
      .filter((a) => plays.has(a.name.toLowerCase()))
      .sort((a, b) => (plays.get(b.name.toLowerCase()) ?? 0) - (plays.get(a.name.toLowerCase()) ?? 0))
      .slice(0, 12);
  }, [tracks, artists, playCounts]);

  if (!loaded) return null;

  if (!tracks.length) {
    return (
      <div className="max-w-[640px] pt-10 space-y-6 animate-slide-up">
        <h1 className="font-display text-[40px] font-extrabold tracking-[-0.03em] text-ink-hi">{greeting()}</h1>
        <p className="text-[15px] text-ink-dim">{T("Your library is empty. Add a music folder or connect your media server — covers, artist photos, bios and lyrics are filled in from open databases.")}</p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => navigate({ name: "local" })}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-primary text-on-primary text-[14px] font-bold hover:scale-[1.02] transition-transform"
          >
            <FolderPlus className="w-4 h-4" />{" "}{T("Add music folders")}</button>
          <button
            onClick={() => navigate({ name: "jellyfin" })}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-ink-hi/[0.08] text-ink-hi text-[14px] font-bold hover:bg-ink-hi/[0.14] transition-colors"
          >
            <Server className="w-4 h-4" />{" "}{T("Connect Jellyfin")}</button>
          <button
            onClick={() => navigate({ name: "subsonic" })}
            className="inline-flex items-center gap-2 h-11 px-5 rounded-full bg-ink-hi/[0.08] text-ink-hi text-[14px] font-bold hover:bg-ink-hi/[0.14] transition-colors"
          >
            <Server className="w-4 h-4" />{" "}{T("Connect Navidrome")}</button>
        </div>
      </div>
    );
  }

  // Quick access: recent albums first, topped up with mixes.
  const quick: { id: string; title: string; thumb?: string; art?: React.ReactNode; open: () => void; play: () => void }[] = [
    ...recentAlbums.map((a) => ({
      id: a.key,
      title: a.title,
      thumb: a.thumb,
      open: () => navigate({ name: "album", param: a.route }),
      play: () => usePlayer.getState().playAll(a.tracks),
    })),
    ...mixes.map((m) => ({
      id: m.id,
      title: m.title,
      thumb: m.tracks[0]?.thumb,
      art: <CoverCollage tracks={m.tracks} className="w-16 h-16" />,
      open: () => navigate({ name: "mix", param: m.id }),
      play: () => usePlayer.getState().playAll(m.tracks),
    })),
  ].slice(0, 8);

  return (
    <div className="space-y-9">
      <section className="animate-slide-up">
        <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi mb-5">{greeting()}</h1>
        {/* As many columns as the panel has room for, four at most: the tiles' titles stay readable. */}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(max(240px,calc(25%-8px)),1fr))] gap-2.5">
          {quick.map((q) => (
            <QuickTile key={q.id} title={q.title} thumb={q.thumb} art={q.art} onOpen={q.open} onPlay={q.play} />
          ))}
        </div>
      </section>

      {mixes.length > 0 && (
        <Shelf title={T("Made for you")}>
          {mixes.map((m) => (
            <MixTile key={m.id} title={m.title} subtitle={m.subtitle} tracks={m.tracks} route={m.id} />
          ))}
        </Shelf>
      )}

      {recentlyAdded.length > 0 && (
        <Shelf title={T("Recently added")}>
          {recentlyAdded.map((a) => (
            <AlbumTile key={a.key} album={a} />
          ))}
        </Shelf>
      )}

      {topArtists.length > 0 && (
        <Shelf title={T("Your top artists")}>
          {topArtists.map((a) => (
            <ArtistTile key={a.name} name={a.name} route={a.route} fallbackThumb={a.thumb} subtitle={T("Artist")} />
          ))}
        </Shelf>
      )}

      {recentTracks.length > 0 && (
        <Shelf title={T("Recently played")}>
          {recentTracks.map((t) => (
            <TrackCard key={t.id} track={t} />
          ))}
        </Shelf>
      )}
    </div>
  );
}
