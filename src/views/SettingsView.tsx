import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  AppWindow,
  AudioLines,
  BarChart3,
  Check,
  ChevronRight,
  Circle,
  CircleCheck,
  Disc3,
  Download,
  Droplets,
  ExternalLink,
  FileAudio,
  FileDown,
  FileUp,
  FolderOpen,
  FolderSync,
  Gauge,
  Heart,
  Image,
  Infinity as InfinityIcon,
  KeyRound,
  Languages,
  Link2,
  ListChecks,
  ListMusic,
  Maximize2,
  Music4,
  Palette,
  Power,
  Radio,
  RefreshCw,
  Repeat,
  Server,
  ShoppingBag,
  SlidersVertical,
  Sparkles,
  Speaker,
  Squircle,
  Trash2,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  useSettings,
  type Accent,
  type Corners,
} from "../stores/settings";
import { installUpdate, lookNow, openReleasePage, startUpdate, useAppUpdate, useNewerVersion } from "../lib/newVersionWatch";
import { isLinux, isMac } from "../lib/platform";
import { ParametricEqEditor } from "../components/ParametricEqEditor";
import { useUI, type MenuItem } from "../stores/ui";
import { EQ_BANDS, listOutputDevices } from "../lib/audio";
import type { OutputDeviceChoice } from "../lib/audio-output";
import type { DiscordStatus } from "../../electron/discord";
import type { JellyfinStatus } from "../../electron/jellyfin";
import type { SubsonicStatus } from "../../electron/subsonic";
import type { SoundStatus } from "../../electron/sound-library";
import { refreshHomeSync, useHomeSync } from "../lib/homeSync";
import { syncFavorites } from "../lib/serverSync";
import type { SyncStatus } from "../lib/syncEngine";
import { LANGUAGES, storedLanguageChoice, storeLanguageChoice, T, type LanguageChoice } from "../lib/i18n";

/* ============================================================ settings chrome
   Settings are inset cards of rows: an uppercase group header, a
   rounded card, glyph + title + optional subtitle on the left, a value/switch
   or chevron on the right, and hairline dividers inset to the text column. */

const GROUP_INSET = "px-0"; // page padding comes from the view container
const ROW_INSET = "px-4";
const TEXT_INSET = "pl-[52px]"; // icon (22) + gap (14) + row inset (16)

function SettingsGroup({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section className="animate-slide-up">
      {header && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim px-1 pt-7 pb-2">
          {header}
        </h2>
      )}
      {!header && <div className="pt-7" />}
      <div className={`rounded-[calc(14px*var(--radius-scale))] bg-panel overflow-hidden ${GROUP_INSET}`}>{children}</div>
      {footer && <p className="text-[12.5px] text-ink-dim px-1 pt-2 leading-relaxed">{footer}</p>}
    </section>
  );
}

function Divider() {
  return <div className={`h-px bg-ink-hi/[0.08] ${TEXT_INSET}`} />;
}

function Switch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      className={`relative shrink-0 w-[42px] h-[26px] rounded-full transition-colors duration-200 disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-ink-hi/[0.16]"
      }`}
    >
      <span
        className={`absolute top-[3px] w-[20px] h-[20px] rounded-full transition-all duration-200 ${
          checked ? "left-[19px] bg-on-primary" : "left-[3px] bg-white"
        }`}
      />
    </button>
  );
}

function Chevron() {
  return <ChevronRight className="w-5 h-5 text-ink-dim/70 shrink-0" />;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-hi/90 rounded-[5px] bg-ink-hi/[0.16] px-1.5 py-0.5">
      {children}
    </span>
  );
}

/** How this system installs FFmpeg, for the hint when it's missing. */
const FFMPEG_INSTALL = isLinux ? "sudo apt install ffmpeg" : isMac ? "brew install ffmpeg" : "winget install ffmpeg";

/**
 * FFmpeg status: AIFF, ALAC, WMA, WavPack, APE and DSD play through an FFmpeg
 * conversion (electron/transcode.ts). Clicking re-checks, so installing
 * FFmpeg while ByTune runs is picked up without a restart.
 */
function FfmpegRow() {
  const [status, setStatus] = useState<{ path: string | null; version: string | null } | null>(null);
  const check = (recheck: boolean): void => {
    void window.bytune?.ffmpegStatus(recheck).then(setStatus).catch(() => undefined);
  };
  useEffect(() => check(false), []);
  return (
    <SettingsRow
      icon={FileAudio}
      title={T("FFmpeg")}
      subtitle={
        !status ? T("Checking…") : status.path ? T("AIFF, ALAC, WMA, WavPack, APE and DSD play through it (converted once, lossless)") : T("Not found — needed for AIFF, ALAC, WMA, WavPack, APE and DSD. Install it (e.g. “{FFMPEG_INSTALL}”), then click to check again.", { FFMPEG_INSTALL })
      }
      value={status?.path ? `v${status.version}` : status ? T("Missing") : undefined}
      onClick={() => check(true)}
    />
  );
}

/**
 * Sound analysis (electron/sound-library.ts): tempo, key and energy of every
 * local song, measured once in the background — its switch and how far it
 * got, asked again every few seconds while Settings is open.
 */
function SoundAnalysisRow() {
  const on = useSettings((s) => s.soundAnalysis);
  const setOn = useSettings((s) => s.setSoundAnalysis);
  const [status, setStatus] = useState<SoundStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = (): void => {
      void window.bytune
        ?.soundStatus()
        .then((st) => {
          if (live) setStatus(st);
        })
        .catch(() => undefined);
    };
    read();
    const timer = window.setInterval(read, 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);
  const n = (v: number): string => v.toLocaleString("en-US");
  const progress = !status
    ? ""
    : !status.ffmpeg
      ? "needs FFmpeg"
      : !on
        ? ""
        : status.total === 0
          ? T("no local songs yet")
          : status.done >= status.total
            ? T("all {count} songs measured", { count: n(status.total) })
            : T("{done} of {total} songs measured", { done: n(status.done), total: n(status.total) });
  return (
    <SettingsRow
      icon={AudioLines}
      title={T("Sound analysis")}
      subtitle={T("Tempo, key and energy of each song, measured once in the background{value}", { value: progress ? ` — ${progress}` : "" })}
      trailing={<Switch checked={on} onChange={setOn} />}
      onClick={() => setOn(!on)}
    />
  );
}

const DISCORD_PORTAL = "https://discord.com/developers/applications";

/**
 * Discord status (electron/discord.ts): the switch, the Application ID it
 * needs — an application the user creates, whose name Discord shows — and
 * how the connection is doing, polled while the switch is on.
 */
function DiscordGroup() {
  const enabled = useSettings((s) => s.discordPresence);
  const clientId = useSettings((s) => s.discordClientId);
  const setEnabled = useSettings((s) => s.setDiscordPresence);
  const setClientId = useSettings((s) => s.setDiscordClientId);
  const [status, setStatus] = useState<DiscordStatus | null>(null);
  useEffect(() => {
    const bridge = window.bytune;
    if (!enabled || !bridge?.discordStatus) {
      setStatus(null);
      return;
    }
    let alive = true;
    const poll = (): void => {
      void bridge.discordStatus().then((s) => alive && setStatus(s)).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled, clientId]);

  const validId = /^\d{15,22}$/.test(clientId);
  const subtitle = !enabled
    ? T("Show the song playing now as your Discord status")
    : !validId
      ? T("Add your Application ID below to connect")
      : status?.state === "connected"
        ? `${status.user ? T("Connected as {user}", { user: status.user }) : T("Connected")} · ${status.message ?? T("shows while music plays")}`
        : status?.state === "unavailable"
          ? T("{message} — connects once Discord is open", { message: status.message ?? T("Discord isn't running") })
          : status?.state === "error"
            ? T("{message} — check the ID", { message: status.message ?? T("Discord refused the connection") })
            : T("Connecting to Discord…");

  return (
    <SettingsGroup
      header={T("Discord")}
      footer={T("Discord shows your application's name in “Listening to …”, so call it Songsta, for example. Only the Discord app on this computer gets the song title and artist; covers stay here.")}
    >
      <SettingsRow
        icon={Radio}
        title={T("Discord status")}
        subtitle={subtitle}
        trailing={<Switch checked={enabled} onChange={setEnabled} />}
        onClick={() => setEnabled(!enabled)}
      />
      {enabled && (
        <>
          <Divider />
          <SettingsRow
            icon={KeyRound}
            title={T("Application ID")}
            subtitle={T("From your application's General Information page")}
            trailing={
              <input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={T("e.g. 1234567890123456789")}
                inputMode="numeric"
                spellCheck={false}
                aria-label={T("Discord Application ID")}
                className={`w-56 h-9 px-3 rounded-lg bg-ink-hi/[0.05] border text-[13px] text-ink-hi tabular-nums placeholder:text-ink-faint outline-none focus:border-ink-hi/25 ${
                  clientId && !validId ? "border-red-400/60" : "border-ink-hi/10"
                }`}
              />
            }
          />
          <Divider />
          <SettingsRow
            icon={ExternalLink}
            title={T("Create an application")}
            subtitle={T("Discord Developer Portal → New Application → name it → copy its Application ID (free)")}
            onClick={() => window.open(DISCORD_PORTAL, "_blank")}
          />
        </>
      )}
    </SettingsGroup>
  );
}

const SYNC_LINE: Record<SyncStatus, string> = {
  off: T("The same playlists on all your devices, and pick up where you stopped"),
  connecting: T("Looking for the sync service…"),
  connected: T("Connected: playlists and where you stopped stay the same on all your devices"),
  unreachable: T("The sync service isn't answering. Is it running on your server?"),
  rejected: T("The sync service refused this login"),
};

/** Server sync — Liked Songs ↔ the servers' favorites, plays counted there
    too (lib/serverSync.ts). Shown with a server connected. An API-key login
    to Jellyfin belongs to no user, so it picks whose favorites and plays
    these are; until then Jellyfin sits out. */
function ServerSyncGroup() {
  const sync = useSettings((st) => st.serverSync);
  const plays = useSettings((st) => st.serverPlays);
  const setSync = useSettings((st) => st.setServerSync);
  const setPlays = useSettings((st) => st.setServerPlays);
  const syncPlaylists = useSettings((st) => st.syncPlaylists);
  const setSyncPlaylists = useSettings((st) => st.setSyncPlaylists);
  const syncStatus = useHomeSync((st) => st.status);
  const syncAddress = useHomeSync((st) => st.address);
  const customAddress = useHomeSync((st) => st.customAddress);
  const syncNeedsUser = useHomeSync((st) => st.needsUser);
  const openDialog = useUI((st) => st.openDialog);
  const toast = useUI((st) => st.toast);
  const [jf, setJf] = useState<JellyfinStatus | null>(null);
  const [navidrome, setNavidrome] = useState<SubsonicStatus | null>(null);
  useEffect(() => {
    const bridge = window.bytune;
    if (!bridge) return;
    let alive = true;
    void Promise.all([bridge.jellyfinStatus(), bridge.subsonicStatus()])
      .then(([j, s]) => {
        if (!alive) return;
        setJf(j as JellyfinStatus);
        setNavidrome(s as SubsonicStatus);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!jf?.connected && !navidrome?.connected) return null;

  const servers = [jf?.connected ? "Jellyfin" : null, navidrome?.connected ? "Navidrome" : null].filter(Boolean).join(" and ");
  const needsUser = !!jf?.connected && jf.apiKey && !jf.syncUserId;
  const pickUser = (e: React.MouseEvent): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ui = useUI.getState();
    const bridge = window.bytune;
    if (ui.contextMenu) {
      ui.closeContextMenu();
      return;
    }
    if (!bridge) return;
    void bridge
      .jellyfinUsers()
      .then((users) => {
        const items: MenuItem[] = users.map((u) => ({
          label: u.name,
          icon: Check,
          iconClassName: u.id === jf?.syncUserId ? "text-accent" : "opacity-0",
          action: () => {
            void bridge
              .jellyfinSetSyncUser(u.id)
              .then((status) => {
                refreshHomeSync();
                return status;
              })
              .then((s) => {
                setJf(s);
                void syncFavorites().catch(() => undefined);
              })
              .catch((err) => toast(err instanceof Error ? err.message : T("Couldn't save the user"), "error"));
          },
        }));
        ui.openContextMenu(rect.right, rect.bottom + 6, items, { alignRight: true });
      })
      .catch((err) => toast(err instanceof Error ? err.message : T("Couldn't list the Jellyfin users"), "error"));
  };

  const editSyncAddress = (): void => {
    openDialog({
      title: T("Sync service address"),
      body: T("Empty: on the same machine as your Jellyfin server, port 8196."),
      initialValue: customAddress,
      confirmLabel: T("Save"),
      onConfirm: (value) => {
        void window.bytune
          ?.homeSyncSetAddress(value)
          .then(() => refreshHomeSync())
          .catch((err) => toast(err instanceof Error ? err.message : T("That address doesn't work"), "error"));
      },
    });
  };

  return (
    <SettingsGroup
      header={T("Server sync")}
      footer={T("A like here becomes a favorite on {servers}, and a favorite set in another app (Finamp, Jellyfin Web, a Subsonic app) shows up in Liked Songs — taking one back works both ways too. A play counts there once you've heard half a song, at most 4 minutes.", { servers })}
    >
      <SettingsRow
        icon={Heart}
        title={T("Liked Songs ↔ favorites")}
        subtitle={!sync ? T("Keep Liked Songs and the {servers} favorites the same", { servers }) : needsUser ? T("Jellyfin waits for a user — choose one below") : T("Both ways with {servers}", { servers })}
        trailing={<Switch checked={sync} onChange={setSync} />}
        onClick={() => setSync(!sync)}
      />
      <Divider />
      <SettingsRow
        icon={BarChart3}
        title={T("Count plays on the server")}
        subtitle={T("Play counts and “last played” on {servers} include what you hear here", { servers })}
        trailing={<Switch checked={plays} onChange={setPlays} />}
        onClick={() => setPlays(!plays)}
      />
      {jf?.connected && (
        <>
          <Divider />
          <SettingsRow
            icon={ListMusic}
            title={T("Playlists and where you stopped")}
            subtitle={syncNeedsUser ? T("Waits for a user, chosen below") : syncPlaylists ? SYNC_LINE[syncStatus] : SYNC_LINE.off}
            trailing={<Switch checked={syncPlaylists} onChange={setSyncPlaylists} />}
            onClick={() => setSyncPlaylists(!syncPlaylists)}
          />
          {syncPlaylists && (
            <>
              <Divider />
              <SettingsRow
                icon={Link2}
                title={T("Sync service address")}
                subtitle={customAddress ? T("Entered by you") : T("On your Jellyfin server")}
                value={syncAddress ?? "—"}
                onClick={editSyncAddress}
              />
            </>
          )}
        </>
      )}
      {jf?.connected && jf.apiKey && (
        <>
          <Divider />
          <SettingsRow
            icon={UserRound}
            title={T("Jellyfin user")}
            subtitle={T("Signed in with an API key, which belongs to no user: whose favorites and plays these are")}
            value={jf.syncUserName ?? T("Choose…")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={pickUser}
          />
        </>
      )}
    </SettingsGroup>
  );
}

function SettingsRow({
  icon: Icon,
  title,
  subtitle,
  value,
  badge,
  disabled,
  onClick,
  onPointerDown,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  disabled?: boolean;
  /** receives the event so rows can anchor a dropdown to themselves */
  onClick?: (e: React.MouseEvent) => void;
  /** dropdown rows stop the press here — the open menu survives until the
      click, letting the same row toggle it closed (playbar "+" pattern) */
  onPointerDown?: (e: React.PointerEvent) => void;
  trailing?: ReactNode;
}) {
  const interactive = onClick && !disabled;
  return (
    <div
      onPointerDown={onPointerDown}
      onClick={interactive ? (e) => onClick(e) : undefined}
      className={`flex items-center min-h-[52px] py-3 ${ROW_INSET} ${
        interactive ? "cursor-pointer hover:bg-ink-hi/[0.04] active:bg-ink-hi/[0.07] transition-colors" : ""
      } ${disabled ? "opacity-45" : ""}`}
    >
      <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
      <div className="flex-1 min-w-0 ml-[14px]">
        <div className="flex items-center">
          <span className="text-[14px] text-ink-hi truncate">{title}</span>
          {badge && <Badge>{badge}</Badge>}
        </div>
        {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-3">
        {trailing ?? (
          <>
            {value && <span className="text-[14px] text-ink-dim">{value}</span>}
            {onClick && <Chevron />}
          </>
        )}
      </div>
    </div>
  );
}

/** Thumb width of the .slider CSS — the fill is computed so it ends exactly
    at the thumb's centre (the native input insets the thumb by half its
    width at both ends of the range). */
const SLIDER_THUMB_PX = 13;

function SliderRow({
  icon: Icon,
  title,
  subtitle,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
}) {
  const frac = max > min ? Math.min(1, Math.max(0, (current - min) / (max - min))) : 0;
  return (
    <div className={`${ROW_INSET} py-3`}>
      <div className="flex items-center">
        <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
        <div className="flex-1 min-w-0 ml-[14px]">
          <div className="text-[14px] text-ink-hi">{title}</div>
          {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5">{subtitle}</div>}
        </div>
        <span className="text-[14px] text-ink-dim ml-3 shrink-0">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider slider-dot w-full mt-3 ml-[36px]"
        style={
          {
            width: "calc(100% - 36px)",
            "--fill": `calc((100% - ${SLIDER_THUMB_PX}px) * ${frac} + ${SLIDER_THUMB_PX / 2}px)`,
          } as CSSProperties
        }
      />
    </div>
  );
}

const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1],
  Loudness: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
};

const bandLabel = (hz: number): string => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

const REPLAYGAIN_LABEL = { off: T("Off"), track: T("Per song"), album: T("Per album") } as const;
const TARGET_LABEL = { "-18": "−18 LUFS (ReplayGain)", "-14": T("−14 LUFS (like Spotify)"), "-11": T("−11 LUFS (loud)") } as const;

/** 10-band graphic EQ: switch, presets, one vertical slider per band (±12 dB). */
function EqualizerRows() {
  const enabled = useSettings((st) => st.eqEnabled);
  const gains = useSettings((st) => st.eqGains);
  const mode = useSettings((st) => st.eqMode);
  const peqName = useSettings((st) => st.peq.name);
  const { setEqEnabled, setEqGains, setEqMode } = useSettings.getState();
  const preset = Object.keys(EQ_PRESETS).find((k) => EQ_PRESETS[k].every((g, i) => g === gains[i]));
  return (
    <>
      <SettingsRow
        icon={SlidersVertical}
        title={T("Equalizer")}
        subtitle={
          !enabled ? T("10-band EQ, or a parametric EQ with AutoEQ headphone corrections") : mode === "parametric" ? T("Parametric, {peqName}", { peqName }) : T("10-band, {value}", { value: preset ?? T("Custom") })
        }
        trailing={<Switch checked={enabled} onChange={setEqEnabled} />}
        onClick={() => setEqEnabled(!enabled)}
      />
      {enabled && (
        <div className={`${TEXT_INSET} pr-4 pt-1`}>
          <div className="flex gap-1.5 mb-3">
            {(
              [
                ["graphic", "10-band"],
                ["parametric", T("Parametric · AutoEQ")],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setEqMode(key)}
                className={`text-[12px] rounded-full px-3 py-1 transition-colors ${
                  mode === key ? "bg-primary text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14]"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {enabled && mode === "parametric" && (
        <div className={`${TEXT_INSET} pr-4 pb-4`}>
          <ParametricEqEditor />
        </div>
      )}
      {enabled && mode === "graphic" && (
        <div className={`${TEXT_INSET} pr-4 pb-4`}>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {Object.keys(EQ_PRESETS).map((name) => (
              <button
                key={name}
                onClick={() => setEqGains(EQ_PRESETS[name])}
                className={`text-[12px] rounded-full px-3 py-1 transition-colors ${
                  name === preset ? "bg-primary text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14]"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
          <div className="flex justify-between gap-1 max-w-[520px]">
            {EQ_BANDS.map((hz, i) => (
              <label key={hz} className="flex flex-col items-center gap-1.5 min-w-0 flex-1">
                <span className="text-[11px] tabular-nums text-ink-dim">
                  {gains[i] > 0 ? `+${gains[i]}` : gains[i]}
                </span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={gains[i] ?? 0}
                  aria-label={T("{bandLabel} Hz", { bandLabel: bandLabel(hz) })}
                  onChange={(e) => setEqGains(gains.map((g, j) => (j === i ? Number(e.target.value) : g)))}
                  onDoubleClick={() => setEqGains(gains.map((g, j) => (j === i ? 0 : g)))}
                  className="h-[120px] w-5 accent-[rgb(var(--primary))] cursor-pointer"
                  style={{ writingMode: "vertical-lr", direction: "rtl" }}
                />
                <span className="text-[11px] text-ink-dim">{bandLabel(hz)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/* ============================================================ view */

/** Builds the option list for the quality dropdowns. Every row carries the
    check glyph — filled on the current value, invisible on the rest so the
    labels keep their alignment — and picking one commits it immediately. */
const CORNERS_LABEL: Record<Corners, string> = { round: T("Round"), soft: T("Soft"), square: T("Square") };
const ACCENT_LABEL: Record<Accent, string> = {
  violet: T("Violet"),
  blue: T("Blue"),
  teal: T("Teal"),
  green: T("Green"),
  amber: T("Amber"),
  coral: T("Coral"),
  pink: T("Pink"),
  white: T("White"),
};
/** Each accent drawn in its own colour on its menu row (whole class names, so Tailwind keeps them). */
const ACCENT_SWATCH: Record<Accent, string> = {
  violet: "fill-[#a78bfa] text-[#a78bfa]",
  blue: "fill-[#60a5fa] text-[#60a5fa]",
  teal: "fill-[#2dd4bf] text-[#2dd4bf]",
  green: "fill-[#4ade80] text-[#4ade80]",
  amber: "fill-[#fbbf24] text-[#fbbf24]",
  coral: "fill-[#fb7185] text-[#fb7185]",
  pink: "fill-[#f472b6] text-[#f472b6]",
  white: "fill-white text-white",
};
const ACCENT_PICKED: Record<Accent, string> = {
  violet: "fill-[#a78bfa]/25 text-[#a78bfa]",
  blue: "fill-[#60a5fa]/25 text-[#60a5fa]",
  teal: "fill-[#2dd4bf]/25 text-[#2dd4bf]",
  green: "fill-[#4ade80]/25 text-[#4ade80]",
  amber: "fill-[#fbbf24]/25 text-[#fbbf24]",
  coral: "fill-[#fb7185]/25 text-[#fb7185]",
  pink: "fill-[#f472b6]/25 text-[#f472b6]",
  white: "fill-white/25 text-white",
};

/** The accent presets, each a dot of its colour; the current one is checked. */
function accentMenu(current: Accent, onPick: (a: Accent) => void): MenuItem[] {
  return (Object.keys(ACCENT_LABEL) as Accent[]).map((a) => ({
    label: ACCENT_LABEL[a],
    icon: a === current ? CircleCheck : Circle,
    iconClassName: a === current ? ACCENT_PICKED[a] : ACCENT_SWATCH[a],
    action: () => onPick(a),
  }));
}

function qualityMenu<T extends string>(
  order: T[],
  labels: Record<T, string>,
  current: T,
  onPick: (q: T) => void,
): MenuItem[] {
  return order.map((q) => ({
    label: labels[q],
    icon: Check,
    iconClassName: q === current ? "text-accent" : "opacity-0",
    action: () => onPick(q),
  }));
}

/** Opens the row's dropdown, right-aligned under the row's value — and
    toggles it closed when one is already open. Same contract as the playbar
    "+": the row's pointerdown keeps an open menu alive until this click (see
    SettingsRow's onPointerDown), so the click itself can close it. */
function toggleDropdownAt(e: React.MouseEvent, items: MenuItem[]): void {
  e.stopPropagation();
  const ui = useUI.getState();
  if (ui.contextMenu) {
    ui.closeContextMenu();
    return;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  ui.openContextMenu(rect.right, rect.bottom + 6, items, { alignRight: true });
}

/** Output device — routes playback to a specific speaker/headset via
    setSinkId. Chromium hides device labels until the page has held capture
    permission once, so the first menu open asks for it on explicit intent;
    failure degrades to generic "Speaker N" names. */
function OutputDeviceGroup() {
  const sinkId = useSettings((st) => st.audioSinkId);
  const [devices, setDevices] = useState<OutputDeviceChoice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void listOutputDevices().then((list) => {
        if (alive) setDevices(list);
      });
    };
    refresh();
    // Plugging or unplugging a device must update the row and the menu live.
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.("devicechange", refresh);
    };
  }, []);
  const current = devices?.find((d) => d.deviceId === sinkId);
  // Where sound is going RIGHT NOW: the pinned device, or — when following
  // the system default — whichever physical endpoint the OS currently routes
  // "default" to. Resolving this is what makes the row move when Windows
  // hands the default to a newly connected headset.
  const active = devices?.find((d) => d.deviceId !== "" && d.activeDefault);
  const value = sinkId ? (current?.label ?? T("System default")) : active ? active.label : T("System default");
  const itemsFor = (list: OutputDeviceChoice[]): MenuItem[] =>
    list.map((d) => ({
      label: d.deviceId === "" && active ? T("System default — {label}", { label: active.label }) : d.label,
      icon: Check,
      iconClassName: d.deviceId === sinkId ? "text-accent" : "opacity-0",
      action: () => useSettings.getState().setAudioSinkId(d.deviceId),
    }));
  return (
    <SettingsGroup
      header={T("Audio output")}
      footer={T("Playback follows the device you pick. If it disappears (headset unplugged, Bluetooth dropped), playback pauses and the setting falls back to the system default.")}
    >
      <SettingsRow
        icon={Speaker}
        title={T("Output device")}
        subtitle={sinkId ? T("Pinned to this device") : T("Following the system default")}
        value={devices ? value : T("System default")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          // Same toggle contract as the quality rows: a click on the row
          // closes the open menu; otherwise the list resolves (async) and the
          // menu opens anchored to the row. The rect is captured
          // synchronously — React nulls currentTarget after the handler.
          const rect = e.currentTarget.getBoundingClientRect();
          const ui = useUI.getState();
          if (ui.contextMenu) {
            ui.closeContextMenu();
            return;
          }
          void listOutputDevices().then((list) => {
            setDevices(list);
            ui.openContextMenu(rect.right, rect.bottom + 6, itemsFor(list), { alignRight: true });
          });
        }}
      />
    </SettingsGroup>
  );
}

/** The interface's language: it follows the system unless chosen here. A change reloads the window. */
function LanguageRow() {
  const choice = storedLanguageChoice();
  const pick = (next: LanguageChoice): void => {
    if (next === choice) return;
    storeLanguageChoice(next);
    window.location.reload();
  };
  return (
    <SettingsRow
      icon={Languages}
      title={T("Language")}
      subtitle={choice === "auto" ? T("Follow the system") : undefined}
      trailing={
        <select
          aria-label={T("Language")}
          value={choice}
          onChange={(e) => pick(e.target.value as LanguageChoice)}
          className="h-9 rounded-lg bg-ink-hi/[0.08] px-3 text-[13px] font-semibold text-ink-hi outline-none"
        >
          <option value="auto">{T("Automatic")}</option>
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      }
    />
  );
}

/** A small button at the end of a row, looking like the language picker. */
function RowButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onPress();
      }}
      className="h-9 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] px-3 text-[13px] font-semibold text-ink-hi whitespace-nowrap transition-colors"
    >
      {label}
    </button>
  );
}

/** The top of Settings while a new version is around: what there is to do about it, depending on how far it's come. */
function UpdateGroup() {
  const update = useAppUpdate();
  const newer = useNewerVersion();
  const version = update.version || newer;
  const current = window.bytune?.versions.app ?? "";
  if (!version) return null;
  if (update.phase === "ready") {
    return (
      <SettingsGroup>
        <SettingsRow
          icon={Download}
          title={T("Songsta {version} is ready", { version })}
          subtitle={T("It installs when you close Songsta.")}
          trailing={<RowButton label={T("Restart now")} onPress={installUpdate} />}
        />
      </SettingsGroup>
    );
  }
  if (update.phase === "downloading") {
    return (
      <SettingsGroup>
        <SettingsRow
          icon={Download}
          title={T("Downloading Songsta {version}", { version })}
          subtitle={T("{percent}% downloaded", { percent: update.percent })}
          trailing={
            <div className="w-24 h-1 rounded-full bg-ink-hi/[0.12] overflow-hidden" role="progressbar" aria-valuenow={update.percent} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${update.percent}%` }} />
            </div>
          }
        />
      </SettingsGroup>
    );
  }
  if (update.phase === "failed") {
    return (
      <SettingsGroup>
        <SettingsRow
          icon={Download}
          title={T("Couldn't update to Songsta {version}", { version })}
          subtitle={T("Try again, or get it from the download page.")}
          trailing={
            <div className="flex items-center gap-2">
              <RowButton label={T("Download page")} onPress={openReleasePage} />
              <RowButton label={T("Try again")} onPress={startUpdate} />
            </div>
          }
        />
      </SettingsGroup>
    );
  }
  if (update.canInstall) {
    return (
      <SettingsGroup>
        <SettingsRow
          icon={Download}
          title={T("Songsta {version} is out", { version })}
          subtitle={T("You have {version}.", { version: current })}
          trailing={<RowButton label={T("Update")} onPress={startUpdate} />}
        />
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup>
      <SettingsRow
        icon={Download}
        title={T("Songsta {version} is out", { version })}
        subtitle={T("You have {version}. This opens the download page.", { version: current })}
        trailing={<ExternalLink className="w-4 h-4 text-ink-dim" />}
        onClick={openReleasePage}
      />
    </SettingsGroup>
  );
}

function LookForUpdatesRow() {
  const [looking, setLooking] = useState(false);
  return (
    <SettingsRow
      icon={RefreshCw}
      title={T("Look for updates")}
      subtitle={looking ? T("Looking…") : T("You have Songsta {version}", { version: window.bytune?.versions.app ?? "" })}
      disabled={looking}
      onClick={() => {
        setLooking(true);
        void lookNow().finally(() => setLooking(false));
      }}
    />
  );
}

export function SettingsView() {
  const s = useSettings();
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const versions = window.bytune?.versions;
  const canSelfUpdate = useAppUpdate((u) => u.canInstall);
  const [folderSummary, setFolderSummary] = useState<string | null>(null);

  const refreshFolderSummary = async (): Promise<void> => {
    const lib = await window.bytune?.localLibrary();
    const n = lib?.folders?.length ?? 0;
    setFolderSummary(n === 0 ? T("No folders imported yet") : T("{n} folders imported", { n }));
  };

  useEffect(() => {
    void refreshFolderSummary();
  }, []);

  const chooseMusicFolder = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (!dir) return;
      toast(T("Importing folder…"), "info");
      const res = await window.bytune.addLibraryFolders([dir]);
      if (res.added.length === 0) {
        setFolderSummary(T("{n} folders imported", { n: res.lib.folders.length }));
        toast(T("That folder is already in your library"), "info");
        return;
      }
      s.setLocalMusicFolder(dir);
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      setFolderSummary(`${res.lib.folders.length} folder${res.lib.folders.length === 1 ? "" : "s"} imported`);
      toast(T("Local library scanned"), "success");
    } catch {
      toast(T("Couldn't import that folder"), "error");
    }
  };

  const rescanMusic = async (): Promise<void> => {
    if (!window.bytune) return;
    const lib = await window.bytune.localLibrary();
    if (!lib?.folders?.length) {
      toast(T("Import a local folder first"), "info");
      return;
    }
    toast(T("Rescanning local library…"), "info");
    try {
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      toast(T("Local library updated"), "success");
    } catch {
      toast(T("Rescan failed"), "error");
    }
  };

  const exportData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupExport();
      if (res?.path) toast(T("Backup saved"), "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : T("Export failed"), "error");
    }
  };

  const importData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupImport();
      if (res?.restored) {
        toast(
          T("Backup restored{value}. Reloading…", { value: typeof res.months === "number" && res.months > 0 ? T(" ({months} months of history)", { months: res.months }) : "" }),
          "success"
        );
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : T("Import failed"), "error");
    }
  };

  const resetAppData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      // Main-process wipe: every store, history buckets and derived caches.
      // Downloaded audio files are the user's files and stay on disk.
      await window.bytune.resetData();
      window.location.reload();
    } catch {
      toast(T("Couldn't reset app data"), "error");
    }
  };

  return (
    <div className="max-w-2xl pb-14">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi px-1 pt-2 pb-3.5">{T("Settings")}</h1>

      <UpdateGroup />

      <SettingsGroup
        header={T("Library sources")}
        footer={T("Covers your files lack, album names and artist bios come from open databases: MusicBrainz, Cover Art Archive, iTunes Search and Wikipedia/Wikidata. Answers are cached on this device.")}
      >
        <SettingsRow
          icon={FolderOpen}
          title={T("Local Music")}
          subtitle={T("Folders on this device")}
          onClick={() => useUI.getState().navigate({ name: "local" })}
        />
        <Divider />
        <SettingsRow
          icon={Server}
          title={T("Jellyfin")}
          subtitle={T("Your own media server")}
          onClick={() => useUI.getState().navigate({ name: "jellyfin" })}
        />
        <Divider />
        <SettingsRow
          icon={Disc3}
          title={T("Navidrome")}
          subtitle={T("Navidrome or any Subsonic server")}
          onClick={() => useUI.getState().navigate({ name: "subsonic" })}
        />
        <Divider />
        <SettingsRow
          icon={FileUp}
          title={T("Import from Spotify")}
          subtitle={T("Your Liked Songs: which you have, which to buy")}
          onClick={() => useUI.getState().navigate({ name: "spotify" })}
        />
        <Divider />
        <SettingsRow
          icon={ShoppingBag}
          title={T("Shop links for missing songs")}
          subtitle={T("In the Spotify import's “to buy” list: searches on Qobuz, Bandcamp, 7digital and Amazon")}
          trailing={<Switch checked={s.storeLinks} onChange={s.setStoreLinks} />}
          onClick={() => s.setStoreLinks(!s.storeLinks)}
        />
        <Divider />
        <SettingsRow
          icon={FolderSync}
          title={T("Watch folders")}
          subtitle={T("New, changed and deleted files show up without rescanning")}
          trailing={<Switch checked={s.watchFolders} onChange={s.setWatchFolders} />}
          onClick={() => s.setWatchFolders(!s.watchFolders)}
        />
        <Divider />
        <FfmpegRow />
        <Divider />
        <SoundAnalysisRow />
        <Divider />
        <SettingsRow
          icon={ListChecks}
          title={T("Library check")}
          subtitle={T("Artists written different ways, albums in parts, songs you have twice, missing covers")}
          onClick={() => useUI.getState().navigate({ name: "check" })}
        />
      </SettingsGroup>

      <ServerSyncGroup />

      <OutputDeviceGroup />

      <SettingsGroup header={T("Playback")}>
        {!s.smartFade && (
          <>
            <SliderRow
              icon={Activity}
              title={T("Crossfade")}
              subtitle={T("Blend the end of one track into the next")}
              value={s.crossfadeSeconds === 0 ? T("Off") : `${s.crossfadeSeconds}s`}
              min={0}
              max={12}
              step={1}
              current={s.crossfadeSeconds}
              onChange={s.setCrossfadeSeconds}
            />
            <Divider />
            {s.crossfadeSeconds === 0 && (
              <>
                <SettingsRow
                  icon={AudioLines}
                  title={T("Gapless playback")}
                  subtitle={
                    s.skipSilence ? T("Off while Skip silence trims the song ends") : T("The next song starts the moment this one ends — live albums and soundtracks run on")
                  }
                  trailing={<Switch checked={s.gapless} onChange={s.setGapless} />}
                  onClick={() => s.setGapless(!s.gapless)}
                />
                <Divider />
              </>
            )}
          </>
        )}
        <SettingsRow
          icon={Sparkles}
          title={T("Automix")}
          subtitle={s.smartFade ? T("Enabled: transitions decided per track pair") : T("Disabled: uses the crossfade above")}
          trailing={<Switch checked={s.smartFade} onChange={s.setSmartFade} />}
          onClick={() => s.setSmartFade(!s.smartFade)}
        />
        <Divider />
        <SettingsRow
          icon={InfinityIcon}
          title={T("Seamless albums")}
          subtitle={T("Live albums, DJ mixes and songs that run into each other play on without a gap or a crossfade")}
          trailing={<Switch checked={s.seamlessAlbums} onChange={s.setSeamlessAlbums} />}
          onClick={() => s.setSeamlessAlbums(!s.seamlessAlbums)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title={T("Skip silence")}
          subtitle={T("Jump over silent intros and gaps")}
          trailing={<Switch checked={s.skipSilence} onChange={s.setSkipSilence} />}
          onClick={() => s.setSkipSilence(!s.skipSilence)}
        />
        <Divider />
        <SettingsRow
          icon={InfinityIcon}
          title={T("Autoplay")}
          subtitle={T("Keep the music going when the queue ends")}
          trailing={<Switch checked={s.autoplay} onChange={s.setAutoplay} />}
          onClick={() => s.setAutoplay(!s.autoplay)}
        />
        <Divider />
        <SettingsRow
          icon={Repeat}
          title={T("Skipping ends repeat one")}
          subtitle={T("Go to another song while one is on repeat, and the whole list repeats from there")}
          trailing={<Switch checked={s.skipEndsRepeatOne} onChange={s.setSkipEndsRepeatOne} />}
          onClick={() => s.setSkipEndsRepeatOne(!s.skipEndsRepeatOne)}
        />
        <Divider />
        <SettingsRow
          icon={Power}
          title={T("Switch receivers off afterwards")}
          subtitle={T("Denon and Marantz go off 30 seconds after the music has left them, unless you stop it or they're doing something else")}
          trailing={<Switch checked={s.switchOffDevices} onChange={s.setSwitchOffDevices} />}
          onClick={() => s.setSwitchOffDevices(!s.switchOffDevices)}
        />
        <Divider />
        <SliderRow
          icon={Gauge}
          title={T("Playback speed")}
          subtitle={T("Pitch-preserving tempo for everything you play")}
          value={`${s.playbackSpeed.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`}
          min={0.5}
          max={2}
          step={0.05}
          current={s.playbackSpeed}
          onChange={s.setPlaybackSpeed}
        />
        <Divider />
        <SettingsRow
          icon={Gauge}
          title={T("Volume leveling")}
          subtitle={T("ReplayGain — songs play at the same loudness, their dynamics untouched")}
          value={REPLAYGAIN_LABEL[s.replayGainMode]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) =>
            toggleDropdownAt(e, qualityMenu(["off", "track", "album"], REPLAYGAIN_LABEL, s.replayGainMode, s.setReplayGainMode))
          }
        />
        {s.replayGainMode !== "off" && (
          <>
            <Divider />
            <SettingsRow
              icon={Volume2}
              title={T("Leveling target")}
              subtitle={T("Loud songs are turned down to it; quieter ones are never boosted, so nothing clips")}
              value={TARGET_LABEL[String(s.replayGainTarget) as keyof typeof TARGET_LABEL] ?? `${s.replayGainTarget} LUFS`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) =>
                toggleDropdownAt(
                  e,
                  qualityMenu(["-18", "-14", "-11"] as const, TARGET_LABEL, String(s.replayGainTarget) as "-18" | "-14" | "-11", (v) =>
                    s.setReplayGainTarget(Number(v))
                  )
                )
              }
            />
          </>
        )}
        <Divider />
        <EqualizerRows />
      </SettingsGroup>

      <SettingsGroup header={T("Appearance")}>
        <LanguageRow />
        <Divider />
        <SettingsRow
          icon={Squircle}
          title={T("Corners")}
          subtitle={T("How round panels, cards and menus are")}
          value={CORNERS_LABEL[s.corners]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => toggleDropdownAt(e, qualityMenu(["round", "soft", "square"], CORNERS_LABEL, s.corners, s.setCorners))}
        />
        <Divider />
        <SettingsRow
          icon={Palette}
          title={T("Accent")}
          subtitle={T("The colour of what's playing, what's on, likes and the main buttons")}
          value={ACCENT_LABEL[s.accent]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => toggleDropdownAt(e, accentMenu(s.accent, s.setAccent))}
        />
        <Divider />
        <SettingsRow
          icon={AppWindow}
          title={T("Reduce animation")}
          subtitle={T("Cut crossfades and motion through the app")}
          trailing={<Switch checked={s.reduceAnimation} onChange={s.setReduceAnimation} />}
          onClick={() => s.setReduceAnimation(!s.reduceAnimation)}
        />
        <Divider />
        <SettingsRow
          icon={Droplets}
          title={T("Reduce dynamic blur")}
          subtitle={T("Fill glass surfaces solid instead of blurring")}
          trailing={<Switch checked={s.reduceDynamicBlur} onChange={s.setReduceDynamicBlur} />}
          onClick={() => s.setReduceDynamicBlur(!s.reduceDynamicBlur)}
        />
        <Divider />
        <SettingsRow
          icon={Sparkles}
          title={T("Liquid glass")}
          subtitle={T("Refractive glass on the floating chrome")}
          trailing={<Switch checked={s.liquidGlass} onChange={s.setLiquidGlass} disabled={s.reduceDynamicBlur} />}
          onClick={() => s.setLiquidGlass(!s.liquidGlass)}
        />
        <Divider />
        <SettingsRow
          icon={Maximize2}
          title={T("Full-screen cover art")}
          subtitle={T("Let the artwork bleed behind the status area")}
          trailing={<Switch checked={s.fullBleedArtwork} onChange={s.setFullBleedArtwork} />}
          onClick={() => s.setFullBleedArtwork(!s.fullBleedArtwork)}
        />
        <Divider />
        <SettingsRow
          icon={Image}
          title={T("Legacy mesh gradient")}
          subtitle={T("Use the older drifting-blob player backdrop")}
          trailing={<Switch checked={s.legacyMeshGradient} onChange={s.setLegacyMeshGradient} />}
          onClick={() => s.setLegacyMeshGradient(!s.legacyMeshGradient)}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title={T("Animated cover art")}
          subtitle={T("Play canvas clips in place of the still cover")}
          trailing={<Switch checked={s.animatedCanvas} onChange={s.setAnimatedCanvas} />}
          onClick={() => s.setAnimatedCanvas(!s.animatedCanvas)}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title={T("Synced lyrics")}
          subtitle={T("Highlight the current line and auto-scroll")}
          trailing={<Switch checked={s.syncedLyrics} onChange={s.setSyncedLyrics} />}
          onClick={() => s.setSyncedLyrics(!s.syncedLyrics)}
        />
        {s.syncedLyrics && (
          <>
            <Divider />
            <SettingsRow
              icon={Droplets}
              title={T("Blur unfocused lyrics")}
              subtitle={T("Keep the spotlight on the current line")}
              trailing={<Switch checked={s.blurUnfocusedLyrics} onChange={s.setBlurUnfocusedLyrics} />}
              onClick={() => s.setBlurUnfocusedLyrics(!s.blurUnfocusedLyrics)}
            />
          </>
        )}
        <Divider />
        <SettingsRow
          icon={Languages}
          title={T("Cyrillic in Latin letters")}
          subtitle={T("A Latin line under each line of Russian, Ukrainian or other Cyrillic lyrics")}
          trailing={<Switch checked={s.lyricsLatin} onChange={s.setLyricsLatin} />}
          onClick={() => s.setLyricsLatin(!s.lyricsLatin)}
        />
      </SettingsGroup>

      <SettingsGroup header={T("Local music")}>
        <SettingsRow
          icon={FolderOpen}
          title={T("Local music folders")}
          subtitle={folderSummary ?? T("Your imported collections")}
          onClick={() => useUI.getState().navigate({ name: "local" })}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title={T("Add a folder")}
          subtitle={T("Import music folders — a parent folder brings its music subfolders along")}
          onClick={() => void chooseMusicFolder()}
        />
        <Divider />
        <SettingsRow
          icon={RefreshCw}
          title={T("Rescan library")}
          subtitle={T("Re-read tags and artwork from every imported folder")}
          onClick={() => void rescanMusic()}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title={T("Filter non-music audio")}
          subtitle={T("Hide clips, recordings and voice notes (applies on rescan)")}
          trailing={<Switch checked={s.filterNonMusicAudio} onChange={(v) => { s.setFilterNonMusicAudio(v); void rescanMusic(); }} />}
          onClick={() => { s.setFilterNonMusicAudio(!s.filterNonMusicAudio); void rescanMusic(); }}
        />
      </SettingsGroup>

      <DiscordGroup />

      <SettingsGroup header={T("Your data")}>
        <SettingsRow
          icon={BarChart3}
          title={T("Replay")}
          subtitle={T("Your listening over time, and every listen — kept on this computer")}
          onClick={() => useUI.getState().navigate({ name: "replay" })}
        />
        <Divider />
        <SettingsRow
          icon={FileUp}
          title={T("Export data")}
          subtitle={T("Write a backup of your library and history")}
          onClick={() => void exportData()}
        />
        <Divider />
        <SettingsRow
          icon={FileDown}
          title={T("Import data")}
          subtitle={T("Restore a backup, replacing what's here")}
          onClick={() =>
            openDialog({
              title: T("Import a backup?"),
              body: T("Your current library, playlists and history will be replaced by the backup's."),
              confirmLabel: T("Choose file"),
              danger: true,
              onConfirm: () => void importData(),
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup header={T("Updates")} footer={T("Asking GitHub once a day which version is the newest is all that goes out for this. With both off, not even that.")}>
        <LookForUpdatesRow />
        {canSelfUpdate && (
          <>
            <Divider />
            <SettingsRow
              icon={Download}
              title={T("Automatic updates")}
              subtitle={T("Fetches new versions in the background. They install when you close Songsta.")}
              trailing={<Switch checked={s.autoUpdate} onChange={s.setAutoUpdate} />}
              onClick={() => s.setAutoUpdate(!s.autoUpdate)}
            />
          </>
        )}
        <Divider />
        <SettingsRow
          icon={Sparkles}
          title={T("Tell me about new versions")}
          subtitle={T("A short note and a dot on the settings button when one is out")}
          trailing={<Switch checked={s.checkNewVersion} onChange={s.setCheckNewVersion} />}
          onClick={() => s.setCheckNewVersion(!s.checkNewVersion)}
        />
      </SettingsGroup>

      <SettingsGroup
        header={T("Miscellaneous")}
        footer={T("These apply to this desktop client and are stored locally.")}
      >
        <SettingsRow
          icon={ListMusic}
          title={T("Don't repeat suggestions")}
          subtitle={T("Keep recently played tracks out of autoplay")}
          trailing={<Switch checked={s.dontRepeatSuggestions} onChange={s.setDontRepeatSuggestions} />}
          onClick={() => s.setDontRepeatSuggestions(!s.dontRepeatSuggestions)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title={T("Hide volume bar")}
          subtitle={T("Keep the player bar free of the volume slider")}
          trailing={<Switch checked={s.hideVolumeBar} onChange={s.setHideVolumeBar} />}
          onClick={() => s.setHideVolumeBar(!s.hideVolumeBar)}
        />
      </SettingsGroup>



      <SettingsGroup header={T("Danger zone")}>
        <SettingsRow
          icon={Trash2}
          title={T("Reset app data")}
          subtitle={T("Erase library, playlists, history and settings on this device")}
          onClick={() =>
            openDialog({
              title: T("Reset app data?"),
              body: T("Your library, playlists, history and settings on this device will be erased. This can't be undone. Your music files aren't touched."),
              confirmLabel: T("Reset app data"),
              danger: true,
              onConfirm: () => void resetAppData(),
            })
          }
        />
      </SettingsGroup>

      <div className="text-center text-[11px] text-ink-dim/80 pt-6 px-1 leading-relaxed">{T("Songsta {value} · GPL-3.0 · based on ByTune by rishiteja21", { value: versions?.app ?? "1.0.0" })}</div>
    </div>
  );
}