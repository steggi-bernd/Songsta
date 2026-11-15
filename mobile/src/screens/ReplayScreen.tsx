/**
 * Replay on the phone, after the computer's page (src/views/ReplayView.tsx): the period, loud, over
 * its top albums fanned out; the album of the period tilted in its own colours; five songs as a row
 * of cards; the period's pulse as records on a wave; the artists as tilted cards; a ticket to end.
 * Counted from what this phone played (stores/listens.ts), nothing estimated.
 */
import { useNavigation } from "@react-navigation/native";
import { ChevronDown } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PullDownToClose } from "../components/PullDownToClose";
import { Chip, Cover, picture } from "../components/ui";
import { T } from "../shared";
import { useLibrary } from "../stores/library";
import { summarize, useListens, type ReplayPeriod } from "../stores/listens";
import { usePlayer } from "../stores/player";
import { colors, PAGE_END } from "../theme";

const PERIODS: { key: ReplayPeriod; label: string }[] = [
  { key: "month", label: T("This month") },
  { key: "lastMonth", label: T("Last month") },
  { key: "year", label: T("This year") },
  { key: "all", label: T("All time") },
];

function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  return `${h < 10 ? h.toFixed(1) : Math.round(h)} hrs`;
}

function Headline({ first, accent, right }: { first: string; accent: string; right?: boolean }) {
  return (
    <View style={right ? styles.right : undefined}>
      <Text style={[styles.headline, right && styles.textRight]}>{first}</Text>
      <Text style={[styles.headline, styles.headlineAccent, right && styles.textRight]}>{accent}</Text>
    </View>
  );
}

function Number({ value, label }: { value: string; label: string }) {
  return (
    <View>
      <Text style={styles.number}>{value}</Text>
      <Text style={styles.numberLabel}>{label}</Text>
    </View>
  );
}

export function ReplayScreen() {
  const nav = useNavigation<any>();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [period, setPeriod] = useState<ReplayPeriod>("month");
  const listens = useListens((s) => s.listens);
  const data = useMemo(() => summarize(listens, period), [listens, period]);
  const has = data.totalMs > 0 || data.plays > 0;

  const periodName = period === "month" ? T("This month") : period === "lastMonth" ? T("Last month") : period === "year" ? String(new Date().getFullYear()) : T("All of it");
  const minutes = Math.round(data.totalMs / 60000);
  const topAlbum = data.albums[0];
  const flow = data.albums.filter((a) => a.thumb).slice(0, 5);
  const maxPulse = Math.max(1, ...data.pulse.map((p) => p.ms));
  const pulseCovers = flow.length ? flow.map((a) => a.thumb) : data.tracks.map((t) => t.thumb).filter(Boolean);
  const pulseWidth = width - 44;

  const play = (index: number): void => {
    const all = useLibrary.getState().data.tracks;
    const songs = data.tracks.map((t) => all.find((x) => x.id === t.id)).filter((t): t is NonNullable<typeof t> => !!t);
    const wanted = data.tracks[index].id;
    const at = songs.findIndex((t) => t.id === wanted);
    if (at >= 0) usePlayer.getState().playTracks(songs, at, T("Replay"));
  };

  return (
    <PullDownToClose onClose={() => nav.goBack()}>
      <ScrollView contentContainerStyle={{ paddingBottom: PAGE_END + insets.bottom }} showsVerticalScrollIndicator={false}>
        {/* The opening */}
        <View style={styles.opening}>
          {!!topAlbum?.thumb && <Image source={picture(topAlbum.thumb)} blurRadius={40} style={[StyleSheet.absoluteFill, styles.backdrop]} />}
          <View style={[styles.pad, { paddingTop: insets.top + 6 }]}>
            <View style={styles.topRow}>
              <Pressable onPress={() => nav.goBack()} accessibilityLabel={T("Close")} hitSlop={8} style={styles.close}>
                <ChevronDown size={28} color={colors.ink} />
              </Pressable>
              <Text style={styles.brand}>{T("SONGSTA REPLAY")}</Text>
            </View>
            <Text style={styles.opener}>{has ? T("{period} was", { period: periodName }) : periodName}</Text>
            <Text style={[styles.opener, styles.headlineAccent]}>{has ? T("loud.") : T("still quiet.")}</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.periods}>
            {PERIODS.map((p) => (
              <Chip key={p.key} label={p.label} active={p.key === period} onPress={() => setPeriod(p.key)} />
            ))}
          </ScrollView>

          {!has && <Text style={styles.empty}>{T("Play something first — Replay fills in as this phone counts what you listen to.")}</Text>}

          {has && flow.length >= 3 && (
            <View style={styles.flow}>
              {flow.map((a, i) => {
                const off = i - (flow.length - 1) / 2;
                const size = Math.round(width * 0.42 - Math.abs(off) * 34);
                return (
                  <View key={a.name + i} style={{ marginLeft: i === 0 ? 0 : -26, zIndex: 10 - Math.abs(Math.round(off)), opacity: 1 - Math.abs(off) * 0.14, transform: [{ perspective: 900 }, { rotateY: `${Math.round(-off * 24)}deg` }] }}>
                    <Cover uri={a.thumb} size={size} radius={10} />
                  </View>
                );
              })}
            </View>
          )}
          {has && (
            <View style={[styles.pad, styles.numbers]}>
              <Number value={minutes.toLocaleString()} label={T("MINUTES")} />
              <Number value={data.plays.toLocaleString()} label={T("PLAYS")} />
              <Number value={String(data.artists.length)} label={T("ARTISTS")} />
            </View>
          )}
        </View>

        {has && (
          <>
            {/* N°1 */}
            {!!topAlbum && (
              <View style={styles.first}>
                {!!topAlbum.thumb && <Image source={picture(topAlbum.thumb)} blurRadius={36} style={[StyleSheet.absoluteFill, styles.firstBackdrop]} />}
                <Text style={styles.firstMark}>N°1</Text>
                <View style={styles.firstCover}>
                  <Cover uri={topAlbum.thumb} size={Math.round(width * 0.62)} radius={12} />
                </View>
                <Text style={styles.firstTitle}>{topAlbum.name}</Text>
                <View style={styles.firstTag}>
                  <Text style={styles.firstTagText}>{[topAlbum.sub, fmtHours(topAlbum.ms)].filter(Boolean).join(" — ")}</Text>
                </View>
              </View>
            )}

            {/* Five songs */}
            {data.tracks.length > 0 && (
              <View style={styles.section}>
                <View style={styles.pad}>
                  <Headline first={T("Five you")} accent={T("couldn't stop.")} />
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cards}>
                  {data.tracks.slice(0, 5).map((t, i) => (
                    <Pressable key={t.id ?? i} onPress={() => play(i)} accessibilityLabel={T("Play {title}", { title: t.name })} style={[styles.card, { transform: [{ rotate: `${[-5, 3, -2, 4, -3][i]}deg` }, { translateY: [8, -4, 6, -6, 4][i] }] }]}>
                      <Cover uri={t.thumb} size={190} radius={0} />
                      <Text style={styles.cardRank}>{i + 1}</Text>
                      <View style={styles.cardText}>
                        <Text numberOfLines={1} style={styles.cardTitle}>{t.name}</Text>
                        <Text numberOfLines={1} style={styles.cardSub}>{t.sub}</Text>
                        <Text style={styles.cardPlays}>{t.plays === 1 ? T("1 play") : T("{count} plays", { count: t.plays })}</Text>
                      </View>
                    </Pressable>
                  ))}
                </ScrollView>
              </View>
            )}

            {/* The pulse */}
            {data.pulse.length > 2 && (
              <View style={[styles.section, styles.band]}>
                <View style={styles.pad}>
                  <Headline first={T("It had a")} accent={T("pulse.")} />
                  <Text style={styles.note}>{T("The bigger the record, the more played then.")}</Text>
                </View>
                <View style={[styles.pulse, { width: pulseWidth }]}>
                  {data.pulse.map((p, i) => {
                    const share = p.ms / maxPulse;
                    const size = Math.round(26 + share * 64);
                    const peak = p.ms === maxPulse;
                    return (
                      <View key={p.label + i} style={[styles.pulseItem, { left: 8 + (i * (pulseWidth - 16)) / Math.max(1, data.pulse.length - 1) - 40, top: Math.round(150 - share * 90 + Math.sin(i * 1.3) * 8) - size / 2 }]}>
                        <View style={[peak && styles.peak, { borderRadius: size }]}>
                          <Cover uri={pulseCovers.length ? pulseCovers[i % pulseCovers.length] : undefined} size={size} radius={size} />
                        </View>
                        <Text numberOfLines={1} style={[styles.pulseLabel, peak && { color: colors.accent }]}>{p.label}</Text>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* The faces */}
            {data.artists.length > 0 && (
              <View style={styles.section}>
                <View style={styles.pad}>
                  <Headline right first={T("The faces")} accent={`${T("of")} ${T("it all.")}`} />
                </View>
                <View style={styles.faces}>
                  {data.artists.slice(0, 4).map((a, i) => {
                    const size = Math.round(width * [0.4, 0.3, 0.25, 0.21][i]);
                    return (
                      <View key={a.name} style={{ marginLeft: i === 0 ? 0 : -22, zIndex: 5 - i, transform: [{ rotate: `${[-4, 5, -6, 7][i]}deg` }, { translateY: [0, -18, 8, -26][i] }] }}>
                        <Cover uri={a.thumb} size={size} radius={12} />
                        <View style={[styles.faceTag, i === 0 && styles.faceTagFirst]}>
                          <Text numberOfLines={1} style={[styles.faceTagText, i === 0 && styles.faceTagTextFirst, { maxWidth: size }]}>
                            {i + 1} · {a.name}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {/* The ticket */}
            <View style={[styles.section, styles.band, styles.pad]}>
              <Headline first={T("Same seat")} accent={T("next time?")} />
              <View style={styles.ticket}>
                <Cover uri={topAlbum?.thumb} size={118} radius={0} />
                <View style={styles.stub}>
                  <Text style={styles.stubBrand}>{T("ADMIT ONE · SONGSTA REPLAY")}</Text>
                  <Text numberOfLines={1} adjustsFontSizeToFit style={styles.stubPeriod}>{periodName}</Text>
                  <Text style={styles.stubLine}>{T("{minutes} minutes · {plays} plays", { minutes: minutes.toLocaleString(), plays: data.plays.toLocaleString() })}</Text>
                  {!!data.artists[0] && <Text numberOfLines={1} style={styles.stubLine}>{T("Headliner: {name}", { name: data.artists[0].name })}</Text>}
                </View>
              </View>
              <Text style={styles.note}>{T("Counted on this phone only, since Replay arrived here.")}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </PullDownToClose>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 22 },
  opening: { overflow: "hidden", paddingBottom: 26 },
  backdrop: { opacity: 0.38 },
  topRow: { flexDirection: "row", alignItems: "center", gap: 8, marginLeft: -6 },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  brand: { color: colors.accent, fontSize: 12, fontWeight: "900", letterSpacing: 3.4 },
  opener: { color: colors.ink, fontSize: 60, lineHeight: 58, fontWeight: "900", letterSpacing: -3, paddingTop: 6 },
  headline: { color: colors.ink, fontSize: 46, lineHeight: 46, fontWeight: "900", letterSpacing: -2.2 },
  headlineAccent: { color: colors.accent, fontStyle: "italic" },
  right: { alignItems: "flex-end" },
  textRight: { textAlign: "right" },
  periods: { paddingHorizontal: 22, gap: 8, paddingTop: 18 },
  empty: { color: colors.dim, fontSize: 15, lineHeight: 21, paddingHorizontal: 22, paddingTop: 26 },
  flow: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingTop: 26, height: 220 },
  numbers: { flexDirection: "row", gap: 28, paddingTop: 22, flexWrap: "wrap" },
  number: { color: colors.ink, fontSize: 34, fontWeight: "900", letterSpacing: -1.2 },
  numberLabel: { color: colors.dim, fontSize: 10.5, fontWeight: "800", letterSpacing: 1.8 },
  first: { overflow: "hidden", paddingHorizontal: 22, paddingTop: 34, paddingBottom: 40, backgroundColor: "#111" },
  firstBackdrop: { opacity: 0.6 },
  firstMark: { color: "rgba(255,255,255,0.28)", fontSize: 110, lineHeight: 104, fontWeight: "900", letterSpacing: -4 },
  firstCover: { marginTop: -34, marginLeft: -40, transform: [{ rotate: "-8deg" }], elevation: 18 },
  firstTitle: { color: colors.ink, fontSize: 52, lineHeight: 50, fontWeight: "900", letterSpacing: -2.6, marginTop: 6 },
  firstTag: { alignSelf: "flex-start", backgroundColor: "#0b0b0d", paddingHorizontal: 12, paddingVertical: 7, marginTop: 14, transform: [{ rotate: "2deg" }] },
  firstTagText: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  section: { paddingTop: 48, paddingBottom: 30 },
  band: { backgroundColor: "#101013" },
  note: { color: colors.dim, fontSize: 14, lineHeight: 20, marginTop: 12 },
  cards: { paddingHorizontal: 22, paddingTop: 30, paddingBottom: 18, gap: 14 },
  card: { width: 190, borderRadius: 16, overflow: "hidden", backgroundColor: "#17171b", elevation: 12 },
  cardRank: { position: "absolute", left: 10, top: -4, color: colors.ink, fontSize: 84, fontWeight: "900", letterSpacing: -4, textShadowColor: "rgba(0,0,0,0.8)", textShadowRadius: 18, textShadowOffset: { width: 0, height: 4 } },
  cardText: { paddingHorizontal: 14, paddingTop: 11, paddingBottom: 14 },
  cardTitle: { color: colors.ink, fontSize: 18, fontWeight: "900", letterSpacing: -0.4 },
  cardSub: { color: colors.dim, fontSize: 13 },
  cardPlays: { color: colors.accent, fontSize: 13, fontWeight: "800", marginTop: 6 },
  pulse: { height: 240, alignSelf: "center", marginTop: 14 },
  pulseItem: { position: "absolute", width: 80, alignItems: "center" },
  peak: { borderWidth: 4, borderColor: colors.accent },
  pulseLabel: { color: "#71717a", fontSize: 10, fontWeight: "900", letterSpacing: 1, marginTop: 6, textTransform: "uppercase" },
  faces: { flexDirection: "row", alignItems: "flex-end", justifyContent: "center", paddingTop: 44, paddingBottom: 14 },
  faceTag: { position: "absolute", left: -6, bottom: 10, backgroundColor: "#fff", paddingHorizontal: 7, paddingVertical: 3 },
  faceTagFirst: { backgroundColor: colors.accent, bottom: 16 },
  faceTagText: { color: "#0b0b0d", fontSize: 10.5, fontWeight: "900" },
  faceTagTextFirst: { fontSize: 14 },
  ticket: { flexDirection: "row", alignSelf: "center", marginTop: 30, borderRadius: 14, overflow: "hidden", transform: [{ rotate: "3deg" }], elevation: 14 },
  stub: { width: 196, height: 118, backgroundColor: "#f4f1ea", paddingHorizontal: 14, paddingVertical: 10, borderLeftWidth: 2, borderLeftColor: "#0b0b0d", borderStyle: "dashed" },
  stubBrand: { color: "#0b0b0d", fontSize: 7.5, fontWeight: "900", letterSpacing: 1.6 },
  stubPeriod: { color: "#0b0b0d", fontSize: 30, fontWeight: "900", letterSpacing: -1.4 },
  stubLine: { color: "#0b0b0d", fontSize: 10.5, fontWeight: "700", lineHeight: 15 },
});
