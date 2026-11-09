/**
 * How this phone's library is organised, as far as it travels between the devices
 * (lib/librarySync.ts): the moment each part last changed, the pins as the document has them
 * (with what only the computer shows), the library's sort chosen on the computer, and the
 * revision each document was last merged at. The parts themselves stay where they always were:
 * the pins and the groups in the settings, Explore's groups in its store, the played times in
 * stores/played.ts, the album edits in stores/albumEdits.ts.
 */
import { create } from "zustand";
import { stampClock, type LibraryDocName, type LibrarySort } from "../shared";
import { readJson, removeJson, writeJson } from "../storage";

const FILE = "library-sync.json";

interface Saved {
  /** the latest moment seen anywhere: a change here comes after it */
  clock: number;
  /** how Your Library is sorted, as chosen on the computer (or here) */
  sort?: { at: number; v?: LibrarySort };
  pinsAt?: number;
  /** what stands on top, first first, the computer's kinds included (Liked Songs, smart playlists, playlists' places) */
  pins?: string[];
  libraryGroupsAt?: number;
  exploreGroupsAt?: number;
  merges: Partial<Record<LibraryDocName, { rev: number; changed: boolean }>>;
}

interface LibrarySyncState extends Saved {
  restored: boolean;
  /** goes up when the account's library is cleared: what the sync was doing for it then is over */
  generation: number;
  restore(): Promise<void>;
  /** Kept and written to the phone. */
  change(next: Partial<Saved>): void;
  /** The moment of a change made here, now. */
  stamp(): number;
  /** Something came from another device: moments from here on are later than its. */
  saw(at: number): void;
  clear(): void;
}

const clock = stampClock();
const EMPTY: Saved = { clock: 0, merges: {} };

function save(): void {
  const { clock: at, sort, pinsAt, pins, libraryGroupsAt, exploreGroupsAt, merges } = useLibrarySync.getState();
  writeJson(FILE, { clock: at, sort, pinsAt, pins, libraryGroupsAt, exploreGroupsAt, merges } satisfies Saved);
}

let restoring: Promise<void> | null = null;

export const useLibrarySync = create<LibrarySyncState>((set, get) => ({
  ...EMPTY,
  restored: false,
  generation: 0,
  restore() {
    restoring ??= readJson<Saved>(FILE).then((saved) => {
      if (saved) set({ ...EMPTY, ...saved, merges: saved.merges ?? {} });
      clock.saw(get().clock);
      set({ restored: true });
    });
    return restoring;
  },
  change(next) {
    set(next);
    save();
  },
  stamp() {
    const at = clock.now();
    get().change({ clock: at });
    return at;
  },
  saw(at) {
    clock.saw(at);
    if (clock.latest() !== get().clock) get().change({ clock: clock.latest() });
  },
  clear() {
    removeJson(FILE);
    set({ ...EMPTY, clock: get().clock, generation: get().generation + 1 });
  },
}));
