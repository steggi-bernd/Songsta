/**
 * What stays over every page: the three tabs and the player. They share this
 * slot so the player's page can slide up over the tabs, which stay where they are.
 */
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { LinearGradient } from "expo-linear-gradient";
import { House, Library, Search } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useOverBottomBar } from "../stores/popups";
import { deviceName, pickMusicFor, useZones } from "../stores/zones";
import { colors, MINI_PLAYER_HEIGHT, TAB_BAR_HEIGHT } from "../theme";
import { PlayerSheet } from "./PlayerSheet";
import { useSongMenu } from "./SongMenu";
import { T } from "../shared";

const TABS = [
  { label: T("Home"), Icon: House },
  { label: T("Search"), Icon: Search },
  { label: T("Your Library"), Icon: Library },
];

export function BottomBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const progress = useRef(new Animated.Value(0, { useNativeDriver: true })).current;
  const [expanded, setExpanded] = useState(false);
  // The open player covers the tab bar and the mini player: notes sit lower then.
  useOverBottomBar(expanded);
  const pickingFor = useZones((s) => s.pickingFor);
  const shownTab = state.routes[state.index].name;
  const goTo = (screen: string, params: object): void => navigation.navigate(shownTab, { screen, params });
  useEffect(() => {
    useSongMenu.setState({ goTo });
  });

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View pointerEvents={expanded ? "none" : "box-none"} style={styles.tabsLayer}>
        <LinearGradient colors={["rgba(0,0,0,0.72)", colors.base]} locations={[0, 0.5]} style={{ paddingBottom: insets.bottom }}>
          <View style={styles.tabs} accessibilityRole="tablist">
            {TABS.map(({ label, Icon }, i) => {
              const active = state.index === i;
              const color = active ? colors.ink : colors.dim;
              return (
                <Pressable
                  key={label}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  style={styles.tab}
                  onPress={() => {
                    const route = state.routes[i];
                    // On the tab already: back to its first page, as on Spotify.
                    if (active) navigation.navigate(route.name, { screen: route.name.replace("Tab", "") });
                    else navigation.navigate(route.name);
                  }}
                >
                  <Icon size={24} color={color} strokeWidth={active ? 2.6 : 1.9} fill={active && i === 0 ? color : "transparent"} />
                  <Text style={[styles.tabLabel, { color }]}>{label}</Text>
                </Pressable>
              );
            })}
          </View>
        </LinearGradient>
      </View>
      {pickingFor && (
        <View style={[styles.picking, { bottom: insets.bottom + TAB_BAR_HEIGHT + MINI_PLAYER_HEIGHT + 8 }]}>
          <Text numberOfLines={1} style={styles.pickingText}>{T("Choose music for {deviceName}", { deviceName: deviceName(pickingFor) })}
          </Text>
          <Pressable onPress={() => pickMusicFor(null)} hitSlop={8} accessibilityLabel={T("Stop choosing")}>
            <Text style={styles.pickingCancel}>{T("Cancel")}</Text>
          </Pressable>
        </View>
      )}
      <PlayerSheet
        progress={progress}
        expanded={expanded}
        setExpanded={setExpanded}
        goTo={goTo}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tabsLayer: { position: "absolute", left: 0, right: 0, bottom: 0 },
  tabs: { flexDirection: "row", height: TAB_BAR_HEIGHT, paddingHorizontal: 12 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 4 },
  tabLabel: { fontSize: 11, fontWeight: "500" },
  picking: { position: "absolute", left: 12, right: 12, zIndex: 5, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 14, height: 44 },
  pickingText: { flex: 1, color: colors.onAccent, fontSize: 14, fontWeight: "600" },
  pickingCancel: { color: colors.onAccent, fontSize: 14, fontWeight: "700", textDecorationLine: "underline" },
});
