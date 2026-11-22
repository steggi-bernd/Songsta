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
 *
 * Let go, and the page snaps up like a rubber band and stops right under the lines (the user's wish,
 * 2026-11-22). That move is a spring stepped here frame by frame: Android's own animated scroll starts
 * slowly, so the page seemed to hang down before it went up, and a finger still moving as it let go
 * flung the page on down first. While a pull is in the room, the list's flings stop at once.
 */
import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { Animated, Easing, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { feel } from "../stores/settings";
import { colors } from "../theme";

/** The room above the page, as far as a pull reaches. */
const ROOM = 170;
/** Pulled this far, letting go reads everything again. */
const ARM = 104;
/** While it loads, the page stays this far down (lower since the user found 88 too high, 2026-11-20). */
const HOLD = 64;
const BARS = 27;
/** How short loading keeps the lines dancing at least, so a quick answer still shows them. */
const MIN_LOADING_MS = 900;

/** Each line's share of the longest: a V, longest in the middle, a little uneven as a spectrum is. */
const SHAPE = Array.from({ length: BARS }, (_, i) => {
  const t = 1 - Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2 + 1);
  return Math.max(0.08, Math.pow(t, 0.9) * [0.86, 1, 0.9, 0.96, 0.82, 1, 0.92][i % 7]);
});
/** The longest a line gets while loading, as a share of its length pulled all the way: it fits the room left open. */
const LOAD_MAX = (HOLD - 12) / (ROOM * 0.8);
/** While loading the V is flatter, so the outer lines move too. */
const LOAD_SHAPE = SHAPE.map((share) => 0.4 + 0.6 * share);

/**
 * The visualizer, as music flows rather than in steps (the user found frames robotic, 2026-11-20): two
 * waves run across the lines in opposite directions and a slower third one rolls under them, so the
 * shape keeps moving like sound does, and a soft beat swells the middle four times a round, 120 beats a
 * minute. Everything repeats whole within one round, so the loop has no seam. Each line gets its share
 * of its loading length at SAMPLES points of the round; the native side moves smoothly in between.
 */
const LOOP_MS = 2000;
const SAMPLES = 64;
/** The snap's spring: stiff, so it starts at once; a little under-damped, so it gives a hint of a bounce. */
const SNAP_STIFFNESS = 520;
const SNAP_DAMPING = 0.76;
const WAVES: number[][] = Array.from({ length: BARS }, (_, i) => {
  const out: number[] = [];
  for (let k = 0; k <= SAMPLES; k++) {
    const s = k / SAMPLES;
    const a = 0.5 + 0.5 * Math.sin(2 * Math.PI * (s + i * 0.055));
    const b = 0.5 + 0.5 * Math.sin(2 * Math.PI * (2 * s - i * 0.09) + 1.3);
    const c = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 * s + i * 0.031) + 2.1);
    // The beat rises quickly and dies away slowly, strongest in the middle, where the bass sits.
    const phase = (s * 4) % 1;
    const swell = phase < 0.08 ? phase / 0.08 : Math.exp(-(phase - 0.08) / 0.16);
    const beat = swell * Math.exp(-((i - (BARS - 1) / 2) ** 2) / 45);
    out.push(Math.max(0.12, Math.min(1, 0.16 + 0.32 * a + 0.2 * b + 0.12 * c + 0.28 * beat)));
  }
  return out;
});
const SAMPLE_AT = Array.from({ length: SAMPLES + 1 }, (_, k) => k / SAMPLES);

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
  /**
   * The visualizer's clock (0 to 1 each round), the lines' length where the visualizer takes over or
   * hands back, and how far it has taken over (0 to 1): the lines blend from the pull into the waves
   * and back instead of jumping. And how bright they are.
   */
  const clock = useRef(new Animated.Value(0)).current;
  const handover = useRef(new Animated.Value(0)).current;
  const mix = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(1)).current;
  /**
   * 1 while loading, else 0. The lines stay tied to the same animated values all along, and this switch
   * (set on the native side) picks between the pull's and the visualizer's: changing what a line is tied
   * to drew it one frame from a stale scroll place, and the lines blinked as the finger let go.
   */
  const loading = useRef(new Animated.Value(0)).current;
  const moves = useRef<Animated.CompositeAnimation | null>(null);
  /** the snap's next frame, while it runs */
  const snapFrame = useRef<number | null>(null);
  /** in the room: the list's flings stop at once (a fling there only fought the snap) */
  const [inRoom, setInRoom] = useState(false);
  const inRoomRef = useRef(false);
  useEffect(
    () => () => {
      moves.current?.stop();
      if (snapFrame.current !== null) cancelAnimationFrame(snapFrame.current);
    },
    []
  );

  const pull = useMemo(() => y.interpolate({ inputRange: [0, ROOM], outputRange: [ROOM, 0], extrapolate: "clamp" }), [y]);
  const grow = useMemo(() => pull.interpolate({ inputRange: [0, ROOM], outputRange: [0, 1], extrapolate: "clamp" }), [pull]);
  const lit = useMemo(() => pull.interpolate({ inputRange: [ARM - 16, ARM], outputRange: [0.5, 1], extrapolate: "clamp" }), [pull]);
  const halo = useMemo(() => pull.interpolate({ inputRange: [ARM - 4, ARM + 8], outputRange: [0, 0.3], extrapolate: "clamp" }), [pull]);
  const lift = useMemo(() => y.interpolate({ inputRange: [ROOM, ROOM + 400], outputRange: [0, -400], extrapolate: "clamp" }), [y]);
  /** scrolled on down while loading, the lines go up with the page instead of standing over it */
  const follow = useMemo(() => y.interpolate({ inputRange: [ROOM - HOLD, ROOM - HOLD + 600], outputRange: [0, -600], extrapolate: "clamp" }), [y]);
  const tied = useMemo(() => {
    const pulling = Animated.subtract(1, loading);
    const before = Animated.multiply(handover, Animated.subtract(1, mix));
    return {
      scales: WAVES.map((wave, i) => {
        const flowing = clock.interpolate({ inputRange: SAMPLE_AT, outputRange: wave.map((v) => (LOAD_MAX * v * LOAD_SHAPE[i]) / SHAPE[i]) });
        const visualizer = Animated.add(before, Animated.multiply(flowing, mix));
        return Animated.add(Animated.multiply(grow, pulling), Animated.multiply(visualizer, loading));
      }),
      opacity: Animated.add(Animated.multiply(lit, pulling), Animated.multiply(glow, loading)),
      halo: Animated.multiply(halo, pulling),
      shift: Animated.multiply(follow, loading),
    };
  }, [clock, handover, mix, grow, lit, glow, halo, follow, loading]);
  /** the length a pull to here gives the lines */
  const grownAt = (offset: number): number => Math.max(0, Math.min(1, (ROOM - offset) / ROOM));

  const settle = (to: number): void => {
    stopSnap();
    settling.current = true;
    list.current?.scrollTo({ y: to, animated: true });
  };

  const stopSnap = (): void => {
    if (snapFrame.current !== null) cancelAnimationFrame(snapFrame.current);
    snapFrame.current = null;
  };

  /**
   * The page from where it is to `to` on a spring, a frame at a time: it moves off at once and comes to
   * rest exactly there. `bounce` lets it swing a hair past and back, as a rubber band does.
   */
  const snap = (to: number, bounce: boolean, then?: () => void): void => {
    stopSnap();
    settling.current = true;
    const damping = 2 * (bounce ? SNAP_DAMPING : 1) * Math.sqrt(SNAP_STIFFNESS);
    let place = at.current;
    let speed = 0;
    let last: number | null = null;
    const frame = (now: number): void => {
      // (The first step's clock and a frame's may differ: whatever comes out, a step stays within reason.)
      const dt = last === null ? 1 / 60 : Math.max(1 / 240, Math.min(0.05, (now - last) / 1000));
      last = now;
      // A few small steps per frame keep the spring steady whatever the frame rate.
      for (let i = 0; i < 4; i++) {
        const h = dt / 4;
        speed += (-SNAP_STIFFNESS * (place - to) - damping * speed) * h;
        place += speed * h;
      }
      const resting = Math.abs(place - to) < 0.5 && Math.abs(speed) < 20;
      list.current?.scrollTo({ y: resting ? to : place, animated: false });
      if (resting) {
        snapFrame.current = null;
        then?.();
        return;
      }
      snapFrame.current = requestAnimationFrame(frame);
    };
    // The first step at once, not a frame later: the page is already on its way when the finger is off.
    frame(performance.now());
  };

  /**
   * The visualizer: its clock runs round after round (each round ends where it began, so the loop's
   * reset to 0 is seamless), and the lines blend from their length when the finger let go into it.
   */
  const play = (from: number): void => {
    moves.current?.stop();
    handover.setValue(from);
    mix.setValue(0);
    glow.setValue(1);
    clock.setValue(0);
    moves.current = Animated.loop(Animated.timing(clock, { toValue: 1, duration: LOOP_MS, easing: Easing.linear, useNativeDriver: true }));
    moves.current.start();
    Animated.timing(mix, { toValue: 1, duration: 450, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }).start();
  };

  const done = (): void => {
    // The lines blend back to the length the pull gives where the page stands, then go up with it.
    handover.setValue(grownAt(at.current));
    Animated.parallel([
      Animated.timing(mix, { toValue: 0, duration: 380, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      Animated.timing(glow, { toValue: 0.5, duration: 380, useNativeDriver: true }),
    ]).start(() => {
      moves.current?.stop();
      moves.current = null;
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
    // Reading starts once the page has snapped up (or soon in any case): its work on this thread
    // mustn't make the snap stutter.
    let begun = false;
    const begin = (): void => {
      if (begun) return;
      begun = true;
      const began = Date.now();
      void onRefresh()
        .catch(() => undefined)
        .finally(() => setTimeout(done, Math.max(0, MIN_LOADING_MS - (Date.now() - began))));
    };
    snap(ROOM - HOLD, true, begin);
    setTimeout(begin, 450);
  };

  const onScroll = useMemo(
    () =>
      Animated.event([{ nativeEvent: { contentOffset: { y } } }], {
        useNativeDriver: true,
        listener: (e: NativeSyntheticEvent<NativeScrollEvent>) => {
          const now = e.nativeEvent.contentOffset.y;
          at.current = now;
          if (now >= ROOM - 0.5) settling.current = false;
          const room = now < ROOM - 2;
          if (room !== inRoomRef.current) {
            inRoomRef.current = room;
            setInRoom(room);
          }
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
        decelerationRate={inRoom ? 0 : "normal"}
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
          stopSnap();
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
            if (now < ROOM - HOLD) snap(ROOM - HOLD, true);
          } else if (ROOM - now >= ARM) start();
          else if (now < ROOM - 1) snap(ROOM, false);
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
