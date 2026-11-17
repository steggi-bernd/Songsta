// Tempo, key and energy shared between devices (src/lib/soundShare.ts): songs known by a key every
// device finds, measurements travelling short and read with care, two copies of a document becoming
// the same one on every device, keys set by hand where the later one wins and a key given back stays
// given back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./soundShare"; export { LIBRARY_DOC_KINDS, LIBRARY_DOCS, REQUIRED_LIBRARY_DOCS } from "./librarySync"; export { serviceProblem, readServiceInfo } from "./syncService";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const s = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const facts = (over = {}) => ({ bpm: 121.37, key: 9, minor: true, energy: 0.6234, loudness: -11.26, introSilence: 0.42, outroSilence: 1.75, headDb: -40.2, tailDb: -33.1, ...over });

test("a song's key: a server song by its id, a file by artist, title and length", () => {
  assert.equal(s.soundKeyOf({ id: "jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b" }), "jf:0f3a9c27b1d84e5f9a6b2c1d0e9f8a7b");
  const a = s.soundKeyOf({ id: "local:aaa", title: "  Night  Ferry ", artist: "Lumen Harbor", duration: 213.4 });
  const b = s.soundKeyOf({ id: "local:bbb", title: "night ferry", artist: "LUMEN HARBOR", duration: 212.6 });
  assert.equal(a, "~lumen harbor|night ferry|213");
  assert.equal(a, b, "the same file on another computer: another id, the same key");
  assert.notEqual(s.soundKeyOf({ id: "local:c", title: "Night Ferry", artist: "Lumen Harbor", duration: 290 }), a, "another length is another recording");
  assert.equal(s.soundKeyOf({ id: "local:d", title: "", artist: "X", duration: 100 }), null);
  assert.equal(s.soundKeyOf({ id: "local:e", title: "Y", artist: "X", duration: 0 }), null);
});

test("a measurement travels short and comes back as it was; one from a stretch keeps its ends unknown", () => {
  const w = s.toWireSound(facts());
  assert.deepEqual(w, { b: 121.4, k: 9, m: 1, e: 0.623, l: -11.3, i: 0.42, o: 1.75, h: -40.2, t: -33.1 });
  assert.deepEqual(s.fromWireSound(w), { bpm: 121.4, key: 9, minor: true, energy: 0.623, loudness: -11.3, introSilence: 0.42, outroSilence: 1.75, headDb: -40.2, tailDb: -33.1 });
  const stretch = s.toWireSound(facts({ excerpt: true }));
  assert.deepEqual(stretch, { b: 121.4, k: 9, m: 1, e: 0.623, l: -11.3, x: 1 });
  assert.deepEqual(s.fromWireSound(stretch), { bpm: 121.4, key: 9, minor: true, energy: 0.623, loudness: -11.3, introSilence: 0, outroSilence: 0, headDb: -11.3, tailDb: -11.3, excerpt: true });
});

test("documents from the service are read with care", () => {
  const doc = s.readSoundsDoc({
    songs: {
      good: { b: 120, k: 0, e: 0.5, l: -10, i: 0, o: 1, h: -30, t: -30 },
      __proto__: { b: 1, k: 1, e: 0.1, l: -1 },
      tooFast: { b: 999, k: 0, e: 0.5, l: -10 },
      badKey: { b: 120, k: 3.5, e: 0.5, l: -10 },
      loud: { b: 120, k: 0, e: 2, l: -10 },
      badEnds: { b: 120, k: 0, e: 0.5, l: -10, i: -3 },
    },
  });
  assert.deepEqual(Object.keys(doc.songs), ["good", "badEnds"]);
  assert.equal(doc.songs.badEnds.x, 1, "ends that don't read: as from a stretch");
  assert.deepEqual(s.readSoundsDoc(null), {});
  assert.deepEqual(s.readSoundsDoc({ songs: "x" }), {});
  const keys = s.readKeysDoc({ keys: { a: { at: 5, v: { k: 4, m: 1 } }, b: { at: 6 }, c: { at: -1, v: { k: 1 } }, d: { at: 7, v: { k: 12 } } } });
  assert.deepEqual(keys, { keys: { a: { at: 5, v: { k: 4, m: 1 } }, b: { at: 6 } } });
});

test("two copies of the measurements become the same one on every device, whichever way they meet", () => {
  const whole = s.toWireSound(facts());
  const stretch = s.toWireSound(facts({ excerpt: true, bpm: 60.7 }));
  const other = s.toWireSound(facts({ bpm: 88 }));
  const a = { songs: { x: stretch, y: whole } };
  const b = { songs: { x: whole, y: other, z: stretch } };
  const ab = s.mergeSoundsDocs(a, b);
  const ba = s.mergeSoundsDocs(b, a);
  assert.deepEqual(ab, ba, "the same either way");
  assert.deepEqual(ab.songs.x, whole, "a whole measurement beats one from a stretch");
  assert.ok([whole, other].some((w) => JSON.stringify(w) === JSON.stringify(ab.songs.y)), "two whole ones: one of them, the same on both");
  assert.deepEqual(s.mergeSoundsDocs(ab, a), ab, "merging again changes nothing");
  assert.deepEqual(s.mergeSoundsDocs({}, {}), {});
});

test("keys set by hand: the later one wins, a key given back stays given back", () => {
  const a = { keys: { x: { at: 10, v: { k: 4 } }, y: { at: 20 } } };
  const b = { keys: { x: { at: 12, v: { k: 7, m: 1 } }, y: { at: 15, v: { k: 2 } } } };
  const ab = s.mergeKeysDocs(a, b);
  assert.deepEqual(ab, s.mergeKeysDocs(b, a));
  assert.deepEqual(ab.keys.x, { at: 12, v: { k: 7, m: 1 } });
  assert.deepEqual(ab.keys.y, { at: 20 }, "given back later: it doesn't come back");
});

test("a device's own: copies under their songs' keys; what the others tell is taken in only where it's new here", () => {
  const copies = new Map([
    ["local:a1", { id: "local:a1", title: "One", artist: "Band", duration: 200 }],
    ["jf:1111", { id: "jf:1111", title: "Two", artist: "Band", duration: 180 }],
  ]);
  const doc = s.soundsDocOf({ "local:a1": facts(), "jf:1111": facts({ excerpt: true }), "local:gone": facts() }, (id) => copies.get(id));
  assert.deepEqual(Object.keys(doc.songs).sort(), ["jf:1111", "~band|one|200"], "a copy not in the library isn't said");
  // Another computer: the same file under its own id, and a song it has measured itself.
  const there = [
    { id: "local:zz", title: "one", artist: "BAND", duration: 200.2 },
    { id: "jf:1111", title: "Two", artist: "Band", duration: 180 },
    { id: "local:mine", title: "Three", artist: "Band", duration: 100 },
  ];
  const taken = s.sharedFor(there, doc, { "jf:1111": facts() });
  assert.deepEqual(taken.map((t) => t.id), ["local:zz"], "measured there already: kept as it is");
  assert.equal(taken[0].facts.bpm, 121.4);
});

test("keys set elsewhere reach the copies here, by moment; given back elsewhere, given back here", () => {
  const copies = [
    { id: "local:a", title: "One", artist: "Band", duration: 200 },
    { id: "jf:2222", title: "Two", artist: "Band", duration: 180 },
  ];
  const doc = { keys: { "~band|one|200": { at: 50, v: { k: 4, m: 1 } }, "jf:2222": { at: 60 } } };
  const changes = s.keyChangesFor(copies, doc, { "jf:2222": { key: 1, minor: false, at: 40 } }, {});
  assert.deepEqual(changes, { set: [{ id: "local:a", key: 4, minor: true, at: 50 }], back: [{ id: "jf:2222", at: 60 }] });
  assert.deepEqual(s.keyChangesFor(copies, doc, { "local:a": { key: 9, minor: false, at: 70 } }, { "jf:2222": 60 }), { set: [], back: [] }, "set later here, or given back already: nothing to do");
  // And the way out: a key given back carries its moment.
  const own = s.keysDocOf({ "local:a": { key: 2, minor: false, at: 80 } }, { "jf:2222": 90 }, (id) => copies.find((c) => c.id === id));
  assert.deepEqual(own, { keys: { "jf:2222": { at: 90 }, "~band|one|200": { at: 80, v: { k: 2 } } } });
});

test("the sound documents are synced like the library's, but a service without them isn't called too old", () => {
  assert.ok(s.LIBRARY_DOCS.includes("sounds") && s.LIBRARY_DOCS.includes("keys"));
  assert.ok(s.LIBRARY_DOC_KINDS.sounds && s.LIBRARY_DOC_KINDS.keys);
  assert.deepEqual([...s.REQUIRED_LIBRARY_DOCS], ["order", "groups", "albumedits", "albumpictures"]);
  assert.equal(s.serviceProblem(s.readServiceInfo({ service: "songsta-sync", version: "1.7.0", docs: ["playlists", "order", "groups", "albumedits", "albumpictures"] })), null);
});

test("a server song is also looked for under its artist, title and length, where a computer measured it as a file", () => {
  assert.deepEqual(s.soundKeysOf({ id: "jf:77aa", title: "Night Ferry", artist: "Lumen Harbor", duration: 213.4 }), ["jf:77aa", "~lumen harbor|night ferry|213"]);
  assert.deepEqual(s.soundKeysOf({ id: "jf:77aa" }), ["jf:77aa"], "nothing to tell it apart by: its id alone");
  assert.deepEqual(s.soundKeysOf({ id: "local:x", title: "Night Ferry", artist: "Lumen Harbor", duration: 213 }), ["~lumen harbor|night ferry|213"]);
  assert.deepEqual(s.soundKeysOf({ id: "local:y", title: "", artist: "X", duration: 9 }), []);
});

test("the phone finds what the computer measured of a file under the server copy it plays", async () => {
  const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
  const phone = await build({
    stdin: { contents: `export { useSoundShare, sharedSoundOf } from "./soundShare";`, resolveDir: stores, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onLoad({ filter: /[\\/]mobile[\\/]src[\\/]storage\.ts$/ }, () => ({ contents: `export const readJson = async () => null; export const writeJson = () => undefined; export const removeJson = () => undefined;`, loader: "ts" }));
        },
      },
    ],
  });
  const p = await import(`data:text/javascript;base64,${Buffer.from(phone.outputFiles[0].text).toString("base64")}`);
  const song = { id: "jf:77aa", title: "Night Ferry", artist: "Lumen Harbor", duration: 213.4, thumb: "" };
  p.useSoundShare.getState().keepSounds({ songs: { "~lumen harbor|night ferry|213": s.toWireSound(facts({ bpm: 98 })) } });
  assert.equal(p.sharedSoundOf(song)?.bpm, 98, "measured as a file on the computer");
  p.useSoundShare.getState().keepSounds({ songs: { "~lumen harbor|night ferry|213": s.toWireSound(facts({ bpm: 98 })), "jf:77aa": s.toWireSound(facts({ bpm: 99, excerpt: true })) } });
  assert.equal(p.sharedSoundOf(song)?.bpm, 99, "the server copy's own measurement goes first");
  assert.equal(p.sharedSoundOf({ ...song, id: "jf:other", duration: 290 }), undefined, "another length is another recording");
});
