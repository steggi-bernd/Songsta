// Folders changed while the phone reads them (mobile/src/stores/localMusic.ts, plan section 4): a folder
// taken out during its scan doesn't come back with what that scan read, one added meanwhile is read after,
// and one picked anew during its scan is read anew.
import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const stores = fileURLToPath(new URL("../mobile/src/stores/", import.meta.url));
const stubs = {
  storage: `export const readJson = async (name) => globalThis.__files?.[name] ?? null;
    export const writeJson = (name, value) => { (globalThis.__files ??= {})[name] = structuredClone(value); };`,
  "stores/popups": `export const toast = (text) => { (globalThis.__toasts ??= []).push(text); };`,
  "stores/settings": `export const useSettings = { getState: () => ({ filterNonMusic: false }) };`,
  shared: `export const albumRoute = (key) => key; export const libraryAlbumKey = () => null; export const T = (text) => text;`,
};
const out = await build({
  stdin: { contents: `export { useLocalMusic } from "./localMusic";`, resolveDir: stores, loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "stubs",
      setup(b) {
        b.onResolve({ filter: /media3-player$/ }, () => ({ path: "media3", namespace: "stub" }));
        // Each folder's scan waits until the test lets it through, with the files the test says it holds.
        b.onLoad({ filter: /^media3$/, namespace: "stub" }, () => ({
          contents: `export default {
            pickFolder: async () => globalThis.__nextPick ?? null,
            localForget: async () => undefined,
            addListener: () => ({ remove() {} }),
            localScan: (uri) => new Promise((resolve) => { (globalThis.__scans ??= []).push({ uri, done: () => resolve(globalThis.__folderFiles?.[uri] ?? []) }); }),
          };`,
          loader: "js",
        }));
        for (const [name, contents] of Object.entries(stubs)) {
          const filter = new RegExp(`[\\\\/]mobile[\\\\/]src[\\\\/]${name.replace("/", "[\\\\/]")}\\.ts$`);
          b.onLoad({ filter }, () => ({ contents, resolveDir: stores, loader: "js" }));
        }
      },
    },
  ],
});
const { useLocalMusic } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);

const file = (folder, name) => ({ uri: `${folder}/${name}`, name, path: `${folder}/${name}`, modified: 1, durationMs: 100_000, unchanged: false });
const tick = () => new Promise((resolve) => setImmediate(resolve));
/** Lets the oldest waiting scan through. */
async function finishScan(uri) {
  await tick();
  const at = globalThis.__scans.findIndex((s) => s.uri === uri);
  assert.ok(at >= 0, `a scan of ${uri} under way`);
  const [scan] = globalThis.__scans.splice(at, 1);
  scan.done();
  await tick();
}
const folders = () => useLocalMusic.getState().folders.map((f) => f.uri);
const filesIn = () => [...new Set(useLocalMusic.getState().files.map((f) => f.folder))].sort();
const saved = () => [...new Set((globalThis.__files["local-music.json"]?.files ?? []).map((f) => f.folder))].sort();

beforeEach(() => {
  useLocalMusic.setState({ folders: [], files: [], scanning: null });
  globalThis.__scans = [];
  globalThis.__files = {};
  globalThis.__folderFiles = { "content://a": [file("content://a", "a1.mp3")], "content://b": [file("content://b", "b1.mp3")] };
});

test("A taken out while it's read and B added meanwhile: only B ends up in the files, and in what's kept", async () => {
  globalThis.__nextPick = { uri: "content://a", name: "A" };
  await useLocalMusic.getState().addFolder();
  // A is being read; B comes in, A goes.
  globalThis.__nextPick = { uri: "content://b", name: "B" };
  await useLocalMusic.getState().addFolder();
  useLocalMusic.getState().removeFolder("content://a");
  await finishScan("content://a");
  // The scan asked for meanwhile reads B.
  await finishScan("content://b");
  await tick();
  assert.deepEqual(folders(), ["content://b"]);
  assert.deepEqual(filesIn(), ["content://b"], "nothing of A came back");
  assert.deepEqual(saved(), ["content://b"], "and what's kept says the same");
  assert.equal(useLocalMusic.getState().scanning, null);
});

test("A picked anew while it's read: what was read before goes, and A is read again", async () => {
  globalThis.__nextPick = { uri: "content://a", name: "A" };
  await useLocalMusic.getState().addFolder();
  useLocalMusic.getState().removeFolder("content://a");
  globalThis.__folderFiles["content://a"] = [file("content://a", "a2.mp3")];
  await useLocalMusic.getState().addFolder();
  globalThis.__folderFiles["content://a"] = [file("content://a", "old.mp3")];
  // The first scan comes back with what A held before: dropped.
  await finishScan("content://a");
  assert.deepEqual(useLocalMusic.getState().files.map((f) => f.name), [], "the old read isn't taken");
  globalThis.__folderFiles["content://a"] = [file("content://a", "a2.mp3")];
  await finishScan("content://a");
  await tick();
  assert.deepEqual(useLocalMusic.getState().files.map((f) => f.name), ["a2.mp3"]);
});
