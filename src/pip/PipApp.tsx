/**
 * PipApp — ByTune's native desktop miniplayer (PiP), rendered in its own
 * always-on-top BrowserWindow (`?window=pip`).
 *
 * Hybrid of Spotify's MiniPlayer (measured via CDP against the real app,
 * 330×342 viewport at 200% scale) and ByTune's own player treatments:
 *
 *   top bar 26px, auto-hides unless the window is hovered/focused — 6-dot
 *   grip centred, minimize and close X (12px boxes, right 29 / right 9,
 *   vertically centred);
 *   artwork fills the card edge-to-edge (object-cover) inside a 4px frame
 *   (5px along the top on Windows — see TOP_INSET),
 *   easing down a few px beneath the dropped bar — transform only, the
 *   cover never re-crops (ByTune's original presentation);
 *   the card's background is the artwork's dominant colour (visible while
 *   the cover loads), blending 0.5s linear between tracks;
 *   seek (10px grey times + slider over a rise that is solid black at the
 *   bottom, fading to transparent via black/70) shows on hover
 *   only, pinned above the metadata bar;
 *   hover overlay (the card's rect): linear-gradient(rgba(18,18,18,.53) →
 *   #0a0a0a), opacity 0.3s cubic-bezier(0,0,0.5,1), transport row centred —
 *   mute (+ horizontal #282828 volume pill 96px wide, radius 12, on hover), shuffle, prev,
 *   PLAY (48px white circle, black icon, in a 56×48 button), next, repeat,
 *   copy-link — 32px buttons, 16px icons, #b3b3b3;
 *   48px metadata bar: ByTune's own 15px/12px title+artist treatment and
 *   the original 32px like button with its like-burst celebration, floated
 *   10px above the bottom edge;
 *   resize grip 9×9 (0.5 strokes) 4px from the corner;
 *   the whole artwork area is the native drag surface (buttons carve
 *   no-drag) — exactly Spotify's fixed drag layer.
 *
 * Playback is NOT here. This window holds no audio: it renders snapshots
 * pushed from the main window (pip:state) and sends transport commands back
 * (pip:command). Closing it never touches playback.
 *
 * Hover mechanics: pointer events stop over the app-region drag surface, so
 * visibility is driven by the main process's native cursor watch
 * ("pip:cursor-inside") + keyboard focus — never by per-element listeners.
 */
import { useEffect, useRef, useState, type ReactNode, type FocusEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  SpCheck,
  SpCoverNote,
  SpNext,
  SpPause,
  SpPlay,
  SpPlus,
  SpPrev,
  SpRepeat,
  SpRepeatOne,
  SpShuffle,
  SpVolumeHigh,
  SpVolumeOff,
} from "../components/SpotifyIcons";
import { Slider } from "../components/Slider";
import { fmtTime } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";
import { isWindows } from "../lib/platform";
import type { PipCommand, PipSnapshot } from "./types";
import { T } from "../lib/i18n";

const dragRegion = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragRegion = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

/** Spotify MiniPlayer geometry (logical px, CDP-measured). */
const TOP_BAR_H = 26; // dropdown top bar
const INSET = 4; // frame gap around the artwork card (left/right)
/** Windows' frameless window border overlaps the client's first pixel row,
 *  which renders the collapsed top frame a device pixel thinner than the
 *  sides — on Windows the top runs 1px larger so all three read equal. */
const TOP_INSET = isWindows ? INSET + 1 : INSET;
const GRADIENT = "linear-gradient(rgba(18, 18, 18, 0.53) 0%, rgb(10, 10, 10) 100%)";

/** like-burst confetti — flight target (--tx/--ty), spin (--rot), size and
    shade of each square in the Spotify-style "added" celebration */
const LIKE_CONFETTI = [
  { size: 4, color: "#1ed760", tx: -3, ty: -17, rot: 95, delay: 0 },
  { size: 3, color: "#9af0b4", tx: 7, ty: -15, rot: -60, delay: 20 },
  { size: 3, color: "#169c46", tx: 15, ty: -7, rot: 140, delay: 10 },
  { size: 4, color: "#1ed760", tx: 18, ty: 3, rot: -110, delay: 30 },
  { size: 3, color: "#b7f5c4", tx: 13, ty: 12, rot: 70, delay: 0 },
  { size: 3, color: "#169c46", tx: 2, ty: 17, rot: -150, delay: 25 },
  { size: 4, color: "#1ed760", tx: -10, ty: 14, rot: 120, delay: 15 },
  { size: 3, color: "#9af0b4", tx: -17, ty: 5, rot: -90, delay: 35 },
  { size: 3, color: "#1ed760", tx: -18, ty: -6, rot: 60, delay: 20 },
  { size: 3, color: "#169c46", tx: -11, ty: -14, rot: -45, delay: 0 },
];

/** 6-dot drag grip — Spotify's exact 4×2 dot field (24px grid). */
function SpGrip({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M6 13a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m4 4a1 1 0 1 1 0 2 1 1 0 0 1 0-2m0-4a1 1 0 1 1 0 2 1 1 0 0 1 0-2" />
    </svg>
  );
}

/** Close X — Spotify's exact 16px-grid cross. */
function SpClose({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M2.47 2.47a.75.75 0 0 1 1.06 0L8 6.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L6.94 8 2.47 3.53a.75.75 0 0 1 0-1.06" />
    </svg>
  );
}

function send(command: PipCommand): void {
  window.bytune?.pipSendCommand(command);
}

function IconBtn({
  onClick,
  active,
  title,
  disabled,
  children,
}: {
  onClick?: () => void;
  active?: boolean;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      style={noDragRegion}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`relative grid h-8 w-8 cursor-pointer place-items-center rounded-full transition-all duration-150 hover:bg-white/10 active:scale-90 disabled:pointer-events-none disabled:opacity-40 ${
        active ? "text-white" : "text-white/90 hover:text-white"
      } focus-visible:text-white`}
    >
      {children}
      {/* Spotify's selected treatment: the icon keeps its normal colour and a
          small dot appears beneath it — no colour change. */}
      {active && (
        <span className="absolute bottom-[2px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-white" />
      )}
    </button>
  );
}

export function PipApp() {
  const [snap, setSnap] = useState<PipSnapshot | null>(null);
  /** native cursor watch (main process): true while the OS pointer is over
      the PiP window. Pointer events stop over the drag surface, so the main
      process arbitrates inside/outside — Spotify's model exactly. */
  const [cursorInside, setCursorInside] = useState(true);
  const [focusWithin, setFocusWithin] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const volTimer = useRef<number | null>(null);
  /** Spotify-style like-burst overlay (set when adding, self-clears) */
  const [likeBurst, setLikeBurst] = useState(false);
  const likeBurstTimer = useRef<number | null>(null);
  /** While the seek thumb is held down, the drag is purely visual: snapshots
      pushed from the main window must not fight the thumb mid-drag. The seek
      command is sent once, on release. */
  const [seekValue, setSeekValue] = useState<number | null>(null);
  /** dominant colour of the current artwork — the card's loading backdrop */
  const [ambient, setAmbient] = useState("#282828");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const off = window.bytune?.onPipState((s) => setSnap(s as PipSnapshot));
    return off;
  }, []);

  /* Space toggles playback while the PiP window is focused — main-window
     parity. The engine lives in the main window, so this routes over the
     command channel; text fields keep their normal Space, and keys only ever
     arrive here while the PiP window itself is focused. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== "Space" || e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      send({ type: "toggle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* The OS window's corners are rounded by the OS itself; the shell stays
     square and black so shell, corner squares and window edge all read as
     one solid black panel (Spotify does the same). */
  useEffect(() => {
    document.documentElement.style.background = "#000";
    document.body.style.background = "#000";
  }, []);

  useEffect(() => {
    const off = window.bytune?.onPipCursorInside((inside) => setCursorInside(inside));
    return off;
  }, []);

  // A new track resets any in-progress visual drag.
  const track = snap?.track ?? null;
  const trackId = track?.id ?? null;
  const thumb = track?.thumb ? upgradeArtwork(track.thumb) : "";
  useEffect(() => setSeekValue(null), [trackId]);

  /* Dominant artwork colour for the card's backdrop (visible while the cover
     loads): 48px canvas readback, 4-bit/channel quantisation, best bucket by
     count weighted toward saturation. Cross-origin readback can fail (file
     thumbs) — the previous neutral stays. */
  useEffect(() => {
    if (!thumb) {
      setAmbient("#282828");
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const c = document.createElement("canvas");
        c.width = 48;
        c.height = 48;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 48, 48);
        const data = ctx.getImageData(0, 0, 48, 48).data;
        const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
          const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
          e.n++;
          e.r += r;
          e.g += g;
          e.b += b;
          buckets.set(key, e);
        }
        let best: { n: number; r: number; g: number; b: number } | null = null;
        let bestScore = -1;
        for (const e of buckets.values()) {
          const mx = Math.max(e.r, e.g, e.b) / e.n;
          const mn = Math.min(e.r, e.g, e.b) / e.n;
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const score = e.n * (0.3 + sat);
          if (score > bestScore) {
            bestScore = score;
            best = e;
          }
        }
        if (!best || best.n === 0) return;
        setAmbient(`rgb(${Math.round(best.r / best.n)},${Math.round(best.g / best.n)},${Math.round(best.b / best.n)})`);
      } catch {
        /* tainted canvas — keep the current ambient */
      }
    };
    img.src = thumb;
    return () => {
      cancelled = true;
    };
  }, [thumb]);

  useEffect(
    () => () => {
      if (volTimer.current !== null) window.clearTimeout(volTimer.current);
      if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
    },
    []
  );

  /** Spotify shows bar + transport whenever the cursor is over the window
      (native watch) or the window holds keyboard focus. */
  const expanded = cursorInside || focusWithin;
  const playing = snap?.playing ?? false;
  const buffering = snap?.buffering ?? false;
  const duration = snap?.duration ?? 0;
  const position = Math.min(snap?.position ?? 0, duration > 0 ? duration : Infinity);
  const max = duration > 0 ? duration : 1;
  const shownSeek = Math.min(seekValue ?? position, max);
  const commitSeek = (fraction: number): void => {
    send({ type: "seek", sec: Math.min(fraction * max, max) });
    setSeekValue(null);
  };

  const onCardFocus = (e: FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(true);
  };
  const onCardBlur = (e: FocusEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false);
  };

  /* volume popover: one hover/focus region with a short linger on exit */
  const openVol = (): void => {
    if (volTimer.current !== null) {
      window.clearTimeout(volTimer.current);
      volTimer.current = null;
    }
    setVolOpen(true);
  };
  const scheduleVolClose = (): void => {
    if (volTimer.current !== null) window.clearTimeout(volTimer.current);
    volTimer.current = window.setTimeout(() => {
      volTimer.current = null;
      setVolOpen(false);
    }, 180);
  };

  const reveal = (extra = ""): string =>
    `${extra} transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
      expanded ? "opacity-100" : "pointer-events-none opacity-0"
    }`;

  return (
    <div
      ref={rootRef}
      onFocus={onCardFocus}
      onBlur={onCardBlur}
      onPointerEnter={() => setCursorInside(true)}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-pip-in fixed inset-0 flex select-none flex-col overflow-hidden bg-black text-white"
    >
      {/* ------------------------- upper player zone ------------------------- */}
      {/* Everything above the metadata bar. Native drag surface first: the
          whole area drags the window exactly like Spotify's fixed drag layer
          — interactive elements carve no-drag. Pointer events never fire
          over the drag surface; visibility runs off the native cursor
          watch + focus (see `expanded`). overflow-hidden clips the bar's
          hidden state above the window and the cover's tucked bottom. */}
      <div ref={zoneRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div aria-hidden className="absolute inset-0" style={dragRegion} />

        {/* the cover — fills the card edge-to-edge and slides 22px beneath
            the dropped bar (transform only: the image keeps its exact
            rendered size, never re-crops; the tucked bottom clips at the
            zone edge). The layer must NOT carry app-regions: drag carve-outs
            inside a transformed subtree are placed wrong by Chromium, so
            every app-region lives outside this layer. */}
        <div
          className={`absolute left-[4px] right-[4px] overflow-hidden rounded-[8px] transition-transform ${
            expanded ? "duration-200 ease-out" : "duration-[250ms] ease-in"
          }`}
          style={{
            top: TOP_INSET,
            height: `calc(100% - ${TOP_INSET}px)`,
            transform: expanded ? `translateY(${TOP_BAR_H - TOP_INSET}px)` : "translateY(0px)",
            backgroundColor: ambient,
          }}
        >
          {thumb ? (
            <img
              key={trackId ?? "none"}
              src={thumb}
              alt=""
              draggable={false}
              className="animate-art-in h-full w-full object-cover"
            />
          ) : (
            <div key={trackId ?? "none"} className="animate-art-in grid h-full w-full place-items-center">
              <SpCoverNote className="h-12 w-12 text-white/25" />
            </div>
          )}
        </div>

        {/* hover transport overlay — Spotify's gradient over the card.
            Sits at the card's EXPANDED geometry (fixed, untransformed) so
            its no-drag carve-outs track real layout. */}
        <div
          aria-hidden={!expanded}
          className={`absolute bottom-0 left-[4px] right-[4px] rounded-[8px] transition-opacity duration-300 ease-[cubic-bezier(0,0,0.5,1)] ${
            expanded ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          style={{ top: TOP_BAR_H, backgroundImage: GRADIENT }}
        >
          <div
            className={`absolute inset-0 flex items-center justify-center ${reveal()}`}
            onClick={() => send({ type: "toggle" })}
          >
            <div
              className="pip-controls flex items-center justify-center gap-[2px] px-1"
              onClick={(e) => e.stopPropagation()}
            >
              {/* volume + vertical popover — one hover region, bridged */}
              <div
                className="relative"
                onMouseEnter={openVol}
                onMouseLeave={scheduleVolClose}
                onFocus={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) openVol();
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) scheduleVolClose();
                }}
              >
                {/* No active marking: the glyph itself swaps to the muted
                    speaker, the way Spotify communicates mute. */}
                <IconBtn onClick={() => send({ type: "mute" })} title={snap?.muted ? T("Unmute") : T("Mute")}>
                  <span key={snap?.muted ? "off" : "on"} className="icon-swap">
                    {snap?.muted ? <SpVolumeOff /> : <SpVolumeHigh />}
                  </span>
                </IconBtn>
                {/* git-version hover design: horizontal pill, left-anchored
                    so it never clips the card edge; pb-2 bridges the pointer
                    gap while crossing button → slider. The no-drag carve-out
                    keeps the slider clickable over the drag surface. */}
                <div
                  className={`absolute bottom-full left-0 pb-2 transition-all duration-150 ease-[cubic-bezier(0.2,0.8,0.3,1)] ${
                    volOpen && expanded ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0"
                  }`}
                  style={noDragRegion}
                >
                  <div className="w-[96px] rounded-xl bg-[#282828] px-2.5 py-2 shadow-elev">
                    <Slider
                      size="mini"
                      label={T("Volume")}
                      value={snap?.muted ? 0 : snap?.volume ?? 0.8}
                      onChange={(v) => send({ type: "volume", v })}
                      step={0.05}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>
              <IconBtn onClick={() => send({ type: "shuffle" })} active={snap?.shuffle} title={T("Shuffle")} disabled={!track}>
                <SpShuffle />
              </IconBtn>
              <IconBtn onClick={() => send({ type: "prev" })} title={T("Previous")} disabled={!track}>
                <SpPrev />
              </IconBtn>
              <button
                type="button"
                style={noDragRegion}
                onClick={() => send({ type: "toggle" })}
                disabled={!track}
                title={playing ? T("Pause") : T("Play")}
                aria-label={playing ? T("Pause") : T("Play")}
                className="mx-1.5 grid h-12 w-12 cursor-pointer shrink-0 place-items-center rounded-full bg-white text-black shadow-[0_4px_16px_rgba(0,0,0,0.45)] transition-transform duration-150 hover:scale-[1.06] active:scale-95 focus-visible:scale-[1.06] disabled:pointer-events-none disabled:opacity-40"
              >
                {buffering ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <span key={playing ? "pause" : "play"} className="icon-swap">
                    {playing ? <SpPause className="h-5 w-5" /> : <SpPlay className="ml-0.5 h-5 w-5" />}
                  </span>
                )}
              </button>
              <IconBtn onClick={() => send({ type: "next" })} title={T("Next")} disabled={!track}>
                <SpNext />
              </IconBtn>
              <IconBtn
                onClick={() => send({ type: "repeat" })}
                active={snap?.repeat !== "off"}
                title={snap?.repeat === "one" ? T("Repeat one") : T("Repeat")}
                disabled={!track}
              >
                {snap?.repeat === "one" ? <SpRepeatOne /> : <SpRepeat />}
              </IconBtn>
            </div>
          </div>
        </div>

        {/* seek — hover only, pinned above the metadata bar (old treatment):
            10px grey times flanking the slider over a rise that is solid
            black at the bottom (artwork must not bleed through) fading to
            transparent via black/70 */}
        <div
          className={`absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black via-black/70 to-transparent px-3 pb-2 pt-5 ${reveal()}`}
          style={noDragRegion}
          onClick={(e) => e.stopPropagation()}
          aria-hidden={!expanded}
        >
          <div className="flex items-center gap-2">
            <span className="w-7 shrink-0 text-right text-[10px] tabular-nums leading-none text-white/70">
              {fmtTime(shownSeek)}
            </span>
            <Slider
              size="mini"
              label={T("Seek")}
              className="min-w-0 flex-1"
              value={shownSeek / max}
              disabled={!track}
              step={5 / max}
              onScrub={(v) => {
                if (v !== null) setSeekValue(v * max);
              }}
              onCommit={commitSeek}
            />
            <span className="w-7 shrink-0 text-[10px] tabular-nums leading-none text-white/70">
              {fmtTime(duration)}
            </span>
          </div>
        </div>

        {/* top bar — 26px, drops when the cursor is over the window / the
            window is focused; sits 1px down so it laps the cover's top edge
            instead of meeting it flush. The close button carves no-drag out
            of the drag surface. */}
        <div className="absolute inset-x-0 top-[1px] z-20 h-[26px]">
          <div
            className={`relative flex h-full w-full items-center justify-center bg-black transition-[transform,opacity] ${
              expanded ? "translate-y-0 opacity-100 duration-200 ease-out" : "pointer-events-none -translate-y-full opacity-0 duration-[250ms] ease-in"
            }`}
          >
            <SpGrip className="h-6 w-6 text-[#b3b3b3]" />
            <button
              type="button"
              style={noDragRegion}
              onClick={() => window.bytune?.pipMinimize()}
              title={T("Minimize miniplayer")}
              aria-label={T("Minimize miniplayer")}
              className="absolute right-[29px] top-[7px] grid h-3 w-3 cursor-pointer place-items-center rounded-full text-white transition-colors duration-150 hover:bg-white/10 active:scale-95"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                {/* span matches one X stick's tip-to-tip reach (2.47→13.53
                    incl. round caps) so the minus reads as wide as the X */}
                <path d="M3.27 8h9.46" />
              </svg>
            </button>
            <button
              type="button"
              style={noDragRegion}
              onClick={() => window.bytune?.pipClose()}
              title={T("Close miniplayer")}
              aria-label={T("Close miniplayer")}
              className="absolute right-[9px] top-[7px] grid h-3 w-3 cursor-pointer place-items-center rounded-full text-white transition-colors duration-150 hover:bg-white/10 active:scale-95"
            >
              <SpClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* ------------------------- metadata bar ------------------------- */}
      {/* floats a 10px gap above the bottom edge instead of sitting flush */}
      <div className="relative z-10 mx-2 mb-[10px] flex h-12 shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => window.bytune?.pipShowMain()}
          title={T("Open Songsta")}
          className="min-w-0 flex-1 cursor-pointer text-left"
        >
          <div key={trackId ?? "t"} className="animate-meta-in truncate text-[15px] font-semibold leading-[1.35] text-white">
            {track ? track.title : T("Nothing playing")}
          </div>
          <div key={trackId ? `${trackId}-a` : "a"} className="animate-meta-in truncate text-[12px] leading-[1.4] text-white/60">
            {track ? track.artist : ""}
          </div>
        </button>

        {track && (
          <button
            type="button"
            style={noDragRegion}
            onClick={() => {
              // Spotify-style "added" burst when liking (unliked -> liked);
              // tapping the green check (unlike) just swaps back quietly.
              if (!snap?.liked && !likeBurst) {
                setLikeBurst(true);
                if (likeBurstTimer.current !== null) window.clearTimeout(likeBurstTimer.current);
                likeBurstTimer.current = window.setTimeout(() => setLikeBurst(false), 900);
              }
              send({ type: "like" });
            }}
            title={snap?.liked ? T("Edit Liked Songs") : T("Save to your library")}
            aria-label={snap?.liked ? T("Remove from Liked Songs") : T("Save to Liked Songs")}
            aria-pressed={snap?.liked}
            className="relative grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full transition-transform duration-150 hover:scale-105 active:scale-90"
          >
            <span key={snap?.liked ? "liked" : "unliked"} className="icon-swap">
              {snap?.liked ? (
                <SpCheck className="h-[18px] w-[18px] text-[#1ed760]" />
              ) : (
                <SpPlus className="h-[18px] w-[18px] text-white/70 hover:text-white" />
              )}
            </span>
            {/* like-burst overlay — green check disc + expanding ring + green
                confetti squares; purely visual (pointer-transparent) */}
            {likeBurst && (
              <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-0 w-0">
                {LIKE_CONFETTI.map((p, i) => (
                  <span
                    key={i}
                    className="absolute block"
                    style={
                      {
                        width: p.size,
                        height: p.size,
                        left: -p.size / 2,
                        top: -p.size / 2,
                        background: p.color,
                        animation: `pip-like-confetti 700ms ease-out ${p.delay}ms both`,
                        "--tx": `${p.tx}px`,
                        "--ty": `${p.ty}px`,
                        "--rot": `${p.rot}deg`,
                      } as React.CSSProperties
                    }
                  />
                ))}
                <span
                  className="absolute block rounded-full border-2 border-[#1d7a3c]"
                  style={{ width: 28, height: 28, left: -14, top: -14, animation: "pip-like-ring 800ms ease-out both" }}
                />
                <span
                  className="absolute grid place-items-center rounded-full bg-[#1ed760]"
                  style={{ width: 27, height: 27, left: -13.5, top: -13.5, animation: "pip-like-pop 850ms ease-out both" }}
                >
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="#000" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M5.5 12.5l4.4 4.4L18.5 8.3" />
                  </svg>
                </span>
              </span>
            )}
          </button>
        )}
      </div>

      {/* resize grip — Spotify's 9×9 double-line mark, 4px from the corner.
          Purely visual: frameless resizing is the window's native edges. */}
      <div aria-hidden className="pointer-events-none absolute bottom-[4px] right-[4px] text-[#b3b3b3]">
        <svg viewBox="0 0 9 9" width="9" height="9" fill="none">
          <line x1="0.823223" y1="8.82322" x2="8.82322" y2="0.823223" stroke="currentColor" strokeWidth="0.5" />
          <line x1="4.82322" y1="8.82322" x2="8.82322" y2="4.82322" stroke="currentColor" strokeWidth="0.5" />
        </svg>
      </div>
    </div>
  );
}
