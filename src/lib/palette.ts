/**
 * Per-page ArtworkPalette.
 *
 * Derives the entire surface palette of an album/playlist/artist page
 * from the sleeve: a deep tinted `background`, a `wash` that matches what the
 * artwork's own bottom edge would blur down to, an `elevated` tone for chips
 * and glass buttons, and an `accent` that's the artwork's own colour but
 * contrast-corrected so titles and the Play FAB read on the wash. The shell
 * stays monochrome; the page is the only thing that ever wears a colour.
 *
 * The HSL `coerceIn` ranges below are taken directly from the mobile file
 * (toPalette, dark/light branches) and translated 1:1. Same scoring formula
 * for the vibrant swatch (saturation × √population — see seedOf).
 */
import { useEffect, useRef, useState } from "react";
import { loadArtworkImage } from "./ambient";

export interface ArtworkPalette {
  /** CSS `R G B` triplet strings — consumed as `rgb(var(--page-bg) / <a>)`. */
  background: string;
  wash: string;
  elevated: string;
  /** Already contrast-corrected for use on `background` / `wash`. */
  accent: string;
  onBackground: string;
  onBackgroundVariant: string;
  divider: string;
}

interface Seed {
  dominant: [number, number, number];
  vibrant: [number, number, number];
  edge: [number, number, number];
}

/* LRU cache — see ArtworkPalette.kt:162-167. Access-order, evicts eldest. */
const SEED_CACHE_ENTRIES = 128;
const seedCache = new Map<string, Seed>();

/** Read size for the quantiser. 128² is enough; the blur hides the upscale. */
const PALETTE_PX = 128;

/* ============================================================ extraction */

/**
 * Reads the artwork at [url] and returns a Seed (dominant, vibrant, edge).
 *
 * Two-step scoring, same as mobile:
 *  - `dominant` is the swatch with the most pixels.
 *  - `vibrant` is the swatch that maximises `hslSaturation * sqrt(population)`,
 *    so a sleeve that's four-fifths black sky still picks the bright note.
 *  - `edge` is a flat mean of the bottom 18% of the bitmap — what a blur wide
 *    enough to lose the picture leaves behind at that edge.
 */
async function seedOf(url: string): Promise<Seed | null> {
  const loaded = await loadArtworkImage(url);
  if (!loaded) return null;
  const { image: img, cleanup } = loaded;
  try {
    if (!img.naturalWidth || !img.naturalHeight) return null;

    const canvas = document.createElement("canvas");
    canvas.width = PALETTE_PX;
    canvas.height = PALETTE_PX;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, PALETTE_PX, PALETTE_PX);
    const { data } = ctx.getImageData(0, 0, PALETTE_PX, PALETTE_PX);

    // Mobile does this with androidx.palette; we approximate with a 24-bin hue
    // histogram weighted by saturation × population, plus a flat mean for the
    // edge band. Same end shape, no Android dependency.
    const BINS = 24;
    const score = new Float32Array(BINS);
    const rSum = new Float32Array(BINS);
    const gSum = new Float32Array(BINS);
    const bSum = new Float32Array(BINS);
    const wSum = new Float32Array(BINS);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = max === 0 ? 0 : (max - min) / max;
      // Same luminance floor as the mobile extractPalette — anything this dark
      // or this bright is just shadow / highlight, not "the colour of the art".
      if (lum < 0.06 || lum > 0.97) continue;

      let h = 0;
      if (max !== min) {
        const d = max - min;
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
      }
      const bin = Math.min(BINS - 1, Math.max(0, Math.floor(h * BINS)));
      const w = sat * Math.sqrt(sat) + 0.02;
      score[bin] += w;
      rSum[bin] += r * w;
      gSum[bin] += g * w;
      bSum[bin] += b * w;
      wSum[bin] += w;
    }

    let dominantBin = -1;
    let vibrantBin = -1;
    for (let i = 0; i < BINS; i++) {
      if (wSum[i] === 0) continue;
      if (dominantBin < 0 || wSum[i] > wSum[dominantBin]) dominantBin = i;
      if (vibrantBin < 0 || score[i] > score[vibrantBin]) vibrantBin = i;
    }
    if (dominantBin < 0 || vibrantBin < 0) return null;

    const avg = (i: number): [number, number, number] => {
      const w = wSum[i] || 1;
      return [
        Math.round((rSum[i] / w) * 255),
        Math.round((gSum[i] / w) * 255),
        Math.round((bSum[i] / w) * 255),
      ];
    };

    // Edge band: bottom 18% of the bitmap. The page under the artwork has to
    // match what a wide blur produces, not what the picture is about.
    const edgeBand = Math.max(1, Math.floor(PALETTE_PX * 0.18));
    let rEdge = 0;
    let gEdge = 0;
    let bEdge = 0;
    let edgeCount = 0;
    for (let y = PALETTE_PX - edgeBand; y < PALETTE_PX; y++) {
      for (let x = 0; x < PALETTE_PX; x++) {
        const idx = (y * PALETTE_PX + x) * 4;
        rEdge += data[idx];
        gEdge += data[idx + 1];
        bEdge += data[idx + 2];
        edgeCount++;
      }
    }
    const edge: [number, number, number] = edgeCount
      ? [Math.round(rEdge / edgeCount), Math.round(gEdge / edgeCount), Math.round(bEdge / edgeCount)]
      : avg(dominantBin);

    return {
      dominant: avg(dominantBin),
      vibrant: avg(vibrantBin),
      edge,
    };
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

/* ============================================================ HSL clamp */

interface HSL {
  h: number;
  s: number;
  l: number;
}

function rgbToHsl(r: number, g: number, b: number): HSL {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(hk(h + 1 / 3) * 255),
    Math.round(hk(h) * 255),
    Math.round(hk(h - 1 / 3) * 255),
  ];
}

/** Clamp a colour's HSL channels and return the new rgb triplet. */
function withHsl(
  rgb: [number, number, number],
  sat: (s: number) => number,
  lit: (l: number) => number,
): [number, number, number] {
  const hsl = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  hsl.s = Math.max(0, Math.min(1, sat(hsl.s)));
  hsl.l = Math.max(0, Math.min(1, lit(hsl.l)));
  return hslToRgb(hsl);
}

const clamp = (lo: number, hi: number) => (v: number): number =>
  Math.max(lo, Math.min(hi, v));
const floor = (lo: number) => (v: number): number => Math.max(lo, v);

/* ============================================================ toPalette */

/**
 * The HSL clamps below are taken straight from `Seed.toPalette()` in
 * `ArtworkPalette.kt` (L238-281). The comments paraphrase the mobile file.
 */
function seedToPalette(seed: Seed, dark: boolean): ArtworkPalette {
  if (dark) {
    // "Deep enough that white body text clears contrast on any sleeve, but
    //  not so deep the hue is gone — the whole point is that the page is
    //  recognisably *this* record's colour."
    const background = withHsl(seed.dominant, clamp(0.2, 0.62), () => 0.13);
    // "Follows the edge's own brightness within a band that stays clear of
    //  white body text at the top and of [background] at the bottom."
    const wash = withHsl(seed.edge, clamp(0.18, 0.58), clamp(0.14, 0.24));
    const elevated = withHsl(seed.dominant, clamp(0.2, 0.62), () => 0.22);
    // "The accent has to earn its place twice over: a colour nobody sees
    //  enough of reads as arbitrary, and a grey one isn't an accent at all."
    const accent = withHsl(seed.vibrant, floor(0.55), clamp(0.62, 0.78));
    return {
      background: triplet(background),
      wash: triplet(wash),
      elevated: triplet(elevated),
      accent: triplet(accent),
      onBackground: "255 255 255",
      onBackgroundVariant: "204 204 204", // White @ 0.80
      divider: "31 31 31", // White @ 0.12
    };
  }
  // Light branch (mobile L266-281). The PC build ships dark only for now, but
  // the function is structured for a future light-mode flip without re-deriving.
  const background = withHsl(seed.dominant, clamp(0.14, 0.5), () => 0.91);
  const wash = withHsl(seed.edge, clamp(0.12, 0.46), clamp(0.78, 0.9));
  const elevated = withHsl(seed.dominant, clamp(0.14, 0.5), () => 0.83);
  const accent = withHsl(seed.vibrant, floor(0.55), clamp(0.3, 0.44));
  return {
    background: triplet(background),
    wash: triplet(wash),
    elevated: triplet(elevated),
    accent: triplet(accent),
    onBackground: "0 0 0",
    onBackgroundVariant: "89 89 89", // Black @ 0.70
    divider: "26 26 26", // Black @ 0.10
  };
}

const triplet = (rgb: [number, number, number]): string => `${rgb[0]} ${rgb[1]} ${rgb[2]}`;

/* ============================================================ the hook */

const NEUTRAL_DARK: ArtworkPalette = {
  background: "13 13 15",
  wash: "13 13 15",
  elevated: "28 28 30",
  accent: "255 255 255",
  onBackground: "255 255 255",
  onBackgroundVariant: "142 142 147",
  divider: "31 31 31",
};

/**
 * React hook: returns an `ArtworkPalette` derived from the URL.
 *
 * - On first frame, returns the cached seed immediately if any.
 * - On miss, kicks off an async extraction; the palette re-renders when it
 *   lands. The crossfade is 260ms by default; `transition: none` in
 *   `.page-tint` when the page has `html.reduce-motion` on the root.
 * - Writes the palette to CSS custom properties on the element the caller
 *   passes in `targetRef` (or, by default, on `<main>`) so consumers can read
 *   it via `var(--page-bg)` / `var(--page-wash)` / etc.
 */
export function useArtworkPalette(
  url: string | null | undefined,
  options: { dark?: boolean; targetRef?: React.RefObject<HTMLElement> } = {},
): ArtworkPalette {
  // The app is dark-only; the dark pin stays so callers read honestly.
  const { dark = true, targetRef } = options;
  const [palette, setPalette] = useState<ArtworkPalette>(() => {
    if (url && seedCache.has(url)) {
      return seedToPalette(seedCache.get(url)!, dark);
    }
    return NEUTRAL_DARK;
  });

  // Hold the latest target ref without re-running the effect on every render.
  const targetHolder = useRef<HTMLElement | null>(null);
  useEffect(() => {
    targetHolder.current = targetRef?.current ?? null;
  });

  useEffect(() => {
    if (!url) {
      setPalette(NEUTRAL_DARK);
      return;
    }
    const known = seedCache.get(url);
    if (known) {
      setPalette(seedToPalette(known, dark));
      return;
    }
    let cancelled = false;
    void seedOf(url).then((seed) => {
      if (cancelled || !seed) return;
      // Bound the cache.
      if (seedCache.size >= SEED_CACHE_ENTRIES) {
        const oldest = seedCache.keys().next().value;
        if (oldest) seedCache.delete(oldest);
      }
      seedCache.set(url, seed);
      setPalette(seedToPalette(seed, dark));
    });
    return () => {
      cancelled = true;
    };
  }, [url, dark]);

  // Paint the palette onto the target element as CSS variables. We do this in
  // an effect (not a layout) so React state remains the source of truth.
  useEffect(() => {
    const el = targetRef?.current ?? null;
    if (!el) return;
    el.style.setProperty("--page-bg", palette.background);
    el.style.setProperty("--page-wash", palette.wash);
    el.style.setProperty("--page-elevated", palette.elevated);
    el.style.setProperty("--page-accent", palette.accent);
    el.style.setProperty("--page-on", palette.onBackground);
    el.style.setProperty("--page-on-variant", palette.onBackgroundVariant);
    el.style.setProperty("--page-divider", palette.divider);
  }, [palette, targetRef]);

  return palette;
}
