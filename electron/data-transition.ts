import { randomUUID } from "crypto";
import * as persist from "./persist";

let generation = randomUUID();
let tail: Promise<unknown> = Promise.resolve();

/** Resets, backup imports and renderer writes share this queue. */
export function serializeData<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.catch(() => undefined).then(work);
  tail = result;
  return result;
}

/** Wait for accepted work, including work appended while draining. Stop producers first. */
export async function drainData(): Promise<void> {
  let observed: Promise<unknown>;
  do {
    observed = tail;
    await observed.catch(() => undefined);
  } while (observed !== tail);
}

/** What a page reads and writes under: a page from before a reset can no longer write its old state back. */
export function documentScope(): string {
  return generation;
}

function assertCurrent(token: string): void {
  if (token !== generation) throw new Error("App data was reset. Reload this document before editing.");
}

export function readForDocument(name: string, token: string): unknown {
  assertCurrent(token);
  return persist.readData(name);
}

export async function writeForDocument(name: string, data: unknown, token: string): Promise<void> {
  assertCurrent(token);
  await persist.writeData(name, data);
}

export function invalidateResetDocuments(): void {
  generation = randomUUID();
}
