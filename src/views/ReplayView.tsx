/**
 * Replay — the listening-statistics experience, fed exclusively by what
 * ByTune actually recorded (electron/stats.ts). No fake numbers: an empty
 * period says so. Below the numbers, the listening history: every listen,
 * kept on this computer only (electron/listens.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { Clock3, FileDown } from "lucide-react";
import type { Listen } from "../../electron/listens";
import { Artwork, Btn, EmptyState, ErrorState, Pills } from "../components/primitives";
import { plural } from "../lib/format";
import { ipcErrorText } from "../lib/ipcError";
import { useCatalog } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { resolveArtistAbout } from "../lib/artistAbout";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";
import { T } from "../lib/i18n";

interface Summary {
  totalMs: number;
  plays: number;
  tracks: { id: string; title: string; artist: string; thumb: string; ms: number; plays: number }[];
  artists: { name: string; thumb?: string; ms: number; plays: number }[];
  albums: { name: string; artist?: string; thumb?: string; ms: number; plays: number }[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: string;
  months: string[];
}

const PERIODS = [
  { key: "month", label: T("This month") },
  { key: "lastMonth", label: T("Last month") },
  { key: "year", label: T("This year") },
  { key: "all", label: T("All time") },
] as const;

function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} hrs`;
}

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Join key for an album row — the same shape the stats buckets use. */
const albumKey = (al: { name: string; artist?: string }): string =>
  `${al.name.toLowerCase()}|${(al.artist || "unknown artist").toLowerCase()}`;

export function ReplayView() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("month");
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});
  const playQueue = usePlayer((s) => s.playQueue);
  const toast = useUI((s) => s.toast);
  const { history, liked, playlists } = useLibrary();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        if (!cancelled) setData(res as Summary);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, nonce]);

  // Artist photos come from the identity cache; names it doesn't know yet
  // are resolved once and cached for the whole app.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.artists.slice(0, 10).map(async (a) => {
        if (a.thumb || artistThumbs[a.name]) return;
        // Artist photos from the open databases (Wikimedia Commons).
        const meta = await resolveArtistAbout(a.name);
        if (meta?.thumb && alive && !artistThumbs[a.name]) {
          setArtistThumbs((prev) => ({ ...prev, [a.name]: meta.thumb as string }));
        }
      })
    );
    return () => {
      alive = false;
    };
    // artistThumbs intentionally excluded: re-running on our own writes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Album covers for buckets recorded before Replay stored artwork: the
  // listener's own library already knows what those albums look like.
  //
  // Local-file covers (localart://) point at extracted art on THIS machine —
  // a data reset deletes that folder and a backup can never bring it back,
  // so such a reference is used only after the file is confirmed present.
  // Trusting it blindly left every restored local-music album rendering as a
  // permanently broken image.
  const albumCandidates = useMemo(() => {
    const web = new Map<string, string>();
    const local = new Map<string, string>();
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      if (!t.album || !t.thumb) continue;
      const key = albumKey({ name: t.album, artist: t.artist });
      if (/^(https?:\/\/|data:image\/|blob:)/i.test(t.thumb)) {
        if (!web.has(key)) web.set(key, t.thumb);
      } else if (t.thumb.startsWith("localart:") && !local.has(key)) {
        local.set(key, t.thumb);
      }
    }
    return { web, local };
  }, [history, liked, playlists]);

  const [presentCovers, setPresentCovers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.albums.slice(0, 5).map(async (al) => {
        const key = albumKey(al);
        if (al.thumb || albumCandidates.web.has(key) || presentCovers[key]) return;
        const candidate = albumCandidates.local.get(key);
        if (!candidate) return;
        try {
          const art = await window.bytune?.localArtBytes(candidate);
          if (alive && art?.data) setPresentCovers((prev) => ({ ...prev, [key]: candidate }));
        } catch {
          /* the extracted cover is gone — keep the placeholder */
        }
      })
    );
    return () => {
      alive = false;
    };
    // presentCovers is a cache this pass fills; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, albumCandidates]);

  const albumThumb = (al: Summary["albums"][number]): string => {
    const key = albumKey(al);
    return al.thumb || albumCandidates.web.get(key) || presentCovers[key] || "";
  };

  if (error) {
    return <ErrorState title={T("Replay didn't load")} body={T("Give it another try.")} onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;
  const maxDay = Math.max(1, ...(data?.days.map((d) => d.ms) ?? [1]));
  const recentDays = (data?.days ?? []).slice(-28);
  const maxHour = Math.max(1, ...(data?.hours.map((h) => h) ?? [1]));
  const topTracks: Track[] = (data?.tracks ?? []).slice(0, 20).map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    thumb: t.thumb,
    duration: 0,
  }));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
        <div>
          <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi">{T("Replay")}</h1>
          <p className="text-[13.5px] text-ink-dim mt-1">{T("Your listening, counted by Songsta — nothing estimated, kept on this computer.")}</p>
        </div>
        <Pills options={PERIODS.map((p) => ({ key: p.key, label: p.label }))} value={period} onChange={(k) => setPeriod(k as typeof period)} />
      </div>

      {loading && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
      )}

      {!loading && !hasData && (
        <EmptyState
          icon={Clock3}
          title={T("Nothing here yet")}
          body={T("Play something first — Replay fills in as Songsta counts what you actually listen to.")}
        />
      )}

      {!loading && hasData && data && (
        <>
          {/* Hero stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">{T("Listening time")}</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{fmtHours(data.totalMs)}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">{T("Plays")}</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{data.plays}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">{T("Top artist")}</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.artists[0]?.name ?? "—"}
              </div>
              {data.artists[0] && <div className="text-[12.5px] text-ink-dim mt-1">{fmtHours(data.artists[0].ms)}</div>}
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">{T("Top song")}</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.tracks[0]?.title ?? "—"}
              </div>
              {data.tracks[0] && <div className="text-[12.5px] text-ink-dim mt-1 truncate">{data.tracks[0].artist}</div>}
            </div>
          </div>

          {/* Listening activity */}
          {recentDays.length > 1 && (
            <section>
              <h2 className="section-title text-[21px] mb-4">{T("Listening activity")}</h2>
              <div className="glass-pill rounded-2xl p-5">
                <div className="flex items-end gap-1.5 h-28">
                  {recentDays.map((d) => (
                    <div
                      key={d.date}
                      title={`${fmtDate(d.date)} — ${fmtHours(d.ms)}`}
                      className="flex-1 rounded-t-md bg-accent/70 hover:bg-accent transition-colors min-h-[3px]"
                      style={{ height: `${Math.max(3, (d.ms / maxDay) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                  <span>{fmtDate(recentDays[0].date)}</span>
                  <span>{fmtDate(recentDays[recentDays.length - 1].date)}</span>
                </div>
              </div>
            </section>
          )}

          {/* Listening clock */}
          <section>
            <h2 className="section-title text-[21px] mb-4">{T("When you listen")}</h2>
            <div className="glass-pill rounded-2xl p-5">
              <div className="flex items-end gap-1 h-20">
                {data.hours.map((ms, h) => (
                  <div key={h} title={`${h}:00 — ${fmtHours(ms)}`} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-sm bg-ink-hi/25 hover:bg-ink-hi/50 transition-colors min-h-[2px]"
                      style={{ height: `${Math.max(2, (ms / maxHour) * 72)}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                <span>{T("12am")}</span>
                <span>{T("6am")}</span>
                <span>{T("12pm")}</span>
                <span>{T("6pm")}</span>
                <span>{T("11pm")}</span>
              </div>
            </div>
          </section>

          {/* Top tracks + artists */}
          <div className="grid lg:grid-cols-2 gap-8">
            <section>
              <h2 className="section-title text-[21px] mb-4">{T("Top songs")}</h2>
              <div className="glass-pill rounded-2xl p-2">
                {topTracks.slice(0, 10).map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      playQueue(topTracks, i);
                      toast(T("Playing {title}", { title: t.title }), "info");
                    }}
                    className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left"
                  >
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <Artwork src={t.thumb} className="w-11 h-11 rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-ink-hi truncate">{t.title}</span>
                      <span className="block text-[12.5px] text-ink-dim truncate">{t.artist}</span>
                    </span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">
                      {fmtHours(data.tracks.find((x) => x.id === t.id)?.ms ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h2 className="section-title text-[21px] mb-4">{T("Top artists")}</h2>
              <div className="glass-pill rounded-2xl p-4 space-y-3">
                {data.artists.slice(0, 10).map((a, i) => (
                  <div key={a.name} className="flex items-center gap-3">
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <Artwork
                      src={a.thumb || artistThumbs[a.name] || ""}
                      className="w-9 h-9 rounded-full shrink-0"
                      iconClassName="w-4 h-4"
                      alt=""
                    />
                    <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink-hi truncate">{a.name}</span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(a.ms)}</span>
                  </div>
                ))}
              </div>
              {data.albums.length > 0 && (
                <>
                  <h2 className="section-title text-[21px] mt-8 mb-4">{T("Top albums")}</h2>
                  <div className="glass-pill rounded-2xl p-4 space-y-3">
                    {data.albums.slice(0, 5).map((al, i) => (
                      <div key={`${al.name}-${i}`} className="flex items-center gap-3">
                        <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                        <Artwork
                          src={albumThumb(al)}
                          className="w-9 h-9 rounded-lg shrink-0"
                          iconClassName="w-4 h-4"
                          alt=""
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-semibold text-ink-hi truncate">{al.name}</span>
                          <span className="block text-[12.5px] text-ink-dim truncate">{al.artist}</span>
                        </span>
                        <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(al.ms)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}

      <ListeningHistory />
    </div>
  );
}

/** "Today", "Yesterday", else the weekday and date (the year only when it isn't this one). */
function dayTitle(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days === 0) return T("Today");
  if (days === 1) return T("Yesterday");
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

/**
 * Every listen, newest first and by day — scrobbling that never leaves this
 * computer (electron/listens.ts), a page at a time. A song still in the
 * library plays from its row; "Export…" saves the whole history as a
 * spreadsheet.
 */
function ListeningHistory() {
  const [listens, setListens] = useState<Listen[]>([]);
  const [more, setMore] = useState(false);
  const [total, setTotal] = useState(0);
  const byId = useCatalog((s) => s.byId);
  const toast = useUI((s) => s.toast);

  const load = (before?: number): void => {
    void window.bytune
      ?.listensPage(before, 100)
      .then((page) => {
        setListens((prev) => (before ? [...prev, ...page.listens] : page.listens));
        setMore(page.more);
        setTotal(page.total);
      })
      .catch(() => undefined);
  };
  useEffect(() => load(), []);

  const exportCsv = async (): Promise<void> => {
    try {
      const res = await window.bytune?.listensExport();
      if (res) toast(T("Saved {count} to {pop}", { count: plural(res.count, T("listen"), T("listens")), pop: res.path.split(/[\\/]/).pop() }), "success");
    } catch (err) {
      toast(ipcErrorText(err, T("Couldn't save the listening history")), "error");
    }
  };

  if (!listens.length) return null;
  const days: { title: string; items: Listen[] }[] = [];
  for (const l of listens) {
    const title = dayTitle(l.at);
    const last = days[days.length - 1];
    if (last?.title === title) last.items.push(l);
    else days.push({ title, items: [l] });
  }

  return (
    <section>
      <div className="flex items-end justify-between gap-4 mb-4">
        <div>
          <h2 className="section-title text-[21px]">{T("Listening history")}</h2>
          <p className="text-[13px] text-ink-dim mt-1">{T("{count} · kept on this computer only", { count: plural(total, T("listen"), T("listens")) })}</p>
        </div>
        <Btn variant="glass" size="sm" icon={FileDown} onClick={() => void exportCsv()}>{T("Export…")}</Btn>
      </div>
      <div className="glass-pill rounded-2xl p-2">
        {days.map((d) => (
          <div key={d.title}>
            <div className="px-3 pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">{d.title}</div>
            {d.items.map((l, i) => {
              const track = byId.get(l.id);
              return (
                <div
                  key={`${l.at}-${i}`}
                  onClick={track ? () => usePlayer.getState().playTrack(track) : undefined}
                  title={track ? T("Play {title}", { title: l.title }) : undefined}
                  className={`flex items-center gap-3 px-3 h-11 rounded-lg transition-colors hover:bg-ink-hi/[0.05] ${track ? "cursor-pointer" : ""}`}
                >
                  <span className="w-12 shrink-0 text-[12.5px] tabular-nums text-ink-faint">
                    {new Date(l.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink-hi">{l.title}</span>
                  <span className="w-[40%] min-w-0 truncate text-[13px] text-ink-dim">
                    {l.artist}
                    {l.album ? ` · ${l.album}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {more && (
          <button
            onClick={() => load(listens[listens.length - 1].at)}
            className="w-full h-10 mt-1 rounded-lg text-[13px] font-semibold text-ink-hi/70 hover:text-ink-hi hover:bg-ink-hi/[0.05] transition-colors"
          >{T("Show more")}</button>
        )}
      </div>
    </section>
  );
}
