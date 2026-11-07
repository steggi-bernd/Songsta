/**
 * Track analysis, scaled to what a browser can do honestly:
 *
 *  - analyseTrackHead: decode a track and estimate tempo (BPM) from the
 *    onset-energy envelope via autocorrelation. Powers beat-aligned
 *    transition starts (smart fade). No vocal mask, no mel spectrogram —
 *    those need native DSP and are not faked here.
 *  - detectEdgeSilence: scan a decoded track for leading/trailing silence
 *    (skip-silence).
 *
 * Both run on the renderer's own thread pool via decodeAudioData; work is
 * bounded (one analysis in flight, small inputs) so playback stays responsive.
 */

export interface TempoGrid {
  bpm: number;
  beatInterval: number; // seconds
  confidence: number; // 0..1
  downbeatEvery: number; // beats per assumed bar (4), 0 = unknown
}

const cache = new Map<string, TempoGrid>();
let inFlight: Promise<void> | null = null;
const queue: string[] = [];
const MAX_CACHE = 400;

function trimCache(): void {
  while (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

async function fetchAudio(trackId: string): Promise<ArrayBuffer | null> {
  try {
    if (!/^(local|jf|ss):/.test(trackId)) return null;
    const { resolveLibrarySource } = await import("./librarySource");
    // Analysed through the same proxy route (and copy) the element plays.
    const url = (await resolveLibrarySource({ id: trackId, title: "", artist: "", duration: 0, thumb: "" }))?.url ?? null;
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok || !res.body) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

async function decode(buf: ArrayBuffer): Promise<AudioBuffer | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    return await ctx.decodeAudioData(buf);
  } catch {
    return null;
  }
}

function mixdown(audio: AudioBuffer, seconds: number): Float32Array {
  const len = Math.min(audio.length, Math.ceil(audio.sampleRate * seconds));
  const out = new Float32Array(len);
  const ch = Math.min(2, audio.numberOfChannels);
  for (let c = 0; c < ch; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) out[i] += data[i] / ch;
  }
  return out;
}

/** Onset-energy autocorrelation BPM over the first `seconds` of audio. */
function estimateTempo(audio: AudioBuffer, seconds = 24): TempoGrid | null {
  const samples = mixdown(audio, seconds);
  const sr = audio.sampleRate;
  const hop = 512;
  const win = 1024;
  const frames = Math.floor((samples.length - win) / hop);
  if (frames < 64) return null;

  // Energy envelope + half-wave-rectified difference = onset strength.
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < win; i++) {
      const v = samples[base + i];
      sum += v * v;
    }
    energy[f] = Math.sqrt(sum / win);
  }
  const onset = new Float32Array(frames - 1);
  let onsetMean = 0;
  for (let f = 0; f < frames - 1; f++) {
    onset[f] = Math.max(0, energy[f + 1] - energy[f]);
    onsetMean += onset[f];
  }
  onsetMean = onsetMean / Math.max(1, onset.length) || 1e-9;
  for (let f = 0; f < onset.length; f++) onset[f] -= onsetMean;

  // Autocorrelation over lags matching 50..220 BPM.
  const fps = sr / hop;
  const minLag = Math.floor((60 / 220) * fps);
  const maxLag = Math.ceil((60 / 50) * fps);
  let bestLag = 0;
  let bestVal = 0;
  let sumSq = 0;
  for (let f = 0; f < onset.length; f++) sumSq += onset[f] * onset[f];
  if (sumSq <= 0) return null;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let dot = 0;
    for (let f = 0; f + lag < onset.length; f++) dot += onset[f] * onset[f + lag];
    const norm = dot / Math.sqrt(sumSq * sumSq) * onset.length;
    // Prefer multiples near 90–180 BPM (octave disambiguation).
    let bpm = (60 * fps) / lag;
    while (bpm < 85) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const octaveWeight = bpm >= 85 && bpm <= 180 ? 1 : 0.55;
    const val = norm * octaveWeight;
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  let bpm = (60 * fps) / bestLag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const confidence = Math.min(1, Math.max(0, bestVal));
  if (confidence < 0.08) return null;
  return { bpm: Math.round(bpm * 10) / 10, beatInterval: 60 / bpm, confidence, downbeatEvery: 4 };
}

/** Analyse a track's tempo (queued, one in flight). The returned promise
 * resolves when THIS track has been processed (hit or miss), so callers can
 * bound-wait for fresh analysis instead of racing the background queue. */
function ensure(trackId: string): Promise<void> {
  if (cache.has(trackId)) return Promise.resolve();
  if (!queue.includes(trackId)) queue.push(trackId);
  return new Promise<void>((resolve) => {
    const list = waiters.get(trackId) ?? [];
    list.push(resolve);
    waiters.set(trackId, list);
    void pump();
  });
}

const waiters = new Map<string, Array<() => void>>();

function settle(trackId: string): void {
  const list = waiters.get(trackId);
  if (!list) return;
  waiters.delete(trackId);
  for (const r of list) {
    try {
      r();
    } catch {
      /* ignore */
    }
  }
}

function pump(): void {
  if (inFlight) return;
  const run = async (): Promise<void> => {
    for (;;) {
      const id = queue.shift();
      if (!id) break;
      if (cache.has(id)) {
        settle(id);
        continue;
      }
      try {
        const buf = await fetchAudio(id);
        if (!buf) {
          settle(id);
          continue;
        }
        const audio = await decode(buf);
        if (!audio) {
          settle(id);
          continue;
        }
        const grid = estimateTempo(audio);
        if (grid) {
          cache.set(id, grid);
          trimCache();
        }
      } catch {
        /* analysis is best-effort */
      } finally {
        settle(id);
      }
    }
  };
  inFlight = run().finally(() => {
    inFlight = null;
    // A track enqueued while the last one processed still needs a runner.
    if (queue.length > 0) pump();
  });
}

export const analyseTrackHead = {
  ensure,
  getCached(trackId: string): TempoGrid | null {
    return cache.get(trackId) ?? null;
  },
  peek: (trackId: string): TempoGrid | null => cache.get(trackId) ?? null,
};

/**
 * Leading/trailing silence, in seconds. Threshold ≈ -42dBFS sustained over a
 * 40ms window, matching what a listener would call silence.
 */
export async function detectEdgeSilence(buf: ArrayBuffer): Promise<{ head: number; tail: number } | null> {
  const audio = await decode(buf);
  if (!audio || audio.length === 0) return null;
  const sr = audio.sampleRate;
  const ch = Math.min(2, audio.numberOfChannels);
  const window = Math.max(1, Math.floor(sr * 0.04));
  const threshold = 0.008;
  const loudAt = (from: number, to: number, step: number): number => {
    for (let i = from; step > 0 ? i < to : i > to; i += step) {
      let loud = false;
      for (let w = 0; w < window && !loud; w++) {
        const idx = i + w * step;
        if (idx < 0 || idx >= audio.length) break;
        for (let c = 0; c < ch; c++) {
          if (Math.abs(audio.getChannelData(c)[idx]) > threshold) {
            loud = true;
            break;
          }
        }
      }
      if (loud) return i;
    }
    return -1;
  };
  const first = loudAt(0, audio.length, 1);
  const last = loudAt(audio.length - 1, 0, -1);
  if (first < 0 || last < 0) return { head: 0, tail: 0 };
  return {
    head: Math.max(0, (first - window) / sr),
    tail: Math.max(0, (audio.length - 1 - last - window) / sr),
  };
}
