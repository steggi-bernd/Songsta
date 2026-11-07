/** Everything that can be chosen: the music on this phone, the server, how it plays and feels, downloads, sync. */
import { useNavigation } from "@react-navigation/native";
import { Check, ChevronLeft, ChevronRight, FolderPlus, Link2, LogOut, RefreshCw, Server, SlidersHorizontal, Trash2, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { APP_VERSION, installPhoneUpdate, lookNow, openReleasePage, updatePhone, useNewerVersion, usePhoneUpdate } from "../newVersion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Reach } from "../addresses";
import Player from "../../modules/media3-player";
import type { Leveling, QualityMode } from "../quality";
import { NameDialog } from "../components/PlaylistSheets";
import { Chip } from "../components/ui";
import { plural, type SyncStatus } from "../shared";
import { useConnection } from "../stores/connection";
import { sizeLine, useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { useLocalMusic } from "../stores/localMusic";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { showDialog } from "../stores/popups";
import { useSession } from "../stores/session";
import { ACCENTS, useSettings, type Accent, feel } from "../stores/settings";
import { LANGUAGES, type LanguageChoice } from "../shared";
import { syncAddress, useSync } from "../sync";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

const SYNC_LINE: Record<SyncStatus, string> = {
  off: T("Off"),
  connecting: T("Looking for it…"),
  connected: T("Connected"),
  unreachable: T("Not found. Is it running there?"),
  rejected: T("It refused this login"),
};

const LEVELS: { value: Leveling; label: string; line: string }[] = [
  { value: "off", label: T("Off"), line: T("Every song as loud as it was mastered") },
  { value: "quiet", label: T("Quiet"), line: T("Loud songs come down to about −18 LUFS") },
  { value: "normal", label: T("Normal"), line: T("Loud songs come down to about −14 LUFS, as on Spotify") },
  { value: "loud", label: T("Loud"), line: T("Loud songs come down to about −11 LUFS") },
];

const QUALITIES: { value: QualityMode; label: string; line: string }[] = [
  { value: "auto", label: T("Automatic"), line: T("The best your connection carries, on mobile data up to AAC 256 kbps") },
  { value: "original", label: T("Original"), line: T("Always the file itself, nothing converted") },
  { value: "compact", label: T("Compact"), line: T("A small copy, 128 kbps, that saves data") },
];

const FADES = [0, 3, 6, 9, 12];
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

/** A switch with what it's about. */
/** What there is to do about a new version, depending on how far it's come. */
function UpdateRows({ newer }: { newer: string | null }) {
  const update = usePhoneUpdate();
  const version = update.version || newer;
  if (!version) return null;
  const accent = [styles.rowTitle, { color: colors.accent }];
  return (
    <>
      {update.phase === "ready" ? (
        <Pressable onPress={installPhoneUpdate} style={styles.row}>
          <Text style={accent}>{T("Songsta {version} is ready", { version })}</Text>
          <Text style={styles.rowSub}>{T("Press to install. Android asks once more.")}</Text>
        </Pressable>
      ) : update.phase === "downloading" ? (
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Downloading Songsta {version}", { version })}</Text>
          <Text style={styles.rowSub}>{T("{percent}% downloaded", { percent: update.percent })}</Text>
        </View>
      ) : update.phase === "failed" ? (
        <>
          <Pressable onPress={() => void updatePhone()} style={styles.row}>
            <Text style={styles.rowTitle}>{T("Couldn't update to Songsta {version}", { version })}</Text>
            <Text style={styles.rowSub}>{T("Press to try again.")}</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable onPress={openReleasePage} style={styles.row}>
            <Text style={styles.rowTitle}>{T("Download page")}</Text>
          </Pressable>
        </>
      ) : (
        <Pressable onPress={() => void updatePhone()} style={styles.row}>
          <Text style={accent}>{T("Songsta {version} is out", { version })}</Text>
          <Text style={styles.rowSub}>{T("You have {version}. Press to update.", { version: APP_VERSION })}</Text>
        </Pressable>
      )}
      <View style={styles.divider} />
    </>
  );
}

function SwitchRow({ title, line, value, onChange }: { title: string; line?: string; value: boolean; onChange: (on: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {!!line && <Text style={styles.rowSub}>{line}</Text>}
      </View>
      <Switch
        accessibilityLabel={title}
        value={value}
        onValueChange={(on) => {
          feel("tick");
          onChange(on);
        }}
        trackColor={{ true: colors.accent }}
        thumbColor={colors.ink}
      />
    </View>
  );
}

const REACH_LINE: Record<Reach, string> = {
  home: T("Connected at home"),
  away: T("Connected from away"),
  offline: T("Out of reach. Downloaded music plays."),
};

export function SettingsScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const session = useSession((s) => s.session);
  const signOut = useSession((s) => s.signOut);
  const setAddress = useSession((s) => s.setAddress);
  const reach = useConnection((s) => s.reach);
  const count = useLibrary((s) => s.data.tracks.length);
  const refreshing = useLibrary((s) => s.refreshing);
  const refresh = useLibrary((s) => s.refresh);
  const clear = useLibrary((s) => s.clear);
  const stop = usePlayer((s) => s.stop);
  const syncStatus = useSync((s) => s.status);
  const customAddress = useSync((s) => s.customAddress);
  const setCustomAddress = useSync((s) => s.setCustomAddress);
  const kept = useDownloads((s) => s.kept);
  const waitingForWifi = useDownloads((s) => Object.values(s.loading).filter((song) => song.wantsWifi).length);
  const quality = useDownloads((s) => s.quality);
  const overMobile = useDownloads((s) => s.overMobile);
  const keep24Bit = usePlayer((s) => s.keep24Bit);
  const leveling = usePlayer((s) => s.leveling);
  const lastProblem = useDownloads((s) => s.lastProblem);
  const failedCount = useDownloads((s) => Object.values(s.loading).filter((song) => song.failed).length);
  const loadingCount = useDownloads((s) => Object.values(s.loading).filter((song) => !song.failed).length);
  const settings = useSettings();
  const change = settings.change;
  const newer = useNewerVersion();
  const streaming = usePlayer((s) => s.quality);
  const folders = useLocalMusic((s) => s.folders);
  const onPhone = useLibrary((s) => s.data.tracks.filter((t) => t.localPath).length);
  const inFolders = useLocalMusic((s) => s.files.length);
  const scanning = useLocalMusic((s) => s.scanning);
  const [lookingForUpdates, setLookingForUpdates] = useState(false);
  const [editingSync, setEditingSync] = useState(false);
  const [editingServer, setEditingServer] = useState<"home" | "away" | null>(null);

  const keptSongs = Object.values(kept);
  const keptBytes = keptSongs.reduce((sum, song) => sum + song.bytes, 0);
  const onItsWay = useDownloads((s) => Object.keys(s.loading).length);
  const anyDownloads = keptSongs.length + onItsWay > 0;

  const leave = (): void => {
    stop();
    clear();
    usePlaylists.getState().clear();
    useDownloads.getState().removeAll();
    // With music in folders the app goes on with that.
    if (useLocalMusic.getState().folders.length) useLocalMusic.getState().setWithoutServer(true);
    void signOut().then(() => useLibrary.getState().applyLocal());
  };

  const pickLanguage = (language: LanguageChoice): void => {
    change({ language });
    showDialog(T("Restart the app?"), T("The interface's language. The app restarts for it; the music stops for a moment."), [
      { text: T("Later"), style: "cancel" },
      { text: T("Restart now"), onPress: () => void Player.restartApp() },
    ]);
  };

  const pickAccent = (accent: Accent): void => {
    if (accent === settings.accent) return;
    change({ accent });
    showDialog(T("Restart the app?"), T("The new colour shows after a restart. The music stops for a moment."), [
      { text: T("Later"), style: "cancel" },
      { text: T("Restart"), onPress: () => void Player.restartApp() },
    ]);
  };

  const resetEverything = (): void => {
    showDialog(T("Reset the app?"), T("Downloads, folders, settings and your login go from this phone. Your server and your files stay as they are."), [
      { text: T("Cancel"), style: "cancel" },
      {
        text: T("Reset"),
        style: "destructive",
        onPress: () => {
          for (const folder of useLocalMusic.getState().folders) useLocalMusic.getState().removeFolder(folder.uri);
          useLocalMusic.getState().setWithoutServer(false);
          stop();
          clear();
          usePlaylists.getState().clear();
          useDownloads.getState().removeAll();
          void signOut();
        },
      },
    ]);
  };

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingTop: insets.top + 2, paddingBottom: PAGE_END + insets.bottom }}>
      <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Go back")} style={styles.back}>
        <ChevronLeft size={28} color={colors.ink} />
      </Pressable>
      <Text style={styles.title}>{T("Settings")}</Text>

      <Text style={styles.section}>{T("MUSIC ON THIS PHONE")}</Text>
      <View style={styles.group}>
        {folders.map((folder) => (
          <View key={folder.uri}>
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text numberOfLines={1} style={styles.rowTitle}>
                  {folder.name}
                </Text>
              </View>
              <Pressable
                accessibilityLabel={T("Remove {name}", { name: folder.name })}
                hitSlop={8}
                onPress={() =>
                  showDialog(T("Remove “{name}”?", { name: folder.name }), T("Its songs leave the app. The files stay on your phone."), [
                    { text: T("Cancel"), style: "cancel" },
                    { text: T("Remove"), style: "destructive", onPress: () => useLocalMusic.getState().removeFolder(folder.uri) },
                  ])
                }
              >
                <X size={20} color={colors.dim} />
              </Pressable>
            </View>
            <View style={styles.divider} />
          </View>
        ))}
        <Pressable onPress={() => void useLocalMusic.getState().addFolder()} style={styles.action}>
          <FolderPlus size={20} color={colors.ink} />
          <Text style={styles.actionText}>{T("Add a folder")}</Text>
        </Pressable>
        {folders.length > 0 && (
          <>
            <View style={styles.divider} />
            <Pressable disabled={!!scanning} onPress={() => void useLocalMusic.getState().rescan()} style={styles.action}>
              <RefreshCw size={20} color={colors.ink} />
              <Text style={styles.actionText}>
                {scanning ? (scanning.total ? T("Reading {read} of {total}…", { read: scanning.read, total: scanning.total }) : T("Looking through the folders…")) : T("Look again ({count})", { count: plural(onPhone, T("song"), T("songs")) })}
              </Text>
            </Pressable>
            <View style={styles.divider} />
            <SwitchRow
              title={T("Filter non-music audio")}
              line={inFolders > onPhone ? T("Clips, recordings and voice notes stay out. Of {count}, {value} {value2} listed on their own: filtered, or also on your server.", { count: plural(inFolders, T("file"), T("files")), value: inFolders - onPhone, value2: inFolders - onPhone === 1 ? "isn't" : "aren't" }) : T("Clips, recordings and voice notes stay out")}
              value={settings.filterNonMusic}
              onChange={(filterNonMusic) => change({ filterNonMusic })}
            />
          </>
        )}
      </View>

      <Text style={styles.section}>{T("SERVER")}</Text>
      {!session && (
        <View style={styles.group}>
          <Pressable onPress={() => useLocalMusic.getState().setAddingServer(true)} style={styles.action}>
            <Server size={20} color={colors.ink} />
            <Text style={styles.actionText}>{T("Connect to a Jellyfin server")}</Text>
          </Pressable>
        </View>
      )}
      {!!session && <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Jellyfin")}</Text>
          <Text style={[styles.rowSub, reach !== "offline" && { color: colors.accent }]}>{REACH_LINE[reach]}</Text>
          <Text style={styles.rowSub}>
            {session?.userName} · {plural(count, T("song"), T("songs"))}
          </Text>
        </View>
        <View style={styles.divider} />
        <Pressable onPress={() => setEditingServer("home")} style={styles.row}>
          <Text style={styles.rowTitle}>{T("Address at home")}</Text>
          <Text numberOfLines={1} style={styles.rowSub}>
            {session?.home}
          </Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable onPress={() => setEditingServer("away")} style={styles.row}>
          <Text style={styles.rowTitle}>{T("Address away from home")}</Text>
          <Text numberOfLines={2} style={styles.rowSub}>
            {session?.away ?? T("None yet: your music plays only at home. Enter the address of your tunnel or proxy.")}
          </Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable disabled={refreshing} onPress={() => void refresh()} style={styles.action}>
          <RefreshCw size={20} color={colors.ink} />
          <Text style={styles.actionText}>{refreshing ? T("Reading the library…") : T("Read the library again")}</Text>
        </Pressable>
        <View style={styles.divider} />
        <Pressable
          onPress={() => {
            if (!keptSongs.length) leave();
            else {
              showDialog(T("Sign out?"), T("Your downloads go too: {count}, {sizeLine}.", { count: plural(keptSongs.length, T("song"), T("songs")), sizeLine: sizeLine(keptBytes) }), [
                { text: T("Cancel"), style: "cancel" },
                { text: T("Sign out"), style: "destructive", onPress: leave },
              ]);
            }
          }}
          style={styles.action}
        >
          <LogOut size={20} color="#FF9D9D" />
          <Text style={[styles.actionText, { color: "#FF9D9D" }]}>{T("Sign out")}</Text>
        </Pressable>
      </View>}

      <Text style={styles.section}>{T("PLAYBACK")}</Text>
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Streaming quality")}</Text>
          <View style={styles.chips}>
            {QUALITIES.map((q) => (
              <Chip key={q.value} label={q.label} active={streaming === q.value} onPress={() => usePlayer.getState().setQuality(q.value)} />
            ))}
          </View>
          <Text style={styles.rowSub}>{QUALITIES.find((q) => q.value === streaming)?.line}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Fade between songs")}</Text>
          <View style={styles.chips}>
            {FADES.map((seconds) => (
              <Chip key={seconds} label={seconds ? `${seconds} s` : T("Off")} active={settings.fadeSeconds === seconds} onPress={() => change({ fadeSeconds: seconds })} />
            ))}
          </View>
          <Text style={styles.rowSub}>{settings.fadeSeconds ? T("A song fades out, the next one fades in. They don't overlap yet.") : T("Songs follow each other without a gap")}</Text>
        </View>
        {settings.fadeSeconds > 0 && (
          <>
            <View style={styles.divider} />
            <SwitchRow
              title={T("Seamless albums")}
              line={T("Songs of one album play on without a fade: live albums, DJ mixes, songs that run into each other")}
              value={settings.seamlessAlbums}
              onChange={(seamlessAlbums) => change({ seamlessAlbums })}
            />
          </>
        )}
        <View style={styles.divider} />
        <SwitchRow title={T("Skip silence")} line={T("Jump over silent intros and gaps")} value={settings.skipSilence} onChange={(skipSilence) => change({ skipSilence })} />
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Playback speed")}</Text>
          <View style={styles.chips}>
            {SPEEDS.map((speed) => (
              <Chip key={speed} label={`${speed}×`} active={settings.speed === speed} onPress={() => change({ speed })} />
            ))}
          </View>
          <Text style={styles.rowSub}>{T("The pitch stays where it is")}</Text>
        </View>
        <View style={styles.divider} />
        <SwitchRow title={T("Switch receivers off afterwards")} line={T("Denon and Marantz go off 30 seconds after the music has left them, unless you stop it or they're doing something else")} value={settings.switchOffDevices} onChange={(switchOffDevices) => change({ switchOffDevices })} />
        <View style={styles.divider} />
        <SwitchRow title={T("Skipping ends repeat one")} line={T("Go to another song while one is on repeat, and the whole list repeats from there")} value={settings.skipEndsRepeatOne} onChange={(skipEndsRepeatOne) => change({ skipEndsRepeatOne })} />
        <View style={styles.divider} />
        <SwitchRow title={T("Autoplay")} line={T("Keep the music going when the queue ends")} value={settings.autoplay} onChange={(autoplay) => change({ autoplay })} />
        {settings.autoplay && (
          <>
            <View style={styles.divider} />
            <SwitchRow title={T("Don't repeat suggestions")} line={T("What played in the last week stays out of that")} value={settings.dontRepeat} onChange={(dontRepeat) => change({ dontRepeat })} />
          </>
        )}
        <View style={styles.divider} />
        <Pressable onPress={() => nav.navigate("Equalizer")} style={styles.action}>
          <SlidersHorizontal size={20} color={colors.ink} />
          <Text style={[styles.actionText, styles.actionGrow]}>{T("Equalizer")}</Text>
          <Text style={styles.rowSub}>{settings.eqOn ? T("On") : T("Off")}</Text>
          <ChevronRight size={18} color={colors.dim} />
        </Pressable>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Volume leveling")}</Text>
          <View style={styles.chips}>
            {LEVELS.map((level) => (
              <Chip key={level.value} label={level.label} active={leveling === level.value} onPress={() => usePlayer.getState().setLeveling(level.value)} />
            ))}
          </View>
          <Text style={styles.rowSub}>{LEVELS.find((level) => level.value === leveling)?.line}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.rowTitle}>{T("24-bit output")}</Text>
            <Text style={styles.rowSub}>{T("Keeps the full resolution of 24-bit files up to your phone's mixer. Turn it off if those songs play too fast.")}</Text>
          </View>
          <Switch accessibilityLabel={T("24-bit output")} value={keep24Bit} onValueChange={(on) => usePlayer.getState().setKeep24Bit(on)} trackColor={{ true: colors.accent }} thumbColor={colors.ink} />
        </View>
      </View>

      <Text style={styles.section}>{T("GESTURES")}</Text>
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("How a pulled song feels")}</Text>
          <View style={styles.chips}>
            <Chip label={T("Rubber band")} active={settings.swipeFeel === "rubber"} onPress={() => change({ swipeFeel: "rubber" })} />
            <Chip label={T("Taut")} active={settings.swipeFeel === "taut"} onPress={() => change({ swipeFeel: "taut" })} />
          </View>
          <Text style={styles.rowSub}>{settings.swipeFeel === "rubber" ? T("Pulls far and kicks at every step; let go it snaps home") : T("Gives less and kicks less; let go it comes home without going past it")}</Text>
        </View>
        <View style={styles.divider} />
        <SwitchRow title={T("Vibration")} line={T("The phone answers your touches: pulled songs, buttons, likes, menus")} value={settings.haptics} onChange={(haptics) => change({ haptics })} />
      </View>

      <Text style={styles.section}>{T("LYRICS")}</Text>
      <View style={styles.group}>
        <SwitchRow title={T("Synced lyrics")} line={T("Highlight the current line and follow it")} value={settings.syncedLyrics} onChange={(syncedLyrics) => change({ syncedLyrics })} />
        <View style={styles.divider} />
        <SwitchRow title={T("Dim the other lines")} line={T("Keep the spotlight on the current line")} value={settings.dimLyrics} onChange={(dimLyrics) => change({ dimLyrics })} />
        <View style={styles.divider} />
        <SwitchRow title={T("Cyrillic in Latin letters")} line={T("A Latin line under each line of Russian, Ukrainian or other Cyrillic lyrics")} value={settings.lyricsLatin} onChange={(lyricsLatin) => change({ lyricsLatin })} />
      </View>

      <Text style={styles.section}>{T("APPEARANCE")}</Text>
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Accent")}</Text>
          <View style={styles.swatches}>
            {(Object.keys(ACCENTS) as Accent[]).map((accent) => (
              <Pressable
                key={accent}
                accessibilityLabel={ACCENTS[accent].label}
                accessibilityState={{ selected: settings.accent === accent }}
                onPress={() => pickAccent(accent)}
                style={[styles.swatch, { backgroundColor: ACCENTS[accent].color }]}
              >
                {settings.accent === accent && <Check size={18} color={ACCENTS[accent].on} strokeWidth={3} />}
              </Pressable>
            ))}
          </View>
          <Text style={styles.rowSub}>{T("The colour of what's playing, what's on, likes and the main buttons")}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Language")}</Text>
          <View style={styles.chips}>
            <Chip label={T("Automatic")} active={settings.language === "auto"} onPress={() => pickLanguage("auto")} />
            {LANGUAGES.map((l) => (
              <Chip key={l.id} label={l.name} active={settings.language === l.id} onPress={() => pickLanguage(l.id)} />
            ))}
          </View>
        </View>
        <View style={styles.divider} />
        <SwitchRow title={T("Reduce animation")} line={T("Pages and pulled songs move straight to where they're going")} value={settings.reduceMotion} onChange={(reduceMotion) => change({ reduceMotion })} />
      </View>

      {!!session && <>
      <Text style={styles.section}>{T("DOWNLOADS")}</Text>
      <View style={styles.group}>
        {!!(loadingCount || failedCount) && (
          <>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>
                {waitingForWifi ? T("{count} for Wi-Fi", { count: plural(waitingForWifi, T("song waits"), T("songs wait")) }) : loadingCount ? T("Downloading {count}", { count: plural(loadingCount, T("song"), T("songs")) }) : T("{count} didn't download", { count: plural(failedCount, T("song"), T("songs")) })}
              </Text>
              {!!failedCount && !!lastProblem && <Text style={[styles.rowSub, { color: "#FF9D9D" }]}>{lastProblem}</Text>}
            </View>
            <View style={styles.divider} />
          </>
        )}
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Quality of new downloads")}</Text>
          <View style={styles.chips}>
            <Chip label={T("Original")} active={quality === "original"} onPress={() => useDownloads.getState().setQuality("original")} />
            <Chip label={T("Compact")} active={quality === "compact"} onPress={() => useDownloads.getState().setQuality("compact")} />
          </View>
          <Text style={styles.rowSub}>{quality === "original" ? T("The files themselves, FLAC stays FLAC") : T("MP3 at 192 kbps, about 1.5 MB a minute")}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.switchRow}>
          <View style={styles.switchText}>
            <Text style={styles.rowTitle}>{T("Download over mobile data")}</Text>
          </View>
          <Switch
            accessibilityLabel={T("Download over mobile data")}
            value={overMobile}
            onValueChange={(on) => useDownloads.getState().setOverMobile(on)}
            trackColor={{ true: colors.accent }}
          thumbColor={colors.ink}
          />
        </View>
        <View style={styles.divider} />
        <Pressable
          disabled={!anyDownloads}
          onPress={() =>
            showDialog(T("Remove all downloads?"), T("{count}, {sizeLine} from this phone{value}. They stay on your server.", { count: plural(keptSongs.length, T("song"), T("songs")), sizeLine: sizeLine(keptBytes), value: onItsWay ? T(", and {count} on the way", { count: plural(onItsWay, T("song"), T("songs")) }) : "" }), [
              { text: T("Cancel"), style: "cancel" },
              { text: T("Remove"), style: "destructive", onPress: () => useDownloads.getState().removeAll() },
            ])
          }
          style={styles.action}
        >
          <Trash2 size={20} color={anyDownloads ? "#FF9D9D" : colors.dim} />
          <Text style={[styles.actionText, { color: anyDownloads ? "#FF9D9D" : colors.dim }]}>
            {anyDownloads ? T("Remove all ({count}, {sizeLine})", { count: plural(keptSongs.length + onItsWay, T("song"), T("songs")), sizeLine: sizeLine(keptBytes) }) : T("Nothing downloaded yet")}
          </Text>
        </Pressable>
      </View>

      <Text style={styles.section}>{T("SYNC")}</Text>
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Playlists and where you stopped")}</Text>
          <Text style={[styles.rowSub, syncStatus === "connected" && { color: colors.accent }]}>{SYNC_LINE[syncStatus]}</Text>
          <Text numberOfLines={1} style={styles.rowSub}>
            {syncAddress()}
          </Text>
        </View>
        <View style={styles.divider} />
        <Pressable onPress={() => setEditingSync(true)} style={styles.action}>
          <Link2 size={20} color={colors.ink} />
          <Text style={styles.actionText}>{customAddress ? T("Change the address") : T("Enter another address")}</Text>
        </Pressable>
        <View style={styles.divider} />
        <SwitchRow title={T("Count plays on the server")} line={T("Songs you hear here count on Jellyfin too")} value={settings.serverPlays} onChange={(serverPlays) => change({ serverPlays })} />
      </View>
      </>}

      <Text style={styles.section}>{T("THIS APP")}</Text>
      <View style={styles.group}>
        <View style={styles.row}>
          <Text style={styles.rowTitle}>{T("Songsta {APP_VERSION}", { APP_VERSION })}</Text>
          <Text style={styles.rowSub}>{T("Your data stays on your devices and your own server.")}</Text>
        </View>
        <View style={styles.divider} />
        <UpdateRows newer={newer} />
        <Pressable
          disabled={lookingForUpdates}
          onPress={() => {
            setLookingForUpdates(true);
            void lookNow().finally(() => setLookingForUpdates(false));
          }}
          style={styles.row}
        >
          <Text style={styles.rowTitle}>{T("Look for updates")}</Text>
          <Text style={styles.rowSub}>{lookingForUpdates ? T("Looking…") : T("You have Songsta {version}", { version: APP_VERSION })}</Text>
        </Pressable>
        <View style={styles.divider} />
        <SwitchRow title={T("Automatic updates")} line={T("Fetches new versions on Wi-Fi. Android asks you before one goes in.")} value={settings.autoUpdate} onChange={(autoUpdate) => change({ autoUpdate })} />
        <View style={styles.divider} />
        <SwitchRow title={T("Tell me about new versions")} line={T("A short note and a dot on the settings button when one is out")} value={settings.checkNewVersion} onChange={(checkNewVersion) => change({ checkNewVersion })} />
        <View style={styles.divider} />
        <Pressable onPress={resetEverything} style={styles.action}>
          <Trash2 size={20} color="#FF9D9D" />
          <Text style={[styles.actionText, { color: "#FF9D9D" }]}>{T("Reset the app")}</Text>
        </Pressable>
      </View>

      <NameDialog
        visible={editingSync}
        title={T("Sync service")}
        placeholder={T("Empty: on your Jellyfin server")}
        initial={customAddress}
        action={T("Save")}
        allowEmpty
        address
        onCancel={() => setEditingSync(false)}
        onDone={(address) => {
          setCustomAddress(address);
          setEditingSync(false);
        }}
      />
      <NameDialog
        visible={!!editingServer}
        title={editingServer === "away" ? T("Address away from home") : T("Address at home")}
        placeholder={editingServer === "away" ? "https://music.example.org" : "http://192.168.1.20:8096"}
        initial={(editingServer && session?.[editingServer]) ?? ""}
        action={T("Save")}
        allowEmpty={editingServer === "away"}
        address
        onCancel={() => setEditingServer(null)}
        onDone={(address) => {
          const which = editingServer;
          setEditingServer(null);
          if (!which) return;
          setAddress(which, address).then(
            () => void useConnection.getState().check(),
            (err) => showDialog(T("That address didn't work"), err instanceof Error ? err.message : T("The server did not answer"))
          );
        }}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base, paddingHorizontal: 16 },
  back: { width: 44, height: 44, marginLeft: -10, alignItems: "center", justifyContent: "center" },
  title: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, marginTop: 4 },
  section: { color: colors.dim, fontSize: 11, fontWeight: "600", letterSpacing: 1.5, marginTop: 26, marginBottom: 8 },
  group: { borderRadius: 12, backgroundColor: colors.panel, overflow: "hidden" },
  row: { padding: 14, gap: 3 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.dim, fontSize: 13 },
  chips: { flexDirection: "row", gap: 8, marginVertical: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8 },
  switchText: { flex: 1, minWidth: 0, gap: 3 },
  divider: { height: 1, backgroundColor: colors.hairline, marginLeft: 14 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, paddingHorizontal: 14 },
  actionText: { flexShrink: 1, color: colors.ink, fontSize: 15 },
  actionGrow: { flex: 1 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginVertical: 10 },
  swatch: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});
