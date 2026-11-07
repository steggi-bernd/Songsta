// Switching an Android TV off (src/lib/tvRemote.ts, electron/tv-remote.ts): the protocol against a stand-in that keeps to what the
// real one's messages look like, over real TLS with this app's own certificate.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import tls from "node:tls";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

globalThis.__store = new Map();
const stubs = {
  name: "stubs",
  setup(b) {
    b.onResolve({ filter: /^\.\/(persist|secrets)$/ }, (a) => ({ path: a.path.slice(2), namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
      loader: "js",
      contents: {
        persist: "export const readData = (n) => globalThis.__store.get(n) ?? null; export const writeData = async (n, v) => { globalThis.__store.set(n, v); };",
        secrets: "export const sealSecret = (s) => 'sealed:' + s; export const openSecret = (s) => (typeof s === 'string' && s.startsWith('sealed:') ? s.slice(7) : null);",
      }[a.path],
    }));
  },
};
async function load(entry) {
  const out = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: "node", format: "esm", write: false, plugins: [stubs] });
  return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString("base64")}`);
}
const lib = await load("../src/lib/tvRemote.ts");
const desk = await load("../electron/tv-remote.ts");

/* ------------------------------------------------------------ hand-made protobuf, separate from the code under test */
function varint(v) {
  const out = [];
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}
const num = (f, v) => [...varint(f << 3), ...varint(v)];
const msg = (f, body) => [...varint((f << 3) | 2), ...varint(body.length), ...body];
const text = (f, s) => msg(f, [...Buffer.from(s)]);
const frame = (body) => Buffer.from([...varint(body.length), ...body]);
const read = (bytes) => lib.readFields(new Uint8Array(bytes));
function frames(onMessage) {
  let buffer = Buffer.alloc(0);
  return (data) => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      let size = 0;
      let scale = 1;
      let at = 0;
      for (;;) {
        if (at >= buffer.length) return;
        const b = buffer[at++];
        size += (b & 0x7f) * scale;
        if (!(b & 0x80)) break;
        scale *= 128;
      }
      if (buffer.length < at + size) return;
      onMessage(read(buffer.subarray(at, at + size)));
      buffer = buffer.subarray(at + size);
    }
  };
}

const keyOf = (pem) => {
  const jwk = new crypto.X509Certificate(pem).publicKey.export({ format: "jwk" });
  const hex = (t) => Buffer.from(t, "base64url").toString("hex");
  return { n: hex(jwk.n), e: hex(jwk.e) };
};
const pemOf = (raw) => `-----BEGIN CERTIFICATE-----\n${raw.toString("base64")}\n-----END CERTIFICATE-----\n`;

test("SHA-256 by hand says what the real one says", () => {
  for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000]) {
    const data = crypto.randomBytes(size);
    assert.equal(Buffer.from(lib.sha256(new Uint8Array(data))).toString("hex"), crypto.createHash("sha256").update(data).digest("hex"), `${size} bytes`);
  }
  assert.equal(Buffer.from(lib.sha256(Uint8Array.from(Buffer.from("abc")))).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("this app's certificate is a real one: self-signed, ten years, the key inside fits", () => {
  const made = desk.makeCertificate("Songsta", new Date("2026-11-07T12:00:00Z"));
  const cert = new crypto.X509Certificate(made.cert);
  assert.equal(cert.subject, "CN=Songsta");
  assert.equal(cert.issuer, "CN=Songsta");
  assert.ok(cert.verify(cert.publicKey), "signed by its own key");
  assert.equal(new Date(cert.validFrom).getUTCFullYear(), 2026);
  assert.equal(new Date(cert.validTo).getUTCFullYear(), 2036);
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey(made.key)));
  assert.match(cert.subjectAltName ?? "", /DNS:Songsta/);
  assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength, 2048);
});

test("the code: its first byte is a check, the rest goes into the hash with both keys", () => {
  const client = { modulus: "c0ffee", exponent: "10001" };
  const server = { modulus: "BADCAF", exponent: "0x10001" };
  const want = crypto.createHash("sha256").update(Buffer.from("c0ffee010001badcaf010001a1b2", "hex")).digest();
  const code = `${want[0].toString(16).padStart(2, "0")}a1b2`;
  assert.equal(Buffer.from(lib.tvSecret(client, server, code)).toString("hex"), want.toString("hex"));
  assert.equal(Buffer.from(lib.tvSecret(client, server, ` ${code.toUpperCase()} `)).toString("hex"), want.toString("hex"), "however it's typed");
  const wrong = `${((want[0] + 1) & 255).toString(16).padStart(2, "0")}a1b2`;
  assert.equal(lib.tvSecret(client, server, wrong), null, "mistyped");
  for (const bad of ["", "12345", "1234567", "12345g"]) assert.equal(lib.tvSecret(client, server, bad), null, bad);
});

/** A TV's pairing side, as its messages go, with the code it would show. */
function pairingTv({ refuse = false } = {}) {
  const seen = { names: [], secret: null, code: null };
  return {
    seen,
    handler(socket, own) {
      const ok = [...num(1, 2), ...num(2, 200)];
      socket.on(
        "data",
        frames((f) => {
          if (f.has(10)) {
            const request = lib.readFields(f.get(10)[0]);
            seen.names.push(Buffer.from(request.get(1)[0]).toString(), Buffer.from(request.get(2)[0]).toString());
            socket.write(frame([...ok, ...msg(11, text(1, "Stand-in TV"))]));
          } else if (f.has(20)) {
            const options = lib.readFields(f.get(20)[0]);
            const encoding = lib.readFields(options.get(1)[0]);
            assert.deepEqual([encoding.get(1)[0], encoding.get(2)[0], options.get(3)[0]], [3, 6, 1]);
            socket.write(frame([...ok, ...msg(20, [...msg(2, [...num(1, 3), ...num(2, 6)]), ...num(3, 1)])]));
          } else if (f.has(30)) {
            const config = lib.readFields(f.get(30)[0]);
            assert.equal(config.get(2)[0], 1);
            // Now it shows a code, made of both keys.
            const client = keyOf(pemOf(socket.getPeerCertificate().raw));
            const server = keyOf(own.cert);
            const rest = "a1b2";
            const hash = crypto.createHash("sha256").update(Buffer.from(`${client.n}${client.e}${server.n}${server.e}${rest}`, "hex")).digest();
            seen.code = `${hash[0].toString(16).padStart(2, "0")}${rest}`;
            seen.hash = hash;
            socket.write(frame([...ok, ...msg(31, [])]));
          } else if (f.has(40)) {
            const secret = Buffer.from(lib.readFields(f.get(40)[0]).get(1)[0]);
            seen.secret = secret;
            if (refuse || !secret.equals(seen.hash)) socket.write(frame([...num(1, 2), ...num(2, 402)]));
            else socket.write(frame([...ok, ...msg(41, text(1, "x"))]));
          }
        })
      );
      socket.on("error", () => undefined);
    },
  };
}

/** The stand-in on the port the protocol fixes. */
async function onPort(port, handler) {
  const own = desk.makeCertificate("Stand-in TV");
  const server = tls.createServer({ key: own.key, cert: own.cert, requestCert: true, rejectUnauthorized: false }, (socket) => handler(socket, own));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

test("pairing from start to end: the code typed goes back right, and the TV takes it", async (t) => {
  const tv = pairingTv();
  const server = await onPort(lib.TV_PAIRING_PORT, tv.handler);
  t.after(() => server.close());
  await desk.startPairing("127.0.0.1");
  assert.deepEqual(tv.seen.names, ["atvremote", "Songsta"]);
  assert.ok(tv.seen.code, "the TV shows its code now");
  assert.equal(await desk.finishPairing("000000".replace(/^00/, tv.seen.code.startsWith("00") ? "01" : "00")), "mistyped");
  assert.equal(tv.seen.secret, null, "a mistyped code never leaves this computer");
  // A mistyped code ended this try: the next one starts again.
  await desk.startPairing("127.0.0.1");
  assert.equal(await desk.finishPairing(tv.seen.code), "ok");
  assert.equal(tv.seen.secret.length, 32);
  assert.ok(globalThis.__store.get("tv-remote").key.startsWith("sealed:"), "the key is kept sealed");
});

test("the TV turning a code down is said as such", async (t) => {
  const tv = pairingTv({ refuse: true });
  const server = await onPort(lib.TV_PAIRING_PORT, tv.handler);
  t.after(() => server.close());
  await desk.startPairing("127.0.0.1");
  assert.equal(await desk.finishPairing(tv.seen.code), "refused");
});

/** A TV's remote side, in the order the real one talks. */
function remoteTv({ on = true, app = null, features = 622 } = {}) {
  const seen = { configure: null, active: null, keys: [], pings: [] };
  return {
    seen,
    handler(socket) {
      socket.on("error", () => undefined);
      socket.write(frame(msg(1, [...num(1, features), ...msg(2, [...text(1, "Stand-in"), ...text(2, "Test")])])));
      socket.on(
        "data",
        frames((f) => {
          if (f.has(1)) {
            seen.configure = lib.readFields(f.get(1)[0]);
            socket.write(frame(msg(2, [])));
          } else if (f.has(2)) {
            seen.active = lib.readFields(f.get(2)[0]).get(1)[0];
            // false is left out on the wire: an empty message.
            socket.write(frame([...msg(8, num(1, 7)), ...[]]));
            socket.write(frame(msg(40, on ? num(1, 1) : [])));
            if (app) socket.write(frame(msg(20, msg(1, [...num(1, 1), ...text(12, app)]))));
          } else if (f.has(9)) {
            seen.pings.push(lib.readFields(f.get(9)[0]).get(1)[0]);
          } else if (f.has(10)) {
            const key = lib.readFields(f.get(10)[0]);
            seen.keys.push([key.get(1)[0], key.get(2)[0]]);
          }
        })
      );
    },
  };
}

test("how a TV stands: what's on it, and it answers its pings along the way", async (t) => {
  const tv = remoteTv({ app: "com.google.android.apps.tv.launcherx" });
  const server = await onPort(lib.TV_REMOTE_PORT, tv.handler);
  t.after(() => server.close());
  assert.deepEqual(await desk.readTv("127.0.0.1"), { on: true, busy: false });
  assert.equal(tv.seen.configure.get(1)[0], 622 & 39, "only what both can do");
  assert.equal(tv.seen.active, 39);
  assert.deepEqual(tv.seen.pings, [7]);
  assert.deepEqual(tv.seen.keys, [], "looking presses nothing");
});

test("an app open means somebody may be watching; Cast sitting there doesn't", async (t) => {
  for (const [app, busy] of [
    ["com.netflix.ninja", true],
    ["com.google.android.youtube.tv", true],
    ["com.google.android.apps.mediashell", false],
    ["com.google.android.tvlauncher", false],
    ["com.google.android.leanbacklauncher", false],
    [null, false],
  ]) {
    const server = await onPort(lib.TV_REMOTE_PORT, remoteTv({ app }).handler);
    assert.deepEqual(await desk.readTv("127.0.0.1"), { on: true, busy }, String(app));
    await new Promise((r) => server.close(r));
  }
  void t;
});

test("switching off: the power key once, when it's on", async (t) => {
  const tv = remoteTv();
  const server = await onPort(lib.TV_REMOTE_PORT, tv.handler);
  t.after(() => server.close());
  assert.equal(await desk.switchTvOff("127.0.0.1"), true);
  assert.deepEqual(tv.seen.keys, [[26, 3]]);
});

test("one that's off already gets no key: the key is a toggle", async (t) => {
  const tv = remoteTv({ on: false });
  const server = await onPort(lib.TV_REMOTE_PORT, tv.handler);
  t.after(() => server.close());
  assert.deepEqual(await desk.readTv("127.0.0.1"), { on: false, busy: false });
  assert.equal(await desk.switchTvOff("127.0.0.1"), true);
  assert.deepEqual(tv.seen.keys, []);
});

test("nobody there: it says so instead of hanging", async () => {
  assert.equal(await desk.readTv("127.0.0.1"), null);
  assert.equal(await desk.switchTvOff("127.0.0.1"), false);
  await assert.rejects(desk.startPairing("127.0.0.1"));
  assert.equal(await desk.finishPairing("123456"), "failed");
});

test("messages arrive however the network cuts them", async () => {
  const data = [];
  let close = () => undefined;
  const socket = {
    write: () => undefined,
    close: () => close(),
    onData: (f) => data.push(f),
    onClose: (f) => {
      close = f;
    },
  };
  const remote = new lib.TvRemote(socket);
  const bytes = [...frame(msg(40, num(1, 1))), ...frame(msg(20, msg(1, text(12, "com.netflix.ninja"))))];
  for (const b of bytes) data[0](Uint8Array.from([b]));
  assert.equal(remote.on, true);
  assert.equal(remote.app, "com.netflix.ninja");
  // Rubbish on the line: it hangs up rather than falls over.
  let closed = false;
  close = () => {
    closed = true;
  };
  data[0](Uint8Array.from([3, 0xff, 0xff, 0xff]));
  assert.equal(closed, true);
});
