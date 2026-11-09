// The album cover on the Discord status (electron/metadata.ts discordCover). Discord fetches the
// picture itself and gives up on an address that redirects, as the Cover Art Archive's do, and
// shows the application's icon instead. So iTunes, whose pictures come straight from a CDN, is
// asked first, and an archive picture goes by its final address. No network: a stand-in fetch.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const store = new Map();
globalThis.__store = store;
const out = await build({
  entryPoints: [fileURLToPath(new URL("../electron/metadata.ts", import.meta.url))],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "stub" }));
        b.onResolve({ filter: /^\.\/(persist|local-library)$/ }, (a) => ({ path: a.path.slice(2), namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
          loader: "js",
          contents: {
            electron: `export const app = { getPath: () => ${JSON.stringify(os.tmpdir())}, getLocale: () => "de", getVersion: () => "0.0.0" };`,
            persist: "export const readData = (n) => globalThis.__store.get(n) ?? null; export const writeData = async (n, v) => { globalThis.__store.set(n, v); };",
            "local-library": "export const storeFetchedArt = () => undefined;",
          }[a.path],
        }));
      },
    },
  ],
});
const meta = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

/** What the stand-in services answer, and what was asked of them. */
const stage = { itunes: [], groups: [], finalUrl: "", finalType: "image/jpeg", asked: [] };
const answer = (body) => ({ ok: true, status: 200, url: "", headers: new Headers({ "content-type": "application/json" }), json: async () => body });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  stage.asked.push(`${init.method ?? "GET"} ${new URL(url).host}`);
  if (url.startsWith("https://itunes.apple.com/search")) return answer({ results: stage.itunes });
  if (url.startsWith("https://musicbrainz.org/ws/2/release-group")) return answer({ "release-groups": stage.groups });
  if (url.startsWith("https://coverartarchive.org/")) {
    // fetch follows the archive's redirects: the answer carries the address it ended up at.
    return { ok: !!stage.finalUrl, status: stage.finalUrl ? 200 : 404, url: stage.finalUrl, headers: new Headers({ "content-type": stage.finalType }) };
  }
  throw new TypeError("no network in tests");
};

const group = (title, artist) => ({ id: `rg-${title.length}-${artist.length}`, title, score: 100, "artist-credit": [{ name: artist, joinphrase: "" }], "first-release-date": "2021-03-01" });
const itunesAlbum = (title, artist) => ({ collectionName: title, artistName: artist, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/Music/v4/${title.length}/100x100bb.jpg`, releaseDate: "2021-03-01T08:00:00Z" });

beforeEach(() => {
  Object.assign(stage, { itunes: [], groups: [], finalUrl: "", finalType: "image/jpeg", asked: [] });
});

test("iTunes' picture comes first: straight from its CDN, at 600 px, and MusicBrainz isn't asked", async () => {
  stage.itunes = [itunesAlbum("Night Ferry", "Lumen Harbor")];
  const url = await meta.discordCover("Lumen Harbor", "Night Ferry");
  assert.equal(url, "https://is1-ssl.mzstatic.com/image/thumb/Music/v4/11/600x600bb.jpg");
  assert.deepEqual(stage.asked, ["GET itunes.apple.com"]);
});

test("without iTunes, the archive's picture goes by its final address, not the redirecting one", async () => {
  stage.groups = [group("Paper Lanterns", "Wren")];
  stage.finalUrl = "https://ia800106.us.archive.org/17/items/mbid-1/mbid-1-500.jpg";
  const url = await meta.discordCover("Wren", "Paper Lanterns");
  assert.equal(url, stage.finalUrl);
  assert.ok(!url.includes("coverartarchive.org"), "never the address that redirects");
});

test("a final address Discord can't take leaves the logo: not a picture, not https, or too long", async () => {
  stage.groups = [group("Tidewater", "Wren")];
  stage.finalUrl = "https://ia800106.us.archive.org/items/mbid-2/index.html";
  stage.finalType = "text/html";
  assert.equal(await meta.discordCover("Wren", "Tidewater"), null);

  stage.groups = [group("Low Light", "Wren")];
  stage.finalUrl = `https://ia800106.us.archive.org/items/${"x".repeat(260)}.jpg`;
  stage.finalType = "image/jpeg";
  assert.equal(await meta.discordCover("Wren", "Low Light"), null);
});

test("nothing anywhere, or no real names: no cover, and placeholders ask nobody", async () => {
  assert.equal(await meta.discordCover("Wren", "Never Pressed"), null);
  stage.asked = [];
  assert.equal(await meta.discordCover("Unknown artist", "Night Ferry"), null);
  assert.equal(await meta.discordCover("Wren", "Unknown album"), null);
  assert.deepEqual(stage.asked, []);
});

test("an album found once is answered from memory", async () => {
  stage.itunes = [itunesAlbum("Harbor Lights", "Lumen Harbor")];
  const first = await meta.discordCover("Lumen Harbor", "Harbor Lights");
  stage.asked = [];
  assert.equal(await meta.discordCover("Lumen Harbor", "Harbor Lights"), first);
  assert.deepEqual(stage.asked, []);
});
