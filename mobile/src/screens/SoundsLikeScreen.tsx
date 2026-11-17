/**
 * Klingt wie on the phone (the user's pick from the mockups, 2026-11-16, "wheel and list"): the song on
 * top with its tempo, key and energy; under it half of the Camelot wheel DJs use, the key aimed at in
 * the middle — a swipe turns it to another key, a tap picks one; chips for the key or a mood (late at
 * night, focus, running, sunny); then the songs that fit, each with why, and "Mix from these" or "As a
 * playlist". The phone measures nothing itself: tempo and key come from the computer's media analysis
 * through the sync service (stores/soundShare.ts), and matching is the desktop's (src/lib/soundMatch.ts).
 */
import { useNavigation, useRoute } from "@react-navigation/native";
import { AudioWaveform, ChevronLeft, ListPlus, Play } from "lucide-react-native";
import { useMemo, useRef, useState } from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import Svg, { Path, Text as SvgText } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PullDownToClose } from "../components/PullDownToClose";
import { Cover } from "../components/ui";
import { camelotLabel, camelotOf, DEFAULT_MATCH, keyLabel, keyOfCamelot, matchSong, mixRules, ringSlice, songsInKey, type Camelot, type MatchResult, type SoundFacts, type Track } from "../shared";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { usePlaylists } from "../stores/playlists";
import { toast } from "../stores/popups";
import { feel } from "../stores/settings";
import { sharedSoundOf, useSoundShare } from "../stores/soundShare";
import { colors, PAGE_END } from "../theme";
import { T } from "../shared";

type Mode = "key" | "late" | "focus" | "run" | "sunlit";
interface Found {
  track: Track;
  facts: SoundFacts;
  result: MatchResult | null;
  score: number;
}

const ringColor = (n: number, ring: "A" | "B"): string => `hsl(${(n * 30 + 150) % 360}, 70%, ${ring === "B" ? 62 : 52}%)`;
const energyWord = (e: number): string => (e < 0.35 ? T("calm") : e < 0.65 ? T("lively") : T("driving"));

/**
 * A song as the card on top shows it: cover, name, who sings it, and its tempo, key and energy. The
 * song itself, or (the wheel turned to another key) one of yours in that key, shown the same way.
 */
function SongFace({ track, facts, eyebrow, playing }: { track: Track; facts: SoundFacts | undefined; eyebrow: string; playing: boolean }) {
  const key = facts && facts.key >= 0 ? camelotOf(facts.key, facts.minor) : null;
  return (
    <>
      <Cover uri={track.thumb} size={62} radius={8} />
      <View style={styles.songText}>
        <Text numberOfLines={1} style={styles.eyebrow}>
          {eyebrow}
        </Text>
        <Text numberOfLines={1} style={styles.songTitle}>
          {track.title}
        </Text>
        <Text numberOfLines={1} style={styles.songSub}>
          {playing ? `${track.artist} · ${T("playing")}` : track.artist}
        </Text>
        {facts && (
          <View style={styles.tags}>
            {facts.bpm > 0 && <Text style={styles.tag}>{T("{n} bpm", { n: Math.round(facts.bpm) })}</Text>}
            {key && <Text style={[styles.tag, styles.tagKey]}>{camelotLabel(key)}</Text>}
            <Text style={[styles.tag, styles.tagGold]}>{energyWord(facts.energy)}</Text>
          </View>
        )}
      </View>
    </>
  );
}

/** Why a song fits: the key's step on the wheel, and the tempo next to the aimed song's. */
function reasons(seed: Camelot | null, other: SoundFacts, result: MatchResult | null): string[] {
  const out: string[] = [];
  const c = camelotOf(other.key, other.minor);
  if (seed && c) {
    if (c.n === seed.n && c.ring === seed.ring) out.push(T("Same key"));
    else if (c.n === seed.n) out.push(T("Partner {key}", { key: camelotLabel(c) }));
    else if (result?.keyStep === 1) out.push(T("Neighbour {key}", { key: camelotLabel(c) }));
    else out.push(camelotLabel(c));
  }
  if (result?.tempoNote) out.push(result.tempoNote === "½" ? T("half time") : result.tempoNote === "2×" ? T("double time") : T("{n} bpm", { n: result.tempoNote }));
  return out;
}

export function SoundsLikeScreen() {
  const nav = useNavigation<any>();
  const { params } = useRoute<any>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const tracks = useLibrary((s) => s.tracks);
  const byId = useLibrary((s) => s.byId);
  const current = usePlayer((s) => s.queue[s.index] ?? null);
  const counts = useLibrary((s) => s.data.counts);
  // Re-read when the computer's measurements come in.
  const sounds = useSoundShare((s) => s.sounds);
  // Opened for the song playing, the page keeps it once a song is played to hear another key by.
  const [pinned, setPinned] = useState<string | null>(null);
  const fixed = params?.id ?? pinned;
  const seed: Track | null = (fixed ? byId.get(fixed) : null) ?? current;
  const seedFacts = seed ? sharedSoundOf(seed) : undefined;
  const seedKey = seedFacts && seedFacts.key >= 0 ? camelotOf(seedFacts.key, seedFacts.minor) : null;
  const [aim, setAim] = useState<Camelot | null>(null);
  const target = aim ?? seedKey;
  const [mode, setMode] = useState<Mode>("key");

  // Swiped sideways the wheel turns a key a step at a time; let go, the key stays aimed at.
  const [turn, setTurn] = useState(0);
  const turnRef = useRef(0);
  const targetRef = useRef<Camelot | null>(null);
  targetRef.current = target;
  const stepped = (c: Camelot, steps: number): Camelot => ({ n: ((((c.n - 1 + steps) % 12) + 12) % 12) + 1, ring: c.ring });
  const shown: Camelot | null = target ? stepped(target, turn) : null;
  const away = !!shown && !!seedKey && !(shown.n === seedKey.n && shown.ring === seedKey.ring);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => {
          const steps = -Math.round(g.dx / 38);
          if (steps === turnRef.current) return;
          turnRef.current = steps;
          feel("tick");
          setTurn(steps);
        },
        onPanResponderRelease: () => {
          const steps = turnRef.current;
          const base = targetRef.current;
          turnRef.current = 0;
          setTurn(0);
          if (steps && base) setAim(stepped(base, steps));
        },
        onPanResponderTerminate: () => {
          turnRef.current = 0;
          setTurn(0);
        },
      }),
    []
  );

  const aimed: SoundFacts | null = seedFacts && shown ? { ...seedFacts, ...keyOf(shown) } : (seedFacts ?? null);
  const found = useMemo<Found[]>(() => {
    if (!seed || !aimed) return [];
    const rule = mode === "key" ? null : mixRules(aimed).find((r) => r.id === mode);
    const out: Found[] = [];
    for (const t of tracks) {
      if (t.id === seed.id) continue;
      const f = sharedSoundOf(t);
      if (!f) continue;
      if (rule) {
        if (!rule.fits(f)) continue;
        const r = matchSong(aimed, f, { ...DEFAULT_MATCH, mode: "energy", energy: "any" });
        out.push({ track: t, facts: f, result: r, score: r?.score ?? 1 - Math.abs(f.energy - aimed.energy) });
      } else {
        const r = matchSong(aimed, f, DEFAULT_MATCH);
        if (r) out.push({ track: t, facts: f, result: r, score: r.score });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 40);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.id, tracks, mode, aimed?.key, aimed?.minor, aimed?.bpm, aimed?.energy]);

  // What the key the wheel shows sounds like: the song of yours in it you play most, in the song's place.
  const keyRef = useMemo<Track | null>(
    () => (shown ? (songsInKey(tracks, (t) => sharedSoundOf(t), shown, (t) => counts[t.id]?.plays ?? 0, 1, (t) => t.id === seed?.id)[0] ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown?.n, shown?.ring, tracks, counts, sounds, seed?.id]
  );

  const close = (): void => nav.goBack();
  const wheelH = 176;
  const scale = width / 390;
  const cx = width / 2;
  const cy = 196 * scale;
  const segments = shown
    ? Array.from({ length: 12 }, (_, i) => i + 1).flatMap((n) =>
        (["B", "A"] as const).map((ring) => {
          // The rings meet; ringSlice leaves the room between slices and rounds their corners (no outlines).
          const r1 = (ring === "B" ? 190 : 136) * scale;
          const r0 = (ring === "B" ? 136 : 82) * scale;
          const mid = (((n - shown.n + 18) % 12) - 6) * 30 - 90;
          const rad = (a: number): number => (a * Math.PI) / 180;
          const at = (r: number, a: number): [number, number] => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))];
          const [lx, ly] = at((r1 + r0) / 2, mid);
          const hot = n === shown.n && ring === shown.ring;
          const near = !hot && ((n === shown.n && ring !== shown.ring) || (ring === shown.ring && (Math.abs(n - shown.n) === 1 || Math.abs(n - shown.n) === 11)));
          return {
            key: `${n}${ring}`,
            n,
            ring,
            d: ringSlice(cx, cy, r0, r1, rad(mid - 15), rad(mid + 15), 6 * scale, 4.5 * scale),
            lx,
            ly: ly + 4,
            fill: ringColor(n, ring),
            opacity: hot ? 1 : near ? 0.75 : 0.22,
            ink: hot || near ? "#0B0B0D" : "rgba(255,255,255,0.55)",
          };
        })
      )
    : [];

  const playFound = (): void => {
    if (!found.length || !seed) return;
    feel("press");
    usePlayer.getState().playAll([seed, ...found.map((f) => f.track)], T("Sounds like {title}", { title: seed.title }), false);
  };
  const keepFound = (): void => {
    if (!found.length || !seed) return;
    const lists = usePlaylists.getState();
    const id = lists.create(T("Sounds like {title}", { title: seed.title }));
    for (const f of [seed, ...found.map((x) => x.track)]) lists.addTrack(id, f);
    toast(T("Saved as “{name}”", { name: T("Sounds like {title}", { title: seed.title }) }));
  };

  const head = (
    <View style={[styles.top, { paddingTop: insets.top + 6 }]}>
      <Pressable onPress={close} accessibilityLabel={T("Go back")} style={styles.topButton}>
        <ChevronLeft size={28} color={colors.ink} />
      </Pressable>
      <Text style={styles.topTitle}>{T("Sounds like")}</Text>
      <View style={styles.topButton} />
    </View>
  );

  if (!seed || !seedFacts) {
    return (
      <PullDownToClose onClose={close}>
        <View style={styles.root}>
          {head}
          <View style={styles.empty}>
            <AudioWaveform size={34} color={colors.dim} />
            <Text style={styles.emptyTitle}>{seed ? T("“{title}” isn't measured yet", { title: seed.title }) : T("Play a song first")}</Text>
            <Text style={styles.emptyBody}>
              {seed
                ? T("Songsta measures tempo and key on your computer (Settings → Media analysis) and shares them with this phone through your sync service.")
                : T("Klingt wie finds the songs in your library that sound like the one playing: by tempo, key and energy.")}
            </Text>
          </View>
        </View>
      </PullDownToClose>
    );
  }

  const chips: { key: Mode; label: string }[] = [
    { key: "key", label: T("In {key}", { key: shown ? camelotLabel(shown) : "" }) },
    { key: "late", label: T("Late night") },
    { key: "focus", label: T("Focus") },
    { key: "run", label: T("Run") },
    { key: "sunlit", label: T("Sunlit") },
  ];

  return (
    <PullDownToClose onClose={close}>
      <ScrollView style={styles.root} contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }}>
        {head}
        {/* The song, or (the wheel turned to another key) one song of yours in that key, shown the same
            way in its place, to hear the key by; the card keeps its height either way. */}
        {away && shown ? (
          keyRef ? (
            <Pressable
              onPress={() => {
                feel("press");
                if (!params?.id) setPinned(seed.id);
                usePlayer.getState().playTracks([keyRef], 0, T("Sounds like {title}", { title: seed.title }));
              }}
              accessibilityLabel={T("Play {title}", { title: keyRef.title })}
              style={styles.song}
            >
              <SongFace
                track={keyRef}
                facts={sharedSoundOf(keyRef)}
                eyebrow={T("This is how {key} sounds", { key: `${camelotLabel(shown)} · ${keyLabel(keyOf(shown).key, keyOf(shown).minor)}` })}
                playing={current?.id === keyRef.id}
              />
              <View style={styles.songPlay}>
                <Play size={18} color={colors.onAccent} fill={colors.onAccent} style={{ marginLeft: 2 }} />
              </View>
            </Pressable>
          ) : (
            <View style={styles.song}>
              <View style={styles.keyStandIn}>
                <Text style={styles.keyStandInText}>{camelotLabel(shown)}</Text>
              </View>
              <View style={styles.songText}>
                <Text numberOfLines={1} style={styles.eyebrow}>
                  {T("This is how {key} sounds", { key: `${camelotLabel(shown)} · ${keyLabel(keyOf(shown).key, keyOf(shown).minor)}` })}
                </Text>
                <Text style={styles.refsNone}>{T("No song of yours in {key} is measured yet", { key: camelotLabel(shown) })}</Text>
              </View>
            </View>
          )
        ) : (
          <View style={styles.song}>
            <SongFace track={seed} facts={seedFacts} eyebrow={T("Sounds like")} playing={current?.id === seed.id} />
          </View>
        )}

        {shown && (
          <View style={{ height: wheelH, marginTop: 6, overflow: "hidden" }} {...pan.panHandlers}>
            <Svg width={width} height={wheelH}>
              {segments.map((s) => (
                <Path
                  key={s.key}
                  d={s.d}
                  fill={s.fill}
                  fillOpacity={s.opacity}
                  onPress={() => {
                    feel("tick");
                    setAim({ n: s.n, ring: s.ring });
                  }}
                />
              ))}
              {segments.map((s) => (
                <SvgText key={`l${s.key}`} x={s.lx} y={s.ly} textAnchor="middle" fontSize={12} fontWeight="800" fill={s.ink}>
                  {s.key}
                </SvgText>
              ))}
              <Path d={`M${cx} 8 l-7 -8 h14 z`} fill={colors.ink} />
            </Svg>
            <View pointerEvents="none" style={styles.wheelMiddle}>
              <Text style={[styles.wheelKey, { color: ringColor(shown.n, shown.ring) }]}>{camelotLabel(shown)}</Text>
              <Text style={styles.wheelHint}>{`${keyLabel(keyOf(shown).key, keyOf(shown).minor)} · ${T("swipe to turn")}`}</Text>
            </View>
          </View>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {chips.map((c) => (
            <Pressable key={c.key} onPress={() => setMode(c.key)} style={[styles.chip, mode === c.key && styles.chipOn]}>
              <Text style={[styles.chipText, mode === c.key && styles.chipTextOn]}>{c.label}</Text>
            </Pressable>
          ))}
        </ScrollView>

        <View style={styles.countRow}>
          <Text style={styles.count}>{found.length === 1 ? T("1 fits") : T("{count} fit", { count: found.length })}</Text>
          <Text numberOfLines={1} style={styles.countSub}>
            {mode === "key" ? T("{key} and its neighbours", { key: shown ? camelotLabel(shown) : "" }) : chips.find((c) => c.key === mode)?.label}
          </Text>
        </View>
        {found.length > 0 && (
          <View style={styles.actions}>
            <Pressable onPress={playFound} style={[styles.action, styles.actionMain]}>
              <Play size={16} color={colors.onAccent} fill={colors.onAccent} />
              <Text style={styles.actionMainText}>{T("Mix from these")}</Text>
            </Pressable>
            <Pressable onPress={keepFound} style={styles.action}>
              <ListPlus size={17} color={colors.ink} />
              <Text style={styles.actionText}>{T("As a playlist")}</Text>
            </Pressable>
          </View>
        )}

        {found.length === 0 && <Text style={styles.none}>{T("Nothing in your library fits this closely. Turn the wheel to a neighbour, or pick a mood.")}</Text>}
        {found.map((f, i) => (
          <Pressable
            key={f.track.id}
            onPress={() => usePlayer.getState().playTracks(found.map((x) => x.track), i, T("Sounds like {title}", { title: seed.title }))}
            style={styles.match}
          >
            <Cover uri={f.track.thumb} size={46} radius={6} />
            <View style={styles.matchText}>
              <Text numberOfLines={1} style={styles.matchTitle}>
                {f.track.title}
              </Text>
              <View style={styles.why}>
                {reasons(shown, f.facts, f.result).map((w) => (
                  <Text key={w} style={styles.whyChip}>
                    {w}
                  </Text>
                ))}
              </View>
            </View>
            <Text style={styles.percent}>{`${Math.round(f.score * 100)} %`}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </PullDownToClose>
  );
}

/** A place on the wheel as a key: 8A is A minor (A minor, B major), as the desktop counts it. */
const keyOf = (c: Camelot): { key: number; minor: boolean } => keyOfCamelot(c);

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.base },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 6, paddingBottom: 6 },
  topButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  topTitle: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  // One height for the song and for the one in another key, so turning the wheel moves nothing below.
  song: { flexDirection: "row", alignItems: "center", gap: 12, marginHorizontal: 16, padding: 10, height: 104, borderRadius: 16, backgroundColor: colors.panel },
  songText: { flex: 1, minWidth: 0 },
  eyebrow: { color: colors.accent, fontSize: 10.5, fontWeight: "800", letterSpacing: 1.1, textTransform: "uppercase", marginBottom: 1 },
  songTitle: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  songSub: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  songPlay: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  keyStandIn: { width: 62, height: 62, borderRadius: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.06)" },
  keyStandInText: { color: "rgba(255,255,255,0.4)", fontSize: 20, fontWeight: "900", letterSpacing: -0.5 },
  tags: { flexDirection: "row", gap: 5, marginTop: 6 },
  tag: { overflow: "hidden", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, fontSize: 11, fontWeight: "800", color: "#E5E5EA", backgroundColor: "rgba(255,255,255,0.08)" },
  tagKey: { color: "#5EEAD4", backgroundColor: "rgba(94,234,212,0.14)" },
  tagGold: { color: "#FBBF24", backgroundColor: "rgba(251,191,36,0.14)" },
  wheelMiddle: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center" },
  wheelKey: { fontSize: 40, fontWeight: "900", letterSpacing: -1, lineHeight: 42 },
  wheelHint: { color: colors.dim, fontSize: 11.5, fontWeight: "700", marginBottom: 2 },
  refsNone: { color: colors.dim, fontSize: 13, paddingTop: 4 },
  chips: { gap: 6, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
  chip: { height: 32, paddingHorizontal: 13, borderRadius: 16, justifyContent: "center", backgroundColor: colors.chip },
  chipOn: { backgroundColor: "rgba(167,139,250,0.2)" },
  chipText: { color: colors.ink, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: colors.accent },
  countRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 10, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 2 },
  count: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  countSub: { flexShrink: 1, color: colors.dim, fontSize: 12 },
  actions: { flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  action: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, height: 42, paddingHorizontal: 16, borderRadius: 21, backgroundColor: colors.chip },
  actionMain: { flex: 1, backgroundColor: colors.accent },
  actionText: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  actionMainText: { color: colors.onAccent, fontSize: 14, fontWeight: "800" },
  none: { color: colors.dim, fontSize: 14, lineHeight: 20, marginHorizontal: 16, marginTop: 14 },
  match: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 7 },
  matchText: { flex: 1, minWidth: 0 },
  matchTitle: { color: colors.ink, fontSize: 14, fontWeight: "700" },
  why: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  whyChip: { overflow: "hidden", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999, fontSize: 10, fontWeight: "800", color: "#C4B5FD", backgroundColor: "rgba(167,139,250,0.14)" },
  percent: { width: 46, textAlign: "right", color: "#34D399", fontSize: 13, fontWeight: "800" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, paddingBottom: 120, gap: 10 },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", textAlign: "center" },
  emptyBody: { color: colors.dim, fontSize: 14, lineHeight: 20, textAlign: "center" },
});
