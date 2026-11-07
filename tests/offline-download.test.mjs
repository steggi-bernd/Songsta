// Offline copies of server songs (electron/downloads.ts): the original file, filed as
// <Music>/Songsta Offline/<artist>/<album>/<no> <title>.<ext>, fetched with the server's auth header.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

async function loadDownloads(dir, original) {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/downloads.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["electron", "./jellyfin", "./subsonic"],
  });
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, setTimeout, clearTimeout, console, Buffer, AbortController, fetch, Response,
    require(name) {
      if (name === "electron") return { app: { getPath: () => dir } };
      if (name === "./jellyfin" || name === "./subsonic") return { originalFile: original };
      return require(name);
    },
  });
  return module.exports;
}

test("a Jellyfin song's original lands in the offline library folder, filed by artist and album", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-offline-"));
  let auth = "";
  const server = http.createServer((req, res) => {
    auth = req.headers.authorization ?? "";
    res.writeHead(200, { "Content-Type": "audio/flac", "Content-Disposition": 'attachment; filename="02 - Night Ferry.flac"', "Content-Length": "4" });
    res.end("fLaC");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const downloads = await loadDownloads(dir, (id) => ({ url: `${base}/Items/${id}/Download`, headers: { Authorization: 'MediaBrowser Token="secret"' }, ext: ".mp3" }));

  const done = new Promise((resolve, reject) =>
    downloads.addDownloadListener((e) => (e.type === "done" ? resolve(e) : e.type === "failed" ? reject(new Error(e.reason)) : undefined))
  );
  downloads.enqueueDownload({ id: "jf:0123456789abcdef0123456789abcdef", title: "Night Ferry", artist: "Lumen Harbor", album: "Night Ferry", trackNo: 2, duration: 252, thumb: "" });
  const event = await done;

  const expected = path.join(dir, "Songsta Offline", "Lumen Harbor", "Night Ferry", "02 Night Ferry.flac");
  assert.equal(event.path, expected, "filed by artist and album, the extension the server gave its file");
  assert.equal(fs.readFileSync(expected, "utf8"), "fLaC");
  assert.equal(auth, 'MediaBrowser Token="secret"', "the login travels in the header, from the main process only");
  assert.equal(downloads.offlineDir(), path.join(dir, "Songsta Offline"));
});
