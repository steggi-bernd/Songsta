/**
 * Switching an Android TV or Google TV off from here. Cast has no word for it, but the
 * remote control the Google TV app speaks over the network has: a power key, and it tells
 * whether the screen is on and which app is open. Once per device and app the TV shows a
 * code to type in, as it does for that app. Pure, one copy for the computer and the phone:
 * how the bytes travel, TLS with a certificate of this app's own, is each app's business.
 */
import type { CastSocket } from "./castV2";
import { utf8Bytes, utf8Text } from "./castV2";

export const TV_PAIRING_PORT = 6467;
export const TV_REMOTE_PORT = 6466;
const STATUS_OK = 200;
const STATUS_BAD_SECRET = 402;
const REPLY_MS = 12_000;
const STATE_MS = 4000;
/** Which app is open comes a moment after the rest. */
const APP_WAIT_MS = 700;
/** The key on its way before the line goes. */
const AFTER_KEY_MS = 400;

/* ------------------------------------------------------------- SHA-256, by hand: Hermes has no crypto */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256(data: Uint8Array): Uint8Array {
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const length = data.length;
  const padded = new Uint8Array(((length + 9 + 63) >>> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const rotate = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  const w = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(block + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, x] = h;
    for (let t = 0; t < 64; t++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (x + s1 + choose + K[t] + w[t]) | 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const major = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + major) | 0;
      x = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + x) | 0;
  }
  const out = new Uint8Array(32);
  const result = new DataView(out.buffer);
  h.forEach((value, i) => result.setInt32(i * 4, value));
  return out;
}

/* ------------------------------------------------------------- the code the TV shows */

/** An RSA public key, its parts in hex. */
export interface TvKey {
  modulus: string;
  exponent: string;
}

function hexBytes(hex: string): number[] {
  let plain = hex.replace(/^0x/i, "").replace(/^0+/, "");
  if (plain.length % 2) plain = `0${plain}`;
  const out: number[] = [];
  for (let i = 0; i < plain.length; i += 2) out.push(parseInt(plain.slice(i, i + 2), 16));
  return out;
}

/**
 * What goes back to the TV for the code on its screen. The code's first byte is a check on
 * the rest: null means it was mistyped, and nothing needs to be sent.
 */
export function tvSecret(client: TvKey, server: TvKey, code: string): Uint8Array | null {
  const typed = code.trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(typed)) return null;
  const hash = sha256(Uint8Array.from([...hexBytes(client.modulus), ...hexBytes(client.exponent), ...hexBytes(server.modulus), ...hexBytes(server.exponent), ...hexBytes(typed.slice(2))]));
  return hash[0] === parseInt(typed.slice(0, 2), 16) ? hash : null;
}

/* ------------------------------------------------------------- protobuf, the little of it needed here */

type Fields = Map<number, (number | Uint8Array)[]>;

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

const numberField = (field: number, value: number): number[] => [...varint(field << 3), ...varint(value)];

function bytesField(field: number, bytes: ArrayLike<number>): number[] {
  return [...varint((field << 3) | 2), ...varint(bytes.length), ...Array.from(bytes)];
}

const textField = (field: number, text: string): number[] => bytesField(field, utf8Bytes(text));

export function readFields(bytes: Uint8Array): Fields {
  const fields: Fields = new Map();
  let i = 0;
  const readVarint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (i >= bytes.length) throw new Error("A message that stops halfway");
      const b = bytes[i++];
      value += (b & 0x7f) * scale;
      if (!(b & 0x80)) return value;
      scale *= 128;
    }
  };
  while (i < bytes.length) {
    const key = readVarint();
    const field = Math.floor(key / 8);
    const wire = key & 7;
    let value: number | Uint8Array;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const size = readVarint();
      if (i + size > bytes.length) throw new Error("A message that stops halfway");
      value = bytes.subarray(i, i + size);
      i += size;
    } else if (wire === 5) i += 4, (value = 0);
    else if (wire === 1) i += 8, (value = 0);
    else throw new Error("A message of an unknown kind");
    fields.set(field, [...(fields.get(field) ?? []), value]);
  }
  return fields;
}

const numberOf = (fields: Fields, field: number): number | null => {
  const value = fields.get(field)?.[0];
  return typeof value === "number" ? value : null;
};

const partOf = (fields: Fields, field: number): Fields | null => {
  const value = fields.get(field)?.[0];
  return value instanceof Uint8Array ? readFields(value) : null;
};

/** Messages with their length in front, however the bytes arrive. */
function listen(socket: CastSocket, onMessage: (fields: Fields) => void, onGone: () => void): void {
  let buffer = new Uint8Array(0);
  socket.onData((data) => {
    const joined = new Uint8Array(buffer.length + data.length);
    joined.set(buffer);
    joined.set(data, buffer.length);
    buffer = joined;
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
      const message = buffer.slice(at, at + size);
      buffer = buffer.slice(at + size);
      try {
        onMessage(readFields(message));
      } catch {
        socket.close();
        return;
      }
    }
  });
  socket.onClose(onGone);
}

const framed = (body: number[]): Uint8Array => Uint8Array.from([...varint(body.length), ...body]);

/* ------------------------------------------------------------- pairing */

const PAIRING_ACK = 11;
const PAIRING_OPTIONS = 20;
const PAIRING_CONFIG_ACK = 31;
const PAIRING_SECRET_ACK = 41;
const HEXADECIMAL = 3;
const CODE_LENGTH = 6;
const ROLE_INPUT = 1;

/** The TV turned the code down: another try starts again with a new one. */
export class TvCodeRefused extends Error {}

export class TvPairing {
  private waiting: { field: number; done: () => void; fail: (err: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private gone = false;

  constructor(
    private socket: CastSocket,
    private clientName: string
  ) {
    listen(
      socket,
      (fields) => {
        const w = this.waiting;
        if (!w) return;
        const status = numberOf(fields, 2);
        if (status !== STATUS_OK) {
          this.answer(status === STATUS_BAD_SECRET ? new TvCodeRefused("That code doesn't fit") : new Error("The TV turned that down"));
          return;
        }
        if (fields.has(w.field)) this.answer();
      },
      () => {
        this.gone = true;
        this.answer(new Error("The TV hung up"));
      }
    );
  }

  private answer(err?: Error): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    clearTimeout(w.timer);
    if (err) w.fail(err);
    else w.done();
  }

  private ask(body: number[], field: number): Promise<void> {
    if (this.gone) return Promise.reject(new Error("The TV hung up"));
    return new Promise((done, fail) => {
      const timer = setTimeout(() => this.answer(new Error("The TV doesn't answer")), REPLY_MS);
      this.waiting = { field, done, fail, timer };
      this.socket.write(framed([...numberField(1, 2), ...numberField(2, STATUS_OK), ...body]));
    });
  }

  /** Up to where the TV shows its code. */
  async start(): Promise<void> {
    const encoding = [...numberField(1, HEXADECIMAL), ...numberField(2, CODE_LENGTH)];
    await this.ask(bytesField(10, [...textField(1, "atvremote"), ...textField(2, this.clientName)]), PAIRING_ACK);
    await this.ask(bytesField(PAIRING_OPTIONS, [...bytesField(1, encoding), ...numberField(3, ROLE_INPUT)]), PAIRING_OPTIONS);
    await this.ask(bytesField(30, [...bytesField(1, encoding), ...numberField(2, ROLE_INPUT)]), PAIRING_CONFIG_ACK);
  }

  /** What `tvSecret` made of the typed code. */
  finish(secret: Uint8Array): Promise<void> {
    return this.ask(bytesField(40, bytesField(1, secret)), PAIRING_SECRET_ACK);
  }

  close(): void {
    this.socket.close();
  }
}

/* ------------------------------------------------------------- the remote */

const FEATURE_PING = 1;
const FEATURE_KEY = 2;
const FEATURE_IME = 4;
const FEATURE_POWER = 32;
/** What this client can do: the IME part is only asked for because it tells which app is open. */
const FEATURES = FEATURE_PING | FEATURE_KEY | FEATURE_IME | FEATURE_POWER;
const KEYCODE_POWER = 26;
const KEY_SHORT = 3;

export class TvRemote {
  /** whether its screen is on; null until it has said */
  on: boolean | null = null;
  /** the app that's open, when it has said */
  app: string | null = null;
  gone = false;

  constructor(private socket: CastSocket) {
    listen(
      socket,
      (fields) => this.hear(fields),
      () => {
        this.gone = true;
      }
    );
  }

  private send(body: number[]): void {
    this.socket.write(framed(body));
  }

  private hear(fields: Fields): void {
    const configure = partOf(fields, 1);
    if (configure) {
      const theirs = numberOf(configure, 1) ?? FEATURES;
      const device = [...numberField(3, 1), ...textField(4, "1"), ...textField(5, "atvremote"), ...textField(6, "1.0.0")];
      this.send(bytesField(1, [...numberField(1, FEATURES & theirs), ...bytesField(2, device)]));
      return;
    }
    if (partOf(fields, 2)) {
      this.send(bytesField(2, numberField(1, FEATURES)));
      return;
    }
    const ping = partOf(fields, 8);
    if (ping) {
      this.send(bytesField(9, numberField(1, numberOf(ping, 1) ?? 0)));
      return;
    }
    const start = partOf(fields, 40);
    // An empty one says "not started": what's false doesn't get written.
    if (start) this.on = (numberOf(start, 1) ?? 0) === 1;
    const ime = partOf(fields, 20);
    const info = ime && partOf(ime, 1);
    const app = info?.get(12)?.[0];
    if (app instanceof Uint8Array) this.app = utf8Text(app);
  }

  pressPower(): void {
    this.send(bytesField(10, [...numberField(1, KEYCODE_POWER), ...numberField(2, KEY_SHORT)]));
  }

  close(): void {
    this.socket.close();
  }
}

/** The TV's home, its screen saver or Cast sitting there: nobody's doing anything on it. */
const NOTHING_ON = /launcher|mediashell|backdrop|dream|screensaver|katniss|ambient/i;

export interface TvState {
  on: boolean;
  /** an app is open: somebody may be watching */
  busy: boolean;
}

export type OpenTvSocket = () => Promise<CastSocket>;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

async function withRemote<T>(open: OpenTvSocket, then: (remote: TvRemote) => Promise<T>): Promise<T | null> {
  const socket = await open().catch(() => null);
  if (!socket) return null;
  const remote = new TvRemote(socket);
  try {
    for (const until = Date.now() + STATE_MS; remote.on === null && !remote.gone && Date.now() < until; ) await wait(50);
    if (remote.on === null) return null;
    await wait(APP_WAIT_MS);
    return await then(remote);
  } finally {
    remote.close();
  }
}

const stateOf = (remote: TvRemote): TvState => ({ on: remote.on === true, busy: remote.on === true && !!remote.app && !NOTHING_ON.test(remote.app) });

/** How it stands; null when it doesn't answer, or doesn't know this app. */
export const tvState = (open: OpenTvSocket): Promise<TvState | null> => withRemote(open, async (remote) => stateOf(remote));

/** The power key is a toggle: pressed only when it's on. Answers whether it's off now, as far as can be told. */
export async function tvSwitchOff(open: OpenTvSocket): Promise<boolean> {
  const done = await withRemote(open, async (remote) => {
    if (remote.on) {
      remote.pressPower();
      await wait(AFTER_KEY_MS);
    }
    return true;
  });
  return done === true;
}
