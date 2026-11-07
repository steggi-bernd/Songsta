/** What you chose in Settings, kept on the phone; the player's part goes straight to the native player. */
import { create } from "zustand";
import Player from "../../modules/media3-player";
import { readJson, writeJson } from "../storage";
import { colors } from "../theme";
import { NO_VERSION_MEMORY, T, type LanguageChoice, type NewVersionMemory, type DeviceLink } from "../shared";

const FILE = "settings.json";

/** How a swiped row feels: `rubber` pulls long and lets go hard, `taut` gives less all the way. */
export type SwipeFeel = "rubber" | "taut";

/** The desktop's accents, in the phone's colours. */
export const ACCENTS = {
  violet: { label: T("Violet"), color: "#A78BFA", on: "#120B24" },
  blue: { label: T("Blue"), color: "#60A5FA", on: "#07172B" },
  teal: { label: T("Teal"), color: "#2DD4BF", on: "#04211D" },
  green: { label: T("Green"), color: "#4ADE80", on: "#06210F" },
  amber: { label: T("Amber"), color: "#FBBF24", on: "#241A02" },
  coral: { label: T("Coral"), color: "#FB7185", on: "#2A0810" },
  pink: { label: T("Pink"), color: "#F472B6", on: "#2A0A1C" },
  white: { label: T("White"), color: "#F4F4F5", on: "#111113" },
} as const;

export type Accent = keyof typeof ACCENTS;

/** Hz of the equalizer's bands, as on the desktop. */
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_RANGE_DB = 12;

export const EQ_PRESETS: { label: string; gains: number[] }[] = [
  { label: T("Flat"), gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { label: T("Bass"), gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { label: T("Warm"), gains: [3, 3, 2, 1, 0, 0, -1, -1, -2, -2] },
  { label: T("Vocal"), gains: [-2, -2, -1, 0, 2, 3, 3, 2, 0, -1] },
  { label: T("Bright"), gains: [0, 0, 0, 0, 0, 1, 2, 3, 4, 5] },
  { label: T("Loudness"), gains: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5] },
];

export interface Settings {
  swipeFeel: SwipeFeel;
  /** the phone answers gestures */
  haptics: boolean;
  /** seconds a song fades out and the next one in; 0: they just follow each other */
  fadeSeconds: number;
  /** songs of one album play on without a fade, whatever `fadeSeconds` says */
  seamlessAlbums: boolean;
  skipSilence: boolean;
  speed: number;
  /** a queue that runs out goes on with something from the library */
  autoplay: boolean;
  /** going to another song ends repeat-one: the whole list repeats from there */
  skipEndsRepeatOne: boolean;
  /** what played lately stays out of that */
  dontRepeat: boolean;
  eqOn: boolean;
  eqGains: number[];
  syncedLyrics: boolean;
  dimLyrics: boolean;
  lyricsLatin: boolean;
  accent: Accent;
  reduceMotion: boolean;
  /** plays are counted on the server too */
  serverPlays: boolean;
  /** clips and voice notes stay out of the local songs */
  filterNonMusic: boolean;
  /** of the interface; mobile/index.ts reads it first thing, and a change takes a restart */
  language: LanguageChoice;
  /** what stands on top in Your Library, first pinned first: "album:…", "mix:…", "artist:…" (playlists carry their own pin) */
  pins: string[];
  /** a short note and a dot when a newer version is out (newVersion.ts) */
  checkNewVersion: boolean;
  newVersion: NewVersionMemory;
  /** the first start's pages were gone through */
  setupDone: boolean;
  /** fetches a new version unasked, on Wi-Fi; Android still asks before it goes in */
  autoUpdate: boolean;
  /** a receiver goes off half a minute after the music has left it (lib/devicePower.ts) */
  switchOffDevices: boolean;
  /** which device hangs on which input of a receiver */
  deviceLinks: DeviceLink[];
  /** TVs that took this app's code: they can be switched off from here */
  pairedTvs: string[];
  /** how far ahead a device plays in a group, in ms, set by hand; below zero behind */
  playAhead: Record<string, number>;
  /** the version that ran last, for the note after an update */
  lastVersion: string;
}

const DEFAULTS: Settings = {
  swipeFeel: "rubber",
  haptics: true,
  fadeSeconds: 0,
  seamlessAlbums: true,
  skipSilence: false,
  speed: 1,
  autoplay: false,
  skipEndsRepeatOne: true,
  dontRepeat: false,
  eqOn: false,
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  syncedLyrics: true,
  dimLyrics: true,
  lyricsLatin: false,
  accent: "violet",
  reduceMotion: false,
  serverPlays: true,
  filterNonMusic: true,
  language: "auto",
  pins: [],
  checkNewVersion: true,
  newVersion: NO_VERSION_MEMORY,
  setupDone: false,
  autoUpdate: true,
  switchOffDevices: true,
  deviceLinks: [],
  pairedTvs: [],
  playAhead: {},
  lastVersion: "",
};

interface SettingsState extends Settings {
  change(next: Partial<Settings>): void;
  togglePin(key: string): void;
}

/** The native player's share of it. */
function tellPlayer(s: Settings): void {
  void Player.setTuning(s.skipSilence, s.speed, s.fadeSeconds, s.seamlessAlbums).catch(() => undefined);
  void Player.setEqualizer(s.eqOn, EQ_BANDS, s.eqGains).catch(() => undefined);
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...DEFAULTS,
  change(next) {
    set(next);
    const { change: _change, togglePin: _togglePin, ...saved } = get();
    writeJson(FILE, saved);
    if (["skipSilence", "speed", "fadeSeconds", "seamlessAlbums", "eqOn", "eqGains"].some((key) => key in next)) tellPlayer(saved);
  },
  togglePin(key) {
    const { pins } = get();
    get().change({ pins: pins.includes(key) ? pins.filter((k) => k !== key) : [...pins, key] });
  },
}));

/** Before anything draws: the colours go into every screen's styles as those are made. */
export async function restoreSettings(): Promise<void> {
  const saved = await readJson<Partial<Settings>>(FILE).catch(() => null);
  const settings = { ...DEFAULTS, ...saved };
  useSettings.setState(settings);
  const accent = ACCENTS[settings.accent] ?? ACCENTS.violet;
  colors.accent = accent.color;
  colors.onAccent = accent.on;
  tellPlayer(settings);
}

/** What a touch or a gesture feels like, unless that's switched off: "tick" for small things, "press" for what opens or changes something. */
export function feel(kind: "tick" | "press" | "arm" | "charge" | "charged" | "commit" | "cancel"): void {
  if (useSettings.getState().haptics) void Player.haptic(kind).catch(() => undefined);
}
