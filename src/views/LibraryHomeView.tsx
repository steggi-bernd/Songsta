/**
 * Home, with what the Your Library page had (the user's wish of 2026-11-21, after their mockup B2): the
 * library's cover wall behind the greeting and its numbers, what plays as a cover with Play/Pause beside
 * what was played last (albums, playlists, artists, Liked Songs, as on Spotify); then Liked Songs, this
 * week, Downloads and Local Music; the albums that joined last, the playlists, the top artists, the
 * genres and the mixes (components/LibraryFront.tsx and views/LibraryView.tsx hold the parts). An empty
 * library gets a start screen pointing at Local Music, Jellyfin and Navidrome.
 */
import { useMemo } from "react";
import { FolderPlus, Server } from "lucide-react";
import { ArtistTile } from "../components/LibraryCards";
import { ByGenre, HomeHead, LibraryTiles, NewOnTheWall } from "../components/LibraryFront";
import { MixGallery } from "../components/MixGallery";
import { ShelfScroller } from "../components/primitives";
import { useLibraryIndex } from "../lib/catalogIndex";
import { splitCredits } from "../lib/libraryTracks";
import { useCatalog, useFreshPlayCounts } from "../stores/catalog";
import { useUI } from "../stores/ui";
import { T } from "../lib/i18n";
import { PlaylistsSection, useDownloadedCount } from "./LibraryView";

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return T("Good morning");
  if (h >= 12 && h < 18) return T("Good afternoon");
  return T("Good evening");
}

export function LibraryHomeView() {
  const { tracks, artists, loaded } = useLibraryIndex();
  const playCounts = useCatalog((s) => s.playCounts);
  const navigate = useUI((s) => s.navigate);
  const downloaded = useDownloadedCount();
  useFreshPlayCounts();

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

  return (
    <div className="pb-12">
      <HomeHead />
      <LibraryTiles downloaded={downloaded} />
      <NewOnTheWall />
      <PlaylistsSection />
      {/* The top artists right under the playlists, above the genres (the user's wish, 2026-11-22). */}
      {topArtists.length > 0 && (
        <section className="mt-12">
          <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi mb-5">{T("Your top artists")}</h2>
          <ShelfScroller>
            {topArtists.map((a) => (
              <ArtistTile key={a.name} name={a.name} route={a.route} fallbackThumb={a.thumb} subtitle={T("Artist")} />
            ))}
          </ShelfScroller>
        </section>
      )}
      <ByGenre />
      <MixGallery />
    </div>
  );
}
