/**
 * A playlist page's header, shared by the playlists, Liked Songs and an
 * artist's liked songs: the cover (or a mosaic of four) at the left beside
 * the name, the kind and the line of counts, over its own picture blurred
 * into the page; under them a row of actions — play, shuffle, whatever the
 * page adds, more. As tall as the full-bleed header it replaced (the user's
 * wish with the "clear head" mockup, 2026-11-16). Sizes follow the header's
 * own width, so a half-screen window with both panels open still fits.
 */
import type { ReactNode } from "react";
import { MoreHorizontal, Pause, Play, Shuffle } from "lucide-react";
import { T } from "../lib/i18n";

const ROUND = "w-11 h-11 grid place-items-center rounded-full bg-black/35 border border-white/10 text-white backdrop-blur-sm hover:bg-black/55 transition-all active:scale-[0.97]";
export const HERO_PILL =
  "inline-flex items-center gap-2 h-9 px-4 rounded-full border border-white/10 text-[13.5px] font-semibold backdrop-blur-sm transition-all active:scale-[0.97] whitespace-nowrap";

export function PlaylistHero({
  art,
  cover,
  title,
  eyebrow = T("Playlist"),
  meta,
  onShuffle,
  onPlay,
  onMore,
  playing = false,
  actions,
}: {
  /** the page's picture: blurred behind the header, and the cover unless one is given */
  art: ReactNode;
  /** the square at the left, when it isn't the picture itself (a mosaic of four covers) */
  cover?: ReactNode;
  title: string;
  eyebrow?: string;
  /** "12 songs · 58 min" */
  meta: string;
  onShuffle: () => void;
  onPlay: () => void;
  onMore: (x: number, y: number) => void;
  /** the page's songs are playing: the button says Pause */
  playing?: boolean;
  /** more buttons in the action row, before More */
  actions?: ReactNode;
}) {
  return (
    <div className="relative overflow-hidden" style={{ containerType: "inline-size" }}>
      <div className="absolute inset-0" aria-hidden>
        <div className="absolute -inset-10 blur-[54px] saturate-[1.35] opacity-75">{art}</div>
        <div
          className="absolute inset-0"
          style={{
            background: `linear-gradient(to bottom,
              rgb(var(--page-bg) / 0.25) 0%,
              rgb(var(--page-bg) / 0.55) 45%,
              rgb(var(--page-bg) / 0.92) 82%,
              rgb(var(--page-bg)) 100%)`,
          }}
        />
      </div>

      <div className="relative flex flex-wrap items-end gap-x-7 gap-y-4 page-pad pt-16 pb-5">
        <div
          className="shrink-0 rounded-xl overflow-hidden bg-black/30 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.75)]"
          style={{ width: "clamp(140px, 30cqi, 232px)", aspectRatio: "1 / 1" }}
        >
          {cover ?? art}
        </div>
        <div className="min-w-[200px] flex-1 pb-1">
          <div className="text-[12px] font-bold uppercase tracking-[0.16em] text-white/75 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">{eyebrow}</div>
          {/* line-clamp hides what leaves the box, and Segoe UI's g, y and p reach below a line of 1.12: at 1.2
              with a little room under the last line they stay whole, and a third line's tops still don't show. */}
          <h1
            className="font-display font-black tracking-[-0.045em] leading-[1.2] pb-[0.08em] text-white break-words line-clamp-2 mt-1 drop-shadow-[0_2px_14px_rgba(0,0,0,0.45)]"
            style={{ fontSize: "clamp(30px, 7cqi, 64px)" }}
          >
            {title}
          </h1>
          <div className="text-[13.5px] text-white/75 mt-2 drop-shadow-[0_1px_6px_rgba(0,0,0,0.5)]">{meta}</div>
        </div>
      </div>

      <div className="relative flex flex-wrap items-center gap-2.5 page-pad pb-5">
        {/* No `disabled` dimming when empty — playing no songs does nothing,
            and grayed-out buttons made fresh playlists look broken. */}
        <button
          onClick={onPlay}
          title={playing ? T("Pause") : T("Play")}
          aria-label={playing ? T("Pause") : T("Play")}
          className="w-14 h-14 grid place-items-center rounded-full bg-primary text-on-primary shadow-float hover:scale-[1.04] active:scale-[0.97] transition-transform"
        >
          {playing ? <Pause className="w-6 h-6 fill-current" /> : <Play className="w-6 h-6 fill-current ml-0.5" />}
        </button>
        <button onClick={onShuffle} title={T("Shuffle")} className={`${HERO_PILL} bg-black/30 text-white hover:bg-black/50`}>
          <Shuffle className="w-4 h-4" />
          {T("Shuffle")}
        </button>
        {actions}
        <button onClick={(e) => onMore(e.clientX, e.clientY)} title={T("More options")} aria-label={T("More options")} className={ROUND}>
          <MoreHorizontal className="w-[18px] h-[18px]" />
        </button>
      </div>
    </div>
  );
}
