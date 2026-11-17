/**
 * The full-screen player's party look (the user's pick, 2026-11-16): the cover
 * as a round record in the middle, a ring of rays round it, in the cover's
 * colours; title and artist under it, a small transport at the foot.
 *
 * It listens to the music (the user's wish, 2026-11-17, "like the visualizers
 * on YouTube"): an analyser on the audio graph (lib/audio.ts visualizerTap)
 * gives each ray a band of the spectrum, bass at the foot of the ring and the
 * highs at its top, mirrored left and right; the bass makes the record and the
 * glow swell, the loudness turns the dashed ring faster, the highs light the
 * outer one. Where there's nothing to hear (another device plays, or nothing
 * comes through) the rays pulse in the song's tempo as before. Still with
 * "Reduce animation". The classic look is a switch away.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { Track } from "../types";
import type { ArtworkPalette } from "../lib/palette";
import { upgradeArtwork } from "../lib/artwork";
import { visualizerTap } from "../lib/audio";
import { fmtTime } from "../lib/format";
import { soundOf, useSound } from "../stores/sound";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { T } from "../lib/i18n";

const RAYS = 104;
const HALF = RAYS / 2;

/** The ray's band: bass at the foot of the ring (180°), the highs at its top, the same on both sides. */
const bandOfRay = (i: number): number => Math.min(HALF - 1, HALF - Math.min(i, RAYS - i));

/**
 * The music driving the stage, frame by frame, straight on the elements (104 rays at 60 frames a second
 * don't go through React). Returns whether it's on: off when there's nothing to hear, so the rays pulse
 * in the tempo instead.
 */
function useLiveSpectrum(stage: React.RefObject<HTMLDivElement | null>, playing: boolean, trackId: string): boolean {
  const reduce = useSettings((s) => s.reduceAnimation);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const systemReduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = stage.current;
    if (!playing || reduce || systemReduce || !root) return;
    const analyser = visualizerTap();
    if (!analyser) return;
    const rays = Array.from(root.querySelectorAll<HTMLElement>(".viz-ray"));
    const rest = rays.map((r) => Number(r.parentElement?.style.getPropertyValue("--lo")) || 0.2);
    const cover = root.querySelector<HTMLElement>(".viz-cover");
    const glow = root.querySelector<HTMLElement>(".viz-glow");
    const dashed = root.querySelector<HTMLElement>(".viz-ring-dashed");
    const outer = root.querySelector<HTMLElement>(".viz-ring-outer");
    const bins = new Uint8Array(analyser.frequencyBinCount);
    const nyquist = analyser.context.sampleRate / 2;
    const binOf = (hz: number): number => Math.max(1, Math.min(bins.length - 1, Math.round((hz / nyquist) * bins.length)));
    // Bands spaced as we hear, 40 Hz to 14 kHz.
    const edges = Array.from({ length: HALF + 1 }, (_, i) => binOf(40 * Math.pow(14000 / 40, i / HALF)));
    const bass = [binOf(35), binOf(140)];
    const highs = [binOf(4000), binOf(14000)];
    const level = new Float32Array(HALF);
    let ceiling = 0.35;
    let bassLevel = 0;
    let loud = 0;
    let bright = 0;
    let spin = 0;
    let quiet = 0;
    let last = performance.now();
    let frame = 0;
    let on = false;
    const mean = (from: number, to: number): number => {
      let sum = 0;
      for (let j = from; j <= to; j++) sum += bins[j];
      return sum / (255 * Math.max(1, to - from + 1));
    };
    const tick = (now: number): void => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      analyser.getByteFrequencyData(bins);
      let total = 0;
      for (let b = 0; b < HALF; b++) {
        let peak = 0;
        for (let j = edges[b]; j < Math.max(edges[b] + 1, edges[b + 1]); j++) peak = Math.max(peak, bins[j]);
        // The highs carry less energy than the bass: tilted up a little so the top of the ring moves too.
        const x = (peak / 255) * (0.86 + 0.42 * (b / HALF));
        // Up at once, down slowly, as a meter falls.
        level[b] = x > level[b] ? level[b] + (x - level[b]) * 0.65 : level[b] - (level[b] - x) * Math.min(1, dt * 7);
        total += level[b];
      }
      const average = total / HALF;
      // Silence for a while (another device plays, or the stream is closed to it): back to the tempo.
      quiet = average < 0.012 ? quiet + dt : 0;
      if (quiet > 1.2) {
        if (on) {
          on = false;
          setLive(false);
        }
      } else if (!on && average >= 0.012) {
        on = true;
        setLive(true);
      }
      if (on) {
        // A ceiling that follows the song, so quiet and loud songs both fill the ring.
        ceiling = Math.max(0.22, average * 1.9, ceiling - dt * 0.08);
        for (let i = 0; i < RAYS; i++) {
          const v = Math.min(1, level[bandOfRay(i)] / ceiling);
          rays[i].style.transform = `scaleY(${(rest[i] + (1 - rest[i]) * v).toFixed(3)})`;
        }
        const b = mean(bass[0], bass[1]);
        bassLevel = b > bassLevel ? bassLevel + (b - bassLevel) * 0.55 : bassLevel - (bassLevel - b) * Math.min(1, dt * 6);
        loud += (Math.min(1, average / ceiling) - loud) * Math.min(1, dt * 5);
        bright += (mean(highs[0], highs[1]) * 2.2 - bright) * Math.min(1, dt * 6);
        spin = (spin + dt * (4 + 70 * loud * loud)) % 360;
        const swell = Math.max(0, (bassLevel - 0.35) / 0.65);
        if (cover) cover.style.scale = (1 + 0.075 * swell).toFixed(4);
        if (glow) {
          glow.style.opacity = (0.35 + 0.65 * loud).toFixed(3);
          glow.style.scale = (0.94 + 0.2 * swell).toFixed(4);
        }
        if (dashed) {
          dashed.style.rotate = `${spin.toFixed(2)}deg`;
          dashed.style.scale = (1 + 0.035 * loud).toFixed(4);
          dashed.style.borderColor = `rgb(255 255 255 / ${(0.06 + 0.22 * loud).toFixed(3)})`;
        }
        if (outer) outer.style.borderColor = `rgb(255 255 255 / ${(0.04 + 0.3 * Math.min(1, bright)).toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      for (const r of rays) r.style.transform = "";
      for (const el of [cover, glow, dashed, outer]) {
        if (!el) continue;
        el.style.scale = "";
        el.style.rotate = "";
        el.style.opacity = "";
        el.style.borderColor = "";
      }
      setLive(false);
    };
  }, [stage, playing, reduce, trackId]);
  return live;
}

/** "Visualizer | Classic" — which look the full-screen player wears. */
export function LookSwitch({ look, onChange }: { look: "visualizer" | "classic"; onChange: (look: "visualizer" | "classic") => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-full bg-white/[0.07] p-1 backdrop-blur-sm" role="group" aria-label={T("Look")}>
      {(["visualizer", "classic"] as const).map((l) => (
        <button
          key={l}
          onClick={() => onChange(l)}
          aria-pressed={look === l}
          className={`h-8 rounded-full px-4 text-[13px] font-semibold transition-all active:scale-[0.97] ${
            look === l ? "bg-white/[0.16] text-white" : "text-white/55 hover:text-white/90"
          }`}
        >
          {l === "visualizer" ? T("Visualizer") : T("Classic")}
        </button>
      ))}
    </div>
  );
}

export function VisualizerStage({ track, playing, palette }: { track: Track; playing: boolean; palette: ArtworkPalette }) {
  const facts = useSound((s) => soundOf(track, s.facts));
  const bpm = facts && facts.bpm >= 50 && facts.bpm <= 220 ? facts.bpm : 0;
  // A pulse a beat; fast songs pulse every other beat, so the rays breathe instead of flickering.
  const beat = bpm ? (bpm > 132 ? 120 / bpm : 60 / bpm) : 0.66;
  const energy = facts ? Math.max(0.3, Math.min(1, facts.energy)) : 0.55;
  const rays = useMemo(
    () =>
      Array.from({ length: RAYS }, (_, i) => {
        const r1 = ((i * 137) % 101) / 101;
        const r2 = ((i * 61) % 97) / 97;
        const wave = Math.abs(Math.sin(i * 0.42) * 0.55 + Math.sin(i * 0.13 + 1.2) * 0.35 + Math.sin(i * 1.7) * 0.18);
        return {
          "--a": `${((i / RAYS) * 360).toFixed(2)}deg`,
          "--lo": (0.16 + r1 * 0.12).toFixed(3),
          "--hi": Math.min(1, 0.42 + wave * 0.6).toFixed(3),
          // The pulse runs round the ring once a beat and a half, a little ragged.
          "--d": `${(-((i / RAYS) * 1.5 + r2 * 0.2) * beat).toFixed(3)}s`,
        } as CSSProperties;
      }),
    [beat]
  );
  const stage = useRef<HTMLDivElement>(null);
  const live = useLiveSpectrum(stage, playing, track.id);
  return (
    <div className="flex-1 min-h-0 w-full flex flex-col items-center justify-center px-6">
      <div
        ref={stage}
        className={`viz-stage relative aspect-square ${playing && !live ? "viz-on" : ""} ${live ? "viz-live" : ""}`}
        style={
          {
            width: "min(62vh, 56vw, 760px)",
            containerType: "inline-size",
            "--beat": `${beat.toFixed(3)}s`,
            "--energy": energy.toFixed(2),
            "--viz-a": palette.accent,
            "--viz-b": palette.onBackground,
          } as CSSProperties
        }
      >
        <div
          aria-hidden
          className="viz-glow absolute inset-[8%] rounded-full pointer-events-none"
          style={{ background: `radial-gradient(closest-side, rgb(${palette.accent} / 0.34), transparent 72%)`, filter: "blur(30px)" }}
        />
        <div aria-hidden className="viz-ring-outer absolute inset-[2%] rounded-full border border-white/[0.05]" />
        <div aria-hidden className="viz-ring-dashed absolute inset-[7%] rounded-full border border-dashed border-white/[0.08]" />
        <div aria-hidden className="absolute inset-0">
          {rays.map((style, i) => (
            <span key={i} className="viz-arm" style={style}>
              <i className="viz-ray" />
            </span>
          ))}
        </div>
        {/* Placed without a translate: a translate under the swell's scale moved the record up and left as it grew. */}
        <div className="viz-cover absolute left-[27cqi] top-[27cqi] w-[46cqi] h-[46cqi] rounded-full overflow-hidden shadow-[0_0_90px_rgb(0_0_0/0.55)] ring-2 ring-white/15">
          {track.thumb ? <img key={track.id} src={upgradeArtwork(track.thumb)} alt="" className="w-full h-full object-cover animate-art-in" /> : <span className="block w-full h-full bg-white/[0.06]" />}
          {/* The record's hole. */}
          <span aria-hidden className="absolute left-1/2 top-1/2 w-[5cqi] h-[5cqi] -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/85 ring-[3px] ring-white/35" />
        </div>
      </div>
      <div key={`viz-meta-${track.id}`} className="mt-[3vh] max-w-[min(900px,90vw)] text-center animate-meta-in">
        <div className="font-display font-black tracking-[-0.04em] text-white truncate" style={{ fontSize: "clamp(26px, 4.4vh, 52px)" }} title={track.title}>
          {track.title}
        </div>
        <div className="mt-1 text-white/65 truncate" style={{ fontSize: "clamp(14px, 1.9vh, 20px)" }}>
          {track.artist}
        </div>
      </div>
    </div>
  );
}

/** The party look's whole transport: where in the song, back, play or pause, on. */
export function VisualizerControls() {
  const playing = usePlayer((s) => s.playing);
  const position = usePlayer((s) => s.position);
  const duration = usePlayer((s) => s.queue[s.index]?.duration ?? 0);
  const share = duration > 0 ? Math.min(1, position / duration) : 0;
  return (
    <div className="flex items-center justify-center gap-4 sm:gap-5 px-6 pb-7 pt-2 text-white/80">
      <span className="text-[12px] tabular-nums w-10 text-right">{fmtTime(position)}</span>
      <button
        type="button"
        aria-label={T("Seek")}
        onClick={(e) => {
          if (!duration) return;
          const r = e.currentTarget.getBoundingClientRect();
          usePlayer.getState().seek(((e.clientX - r.left) / r.width) * duration);
        }}
        className="group relative h-4 w-[min(420px,40vw)] flex items-center"
      >
        <span className="absolute inset-x-0 h-[3px] rounded-full bg-white/20 group-hover:h-[5px] transition-[height]" />
        <span className="absolute left-0 h-[3px] rounded-full bg-white group-hover:h-[5px] transition-[height]" style={{ width: `${share * 100}%` }} />
      </button>
      <span className="text-[12px] tabular-nums w-10">{duration > 0 ? fmtTime(duration) : "--:--"}</span>
      <button onClick={() => usePlayer.getState().prev()} title={T("Previous")} aria-label={T("Previous")} className="w-10 h-10 grid place-items-center rounded-full hover:bg-white/[0.08] hover:text-white transition-colors">
        <SkipBack className="w-[18px] h-[18px] fill-current" />
      </button>
      <button
        onClick={() => usePlayer.getState().toggle()}
        title={playing ? T("Pause") : T("Play")}
        aria-label={playing ? T("Pause") : T("Play")}
        className="w-12 h-12 grid place-items-center rounded-full bg-white text-black hover:scale-[1.05] active:scale-95 transition-transform"
      >
        {playing ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current ml-0.5" />}
      </button>
      <button onClick={() => usePlayer.getState().next(true)} title={T("Next")} aria-label={T("Next")} className="w-10 h-10 grid place-items-center rounded-full hover:bg-white/[0.08] hover:text-white transition-colors">
        <SkipForward className="w-[18px] h-[18px] fill-current" />
      </button>
    </div>
  );
}
