// Songs only a phone linked to this computer has (phase 2, the other way): the phone sends where its file
// server hands each one out, this computer plays it from there through its stream proxy. Only a phone's
// file server at home goes through: nothing else becomes reachable that way.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

async function load(entry, stubs = {}) {
  const out = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /^\.\/(jellyfin|subsonic|local-library|transcode)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: stubs[a.path] ?? "export {};", loader: "js" }));
        },
      },
    ],
  });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}

const proxy = await load("../electron/stream-proxy.ts", {
  "./jellyfin": "export const fetchStream = async () => new Response(null, { status: 404 });",
  "./subsonic": "export const fetchStream = async () => new Response(null, { status: 404 });",
  "./local-library": "export const localStreamPath = () => null;",
  "./transcode": "export const servedPathFor = (p) => p;",
});
const peer = await load("../src/lib/peerSongs.ts");
const SONG = "http://192.168.178.50:41234/song/0123456789abcdef0123456789abcdef.flac";

test("only a phone's file server at home passes as a song's address", () => {
  for (const ok of [SONG, "http://10.0.0.7:8080/song/ffffffffffffffffffffffffffffffff.mp3", "http://172.20.1.2:5000/song/00000000000000000000000000000000.m4a"]) {
    assert.equal(proxy.isPeerAddress(ok), true, ok);
  }
  for (const bad of [
    "https://192.168.178.50:41234/song/0123456789abcdef0123456789abcdef.flac",
    "http://8.8.8.8:41234/song/0123456789abcdef0123456789abcdef.flac",
    "http://127.0.0.1:8197/song/0123456789abcdef0123456789abcdef.flac",
    "http://172.32.0.1:41234/song/0123456789abcdef0123456789abcdef.flac",
    "http://192.168.178.50:41234/v1/docs/playlists",
    "http://192.168.178.50:41234/song/0123456789abcdef0123456789abcdef.flac?x=1",
    "http://user:pass@192.168.178.50:41234/song/0123456789abcdef0123456789abcdef.flac",
    "http://phone.local:41234/song/0123456789abcdef0123456789abcdef.flac",
    "file:///C:/secret.flac",
    "not an address",
  ]) {
    assert.equal(proxy.isPeerAddress(bad), false, bad);
  }
});

test("the stream proxy gives a phone's song an address of its own and turns anything else away", async () => {
  const port = await proxy.startStreamProxy();
  after(() => proxy.stopStreamProxy?.());
  const url = proxy.proxyUrlForPeer(SONG);
  assert.equal(url, `http://127.0.0.1:${port}/?peer=${encodeURIComponent(SONG)}`);
  assert.equal(proxy.proxyUrlForPeer("http://8.8.8.8:80/song/0123456789abcdef0123456789abcdef.flac"), null);
  const refused = await fetch(`http://127.0.0.1:${port}/?peer=${encodeURIComponent("http://127.0.0.1:8197/v1/docs/playlists")}`);
  assert.equal(refused.status, 400, "not a phone's song: nothing is fetched");
});

test("a song the phone said it hands out plays from there; without such an address it isn't one", () => {
  const wire = { id: "local:phone1", title: "Night Ferry", artist: "Lumen Harbor", duration: 210, src: SONG };
  const song = peer.songFromPhone(wire);
  assert.equal(song.id, "local:phone1");
  assert.equal(song.title, "Night Ferry");
  assert.equal("src" in song, false, "the address isn't part of the song");
  assert.equal(peer.phoneAddressOf("local:phone1"), SONG);
  assert.equal(peer.songFromPhone({ ...wire, id: "local:phone2", src: undefined }), undefined);
  assert.equal(peer.songFromPhone({ ...wire, id: "local:phone3", src: "https://example.com/song.flac" }), undefined);
  assert.equal(peer.phoneAddressOf("local:phone3"), undefined);
});
