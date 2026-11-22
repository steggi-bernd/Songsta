/**
 * What this phone still owes its Jellyfin server: likes and plays from while the server was out of reach
 * or said "not now" (plan section 5). Kept per account, so it outlasts a sign-out and a sign-in to the
 * same account, and another account never gets it.
 *
 * Kept for later: no answer, a login the server doesn't take right now (401: until signed in again), a
 * server that's busy (429: asked again after the time it names), a song the library doesn't know yet
 * (until it's read anew). Dropped: what the server refuses for good. A play sent once without an answer
 * in time may have been counted already; before it goes again the server is asked, as sending it twice
 * would count it twice. It used to drop all of it at the first "no" (Codex's look at the code).
 */
import { isNoAnswer, isUnsure, retryAfterOf, statusOf, type Session } from "./jellyfin";
import type { Track } from "./shared";
import { readJson, writeJson } from "./storage";

const FILE = "outbox.json";
/** A busy server that names no time is asked again after this long. */
const BUSY_RETRY_MS = 60_000;

export interface PendingPlay {
  id: string;
  at: number;
  /** sent once without an answer in time: the server may have it already */
  unsure?: boolean;
}

interface Box {
  likes: Record<string, boolean>;
  plays: PendingPlay[];
  /** a busy server (429) asked to wait until then (ms): nothing goes before, from wherever it's sent */
  notBefore?: number;
}

/** Per account (accountOf). */
let boxes: Record<string, Box> = {};
/** An outbox from before they were kept per account: the first account signed in when it's needed gets it. */
let loose: Box | null = null;

/** Which account a login is: its server, and the user on it. */
export const accountOf = (s: Session): string => `${s.serverId || s.home || s.server}|${s.userId}`;

const isBox = (v: unknown): v is Box => !!v && typeof v === "object" && typeof (v as Box).likes === "object" && Array.isArray((v as Box).plays);

function save(): void {
  writeJson(FILE, { accounts: boxes, ...(loose ? { loose } : {}) });
}

export async function restoreOutbox(): Promise<void> {
  const saved = await readJson<unknown>(FILE);
  boxes = {};
  loose = null;
  if (!saved || typeof saved !== "object") return;
  const accounts = (saved as { accounts?: unknown }).accounts;
  if (accounts && typeof accounts === "object") {
    for (const [key, box] of Object.entries(accounts as Record<string, unknown>)) if (isBox(box)) boxes[key] = box;
    const rest = (saved as { loose?: unknown }).loose;
    if (isBox(rest)) loose = rest;
  } else if (isBox(saved)) loose = saved;
}

function boxOf(s: Session): Box {
  const key = accountOf(s);
  const box = (boxes[key] ??= { likes: {}, plays: [] });
  if (loose) {
    for (const [id, liked] of Object.entries(loose.likes)) if (!(id in box.likes)) box.likes[id] = liked;
    box.plays.push(...loose.plays);
    loose = null;
    save();
  }
  return box;
}

/** The likes this account still owes: liked (true) or not (false), by song id. */
export function owedLikes(s: Session | null): Readonly<Record<string, boolean>> {
  return s ? boxOf(s).likes : {};
}

export function oweLike(s: Session, id: string, liked: boolean): void {
  boxOf(s).likes[id] = liked;
  save();
}

/** A like changed again before the server heard: the older wish doesn't come back. */
export function forgetLikes(s: Session, ids: readonly string[]): void {
  const box = boxOf(s);
  if (!ids.some((id) => id in box.likes)) return;
  for (const id of ids) delete box.likes[id];
  save();
}

export function owePlay(s: Session, play: PendingPlay): void {
  boxOf(s).plays.push(play);
  save();
}

/** Until when a busy server asked this account to wait (ms since 1970); 0 for no wait. */
export function owedAfter(s: Session): number {
  return boxOf(s).notBefore ?? 0;
}

/** Whatever a failure means for what's owed: kept and tried later, or refused for good. */
export function keptOnFailure(err: unknown): boolean {
  if (isNoAnswer(err)) return true;
  const status = statusOf(err);
  return status === 401 || status === 429;
}

export interface OutboxActions {
  setFavorite(track: Track, liked: boolean): Promise<void>;
  markPlayed(track: Track, at: Date): Promise<void>;
  /** whether the server has a play of this song from that moment on already */
  playedSince(track: Track, at: number): Promise<boolean>;
}

/** Stops the round, keeping the rest. */
const STOP = Symbol("stop");

type Round = { refused: string[]; retryInMs?: number };

/** The round under way for each account. */
const rounds = new Map<string, Promise<Round>>();

/**
 * What this account owes goes out, in order. `final`: the library was just read anew, so a song it still
 * doesn't know isn't coming; otherwise such a one waits. Answers what the server refused for good (song
 * ids), and when to try again if a busy server said.
 *
 * One round at a time per account: one asked for while another is under way goes after it, for what came
 * meanwhile (Codex, 2026-11-21: a refresh and the retry timer each sent the same play).
 */
export function sendOutbox(s: Session, byId: ReadonlyMap<string, Track>, act: OutboxActions, final: boolean): Promise<Round> {
  const key = accountOf(s);
  const under = rounds.get(key);
  if (under) {
    const after = () => sendOutbox(s, byId, act, final);
    return under.then(after, after);
  }
  const round = sendRound(s, byId, act, final).finally(() => {
    if (rounds.get(key) === round) rounds.delete(key);
  });
  rounds.set(key, round);
  return round;
}

async function sendRound(s: Session, byId: ReadonlyMap<string, Track>, act: OutboxActions, final: boolean): Promise<Round> {
  const box = boxOf(s);
  const refused: string[] = [];
  let retryInMs: number | undefined;
  const failed = (err: unknown): void => {
    if (!keptOnFailure(err)) return;
    if (statusOf(err) === 429) {
      retryInMs = retryAfterOf(err) ?? BUSY_RETRY_MS;
      // Kept with the account: a refresh, the timer, whoever sends next waits for it too.
      box.notBefore = Date.now() + retryInMs;
    }
    throw STOP;
  };
  const before = JSON.stringify(box);
  // A round that gets to ask: whatever wait there was is over.
  delete box.notBefore;
  try {
    for (const [id, liked] of Object.entries(box.likes)) {
      const track = byId.get(id);
      if (!track) {
        if (final) {
          delete box.likes[id];
          refused.push(id);
        }
        continue;
      }
      try {
        await act.setFavorite(track, liked);
      } catch (err) {
        failed(err);
        refused.push(id);
      }
      // Changed again while it was on its way: the newer wish stays.
      if (box.likes[id] === liked) delete box.likes[id];
    }
    for (const play of [...box.plays]) {
      const drop = (): void => {
        const at = box.plays.indexOf(play);
        if (at >= 0) box.plays.splice(at, 1);
      };
      const track = byId.get(play.id);
      if (!track) {
        if (final) {
          drop();
          refused.push(play.id);
        }
        continue;
      }
      if (play.unsure) {
        // Asked about first; a question that gets no clear answer leaves it unsure, and kept (Codex,
        // 2026-11-21: a busy answer to the question let the play go again, maybe counted twice).
        let counted: boolean;
        try {
          counted = await act.playedSince(track, play.at);
        } catch (err) {
          failed(err);
          drop();
          refused.push(play.id);
          continue;
        }
        if (counted) {
          drop();
          continue;
        }
      }
      try {
        await act.markPlayed(track, new Date(play.at));
        drop();
      } catch (err) {
        if (isUnsure(err)) play.unsure = true;
        failed(err);
        drop();
        refused.push(play.id);
      }
    }
  } catch (err) {
    if (err !== STOP) throw err;
  }
  if (JSON.stringify(box) !== before) save();
  return { refused, ...(retryInMs !== undefined ? { retryInMs } : {}) };
}

/** Everything owed by every account goes (only for a test). */
export function dropOutboxes(): void {
  boxes = {};
  loose = null;
  rounds.clear();
}
