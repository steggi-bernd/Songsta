/**
 * A group's own order (lib/libraryGroups.ts): what's in it, one place up or down at a time, the
 * list following along while the sheet stays up. Used by Your Library's groups and Explore's.
 */
import { ArrowDown, ArrowUp } from "lucide-react-native";
import type { ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { feel } from "../stores/settings";
import { colors } from "../theme";
import { SheetFrame, SheetHead } from "./Sheet";
import { T } from "../shared";

export interface OrderItem {
  key: string;
  label: string;
  line?: string;
  art?: ReactNode;
}

export function GroupOrderSheet({
  visible,
  title,
  items,
  onMove,
  onClose,
}: {
  visible: boolean;
  title?: string;
  items: OrderItem[];
  onMove: (key: string, by: -1 | 1) => void;
  onClose: () => void;
}) {
  const arrow = (item: OrderItem, by: -1 | 1, can: boolean) => {
    const Icon = by < 0 ? ArrowUp : ArrowDown;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={by < 0 ? T("Move up") : T("Move down")}
        accessibilityState={{ disabled: !can }}
        disabled={!can}
        hitSlop={4}
        onPress={() => {
          feel("tick");
          onMove(item.key, by);
        }}
        style={styles.arrow}
      >
        <Icon size={20} color={can ? colors.ink : "rgba(255,255,255,0.22)"} />
      </Pressable>
    );
  };
  return (
    <SheetFrame visible={visible} onClose={onClose}>
      <SheetHead title={title} subtitle={T("Change the order")} />
      <ScrollView bounces={false} overScrollMode="never" style={styles.rows}>
        {items.map((item, i) => (
          <View key={item.key} style={styles.row}>
            {item.art}
            <View style={styles.text}>
              <Text numberOfLines={1} style={styles.label}>
                {item.label}
              </Text>
              {!!item.line && (
                <Text numberOfLines={1} style={styles.line}>
                  {item.line}
                </Text>
              )}
            </View>
            {arrow(item, -1, i > 0)}
            {arrow(item, 1, i < items.length - 1)}
          </View>
        ))}
      </ScrollView>
    </SheetFrame>
  );
}

const styles = StyleSheet.create({
  rows: { flexGrow: 0, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 60, paddingLeft: 18, paddingRight: 8 },
  text: { flex: 1, minWidth: 0 },
  label: { color: colors.ink, fontSize: 15.5 },
  line: { color: colors.dim, fontSize: 13, marginTop: 2 },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
});
