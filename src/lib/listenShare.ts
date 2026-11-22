/**
 * The computer's side of the shared listening history (lib/listenSync.ts, the engine's ListenHost):
 * its own plays go out from the listening history in electron/listens.ts, the other devices' come in
 * to that history and to Replay's counts (electron/stats.ts). How far it sent and read is kept per
 * sync service: a new one gets the whole history once.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useCatalog } from "../stores/catalog";
import type { ListenHost } from "./syncEngine";
import { storage } from "./persist";

interface Cursor {
  /** how many of this computer's plays the service has, in the order they counted */
  sent: number;
  /** how far the shared history was read (the service's count) */
  readUpTo: number;
  /** this computer's plays before this place were taken off the service on asking: never sent again */
  floor?: number;
  /** the version (generation) of the service's history read to its end: another one is read afresh */
  generation?: string;
}

interface ListenCursorsState {
  /** by sync service (its server key) */
  byServer: Record<string, Cursor>;
  /** the linked service keeps no shared history (one from before 1.8) */
  missing: boolean;
}

export const useListenCursors = create<ListenCursorsState>()(
  persist((): ListenCursorsState => ({ byServer: {}, missing: false }), {
    name: "listen-sync",
    storage: createJSONStorage(() => storage),
    version: 1,
    partialize: (s) => ({ byServer: s.byServer }) as ListenCursorsState,
  })
);

/** Said when other devices' plays came in: Replay and the listening history read again. */
export const LISTENS_UPDATED = "songsta:listens-updated";

/**
 * This computer's plays were taken off this sync service on asking (lib/homeSync.ts): none of those so
 * far is sent there again, even when the service's history starts over; new ones go as before.
 */
export async function keepOwnPlaysHere(serverKey: string): Promise<void> {
  const got = await window.bytune?.listensPending(0, 1).catch(() => null);
  const total = got?.total ?? 0;
  useListenCursors.setState((s) => {
    const c = s.byServer[serverKey] ?? { sent: 0, readUpTo: 0 };
    return { byServer: { ...s.byServer, [serverKey]: { ...c, sent: Math.max(Number(c.sent) || 0, total), floor: total } } };
  });
}

export function computerListenHost(serverKey: () => string | null, name: () => string): ListenHost {
  const key = (): string => serverKey() ?? "";
  const cursor = (): Cursor => {
    const c = useListenCursors.getState().byServer[key()];
    const floor = Number.isFinite(c?.floor) ? (c as Cursor).floor ?? 0 : 0;
    const generation = typeof c?.generation === "string" && c.generation ? c.generation : undefined;
    return { sent: Math.max(floor, Number.isFinite(c?.sent) ? (c as Cursor).sent : 0), readUpTo: Number.isFinite(c?.readUpTo) ? (c as Cursor).readUpTo : 0, floor, ...(generation ? { generation } : {}) };
  };
  const save = (patch: Partial<Cursor>): void => {
    useListenCursors.setState((s) => ({ byServer: { ...s.byServer, [key()]: { ...cursor(), ...patch } } }));
  };
  // The stretch handed out last: once the service has it, that far is sent.
  let batch: { from: number; count: number } | null = null;
  /** the version of the history being read afresh, from its start */
  let afresh: string | null = null;
  return {
    device: () => ({ name: name() || "Computer", kind: "computer" }),
    async pending(max) {
      let from = cursor().sent;
      let got = await window.bytune?.listensPending(from, max).catch(() => null);
      if (got && got.total < from) {
        // The history here was cleared: what's in it goes again (the service keeps each play once); what was taken off is gone here too.
        from = 0;
        save({ sent: 0, floor: 0 });
        got = await window.bytune?.listensPending(0, max).catch(() => null);
      }
      if (!got) return [];
      batch = { from, count: got.listens.length };
      // The catalogue's picture goes along where it's a web address the other devices can load too.
      const byId = useCatalog.getState().byId;
      return got.listens.map((l) => {
        const thumb = byId.get(l.id)?.thumb;
        return thumb && /^https?:\/\//i.test(thumb) ? { ...l, thumb } : l;
      });
    },
    sent() {
      if (batch) save({ sent: batch.from + batch.count });
      batch = null;
    },
    readUpTo: () => cursor().readUpTo,
    async take(listens, devices, upTo, startOver) {
      if (listens.length) {
        // Plays that couldn't be written stop the step here, before the place read up to moves on: the
        // same page comes again next time. Taken as "none new", the place moved past them for good.
        const added = (await window.bytune?.listensTake(listens, devices))?.added ?? 0;
        if (added) {
          void useCatalog.getState().refreshPlayCounts();
          window.dispatchEvent(new Event(LISTENS_UPDATED));
        }
      }
      // Another service, or one that started over: it reads from the start, and gets this computer's plays again,
      // apart from the ones taken off it on asking.
      save(startOver ? { readUpTo: 0, sent: cursor().floor ?? 0 } : { readUpTo: upTo });
      if (useListenCursors.getState().missing) useListenCursors.setState({ missing: false });
    },
    missing() {
      if (!useListenCursors.getState().missing) useListenCursors.setState({ missing: true });
    },
    generation: () => ({ read: cursor().generation ?? null, afresh }),
    // Another version of the service's history: read from its start, and this computer's plays go again
    // (the service keeps each once), apart from the ones taken off on asking. What came in stays, as the
    // privacy settings promise: the others keep what they have.
    readAfresh(generation) {
      afresh = generation;
      save({ readUpTo: 0, sent: cursor().floor ?? 0 });
    },
    readThrough(generation) {
      if (afresh === generation) afresh = null;
      save({ generation });
    },
  };
}
