// Search under a source (src/lib/searchScope.ts, plan section 4): every copy of a song counts, and the
// albums and artists come from the same songs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const out = await build({ entryPoints: [fileURLToPath(new URL("../src/lib/searchScope.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", write: false });
const { scopeLibrary } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const song = (id, title, artist, album, source) => ({ id, title, artist, album, source, duration: 200, thumb: "" });
// One recording as a local file and on Jellyfin (the local copy plays first), an album only here, one only on Navidrome.
const both = song("local:1", "Twice", "Shared Band", "Shared LP", "local");
const jellyCopy = song("jf:1", "Twice", "Shared Band", "Shared LP", "jellyfin");
const onlyHere = song("local:2", "Mine", "Home Artist", "Home LP", "local");
const onlyNavidrome = song("sub:3", "Theirs", "Far Artist", "Far LP", "subsonic");
const versions = new Map([
  ["local:1", [both, jellyCopy]],
  ["jf:1", [both, jellyCopy]],
]);
const album = (title, artist, tracks) => ({ key: title, route: title, title, artist, kind: "album", thumb: "", tracks });
const artist = (name) => ({ name, route: name, trackCount: 1, albumCount: 1, thumb: "" });
const library = {
  tracks: [both, onlyHere, onlyNavidrome],
  albums: [album("Shared LP", "Shared Band", [both]), album("Home LP", "Home Artist", [onlyHere]), album("Far LP", "Far Artist", [onlyNavidrome])],
  artists: [artist("Shared Band"), artist("Home Artist"), artist("Far Artist")],
};
const titles = (list) => list.map((x) => x.title ?? x.name);

test("a song kept here and on Jellyfin is found under both, once each; Jellyfin stays to pick though its songs all have local copies", () => {
  const jelly = scopeLibrary(library, versions, "jellyfin");
  assert.deepEqual([...jelly.sources].sort(), ["jellyfin", "local", "subsonic"]);
  assert.deepEqual(titles(jelly.tracks), ["Twice"]);
  assert.deepEqual(titles(scopeLibrary(library, versions, "local").tracks), ["Twice", "Mine"]);
  assert.deepEqual(titles(scopeLibrary(library, versions, "subsonic").tracks), ["Theirs"]);
  assert.deepEqual(titles(scopeLibrary(library, versions, "all").tracks), ["Twice", "Mine", "Theirs"]);
});

test("under Jellyfin, an album only on this computer isn't there, nor its artist; the same goes for Navidrome's", () => {
  const jelly = scopeLibrary(library, versions, "jellyfin");
  assert.deepEqual(titles(jelly.albums), ["Shared LP"]);
  assert.deepEqual(titles(jelly.artists), ["Shared Band"]);
  const here = scopeLibrary(library, versions, "local");
  assert.deepEqual(titles(here.albums), ["Shared LP", "Home LP"]);
  assert.deepEqual(titles(here.artists), ["Shared Band", "Home Artist"]);
  const all = scopeLibrary(library, versions, "all");
  assert.equal(all.albums.length, 3);
  assert.equal(all.artists.length, 3);
});
