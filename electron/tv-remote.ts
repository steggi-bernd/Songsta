/**
 * The computer's share of switching a Google TV off (src/lib/tvRemote.ts): TLS with a
 * certificate of this app's own, made once, its key sealed like the servers' logins.
 */
import * as crypto from "crypto";
import * as tls from "tls";
import type { CastSocket } from "../src/lib/castV2";
import { TV_PAIRING_PORT, TV_REMOTE_PORT, TvCodeRefused, TvPairing, tvSecret, tvState, tvSwitchOff, type TvKey, type TvState } from "../src/lib/tvRemote";
import * as persist from "./persist";
import { openSecret, sealSecret } from "./secrets";

const STORE = "tv-remote";
const CLIENT_NAME = "Songsta";
const CONNECT_MS = 6000;

interface Stored {
  cert: string;
  key: string;
}

/* ------------------------------------------------------------- a certificate, by hand: Node has none to make them with */

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const size = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 255]);
  return Buffer.concat([Buffer.from([tag]), size, body]);
}

const sequence = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const set = (...parts: Buffer[]): Buffer => der(0x31, ...parts);
const oid = (bytes: number[]): Buffer => der(0x06, Buffer.from(bytes));
const OID_COMMON_NAME = [0x55, 0x04, 0x03];
const OID_SHA256_RSA = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b];
const OID_BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];
const OID_SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];

function utcTime(date: Date): Buffer {
  const two = (n: number): string => String(n).padStart(2, "0");
  const text = `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, Buffer.from(text, "ascii"));
}

/** Self-signed, as the TV expects from a remote: it only cares about the key inside. */
export function makeCertificate(name: string, now = new Date()): Stored {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const algorithm = sequence(oid(OID_SHA256_RSA), der(0x05));
  const subject = sequence(set(sequence(oid(OID_COMMON_NAME), der(0x0c, Buffer.from(name, "utf8")))));
  const until = new Date(now);
  until.setUTCFullYear(now.getUTCFullYear() + 10);
  const extensions = der(
    0xa3,
    sequence(
      sequence(oid(OID_BASIC_CONSTRAINTS), der(0x04, sequence(der(0x01, Buffer.from([0xff]))))),
      sequence(oid(OID_SUBJECT_ALT_NAME), der(0x04, sequence(der(0x82, Buffer.from(name, "ascii")))))
    )
  );
  const toBeSigned = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([0x03, 0xe8])),
    algorithm,
    subject,
    sequence(utcTime(now), utcTime(until)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    extensions
  );
  const signature = crypto.sign("sha256", toBeSigned, privateKey);
  const certificate = sequence(toBeSigned, algorithm, der(0x03, Buffer.from([0]), signature));
  const lines = certificate.toString("base64").replace(/(.{64})/g, "$1\n").trim();
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
}

function ownCertificate(): Stored {
  const stored = persist.readData(STORE) as Stored | null;
  const key = stored?.key ? openSecret(stored.key) : null;
  if (stored?.cert && key) return { cert: stored.cert, key };
  const made = makeCertificate(CLIENT_NAME);
  void persist.writeData(STORE, { cert: made.cert, key: sealSecret(made.key) });
  return made;
}

function clientKey(cert: string): TvKey {
  const jwk = new crypto.X509Certificate(cert).publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const hex = (text: string): string => Buffer.from(text, "base64url").toString("hex");
  return { modulus: hex(jwk.n), exponent: hex(jwk.e) };
}

interface Opened {
  socket: CastSocket;
  serverKey: TvKey;
}

function open(host: string, port: number, own: Stored): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, key: own.key, cert: own.cert, rejectUnauthorized: false }, () => {
      socket.setTimeout(0);
      const peer = socket.getPeerCertificate();
      resolve({
        serverKey: { modulus: peer.modulus ?? "", exponent: peer.exponent ?? "" },
        socket: {
          write: (bytes) => void socket.write(bytes),
          close: () => socket.destroy(),
          onData: (listener) => void socket.on("data", (data: Buffer) => listener(new Uint8Array(data))),
          onClose: (listener) => void socket.on("close", listener),
        },
      });
    });
    socket.once("error", reject);
    socket.setTimeout(CONNECT_MS, () => socket.destroy(new Error("The TV doesn't answer")));
  });
}

const remoteOf = (host: string) => async (): Promise<CastSocket> => (await open(host, TV_REMOTE_PORT, ownCertificate())).socket;

export const readTv = (host: string): Promise<TvState | null> => tvState(remoteOf(host));

export const switchTvOff = (host: string): Promise<boolean> => tvSwitchOff(remoteOf(host));

/* ------------------------------------------------------------- the one pairing that can be under way */

let pairing: { tv: TvPairing; serverKey: TvKey; own: Stored } | null = null;

export function cancelPairing(): void {
  pairing?.tv.close();
  pairing = null;
}

/** The TV shows a code once this is through. */
export async function startPairing(host: string): Promise<void> {
  cancelPairing();
  const own = ownCertificate();
  const { socket, serverKey } = await open(host, TV_PAIRING_PORT, own);
  const tv = new TvPairing(socket, CLIENT_NAME);
  try {
    await tv.start();
  } catch (err) {
    tv.close();
    throw err;
  }
  pairing = { tv, serverKey, own };
}

/** "ok", or why not: a mistyped code can be typed again, one the TV turned down needs a new start. */
export async function finishPairing(code: string): Promise<"ok" | "mistyped" | "refused" | "failed"> {
  if (!pairing) return "failed";
  const secret = tvSecret(clientKey(pairing.own.cert), pairing.serverKey, code);
  if (!secret) return "mistyped";
  try {
    await pairing.tv.finish(secret);
    return "ok";
  } catch (err) {
    return err instanceof TvCodeRefused ? "refused" : "failed";
  } finally {
    cancelPairing();
  }
}
