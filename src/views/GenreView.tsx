/**
 * One genre of the library as a page: every song tagged with it (not the
 * home page's 50-song mix), its albums newest first, play and shuffle.
 * Opened from Explore's genre list.
 */
import { useMemo } from "react";
import { Tags } from "lucide-react";
import { AlbumTile, CollectionHeader } from "../components/LibraryCards";
import { TrackList } from "../components/TrackList";
import { EmptyState, ShelfScroller } from "../components/primitives";
import { newestFirst, useLibraryGenres, useLibraryIndex } from "../lib/catalogIndex";
import { genreKey } from "../lib/genres";
import { genresOfTrack } from "../lib/albumGenres";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";

export function GenreView({ param }: { param: string }) {
  const { albums, loaded } = useLibraryIndex();
  const genres = useLibraryGenres();
  const key = useMemo(() => {
    try {
      return decodeURIComponent(param);
    } catch {
      return param;
    }
  }, [param]);
  const genre = useMemo(() => genres.find((g) => g.key === key) ?? null, [genres, key]);
  const own = useMemo(
    () => (genre ? albums.filter((a) => a.tracks.some((t) => genresOfTrack(t).some((g) => genreKey(g) === genreKey(genre.name)))).sort(newestFirst) : []),
    [albums, genre]
  );
  // Album by album, each in its own order — the way the shelf above lists them.
  const songs = useMemo(() => {
    if (!genre) return [];
    const inGenre = new Set(genre.tracks.map((t) => t.id));
    const listed = own.flatMap((a) => a.tracks.filter((t) => inGenre.has(t.id)));
    const seen = new Set(listed.map((t) => t.id));
    return [...listed, ...genre.tracks.filter((t) => !seen.has(t.id))];
  }, [genre, own]);

  if (!loaded) return null;
  if (!genre) return <EmptyState icon={Tags} title={T("No songs in this genre")} body={T("None of the songs in your library carry this genre anymore.")} />;

  return (
    <div className="space-y-7">
      <CollectionHeader
        label={T("Genre")}
        title={genre.name}
        subtitle={`${plural(genre.artistCount, T("artist"), T("artists"))} · ${plural(own.length, T("album"), T("albums"))}`}
        tracks={songs}
      />
      {own.length > 1 && (
        <section>
          <h2 className="text-[22px] font-bold tracking-[-0.4px] text-ink-hi mb-3">{T("Albums")}</h2>
          <ShelfScroller>
            {own.map((a) => (
              <AlbumTile key={a.key} album={a} />
            ))}
          </ShelfScroller>
        </section>
      )}
      <TrackList tracks={songs} showAlbum sourceName={genre.name} emptyLabel={T("No songs.")} />
    </div>
  );
}
