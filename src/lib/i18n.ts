/**
 * The interface's languages, for the computer and the phone. The English text is
 * the key: `T("Add to queue")`, with `{placeholders}` for what's in it. What a
 * language doesn't have yet shows in English. Another language is another file
 * in src/locales and a line below. Changing the language takes a reload: texts
 * are also read when modules load.
 */
import { de } from "../locales/de";

export type Language = "en" | "de";
/** What can be chosen: "auto" follows the system. */
export type LanguageChoice = Language | "auto";

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: "en", name: "English" },
  { id: "de", name: "Deutsch" },
];

/** English only needs its own words for the few texts whose key isn't the text itself. */
const en: Record<string, string> = {
  "swipe.queue": "Add to queue",
  "swipe.undo": "Undo branch",
  "swipe.branch": "Branch off",
  "swipe.mute": "Mute song",
  "swipe.unmute": "Play again",
};
const TABLES: Record<Language, Record<string, string>> = { en, de };

let table: Record<string, string> = en;
let current: Language = "en";

export const currentLanguage = (): Language => current;

/**
 * The locale for dates and numbers inside the interface's sentences: the system's when it speaks the
 * interface's language (the region keeps its own formats), else the interface's language itself, so a
 * German interface on an English system says "Sonntag war dein Tag", not "Sunday war dein Tag".
 */
export function textLocale(): string {
  const system = typeof navigator !== "undefined" ? navigator.language || "" : "";
  return system.toLowerCase().startsWith(current) ? system : current;
}

/** The language a system's locale means, English if we don't have it. */
export function languageOf(locale: string | null | undefined): Language {
  const code = (locale ?? "").toLowerCase().slice(0, 2);
  return LANGUAGES.some((l) => l.id === code) ? (code as Language) : "en";
}

export function setLanguage(language: Language): void {
  current = language;
  table = TABLES[language];
}

/** A text of the interface in the language chosen. */
export function T(text: string, values?: Record<string, string | number | null | undefined>): string {
  const found = table[text] ?? text;
  if (!values) return found;
  return found.replace(/\{(\w+)\}/g, (all, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? all : String(value);
  });
}

/* ------------------------------------------------------------- on the computer: known before anything else loads */

const STORED = "songsta.language";

export function storedLanguageChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(STORED);
    return value === "en" || value === "de" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function storeLanguageChoice(choice: LanguageChoice): void {
  try {
    if (choice === "auto") localStorage.removeItem(STORED);
    else localStorage.setItem(STORED, choice);
  } catch {
    /* it stays as it is */
  }
}

// In a browser window. A phone says which language with setLanguage before its screens load; tests stay in English.
if (typeof document !== "undefined" && typeof localStorage !== "undefined" && typeof navigator !== "undefined") {
  const choice = storedLanguageChoice();
  setLanguage(choice === "auto" ? languageOf(navigator.language) : choice);
}
