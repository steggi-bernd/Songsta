/**
 * The player, moving as on Spotify: the mini player and the tabs stay where they
 * are, and the whole page slides up over them, complete and solid, and back down.
 * One number runs the way, `progress` from 0 to 1, on the native side, so the
 * motion stays smooth whatever JavaScript is doing. A finger moves the same number.
 */
import { useNavigation } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { AudioLines, Check, CircleArrowDown, Disc3, ListPlus, Pause, Play, Speaker, Tv, User, Volume2, VolumeX } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, BackHandler, Easing, PanResponder, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaFrame, useSafeAreaInsets } from "react-native-safe-area-context";
import { seeThrough, tinted } from "../color";
import { albumKeyOf } from "../playingFrom";
import { playingNow, type QualityMode } from "../quality";
import { describePlayback, formatLine, leadArtist, type Track } from "../shared";
import { useCoverColor, useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { feel, useSettings } from "../stores/settings";
import { useZones } from "../stores/zones";
import { colors, MINI_PLAYER_HEIGHT, qualityColors, TAB_BAR_HEIGHT } from "../theme";
import { PlayerPage } from "./PlayerPage";
import { MenuSheet, SheetFrame, SheetHead } from "./Sheet";
import { useDownloadAction } from "./SongMenu";
import { TrackStrip, useTrackSwipe } from "./TrackStrip";
import { Cover } from "./ui";
import { T } from "../shared";

const SPRING = { stiffness: 300, damping: 34, mass: 1, overshootClamping: true, useNativeDriver: true };

const MINI_MARGIN = 8;
const MINI_COVER = 40;
const MINI_ROW = 56;
const MINI_BUTTON_ROOM = 88;
/** How much of the cards shows under the player's page. */
const PEEK = 32;
const COVER_SIDE = 23;
const COVER_RADIUS = 8;

const MINI_RADIUS = 4;
/** How dark the page beneath is under the player that has only just begun to go down (PullDownView.kt has the same). */
const SHADE = 0.6;

const QUALITIES: { mode: QualityMode; title: string; line: string }[] = [
  { mode: "auto", title: T("Automatic"), line: T("The best your connection carries, on mobile data up to AAC 256 kbps") },
  { mode: "original", title: T("Original"), line: T("Always the file itself, nothing converted") },
  { mode: "compact", title: T("Compact"), line: T("A small copy (128 kbps) that saves data") },
];

/** Past the end of the page the finger pulls against a spring. */
const pageAt = (y: number, max: number): number => (y >= 0 ? 0 : y < -max ? -max + (y + max) * 0.3 : y);

/** How far a flick carries the page, per unit of its speed; so much that a good one crosses a screen. */
const FLICK_CARRIES_MS = 330;
/** This close under the top it may as well be at the top. */
const PAGE_TOP_SNAP = 28;
/** How tall Android's gesture area at the bottom is at least, when the insets don't say. */
const MIN_GESTURE_EDGE = 24;
const GESTURE_EDGE_MARGIN = 8;

function MiniProgress() {
  const part = usePlayer((s) => (s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : 0));
  return (
    <View style={styles.progressTrack}>
      <View style={[styles.progressFill, { width: `${part * 100}%` }]} />
    </View>
  );
}

function MiniPlayer({ width, onOpen }: { width: number; onOpen: () => void }) {
  const track = usePlayer((s) => s.queue[s.index]);
  const playWhenReady = usePlayer((s) => s.playWhenReady);
  const toggle = usePlayer((s) => s.toggle);
  const remote = usePlayer((s) => s.remote);
  const device = usePlayer((s) => s.device);
  const elsewhere = device?.name ?? remote?.name;
  const nav = useNavigation<any>();
  const color = useCoverColor(track?.thumb);
  const stripWidth = width - MINI_MARGIN * 2 - MINI_BUTTON_ROOM;
  const swipe = useTrackSwipe(stripWidth);
  return (
    <View style={[styles.mini, { backgroundColor: tinted(color, 0.2) }]}>
      <View style={styles.miniRow}>
        <View {...swipe.panHandlers} style={styles.miniStrip}>
          <TrackStrip width={stripWidth}>
            {(t) => (
              <Pressable onPress={onOpen} style={styles.miniOpen} accessibilityLabel={T("Open the player")}>
                <Cover uri={t.thumb} size={MINI_COVER} radius={MINI_RADIUS} />
                <View style={styles.miniText}>
                  <Text numberOfLines={1} style={styles.miniTitle}>
                    {t.title}
                  </Text>
                  <Text numberOfLines={1} style={[styles.miniArtist, !!elsewhere && styles.miniElsewhere]}>
                    {elsewhere ? T("On {elsewhere} · {artist}", { elsewhere, artist: t.artist }) : t.artist}
                  </Text>
                </View>
              </Pressable>
            )}
          </TrackStrip>
        </View>
        <Pressable onPress={() => nav.navigate("Devices")} style={styles.miniDevices} accessibilityLabel={T("Devices")}>
          {device?.tv ? <Tv size={21} color={elsewhere ? colors.accent : colors.ink} /> : <Speaker size={21} color={elsewhere ? colors.accent : colors.ink} />}
        </Pressable>
        <Pressable
          onPress={() => {
            feel("tick");
            toggle();
          }}
          style={styles.miniButton}
          accessibilityLabel={playWhenReady ? T("Pause") : T("Play")}
        >
          {playWhenReady ? <Pause size={24} color={colors.ink} fill={colors.ink} /> : <Play size={24} color={colors.ink} fill={colors.ink} />}
        </Pressable>
      </View>
      <MiniProgress />
    </View>
  );
}

export function PlayerSheet({
  progress,
  expanded,
  setExpanded,
  goTo,
}: {
  progress: Animated.Value;
  expanded: boolean;
  setExpanded: (open: boolean) => void;
  /** a page in the tab showing under the sheet */
  goTo: (screen: string, params: object) => void;
}) {
  const nav = useNavigation<any>();
  const { width, height } = useSafeAreaFrame();
  const insets = useSafeAreaInsets();
  const track = usePlayer((s) => s.queue[s.index]);
  const hasTrack = !!track;
  const color = useCoverColor(track?.thumb);
  const pageY = useRef(new Animated.Value(0, { useNativeDriver: true })).current;
  const settleRef = useRef<((open: boolean) => void) | null>(null);
  const [coverArea, setCoverArea] = useState({ y: insets.top + 46, height: width });
  const [menu, setMenu] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const quality = usePlayer((s) => s.quality);
  const setQuality = usePlayer((s) => s.setQuality);
  const audio = usePlayer((s) => s.audio);
  const stream = usePlayer((s) => s.stream);
  const muted = useLibrary((s) => !!track && s.muted.has(track.id));
  const download = useDownloadAction(track);

  const collapsedY = height - TAB_BAR_HEIGHT - insets.bottom - MINI_PLAYER_HEIGHT;
  const geometry = useRef({ travel: height, pageMax: 0, gestureEdge: height });
  geometry.current.travel = height;
  // Along the bottom edge starts Android's own gesture: a touch from there is none of the player's business.
  geometry.current.gestureEdge = height - Math.max(insets.bottom, MIN_GESTURE_EDGE) - GESTURE_EDGE_MARGIN;
  const isOpen = useRef(false);
  /** where the page came to rest: at the top, or down at the cards */
  const pageRest = useRef(0);
  const from = useRef({ sheet: 0, page: 0 });
  /** A flick still under way. */
  const gliding = useRef<{ from: number; to: number; at: number; ms: number } | null>(null);
  /** How far the finger had come when the drag was recognised: the gesture counts from zero after that. */
  const caught = useRef(0);

  const settlePage = useCallback(
    (to: number, velocity = 0) => {
      pageRest.current = to;
      gliding.current = null;
      Animated.spring(pageY, { ...SPRING, toValue: to, velocity }).start();
    },
    [pageY]
  );

  /** The page scrolls freely: a flick goes on and slows down, at the speed the finger left it, and stops at either end. */
  const glidePage = useCallback(
    (y: number, vy: number) => {
      const { pageMax } = geometry.current;
      const at = pageAt(y, pageMax);
      const ahead = Math.max(-pageMax, Math.min(0, at + vy * FLICK_CARRIES_MS));
      const to = ahead > -PAGE_TOP_SNAP ? 0 : ahead;
      // Easing out by this curve starts at three times the average speed.
      const ms = Math.max(180, Math.min(1000, (3 * Math.abs(to - at)) / Math.max(0.3, Math.abs(vy))));
      pageRest.current = to;
      gliding.current = { from: at, to, at: Date.now(), ms };
      Animated.timing(pageY, { toValue: to, duration: ms, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    },
    [pageY]
  );

  /** Where the page stands this moment, flick or not: the native side's own answer only comes with the next move. */
  const pageNow = useCallback((): number => {
    const glide = gliding.current;
    if (!glide) return pageRest.current;
    const part = Math.min(1, (Date.now() - glide.at) / glide.ms);
    return glide.from + (glide.to - glide.from) * (1 - (1 - part) ** 3);
  }, []);

  // Choosing music for a device: down with the page, so there's something to choose from.
  const picking = useZones((s) => !!s.pickingFor);
  useEffect(() => {
    if (picking) settleRef.current?.(false);
  }, [picking]);

  const settle = useCallback(
    (open: boolean, velocity = 0) => {
      if (isOpen.current !== open) feel("tick");
      isOpen.current = open;
      setExpanded(open);
      if (useSettings.getState().reduceMotion) progress.setValue(open ? 1 : 0);
      else Animated.spring(progress, { ...SPRING, toValue: open ? 1 : 0, velocity }).start();
      if (!open && pageRest.current !== 0) settlePage(0);
    },
    [progress, setExpanded, settlePage]
  );
  settleRef.current = settle;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_, g) => {
          caught.current = g.dy;
          if (g.moveY - g.dy >= geometry.current.gestureEdge) return false;
          if (Math.abs(g.dy) <= 10 || Math.abs(g.dy) <= Math.abs(g.dx) * 1.5) return false;
          return isOpen.current || g.dy < 0;
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          from.current = { sheet: isOpen.current ? 1 : 0, page: pageNow() };
          gliding.current = null;
          // Caught on its way: from wherever it is now.
          progress.stopAnimation((value) => (from.current.sheet = value));
          pageY.stopAnimation((value) => (from.current.page = value));
        },
        onPanResponderMove: (_, g) => {
          const { travel, pageMax } = geometry.current;
          const dy = caught.current + g.dy;
          if (from.current.page < -0.5) {
            // Down at the cards this drag only scrolls, back to the top at most.
            pageY.setValue(pageAt(from.current.page + dy, pageMax));
            return;
          }
          const sheet = from.current.sheet - dy / travel;
          progress.setValue(Math.max(0, Math.min(1, sheet)));
          // Pushed up past fully open: the page itself goes on.
          pageY.setValue(pageAt((1 - sheet) * travel, pageMax));
        },
        onPanResponderRelease: (_, g) => {
          const { travel } = geometry.current;
          const dy = caught.current + g.dy;
          const sheet = from.current.sheet - dy / travel;
          if (from.current.page < -0.5 || sheet > 1) {
            glidePage(from.current.page < -0.5 ? from.current.page + dy : (1 - sheet) * travel, g.vy);
            return;
          }
          // Where the finger was headed a moment on: a flick counts like a long drag.
          const ahead = sheet - (g.vy * 200) / travel;
          settle(ahead > (isOpen.current ? 0.8 : 0.2), (-g.vy * 1000) / travel);
        },
        // Android took the touch over: everything back where it rested, or the next drag would only bring the page home.
        onPanResponderTerminate: () => {
          settle(isOpen.current);
          if (isOpen.current) settlePage(pageRest.current);
        },
      }),
    [glidePage, pageNow, pageY, progress, settle, settlePage]
  );

  const swipe = useTrackSwipe(width);

  // The system's back closes the player; a sheet opened over it goes first.
  useEffect(() => {
    if (!expanded) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (nav.getState()?.routes.length > 1) return false;
      settle(false);
      return true;
    });
    return () => sub.remove();
  }, [expanded, nav, settle]);

  // Nothing left to show: the queue was emptied.
  useEffect(() => {
    if (!hasTrack && isOpen.current) settle(false);
  }, [hasTrack, settle]);

  const coverSize = Math.max(120, Math.min(width - COVER_SIDE * 2, coverArea.height));
  const coverTop = coverArea.y + (coverArea.height - coverSize) / 2;

  const pageTop = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), [progress, height]);
  // What lies beneath is darkened while the player is over it: least when it has gone down the furthest, as under the pages that close with a pull.
  const shade = useMemo(() => progress.interpolate({ inputRange: [0, 1], outputRange: [0, SHADE] }), [progress]);

  const renderCover = useCallback(
    (t: Track) => (
      <View style={styles.coverPage}>
        <Cover uri={t.thumb} size={coverSize} radius={COVER_RADIUS} />
      </View>
    ),
    [coverSize]
  );

  const open = useCallback(() => settle(true), [settle]);
  const close = useCallback(() => settle(false), [settle]);
  const openPage = useCallback(
    (screen: string, params: object) => {
      setMenu(false);
      settle(false);
      goTo(screen, params);
    },
    [goTo, settle]
  );

  if (!track) return null;
  const albumKey = albumKeyOf(track);
  const format = describePlayback(track);
  const playing = playingNow(stream, format);
  const isTheFile = stream.kind === "original" || (stream.kind === "download" && !stream.compact);

  return (
    <>
      <View {...pan.panHandlers} pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        <View
          pointerEvents={expanded ? "none" : "box-none"}
          importantForAccessibility={expanded ? "no-hide-descendants" : "auto"}
          accessibilityElementsHidden={expanded}
          style={[styles.miniLayer, { top: collapsedY }]}
        >
          <MiniPlayer width={width} onOpen={open} />
        </View>

        <Animated.View pointerEvents="none" style={[styles.shade, { opacity: shade }]} />

        <Animated.View
          pointerEvents={expanded ? "auto" : "none"}
          importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
          accessibilityElementsHidden={!expanded}
          style={[StyleSheet.absoluteFill, { transform: [{ translateY: pageTop }] }]}
        >
          <View pointerEvents="none" style={styles.back}>
            <LinearGradient colors={[tinted(color, 0.24), tinted(color, 0.16), "#121212"]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
          </View>

          <Animated.View style={[styles.page, { transform: [{ translateY: pageY }] }]}>
            <PlayerPage
              height={height - PEEK}
              expanded={expanded}
              swipe={swipe.panHandlers}
              onClose={close}
              onMenu={() => setMenu(true)}
              onQuality={() => setQualityOpen(true)}
              onContext={(page) => openPage(page.screen, page.params)}
              onAlbum={(key) => openPage("Album", { albumKey: key })}
              onArtist={(t) => openPage("Artist", { name: leadArtist(t.artist) })}
              onCoverArea={(y, h) => setCoverArea((a) => (a.y === y && a.height === h ? a : { y, height: h }))}
              onCardsHeight={(h) => {
                geometry.current.pageMax = Math.max(0, h - PEEK);
                if (pageRest.current < -geometry.current.pageMax) settlePage(-geometry.current.pageMax);
              }}
            />
          </Animated.View>

          <Animated.View
            {...swipe.panHandlers}
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={[styles.bigCover, { top: coverTop, height: coverSize, transform: [{ translateY: pageY }] }]}
          >
            <TrackStrip width={width}>{renderCover}</TrackStrip>
          </Animated.View>

          {/* What scrolls up fades out before the clock and the battery. */}
          <LinearGradient
            pointerEvents="none"
            colors={[tinted(color, 0.24), tinted(color, 0.24), seeThrough(tinted(color, 0.24))]}
            locations={[0, 0.7, 1]}
            style={[styles.statusFade, { height: insets.top + 16 }]}
          />
        </Animated.View>
      </View>

      <MenuSheet
        visible={menu}
        art={<Cover uri={track.thumb} size={46} />}
        title={track.title}
        subtitle={track.artist}
        onClose={() => setMenu(false)}
        rows={[
          { label: T("Add to playlist"), Icon: ListPlus, run: () => usePlaylists.getState().setPicking(track) },
          ...(download ? [{ label: download.label, Icon: CircleArrowDown, run: download.run }] : []),
          { label: T("Quality: {title}", { title: QUALITIES.find((q) => q.mode === quality)?.title }), Icon: AudioLines, run: () => setQualityOpen(true) },
          { label: muted ? T("Play again (unmute)") : T("Mute song"), Icon: muted ? Volume2 : VolumeX, run: () => void useLibrary.getState().toggleMuted(track) },
          ...(track.album && albumKey ? [{ label: T("Go to album"), Icon: Disc3, run: () => openPage("Album", { albumKey }) }] : []),
          { label: T("Go to artist"), Icon: User, run: () => openPage("Artist", { name: leadArtist(track.artist) }) },
        ]}
      />

      <SheetFrame visible={qualityOpen} onClose={() => setQualityOpen(false)}>
        <SheetHead title={T("Quality")} />
        {!!playing && (
          <Text style={[styles.playingLine, { color: qualityColors[playing.tier] }]}>{T("Playing now: {value}", { value: isTheFile && format ? `${format.hiRes ? "Hi-Res " : ""}${formatLine(format)}` : playing.text })}
          </Text>
        )}
        {QUALITIES.map((q) => (
          <Pressable
            key={q.mode}
            accessibilityState={{ selected: quality === q.mode }}
            android_ripple={{ color: "rgba(255,255,255,0.08)" }}
            style={styles.qualityRow}
            onPress={() => {
              feel("tick");
              setQuality(q.mode);
              setQualityOpen(false);
            }}
          >
            <View style={styles.qualityText}>
              <Text style={[styles.menuText, quality === q.mode && { color: colors.accent }]}>{q.title}</Text>
              <Text style={styles.qualityLine}>{q.line}</Text>
            </View>
            {quality === q.mode && <Check size={20} color={colors.accent} />}
          </Pressable>
        ))}
        {!!audio && <Text style={styles.audioLine}>{audio}</Text>}
      </SheetFrame>
    </>
  );
}

const styles = StyleSheet.create({
  back: { ...StyleSheet.absoluteFill, backgroundColor: "#121212" },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: "#000" },
  page: { position: "absolute", left: 0, right: 0, top: 0 },
  bigCover: { position: "absolute", left: 0, right: 0, overflow: "hidden" },
  statusFade: { position: "absolute", left: 0, right: 0, top: 0 },
  coverPage: { flex: 1, alignItems: "center" },
  miniLayer: { position: "absolute", left: 0, right: 0 },
  mini: { marginHorizontal: MINI_MARGIN, borderRadius: 8, overflow: "hidden" },
  miniRow: { flexDirection: "row", alignItems: "center", height: MINI_ROW, paddingRight: 4 },
  miniStrip: { flex: 1, minWidth: 0, height: MINI_ROW, overflow: "hidden" },
  miniOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: 8 },
  miniText: { flex: 1, minWidth: 0, paddingRight: 8 },
  miniTitle: { color: colors.ink, fontSize: 13.5, fontWeight: "600" },
  miniArtist: { color: "rgba(255,255,255,0.78)", fontSize: 12.5, marginTop: 2 },
  miniElsewhere: { color: colors.accent, fontWeight: "600" },
  miniDevices: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  miniButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  progressTrack: { height: 2, marginHorizontal: 8, backgroundColor: "rgba(255,255,255,0.25)" },
  progressFill: { height: 2, backgroundColor: colors.ink },
  menuText: { color: colors.ink, fontSize: 15.5 },
  playingLine: { fontSize: 13, fontWeight: "600", paddingHorizontal: 18, paddingTop: 6, paddingBottom: 6 },
  qualityRow: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 62, paddingHorizontal: 18 },
  qualityText: { flex: 1, minWidth: 0 },
  qualityLine: { color: colors.dim, fontSize: 13, marginTop: 2 },
  audioLine: { color: colors.dim, fontSize: 11, paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4 },
});
