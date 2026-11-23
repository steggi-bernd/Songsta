/**
 * Draft semantic Replay copy: complete, independently translatable messages in nine locales.
 * No run-time import: the current Replay screens still use legacy T("English").
 *
 * Use these keys in a future Replay copy-selection layer. Each story headline
 * is a complete sentence/phrase. NEVER concatenate translated grammatical
 * fragments (e.g. "Five you" + "couldn't stop.").
 */
import type { SupportedLocale } from "./i18n-next";

export type ReplayFlavor =
  | "introBalanced"
  | "introExploring"
  | "introFavorites"
  | "introLowActivity"
  | "topSongs"
  | "newDiscoveries"
  | "topArtist"
  | "genreFocus"
  | "peakHour"
  | "weekHighlight"
  | "outro";

type ReplayCatalog = Record<ReplayFlavor, string>;
export const REPLAY_HEADLINES: Record<SupportedLocale, ReplayCatalog> = {
  en: {
    introBalanced: "Your music. Your story.",
    introExploring: "A month full of discoveries.",
    introFavorites: "Some songs deserve another listen.",
    introLowActivity: "A quieter chapter. Still yours.",
    topSongs: "Your most played songs.",
    newDiscoveries: "A few new favorites.",
    topArtist: "{artist} was in the spotlight.",
    genreFocus: "Your sound leaned toward {genre}.",
    peakHour: "Your music hour was {time}.",
    weekHighlight: "{weekday} was your biggest music day.",
    outro: "Ready for another round?",
  },
  de: {
    introBalanced: "Deine Musik. Deine Geschichte.",
    introExploring: "Ein Monat voller Entdeckungen.",
    introFavorites: "Manche Songs gehen einfach immer.",
    introLowActivity: "Ein ruhigeres Kapitel. Trotzdem deins.",
    topSongs: "Deine meistgehörten Songs.",
    newDiscoveries: "Ein paar neue Lieblingssongs.",
    topArtist: "{artist} stand im Rampenlicht.",
    genreFocus: "Diesen Monat war {genre} besonders gefragt.",
    peakHour: "Deine Musik-Primetime: {time} Uhr.",
    weekHighlight: "{weekday} war dein musikreichster Tag.",
    outro: "Lust auf eine weitere Runde?",
  },
  fr: {
    introBalanced: "Ta musique. Ton histoire.",
    introExploring: "Un mois plein de découvertes.",
    introFavorites: "Certains titres ne lassent jamais.",
    introLowActivity: "Un chapitre plus calme. Mais bien à toi.",
    topSongs: "Tes titres les plus écoutés.",
    newDiscoveries: "Quelques nouveaux favoris.",
    topArtist: "{artist} était à l’honneur.",
    genreFocus: "Ce mois-ci, le {genre} a eu la cote.",
    peakHour: "Ton heure de musique préférée : {time}.",
    weekHighlight: "Ton jour le plus musical : {weekday}.",
    outro: "On remet ça ?",
  },
  es: {
    introBalanced: "Tu música. Tu historia.",
    introExploring: "Un mes lleno de descubrimientos.",
    introFavorites: "Hay canciones que nunca cansan.",
    introLowActivity: "Un capítulo más tranquilo. Pero muy tuyo.",
    topSongs: "Tus canciones más escuchadas.",
    newDiscoveries: "Unas cuantas favoritas nuevas.",
    topArtist: "{artist} estuvo en el centro de atención.",
    genreFocus: "Este mes sonó mucho {genre}.",
    peakHour: "Tu hora punta musical: {time}.",
    weekHighlight: "Tu día con más música: {weekday}.",
    outro: "¿Otra vuelta más?",
  },
  it: {
    introBalanced: "La tua musica. La tua storia.",
    introExploring: "Un mese pieno di scoperte.",
    introFavorites: "Certi brani non stancano mai.",
    introLowActivity: "Un capitolo più tranquillo. Sempre tuo.",
    topSongs: "I tuoi brani più ascoltati.",
    newDiscoveries: "Qualche nuovo brano del cuore.",
    topArtist: "Sotto i riflettori: {artist}.",
    genreFocus: "Questo mese hai ascoltato soprattutto {genre}.",
    peakHour: "La tua ora di musica: {time}.",
    weekHighlight: "Il giorno più musicale? {weekday}.",
    outro: "Pronto per un altro giro?",
  },
  "pt-BR": {
    introBalanced: "Sua música. Sua história.",
    introExploring: "Um mês cheio de descobertas.",
    introFavorites: "Tem música que a gente nunca cansa de ouvir.",
    introLowActivity: "Um capítulo mais tranquilo. Ainda assim, seu.",
    topSongs: "Suas músicas mais ouvidas.",
    newDiscoveries: "Algumas novas favoritas.",
    topArtist: "Quem brilhou por aqui foi {artist}.",
    genreFocus: "Neste mês, {genre} tocou bastante por aqui.",
    peakHour: "Seu horário de ouvir música: {time}.",
    weekHighlight: "O dia mais musical foi {weekday}.",
    outro: "Bora ouvir mais?",
  },
  ru: {
    introBalanced: "Твоя музыка. Твоя история.",
    introExploring: "Месяц музыкальных открытий.",
    introFavorites: "Есть треки, которые не надоедают.",
    introLowActivity: "Более спокойная глава. Но всё равно твоя.",
    topSongs: "Твои самые прослушиваемые треки.",
    newDiscoveries: "Несколько новых любимых треков.",
    topArtist: "В центре внимания — {artist}.",
    genreFocus: "В этом месяце чаще звучал жанр {genre}.",
    peakHour: "Твоё музыкальное время — {time}.",
    weekHighlight: "Самым музыкальным днём стал {weekday}.",
    outro: "Ещё один круг?",
  },
  zh: {
    introBalanced: "你的音乐，你的故事。",
    introExploring: "这个月发现了不少好音乐。",
    introFavorites: "有些歌就是百听不厌。",
    introLowActivity: "这个月安静了一些，但依然属于你。",
    topSongs: "你最常听的歌曲。",
    newDiscoveries: "又发现了几首新欢。",
    topArtist: "这个月的焦点艺人是 {artist}。",
    genreFocus: "这个月，你格外喜欢 {genre}。",
    peakHour: "你的音乐高峰时段：{time}。",
    weekHighlight: "{weekday} 是你听歌最多的一天。",
    outro: "再来一轮？",
  },
  ja: {
    introBalanced: "あなたの音楽、あなたの物語。",
    introExploring: "新しい音楽にたくさん出会えた月。",
    introFavorites: "何度聴いても飽きない曲がある。",
    introLowActivity: "今月は少し静か。それもあなたらしい。",
    topSongs: "いちばんよく聴いた曲。",
    newDiscoveries: "新しくお気に入りになった曲。",
    topArtist: "今月の注目アーティストは{artist}。",
    genreFocus: "今月は{genre}をよく聴いたね。",
    peakHour: "いちばん音楽を聴いた時間：{time}。",
    weekHighlight: "いちばんよく聴いた曜日は{weekday}。",
    outro: "もう一度聴いてみる？",
  },
};

/** Period-specific use conditions; thresholds are suggestions, not app logic. */
export interface ReplayCopySignals {
  /** Only select intro variants for periods with actual play counts. */
  hasPlays: boolean;
  /** Share of playtime in tracks discovered during the selected period, 0..1. */
  newMusicShare?: number;
  /** Most-played five songs' share of plays, 0..1. */
  topFiveShare?: number;
  /** Deterministic period key (e.g. YYYY-MM), stable through that Replay. */
  periodId: string;
}

/** A stable, small hash avoids randomly switching slides during React rerenders. */
function stableHash(value: string): number {
  let result = 2166136261;
  for (let i = 0; i < value.length; i++) {
    result = Math.imul(result ^ value.charCodeAt(i), 16777619);
  }
  return result >>> 0;
}

/** Choose contextual copy; never claim a behavior that the listening data does not show. */
export function pickReplayIntro(signals: ReplayCopySignals): ReplayFlavor {
  if (!signals.hasPlays) return "introLowActivity";
  if (signals.newMusicShare !== undefined && signals.newMusicShare >= 0.35) return "introExploring";
  if (signals.topFiveShare !== undefined && signals.topFiveShare >= 0.55) return "introFavorites";
  // Rotate the default copy only when we add further approved, non-factual variants.
  void stableHash(signals.periodId);
  return "introBalanced";
}

/**
 * Recommendation: a future StoryPicker can use >=2 text variants per category
 * chosen by stableHash(userLibrarySeed + periodId + flavor), gated on measured
 * activity, never fabricated facts.
 *
 * IMPORTANT: 'introLowActivity' is only appropriate for an empty or very low
 * activity period. Do not use it when hasPlays=true in a high-activity month.
 */
