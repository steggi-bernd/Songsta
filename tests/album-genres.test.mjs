// Smarter album genres (src/lib/albumGenres.ts, electron/metadata.ts lookupAlbumGenres): the tags,
// MusicBrainz's voted genres and Wikidata's stated ones weighed together; asked of stand-in databases.
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

const lib = fileURLToPath(new URL("../src/lib/", import.meta.url));
const out = await build({ stdin: { contents: `export { voteAlbumGenres } from "./albumGenres";`, resolveDir: lib, loader: "ts" }, bundle: true, platform: "node", format: "esm", write: false });
const { voteAlbumGenres } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

test("nothing from the databases: the tags stand", () => {
  assert.equal(voteAlbumGenres(new Map([["Rock", 10]]), 10, undefined), null);
  assert.equal(voteAlbumGenres(new Map([["Rock", 10]]), 10, { mb: [], wikidata: [] }), null);
});

test("tags on every song and MusicBrainz's votes agree: one genre, however each spells it", () => {
  const vote = voteAlbumGenres(new Map([["Hip Hop", 12]]), 12, { mb: [{ name: "hip hop", count: 9 }, { name: "trap", count: 1 }], wikidata: ["hip-hop music"] });
  assert.equal(vote[0], "Hip-Hop");
  assert.ok(!vote.includes("trap"), "one vote against nine doesn't make it");
});

test("an album tagged with a catch-all gets what the databases agree on", () => {
  const vote = voteAlbumGenres(new Map([["Other", 2]]), 10, { mb: [{ name: "synthwave", count: 6 }, { name: "electronic", count: 4 }], wikidata: ["synthwave"] });
  assert.equal(vote[0], "synthwave", "MusicBrainz and Wikidata both: first");
  assert.ok(vote.includes("Electronic"));
  assert.ok(!vote.includes("Other"), "a tag on two of ten songs is outvoted");
});

test("an untagged album takes the databases' genres, at most three", () => {
  const vote = voteAlbumGenres(new Map(), 8, { mb: [{ name: "dream pop", count: 5 }, { name: "shoegaze", count: 5 }, { name: "indie pop", count: 4 }, { name: "noise pop", count: 4 }], wikidata: [] });
  assert.equal(vote.length, 3);
  assert.deepEqual(vote.slice(0, 2).sort(), ["dream pop", "shoegaze"]);
});

/* ------------------------------------------------------------ asking the databases */

async function loadMetadata(fetchStub) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/metadata.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module,
    exports: module.exports,
    console,
    Buffer,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: fetchStub,
    require: (name) => (name === "electron" ? { app: { getLocale: () => "en", getPath: () => "." }, net: {} } : require(name)),
  });
  return module.exports;
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("an album's genres: its MusicBrainz group by name and artist, the group's votes, Wikidata's statements by its link", async () => {
  const asked = [];
  const meta = await loadMetadata(async (url, init) => {
    asked.push(String(url));
    assert.match(String(init?.headers?.["User-Agent"] ?? ""), /^Songsta\//, "the open databases hear who asks, not who listens");
    if (url.includes("/ws/2/release-group?query=")) return json({ "release-groups": [{ id: "rg-1", score: 100, title: "Night Ferry" }, { id: "rg-2", score: 60, title: "Other" }] });
    if (url.includes("/ws/2/release-group/rg-1")) return json({ genres: [{ name: "ambient", count: 4 }, { name: "dream pop", count: 2 }], relations: [{ type: "wikidata", url: { resource: "https://www.wikidata.org/wiki/Q42" } }] });
    if (url.includes("Special:EntityData/Q42")) return json({ entities: { Q42: { claims: { P136: [{ mainsnak: { datavalue: { value: { id: "Q100" } } } }] } } } });
    if (url.includes("wbgetentities")) return json({ entities: { Q100: { labels: { en: { value: "ambient music" } } } } });
    return json({}, 404);
  });
  const found = await meta.lookupAlbumGenres("Lumen Harbor", "Night Ferry");
  assert.deepEqual(JSON.parse(JSON.stringify(found)), { mb: [{ name: "ambient", count: 4 }, { name: "dream pop", count: 2 }], wikidata: ["ambient music"] });
  assert.ok(asked[0].includes(encodeURIComponent('releasegroup:"Night Ferry"')));
  const unknown = await meta.lookupAlbumGenres("Nobody", "Not An Album");
  assert.equal(unknown, null, "an album MusicBrainz doesn't know");
});
