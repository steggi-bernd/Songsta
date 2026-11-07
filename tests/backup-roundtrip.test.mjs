import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DEVICE_LOCAL_SETTINGS,
  SETTINGS_KEYS,
  envelope,
  searchesFromBackup,
  searchesToBackup,
  settingsFromBackup,
  settingsToBackup,
  storeEnvelopeFromBackup,
} from "../.test-build/backup-transfer.mjs";

// The exact bug being guarded against: stores persist as zustand envelopes
// { state, version }; backup transforms must unwrap on export and re-wrap on
// import, or settings and recent searches silently vanish from every backup.

test("settings and recent searches survive export → wipe → import", () => {
  // 1. A live store, in the envelope shape persist writes to disk.
  const settingsEnvelope = envelope({
    localMusicFolder: "C:\\Music\\ByTune", // device-local: never travels
    accent: "teal",
    skipEndsRepeatOne: false,
    crossfadeSeconds: 4,
    smartFade: true,
    liquidGlass: false,
  });
  const recentsEnvelope = envelope({ searches: ["radiohead", "Aphex Twin", "burial"] });

  // 2. Export.
  const doc = {
    settings: settingsToBackup(settingsEnvelope),
    recentSearches: searchesToBackup(recentsEnvelope),
  };
  assert.equal(doc.settings.localMusicFolder, undefined);
  assert.equal(doc.settings.accent, "teal");
  assert.equal(doc.settings.skipEndsRepeatOne, false);
  assert.deepEqual(doc.recentSearches, ["radiohead", "Aphex Twin", "burial"]);

  // 3. Wipe (reset app data): stores go back to empty defaults.
  const wipedSettings = envelope({});
  const wipedSearches = envelope({ searches: [] });

  // 4. Import: rebuild the store states the renderer will hydrate.
  const restoredSettings = settingsFromBackup(doc.settings, wipedSettings);
  const restoredSearches = searchesFromBackup(doc.recentSearches);

  assert.equal(restoredSettings.accent, "teal");
  assert.equal(restoredSettings.skipEndsRepeatOne, false);
  assert.equal(restoredSettings.crossfadeSeconds, 4);
  assert.equal(restoredSettings.smartFade, true);
  assert.equal(restoredSettings.liquidGlass, false);
  // Device-local: absent from the backup AND from the wiped store → absent.
  assert.equal("localMusicFolder" in restoredSettings, false);
  assert.deepEqual(restoredSearches, ["radiohead", "Aphex Twin", "burial"]);

  // 5. The import result must be written as the envelope the store hydrates.
  assert.deepEqual(envelope(restoredSettings), { state: restoredSettings, version: 0 });
  assert.deepEqual(envelope({ searches: restoredSearches }), {
    state: { searches: restoredSearches },
    version: 0,
  });
});

test("import keeps this machine's device-local settings", () => {
  const current = envelope({
    audioSinkId: "this-computers-speakers",
    localMusicFolder: "D:\\Lib",
    accent: "violet",
  });
  const restored = settingsFromBackup(
    envelope({ accent: "teal", audioSinkId: "another-computers-speakers" }),
    current
  );
  assert.equal(restored.audioSinkId, "this-computers-speakers");
  assert.equal(restored.localMusicFolder, "D:\\Lib");
  assert.equal(restored.accent, "teal");
});

test("a backup knows every setting there is", () => {
  // A setting missing here goes back to its default on every import, without a word.
  const source = fs.readFileSync(new URL("../src/stores/settings.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("interface SettingsState {"), source.indexOf("export const useSettings"));
  const keys = [...body.matchAll(/^  (\w+)\??: /gm)].map((m) => m[1]);
  assert.ok(keys.length > 30, "the settings are found");
  assert.deepEqual(keys.filter((k) => !SETTINGS_KEYS.has(k)), []);
  assert.deepEqual([...SETTINGS_KEYS].filter((k) => !keys.includes(k)), [], "and none that's gone");
  // What a backup leaves out belongs to this one computer.
  for (const k of DEVICE_LOCAL_SETTINGS) assert.ok(SETTINGS_KEYS.has(k), k);
  const everything = Object.fromEntries(keys.map((k) => [k, 1]));
  const out = settingsToBackup(envelope(everything));
  assert.deepEqual(keys.filter((k) => !(k in out)).sort(), [...DEVICE_LOCAL_SETTINGS].sort());
});

test("legacy backup shapes still import", () => {
  // Older exports stored the raw zustand envelope for recent searches (the
  // import used to skip it silently) — it must unwrap now.
  const legacy = envelope({ searches: ["a", "b"] });
  assert.deepEqual(searchesFromBackup(legacy), ["a", "b"]);
  // Old settings were always exported empty — must import as defaults, not crash.
  assert.deepEqual(settingsFromBackup({}, envelope({})), {});
  // A bare non-envelope searches map (defensive) also reads.
  assert.deepEqual(searchesFromBackup({ searches: ["x"] }), ["x"]);
});

test("unknown settings keys never enter the backup or the import", () => {
  const exported = settingsToBackup(envelope({ evilKey: 1, accent: "teal" }));
  assert.deepEqual(exported, { accent: "teal" });
  const imported = settingsFromBackup({ evilKey: 2, autoplay: true }, envelope({}));
  assert.deepEqual(imported, { autoplay: true });
});

test("malformed payloads degrade to empty, never throw", () => {
  assert.deepEqual(settingsToBackup(null), {});
  assert.deepEqual(settingsToBackup("nope"), {});
  assert.deepEqual(searchesToBackup(null), []);
  assert.deepEqual(searchesToBackup(envelope({ searches: "not-an-array" })), []);
  assert.deepEqual(searchesFromBackup(42), []);
  assert.deepEqual(searchesFromBackup({ searches: [1, "ok", null] }), ["ok"]);
  assert.deepEqual(settingsFromBackup(null, null), {});
});

test("whole-store sections must be real envelopes, else import is refused", () => {
  // A live export: persist always writes { state, version } envelopes.
  const lib = envelope({ liked: [], playlists: [], history: [], downloads: {} });
  lib.version = 1;
  assert.deepEqual(storeEnvelopeFromBackup(lib, "library"), { state: lib.state, version: 1 });
  // version 0 (stores without an explicit version) is a number too.
  assert.deepEqual(storeEnvelopeFromBackup({ state: {}, version: 0 }, "player"), { state: {}, version: 0 });

  // Junk that used to be written verbatim and broke the store on reload.
  for (const junk of [null, undefined, 42, "nope", [], [1], { version: 1 }, { state: null, version: 1 },
    { state: [], version: 1 }, { state: {}, version: "one" }]) {
    assert.throws(() => storeEnvelopeFromBackup(junk, "library"), /malformed library section/);
  }
  assert.throws(() => storeEnvelopeFromBackup({ state: {} }, "player"), /malformed player section/);
});
