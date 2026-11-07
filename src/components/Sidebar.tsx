/**
 * Sidebar — the whole left panel is "Your Library", Spotify-style.
 *
 * One glass pill: a "Your Library" header (create button), filter chips
 * (Playlists / Albums) and a scrollable list of the user's library — Liked
 * Songs, playlists, folders and the library's albums. The pinned rows lead, in the order they were dragged into; below
 * them, by default, whatever played last (lib/recentlyPlayed.ts). Main navigation lives in the top bar (home beside the search
 * field; the library sources — Local Music, Jellyfin, Navidrome — beside the
 * settings gear).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpDown, Check, ChevronDown, ChevronRight, Disc3, Folder, Heart, Library, ListEnd, ListMusic, ListPlus, Music2, PanelLeftClose, PanelLeftOpen, Pencil, Pin, PinOff, Play, Shuffle, Sparkles, User, Trash2 } from "lucide-react";
import { newestFirst, useLibraryIndex, type LibAlbum } from "../lib/catalogIndex";
import { useAlbumEditorRequest } from "./AlbumEditor";
import { artistRoute, splitCredits } from "../lib/libraryTracks";
import { RELEASE_LABEL } from "../lib/releases";
import { isLoose } from "../lib/albumEdits";
import { useAvailabilityCheck } from "../stores/availability";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings, type LibraryOrder } from "../stores/settings";
import { useLibraryOrder } from "../stores/libraryOrder";
import { movePinned, orderRows } from "../lib/libraryOrder";
import { useSmartPlaylists } from "../stores/smartPlaylists";
import { useSmartEditor } from "./SmartPlaylistEditor";
import { useUI } from "../stores/ui";
import { EqBars } from "./primitives";
import { LikedCover } from "./LikedCover";
import { upgradeArtwork } from "../lib/artwork";
import { CreateMenu } from "./CreateMenu";
import { playlistFolderItems, playlistHeaderItems } from "../lib/trackActions";
import { dragHasPlaylist, dragHasTrack, readPlaylist, readTrack } from "../lib/dnd";
import type { Track } from "../types";
import { T } from "../lib/i18n";

/* ============================================================ nav */

type LibFilter = "playlists" | "albums";
const FILTER_LABEL: Record<LibFilter, string> = { playlists: T("Playlists"), albums: T("Albums") };
const ORDER_LABEL: Record<LibraryOrder, string> = {
  played: T("Recently played"),
  added: T("Recently added"),
  alpha: T("Alphabetical"),
  artist: T("Artist"),
};

/** A pinned row being dragged into another place among the pinned ones. */
const PIN_MIME = "application/x-bytune-pin";
const dragHasPin = (e: React.DragEvent): boolean => e.dataTransfer.types.includes(PIN_MIME);

interface LibRow {
  id: string;
  title: string;
  subtitle: string;
  thumb?: string;
  kind: "playlist" | "folder" | "album" | "smart" | "loose";
  /** album rows: the library album */
  release?: LibAlbum;
  /** album rows: false while none of its songs can be reached */
  available?: boolean;
  /** playlists: the folder they're filed in; folders: their own id */
  folderId?: string;
  /** the Liked Songs row carries its pin state */
  pinned?: boolean;
  /** the shortcut pin this row toggles */
  singleKey?: "liked";
}

/**
 * The library panel. Collapsed, it folds down to an icon rail: every row keeps
 * its artwork/icon (title as tooltip), clicks, drops and context menus work as
 * before, and the header button folds it back out.
 */
function LibraryPill({ collapsed }: { collapsed: boolean }) {
  const setCollapsed = useSettings((s) => s.setSidebarCollapsed);
  const liked = useLibrary((s) => s.liked);
  const playlists = useLibrary((s) => s.playlists);
  const folders = useLibrary((s) => s.folders);
  const pinnedSingles = useLibrary((s) => s.pinnedSingles);
  const smartPlaylists = useSmartPlaylists((s) => s.playlists);
  const navigate = useUI((s) => s.navigate);
  const openDialog = useUI((s) => s.openDialog);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const { albums, tracks: libraryTracks } = useLibraryIndex();
  // Songs whose tags name no album show on no album — they get a row of their own.
  const looseCount = useMemo(() => libraryTracks.filter(isLoose).length, [libraryTracks]);
  const libraryOrder = useSettings((s) => s.libraryOrder);
  const played = useLibraryOrder((s) => s.played);
  const pins = useLibraryOrder((s) => s.pins);
  const pinOrder = useLibraryOrder((s) => s.pinOrder);
  const available = useAvailabilityCheck();

  /** Spotify's filter chips: one category at a time, a second click shows everything again. */
  const [filter, setFilter] = useState<LibFilter | null>(null);
  const sortedAlbums = useMemo(() => {
    const list = [...albums];
    if (libraryOrder === "alpha") return list.sort((a, b) => a.title.localeCompare(b.title));
    if (libraryOrder === "artist") return list.sort((a, b) => a.artist.localeCompare(b.artist) || newestFirst(a, b));
    // Recently added — and under Recently played, the order of the albums never played.
    return list.sort((a, b) => b.addedAt - a.addedAt || a.title.localeCompare(b.title));
  }, [albums, libraryOrder]);
  // Per album, not per render: the panel re-renders on every track change and play/pause.
  const albumAvailable = useMemo(
    () => new Map(sortedAlbums.map((a) => [a.route, a.tracks.some((t) => available(t))])),
    [sortedAlbums, available]
  );
  const sortButtonRef = useRef<HTMLButtonElement | null>(null);
  const openSortMenu = (): void => {
    const rect = sortButtonRef.current?.getBoundingClientRect();
    openContextMenu(
      rect?.right ?? 0,
      rect?.bottom ?? 0,
      [
        { header: true, label: T("Sort by") },
        ...(Object.keys(ORDER_LABEL) as LibraryOrder[]).map((k) => ({
          label: ORDER_LABEL[k],
          icon: libraryOrder === k ? Check : undefined,
          action: () => useSettings.getState().setLibraryOrder(k),
        })),
      ],
      { alignRight: true }
    );
  };

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** the row a drag is currently hovering — drives the drop highlight */
  const [dropHover, setDropHover] = useState<string | null>(null);
  /** the row a drop just landed on — drives the pulse */
  const [pulse, setPulse] = useState<string | null>(null);
  /** a pinned row being dragged into another place, and where it would land */
  const [pinDrag, setPinDrag] = useState<string | null>(null);
  const [pinDrop, setPinDrop] = useState<{ id: string; below: boolean } | null>(null);

  // A drag that ends anywhere (dropped outside a target) clears hover state.
  useEffect(() => {
    const clear = (): void => {
      setDropHover(null);
      setPinDrag(null);
      setPinDrop(null);
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  // Spotify's library contents: Liked Songs, the user's playlists, folders
  // (collapsible) and the library's albums. The library
  // sources (Local Music, Jellyfin, Navidrome) live in the top bar.
  // Liked Songs is pinned by default; unpinned, it sorts in with the rest —
  // at the bottom, unless it played lately (re-pin from its right-click menu).
  const singlePinned = (k: "liked"): boolean => pinnedSingles?.[k] ?? true;

  const likedRow: LibRow = {
    id: "__liked__",
    title: T("Liked Songs"),
    subtitle: T("Playlist · {count} {value}", { count: liked.length, value: liked.length === 1 ? T("song") : T("songs") }),
    thumb: liked[0]?.thumb,
    kind: "playlist",
    pinned: singlePinned("liked"),
    singleKey: "liked",
  };
  const playlistRow = (p: (typeof playlists)[number], folderId?: string): LibRow => ({
    id: p.id,
    title: p.name,
    subtitle: T("Playlist · {count} {value}", { count: p.tracks.length, value: p.tracks.length === 1 ? T("song") : T("songs") }),
    thumb: p.cover ?? p.artistThumb ?? p.tracks[0]?.thumb,
    kind: "playlist",
    folderId,
  });

  // Pinned: Liked Songs and the playlists by their own pins, albums and smart
  // playlists by the panel's (stores/libraryOrder.ts). A playlist in a folder
  // stays in its folder.
  const pinnedPlaylists = new Set(playlists.filter((p) => p.pinned && !p.folderId).map((p) => p.id));
  const isPinned = (r: LibRow): boolean =>
    r.singleKey
      ? singlePinned(r.singleKey)
      : r.kind === "playlist"
        ? !r.folderId && pinnedPlaylists.has(r.id)
        : (r.kind === "album" || r.kind === "smart") && pins.includes(r.id);

  // Every top row in its own order — smart playlists, playlists, folders, the albums as sorted, Liked Songs first while pinned
  // and last when not — then the pinned ones lifted to the top as placed,
  // and under Recently played the rest by when they last played (a folder
  // by its latest playlist).
  const top: LibRow[] = [];
  if (likedRow.pinned) top.push(likedRow);
  for (const sp of smartPlaylists) top.push({ id: sp.id, title: sp.name, subtitle: T("Smart playlist"), kind: "smart" });
  if (looseCount) {
    top.push({ id: "__loose__", title: T("Songs without an album"), subtitle: `${looseCount} ${looseCount === 1 ? T("song") : T("songs")}`, kind: "loose" });
  }
  for (const p of playlists) if (!p.folderId) top.push(playlistRow(p));
  for (const f of folders) top.push({ id: f.id, title: f.name, subtitle: T("Folder"), kind: "folder", folderId: f.id });
  for (const a of sortedAlbums) {
    top.push({
      id: a.route,
      title: a.title,
      subtitle: `${RELEASE_LABEL[a.kind]} · ${a.artist}`,
      thumb: a.thumb,
      kind: "album",
      release: a,
      available: albumAvailable.get(a.route) ?? true,
    });
  }
  if (!likedRow.pinned) top.push(likedRow);
  const folderPlayed = new Map<string, number>();
  for (const p of playlists) {
    if (p.folderId) folderPlayed.set(p.folderId, Math.max(folderPlayed.get(p.folderId) ?? 0, played[p.id] ?? 0));
  }
  const ordered = orderRows(top, {
    isPinned,
    pinOrder,
    playedAt: libraryOrder === "played" ? (r) => (r.kind === "folder" ? folderPlayed.get(r.id) ?? 0 : played[r.id] ?? 0) : undefined,
  });
  /** every pinned row in its place, whatever the chips show — a drag reorders these */
  const pinnedIds = ordered.filter(isPinned).map((r) => r.id);

  const show = (k: LibFilter): boolean => filter === null || filter === k;
  const shelf = (r: LibRow): LibFilter => (r.kind === "album" ? "albums" : "playlists");
  const rows: LibRow[] = [];
  for (const r of ordered) {
    if (!show(shelf(r))) continue;
    rows.push(r);
    if (r.kind === "folder" && expanded.has(r.id)) {
      for (const p of playlists) if (p.folderId === r.id) rows.push(playlistRow(p, r.id));
    }
  }

  /** Unpinning takes a row out of the pinned order too: pinned again, it comes last. */
  const unplace = (id: string): void => {
    const o = useLibraryOrder.getState();
    if (o.pinOrder.includes(id)) o.setPinOrder(o.pinOrder.filter((x) => x !== id));
  };

  const toggleFolder = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ---------------------------------------------------------- drag & drop */

  /** A playlist dropped on a folder is filed there. */
  const fileLocalPlaylist = (id: string, folderId: string): void => {
    const lib = useLibrary.getState();
    const toast = useUI.getState().toast;
    const name = lib.playlists.find((p) => p.id === id)?.name;
    if (!name) return;
    lib.setPlaylistFolder(id, folderId);
    setExpanded((prev) => new Set(prev).add(folderId));
    toast(T("Moved “{name}” into the folder", { name }), "success");
    setPulse(folderId);
    window.setTimeout(() => setPulse((cur) => (cur === folderId ? null : cur)), 650);
  };

  /** A dropped track lands on Liked Songs or one of the user's playlists. */
  const dropTrackOn = (r: LibRow, track: Track): void => {
    const lib = useLibrary.getState();
    const toast = useUI.getState().toast;
    if (r.id === "__liked__") {
      if (lib.isLiked(track.id)) {
        toast(T("“{title}” is already in your Liked Songs", { title: track.title }));
      } else {
        lib.toggleLike(track);
        toast(T("Added “{title}” to Liked Songs", { title: track.title }), "success");
      }
    } else {
      const p = lib.playlists.find((pl) => pl.id === r.id);
      if (!p) return;
      const added = lib.addToPlaylist(r.id, track);
      toast(
        added ? T("Added “{title}” to “{name}”", { title: track.title, name: p.name }) : T("“{title}” is already in “{name}”", { title: track.title, name: p.name })
      );
    }
    setPulse(r.id);
    window.setTimeout(() => setPulse((cur) => (cur === r.id ? null : cur)), 650);
  };

  /**
   * Hovering a collapsed folder mid-drag opens it after a beat so the drag
   * can continue onto the playlists inside — one gesture, no re-drag. The
   * highlight itself is immediate (set in onRowDragOver); only the expansion
   * waits, the way file managers do.
   */
  const expandTimer = useRef<number | null>(null);
  const cancelPendingExpand = (): void => {
    if (expandTimer.current !== null) {
      window.clearTimeout(expandTimer.current);
      expandTimer.current = null;
    }
  };
  const scheduleExpand = (folderId: string): void => {
    if (expanded.has(folderId)) return;
    if (expandTimer.current !== null) return;
    expandTimer.current = window.setTimeout(() => {
      expandTimer.current = null;
      setExpanded((prev) => new Set(prev).add(folderId));
    }, 650);
  };
  useEffect(() => {
    const clear = (): void => {
      cancelPendingExpand();
      setDropHover(null);
    };
    window.addEventListener("dragend", clear);
    return () => window.removeEventListener("dragend", clear);
  }, []);

  const onRowDragOver = (e: React.DragEvent, r: LibRow): void => {
    if (dragHasPin(e)) {
      // A pinned row moves among the pinned ones: the line shows where it lands.
      if (!isPinned(r) || r.id === pinDrag) {
        setPinDrop((d) => (d ? null : d));
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const box = e.currentTarget.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      setPinDrop((d) => (d?.id === r.id && d.below === below ? d : { id: r.id, below }));
      return;
    }
    const isTrack = dragHasTrack(e);
    const isPlaylist = dragHasPlaylist(e);
    // Playlist rows take tracks (__liked__ carries kind "playlist").
    const acceptsTracks = r.kind === "playlist" && isTrack;
    // Folders file playlists. A track hovering a folder previews the folder
    // and opens it so the drag can land on a playlist inside — the same
    // gesture, no second attempt.
    const acceptsPlaylists = r.kind === "folder" && isPlaylist;
    const previewsFolder = r.kind === "folder" && isTrack && !isPlaylist;
    if (!acceptsTracks && !acceptsPlaylists && !previewsFolder) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDropHover(r.id);
    if (r.kind === "folder") scheduleExpand(r.id);
  };

  const onRowDragLeave = (e: React.DragEvent, r: LibRow): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropHover((cur) => (cur === r.id ? null : cur));
      setPinDrop((d) => (d?.id === r.id ? null : d));
      cancelPendingExpand();
    }
  };

  const onRowDrop = (e: React.DragEvent, r: LibRow): void => {
    cancelPendingExpand();
    if (dragHasPin(e)) {
      e.preventDefault();
      e.stopPropagation();
      const id = e.dataTransfer.getData(PIN_MIME);
      const box = e.currentTarget.getBoundingClientRect();
      const below = e.clientY > box.top + box.height / 2;
      setPinDrag(null);
      setPinDrop(null);
      if (id && id !== r.id && isPinned(r)) useLibraryOrder.getState().setPinOrder(movePinned(pinnedIds, id, r.id, below));
      return;
    }
    if (r.kind === "playlist" && dragHasTrack(e)) {
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      const track = readTrack(e);
      if (track) dropTrackOn(r, track);
      return;
    }
    if (r.kind === "folder" && dragHasPlaylist(e)) {
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      const pl = readPlaylist(e);
      if (pl) fileLocalPlaylist(pl.id, r.id);
      return;
    }
    if (r.kind === "folder" && dragHasTrack(e)) {
      // Folders hold playlists, not songs: open the folder so the drag can
      // finish on a playlist inside, and say so once.
      e.preventDefault();
      e.stopPropagation();
      setDropHover(null);
      setExpanded((prev) => new Set(prev).add(r.id));
      setPulse(r.id);
      window.setTimeout(() => setPulse((cur) => (cur === r.id ? null : cur)), 650);
      useUI.getState().toast(T("“{title}” holds playlists — drop onto one of them", { title: r.title }), "info");
    }
  };

  const onClickRow = (r: LibRow): void => {
    switch (r.kind) {
      case "playlist":
        if (r.id === "__liked__") navigate({ name: "library", param: "liked" });
        else navigate({ name: "playlist", param: r.id });
        break;
      case "folder":
        toggleFolder(r.id);
        break;
      case "album":
        navigate({ name: "album", param: r.id });
        break;
      case "smart":
        navigate({ name: "smart", param: r.id });
        break;
      case "loose":
        navigate({ name: "loose" });
        break;
    }
  };

  /** Right-click a row: pin/unpin shortcuts, album, playlist and folder options. */
  const onRowContextMenu = (e: React.MouseEvent, r: LibRow): void => {
    if (r.kind === "album" && r.release) {
      const album = r.release;
      e.preventDefault();
      e.stopPropagation();
      // Only songs that can play right now go into the queue.
      const playable = album.tracks.filter((t) => available(t));
      const none = playable.length === 0;
      openContextMenu(e.clientX, e.clientY, [
        { label: T("Play"), icon: Play, disabled: none, action: () => usePlayer.getState().playAll(playable) },
        {
          label: T("Shuffle"),
          icon: Shuffle,
          disabled: none,
          action: () => {
            usePlayer.setState({ shuffle: true });
            usePlayer.getState().playAll(playable, true);
          },
        },
        {
          label: T("Add to queue"),
          icon: ListEnd,
          disabled: none,
          action: () => {
            usePlayer.getState().addToQueue(playable);
            useUI.getState().toast(T("Added “{title}” to the queue", { title: album.title }));
          },
        },
        {
          label: isPinned(r) ? T("Unpin album") : T("Pin album"),
          icon: isPinned(r) ? PinOff : Pin,
          action: () => useLibraryOrder.getState().togglePin(r.id),
        },
        {
          label: T("Edit album…"),
          icon: Pencil,
          action: () => {
            useAlbumEditorRequest.setState({ key: album.key });
            navigate({ name: "album", param: album.route });
          },
        },
        // One entry per credited artist — "A, B" are two artists, two pages.
        ...splitCredits(album.artist).map((name, i, all) => ({
          label: all.length === 1 ? T("Go to artist") : T("Go to {name}", { name }),
          icon: User,
          separatorBefore: i === 0,
          action: () => navigate({ name: "artist", param: artistRoute(name) }),
        })),
      ]);
      return;
    }
    if (r.singleKey) {
      e.preventDefault();
      e.stopPropagation();
      const pinned = singlePinned(r.singleKey);
      openContextMenu(e.clientX, e.clientY, [
        {
          label: pinned ? T("Unpin") : T("Pin to top"),
          icon: pinned ? PinOff : Pin,
          action: () => {
            if (pinned) unplace(r.id);
            useLibrary.getState().togglePinSingle(r.singleKey!);
          },
        },
      ]);
      return;
    }
    if (r.kind === "smart") {
      const sp = smartPlaylists.find((p) => p.id === r.id);
      if (!sp) return;
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: isPinned(r) ? T("Unpin") : T("Pin to top"),
          icon: isPinned(r) ? PinOff : Pin,
          action: () => useLibraryOrder.getState().togglePin(r.id),
        },
        { label: T("Edit rules"), icon: Sparkles, action: () => useSmartEditor.getState().open(sp, false) },
        {
          label: T("Delete smart playlist"),
          danger: true,
          action: () => useSmartPlaylists.getState().remove(sp.id),
        },
      ]);
      return;
    }
    if (r.kind === "playlist" && r.id !== "__liked__") {
      const playlist = playlists.find((p) => p.id === r.id);
      if (!playlist) return;
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: playlist.pinned ? T("Unpin playlist") : T("Pin playlist"),
          // slashed pin = "currently pinned, click to undo" (Spotify's model)
          icon: playlist.pinned ? PinOff : Pin,
          action: () => {
            if (playlist.pinned) unplace(playlist.id);
            useLibrary.getState().togglePinPlaylist(playlist.id);
          },
        },
        ...playlistHeaderItems(playlist),
        ...playlistFolderItems(playlist),
      ]);
      return;
    }
    if (r.kind === "folder") {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu(e.clientX, e.clientY, [
        {
          label: T("Rename folder"),
          icon: Pencil,
          action: () =>
            openDialog({
              title: T("Rename folder"),
              initialValue: r.title,
              placeholder: T("Folder name"),
              confirmLabel: T("Save"),
              onConfirm: (value) => useLibrary.getState().renameFolder(r.id, value),
            }),
        },
        {
          label: T("Delete folder"),
          icon: Trash2,
          danger: true,
          action: () => useLibrary.getState().deleteFolder(r.id),
        },
      ]);
    }
  };

  /** Right-click the library panel itself — Spotify's create menu. Rows stop
      propagation so they keep their own menus; everywhere else (header, empty
      space) offers playlist/folder creation, each asking for a name first so
      nothing empty lands in the library. */
  const onLibraryContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      {
        label: T("Create playlist"),
        icon: ListPlus,
        action: () => {
          const suggested = T("My Playlist #{count}", { count: useLibrary.getState().playlists.length + 1 });
          openDialog({
            title: T("New playlist"),
            body: T("Give your playlist a name."),
            initialValue: suggested,
            placeholder: T("Playlist name"),
            confirmLabel: T("Create"),
            onConfirm: (value) => {
              const p = useLibrary.getState().createPlaylist(value.trim() || suggested);
              navigate({ name: "playlist", param: p.id });
            },
          });
        },
      },
      {
        label: T("Create folder"),
        icon: Folder,
        action: () => {
          const suggested = T("New Folder {count}", { count: useLibrary.getState().folders.length + 1 });
          openDialog({
            title: T("New folder"),
            body: T("Give your folder a name."),
            initialValue: suggested,
            placeholder: T("Folder name"),
            confirmLabel: T("Create"),
            onConfirm: (value) => {
              const f = useLibrary.getState().createFolder(value.trim() || suggested);
              setExpanded((prev) => new Set(prev).add(f.id));
            },
          });
        },
      },
    ]);
  };

  return (
    <div
      className="relative flex-1 min-h-0 flex flex-col glass-pill rounded-2xl overflow-hidden shadow-pill"
      onContextMenu={onLibraryContextMenu}
    >
      {/* Header */}
      {collapsed ? (
        <div className="flex justify-center pt-4 pb-2">
          <button
            onClick={() => setCollapsed(false)}
            title={T("Expand Your Library")}
            aria-label={T("Expand Your Library")}
            className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
          >
            <PanelLeftOpen className="w-5 h-5" />
          </button>
        </div>
      ) : (
        // Nothing here may wrap: while the panel widens from the rail, a
        // wrapped "Your Library" grew the header and pushed every row down.
        <div className="flex items-center gap-2 px-5 pt-4 pb-2 whitespace-nowrap">
          <button
            onClick={() => navigate({ name: "library" })}
            className="flex items-center gap-2 text-[14px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
          >
            <Library className="w-4 h-4" />{T("Your Library")}</button>
          <div className="ml-auto flex items-center gap-1">
            {/* + opens Spotify's create dropdown — Playlist / Folder, no modal. */}
            <CreateMenu onFolderCreated={(f) => setExpanded((prev) => new Set(prev).add(f.id))} />
            <button
              onClick={() => setCollapsed(true)}
              title={T("Collapse Your Library")}
              aria-label={T("Collapse Your Library")}
              className="w-8 h-8 grid place-items-center rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Filter chips, Spotify's: one category at a time (a second click shows
          everything again); the sort button orders the albums. */}
      {!collapsed && (
        <div className="flex items-center gap-2 px-4 pb-2 whitespace-nowrap">
          {(Object.keys(FILTER_LABEL) as LibFilter[]).map((k) => (
            <button
              key={k}
              onClick={() => setFilter((f) => (f === k ? null : k))}
              aria-pressed={filter === k}
              className={`h-8 px-3 shrink-0 rounded-full text-[13px] font-medium transition-colors ${
                filter === k ? "bg-ink-hi text-black" : "bg-ink-hi/[0.07] text-ink-hi hover:bg-ink-hi/[0.12]"
              }`}
            >
              {FILTER_LABEL[k]}
            </button>
          ))}
          {rows.length > 1 && (
            <button
              ref={sortButtonRef}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                openSortMenu();
              }}
              title={T("Sort: {value}", { value: ORDER_LABEL[libraryOrder] })}
              aria-label={T("Sort: {value}", { value: ORDER_LABEL[libraryOrder] })}
              className="ml-auto w-8 h-8 grid place-items-center rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors"
            >
              <ArrowUpDown className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {/* The list keeps the scrollbar's room on both sides (scroll-center):
          on one side only it pulled every cover off the rail's centre line.
          Open, its 9px padding puts the covers' left edge at 36px (8px gap,
          1px border, 10px scrollbar room, 9px, the row's 8px) — where the
          logo above starts, as it does over the folded rail's centre. */}
      <div className={`flex-1 min-h-0 overflow-y-auto scroll-center pb-2 pt-1 space-y-0.5 ${collapsed ? "" : "px-[9px]"}`}>
        {rows.length === 0 && !collapsed ? (
          <div className="px-3 py-8 text-center text-[13px] text-ink-hi/55">{T("Nothing here yet — play a track to fill your library.")}</div>
        ) : (
          rows.map((r) => {
            const isCurrent = r.kind === "album" ? current?.albumId === r.id : current?.id === r.id;
            const pinnedRow = isPinned(r);
            return (
              <button
                key={`${r.kind}-${r.id}`}
                onClick={() => onClickRow(r)}
                // A pinned row is dragged into its place among the pinned ones.
                draggable={pinnedRow}
                onDragStart={
                  pinnedRow
                    ? (e) => {
                        e.dataTransfer.setData(PIN_MIME, r.id);
                        e.dataTransfer.effectAllowed = "move";
                        setPinDrag(r.id);
                      }
                    : undefined
                }
                onDragEnd={
                  pinnedRow
                    ? () => {
                        setPinDrag(null);
                        setPinDrop(null);
                      }
                    : undefined
                }
                onContextMenu={(e) => onRowContextMenu(e, r)}
                onDragOver={(e) => onRowDragOver(e, r)}
                onDragLeave={(e) => onRowDragLeave(e, r)}
                onDrop={(e) => onRowDrop(e, r)}
                title={
                  r.available === false ? T("{title} · not available right now", { title: r.title }) : collapsed
                      ? `${r.title} · ${r.subtitle}`
                      : undefined
                }
                aria-label={collapsed ? r.title : undefined}
                // Hundreds of album rows: only the ones on screen are laid out and painted.
                style={r.kind === "album" ? { contentVisibility: "auto", containIntrinsicSize: "auto 64px" } : undefined}
                className={`group relative w-full flex items-center gap-3 rounded-lg text-left hover:bg-ink-hi/[0.05] active:bg-ink-hi/[0.09] transition-[background-color,transform,opacity] duration-150 ${
                  pinDrag === r.id ? "opacity-40" : ""
                } ${
                  collapsed ? "justify-center p-1.5" : r.kind === "playlist" && r.folderId ? "p-2 pl-6" : "p-2"
                } ${dropHover === r.id ? "ring-2 ring-inset ring-accent/60 bg-ink-hi/[0.08] scale-[1.02]" : ""} ${
                  pulse === r.id ? "animate-drop-pulse" : ""
                } ${r.available === false ? "opacity-40" : ""}`}
              >
                {pinDrop?.id === r.id && (
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute left-2 right-2 h-0.5 rounded-full bg-accent ${pinDrop.below ? "-bottom-[2px]" : "-top-[2px]"}`}
                  />
                )}
                {/* max-w-none on the artwork: the base styles cap images at
                    their row's width, and in the icon rail (narrower still
                    once the list scrolls) that squeezed covers into
                    portrait rectangles. */}
                {r.singleKey === "liked" ? (
                  <LikedCover className="w-12 h-12 rounded-md art-hairline shrink-0" />
                ) : r.kind === "folder" ? (
                  <span className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
                    <Folder className="w-5 h-5 text-ink-hi/55" />
                  </span>
                ) : r.kind === "album" ? (
                  r.thumb ? (
                    <img
                      src={upgradeArtwork(r.thumb)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="w-12 h-12 max-w-none rounded-md object-cover art-hairline shrink-0"
                    />
                  ) : (
                    <span className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
                      <Disc3 className="w-5 h-5 text-ink-hi/55" />
                    </span>
                  )
                ) : r.kind === "smart" ? (
                  <span className="w-12 h-12 rounded-md bg-accent/15 art-hairline shrink-0 grid place-items-center">
                    <Sparkles className="w-5 h-5 text-accent" />
                  </span>
                ) : r.kind === "loose" ? (
                  <span className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
                    <ListMusic className="w-5 h-5 text-ink-hi/55" />
                  </span>
                ) : r.thumb ? (
                  <img src={upgradeArtwork(r.thumb)} alt="" className="w-12 h-12 max-w-none rounded-md object-cover art-hairline shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-md bg-ink-hi/[0.06] art-hairline shrink-0 grid place-items-center">
                    {r.kind === "playlist" ? (
                      <Music2 className="w-4 h-4 text-ink-hi/35" />
                    ) : (
                      <Heart className="w-4 h-4 text-ink-hi/35" />
                    )}
                  </div>
                )}
                {!collapsed && (
                  <>
                    <div className="min-w-0 flex-1">
                      <div
                        className={`text-[14px] font-semibold truncate ${
                          isCurrent ? "text-ink-hi" : "text-ink-hi"
                        }`}
                      >
                        {r.title}
                      </div>
                      <div className="text-[12.5px] text-ink-hi/55 truncate mt-0.5">{r.subtitle}</div>
                    </div>
                    {isCurrent && playing && <EqBars />}
                    {pinnedRow && <Pin className="w-3.5 h-3.5 text-accent shrink-0 fill-accent/20" aria-label={T("Pinned — drag to reorder")} />}
                    {r.kind === "folder" &&
                      (expanded.has(r.id) ? (
                        <ChevronDown className="w-4 h-4 text-ink-hi/45 shrink-0" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-ink-hi/45 shrink-0" />
                      ))}
                  </>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ============================================================ root */

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  return (
    <aside
      className={`${collapsed ? "w-[80px]" : "w-[328px]"} shrink-0 flex flex-col min-h-0 transition-[width] duration-200 ease-out`}
    >
      <LibraryPill collapsed={collapsed} />
    </aside>
  );
}
