// The interface's languages (src/lib/i18n.ts, src/locales): the English text is the key, a language
// says the same with the same placeholders, and what it doesn't have shows in English.
import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({
  stdin: { contents: `export * from "./i18n"; export { de } from "../locales/de";`, resolveDir: lib, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { T, setLanguage, languageOf, currentLanguage, textLocale, de } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

afterEach(() => setLanguage("en"));

test("in English the text is its own key, with what's put into it", () => {
  assert.equal(T("Add to Liked Songs"), "Add to Liked Songs");
  assert.equal(T("Playing on {name}", { name: "Kitchen" }), "Playing on Kitchen");
  assert.equal(T("swipe.queue"), "Add to queue", "the few keys that aren't the text have their own English");
});

test("in German the same, and what it doesn't have shows in English", () => {
  setLanguage("de");
  assert.equal(currentLanguage(), "de");
  assert.equal(T("Add to Liked Songs"), "Zu den Lieblingssongs");
  assert.equal(T("Playing on {name}", { name: "Kitchen" }), "Läuft auf Kitchen");
  assert.equal(T("A text nobody translated {x}", { x: 1 }), "A text nobody translated 1");
  assert.equal(T("Second stream: what you start now plays here. {name} goes on by itself.", { name: "PC" }), "Zweiter Stream: Was du jetzt startest, spielt hier. PC läuft allein weiter.");
});

test("a value that isn't there leaves its place visible; a zero is a value", () => {
  assert.equal(T("Playing on {name}"), "Playing on {name}");
  assert.equal(T("Playing on {name}", { name: 0 }), "Playing on 0");
});

test("a system's locale means a language we have, or English", () => {
  assert.equal(languageOf("de_DE"), "de");
  assert.equal(languageOf("de-AT"), "de");
  assert.equal(languageOf("en-US"), "en");
  assert.equal(languageOf("fr_FR"), "en");
  assert.equal(languageOf(""), "en");
  assert.equal(languageOf(null), "en");
});

test("dates in a sentence speak the interface's language, in the system's region when it speaks it too", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const system = (language) => Object.defineProperty(globalThis, "navigator", { value: { language }, configurable: true, writable: true });
  try {
    system("en-GB");
    assert.equal(textLocale(), "en-GB");
    setLanguage("de");
    assert.equal(textLocale(), "de", "a German interface on an English system: German weekdays");
    system("de-AT");
    assert.equal(textLocale(), "de-AT");
    setLanguage("en");
    assert.equal(textLocale(), "en", "an English interface on a German system: English weekdays");
  } finally {
    if (real) Object.defineProperty(globalThis, "navigator", real);
    else delete globalThis.navigator;
  }
});

const holes = (s) => (s.match(/\{\w+\}/g) ?? []).sort();

test("a translation only uses placeholders its English text has", () => {
  for (const [key, text] of Object.entries(de)) {
    for (const hole of holes(text)) assert.ok(holes(key).includes(hole), `${key} -> ${text}`);
  }
});

test("every text of the screens has its German, apart from names that stay as they are", () => {
  const stays = new Set([
    "Automix", "Automix: {reason}", "Ctrl+F", "dB", "Discord", "Downloads", "Equalizer", "Esc", "Exportify", "exportify.net", "FFmpeg", "Genius", "HI-RES", "Hz",
    "Jellyfin", "Jellyfin{reach}", "MP3 192 kbps", "Navidrome", "Navidrome{reach}", "Playlist1.json", "RADIO", "Replay", "Songsta", "Songsta {APP_VERSION}", "Spotify",
    "Wikipedia", "YourLibrary.json", "{bandLabel} Hz", "+{range} dB", "−{range} dB", "AAC {kbps} kbps",
  ]);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !p.includes("locales")) files.push(p);
    }
  })(join(root, "src"));
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) files.push(p);
    }
  })(join(root, "mobile", "src"));
  const missing = new Set();
  for (const file of files) {
    for (const m of readFileSync(file, "utf8").matchAll(/\bT\("((?:[^"\\]|\\.)*)"/g)) {
      const key = JSON.parse(`"${m[1]}"`);
      if (!de[key] && !stays.has(key)) missing.add(key);
    }
  }
  assert.deepEqual([...missing], []);
});
