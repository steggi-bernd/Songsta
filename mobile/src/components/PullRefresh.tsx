/**
 * Pull to refresh in Songsta's own way (the user's pick from the mockups, "Neu laden A", 2026-11-17):
 * sound lines hang from the top and grow as you pull, the longest in the middle; pulled far enough they
 * light up. Let go and the page springs back part of the way, and the same lines play as a visualizer
 * does, a spectrum moving to a beat, for as long as loading lasts (the user's wish); then they draw
 * back up with the page. The page moves down with the finger and nothing opens up behind it: what the
 * screen shows behind the page (`backdrop`, the home page's colour wash) stays where it is while you
 * pull, and only goes up with the page as you scroll.
 *
 * Android gives a drag on a list to the list before JavaScript sees it, so there's no gesture to catch:
 * the list starts scrolled a little way down, past a room of its own at the top (ROOM). Pulling at the
 * top scrolls into that room, and how far in is the pull. A fling never runs into it: it stops at the
 * page's real top.
 */
import { useEffect, useMemo, useRef, type ComponentRef, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { feel } from "../stores/settings";
import { colors } from "../theme";

/** The room above the page, as far as a pull reaches. */
const ROOM = 170;
/** Pulled this far, letting go reads everything again. */
const ARM = 104;
/** While it loads, the page stays this far down. */
const HOLD = 88;
const BARS = 27;
/** How short loading keeps the lines dancing at least, so a quick answer still shows them. */
const MIN_LOADING_MS = 900;

/** Each line's share of the longest: a V, longest in the middle, a little uneven as a spectrum is. */
const SHAPE = Array.from({ length: BARS }, (_, i) => {
  const t = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2 + 1);
  return Math.max(0.08, Math.pow(t, 0.9) * [0.86, 1, 0.9, 0.96, 0.82, 1, 0.92][i % 7]);
});
/** The longest a line gets while loading, as a share of its length pulled all the way: it fits the room left open. */
const LOAD_MAX = (HOLD - 10) / (ROOM * 0.8);
/** While loading the V is flatter, so the outer lines move too. */
const LOAD_SHAPE = SHAPE.map((share) => 0.32 + 0.68 * share);

/**
 * The visualizer: frames of a spectrum one after the other, neighbours close to each other as in real
 * music, a beat every fourth frame that lifts the middle and comes quicker. Made once, the same moves
 * every time; a frame says each line's share of its loading length.
 */
const FRAMES: number[][] = (() => {
  let s = 20261117;
  const rand = (): number => (s = (s * 16807) % 2147483647) / 2147483647;
  const out: number[][] = [];
  for (let f = 0; f < 32; f++) {
    const peaks = Array.from({ length: 3 }, () => ({ at: rand() * (BARS - 1), wide: 1.6 + rand() * 3.4, high: 0.45 + rand() * 0.55 }));
    const beat = f % 4 === 0;
    out.push(
      Array.from({ length: BARS }, (_, i) => {
        let v = 0.18 + rand() * 0.16;
        for (const p of peaks) v = Math.max(v, p.high * Math.exp(-((i - p.at) ** 2) / (2 * p.wide * p.wide)));
        if (beat) v += 0.34 * Math.exp(-((i - (BARS - 1) / 2) ** 2) / 50);
        return Math.min(1, v);
      })
    );
  }
  return out;
})();
const FRAME_MS = FRAMES.map((_, f) => (f % 4 === 0 ? 80 : 130 + (f % 3) * 25));

export function PullRefreshScroll({
  onRefresh,
  backdrop,
  contentContainerStyle,
  children,
}: {
  onRefresh: () => Promise<unknown>;
  /** drawn behind the page: it goes up as the page scrolls, but not down as the page is pulled */
  backdrop?: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const list = useRef<ComponentRef<typeof Animated.ScrollView>>(null);
  const y = useRef(new Animated.Value(ROOM)).current;
  const at = useRef(ROOM);
  const dragging = useRef(false);
  const armed = useRef(false);
  /** a fling or a let-go going back to the page's top */
  const settling = useRef(false);
  const loadingRef = useRef(false);
  const placed = useRef(false);
  /** each line's length while loading, as a share of its length pulled all the way; and how bright they are */
  const eq = useRef(Array.from({ length: BARS }, () => new Animated.Value(0))).current;
  const glow = useRef(new Animated.Value(1)).current;
  /**
   * 1 while loading, else 0. The lines stay tied to the same animated values all along, and this switch
   * (set on the native side) picks between the pull's and the visualizer's: changing what a line is tied
   * to drew it one frame from a stale scroll place, and the lines blinked as the finger let go.
   */
  const loading = useRef(new Animated.Value(0)).current;
  const moves = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => () => moves.current?.stop(), []);

  const pull = useMemo(() => y.interpolate({ inputRange: [0, ROOM], outputRange: [ROOM, 0], extrapolate: "clamp" }), [y]);
  const grow = useMemo(() => pull.interpolate({ inputRange: [0, ROOM], outputRange: [0, 1], extrapolate: "clamp" }), [pull]);
  const lit = useMemo(() => pull.interpolate({ inputRange: [ARM - 16, ARM], outputRange: [0.5, 1], extrapolate: "clamp" }), [pull]);
  const halo = useMemo(() => pull.interpolate({ inputRange: [ARM - 4, ARM + 8], outputRange: [0, 0.3], extrapolate: "clamp" }), [pull]);
  const lift = useMemo(() => y.interpolate({ inputRange: [ROOM, ROOM + 400], outputRange: [0, -400], extrapolate: "clamp" }), [y]);
  /** scrolled on down while loading, the lines go up with the page instead of standing over it */
  const follow = useMemo(() => y.interpolate({ inputRange: [ROOM - HOLD, ROOM - HOLD + 600], outputRange: [0, -600], extrapolate: "clamp" }), [y]);
  const tied = useMemo(() => {
    const pulling = Animated.subtract(1, loading);
    return {
      scales: eq.map((v) => Animated.add(Animated.multiply(grow, pulling), Animated.multiply(v, loading))),
      opacity: Animated.add(Animated.multiply(lit, pulling), Animated.multiply(glow, loading)),
      halo: Animated.multiply(halo, pulling),
      shift: Animated.multiply(follow, loading),
    };
  }, [eq, grow, lit, glow, halo, follow, loading]);
  /** the length a pull to here gives the lines */
  const grownAt = (offset: number): number => Math.max(0, Math.min(1, (ROOM - offset) / ROOM));

  const settle = (to: number): void => {
    settling.current = true;
    list.current?.scrollTo({ y: to, animated: true });
  };

  /** The visualizer, from the lines' length when the finger let go into the spectrum's frames, over and over. */
  const play = (from: number): void => {
    moves.current?.stop();
    eq.forEach((v) => v.setValue(from));
    glow.setValue(1);
    moves.current = Animated.parallel(
      eq.map((v, i) =>
        Animated.loop(
          Animated.sequence(
            FRAMES.map((frame, f) =>
              Animated.timing(v, { toValue: (LOAD_MAX * frame[i] * LOAD_SHAPE[i]) / SHAPE[i], duration: FRAME_MS[f], easing: Easing.out(Easing.quad), useNativeDriver: true })
            )
          ),
          // A loop puts its value back where it was made (0) before each round, the first one too: the
          // lines dropped to nothing as the finger let go, and again every round.
          { iterations: -1, resetBeforeIteration: false }
        )
      )
    );
    moves.current.start();
  };

  const done = (): void => {
    moves.current?.stop();
    moves.current = null;
    // The lines take the length the pull gives where the page stands, then go back up with it.
    const to = grownAt(at.current);
    Animated.parallel([
      ...eq.map((v) => Animated.timing(v, { toValue: to, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true })),
      Animated.timing(glow, { toValue: 0.5, duration: 240, useNativeDriver: true }),
    ]).start(() => {
      loadingRef.current = false;
      armed.current = false;
      loading.setValue(0);
      if (at.current < ROOM - 1 && !dragging.current) settle(ROOM);
    });
  };

  const start = (): void => {
    loadingRef.current = true;
    feel("press");
    play(grownAt(at.current));
    loading.setValue(1);
    settle(ROOM - HOLD);
    const began = Date.now();
    void onRefresh()
      .catch(() => undefined)
      .finally(() => setTimeout(done, Math.max(0, MIN_LOADING_MS - (Date.now() - began))));
  };

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const now = e.nativeEvent.contentOffset.y;
          at.current = now;
          if (now >= ROOM - 0.5) settling.current = false;
          if (dragging.current) {
            const nowArmed = ROOM - now >= ARM;
            if (nowArmed !== armed.current) {
              armed.current = nowArmed;
              if (nowArmed && !loadingRef.current) feel("tick");
            }
          } else if (!loadingRef.current && !settling.current && now < ROOM - 1) {
            // A fling that would run on into the room stops at the page's top.
            settle(ROOM);
          }
        },
      }),
    // The listener reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [y]
  );

  return (
    <View style={styles.root}>
      {!!backdrop && (
        <Animated.View pointerEvents="none" style={[styles.backdrop, { transform: [{ translateY: lift }] }]}>
          {backdrop}
        </Animated.View>
      )}
      <Animated.ScrollView
        ref={list}
        style={styles.list}
        contentOffset={{ x: 0, y: ROOM }}
        contentContainerStyle={contentContainerStyle}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onContentSizeChange={(_w, h) => {
          // Where contentOffset isn't heeded, the page is put past its room once it's tall enough.
          if (!placed.current && h > ROOM) {
            placed.current = true;
            if (at.current < ROOM - 1) list.current?.scrollTo({ y: ROOM, animated: false });
          }
        }}
        onScrollBeginDrag={() => {
          dragging.current = true;
          settling.current = false;
        }}
        onScrollEndDrag={(e) => {
          dragging.current = false;
          const now = e.nativeEvent.contentOffset.y;
          // Scroll events can reach JavaScript after this one: where the finger let go is taken from here,
          // or the visualizer started from a stale place, with no lines for a frame.
          at.current = now;
          if (loadingRef.current) {
            if (now < ROOM - HOLD) settle(ROOM - HOLD);
          } else if (ROOM - now >= ARM) start();
          else if (now < ROOM - 1) settle(ROOM);
        }}
        onMomentumScrollEnd={(e) => {
          const now = e.nativeEvent.contentOffset.y;
          if (!loadingRef.current && !dragging.current && now < ROOM - 1) settle(ROOM);
        }}
      >
        <View style={{ height: ROOM }} />
        {children}
      </Animated.ScrollView>
      {/* The lines hang from just under the status bar into the room the page leaves as it moves down. */}
      <Animated.View pointerEvents="none" style={[styles.lines, { top: insets.top + 4, width, transform: [{ translateY: tied.shift }] }]}>
        {SHAPE.map((share, i) => {
          const left = ((width - 16) / BARS) * i + 8;
          const w = Math.max(5, ((width - 16) / BARS) * 0.62);
          const height = Math.round(ROOM * 0.8 * share);
          const scale = tied.scales[i];
          return (
            <View key={i} style={{ position: "absolute", left, top: 0, width: w }}>
              <Animated.View style={[styles.halo, { height, width: w + 8, marginLeft: -4, opacity: tied.halo, transform: [{ scaleY: scale }] }]} />
              <Animated.View style={[styles.line, { height, width: w, opacity: tied.opacity, transform: [{ scaleY: scale }] }]} />
            </View>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  backdrop: { position: "absolute", left: 0, right: 0, top: 0 },
  list: { flex: 1, backgroundColor: "transparent" },
  lines: { position: "absolute", left: 0, height: ROOM },
  line: { position: "absolute", top: 0, left: 0, borderBottomLeftRadius: 3, borderBottomRightRadius: 3, backgroundColor: colors.accent, transformOrigin: "top" },
  halo: { position: "absolute", top: 0, borderBottomLeftRadius: 6, borderBottomRightRadius: 6, backgroundColor: colors.accent, transformOrigin: "top" },
});
