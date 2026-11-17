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
import { artistAlbums, artistTracks, byPlays, fmtMinutes, likedAmong, plural, RELEASE_LABEL, type LibAlbum, type Track } from "../shared";
import { likedSongIds, useArtistPhoto, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { sharedSoundOf } from "../stores/soundShare";
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
  const tracks = useLibrary((s) => s.tracks);
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
  // Your numbers with them, and the genre most of their songs are filed under (its page a tap away).
  const genres = useLibrary((s) => s.genres);
  const yours = useMemo(() => {
    let plays = 0;
    let heard = 0;
    for (const t of songs) {
      const n = counts[t.id]?.plays ?? 0;
      plays += n;
      heard += n * (t.duration || 0);
    }
    const ids = new Set(songs.map((t) => t.id));
    let genre: { key: string; name: string } | null = null;
    let most = 0;
    for (const g of genres) {
      const n = g.tracks.reduce((sum, t) => sum + (ids.has(t.id) ? 1 : 0), 0);
      if (n > most) {
        most = n;
        genre = { key: g.key, name: g.name };
      }
    }
    return { plays, heard, genre };
  }, [songs, counts, genres]);
  const seed = top.find((t) => sharedSoundOf(t)) ?? songs.find((t) => sharedSoundOf(t));

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
        <Text numberOfLines={1} style={styles.counts}>
          {yours.plays > 0
            ? `${plural(yours.plays, T("play"), T("plays"))} · ${T("{time} heard by you", { time: fmtMinutes(yours.heard) })}`
            : T("{count} · {count2} in your library", { count: plural(songs.length, T("song"), T("songs")), count2: plural(own.length, T("release"), T("releases")) })}
        </Text>
      </View>

      <View style={styles.actions}>
        <View style={styles.pills}>
          {!!seed && (
            <Pressable onPress={() => nav.navigate("SoundsLike", { id: seed.id })} style={styles.pill}>
              <Text style={styles.pillText}>{T("Sounds like")}</Text>
            </Pressable>
          )}
          {!!yours.genre && (
            <Pressable onPress={() => nav.navigate("Collection", { kind: "genre", key: yours.genre?.key })} style={styles.pill}>
              <Text numberOfLines={1} style={styles.pillText}>
                {yours.genre.name}
              </Text>
            </Pressable>
          )}
        </View>
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

      <Text style={styles.heading}>{yours.plays > 0 ? T("Popular with you") : T("Popular")}</Text>
      {top.map((t, i) => {
        const plays = counts[t.id]?.plays ?? 0;
        return (
          <TrackRow
            key={t.id}
            track={t}
            number={i + 1}
            subtitle={plays ? `${plays}× · ${t.album || t.artist}` : t.album || t.artist}
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
  banner: { height: 360, backgroundColor: colors.panel, justifyContent: "flex-end" },
  back: { position: "absolute", left: 6, width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  name: { color: colors.ink, fontSize: 54, fontWeight: "900", letterSpacing: -2.4, lineHeight: 56, marginHorizontal: 16, marginBottom: 6 },
  nameLong: { fontSize: 36, lineHeight: 40, letterSpacing: -1.2 },
  counts: { color: "#E4E4E7", fontSize: 13, marginHorizontal: 16, marginBottom: 16 },
  actions: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  pills: { flex: 1, minWidth: 0, flexDirection: "row", gap: 8 },
  pill: { height: 32, paddingHorizontal: 13, borderRadius: 16, justifyContent: "center", backgroundColor: colors.chip, flexShrink: 1 },
  pillText: { color: colors.ink, fontSize: 13, fontWeight: "700" },
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
