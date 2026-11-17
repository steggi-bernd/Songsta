// The media analysis' count (src/stores/sound.ts soundCounts, components/MediaAnalysis.tsx): a song that
// can't be measured counts as looked at, so the progress gets to its end; once it stood at 2212 of 2228
// for good. And a short server song is measured from what it has (lib/serverSound.ts shortestStretch):
// an intro of six seconds used to fail the ten-second rule every time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const stubs = {
  "stores/catalog": `export const versionsOf = (t) => t.versions ?? []; export const useCatalog = { getState: () => ({ tracks: [], byId: new Map(), loaded: true }) };`,
  "stores/library": `export const useLibrary = { getState: () => ({ liked: [], history: [], playlists: [] }) };`,
  "stores/player": `export const usePlayer = { getState: () => ({ queue: [], index: 0, playing: false }) };`,
  "stores/settings": `export const useSettings = { getState: () => ({ soundAnalysis: true, soundAnalysisStarted: true }) };`,
};
async function bundle(contents) {
  const out = await build({
    stdin: { contents, resolveDir: src, loader: "ts" },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "stubs",
        setup(b) {
          for (const [name, body] of Object.entries(stubs)) {
            const filter = new RegExp(`[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
            b.onLoad({ filter }, () => ({ contents: body, resolveDir: src, loader: "ts" }));
          }
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const { soundCounts } = await bundle(`export { soundCounts } from "./stores/sound";`);
const { shortestStretch } = await bundle(`export { shortestStretch } from "./lib/serverSound";`);

const facts = { bpm: 120, key: 0, minor: false, energy: 0.5, loudness: -12 };

test("songs that can't be measured count as looked at: the progress gets to its end, and says how many", () => {
  const tracks = [
    { id: "local:a" },
    { id: "local:b" },
    { id: "local:unreadable" },
    { id: "jf:1" },
    { id: "jf:intro" },
    // A merged song measured through its local copy.
    { id: "jf:2", versions: [{ id: "local:copy" }] },
    { id: "other:x" },
  ];
  const measured = { "local:a": facts, "local:b": facts, "jf:1": facts, "local:copy": facts };
  const before = soundCounts(tracks, measured);
  assert.deepEqual(before, { local: { done: 2, skipped: 0, total: 3 }, server: { done: 2, skipped: 0, total: 3 } }, "without the marks: never through");
  const after = soundCounts(tracks, measured, new Set(["local:unreadable", "jf:intro"]));
  assert.deepEqual(after, { local: { done: 3, skipped: 1, total: 3 }, server: { done: 3, skipped: 1, total: 3 } });
  // A song measured after all counts as measured, not as skipped.
  const later = soundCounts(tracks, { ...measured, "jf:intro": facts }, new Set(["local:unreadable", "jf:intro"]));
  assert.equal(later.server.skipped, 0);
});

test("a short server song is measured from what it has; a long one needs ten seconds of its stretch", () => {
  assert.equal(shortestStretch({ duration: 6 }), 4.8, "an intro of six seconds");
  assert.equal(shortestStretch({ duration: 12 }), 9.6);
  assert.equal(shortestStretch({ duration: 2 }), 2, "never less than two seconds");
  assert.equal(shortestStretch({ duration: 0 }), 2, "a length the server doesn't know");
  assert.equal(shortestStretch({ duration: 120 }), 10);
  assert.equal(shortestStretch({ duration: 240 }), 10);
});
