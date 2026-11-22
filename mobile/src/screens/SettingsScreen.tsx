/** Everything that can be chosen: the music on this phone, the server, how it plays and feels, downloads, sync. */
import { useNavigation, useRoute } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { BarChart3, AudioLines, Check, ChevronLeft, ChevronRight, CircleAlert, CircleArrowDown, CirclePlay, CloudOff, FileDown, FileUp, Heart, FolderPlus, Hand, Info, Laptop, Link2, LogOut, MicVocal, MonitorSmartphone, Palette, RefreshCw, Server, ShieldCheck, SlidersHorizontal, Trash2, Unlink, X, type LucideIcon } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { APP_VERSION, installPhoneUpdate, lookNow, openReleasePage, updatePhone, useNewerVersion, usePhoneUpdate } from "../newVersion";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Reach } from "../addresses";
import Player from "../../modules/media3-player";
import type { Leveling, QualityMode } from "../quality";
import { NameDialog } from "../components/PlaylistSheets";
import { PullDownToClose } from "../components/PullDownToClose";
import { Chip } from "../components/ui";
import { currentLanguage, NET_SERVICES, plural, SYNC_UPDATE_COMMAND, type SyncStatus } from "../shared";
import { backupSummary, type BackupProblem, type PhoneBackup } from "../backup";
import { exportBackup, pickBackup, restoreBackup } from "../phoneBackup";
import { useConnection } from "../stores/connection";
import { sizeLine, useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { useLocalMusic } from "../stores/localMusic";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { showDialog, toast } from "../stores/popups";
import { useSession } from "../stores/session";
import { ACCENTS, useSettings, type Accent, feel } from "../stores/settings";
import { LANGUAGES, type LanguageChoice } from "../shared";
import { removeSharedListens, restartSync, searchSyncAgain, syncAddress, useSync } from "../sync";
import { findComputers, forgetHomeLink, homeLink, loadHomeLink, pairWith, type FoundComputer, type HomeLink } from "../homeLink";
import { useListens } from "../stores/listens";
import { usePlayed } from "../stores/played";
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

function SwitchRow({ title, line, value, onChange, disabled }: { title: string; line?: string; value: boolean; onChange: (on: boolean) => void; disabled?: boolean }) {
  return (
    <View style={[styles.switchRow, disabled && styles.switchRowOff]}>
      <View style={styles.switchText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {!!line && <Text style={styles.rowSub}>{line}</Text>}
      </View>
      <Switch
        accessibilityLabel={title}
        disabled={disabled}
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

/** What's wrong with a picked file, in words. */
const BACKUP_PROBLEM: Record<BackupProblem | "unreadable", string> = {
  "not-a-backup": T("That file isn't a backup from Songsta on a phone."),
  "computer-backup": T("That backup comes from Songsta on a computer: it goes back in there, with Import data in its settings."),
  "too-new": T("That backup comes from a newer Songsta. Update the app first, then import it."),
  "too-big": T("That file is too big to be a backup."),
  unreadable: T("That file couldn't be read."),
};

function dayOf(at: number): string {
  try {
    return new Date(at).toLocaleDateString(currentLanguage() === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

/** Asks where, and writes the backup there (phoneBackup.ts). */
function exportData(): void {
  exportBackup().then(
    (name) => {
      if (name) toast(T("Backup saved as {name}", { name }), true);
    },
    (err: unknown) => showDialog(T("Export failed"), err instanceof Error ? err.message : undefined)
  );
}

/** The backup's things in place of the phone's, and a new start with them. */
async function putBack(backup: PhoneBackup): Promise<void> {
  try {
    const folders = await restoreBackup(backup);
    showDialog(
      T("Backup imported"),
      folders.length
        ? T("Songsta starts anew with it now. Android lets it read a music folder only once it's picked again: add {folders} under Music on this phone.", { folders: folders.join(", ") })
        : T("Songsta starts anew with it now."),
      [{ text: T("Restart"), onPress: () => void Player.restartApp().catch(() => showDialog(T("Close Songsta and open it again to finish."))) }],
      { cancelable: false }
    );
  } catch (err) {
    showDialog(T("Import failed"), err instanceof Error ? err.message : undefined);
  }
}

/** Asks for the file, says what's in it, and puts it back if that's still wanted. */
function importData(): void {
  pickBackup().then(
    (picked) => {
      if (!picked) return;
      if (typeof picked === "string") {
        showDialog(T("Import failed"), BACKUP_PROBLEM[picked]);
        return;
      }
      const { playlists, groups, albumEdits, at } = backupSummary(picked);
      const holds = [plural(playlists, T("playlist"), T("playlists")), plural(groups, T("group"), T("groups")), plural(albumEdits, T("edited album"), T("edited albums"))].join(", ");
      showDialog(
        T("Import this backup?"),
        `${at ? T("From {date}: {holds}.", { date: dayOf(at), holds }) : `${holds}.`} ${T("Playlists, library order, groups, album edits and settings on this phone are replaced by the backup's. Songsta then starts anew.")}`,
        [
          { text: T("Cancel"), style: "cancel" },
          { text: T("Import"), style: "destructive", onPress: () => void putBack(picked) },
        ]
      );
    },
    (err: unknown) => showDialog(T("Import failed"), err instanceof Error ? err.message : undefined)
  );
}

type SettingsSection = "music" | "playback" | "sound" | "gestures" | "lyrics" | "appearance" | "downloads" | "sync" | "privacy" | "app";

/** The categories, in the order of the list. Downloads and sync only with a server. */
const SECTIONS: { key: SettingsSection; title: string; Icon: LucideIcon; server?: boolean }[] = [
  { key: "music", title: T("Music and server"), Icon: Server },
  { key: "playback", title: T("Playback"), Icon: CirclePlay },
  { key: "sound", title: T("Sound"), Icon: AudioLines },
  { key: "lyrics", title: T("Lyrics"), Icon: MicVocal },
  { key: "appearance", title: T("Appearance"), Icon: Palette },
  { key: "gestures", title: T("Gestures"), Icon: Hand },
  { key: "downloads", title: T("Downloads"), Icon: CircleArrowDown, server: true },
  { key: "sync", title: T("Sync and devices"), Icon: MonitorSmartphone },
  { key: "privacy", title: T("Network & privacy"), Icon: ShieldCheck },
  { key: "app", title: T("This app"), Icon: Info },
];

/** The overview's groups, and each category's colour (Replay leads you to the story, not to a page of settings). */
type OverviewKey = SettingsSection | "replay";
const OVERVIEW_GROUPS: { title: string; keys: OverviewKey[] }[] = [
  { title: T("Listening"), keys: ["playback", "sound", "lyrics", "gestures"] },
  { title: T("Music"), keys: ["music", "downloads", "replay"] },
  { title: T("Connections"), keys: ["sync", "privacy"] },
  { title: T("Look and app"), keys: ["appearance", "app"] },
];
const tinted = (r: number, g: number, b: number): { ink: string; bg: string } => ({ ink: `rgb(${r},${g},${b})`, bg: `rgba(${r},${g},${b},0.16)` });
const TINTS: Record<OverviewKey, { ink: string; bg: string }> = {
  playback: tinted(196, 181, 253),
  sound: tinted(94, 234, 212),
  lyrics: tinted(251, 191, 36),
  gestures: tinted(148, 163, 184),
  music: tinted(125, 211, 252),
  downloads: tinted(74, 222, 128),
  replay: tinted(244, 114, 182),
  sync: tinted(165, 180, 252),
  privacy: tinted(251, 146, 60),
  appearance: tinted(253, 164, 175),
  app: tinted(212, 212, 216),
};

/** The services on the internet the phone asks (src/lib/netServices.ts). */
const PHONE_SERVICES = NET_SERVICES.filter((s) => s.phone);

export function SettingsScreen() {
  const nav = useNavigation<any>();
  // Pushed with a section: that category's page; without: the list of categories.
  const section = (useRoute<any>().params?.section as SettingsSection | undefined) ?? undefined;
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
  const syncVersion = useSync((s) => s.service?.version);
  // Only with a linked service (lib/syncService.ts): without one, nothing is asked or said.
  const syncTooOld = useSync((s) => !!s.serviceProblem && s.status === "connected");
  // Never found for this server: it was looked for once, and "Search again" looks now.
  const syncNotFound = useSync((s) => s.status === "unreachable" && !s.linked);
  const customAddress = useSync((s) => s.customAddress);
  const syncLinked = useSync((s) => s.linked);
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
  // A computer at home in place of a sync service (homeLink.ts): which one, and the ones found to pair with.
  const [linkedTo, setLinkedTo] = useState<HomeLink | null>(homeLink());
  const [computers, setComputers] = useState<FoundComputer[] | null>(null);
  const [lookingForComputers, setLookingForComputers] = useState(false);
  const [pairingWith, setPairingWith] = useState<FoundComputer | null>(null);
  // Read from storage at the start; a page opened before that shows it once it's read.
  useEffect(() => {
    void loadHomeLink().then(() => setLinkedTo(homeLink()));
  }, []);
  // Your own sync service links the devices already: the computer is for homes without one.
  const externalSync = !!session && syncLinked && !linkedTo;
  const lookForComputers = async (): Promise<void> => {
    setLookingForComputers(true);
    setComputers(await findComputers().catch(() => []));
    setLookingForComputers(false);
  };
  const finishPairing = async (code: string): Promise<void> => {
    const computer = pairingWith;
    setPairingWith(null);
    if (!computer) return;
    const result = await pairWith(computer, code, { name: String((Platform.constants as { Model?: string }).Model ?? "Phone") });
    if (result === "paired") {
      setLinkedTo(homeLink());
      setComputers(null);
      restartSync();
      toast(T("Linked to {name}", { name: computer.name }));
    } else if (result === "wrong") showDialog(T("That code doesn't fit"), T("Look at the code on the computer and try again."));
    else if (result === "closed") showDialog(T("The code has run out"), T("Show a new one on the computer: Settings → Sync & devices → Phones at home → Pair a phone."));
    else showDialog(T("{name} didn't answer", { name: computer.name }), T("Is Songsta open on it, and this phone on the same Wi-Fi?"));
  };
  const unlink = (): void => {
    if (!linkedTo) return;
    showDialog(T("Unlink from {name}?", { name: linkedTo.name }), T("Playlists and your library stay on this phone as they are; the computer keeps what it has."), [
      { text: T("Cancel"), style: "cancel" },
      {
        text: T("Unlink"),
        style: "destructive",
        onPress: () => {
          forgetHomeLink();
          setLinkedTo(null);
          restartSync();
        },
      },
    ]);
  };

  const keptSongs = Object.values(kept);
  const keptBytes = keptSongs.reduce((sum, song) => sum + song.bytes, 0);
  const onItsWay = useDownloads((s) => Object.keys(s.loading).length);
  const anyDownloads = keptSongs.length + onItsWay > 0;

  // What each category holds right now, in a line under its name.
  const summary: Record<SettingsSection, string> = {
    music: session ? `${session.userName} · ${plural(count, T("song"), T("songs"))}` : folders.length ? plural(folders.length, T("folder"), T("folders")) : T("Not set up yet"),
    playback: [settings.fadeSeconds ? T("Fade {seconds} s", { seconds: settings.fadeSeconds }) : T("No fade"), settings.speed !== 1 ? `${settings.speed}×` : "", settings.autoplay ? T("Autoplay") : ""].filter(Boolean).join(" · "),
    sound: [QUALITIES.find((q) => q.value === streaming)?.label, settings.eqOn ? T("Equalizer on") : "", settings.evenOut ? T("Evened out") : ""].filter(Boolean).join(" · "),
    lyrics: settings.syncedLyrics ? T("Synced") : T("Plain text"),
    appearance: [ACCENTS[settings.accent].label, settings.language === "auto" ? T("Automatic language") : LANGUAGES.find((l) => l.id === settings.language)?.name].filter(Boolean).join(" · "),
    gestures: [settings.swipeFeel === "rubber" ? T("Rubber band") : T("Taut"), settings.haptics ? T("Vibration") : ""].filter(Boolean).join(" · "),
    downloads: keptSongs.length ? `${plural(keptSongs.length, T("song"), T("songs"))} · ${sizeLine(keptBytes)}` : T("Nothing downloaded yet"),
    sync: linkedTo
      ? [T("Linked to {name}", { name: linkedTo.name }), SYNC_LINE[syncStatus]].join(" · ")
      : !session
        ? T("Not linked to a computer")
        : syncNotFound
          ? T("No sync service found")
          : SYNC_LINE[syncStatus],
    privacy: settings.netOwnOnly
      ? T("Only my own server")
      : T("{on} of {count} services on the internet on", { on: PHONE_SERVICES.filter((s) => !settings.netOff.includes(s.id)).length, count: PHONE_SERVICES.length }),
    app: newer ? T("Songsta {version} is out", { version: newer }) : T("Songsta {APP_VERSION}", { APP_VERSION }),
  };

  // The overview as the grouped mockup the user picked to mix in (2026-11-16): a card with the app,
  // the server and the sync on top, then the categories in groups under a heading in the middle,
  // each with an icon of its own colour; the rows and their lines as before.
  const overview = (
    <>
      <View style={styles.appCard}>
        <LinearGradient colors={["rgba(167,139,250,0.26)", colors.panel]} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={styles.appMark}>
          <Text style={styles.appMarkText}>S</Text>
        </View>
        <Text style={styles.appName}>{T("Songsta {APP_VERSION}", { APP_VERSION })}</Text>
        <Text numberOfLines={2} style={styles.appLine}>
          {[session ? session.userName : null, plural(count, T("song"), T("songs")), session ? (syncNotFound ? T("No sync service found") : SYNC_LINE[syncStatus]) : null].filter(Boolean).join(" · ")}
        </Text>
      </View>
      {OVERVIEW_GROUPS.map((g) => {
        const keys = g.keys.filter((k) => k === "replay" || !SECTIONS.find((x) => x.key === k)?.server || session);
        if (!keys.length) return null;
        return (
          <View key={g.title}>
            <Text style={styles.groupTitle}>{g.title}</Text>
            <View style={styles.group}>
              {keys.map((k, i) => {
                const s = k === "replay" ? null : SECTIONS.find((x) => x.key === k);
                const Icon = s ? s.Icon : BarChart3;
                const tint = TINTS[k];
                return (
                  <View key={k}>
                    {i > 0 && <View style={styles.overviewDivider} />}
                    <Pressable
                      onPress={() => (k === "replay" ? nav.push("Replay") : nav.push("Settings", { section: k }))}
                      android_ripple={{ color: "rgba(255,255,255,0.06)" }}
                      style={styles.overviewRow}
                    >
                      <View style={[styles.overviewIcon, { backgroundColor: tint.bg }]}>
                        <Icon size={19} color={tint.ink} />
                      </View>
                      <View style={styles.switchText}>
                        <Text style={styles.rowTitle}>{s ? s.title : T("Replay")}</Text>
                        <Text numberOfLines={1} style={[styles.rowSub, k === "app" && !!newer && { color: colors.accent }]}>
                          {k === "replay" ? T("Your listening, told as a story") : summary[k]}
                        </Text>
                      </View>
                      <ChevronRight size={18} color={colors.dim} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}
    </>
  );

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

  /** Every play kept on this phone goes: Replay, its history, Recently played. The server's counts and the sync service's history stay. */
  const deletePlays = (): void => {
    showDialog(T("Delete your plays?"), T("Replay, the listening history and Recently played on this phone start from nothing. Play counts on your server and what your sync service has stay. This can't be undone."), [
      { text: T("Cancel"), style: "cancel" },
      {
        text: T("Delete"),
        style: "destructive",
        onPress: () => {
          useListens.getState().clearAll();
          usePlayed.getState().forget();
          toast(T("Plays deleted"));
        },
      },
    ]);
  };
  const removeFromService = (): void => {
    showDialog(T("Take this phone's plays off your sync service?"), T("They leave the history your devices share. Your other devices keep the ones they already have, and this phone keeps its own history. New plays go there again while the listening history is shared."), [
      { text: T("Cancel"), style: "cancel" },
      {
        text: T("Take them off"),
        style: "destructive",
        onPress: () => {
          void removeSharedListens().then((result) =>
            toast(
              result === "removed"
                ? T("This phone's plays are off your sync service")
                : result === "old-service"
                  ? T("Your sync service can't do that yet: it needs its update")
                  : result === "not-linked"
                    ? T("No sync service is linked")
                    : T("Your sync service didn't answer. Try again later."),
              result !== "removed"
            )
          );
        },
      },
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

  // One page of a category, or the list of them (section undefined).
  const pages: Record<SettingsSection, ReactNode> = {
    music: (
          <>
          <Text style={styles.section}>{T("ON THIS PHONE")}</Text>
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
    
          </>
    ),
    playback: (
          <>
          <View style={styles.group}>
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
            <SwitchRow title={T("Skipping ends repeat one")} line={T("Go to another song while one is on repeat, and the whole list repeats from there")} value={settings.skipEndsRepeatOne} onChange={(skipEndsRepeatOne) => change({ skipEndsRepeatOne })} />
            <View style={styles.divider} />
            <SwitchRow title={T("Autoplay")} line={T("Keep the music going when the queue ends")} value={settings.autoplay} onChange={(autoplay) => change({ autoplay })} />
            {settings.autoplay && (
              <>
                <View style={styles.divider} />
                <SwitchRow title={T("Don't repeat suggestions")} line={T("What played in the last week stays out of that")} value={settings.dontRepeat} onChange={(dontRepeat) => change({ dontRepeat })} />
              </>
            )}
          </View>
          </>
    ),
    sound: (
          <>
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
              <Text style={styles.rowTitle}>{T("Volume leveling")}</Text>
              <View style={styles.chips}>
                {LEVELS.map((level) => (
                  <Chip key={level.value} label={level.label} active={leveling === level.value} onPress={() => usePlayer.getState().setLeveling(level.value)} />
                ))}
              </View>
              <Text style={styles.rowSub}>{LEVELS.find((level) => level.value === leveling)?.line}</Text>
            </View>
            {Number(Platform.Version) >= 28 && (
              <>
              <View style={styles.divider} />
              <SwitchRow
                title={T("Even out loud and quiet")}
                line={T("Quiet passages come up and loud ones are held back: for orchestras and film music on headphones, or at night")}
                value={settings.evenOut}
                onChange={(evenOut) => change({ evenOut })}
              />
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
            <View style={styles.switchRow}>
              <View style={styles.switchText}>
                <Text style={styles.rowTitle}>{T("24-bit output")}</Text>
                <Text style={styles.rowSub}>{T("Keeps the full resolution of 24-bit files up to your phone's mixer. Turn it off if those songs play too fast.")}</Text>
              </View>
              <Switch accessibilityLabel={T("24-bit output")} value={keep24Bit} onValueChange={(on) => usePlayer.getState().setKeep24Bit(on)} trackColor={{ true: colors.accent }} thumbColor={colors.ink} />
            </View>
          </View>
          </>
    ),
    gestures: (
          <>
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
    
          </>
    ),
    lyrics: (
          <>
          <View style={styles.group}>
            <SwitchRow title={T("Synced lyrics")} line={T("Highlight the current line and follow it")} value={settings.syncedLyrics} onChange={(syncedLyrics) => change({ syncedLyrics })} />
            <View style={styles.divider} />
            <SwitchRow title={T("Dim the other lines")} line={T("Keep the spotlight on the current line")} value={settings.dimLyrics} onChange={(dimLyrics) => change({ dimLyrics })} />
            <View style={styles.divider} />
            <SwitchRow title={T("Cyrillic in Latin letters")} line={T("A Latin line under each line of Russian, Ukrainian or other Cyrillic lyrics")} value={settings.lyricsLatin} onChange={(lyricsLatin) => change({ lyricsLatin })} />
          </View>
    
          </>
    ),
    appearance: (
          <>
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
    
          </>
    ),
    downloads: (
          <>
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
    
          </>
    ),
    sync: (
          <>
          {session && (
          <View style={styles.group}>
            {/* Linked to a computer at home, that's the service: the one on the Jellyfin server sits out. */}
            {!linkedTo && (
            <>
            <View style={styles.row}>
              <Text style={styles.rowTitle}>{T("Playlists and where you stopped")}</Text>
              <Text style={[styles.rowSub, syncStatus === "connected" && { color: colors.accent }]}>
                {syncNotFound ? T("No sync service found on your Jellyfin server") : SYNC_LINE[syncStatus]}
                {syncStatus === "connected" && syncVersion ? ` · ${T("version {version}", { version: syncVersion })}` : ""}
              </Text>
              <Text numberOfLines={1} style={styles.rowSub}>
                {syncAddress()}
              </Text>
            </View>
            {syncNotFound && (
              <>
                <View style={styles.divider} />
                <Pressable onPress={searchSyncAgain} style={styles.notice}>
                  <RefreshCw size={20} color={colors.ink} />
                  <View style={styles.noticeText}>
                    <Text style={styles.rowTitle}>{T("Search again")}</Text>
                    <Text style={styles.rowSub}>{T("A sync service keeps playlists and your library the same on all your devices: a small Docker container next to Jellyfin, songsta-sync.zip on the Releases page. Without one, each device keeps its own.")}</Text>
                  </View>
                </Pressable>
              </>
            )}
            {syncTooOld && (
              <>
                <View style={styles.divider} />
                <View style={styles.notice}>
                  <CircleAlert size={20} color={colors.hiRes} />
                  <View style={styles.noticeText}>
                    <Text style={styles.rowTitle}>{T("The sync service needs an update")}</Text>
                    <Text style={styles.rowSub}>{T("Until then, library order, groups and album edits stay on this phone. To update it, run this in its folder on the server:")}</Text>
                    <Text selectable style={styles.command}>
                      {SYNC_UPDATE_COMMAND}
                    </Text>
                  </View>
                </View>
              </>
            )}
            <View style={styles.divider} />
            <Pressable onPress={() => setEditingSync(true)} style={styles.action}>
              <Link2 size={20} color={colors.ink} />
              <Text style={styles.actionText}>{customAddress ? T("Change the address") : T("Enter another address")}</Text>
            </Pressable>
            <View style={styles.divider} />
            </>
            )}
            <SwitchRow title={T("Count plays on the server")} line={T("Songs you hear here count on Jellyfin too")} value={settings.serverPlays} onChange={(serverPlays) => change({ serverPlays })} />
          </View>
          )}
          <Text style={styles.section}>{T("COMPUTER AT HOME")}</Text>
          <View style={styles.group}>
            {linkedTo ? (
              <>
                <View style={styles.row}>
                  <Text style={styles.rowTitle}>{T("Linked to {name}", { name: linkedTo.name })}</Text>
                  <Text style={[styles.rowSub, syncStatus === "connected" && { color: colors.accent }]}>
                    {syncStatus === "connected" ? T("Playlists, your library and what plays stay in step with it, and a song only it has plays here from it") : T("It answers while Songsta is open on it")}
                  </Text>
                </View>
                <View style={styles.divider} />
                <Pressable onPress={unlink} style={styles.action}>
                  <Unlink size={20} color="#FF9D9D" />
                  <Text style={[styles.actionText, { color: "#FF9D9D" }]}>{T("Unlink")}</Text>
                </Pressable>
              </>
            ) : externalSync ? (
              <View style={styles.row}>
                <Text style={styles.rowTitle}>{T("Link to a computer")}</Text>
                <Text style={styles.rowSub}>{T("Your sync service already links your devices. This is for homes without one.")}</Text>
              </View>
            ) : (
              <>
                <Pressable onPress={() => void lookForComputers()} disabled={lookingForComputers} style={styles.notice}>
                  <Laptop size={20} color={colors.ink} />
                  <View style={styles.noticeText}>
                    <Text style={styles.rowTitle}>{lookingForComputers ? T("Looking for computers…") : T("Link to a computer")}</Text>
                    <Text style={styles.rowSub}>{T("Without a sync service, a computer with Songsta keeps this phone's playlists, library and what plays in step. On the computer: Settings → Sync & devices → Phones at home.")}</Text>
                  </View>
                </Pressable>
                {computers && computers.length === 0 && !lookingForComputers && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.row}>
                      <Text style={styles.rowSub}>{T("No computer found. Is Songsta open on it with Phones at home switched on, and this phone on the same Wi-Fi?")}</Text>
                    </View>
                  </>
                )}
                {computers?.map((c) => (
                  <View key={c.id}>
                    <View style={styles.divider} />
                    <Pressable onPress={() => setPairingWith(c)} style={styles.action}>
                      <MonitorSmartphone size={20} color={colors.ink} />
                      <Text style={styles.actionText}>{c.name}</Text>
                    </Pressable>
                  </View>
                ))}
              </>
            )}
          </View>
          <Text style={styles.section}>{T("RECEIVERS AND TVS")}</Text>
          <View style={styles.group}>
            <SwitchRow title={T("Switch receivers off afterwards")} line={T("Denon and Marantz go off 30 seconds after the music has left them, unless you stop it or they're doing something else")} value={settings.switchOffDevices} onChange={(switchOffDevices) => change({ switchOffDevices })} />
          </View>
          </>
    ),
    privacy: (
          <>
          <Text style={styles.section}>{T("CONNECTIONS")}</Text>
          <View style={styles.group}>
            <SwitchRow
              title={T("Only my own server")}
              line={T("Every service on the internet off at once: no facts or lyrics from outside. Your server, the sync service and the devices at home always work.")}
              value={settings.netOwnOnly}
              onChange={(netOwnOnly) => change({ netOwnOnly })}
            />
            {PHONE_SERVICES.map((s) => (
              <View key={s.id}>
                <View style={styles.divider} />
                <SwitchRow
                  title={s.name}
                  line={`${T(s.purpose)} · ${T("Sends: {what}", { what: T(s.sends) })}`}
                  value={!settings.netOwnOnly && !settings.netOff.includes(s.id)}
                  disabled={settings.netOwnOnly}
                  onChange={(on) => !settings.netOwnOnly && change({ netOff: on ? settings.netOff.filter((x) => x !== s.id) : [...new Set([...settings.netOff, s.id])] })}
                />
              </View>
            ))}
          </View>
          <Text style={styles.sectionNote}>{T("Each switch holds back every request to that service: nothing of it leaves the phone while it's off.")}</Text>
          <Text style={styles.section}>{T("KEPT ON THIS PHONE")}</Text>
          <View style={styles.group}>
            <SwitchRow title={T("Keep my plays")} line={T("For Replay on this phone")} value={settings.recordListening} onChange={(recordListening) => change({ recordListening })} />
            <View style={styles.divider} />
            <Pressable onPress={deletePlays} style={styles.action}>
              <Trash2 size={20} color="#FF9D9D" />
              <Text style={[styles.actionText, { color: "#FF9D9D" }]}>{T("Delete my plays")}</Text>
            </Pressable>
          </View>
          {session && (
            <>
              <Text style={styles.section}>{T("SHARED WITH YOUR OWN SERVERS")}</Text>
              <View style={styles.group}>
                <SwitchRow
                  title={T("Listening history")}
                  line={settings.recordListening ? T("Every play goes to your sync service, so Replay counts all your devices") : T("Off while your plays aren't kept on this phone")}
                  value={settings.shareListens && settings.recordListening}
                  disabled={!settings.recordListening}
                  onChange={(shareListens) => change({ shareListens })}
                />
                <View style={styles.divider} />
                <SwitchRow title={T("Library order, groups and album edits")} line={T("Through your sync service, to your other devices")} value={settings.shareLibrary} onChange={(shareLibrary) => change({ shareLibrary })} />
                <View style={styles.divider} />
                <SwitchRow title={T("Count plays on the server")} line={T("Songs you hear here count on Jellyfin too")} value={settings.serverPlays} onChange={(serverPlays) => change({ serverPlays })} />
                {syncLinked && (
                  <>
                    <View style={styles.divider} />
                    <Pressable onPress={removeFromService} style={styles.action}>
                      <CloudOff size={20} color={colors.ink} />
                      <Text style={styles.actionText}>{T("Take this phone's plays off the sync service")}</Text>
                    </Pressable>
                  </>
                )}
              </View>
            </>
          )}
          </>
    ),
    app: (
          <>
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
            {/* Only here, only on a tap: Ko-fi opens in the browser, the app itself asks it nothing. */}
            <Pressable onPress={() => void Linking.openURL("https://ko-fi.com/besteck").catch(() => undefined)} style={styles.notice}>
              <Heart size={20} color={colors.accent} />
              <View style={styles.noticeText}>
                <Text style={styles.rowTitle}>{T("Support Songsta")}</Text>
                <Text style={styles.rowSub}>{T("Songsta is free and stays free. If you like it, you can buy me a coffee on Ko-fi.")}</Text>
              </View>
            </Pressable>
            <View style={styles.divider} />
            <Pressable onPress={exportData} style={styles.notice}>
              <FileUp size={20} color={colors.ink} />
              <View style={styles.noticeText}>
                <Text style={styles.rowTitle}>{T("Export data")}</Text>
                <Text style={styles.rowSub}>{T("Playlists, library order, groups, album edits and settings in one file, for a new start")}</Text>
              </View>
            </Pressable>
            <View style={styles.divider} />
            <Pressable onPress={importData} style={styles.notice}>
              <FileDown size={20} color={colors.ink} />
              <View style={styles.noticeText}>
                <Text style={styles.rowTitle}>{T("Import data")}</Text>
                <Text style={styles.rowSub}>{T("From a file exported on a phone, in place of what's here")}</Text>
              </View>
            </Pressable>
            <View style={styles.divider} />
            <Pressable onPress={resetEverything} style={styles.action}>
              <Trash2 size={20} color="#FF9D9D" />
              <Text style={[styles.actionText, { color: "#FF9D9D" }]}>{T("Reset the app")}</Text>
            </Pressable>
          </View>
    
          </>
    ),
  };

  return (
    <PullDownToClose onClose={() => nav.goBack()}>
    <ScrollView style={styles.root} contentContainerStyle={{ paddingTop: insets.top + 2, paddingBottom: PAGE_END + insets.bottom }}>
      <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Go back")} style={styles.back}>
        <ChevronLeft size={28} color={colors.ink} />
      </Pressable>
      <Text style={styles.title}>{section ? SECTIONS.find((x) => x.key === section)?.title : T("Settings")}</Text>

      {section ? pages[section] : overview}

      <NameDialog
        visible={!!pairingWith}
        title={T("The code on {name}", { name: pairingWith?.name ?? "" })}
        message={T("On the computer: Settings → Sync & devices → Phones at home → Pair a phone.")}
        placeholder="123 456"
        action={T("Link")}
        digits
        onCancel={() => setPairingWith(null)}
        onDone={(code) => void finishPairing(code)}
      />
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
    </PullDownToClose>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base, paddingHorizontal: 16 },
  back: { width: 44, height: 44, marginLeft: -10, alignItems: "center", justifyContent: "center" },
  title: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.8, marginTop: 4 },
  section: { color: colors.dim, fontSize: 11, fontWeight: "600", letterSpacing: 1.5, marginTop: 26, marginBottom: 8 },
  sectionNote: { color: colors.dim, fontSize: 12.5, lineHeight: 18, marginTop: 8, paddingHorizontal: 2 },
  group: { borderRadius: 12, backgroundColor: colors.panel, overflow: "hidden" },
  row: { padding: 14, gap: 3 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.dim, fontSize: 13 },
  chips: { flexDirection: "row", gap: 8, marginVertical: 8 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingHorizontal: 14, paddingVertical: 8 },
  switchRowOff: { opacity: 0.45 },
  switchText: { flex: 1, minWidth: 0, gap: 3 },
  divider: { height: 1, backgroundColor: colors.hairline, marginLeft: 14 },
  notice: { flexDirection: "row", gap: 12, padding: 14 },
  noticeText: { flex: 1, minWidth: 0, gap: 4 },
  command: { color: colors.ink, fontSize: 13, fontFamily: "monospace", backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, marginTop: 2 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, height: 52, paddingHorizontal: 14 },
  actionText: { flexShrink: 1, color: colors.ink, fontSize: 15 },
  actionGrow: { flex: 1 },
  swatches: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginVertical: 10 },
  swatch: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  overview: { marginTop: 18 },
  appCard: { alignItems: "center", gap: 6, marginTop: 14, padding: 18, borderRadius: 20, overflow: "hidden", backgroundColor: colors.panel },
  appMark: { width: 54, height: 54, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.08)" },
  appMarkText: { color: colors.ink, fontSize: 30, fontWeight: "900", fontStyle: "italic", letterSpacing: -1.5 },
  appName: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  appLine: { color: colors.dim, fontSize: 12.5, textAlign: "center" },
  groupTitle: { color: colors.dim, fontSize: 11, fontWeight: "800", letterSpacing: 1.6, textTransform: "uppercase", textAlign: "center", marginTop: 20, marginBottom: 8 },
  overviewRow: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 64, paddingHorizontal: 14, paddingVertical: 10 },
  overviewIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.07)", alignItems: "center", justifyContent: "center" },
  overviewDivider: { height: 1, backgroundColor: colors.hairline, marginLeft: 64 },
});
