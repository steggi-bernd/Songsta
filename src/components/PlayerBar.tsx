/**
 * PlayerBar — point-for-point clone of the Spotify web player's
 * now-playing bar. All values below were extracted from Spotify's live
 * computed styles (DevTools), and every icon is Spotify's own SVG
 * geometry extracted verbatim from the page (SpotifyIcons.tsx):
 *
 *  - black 88px bar (measured off the desktop app), 56px content row
 *    centred → 16px inset top/bottom; 16px to the cover on the left, 8px
 *    footer padding + 8px button padding = 16px to the last glyph on the right
 *  - left: 56px cover (4px radius, #282828 placeholder; opens Now
 *    Playing), 10px gap, title 14/19 white (opens the album) + artists
 *    12/17 #b3b3b3 (each opens its artist page), hover underline, then the
 *    playback format line; like button 16×32 with a 16px icon (#b3b3b3 →
 *    white), 16px after the text
 *  - centre: [shuffle, prev] —16px— play disc —16px— [next, repeat], the
 *    groups flex-1 so the disc sits dead centre; buttons 32×32 (8px pad,
 *    full radius), icons 16×16 #b3b3b3 → white on hover; disc 32px white
 *    with the black 16px glyph; active modes keep their colour with a
 *    white dot beneath (Spotify's treatment)
 *  - seek row (8px below transport): fixed 50px time boxes (12/17
 *    #b3b3b3) flanking a flexible bar — 12px hit area, 4px track (2px
 *    radius, white @30%), white fill, 12px white handle on hover
 *  - right: lyrics / queue / cast / volume (speaker 32px + 67px track)
 *    / miniplayer / fullscreen — 16px icons white @70% → white on hover
 *  - while another device has the music: a "Playing on …" strip above the
 *    bar, tinted in the accent colour, with *Play here* to bring it back
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check, Heart, ListMusic, ListPlus, Loader2, Smartphone, Speaker } from "lucide-react";
import {
  SpCheck,
  SpCoverNote,
  SpExitFullscreen,
  SpFullscreen,
  SpLyrics,
  SpMiniplayer,
  SpNext,
  SpPause,
  SpPlay,
  SpPlus,
  SpPrev,
  SpQueue,
  SpRepeat,
  SpRepeatOne,
  SpShuffle,
  SpVolumeHigh,
  SpVolumeOff,
} from "./SpotifyIcons";
import { SeekBar, VolumeControl } from "./Controls";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItem } from "../stores/ui";
import { sourceOf } from "../stores/availability";
import { useCatalog } from "../stores/catalog";
import { upgradeArtwork } from "../lib/artwork";
import { useDrag } from "../lib/dnd";
import { isLibraryTrack } from "../lib/libraryTracks";
import { ArtistLinks } from "./ArtistLinks";
import { describePlayback, formatLine } from "../lib/playbackFormat";
import { otherDevices, useHomeSync } from "../lib/homeSync";
import { stopCasting, useCast, useVolumeTarget } from "../lib/cast";
import { useDeviceNames } from "../stores/deviceNames";
import type { Track } from "../types";
import { T } from "../lib/i18n";

const SOURCE_NAME = { local: "a file on this device", jellyfin: "Jellyfin", subsonic: "Navidrome" } as const;

/**
 * What is playing, after any conversion on the way: a Hi-Res / Lossless /
 * Lossy tag and the format line ("FLAC 24-bit / 96 kHz", "MP3 320 kbps").
 * A song found in several places shows the copy it actually plays from.
 */
function PlaybackFormatLine({ track }: { track: Track }) {
  const playingFrom = usePlayer((s) => s.sources[track.id]) ?? track;
  // The catalogue's copy carries the media info a queue entry saved by an older version may lack.
  const listed = useCatalog((s) => s.byId.get(playingFrom.id));
  const version = listed ?? playingFrom;
  const format = describePlayback(version);
  if (!format) return null;
  const tier = format.hiRes ? "Hi-Res" : format.lossless ? T("Lossless") : T("Lossy");
  const line = formatLine(format);
  const from = SOURCE_NAME[sourceOf(version) ?? "local"];
  const details = [
    `${format.hiRes ? T("Hi-Res lossless") : format.lossless ? T("Lossless") : T("Lossy")} · ${line}`,
    T("Playing from {from}", { from }),
    format.note ? `${format.note.charAt(0).toUpperCase()}${format.note.slice(1)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <span className="mt-[3px] flex min-w-0 items-center gap-1.5 text-[11px] leading-[14px] text-[#b3b3b3]" title={details}>
      <span
        className={`shrink-0 rounded-[3px] px-1 text-[9px] font-bold uppercase leading-[14px] tracking-[0.06em] ${
          format.hiRes
            ? "bg-[#e6c35c]/[0.16] text-[#e6c35c]"
            : format.lossless
              ? "bg-white/[0.12] text-white"
              : "bg-white/[0.06] text-[#8f8f8f]"
        }`}
      >
        {tier}
      </span>
      <span className="truncate tabular-nums">{line}</span>
    </span>
  );
}

/** A span that acts as a link — inline, so a long credit line still truncates with an ellipsis. */
function linkProps(go: () => void) {
  return {
    role: "link",
    tabIndex: 0,
    onClick: go,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Enter") go();
    },
  };
}

/**
 * Title and artists, Spotify's way: the title opens the album, each credited
 * artist their own page (the cover opens the Now Playing view).
 */
function TrackMeta({ track }: { track: Track | null }) {
  const navigate = useUI((s) => s.navigate);
  if (!track) {
    return (
      <div className="ml-2.5 min-w-0">
        <span className="block truncate text-[14px] leading-[19px] text-white">{T("Nothing playing")}</span>
        <span className="block truncate text-[12px] leading-[17px] text-[#b3b3b3]">{T("Search for something to play")}</span>
      </div>
    );
  }
  const library = isLibraryTrack(track);
  const album = track.albumId?.startsWith("lib:album:") ? track.albumId : null;
  return (
    <div className="ml-2.5 min-w-0" key={`meta-${track.id}`}>
      <span className="block truncate text-[14px] leading-[19px] text-white">
        {album ? (
          <span
            {...linkProps(() => navigate({ name: "album", param: album }))}
            title={track.album ? T("Go to {album}", { album: track.album }) : undefined}
            className="cursor-pointer hover:underline"
          >
            {track.title}
          </span>
        ) : (
          track.title
        )}
      </span>
      <span className="block truncate text-[12px] leading-[17px] text-[#b3b3b3]">
        {library ? <ArtistLinks artist={track.artist} className="hover:text-white" /> : track.artist}
      </span>
      <PlaybackFormatLine track={track} />
    </div>
  );
}

/* Transport button — 32×32, 16px glyph, colour-only hover (Spotify). */
function TransportButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`relative grid h-8 w-8 place-items-center rounded-full transition-colors ${
        active ? "text-accent" : "text-[#b3b3b3] hover:text-white"
      }`}
    >
      {children}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" />
      )}
    </button>
  );
}

/* Right-cluster button — 32×32, 16px icon white @70% → white. */
function BarButton({
  onClick,
  active,
  title,
  className: extra = "",
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`relative grid h-8 w-8 place-items-center rounded-full transition-colors ${extra} ${
        active ? "text-accent" : "text-white/70 hover:text-white"
      }`}
    >
      {children}
      {/* Spotify's selected treatment for the right-cluster toggles: full
          white icon plus a small dot beneath — no highlight circle. */}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" />
      )}
    </button>
  );
}

/** Where the music is, by the names you gave your devices: "Kitchen + Patio". */
function useCastingLabel(): string | undefined {
  const active = useCast((s) => s.active);
  const members = useCast((s) => s.members);
  const names = useDeviceNames((s) => s.names);
  if (!active) return undefined;
  return (members.length > 1 ? members : [active]).map((d) => names[d.id] ?? d.name).join(" + ");
}

/** Opens the devices: where the music plays, here or anywhere else. */
function DevicesButton() {
  const connecting = useCast((s) => s.connecting);
  const followed = useHomeSync((s) => s.followed);
  const open = useUI((s) => s.rightPanel === "devices");
  const castingLabel = useCastingLabel();
  const elsewhere = castingLabel ?? followed?.name;
  return (
    <button
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        useUI.setState({ rightPanel: open ? "details" : "devices" });
      }}
      title={elsewhere ? T("Playing on {elsewhere}", { elsewhere }) : T("Devices")}
      aria-label={elsewhere ? T("Playing on {elsewhere}", { elsewhere }) : T("Devices")}
      aria-pressed={open}
      className={`relative grid h-8 w-8 place-items-center rounded-full transition-colors ${
        elsewhere || open ? "text-accent" : "text-white/70 hover:text-white"
      }`}
    >
      {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Speaker className="h-4 w-4" />}
      {elsewhere && <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" />}
    </button>
  );
}

export function PlayerBar() {
  const track = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const buffering = usePlayer((s) => s.buffering);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const toggleShuffle = usePlayer((s) => s.toggleShuffle);
  const cycleRepeat = usePlayer((s) => s.cycleRepeat);
  // While a network player has the music, its volume (lib/cast.ts).
  const { value: volume, muted } = useVolumeTarget();
  const castingTo = useCast((s) => s.active);
  const castingLabel = useCastingLabel();
  const followed = useHomeSync((s) => s.followed);

  const liked = useLibrary((s) => (track ? s.liked.some((t) => t.id === track.id) : false));
  const hideVolumeBar = useSettings((s) => s.hideVolumeBar);
  const coverDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  /** The "+" beside the track — two top-level options: liked, and the
      playlists flyout (hover → every playlist + "New playlist"), so a big
      playlist library never floods the first click. */
  const addToPlaylistRef = useRef<HTMLButtonElement | null>(null);
  const openAddToPlaylist = (): void => {
    if (!track) return;
    // Real toggle: when the picker is already open, this click closes it.
    // (The pointerdown handler on the button below keeps the open menu alive
    // until the click arrives — otherwise the menu's outside-press dismissal
    // fired first and every press on "+" re-opened it, never closing it.)
    if (useUI.getState().contextMenu) {
      useUI.getState().closeContextMenu();
      return;
    }
    const lib = useLibrary.getState();
    const items: MenuItem[] = [
      {
        label: liked ? T("Remove from Liked Songs") : T("Add to Liked Songs"),
        icon: Heart,
        action: () => lib.toggleLike(track),
      },
      {
        label: T("Add to playlist"),
        icon: ListMusic,
        children: [
          ...lib.playlists.map((p) => {
            const inList = p.tracks.some((t) => t.id === track.id);
            return {
              icon: inList ? Check : undefined,
              label: inList ? T("Remove from \"{name}\"", { name: p.name }) : T("Add to \"{name}\"", { name: p.name }),
              action: () => {
                if (inList) {
                  useLibrary.getState().removeFromPlaylist(p.id, track.id);
                  useUI.getState().toast(T("Removed from \"{name}\"", { name: p.name }));
                } else {
                  const added = useLibrary.getState().addToPlaylist(p.id, track);
                  useUI.getState().toast(added ? T("Added to \"{name}\"", { name: p.name }) : T("Already in this playlist"));
                }
              },
            };
          }),
          {
            separatorBefore: lib.playlists.length > 0,
            label: T("New playlist"),
            icon: ListPlus,
            action: () => {
              // Name it before it exists — cancel adds nothing. Blank
              // confirm keeps the numbered default.
              const suggested = `Playlist ${useLibrary.getState().playlists.length + 1}`;
              useUI.getState().openDialog({
                title: T("New playlist"),
                body: T("Add \"{title}\" to a new playlist.", { title: track.title }),
                initialValue: suggested,
                placeholder: T("Playlist name"),
                confirmLabel: T("Create"),
                onConfirm: (value) => {
                  const fresh = useLibrary.getState();
                  const playlist = fresh.createPlaylist(value.trim() || suggested);
                  fresh.addToPlaylist(playlist.id, track);
                  useUI.getState().navigate({ name: "playlist", param: playlist.id });
                },
              });
            },
          },
        ],
      },
    ];
    const rect = addToPlaylistRef.current?.getBoundingClientRect();
    // The playbar hugs the window bottom — the menu hangs ABOVE the button.
    useUI
      .getState()
      .openContextMenu(rect?.left ?? window.innerWidth / 2, rect?.top ?? window.innerHeight / 2, items, {
        above: true,
      });
  };

  const lyricsCenter = useUI((s) => s.lyricsCenter);
  const rightPanel = useUI((s) => s.rightPanel);
  const nowPlayingOpen = useUI((s) => s.nowPlayingOpen);
  const toggleLyrics = useUI((s) => s.toggleLyrics);
  const toggleQueue = useUI((s) => s.toggleQueue);
  const toggleNowPlaying = useUI((s) => s.toggleNowPlaying);

  // The miniplayer is a separate native always-on-top window (see
  // electron/pip.ts); this button just toggles it and mirrors its state.
  const [pipOpen, setPipOpen] = useState(false);
  useEffect(() => {
    const bridge = window.bytune;
    if (!bridge?.pipToggle) return;
    void bridge.pipIsOpen?.().then((open) => setPipOpen(!!open));
    const off = bridge.onPipOpenChange?.((open) => setPipOpen(open));
    return off;
  }, []);
  const toggleMiniPlayer = (): void => void window.bytune?.pipToggle();

  const VolIcon = muted || volume === 0 ? SpVolumeOff : SpVolumeHigh;

  return (
    <footer className="shrink-0 z-30 bg-black px-2">
      {(castingTo || followed) && (
        <div className="mt-1.5 flex h-8 items-center gap-2 rounded-lg bg-accent/[0.16] pl-3 pr-1 text-[12.5px] font-semibold text-ink-hi ring-1 ring-inset ring-accent/40">
          {castingTo ? <Speaker className="h-3.5 w-3.5 shrink-0 text-accent" /> : <Smartphone className="h-3.5 w-3.5 shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 truncate">{castingTo ? T("Playing on {castingLabel}", { castingLabel }) : T("Playing on {name}", { name: followed?.name ?? "" })}</span>
          <button
            onClick={() => (followed && !castingTo ? otherDevices.takeHere() : void stopCasting())}
            className="h-6 shrink-0 rounded-full bg-accent px-3 text-[12px] font-bold text-black transition hover:brightness-110 active:scale-95"
          >
            {T("Play here")}
          </button>
        </div>
      )}
      <div
        className="h-[88px] grid grid-cols-[3fr_4fr_3fr] items-center"
        role="contentinfo"
        aria-label={T("Now playing bar")}
      >
        {/* Track info — click opens the Now Playing view. */}
        <div className="flex items-center min-w-0 pl-2">
          <button
            onClick={toggleNowPlaying}
            {...(track ? coverDrag.props : {})}
            title={T("Now playing view — drag to a playlist to add this song")}
            aria-label={T("Now playing view")}
            className={`h-14 w-14 shrink-0 overflow-hidden rounded-[4px] bg-[#282828] focus:outline-none ${
              track && coverDrag.dragging ? "opacity-50" : ""
            }`}
          >
            {track?.thumb ? (
              <img
                key={track.id}
                src={upgradeArtwork(track.thumb)}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center">
                <SpCoverNote />
              </div>
            )}
          </button>
          <TrackMeta track={track} />
          {track && (
            <button
              ref={addToPlaylistRef}
              onPointerDown={(e) => {
                // Keep the context menu's outside-press dismissal from
                // closing an open picker on this press — the click handler
                // then sees the open menu and toggles it closed instead.
                e.stopPropagation();
              }}
              onClick={(e) => {
                // The opening click must not bubble to the ContextMenu's
                // click-outside listener, or it closes itself immediately.
                e.stopPropagation();
                openAddToPlaylist();
              }}
              title={T("Add to playlist")}
              aria-label={T("Add to playlist")}
              aria-haspopup="menu"
              className="ml-4 flex h-8 w-4 shrink-0 items-center justify-center text-[#b3b3b3] transition-all hover:scale-105 hover:text-white active:scale-95"
            >
              {/* Spotify's model: the glyph reflects Liked state, the click
                  always opens the add-to-playlist picker. */}
              {liked ? <SpCheck className="text-accent" /> : <SpPlus />}
            </button>
          )}
        </div>

        {/* Centre — [shuffle prev] play [next repeat], disc dead centre. */}
        <div className="flex h-14 flex-col justify-center gap-2">
          <div className="flex w-full items-center gap-4">
            <div className="flex flex-1 items-center justify-end gap-2">
              <TransportButton onClick={toggleShuffle} active={shuffle} title={shuffle ? T("Disable Shuffle") : T("Enable Shuffle")}>
                <SpShuffle />
              </TransportButton>
              <TransportButton onClick={() => prev()} title={T("Previous")}>
                <SpPrev />
              </TransportButton>
            </div>
            <button
              onClick={toggle}
              title={playing ? T("Pause") : T("Play")}
              aria-label={playing ? T("Pause") : T("Play")}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white text-black transition-transform hover:scale-[1.06] active:scale-95"
            >
              {buffering ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : playing ? (
                <SpPause />
              ) : (
                <SpPlay />
              )}
            </button>
            <div className="flex flex-1 items-center gap-2">
              <TransportButton onClick={() => next(true)} title={T("Next")}>
                <SpNext />
              </TransportButton>
              <TransportButton
                onClick={cycleRepeat}
                active={repeat !== "off"}
                title={repeat === "off" ? T("Enable repeat") : repeat === "all" ? T("Disable repeat") : T("Enable repeat one")}
              >
                {repeat === "one" ? <SpRepeatOne /> : <SpRepeat />}
              </TransportButton>
            </div>
          </div>
          <SeekBar thin />
        </div>

        {/* Right — lyrics, queue, volume, miniplayer, fullscreen. */}
        <div className="flex items-center justify-end">
          <BarButton onClick={toggleLyrics} title={T("Lyrics")} active={lyricsCenter}>
            <SpLyrics />
          </BarButton>
          <BarButton onClick={toggleQueue} title={T("Queue")} active={rightPanel === "queue"}>
            <SpQueue />
          </BarButton>
          <DevicesButton />
          {!hideVolumeBar && <VolumeControl VolIcon={VolIcon} />}
          <BarButton
            onClick={toggleMiniPlayer}
            active={pipOpen}
            title={pipOpen ? T("Close Miniplayer") : T("Open Miniplayer")}
            className="ml-2"
          >
            <SpMiniplayer />
          </BarButton>
          <BarButton
            onClick={toggleNowPlaying}
            title={nowPlayingOpen ? T("Exit Full screen") : T("Enter Full screen")}
          >
            {nowPlayingOpen ? <SpExitFullscreen /> : <SpFullscreen />}
          </BarButton>
        </div>
      </div>
    </footer>
  );
}
