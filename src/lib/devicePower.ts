/**
 * Switching a device off from here, where its maker offers a way. UPnP has no word
 * for it, so this goes by brand: Denon and Marantz receivers answer on a control
 * port of their own. Only fetch in here: one copy for the computer and the phone.
 *
 * When the music has left a device, it goes off half a minute later, unless somebody
 * says otherwise, it plays again, or it has moved on to something else: a receiver
 * switched over to the TV stays on.
 *
 * A device can hang on one of a receiver's inputs, a Google TV over HDMI, say. Music to
 * that device then means the receiver has to be on and on that input: it comes along. When
 * the music leaves for good, both go off the same way; back on the receiver, only the TV does.
 */
import { isLanUrl } from "../../electron/upnp-control";

export const SWITCH_OFF_AFTER_MS = 30_000;
/** Told while it's still on its way up, it isn't "on" yet: one more look when it should be. */
const LOOK_AGAIN_MS = 25_000;
const CONTROL_PORT = 8080;
const ASK_TIMEOUT_MS = 3000;
/** The inputs a stream from the network plays on; on any other it's doing something else. */
const NETWORK_INPUT = /^(NET|SERVER|IRADIO|HEOS|FAVORITES|USB)/i;

export const canSwitchOff = (model: string): boolean => /\b(denon|marantz)\b/i.test(model);

/** Something with a screen, so perhaps with the remote control lib/tvRemote.ts speaks. */
export const looksLikeTv = (d: { model: string; name: string }): boolean => /\btv\b|shield|chromecast|bravia/i.test(`${d.model} ${d.name}`);

export interface DevicePower {
  on: boolean;
  input: string;
  /** a TV: no inputs to go by */
  tv?: boolean;
  /** an app is open on it: somebody may be watching */
  busy?: boolean;
}

export const isNetworkInput = (input: string): boolean => NETWORK_INPUT.test(input);

async function ask(host: string, path: string): Promise<Response | null> {
  if (!isLanUrl(`http://${host}/`)) return null;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ASK_TIMEOUT_MS);
  try {
    return await fetch(`http://${host}:${CONTROL_PORT}${path}`, { redirect: "error", signal: stop.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** What the device's status page says. */
export function parsePower(xml: string): DevicePower | null {
  const value = (name: string): string => new RegExp(`<${name}>\\s*<value>([^<]*)</value>`, "i").exec(xml)?.[1]?.trim() ?? "";
  const power = value("Power");
  return power ? { on: /^ON$/i.test(power), input: value("InputFuncSelect") } : null;
}

export async function readPower(host: string): Promise<DevicePower | null> {
  const res = await ask(host, "/goform/formMainZone_MainZoneXmlStatusLite.xml");
  if (!res?.ok) return null;
  return parsePower(await res.text().catch(() => ""));
}

/** The few words a receiver gets told from here. */
const RECEIVER_WORD = /^(PWON|PWSTANDBY|SI[A-Z0-9/+.-]{1,20})$/;

export async function sendToReceiver(host: string, word: string): Promise<boolean> {
  if (!RECEIVER_WORD.test(word)) return false;
  return (await ask(host, `/goform/formiPhoneAppDirect.xml?${encodeURI(word)}`))?.ok ?? false;
}

export const switchOffAt = (host: string): Promise<boolean> => sendToReceiver(host, "PWSTANDBY");

/* ------------------------------------------------------------- what hangs on which input */

export interface DeviceLink {
  /** what's plugged in */
  device: string;
  receiver: string;
  /** the input, in the receiver's own word for it */
  input: string;
}

/** The inputs something can be plugged into, by the receiver's word and the name on its back. */
export const RECEIVER_INPUTS: readonly { code: string; name: string }[] = [
  { code: "MPLAY", name: "Media Player" },
  { code: "SAT/CBL", name: "CBL/SAT" },
  { code: "BD", name: "Blu-ray" },
  { code: "DVD", name: "DVD" },
  { code: "GAME", name: "Game" },
  { code: "AUX1", name: "AUX1" },
  { code: "AUX2", name: "AUX2" },
  { code: "TV", name: "TV Audio" },
  { code: "CD", name: "CD" },
];

/** Some models report an input by its name on the display. */
const ALSO_CALLED: Record<string, string> = { "MEDIA PLAYER": "MPLAY", "CBL/SAT": "SAT/CBL", "BLU-RAY": "BD", "TV AUDIO": "TV", "HEOS MUSIC": "NET", "ONLINE MUSIC": "NET" };

export function inputCode(input: string): string {
  const word = input.trim().toUpperCase();
  return ALSO_CALLED[word] ?? word;
}

export function inputName(input: string): string {
  const code = inputCode(input);
  return RECEIVER_INPUTS.find((i) => i.code === code)?.name ?? input;
}

export interface ReceiverControl {
  read(): Promise<DevicePower | null>;
  send(word: string): Promise<boolean>;
}

export interface BringingToInput {
  onSwitching?(): void;
  /** what counts as being there, when it's more than the one input */
  accept?(input: string): boolean;
  /** Left to wake by itself: music handed to it does that. */
  noWaking?: boolean;
}

const INPUT_TRIES = 15;
const INPUT_LOOK_EVERY_MS = 2000;

/**
 * On, and on this input. One coming out of standby doesn't take an input straight away,
 * so it's looked at until it's there. Answers whether it got there.
 */
export async function bringToInput(control: ReceiverControl, input: string, wanted: () => boolean, how: BringingToInput = {}): Promise<boolean> {
  const code = inputCode(input);
  const there = how.accept ?? ((now: string): boolean => inputCode(now) === code);
  let said = false;
  for (let i = 0; i < INPUT_TRIES && wanted(); i++) {
    const now = await control.read();
    if (now?.on && there(now.input)) return true;
    if (now?.on || (now && !how.noWaking)) {
      if (!said) how.onSwitching?.();
      said = true;
      await control.send(now.on ? `SI${code}` : "PWON");
    }
    await new Promise((done) => setTimeout(done, INPUT_LOOK_EVERY_MS));
  }
  return false;
}

/** The receiver's own player: HEOS Music on today's Denon and Marantz. They go there by themselves when handed a song; this is for when they don't. */
export const OWN_INPUT = "NET";

/**
 * A TV going off can take the receiver along over HDMI, which is the receiver's setting
 * "Pow.Off Control". Looked at for a while after: answers whether that happened.
 */
export async function wentOffToo(read: () => Promise<DevicePower | null>, wanted: () => boolean): Promise<boolean> {
  for (let i = 0; i < 8 && wanted(); i++) {
    await new Promise((done) => setTimeout(done, INPUT_LOOK_EVERY_MS));
    const now = await read();
    if (now && !now.on) return wanted();
  }
  return false;
}

/** Music on what hangs on a receiver is music on that receiver. */
export function receiverInUse(id: string, withMusic: ReadonlySet<string>, links: readonly DeviceLink[]): boolean {
  return withMusic.has(id) || links.some((l) => l.receiver === id && withMusic.has(l.device));
}

/** What needs its receiver now: it has just got music, or the receiver's own music has just ended. Never against a receiver playing by itself. */
export function linksToFollow(now: ReadonlySet<string>, before: ReadonlySet<string>, links: readonly DeviceLink[]): DeviceLink[] {
  return links.filter((l) => now.has(l.device) && !now.has(l.receiver) && (!before.has(l.device) || before.has(l.receiver)));
}

export interface LeavingDevice {
  id: string;
  name: string;
  /** when it goes off, by the clock */
  at: number;
}

export interface SwitchOffHooks {
  readPower(id: string): Promise<DevicePower | null>;
  switchOff(id: string): Promise<boolean>;
  /** it has music on it again */
  inUse(id: string): boolean;
  changed(pending: LeavingDevice[]): void;
  /** It has just started counting: a word to whoever's there. */
  counting(device: LeavingDevice): void;
  /** The count ran out and it was told to go off. */
  afterSwitchedOff?(id: string): void;
}

/** Why a receiver is on its way off when it isn't its own music that left. */
export interface WhyLeaving {
  /** the input of what hangs on it: that counts like its own */
  input?: string;
  /** what hangs on it: with a film on, the receiver stays */
  through?: string;
}

export class SwitchOffs {
  pending: LeavingDevice[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** switched off by hand just now: its leaving means nothing */
  private quiet = new Set<string>();

  constructor(private hooks: SwitchOffHooks) {}

  /** The music has left this device. */
  async left(id: string, name: string, why: WhyLeaving = {}, secondLook = false): Promise<void> {
    if (this.timers.has(id) || this.quiet.has(id)) return;
    const power = await this.hooks.readPower(id);
    if (this.timers.has(id) || this.quiet.has(id) || this.hooks.inUse(id)) return;
    if (power && !power.on && !power.tv && !secondLook) {
      const timer = setTimeout(() => {
        this.timers.delete(id);
        void this.left(id, name, why, true);
      }, LOOK_AGAIN_MS);
      this.timers.set(id, timer);
      return;
    }
    if (!power?.on) return;
    const fits = power.tv ? !power.busy : NETWORK_INPUT.test(power.input) || (!!why.input && inputCode(power.input) === inputCode(why.input));
    if (!fits) return;
    const device = { id, name, at: Date.now() + SWITCH_OFF_AFTER_MS };
    const { input } = power;
    this.pending = [...this.pending, device];
    this.timers.set(id, setTimeout(() => void this.due(id, input, why), SWITCH_OFF_AFTER_MS));
    this.hooks.changed(this.pending);
    this.hooks.counting(device);
  }

  private async due(id: string, input: string, why: WhyLeaving): Promise<void> {
    this.forget(id);
    if (this.hooks.inUse(id)) return;
    if (why.through && (await this.hooks.readPower(why.through))?.busy) return;
    const power = await this.hooks.readPower(id);
    if (!power?.on || power.input !== input || power.busy) return;
    if (await this.hooks.switchOff(id)) this.hooks.afterSwitchedOff?.(id);
  }

  /** It plays again, or somebody said to leave it on. */
  forget(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
    if (!this.pending.some((d) => d.id === id)) return;
    this.pending = this.pending.filter((d) => d.id !== id);
    this.hooks.changed(this.pending);
  }

  /** By hand, now. Whatever its music does on the way out says nothing any more. */
  async switchOffNow(id: string): Promise<boolean> {
    this.forget(id);
    this.quiet.add(id);
    setTimeout(() => this.quiet.delete(id), LOOK_AGAIN_MS);
    return this.hooks.switchOff(id);
  }

  /** Which devices have just lost their music or got it back: goes by who's on now and who was on before. */
  sawDevices(now: Set<string>, before: Set<string>, nameOf: (id: string) => { name: string; canSwitchOff: boolean } | null, links: readonly DeviceLink[] = []): void {
    for (const id of now) if (!before.has(id)) this.forget(id);
    for (const id of before) {
      if (now.has(id)) continue;
      const device = nameOf(id);
      if (device?.canSwitchOff) void this.left(id, device.name);
      // Off for good, with what it hangs on. Back on the receiver itself, that stays on, with its music.
      const link = links.find((l) => l.device === id);
      const receiver = link && !now.has(link.receiver) ? nameOf(link.receiver) : null;
      if (link && receiver?.canSwitchOff) void this.left(link.receiver, receiver.name, { input: link.input, through: id });
    }
  }
}
