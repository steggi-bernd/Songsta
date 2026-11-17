/**
 * The mixes built from the library (lib/mixes.ts) — the hook the home page
 * and Your Library share, and the gallery at the foot of Your Library: every
 * mix as a wide card in its own colour, two of its covers tilted on it, chips
 * to show only one kind (made for you, moods, genres, decades).
 */
import { useMemo, useState } from "react";
import { familyOf, type GenreFamily } from "../lib/genres";
import { useLibraryIndex } from "../lib/catalogIndex";
import { genresOfTrack, useAlbumGenres } from "../lib/albumGenres";
import { allMixes, inFlow, momentMix, type Mix } from "../lib/mixes";
import { useMomentScores } from "../lib/moments";
import { fmtMinutes, plural } from "../lib/format";
import { T } from "../lib/i18n";
import { energyOf, soundOf, useSound } from "../stores/sound";
import { skipsOf } from "../stores/skips";
import { songKey, useCatalog, useFreshPlayCounts } from "../stores/catalog";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import { playCollection, useCollectionPlayback } from "./LibraryCards";
import { PlayOverlay } from "./primitives";

/** Every mix of the library, the one for this time of day first. */
export function useLibraryMixes(): Mix[] {
  const { tracks } = useLibraryIndex();
  const playCounts = useCatalog((s) => s.playCounts);
  useFreshPlayCounts();
  const moment = useMomentScores();
  const sound = useSound((s) => s.facts);
  // The genre mixes hold their genre pages' songs: the albums' genres where they're known.
  const voted = useAlbumGenres((s) => s.voted);
  return useMemo(() => {
    const now = inFlow(momentMix(tracks, moment.scores, songKey, moment.at || Date.now()), (t) => soundOf(t, sound), (t) => skipsOf(t.id));
    const rest = allMixes(tracks, playCounts, { energyOf: (t) => energyOf(t, sound), sound: (t) => soundOf(t, sound), skips: (t) => skipsOf(t.id), genres: genresOfTrack });
    return now ? [now, ...rest] : rest;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracks, playCounts, moment.scores, moment.at, sound, voted]);
}

type MixKind = "you" | "mood" | "genre" | "decade";
const kindOf = (id: string): MixKind => (id.startsWith("mood:") ? "mood" : id.startsWith("genre:") ? "genre" : id.startsWith("decade:") ? "decade" : "you");

const FAMILY_HUE: Record<GenreFamily, number> = {
  Electronic: 172,
  Pop: 330,
  Rock: 142,
  "Hip-Hop": 44,
  "R&B & Soul": 300,
  "Folk & Country": 30,
  "Jazz & Blues": 18,
  Classical: 345,
  Soundtrack: 214,
  Metal: 2,
  World: 92,
  Other: 262,
};

/** A mix's own colour: its genre family's, a mood's, the hour's, else one drawn from its name. */
function hueOf(mix: Mix): number {
  if (mix.id === "onrepeat") return 266;
  if (mix.id === "rediscover") return 186;
  if (mix.id === "mood:calm") return 218;
  if (mix.id === "mood:upbeat") return 24;
  if (mix.id === "moment") {
    const h = new Date().getHours();
    return h < 5 || h >= 22 ? 238 : h >= 18 ? 318 : h >= 11 ? 200 : 40;
  }
  if (mix.id.startsWith("genre:")) return FAMILY_HUE[familyOf(mix.title.replace(/ Mix$/, ""))];
  let n = 0;
  for (const ch of mix.id) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

function MixCard({ mix }: { mix: Mix }) {
  const navigate = useUI((s) => s.navigate);
  const { active, playing } = useCollectionPlayback(mix.tracks);
  // Two covers of two different albums (an album's songs can each carry their own copy of its cover).
  const covers = useMemo(() => {
    const out: string[] = [];
    const albums = new Set<string>();
    for (const t of mix.tracks) {
      const album = (t.album || t.title).toLowerCase();
      if (!t.thumb || albums.has(album)) continue;
      albums.add(album);
      out.push(t.thumb);
      if (out.length === 2) break;
    }
    return out;
  }, [mix.tracks]);
  const hue = hueOf(mix);
  const seconds = mix.tracks.reduce((n, t) => n + (t.duration || 0), 0);
  const open = (): void => navigate({ name: "mix", param: mix.id });
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
      {...tintHoverHandlers(covers[0] ?? "")}
      className="group text-left cursor-pointer select-none min-w-0 rounded-2xl p-1.5 -m-1.5 transition-colors duration-200 hover:bg-ink-hi/[0.06]"
    >
      <div
        className="relative aspect-[5/2] rounded-xl overflow-hidden"
        style={{ background: `linear-gradient(140deg, hsl(${hue} 62% 46%), hsl(${hue} 58% 14%) 82%)` }}
      >
        {covers[1] && (
          <img
            src={covers[1]}
            alt=""
            className="absolute h-[70%] aspect-square object-cover rounded-md shadow-[0_12px_28px_rgba(0,0,0,0.45)] transition-transform duration-300 group-hover:-translate-y-1"
            style={{ right: "25%", top: "18%", rotate: "-8deg" }}
          />
        )}
        {covers[0] && (
          <img
            src={covers[0]}
            alt=""
            className="absolute h-[80%] aspect-square object-cover rounded-md shadow-[0_12px_28px_rgba(0,0,0,0.45)] transition-transform duration-300 group-hover:-translate-y-1.5"
            style={{ right: "6%", top: "12%", rotate: "7deg" }}
          />
        )}
        <span className="absolute left-4 right-[46%] bottom-3 text-[21px] font-black tracking-[-0.03em] leading-[1.18] pb-[0.08em] text-white [text-shadow:0_2px_12px_rgba(0,0,0,0.35)] line-clamp-2">
          {mix.title}
        </span>
        <PlayOverlay onClick={() => (active ? usePlayer.getState().toggle() : playCollection(mix.tracks))} playing={playing} />
      </div>
      <div className="mt-2 px-0.5 text-[13px] text-ink-dim truncate">
        {plural(mix.tracks.length, T("song"), T("songs"))}
        {seconds > 0 ? ` · ${fmtMinutes(seconds)}` : ""}
      </div>
    </div>
  );
}

/** Your Library's foot: all the mixes, filterable by kind. */
export function MixGallery() {
  const mixes = useLibraryMixes();
  const [kind, setKind] = useState<MixKind | "all">("all");
  const kinds: { key: MixKind | "all"; label: string; count: number }[] = [
    { key: "all", label: T("All"), count: mixes.length },
    { key: "you", label: T("For you"), count: mixes.filter((m) => kindOf(m.id) === "you").length },
    { key: "mood", label: T("Mood"), count: mixes.filter((m) => kindOf(m.id) === "mood").length },
    { key: "genre", label: T("Genre"), count: mixes.filter((m) => kindOf(m.id) === "genre").length },
    { key: "decade", label: T("Decade"), count: mixes.filter((m) => kindOf(m.id) === "decade").length },
  ];
  if (!mixes.length) return null;
  const shown = kind === "all" ? mixes : mixes.filter((m) => kindOf(m.id) === kind);
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-5">
        <div className="min-w-0">
          <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-accent mb-1.5">{T("Mixed for you · new every day")}</div>
          <h2 className="text-[30px] font-black tracking-[-0.03em] text-ink-hi leading-none">{T("Your mixes")}</h2>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {kinds
            .filter((k) => k.key === "all" || k.count > 0)
            .map((k) => (
              <button
                key={k.key}
                type="button"
                onClick={() => setKind(k.key)}
                aria-pressed={kind === k.key}
                className={`h-8 px-3.5 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors ${
                  kind === k.key ? "bg-primary text-on-primary" : "text-ink-dim bg-ink-hi/[0.045] hover:bg-ink-hi/[0.09] hover:text-ink"
                }`}
              >
                {k.label}
                <span className="ml-1.5 text-xs opacity-60">{k.count}</span>
              </button>
            ))}
        </div>
      </div>
      <div className="grid gap-x-[18px] gap-y-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))" }}>
        {shown.map((m) => (
          <MixCard key={m.id} mix={m} />
        ))}
      </div>
    </section>
  );
}
