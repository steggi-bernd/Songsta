/**
 * A list of songs with a playlist's page: a playlist, Liked Songs, a mix, a
 * genre, an artist's liked songs. The header is the desktop's: the picture full-bleed
 * and melting into the page, the name and the "PLAYLIST • N SONGS" line over
 * its lower edge, round glass controls under them.
 */
import { useNavigation, useRoute } from "@react-navigation/native";
import { PullDownToClose } from "../components/PullDownToClose";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { ChevronLeft, CircleMinus, EllipsisVertical, Image as ImageIcon, ImageOff, Pause, Pencil, Pin, PinOff, Play, Search, Shuffle, Trash2 } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import Player from "../../modules/media3-player";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NameDialog } from "../components/PlaylistSheets";
import { MenuSheet } from "../components/Sheet";
import { DownloadButton, useSongMenu } from "../components/SongMenu";
import { LIKED_LIST, playlistListKey } from "../shared";
import { CoverGrid, picture as pictureSource, SearchField, TrackRow } from "../components/ui";
import { artistTracks, fmtTime, matchesQuery, plural, type Track } from "../shared";
import { sizeLine, useDownloads } from "../stores/downloads";
import { likedSongIds, useArtistPhoto, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { playlistTracks, usePlaylists, type PlaylistTrack } from "../stores/playlists";
import { showDialog } from "../stores/popups";
import { colors, PAGE_END } from "../theme";
import { useLiked } from "./ArtistScreen";
import { T } from "../shared";

type Params = { kind: "playlist"; id: string } | { kind: "liked" } | { kind: "downloads" } | { kind: "local" } | { kind: "mix"; id: string } | { kind: "genre"; key: string } | { kind: "artistLiked"; name: string };

export function CollectionScreen() {
  const nav = useNavigation<any>();
  const params = useRoute<any>().params as Params;
  const insets = useSafeAreaInsets();
  const data = useLibrary((s) => s.data);
  const byId = useLibrary((s) => s.byId);
  const mixes = useLibrary((s) => s.mixes);
  const genres = useLibrary((s) => s.genres);
  const playTracks = usePlayer((s) => s.playTracks);
  const playAll = usePlayer((s) => s.playAll);
  const toggle = usePlayer((s) => s.toggle);
  const playWhenReady = usePlayer((s) => s.playWhenReady);

  const playlistId = params.kind === "playlist" ? params.id : null;
  /** What Your Library counts as played when this list is started (stores/played.ts). */
  const source = params.kind === "playlist" ? `playlist:${params.id}` : params.kind === "mix" ? `mix:${params.id}` : null;
  const playlist = usePlaylists((s) => (playlistId ? s.playlists.find((p) => p.id === playlistId) : undefined));
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const kept = useDownloads((s) => s.kept);
  // What's on its way stands on top, with how far it is.
  const onItsWay = useDownloads((s) => Object.keys(s.loading).join("|"));
  // Deleted here or on another device: nothing left to show.
  useEffect(() => {
    if (playlistId && !playlist && nav.canGoBack()) nav.goBack();
  }, [playlistId, playlist, nav]);

  const artistName = params.kind === "artistLiked" ? params.name : "";
  const artistSongs = useMemo(() => (artistName ? artistTracks(data.tracks, artistName) : []), [artistName, data.tracks]);
  const artistLiked = useLiked(artistSongs);
  const photo = useArtistPhoto(artistName);

  const { title, tracks: shown } = useMemo((): { title: string; tracks: PlaylistTrack[] } => {
    switch (params.kind) {
      case "playlist":
        return { title: playlist?.name ?? T("Playlist"), tracks: playlist ? playlistTracks(playlist) : [] };
      case "liked":
        return { title: T("Liked Songs"), tracks: likedSongIds(data.favorites, byId).map((id) => byId.get(id)).filter((t): t is Track => !!t) };
      case "downloads":
        return {
          title: T("Downloads"),
          tracks: [...onItsWay.split("|"), ...Object.keys(kept)].map((id) => byId.get(id)).filter((t): t is Track => !!t),
        };
      case "local":
        return { title: T("On this phone"), tracks: data.tracks.filter((t) => t.localPath) };
      case "mix": {
        const mix = mixes.find((m) => m.id === params.id);
        return { title: mix?.title ?? T("Mix"), tracks: mix?.tracks ?? [] };
      }
      case "genre": {
        const genre = genres.find((g) => g.key === params.key);
        return { title: genre?.name ?? T("Genre"), tracks: genre?.tracks ?? [] };
      }
      case "artistLiked":
        return { title: T("Liked songs by {name}", { name: params.name }), tracks: artistLiked };
    }
  }, [params, playlist, data.tracks, data.favorites, byId, mixes, genres, artistLiked, kept, onItsWay]);
  // What can play: a playlist's song this library doesn't have stays in the list only.
  const tracks = useMemo(() => shown.filter((t) => !t.missing), [shown]);
  // Looking for one song: it still plays on through the whole list from there.
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const found = useMemo(() => (finding && query.trim() ? shown.filter((t) => matchesQuery(t, query)) : shown), [finding, query, shown]);
  const swipeList = useMemo(() => ({ tracks, name: title }), [tracks, title]);

  // Exactly this list playing: its button pauses, not while an album plays one of its songs.
  const playingHere = usePlayer((s) => s.context === title && tracks.some((t) => t.id === s.queue[s.index]?.id));
  const pause = playingHere && playWhenReady;
  const seconds = tracks.reduce((sum, t) => sum + t.duration, 0);
  const keptBytes = params.kind === "downloads" ? Object.values(kept).reduce((sum, k) => sum + k.bytes, 0) : 0;
  const meta = [params.kind === "downloads" || params.kind === "local" ? T("On this phone") : T("Playlist"), shown.length ? plural(shown.length, T("song"), T("songs")) : "", keptBytes ? sizeLine(keptBytes) : seconds > 0 ? `about ${fmtTime(seconds)}` : ""]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();
  const picture = playlist?.cover ?? photo ?? tracks.find((t) => t.thumb)?.thumb;
  const choosePicture = async (): Promise<void> => {
    if (!playlist) return;
    const cover = await Player.pickImage();
    if (cover) usePlaylists.getState().setCover(playlist.id, cover);
  };

  return (
    <>
<PullDownToClose onClose={() => nav.goBack()}>
      <FlatList
        style={styles.root}
        data={found}
        keyExtractor={(t, i) => `${t.id}-${i}`}
        initialNumToRender={12}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
        ListHeaderComponent={
          <View style={styles.hero}>
            {!!picture && <Image source={pictureSource(picture)} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="disk" transition={200} />}
            <LinearGradient
              colors={["rgba(0,0,0,0.2)", "rgba(0,0,0,0.45)", "rgba(0,0,0,0.9)", colors.base]}
              locations={[0, 0.5, 0.8, 1]}
              style={StyleSheet.absoluteFill}
            />
            <View style={[styles.topRow, { top: insets.top + 2 }]}>
              <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Go back")} style={styles.topButton}>
                <ChevronLeft size={28} color={colors.ink} />
              </Pressable>
              {finding ? (
                <SearchField
                  autoFocus
                  value={query}
                  onChange={setQuery}
                  placeholder={T("Find in this list")}
                  onClose={() => setFinding(false)}
                  style={styles.find}
                />
              ) : (
                <>
                  <View style={styles.topGap} />
                  <Pressable onPress={() => setFinding(true)} accessibilityLabel={T("Find a song in this list")} style={styles.topButton}>
                    <Search size={22} color={colors.ink} />
                  </Pressable>
                  {!!playlist && (
                    <Pressable onPress={() => setMenu(true)} accessibilityLabel={T("More options")} style={styles.topButton}>
                      <EllipsisVertical size={22} color={colors.ink} />
                    </Pressable>
                  )}
                </>
              )}
            </View>
            <Text numberOfLines={2} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.meta}>{meta}</Text>
            <View style={styles.controls}>
              {params.kind !== "downloads" && tracks.some((t) => !t.localPath) && <DownloadButton tracks={tracks} list={params.kind === "playlist" ? playlistListKey(params.id) : params.kind === "liked" ? LIKED_LIST : undefined} size={20} style={styles.roundWide} />}
              <Pressable
                accessibilityLabel={T("Shuffle")}
                onPress={() => playAll(tracks, title, true, source)}
                style={styles.round}
              >
                <Shuffle size={18} color={colors.ink} />
              </Pressable>
              <Pressable onPress={() => (playingHere ? toggle() : playAll(tracks, title, undefined, source))} style={styles.pill}>
                {pause ? <Pause size={18} color={colors.ink} fill={colors.ink} /> : <Play size={18} color={colors.ink} fill={colors.ink} />}
                <Text style={styles.pillText}>{pause ? T("Pause") : T("Play")}</Text>
              </Pressable>
            </View>
          </View>
        }
        ListEmptyComponent={<Text style={styles.empty}>{query.trim() ? T("Nothing in this list by that name.") : T("No songs here yet.")}</Text>}
        renderItem={({ item }) => (
          <TrackRow
            track={item}
            list={swipeList}
            missing={item.missing}
            onLongPress={
              playlist
                ? () =>
                    useSongMenu.getState().open(item, {
                      plain: item.missing,
                      extras: [{ label: T("Remove from this playlist"), Icon: CircleMinus, run: () => usePlaylists.getState().removeTrack(playlist.id, item.entryId ?? item.id) }],
                    })
                : undefined
            }
            onPress={() => playTracks(tracks, Math.max(0, tracks.indexOf(item)), title, false, source)}
          />
        )}
      />
      </PullDownToClose>
      {!!playlist && (
      <>
        <MenuSheet
          visible={menu}
          art={<CoverGrid tracks={tracks} size={46} cover={playlist.cover} />}
          title={playlist.name}
          subtitle={plural(tracks.length, T("song"), T("songs"))}
          onClose={() => setMenu(false)}
          rows={[
            { label: playlist.pinned ? T("Unpin from Your Library") : T("Pin to the top of Your Library"), Icon: playlist.pinned ? PinOff : Pin, run: () => usePlaylists.getState().togglePin(playlist.id) },
            { label: T("Rename"), Icon: Pencil, run: () => setRenaming(true) },
            { label: playlist.cover ? T("Change picture…") : T("Choose a picture…"), Icon: ImageIcon, run: () => void choosePicture() },
            ...(playlist.cover ? [{ label: T("Remove picture"), Icon: ImageOff, run: () => usePlaylists.getState().setCover(playlist.id, null) }] : []),
            {
              label: T("Delete"),
              Icon: Trash2,
              danger: true,
              run: () =>
                showDialog(T("Delete “{name}”?", { name: playlist.name }), T("It goes from all your devices."), [
                  { text: T("Cancel"), style: "cancel" },
                  { text: T("Delete"), style: "destructive", onPress: () => usePlaylists.getState().remove(playlist.id) },
                ]),
            },
          ]}
        />
        <NameDialog
          visible={renaming}
          title={T("Rename playlist")}
          placeholder={T("Name")}
          initial={playlist.name}
          action={T("Save")}
          onCancel={() => setRenaming(false)}
          onDone={(name) => {
            usePlaylists.getState().rename(playlist.id, name);
            setRenaming(false);
          }}
        />
    </>
    )}
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  hero: { alignItems: "center", paddingTop: 176, paddingBottom: 14, paddingHorizontal: 20, overflow: "hidden" },
  topRow: { position: "absolute", left: 6, right: 6, flexDirection: "row", alignItems: "center", gap: 2 },
  topButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  topGap: { flex: 1 },
  title: { color: colors.ink, fontSize: 28, fontWeight: "800", letterSpacing: -0.8, lineHeight: 34, textAlign: "center" },
  meta: { color: "rgba(255,255,255,0.78)", fontSize: 11, fontWeight: "600", letterSpacing: 1.5, marginTop: 6, textAlign: "center" },
  controls: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  roundWide: {
    minWidth: 44,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 22,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  pillText: { color: colors.ink, fontSize: 14.5, fontWeight: "600" },
  find: { flex: 1, height: 44, marginRight: 6, backgroundColor: "rgba(0,0,0,0.55)" },
  empty: { color: colors.dim, fontSize: 14, textAlign: "center", marginTop: 24 },
});
