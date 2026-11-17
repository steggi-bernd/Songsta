/**
 * Replay's listening calendar (the user's pick, 2026-11-16): a year as days,
 * each a small square that's the brighter the longer you listened — weeks as
 * columns, Monday on top, like a wall calendar turned on its side. Beside it
 * what the year tells: the longest run of days with music, the busiest day,
 * the quietest month, how many days had any. A day pointed at shows its time;
 * a day clicked shows its songs, and plays the day back as it was.
 * The days come from Replay's counts (electron/stats.ts, every period), the
 * songs of a day from the listening history (electron/listens.ts).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import type { Listen } from "../../electron/listens";
import { plural } from "../lib/format";
import { T, textLocale } from "../lib/i18n";
import { useCatalog } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";
import { Artwork, Btn, Pills } from "./primitives";

interface Cell {
  iso: string;
  ms: number;
  inYear: boolean;
  future: boolean;
  date: Date;
}

const DAY_MS = 86_400_000;
const pad2 = (n: number): string => String(n).padStart(2, "0");
const isoOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function fmtSpan(ms: number): string {
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  return h ? T("{h} h {m} min", { h, m: minutes % 60 }) : T("{count} min", { count: minutes });
}

/** The year's weeks, Monday to Sunday, from the week holding 1 January to the one holding 31 December. */
function yearWeeks(year: number, byDate: Map<string, number>, now: Date): Cell[][] {
  const jan1 = new Date(year, 0, 1);
  const dec31 = new Date(year, 11, 31);
  const start = new Date(year, 0, 1 - ((jan1.getDay() + 6) % 7));
  const end = new Date(year, 11, 31 + (6 - ((dec31.getDay() + 6) % 7)));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weeks: Cell[][] = [];
  for (let d = new Date(start); d <= end; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (weeks.length === 0 || weeks[weeks.length - 1].length === 7) weeks.push([]);
    const iso = isoOf(d);
    weeks[weeks.length - 1].push({ iso, ms: byDate.get(iso) ?? 0, inYear: d.getFullYear() === year, future: d > today, date: new Date(d) });
  }
  return weeks;
}

export function ListeningCalendar({ days, width, height, head }: { days: { date: string; ms: number }[]; width: number; height: number; head: ReactNode }) {
  const now = useMemo(() => new Date(), []);
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d.ms])), [days]);
  const years = useMemo(() => [...new Set(days.filter((d) => d.ms > 0).map((d) => Number(d.date.slice(0, 4))))].sort((a, b) => a - b), [days]);
  const [year, setYear] = useState(() => now.getFullYear());
  const shownYear = years.includes(year) ? year : (years[years.length - 1] ?? now.getFullYear());
  const weeks = useMemo(() => yearWeeks(shownYear, byDate, now), [shownYear, byDate, now]);
  const [hover, setHover] = useState<Cell | null>(null);
  const [picked, setPicked] = useState<Cell | null>(null);

  // How bright a day is: by the quarters of the year's days with music, so one long day doesn't dim the rest.
  const levels = useMemo(() => {
    const lit = weeks.flat().filter((c) => c.inYear && c.ms >= 60000).map((c) => c.ms).sort((a, b) => a - b);
    const q = (p: number): number => lit[Math.min(lit.length - 1, Math.floor(p * lit.length))] ?? Infinity;
    return [q(0.25), q(0.5), q(0.75)];
  }, [weeks]);
  const levelOf = (ms: number): number => (ms < 60000 ? 0 : ms <= levels[0] ? 1 : ms <= levels[1] ? 2 : ms <= levels[2] ? 3 : 4);
  const SHADE = ["rgb(255 255 255 / 0.05)", "rgb(var(--accent) / 0.28)", "rgb(var(--accent) / 0.48)", "rgb(var(--accent) / 0.72)", "rgb(var(--accent))"];

  // What the year tells, up to today.
  const story = useMemo(() => {
    const cells = weeks.flat().filter((c) => c.inYear && !c.future);
    let run = 0;
    let runStart: Cell | null = null;
    let best = { length: 0, from: null as Cell | null, to: null as Cell | null };
    for (const c of cells) {
      if (c.ms >= 60000) {
        if (run === 0) runStart = c;
        run += 1;
        if (run > best.length) best = { length: run, from: runStart, to: c };
      } else run = 0;
    }
    const busiest = cells.reduce<Cell | null>((m, c) => (c.ms > (m?.ms ?? 0) ? c : m), null);
    const firstLit = cells.findIndex((c) => c.ms >= 60000);
    const months = new Map<number, number>();
    if (firstLit >= 0) for (const c of cells.slice(firstLit)) months.set(c.date.getMonth(), (months.get(c.date.getMonth()) ?? 0) + c.ms);
    // A month still running isn't over yet: the quietest is one of the finished ones, where there are any.
    const thisMonth = shownYear === now.getFullYear() ? now.getMonth() : 12;
    const finished = [...months.entries()].filter(([m]) => m < thisMonth);
    const quiet = (finished.length ? finished : [...months.entries()]).sort((a, b) => a[1] - b[1])[0];
    return {
      streak: best,
      busiest,
      quiet: quiet ? { month: new Date(shownYear, quiet[0], 1).toLocaleDateString(textLocale(), { month: "long" }), ms: quiet[1] } : null,
      lit: cells.filter((c) => c.ms >= 60000).length,
      total: cells.length,
    };
  }, [weeks, shownYear, now]);

  // The picked day's songs, from the listening history.
  const [daySongs, setDaySongs] = useState<Listen[] | null>(null);
  useEffect(() => {
    if (!picked) return;
    let alive = true;
    setDaySongs(null);
    const from = picked.date.getTime();
    void window.bytune
      ?.listensPage(from + DAY_MS, 500)
      .then((page) => {
        if (alive) setDaySongs(page.listens.filter((l) => l.at >= from).reverse());
      })
      .catch(() => alive && setDaySongs([]));
    return () => {
      alive = false;
    };
  }, [picked]);
  const byId = useCatalog((s) => s.byId);
  const dayTracks = (daySongs ?? []).map((l) => byId.get(l.id)).filter((t): t is Track => !!t);
  const dayCovers = [...new Set(dayTracks.map((t) => t.thumb).filter(Boolean))].slice(0, 4);
  const dayHours = (() => {
    if (!daySongs?.length) return null;
    const count = new Array(24).fill(0);
    for (const l of daySongs) count[new Date(l.at).getHours()] += 1;
    let at = 0;
    for (let h = 0; h < 24; h++) if (count[h] + count[(h + 1) % 24] > count[at] + count[(at + 1) % 24]) at = h;
    return { from: `${pad2(at)}:00`, to: `${pad2((at + 2) % 24)}:00` };
  })();

  // Sizes from the room there is: the squares as large as the width and the slide's height allow.
  const labelW = 28;
  const gap = 3;
  const cols = weeks.length;
  const byWidth = Math.floor((width - labelW - (cols - 1) * gap) / cols);
  const byHeight = Math.floor((height - 330) / 7 - gap);
  const cell = Math.max(6, Math.min(18, byWidth, byHeight));
  const gridW = labelW + cols * cell + (cols - 1) * gap;
  const wideStats = width >= 760;
  const dayTitle = (c: Cell): string => c.date.toLocaleDateString(textLocale(), { weekday: "long", day: "numeric", month: "long" });
  const short = (c: Cell): string => c.date.toLocaleDateString(textLocale(), { day: "numeric", month: "short" });
  const weekdayNames = [0, 2, 4, 6].map((i) => new Date(2024, 0, 1 + i).toLocaleDateString(textLocale(), { weekday: "short" }));

  const tile = (label: string, value: string, sub: string): ReactNode => (
    <div className="rounded-2xl bg-white/[0.05] px-4 py-3.5 min-w-0">
      <div className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-ink-dim">{label}</div>
      <div className="text-[24px] font-black tracking-[-0.03em] text-ink-hi leading-tight pb-[0.1em] mt-1 truncate">{value}</div>
      <div className="text-[12px] text-ink-dim truncate">{sub}</div>
    </div>
  );

  return (
    <div className="flex flex-col">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">{head}</div>
        {years.length > 1 && <Pills wrap options={years.map((y) => ({ key: String(y), label: String(y) }))} value={String(shownYear)} onChange={(k) => setYear(Number(k))} />}
      </div>

      <div className="mt-6 overflow-x-auto pb-1">
        <div style={{ width: gridW }}>
          {/* The months over the week where each begins. */}
          <div className="relative h-[18px]" style={{ marginLeft: labelW }}>
            {weeks.map((w, i) => {
              const first = w.find((c) => c.inYear && c.date.getDate() === 1);
              return first ? (
                <span key={i} className="absolute text-[11px] font-bold text-ink-faint whitespace-nowrap" style={{ left: i * (cell + gap) }}>
                  {first.date.toLocaleDateString(textLocale(), { month: "short" })}
                </span>
              ) : null;
            })}
          </div>
          <div className="flex" style={{ gap }}>
            <div className="flex flex-col shrink-0 text-[10px] font-bold text-ink-ghost" style={{ width: labelW - gap, gap }}>
              {Array.from({ length: 7 }, (_, r) => (
                <span key={r} style={{ height: cell, lineHeight: `${cell}px` }}>
                  {r % 2 === 0 && cell >= 9 ? weekdayNames[r / 2] : ""}
                </span>
              ))}
            </div>
            {weeks.map((w, i) => (
              <div key={i} className="flex flex-col" style={{ gap }}>
                {w.map((c) => (
                  <button
                    key={c.iso}
                    type="button"
                    disabled={!c.inYear || c.future}
                    onPointerEnter={() => setHover(c)}
                    onPointerLeave={() => setHover((h) => (h === c ? null : h))}
                    onClick={() => setPicked((p) => (p?.iso === c.iso ? null : c))}
                    title={c.inYear ? `${dayTitle(c)} · ${c.ms >= 60000 ? fmtSpan(c.ms) : T("No music that day")}` : undefined}
                    aria-label={c.inYear ? `${dayTitle(c)}: ${c.ms >= 60000 ? fmtSpan(c.ms) : T("No music that day")}` : undefined}
                    className={`rounded-[3px] transition-[outline-color,transform] ${c.inYear && !c.future ? "cursor-pointer hover:scale-125" : "cursor-default"} ${
                      picked?.iso === c.iso ? "outline outline-2 outline-white outline-offset-1" : ""
                    }`}
                    style={{ width: cell, height: cell, background: !c.inYear ? "transparent" : c.future ? "rgb(255 255 255 / 0.025)" : SHADE[levelOf(c.ms)] }}
                  />
                ))}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mt-2.5 text-[11.5px] text-ink-dim" style={{ marginLeft: labelW }}>
            <span className="truncate">{hover ? `${dayTitle(hover)} · ${hover.ms >= 60000 ? fmtSpan(hover.ms) : T("No music that day")}` : T("Point at a day, click it to see its songs.")}</span>
            <span className="flex items-center gap-1 shrink-0 ml-3">
              {T("Less")}
              {SHADE.map((s) => (
                <i key={s} className="block rounded-[3px]" style={{ width: 11, height: 11, background: s }} />
              ))}
              {T("More")}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-3" style={{ gridTemplateColumns: picked ? (wideStats ? "minmax(0,1.15fr) minmax(0,1fr)" : "1fr") : wideStats ? "repeat(4, minmax(0,1fr))" : "repeat(2, minmax(0,1fr))" }}>
        {picked ? (
          <>
            <div className="rounded-2xl bg-white/[0.07] px-4 py-3.5 min-w-0 flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-[16px] font-black tracking-[-0.02em] text-ink-hi truncate">{dayTitle(picked)}</div>
                <div className="text-[12.5px] text-ink-dim mt-0.5 truncate">
                  {picked.ms >= 60000 ? fmtSpan(picked.ms) : T("No music that day")}
                  {daySongs?.length ? ` · ${plural(daySongs.length, T("song"), T("songs"))}` : ""}
                  {dayHours ? ` · ${T("mostly between {from} and {to}", dayHours)}` : ""}
                </div>
                {daySongs === null ? (
                  <div className="text-[12px] text-ink-faint mt-2">{T("Loading the day…")}</div>
                ) : dayTracks.length > 0 ? (
                  <div className="mt-2.5">
                    <Btn variant="white" size="sm" icon={Play} onClick={() => {
                      usePlayer.getState().playQueue(dayTracks.slice(0, 200), 0);
                      useUI.getState().toast(T("Playing {title}", { title: dayTitle(picked) }), "info");
                    }}>{T("Play the day")}</Btn>
                  </div>
                ) : null}
              </div>
              {dayCovers.length > 0 && (
                <div className="flex -space-x-3 shrink-0">
                  {dayCovers.map((c, i) => (
                    <span key={c} className="relative block" style={{ zIndex: 4 - i }}>
                      <Artwork src={c} className="w-14 h-14 rounded-lg ring-2 ring-[#0d0d0f] shadow-lg" rounded="rounded-lg" iconClassName="w-4 h-4" alt="" />
                    </span>
                  ))}
                </div>
              )}
            </div>
            {wideStats && tile(T("Longest streak"), T("{count} days", { count: story.streak.length }), story.streak.from && story.streak.to ? T("{from} to {to}", { from: short(story.streak.from), to: short(story.streak.to) }) : "")}
          </>
        ) : (
          <>
            {tile(T("Longest streak"), T("{count} days", { count: story.streak.length }), story.streak.from && story.streak.to ? T("{from} to {to}", { from: short(story.streak.from), to: short(story.streak.to) }) : "")}
            {tile(T("Busiest day"), story.busiest && story.busiest.ms > 0 ? short(story.busiest) : "—", story.busiest && story.busiest.ms > 0 ? fmtSpan(story.busiest.ms) : "")}
            {tile(T("Quietest month"), story.quiet?.month ?? "—", story.quiet ? fmtSpan(story.quiet.ms) : "")}
            {tile(T("Days with music"), String(story.lit), T("of {total} so far", { total: story.total }))}
          </>
        )}
      </div>
    </div>
  );
}
