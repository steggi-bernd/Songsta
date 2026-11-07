// The lyrics out of a Genius page (electron/genius-page.ts). The page below is made up, in the form Genius uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/genius-page.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { geniusExtractLyrics } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const page = (body) => `<!doctype html><html><head><title>A song</title><style>.x{color:red}</style></head><body><div id="top">Sign in</div>${body}<footer>About</footer></body></html>`;

test("the lines of every part, one under the other", async () => {
  const html = page(`
    <div data-lyrics-container="true" class="Lyrics__Container-a b">[Verse 1]<br/>Paper lanterns on the water<br/>Slowly drifting out to sea</div>
    <div class="Ad">Nothing to do with it</div>
    <div data-lyrics-container="true" class="Lyrics__Container-a b">[Chorus]<br/>Hold the line, hold the line</div>`);
  assert.equal(await geniusExtractLyrics(html), "[Verse 1]\nPaper lanterns on the water\nSlowly drifting out to sea\n[Chorus]\nHold the line, hold the line");
});

test("links and marks around a line stay out of the text, entities read as what they are", async () => {
  const html = page(`<div data-lyrics-container="true"><a href="/x"><span>Don&#x27;t you know &amp; don&apos;t you care</span></a><br/><i>caf&eacute; lights</i> <b>go&nbsp;down</b></div>`);
  assert.equal(await geniusExtractLyrics(html), "Don't you know & don't you care\ncafé lights go down");
});

test("what isn't lyrics inside a part goes", async () => {
  const html = page(`
    <div data-lyrics-container="true">
      <div data-exclude-from-selection="true">3 Contributors</div>
      <div class="LyricsHeader__Container">Translations</div>
      <div class="SongBioPreview__Container">About this song</div>
      <div class="InreadAd__Container">An advert</div>
      <button>Share</button>
      <script>var a = "code";</script>
      <style>.y { color: blue }</style>
      Only this stays
    </div>`);
  assert.equal(await geniusExtractLyrics(html), "Only this stays");
});

test("a paragraph starts on a new line", async () => {
  const html = page(`<div data-lyrics-container="true"><p>First</p><p>Second</p></div>`);
  assert.equal(await geniusExtractLyrics(html), "First\nSecond");
});

test("Genius's own words at the edges go, odd spaces become plain ones", async () => {
  const html = page(`<div data-lyrics-container="true">One\u00A0line\u200Bhere<br/>12You might also like<br/>Last line34Embed</div>`);
  assert.equal(await geniusExtractLyrics(html), "One line here\n\nLast line");
});

test("the older form of the page", async () => {
  assert.equal(await geniusExtractLyrics(page(`<div class="lyrics"><p>Old form<br/>still reads</p></div>`)), "Old form\nstill reads");
});

test("no lyrics on the page: nothing, also with an empty part", async () => {
  assert.equal(await geniusExtractLyrics(page(`<div class="Other">An instrumental</div>`)), null);
  assert.equal(await geniusExtractLyrics(page(`<div data-lyrics-container="true">  <button>Share</button>  </div>`)), null);
  assert.equal(await geniusExtractLyrics(""), null);
});
