/**
 * One line of text that doesn't fit its place: it waits a moment, then runs through to the left at
 * a reading pace, a second copy following it in, and starts over, always in the same direction, as
 * on Spotify. Text that fits stays as it is. With "Reduce motion" on it's cut off with dots instead.
 * The move runs on the native side, so a long title costs JavaScript nothing while it scrolls.
 */
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { useSettings } from "../stores/settings";

/** Points per second: slow enough to read along. */
const PACE = 32;
/** The pause before each run, and the room between the text and its copy. */
const REST_MS = 1800;
const GAP = 48;

export function Marquee({ text, style, active = true }: { text: string; style?: StyleProp<TextStyle>; active?: boolean }) {
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const [room, setRoom] = useState(0);
  const [length, setLength] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  const runs = active && !reduceMotion && room > 0 && length > room + 1;

  useEffect(() => {
    x.setValue(0);
    if (!runs) return;
    const way = length + GAP;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(REST_MS),
        Animated.timing(x, { toValue: -way, duration: (way / PACE) * 1000, easing: Easing.linear, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [runs, length, text, x]);

  return (
    <View style={styles.root} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      {/* What gives the line its size, and what shows when the text fits. */}
      <Text numberOfLines={1} style={[style, runs && styles.unseen]}>
        {text}
      </Text>
      {/* The text at its full length, only to measure it. */}
      <View style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text numberOfLines={1} style={[style, styles.unseen]} onLayout={(e) => setLength(e.nativeEvent.layout.width)}>
          {text}
        </Text>
      </View>
      {runs && (
        <Animated.View style={[styles.run, { transform: [{ translateX: x }] }]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <Text numberOfLines={1} style={style}>
            {text}
          </Text>
          <View style={{ width: GAP }} />
          <Text numberOfLines={1} style={style}>
            {text}
          </Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { maxWidth: "100%", overflow: "hidden" },
  unseen: { opacity: 0 },
  // Wide enough for any title: in a row this wide a line of text takes its own length.
  measure: { position: "absolute", left: 0, top: 0, width: 20000, flexDirection: "row" },
  run: { position: "absolute", left: 0, top: 0, bottom: 0, flexDirection: "row", alignItems: "flex-start" },
});
