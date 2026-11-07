/**
 * Home, as on the desktop: a greeting, six quick tiles (what played last,
 * topped up with mixes), "Made for you", what was added last, top artists and
 * songs played last.
 */
import { useNavigation } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { CloudOff, Settings, Speaker } from "lucide-react-native";
import { useNewerVersion } from "../newVersion";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tinted } from "../color";
import { Card, CARD_SIZE, Chip, Cover, CoverGrid, Shelf } from "../components/ui";
import { splitCredits, type LibAlbum, type Track } from "../shared";
import { useConnection } from "../stores/connection";
import { useSession } from "../stores/session";
import { useArtistPhoto, useCoverColor, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

function greeting(): string {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return T("Good morning");
  if (h >= 12 && h < 18) return T("Good afternoon");
  return T("Good evening");
}

type Filter = "all" | "mixes" | "albums";

function Tile({ art, title, onPress }: { art: React.ReactNode; title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.tile}>
      {art}
      <Text numberOfLines={2} style={styles.tileText}>
        {title}
      </Text>
    </Pressable>
  );
}

function ArtistCard({ name, thumb, plays }: { name: string; thumb: string; plays: number }) {
  const nav = useNavigation<any>();
  const photo = useArtistPhoto(name);
  return (
    <Card
      art={<Cover uri={photo} fallback={thumb} size={CARD_SIZE} radius={CARD_SIZE / 2} />}
      title={name}
      subtitle={`${plays} ${plays === 1 ? T("play") : T("plays")}`}
      onPress={() => nav.navigate("Artist", { name })}
    />
  );
}

export function HomeScreen() {
  const newer = useNewerVersion();
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>("all");
  const loaded = useLibrary((s) => s.loaded);
  const refreshing = useLibrary((s) => s.refreshing);
  const refresh = useLibrary((s) => s.refresh);
  const error = useLibrary((s) => s.error);
  const unreachable = useConnection((s) => s.reach === "offline");
  const hasServer = useSession((s) => !!s.session);
  const offline = unreachable && hasServer;
  const data = useLibrary((s) => s.data);
  const albums = useLibrary((s) => s.albums);
  const artists = useLibrary((s) => s.artists);
  const mixes = useLibrary((s) => s.mixes);
  const playTracks = usePlayer((s) => s.playTracks);
  const color = useCoverColor(usePlayer((s) => s.queue[s.index]?.thumb));

  const { recentAlbums, recentlyAdded, topArtists, recentSongs } = useMemo(() => {
    const lastAt = (a: LibAlbum): number => Math.max(0, ...a.tracks.map((t) => data.counts[t.id]?.lastAt ?? 0));
    const played = albums.filter((a) => lastAt(a) > 0).sort((a, b) => lastAt(b) - lastAt(a));
    const plays = new Map<string, number>();
    for (const t of data.tracks) {
      const n = data.counts[t.id]?.plays ?? 0;
      if (!n) continue;
      // Every credited artist earns the plays, as on the desktop.
      for (const name of splitCredits(t.artist)) plays.set(name.toLowerCase(), (plays.get(name.toLowerCase()) ?? 0) + n);
    }
    return {
      recentAlbums: played.slice(0, 6),
      recentlyAdded: [...albums].sort((a, b) => b.addedAt - a.addedAt).slice(0, 14),
      topArtists: artists
        .filter((a) => plays.has(a.name.toLowerCase()))
        .sort((a, b) => plays.get(b.name.toLowerCase())! - plays.get(a.name.toLowerCase())!)
        .slice(0, 12)
        .map((a) => ({ ...a, plays: plays.get(a.name.toLowerCase())! })),
      recentSongs: data.tracks
        .filter((t) => data.counts[t.id]?.lastAt)
        .sort((a, b) => data.counts[b.id].lastAt - data.counts[a.id].lastAt)
        .slice(0, 14),
    };
  }, [data, albums, artists]);

  const quick = useMemo(() => {
    const tiles = recentAlbums.map((a) => ({
      key: a.key,
      title: a.title,
      art: <Cover uri={a.thumb} size={56} radius={0} />,
      open: () => nav.navigate("Album", { albumKey: a.key }),
    }));
    for (const m of mixes) {
      if (tiles.length >= 6) break;
      tiles.push({
        key: m.id,
        title: m.title,
        art: <CoverGrid tracks={m.tracks} size={56} radius={0} />,
        open: () => nav.navigate("Collection", { kind: "mix", id: m.id }),
      });
    }
    for (const a of recentlyAdded) {
      if (tiles.length >= 6) break;
      if (tiles.some((t) => t.key === a.key)) continue;
      tiles.push({ key: a.key, title: a.title, art: <Cover uri={a.thumb} size={56} radius={0} />, open: () => nav.navigate("Album", { albumKey: a.key }) });
    }
    return tiles;
  }, [recentAlbums, mixes, recentlyAdded, nav]);

  if (!loaded) {
    return (
      <View style={[styles.center, { backgroundColor: colors.base }]}>
        <ActivityIndicator color={colors.ink} />
        <Text style={styles.loading}>{T("Reading your library…")}</Text>
      </View>
    );
  }

  const songCard = (t: Track, i: number) => (
    <Card
      key={t.id}
      art={<Cover uri={t.thumb} size={CARD_SIZE} radius={8} />}
      title={t.title}
      subtitle={t.artist}
      onPress={() => playTracks(recentSongs, i, T("Recently played"))}
    />
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.ink} progressViewOffset={insets.top} />}
    >
      <LinearGradient colors={[tinted(color, 0.16), "rgba(0,0,0,0)"]} style={styles.wash} />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.greeting}>{greeting()}</Text>
        <Pressable onPress={() => nav.navigate("Devices")} accessibilityLabel={T("Devices")} style={styles.headerButton}>
          <Speaker size={23} color={colors.ink} />
        </Pressable>
        <Pressable
          onPress={() => nav.navigate("Settings")}
          accessibilityLabel={newer ? T("Settings — Songsta {version} is out", { version: newer }) : T("Settings")}
          style={styles.headerButton}
        >
          <Settings size={23} color={colors.ink} />
          {!!newer && <View style={styles.newVersionDot} />}
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label={T("All")} active={filter === "all"} onPress={() => setFilter("all")} />
        <Chip label={T("Mixes")} active={filter === "mixes"} onPress={() => setFilter("mixes")} />
        <Chip label={T("Albums")} active={filter === "albums"} onPress={() => setFilter("albums")} />
      </ScrollView>

      {offline && (
        <Pressable onPress={() => nav.navigate("Collection", { kind: "downloads" })} style={styles.offline}>
          <CloudOff size={16} color={colors.dim} />
          <Text style={styles.offlineText}>{T("Your server is out of reach. Downloaded music plays.")}</Text>
        </Pressable>
      )}
      {!!error && !data.tracks.length && <Text style={styles.error}>{error}</Text>}
      {!error && !data.tracks.length && <Text style={styles.empty}>{T("No music on the server yet.")}</Text>}

      {filter === "all" && (
        <View style={styles.tiles}>
          {quick.map((q) => (
            <Tile key={q.key} art={q.art} title={q.title} onPress={q.open} />
          ))}
        </View>
      )}

      {filter !== "albums" && mixes.length > 0 && (
        <Shelf title={T("Made for you")}>
          {mixes.map((m) => (
            <Card
              key={m.id}
              art={<CoverGrid tracks={m.tracks} size={CARD_SIZE} radius={8} />}
              title={m.title}
              subtitle={m.subtitle}
              onPress={() => nav.navigate("Collection", { kind: "mix", id: m.id })}
            />
          ))}
        </Shelf>
      )}

      {filter !== "mixes" && recentlyAdded.length > 0 && (
        <Shelf title={T("Recently added")}>
          {recentlyAdded.map((a) => (
            <Card
              key={a.key}
              art={<Cover uri={a.thumb} size={CARD_SIZE} radius={8} />}
              title={a.title}
              subtitle={`${a.year ? `${a.year} · ` : ""}${a.artist}`}
              onPress={() => nav.navigate("Album", { albumKey: a.key })}
            />
          ))}
        </Shelf>
      )}

      {filter === "all" && topArtists.length > 0 && (
        <Shelf title={T("Your top artists")}>
          {topArtists.map((a) => (
            <ArtistCard key={a.name} name={a.name} thumb={a.thumb} plays={a.plays} />
          ))}
        </Shelf>
      )}

      {filter === "all" && recentSongs.length > 0 && <Shelf title={T("Recently played")}>{recentSongs.map(songCard)}</Shelf>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  loading: { color: colors.dim, fontSize: 14 },
  wash: { position: "absolute", left: 0, right: 0, top: 0, height: 300 },
  header: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8, paddingBottom: 8 },
  greeting: { flex: 1, color: colors.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.7 },
  headerButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  newVersionDot: { position: "absolute", right: 9, bottom: 9, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.base },
  chips: { gap: 8, paddingHorizontal: 16, paddingBottom: 14 },
  error: { color: "#FF9D9D", fontSize: 14, marginHorizontal: 16, marginTop: 12 },
  offline: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 12 },
  offlineText: { flexShrink: 1, color: colors.dim, fontSize: 13 },
  empty: { color: colors.dim, fontSize: 14, marginHorizontal: 16, marginTop: 12 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16 },
  tile: {
    width: "48.7%",
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: 6,
    overflow: "hidden",
    backgroundColor: colors.tile,
  },
  tileText: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: "700", paddingRight: 6 },
});
