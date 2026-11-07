/** Shared data types used by both the Electron main process and the renderer. */

export interface Track {
  /** "local:…", "jf:…" or "ss:…" */
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  /** duration in seconds (0 = unknown) */
  duration: number;
  /** best available thumbnail url */
  thumb: string;
  /** set for local-library tracks (local origin flag; playback resolves via the id) */
  localPath?: string;

  /* Library facts — album/artist pages, home mixes, smart playlists, ReplayGain. */
  /** where the song lives */
  source?: "local" | "jellyfin" | "subsonic";
  year?: number;
  genre?: string;
  albumArtist?: string;
  /** the album as its tags name it, when the user shows it under another name (lib/albumEdits.ts) */
  albumTag?: string;
  trackNo?: number;
  discNo?: number;
  /** when the library first saw the song (ms) */
  addedAt?: number;
  /** ReplayGain 2.0: gains in dB, peaks linear */
  rg?: { trackGain?: number; trackPeak?: number; albumGain?: number; albumPeak?: number };
  codec?: string;
  sampleRate?: number;
  bitsPerSample?: number;
  /** bits per second */
  bitrate?: number;
  /** lossless source, when the decoder said so (local files) */
  lossless?: boolean;
  /** the file's container where a server names it ("flac", "m4a" …) */
  container?: string;
  /** songs on the release, when tagged or listed */
  trackTotal?: number;
  /** release type tags, space-separated ("album", "ep", "single", "album compilation" …) */
  releaseType?: string;
  /** first release year — a reissue's own `year` can be decades later */
  originalYear?: number;
  /** the release's day where the source knows it: "YYYY-MM-DD", or "YYYY-MM" / "YYYY" */
  date?: string;
  /** the first release's day — a reissue's own `date` can be decades later */
  originalDate?: string;
}

/* ---------------- Lyrics ---------------- */

/** A word (or syllable group) with its own timing — Apple TTML / rich LRC. */
export interface SyncedLyricWord {
  /** seconds into the track */
  start: number;
  end: number;
  text: string;
}

export interface SyncedLyricLine {
  /** seconds into the track */
  time: number;
  text: string;
  /** per-word timings when the provider is word-synced */
  words?: SyncedLyricWord[];
  /** seconds the line stops singing, when known */
  end?: number;
  /** instrumental section marker (nobody sings here) */
  gap?: boolean;
}

export interface LyricsResult {
  /** time-synced lines when available (Spotify-style highlighting) */
  synced: SyncedLyricLine[] | null;
  plain: string | null;
  /** which provider answered */
  source?: string;
  /** true when the synced lines carry per-word timings */
  wordSynced?: boolean;
}
