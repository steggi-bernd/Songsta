/**
 * An artist: the photo with the name on it, play and shuffle, a strip leading
 * to the songs of theirs you've liked, what you play most, their releases.
 */
import { useNavigation, useRoute } from "@react-navigation/native";
import { PullDownToClose } from "../components/PullDownToClose";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, ChevronRight, Heart, Pause, Play, Shuffle } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Card, CARD_SIZE, Cover, Shelf, TrackRow, picture } from "../components/ui";
import { artistAlbums, artistTracks, byPlays, likedAmong, plural, RELEASE_LABEL, type LibAlbum, type Track } from "../shared";
import { likedSongIds, useArtistPhoto, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

/** The liked songs among these, the latest like first. One server: a song's id is its only copy. */
export function useLiked(songs: Track[]): Track[] {
  const favorites = useLibrary((s) => s.data.favorites);
  const byId = useLibrary((s) => s.byId);
  return useMemo(() => {
    const liked = likedSongIds(favorites, byId).map((id) => byId.get(id)).filter((t): t is Track => !!t);
    return likedAmong(songs, liked, (id) => id);
  }, [songs, favorites, byId]);
}

export function ArtistScreen() {
  const nav = useNavigation<any>();
  const { params } = useRoute<any>();
  const name: string = params?.name ?? "";
  const insets = useSafeAreaInsets();
  const tracks = useLibrary((s) => s.data.tracks);
  const albums = useLibrary((s) => s.albums);
  const counts = useLibrary((s) => s.data.counts);
  const photo = useArtistPhoto(name);
  const [photoFailed, setPhotoFailed] = useState(false);
  const playTracks = usePlayer((s) => s.playTracks);
  const toggle = usePlayer((s) => s.toggle);
  const playWhenReady = usePlayer((s) => s.playWhenReady);

  const songs = useMemo(() => artistTracks(tracks, name), [tracks, name]);
  const popular = useMemo(() => byPlays(songs, counts), [songs, counts]);
  const liked = useLiked(songs);
  const { own, appearsOn } = useMemo(() => artistAlbums(albums, name), [albums, name]);
  const playingHere = usePlayer((s) => songs.some((t) => t.id === s.queue[s.index]?.id));
  const top = popular.slice(0, 5);
  const banner = (!photoFailed && photo) || own[0]?.thumb || songs[0]?.thumb;
  const pause = playingHere && playWhenReady;

  const releaseCard = (a: LibAlbum, subtitle: string) => (
    <Card
      key={a.key}
      art={<Cover uri={a.thumb} size={CARD_SIZE} radius={8} />}
      title={a.title}
      subtitle={subtitle}
      onPress={() => nav.navigate("Album", { albumKey: a.key })}
    />
  );

  return (
<PullDownToClose onClose={() => nav.goBack()}>
    <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}>
      <View style={styles.banner}>
        {!!banner && (
          <Image
            source={picture(banner)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            contentPosition="top center"
            cachePolicy="disk"
            transition={200}
            onError={() => setPhotoFailed(true)}
          />
        )}
        <LinearGradient colors={["rgba(0,0,0,0.12)", "rgba(0,0,0,0.18)", "rgba(0,0,0,0.82)"]} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
        <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Go back")} style={[styles.back, { top: insets.top + 2 }]}>
          <ChevronLeft size={28} color={colors.ink} />
        </Pressable>
        <Text numberOfLines={2} style={[styles.name, name.length > 18 && styles.nameLong]}>
          {name}
        </Text>
      </View>

      <View style={styles.actions}>
        <Text numberOfLines={1} style={styles.counts}>
          {T("{count} · {count2} in your library", { count: plural(songs.length, T("song"), T("songs")), count2: plural(own.length, T("release"), T("releases")) })}</Text>
        <Pressable
          accessibilityLabel={T("Shuffle")}
          onPress={() => usePlayer.getState().playAll(songs, name, true, `artist:${name.toLowerCase()}`)}
          style={styles.shuffle}
        >
          <Shuffle size={24} color={colors.ink} />
        </Pressable>
        <Pressable
          accessibilityLabel={pause ? T("Pause") : T("Play {name}", { name })}
          onPress={() => (playingHere ? toggle() : usePlayer.getState().playAll(popular, name, undefined, `artist:${name.toLowerCase()}`))}
          style={styles.play}
        >
          {pause ? <Pause size={24} color={colors.base} fill={colors.base} /> : <Play size={24} color={colors.base} fill={colors.base} />}
        </Pressable>
      </View>

      {liked.length > 0 && (
        <Pressable onPress={() => nav.navigate("Collection", { kind: "artistLiked", name })} style={styles.strip}>
          <LinearGradient colors={[colors.accent, "#3F3463"]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.stripCover}>
            <Heart size={20} color={colors.ink} fill={colors.ink} />
          </LinearGradient>
          <View style={styles.stripText}>
            <Text style={styles.stripTitle}>{T("Liked songs")}</Text>
            <Text numberOfLines={1} style={styles.stripSub}>
              {T("{count} by {name}", { count: plural(liked.length, T("song"), T("songs")), name })}
            </Text>
          </View>
          <ChevronRight size={20} color={colors.soft} />
        </Pressable>
      )}

      <Text style={styles.heading}>{T("Popular")}</Text>
      {top.map((t, i) => {
        const plays = counts[t.id]?.plays ?? 0;
        return (
          <TrackRow
            key={t.id}
            track={t}
            number={i + 1}
            subtitle={plays ? plural(plays, T("play"), T("plays")) : t.artist}
            list={{ tracks: popular, name }}
            onPress={() => playTracks(popular, i, name, false, `artist:${name.toLowerCase()}`)}
          />
        );
      })}

      {own.length > 0 && (
        <Shelf title={T("Discography")}>
          {own.map((a) => releaseCard(a, `${a.year ? `${a.year} · ` : ""}${RELEASE_LABEL[a.kind]}`))}
        </Shelf>
      )}
      {appearsOn.length > 0 && (
        <Shelf title={T("Appears on")}>
          {appearsOn.map((a) => releaseCard(a, `${a.year ? `${a.year} · ` : ""}${a.artist}`))}
        </Shelf>
      )}
    </ScrollView>
</PullDownToClose>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  banner: { height: 300, backgroundColor: colors.panel, justifyContent: "flex-end" },
  back: { position: "absolute", left: 6, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  name: { color: colors.ink, fontSize: 44, fontWeight: "800", letterSpacing: -1.6, lineHeight: 48, marginHorizontal: 16, marginBottom: 14 },
  nameLong: { fontSize: 32, lineHeight: 36, letterSpacing: -1 },
  actions: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  counts: { flex: 1, minWidth: 0, color: colors.soft, fontSize: 13 },
  shuffle: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginRight: 6 },
  play: { width: 54, height: 54, borderRadius: 27, backgroundColor: colors.ink, alignItems: "center", justifyContent: "center" },
  heading: { color: colors.ink, fontSize: 21, fontWeight: "700", letterSpacing: -0.3, marginHorizontal: 16, marginTop: 4, marginBottom: 6 },
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 64,
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 16,
    paddingLeft: 8,
    paddingRight: 10,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  stripCover: { width: 48, height: 48, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  stripText: { flex: 1, minWidth: 0 },
  stripTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  stripSub: { color: colors.dim, fontSize: 13, marginTop: 3 },
});
