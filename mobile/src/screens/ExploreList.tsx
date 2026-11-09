/**
 * Explore, as on the desktop: the whole library as three big lists, albums,
 * artists and genres, each in any of its orders, as rows or as tiles. Tab,
 * layout and every tab's order are remembered. Each tab has groups of its own,
 * apart from Your Library's (lib/libraryGroups.ts): a long press puts something
 * in one; a group stands folded where its first member would, opens where it
 * stands, and plays all of it, in its own order or shuffled.
 */
import { useNavigation } from "@react-navigation/native";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, FolderMinus, FolderPlus, LayoutGrid, List, Pencil, Play, Plus, Shuffle, Ungroup } from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, SectionList, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupOrderSheet } from "../components/GroupOrderSheet";
import { NameDialog } from "../components/PlaylistSheets";
import { MenuSheet, type SheetRow } from "../components/Sheet";
import { glideList } from "../components/SwipeRow";
import { Card, Chip, Cover, CoverGrid } from "../components/ui";
import {
  addedLabel,
  albumListKey,
  albumOrders,
  albumRowsOf,
  arrangeGroups,
  artistGroupKey,
  artistOrders,
  artistRowsOf,
  artistTracks,
  dayLabel,
  fmtLength,
  genreGroupKey,
  genreOrders,
  genreRowsOf,
  groupOf,
  newGroupId,
  newGroupName,
  nextSort,
  plural,
  RELEASE_LABEL,
  sortRows,
  withGroupNamed,
  withItemIn,
  withItemMoved,
  withItemOut,
  withNewGroup,
  withoutGroup,
  type AlbumRow,
  type ArtistRow,
  type ExploreTab,
  type GenreRow,
  type Group,
  type Track,
} from "../shared";
import { useExplore } from "../stores/explore";
import { useArtistPhoto, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { toast } from "../stores/popups";
import { feel } from "../stores/settings";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

type Item =
  | { kind: "album"; key: string; row: AlbumRow }
  | { kind: "artist"; key: string; row: ArtistRow }
  | { kind: "genre"; key: string; row: GenreRow };

/** A place in a line: something on its own, or a group standing folded. */
type Cell = { kind: "item"; item: Item; inGroup?: string } | { kind: "group"; group: Group; members: Item[] };

/** A line of the list: one row, or up to three tiles; `inGroup`: what an open group holds, framed. */
interface Line {
  key: string;
  cells: Cell[];
  inGroup?: string;
}

const COLUMNS = 3;
const GAP = 12;
const SIDE = 16;

const TABS: { key: ExploreTab; label: string }[] = [
  { key: "albums", label: T("Albums") },
  { key: "artists", label: T("Artists") },
  { key: "genres", label: T("Genres") },
];

const titleOf = (item: Item): string =>
  item.kind === "album" ? item.row.album.title : item.kind === "artist" ? item.row.artist.name : item.row.genre.name;

/** How a group knows a row (lib/libraryGroups.ts). */
const groupKeyOf = (item: Item): string =>
  item.kind === "album" ? albumListKey(item.row.album.key) : item.kind === "artist" ? artistGroupKey(item.row.artist.name) : genreGroupKey(item.row.genre.key);

/** The value the list is ordered by, where that isn't the name itself. */
function valueOf(item: Item, by: string): string | null {
  const plays = plural(item.row.plays, T("play"), T("plays"));
  if (item.kind === "album") {
    const { album } = item.row;
    if (by === "released") return dayLabel(album.date, album.year);
    if (by === "type") return RELEASE_LABEL[album.kind];
    if (by === "songs") return plural(album.tracks.length, T("song"), T("songs"));
    if (by === "length") return fmtLength(album.duration);
    if (by === "added") return addedLabel(album.addedAt);
    return by === "plays" ? plays : null;
  }
  if (item.kind === "artist") {
    const { artist, addedAt } = item.row;
    if (by === "albums") return plural(artist.albumCount, T("album"), T("albums"));
    if (by === "songs") return plural(artist.trackCount, T("song"), T("songs"));
    if (by === "added") return addedLabel(addedAt);
    return by === "plays" ? plays : null;
  }
  const { genre } = item.row;
  if (by === "artists") return plural(genre.artistCount, T("artist"), T("artists"));
  if (by === "albums") return plural(genre.albumCount, T("album"), T("albums"));
  if (by === "songs") return plural(genre.tracks.length, T("song"), T("songs"));
  return by === "plays" ? plays : null;
}

/** A row's line under the title: there is room for who it is by as well. */
function lineOf(item: Item, by: string): string {
  const value = valueOf(item, by);
  if (item.kind === "album") {
    const { album } = item.row;
    return [album.artist, value ?? album.year].filter(Boolean).join(" · ");
  }
  if (item.kind === "artist") {
    const { artist } = item.row;
    return value ?? `${plural(artist.albumCount, T("album"), T("albums"))} · ${plural(artist.trackCount, T("song"), T("songs"))}`;
  }
  return value ?? plural(item.row.genre.tracks.length, T("song"), T("songs"));
}

/** A tile's line: one thing fits. */
function shortOf(item: Item, by: string): string {
  const value = valueOf(item, by);
  if (value) return value;
  if (item.kind === "album") return item.row.album.artist;
  if (item.kind === "artist") return plural(item.row.artist.trackCount, T("song"), T("songs"));
  return plural(item.row.genre.tracks.length, T("song"), T("songs"));
}

/** "Group · 3 albums" */
function groupLine(tab: ExploreTab, count: number): string {
  const what = tab === "albums" ? plural(count, T("album"), T("albums")) : tab === "artists" ? plural(count, T("artist"), T("artists")) : plural(count, T("genre"), T("genres"));
  return T("Group · {count}", { count: what });
}

const coverOf = (item: Item): string =>
  item.kind === "album" ? item.row.album.thumb : item.kind === "artist" ? item.row.artist.thumb : item.row.genre.tracks.find((t) => t.thumb)?.thumb ?? "";

function ArtistArt({ name, thumb, size }: { name: string; thumb: string; size: number }) {
  const photo = useArtistPhoto(name);
  return <Cover uri={photo} fallback={thumb} size={size} radius={size / 2} />;
}

function Art({ item, size }: { item: Item; size: number }) {
  if (item.kind === "album") return <Cover uri={item.row.album.thumb} size={size} />;
  if (item.kind === "artist") return <ArtistArt name={item.row.artist.name} thumb={item.row.artist.thumb} size={size} />;
  return <CoverGrid tracks={item.row.genre.tracks} size={size} />;
}

/** A group folded: its first covers in a small grid, the way Discord shows a folder of servers. */
function GroupArt({ members, size, round }: { members: Item[]; size: number; round: boolean }) {
  const pad = Math.round(size / 14);
  const cover = Math.floor((size - pad * 3) / 2);
  return (
    <View style={[styles.groupArt, { width: size, height: size, padding: pad, gap: pad, borderRadius: Math.round(size / 8) }]}>
      {members.slice(0, 4).map((m) => (
        <Cover key={m.key} uri={coverOf(m)} size={cover} radius={round ? cover / 2 : 3} />
      ))}
    </View>
  );
}

export function ExploreList() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tab = useExplore((s) => s.tab);
  const layout = useExplore((s) => s.layout);
  const sorts = useExplore((s) => s.sorts);
  const groups = useExplore((s) => s.groups[s.tab]);
  const { setTab, setLayout, setSort } = useExplore.getState();
  const tracks = useLibrary((s) => s.data.tracks);
  const counts = useLibrary((s) => s.data.counts);
  const albums = useLibrary((s) => s.albums);
  const artists = useLibrary((s) => s.artists);
  const genres = useLibrary((s) => s.genres);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  /** the long-pressed one: something on its own or in a group, or a group */
  const [holding, setHolding] = useState<{ item: Item; inGroup?: string } | { group: Group; members: Item[] } | null>(null);
  const [grouping, setGrouping] = useState<Item | null>(null);
  const [naming, setNaming] = useState<{ item: Item } | { group: Group } | null>(null);
  const [ordering, setOrdering] = useState<string | null>(null);
  const sort = sorts[tab];

  const items = useMemo<Item[]>(() => {
    if (tab === "albums") return sortRows(albumRowsOf(albums, counts), albumOrders, sort).map((row) => ({ kind: "album", key: row.album.key, row }));
    if (tab === "artists") return sortRows(artistRowsOf(artists, tracks, counts), artistOrders, sort).map((row) => ({ kind: "artist", key: row.artist.name, row }));
    return sortRows(genreRowsOf(genres, counts), genreOrders, sort).map((row) => ({ kind: "genre", key: row.genre.key, row }));
  }, [tab, sort, albums, artists, genres, tracks, counts]);

  const byKey = useMemo(() => new Map(items.map((item) => [groupKeyOf(item), item])), [items]);

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    const size = layout === "grid" ? COLUMNS : 1;
    let line: Cell[] = [];
    const cellKey = (c: Cell): string => (c.kind === "group" ? `group:${c.group.id}` : c.item.key);
    const flush = (): void => {
      if (line.length) out.push({ key: cellKey(line[0]), cells: line });
      line = [];
    };
    for (const e of arrangeGroups(groups, items, groupKeyOf)) {
      if ("entry" in e) line.push({ kind: "item", item: e.entry });
      else {
        line.push({ kind: "group", group: e.group, members: e.members });
        if (open.has(e.group.id)) {
          // What an open group holds comes right under it, framed, in its own order.
          flush();
          for (let i = 0; i < e.members.length; i += size) {
            out.push({ key: `${e.group.id}:${e.members[i].key}`, inGroup: e.group.id, cells: e.members.slice(i, i + size).map((m) => ({ kind: "item", item: m, inGroup: e.group.id })) });
          }
          continue;
        }
      }
      if (line.length === size) flush();
    }
    flush();
    return out;
  }, [groups, items, open, layout]);

  const openItem = useCallback(
    (item: Item) => {
      if (item.kind === "album") nav.navigate("Album", { albumKey: item.row.album.key });
      else if (item.kind === "artist") nav.navigate("Artist", { name: item.row.artist.name });
      else nav.navigate("Collection", { kind: "genre", key: item.row.genre.key });
    },
    [nav]
  );

  if (!tracks.length) return <Text style={styles.none}>{T("Nothing to explore yet.")}</Text>;

  const groupsNow = (): Group[] => useExplore.getState().groups[tab];
  const save = (next: Group[]): void => {
    glideList();
    useExplore.getState().setGroups(tab, next);
  };
  const toggle = (id: string): void => {
    feel("tick");
    glideList();
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** A group's members, whatever the library has of them right now, in its order. */
  const wholeGroup = (group: Group): Item[] => group.items.map((k) => byKey.get(k)).filter((m): m is Item => !!m);
  const songsOf = (members: Item[]): Track[] =>
    members.flatMap((m) => (m.kind === "album" ? m.row.album.tracks : m.kind === "artist" ? artistTracks(tracks, m.row.artist.name) : m.row.genre.tracks));
  const play = (group: Group, shuffled: boolean): void => {
    const songs = songsOf(wholeGroup(group));
    if (!songs.length) return;
    feel("press");
    usePlayer.getState().playAll(songs, group.name, shuffled);
  };
  const hold = (what: NonNullable<typeof holding>): void => {
    feel("press");
    setHolding(what);
  };

  const menuRows = (what: NonNullable<typeof holding>): SheetRow[] => {
    if ("group" in what) {
      const { group } = what;
      return [
        { label: T("Play in order"), Icon: Play, run: () => play(group, false) },
        { label: T("Shuffle"), Icon: Shuffle, run: () => play(group, true) },
        ...(wholeGroup(group).length > 1 ? [{ label: T("Change the order"), Icon: ArrowUpDown, run: () => setOrdering(group.id) }] : []),
        { label: T("Rename group"), Icon: Pencil, run: () => setNaming({ group }) },
        {
          label: T("Dissolve group"),
          Icon: Ungroup,
          run: () => {
            save(withoutGroup(groupsNow(), group.id));
            toast(T("What was in “{name}” stands on its own again", { name: group.name }));
          },
        },
      ];
    }
    const mine = groupOf(groups, groupKeyOf(what.item));
    const rows: SheetRow[] = [{ label: T("Add to group"), Icon: FolderPlus, run: () => setGrouping(what.item) }];
    if (mine) rows.push({ label: T("Take out of “{name}”", { name: mine.name }), Icon: FolderMinus, run: () => save(withItemOut(groupsNow(), groupKeyOf(what.item))) });
    return rows;
  };

  const groupingRows = (item: Item): SheetRow[] => {
    const mine = groupOf(groups, groupKeyOf(item));
    return [
      { label: T("New group…"), Icon: Plus, run: () => setNaming({ item }) },
      ...groups
        .filter((g) => g.id !== mine?.id)
        .map((g) => ({
          label: g.name,
          Icon: FolderPlus,
          run: () => {
            save(withItemIn(groupsNow(), g.id, groupKeyOf(item)));
            toast(T("Put in “{name}”", { name: g.name }));
          },
        })),
    ];
  };

  const orders: { key: string; label: string; numeric?: boolean }[] = tab === "albums" ? albumOrders : tab === "artists" ? artistOrders : genreOrders;
  const sortLabel = orders.find((o) => o.key === sort.by)?.label ?? orders[0].label;
  const totals: Record<ExploreTab, number> = { albums: albums.length, artists: artists.length, genres: genres.length };
  const tile = (width - SIDE * 2 - GAP * (COLUMNS - 1)) / COLUMNS;
  const round = tab === "artists";
  const orderingGroup = ordering ? groups.find((g) => g.id === ordering) : undefined;

  const groupButtons = (group: Group) => (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={T("Shuffle")} hitSlop={4} onPress={() => play(group, true)} style={styles.groupButton}>
        <Shuffle size={18} color={colors.ink} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={T("Play in order")} hitSlop={4} onPress={() => play(group, false)} style={styles.groupPlay}>
        <Play size={16} color={colors.onAccent} fill={colors.onAccent} />
      </Pressable>
    </>
  );

  const tileOf = (cell: Cell) => {
    if (cell.kind === "item") {
      const { item } = cell;
      return (
        <Card
          key={item.key}
          width={tile}
          art={<Art item={item} size={tile} />}
          title={titleOf(item)}
          subtitle={shortOf(item, sort.by)}
          onPress={() => openItem(item)}
          onLongPress={() => hold({ item, inGroup: cell.inGroup })}
        />
      );
    }
    const { group, members } = cell;
    const isOpen = open.has(group.id);
    return (
      <Pressable
        key={`group:${group.id}`}
        style={[{ width: tile }, isOpen && styles.openTile]}
        onPress={() => toggle(group.id)}
        onLongPress={() => hold({ group, members })}
        accessibilityState={{ expanded: isOpen }}
      >
        <GroupArt members={members} size={tile} round={round} />
        <View style={styles.tileHead}>
          <Text numberOfLines={1} style={styles.tileTitle}>
            {group.name}
          </Text>
          {isOpen ? <ChevronDown size={16} color={colors.dim} /> : <ChevronRight size={16} color={colors.dim} />}
        </View>
        <View style={styles.tileFoot}>{groupButtons(group)}</View>
      </Pressable>
    );
  };

  const rowOf = (cell: Cell) => {
    if (cell.kind === "item") {
      const { item } = cell;
      return (
        <Pressable style={[styles.row, !!cell.inGroup && styles.inGroup]} onPress={() => openItem(item)} onLongPress={() => hold({ item, inGroup: cell.inGroup })}>
          <Art item={item} size={56} />
          <View style={styles.rowText}>
            <Text numberOfLines={1} style={styles.rowTitle}>
              {titleOf(item)}
            </Text>
            <Text numberOfLines={1} style={styles.rowSub}>
              {lineOf(item, sort.by)}
            </Text>
          </View>
        </Pressable>
      );
    }
    const { group, members } = cell;
    const isOpen = open.has(group.id);
    return (
      <Pressable style={[styles.row, isOpen && styles.openRow]} onPress={() => toggle(group.id)} onLongPress={() => hold({ group, members })} accessibilityState={{ expanded: isOpen }}>
        <GroupArt members={members} size={56} round={round} />
        <View style={styles.rowText}>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {group.name}
          </Text>
          <Text numberOfLines={1} style={styles.rowSub}>
            {groupLine(tab, members.length)}
          </Text>
        </View>
        {groupButtons(group)}
        {isOpen ? <ChevronDown size={20} color={colors.dim} /> : <ChevronRight size={20} color={colors.dim} />}
      </Pressable>
    );
  };

  return (
    <>
      <SectionList
        key={`${tab}:${layout}`}
        sections={[{ key: tab, data: lines }]}
        stickySectionHeadersEnabled
        keyExtractor={(line) => line.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        initialNumToRender={12}
        contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}
        ListHeaderComponent={<Text style={styles.heading}>{T("Explore your library")}</Text>}
        renderSectionHeader={() => (
          <View style={styles.controls}>
            <View style={styles.chips}>
              {TABS.map((t) => (
                <Chip key={t.key} label={`${t.label} ${totals[t.key]}`} active={tab === t.key} onPress={() => setTab(t.key)} />
              ))}
            </View>
            <View style={styles.tools}>
              <Pressable onPress={() => setMenu(true)} accessibilityLabel={T("Sorted by {sortLabel}", { sortLabel })} style={styles.sort}>
                <ArrowUpDown size={16} color={colors.ink} />
                <Text style={styles.sortText}>{sortLabel}</Text>
              </Pressable>
              <Pressable
                onPress={() => setLayout(layout === "grid" ? "list" : "grid")}
                accessibilityLabel={layout === "grid" ? T("Show as list") : T("Show as tiles")}
                style={styles.layout}
              >
                {layout === "grid" ? <List size={20} color={colors.ink} /> : <LayoutGrid size={20} color={colors.ink} />}
              </Pressable>
            </View>
          </View>
        )}
        renderItem={({ item: line }) =>
          layout === "grid" ? (
            <View style={[styles.tiles, !!line.inGroup && styles.groupFrame]}>{line.cells.map(tileOf)}</View>
          ) : (
            rowOf(line.cells[0])
          )
        }
      />

      <MenuSheet
        visible={menu}
        title={T("Sort by")}
        onClose={() => setMenu(false)}
        rows={orders.map((o) => {
          const active = sort.by === o.key;
          return {
            label: o.label,
            active,
            trailing: active ? sort.desc ? <ArrowDown size={18} color={colors.accent} /> : <ArrowUp size={18} color={colors.accent} /> : undefined,
            run: () => setSort(tab, nextSort(sort, o)),
          };
        })}
      />
      <MenuSheet
        visible={!!holding}
        title={holding ? ("group" in holding ? holding.group.name : titleOf(holding.item)) : undefined}
        onClose={() => setHolding(null)}
        rows={holding ? menuRows(holding) : []}
      />
      <MenuSheet visible={!!grouping} title={T("Add to group")} subtitle={grouping ? titleOf(grouping) : undefined} onClose={() => setGrouping(null)} rows={grouping ? groupingRows(grouping) : []} />
      <GroupOrderSheet
        visible={!!orderingGroup}
        title={orderingGroup?.name}
        items={(orderingGroup ? wholeGroup(orderingGroup) : []).map((m) => ({ key: groupKeyOf(m), label: titleOf(m), line: lineOf(m, sort.by), art: <Art item={m} size={40} /> }))}
        onMove={(key, by) => save(withItemMoved(groupsNow(), key, by, (k) => byKey.has(k)))}
        onClose={() => setOrdering(null)}
      />
      <NameDialog
        visible={!!naming}
        title={naming && "group" in naming ? T("Rename group") : T("New group")}
        placeholder={T("Group name")}
        initial={naming && "group" in naming ? naming.group.name : newGroupName(groups, (n) => T("Group {count}", { count: n }))}
        action={naming && "group" in naming ? T("Save") : T("Create")}
        onCancel={() => setNaming(null)}
        onDone={(name) => {
          const now = groupsNow();
          if (naming && "group" in naming) save(withGroupNamed(now, naming.group.id, name));
          else if (naming && "item" in naming) {
            const id = newGroupId();
            const named = name || newGroupName(now, (n) => T("Group {count}", { count: n }));
            save(withNewGroup(now, id, named, [groupKeyOf(naming.item)]));
            setOpen((prev) => new Set(prev).add(id));
            toast(T("Made the group “{name}”", { name: named }));
          }
          setNaming(null);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  none: { color: colors.dim, fontSize: 14, margin: SIDE },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700", marginHorizontal: SIDE, marginTop: 8, marginBottom: 12 },
  controls: { backgroundColor: colors.base, paddingBottom: 8 },
  chips: { flexDirection: "row", gap: 8, paddingHorizontal: SIDE },
  tools: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", height: 40, paddingLeft: SIDE, paddingRight: 8, marginTop: 6 },
  sort: { flexDirection: "row", alignItems: "center", gap: 8, height: 40 },
  sortText: { color: colors.ink, fontSize: 13, fontWeight: "500" },
  layout: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  tiles: { flexDirection: "row", gap: GAP, paddingHorizontal: SIDE, paddingBottom: 18 },
  /** what an open group holds, as tiles: framed under it */
  groupFrame: { backgroundColor: "rgba(255,255,255,0.04)", paddingTop: 10 },
  openTile: { opacity: 1 },
  tileHead: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  tileTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: "600" },
  tileFoot: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4, marginTop: 4 },
  groupArt: { flexDirection: "row", flexWrap: "wrap", backgroundColor: colors.panel },
  groupButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  groupPlay: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 68, paddingHorizontal: SIDE },
  openRow: { backgroundColor: "rgba(255,255,255,0.04)" },
  inGroup: { paddingLeft: 32, backgroundColor: "rgba(255,255,255,0.025)" },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "600" },
  rowSub: { color: colors.dim, fontSize: 13, marginTop: 3 },
});
