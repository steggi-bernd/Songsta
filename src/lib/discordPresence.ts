/**
 * The Discord status follows playback while it is turned on in Settings: the
 * song, its artist and how far into it we are. An update goes out on a song
 * change, play/pause, and whenever the clock Discord counts with drifts off
 * by more than 2 s (a seek, a stall, a speed change) — not per position tick.
 * Paused or stopped, the status is cleared, as Spotify's is. The main
 * process holds the connection to Discord, finds the album's cover in the
 * open databases and spaces the updates out.
 *
 * While this computer follows another device (one stream, lib/homeSync.ts),
 * the player here shows that device's song, so the status does too: with
 * Songsta running here, music from the phone shows as well.
 */
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";

const DRIFT_MS = 2000;

/**
 * Songsta's own Discord application, so nobody needs one of their own: its name is what
 * Discord shows ("Listening to Songsta"). An Application ID isn't a secret, only a name tag;
 * an ID of the user's own in Settings wins.
 */
export const SONGSTA_DISCORD_APP_ID = "1569032465333485688";

/** The application the status goes out under. */
export const discordAppId = (own: string): string => own || SONGSTA_DISCORD_APP_ID;

/** Mount once (App). */
export function watchDiscordPresence(): () => void {
  const bridge = window.bytune;
  if (!bridge?.discordConfigure) return () => undefined;

  /** what was sent last: song + length, "" = cleared, null = nothing yet */
  let shown: string | null = null;
  let shownStart = 0;

  const push = (): void => {
    const settings = useSettings.getState();
    const p = usePlayer.getState();
    const track = p.queue[p.index];
    if (!settings.discordPresence || !track || !p.playing) {
      if (shown !== "") {
        shown = "";
        bridge.discordActivity(null);
      }
      return;
    }
    // Discord counts in wall-clock time: at another speed a song takes longer or shorter.
    const rate = settings.playbackSpeed > 0 ? settings.playbackSpeed : 1;
    const length = p.duration > 0 ? p.duration : track.duration;
    const startedAt = Math.round(Date.now() - (p.position * 1000) / rate);
    const key = `${track.id}|${length > 0 ? Math.round(length) : 0}|${settings.discordButton}`;
    if (key === shown && Math.abs(startedAt - shownStart) < DRIFT_MS) return;
    shown = key;
    shownStart = startedAt;
    bridge.discordActivity({
      title: track.title,
      artist: track.artist,
      album: track.album ?? "",
      albumArtist: track.albumArtist ?? "",
      button: settings.discordButton,
      startedAt,
      endsAt: length > 0 ? Math.round(startedAt + (length * 1000) / rate) : 0,
    });
  };

  const configure = (): void => {
    const s = useSettings.getState();
    void bridge.discordConfigure(s.discordPresence, discordAppId(s.discordOwnAppId)).catch(() => undefined);
    shown = null;
    push();
  };

  configure();
  const offSettings = useSettings.subscribe((s, prev) => {
    if (s.discordPresence !== prev.discordPresence || s.discordOwnAppId !== prev.discordOwnAppId) configure();
    else if (s.playbackSpeed !== prev.playbackSpeed || s.discordButton !== prev.discordButton) push();
  });
  const offPlayer = usePlayer.subscribe((s, prev) => {
    if (
      s.playing !== prev.playing ||
      s.index !== prev.index ||
      s.queue[s.index]?.id !== prev.queue[prev.index]?.id ||
      s.position !== prev.position ||
      s.duration !== prev.duration
    ) {
      push();
    }
  });
  return () => {
    offSettings();
    offPlayer();
  };
}
