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

  const periodName = period === "month" ? T("This month") : period === "lastMonth" ? T("Last month") : period === "year" ? String(new Date().getFullYear()) : T("All of it");
  const minutes = Math.round((data?.totalMs ?? 0) / 60000);
  const topAlbum = data?.albums[0];
  const topAlbumThumb = topAlbum ? albumThumb(topAlbum) : "";
  const flowCovers = (data?.albums ?? []).map(albumThumb).filter(Boolean).slice(0, 7);
  const pulse = pulseOf(data?.days ?? [], period === "year" || period === "all");
  const maxPulse = Math.max(1, ...pulse.map((p) => p.ms));
  const pulseCovers = flowCovers.length ? flowCovers : topTracks.map((t) => t.thumb).filter(Boolean);
  const faces = (data?.artists ?? []).slice(0, 5).map((a) => ({ ...a, photo: a.thumb || artistThumbs[a.name] || "" }));
  const play = (i: number): void => {
    playQueue(topTracks, i);
    toast(T("Playing {title}", { title: topTracks[i].title }), "info");
  };

  return (
    <div className="page-bleed -mt-5 pb-12 overflow-hidden">
      {/* The opening: the period, loud, over its top albums fanned out like a record shelf. */}
      <div className="relative overflow-hidden">
        {topAlbumThumb && <img src={topAlbumThumb} alt="" aria-hidden className="absolute -inset-20 w-[calc(100%+160px)] h-[calc(100%+160px)] object-cover blur-[110px] saturate-150 brightness-[0.32]" />}
        <div className="relative page-pad pt-12">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="text-[13px] font-black tracking-[0.3em] text-accent">{T("SONGSTA REPLAY")}</div>
            <Pills options={PERIODS.map((p) => ({ key: p.key, label: p.label }))} value={period} onChange={(k) => setPeriod(k as typeof period)} />
          </div>
          <h1 className="font-display font-black tracking-[-0.065em] leading-[0.88] text-ink-hi mt-3 text-[clamp(64px,11vw,170px)]">
            {hasData ? T("{period} was", { period: periodName }) : periodName}
            <br />
            <span className="italic text-accent">{hasData ? T("loud.") : T("still quiet.")}</span>
          </h1>
        </div>

        {loading && <div className="page-pad py-10"><div className="skeleton h-64 rounded-2xl" /></div>}

        {!loading && !hasData && (
          <div className="relative page-pad py-10">
            <EmptyState icon={Clock3} title={T("Nothing here yet")} body={T("Play something first — Replay fills in as Songsta counts what you actually listen to.")} />
          </div>
        )}

        {!loading && hasData && data && (
          <>
            {flowCovers.length >= 3 && (
              <div className="relative flex items-center justify-center h-[340px] mt-2" style={{ perspective: 1400 }}>
                {flowCovers.map((src, i) => {
                  const mid = (flowCovers.length - 1) / 2;
                  const off = i - mid;
                  const size = Math.round(330 - Math.abs(off) * 62);
                  return (
                    <img
                      key={`${src}-${i}`}
                      src={src}
                      alt=""
                      className="shrink-0 object-cover rounded-xl relative shadow-[0_50px_100px_-24px_rgba(0,0,0,0.95)]"
                      style={{ width: size, height: size, marginLeft: i === 0 ? 0 : -34, transform: `rotateY(${Math.round(-off * 19)}deg)`, zIndex: 10 - Math.round(Math.abs(off)), filter: `brightness(${1 - Math.abs(off) * 0.16})` }}
                    />
                  );
                })}
              </div>
            )}
            <div className="relative page-pad flex gap-x-14 gap-y-2 flex-wrap items-baseline pt-6 pb-10">
              <BigNumber value={minutes.toLocaleString()} label={T("MINUTES")} />
              <BigNumber value={data.plays.toLocaleString()} label={T("PLAYS")} />
              <BigNumber value={String(data.artists.length)} label={T("ARTISTS")} />
            </div>
          </>
        )}
      </div>

      {!loading && hasData && data && (
        <>
          {/* N°1: the album of the period, tilted over the page's edge, in its own colours. */}
          {topAlbum && (
            <div className="relative overflow-hidden min-h-[560px] flex items-center">
              {topAlbumThumb && <img src={topAlbumThumb} alt="" aria-hidden className="absolute -inset-20 w-[calc(100%+160px)] h-[calc(100%+160px)] object-cover blur-[80px] saturate-[1.7] brightness-50" />}
              {topAlbumThumb && (
                <img src={topAlbumThumb} alt="" className="absolute -left-[70px] top-1/2 w-[min(46vw,520px)] aspect-square object-cover rounded-2xl shadow-[0_60px_140px_-30px_rgba(0,0,0,0.95)]" style={{ transform: "translateY(-50%) rotate(-9deg)" }} />
              )}
              <div className="relative ml-[min(42vw,470px)] pr-8 py-16 min-w-0">
                <div className="font-black leading-[0.8] text-transparent text-[clamp(80px,12vw,190px)]" style={{ WebkitTextStroke: "3px rgba(255,255,255,0.4)" }}>N°1</div>
                <div className="font-display font-black tracking-[-0.06em] leading-[0.92] text-white mt-4 text-[clamp(44px,8vw,130px)] break-words">{topAlbum.name}</div>
                <div className="inline-block mt-5 px-4 py-2 bg-[#0b0b0d] text-white text-[clamp(14px,1.6vw,22px)] font-extrabold" style={{ transform: "rotate(2deg)" }}>
                  {[topAlbum.artist, fmtHours(topAlbum.ms)].filter(Boolean).join(" — ")}
                </div>
              </div>
            </div>
          )}

          {/* Five songs as a fan of cards. */}
          {topTracks.length > 0 && (
            <div className="page-pad pt-24 pb-28">
              <h2 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-ink-hi text-[clamp(48px,8vw,120px)]">
                {T("Five you")}
                <br />
                <span className="italic text-accent">{T("couldn't stop.")}</span>
              </h2>
              <div className="flex justify-center mt-16 pl-[60px]">
                {topTracks.slice(0, 5).map((t, i, all) => {
                  const off = i - (all.length - 1) / 2;
                  return (
                    <button
                      key={t.id}
                      onClick={() => play(i)}
                      title={T("Play {title}", { title: t.title })}
                      className="relative w-[250px] shrink-0 -ml-[60px] rounded-2xl overflow-hidden bg-[#17171b] text-left shadow-[0_40px_90px_-20px_rgba(0,0,0,0.95),inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-transform duration-200 hover:z-10 hover:!rotate-0 hover:!translate-y-[-14px]"
                      style={{ transform: `rotate(${off * 5}deg) translateY(${Math.round(Math.abs(off) * Math.abs(off) * 7)}px)` }}
                    >
                      <Artwork src={t.thumb} className="w-[250px] h-[250px]" iconClassName="w-10 h-10" alt="" />
                      <span className="absolute left-3 top-1 text-[110px] font-black tracking-[-0.06em] leading-none text-white drop-shadow-[0_6px_30px_rgba(0,0,0,0.8)]">{i + 1}</span>
                      <span className="block px-4 pt-3.5 pb-4">
                        <span className="block text-[21px] font-black tracking-[-0.02em] text-white truncate">{t.title}</span>
                        <span className="block text-[13px] text-zinc-400 truncate">{t.artist}</span>
                        <span className="block text-[13px] font-extrabold text-accent mt-2">{plural(data.tracks[i].plays, T("play"), T("plays"))}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* The pulse: the period as records on a wave, the bigger the more played. */}
          {pulse.length > 2 && (
            <div className="bg-[#101013] page-pad pt-14 pb-20">
              <h2 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-ink-hi text-[clamp(48px,8vw,120px)]">
                {T("It had a")} <span className="italic text-accent">{T("pulse.")}</span>
              </h2>
              <p className="text-[16px] text-ink-dim mt-3">{T("The bigger the record, the more played then.")}</p>
              <div className="relative h-[440px] mt-6">
                {pulse.map((p, i) => {
                  const share = p.ms / maxPulse;
                  const size = Math.round(50 + share * 150);
                  const top = Math.round(330 - share * 190 + Math.sin(i * 1.3) * 14);
                  const peak = p.ms === maxPulse;
                  const cover = pulseCovers.length ? pulseCovers[i % pulseCovers.length] : "";
                  return (
                    <div key={p.label + i} title={`${p.label} — ${fmtHours(p.ms)}`} className="absolute text-center" style={{ left: `${4 + (i * 92) / Math.max(1, pulse.length - 1)}%`, top, width: size, transform: "translate(-50%, -50%)" }}>
                      <div className={`rounded-full overflow-hidden shadow-[0_24px_60px_-10px_rgba(0,0,0,0.9)] ${peak ? "ring-[6px] ring-accent" : ""}`} style={{ width: size, height: size }}><Artwork src={cover} className="w-full h-full" rounded="rounded-full" iconClassName="w-5 h-5" alt="" /></div>
                      <div className={`text-[12px] font-black tracking-[0.14em] mt-2.5 uppercase whitespace-nowrap ${peak ? "text-accent" : "text-zinc-500"}`}>{p.label}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* The faces: the top artists as tilted, overlapping cards. */}
          {faces.length > 0 && (
            <div className="page-pad pt-24 pb-16">
              <h2 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-ink-hi text-right text-[clamp(48px,8vw,120px)]">
                {T("The faces")}
                <br />
                {T("of")} <span className="italic text-accent">{T("it all.")}</span>
              </h2>
              <div className="flex items-end justify-center mt-8">
                {faces.map((a, i) => {
                  const w = [360, 260, 220, 190, 160][i];
                  const turn = [-4, 5, -6, 7, -3][i];
                  const lift = [0, -30, 10, -44, 20][i];
                  return (
                    <div key={a.name} className="relative shrink-0" style={{ marginLeft: i === 0 ? 0 : -40, zIndex: 5 - i, transform: `rotate(${turn}deg) translateY(${lift}px)` }}>
                      <div className="rounded-2xl overflow-hidden shadow-[0_40px_100px_-20px_rgba(0,0,0,0.95)]" style={{ width: w, height: Math.round(w * 1.22) }}><Artwork src={a.photo} className="w-full h-full" rounded="rounded-2xl" iconClassName="w-10 h-10" alt="" /></div>
                      <div className={`absolute -left-3 px-3 py-1.5 font-black text-[#0b0b0d] whitespace-nowrap ${i === 0 ? "bg-accent text-[22px] bottom-6" : "bg-white text-[14px] bottom-4"}`}>
                        {i + 1} · {a.name}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* The ending: a ticket for the period. */}
          <div className="bg-[#101013] page-pad py-20 flex items-center gap-14 flex-wrap">
            <div className="flex-1 basis-[360px] min-w-0">
              <h2 className="font-display font-black tracking-[-0.06em] leading-[0.9] text-ink-hi text-[clamp(48px,8vw,120px)]">
                {T("Same seat")}
                <br />
                <span className="italic text-accent">{T("next time?")}</span>
              </h2>
            </div>
            <div className="flex shrink-0 rounded-2xl overflow-hidden shadow-[0_50px_120px_-30px_rgba(0,0,0,0.95)]" style={{ transform: "rotate(4deg)" }}>
              <Artwork src={topAlbumThumb} className="w-[230px] h-[300px]" iconClassName="w-10 h-10" alt="" />
              <div className="w-[300px] h-[300px] bg-[#f4f1ea] text-[#0b0b0d] px-6 py-5 flex flex-col border-l-[3px] border-dashed border-[#0b0b0d]">
                <div className="text-[11px] font-black tracking-[0.28em]">{T("ADMIT ONE · SONGSTA REPLAY")}</div>
                <div className="text-[60px] font-black tracking-[-0.06em] leading-none mt-2 truncate">{periodName}</div>
                <div className="text-[13px] font-bold leading-[1.7] mt-2">
                  <div>{T("{minutes} minutes · {plays} plays", { minutes: minutes.toLocaleString(), plays: data.plays.toLocaleString() })}</div>
                  {data.artists[0] && <div className="truncate">{T("Headliner: {name}", { name: data.artists[0].name })}</div>}
                  {topAlbum && <div className="truncate">{T("Album: {name}", { name: topAlbum.name })}</div>}
                </div>
                <div className="flex-1" />
                <div className="h-[34px]" style={{ background: "repeating-linear-gradient(90deg, #0b0b0d 0 3px, transparent 3px 6px, #0b0b0d 6px 7px, transparent 7px 12px)" }} />
              </div>
            </div>
          </div>
        </>
      )}

      <div className="page-pad pt-12">
        <ListeningHistory />
      </div>
    </div>
  );
}

function BigNumber({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <span className="text-[clamp(36px,5vw,64px)] font-black tracking-[-0.04em] text-white">{value}</span>{" "}
      <span className="text-[14px] font-extrabold tracking-[0.16em] text-zinc-400">{label}</span>
    </div>
  );
}

/** The days as up to twelve stretches for the pulse: months for a year or all time, else runs of days. */
function pulseOf(days: { date: string; ms: number }[], byMonth: boolean): { label: string; ms: number }[] {
  if (!days.length) return [];
  if (byMonth) {
    const months = new Map<string, number>();
    for (const d of days) months.set(d.date.slice(0, 7), (months.get(d.date.slice(0, 7)) ?? 0) + d.ms);
    return [...months.entries()].slice(-12).map(([month, ms]) => ({ label: new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, { month: "short" }), ms }));
  }
  const size = Math.max(1, Math.ceil(days.length / 12));
  const out: { label: string; ms: number }[] = [];
  for (let i = 0; i < days.length; i += size) {
    const run = days.slice(i, i + size);
    out.push({ label: fmtDate(run[0].date), ms: run.reduce((sum, d) => sum + d.ms, 0) });
  }
  return out;
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
