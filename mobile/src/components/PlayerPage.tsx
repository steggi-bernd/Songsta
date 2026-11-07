/**
 * The full player's page, laid out as on Spotify: "Playing from …" on top, room
 * for the cover (it lives on the sheet, it flies), title and artist with the
 * like beside them, the scrubber, the transport, where the sound goes, what's
 * playing and the queue, and the cards underneath: the lyrics first, then what
 * the computer shows in its side panel.
 */
import { useNavigation } from "@react-navigation/native";
import { Bluetooth, Check, ChevronDown, EllipsisVertical, Headphones, Laptop, ListMusic, Pause, Play, Plus, Repeat, Repeat1, Share2, Shuffle, SkipBack, SkipForward, Smartphone, Tv, Speaker  } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { PanResponder, PixelRatio, Pressable, Share, StyleSheet, Text, View, type GestureResponderHandlers } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import Player, { type SoundOutput } from "../../modules/media3-player";
import { tinted } from "../color";
import { currentLine, useLyrics } from "../lyrics";
import { albumKeyOf, playingFrom } from "../playingFrom";
import { playingNow } from "../quality";
import { describePlayback, fmtTime, type Track } from "../shared";
import { useCoverColor, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { feel } from "../stores/settings";
import { colors, qualityColors } from "../theme";
import { AboutArtistCard, AboutSongCard, NextUpCard } from "./PlayerCards";
import { SongDownloadButton } from "./SongMenu";
import { TrackStrip } from "./TrackStrip";
import type { LyricLine } from "../jellyfin";
import { T } from "../shared";

const OUTPUT_ICON = { phone: Smartphone, wired: Headphones, bluetooth: Bluetooth, tv: Tv };

/** Where the sound comes out; news of a change can go missing while the app is away, so an opened player asks again. */
function useSoundOutput(asking: boolean): SoundOutput {
  const [output, setOutput] = useState<SoundOutput>({ kind: "phone", name: "" });
  useEffect(() => {
    const sub = Player.addListener("onOutput", setOutput);
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (asking) void Player.getOutput().then(setOutput).catch(() => undefined);
  }, [asking]);
  return output;
}

const SIDE = 23;
const LIKE_ROOM = 54;
const TITLE_HEIGHT = 56 * Math.max(1, PixelRatio.getFontScale());

function Scrubber() {
  const position = usePlayer((s) => s.positionMs);
  const duration = usePlayer((s) => s.durationMs);
  const seek = usePlayer((s) => s.seek);
  const [drag, setDrag] = useState<number | null>(null);
  const width = useRef(1);
  const start = useRef(0);
  const shown = drag ?? position;
  const part = duration > 0 ? Math.min(1, shown / duration) : 0;

  const pan = useMemo(() => {
    const at = (x: number): number => Math.max(0, Math.min(1, x / width.current));
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        start.current = e.nativeEvent.locationX;
        feel("tick");
        setDrag(at(start.current) * usePlayer.getState().durationMs);
      },
      onPanResponderMove: (_, g) => setDrag(at(start.current + g.dx) * usePlayer.getState().durationMs),
      onPanResponderRelease: (_, g) => {
        feel("tick");
        seek(at(start.current + g.dx) * usePlayer.getState().durationMs);
        setDrag(null);
      },
      onPanResponderTerminate: () => setDrag(null),
    });
  }, [seek]);

  return (
    <View>
      <View
        {...pan.panHandlers}
        accessibilityRole="adjustable"
        accessibilityLabel={T("Position in the song")}
        onLayout={(e) => (width.current = e.nativeEvent.layout.width || 1)}
        style={styles.scrubHit}
      >
        <View pointerEvents="none" style={styles.scrubTrack}>
          <View style={[styles.scrubFill, { width: `${part * 100}%` }]} />
          <View style={[styles.scrubKnob, { left: `${part * 100}%` }, drag !== null && styles.scrubKnobHeld]} />
        </View>
      </View>
      <View style={styles.times}>
        <Text style={styles.time}>{fmtTime(shown / 1000)}</Text>
        <Text style={styles.time}>{fmtTime(duration / 1000)}</Text>
      </View>
    </View>
  );
}

function LyricsCard({ lines, track }: { lines: LyricLine[]; track: Track }) {
  const nav = useNavigation<any>();
  const color = useCoverColor(track.thumb);
  const at = usePlayer((s) => Math.max(0, currentLine(lines, s.positionMs)));
  return (
    <Pressable onPress={() => nav.navigate("Lyrics")} style={[styles.lyricsCard, { backgroundColor: tinted(color, 0.3) }]}>
      <Text style={styles.cardTitle}>{T("Lyrics")}</Text>
      {lines.slice(at, at + 3).map((l, i) => (
        <Text key={i} numberOfLines={2} style={[styles.lyricLine, i > 0 && styles.lyricLineNext]}>
          {l.text || "♪"}
        </Text>
      ))}
    </Pressable>
  );
}

export function PlayerPage({
  height,
  expanded,
  swipe,
  onClose,
  onMenu,
  onQuality,
  onContext,
  onAlbum,
  onArtist,
  onCoverArea,
  onCardsHeight,
}: {
  /** of the part down to the transport; the cards come after */
  height: number;
  expanded: boolean;
  swipe: GestureResponderHandlers;
  onClose: () => void;
  onMenu: () => void;
  onQuality: () => void;
  /** to the page the queue was started from */
  onContext: (page: { screen: string; params: object }) => void;
  onAlbum: (albumKey: string) => void;
  onArtist: (track: Track) => void;
  onCoverArea: (y: number, height: number) => void;
  onCardsHeight: (height: number) => void;
}) {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width } = useSafeAreaFrame();
  const track = usePlayer((s) => s.queue[s.index]);
  const context = usePlayer((s) => s.context);
  const playWhenReady = usePlayer((s) => s.playWhenReady);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const error = usePlayer((s) => s.error);
  const { toggle, next, previous, toggleShuffle, cycleRepeat } = usePlayer.getState();
  const liked = useLibrary((s) => (track ? s.favorites.has(track.id) : false));
  const toggleFavorite = useLibrary((s) => s.toggleFavorite);
  const format = useMemo(() => (track ? describePlayback(track) : null), [track]);
  const stream = usePlayer((s) => s.stream);
  const remote = usePlayer((s) => s.remote);
  const device = usePlayer((s) => s.device);
  const output = useSoundOutput(expanded);
  const albums = useLibrary((s) => s.albums);
  const artists = useLibrary((s) => s.artists);
  const mixes = useLibrary((s) => s.mixes);
  const genres = useLibrary((s) => s.genres);
  const playlists = usePlaylists((s) => s.playlists);
  // No questions to the server for a page nobody opened yet.
  const opened = useRef(false);
  if (expanded) opened.current = true;
  const lyrics = useLyrics(opened.current ? track : undefined);

  if (!track) return null;
  const titleWidth = width - SIDE * 2 - LIKE_ROOM + 9;
  const from = playingFrom(context, track, { albums, artists, mixes, genres, playlists });
  const playing = playingNow(stream, format);
  const OutputIcon = device ? (device.tv ? Tv : Speaker) : remote ? (remote.kind === "computer" ? Laptop : Smartphone) : OUTPUT_ICON[output.kind];
  const outputColor = !device && !remote && output.kind === "phone" ? colors.ink : colors.accent;
  const outputName = device?.name ?? remote?.name ?? output.name;

  return (
    <>
      <View style={{ height }}>
        <View style={[styles.top, { marginTop: insets.top + 2 }]}>
          <Pressable onPress={onClose} accessibilityLabel={T("Close the player")} style={styles.iconButton}>
            <ChevronDown size={28} color={colors.ink} />
          </Pressable>
          <Pressable disabled={!from.page} onPress={() => from.page && onContext(from.page)} accessibilityLabel={`${from.label}: ${from.name}`} style={styles.context}>
            <Text numberOfLines={1} style={styles.contextLabel}>
              {from.label}
            </Text>
            <Text numberOfLines={1} style={styles.contextName}>
              {from.name}
            </Text>
          </Pressable>
          <Pressable onPress={onMenu} accessibilityLabel={T("More options")} style={styles.iconButton}>
            <EllipsisVertical size={22} color={colors.ink} />
          </Pressable>
        </View>

        <View style={styles.coverArea} onLayout={(e) => onCoverArea(e.nativeEvent.layout.y, e.nativeEvent.layout.height)} />

        <View style={[styles.controls, { paddingBottom: insets.bottom + 4 }]}>
          <View style={styles.titleRow}>
            <View {...swipe} style={styles.titleStrip}>
              <TrackStrip width={titleWidth}>
                {(t) => (
                  <View style={styles.titleText}>
                    <Pressable
                      onPress={() => {
                        const albumKey = albumKeyOf(t);
                        if (albumKey) onAlbum(albumKey);
                      }}
                      accessibilityLabel={T("{title}: open the album", { title: t.title })}
                      style={styles.titleTap}
                    >
                      <Text numberOfLines={1} style={styles.title}>
                        {t.title}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => onArtist(t)} accessibilityLabel={T("{artist}: open the artist", { artist: t.artist })} style={styles.titleTap}>
                      <Text numberOfLines={1} style={styles.artist}>
                        {t.artist}
                      </Text>
                    </Pressable>
                  </View>
                )}
              </TrackStrip>
            </View>
            <Pressable
              onPress={() => {
                feel("press");
                toggleFavorite(track);
              }}
              accessibilityLabel={liked ? T("Remove from Liked Songs") : T("Add to Liked Songs")}
              style={styles.iconButton}
            >
              {liked ? (
                <View style={styles.likedMark}>
                  <Check size={16} color={colors.onAccent} strokeWidth={3} />
                </View>
              ) : (
                <View style={styles.likeMark}>
                  <Plus size={16} color={colors.ink} strokeWidth={2.4} />
                </View>
              )}
            </Pressable>
          </View>

          {!!error && (
            <Text numberOfLines={2} style={styles.error}>
              {error}
            </Text>
          )}

          <Scrubber />

          <View style={styles.transport}>
            <Pressable onPress={withFeel(toggleShuffle)} accessibilityLabel={T("Shuffle")} accessibilityState={{ selected: shuffle }} style={styles.sideButton}>
              <Shuffle size={24} color={shuffle ? colors.accent : colors.ink} />
              {shuffle && <View style={styles.onDot} />}
            </Pressable>
            <Pressable onPress={withFeel(previous)} accessibilityLabel={T("Previous")} style={styles.skipButton}>
              <SkipBack size={30} color={colors.ink} fill={colors.ink} />
            </Pressable>
            <Pressable onPress={withFeel(toggle)} accessibilityLabel={playWhenReady ? T("Pause") : T("Play")} style={styles.playButton}>
              {playWhenReady ? <Pause size={28} color="#121212" fill="#121212" /> : <Play size={28} color="#121212" fill="#121212" style={styles.playGlyph} />}
            </Pressable>
            <Pressable onPress={withFeel(next)} accessibilityLabel={T("Next")} style={styles.skipButton}>
              <SkipForward size={30} color={colors.ink} fill={colors.ink} />
            </Pressable>
            <Pressable onPress={withFeel(cycleRepeat)} accessibilityLabel={T("Repeat: {repeat}", { repeat })} style={styles.sideButton}>
              {repeat === "one" ? <Repeat1 size={24} color={colors.accent} /> : <Repeat size={24} color={repeat === "all" ? colors.accent : colors.ink} />}
              {repeat !== "off" && <View style={styles.onDot} />}
            </Pressable>
          </View>

          <View style={styles.bottomRow}>
            <Pressable onPress={() => nav.navigate("Devices")} accessibilityLabel={T("Playing on {value}. Choose where the sound goes", { value: outputName || T("this phone") })} style={styles.device}>
              <OutputIcon size={20} color={outputColor} />
              {!!outputName && (
                <Text numberOfLines={1} style={[styles.deviceName, { color: outputColor }]}>
                  {outputName}
                </Text>
              )}
            </Pressable>
            {!!playing && !remote && !device && (
              <Pressable onPress={onQuality} accessibilityLabel={T("Quality: {text}", { text: playing.text })} style={styles.quality}>
                <Text numberOfLines={1} style={[styles.qualityText, { color: qualityColors[playing.tier] }]}>
                  {playing.text}
                </Text>
              </Pressable>
            )}
            <SongDownloadButton track={track} size={22} style={styles.rowButton} />
            <Pressable
              onPress={() => void Share.share({ message: `${track.title} · ${track.artist}` })}
              accessibilityLabel={T("Share")}
              style={styles.rowButton}
            >
              <Share2 size={22} color={colors.ink} />
            </Pressable>
            <Pressable onPress={() => nav.navigate("Queue")} accessibilityLabel={T("Queue")} style={styles.iconButton}>
              <ListMusic size={24} color={colors.ink} />
            </Pressable>
          </View>
        </View>
      </View>

      <View onLayout={(e) => onCardsHeight(e.nativeEvent.layout.height)} style={[styles.cards, { paddingBottom: insets.bottom + 18 }]}>
        {lyrics.length > 0 && <LyricsCard lines={lyrics} track={track} />}
        <NextUpCard />
        <AboutSongCard track={track} active={expanded} />
        <AboutArtistCard track={track} active={expanded} onOpen={() => onArtist(track)} />
      </View>
    </>
  );
}

/** A button that answers the finger. */
const withFeel = (run: () => void) => (): void => {
  feel("tick");
  run();
};

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  context: { flex: 1, minWidth: 0, alignItems: "center", paddingHorizontal: 4 },
  contextLabel: { color: "rgba(255,255,255,0.72)", fontSize: 10.5, fontWeight: "600", letterSpacing: 0.9, textTransform: "uppercase" },
  contextName: { color: colors.ink, fontSize: 13, fontWeight: "700", marginTop: 1 },
  coverArea: { flex: 1 },
  controls: { paddingHorizontal: SIDE },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10, marginRight: -9 },
  titleStrip: { flex: 1, minWidth: 0, height: TITLE_HEIGHT, overflow: "hidden" },
  titleText: { flex: 1, justifyContent: "center" },
  titleTap: { alignSelf: "flex-start", maxWidth: "100%" },
  title: { color: colors.ink, fontSize: 21, fontWeight: "700", letterSpacing: -0.3 },
  artist: { color: "rgba(255,255,255,0.72)", fontSize: 15, marginTop: 5 },
  likedMark: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  likeMark: { width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: colors.ink, alignItems: "center", justifyContent: "center" },
  error: { color: "#FF9D9D", fontSize: 13, marginTop: 8 },
  scrubHit: { height: 32, justifyContent: "center", marginTop: 10 },
  scrubTrack: { height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)" },
  scrubFill: { height: 3, borderRadius: 2, backgroundColor: colors.ink },
  scrubKnob: { position: "absolute", top: -2.5, width: 8, height: 8, marginLeft: -4, borderRadius: 4, backgroundColor: colors.ink },
  scrubKnobHeld: { top: -5, width: 13, height: 13, marginLeft: -6.5, borderRadius: 6.5 },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: -3 },
  time: { color: "rgba(255,255,255,0.72)", fontSize: 12, fontVariant: ["tabular-nums"] },
  transport: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10, marginHorizontal: -9 },
  sideButton: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  skipButton: { width: 56, height: 56, alignItems: "center", justifyContent: "center" },
  playButton: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  playGlyph: { marginLeft: 3 },
  onDot: { position: "absolute", bottom: 4, width: 4, height: 4, borderRadius: 2, backgroundColor: colors.accent },
  bottomRow: { flexDirection: "row", alignItems: "center", marginTop: 8, marginHorizontal: -9 },
  device: { flex: 1, minWidth: 44, height: 44, flexDirection: "row", alignItems: "center", gap: 7, paddingLeft: 9, paddingRight: 8 },
  deviceName: { flexShrink: 1, fontSize: 12.5, fontWeight: "600" },
  quality: { height: 44, justifyContent: "center", paddingLeft: 2, paddingRight: 4 },
  qualityText: { fontSize: 12.5, fontWeight: "700", fontVariant: ["tabular-nums"] },
  rowButton: { width: 40, height: 44, minWidth: 40, alignItems: "center", justifyContent: "center" },
  cards: { paddingHorizontal: 15, gap: 14 },
  lyricsCard: { minHeight: 240, borderRadius: 12, padding: 16 },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", marginBottom: 14 },
  lyricLine: { color: colors.ink, fontSize: 21, fontWeight: "700", lineHeight: 28, letterSpacing: -0.2 },
  lyricLineNext: { color: "rgba(255,255,255,0.62)", marginTop: 6 },
});
