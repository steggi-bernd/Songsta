// A sped-up, slowed, live or remixed upload must not take the studio cut's timed lyrics: the word on
// the title says which it is (electron/lyrics.ts editionOf). The pattern once held two backspace
// characters where word boundaries were meant, and never matched anything.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { editionOf } from "../.test-build/lyrics.mjs";

test("the words that name another rendition are found", () => {
  assert.equal(editionOf("Midnight Drive (Sped Up)"), "sped up");
  assert.equal(editionOf("Midnight Drive - slowed + reverb"), "slowed + reverb");
  assert.equal(editionOf("Midnight Drive (Live)"), "live");
  assert.equal(editionOf("Midnight Drive [Remix]"), "remix");
  assert.equal(editionOf("Midnight Drive nightcore"), "nightcore");
});

test("as whole words only, and a plain title names none", () => {
  assert.equal(editionOf("Midnight Drive"), null);
  assert.equal(editionOf("Alive"), null);
  assert.equal(editionOf("Delivery"), null);
  assert.equal(editionOf("Oliver's Song"), null);
});

test("no control characters in the lyrics source", () => {
  const source = fs.readFileSync(new URL("../electron/lyrics.ts", import.meta.url), "utf8");
  assert.equal(/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(source), false);
});
