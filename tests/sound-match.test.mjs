// Klingt wie (src/lib/soundMatch.ts): the Camelot wheel, tempo with half and double time, and how a
// song is matched to another by tempo, key and energy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export * from "./soundMatch"; export { setLanguage } from "./i18n";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { camelotOf, camelotLabel, keyLabel, keyStep, tempoGap, matchSong, mixRules, DEFAULT_MATCH, setLanguage } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const facts = (bpm, key, minor, energy = 0.5) => ({ bpm, key, minor, energy, loudness: -14, introSilence: 0, outroSilence: 0, headDb: -20, tailDb: -20 });
// Keys: 0 C, 2 D, 4 E, 7 G, 9 A, 11 B.

test("keys on the Camelot wheel", () => {
  assert.equal(camelotLabel(camelotOf(0, false)), "8B", "C major");
  assert.equal(camelotLabel(camelotOf(9, true)), "8A", "A minor");
  assert.equal(camelotLabel(camelotOf(7, false)), "9B", "G major");
  assert.equal(camelotLabel(camelotOf(4, true)), "9A", "E minor");
  assert.equal(camelotLabel(camelotOf(11, false)), "1B", "B major");
  assert.equal(camelotLabel(camelotOf(8, true)), "1A", "G♯ minor");
  assert.equal(camelotLabel(camelotOf(5, false)), "7B", "F major");
  assert.equal(camelotOf(-1, false), null);
});

test("a key as the app's language says it: in German B is H, B♭ is B, minor keys small", () => {
  assert.equal(keyLabel(9, true), "A minor");
  assert.equal(keyLabel(11, false), "B major");
  setLanguage("de");
  try {
    assert.equal(keyLabel(9, true), "a-Moll");
    assert.equal(keyLabel(0, false), "C-Dur");
    assert.equal(keyLabel(11, false), "H-Dur", "English B major");
    assert.equal(keyLabel(10, true), "b-Moll", "B♭ minor");
    assert.equal(keyLabel(6, true), "fis-Moll");
    assert.equal(keyLabel(-1, false), "");
  } finally {
    setLanguage("en");
  }
});

test("neighbours on the wheel: one step round, or the relative key", () => {
  const am = camelotOf(9, true);
  assert.equal(keyStep(am, camelotOf(9, true)), 0);
  assert.equal(keyStep(am, camelotOf(0, false)), 1, "C major is A minor's relative");
  assert.equal(keyStep(am, camelotOf(4, true)), 1, "E minor, 9A");
  assert.equal(keyStep(am, camelotOf(2, true)), 1, "D minor, 7A");
  assert.equal(keyStep(am, camelotOf(7, false)), 2, "G major, 9B: two steps");
  assert.equal(keyStep(camelotOf(11, false), camelotOf(6, false)), 1, "12 and 1 are neighbours: 1B and 2B");
});

test("tempo: half and double time count as the same when asked", () => {
  assert.equal(tempoGap(92, 94, true), 2);
  assert.equal(tempoGap(92, 184, true), 0);
  assert.equal(tempoGap(92, 184, false), 92);
  assert.equal(tempoGap(0, 120, true), Infinity);
});

test("matching by both: the tempo window and the key rule decide, the closer the higher", () => {
  const seed = facts(92, 9, true, 0.62);
  const same = matchSong(seed, facts(93, 9, true, 0.58), DEFAULT_MATCH);
  const near = matchSong(seed, facts(94, 4, true, 0.7), DEFAULT_MATCH);
  assert.equal(same.tempoNote, "+1");
  assert.equal(same.keyStep, 0);
  assert.ok(same.score > near.score);
  assert.equal(matchSong(seed, facts(99, 9, true), DEFAULT_MATCH), null, "7 BPM off a ±4 window");
  assert.equal(matchSong(seed, facts(92, 7, false), DEFAULT_MATCH), null, "G major is too far for neighbours");
  assert.equal(matchSong(seed, facts(184, 9, true), DEFAULT_MATCH).tempoNote, "2×");
  assert.equal(matchSong(seed, facts(184, 9, true), { ...DEFAULT_MATCH, halfAndDouble: false }), null);
  assert.equal(matchSong(seed, facts(94, 4, true), { ...DEFAULT_MATCH, keyRule: "same" }), null);
  assert.ok(matchSong(seed, facts(94, 7, false), { ...DEFAULT_MATCH, keyRule: "any" }));
  assert.equal(matchSong(seed, { ...facts(92, 9, true), loudness: -90 }, DEFAULT_MATCH), null, "a silent file isn't a match");
});

test("tempo alone ignores the key; key alone ignores the tempo; energy can lead the way", () => {
  const seed = facts(120, 0, false, 0.5);
  assert.ok(matchSong(seed, facts(121, 6, true), { ...DEFAULT_MATCH, mode: "tempo" }));
  assert.ok(matchSong(seed, facts(80, 9, true), { ...DEFAULT_MATCH, mode: "key" }));
  assert.equal(matchSong(seed, facts(120, 0, false, 0.5), { ...DEFAULT_MATCH, mode: "both", energy: "lift" }), null, "no more lift");
  assert.ok(matchSong(seed, facts(120, 0, false, 0.7), { ...DEFAULT_MATCH, mode: "both", energy: "lift" }));
  assert.ok(matchSong(seed, facts(90, 5, true, 0.55), { ...DEFAULT_MATCH, mode: "energy" }));
  assert.equal(matchSong(seed, facts(90, 5, true, 0.9), { ...DEFAULT_MATCH, mode: "energy" }), null);
});

test("the mixes made from how songs sound", () => {
  const rules = Object.fromEntries(mixRules(facts(92, 9, true)).map((r) => [r.id, r]));
  assert.ok(rules.late.fits(facts(80, 9, true, 0.3)));
  assert.ok(!rules.late.fits(facts(80, 0, false, 0.3)), "major isn't late night");
  assert.ok(rules.run.fits(facts(165, 0, false, 0.8)));
  assert.ok(rules.run.fits(facts(84, 0, false, 0.8)), "half time runs too");
  assert.ok(rules.focus.fits(facts(110, 2, true, 0.3)));
  assert.ok(rules.sunlit.fits(facts(100, 7, false, 0.7)));
  assert.ok(rules.key.fits(facts(100, 0, false, 0.5)), "C major is A minor's neighbour");
  assert.equal(mixRules(null).some((r) => r.id === "key"), false);
});
