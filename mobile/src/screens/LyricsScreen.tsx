/** The lyrics over the cover's colour: the sung line bright, a tap on a line jumps there. */
import { useNavigation } from "@react-navigation/native";
import { ChevronDown, Pause, Play } from "lucide-react-native";
import { memo, useEffect, useRef, useState, type ComponentRef } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tinted } from "../color";
import { currentLine, useLyrics } from "../lyrics";
import { fmtTime, hasCyrillic, toLatin } from "../shared";
import { useCoverColor } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useOverBottomBar } from "../stores/popups";
import { useSettings } from "../stores/settings";
import { colors } from "../theme";
import { T } from "../shared";

/** After someone scrolled the lines themselves, how long the list stays where they put it. */
const READING_MS = 5000;
/** Where the sung line rests, as a part of the list's height. */
const RESTS_AT = 0.3;

type LineState = "sung" | "past" | "next";

/** One line; only those whose state changes draw again as the song goes on. */
const Line = memo(function Line({
  text,
  state,
  latin,
  at,
  onSeek,
  onPlace,
  index,
}: {
  text: string;
  state: LineState;
  latin: boolean;
  at: number | undefined;
  onSeek: (at: number) => void;
  onPlace: (index: number, y: number) => void;
  index: number;
}) {
  return (
    <Pressable disabled={at === undefined} onPress={() => at !== undefined && onSeek(at)} onLayout={(e) => onPlace(index, e.nativeEvent.layout.y)}>
      <Text style={[styles.line, state === "past" && styles.linePast, state === "next" && styles.lineNext]}>{text || "♪"}</Text>
      {latin && hasCyrillic(text) && <Text style={styles.latin}>{toLatin(text)}</Text>}
    </Pressable>
  );
});

export function LyricsScreen() {
  const nav = useNavigation<any>();
  useOverBottomBar();
  const insets = useSafeAreaInsets();
  const track = usePlayer((s) => s.queue[s.index]);
  const position = usePlayer((s) => s.positionMs);
  const duration = usePlayer((s) => s.durationMs);
  const playWhenReady = usePlayer((s) => s.playWhenReady);
  const { toggle } = usePlayer.getState();
  const lines = useLyrics(track);
  const color = useCoverColor(track?.thumb);
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const places = useRef<number[]>([]);
  const readingUntil = useRef(0);
  const [height, setHeight] = useState(0);
  // Positions come in as the lines are laid out; the sung line goes to its place once they did.
  const [placed, setPlaced] = useState(0);
  const synced = useSettings((s) => s.syncedLyrics);
  const dim = useSettings((s) => s.dimLyrics);
  const latin = useSettings((s) => s.lyricsLatin);
  const at = synced ? currentLine(lines, position) : -1;
  const timed = synced && dim && lines.length > 0 && lines[0].at !== undefined;

  useEffect(() => {
    places.current = [];
    setPlaced(0);
    list.current?.scrollTo({ y: 0, animated: false });
  }, [lines]);

  useEffect(() => {
    const follow = (): void => {
      if (at < 0) {
        list.current?.scrollTo({ y: 0, animated: true });
        return;
      }
      const y = places.current[at];
      if (y !== undefined) list.current?.scrollTo({ y: Math.max(0, y - height * RESTS_AT), animated: true });
    };
    const wait = readingUntil.current - Date.now();
    if (wait <= 0) {
      follow();
      return;
    }
    const timer = setTimeout(follow, wait);
    return () => clearTimeout(timer);
  }, [at, height, placed]);

  const onPlace = useRef((index: number, y: number): void => {
    places.current[index] = y;
    setPlaced((n) => n + 1);
  }).current;
  const onSeek = useRef((to: number): void => {
    readingUntil.current = 0;
    usePlayer.getState().seek(to);
  }).current;

  const background = tinted(color, 0.26);
  const part = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <View style={[styles.root, { backgroundColor: background }]}>
      <View style={[styles.top, { paddingTop: insets.top + 2 }]}>
        <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Close the lyrics")} style={styles.close}>
          <ChevronDown size={28} color={colors.ink} />
        </Pressable>
        <View style={styles.topText}>
          <Text numberOfLines={1} style={styles.title}>
            {track?.title}
          </Text>
          <Text numberOfLines={1} style={styles.artist}>
            {track?.artist}
          </Text>
        </View>
      </View>

      <ScrollView
        ref={list}
        style={styles.scroller}
        contentContainerStyle={styles.lines}
        onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
        onScrollBeginDrag={() => {
          readingUntil.current = Date.now() + READING_MS;
        }}
      >
        {lines.map((line, index) => (
          <Line
            key={index}
            index={index}
            text={line.text}
            at={line.at}
            latin={latin}
            state={!timed || index === at ? "sung" : index < at ? "past" : "next"}
            onSeek={onSeek}
            onPlace={onPlace}
          />
        ))}
      </ScrollView>

      <View style={[styles.bottom, { backgroundColor: background, paddingBottom: insets.bottom + 14 }]}>
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${part * 100}%` }]} />
        </View>
        <View style={styles.times}>
          <Text style={styles.time}>{fmtTime(position / 1000)}</Text>
          <Text style={styles.time}>{fmtTime(duration / 1000)}</Text>
        </View>
        <Pressable onPress={toggle} accessibilityLabel={playWhenReady ? T("Pause") : T("Play")} style={styles.play}>
          {playWhenReady ? <Pause size={26} color={colors.base} fill={colors.base} /> : <Play size={26} color={colors.base} fill={colors.base} />}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  top: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingBottom: 10 },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  topText: { flex: 1, minWidth: 0 },
  title: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  artist: { color: "rgba(255,255,255,0.78)", fontSize: 13, marginTop: 2 },
  scroller: { flex: 1 },
  lines: { paddingHorizontal: 24, paddingVertical: 12, gap: 18 },
  line: { color: colors.ink, fontSize: 27, fontWeight: "800", lineHeight: 33, letterSpacing: -0.6 },
  latin: { color: "rgba(255,255,255,0.62)", fontSize: 16, lineHeight: 22, marginTop: 4 },
  linePast: { color: "rgba(255,255,255,0.48)" },
  lineNext: { color: "rgba(255,255,255,0.62)" },
  bottom: { paddingHorizontal: 24, paddingTop: 12 },
  track: { height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.26)" },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.ink },
  times: { flexDirection: "row", justifyContent: "space-between", marginTop: 8 },
  time: { color: "rgba(255,255,255,0.78)", fontSize: 12 },
  play: { alignSelf: "center", width: 60, height: 60, marginTop: 6, borderRadius: 30, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
});
