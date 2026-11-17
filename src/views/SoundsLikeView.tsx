/**
 * Klingt wie: the songs that sound like one song (the one playing, or one picked), by tempo, key and
 * energy as the sound analysis measured them (lib/soundMatch.ts), after the mockup the user liked
 * (2026-11-15), with its many options cut to four plain ones and the rest under "Advanced":
 *
 *  - the song, its tempo, its key on the Camelot wheel and its energy;
 *  - same tempo / same key / both / same energy, how many fit, play them as a mix or keep them;
 *  - the songs that fit, the closest first;
 *  - what you play around it (the listening history, every device's with a sync service), and a mix
 *    for you made of that, of how it sounds and of a few forgotten favourites, in an order that flows;
 *  - mixes made from how songs sound (late night, run, focus, sunlit, in this key);
 *  - the library's genres sorted into families (lib/genres.ts).
 *
 * Only measured songs take part: local files once FFmpeg measured them, server songs from a short
 * stretch in the background (lib/serverSound.ts). Nothing here is estimated.
 */
import { useEffect, useMemo, useState } from "react";
import { AudioLines, ChevronDown, ListPlus, Pause, Pencil, Play, RotateCcw, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import type { SoundFacts } from "../../electron/sound-analysis";
import { Artwork, Btn, EmptyState, Pills } from "../components/primitives";
import { CamelotWheel } from "../components/CamelotWheel";
import { MediaAnalysis } from "../components/MediaAnalysis";
import { useLibraryGenres, useLibraryIndex } from "../lib/catalogIndex";
import { genresOfTrack } from "../lib/albumGenres";
import { flowOrder } from "../lib/flowOrder";
import { familyOf, GENRE_FAMILIES, type GenreFamily } from "../lib/genres";
import { plural } from "../lib/format";
import { T } from "../lib/i18n";
import { isServerSong, measureSoon } from "../lib/serverSound";
import { camelotLabel, camelotOf, DEFAULT_MATCH, keyLabel, keyOfCamelot, matchSong, mixRules, sameCamelot, songsInKey, type Camelot, type EnergyRule, type KeyRule, type MatchMode, type MatchOptions, type MatchResult, type MixRule } from "../lib/soundMatch";
import { useKeyEdits } from "../stores/keyEdits";
import { songKey, sameSong, useCatalog, versionsOf } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { skipsOf } from "../stores/skips";
import { soundOf, useSound } from "../stores/sound";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

const SHOWN = 50;
const MODES: readonly MatchMode[] = ["tempo", "key", "both", "energy"];
const MIX_MIN = 8;

interface Fit {
  track: Track;
  facts: SoundFacts;
  result: MatchResult;
}

function Fact({ value, label, children }: { value: string; label: string; children?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[34px] font-black tracking-[-0.03em] text-white leading-none tabular-nums">{value}</div>
      <div className="text-[11px] font-extrabold tracking-[0.16em] text-zinc-400 uppercase mt-1.5">{label}</div>
      {children}
    </div>
  );
}

/**
 * A song as the head of the page shows it: its cover, its name, and its tempo, key and energy. The song
 * itself stands there; the wheel turned to another key, one song of yours in that key takes its place,
 * shown the same way and with a play button, to hear the key by (the user's wish, 2026-11-17). Both are
 * laid out on top of each other (grid area 1/1), so the head keeps its height either way.
 */
function SongSpot({
  track,
  facts,
  eyebrow,
  line,
  keyNote,
  hidden,
  onPlay,
}: {
  track: Track;
  facts: SoundFacts | undefined;
  eyebrow: string;
  line: string;
  keyNote: string;
  hidden: boolean;
  onPlay?: () => void;
}) {
  return (
    // Narrow (a half-screen window with both panels), the text goes under the cover instead of beside it.
    <div
      className={`[grid-area:1/1] flex flex-wrap items-center gap-6 min-w-0 transition-opacity duration-300 ${hidden ? "opacity-0 pointer-events-none" : ""}`}
      aria-hidden={hidden}
      aria-live={onPlay ? "polite" : undefined}
    >
      <div className="relative shrink-0">
        <Artwork src={track.thumb} className="w-[150px] h-[150px] shadow-[0_30px_60px_-20px_rgba(0,0,0,0.9)]" rounded="rounded-2xl" alt="" />
        {onPlay && (
          <button
            onClick={onPlay}
            tabIndex={hidden ? -1 : 0}
            title={T("Play {title}", { title: track.title })}
            aria-label={T("Play {title}", { title: track.title })}
            className="absolute right-2.5 bottom-2.5 w-12 h-12 rounded-full bg-accent text-on-primary grid place-items-center shadow-[0_8px_20px_rgba(0,0,0,0.5)] hover:scale-105 active:scale-95 transition-transform"
          >
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </button>
        )}
      </div>
      <div className="min-w-[230px] flex-1">
        <div className="text-[12px] font-black tracking-[0.3em] text-accent uppercase truncate">{eyebrow}</div>
        <h1 className="text-[40px] font-black tracking-[-0.04em] text-white leading-[1.05] mt-1.5 break-words">{track.title}</h1>
        <div className="text-[14px] text-zinc-400 mt-1 truncate">{line}</div>
        {facts && (
          <div className="flex gap-9 mt-5 flex-wrap">
            <Fact value={facts.bpm ? String(Math.round(facts.bpm)) : "–"} label={T("BPM")} />
            <Fact value={keyLabel(facts.key, facts.minor) || "–"} label={keyNote} />
            <Fact value={`${Math.round(facts.energy * 100)}%`} label={T("Energy")}>
              <div className="h-1.5 w-24 rounded-full bg-white/[0.1] mt-2">
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.round(facts.energy * 100)}%` }} />
              </div>
            </Fact>
          </div>
        )}
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex items-center gap-3 text-left text-[13.5px] text-ink">
      <span className={`relative shrink-0 w-[38px] h-[22px] rounded-full transition-colors ${on ? "bg-accent" : "bg-ink-hi/[0.16]"}`}>
        <span className={`absolute top-[3px] w-4 h-4 rounded-full bg-white transition-all ${on ? "left-[19px]" : "left-[3px]"}`} />
      </span>
      {label}
    </button>
  );
}

export function SoundsLikeView({ id }: { id?: string }) {
  const facts = useSound((s) => s.facts);
  const { tracks } = useLibraryIndex();
  const genres = useLibraryGenres();
  const byId = useCatalog((s) => s.byId);
  const playCounts = useCatalog((s) => s.playCounts);
  const liked = useLibrary((s) => s.liked);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const playing = usePlayer((s) => s.playing);
  const navigate = useUI((s) => s.navigate);
  const toast = useUI((s) => s.toast);
  const [options, setOptions] = useState<MatchOptions>(DEFAULT_MATCH);
  /** the way of matching picked here; until then the one with something to show (see autoMode) */
  const [picked, setPicked] = useState<MatchMode | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [families, setFamilies] = useState<GenreFamily[]>([]);
  const [onlyLiked, setOnlyLiked] = useState(false);
  const [skipToday, setSkipToday] = useState(false);

  // The song as the library shows it (its album edits, the copy it prefers), whichever copy's id came.
  const shownById = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  // Opened for the song playing, the page keeps it once a song is played to hear another key by.
  const [pinned, setPinned] = useState<string | null>(null);
  const fixed = id ?? pinned;
  const seed = (fixed ? (shownById.get(songKey(fixed)) ?? byId.get(fixed)) : null) ?? current;
  // What you play around this song: its neighbours in your listening sessions (electron/listens.ts).
  const [together, setTogether] = useState<Track[]>([]);
  useEffect(() => {
    if (!seed) return;
    let alive = true;
    void window.bytune
      ?.listensTogether(versionsOf(seed).map((v) => v.id), 40)
      .then((scores) => {
        if (!alive) return;
        const seen = new Set<string>([songKey(seed.id)]);
        const songs: Track[] = [];
        // A play is noted under the copy that played; the list shows the song as the library does.
        const { tracks: shown, byId: copies } = useCatalog.getState();
        const shownOf = new Map(shown.map((t) => [t.id, t]));
        for (const { id: songId } of scores) {
          const t = shownOf.get(songKey(songId)) ?? copies.get(songId);
          if (!t || seen.has(songKey(t.id))) continue;
          seen.add(songKey(t.id));
          songs.push(t);
        }
        setTogether(songs);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [seed?.id]);
  const seedFacts = seed ? soundOf(seed, facts) : undefined;
  const seedKey = seedFacts ? camelotOf(seedFacts.key, seedFacts.minor) : null;
  // The wheel: another key picked on it aims the matches there; correcting, the next pick is the song's key.
  const [aim, setAim] = useState<Camelot | null>(null);
  const [correcting, setCorrecting] = useState(false);
  useEffect(() => {
    setAim(null);
    setCorrecting(false);
  }, [seed?.id]);
  const aimedFacts = useMemo(() => (seedFacts && aim ? { ...seedFacts, ...keyOfCamelot(aim) } : seedFacts), [seedFacts, aim]);
  // To hear a key by: songs of yours in the key pointed at on the wheel, else the one aimed at, else the song's own.
  const [pointedKey, setPointedKey] = useState<Camelot | null>(null);
  const hearKey = correcting ? null : (pointedKey ?? aim ?? seedKey);
  // Another key than the song's own: one song of yours in it (the one you play most) takes the song's
  // place at the left until the wheel comes back to the song's key.
  const hearingOther = !!hearKey && !!seedKey && !sameCamelot(hearKey, seedKey);
  const keyRef = useMemo(
    () => (hearKey ? (songsInKey(tracks, (t) => soundOf(t, facts), hearKey, (t) => playCounts[t.id]?.plays ?? 0, 1, (t) => !!seed && sameSong(t.id, seed.id))[0] ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hearKey?.n, hearKey?.ring, tracks, facts, playCounts, seed?.id]
  );
  /** measured songs per key, said when a key on the wheel is pointed at */
  const keyCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of tracks) {
      const f = soundOf(t, facts);
      const c = f && f.loudness > -70 ? camelotOf(f.key, f.minor) : null;
      if (c) out[camelotLabel(c)] = (out[camelotLabel(c)] ?? 0) + 1;
    }
    return out;
  }, [tracks, facts]);
  const analysisOn = useSettings((s) => s.soundAnalysis);
  const analysisStarted = useSettings((s) => s.soundAnalysisStarted);
  // A server song not measured yet goes first in the background measuring (lib/serverSound.ts).
  const seedMissing = !!seed && !seedFacts;
  // One that can't be measured (a file that can't be read, a stretch too short) says so.
  const skippedSongs = useSound((s) => s.skipped);
  const seedSkipped = seedMissing && !!seed && versionsOf(seed).some((v) => skippedSongs.has(v.id));
  useEffect(() => {
    if (seed && seedMissing) measureSoon(seed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id, seedMissing]);
  const measured = useMemo(() => tracks.filter((t) => soundOf(t, facts)).length, [tracks, facts]);

  // Every way of matching at once: the buttons say how many each finds, and the first look takes one that finds some.
  const byMode = useMemo((): Record<MatchMode, Fit[]> => {
    const none: Record<MatchMode, Fit[]> = { tempo: [], key: [], both: [], energy: [] };
    if (!seed || !aimedFacts) return none;
    const likedKeys = onlyLiked ? new Set(liked.map((t) => songKey(t.id))) : null;
    const dayStart = new Date().setHours(0, 0, 0, 0);
    const out = none;
    for (const t of tracks) {
      if (sameSong(t.id, seed.id)) continue;
      const f = soundOf(t, facts);
      if (!f) continue;
      if (likedKeys && !likedKeys.has(songKey(t.id))) continue;
      if (skipToday && (playCounts[t.id]?.lastAt ?? 0) >= dayStart) continue;
      if (families.length && !genresOfTrack(t).some((g) => families.includes(familyOf(g)))) continue;
      for (const mode of MODES) {
        const result = matchSong(aimedFacts, f, { ...options, mode });
        if (result) out[mode].push({ track: t, facts: f, result });
      }
    }
    // Songs skipped lately sink a little.
    const sinks = (fit: Fit): number => fit.result.score * (1 - Math.min(0.4, skipsOf(fit.track.id) * 0.1));
    for (const mode of MODES) out[mode].sort((a, b) => sinks(b) - sinks(a));
    return out;
  }, [seed, aimedFacts, tracks, facts, options, onlyLiked, liked, skipToday, playCounts, families]);
  // Both when they give enough, else the stricter of key and tempo that does, else energy.
  const autoMode: MatchMode = byMode.both.length >= 5 ? "both" : Math.max(byMode.key.length, byMode.tempo.length) >= 5 ? (byMode.key.length >= byMode.tempo.length ? "key" : "tempo") : byMode.energy.length ? "energy" : "both";
  const mode = picked ?? autoMode;
  const fits = byMode[mode];
  const shown = fits.slice(0, SHOWN);

  const mixes = useMemo(() => {
    const out: { rule: MixRule; name: string; line: string; pool: Track[]; covers: string[] }[] = [];
    for (const rule of mixRules(aimedFacts ?? null)) {
      const pool = tracks.filter((t) => {
        const f = soundOf(t, facts);
        return !!f && rule.fits(f);
      });
      if (pool.length < MIX_MIN) continue;
      const covers: string[] = [];
      const albums = new Set<string>();
      for (const t of pool) {
        if (!t.thumb || albums.has(t.album ?? t.id)) continue;
        albums.add(t.album ?? t.id);
        covers.push(t.thumb);
        if (covers.length === 4) break;
      }
      const name =
        rule.id === "late" ? T("Late night") : rule.id === "run" ? T("Run") : rule.id === "focus" ? T("Focus") : rule.id === "sunlit" ? T("Sunlit") : T("In {key}", { key: aimedFacts ? keyLabel(aimedFacts.key, aimedFacts.minor) : "" });
      const line =
        rule.id === "late"
          ? T("70–95 BPM · minor · calm")
          : rule.id === "run"
            ? T("150–175 BPM · lots of energy")
            : rule.id === "focus"
              ? T("steady 100–120 BPM · little energy")
              : rule.id === "sunlit"
                ? T("major · bright · lift")
                : T("{key} and its neighbours", { key: (aim ?? seedKey) ? camelotLabel((aim ?? seedKey) as Camelot) : "" });
      out.push({ rule, name, line, pool, covers });
    }
    return out;
  }, [tracks, facts, aimedFacts, aim, seedKey]);

  const familyCards = useMemo(() => {
    const byFamily = new Map<GenreFamily, { albums: Set<string>; genres: { name: string; route: string; size: number }[]; cover: string }>();
    for (const g of genres) {
      const family = familyOf(g.name);
      const card = byFamily.get(family) ?? { albums: new Set<string>(), genres: [], cover: "" };
      for (const t of g.tracks) card.albums.add(t.album ?? t.id);
      card.genres.push({ name: g.name, route: g.route, size: g.tracks.length });
      if (!card.cover) card.cover = g.tracks.find((t) => t.thumb)?.thumb ?? "";
      byFamily.set(family, card);
    }
    return GENRE_FAMILIES.filter((f) => byFamily.has(f))
      .map((family) => ({ family, ...(byFamily.get(family) as { albums: Set<string>; genres: { name: string; route: string; size: number }[]; cover: string }) }))
      .sort((a, b) => b.albums.size - a.albums.size);
  }, [genres]);

  const play = (list: Track[], start = 0): void => {
    if (!list.length) return;
    usePlayer.getState().playQueue(list, start);
  };
  /** who sings it, and whether it's the one playing */
  const lineOf = (t: Track): string => [t.artist, current && sameSong(current.id, t.id) ? (playing ? T("playing now") : T("paused")) : ""].filter(Boolean).join(" · ");
  /**
   * The fitting songs in an order that flows from the song itself (lib/flowOrder.ts): each next one
   * close in key, tempo and energy, an artist not twice in a row. The song itself leads, unless it's
   * the one playing: then the mix carries on from it.
   */
  const asMix = (): Track[] => {
    if (!seed) return [];
    const songs = [{ item: seed, facts: seedFacts, artist: seed.artist }, ...fits.slice(0, 100).map((f) => ({ item: f.track, facts: f.facts, artist: f.track.artist, skips: skipsOf(f.track.id) }))];
    const order = flowOrder(songs, { first: seed });
    return current && sameSong(current.id, seed.id) ? order.slice(1) : order;
  };
  /**
   * A mix for you: what you play around this song, the songs that sound like it, and a few forgotten
   * favourites of its genre family (played often, not for two months), in an order that flows from it.
   */
  const forYou = (): Track[] => {
    if (!seed) return [];
    const picked = new Map<string, Track>();
    const add = (t: Track): void => {
      const key = songKey(t.id);
      if (!picked.has(key) && !sameSong(t.id, seed.id)) picked.set(key, t);
    };
    together.slice(0, 15).forEach((t) => add(t));
    fits.slice(0, 20).forEach((fit) => add(fit.track));
    const families = new Set(genresOfTrack(seed).map((g) => familyOf(g)));
    const twoMonths = Date.now() - 60 * 86_400_000;
    tracks
      .filter((t) => (playCounts[t.id]?.plays ?? 0) >= 3 && (playCounts[t.id]?.lastAt ?? 0) < twoMonths && (!families.size || genresOfTrack(t).some((g) => families.has(familyOf(g)))))
      .sort(() => Math.random() - 0.5)
      .slice(0, 8)
      .forEach((t) => add(t));
    const songs = [{ item: seed, facts: seedFacts, artist: seed.artist }, ...[...picked.values()].map((t) => ({ item: t, facts: soundOf(t, facts), artist: t.artist, skips: skipsOf(t.id) }))];
    const order = flowOrder(songs, { first: seed });
    return current && sameSong(current.id, seed.id) ? order.slice(1) : order;
  };
  const keep = (): void => {
    if (!seed || !fits.length) return;
    const lib = useLibrary.getState();
    const p = lib.createPlaylist(T("Sounds like {title}", { title: seed.title }));
    lib.setPlaylistTracks(p.id, asMix().filter((t) => !sameSong(t.id, seed.id)));
    toast(T("Saved as “{name}”", { name: p.name }), "success", undefined, { label: T("Open"), run: () => navigate({ name: "playlist", param: p.id }) });
  };

  const modes: { key: MatchMode; label: string; count: number }[] = [
    { key: "tempo", label: T("Same tempo"), count: byMode.tempo.length },
    { key: "key", label: T("Same key"), count: byMode.key.length },
    { key: "both", label: T("Both"), count: byMode.both.length },
    { key: "energy", label: T("Same energy"), count: byMode.energy.length },
  ];
  const set = (patch: Partial<MatchOptions>): void => setOptions((o) => ({ ...o, ...patch }));

  /**
   * A key picked on the wheel: the matches aim there (the song's own key, or the one aimed at, picked
   * again, aims back). Correcting: it becomes the song's key, for all its copies; the measured key picked
   * gives it back to the measurement.
   */
  const pickKey = (c: Camelot): void => {
    if (!seed) return;
    if (!correcting) {
      setAim(sameCamelot(c, seedKey) || sameCamelot(c, aim) ? null : c);
      return;
    }
    const before = useKeyEdits.getState().keys;
    const measuredKey = seedFacts?.measuredKey ?? (seedFacts ? { key: seedFacts.key, minor: seedFacts.minor } : null);
    const chosen = keyOfCamelot(c);
    const isMeasured = !!measuredKey && measuredKey.key === chosen.key && measuredKey.minor === chosen.minor;
    useKeyEdits.getState().setKey(
      versionsOf(seed).map((v) => v.id),
      isMeasured ? null : chosen
    );
    setCorrecting(false);
    setAim(null);
    toast(T("The key is now {key}", { key: `${camelotLabel(c)} · ${keyLabel(chosen.key, chosen.minor)}` }), "success", 8000, {
      label: T("Undo"),
      run: () => useKeyEdits.setState({ keys: before }),
    });
  };
  const giveKeyBack = (): void => {
    if (seed) useKeyEdits.getState().setKey(versionsOf(seed).map((v) => v.id), null);
  };
  const measuredKey = seedFacts?.measuredKey ? camelotOf(seedFacts.measuredKey.key, seedFacts.measuredKey.minor) : null;
  const chip = "h-7 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink-dim hover:text-ink-hi hover:bg-ink-hi/[0.08] transition-colors";

  if (!seed) {
    return (
      <div className="pt-6">
        <div className="text-[13px] font-black tracking-[0.3em] text-accent">{T("SOUNDS LIKE")}</div>
        <EmptyState icon={AudioLines} title={T("Play a song first")} body={T("Klingt wie finds the songs in your library that sound like the one playing: by tempo, key and energy.")} />
      </div>
    );
  }

  return (
    <div className="pb-10">
      {/* The song, and what it sounds like. */}
      <section className="flex flex-wrap items-center gap-x-10 gap-y-6 pt-4">
        {/* The song, or (the wheel turned to another key) songs of yours to hear that key by, in the same
            place: both stay laid out on top of each other, so the header keeps its height either way. */}
        <div className="grid min-w-0 flex-1 basis-[420px]">
          <SongSpot
            track={seed}
            facts={seedFacts}
            eyebrow={T("SOUNDS LIKE")}
            line={lineOf(seed)}
            keyNote={seedKey ? (measuredKey ? T("Key · {camelot} · set by you", { camelot: camelotLabel(seedKey) }) : T("Key · {camelot} on the wheel", { camelot: camelotLabel(seedKey) })) : T("Key")}
            hidden={hearingOther}
          />
          {hearKey &&
            (keyRef ? (
              <SongSpot
                track={keyRef}
                facts={soundOf(keyRef, facts)}
                eyebrow={T("This is how {key} sounds", { key: `${camelotLabel(hearKey)} · ${keyLabel(keyOfCamelot(hearKey).key, keyOfCamelot(hearKey).minor)}` })}
                line={lineOf(keyRef)}
                keyNote={T("Key · {camelot} on the wheel", { camelot: camelotLabel(hearKey) })}
                hidden={!hearingOther}
                onPlay={() => {
                  if (!id) setPinned(seed.id);
                  play([keyRef]);
                }}
              />
            ) : (
              <div className={`[grid-area:1/1] flex flex-wrap items-center gap-6 min-w-0 transition-opacity duration-300 ${hearingOther ? "" : "opacity-0 pointer-events-none"}`} aria-hidden={!hearingOther} aria-live="polite">
                <div className="w-[150px] h-[150px] shrink-0 rounded-2xl bg-ink-hi/[0.06] grid place-items-center text-[44px] font-black tracking-[-0.03em] text-ink-hi/35">{camelotLabel(hearKey)}</div>
                <div className="min-w-[230px] flex-1">
                  <div className="text-[12px] font-black tracking-[0.3em] text-accent uppercase truncate">
                    {T("This is how {key} sounds", { key: `${camelotLabel(hearKey)} · ${keyLabel(keyOfCamelot(hearKey).key, keyOfCamelot(hearKey).minor)}` })}
                  </div>
                  <div className="mt-3 text-[15px] text-ink-hi/55">{T("No song of yours in {key} is measured yet", { key: camelotLabel(hearKey) })}</div>
                </div>
              </div>
            ))}
        </div>
        {seedFacts && (
          <div className="flex flex-col items-center gap-1.5 shrink-0">
            <CamelotWheel songKey={seedKey} aim={aim} onPick={pickKey} counts={keyCounts} correcting={correcting} onPoint={setPointedKey} size={232} />
            <div className="flex flex-wrap items-center justify-center gap-1 max-w-[300px] min-h-[28px]">
              {correcting ? (
                <button onClick={() => setCorrecting(false)} className={chip}>
                  <X className="w-3.5 h-3.5" />
                  {T("Cancel")}
                </button>
              ) : (
                <>
                  {aim && seedKey && (
                    <button onClick={() => setAim(null)} className={chip}>
                      <RotateCcw className="w-3.5 h-3.5" />
                      {T("Back to {key}", { key: camelotLabel(seedKey) })}
                    </button>
                  )}
                  <button onClick={() => setCorrecting(true)} className={chip} title={T("The analysis heard another key? Pick the right one on the wheel")}>
                    <Pencil className="w-3.5 h-3.5" />
                    {T("Correct the key")}
                  </button>
                  {measuredKey && (
                    <button onClick={giveKeyBack} className={chip} title={T("Give the key back to the measurement")}>
                      <RotateCcw className="w-3.5 h-3.5" />
                      {T("Measured: {key}", { key: camelotLabel(measuredKey) })}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>

      {!seedFacts && !analysisStarted ? (
        // Never started: the start is right here (the first run measures the whole library).
        <div className="mt-10 max-w-[720px]">
          <MediaAnalysis />
        </div>
      ) : !seedFacts ? (
        <div className="mt-10">
          <EmptyState
            icon={AudioLines}
            title={seedSkipped ? T("This song can't be measured") : T("This song isn't measured yet")}
            body={
              seedSkipped
                ? T("Its file can't be read, or the stretch your server makes of it is too short. It's tried again when the file changes, or in a month.")
                : !analysisOn
                  ? T("The media analysis is paused (Settings → Library). Let it go on to measure your songs.")
                  : seed && isServerSong(seed.id)
                    ? T("It's being measured now, from a short stretch your server makes. In a few seconds the matches show here.")
                    : T("The media analysis measures your songs in the background (Settings → Library). Try again in a little while, or pick another song.")
            }
          />
        </div>
      ) : (
        <>
          {/* Four plain ways to match; the rest under Advanced. */}
          <section className="mt-9 flex flex-wrap items-center gap-3">
            <Pills options={modes} value={mode} onChange={setPicked} />
            <span className="text-[13.5px] font-semibold text-zinc-400 ml-1">
              {fits.length === 1 ? T("1 fits") : T("{count} fit", { count: fits.length.toLocaleString() })}
              {aim && (mode === "key" || mode === "both") && options.keyRule !== "any"
                ? ` · ${options.keyRule === "same" ? T("in {key}", { key: camelotLabel(aim) }) : T("in {key} and next to it", { key: camelotLabel(aim) })}`
                : ""}
            </span>
            <div className="flex-1" />
            <Btn variant="white" size="sm" icon={Play} onClick={() => play(asMix())} disabled={!fits.length}>
              {T("Play as a mix")}
            </Btn>
            <Btn variant="glass" size="sm" icon={ListPlus} onClick={keep} disabled={!fits.length}>
              {T("Keep as playlist")}
            </Btn>
            <button
              onClick={() => setAdvanced((a) => !a)}
              aria-expanded={advanced}
              className={`h-8 px-3 rounded-full flex items-center gap-1.5 text-[13px] font-semibold transition-colors ${advanced ? "bg-ink-hi/[0.12] text-ink-hi" : "text-ink-dim hover:text-ink hover:bg-ink-hi/[0.06]"}`}
            >
              <SlidersHorizontal className="w-4 h-4" />
              {T("Advanced")}
              <ChevronDown className={`w-4 h-4 transition-transform ${advanced ? "rotate-180" : ""}`} />
            </button>
          </section>

          {advanced && (
            <section className="mt-4 rounded-2xl bg-ink-hi/[0.04] p-5 grid gap-x-10 gap-y-5" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
              <div>
                <div className="text-[13px] font-bold text-ink-hi mb-2">{T("Tempo window ± {bpm} BPM", { bpm: options.window })}</div>
                <input type="range" min={1} max={12} value={options.window} onChange={(e) => set({ window: Number(e.target.value) })} className="w-full accent-[rgb(var(--accent))]" aria-label={T("Tempo window")} />
                <div className="mt-3">
                  <Toggle on={options.halfAndDouble} onChange={(halfAndDouble) => set({ halfAndDouble })} label={T("Count half and double time")} />
                </div>
              </div>
              <div>
                <div className="text-[13px] font-bold text-ink-hi mb-2">{T("Key")}</div>
                <Pills<KeyRule>
                  wrap
                  size="sm"
                  options={[
                    { key: "same", label: T("The same only") },
                    { key: "near", label: T("Neighbours on the wheel") },
                    { key: "any", label: T("Any") },
                  ]}
                  value={options.keyRule}
                  onChange={(keyRule) => set({ keyRule })}
                />
                <div className="text-[13px] font-bold text-ink-hi mt-4 mb-2">{T("Energy")}</div>
                <Pills<EnergyRule>
                  wrap
                  size="sm"
                  options={[
                    { key: "any", label: T("Any") },
                    { key: "calmer", label: T("Calmer") },
                    { key: "similar", label: T("Similar") },
                    { key: "lift", label: T("More lift") },
                  ]}
                  value={options.energy}
                  onChange={(energy) => set({ energy })}
                />
              </div>
              <div>
                <div className="text-[13px] font-bold text-ink-hi mb-2">{T("Genre families")}</div>
                <div className="flex flex-wrap gap-1.5">
                  {familyCards.map(({ family }) => {
                    const on = families.includes(family);
                    return (
                      <button
                        key={family}
                        onClick={() => setFamilies((list) => (on ? list.filter((f) => f !== family) : [...list, family]))}
                        aria-pressed={on}
                        className={`h-7 px-3 rounded-full text-[12.5px] font-semibold transition-colors ${on ? "bg-accent text-[#0b0b0d]" : "bg-ink-hi/[0.06] text-ink-dim hover:text-ink hover:bg-ink-hi/[0.1]"}`}
                      >
                        {T(family)}
                      </button>
                    );
                  })}
                </div>
                <div className="mt-4 grid gap-2.5">
                  <Toggle on={onlyLiked} onChange={setOnlyLiked} label={T("Only Liked Songs")} />
                  <Toggle on={skipToday} onChange={setSkipToday} label={T("Leave out what played today")} />
                </div>
              </div>
            </section>
          )}

          {/* The songs that fit, the closest first. */}
          <section className="mt-6">
            {shown.length === 0 ? (
              <p className="text-[14px] text-zinc-400 py-8">{T("Nothing in your library fits this closely. Try another way to match, or a wider tempo window under Advanced.")}</p>
            ) : (
              <div className="rounded-2xl overflow-hidden">
                {shown.map((f, i) => {
                  const on = current && sameSong(current.id, f.track.id);
                  const camelot = camelotOf(f.facts.key, f.facts.minor);
                  return (
                    <div key={f.track.id} className={`group flex items-center gap-4 px-3 py-2 rounded-xl transition-colors hover:bg-ink-hi/[0.05] ${f.result.keyStep === 0 && f.result.score > 0.95 ? "bg-accent/[0.08]" : ""}`}>
                      <button
                        onClick={() => (on ? usePlayer.getState().toggle() : play(shown.map((x) => x.track), i))}
                        aria-label={on && playing ? T("Pause") : T("Play {title}", { title: f.track.title })}
                        className="relative w-11 h-11 shrink-0 rounded-md overflow-hidden"
                      >
                        <Artwork src={f.track.thumb} className="w-full h-full" rounded="rounded-md" alt="" />
                        <span className="absolute inset-0 grid place-items-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity">
                          {on && playing ? <Pause className="w-4 h-4 fill-white text-white" /> : <Play className="w-4 h-4 fill-white text-white" />}
                        </span>
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className={`text-[14.5px] font-bold truncate ${on ? "text-accent" : "text-white"}`}>{f.track.title}</div>
                        <div className="text-[12.5px] text-zinc-400 truncate">{f.track.artist}</div>
                      </div>
                      <div className="w-[96px] shrink-0 text-right tabular-nums">
                        <div className="text-[13.5px] font-bold text-white">{f.facts.bpm ? `${Math.round(f.facts.bpm)} BPM` : "–"}</div>
                        <div className="text-[11.5px] text-zinc-500">{f.result.tempoNote === "½" ? T("half time") : f.result.tempoNote === "2×" ? T("double time") : f.result.tempoNote}</div>
                      </div>
                      <div className="w-[52px] shrink-0 flex justify-center">
                        {camelot && (
                          <span
                            title={keyLabel(f.facts.key, f.facts.minor)}
                            className={`min-w-[40px] h-7 px-2 rounded-full grid place-items-center text-[12px] font-black ${f.result.keyStep === 0 ? "bg-accent text-[#0b0b0d]" : f.result.keyStep === 1 ? "ring-1 ring-inset ring-accent/70 text-white" : "ring-1 ring-inset ring-ink-hi/20 text-zinc-400"}`}
                          >
                            {camelotLabel(camelot)}
                          </span>
                        )}
                      </div>
                      <div className="w-[64px] shrink-0 hidden sm:block">
                        <div className="h-1.5 rounded-full bg-white/[0.08]">
                          <div className="h-1.5 rounded-full bg-white/50" style={{ width: `${Math.round(f.facts.energy * 100)}%` }} />
                        </div>
                      </div>
                      <div className="w-[48px] shrink-0 text-right text-[13.5px] font-black text-accent tabular-nums">{Math.round(f.result.score * 100)}%</div>
                      <button
                        onClick={() => navigate({ name: "soundslike", param: f.track.id })}
                        title={T("Sounds like this one")}
                        aria-label={T("Sounds like {title}", { title: f.track.title })}
                        className="w-8 h-8 shrink-0 rounded-full grid place-items-center text-zinc-500 hover:text-white hover:bg-ink-hi/[0.08] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                      >
                        <Search className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {/* What you play around this song, and a mix for you made of it. */}
      {together.length > 0 && (
        <section className="mt-12">
          <div className="flex flex-wrap items-end justify-between gap-4 mb-4">
            <div className="min-w-0">
              <h2 className="text-[26px] font-black tracking-[-0.03em] text-ink-hi">{T("Often played together")}</h2>
              <p className="text-[13.5px] text-zinc-400 mt-1">{T("What you play around this song, from your listening history.")}</p>
            </div>
            <Btn variant="white" size="sm" icon={Sparkles} onClick={() => play(forYou())}>
              {T("Mix for you")}
            </Btn>
          </div>
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {together.slice(0, 12).map((t, i, list) => (
              <button key={t.id} onClick={() => play(list, i)} title={T("Play {title}", { title: t.title })} className="flex items-center gap-3 p-2 pr-3 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] transition-colors text-left min-w-0">
                <Artwork src={t.thumb} className="w-12 h-12 shrink-0" rounded="rounded-lg" alt="" />
                <span className="min-w-0">
                  <span className="block text-[14px] font-bold text-white truncate">{t.title}</span>
                  <span className="block text-[12.5px] text-zinc-400 truncate">{t.artist}</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Mixes made from how songs sound. */}
      {mixes.length > 0 && (
        <section className="mt-12">
          <h2 className="text-[26px] font-black tracking-[-0.03em] text-ink-hi mb-4">{T("Made from how it sounds")}</h2>
          <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))" }}>
            {mixes.map((m) => (
              <button
                key={m.rule.id}
                onClick={() => {
                  // Sixty of them, drawn anew each time, in an order that rises and eases off.
                  const pick = [...m.pool].sort(() => Math.random() - 0.5).slice(0, 60);
                  play(flowOrder(pick.map((t) => ({ item: t, facts: soundOf(t, facts), artist: t.artist, skips: skipsOf(t.id) })), { arc: true }));
                }}
                title={T("Play {title}", { title: m.name })}
                className="group text-left"
              >
                <span className="relative block aspect-square rounded-2xl overflow-hidden bg-[#17171b] shadow-[0_24px_50px_-24px_rgba(0,0,0,0.9)]">
                  <span className="grid grid-cols-2 w-full h-full">
                    {[0, 1, 2, 3].map((i) => (
                      <Artwork key={i} src={m.covers[i] ?? m.covers[0] ?? ""} className="w-full h-full" rounded="rounded-none" alt="" />
                    ))}
                  </span>
                  <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
                  <span className="absolute left-4 right-4 bottom-3.5">
                    <span className="block text-[22px] font-black tracking-[-0.03em] text-white truncate">{m.name}</span>
                    <span className="block text-[12px] font-semibold text-white/75 truncate">{m.line}</span>
                  </span>
                  <span className="absolute right-3 top-3 w-10 h-10 rounded-full bg-accent text-[#0b0b0d] grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <Play className="w-4 h-4 fill-current" />
                  </span>
                </span>
                <span className="block text-[12.5px] text-zinc-400 mt-2">{T("{count} songs", { count: m.pool.length })}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* The library's genres, sorted into families. */}
      {familyCards.length > 0 && (
        <section className="mt-12">
          <h2 className="text-[26px] font-black tracking-[-0.03em] text-ink-hi">{T("Your genres, sorted")}</h2>
          <p className="text-[13.5px] text-zinc-400 mt-1.5 max-w-[720px]">
            {T("Tags that mean the same are one genre (“Hip Hop”, “Hip-Hop”, “HipHop”), “Singer/Songwriter” stays whole, and every genre belongs to one family. An album's songs share its genre where they carry none.")}
          </p>
          <div className="grid gap-4 mt-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
            {familyCards.map((card) => (
              <div key={card.family} className="relative rounded-2xl overflow-hidden bg-[#141418] p-4 min-h-[132px]">
                {card.cover && <img src={card.cover} alt="" aria-hidden className="absolute -right-6 -top-6 w-32 h-32 object-cover rounded-2xl opacity-30 blur-[2px] rotate-12" />}
                <div className="relative">
                  <div className="text-[20px] font-black tracking-[-0.02em] text-white">{T(card.family)}</div>
                  <div className="text-[12px] font-semibold text-zinc-400">{plural(card.albums.size, T("album"), T("albums"))}</div>
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {card.genres
                      .sort((a, b) => b.size - a.size)
                      .slice(0, 6)
                      .map((g) => (
                        <button key={g.route} onClick={() => navigate({ name: "genre", param: g.route })} className="h-6 px-2.5 rounded-full bg-ink-hi/[0.07] text-[12px] font-semibold text-ink hover:bg-ink-hi/[0.14] transition-colors">
                          {g.name}
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-[12.5px] text-zinc-500 mt-10">
        {T("Measured: {done} of {total} songs. Server songs are measured from a short stretch in the background.", { done: measured.toLocaleString(), total: tracks.length.toLocaleString() })}
      </p>
    </div>
  );
}
