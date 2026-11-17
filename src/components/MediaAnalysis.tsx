/**
 * The media analysis (electron/sound-library.ts measures the local songs, lib/serverSound.ts the
 * server's): tempo, key and energy of every song, for Klingt wie, mixes that flow and the smooth
 * transitions. Off until it's started by hand once (the user's wish): the first run takes the whole
 * library at full speed; after that new songs follow by themselves while it's on. Here: how many wait,
 * how long that takes, how far it got, and start, pause and go on. In Settings → Library, in Klingt wie
 * and on the first start's pages.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, ChevronDown, Pause, Play, RotateCcw } from "lucide-react";
import type { SoundStatus } from "../../electron/sound-library";
import { fmtDuration } from "../lib/format";
import { T, textLocale } from "../lib/i18n";
import { retryServerSongs } from "../lib/serverSound";
import { songKey, useCatalog } from "../stores/catalog";
import { useSettings } from "../stores/settings";
import { soundCounts, useSound, type SkipReason } from "../stores/sound";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

const REASON: Record<SkipReason, string> = {
  unreadable: "Can't be read",
  refused: "The server can't make a stretch of it",
  short: "Too short to measure",
};

/**
 * The songs that can't be measured, and why: shown on asking, each leading to its album; "Try again"
 * tries them all once more (electron/sound-library.ts retrySkipped, lib/serverSound.ts).
 */
function Unmeasurable({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const skipped = useSound((s) => s.skipped);
  const reasons = useSound((s) => s.skipReasons);
  const shownTracks = useCatalog((s) => s.tracks);
  const copies = useCatalog((s) => s.byId);
  const list = useMemo(() => {
    if (!open) return [];
    const shown = new Map(shownTracks.map((t) => [t.id, t]));
    const out: { id: string; track: Track; reason: SkipReason }[] = [];
    for (const id of skipped) {
      const track = shown.get(songKey(id)) ?? copies.get(id);
      if (track) out.push({ id, track, reason: reasons[id] ?? "unreadable" });
    }
    return out.sort((a, b) => a.track.artist.localeCompare(b.track.artist) || a.track.title.localeCompare(b.track.title)).slice(0, 500);
  }, [open, skipped, reasons, shownTracks, copies]);
  const tryAgain = async (): Promise<void> => {
    await window.bytune?.soundRetry().catch(() => 0);
    retryServerSongs();
    setOpen(false);
    useUI.getState().toast(T("Trying them again"), "info");
  };
  const small = "inline-flex h-7 items-center gap-1.5 rounded-full bg-ink-hi/[0.08] px-3 text-[12px] font-semibold text-ink-hi transition-colors hover:bg-ink-hi/[0.14]";
  return (
    <div className="mt-1.5">
      <div className="text-[12px] text-ink-dim">
        {count === 1
          ? T("One song can't be measured: a file that can't be read, or a stretch too short. Tried again when the file changes, or in a month.")
          : T("{count} songs can't be measured: files that can't be read, or stretches too short. Tried again when a file changes, or in a month.", { count: count.toLocaleString(textLocale()) })}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className={small}>
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
          {open ? T("Hide them") : T("Show them")}
        </button>
        <button onClick={() => void tryAgain()} className={small}>
          <RotateCcw className="h-3.5 w-3.5" />
          {T("Try again")}
        </button>
      </div>
      {open && (
        <div className="mt-2 max-h-[280px] overflow-y-auto rounded-xl bg-ink-hi/[0.04]">
          {list.map(({ id, track, reason }) => (
            <button
              key={id}
              onClick={() => track.albumId && useUI.getState().navigate({ name: "album", param: track.albumId })}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink-hi truncate">{track.title}</span>
                <span className="block text-[11.5px] text-ink-dim truncate">{[track.artist, track.album].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="text-[11.5px] text-ink-dim text-right shrink-0 max-w-[45%] [overflow-wrap:anywhere]">
                {T(REASON[reason])} · {id.startsWith("local:") ? T("your folders") : T("your server")}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Before anything was measured here: about this long a song, two at a time (a guess the progress soon replaces). */
const GUESS_LOCAL_S = 0.7;
const GUESS_SERVER_S = 1.1;

export interface AnalysisState {
  started: boolean;
  on: boolean;
  done: number;
  total: number;
  local: { done: number; skipped: number; total: number };
  server: { done: number; skipped: number; total: number };
  /** looked at and can't be measured (counted in `done`) */
  skipped: number;
  /** seconds still to go, guessed from the pace so far (or before it started) */
  left: number;
  ffmpeg: boolean;
}

/** The analysis' state, its pace measured while the page shows it. */
export function useAnalysis(): AnalysisState {
  const started = useSettings((s) => s.soundAnalysisStarted);
  const on = useSettings((s) => s.soundAnalysis);
  const tracks = useCatalog((s) => s.tracks);
  const facts = useSound((s) => s.facts);
  const skippedSongs = useSound((s) => s.skipped);
  const counts = useMemo(() => soundCounts(tracks, facts, skippedSongs), [tracks, facts, skippedSongs]);
  const [status, setStatus] = useState<SoundStatus | null>(null);
  const pace = useRef<{ at: number; done: number }[]>([]);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      // The local pass' word reaches the facts by itself (stores/sound.ts); this is for FFmpeg and the pace.
      void window.bytune
        ?.soundStatus()
        .then((st) => live && setStatus(st))
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 4000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  const done = counts.local.done + counts.server.done;
  const total = counts.local.total + counts.server.total;
  // The pace over the last two minutes.
  const now = Date.now();
  const samples = pace.current;
  if (!samples.length || samples[samples.length - 1].done !== done) samples.push({ at: now, done });
  while (samples.length > 2 && now - samples[0].at > 120_000) samples.shift();
  const first = samples[0];
  const rate = samples.length > 1 && now - first.at > 8000 ? (done - first.done) / ((now - first.at) / 1000) : 0;
  const waitingLocal = counts.local.total - counts.local.done;
  const waitingServer = counts.server.total - counts.server.done;
  const left = rate > 0 ? (total - done) / rate : waitingLocal * GUESS_LOCAL_S + waitingServer * GUESS_SERVER_S;
  return { started, on, done, total, local: counts.local, server: counts.server, skipped: counts.local.skipped + counts.server.skipped, left, ffmpeg: status?.ffmpeg ?? true };
}

/**
 * The analysis as a card: what it is, how far, and its buttons. `quiet` leaves out the explanation
 * (Klingt wie says its own); `bare` leaves out the card's own panel (inside a settings group).
 */
export function MediaAnalysis({ quiet, bare }: { quiet?: boolean; bare?: boolean }) {
  const a = useAnalysis();
  const settings = useSettings();
  const n = (v: number): string => v.toLocaleString(textLocale());
  const finished = a.started && a.total > 0 && a.done >= a.total;
  const share = a.total ? Math.min(1, a.done / a.total) : 0;
  // Measured, apart from the songs that can't be (said on a line of their own).
  const parts = [
    a.local.total ? T("Your folders: {done} of {total}", { done: n(a.local.done - a.local.skipped), total: n(a.local.total) }) : "",
    a.server.total ? T("Your server: {done} of {total}", { done: n(a.server.done - a.server.skipped), total: n(a.server.total) }) : "",
  ].filter(Boolean);
  const measured = a.done - a.skipped;

  let line: string;
  if (!a.total) line = T("Nothing to measure yet: add music first.");
  else if (!a.started && a.done >= a.total) line = T("All {count} songs are measured already. Start it to measure new songs as they come.", { count: n(a.total) });
  else if (!a.started) line = T("{count} songs, about {time} the first time. After that, only new songs are measured.", { count: n(a.total - a.done), time: fmtDuration(a.left) });
  else if (finished && a.skipped) line = a.on ? T("Done: {done} of {total} songs measured. New ones follow by themselves.", { done: n(measured), total: n(a.total) }) : T("Done: {done} of {total} songs measured. New ones wait until you switch this on.", { done: n(measured), total: n(a.total) });
  else if (finished) line = a.on ? T("All {count} songs measured. New ones follow by themselves.", { count: n(a.total) }) : T("All {count} songs measured. New ones wait until you switch this on.", { count: n(a.total) });
  else if (!a.on) line = T("Paused · {done} of {total} songs measured", { done: n(a.done), total: n(a.total) });
  else line = T("{done} of {total} songs measured · {time} to go", { done: n(a.done), total: n(a.total), time: fmtDuration(a.left) });

  return (
    <div className={bare ? "p-4" : "rounded-[calc(14px*var(--radius-scale))] bg-panel p-4"} data-search={`${T("Media analysis")} ${T("Sound analysis")} ${line}`.toLowerCase()}>
      <div className="flex items-start gap-[14px]">
        <AudioLines className="w-[22px] h-[22px] shrink-0 text-ink-hi mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] text-ink-hi">{T("Media analysis")}</div>
          {!quiet && <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">{T("Tempo, key and energy of every song, measured once on this computer: for Klingt wie, mixes that flow and smooth transitions. Server songs are measured from a short stretch your server makes.")}</div>}
          <div className="text-[13px] text-ink-hi/90 mt-2 leading-snug" aria-live="polite">{line}</div>
          {a.started && !finished && a.total > 0 && (
            <div className="mt-3 h-1.5 rounded-full bg-ink-hi/[0.1] overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={a.total} aria-valuenow={a.done}>
              <div className={`h-full rounded-full ${a.on ? "bg-accent" : "bg-ink-hi/40"} transition-[width] duration-700`} style={{ width: `${Math.round(share * 1000) / 10}%` }} />
            </div>
          )}
          {parts.length > 0 && a.started && <div className="text-[12px] text-ink-dim mt-2">{parts.join(" · ")}</div>}
          {a.skipped > 0 && a.started && <Unmeasurable count={a.skipped} />}
          {!a.ffmpeg && a.local.total > a.local.done && <div className="text-[12px] text-ink-dim mt-1">{T("Your folders' songs need FFmpeg (Settings → Library).")}</div>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!a.started && a.total > 0 && (
              <button onClick={settings.startSoundAnalysis} className="inline-flex h-9 items-center gap-2 rounded-full bg-primary px-4 text-[13px] font-bold text-on-primary transition hover:brightness-110">
                <Play className="h-4 w-4" />
                {T("Start the analysis")}
              </button>
            )}
            {a.started && !finished && (
              <button
                onClick={() => settings.setSoundAnalysis(!a.on)}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-ink-hi/[0.1] px-4 text-[13px] font-semibold text-ink-hi transition-colors hover:bg-ink-hi/[0.16]"
              >
                {a.on ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {a.on ? T("Pause") : T("Go on")}
              </button>
            )}
            {finished && (
              <label className="inline-flex items-center gap-2 text-[13px] text-ink-hi cursor-pointer">
                <input type="checkbox" className="accent-[rgb(var(--accent))] h-4 w-4" checked={a.on} onChange={(e) => settings.setSoundAnalysis(e.target.checked)} />
                {T("Measure new songs by themselves")}
              </label>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
