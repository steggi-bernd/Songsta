/**
 * What the computer's album editor does, on the phone: an album's name and picture, its artists,
 * the albums its tags split it into merged back into one, and songs whose tags name no album put
 * on one. Everything stays in Songsta (stores/albumEdits.ts) and goes to the other devices; the
 * files and the server keep their tags.
 */
import { Combine, Image as ImageIcon, ImageOff, Pencil, Plus, RotateCcw, Split, Users, X } from "lucide-react-native";
import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import Player from "../../modules/media3-player";
import {
  baseTitle,
  creditLine,
  foldTag,
  leadArtist,
  libraryAlbumKey,
  plural,
  RELEASE_LABEL,
  resolveAlbumKey,
  splitCredits,
  T,
  type LibAlbum,
  type SongEdit,
  type Track,
} from "../shared";
import { useAlbumEdits, usePutOnAlbum } from "../stores/albumEdits";
import { useLibrary } from "../stores/library";
import { toast } from "../stores/popups";
import { colors } from "../theme";
import { NameDialog } from "./PlaylistSheets";
import { MenuSheet, SheetFrame, SheetHead, type SheetRow } from "./Sheet";
import { Cover, SearchField } from "./ui";

/** An album's songs put on it by hand. */
const handPut = (album: LibAlbum, songs: Record<string, SongEdit>): Track[] => album.tracks.filter((t) => !!songs[t.id]);

/** Albums shown as part of this one, by their own key, with the name their songs carry. */
function partsOf(album: LibAlbum, mergedInto: Record<string, string>): { key: string; title: string; artist: string; count: number }[] {
  return Object.keys(mergedInto)
    .filter((k) => k !== album.key && resolveAlbumKey(k, mergedInto) === album.key)
    .map((k) => {
      const songs = album.tracks.filter((t) => libraryAlbumKey(t) === k);
      return { key: k, title: songs[0]?.albumTag ?? songs[0]?.album ?? k.split("|")[1] ?? k, artist: songs[0]?.albumArtist || songs[0]?.artist || "", count: songs.length };
    });
}

/** The album's menu on its page: everything the computer's album editor offers, a row each. */
export function AlbumMenu({ album, visible, onClose }: { album: LibAlbum; visible: boolean; onClose: () => void }) {
  const renamed = useAlbumEdits((s) => !!s.titles[album.key]);
  const pictured = useAlbumEdits((s) => !!s.covers[album.key]);
  const mergedInto = useAlbumEdits((s) => s.mergedInto);
  const songs = useAlbumEdits((s) => s.songs);
  const [renaming, setRenaming] = useState(false);
  const [sheet, setSheet] = useState<"artists" | "merge" | null>(null);
  const parts = useMemo(() => partsOf(album, mergedInto), [album, mergedInto]);
  const putOn = useMemo(() => handPut(album, songs), [album, songs]);

  const choosePicture = async (): Promise<void> => {
    const picture = await Player.pickImage().catch(() => null);
    if (!picture) return;
    useAlbumEdits.getState().setCover(album.key, picture);
    if (!useAlbumEdits.getState().covers[album.key]) toast(T("That picture can't be read"));
  };

  const rows: SheetRow[] = [
    { label: T("Rename"), Icon: Pencil, run: () => setRenaming(true) },
    { label: pictured ? T("Change picture…") : T("Choose a picture…"), Icon: ImageIcon, run: () => void choosePicture() },
    ...(pictured ? [{ label: T("Remove picture"), Icon: ImageOff, run: () => useAlbumEdits.getState().setCover(album.key, null) }] : []),
    { label: T("Artists…"), line: album.artist, Icon: Users, run: () => setSheet("artists") },
    {
      label: T("Merge albums…"),
      line: parts.length ? T("Made of {count}", { count: plural(parts.length + 1, T("album"), T("albums")) }) : T("Put back together what your tags split, like “Disc 2”"),
      Icon: Combine,
      run: () => setSheet("merge"),
    },
    ...(putOn.length
      ? [
          {
            label: T("Take off the songs put on by hand"),
            line: plural(putOn.length, T("song"), T("songs")),
            Icon: Split,
            run: () => {
              useAlbumEdits.getState().clearSongs(putOn.map((t) => t.id));
              const n = putOn.length;
              toast(T("{n} {value} without an album again", { n, value: n === 1 ? T("song is") : T("songs are") }));
            },
          },
        ]
      : []),
    ...(renamed || pictured
      ? [
          {
            label: T("Back to the tags"),
            line: T("The name and picture the songs bring"),
            Icon: RotateCcw,
            run: () => {
              useAlbumEdits.getState().setTitle(album.key, null);
              useAlbumEdits.getState().setCover(album.key, null);
            },
          },
        ]
      : []),
  ];

  return (
    <>
      <MenuSheet
        visible={visible}
        art={<Cover uri={album.thumb} size={46} />}
        title={album.title}
        subtitle={T("Changes stay in Songsta — your files and servers aren't touched.")}
        rows={rows}
        onClose={onClose}
      />
      <NameDialog
        visible={renaming}
        title={T("Rename album")}
        placeholder={T("Album name")}
        initial={album.title}
        action={T("Save")}
        onCancel={() => setRenaming(false)}
        onDone={(name) => {
          setRenaming(false);
          if (name !== album.title) useAlbumEdits.getState().setTitle(album.key, name);
        }}
      />
      <ArtistsSheet album={album} visible={sheet === "artists"} onClose={() => setSheet(null)} />
      <MergeSheet album={album} parts={parts} visible={sheet === "merge"} onClose={() => setSheet(null)} />
    </>
  );
}

/** The album's artist line, name by name: one taken off, one added, or back to what the tags say. */
function ArtistsSheet({ album, visible, onClose }: { album: LibAlbum; visible: boolean; onClose: () => void }) {
  const credited = useAlbumEdits((s) => !!s.artists[album.key]);
  const [adding, setAdding] = useState(false);
  const names = splitCredits(album.artist);
  const setNames = (next: string[]): void => useAlbumEdits.getState().setArtists(album.key, creditLine(next));
  return (
    <>
      <SheetFrame visible={visible && !adding} onClose={onClose}>
        <SheetHead title={T("Artists")} subtitle={album.title} />
        {names.map((name) => (
          <View key={name} style={styles.row}>
            <Text numberOfLines={1} style={[styles.rowTitle, styles.grow]}>
              {name}
            </Text>
            <Pressable
              disabled={names.length < 2}
              onPress={() => setNames(names.filter((n) => n !== name))}
              accessibilityLabel={names.length < 2 ? T("An album keeps at least one artist") : T("Remove {n}", { n: name })}
              hitSlop={8}
              style={[styles.roundButton, names.length < 2 && styles.off]}
            >
              <X size={18} color={colors.ink} />
            </Pressable>
          </View>
        ))}
        <Pressable style={styles.row} android_ripple={{ color: "rgba(255,255,255,0.08)" }} onPress={() => setAdding(true)}>
          <View style={styles.newMark}>
            <Plus size={22} color={colors.ink} />
          </View>
          <Text style={styles.rowTitle}>{T("Add an artist")}</Text>
        </Pressable>
        {credited && (
          <Pressable style={styles.row} android_ripple={{ color: "rgba(255,255,255,0.08)" }} onPress={() => useAlbumEdits.getState().setArtists(album.key, null)}>
            <View style={styles.newMark}>
              <RotateCcw size={20} color={colors.ink} />
            </View>
            <Text style={styles.rowTitle}>{T("Back to the tags")}</Text>
          </Pressable>
        )}
      </SheetFrame>
      <NameDialog
        visible={visible && adding}
        title={T("Add an artist")}
        placeholder={T("Artist")}
        action={T("Add")}
        onCancel={() => setAdding(false)}
        onDone={(name) => {
          setAdding(false);
          if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) setNames([...names, name]);
        }}
      />
    </>
  );
}

function AlbumLine({ album, onPress }: { album: LibAlbum; onPress: () => void }) {
  return (
    <Pressable style={styles.row} android_ripple={{ color: "rgba(255,255,255,0.08)" }} onPress={onPress}>
      <Cover uri={album.thumb} size={46} />
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={styles.rowTitle}>
          {album.title}
        </Text>
        <Text numberOfLines={1} style={styles.rowSub}>
          {[album.artist, album.year ? String(album.year) : "", RELEASE_LABEL[album.kind], plural(album.tracks.length, T("song"), T("songs"))].filter(Boolean).join(" · ")}
        </Text>
      </View>
    </Pressable>
  );
}

/** Albums that look like parts of this one first (the same title), then the same artist's; or what a search finds. */
function useCandidates(album: LibAlbum, query: string, limit: number): LibAlbum[] {
  const albums = useLibrary((s) => s.albums);
  return useMemo(() => {
    const others = albums.filter((a) => a.key !== album.key);
    const q = foldTag(query);
    if (q) return others.filter((a) => foldTag(`${a.title} ${a.artist}`).includes(q)).slice(0, 40);
    const base = baseTitle(album.title);
    const mine = new Set(splitCredits(album.artist).map((n) => n.toLowerCase()));
    const sameTitle = others.filter((a) => baseTitle(a.title) === base);
    const sameArtist = others.filter((a) => !sameTitle.includes(a) && splitCredits(a.artist).some((n) => mine.has(n.toLowerCase())));
    return [...sameTitle, ...sameArtist].slice(0, limit);
  }, [albums, album, query, limit]);
}

/** The albums shown as part of this one, each to be taken out again; and others to add to it. */
function MergeSheet({ album, parts, visible, onClose }: { album: LibAlbum; parts: ReturnType<typeof partsOf>; visible: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const candidates = useCandidates(album, query, 20);
  return (
    <SheetFrame visible={visible} onClose={onClose}>
      <SheetHead title={T("Merge albums")} subtitle={album.title} />
      <FlatList
        data={candidates}
        keyExtractor={(a) => a.key}
        keyboardShouldPersistTaps="handled"
        style={styles.list}
        ListHeaderComponent={
          <View>
            <Text style={styles.section}>{T("Parts of this album")}</Text>
            {parts.length === 0 ? (
              <Text style={styles.note}>{T("No other album is shown as part of this one. If your tags split it — “Disc 2”, or a song with another album artist — add that album below.")}</Text>
            ) : (
              parts.map((p) => (
                <View key={p.key} style={styles.row}>
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={styles.rowTitle}>
                      {p.title}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowSub}>
                      {[p.artist, plural(p.count, T("song"), T("songs"))].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                  <Pressable
                    style={styles.textButton}
                    onPress={() => {
                      useAlbumEdits.getState().split(p.key);
                      toast(T("“{title}” is its own album again", { title: p.title }));
                    }}
                  >
                    <Text style={styles.textButtonLabel}>{T("Separate")}</Text>
                  </Pressable>
                </View>
              ))
            )}
            <Text style={styles.section}>{T("Add an album to this one")}</Text>
            <SearchField value={query} onChange={setQuery} placeholder={T("Search albums")} style={styles.search} />
          </View>
        }
        ListEmptyComponent={<Text style={styles.note}>{query ? T("No album matches.") : T("No similar albums — search for one.")}</Text>}
        renderItem={({ item }) => (
          <AlbumLine
            album={item}
            onPress={() => {
              useAlbumEdits.getState().merge(item.key, album.key);
              toast(T("“{title}” is now part of “{title2}”", { title: item.title, title2: album.title }));
            }}
          />
        )}
      />
    </SheetFrame>
  );
}

/** What a song carries to join an album of the library, as if tagged with it. */
function joining(album: LibAlbum): SongEdit {
  const own = album.tracks.find((t) => libraryAlbumKey(t) === album.key) ?? album.tracks[0];
  return {
    album: own?.albumTag ?? own?.album ?? album.title,
    albumArtist: own ? own.albumArtist || leadArtist(own.artist) || undefined : undefined,
    trackNo: Math.max(0, ...album.tracks.map((t) => t.trackNo ?? 0)) + 1,
    year: album.year,
  };
}

/** A song put on an album by hand: one the library has, or a new one of its own name. */
export function PutOnAlbumSheet() {
  const track = usePutOnAlbum((s) => s.track);
  const close = usePutOnAlbum((s) => s.close);
  const [naming, setNaming] = useState(false);
  const [query, setQuery] = useState("");
  const albums = useLibrary((s) => s.albums);
  const shown = useMemo(() => {
    if (!track) return [];
    const q = foldTag(query);
    if (q) return albums.filter((a) => foldTag(`${a.title} ${a.artist}`).includes(q)).slice(0, 40);
    // The song's own artist's albums first.
    const lead = leadArtist(track.artist).toLowerCase();
    return albums.filter((a) => splitCredits(a.artist).some((n) => n.toLowerCase() === lead)).slice(0, 30);
  }, [albums, track, query]);
  const put = (edit: SongEdit, title: string, made: boolean): void => {
    if (!track) return;
    useAlbumEdits.getState().setSongs({ [track.id]: edit });
    toast(made ? T("Made “{trim}” from {n} {value}", { trim: title, n: 1, value: T("song") }) : T("Put {n} {value} on “{title}”", { n: 1, value: T("song"), title }));
    setQuery("");
    close();
  };
  return (
    <>
      <SheetFrame visible={!!track && !naming} onClose={close}>
        <SheetHead title={T("Put on an album")} subtitle={track?.title} />
        <FlatList
          data={shown}
          keyExtractor={(a) => a.key}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListHeaderComponent={
            <View>
              <Pressable style={styles.row} android_ripple={{ color: "rgba(255,255,255,0.08)" }} onPress={() => setNaming(true)}>
                <View style={styles.newMark}>
                  <Plus size={22} color={colors.ink} />
                </View>
                <Text style={styles.rowTitle}>{T("New album…")}</Text>
              </Pressable>
              <SearchField value={query} onChange={setQuery} placeholder={T("Search albums")} style={styles.search} />
            </View>
          }
          ListEmptyComponent={<Text style={styles.note}>{query ? T("No album matches.") : T("No album of this artist yet — search for one.")}</Text>}
          renderItem={({ item }) => <AlbumLine album={item} onPress={() => put(joining(item), item.title, false)} />}
        />
      </SheetFrame>
      <NameDialog
        visible={!!track && naming}
        title={T("New album")}
        placeholder={T("Album name")}
        action={T("Create")}
        onCancel={() => setNaming(false)}
        onDone={(name) => {
          setNaming(false);
          put({ album: name, trackNo: 1 }, name, true);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 0, flexShrink: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 58, paddingHorizontal: 18, paddingVertical: 6 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "500" },
  grow: { flex: 1 },
  rowSub: { color: colors.dim, fontSize: 13, marginTop: 2 },
  newMark: { width: 46, height: 46, borderRadius: 4, backgroundColor: colors.button, alignItems: "center", justifyContent: "center" },
  roundButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.35 },
  section: { color: colors.ink, fontSize: 14, fontWeight: "700", paddingHorizontal: 18, paddingTop: 14, paddingBottom: 6 },
  note: { color: colors.dim, fontSize: 13, lineHeight: 18, paddingHorizontal: 18, paddingVertical: 8 },
  search: { marginHorizontal: 16, marginVertical: 8 },
  textButton: { height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: colors.chip, alignItems: "center", justifyContent: "center" },
  textButtonLabel: { color: colors.ink, fontSize: 13.5, fontWeight: "600" },
});
