/** An album: its cover over a wash of its colour, the facts, play and shuffle, its songs in order. */
import { useNavigation, useRoute } from "@react-navigation/native";
import { PullDownToClose } from "../components/PullDownToClose";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, EllipsisVertical, Pause, Play, Shuffle } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tinted } from "../color";
import { AlbumMenu } from "../components/AlbumEditSheets";
import { DownloadButton } from "../components/SongMenu";
import { albumListKey } from "../shared";
import { Cover, TrackRow } from "../components/ui";
import { describePlayback, formatLine, fmtLength, plural, RELEASE_LABEL } from "../shared";
import { useArtistPhoto, useCoverColor, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

export function AlbumScreen() {
  const nav = useNavigation<any>();
  const { params } = useRoute<any>();
  const insets = useSafeAreaInsets();
  const album = useLibrary((s) => s.albums.find((a) => a.key === params?.albumKey) ?? null);
  const color = useCoverColor(album?.thumb);
  const photo = useArtistPhoto(album?.artist ?? "");
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playWhenReady = usePlayer((s) => s.playWhenReady);
  const playingHere = usePlayer((s) => !!album && album.tracks.some((t) => t.id === s.queue[s.index]?.id));
  const format = useMemo(() => {
    const first = album?.tracks[0];
    return first ? describePlayback(first) : null;
  }, [album]);
  // Name and picture, artists, merging what the tags split: as the computer's album editor.
  const [menu, setMenu] = useState(false);

  if (!album) return <View style={styles.root} />;
  const pause = playingHere && playWhenReady;

  return (
    <>
<PullDownToClose onClose={() => nav.goBack()}>
    <FlatList
      style={styles.root}
      data={album.tracks}
      keyExtractor={(t) => t.id}
      contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
      ListHeaderComponent={
        <View>
          <LinearGradient colors={[tinted(color, 0.24), "rgba(0,0,0,0)"]} style={styles.wash} />
          <View style={[styles.top, { paddingTop: insets.top + 2 }]}>
            <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Go back")} style={styles.back}>
              <ChevronLeft size={28} color={colors.ink} />
            </Pressable>
            <Pressable onPress={() => setMenu(true)} accessibilityLabel={T("Edit album")} style={[styles.back, styles.more]}>
              <EllipsisVertical size={22} color={colors.ink} />
            </Pressable>
          </View>
          <View style={styles.coverBox}>
            <Cover uri={album.thumb} size={232} radius={6} />
          </View>
          <View style={styles.facts}>
            <Text numberOfLines={2} style={styles.title}>
              {album.title}
            </Text>
            <Pressable onPress={() => nav.navigate("Artist", { name: album.artist })} style={styles.artist}>
              <Cover uri={photo} fallback={album.thumb} size={24} radius={12} />
              <Text numberOfLines={1} style={styles.artistName}>
                {album.artist}
              </Text>
            </Pressable>
            <View style={styles.line}>
              <Text style={styles.lineText}>
                {RELEASE_LABEL[album.kind]}
                {album.year ? ` · ${album.year}` : ""} · {plural(album.tracks.length, T("song"), T("songs"))}, {fmtLength(album.duration)}
              </Text>
            </View>
            {!!format && (
              <View style={styles.line}>
                {format.hiRes && (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>{T("HI-RES")}</Text>
                  </View>
                )}
                <Text style={styles.lineText}>{formatLine(format)}</Text>
              </View>
            )}
          </View>
          <View style={styles.actions}>
            {album.tracks.some((t) => !t.localPath) ? <DownloadButton tracks={album.tracks} list={albumListKey(album.key)} style={styles.download} /> : <View style={styles.download} />}
            <Pressable
              accessibilityLabel={T("Shuffle")}
              onPress={() => usePlayer.getState().playAll(album.tracks, album.title, true, `album:${album.key}`)}
              style={styles.shuffle}
            >
              <Shuffle size={24} color={colors.ink} />
            </Pressable>
            <Pressable
              accessibilityLabel={pause ? T("Pause") : T("Play")}
              onPress={() => (playingHere ? toggle() : usePlayer.getState().playAll(album.tracks, album.title, undefined, `album:${album.key}`))}
              style={styles.play}
            >
              {pause ? <Pause size={24} color={colors.base} fill={colors.base} /> : <Play size={24} color={colors.base} fill={colors.base} />}
            </Pressable>
          </View>
        </View>
      }
      renderItem={({ item, index }) => (
        <TrackRow track={item} showCover={false} list={{ tracks: album.tracks, name: album.title }} onPress={() => playTracks(album.tracks, index, album.title, false, `album:${album.key}`)} />
      )}
    />
    </PullDownToClose>
    <AlbumMenu album={album} visible={menu} onClose={() => setMenu(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  wash: { position: "absolute", left: 0, right: 0, top: 0, height: 420 },
  top: { flexDirection: "row", paddingHorizontal: 6 },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  more: { marginLeft: "auto" },
  coverBox: { alignItems: "center", paddingTop: 2, paddingBottom: 18 },
  facts: { paddingHorizontal: 16 },
  title: { color: colors.ink, fontSize: 24, fontWeight: "800", letterSpacing: -0.6 },
  artist: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  artistName: { flexShrink: 1, color: colors.ink, fontSize: 13.5, fontWeight: "600" },
  line: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 7 },
  lineText: { color: colors.soft, fontSize: 13 },
  badge: { backgroundColor: colors.hiRes, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: colors.onHiRes, fontSize: 10.5, fontWeight: "700", letterSpacing: 0.4 },
  actions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 6, paddingHorizontal: 16, paddingTop: 2, paddingBottom: 8 },
  download: { marginRight: "auto", marginLeft: -10 },
  shuffle: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  play: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
});
