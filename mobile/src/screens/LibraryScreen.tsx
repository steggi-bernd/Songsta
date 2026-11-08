/**
 * Your Library: Liked Songs on top, the rest by when it last played or was
 * made. The playlists are the same ones as on the desktop (stores/playlists.ts);
 * the mixes stand in the list as playlists do.
 */
import { useNavigation } from "@react-navigation/native";
import { ArrowUpDown, CircleArrowDown, FolderOpen, Heart, Pin, PinOff, Plus } from "lucide-react-native";
import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NameDialog } from "../components/PlaylistSheets";
import { MenuSheet } from "../components/Sheet";
import { glideList, PullRow } from "../components/SwipeRow";
import { Chip, Cover, CoverGrid, EqBars } from "../components/ui";
import { plural, type LibAlbum, type Track } from "../shared";
import { sizeLine, useDownloads } from "../stores/downloads";
import { likedSongIds, useArtistPhoto, useLibrary } from "../stores/library";
import { usePlayed } from "../stores/played";
import { usePlayer } from "../stores/player";
import { playlistTracks, usePlaylists } from "../stores/playlists";
import { toast } from "../stores/popups";
import { feel, useSettings } from "../stores/settings";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

type Filter = "playlists" | "albums" | "artists" | null;

type Row =
  | { kind: "liked"; key: string; count: number }
  | { kind: "downloads"; key: string; line: string }
  | { kind: "local"; key: string; line: string }
  | { kind: "playlist"; key: string; title: string; subtitle: string; tracks: Track[]; lastAt: number; cover?: string }
  | { kind: "mix"; key: string; id: string; title: string; subtitle: string; tracks: Track[]; lastAt: number }
  | { kind: "album"; key: string; album: LibAlbum; lastAt: number }
  | { kind: "artist"; key: string; name: string; thumb: string; lastAt: number };

/** How something that isn't a playlist is known among the pins. */
const pinKey = (r: Row): string => (r.kind === "album" ? `album:${r.key}` : r.kind === "mix" ? `mix:${r.id}` : r.kind === "artist" ? `artist:${r.name}` : "");

const togglePin = (r: Row): void => {
  glideList();
  if (r.kind === "playlist") usePlaylists.getState().togglePin(r.key);
  else useSettings.getState().togglePin(pinKey(r));
};

const nameOf = (r: Row): string | undefined => (r.kind === "playlist" || r.kind === "mix" ? r.title : r.kind === "album" ? r.album.title : r.kind === "artist" ? r.name : undefined);

function SubLine({ pinned, text }: { pinned: boolean; text: string }) {
  return (
    <View style={styles.pinned}>
      {pinned && <Pin size={12} color={colors.accent} fill={colors.accent} />}
      <Text numberOfLines={1} style={[styles.rowSub, styles.subText]}>
        {text}
      </Text>
    </View>
  );
}

function ArtistArt({ name, thumb }: { name: string; thumb: string }) {
  const photo = useArtistPhoto(name);
  return <Cover uri={photo} fallback={thumb} size={56} radius={28} />;
}

export function LibraryScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>(null);
  const [naming, setNaming] = useState(false);
  const [holding, setHolding] = useState<Row | null>(null);
  const hold = (row: Row): void => {
    feel("press");
    setHolding(row);
  };
  const pins = useSettings((s) => s.pins);
  const playlists = usePlaylists((s) => s.playlists);
  const data = useLibrary((s) => s.data);
  const byId = useLibrary((s) => s.byId);
  const albums = useLibrary((s) => s.albums);
  const artists = useLibrary((s) => s.artists);
  const mixes = useLibrary((s) => s.mixes);
  const playingAlbum = usePlayer((s) => s.queue[s.index]?.albumId);
  const kept = useDownloads((s) => s.kept);
  const played = usePlayed((s) => s.at);
  const loadingCount = useDownloads((s) => Object.values(s.loading).filter((song) => !song.failed).length);
  const wifiCount = useDownloads((s) => Object.values(s.loading).filter((song) => song.wantsWifi).length);

  const isPinned = (r: Row): boolean => {
    if (r.kind === "playlist") return !!playlists.find((p) => p.id === r.key)?.pinned;
    return pins.includes(pinKey(r));
  };

  const rows = useMemo<Row[]>(() => {
    // What was started as a whole (stores/played.ts): a song from a playlist doesn't make its album or its artist recent.
    const playedAt = (key: string): number => played[key] ?? 0;
    const rest: Row[] = [];
    if (filter !== "albums" && filter !== "artists") {
      for (const p of playlists) {
        const tracks = playlistTracks(p);
        rest.push({
          kind: "playlist",
          key: p.id,
          title: p.name,
          subtitle: T("Playlist · {count}", { count: plural(tracks.length, T("song"), T("songs")) }),
          tracks,
          cover: p.cover,
          // A new one stands on top, as what somebody just did.
          lastAt: Math.max(p.createdAt, playedAt(`playlist:${p.id}`)),
        });
      }
      for (const m of mixes) rest.push({ kind: "mix", key: m.id, id: m.id, title: m.title, subtitle: T("Mix · {count}", { count: plural(m.tracks.length, T("song"), T("songs")) }), tracks: m.tracks, lastAt: playedAt(`mix:${m.id}`) });
    }
    if (filter !== "playlists" && filter !== "artists") {
      for (const album of albums) rest.push({ kind: "album", key: album.key, album, lastAt: playedAt(`album:${album.key}`) });
    }
    if (filter !== "playlists" && filter !== "albums") {
      for (const a of artists) rest.push({ kind: "artist", key: a.name, name: a.name, thumb: a.thumb, lastAt: playedAt(`artist:${a.name.toLowerCase()}`) });
    }
    // Stable: what never played keeps its order behind the rest. What's pinned stands above it all.
    const lastAt = (r: Row): number => (r.kind === "liked" || r.kind === "downloads" || r.kind === "local" ? 0 : r.lastAt);
    rest.sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || lastAt(b) - lastAt(a));
    const liked: Row[] = filter === "albums" || filter === "artists" ? [] : [{ kind: "liked", key: "liked", count: likedSongIds(data.favorites, byId).length }];
    const keptSongs = Object.values(kept);
    const downloads: Row[] =
      liked.length && (keptSongs.length || loadingCount)
        ? [
            {
              kind: "downloads",
              key: "downloads",
              line: wifiCount ? T("{count} for Wi-Fi", { count: plural(wifiCount, T("song waits"), T("songs wait")) }) : loadingCount ? T("Downloading {count}…", { count: plural(loadingCount, T("song"), T("songs")) }) : `${plural(keptSongs.length, "song", "songs")} · ${sizeLine(keptSongs.reduce((sum, k) => sum + k.bytes, 0))}`,
            },
          ]
        : [];
    const onPhone = liked.length ? data.tracks.filter((t) => t.localPath).length : 0;
    const local: Row[] = onPhone ? [{ kind: "local", key: "local", line: T("Folders on this phone · {count}", { count: plural(onPhone, T("song"), T("songs")) }) }] : [];
    return [...liked, ...local, ...downloads, ...rest];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, albums, artists, mixes, playlists, filter, kept, loadingCount, wifiCount, pins, played]);

  const chip = (label: string, value: Exclude<Filter, null>) => (
    <Chip label={label} active={filter === value} onPress={() => setFilter(filter === value ? null : value)} />
  );

  /** Pulled to the right it goes to the top, or back among the others. */
  const pulled = (row: Row, content: ReactNode) => {
    const pinned = isPinned(row);
    return (
      <PullRow
        label={pinned ? T("Unpin") : T("Pin")}
        Icon={pinned ? PinOff : Pin}
        onPull={() => {
          togglePin(row);
          toast(pinned ? T("Unpinned") : T("Pinned to the top"));
        }}
      >
        {content}
      </PullRow>
    );
  };

  const renderRow = ({ item }: { item: Row }) => {
    switch (item.kind) {
      case "liked":
        return (
          <Pressable style={styles.row} onPress={() => nav.navigate("Collection", { kind: "liked" })}>
            <LinearGradient colors={[colors.accent, "#3F3463"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.liked}>
              <Heart size={24} color={colors.ink} fill={colors.ink} />
            </LinearGradient>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{T("Liked Songs")}</Text>
              <View style={styles.pinned}>
                <Pin size={12} color={colors.accent} fill={colors.accent} />
                <Text style={styles.rowSub}>{T("Playlist · {count}", { count: plural(item.count, T("song"), T("songs")) })}</Text>
              </View>
            </View>
          </Pressable>
        );
      case "downloads":
        return (
          <Pressable style={styles.row} onPress={() => nav.navigate("Collection", { kind: "downloads" })}>
            <View style={styles.downloads}>
              <CircleArrowDown size={26} color={colors.accent} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{T("Downloads")}</Text>
              <Text style={styles.rowSub}>{item.line}</Text>
            </View>
          </Pressable>
        );
      case "local":
        return (
          <Pressable style={styles.row} onPress={() => nav.navigate("Collection", { kind: "local" })}>
            <View style={styles.downloads}>
              <FolderOpen size={26} color={colors.accent} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{T("On this phone")}</Text>
              <Text style={styles.rowSub}>{item.line}</Text>
            </View>
          </Pressable>
        );
      case "playlist":
        return pulled(
          item,
          <Pressable style={styles.row} onLongPress={() => hold(item)} onPress={() => nav.navigate("Collection", { kind: "playlist", id: item.key })}>
            <CoverGrid tracks={item.tracks} size={56} cover={item.cover} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.title}
              </Text>
              <SubLine pinned={isPinned(item)} text={item.subtitle} />
            </View>
          </Pressable>
        );
      case "mix":
        return pulled(
          item,
          <Pressable style={styles.row} onLongPress={() => hold(item)} onPress={() => nav.navigate("Collection", { kind: "mix", id: item.id })}>
            <CoverGrid tracks={item.tracks} size={56} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.title}
              </Text>
              <SubLine pinned={isPinned(item)} text={item.subtitle} />
            </View>
          </Pressable>
        );
      case "album": {
        const playing = playingAlbum === item.album.route;
        return pulled(
          item,
          <Pressable style={styles.row} onLongPress={() => hold(item)} onPress={() => nav.navigate("Album", { albumKey: item.album.key })}>
            <Cover uri={item.album.thumb} size={56} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.rowTitle, playing && { color: colors.accent }]}>
                {item.album.title}
              </Text>
              <SubLine pinned={isPinned(item)} text={T("Album · {artist}", { artist: item.album.artist })} />
            </View>
            {playing && <EqBars />}
          </Pressable>
        );
      }
      case "artist":
        return pulled(
          item,
          <Pressable style={styles.row} onLongPress={() => hold(item)} onPress={() => nav.navigate("Artist", { name: item.name })}>
            <ArtistArt name={item.name} thumb={item.thumb} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.name}
              </Text>
              <SubLine pinned={isPinned(item)} text={T("Artist")} />
            </View>
          </Pressable>
        );
    }
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 14 }]}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{T("Your Library")}</Text>
        <Pressable onPress={() => setNaming(true)} accessibilityLabel={T("New playlist")} style={styles.plus}>
          <Plus size={26} color={colors.ink} />
        </Pressable>
      </View>
      <View style={styles.chips}>
        {chip(T("Playlists"), "playlists")}
        {chip(T("Albums"), "albums")}
        {chip(T("Artists"), "artists")}
      </View>
      <View style={styles.sort}>
        <ArrowUpDown size={16} color={colors.ink} />
        <Text style={styles.sortText}>{T("Recently played")}</Text>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.kind}:${r.key}`}
        renderItem={renderRow}
        initialNumToRender={12}
        contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
      />
      <MenuSheet
        visible={!!holding}
        title={holding ? nameOf(holding) : undefined}
        onClose={() => setHolding(null)}
        rows={
          holding
            ? [
                {
                  label: isPinned(holding) ? T("Unpin") : T("Pin to the top"),
                  Icon: isPinned(holding) ? PinOff : Pin,
                  run: () => togglePin(holding),
                },
              ]
            : []
        }
      />
      <NameDialog
        visible={naming}
        title={T("New playlist")}
        placeholder={T("Name")}
        action={T("Create")}
        onCancel={() => setNaming(false)}
        onDone={(name) => {
          setNaming(false);
          nav.navigate("Collection", { kind: "playlist", id: usePlaylists.getState().create(name) });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12, paddingLeft: 16, paddingRight: 6 },
  title: { color: colors.ink, fontSize: 26, fontWeight: "800", letterSpacing: -0.7 },
  plus: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  chips: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  sort: { flexDirection: "row", alignItems: "center", gap: 8, height: 36, paddingHorizontal: 16 },
  sortText: { color: colors.ink, fontSize: 13, fontWeight: "500" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 68, paddingHorizontal: 16 },
  liked: { width: 56, height: 56, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  downloads: { width: 56, height: 56, borderRadius: 4, alignItems: "center", justifyContent: "center", backgroundColor: colors.panel },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.dim, fontSize: 13, marginTop: 3 },
  pinned: { flexDirection: "row", alignItems: "center", gap: 5 },
  subText: { flexShrink: 1 },
});
