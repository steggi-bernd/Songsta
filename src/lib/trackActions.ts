/** Builds right-click / "more" menu items for tracks and playlists. */
import {
  Disc3,
  Download,
  FolderOpen,
  Heart,
  ImageIcon,
  ImageOff,
  ListMusic,
  ListStart,
  Pencil,
  Play,
  Search,
  Split,
  Trash2,
  Undo2,
  User,
  Volume2,
  VolumeX,
  Speaker,
} from "lucide-react";
import { downloadForOffline, getDownload, removeOfflineCopy, SERVER_SONG } from "./downloads";
import { playlistListKey } from "./keptLists";
import { toggleKeptList } from "./keptListsWatch";
import { withItemOut } from "./libraryGroups";
import { useLibraryOrder } from "../stores/libraryOrder";
import type { TrackSource } from "./dnd";
import { versionsOf } from "../stores/catalog";
import { useCast } from "./cast";
import { startZone } from "./zones";
import { useDeviceNames } from "../stores/deviceNames";
import { useLibrary, type Playlist } from "../stores/library";
import { useSettings } from "../stores/settings";
import { isMuted, useMuted } from "../stores/muted";
import { usePlayer } from "../stores/player";
import { useUI, type MenuItem } from "../stores/ui";
import type { Track } from "../types";
import { T } from "./i18n";

/**
 * Branch off: the song — next, or where it was dropped — and after it the rest
 * of the list it came from, in that list's order. What was coming in the
 * queue goes on afterwards, minus the songs the branch already plays.
 */
export function branchOff(from: TrackSource, at?: number): void {
  const rest = from.tracks.slice(from.index);
  if (!rest.length) return;
  const player = usePlayer.getState();
  if (!player.queue.length) {
    player.playQueue(rest, 0);
    return;
  }
  player.branchOff(rest, from.name, at);
  useUI.getState().toast(T("Branching off into “{name}” — {count} {value}", { name: from.name, count: rest.length, value: rest.length === 1 ? T("song") : T("songs") }));
}

/** After a song dropped into the queue: the rest of its list behind it, wherever the song is now. */
export function branchOffAfterDrop(from: TrackSource): void {
  const { queue, index } = usePlayer.getState();
  const song = from.tracks[from.index];
  const at = queue.findIndex((t, i) => i > index && t.id === song?.id);
  const rest = from.tracks.slice(from.index + 1);
  if (at < 0 || !rest.length) return;
  usePlayer.getState().insertInQueue(rest, at + 1, true);
  useUI.getState().toast(T("Then the rest of “{name}” — {count} {value}", { name: from.name, count: rest.length, value: rest.length === 1 ? T("song") : T("songs") }));
}

/** This very song is what a branch of this list started from, and it can still be taken back. */
function isBranchChoice(track: Track, name: string): boolean {
  return !!usePlayer.getState().branchFrom(track.id, name);
}

export function trackMenuItems(track: Track, from?: TrackSource): MenuItem[] {
  const lib = useLibrary.getState();
  const liked = lib.isLiked(track.id);

  const items: MenuItem[] = [
    {
      label: T("Play now"),
      icon: Play,
      action: () => usePlayer.getState().playTrack(track),
    },
    {
      label: T("Add to queue"),
      icon: ListStart,
      action: () => {
        const inLine = usePlayer.getState().addToQueue(track);
        useUI.getState().toast(inLine > 1 ? T("Added to queue, after {value} other {value2}", { value: inLine - 1, value2: inLine === 2 ? "song" : "songs" }) : T("Plays next"));
      },
    },
    // Under it: the same, then the rest of the list the song is in. On the chosen song itself: back out of it.
    ...(from && isBranchChoice(track, from.name)
      ? [
          {
            label: T("Undo branch"),
            icon: Undo2,
            action: () => {
              usePlayer.getState().cancelBranch(from.name);
              useUI.getState().toast(T("Branch taken back"));
            },
          },
        ]
      : from && from.index < from.tracks.length - 1
        ? [{ label: T("Branch off into “{name}”", { name: from.name }), icon: Split, action: () => branchOff(from) }]
        : []),
    {
      separatorBefore: true,
      label: liked ? T("Remove from Liked Songs") : T("Add to Liked Songs"),
      icon: Heart,
      action: () => useLibrary.getState().toggleLike(track),
    },
    {
      label: isMuted(track.id) ? T("Play again (unmute)") : T("Mute song"),
      icon: isMuted(track.id) ? Volume2 : VolumeX,
      action: () => {
        const nowMuted = useMuted.getState().toggle(track);
        useUI.getState().toast(nowMuted ? T("“{title}” is skipped from now on", { title: track.title }) : T("“{title}” plays again", { title: track.title }));
      },
    },
  ];

  // Straight to a device, next to whatever plays here. Those that a look around the network found.
  const speakers = useCast.getState().devices.filter((d) => d.kind === "upnp" || d.kind === "cast");
  if (speakers.length) {
    items.push({
      label: T("Play on"),
      icon: Speaker,
      children: speakers.map((d) => ({ label: useDeviceNames.getState().names[d.id] ?? d.name, icon: Speaker, action: () => void startZone(d, [track]) })),
    });
  }

  const playlists = lib.playlists.slice(0, 6);
  for (const p of playlists) {
    items.push({
      label: T("Add to \"{name}\"", { name: p.name }),
      icon: ListMusic,
      action: () => {
        const added = useLibrary.getState().addToPlaylist(p.id, track);
        useUI.getState().toast(added ? T("Added to \"{name}\"", { name: p.name }) : T("Already in this playlist"));
      },
    });
  }
  items.push({
    label: T("New playlist…"),
    icon: ListMusic,
    action: () => {
      // Name it before it exists — cancel creates nothing and the track
      // stays where it was. Blank confirm keeps the numbered default.
      const suggested = `Playlist ${useLibrary.getState().playlists.length + 1}`;
      useUI.getState().openDialog({
        title: T("New playlist"),
        body: T("Add \"{title}\" to a new playlist.", { title: track.title }),
        initialValue: suggested,
        placeholder: T("Playlist name"),
        confirmLabel: T("Create"),
        onConfirm: (value) => {
          const lib = useLibrary.getState();
          const playlist = lib.createPlaylist(value.trim() || suggested);
          lib.addToPlaylist(playlist.id, track);
          useUI.getState().navigate({ name: "playlist", param: playlist.id });
        },
      });
    },
  });

  // Local player: no share links — a song's home is a file on this device or
  // an item on the user's server, which can get an offline copy.
  if (track.localPath) {
    items.push({
      separatorBefore: true,
      label: T("Show in folder"),
      icon: FolderOpen,
      action: () => requireReveal(track.localPath as string),
    });
  } else if (SERVER_SONG.test(track.id) && !versionsOf(track).some((v) => v.localPath)) {
    items.push({
      separatorBefore: true,
      label: T("Download for offline"),
      icon: Download,
      action: () => void downloadForOffline([track]),
    });
  }
  // An offline copy made here: taken off by hand, it stays off (lib/downloads.ts).
  const offline = versionsOf(track).find((v) => SERVER_SONG.test(v.id) && getDownload(v.id)?.status === "done");
  if (offline) {
    items.push({
      label: T("Remove download"),
      icon: Trash2,
      action: () => void removeOfflineCopy(offline.id),
    });
  }

  if (track.albumId?.startsWith("lib:album:")) {
    items.push({
      separatorBefore: true,
      label: T("Go to album"),
      icon: Disc3,
      action: () => useUI.getState().navigate({ name: "album", param: track.albumId }),
    });
  }
  if (track.artistId?.startsWith("lib:artist:")) {
    items.push({
      separatorBefore: !track.albumId,
      label: T("Go to artist"),
      icon: User,
      action: () => useUI.getState().navigate({ name: "artist", param: track.artistId }),
    });
  } else if (track.artist && track.artist.toLowerCase() !== "unknown artist") {
    items.push({
      separatorBefore: !track.localPath,
      label: T("More by {artist}", { artist: track.artist }),
      icon: Search,
      action: () => {
        useUI.getState().setSearchQuery(track.artist);
        useUI.getState().navigate({ name: "search" });
      },
    });
  }

  return items;
}

function requireReveal(path: string): void {
  if (window.bytune) window.bytune.revealPath(path);
}

export function playlistMenuItems(playlist: Playlist, track: Track, from?: TrackSource): MenuItem[] {
  return [
    {
      label: T("Remove from this playlist"),
      icon: Trash2,
      danger: true,
      action: () => {
        useLibrary.getState().removeFromPlaylist(playlist.id, track.id);
        useUI.getState().toast(T("Removed from playlist"));
      },
    },
    ...trackMenuItems(track, from),
  ];
}

async function choosePlaylistPicture(playlist: Playlist): Promise<void> {
  const { pickPlaylistPicture } = await import("./pickPicture");
  try {
    const cover = await pickPlaylistPicture();
    if (cover) useLibrary.getState().setPlaylistCover(playlist.id, cover);
  } catch {
    useUI.getState().toast(T("That picture can't be read"), "error");
  }
}

export function playlistHeaderItems(playlist: Playlist): MenuItem[] {
  const keepKey = playlistListKey(playlist.id);
  const keeping = useSettings.getState().keptLists.includes(keepKey);
  const onServer = playlist.tracks.some((t) => versionsOf(t).some((v) => SERVER_SONG.test(v.id)) && !versionsOf(t).some((v) => v.localPath));
  return [
    {
      label: T("Rename"),
      icon: Pencil,
      action: () => {
        useUI.getState().openDialog({
          title: T("Rename playlist"),
          initialValue: playlist.name,
          placeholder: T("Playlist name"),
          confirmLabel: T("Rename"),
          onConfirm: (value) => {
            if (value.trim()) useLibrary.getState().renamePlaylist(playlist.id, value);
          },
        });
      },
    },
    ...(keeping || onServer
      ? [
          {
            label: keeping ? T("Stop keeping offline") : T("Download for offline"),
            icon: Download,
            action: () => toggleKeptList(keepKey, playlist.tracks),
          },
        ]
      : []),
    {
      label: playlist.cover ? T("Change picture…") : T("Choose a picture…"),
      icon: ImageIcon,
      action: () => void choosePlaylistPicture(playlist),
    },
    ...(playlist.cover
      ? [
          {
            label: T("Remove picture"),
            icon: ImageOff,
            action: () => useLibrary.getState().setPlaylistCover(playlist.id, null),
          },
        ]
      : []),
    {
      label: T("Delete playlist"),
      icon: Trash2,
      danger: true,
      action: () => {
        useUI.getState().openDialog({
          title: T("Delete \"{name}\"?", { name: playlist.name }),
          body: T("This can't be undone. The tracks themselves aren't affected."),
          confirmLabel: T("Delete"),
          danger: true,
          onConfirm: () => {
            useLibrary.getState().deletePlaylist(playlist.id);
            useUI.getState().navigate({ name: "playlists" });
            useUI.getState().toast(T("Playlist deleted"), "info");
          },
        });
      },
    },
  ];
}

/** File a playlist into a library folder (or back out to the top level). */
export function playlistFolderItems(playlist: Playlist): MenuItem[] {
  const folders = useLibrary.getState().folders;
  const items: MenuItem[] = folders.map((f, i) => ({
    label: f.id === playlist.folderId ? `✓ ${f.name}` : T("Move to “{name}”", { name: f.name }),
    icon: FolderOpen,
    separatorBefore: i === 0,
    action: () => {
      useLibrary.getState().setPlaylistFolder(playlist.id, f.id);
      // In a folder, it stands there, not in a group of the library panel.
      const order = useLibraryOrder.getState();
      order.setGroups(withItemOut(order.groups, playlistListKey(playlist.id)));
    },
  }));
  if (playlist.folderId) {
    items.push({
      label: T("Remove from folder"),
      icon: FolderOpen,
      separatorBefore: true,
      action: () => useLibrary.getState().setPlaylistFolder(playlist.id, null),
    });
  }
  return items;
}
