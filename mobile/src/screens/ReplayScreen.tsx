/**
 * Replay on the phone as a story (the user's wish, 2026-11-16), in the look they picked from the mockups
 * ("Farbflächen", A on the canvas page "Replay (Handy)"): every slide a field of one strong colour with
 * big type, made for portrait from the start. The period loud with its numbers, the album of the period,
 * five songs, prime time hour by hour, the pulse day by day, the day of the week, the faces, the songs new
 * to you, mostly which genre with how it sounded and where it came from, and the ticket to end with the
 * top songs to play or keep and the listening history.
 *
 * As stories go: the bars on top say where you are and run on by themselves; a tap on the right goes
 * on, on the left back; holding stops the clock; pulling down closes. Counted from every play: this
 * phone's and, with a sync service, every other device's (stores/listens.ts); nothing estimated.
 */
import { useNavigation } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { Play, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Text as SvgText } from "react-native-svg";
import { PullDownToClose } from "../components/PullDownToClose";
import { Cover } from "../components/ui";
import { artistPhotoUrl } from "../jellyfin";
import { pulseRows, shareParts, storyFacts, type PulseRow, type StoryFacts } from "../replayStory";
import { plural, T, textLocale } from "../shared";
import { useLibrary } from "../stores/library";
import { periodRange, summarize, useListens, type PhoneListen, type ReplayPeriod, type ReplaySummary, type ReplayTop } from "../stores/listens";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { toast } from "../stores/popups";
import { useSession } from "../stores/session";
import { useNoStatusScrim } from "../stores/statusScrim";
import { readListensNow } from "../sync";
import { colors } from "../theme";

const PERIODS: { key: ReplayPeriod; label: string }[] = [
  { key: "month", label: T("This month") },
  { key: "lastMonth", label: T("Last month") },
  { key: "year", label: T("This year") },
  { key: "all", label: T("All time") },
];

/** A slide's field of colour, the ink on it, and the second colour some of them pick things out with. */
interface Look {
  back: string;
  ink: string;
  pick?: string;
  /** light ink on a dark field: the status bar goes light too */
  dark?: boolean;
}
const LOOK = {
  open: { back: "#a78bfa", ink: "#1a1033", pick: "#c4b5fd" },
  first: { back: "#d9f99d", ink: "#1a2e05" },
  five: { back: "#fb7185", ink: "#2a0a12" },
  prime: { back: "#1e1b4b", ink: "#ffffff", pick: "#fbbf24", dark: true },
  pulse: { back: "#5eead4", ink: "#042f2e" },
  day: { back: "#fbbf24", ink: "#1c1002" },
  faces: { back: "#f4efe6", ink: "#1c1917" },
  fresh: { back: "#7dd3fc", ink: "#082f49" },
  mostly: { back: "#ede9fe", ink: "#1e1b4b" },
  ticket: { back: "#4c1d95", ink: "#ffffff", pick: "#c4b5fd", dark: true },
} satisfies Record<string, Look>;
const GENRE_COLORS = ["#38bdf8", "#a78bfa", "#f59e0b", "#2dd4bf"];

/** One of the colours above, see-through. */
function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Numbers and dates in the interface's language, not the phone's. */
const count = (n: number): string => n.toLocaleString(textLocale());

function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return T("{minutes} min", { minutes: Math.max(1, Math.round(ms / 60000)) });
  const hours = h < 10 ? h.toLocaleString(textLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : String(Math.round(h));
  return T("{hours} hrs", { hours });
}

const clock = (h: number): string => `${String(h).padStart(2, "0")}:00`;

/** Monday first; 2024-01-01 was a Monday. */
function weekdayNames(): { short: string; long: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(2024, 0, 1 + i);
    return { short: d.toLocaleDateString(textLocale(), { weekday: "short" }), long: d.toLocaleDateString(textLocale(), { weekday: "long" }) };
  });
}

/** A pulse row's name: "Mo 9." for a day, "Nov." for a month. */
function rowLabel(r: PulseRow): string {
  const d = new Date(r.at);
  if (r.unit === "month") return d.toLocaleDateString(textLocale(), { month: "short" });
  return T("{weekday} {day}", { weekday: d.toLocaleDateString(textLocale(), { weekday: "short" }).replace(/\.$/, ""), day: d.getDate() });
}

const longestWord = (text: string): number => Math.max(4, ...text.split(/\s+/).map((w) => w.length));

interface CoverIndex {
  byId: Map<string, string>;
  bySong: Map<string, string>;
  byAlbum: Map<string, string>;
  byArtist: Map<string, string>;
}

/** This phone's covers by song, album and artist: the computer's songs are shown with the phone's own pictures where it has them. */
function coverIndex(tracks: { id: string; title: string; artist: string; album?: string; albumArtist?: string; thumb?: string }[]): CoverIndex {
  const index: CoverIndex = { byId: new Map(), bySong: new Map(), byAlbum: new Map(), byArtist: new Map() };
  for (const t of tracks) {
    if (!t.thumb) continue;
    index.byId.set(t.id, t.thumb);
    index.bySong.set(`${t.title}|${t.artist}`.toLowerCase(), t.thumb);
    if (t.album) index.byAlbum.set(`${t.album}|${t.albumArtist || t.artist}`.toLowerCase(), t.thumb);
    if (!index.byArtist.has(t.artist.toLowerCase())) index.byArtist.set(t.artist.toLowerCase(), t.thumb);
  }
  return index;
}

/** The phone's own picture first (the computer's addresses lead to the server its own way), the computer's where the phone has none. */
const songCover = (t: { id?: string; name: string; sub: string; thumb: string }, index: CoverIndex): string =>
  (t.id && index.byId.get(t.id)) || index.bySong.get(`${t.name}|${t.sub}`.toLowerCase()) || t.thumb;

function withCovers(summary: ReplaySummary, index: CoverIndex): ReplaySummary {
  return {
    ...summary,
    tracks: summary.tracks.map((t) => ({ ...t, thumb: songCover(t, index) })),
    albums: summary.albums.map((a) => ({ ...a, thumb: index.byAlbum.get(`${a.name}|${a.sub}`.toLowerCase()) || a.thumb })),
    artists: summary.artists.map((a) => ({ ...a, thumb: index.byArtist.get(a.name.toLowerCase()) || a.thumb })),
  };
}

/** When the other device last counted: the time today, else the day. */
function whenSaid(at: number): string {
  const d = new Date(at);
  return d.toDateString() === new Date().toDateString()
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : d.toLocaleDateString(textLocale(), { day: "numeric", month: "short" });
}

/** "Today", "Yesterday", else the weekday and date. */
function dayTitle(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return T("Today");
  if (d.toDateString() === yesterday.toDateString()) return T("Yesterday");
  return d.toLocaleDateString(textLocale(), { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce, () => undefined);
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

/** A part of a slide coming in: up a little and out of nothing, one after the other. */
function Rise({ delay = 0, style, children }: { delay?: number; style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    const run = Animated.timing(v, { toValue: 1, duration: 560, delay, easing: Easing.out(Easing.cubic), useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [v, delay, reduce]);
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }] }]}>{children}</Animated.View>;
}

/** The height a part of a slide was given once laid out: the lists size their rows from it. */
function useRoom(): [number, (e: LayoutChangeEvent) => void] {
  const [room, setRoom] = useState(0);
  const onLayout = (e: LayoutChangeEvent): void => {
    const next = Math.floor(e.nativeEvent.layout.height);
    setRoom((old) => (Math.abs(old - next) > 1 ? next : old));
  };
  return [room, onLayout];
}

/**
 * Big type, tight. The lines are closer than the font's own height, so the first line's top and the last
 * line's bottom lose a little of the glyphs: the room above keeps an umlaut whole, the room below a g, p or y.
 */
const bigType = (size: number) => ({ fontSize: size, lineHeight: Math.round(size * 0.96), letterSpacing: -size * 0.045, paddingTop: Math.round(size * 0.1), paddingBottom: Math.round(size * 0.16) });

/** A size at which all of `text` fits in `lines` lines of `width`: no word broken, nothing cut off, as big as `max`. */
function fitType(text: string, width: number, max: number, lines: number, min = 22): number {
  const byWord = width / (longestWord(text) * 0.6);
  const byLines = (width * lines) / (Math.max(1, text.length) * 0.62);
  return Math.round(Math.max(min, Math.min(max, byWord, byLines)));
}

/** Big type in two parts, the second in italics: as big as the look asks, smaller where a word wouldn't fit. */
function Headline({ first, accent, size, width, look, pick }: { first: string; accent: string; size: number; width: number; look: Look; pick?: boolean }) {
  const fit = Math.round(Math.min(size, width / (longestWord(`${first} ${accent}`) * 0.6)));
  return (
    <Text style={[styles.heavy, bigType(fit), { color: look.ink }]}>
      {first}
      {"\n"}
      <Text style={[styles.italic, pick && look.pick ? { color: look.pick } : null]}>{accent}</Text>
    </Text>
  );
}

/** A round-ended button across the slide. */
function Pill({ label, onPress, back, ink, height, icon = true }: { label: string; onPress: () => void; back: string; ink: string; height: number; icon?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.pill, { height, borderRadius: height / 2, backgroundColor: back, opacity: pressed ? 0.85 : 1 }]}>
      {icon && <Play size={18} color={ink} fill={ink} />}
      <Text style={[styles.pillText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

/** A rank drawn in outline only, as the five songs' numbers are. */
function Outline({ n, size, width, ink }: { n: number; size: number; width: number; ink: string }) {
  return (
    <Svg width={width} height={Math.round(size * 0.8)}>
      <SvgText x={width / 2} y={Math.round(size * 0.74)} fontSize={size} fontWeight="900" textAnchor="middle" fill="none" stroke={ink} strokeWidth={Math.max(1.5, size / 52)}>
        {String(n)}
      </SvgText>
    </Svg>
  );
}

interface Part {
  label: string;
  share: number;
  color: string;
}

/** A share of a whole as one thin bar in parts, each named under it with its share. */
function ShareBlock({ title, parts, ink }: { title: string; parts: Part[]; ink: string }) {
  return (
    <View style={styles.shareBlock}>
      <Text style={[styles.label, { color: ink, opacity: 0.6 }]}>{title}</Text>
      <View style={styles.shareBar}>
        {parts.map((p) => (
          <View key={p.label} style={{ flex: Math.max(0.0001, p.share), backgroundColor: p.color }} />
        ))}
      </View>
      <View style={styles.shareLegend}>
        {parts.map((p) => (
          <View key={p.label} style={styles.shareItem}>
            <View style={[styles.shareDot, { backgroundColor: p.color }]} />
            <Text numberOfLines={1} style={[styles.shareLabel, { color: ink }]}>
              {p.label} {T("{n}%", { n: Math.round(p.share * 100) })}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** The opening: the period, loud, over its top albums fanned out; the numbers at the foot. */
function OpenSlide(props: {
  k: number;
  W: number;
  has: boolean;
  source: string;
  period: ReplayPeriod;
  onPeriod: (p: ReplayPeriod) => void;
  name: string;
  quiet: string;
  covers: string[];
  numbers: { value: number; label: string }[];
}) {
  const { k, W, has, source, period, onPeriod, name, quiet, covers, numbers } = props;
  const look = LOOK.open;
  const size = Math.round(Math.min(64 * k, W / (longestWord(name) * 0.6)));
  const numberSize = Math.round(52 * k);
  return (
    <>
      <Rise>
        <Text style={[styles.eyebrow, { color: look.ink }]}>{T("SONGSTA REPLAY")}</Text>
        {!!source && <Text style={[styles.source, { color: look.ink }]}>{source}</Text>}
      </Rise>
      <Rise delay={80}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.periods} style={styles.periodRow}>
          {PERIODS.map((p) => {
            const on = p.key === period;
            return (
              <Pressable key={p.key} onPress={() => onPeriod(p.key)} accessibilityRole="button" accessibilityState={{ selected: on }} style={[styles.chip, { backgroundColor: on ? look.ink : alpha(look.ink, 0.12) }]}>
                <Text style={[styles.chipText, { color: on ? look.pick : look.ink }]}>{p.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </Rise>
      <Rise delay={160}>
        <Text style={[styles.heavy, bigType(size), { color: look.ink, marginTop: Math.round(10 * k) }]}>
          {has ? T("{period} was", { period: name }) : name} <Text style={styles.italic}>{has ? T("loud.") : quiet}</Text>
        </Text>
      </Rise>
      {!has && <Text style={[styles.empty, { color: look.ink }]}>{T("Play something first — Replay fills in as this phone counts what you listen to.")}</Text>}
      {has && <CoverFan covers={covers} k={k} W={W} back={look.back} />}
      {has && (
        <Rise delay={360} style={styles.numbers}>
          {numbers.map((n) => (
            <View key={n.label} style={styles.numberCell}>
              <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.number, { color: look.ink, fontSize: numberSize, lineHeight: Math.round(numberSize * 1.08), letterSpacing: -numberSize * 0.045 }]}>
                {count(n.value)}
              </Text>
              <Text style={[styles.label, { color: look.ink }]}>{n.label}</Text>
            </View>
          ))}
        </Rise>
      )}
    </>
  );
}

/** Three covers fanned out in the room between the headline and the numbers, the first in the middle and on top. */
function CoverFan({ covers, k, W, back }: { covers: string[]; k: number; W: number; back: string }) {
  const [room, onLayout] = useRoom();
  const big = Math.round(Math.min(162 * k, room * 0.74, W * 0.47));
  const side = Math.round(big * 0.9);
  const shift = Math.round(big * 0.54);
  const at = (size: number, dx: number, dy: number) => ({ left: Math.round(W / 2 + dx - size / 2), top: Math.round(room / 2 + dy - size / 2) });
  const [mid, left, right] = covers;
  return (
    <View style={styles.flex} onLayout={onLayout}>
      {room > 60 && big > 48 && (
        <Rise delay={260} style={StyleSheet.absoluteFill}>
          {!!left && (
            <View style={[styles.fanCard, at(side, -shift, big * 0.07), { backgroundColor: back, transform: [{ rotate: "-10deg" }] }]}>
              <Cover uri={left} size={side} radius={12} />
            </View>
          )}
          {!!right && (
            <View style={[styles.fanCard, at(side, shift, big * 0.07), { backgroundColor: back, transform: [{ rotate: "10deg" }] }]}>
              <Cover uri={right} size={side} radius={12} />
            </View>
          )}
          {!!mid && (
            <View style={[styles.fanCard, at(big, 0, -big * 0.05), { backgroundColor: back, transform: [{ rotate: "-2deg" }] }]}>
              <Cover uri={mid} size={big} radius={12} />
            </View>
          )}
        </Rise>
      )}
    </View>
  );
}

/** N°1: the album of the period, tilted, with its badge; the songs liked best from it. */
function FirstSlide({ k, W, eyebrow, album, favs, onPlay }: { k: number; W: number; eyebrow: string; album: ReplayTop; favs: ReplayTop[]; onPlay?: () => void }) {
  const look = LOOK.first;
  const [room, onLayout] = useRoom();
  const side = Math.round(Math.min(300 * k, W * 0.88, room - 40 * k));
  const badge = Math.round(Math.min(92 * k, side * 0.32));
  const titleSize = fitType(album.name, W, 52 * k, 3);
  const round = Math.round(58 * k);
  return (
    <>
      <Rise>
        <Text style={[styles.eyebrow, { color: look.ink }]}>{eyebrow}</Text>
      </Rise>
      <View style={[styles.flex, styles.center]} onLayout={onLayout}>
        {side > 64 && (
          <Rise delay={120} style={{ width: side, height: side + Math.round(badge * 0.4) }}>
            <View style={[styles.lifted, { borderRadius: 14, backgroundColor: look.back, transform: [{ rotate: "-3deg" }] }]}>
              <Cover uri={album.thumb} size={side} radius={14} />
            </View>
            <View style={[styles.badge, { width: badge, height: badge, borderRadius: badge / 2, left: Math.round(side * 0.92 - badge / 2), top: Math.round(side * 0.97 - badge / 2), backgroundColor: look.ink }]}>
              <Text style={[styles.badgeText, { color: look.back, fontSize: Math.round(badge * 0.37), letterSpacing: -badge * 0.02 }]}>N°1</Text>
            </View>
          </Rise>
        )}
      </View>
      <Rise delay={220}>
        <Text numberOfLines={4} style={[styles.heavy, bigType(titleSize), { color: look.ink }]}>
          {album.name}
        </Text>
        <Text numberOfLines={2} style={[styles.meta, { color: look.ink }]}>
          {[album.sub, fmtHours(album.ms), plural(album.plays, T("play"), T("plays"))].filter(Boolean).join(" · ")}
        </Text>
      </Rise>
      {!!onPlay && (
        <Rise delay={300}>
          <Pressable onPress={onPlay} accessibilityRole="button" style={styles.playRow}>
            <View style={[styles.playRound, { width: round, height: round, borderRadius: round / 2, backgroundColor: look.ink }]}>
              <Play size={Math.round(round * 0.4)} color={look.back} fill={look.back} />
            </View>
            <Text style={[styles.playLabel, { color: look.ink }]}>{T("Play album")}</Text>
          </Pressable>
        </Rise>
      )}
      {favs.length > 0 && (
        <Rise delay={380} style={[styles.favBox, { backgroundColor: alpha(look.ink, 0.08) }]}>
          <Text style={[styles.label, { color: look.ink, opacity: 0.6 }]}>{T("Most played from it")}</Text>
          {favs.map((t) => (
            <View key={t.id ?? t.name} style={styles.favRow}>
              <Cover uri={t.thumb} size={36} radius={6} />
              <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.favTitle, { color: look.ink }]}>
                {t.name}
              </Text>
              <Text style={[styles.favCount, { color: look.ink }]}>{t.plays}×</Text>
            </View>
          ))}
        </Rise>
      )}
    </>
  );
}

/** Five songs, by how often they played: the first big, ranks in outline. */
function FiveSlide({ k, W, five, onPlay }: { k: number; W: number; five: ReplayTop[]; onPlay: (at: number) => void }) {
  const look = LOOK.five;
  const [room, onLayout] = useRoom();
  const r = Math.min(k, room / (150 + (five.length - 1) * 92));
  const most = Math.max(1, ...five.map((t) => t.plays));
  return (
    <>
      <Rise>
        <Headline look={look} size={40 * k} width={W} first={T("Five you")} accent={T("couldn't stop.")} />
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 &&
          five.map((t, i) => {
            const first = i === 0;
            return (
              <Rise key={t.id ?? i} delay={140 + i * 90}>
                <Pressable
                  onPress={() => onPlay(i)}
                  accessibilityLabel={T("Play {title}", { title: t.name })}
                  style={[styles.fiveRow, { height: Math.round((first ? 150 : 84) * r), marginTop: i ? Math.round(8 * r) : 0 }]}
                >
                  <Outline n={i + 1} size={Math.round((first ? 132 : 70) * r)} width={Math.round((first ? 56 : 52) * r)} ink={look.ink} />
                  <View style={first ? [styles.lifted, { borderRadius: 12, backgroundColor: look.back }] : undefined}>
                    <Cover uri={t.thumb} size={Math.round((first ? 100 : 70) * r)} radius={first ? 12 : 9} />
                  </View>
                  <View style={styles.fiveText}>
                    <Text numberOfLines={first ? 3 : 2} adjustsFontSizeToFit style={[styles.fiveTitle, { color: look.ink, fontSize: Math.max(15, Math.round((first ? 23 : 17) * r)) }]}>
                      {t.name}
                    </Text>
                    <Text numberOfLines={1} style={[styles.fiveSub, { color: look.ink }]}>
                      {first ? t.sub : `${t.sub} · ${t.plays}×`}
                    </Text>
                    <View style={{ height: first ? 8 : 6, borderRadius: 4, marginTop: first ? 8 : 4, width: `${Math.round((t.plays / most) * 100)}%`, backgroundColor: first ? look.ink : alpha(look.ink, 0.85) }} />
                    {first && <Text style={[styles.fivePlays, { color: look.ink }]}>{plural(t.plays, T("play"), T("plays"))}</Text>}
                  </View>
                </Pressable>
              </Rise>
            );
          })}
      </View>
      <Rise delay={620} style={styles.foot}>
        <Pill label={T("Play these five")} onPress={() => onPlay(0)} back={look.ink} ink={look.back} height={Math.round(Math.max(46, 52 * k))} />
      </Rise>
    </>
  );
}

/** Prime time, hour by hour from midnight down, along a line from night through the day to night again. */
function PrimeSlide({ k, W, hours }: { k: number; W: number; hours: number[] }) {
  const look = LOOK.prime;
  const [room, onLayout] = useRoom();
  const peak = hours.reduce((best, ms, h, all) => (ms > all[best] ? h : best), 0);
  const max = Math.max(1, ...hours);
  const rowH = Math.min(26 * k, room / 24);
  const barH = Math.max(4, Math.min(14, Math.round(rowH * 0.58)));
  const reach = W - 44 - 74;
  return (
    <>
      <Rise>
        <Headline look={look} pick size={42 * k} width={W} first={T("Your prime time")} accent={T("was at {time}.", { time: clock(peak) })} />
      </Rise>
      <Rise delay={80}>
        <Text style={[styles.note, { color: look.ink }]}>{T("Each bar is an hour, from midnight at the top to 23:00 at the bottom.")}</Text>
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 && (
          <Rise delay={180} style={{ height: Math.floor(rowH * 24) }}>
            <LinearGradient colors={["#312e81", "#f472b6", "#fde68a", "#fb923c", "#312e81"]} locations={[0, 0.26, 0.5, 0.74, 1]} style={styles.dayLine} />
            {hours.map((ms, h) => (
              <View key={h} style={[styles.hourRow, { height: rowH }]}>
                <Text style={[styles.hourLabel, { color: look.ink }]}>{h % 3 === 0 ? clock(h).slice(0, 2) : ""}</Text>
                <View
                  style={{
                    height: barH,
                    borderRadius: barH / 2,
                    width: ms ? Math.max(6, (ms / max) * reach) : 4,
                    backgroundColor: h === peak ? look.pick : alpha(look.ink, ms ? 0.36 : 0.12),
                  }}
                />
                {h === peak && <Text style={[styles.hourPeak, { color: look.pick }]}>{fmtHours(ms)}</Text>}
              </View>
            ))}
          </Rise>
        )}
      </View>
    </>
  );
}

/** The pulse: a row for every day (or month), the bar as wide as you listened; the top one wears its song. */
function PulseSlide({ k, W, rows, cover }: { k: number; W: number; rows: PulseRow[]; cover?: string }) {
  const look = LOOK.pulse;
  const [room, onLayout] = useRoom();
  const max = Math.max(1, ...rows.map((r) => r.ms));
  const peak = rows.findIndex((r) => r.ms === max);
  const rowH = Math.min(38 * k, room / Math.max(1, rows.length));
  const barH = Math.max(5, Math.min(22, Math.round(rowH * 0.6)));
  const font = Math.max(9, Math.min(12, Math.round(rowH * 0.42)));
  const reach = W - 52 - 64 - 8;
  const disc = Math.round(Math.min(40, rowH * 1.1));
  return (
    <>
      <Rise>
        <Headline look={look} size={62 * k} width={W} first={T("It had a")} accent={T("pulse.")} />
      </Rise>
      <Rise delay={80}>
        <Text style={[styles.note, { color: look.ink }]}>{rows[0]?.unit === "month" ? T("Each row is a month. The wider, the more played.") : T("Each row is a day. The wider, the more played.")}</Text>
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 && (
          <Rise delay={180}>
            {rows.map((r, i) => {
              const top = i === peak;
              const weight = top ? ("900" as const) : ("600" as const);
              return (
                <View key={r.at} style={[styles.pulseRow, { height: rowH }]}>
                  <Text numberOfLines={1} style={[styles.pulseLabel, { color: look.ink, fontSize: font, fontWeight: weight }]}>
                    {rowLabel(r)}
                  </Text>
                  <View style={styles.pulseMid}>
                    <View style={{ width: r.ms ? Math.max(barH, (r.ms / max) * reach) : barH, height: barH, borderRadius: barH / 2, backgroundColor: top ? look.ink : alpha(look.ink, r.ms ? 0.2 : 0.08) }} />
                    {top && !!cover && disc > 16 && (
                      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
                        <View style={[styles.pulseDisc, { width: disc, height: disc, borderRadius: disc / 2, borderColor: look.back }]}>
                          <Cover uri={cover} size={disc - 6} radius={(disc - 6) / 2} />
                        </View>
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={1} style={[styles.pulseValue, { color: look.ink, fontSize: font, fontWeight: weight }]}>
                    {r.ms ? fmtHours(r.ms) : ""}
                  </Text>
                </View>
              );
            })}
          </Rise>
        )}
      </View>
    </>
  );
}

/** Your day of the week: seven blocks, the day itself dark; the one close behind told at the foot. */
function DaySlide({ k, W, weekdays, names }: { k: number; W: number; weekdays: number[]; names: { long: string }[] }) {
  const look = LOOK.day;
  const [room, onLayout] = useRoom();
  const best = weekdays.reduce((b, ms, i, all) => (ms > all[b] ? i : b), 0);
  const max = Math.max(1, weekdays[best]);
  const second = weekdays.reduce((b, ms, i, all) => (i !== best && (b < 0 || ms > all[b]) ? i : b), -1);
  const rowH = Math.min(66 * k, room / 7.9);
  const gap = rowH * 0.15;
  const most = W - 82;
  const least = Math.min(most * 0.56, 150 * k);
  const font = Math.max(14, Math.min(20, Math.round(rowH * 0.31)));
  return (
    <>
      <Rise>
        <Headline look={look} size={50 * k} width={W} first={names[best].long} accent={T("was your day.")} />
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 &&
          weekdays.map((ms, i) => (
            <Rise key={i} delay={140 + i * 60} style={[styles.dayRow, { height: rowH, marginTop: i ? gap : 0 }]}>
              <View style={[styles.dayBlock, { width: least + (ms / max) * (most - least), borderRadius: Math.round(rowH * 0.27), paddingHorizontal: Math.round(rowH * 0.27), backgroundColor: i === best ? look.ink : alpha(look.ink, 0.14) }]}>
                <Text numberOfLines={1} style={[styles.dayName, { color: i === best ? look.back : look.ink, fontSize: font }]}>
                  {names[i].long}
                </Text>
              </View>
              <Text numberOfLines={1} style={[styles.dayValue, { color: look.ink }]}>
                {ms ? fmtHours(ms) : "–"}
              </Text>
            </Rise>
          ))}
      </View>
      {second >= 0 && weekdays[second] > 0 && (
        <Rise delay={600} style={styles.foot}>
          <Text style={[styles.footText, { color: look.ink }]}>{T("Close behind: {weekday} with {time}", { weekday: names[second].long, time: fmtHours(weekdays[second]) })}</Text>
        </Rise>
      )}
    </>
  );
}

/** The faces: the first as a big picture, the next four in rows with their time. */
function FacesSlide({ k, W, faces, photo, total, onOpen }: { k: number; W: number; faces: ReplayTop[]; photo: (a: ReplayTop) => string; total: number; onOpen: (name: string) => void }) {
  const look = LOOK.faces;
  const [room, onLayout] = useRoom();
  const first = faces[0];
  const rest = faces.slice(1, 5);
  const rowH = Math.round(Math.min(68 * k, Math.max(44, (room - 150) / Math.max(1, rest.length) - 8)));
  const cardH = Math.round(Math.max(120, Math.min(262 * k, room - rest.length * (rowH + 8) - 12)));
  const most = Math.max(1, ...rest.map((a) => a.ms));
  return (
    <>
      <Rise>
        <Headline look={look} size={48 * k} width={W} first={T("The faces")} accent={T("behind it.")} />
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 && (
          <>
            <Rise delay={140}>
              <Pressable onPress={() => onOpen(first.name)} accessibilityRole="button" style={[styles.faceCard, { height: cardH }]}>
                <Cover uri={photo(first)} size={W} radius={0} style={{ width: W, height: cardH }} />
                <LinearGradient colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.72)"]} locations={[0.45, 1]} style={StyleSheet.absoluteFill} />
                <View style={styles.faceCardText}>
                  <Text style={[styles.label, { color: "#fff", opacity: 0.8 }]}>{T("Number 1")}</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit style={styles.faceCardName}>
                    {first.name}
                  </Text>
                  <Text style={styles.faceCardLine}>{[fmtHours(first.ms), plural(first.plays, T("play"), T("plays"))].join(" · ")}</Text>
                </View>
              </Pressable>
            </Rise>
            {rest.map((a, i) => (
              <Rise key={a.name} delay={240 + i * 80}>
                <Pressable onPress={() => onOpen(a.name)} accessibilityRole="button" style={[styles.faceRow, { height: rowH }]}>
                  <Cover uri={photo(a)} size={Math.round(rowH * 0.82)} radius={Math.round(rowH * 0.41)} />
                  <View style={styles.faceText}>
                    <View style={styles.faceLine}>
                      <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.faceName, { color: look.ink }]}>
                        {a.name}
                      </Text>
                      <Text style={[styles.faceTime, { color: look.ink }]}>{fmtHours(a.ms)}</Text>
                    </View>
                    <View style={[styles.faceBar, { width: `${Math.round((a.ms / most) * 100)}%`, backgroundColor: look.ink }]} />
                  </View>
                </Pressable>
              </Rise>
            ))}
          </>
        )}
      </View>
      <Rise delay={560} style={styles.foot}>
        <Text style={[styles.footText, { color: look.ink, opacity: 0.6 }]}>{T("{artists} in all", { artists: plural(total, T("artist"), T("artists")) })}</Text>
      </Rise>
    </>
  );
}

/** New to you: how many, as big as it goes, and the songs to play. */
function FreshSlide({ k, W, total, fresh, onPlay }: { k: number; W: number; total: number; fresh: ReplayTop[]; onPlay: (at: number) => void }) {
  const look = LOOK.fresh;
  const [room, onLayout] = useRoom();
  const numSize = Math.round(Math.min(290 * k, (W * 0.5) / (String(total).length * 0.6)));
  const rowH = Math.round(46 * Math.min(1, k));
  const shown = fresh.slice(0, Math.min(10, Math.floor((room + 6) / (rowH + 6))));
  return (
    <>
      <Rise style={styles.freshHead}>
        <Text style={[styles.freshNumber, { color: look.ink, fontSize: numSize, letterSpacing: -numSize * 0.07, marginTop: -Math.round(numSize * 0.2), marginBottom: -Math.round(numSize * 0.24) }]}>{total}</Text>
        <View style={[styles.freshWords, { paddingTop: Math.round(numSize * 0.1) }]}>
          <Text style={[styles.heavy, { color: look.ink, fontSize: Math.round(36 * k), letterSpacing: -1.4 }]}>{total === 1 ? T("Song") : T("Songs")}</Text>
          <Text style={[styles.heavy, styles.italic, { color: look.ink, fontSize: Math.round(30 * k), lineHeight: Math.round(31 * k), letterSpacing: -1.2, paddingBottom: Math.round(6 * k) }]}>{total === 1 ? T("was new to you.") : T("were new to you.")}</Text>
          <Text style={[styles.note, { color: look.ink }]}>{T("heard for the first time")}</Text>
        </View>
      </Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {shown.map((t, i) => (
          <Rise key={t.id ?? i} delay={160 + i * 50}>
            <Pressable onPress={() => onPlay(i)} accessibilityLabel={T("Play {title}", { title: t.name })} style={[styles.freshRow, { height: rowH, marginTop: i ? 6 : 0 }]}>
              <Cover uri={t.thumb} size={rowH - 4} radius={7} />
              <View style={styles.freshText}>
                <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.freshTitle, { color: look.ink }]}>
                  {t.name}
                </Text>
                <Text numberOfLines={1} style={[styles.freshSub, { color: look.ink }]}>
                  {t.sub}
                </Text>
              </View>
              <Text style={[styles.freshCount, { color: look.ink }]}>{t.plays}×</Text>
            </Pressable>
          </Rise>
        ))}
      </View>
      <Rise delay={520} style={styles.foot}>
        <Pill label={T("Play the new ones")} onPress={() => onPlay(0)} back={look.ink} ink={look.back} height={Math.round(Math.max(46, 52 * k))} />
      </Rise>
    </>
  );
}

/** Mostly which genre, as one tall bar in parts; how it sounded and where it came from under it. */
function MostlySlide({ k, W, genre, genres, formats, sources }: { k: number; W: number; genre?: string; genres: Part[]; formats: Part[]; sources: Part[] }) {
  const look = LOOK.mostly;
  const [room, onLayout] = useRoom();
  const minH = 30;
  const total = Math.min(room - 4, 410 * k);
  const spare = Math.max(0, total - genres.length * minH);
  const column = Math.round(112 * k);
  return (
    <>
      <Rise>{genre ? <Headline look={look} size={58 * k} width={W} first={T("Mostly")} accent={`${genre}.`} /> : <Headline look={look} size={58 * k} width={W} first={T("How it")} accent={T("sounded.")} />}</Rise>
      <View style={[styles.flex, styles.middle]} onLayout={onLayout}>
        {room > 0 && genres.length > 0 && (
          <Rise delay={160}>
            {genres.map((p, i) => {
              const top = i === 0 ? 18 : 0;
              const bottom = i === genres.length - 1 ? 18 : 0;
              return (
                <View key={p.label} style={[styles.genreRow, { height: Math.round(minH + spare * p.share) }]}>
                  <View style={{ width: column, height: "100%", backgroundColor: p.color, borderTopLeftRadius: top, borderTopRightRadius: top, borderBottomLeftRadius: bottom, borderBottomRightRadius: bottom }} />
                  <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.genreName, { color: look.ink }]}>
                    {p.label}
                    <Text style={styles.genreShare}>{`  ${T("{n}%", { n: Math.round(p.share * 100) })}`}</Text>
                  </Text>
                </View>
              );
            })}
          </Rise>
        )}
      </View>
      {formats.length > 0 && (
        <Rise delay={260}>
          <ShareBlock title={T("How it sounded")} parts={formats} ink={look.ink} />
        </Rise>
      )}
      {sources.length > 0 && (
        <Rise delay={340}>
          <ShareBlock title={T("Where it came from")} parts={sources} ink={look.ink} />
        </Rise>
      )}
    </>
  );
}

/** The ending: a ticket for the period, and what to do with it. */
function TicketSlide(props: {
  k: number;
  W: number;
  periodName: string;
  line: string;
  headliner?: string;
  album?: string;
  cover?: string;
  onTop: () => void;
  onKeep: () => void;
  onHistory: () => void;
}) {
  const { k, W, periodName, line, headliner, album, cover, onTop, onKeep, onHistory } = props;
  const look = LOOK.ticket;
  const [room, onLayout] = useRoom();
  const cardW = Math.round(W - 24 * k);
  const coverH = Math.round(Math.max(64, Math.min(184 * k, room - 232)));
  const pillH = Math.round(Math.max(44, 52 * k));
  return (
    <>
      <Rise>
        <Headline look={look} pick size={44 * k} width={W} first={T("Same seat")} accent={T("next time?")} />
      </Rise>
      <View style={[styles.flex, styles.center]} onLayout={onLayout}>
        {room > 0 && (
          <Rise delay={160} style={[styles.ticket, { width: cardW }]}>
            <Cover uri={cover} size={cardW} radius={0} style={{ width: cardW, height: coverH }} />
            <View style={[styles.perforation, { top: coverH - 13 }]}>
              <View style={[styles.notch, { left: -13, backgroundColor: look.back }]} />
              <View style={styles.dashes}>
                {Array.from({ length: 24 }, (_, i) => (
                  <View key={i} style={styles.dash} />
                ))}
              </View>
              <View style={[styles.notch, { right: -13, backgroundColor: look.back }]} />
            </View>
            <View style={styles.stub}>
              <Text style={styles.stubBrand}>{T("ADMIT ONE · SONGSTA REPLAY")}</Text>
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.stubPeriod}>
                {periodName}
              </Text>
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.stubLine}>
                {line}
              </Text>
              {!!headliner && (
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.stubLine}>
                  {T("Headliner: {name}", { name: headliner })}
                </Text>
              )}
              {!!album && (
                <Text numberOfLines={1} adjustsFontSizeToFit style={styles.stubLine}>
                  {T("Album: {name}", { name: album })}
                </Text>
              )}
              <View style={styles.barcode}>
                {Array.from({ length: 96 }, (_, i) => (
                  <View key={i} style={{ width: [2, 1, 3, 1, 2, 1, 3][i % 7], backgroundColor: "#1c1917", marginRight: [2, 3, 2, 1, 3, 2, 1][i % 7] }} />
                ))}
              </View>
            </View>
          </Rise>
        )}
      </View>
      <Rise delay={300} style={[styles.foot, styles.actions]}>
        <Pill label={T("Play your top songs")} onPress={onTop} back="#ffffff" ink="#1a1033" height={pillH} />
        <Pill label={T("Keep them as a playlist")} onPress={onKeep} back="rgba(255,255,255,0.14)" ink="#ffffff" height={pillH} icon={false} />
        <Pill label={T("Listening history")} onPress={onHistory} back="rgba(255,255,255,0.14)" ink="#ffffff" height={pillH} icon={false} />
      </Rise>
    </>
  );
}

interface StorySlide {
  key: string;
  /** how long it stays before the next comes; 0 for the last */
  seconds: number;
  look: Look;
  render(): ReactNode;
}

export function ReplayScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [period, setPeriod] = useState<ReplayPeriod>("month");
  const [index, setIndex] = useState(0);
  const [held, setHeld] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const listens = useListens((s) => s.listens);
  const shared = useListens((s) => s.shared);
  const missing = useListens((s) => s.missing);
  const libraryTracks = useLibrary((s) => s.data.tracks);
  const artistIds = useLibrary((s) => s.data.artistIds);
  const albums = useLibrary((s) => s.albums);
  const session = useSession((s) => s.session);
  // The slides' colour goes up to the screen's edge, without the app's dark shade over it.
  useNoStatusScrim();
  // With a sync service, the other devices' newest plays are asked for at once.
  useEffect(() => void readListensNow(), []);
  const all = useMemo<PhoneListen[]>(() => (shared.length ? [...listens, ...shared] : listens), [listens, shared]);
  const covers = useMemo(() => coverIndex(libraryTracks), [libraryTracks]);
  const data = useMemo(() => withCovers(summarize(all, period), covers), [all, period, covers]);
  const facts = useMemo<StoryFacts>(() => {
    const byId = new Map(libraryTracks.map((t) => [t.id, t]));
    const [from, to] = periodRange(period, new Date());
    return storyFacts(all, from, to, (id) => byId.get(id));
  }, [all, period, libraryTracks]);
  const pulse = useMemo(() => pulseRows(all, period, new Date()), [all, period]);
  const names = useMemo(weekdayNames, []);
  // The other devices that played something in this period (the computer, mostly), and their latest play.
  const others = useMemo(() => {
    const [from, to] = periodRange(period, new Date());
    const latest = new Map<string, number>();
    for (const l of shared) if (l.at >= from && l.at < to) latest.set(l.deviceName || "?", Math.max(latest.get(l.deviceName || "?") ?? 0, l.at));
    return latest;
  }, [shared, period]);
  const source = others.size
    ? T("This phone and {devices} · as of {time}", { devices: [...others.keys()].join(", "), time: whenSaid(Math.max(...others.values())) })
    : missing
      ? T("The computer's listening shows here once your sync service is updated.")
      : "";
  const has = data.totalMs > 0 || data.plays > 0;

  const now = new Date();
  const monthName = (back: number): string => new Date(now.getFullYear(), now.getMonth() - back, 1).toLocaleDateString(textLocale(), { month: "long" });
  const periodName = period === "month" ? T("This month") : period === "lastMonth" ? T("Last month") : period === "year" ? String(now.getFullYear()) : T("All of it");
  const openName = period === "all" ? T("All of it") : T("Your {name}", { name: period === "month" ? monthName(0) : period === "lastMonth" ? monthName(1) : String(now.getFullYear()) });
  const minutes = Math.round(data.totalMs / 60000);
  const topAlbum = data.albums[0];
  const photo = (a: ReplayTop): string => {
    const id = artistIds[a.name.toLowerCase()];
    return (id && session ? artistPhotoUrl(session, id) : "") || a.thumb;
  };
  // The songs liked best from the album of the period.
  const albumFavs = useMemo<ReplayTop[]>(() => {
    if (!topAlbum) return [];
    const [from, to] = periodRange(period, new Date());
    const rows = new Map<string, ReplayTop>();
    for (const l of all) {
      if (l.at < from || l.at >= to || !l.album) continue;
      if (l.album.toLowerCase() !== topAlbum.name.toLowerCase() || l.artist.toLowerCase() !== topAlbum.sub.toLowerCase()) continue;
      const row = rows.get(l.id) ?? { name: l.title, sub: l.artist, thumb: l.thumb ?? "", ms: 0, plays: 0, id: l.id };
      row.plays += 1;
      row.ms += l.ms;
      rows.set(l.id, row);
    }
    return [...rows.values()]
      .sort((a, b) => b.plays - a.plays || b.ms - a.ms)
      .slice(0, 2)
      .map((t) => ({ ...t, thumb: songCover(t, covers) }));
  }, [all, period, topAlbum, covers]);

  // The room on a slide: under the bars on top, over the bottom edge.
  const top = insets.top + 48;
  const bottom = insets.bottom + 24;
  const pad = 22;
  const W = width - pad * 2;
  const k = Math.min(width / 390, height / 844);

  const songs = (list: ReplayTop[]) => {
    const byId = new Map(useLibrary.getState().data.tracks.map((t) => [t.id, t]));
    return list.map((t) => (t.id ? byId.get(t.id) : undefined)).filter((t): t is NonNullable<typeof t> => !!t);
  };
  const playList = (list: ReplayTop[], at = 0): void => {
    const playable = songs(list);
    const wanted = list[at]?.id;
    const start = Math.max(0, playable.findIndex((t) => t.id === wanted));
    if (playable.length) usePlayer.getState().playTracks(playable, start, T("Replay"));
    else toast(T("Those songs aren't in this phone's library"));
  };
  const keepTop = (): void => {
    const playable = songs(data.tracks);
    if (!playable.length) return;
    const lists = usePlaylists.getState();
    const name = T("Replay · {period}", { period: periodName });
    const id = lists.create(name);
    for (const t of playable) lists.addTrack(id, t);
    toast(T("Saved as “{name}”", { name }));
  };
  const albumHere = topAlbum ? albums.find((a) => a.title.toLowerCase() === topAlbum.name.toLowerCase() && (!topAlbum.sub || a.artist.toLowerCase() === topAlbum.sub.toLowerCase())) : undefined;

  const slides = useMemo<StorySlide[]>(() => {
    const list: StorySlide[] = [];
    // The opening's covers: the top albums, then the top songs' where there are fewer than three.
    const fan: string[] = [];
    for (const thumb of [...data.albums.map((a) => a.thumb), ...data.tracks.map((t) => t.thumb)]) {
      if (thumb && !fan.includes(thumb)) fan.push(thumb);
      if (fan.length === 3) break;
    }
    list.push({
      key: "open",
      seconds: has ? 7 : 0,
      look: LOOK.open,
      render: () => (
        <OpenSlide
          k={k}
          W={W}
          has={has}
          source={source}
          period={period}
          onPeriod={(p) => {
            setPeriod(p);
            setIndex(0);
          }}
          name={openName}
          quiet={period === "lastMonth" ? T("was quiet.") : T("is still quiet.")}
          covers={fan}
          numbers={[
            { value: minutes, label: T("MINUTES") },
            { value: data.plays, label: T("PLAYS") },
            { value: data.counts.tracks, label: T("SONGS") },
            { value: data.counts.artists, label: T("ARTISTS") },
          ]}
        />
      ),
    });
    if (!has) return list;

    if (topAlbum) {
      const eyebrow = period === "year" ? T("Album of the year") : period === "all" ? T("Album of all time") : T("Album of the month");
      list.push({
        key: "first",
        seconds: 7,
        look: LOOK.first,
        render: () => (
          <FirstSlide k={k} W={W} eyebrow={eyebrow} album={topAlbum} favs={albumFavs} onPlay={albumHere ? () => usePlayer.getState().playTracks(albumHere.tracks, 0, albumHere.title) : undefined} />
        ),
      });
    }

    const five = data.tracks.slice(0, 5);
    if (five.length) list.push({ key: "five", seconds: 10, look: LOOK.five, render: () => <FiveSlide k={k} W={W} five={five} onPlay={(at) => playList(five, at)} /> });

    if (data.hours.some((ms) => ms > 0)) list.push({ key: "prime", seconds: 8, look: LOOK.prime, render: () => <PrimeSlide k={k} W={W} hours={data.hours} /> });

    if (pulse.filter((r) => r.ms > 0).length >= 2) {
      const peak = pulse.reduce((best, r) => (r.ms > best.ms ? r : best), pulse[0]);
      const cover = peak.top ? songCover({ id: peak.top.id, name: peak.top.title, sub: peak.top.artist, thumb: peak.top.thumb }, covers) : topAlbum?.thumb;
      list.push({ key: "pulse", seconds: 8, look: LOOK.pulse, render: () => <PulseSlide k={k} W={W} rows={pulse} cover={cover} /> });
    }

    if (data.weekdays.some((ms) => ms > 0)) list.push({ key: "day", seconds: 7, look: LOOK.day, render: () => <DaySlide k={k} W={W} weekdays={data.weekdays} names={names} /> });

    if (data.artists.length) {
      list.push({
        key: "faces",
        seconds: 9,
        look: LOOK.faces,
        render: () => <FacesSlide k={k} W={W} faces={data.artists} photo={photo} total={data.counts.artists} onOpen={(name) => nav.navigate("Artist", { name })} />,
      });
    }

    // New to you; over all of it, every song was, so then there's nothing to tell.
    if (facts.freshCount > 0 && period !== "all") {
      const fresh = facts.fresh.map((t) => ({ ...t, thumb: songCover(t, covers) }));
      list.push({ key: "fresh", seconds: 10, look: LOOK.fresh, render: () => <FreshSlide k={k} W={W} total={facts.freshCount} fresh={fresh} onPlay={(at) => playList(fresh, at)} /> });
    }

    const formatTotal = facts.formats.hires + facts.formats.lossless + facts.formats.lossy;
    const sourceTotal = facts.sources.local + facts.sources.jf + facts.sources.ss;
    if (facts.genreTotal > 0 || formatTotal > 0 || sourceTotal > 0) {
      const ink = LOOK.mostly.ink;
      const genres = shareParts(facts.genres, facts.genreTotal, T("Other")).map((p, i) => ({ ...p, color: i < 4 ? GENRE_COLORS[i] : alpha(ink, 0.16) }));
      const formats = [
        { label: T("Hi-Res"), share: formatTotal ? facts.formats.hires / formatTotal : 0, color: "#2dd4bf" },
        { label: T("Lossless"), share: formatTotal ? facts.formats.lossless / formatTotal : 0, color: ink },
        { label: T("Lossy"), share: formatTotal ? facts.formats.lossy / formatTotal : 0, color: alpha(ink, 0.25) },
      ].filter((p) => p.share > 0);
      const sources = [
        { label: T("Jellyfin"), share: sourceTotal ? facts.sources.jf / sourceTotal : 0, color: "#8b5cf6" },
        { label: T("Navidrome"), share: sourceTotal ? facts.sources.ss / sourceTotal : 0, color: "#f472b6" },
        { label: T("Your folders"), share: sourceTotal ? facts.sources.local / sourceTotal : 0, color: "#f59e0b" },
      ].filter((p) => p.share > 0);
      list.push({
        key: "mostly",
        seconds: 10,
        look: LOOK.mostly,
        render: () => <MostlySlide k={k} W={W} genre={facts.genres[0]?.[0]} genres={genres} formats={formats} sources={sources} />,
      });
    }

    list.push({
      key: "ticket",
      seconds: 0,
      look: LOOK.ticket,
      render: () => (
        <TicketSlide
          k={k}
          W={W}
          periodName={periodName}
          line={T("{minutes} minutes · {plays} plays", { minutes: count(minutes), plays: count(data.plays) })}
          headliner={data.artists[0]?.name}
          album={topAlbum?.name}
          cover={topAlbum?.thumb ?? data.tracks[0]?.thumb}
          onTop={() => playList(data.tracks)}
          onKeep={keepTop}
          onHistory={() => setHistoryOpen(true)}
        />
      ),
    });
    return list;
    // The slides read everything above; they're built again when what they show changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, facts, pulse, period, has, source, width, height, artistIds, session, albumHere, albumFavs, covers, names]);

  // Where the story is: a period changed or fewer slides keep it within them.
  useEffect(() => {
    if (index > slides.length - 1) setIndex(Math.max(0, slides.length - 1));
  }, [index, slides.length]);
  const slide = slides[Math.min(index, slides.length - 1)];
  const look: Look = slide?.look ?? LOOK.open;

  // The clock of the bars on top: it runs on to the next slide, stops while held or with the history open.
  const progress = useRef(new Animated.Value(0)).current;
  const at = useRef(0);
  useEffect(() => {
    at.current = 0;
    progress.setValue(0);
  }, [index, period, progress]);
  useEffect(() => {
    if (!slide?.seconds || held || historyOpen) return;
    const run = Animated.timing(progress, { toValue: 1, duration: Math.max(0, (1 - at.current) * slide.seconds * 1000), easing: Easing.linear, useNativeDriver: false });
    run.start(({ finished }) => {
      if (!finished) return;
      at.current = 0;
      setIndex((i) => Math.min(i + 1, slides.length - 1));
    });
    return () => {
      run.stop();
      progress.stopAnimation((v) => (at.current = v));
    };
  }, [slide, held, historyOpen, slides.length, progress]);

  const tap = (e: GestureResponderEvent): void => {
    if (e.nativeEvent.pageX < width * 0.3) setIndex((i) => Math.max(0, i - 1));
    else setIndex((i) => Math.min(slides.length - 1, i + 1));
  };

  return (
    <PullDownToClose onClose={() => nav.goBack()}>
      <View style={[styles.screen, { backgroundColor: look.back }]}>
        <StatusBar style={look.dark || historyOpen ? "light" : "dark"} />
        <Pressable
          key={`${period}-${slide?.key}`}
          onPress={tap}
          onPressIn={() => setHeld(true)}
          onPressOut={() => setHeld(false)}
          delayLongPress={250}
          onLongPress={() => undefined}
          style={[styles.stage, { paddingTop: top, paddingBottom: bottom, paddingHorizontal: pad }]}
          accessibilityHint={T("Tap on the right for the next, on the left for the one before; hold to stop")}
        >
          {slide?.render()}
        </Pressable>
        {/* The bars: one per slide, the one showing fills as its time runs; in the slide's own ink. */}
        <View style={[styles.bars, { top: insets.top + 10 }]} pointerEvents="none">
          {slides.map((s, i) => (
            <View key={s.key} style={[styles.barTrack, { backgroundColor: alpha(look.ink, 0.24) }]}>
              {i < index ? (
                <View style={[styles.barFill, { width: "100%", backgroundColor: look.ink }]} />
              ) : i === index ? (
                <Animated.View style={[styles.barFill, { backgroundColor: look.ink, width: slide?.seconds ? progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }) : "100%" }]} />
              ) : null}
            </View>
          ))}
        </View>
        <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Close")} hitSlop={10} style={[styles.close, { top: insets.top + 20 }]}>
          <X size={24} color={look.ink} />
        </Pressable>
        {historyOpen && <HistoryList listens={all} covers={covers} onClose={() => setHistoryOpen(false)} top={insets.top} bottom={insets.bottom} />}
      </View>
    </PullDownToClose>
  );
}

/** The listening history, newest first and by day, over the story; a song still in the library plays from its row. */
function HistoryList({ listens, covers, onClose, top, bottom }: { listens: PhoneListen[]; covers: CoverIndex; onClose: () => void; top: number; bottom: number }) {
  const [shown, setShown] = useState(150);
  const sorted = useMemo(() => [...listens].sort((a, b) => b.at - a.at), [listens]);
  const days = useMemo(() => {
    const out: { title: string; items: PhoneListen[] }[] = [];
    for (const l of sorted.slice(0, shown)) {
      const title = dayTitle(l.at);
      const last = out[out.length - 1];
      if (last?.title === title) last.items.push(l);
      else out.push({ title, items: [l] });
    }
    return out;
  }, [sorted, shown]);
  const play = (l: PhoneListen): void => {
    const song = useLibrary.getState().data.tracks.find((t) => t.id === l.id);
    if (song) usePlayer.getState().playTracks([song], 0, T("Listening history"));
    else toast(T("That song isn't in this phone's library"));
  };
  return (
    <View style={[StyleSheet.absoluteFill, styles.history]}>
      <View style={[styles.historyHead, { paddingTop: top + 14 }]}>
        <Text style={styles.historyTitle}>{T("Listening history")}</Text>
        <Pressable onPress={onClose} accessibilityLabel={T("Close")} hitSlop={10}>
          <X size={24} color={colors.ink} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: bottom + 40 }}>
        {!sorted.length && <Text style={styles.historyEmpty}>{T("Nothing here yet")}</Text>}
        {days.map((d) => (
          <View key={d.title}>
            <Text style={styles.historyDay}>{d.title}</Text>
            {d.items.map((l, i) => (
              <Pressable key={`${l.at}-${l.id}-${i}`} onPress={() => play(l)} style={styles.historyRow}>
                <Cover uri={songCover({ id: l.id, name: l.title, sub: l.artist, thumb: l.thumb ?? "" }, covers)} size={46} radius={6} />
                <View style={styles.freshText}>
                  <Text numberOfLines={1} style={styles.historySong}>
                    {l.title}
                  </Text>
                  <Text numberOfLines={1} style={styles.historySub}>
                    {[l.artist, l.deviceName].filter(Boolean).join(" · ")}
                  </Text>
                </View>
                <Text style={styles.historyTime}>{`${String(new Date(l.at).getHours()).padStart(2, "0")}:${String(new Date(l.at).getMinutes()).padStart(2, "0")}`}</Text>
              </Pressable>
            ))}
          </View>
        ))}
        {shown < sorted.length && (
          <Pressable onPress={() => setShown((n) => n + 300)} style={styles.more}>
            <Text style={styles.moreText}>{T("Show more")}</Text>
          </Pressable>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, overflow: "hidden" },
  stage: { flex: 1 },
  flex: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  /** the room between a slide's headline and its foot, its content in the middle of it */
  middle: { justifyContent: "center", paddingVertical: 12 },
  foot: { marginTop: 10 },
  bars: { position: "absolute", left: 14, right: 14, flexDirection: "row", gap: 4 },
  barTrack: { flex: 1, height: 3, borderRadius: 2, overflow: "hidden" },
  barFill: { height: 3, borderRadius: 2 },
  close: { position: "absolute", right: 12, width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  // Text is cut at its own box unless it may overflow: a g or p of the last line reaches below it.
  heavy: { fontWeight: "900", includeFontPadding: false, overflow: "visible" },
  italic: { fontStyle: "italic" },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 3.3, textTransform: "uppercase" },
  source: { fontSize: 12.5, fontWeight: "600", opacity: 0.72, marginTop: 6 },
  label: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, textTransform: "uppercase" },
  note: { fontSize: 13, fontWeight: "600", lineHeight: 18, opacity: 0.72, marginTop: 10 },
  periodRow: { marginTop: 14, marginHorizontal: -22, flexGrow: 0 },
  periods: { paddingHorizontal: 22, gap: 6 },
  chip: { height: 30, paddingHorizontal: 12, borderRadius: 15, justifyContent: "center" },
  chipText: { fontSize: 12.5, fontWeight: "700" },
  empty: { fontSize: 15, fontWeight: "600", lineHeight: 21, opacity: 0.8, paddingTop: 22 },
  numbers: { flexDirection: "row", flexWrap: "wrap", rowGap: 14, marginTop: 8 },
  numberCell: { width: "50%", paddingRight: 12 },
  number: { fontWeight: "900", includeFontPadding: false, overflow: "visible" },
  fanCard: { position: "absolute", borderRadius: 12, elevation: 14 },
  lifted: { elevation: 16 },
  badge: { position: "absolute", alignItems: "center", justifyContent: "center", elevation: 18, transform: [{ rotate: "-12deg" }] },
  badgeText: { fontWeight: "900" },
  meta: { fontSize: 15, fontWeight: "600", opacity: 0.75, marginTop: 10 },
  playRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 16, alignSelf: "flex-start" },
  playRound: { alignItems: "center", justifyContent: "center" },
  playLabel: { fontSize: 15, fontWeight: "800" },
  favBox: { borderRadius: 18, padding: 14, marginTop: 16 },
  favRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 9 },
  favTitle: { flex: 1, fontSize: 14.5, fontWeight: "800" },
  favCount: { fontSize: 13, fontWeight: "800" },
  pill: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  pillText: { fontSize: 15, fontWeight: "800" },
  fiveRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  fiveText: { flex: 1, minWidth: 0 },
  fiveTitle: { fontWeight: "900", letterSpacing: -0.3 },
  fiveSub: { fontSize: 12.5, fontWeight: "600", opacity: 0.75, marginTop: 2 },
  fivePlays: { fontSize: 12.5, fontWeight: "800", marginTop: 4 },
  dayLine: { position: "absolute", left: 36, top: 4, bottom: 4, width: 3, borderRadius: 2 },
  hourRow: { flexDirection: "row", alignItems: "center" },
  hourLabel: { width: 30, fontSize: 11, fontWeight: "800", opacity: 0.6, marginRight: 14 },
  hourPeak: { fontSize: 13, fontWeight: "800", marginLeft: 8 },
  pulseRow: { flexDirection: "row", alignItems: "center" },
  pulseLabel: { width: 52 },
  pulseMid: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
  pulseDisc: { borderWidth: 3, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  pulseValue: { width: 64, textAlign: "right" },
  dayRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  dayBlock: { height: "100%", justifyContent: "center" },
  dayName: { fontWeight: "900", letterSpacing: -0.4 },
  dayValue: { fontSize: 14, fontWeight: "800" },
  footText: { fontSize: 13.5, fontWeight: "700" },
  faceCard: { borderRadius: 22, overflow: "hidden" },
  faceCardText: { position: "absolute", left: 18, right: 18, bottom: 16 },
  faceCardName: { color: "#fff", fontSize: 32, fontWeight: "900", letterSpacing: -1, marginTop: 2 },
  faceCardLine: { color: "#fff", fontSize: 13, fontWeight: "600", opacity: 0.85 },
  faceRow: { flexDirection: "row", alignItems: "center", gap: 14, marginTop: 8 },
  faceText: { flex: 1, minWidth: 0 },
  faceLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  faceName: { flex: 1, fontSize: 17, fontWeight: "900", letterSpacing: -0.2 },
  faceTime: { fontSize: 13, fontWeight: "800" },
  faceBar: { height: 8, borderRadius: 4, marginTop: 5 },
  freshHead: { flexDirection: "row", alignItems: "flex-start" },
  freshNumber: { fontWeight: "900", includeFontPadding: false, overflow: "visible" },
  freshWords: { flex: 1, minWidth: 0, marginLeft: 8 },
  freshRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  freshText: { flex: 1, minWidth: 0 },
  freshTitle: { fontSize: 15, fontWeight: "800" },
  freshSub: { fontSize: 12, fontWeight: "600", opacity: 0.72 },
  freshCount: { fontSize: 13, fontWeight: "800" },
  genreRow: { flexDirection: "row", alignItems: "center" },
  genreName: { flex: 1, fontSize: 19, fontWeight: "900", letterSpacing: -0.2, paddingLeft: 18 },
  genreShare: { fontSize: 14, fontWeight: "800", opacity: 0.6 },
  shareBlock: { marginTop: 14 },
  shareBar: { flexDirection: "row", height: 14, borderRadius: 7, overflow: "hidden", marginTop: 8 },
  shareLegend: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 4, marginTop: 8 },
  shareItem: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: "100%" },
  shareDot: { width: 9, height: 9, borderRadius: 5 },
  shareLabel: { fontSize: 12, fontWeight: "700", flexShrink: 1 },
  ticket: { borderRadius: 20, overflow: "hidden", backgroundColor: "#f6f1e7" },
  perforation: { position: "absolute", left: 0, right: 0, height: 26, flexDirection: "row", alignItems: "center" },
  notch: { position: "absolute", top: 0, width: 26, height: 26, borderRadius: 13 },
  dashes: { flex: 1, flexDirection: "row", justifyContent: "space-between", marginHorizontal: 20 },
  dash: { width: 6, height: 2, backgroundColor: "rgba(28,25,23,0.3)" },
  stub: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 18 },
  stubBrand: { color: "#1c1917", fontSize: 10, fontWeight: "800", letterSpacing: 2.2 },
  stubPeriod: { color: "#1c1917", fontSize: 32, fontWeight: "900", letterSpacing: -1.3, marginTop: 6 },
  stubLine: { color: "#1c1917", fontSize: 13, fontWeight: "600", lineHeight: 20 },
  barcode: { flexDirection: "row", height: 46, marginTop: 16, overflow: "hidden" },
  actions: { gap: 10 },
  history: { backgroundColor: "#0b0b0d" },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 22, paddingBottom: 10 },
  historyTitle: { color: colors.ink, fontSize: 28, fontWeight: "900", letterSpacing: -1 },
  historyEmpty: { color: colors.dim, fontSize: 15, lineHeight: 21, paddingTop: 26 },
  historyDay: { color: colors.dim, fontSize: 12, fontWeight: "900", letterSpacing: 1.4, textTransform: "uppercase", marginTop: 18, marginBottom: 6 },
  historyRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 7 },
  historySong: { color: colors.ink, fontSize: 13.5, fontWeight: "800" },
  historySub: { color: colors.dim, fontSize: 12 },
  historyTime: { color: colors.dim, fontSize: 12, fontWeight: "700" },
  more: { marginTop: 18, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.12)" },
  moreText: { color: colors.ink, fontSize: 15, fontWeight: "800" },
});
