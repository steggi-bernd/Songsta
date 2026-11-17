/**
 * Explore's albums by year — what the tiles turn into while they're sorted by
 * release. On top, a strip of bars: albums per year across the whole range,
 * the years in view lit, a bar jumps to its year. Under it the timeline runs
 * sideways: each year's albums stand in stacks of three above its dot on the
 * line, the year big beneath. Over the timeline the wheel scrolls sideways
 * until an end is reached; a touchpad's sideways swipe does so by itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import type { LibAlbum } from "../lib/catalogIndex";
import type { AlbumRow } from "../lib/exploreRows";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import { playCollection, useCollectionPlayback } from "./LibraryCards";
import { Artwork } from "./primitives";

// Small enough that the strip and three covers a year fit under Explore's head in an ordinary window.
const COVER = 80;
const ROWS = 3;
const ITEM_H = COVER + 22;
const GAP = 8;
const STACK_H = ROWS * ITEM_H + (ROWS - 1) * GAP;
const BAR_H = 40;

interface YearColumn {
  key: string;
  year?: number;
  albums: LibAlbum[];
}

/** One album on the timeline: its cover with a small play button, its title under it. */
function TimelineAlbum({ album }: { album: LibAlbum }) {
  const navigate = useUI((s) => s.navigate);
  const { active, playing } = useCollectionPlayback(album.tracks);
  const open = (): void => navigate({ name: "album", param: album.route });
  const label = playing ? T("Pause") : T("Play");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        open();
      }}
      title={`${album.title} · ${album.artist}`}
      {...tintHoverHandlers(album.thumb)}
      className="group cursor-pointer select-none"
      style={{ width: COVER }}
    >
      <div className="relative rounded-lg overflow-hidden shadow-elev">
        <Artwork src={album.thumb} rounded="rounded-lg" className="w-full aspect-square transition-transform duration-300 ease-out group-hover:scale-[1.05]" iconClassName="w-6 h-6" />
        <button
          type="button"
          title={label}
          aria-label={label}
          data-no-drag
          onClick={(e) => {
            e.stopPropagation();
            if (active) usePlayer.getState().toggle();
            else playCollection(album.tracks);
          }}
          className={`absolute bottom-1.5 right-1.5 w-8 h-8 rounded-full bg-primary text-on-primary grid place-items-center shadow-float transition-opacity duration-150 ${
            playing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          }`}
        >
          {playing ? <Pause className="w-3.5 h-3.5 fill-current" /> : <Play className="w-3.5 h-3.5 fill-current ml-px" />}
        </button>
      </div>
      <div className="mt-1 text-[12px] font-semibold text-ink-hi truncate leading-snug">{album.title}</div>
    </div>
  );
}

export function YearTimeline({ rows, desc }: { rows: AlbumRow[]; desc: boolean }) {
  // The rows come sorted by release already; a year keeps that order inside it.
  const columns = useMemo<YearColumn[]>(() => {
    const byYear = new Map<number, LibAlbum[]>();
    const undated: LibAlbum[] = [];
    for (const r of rows) {
      const y = r.album.year;
      if (!y) undated.push(r.album);
      else byYear.set(y, [...(byYear.get(y) ?? []), r.album]);
    }
    const years = [...byYear.keys()].sort((a, b) => (desc ? b - a : a - b));
    const out: YearColumn[] = years.map((year) => ({ key: String(year), year, albums: byYear.get(year) ?? [] }));
    if (undated.length) out.push({ key: "none", albums: undated });
    return out;
  }, [rows, desc]);

  // Every year from the first to the last, also those without an album, so the strip reads as a spread.
  const strip = useMemo(() => {
    const dated = columns.filter((c) => c.year);
    if (!dated.length) return { bars: [] as { year: number; count: number }[], most: null as { year: number; count: number } | null };
    const counts = new Map(dated.map((c) => [c.year as number, c.albums.length]));
    const years = dated.map((c) => c.year as number);
    const lo = Math.min(...years);
    const hi = Math.max(...years);
    const bars: { year: number; count: number }[] = [];
    for (let y = lo; y <= hi; y++) bars.push({ year: y, count: counts.get(y) ?? 0 });
    if (desc) bars.reverse();
    const most = bars.reduce((m, b) => (b.count > m.count ? b : m), bars[0]);
    return { bars, most };
  }, [columns, desc]);
  const maxCount = Math.max(1, ...strip.bars.map((b) => b.count));

  const scroller = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState<ReadonlySet<string>>(new Set());
  const measure = useCallback((): void => {
    const el = scroller.current;
    if (!el) return;
    const from = el.scrollLeft;
    const to = from + el.clientWidth;
    const seen = new Set<string>();
    el.querySelectorAll<HTMLElement>("[data-year-col]").forEach((col) => {
      if (col.offsetLeft + col.offsetWidth > from && col.offsetLeft < to) seen.add(col.dataset.yearCol ?? "");
    });
    setInView((prev) => (prev.size === seen.size && [...seen].every((k) => prev.has(k)) ? prev : seen));
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    let frame = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // A wheel without a sideways part scrolls the timeline sideways until it reaches an end.
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 32 : e.deltaY;
    };
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", onWheel);
    };
  }, [measure, columns]);

  const jumpTo = (key: string): void => {
    const el = scroller.current;
    const col = el?.querySelector<HTMLElement>(`[data-year-col="${key}"]`);
    if (el && col) el.scrollTo({ left: Math.max(0, col.offsetLeft - 24), behavior: "smooth" });
  };

  // Labels under the strip: the decades, and the first and last year where no decade stands close.
  const labelAt = (i: number): string | null => {
    const y = strip.bars[i]?.year;
    if (y === undefined) return null;
    if (y % 10 === 0) return String(y);
    const end = i === 0 || i === strip.bars.length - 1;
    if (!end) return null;
    const near = strip.bars.some((b, j) => Math.abs(j - i) <= 3 && b.year % 10 === 0);
    return near ? null : String(y);
  };

  return (
    <div className="space-y-5">
      {strip.bars.length > 1 && (
        <section className="rounded-2xl bg-ink-hi/[0.035] px-5 pt-3.5 pb-2.5">
          {/* Narrow, the summary goes under the name instead of being cut. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-2.5">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim whitespace-nowrap">{T("Albums per year")}</span>
            {strip.most && (
              <span className="text-[12.5px] text-ink-dim">
                {T("{year} has the most: {count}", { year: strip.most.year, count: plural(strip.most.count, T("album"), T("albums")) })}
              </span>
            )}
          </div>
          <div className="flex items-end gap-[3px]" style={{ height: BAR_H }}>
            {strip.bars.map((b) =>
              b.count ? (
                <button
                  key={b.year}
                  type="button"
                  onClick={() => jumpTo(String(b.year))}
                  title={`${b.year} · ${plural(b.count, T("album"), T("albums"))}`}
                  aria-label={`${b.year} · ${plural(b.count, T("album"), T("albums"))}`}
                  className={`flex-1 min-w-[3px] rounded-t-[3px] transition-colors ${inView.has(String(b.year)) ? "bg-accent" : "bg-ink-hi/[0.2] hover:bg-ink-hi/[0.4]"}`}
                  style={{ height: Math.max(4, Math.round((b.count / maxCount) * BAR_H)) }}
                />
              ) : (
                <span key={b.year} aria-hidden className="flex-1 min-w-[3px] h-[2px] rounded-full bg-ink-hi/[0.08]" />
              )
            )}
          </div>
          <div className="flex gap-[3px] mt-1.5 h-4">
            {strip.bars.map((b, i) => {
              const label = labelAt(i);
              return (
                <span key={b.year} className="flex-1 min-w-[3px] relative">
                  {label && <span className="absolute left-1/2 -translate-x-1/2 text-[10.5px] font-semibold text-ink-ghost tabular-nums whitespace-nowrap">{label}</span>}
                </span>
              );
            })}
          </div>
        </section>
      )}

      <div className="page-bleed">
        <div ref={scroller} className="overflow-x-auto overflow-y-hidden pb-4" aria-label={T("Albums by year")} role="region">
          <div className="relative flex w-max gap-8" style={{ paddingInline: "var(--page-pad)" }}>
            <span
              aria-hidden
              className="absolute left-0 right-0 h-[2px] bg-gradient-to-r from-ink-hi/[0.04] via-ink-hi/[0.24] to-ink-hi/[0.04]"
              style={{ top: STACK_H + 12 }}
            />
            {columns.map((c) => {
              const stacks: LibAlbum[][] = [];
              for (let i = 0; i < c.albums.length; i += ROWS) stacks.push(c.albums.slice(i, i + ROWS));
              return (
                <div key={c.key} data-year-col={c.key} className="shrink-0 flex flex-col items-center">
                  <div className="flex items-end" style={{ height: STACK_H, gap: GAP }}>
                    {stacks.map((s, i) => (
                      <div key={i} className="flex flex-col-reverse" style={{ gap: GAP }}>
                        {s.map((a) => (
                          <TimelineAlbum key={a.key} album={a} />
                        ))}
                      </div>
                    ))}
                  </div>
                  <span className={`relative z-[1] mt-1.5 w-3.5 h-3.5 rounded-full border-[3px] border-surface ${c.year ? "bg-accent" : "bg-ink-hi/40"}`} />
                  {c.year ? (
                    <span className="mt-2 font-display text-[40px] font-black tracking-[-0.05em] leading-none text-ink-hi/[0.16] tabular-nums">{c.year}</span>
                  ) : (
                    <span className="mt-3 text-[18px] font-extrabold tracking-[-0.02em] leading-none text-ink-hi/[0.3]">{T("No year")}</span>
                  )}
                  <span className="mt-1.5 text-[11.5px] font-semibold text-ink-dim">{plural(c.albums.length, T("album"), T("albums"))}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
