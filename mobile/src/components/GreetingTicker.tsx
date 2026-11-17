/**
 * Home's greeting, and while Home is pulled to refresh, what's being read again in its place (the user's
 * wish, 2026-11-17): a line for each step from refreshAll.ts ("Server: reached", "Albums: 2 new", …),
 * each pushed up and out by the next as on the computer's note in the player, and shown long enough to
 * read even when the steps come quicker. It ends with "All up to date" or that the server can't be
 * reached, held a moment, and then the greeting comes back. A line too long for the room shrinks to fit,
 * it's never cut off.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { useRefreshReport, type ReportLine } from "../refreshAll";
import { colors } from "../theme";

/** How long a line stays at least, so it can be read; the last one a little longer. */
const READ_MS = 1250;
const LAST_MS = 2000;
const ROOM = 40;

interface Shown {
  key: string;
  text: string;
  tone: ReportLine["tone"] | "greeting";
}

const TONE: Record<Shown["tone"], { color: string; size: number; weight: "800" | "700" }> = {
  greeting: { color: colors.ink, size: 26, weight: "800" },
  busy: { color: colors.dim, size: 22, weight: "700" },
  ok: { color: colors.ink, size: 22, weight: "700" },
  warn: { color: "#FFB4A8", size: 22, weight: "700" },
  done: { color: colors.accent, size: 24, weight: "800" },
};

export function GreetingTicker({ greeting }: { greeting: string }) {
  const lines = useRefreshReport((s) => s.lines);
  const running = useRefreshReport((s) => s.running);
  const [now, setNow] = useState<Shown>({ key: "greeting", text: greeting, tone: "greeting" });
  const [before, setBefore] = useState<Shown | null>(null);
  const turn = useRef(new Animated.Value(1)).current;
  /**
   * The last line shown, by its number: numbers only grow, from one pull to the next, so a new pull's
   * lines are the ones above it. (Counting places in the list kept the last pull's count when its lines
   * were replaced at once, and the second pull showed nothing.)
   */
  const shownId = useRef(0);
  const shownAt = useRef(0);
  const nowRef = useRef(now);
  nowRef.current = now;

  // The greeting follows the hour while it shows.
  useEffect(() => {
    if (nowRef.current.tone === "greeting" && nowRef.current.text !== greeting) setNow({ key: "greeting", text: greeting, tone: "greeting" });
  }, [greeting]);

  useEffect(() => {
    const show = (item: Shown): void => {
      setBefore(nowRef.current);
      setNow(item);
      shownAt.current = Date.now();
      turn.setValue(0);
      Animated.timing(turn, { toValue: 1, duration: 340, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => setBefore(null));
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = (): void => {
      const current = nowRef.current;
      const waited = Date.now() - shownAt.current;
      const waiting = lines.find((l) => l.id > shownId.current);
      const isLast = current.tone !== "greeting" && !waiting && !running;
      // The last word is on screen: the pull's visualizer can stop (refreshAll.ts, whenTold).
      const tell = (): void => {
        if (!useRefreshReport.getState().told) useRefreshReport.setState({ told: true });
      };
      if (isLast) tell();
      if (waiting && (current.tone === "greeting" || waited >= READ_MS)) {
        shownId.current = waiting.id;
        show({ key: `line-${waiting.id}`, text: waiting.text, tone: waiting.tone });
        // Said as it comes in, not a beat later, so the lines stop as "All up to date" rises.
        if (!running && !lines.some((l) => l.id > waiting.id)) tell();
        timer = setTimeout(step, READ_MS);
      } else if (isLast && waited >= LAST_MS) {
        show({ key: `greeting-${Date.now()}`, text: greeting, tone: "greeting" });
      } else if (current.tone !== "greeting" || waiting) {
        timer = setTimeout(step, Math.max(60, (isLast ? LAST_MS : READ_MS) - waited));
      }
    };
    step();
    return () => {
      if (timer) clearTimeout(timer);
    };
    // Each new line, and the end of the run, look again; the greeting's own text is read when it's due.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, running, turn]);

  const rise = turn.interpolate({ inputRange: [0, 1], outputRange: [ROOM * 0.8, 0] });
  const leave = turn.interpolate({ inputRange: [0, 1], outputRange: [0, -ROOM * 0.8] });
  return (
    <View style={styles.room} accessibilityLiveRegion="polite">
      {before && (
        <Animated.View style={[styles.line, { opacity: turn.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }), transform: [{ translateY: leave }] }]}>
          <Line item={before} />
        </Animated.View>
      )}
      <Animated.View key={now.key} style={[styles.line, { opacity: turn, transform: [{ translateY: rise }] }]}>
        <Line item={now} />
      </Animated.View>
    </View>
  );
}

function Line({ item }: { item: Shown }) {
  const tone = TONE[item.tone];
  return (
    <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={[styles.text, { color: tone.color, fontSize: tone.size, fontWeight: tone.weight }]}>
      {item.text}
    </Text>
  );
}

const styles = StyleSheet.create({
  room: { flex: 1, height: ROOM, overflow: "hidden", justifyContent: "center" },
  line: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0, justifyContent: "center" },
  text: { letterSpacing: -0.5, overflow: "visible" },
});
