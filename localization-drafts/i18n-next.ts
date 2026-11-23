/**
 * Proposed message formatter for Songsta i18n v2.
 * Draft only: not imported by src/lib/i18n.ts.
 *
 * New messages use stable semantic IDs, rather than English source text keys.
 * Existing T("English key") calls remain intact until separately migrated.
 */
export type SupportedLocale = "en" | "de" | "fr" | "es" | "ru" | "zh" | "ja";
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type Message = string | PluralForms;
export type MessageCatalog = Record<string, Message>;
export type MessageValues = Record<string, string | number | null | undefined>;

const LOCALE: Record<SupportedLocale, string> = {
  en: "en-US",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  ru: "ru-RU",
  zh: "zh-CN",
  ja: "ja-JP",
};

const getPlaceholders = (text: string): string[] =>
  [...text.matchAll(/\{([A-Za-z_]\w*)\}/g)].map((match) => match[1]);

/** Safe placeholder interpolation: not HTML, never evaluates string content. */
export function interpolate(source: string, values: MessageValues = {}): string {
  return source.replace(/\{([A-Za-z_]\w*)\}/g, (whole, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? whole : String(value);
  });
}

export function pluralCategory(locale: SupportedLocale, count: number): Intl.LDMLPluralRule {
  return new Intl.PluralRules(LOCALE[locale]).select(count);
}

/**
 * Resolve a semantic ID from a fully translated catalog.
 * For plural messages, supply values.count, numeric and locale-specific.
 * The explicit fallback prevents accidentally showing an object as text.
 */
export function resolveMessage(
  locale: SupportedLocale,
  key: string,
  catalog: MessageCatalog,
  values: MessageValues = {},
): string {
  const message = catalog[key];
  if (message === undefined) return key;
  if (typeof message === "string") return interpolate(message, values);
  const count = values.count;
  if (typeof count !== "number" || !Number.isFinite(count)) {
    throw new Error("Count required for plural message: " + key);
  }
  const form = pluralCategory(locale, count);
  return interpolate(message[form] ?? message.other, values);
}

/** Validate catalogs before merging, including all plural variants. */
export function validateCatalog(reference: MessageCatalog, target: MessageCatalog): string[] {
  const errors: string[] = [];
  for (const [key, base] of Object.entries(reference)) {
    const translated = target[key];
    if (translated === undefined) {
      errors.push(key + ": missing message");
      continue;
    }
    const forms = (message: Message) =>
      typeof message === "string" ? [message] : Object.values(message);
    const expected = new Set(forms(base).flatMap(getPlaceholders));
    for (const text of forms(translated)) {
      for (const placeholder of expected) {
        if (!getPlaceholders(text).includes(placeholder)) {
          errors.push(key + ": missing placeholder " + placeholder);
        }
      }
      for (const placeholder of getPlaceholders(text)) {
        if (!expected.has(placeholder)) errors.push(key + ": unexpected placeholder " + placeholder);
      }
    }
  }
  return errors;
}

/** Example singular/plural messages for all seven language families. */
export const PLAY_COUNTS: Record<SupportedLocale, PluralForms> = {
  en: { one: "{count} play", other: "{count} plays" },
  de: { one: "{count} Wiedergabe", other: "{count} Wiedergaben" },
  fr: { one: "{count} écoute", other: "{count} écoutes" },
  es: { one: "{count} reproducción", other: "{count} reproducciones" },
  ru: { one: "{count} прослушивание", few: "{count} прослушивания", many: "{count} прослушиваний", other: "{count} прослушивания" },
  zh: { other: "播放 {count} 次" },
  ja: { other: "{count}回再生" },
};

export function formatPlayCount(locale: SupportedLocale, count: number): string {
  const result = resolveMessage(locale, "stats.playCount", { "stats.playCount": PLAY_COUNTS[locale] }, { count });
  return result;
}
