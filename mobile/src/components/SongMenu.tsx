/** What a song's menu offers, and the download buttons of a song and of a whole list. */
import { ArrowDown, CircleArrowDown, Disc3, ListPlus, ListStart, Share2, Speaker, Undo2, User, Volume2, VolumeX, type LucideIcon } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Share, StyleSheet, Text, View, type ViewStyle } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { create } from "zustand";
import { albumKeyOf } from "../playingFrom";
import { leadArtist, plural, type Track } from "../shared";
import { useConnection } from "../stores/connection";
import { downloadOf, percentOf, useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { showDialog, toast } from "../stores/popups";
import { canPlay, deviceName, startOwnMusicOn, useZones } from "../stores/zones";
import { colors } from "../theme";
import { MenuSheet, type SheetRow } from "./Sheet";
import { Cover } from "./ui";
import { T } from "../shared";

interface MenuExtra {
  label: string;
  Icon?: LucideIcon;
  run(): void;
}

interface SongMenuState {
  track: Track | null;
  extras: MenuExtra[];
  /** a playlist's song this library doesn't have: only the extras apply */
  plain: boolean;
  /** to a page in the tab that's showing: the bottom bar knows which that is */
  goTo: ((screen: string, params: object) => void) | null;
  open(track: Track, options?: { extras?: MenuExtra[]; plain?: boolean }): void;
  close(): void;
}

export const useSongMenu = create<SongMenuState>((set) => ({
  track: null,
  extras: [],
  plain: false,
  goTo: null,
  open: (track, options) => set({ track, extras: options?.extras ?? [], plain: !!options?.plain }),
  close: () => set({ track: null, extras: [], plain: false }),
}));

const DOWNLOAD_LABEL = { kept: T("Remove download"), loading: T("Stop downloading"), wifi: T("Stop waiting for Wi-Fi"), failed: T("Try downloading again") } as const;

/** On mobile data the question comes up at once: nothing that silently waits for a Wi-Fi nobody has in mind. */
export function startDownload(tracks: Track[]): void {
  const { add, overMobile, setOverMobile, quality } = useDownloads.getState();
  if (!useConnection.getState().metered || overMobile) {
    add(tracks);
    return;
  }
  showDialog(
    T("You're on mobile data"),
    quality === "original" ? T("Downloading the files themselves takes about 10 MB a minute of music, or wait for Wi-Fi.") : T("Downloading takes about 1.5 MB a minute of music, or wait for Wi-Fi."),
    [
      { text: T("Wait for Wi-Fi"), onPress: () => add(tracks) },
      {
        text: T("Use mobile data"),
        onPress: () => {
          setOverMobile(true);
          add(tracks);
        },
      },
    ],
    { cancelable: true }
  );
}

/** One song's download, the same words wherever it is offered. */
export function useDownloadAction(track: Track | null | undefined): { label: string; run(): void } | null {
  const state = useDownloads((s) => (track ? downloadOf(s, track.id) : null));
  if (!track || track.localPath) return null;
  const { remove } = useDownloads.getState();
  return {
    label: state ? DOWNLOAD_LABEL[state] : T("Download"),
    run: () => (state === "kept" || state === "loading" || state === "wifi" ? remove([track]) : startDownload([track])),
  };
}

export function SongMenu() {
  const { track, extras, plain, goTo, close } = useSongMenu();
  const download = useDownloadAction(track);
  const albumKey = track ? albumKeyOf(track) : null;
  const muted = useLibrary((s) => !!track && s.muted.has(track.id));
  const [playOn, setPlayOn] = useState<Track | null>(null);
  const found = useZones((s) => s.found);
  const names = useZones((s) => s.names);
  const playable = found.filter(canPlay);
  const branch = track ? usePlayer.getState().branches.find((b) => b.trackId === track.id) : undefined;
  const rows: SheetRow[] = [];
  if (track && !plain) {
    if (download) rows.push({ label: download.label, Icon: CircleArrowDown, run: download.run });
    rows.push({ label: T("Add to playlist"), Icon: ListPlus, run: () => usePlaylists.getState().setPicking(track) });
    rows.push({
      label: T("Add to queue"),
      Icon: ListStart,
      run: () => {
        const inLine = usePlayer.getState().addToQueue([track]);
        toast(inLine > 1 ? T("Added to queue, after {count}", { count: plural(inLine - 1, T("other song"), T("other songs")) }) : T("Plays next"));
      },
    });
    if (branch) {
      rows.push({
        label: T("Undo branch"),
        Icon: Undo2,
        run: () => {
          usePlayer.getState().cancelBranch(branch.name);
          toast(T("Branch taken back"));
        },
      });
    }
    if (playable.length > 0) rows.push({ label: T("Play on a device"), Icon: Speaker, run: () => setPlayOn(track) });
    if (albumKey) rows.push({ label: T("Go to album"), Icon: Disc3, run: () => goTo?.("Album", { albumKey }) });
    rows.push({ label: T("Go to artist"), Icon: User, run: () => goTo?.("Artist", { name: leadArtist(track.artist) }) });
    rows.push({ label: muted ? T("Play again (unmute)") : T("Mute song"), Icon: muted ? Volume2 : VolumeX, run: () => void useLibrary.getState().toggleMuted(track) });
    rows.push({ label: T("Share"), Icon: Share2, run: () => void Share.share({ message: `${track.title} · ${track.artist}` }) });
  }
  for (const extra of extras) rows.push(extra);
  return (
    <>
      <MenuSheet visible={!!track} art={track ? <Cover uri={track.thumb} size={46} /> : undefined} title={track?.title} subtitle={track?.artist} rows={rows} onClose={close} />
      <MenuSheet
        visible={!!playOn}
        title={T("Play on")}
        subtitle={playOn?.title}
        rows={playable.map((d) => ({
          label: deviceName(d, names),
          Icon: Speaker,
          run: () => {
            if (playOn) void startOwnMusicOn([d], [playOn]);
          },
        }))}
        onClose={() => setPlayOn(null)}
      />
    </>
  );
}

/** How far a song is: a ring that closes around the arrow. */
function DownloadRing({ size, part }: { size: number; part: number }) {
  const stroke = Math.max(2, size / 11);
  const radius = (size - stroke) / 2;
  const around = 2 * Math.PI * radius;
  const middle = size / 2;
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={middle} cy={middle} r={radius} stroke={colors.hairline} strokeWidth={stroke} fill="none" />
        <Circle
          cx={middle}
          cy={middle}
          r={radius}
          stroke={colors.accent}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${around * part} ${around}`}
          fill="none"
          transform={`rotate(-90 ${middle} ${middle})`}
        />
      </Svg>
      <ArrowDown size={size * 0.55} color={colors.accent} />
    </View>
  );
}

/** One song's arrow: nothing said in words. It also takes the song off again. */
export function SongDownloadButton({ track, size = 24, style }: { track: Track; size?: number; style?: ViewStyle }) {
  const state = useDownloads((s) => downloadOf(s, track.id));
  const percent = useDownloads((s) => percentOf(s, track.id));
  const { remove } = useDownloads.getState();
  if (track.localPath) return null;
  return (
    <Pressable
      accessibilityLabel={state ? DOWNLOAD_LABEL[state] : T("Download")}
      onPress={() => {
        if (state === "kept") {
          showDialog(T("Remove this download?"), T("“{title}” goes from this phone. It stays on your server.", { title: track.title }), [
            { text: T("Cancel"), style: "cancel" },
            { text: T("Remove"), style: "destructive", onPress: () => remove([track]) },
          ]);
        } else if (state === "loading" || state === "wifi") remove([track]);
        else startDownload([track]);
      }}
      style={[styles.button, style]}
    >
      {state === "loading" && percent !== null && percent >= 0 ? (
        <DownloadRing size={size} part={percent / 100} />
      ) : (
        <CircleArrowDown
          size={size}
          color={state === "kept" ? colors.onAccent : state === "failed" ? "#FF9D9D" : state ? colors.accent : colors.ink}
          fill={state === "kept" ? colors.accent : "transparent"}
        />
      )}
    </Pressable>
  );
}

/** All of a list on the phone: the arrow fills up as its songs arrive. */
export function DownloadButton({ tracks, list, size = 24, style }: { tracks: Track[]; /** which list this is: it then stays whole */ list?: string; size?: number; style?: ViewStyle }) {
  const counts = useDownloads((s) => {
    let kept = 0;
    let loading = 0;
    for (const t of tracks) {
      if (s.kept[t.id]) kept += 1;
      else if (s.loading[t.id] && !s.loading[t.id].failed) loading += 1;
    }
    return `${kept}/${loading}`;
  });
  const [kept, loading] = counts.split("/").map(Number);
  const all = tracks.length > 0 && kept === tracks.length;
  const { remove, keepList, dropList } = useDownloads.getState();
  const label = all ? T("Remove download") : loading ? T("Downloading") : T("Download");
  return (
    <Pressable
      accessibilityLabel={label}
      onPress={() => {
        if (!tracks.length) return;
        if (all || loading) {
          showDialog(all ? T("Remove these downloads?") : T("Stop these downloads?"), T("{count} from this phone. They stay on your server.", { count: plural(kept + loading, T("song"), T("songs")) }), [
            { text: T("Cancel"), style: "cancel" },
            {
              text: T("Remove"),
              style: "destructive",
              onPress: () => {
                if (list) dropList(list);
                remove(tracks, false);
              },
            },
          ]);
        } else {
          if (list) keepList(list);
          startDownload(tracks);
        }
      }}
      style={[styles.button, style]}
    >
      <CircleArrowDown size={size} color={all ? colors.onAccent : loading ? colors.accent : colors.ink} fill={all ? colors.accent : "transparent"} />
      {!!loading && (
        <Text style={styles.count}>
          {kept}/{tracks.length}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 44, height: 44 },
  count: { color: colors.accent, fontSize: 12, fontWeight: "600" },
});
