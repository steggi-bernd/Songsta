/**
 * A page closed by pulling it down, as the player is: from anywhere on it, while the list it shows is
 * at its top. It follows the finger, and past a quarter of the screen, or flung, it goes; otherwise it
 * springs back. Scrolling and sideways swipes stay the page's own. Android gives a drag to a scrolling
 * list before JavaScript sees it, so the pull is caught natively (PullDownView.kt).
 *
 * The page it was opened from lies beneath (navigation.tsx `pullDownPage`), under a dark shade that
 * gets lighter the further this page goes down; once it's gone, the page beneath is simply there.
 */
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { PullDownView } from "../../modules/media3-player";
import { colors } from "../theme";

export function PullDownToClose({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <View style={styles.fill} collapsable={false}>
      {/* PullDownView.kt finds the shade right before it and sets how dark it is. */}
      <View style={styles.shade} pointerEvents="none" collapsable={false} />
      <PullDownView style={styles.page} onClose={onClose}>
        {children}
      </PullDownView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: "#000" },
  page: { flex: 1, backgroundColor: colors.base },
});
