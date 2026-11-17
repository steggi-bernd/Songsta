/**
 * The songs of one artist you've liked, as a small playlist of their own: the
 * artist page's "Liked songs" strip leads here. Built like a playlist's page,
 * wearing the artist's picture; its play button pauses only while this list
 * plays, not while an album plays one of its songs.
 */
import { useMemo } from "react";
import { FileDown, ListPlus } from "lucide-react";
import { BannerPicture } from "../components/BannerPicture";
import { playCollection, useArtistPhoto, useCollectionPlayback } from "../components/LibraryCards";
import { PlaylistHero } from "../components/PlaylistHero";
import { TrackList } from "../components/TrackList";
import { useArtistPicture } from "../lib/artistAbout";
import { bannerCandidates } from "../lib/artistBanner";
import { artistTracks, useLibraryIndex, useLikedAmong } from "../lib/catalogIndex";
import { fmtMinutes, plural } from "../lib/format";
import { parseRoute } from "../lib/libraryTracks";
import { exportM3uPlaylist } from "../lib/playlistFiles";
import { useArtistImages } from "../lib/songInfo";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { T } from "../lib/i18n";

export function ArtistLikedView({ param }: { param: string }) {
  const name = parseRoute(param, "artist") ?? "";
  const { tracks, loaded } = useLibraryIndex();
  const songs = useMemo(() => artistTracks(tracks, name), [tracks, name]);
  const liked = useLikedAmong(songs);
  const { active, playing } = useCollectionPlayback(liked, true);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);
  const images = useArtistImages(name);
  const picture = useArtistPicture(name);
  const photo = useArtistPhoto(name);

  if (!loaded) return null;

  const title = T("Liked songs by {name}", { name });
  const totalSec = liked.reduce((sum, t) => sum + t.duration, 0);
  const meta = [liked.length ? plural(liked.length, T("song"), T("songs")) : T("No songs yet"), totalSec > 0 ? fmtMinutes(totalSec) : ""].filter(Boolean).join(" · ");

  const openMenu = (x: number, y: number): void => {
    openContextMenu(x, y, [
      {
        label: T("Add all to queue"),
        icon: ListPlus,
        action: () => {
          usePlayer.getState().addToQueue(liked);
          toast(T("Songs added to queue"));
        },
      },
      { label: T("Export as M3U…"), icon: FileDown, action: () => void exportM3uPlaylist(title, liked) },
    ]);
  };

  return (
    <div className="page-tint page-bleed -mt-5">
      <PlaylistHero
        art={<BannerPicture key={name} candidates={bannerCandidates({ picture, genius: images, photo: photo || null, covers: [songs[0]?.thumb] })} />}
        title={title}
        meta={meta}
        playing={playing}
        onShuffle={() => liked.length && playCollection(liked, true)}
        onPlay={() => {
          if (active) usePlayer.getState().toggle();
          else if (liked.length) playCollection(liked);
        }}
        onMore={openMenu}
      />
      <div className="page-pad pb-12 pt-2">
        <TrackList
          tracks={liked}
          showAlbum
          sourceName={title}
          emptyTitle={T("No liked songs by {name}", { name })}
          emptyLabel={T("Songs of theirs you like show up here.")}
        />
      </div>
    </div>
  );
}
