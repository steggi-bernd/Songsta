/**
 * Several devices playing the same song. UPnP and Cast have no word for "together": each
 * fetches and buffers in its own time, so one is easily a second or two behind. This looks at
 * where each really stands and moves the late ones on, and remembers how much later each tends
 * to start, so the next song is handed to the quick ones that much later. It gets a group close,
 * not sample-exact: what a device says about its place is as near as anyone can get from outside.
 * What's left can be set by hand per device (`offset`): a receiver that works on the sound, say,
 * sounds later than it says, and is played that much ahead.
 *
 * Pure, one copy for the computer and the phone.
 */

export interface SyncMember {
  id: string;
  /** where it stands now by its own word; null when it isn't playing */
  place(): Promise<number | null>;
  seek(sec: number): Promise<unknown>;
  /** This device's own player: a seek costs next to nothing and can be told to the millisecond. */
  nearby?: boolean;
  /** Seconds it plays ahead of the others, set by hand: it sounds that much later than it says. Below zero: behind them. */
  offset?: number;
}

interface Reading {
  position: number;
  /** when that was so, by the clock */
  at: number;
}

const READ_FOR_MS = 1400;
const READ_EVERY_MS = 60;
/** The next turnover is due a second after the first one: looked for this often, from a little before. */
const CLOSER_EVERY_MS = 15;
const CLOSER_BEFORE_MS = 60;
const CLOSER_AFTER_MS = 90;
/** Closer than this isn't worth the gap a seek leaves on a device. */
const CLOSE_ENOUGH_SEC = 0.3;
const CLOSE_ENOUGH_NEARBY_SEC = 0.1;
/** One of them set by hand: whoever did that listens closely, and the group is kept that close. */
const CLOSE_ENOUGH_SET_SEC = 0.04;
/** This far apart it isn't about the start any more: the one furthest on sets the place, whichever it is. */
const FAR_APART_SEC = 3;
const TRIES = 3;
/** After a seek, before asking where it stands. */
const SETTLE_MS = 1500;
const FIRST_SEEK_COST_SEC = 1;
const FIRST_SEEK_COST_NEARBY_SEC = 0.15;
const LONGEST_SEEK_COST_SEC = 6;
/** Later than this at the start is one waking up: nothing to go by for the next song. */
const TOO_LATE_TO_LEARN_SEC = 6;
/** Not this close to a song's end. */
const LEAVE_AT_THE_END_SEC = 4;

/** Steps and reach of that setting, in ms, the same on both apps. */
export const PLAY_AHEAD_STEP_MS = 50;
export const PLAY_AHEAD_MAX_MS = 1000;

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const aheadOf = (m: SyncMember): number => m.offset ?? 0;

/**
 * Where a device stands, as exactly as it can be told. Many report whole seconds only:
 * the moment that number turns over says more than the number. Found roughly first, then
 * the next one, due a second later, closely: to some hundredths, enough for a step set by
 * hand to show. Null when it doesn't move.
 */
export async function readPlace(member: SyncMember): Promise<Reading | null> {
  const ask = async (): Promise<{ position: number | null; at: number }> => {
    const before = Date.now();
    const position = await member.place();
    return { position, at: (before + Date.now()) / 2 };
  };
  const first = await ask();
  if (first.position === null) return null;
  if (!Number.isInteger(first.position)) return { position: first.position, at: first.at };
  let last = first;
  let rough: Reading | null = null;
  while (!rough && Date.now() < first.at + READ_FOR_MS) {
    await wait(READ_EVERY_MS);
    const next = await ask();
    if (next.position === null) return null;
    if (next.position !== first.position) rough = { position: next.position, at: (last.at + next.at) / 2 };
    last = next;
  }
  if (!rough) return null;
  const due = rough.at + 1000;
  await wait(Math.max(0, due - CLOSER_BEFORE_MS - Date.now()));
  let before = await ask();
  // Too late for it, or it stopped: the rough one stands.
  if (before.position !== rough.position) return rough;
  while (Date.now() < due + CLOSER_AFTER_MS) {
    await wait(CLOSER_EVERY_MS);
    const next = await ask();
    if (next.position === null) return rough;
    if (next.position !== rough.position) return next.position === rough.position + 1 ? { position: next.position, at: (before.at + next.at) / 2 } : rough;
    before = next;
  }
  return rough;
}

const placeNow = (r: Reading, now: number): number => r.position + (now - r.at) / 1000;

export class GroupSync {
  private seekCosts = new Map<string, number>();
  /** how much later than the group's first each one starts a song */
  private lateness = new Map<string, number>();

  /** How long to wait before handing a song to each, in ms: the slowest gets it first. */
  startDelays(ids: readonly string[]): Map<string, number> {
    const late = ids.map((id, i) => (i === 0 ? 0 : (this.lateness.get(id) ?? 0)));
    const latest = Math.max(0, ...late);
    return new Map(ids.map((id, i) => [id, Math.round((latest - late[i]) * 1000)]));
  }

  private costOf(m: SyncMember): number {
    return this.seekCosts.get(m.id) ?? (m.nearby ? FIRST_SEEK_COST_NEARBY_SEC : FIRST_SEEK_COST_SEC);
  }

  private learnStart(id: string, late: number): void {
    if (Math.abs(late) > TOO_LATE_TO_LEARN_SEC) return;
    const known = this.lateness.get(id);
    this.lateness.set(id, known === undefined ? late : known * 0.6 + late * 0.4);
  }

  private async moveTo(m: SyncMember, reference: SyncMember, wanted: () => boolean, duration: number, tight: boolean, firstLook?: number): Promise<void> {
    const closeEnough = tight ? CLOSE_ENOUGH_SET_SEC : m.nearby ? CLOSE_ENOUGH_NEARBY_SEC : CLOSE_ENOUGH_SEC;
    for (let attempt = 0; attempt < TRIES && wanted(); attempt++) {
      const [theirs, mine] = await Promise.all([readPlace(reference), readPlace(m)]);
      if (!theirs || !mine || !wanted()) return;
      const now = Date.now();
      // What's heard, not what they say: one set to play ahead sounds that much later than its word.
      const there = placeNow(theirs, now) - aheadOf(reference);
      const late = there - (placeNow(mine, now) - aheadOf(m));
      if (attempt === 0 && firstLook !== undefined) this.learnStart(m.id, late + firstLook);
      // It was told a place and came out this far off: that's what its seeks cost more or less than thought.
      if (attempt > 0) this.seekCosts.set(m.id, Math.min(LONGEST_SEEK_COST_SEC, Math.max(0, this.costOf(m) + late)));
      if (Math.abs(late) < closeEnough) return;
      const cost = this.costOf(m);
      const aim = there + aheadOf(m) + cost;
      if (duration > 0 && aim > duration - LEAVE_AT_THE_END_SEC) return;
      if (m.nearby) await m.seek(aim);
      else {
        // Whole seconds are what every device takes: told when the place it's told is the right one.
        const target = Math.ceil(aim);
        await wait((target - aim) * 1000);
        if (!wanted()) return;
        await m.seek(target);
      }
      await wait(SETTLE_MS + cost * 1000);
    }
  }

  /**
   * The group's first device sets the place, unless another is far ahead of it (it woke up late, say).
   * `delays`: how the song was just handed out, for a fresh start to learn from; left out after a seek or a pause.
   * `closely`: somebody just changed a setting by hand and listens, also when it went back to zero.
   */
  async align(members: readonly SyncMember[], wanted: () => boolean, duration: number, delays?: ReadonlyMap<string, number> | null, closely = false): Promise<void> {
    if (members.length < 2) return;
    const readings = await Promise.all(members.map(readPlace));
    if (!wanted()) return;
    const now = Date.now();
    const first = members[0];
    const heard = (i: number): number => {
      const r = readings[i];
      return r ? placeNow(r, now) - aheadOf(members[i]) : -Infinity;
    };
    let reference = first;
    let furthest = heard(0);
    readings.forEach((r, i) => {
      if (r && heard(i) > furthest + FAR_APART_SEC) {
        reference = members[i];
        furthest = heard(i);
      }
    });
    const tight = closely || members.some((m) => aheadOf(m) !== 0);
    const delayOf = (id: string): number => (delays?.get(id) ?? 0) / 1000;
    for (const m of members) {
      if (m === reference || !wanted()) continue;
      // What it would have been late by with nobody waiting: how long each waited is taken out again.
      await this.moveTo(m, reference, wanted, duration, tight, delays && reference === first ? delayOf(first.id) - delayOf(m.id) : undefined).catch(() => undefined);
    }
  }
}
