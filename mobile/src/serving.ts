/**
 * Songs of this phone that the linked computer plays from it (phase 2, the other way): while it does,
 * the phone stays awake and within reach, with a note saying so (stores/zones.ts keepAlive). Set by the
 * phone's player while it follows the computer.
 */
export interface Serving {
  /** the computer's name */
  name: string;
  /** what plays there now */
  title: string;
  playing: boolean;
}

let serving: Serving | null = null;
const listeners = new Set<() => void>();

export const servingComputer = (): Serving | null => serving;

export function setServing(next: Serving | null): void {
  if (JSON.stringify(next) === JSON.stringify(serving)) return;
  serving = next;
  for (const fn of listeners) fn();
}

export function onServingChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
