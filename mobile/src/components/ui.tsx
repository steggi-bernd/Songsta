/** The small parts every screen is built from: covers, chips, shelves, song rows. */
import { Image } from "expo-image";
import { CircleArrowDown, EllipsisVertical, Heart, Music2, Search, Split, VolumeX, X } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { PixelRatio, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";
import { withoutServer } from "../addresses";
import type { Track } from "../shared";
import { readJson, writeJson } from "../storage";
import { useConnection } from "../stores/connection";
import { downloadOf, percentOf, useDownloads } from "../stores/downloads";
import { useLibrary } from "../stores/library";
import { fileOfSong } from "../stores/localMusic";
import { usePlayer } from "../stores/player";
import { here, useSession } from "../stores/session";
import { feel } from "../stores/settings";
import { colors } from "../theme";
import { useSongMenu } from "./SongMenu";
import { SwipeRow, type RowList } from "./SwipeRow";
import { T } from "../shared";

/** Jellyfin scales pictures to order: a row's 48 points don't need the player's 800 pixels. */
const PICTURE_WIDTHS = [200, 480];
const SMALL_PICTURE = 48;
function sized(uri: string, size: number): string {
  const width = PICTURE_WIDTHS.find((w) => w >= size * PixelRatio.get());
  return width ? uri.replace(/([?&]maxWidth=)[0-9]+/, `$1${width}`) : uri;
}

/** Where to load a picture from now, remembered by what it is: seen at home it's there on the road too. */
export const picture = (uri: string): { uri: string; cacheKey?: string } => (uri.startsWith("data:") ? { uri } : { uri: here(uri), cacheKey: withoutServer(uri) });

/** A cover or photo; `fallback` stands in when the server has no such picture. */
export function Cover({
  uri,
  fallback,
  size,
  radius = 4,
  style,
}: {
  uri?: string | null;
  fallback?: string;
  size: number;
  radius?: number;
  style?: ImageStyle;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  // Without a connection the big one may never have been seen, the small one in a list mostly has.
  const [noBig, setNoBig] = useState<string | null>(null);
  const box = { width: size, height: size, borderRadius: radius };
  const shown = uri && uri !== failed ? uri : fallback;
  // The same pictures from wherever the server answers now.
  useSession((s) => s.session?.server);
  const kept = useDownloads((s) => (shown ? s.covers[withoutServer(shown)] : undefined));
  if (!shown) {
    return (
      <View style={[box, styles.noCover, style as ViewStyle]}>
        <Music2 size={size * 0.4} color={colors.dim} />
      </View>
    );
  }
  return (
    <Image
      source={kept ? { uri: kept } : picture(sized(shown, noBig === shown ? SMALL_PICTURE : size))}
      style={[box, style]}
      contentFit="cover"
      cachePolicy="disk"
      recyclingKey={shown}
      transition={100}
      onError={() => {
        if (noBig !== shown && sized(shown, size) !== sized(shown, SMALL_PICTURE)) setNoBig(shown);
        else if (shown === uri) setFailed(uri);
      }}
    />
  );
}

const KEPT_COVERS_FILE = "covers-seen.json";

/**
 * On Wi-Fi the small cover of every album comes to the phone, one at a time, so
 * lists keep their pictures without a connection. Draws nothing you can see.
 */
export function CoverKeeper() {
  const tracks = useLibrary((s) => s.data.tracks);
  const free = useConnection((s) => s.reach !== "offline" && !s.metered);
  const [seen, setSeen] = useState<Set<string> | null>(null);
  useEffect(() => {
    void readJson<string[]>(KEPT_COVERS_FILE).then((saved) => setSeen(new Set(saved ?? [])));
  }, []);
  const next = useMemo(() => {
    if (!seen) return null;
    for (const t of tracks) if (t.thumb && !seen.has(withoutServer(t.thumb))) return t.thumb;
    return null;
  }, [tracks, seen]);
  if (!next || !free) return null;
  const done = (): void => {
    const all = new Set(seen).add(withoutServer(next));
    setSeen(all);
    // Not after every picture: a few lost ones are only asked for again.
    if (all.size % 20 === 0) writeJson(KEPT_COVERS_FILE, [...all]);
  };
  return <Image source={picture(sized(next, SMALL_PICTURE))} style={styles.keeper} cachePolicy="disk" onLoad={done} onError={done} />;
}

/** Four covers of a mix or playlist, or the one it has. */
export function CoverGrid({ tracks, size, radius = 4, cover }: { tracks: Track[]; size: number; radius?: number; cover?: string }) {
  if (cover) return <Cover uri={cover} size={size} radius={radius} />;
  const covers: string[] = [];
  for (const t of tracks) {
    if (t.thumb && !covers.includes(t.thumb)) covers.push(t.thumb);
    if (covers.length === 4) break;
  }
  if (covers.length < 4) return <Cover uri={covers[0]} size={size} radius={radius} />;
  return (
    <View style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", flexDirection: "row", flexWrap: "wrap" }}>
      {covers.map((c) => (
        <Cover key={c} uri={c} size={size / 2} radius={0} />
      ))}
    </View>
  );
}

export function Chip({ label, active, onPress }: { label: string; active?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={() => {
        feel("tick");
        onPress();
      }}
      style={[styles.chip, active && styles.chipActive]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function Shelf({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.shelf}>
      <Text style={styles.shelfTitle}>{title}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.shelfRow}>
        {children}
      </ScrollView>
    </View>
  );
}

export function Card({
  art,
  title,
  subtitle,
  width = CARD_SIZE,
  onPress,
  onLongPress,
}: {
  art: ReactNode;
  title: string;
  subtitle?: string;
  width?: number;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={{ width }}>
      {art}
      <Text numberOfLines={1} style={styles.cardTitle}>
        {title}
      </Text>
      {!!subtitle && (
        <Text numberOfLines={1} style={styles.cardSubtitle}>
          {subtitle}
        </Text>
      )}
    </Pressable>
  );
}

export const CARD_SIZE = 148;

/** A search: its X empties it and the keyboard stays; with nothing left to empty it closes the search, if that's a thing here. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
  onClose,
  style,
}: {
  value: string;
  onChange: (text: string) => void;
  placeholder: string;
  label?: string;
  autoFocus?: boolean;
  onClose?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  return (
    <View style={[styles.search, style]}>
      <Search size={20} color={colors.soft} strokeWidth={2.2} />
      <TextInput
        ref={input}
        accessibilityLabel={label ?? placeholder}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.soft}
        autoFocus={autoFocus}
        autoCorrect={false}
        returnKeyType="search"
        style={styles.searchInput}
      />
      {(!!value || !!onClose) && (
        <Pressable
          onPress={() => {
            if (value) {
              onChange("");
              input.current?.focus();
            } else onClose?.();
          }}
          hitSlop={10}
          accessibilityLabel={value ? T("Clear the search") : T("Close the search")}
          style={styles.searchClear}
        >
          <X size={20} color={colors.soft} />
        </Pressable>
      )}
    </View>
  );
}

export function LikeButton({ track, size = 20 }: { track: Track; size?: number }) {
  const liked = useLibrary((s) => s.favorites.has(track.id));
  const toggle = useLibrary((s) => s.toggleFavorite);
  return (
    <Pressable
      onPress={() => {
        feel("press");
        toggle(track);
      }}
      hitSlop={6}
      accessibilityLabel={liked ? T("Remove from Liked Songs") : T("Add to Liked Songs")}
      style={styles.iconButton}
    >
      <Heart size={size} color={liked ? colors.accent : colors.dim} fill={liked ? colors.accent : "transparent"} />
    </Pressable>
  );
}

/** Playing: three little bars, the desktop's mark for the song on air. */
export function EqBars({ color = colors.accent }: { color?: string }) {
  return (
    <View accessibilityLabel={T("Playing")} style={styles.eq}>
      {[8, 13, 6].map((h, i) => (
        <View key={i} style={{ width: 3, height: h, borderRadius: 1, backgroundColor: color }} />
      ))}
    </View>
  );
}

export function TrackRow({
  track,
  number,
  showCover = true,
  subtitle,
  missing,
  list,
  onPress,
  onLongPress,
}: {
  track: Track;
  number?: number;
  showCover?: boolean;
  subtitle?: string;
  /** a playlist's song this library doesn't have */
  missing?: boolean;
  /** the list this row is part of: with it the row can be pulled left, into the queue or branching off */
  list?: RowList;
  onPress: () => void;
  /** by default a held song can go to a playlist */
  onLongPress?: () => void;
}) {
  const current = usePlayer((s) => s.queue[s.index]?.id === track.id);
  const playing = usePlayer((s) => s.isPlaying);
  const download = useDownloads((s) => downloadOf(s, track.id));
  const percent = useDownloads((s) => percentOf(s, track.id));
  const muted = useLibrary((s) => s.muted.has(track.id));
  // Chosen to branch off from, until it comes on.
  const chosen = usePlayer((s) => s.branches.some((b) => !b.started && b.trackId === track.id));
  // Without a way to the server only what's on the phone can play.
  const outOfReach = useConnection((s) => s.reach === "offline") && download !== "kept" && !fileOfSong(track);
  const openMenu = (): void => {
    feel("press");
    if (onLongPress) onLongPress();
    else useSongMenu.getState().open(track);
  };
  let line = subtitle ?? track.artist;
  if (missing) line = T("Not on this server");
  else if (download === "wifi") line = T("Waiting for Wi-Fi");
  else if (download === "failed") line = T("Didn't download");
  else if (download === "loading") line = percent === null ? T("Waiting to download") : percent < 0 ? T("Downloading…") : T("Downloading {percent}%", { percent });
  const row = (
    <Pressable
      disabled={missing && !onLongPress}
      onPress={missing || outOfReach ? undefined : onPress}
      onLongPress={openMenu}
      style={[styles.row, !showCover && styles.rowPlain, (missing || outOfReach) && styles.rowMissing, muted && styles.rowMuted]}
    >
      {number !== undefined && (
        <View style={styles.rowNumber}>
          {current && playing ? <EqBars /> : <Text style={[styles.rowNumberText, current && { color: colors.accent }]}>{number}</Text>}
        </View>
      )}
      {showCover && <Cover uri={track.thumb} size={48} radius={4} />}
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.rowTitle, muted && styles.rowTitleMuted, current && { color: colors.accent }]}>
          {track.title}
        </Text>
        <View style={styles.rowSubline}>
          {chosen && <Split size={13} color={colors.accent} strokeWidth={2.6} accessibilityLabel={T("The branch starts here")} />}
          {muted && <VolumeX size={13} color={colors.mutedSong} />}
          {(download === "kept" || download === "loading" || download === "wifi") && (
            <CircleArrowDown size={13} color={download === "kept" ? colors.onAccent : colors.dim} fill={download === "kept" ? colors.accent : "transparent"} accessibilityLabel={download === "kept" ? T("Downloaded") : T("Downloading")} />
          )}
          <Text numberOfLines={1} style={[styles.rowSubtitle, muted && styles.rowSubtitleMuted]}>
            {line}
          </Text>
        </View>
        {download === "loading" && percent !== null && percent >= 0 && (
          <View style={styles.rowBar}>
            <View style={[styles.rowBarFill, { width: `${percent}%` }]} />
          </View>
        )}
      </View>
      {!missing && <LikeButton track={track} />}
      {(!missing || !!onLongPress) && (
        <Pressable onPress={openMenu} hitSlop={4} accessibilityLabel={T("More options for {title}", { title: track.title })} style={styles.rowMore}>
          <EllipsisVertical size={20} color={colors.dim} />
        </Pressable>
      )}
    </Pressable>
  );
  return list && !missing && !outOfReach ? (
    <SwipeRow track={track} list={list}>
      {row}
    </SwipeRow>
  ) : (
    row
  );
}

const styles = StyleSheet.create({
  noCover: { backgroundColor: colors.panel, alignItems: "center", justifyContent: "center" },
  keeper: { position: "absolute", width: 1, height: 1, opacity: 0 },
  chip: { height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.chip, justifyContent: "center" },
  chipActive: { backgroundColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: "500" },
  chipTextActive: { color: colors.base, fontWeight: "600" },
  shelf: { paddingTop: 26 },
  shelfTitle: { color: colors.ink, fontSize: 21, fontWeight: "700", letterSpacing: -0.3, marginLeft: 16, marginBottom: 12 },
  shelfRow: { paddingHorizontal: 16, gap: 12 },
  cardTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "600", marginTop: 8 },
  cardSubtitle: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  iconButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  search: { flexDirection: "row", alignItems: "center", gap: 10, height: 48, paddingLeft: 14, paddingRight: 6, borderRadius: 8, backgroundColor: colors.chip },
  searchInput: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 15, fontWeight: "500", padding: 0 },
  searchClear: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  eq: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, height: 62, paddingLeft: 16, paddingRight: 2 },
  rowPlain: { height: 60 },
  rowMissing: { opacity: 0.45 },
  rowMuted: { opacity: 0.62 },
  rowTitleMuted: { color: colors.mutedSong },
  rowSubtitleMuted: { color: colors.mutedSong },
  rowNumber: { width: 18, alignItems: "center" },
  rowNumberText: { color: colors.dim, fontSize: 13 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: colors.ink, fontSize: 15, fontWeight: "500" },
  rowSubline: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 3 },
  rowSubtitle: { flexShrink: 1, color: colors.dim, fontSize: 13 },
  rowBar: { height: 2, marginTop: 4, borderRadius: 1, backgroundColor: colors.hairline, overflow: "hidden" },
  rowBarFill: { height: 2, backgroundColor: colors.accent },
  rowMore: { width: 36, height: 44, alignItems: "center", justifyContent: "center" },
});
