/**
 * What a song sounds like, measured once from its samples — a mono decode at
 * a low rate (sound-library.ts feeds it): tempo, key, energy, level, and the
 * silence and level at its two ends. Pure arithmetic, no Electron: the home
 * page's mood mixes, the song details, Automix and the seamless transitions
 * (src/lib/continuity.ts) read the results.
 *
 *  - tempo: spectral-flux onsets, their autocorrelation over 60–200 BPM, a
 *    gentle preference for ~120 BPM against double/half-time mistakes; none
 *    where the sound hardly ever starts anew (held chords, drones)
 *  - key: a chromagram (80 Hz – 2.1 kHz, every moment weighted alike)
 *    correlated with the Krumhansl–Kessler profiles of the 24 keys
 *  - energy: level, attack, tempo and brightness, 0 (calm) … 1 (driving)
 *
 * Long work yields (`breathe`) every few dozen frames, so the main process
 * keeps answering while it runs.
 */

export interface SoundFacts {
  /** beats per minute; 0 = no steady beat */
  bpm: number;
  /** the key's tonic, 0 = C … 11 = B; -1 = no clear key */
  key: number;
  minor: boolean;
  /** 0 (calm) … 1 (driving) */
  energy: number;
  /** average level of the sounding part, dBFS */
  loudness: number;
  /** seconds of near-silence at the start / at the end */
  introSilence: number;
  outroSilence: number;
  /** level of the first / the last half second, dBFS — a song that runs into the next ends loud */
  headDb: number;
  tailDb: number;
  /** measured from a stretch in the middle (a server song): tempo, key and energy hold, its two ends are not known */
  excerpt?: boolean;
  /** the key was set by hand (src/stores/keyEdits.ts): what the analysis measured */
  measuredKey?: { key: number; minor: boolean };
}

/** Onset strength (spectral flux per unit of spectrum) below which nothing beats. */
const ATTACK_MIN = 0.04;
/** Profile correlation below which no key is clear enough to name. */
const KEY_MIN = 0.5;

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** "A minor", "E♭ major"; "" for no clear key. */
export function keyName(key: number, minor: boolean): string {
  return key >= 0 && key < 12 ? `${NAMES[key]} ${minor ? "minor" : "major"}` : "";
}

const dbOf = (meanSquare: number): number => 10 * Math.log10(meanSquare + 1e-12);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places;

/** In-place radix-2 FFT (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let start = 0; start < n; start += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

/** Magnitudes of one Hann-windowed frame (size/2 bins) into `out`. */
function frameMagnitudes(samples: Float32Array, start: number, window: Float64Array, re: Float64Array, im: Float64Array, out: Float64Array): void {
  const size = window.length;
  for (let i = 0; i < size; i++) {
    const s = start + i < samples.length ? samples[start + i] : 0;
    re[i] = s * window[i];
    im[i] = 0;
  }
  fft(re, im);
  for (let k = 0; k < size / 2; k++) out[k] = Math.hypot(re[k], im[k]);
}

function hann(size: number): Float64Array {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  return w;
}

/** Pearson correlation of two 12-value profiles. */
function correlate(a: readonly number[], b: readonly number[]): number {
  const mean = (v: readonly number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The best of the 24 keys for a chroma profile, and how clearly it wins. */
export function keyOfChroma(chroma: readonly number[]): { key: number; minor: boolean; strength: number } {
  let best = { key: -1, minor: false, strength: -1 };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const profile = minor ? KK_MINOR : KK_MAJOR;
      const rotated = Array.from({ length: 12 }, (_, pc) => profile[(pc - tonic + 12) % 12]);
      const r = correlate(chroma, rotated);
      if (r > best.strength) best = { key: tonic, minor, strength: r };
    }
  }
  return best;
}

/**
 * The tempo of an onset envelope sampled `fps` times a second: the lag with
 * the strongest self-similarity between 60 and 200 BPM, weighted towards
 * ~120 BPM so a song isn't heard at double or half its speed; 0 when no lag
 * stands out (no steady beat).
 */
export function tempoOfOnsets(onsets: Float64Array, fps: number): number {
  const n = onsets.length;
  const minLag = Math.max(1, Math.floor((fps * 60) / 200));
  const maxLag = Math.min(n - 2, Math.ceil((fps * 60) / 60));
  if (maxLag <= minLag + 2) return 0;
  const r = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) sum += onsets[i] * onsets[i + lag];
    r[lag] = sum / (n - lag);
  }
  let bestLag = -1;
  let bestScore = 0;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    total += r[lag];
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    const score = r[lag] * prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  const mean = total / (maxLag - minLag + 1);
  if (bestLag < 0 || mean <= 0 || r[bestLag] < mean * 1.25) return 0;
  // Between the neighbouring lags, where the peak really is.
  const a = r[bestLag - 1];
  const b = r[bestLag];
  const c = r[bestLag + 1];
  const shift = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return round((60 * fps) / (bestLag + Math.max(-0.5, Math.min(0.5, shift))), 1);
}

/** Facts of a mono signal at `rate` Hz. */
export async function analyseSamples(samples: Float32Array, rate: number, breathe: () => Promise<void> = async () => undefined): Promise<SoundFacts> {
  const n = samples.length;
  const block = 1024;
  const blocks = Math.floor(n / block);
  const levels = new Float64Array(blocks);
  let peak = -Infinity;
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    for (let i = b * block; i < (b + 1) * block; i++) sum += samples[i] * samples[i];
    levels[b] = dbOf(sum / block);
    peak = Math.max(peak, levels[b]);
  }
  const edge = (from: number, to: number): number => {
    let sum = 0;
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) sum += samples[i] * samples[i];
    return round(dbOf(sum / Math.max(1, Math.min(n, to) - Math.max(0, from))), 1);
  };
  const half = Math.round(rate / 2);
  const silentFacts: SoundFacts = { bpm: 0, key: -1, minor: false, energy: 0, loudness: -120, introSilence: n / rate, outroSilence: n / rate, headDb: edge(0, half), tailDb: edge(n - half, n) };
  if (!blocks || peak < -70) return silentFacts;

  // Near-silence: 45 dB under the loudest moment, and never louder than -60 dBFS counts as sound.
  const floor = Math.max(-60, peak - 45);
  let first = 0;
  while (first < blocks && levels[first] < floor) first++;
  let last = blocks - 1;
  while (last > first && levels[last] < floor) last--;
  let power = 0;
  for (let b = first; b <= last; b++) power += 10 ** (levels[b] / 10);
  const loudness = round(dbOf(power / (last - first + 1)), 1);

  // The middle of the sounding part, up to two minutes, carries tempo, key and energy.
  const from = first * block;
  const to = (last + 1) * block;
  const span = Math.min(to - from, 120 * rate);
  const start = from + Math.floor((to - from - span) / 2);
  const end = start + span;

  // Onsets: how much louder each band got since the last frame (spectral flux).
  const size = 1024;
  const hop = 256;
  const window = hann(size);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const mags = new Float64Array(size / 2);
  let prev = new Float64Array(size / 2);
  let cur = new Float64Array(size / 2);
  const topBin = Math.min(size / 2, Math.floor((4000 * size) / rate));
  const frames = Math.max(0, Math.floor((end - start - size) / hop));
  const flux = new Float64Array(frames);
  let level = 0;
  for (let f = 0; f < frames; f++) {
    frameMagnitudes(samples, start + f * hop, window, re, im, mags);
    let sum = 0;
    for (let k = 1; k < topBin; k++) {
      cur[k] = Math.log1p(10 * mags[k]);
      level += cur[k];
      if (f > 0 && cur[k] > prev[k]) sum += cur[k] - prev[k];
    }
    flux[f] = sum;
    [prev, cur] = [cur, prev];
    if (f % 64 === 63) await breathe();
  }
  // Against its own surroundings (±0.4 s), so a crescendo isn't one long onset.
  const fps = rate / hop;
  const radius = Math.round(0.4 * fps);
  const onsets = new Float64Array(frames);
  let running = 0;
  for (let f = 0; f < Math.min(frames, radius); f++) running += flux[f];
  for (let f = 0; f < frames; f++) {
    if (f + radius < frames) running += flux[f + radius];
    if (f - radius - 1 >= 0) running -= flux[f - radius - 1];
    const count = Math.min(frames - 1, f + radius) - Math.max(0, f - radius) + 1;
    onsets[f] = Math.max(0, flux[f] - running / count);
  }
  // How hard the sound keeps starting, against how much sound there is: a beat
  // or plucked notes run 0.1–0.3, held chords and drones stay near 0. Below
  // ATTACK_MIN the autocorrelation only finds the rhythm of numerical noise.
  let fluxSum = 0;
  for (let f = 0; f < frames; f++) fluxSum += flux[f];
  const attack = level > 0 ? fluxSum / level : 0;
  const bpm = attack >= ATTACK_MIN ? tempoOfOnsets(onsets, fps) : 0;

  // Key and brightness: a chromagram of 80 Hz – 2.1 kHz, and the spectral centre of gravity.
  const kSize = 4096;
  const kHop = 2048;
  const kWindow = hann(kSize);
  const kRe = new Float64Array(kSize);
  const kIm = new Float64Array(kSize);
  const kMags = new Float64Array(kSize / 2);
  const chroma = new Array<number>(12).fill(0);
  const pcOfBin = new Int8Array(kSize / 2).fill(-1);
  for (let k = 1; k < kSize / 2; k++) {
    const hz = (k * rate) / kSize;
    // Kick drums live below 80 Hz: their thud would pull every song towards their pitch.
    if (hz < 80 || hz > 2100) continue;
    pcOfBin[k] = (((Math.round(69 + 12 * Math.log2(hz / 440)) % 12) + 12) % 12) as number;
  }
  let centroidSum = 0;
  let centroidWeight = 0;
  const frameChroma = new Array<number>(12);
  const kFrames = Math.max(0, Math.floor((end - start - kSize) / kHop));
  for (let f = 0; f < kFrames; f++) {
    frameMagnitudes(samples, start + f * kHop, kWindow, kRe, kIm, kMags);
    frameChroma.fill(0);
    for (let k = 1; k < kSize / 2; k++) {
      const m = kMags[k];
      if (pcOfBin[k] >= 0) frameChroma[pcOfBin[k]] += Math.sqrt(m);
      centroidSum += m * ((k * rate) / kSize);
      centroidWeight += m;
    }
    // Every moment counts the same — a loud drum hit doesn't outvote the harmony around it.
    const total = frameChroma.reduce((s, v) => s + v, 0);
    if (total > 0) for (let pc = 0; pc < 12; pc++) chroma[pc] += frameChroma[pc] / total;
    if (f % 16 === 15) await breathe();
  }
  const tonal = keyOfChroma(chroma);
  const centroid = centroidWeight ? centroidSum / centroidWeight : 0;

  // Energy: how loud, how hard it keeps starting, how fast, how bright.
  const energy =
    0.4 * clamp01((loudness + 30) / 22) +
    0.3 * clamp01(attack / 0.3) +
    0.15 * (bpm ? clamp01((bpm - 60) / 120) : 0) +
    0.15 * clamp01((centroid - 400) / 2200);

  return {
    bpm,
    key: tonal.strength >= KEY_MIN ? tonal.key : -1,
    minor: tonal.strength >= KEY_MIN && tonal.minor,
    energy: round(energy, 2),
    loudness,
    introSilence: round((first * block) / rate, 2),
    outroSilence: round(((blocks - 1 - last) * block + (n - blocks * block)) / rate, 2),
    headDb: silentFacts.headDb,
    tailDb: silentFacts.tailDb,
  };
}
