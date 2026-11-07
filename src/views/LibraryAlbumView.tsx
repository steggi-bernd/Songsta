/**
 * Album page for the library, Spotify-style: big cover beside the title, the
 * artist (opens the artist page), year, song count and length, a play and a
 * shuffle button, the tracks in disc/track order, then more by the artist.
 * Songs from every source that share album artist + title form one album;
 * a song found in several places is listed once (lib/duplicates.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { Disc3, Download, Pencil, Shuffle } from "lucide-react";
import { useSettings } from "../stores/settings";
import { SERVER_SONG } from "../lib/downloads";
import { albumListKey } from "../lib/keptLists";
import { toggleKeptList } from "../lib/keptListsWatch";
import { AlbumEditor, useAlbumEditorRequest } from "../components/AlbumEditor";
import { ArtistLinks } from "../components/ArtistLinks";
import { AlbumTile, BigPlayButton, playCollection } from "../components/LibraryCards";
import { TrackList } from "../components/TrackList";
import { Artwork, EmptyState, ShelfScroller } from "../components/primitives";
import { artistAlbums, useLibraryIndex } from "../lib/catalogIndex";
import { fmtLength } from "../lib/format";
import { parseRoute } from "../lib/libraryTracks";
import { RELEASE_LABEL } from "../lib/releases";
import { resolveAlbumKey } from "../lib/albumEdits";
import { useAlbumEdits } from "../stores/albumEdits";
import { useCatalog, versionsOf } from "../stores/catalog";
import { T } from "../lib/i18n";

const SOURCE_LABEL = { local: T("On this device"), jellyfin: "Jellyfin", subsonic: "Navidrome" } as const;

export function LibraryAlbumView({ param }: { param: string }) {
  const { albums, loaded } = useLibraryIndex();
  const catalogVersion = useCatalog((s) => s.version);
  const mergedInto = useAlbumEdits((s) => s.mergedInto);
  // A link to an album that was merged into another (from the queue, history, an old page) opens that one.
  const key = resolveAlbumKey(parseRoute(param, "album") ?? "", mergedInto);
  const album = useMemo(() => albums.find((a) => a.key === key) ?? null, [albums, key]);
  const [editing, setEditing] = useState(false);
  const requested = useAlbumEditorRequest((s) => s.key);
  useEffect(() => {
    if (requested && requested === key) {
      setEditing(true);
      useAlbumEditorRequest.setState({ key: null });
    }
  }, [requested, key]);
  const more = useMemo(
    () => (album ? artistAlbums(albums, album.artist).own.filter((a) => a.key !== album.key) : []),
    [albums, album]
  );
  // Every place the album's songs live — a merged song counts for each of its copies.
  const sources = useMemo(() => {
    const found = new Set<keyof typeof SOURCE_LABEL>();
    for (const t of album?.tracks ?? []) for (const v of versionsOf(t)) if (v.source) found.add(v.source);
    return (["local", "jellyfin", "subsonic"] as const).filter((s) => found.has(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album, catalogVersion]);
  const keptLists = useSettings((s) => s.keptLists);
  const kept = !!album && keptLists.includes(albumListKey(album.key));
  // Songs only a server has: what "Download for offline" fetches (each one's server copy).
  const serverOnly = useMemo(
    () =>
      (album?.tracks ?? [])
        .filter((t) => !versionsOf(t).some((v) => v.localPath))
        .map((t) => versionsOf(t).find((v) => SERVER_SONG.test(v.id)))
        .filter((t): t is NonNullable<typeof t> => !!t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [album, catalogVersion]
  );

  if (!loaded) return null;
  if (!album) {
    return <EmptyState icon={Disc3} title={T("Album not found")} body={T("It may have been removed from your library.")} />;
  }

  return (
    <div className="space-y-6">
      <header className="flex items-end gap-6 pt-4 animate-slide-up">
        <Artwork src={album.thumb} rounded="rounded-lg" className="w-[232px] h-[232px] shrink-0 shadow-elev" iconClassName="w-12 h-12" />
        <div className="min-w-0 pb-1">
          <div className="text-[13px] font-semibold text-ink-hi/80">{RELEASE_LABEL[album.kind]}</div>
          <h1
            className="font-display font-extrabold tracking-[-0.04em] text-ink-hi leading-[1.15] pb-[0.08em] line-clamp-2"
            style={{ fontSize: album.title.length > 28 ? 44 : 64 }}
          >
            {album.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-1.5 text-[14px] text-ink-hi/80 mt-2">
            <span className="font-bold text-ink-hi">
              <ArtistLinks artist={album.artist} />
            </span>
            {album.year && <span>· {album.year}</span>}
            <span>
              · {album.tracks.length} {album.tracks.length === 1 ? T("song") : T("songs")}, {fmtLength(album.duration)}
            </span>
            {sources.length > 0 && <span className="text-ink-dim">· {sources.map((s) => SOURCE_LABEL[s]).join(" + ")}</span>}
          </div>
        </div>
      </header>

      <div className="flex items-center gap-5">
        <BigPlayButton onClick={() => playCollection(album.tracks)} label={T("Play {title}", { title: album.title })} tracks={album.tracks} />
        <button
          onClick={() => playCollection(album.tracks, true)}
          title={T("Shuffle play")}
          aria-label={T("Shuffle play")}
          className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:scale-105 transition-all"
        >
          <Shuffle className="w-6 h-6" />
        </button>
        <button
          onClick={() => setEditing(true)}
          title={T("Edit album — artists, merge split albums")}
          aria-label={T("Edit album")}
          className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:scale-105 transition-all"
        >
          <Pencil className="w-5 h-5" />
        </button>
        {(serverOnly.length > 0 || kept) && (
          <button
            onClick={() => toggleKeptList(albumListKey(album.key), album.tracks)}
            title={kept ? T("Kept offline: new songs download by themselves. Press to stop that.") : T("Download for offline — {count} {value} only on the server", { count: serverOnly.length, value: serverOnly.length === 1 ? T("song") : T("songs") })}
            aria-label={T("Download for offline")}
            aria-pressed={kept}
            className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:scale-105 transition-all"
          >
            <Download className={`w-5 h-5 ${kept ? "text-accent" : ""}`} />
          </button>
        )}
      </div>
      {editing && <AlbumEditor album={album} onClose={() => setEditing(false)} />}

      <TrackList tracks={album.tracks} sourceName={album.title} emptyLabel={T("No songs.")} />

      {more.length > 0 && (
        <section className="pt-2">
          <h2 className="section-title text-[21px] mb-4">{T("More by {artist}", { artist: album.artist })}</h2>
          <ShelfScroller>
            {more.map((a) => (
              <AlbumTile key={a.key} album={a} subtitle={`${a.year ? `${a.year} · ` : ""}${RELEASE_LABEL[a.kind]}`} />
            ))}
          </ShelfScroller>
        </section>
      )}
    </div>
  );
}
