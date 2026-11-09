/**
 * Your Library: Liked Songs on top, what's pinned in the order it was placed,
 * the rest by when it last played or was made, or as sorted on the computer.
 * The playlists are the same ones as on the desktop (stores/playlists.ts);
 * the mixes stand in the list as playlists do. Albums and playlists put in a
 * group stand folded in it, as Discord folds servers, until a tap opens it; a
 * group plays all of it, in its own order or shuffled (lib/libraryGroups.ts).
 * Pins, their order, the sort and the groups are the same on every device
 * (stores/librarySync.ts).
 */
import { useNavigation } from "@react-navigation/native";
import { ArrowDownAZ, ArrowUpDown, CalendarPlus, ChevronDown, ChevronRight, CircleArrowDown, FolderMinus, FolderOpen, FolderPlus, Heart, History, Pencil, Pin, PinOff, Play, Plus, Shuffle, Ungroup, User, type LucideIcon } from "lucide-react-native";
import { useMemo, useState, type ReactNode } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupOrderSheet } from "../components/GroupOrderSheet";
import { NameDialog } from "../components/PlaylistSheets";
import { MenuSheet, type SheetRow } from "../components/Sheet";
import { glideList, PullRow } from "../components/SwipeRow";
import { Chip, Cover, CoverGrid, EqBars } from "../components/ui";
import {
  albumListKey,
  arrangeGroups,
  groupOf,
  LIBRARY_SORTS,
  LIKED_KEY,
  newestFirst,
  newGroupId,
  newGroupName,
  playlistListKey,
  plural,
  withGroupNamed,
  withItemIn,
  withItemMoved,
  withItemOut,
  withNewGroup,
  withoutGroup,
  type Group,
  type LibAlbum,
  type LibrarySort,
  type Track,
} from "../shared";
import { sizeLine, useDownloads } from "../stores/downloads";
import { likedSongIds, useArtistPhoto, useLibrary } from "../stores/library";
import { useLibrarySync } from "../stores/librarySync";
import { chooseLibrarySort } from "../libraryDocs";
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
  | { kind: "playlist"; key: string; title: string; subtitle: string; tracks: Track[]; lastAt: number; cover?: string; inGroup?: string }
  | { kind: "mix"; key: string; id: string; title: string; subtitle: string; tracks: Track[]; lastAt: number }
  | { kind: "album"; key: string; album: LibAlbum; lastAt: number; inGroup?: string }
  | { kind: "group"; key: string; group: Group; members: Member[]; lastAt: number }
  | { kind: "artist"; key: string; name: string; thumb: string; lastAt: number };

/** What a group holds: albums and playlists. */
type Member = Extract<Row, { kind: "album" | "playlist" }>;

/** How a group knows an album or a playlist (lib/keptLists.ts' keys). */
const itemKey = (r: Member): string => (r.kind === "album" ? albumListKey(r.album.key) : playlistListKey(r.key));

/** How something that isn't a playlist is known among the pins. */
const pinKey = (r: Row): string => (r.kind === "album" ? `album:${r.key}` : r.kind === "mix" ? `mix:${r.id}` : r.kind === "artist" ? `artist:${r.name}` : "");

/** The sorts the computer's library panel offers, the same on every device (libraryDocs.ts). */
const SORT_LABEL: Record<LibrarySort, string> = { played: T("Recently played"), added: T("Recently added"), alpha: T("Alphabetical"), artist: T("Artist") };
const SORT_ICON: Record<LibrarySort, LucideIcon> = { played: History, added: CalendarPlus, alpha: ArrowDownAZ, artist: User };

/** Where a row stands among the pins, placed here or on the computer (stores/librarySync.ts). */
const placeKey = (r: Row): string => (r.kind === "playlist" ? playlistListKey(r.key) : r.kind === "liked" ? LIKED_KEY : pinKey(r));

/** The library's sort as chosen on the computer: the playlists in their own order, then the albums sorted. */
function bySort(sort: LibrarySort): (a: Member, b: Member) => number {
  return (a, b) => {
    if (a.kind === "playlist" || b.kind === "playlist") return a.kind === b.kind ? 0 : a.kind === "playlist" ? -1 : 1;
    if (sort === "alpha") return a.album.title.localeCompare(b.album.title);
    if (sort === "artist") return a.album.artist.localeCompare(b.album.artist) || newestFirst(a.album, b.album);
    return b.album.addedAt - a.album.addedAt || a.album.title.localeCompare(b.album.title);
  };
}

const togglePin = (r: Row): void => {
  glideList();
  if (r.kind === "playlist") usePlaylists.getState().togglePin(r.key);
  else useSettings.getState().togglePin(pinKey(r));
};

const nameOf = (r: Row): string | undefined =>
  r.kind === "playlist" || r.kind === "mix" ? r.title : r.kind === "album" ? r.album.title : r.kind === "group" ? r.group.name : r.kind === "artist" ? r.name : undefined;

/* ------------------------------------------------------------ groups */

const groupsNow = (): Group[] => useSettings.getState().libraryGroups;
const setGroups = (groups: Group[]): void => useSettings.getState().change({ libraryGroups: groups });
const groupName = (n: number): string => T("Group {count}", { count: n });

/** "Group · 3 albums, 1 playlist" */
function groupLine(members: Member[]): string {
  const albums = members.filter((m) => m.kind === "album").length;
  const lists = members.length - albums;
  const parts = [albums ? plural(albums, T("album"), T("albums")) : "", lists ? plural(lists, T("playlist"), T("playlists")) : ""];
  return T("Group · {count}", { count: parts.filter(Boolean).join(", ") });
}

const coverOf = (m: Member): string => (m.kind === "album" ? m.album.thumb : m.cover ?? m.tracks.find((t) => t.thumb)?.thumb ?? "");

/** Everything in a group, album after album and playlist after playlist, in the group's own order. */
const songsOf = (members: Member[]): Track[] => members.flatMap((m) => (m.kind === "album" ? m.album.tracks : m.tracks));

function playGroup(row: Extract<Row, { kind: "group" }>, shuffled: boolean): void {
  const songs = songsOf(row.members);
  if (!songs.length) return;
  feel("press");
  usePlayer.getState().playAll(songs, row.group.name, shuffled);
}

/** A group folded: its first covers in a small grid, the way Discord shows a folder of servers. */
function GroupTile({ covers }: { covers: string[] }) {
  return (
    <View style={styles.groupTile}>
      {covers.slice(0, 4).map((uri, i) => (
        <Cover key={i} uri={uri} size={22} radius={3} />
      ))}
    </View>
  );
}

/** What a dialog names: a new group for an album or a playlist, or a group there is. */
type Naming = { item: Member } | { group: Group } | null;

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
  // The sort and the pins' order, the same as on the computer.
  const sort = useLibrarySync((s) => s.sort?.v ?? "played");
  const pinPlaces = useLibrarySync((s) => s.pins);
  const [sorting, setSorting] = useState(false);
  const libraryGroups = useSettings((s) => s.libraryGroups);
  /** groups opened by a tap; folded again by the next */
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** the album or playlist whose "Add to group" sheet is up */
  const [grouping, setGrouping] = useState<Member | null>(null);
  const [groupNaming, setGroupNaming] = useState<Naming>(null);
  /** the group whose order is being changed */
  const [ordering, setOrdering] = useState<string | null>(null);
  const toggleGroup = (id: string): void => {
    feel("tick");
    glideList();
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
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
    if ((r.kind === "album" || r.kind === "playlist") && r.inGroup) return false;
    if (r.kind === "playlist") return !!playlists.find((p) => p.id === r.key)?.pinned;
    return pins.includes(pinKey(r));
  };

  /** Every album and playlist the library has, as a group's rows, by key: also what the chips hide. */
  const members = useMemo(() => {
    const playedAt = (key: string): number => played[key] ?? 0;
    const all = new Map<string, Member>();
    for (const p of playlists) {
      const tracks = playlistTracks(p);
      const row: Member = {
        kind: "playlist",
        key: p.id,
        title: p.name,
        subtitle: T("Playlist · {count}", { count: plural(tracks.length, T("song"), T("songs")) }),
        tracks,
        cover: p.cover,
        // A new one stands on top, as what somebody just did.
        lastAt: Math.max(p.createdAt, playedAt(`playlist:${p.id}`)),
      };
      all.set(itemKey(row), row);
    }
    for (const a of albums) {
      const row: Member = { kind: "album", key: a.key, album: a, lastAt: playedAt(`album:${a.key}`) };
      all.set(itemKey(row), row);
    }
    return all;
  }, [playlists, albums, played]);

  const rows = useMemo<Row[]>(() => {
    // What was started as a whole (stores/played.ts): a song from a playlist doesn't make its album or its artist recent.
    const playedAt = (key: string): number => played[key] ?? 0;
    const rest: Row[] = [];
    const entries: Member[] = [];
    for (const m of members.values()) {
      if (m.kind === "playlist" ? filter !== "albums" && filter !== "artists" : filter !== "playlists" && filter !== "artists") entries.push(m);
    }
    if (sort !== "played") entries.sort(bySort(sort));
    if (filter !== "albums" && filter !== "artists") {
      for (const m of mixes) rest.push({ kind: "mix", key: m.id, id: m.id, title: m.title, subtitle: T("Mix · {count}", { count: plural(m.tracks.length, T("song"), T("songs")) }), tracks: m.tracks, lastAt: playedAt(`mix:${m.id}`) });
    }
    // A group stands as one row, as recent as its most recent album or playlist; under a chip, with what of it the chip shows.
    for (const item of arrangeGroups(libraryGroups, entries, itemKey)) {
      if ("entry" in item) rest.push(item.entry);
      else rest.push({ kind: "group", key: item.group.id, group: item.group, members: item.members, lastAt: Math.max(0, ...item.members.map((m) => m.lastAt)) });
    }
    if (filter !== "playlists" && filter !== "albums") {
      for (const a of artists) rest.push({ kind: "artist", key: a.name, name: a.name, thumb: a.thumb, lastAt: playedAt(`artist:${a.name.toLowerCase()}`) });
    }
    // Liked Songs stands on top, unless it was unpinned (on the computer): then it sorts in with the rest.
    const likedRow: Row | null = filter === "albums" || filter === "artists" ? null : { kind: "liked", key: "liked", count: likedSongIds(data.favorites, byId).length };
    const likedOnTop = !pinPlaces || pinPlaces.includes(LIKED_KEY);
    if (likedRow && !likedOnTop) rest.push(likedRow);
    // What's pinned stands above it all, in the order it was placed; then, by Recently played, the rest by when it last played.
    // Stable: what never played keeps its order behind the rest.
    const lastAt = (r: Row): number => (r.kind === "liked" ? played[LIKED_KEY] ?? 0 : r.kind === "downloads" || r.kind === "local" ? 0 : r.lastAt);
    const place = new Map((pinPlaces ?? []).map((key, i) => [key, i] as const));
    const placeOf = (r: Row): number => place.get(placeKey(r)) ?? Number.MAX_SAFE_INTEGER;
    const others = rest.filter((r) => !isPinned(r));
    if (sort === "played") others.sort((a, b) => lastAt(b) - lastAt(a));
    const ordered = [...rest.filter(isPinned).sort((a, b) => placeOf(a) - placeOf(b) || lastAt(b) - lastAt(a)), ...others];
    // An open group shows what's in it right under it, in its own order.
    const shown: Row[] = [];
    for (const r of ordered) {
      shown.push(r);
      if (r.kind === "group" && open.has(r.key)) for (const m of r.members) shown.push({ ...m, inGroup: r.key });
    }
    const liked: Row[] = likedRow && likedOnTop ? [likedRow] : [];
    const keptSongs = Object.values(kept);
    const downloads: Row[] =
      likedRow && (keptSongs.length || loadingCount)
        ? [
            {
              kind: "downloads",
              key: "downloads",
              line: wifiCount ? T("{count} for Wi-Fi", { count: plural(wifiCount, T("song waits"), T("songs wait")) }) : loadingCount ? T("Downloading {count}…", { count: plural(loadingCount, T("song"), T("songs")) }) : `${plural(keptSongs.length, "song", "songs")} · ${sizeLine(keptSongs.reduce((sum, k) => sum + k.bytes, 0))}`,
            },
          ]
        : [];
    const onPhone = likedRow ? data.tracks.filter((t) => t.localPath).length : 0;
    const local: Row[] = onPhone ? [{ kind: "local", key: "local", line: T("Folders on this phone · {count}", { count: plural(onPhone, T("song"), T("songs")) }) }] : [];
    return [...liked, ...local, ...downloads, ...shown];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, members, artists, mixes, playlists, filter, kept, loadingCount, wifiCount, pins, played, libraryGroups, open, sort, pinPlaces]);

  const chip = (label: string, value: Exclude<Filter, null>) => (
    <Chip label={label} active={filter === value} onPress={() => setFilter(filter === value ? null : value)} />
  );

  /** A group's rows, whatever the chips show, in its own order. */
  const wholeGroup = (group: Group): Member[] => group.items.map((k) => members.get(k)).filter((m): m is Member => !!m);

  const putIn = (group: Group, item: Member): void => {
    glideList();
    setGroups(withItemIn(groupsNow(), group.id, itemKey(item)));
    toast(T("Put in “{name}”", { name: group.name }));
  };

  /** A held row's menu: its pin; an album's or a playlist's way into a group or out of it; a group's own. */
  const menuRows = (row: Row): SheetRow[] => {
    if (row.kind === "group") {
      const whole = { ...row, members: wholeGroup(row.group) };
      return [
        { label: T("Play in order"), Icon: Play, run: () => playGroup(whole, false) },
        { label: T("Shuffle"), Icon: Shuffle, run: () => playGroup(whole, true) },
        ...(whole.members.length > 1 ? [{ label: T("Change the order"), Icon: ArrowUpDown, run: () => setOrdering(row.group.id) }] : []),
        { label: T("Rename group"), Icon: Pencil, run: () => setGroupNaming({ group: row.group }) },
        {
          label: T("Dissolve group"),
          Icon: Ungroup,
          run: () => {
            glideList();
            setGroups(withoutGroup(groupsNow(), row.group.id));
            toast(T("What was in “{name}” stands on its own again", { name: row.group.name }));
          },
        },
      ];
    }
    const pin: SheetRow = { label: isPinned(row) ? T("Unpin") : T("Pin to the top"), Icon: isPinned(row) ? PinOff : Pin, run: () => togglePin(row) };
    if (row.kind !== "album" && row.kind !== "playlist") return [pin];
    const mine = groupOf(libraryGroups, itemKey(row));
    const items: SheetRow[] = [...(mine ? [] : [pin]), { label: T("Add to group"), Icon: FolderPlus, run: () => setGrouping(row) }];
    if (mine) {
      items.push({
        label: T("Take out of “{name}”", { name: mine.name }),
        Icon: FolderMinus,
        run: () => {
          glideList();
          setGroups(withItemOut(groupsNow(), itemKey(row)));
        },
      });
    }
    return items;
  };

  /** Where an album or a playlist can go: a new group, or one there is. */
  const groupingRows = (item: Member): SheetRow[] => {
    const mine = groupOf(libraryGroups, itemKey(item));
    return [
      { label: T("New group…"), Icon: Plus, run: () => setGroupNaming({ item }) },
      ...libraryGroups.filter((g) => g.id !== mine?.id).map((g) => ({ label: g.name, Icon: FolderPlus, run: () => putIn(g, item) })),
    ];
  };

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

  const orderingGroup = ordering ? libraryGroups.find((g) => g.id === ordering) : undefined;

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
      case "playlist": {
        const content = (
          <Pressable style={[styles.row, !!item.inGroup && styles.inGroup]} onLongPress={() => hold(item)} onPress={() => nav.navigate("Collection", { kind: "playlist", id: item.key })}>
            <CoverGrid tracks={item.tracks} size={56} cover={item.cover} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {item.title}
              </Text>
              <SubLine pinned={isPinned(item)} text={item.subtitle} />
            </View>
          </Pressable>
        );
        // In a group, its place is the group's: no pin to pull.
        return item.inGroup ? content : pulled(item, content);
      }
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
      case "group": {
        const playing = item.members.some((m) => m.kind === "album" && m.album.route === playingAlbum);
        const isOpen = open.has(item.key);
        const whole = { ...item, members: wholeGroup(item.group) };
        return (
          <Pressable style={[styles.row, isOpen && styles.openGroup]} onLongPress={() => hold(item)} onPress={() => toggleGroup(item.key)} accessibilityState={{ expanded: isOpen }}>
            <GroupTile covers={item.members.map(coverOf)} />
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.rowTitle, playing && { color: colors.accent }]}>
                {item.group.name}
              </Text>
              <Text numberOfLines={1} style={styles.rowSub}>
                {groupLine(item.members)}
              </Text>
            </View>
            {playing && <EqBars />}
            <Pressable accessibilityRole="button" accessibilityLabel={T("Shuffle")} hitSlop={4} onPress={() => playGroup(whole, true)} style={styles.groupButton}>
              <Shuffle size={20} color={colors.ink} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={T("Play in order")} hitSlop={4} onPress={() => playGroup(whole, false)} style={styles.groupPlay}>
              <Play size={18} color={colors.onAccent} fill={colors.onAccent} />
            </Pressable>
            {isOpen ? <ChevronDown size={20} color={colors.dim} /> : <ChevronRight size={20} color={colors.dim} />}
          </Pressable>
        );
      }
      case "album": {
        const playing = playingAlbum === item.album.route;
        const content = (
          <Pressable style={[styles.row, !!item.inGroup && styles.inGroup]} onLongPress={() => hold(item)} onPress={() => nav.navigate("Album", { albumKey: item.album.key })}>
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
        return item.inGroup ? content : pulled(item, content);
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
      <Pressable style={styles.sort} onPress={() => setSorting(true)} accessibilityLabel={T("Sort by")}>
        <ArrowUpDown size={16} color={colors.ink} />
        <Text style={styles.sortText}>{SORT_LABEL[sort]}</Text>
      </Pressable>
      <MenuSheet
        visible={sorting}
        title={T("Sort by")}
        rows={LIBRARY_SORTS.map((k) => ({ label: SORT_LABEL[k], Icon: SORT_ICON[k], active: sort === k, run: () => chooseLibrarySort(k) }))}
        onClose={() => setSorting(false)}
      />
      <FlatList
        data={rows}
        keyExtractor={(r) => `${r.kind}:${"inGroup" in r && r.inGroup ? `${r.inGroup}:` : ""}${r.key}`}
        renderItem={renderRow}
        initialNumToRender={12}
        contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
      />
      <MenuSheet visible={!!holding} title={holding ? nameOf(holding) : undefined} onClose={() => setHolding(null)} rows={holding ? menuRows(holding) : []} />
      <MenuSheet
        visible={!!grouping}
        title={T("Add to group")}
        subtitle={grouping ? nameOf(grouping) : undefined}
        onClose={() => setGrouping(null)}
        rows={grouping ? groupingRows(grouping) : []}
      />
      <GroupOrderSheet
        visible={!!orderingGroup}
        title={orderingGroup?.name}
        items={(orderingGroup ? wholeGroup(orderingGroup) : []).map((m) => ({
          key: itemKey(m),
          label: m.kind === "album" ? m.album.title : m.title,
          line: m.kind === "album" ? T("Album · {artist}", { artist: m.album.artist }) : m.subtitle,
          art: m.kind === "album" ? <Cover uri={m.album.thumb} size={40} /> : <CoverGrid tracks={m.tracks} size={40} cover={m.cover} />,
        }))}
        onMove={(key, by) => {
          glideList();
          setGroups(withItemMoved(groupsNow(), key, by, (k) => members.has(k)));
        }}
        onClose={() => setOrdering(null)}
      />
      <NameDialog
        visible={!!groupNaming}
        title={groupNaming && "group" in groupNaming ? T("Rename group") : T("New group")}
        placeholder={T("Group name")}
        initial={groupNaming && "group" in groupNaming ? groupNaming.group.name : newGroupName(libraryGroups, groupName)}
        action={groupNaming && "group" in groupNaming ? T("Save") : T("Create")}
        onCancel={() => setGroupNaming(null)}
        onDone={(name) => {
          const now = groupsNow();
          if (groupNaming && "group" in groupNaming) setGroups(withGroupNamed(now, groupNaming.group.id, name));
          else if (groupNaming && "item" in groupNaming) {
            const id = newGroupId();
            const named = name || newGroupName(now, groupName);
            glideList();
            setGroups(withNewGroup(now, id, named, [itemKey(groupNaming.item)]));
            setOpen((prev) => new Set(prev).add(id));
            toast(T("Made the group “{name}”", { name: named }));
          }
          setGroupNaming(null);
        }}
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
  groupTile: { width: 56, height: 56, borderRadius: 8, padding: 4, gap: 4, flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.panel },
  openGroup: { backgroundColor: "rgba(255,255,255,0.04)" },
  groupButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  groupPlay: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  /** an album or a playlist shown inside its open group */
  inGroup: { paddingLeft: 32, backgroundColor: "rgba(255,255,255,0.025)" },
});
