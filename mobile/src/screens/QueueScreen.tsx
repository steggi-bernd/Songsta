/**
 * The queue, as on Spotify: a sheet over the dimmed player with the playing song on
 * top, a small area of its own for what was asked for by hand, then what comes next
 * from the list. Every song can go by its cross or a pull to the right, and moves by
 * its handle. Shuffle, Repeat and the sleep Timer are three big buttons below. Its
 * grip and its head drag it: all the way up, or down and away.
 */
import { useNavigation } from "@react-navigation/native";
import { ChevronDown, ChevronUp, Menu, Pause, Play, Repeat, Repeat1, Shuffle, Split, Timer, Trash2, X } from "lucide-react-native";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Animated, FlatList, PanResponder, PixelRatio, Pressable, StyleSheet, Text, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { glideList, PullRow } from "../components/SwipeRow";
import { Cover, EqBars } from "../components/ui";
import { handRows, type Track } from "../shared";
import { usePlayer } from "../stores/player";
import { useOverBottomBar } from "../stores/popups";
import { feel } from "../stores/settings";
import { colors } from "../theme";
import { T } from "../shared";

/** A row's height: the list knows where everything is by these. On whole pixels, or the area shows hairlines between its rows. */
const px = PixelRatio.roundToNearestPixel;
const HEIGHT = { hand: px(44), branch: px(38), song: px(61), more: px(42), handEnd: px(18), list: px(42) };
/** The area of what was asked for by hand stands out a little from the sheet. */
const AREA = "#2B2B2E";
const AREA_MARGIN = 8;
/** At rest the sheet covers this much of the screen. */
const AT_REST = 0.66;
const SHEET_GAP_ON_TOP = 8;
const BUTTON_HEIGHT = 58;
const BUTTONS_ABOVE = 8;
const BUTTONS_BELOW = 12;
/** A moment on from where the finger left it: a flick counts like a long drag. */
const FLICK_MS = 200;
const SPRING = { stiffness: 300, damping: 34, mass: 1, overshootClamping: true, useNativeDriver: true };

type Row =
  | { kind: "hand"; key: string }
  | { kind: "branch"; key: string; name: string; count: number; folds: boolean }
  | { kind: "song"; key: string; track: Track; at: number; inHand: boolean }
  | { kind: "more"; key: string; name: string; count: number }
  | { kind: "handEnd"; key: string }
  | { kind: "list"; key: string; title: string };

/** The row being dragged: its whole cell comes up, or the rows after it would cover it. */
const HeldRow = createContext<string | null>(null);

function QueueCell({ item, style, onLayout, children }: { item: Row; style?: StyleProp<ViewStyle>; onLayout?: (e: LayoutChangeEvent) => void; children?: ReactNode }) {
  const held = useContext(HeldRow) === item.key;
  return (
    <View style={[style, held && styles.cellHeld]} onLayout={onLayout}>
      {children}
    </View>
  );
}

/** One song that comes next. Its handle drags it: to the place of whichever song the finger comes to. */
function UpcomingRow({
  rowKey,
  track,
  at,
  inHand,
  onDragChange,
  placeFor,
}: {
  rowKey: string;
  track: Track;
  at: number;
  inHand: boolean;
  onDragChange: (row: string | null) => void;
  /** Dragged this far from there: the place in the queue it would take. */
  placeFor: (at: number, dy: number) => number;
}) {
  const { skipTo, removeAt, moveItem } = usePlayer.getState();
  const y = useRef(new Animated.Value(0)).current;
  const [held, setHeld] = useState(false);
  const place = useRef(at);
  place.current = at;
  const slot = useRef(at);
  const finding = useRef(placeFor);
  finding.current = placeFor;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          slot.current = place.current;
          feel("press");
          setHeld(true);
          onDragChange(rowKey);
        },
        onPanResponderMove: (_, g) => {
          y.setValue(g.dy);
          // Every place passed can be felt.
          const now = finding.current(place.current, g.dy);
          if (now !== slot.current) feel("tick");
          slot.current = now;
        },
        onPanResponderRelease: (_, g) => {
          feel("press");
          y.setValue(0);
          setHeld(false);
          onDragChange(null);
          moveItem(place.current, finding.current(place.current, g.dy));
        },
        onPanResponderTerminate: () => {
          y.setValue(0);
          setHeld(false);
          onDragChange(null);
        },
      }),
    [y, moveItem, onDragChange, rowKey]
  );

  const remove = (): void => {
    glideList();
    removeAt(place.current);
  };
  const rowColor = inHand ? AREA : colors.sheet;

  return (
    <PullRow label={T("Remove")} Icon={Trash2} tone="danger" leaves rowColor={rowColor} style={inHand ? styles.inArea : undefined} onPull={remove}>
      <Animated.View style={[styles.row, inHand && styles.rowInArea, held && styles.rowHeld, { transform: [{ translateY: y }] }]}>
        <Pressable onPress={() => skipTo(place.current)} style={styles.rowMain}>
          <Cover uri={track.thumb} size={46} />
          <View style={styles.rowText}>
            <Text numberOfLines={1} style={styles.rowTitle}>
              {track.title}
            </Text>
            <Text numberOfLines={1} style={styles.rowArtist}>
              {track.artist}
            </Text>
          </View>
        </Pressable>
        <Pressable
          onPress={() => {
            feel("press");
            remove();
          }}
          hitSlop={4}
          accessibilityLabel={T("Remove {title}", { title: track.title })}
          style={styles.remove}
        >
          <X size={17} color={colors.dim} />
        </Pressable>
        <View {...pan.panHandlers} accessibilityLabel={T("Move {title}", { title: track.title })} style={styles.handle}>
          <Menu size={20} color={colors.ink} />
        </View>
      </Animated.View>
    </PullRow>
  );
}

export function QueueScreen() {
  const nav = useNavigation<any>();
  useOverBottomBar();
  const insets = useSafeAreaInsets();
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const context = usePlayer((s) => s.context);
  const homeContext = usePlayer((s) => s.homeContext);
  const lineEnd = usePlayer((s) => s.lineEnd);
  const branches = usePlayer((s) => s.branches);
  const playWhenReady = usePlayer((s) => s.playWhenReady);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const sleepAt = usePlayer((s) => s.sleepAt);
  const { toggle, toggleShuffle, cycleRepeat, clearUpcoming, clearLine, cancelBranch, cycleSleepTimer } = usePlayer.getState();
  const [heldRow, setHeldRow] = useState<string | null>(null);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const current = queue[index];
  const onDragChange = useCallback((row: string | null) => setHeldRow(row), []);
  const openOrClose = (name: string): void => {
    glideList();
    setOpened((was) => {
      const next = new Set(was);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  };

  const { rows, tops } = useMemo(() => {
    const out: Row[] = [];
    const times = new Map<string, number>();
    const once = (key: string): string => {
      const n = times.get(key) ?? 0;
      times.set(key, n + 1);
      return `${key}:${n}`;
    };
    const hand = handRows(queue, index, lineEnd, branches, opened);
    if (hand.length) {
      out.push({ kind: "hand", key: "hand" });
      for (const row of hand) {
        if (row.kind === "song") out.push({ kind: "song", key: once(`song:${row.track.id}`), track: row.track, at: row.at, inHand: true });
        else if (row.kind === "branch") out.push({ kind: "branch", key: once(`branch:${row.branch}`), name: row.branch, count: row.count, folds: row.folds });
        else out.push({ kind: "more", key: once(`more:${row.branch}`), name: row.branch, count: row.count });
      }
      out.push({ kind: "handEnd", key: "handEnd" });
    }
    const from = Math.min(queue.length, Math.max(index + 1, lineEnd));
    const list = homeContext ?? context;
    if (from < queue.length) out.push({ kind: "list", key: "list", title: list ? T("Next from {name}", { name: list }) : T("Next up") });
    for (let at = from; at < queue.length; at++) out.push({ kind: "song", key: once(`song:${queue[at].id}`), track: queue[at], at, inHand: false });
    let y = 0;
    const places = out.map((row) => {
      const top = y;
      y += HEIGHT[row.kind];
      return top;
    });
    return { rows: out, tops: places };
  }, [queue, index, lineEnd, branches, opened, homeContext, context]);

  const placeFor = useCallback(
    (at: number, dy: number): number => {
      let from = 0;
      rows.forEach((row, i) => {
        if (row.kind === "song" && row.at === at) from = tops[i];
      });
      const wanted = from + dy;
      let best = at;
      let bestBy = Infinity;
      rows.forEach((row, i) => {
        if (row.kind !== "song") return;
        const by = Math.abs(tops[i] - wanted);
        if (by < bestBy) {
          bestBy = by;
          best = row.at;
        }
      });
      return best;
    },
    [rows, tops]
  );
  const minutesLeft = sleepAt ? Math.max(1, Math.round((sleepAt - Date.now()) / 60000)) : 0;

  // The sheet is always its full height and slides: 0 is all the way up.
  const { height } = useSafeAreaFrame();
  const sheetTop = insets.top + SHEET_GAP_ON_TOP;
  const away = height - sheetTop;
  const rest = away - height * AT_REST;
  const y = useRef(new Animated.Value(rest, { useNativeDriver: true })).current;
  const place = useRef(rest);
  const dragFrom = useRef(rest);
  const [big, setBig] = useState(false);

  const moveTo = useCallback(
    (to: number, velocity = 0) => {
      place.current = to;
      setBig(to === 0);
      Animated.spring(y, { ...SPRING, toValue: to, velocity }).start(({ finished }) => {
        if (finished && to === away) nav.goBack();
      });
    },
    [away, nav, y]
  );

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragFrom.current = place.current;
          y.stopAnimation((value) => (dragFrom.current = value));
        },
        onPanResponderMove: (_, g) => y.setValue(Math.max(0, dragFrom.current + g.dy)),
        onPanResponderRelease: (_, g) => {
          const ahead = dragFrom.current + g.dy + g.vy * FLICK_MS;
          moveTo([0, rest, away].reduce((best, p) => (Math.abs(p - ahead) < Math.abs(best - ahead) ? p : best)), g.vy * 1000);
        },
        onPanResponderTerminate: () => moveTo(place.current),
      }),
    [away, moveTo, rest, y]
  );

  const dimming = useMemo(() => y.interpolate({ inputRange: [rest, away], outputRange: [1, 0], extrapolate: "clamp" }), [away, rest, y]);
  // The buttons stay at the bottom of the screen until the sheet goes below its resting place.
  const buttonsY = useMemo(() => y.interpolate({ inputRange: [0, rest, away], outputRange: [0, -rest, -rest] }), [away, rest, y]);
  const buttonsHeight = BUTTON_HEIGHT + BUTTONS_ABOVE + BUTTONS_BELOW + insets.bottom;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.dim, { opacity: dimming }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => moveTo(away)} accessibilityLabel={T("Close the queue")} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { top: sheetTop, transform: [{ translateY: y }] }]}>
        <View {...pan.panHandlers}>
          <Pressable onPress={() => moveTo(big ? rest : 0)} accessibilityLabel={big ? T("Make the queue smaller") : T("Make the queue bigger")} style={styles.gripArea}>
            <View style={styles.grip} />
          </Pressable>
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text style={styles.heading}>{T("Queue")}</Text>
              <Text numberOfLines={1} style={styles.from}>{context ? T("Playing from '{context}'", { context }) : ""}</Text>
            </View>
            <Pressable onPress={clearUpcoming} style={styles.pill}>
              <Text style={styles.pillText}>{T("Clear")}</Text>
            </Pressable>
          </View>
        </View>

        <HeldRow.Provider value={heldRow}>
        <FlatList
          data={rows}
          scrollEnabled={!heldRow}
          CellRendererComponent={QueueCell}
          // What the sheet's lower part hides at rest can still be scrolled up into view.
          contentContainerStyle={{ paddingBottom: buttonsHeight + (big ? 0 : rest) }}
          keyExtractor={(row) => row.key}
          getItemLayout={(_, i) => ({ length: HEIGHT[rows[i].kind], offset: (current ? HEIGHT.song : 0) + tops[i], index: i })}
          ListHeaderComponent={
            current ? (
              <View style={styles.row}>
                <View style={styles.rowMain}>
                  <Cover uri={current.thumb} size={46} />
                  <View style={styles.rowText}>
                    <View style={styles.currentLine}>
                      <EqBars />
                      <Text numberOfLines={1} style={[styles.rowTitle, styles.currentTitle]}>
                        {current.title}
                      </Text>
                    </View>
                    <Text numberOfLines={1} style={styles.rowArtist}>
                      {current.artist}
                    </Text>
                  </View>
                </View>
                <Pressable onPress={toggle} accessibilityLabel={playWhenReady ? T("Pause") : T("Play")} style={styles.currentButton}>
                  {playWhenReady ? <Pause size={15} color="#121212" fill="#121212" /> : <Play size={15} color="#121212" fill="#121212" />}
                </Pressable>
              </View>
            ) : undefined
          }
          renderItem={({ item }) => {
            switch (item.kind) {
              case "song":
                return <UpcomingRow rowKey={item.key} track={item.track} at={item.at} inHand={item.inHand} onDragChange={onDragChange} placeFor={placeFor} />;
              case "hand":
                return (
                  <View style={[styles.inArea, styles.areaTop]}>
                    <Text numberOfLines={1} style={styles.areaTitle}>
                      {T("Next in queue")}
                    </Text>
                    <Pressable
                      onPress={() => {
                        feel("press");
                        glideList();
                        clearLine();
                      }}
                      hitSlop={6}
                      style={styles.areaClear}
                    >
                      <Text style={styles.areaClearText}>{T("Clear")}</Text>
                    </Pressable>
                  </View>
                );
              case "branch": {
                const open = opened.has(item.name);
                return (
                  <View style={[styles.inArea, styles.branchRow]}>
                    <Pressable
                      disabled={!item.folds}
                      onPress={() => openOrClose(item.name)}
                      accessibilityLabel={item.folds ? (open ? T("Show less") : T("Show all")) : undefined}
                      style={styles.branchName}
                    >
                      <Split size={14} color={colors.accent} strokeWidth={2.4} />
                      <Text numberOfLines={1} style={styles.branchText}>
                        {item.name}
                      </Text>
                      <Text style={styles.branchCount}>{item.count}</Text>
                      {item.folds && (open ? <ChevronUp size={15} color={colors.dim} /> : <ChevronDown size={15} color={colors.dim} />)}
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        feel("press");
                        glideList();
                        cancelBranch(item.name);
                      }}
                      hitSlop={6}
                      accessibilityLabel={T("Undo branch")}
                      style={styles.remove}
                    >
                      <X size={17} color={colors.dim} />
                    </Pressable>
                  </View>
                );
              }
              case "more":
                return (
                  <Pressable onPress={() => openOrClose(item.name)} style={[styles.inArea, styles.moreRow]}>
                    <Text style={styles.moreText}>{T("{count} more", { count: item.count })}</Text>
                    <ChevronDown size={15} color={colors.dim} />
                  </Pressable>
                );
              case "handEnd":
                return <View style={[styles.inArea, styles.areaEnd]} />;
              case "list":
                return (
                  <View style={styles.listHead}>
                    <Text numberOfLines={1} style={styles.listTitle}>
                      {item.title}
                    </Text>
                  </View>
                );
            }
          }}
        />
        </HeldRow.Provider>

        <Animated.View style={[styles.buttons, { paddingBottom: insets.bottom + BUTTONS_BELOW, transform: [{ translateY: buttonsY }] }]}>
          <Pressable onPress={toggleShuffle} style={styles.bigButton}>
            <Shuffle size={22} color={shuffle ? colors.accent : colors.ink} />
            <Text style={[styles.bigLabel, shuffle && { color: colors.accent }]}>{T("Shuffle")}</Text>
          </Pressable>
          <Pressable onPress={cycleRepeat} style={styles.bigButton}>
            {repeat === "one" ? <Repeat1 size={22} color={colors.accent} /> : <Repeat size={22} color={repeat === "all" ? colors.accent : colors.ink} />}
            <Text style={[styles.bigLabel, repeat !== "off" && { color: colors.accent }]}>{T("Repeat")}</Text>
          </Pressable>
          <Pressable onPress={() => cycleSleepTimer()} style={styles.bigButton}>
            <Timer size={22} color={sleepAt ? colors.accent : colors.ink} />
            <Text style={[styles.bigLabel, !!sleepAt && { color: colors.accent }]}>{sleepAt ? `${minutesLeft} min` : T("Timer")}</Text>
          </Pressable>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.68)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, backgroundColor: colors.sheet, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  gripArea: { height: 26, alignItems: "center", justifyContent: "center" },
  grip: { width: 34, height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)" },
  head: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingHorizontal: 15, paddingTop: 2, paddingBottom: 8 },
  headText: { flex: 1, minWidth: 0 },
  heading: { color: colors.ink, fontSize: 20, fontWeight: "700", letterSpacing: -0.3 },
  from: { color: "#B3B3B8", fontSize: 13, marginTop: 4 },
  pill: { height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: colors.button, justifyContent: "center" },
  pillText: { color: colors.ink, fontSize: 13.5, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "center", height: HEIGHT.song, paddingLeft: 15, paddingRight: AREA_MARGIN },
  rowInArea: { paddingLeft: 15 - AREA_MARGIN, paddingRight: 0 },
  rowHeld: { backgroundColor: colors.button },
  cellHeld: { zIndex: 10, elevation: 8 },
  remove: { width: 34, height: 44, alignItems: "center", justifyContent: "center" },
  inArea: { marginHorizontal: AREA_MARGIN },
  areaTop: { height: HEIGHT.hand, flexDirection: "row", alignItems: "center", paddingLeft: 15 - AREA_MARGIN, paddingRight: 4, backgroundColor: AREA, borderTopLeftRadius: 14, borderTopRightRadius: 14 },
  areaTitle: { flex: 1, minWidth: 0, color: colors.accent, fontSize: 13.5, fontWeight: "700" },
  areaClear: { height: 34, paddingHorizontal: 10, justifyContent: "center" },
  areaClearText: { color: colors.soft, fontSize: 13, fontWeight: "600" },
  areaEnd: { height: HEIGHT.handEnd - 8, marginBottom: 8, backgroundColor: AREA, borderBottomLeftRadius: 14, borderBottomRightRadius: 14 },
  branchRow: { height: HEIGHT.branch, flexDirection: "row", alignItems: "center", paddingLeft: 15 - AREA_MARGIN, paddingRight: 4, backgroundColor: AREA },
  branchName: { flex: 1, minWidth: 0, height: "100%", flexDirection: "row", alignItems: "center", gap: 7 },
  branchText: { flexShrink: 1, color: colors.ink, fontSize: 13, fontWeight: "600" },
  branchCount: { color: colors.dim, fontSize: 12.5 },
  moreRow: { height: HEIGHT.more, flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 15 - AREA_MARGIN + 46 + 12, backgroundColor: AREA },
  moreText: { color: colors.soft, fontSize: 13.5, fontWeight: "600" },
  listHead: { height: HEIGHT.list, justifyContent: "center", paddingHorizontal: 15 },
  listTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "700" },
  rowMain: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 12, height: "100%" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15.5 },
  rowLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  rowArtist: { color: "#B3B3B8", fontSize: 13.5, marginTop: 3 },
  currentLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  currentTitle: { flexShrink: 1, color: colors.accent },
  currentButton: { width: 32, height: 32, marginRight: 8, borderRadius: 16, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  handle: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  buttons: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", gap: 11, paddingHorizontal: 15, paddingTop: BUTTONS_ABOVE, backgroundColor: colors.sheet },
  bigButton: { flex: 1, height: BUTTON_HEIGHT, gap: 5, borderRadius: 10, backgroundColor: colors.button, alignItems: "center", justifyContent: "center" },
  bigLabel: { color: colors.ink, fontSize: 12.5 },
});
