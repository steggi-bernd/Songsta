/**
 * The computer's side of the library documents (lib/librarySync.ts): what the sync engine reads
 * and changes here for the library panel's order, the groups, the album edits and their pictures.
 * A change made here gets its moment and goes out; what another device changed goes into the
 * stores as it came, with its moments. The stores themselves stay as they are: this only watches
 * them and writes into them.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useAlbumEdits } from "../stores/albumEdits";
import { useLibrary } from "../stores/library";
import { useLibraryOrder } from "../stores/libraryOrder";
import { useSettings } from "../stores/settings";
import { useSmartPlaylists } from "../stores/smartPlaylists";
import { albumRoute, parseRoute } from "./libraryCore";
import { readExploreGroups, readGroups } from "./libraryGroups";
import {
  albumEditsDoc,
  albumEditsFrom,
  canonical,
  EDIT_FIELDS,
  kindOfKey,
  latestMoment,
  LIKED_KEY,
  OLD_ON_COMPUTER,
  restamp,
  stampClock,
  withOwnPins,
  type AlbumEditsDoc,
  type AlbumPicturesDoc,
  type EditStamps,
  type EditValues,
  type GroupsDoc,
  type LibraryDocName,
  type OrderDoc,
  type StampedMap,
} from "./librarySync";
import { storage } from "./persist";
import { albumPictureToShare, keepSharedAlbumPicture } from "./pickPicture";
import type { LibraryDocHost } from "./syncEngine";

interface Moments {
  /** the latest moment seen anywhere: a change here comes after it */
  clock: number;
  sortAt?: number;
  pinsAt?: number;
  /** the pins as the document has them, the kinds only other devices show included */
  pins?: string[];
  libraryGroupsAt?: number;
  exploreGroupsAt?: number;
  edits: EditStamps;
  covers: Record<string, number>;
  /** per document: the revision merged last, and whether something changed here since */
  merges: Partial<Record<LibraryDocName, { rev: number; changed: boolean }>>;
}

/** When each part of how the library is organised last changed, here or on the device it came from. */
const useMoments = create<Moments>()(
  persist(() => ({ clock: 0, edits: {}, covers: {}, merges: {} }) as Moments, { name: "library-sync", storage: createJSONStorage(() => storage) })
);

const clock = stampClock();
const seen = (): void => clock.saw(useMoments.getState().clock);
if (useMoments.persist.hasHydrated()) seen();
else useMoments.persist.onFinishHydration(seen);

/** A moment for a change made now. */
function now(): number {
  const at = clock.now();
  useMoments.setState({ clock: at });
  return at;
}

/** Every store these documents read has been read from disk: before that, there's nothing to say. */
export function librarySyncReady(): boolean {
  return (
    useMoments.persist.hasHydrated() &&
    useAlbumEdits.persist.hasHydrated() &&
    useLibraryOrder.persist.hasHydrated() &&
    useSettings.persist.hasHydrated() &&
    useSmartPlaylists.persist.hasHydrated() &&
    useLibrary.persist.hasHydrated()
  );
}

/** Calls back when the last of them has been read. */
export function onLibrarySyncReady(then: () => void): () => void {
  const offs = [useMoments, useAlbumEdits, useLibraryOrder, useSettings, useSmartPlaylists, useLibrary].map((store) => store.persist.onFinishHydration(then));
  return () => offs.forEach((off) => off());
}

/** a change made by the sync itself isn't news for the sync */
let applying = false;
function quietly(change: () => void): void {
  applying = true;
  try {
    change();
  } finally {
    applying = false;
  }
}

const localChanges: Record<LibraryDocName, number> = { order: 0, groups: 0, albumedits: 0, albumpictures: 0 };
const readAt: Partial<Record<LibraryDocName, number>> = {};
let tell: ((name: LibraryDocName) => void) | null = null;

function changedHere(name: LibraryDocName): void {
  localChanges[name] += 1;
  const merge = useMoments.getState().merges[name];
  if (merge && !merge.changed) useMoments.setState((m) => ({ merges: { ...m.merges, [name]: { ...merge, changed: true } } }));
  tell?.(name);
}

function side(name: LibraryDocName, read: () => object | null, apply: (doc: object) => void | Promise<void>): LibraryDocHost {
  return {
    read() {
      readAt[name] = localChanges[name];
      return read();
    },
    async apply(doc) {
      clock.saw(latestMoment(doc));
      useMoments.setState({ clock: clock.latest() });
      await apply(doc);
    },
    lastMerge: () => useMoments.getState().merges[name] ?? null,
    merged(rev) {
      const changed = localChanges[name] !== readAt[name];
      useMoments.setState((m) => ({ merges: { ...m.merges, [name]: { rev, changed } } }));
    },
  };
}

/* ------------------------------------------------------------------ order: pins, sort, played */

const LIKED_ROW = "__liked__";
/** what the library panel shows and pins itself; an artist or a mix is the phone's */
const COMPUTER_KINDS = new Set([LIKED_KEY, "album", "playlist", "smart"]);
const isComputerKind = (key: string): boolean => COMPUTER_KINDS.has(kindOfKey(key));
/** The panel keeps the played times of this many. */
const MAX_PLAYED = 400;

/** A panel row's id as the documents know it. */
function keyOfRow(id: string): string | null {
  if (id === LIKED_ROW) return LIKED_KEY;
  const album = parseRoute(id, "album");
  if (album) return `album:${album}`;
  if (id.startsWith("smart-")) return `smart:${id}`;
  if (useLibrary.getState().playlists.some((p) => p.id === id)) return `playlist:${id}`;
  return null;
}

/** A key of the documents as the panel's row id; null for what the panel doesn't show. */
function rowOfKey(key: string): string | null {
  const kind = kindOfKey(key);
  const rest = key.slice(kind.length + 1);
  if (kind === LIKED_KEY) return LIKED_ROW;
  if (kind === "album") return rest ? albumRoute(rest) : null;
  if (kind === "playlist" || kind === "smart") return rest || null;
  return null;
}

const pinnedPlaylists = (playlists: ReturnType<typeof useLibrary.getState>["playlists"]): string[] =>
  playlists.filter((p) => p.pinned && !p.folderId).map((p) => p.id);

/** What the panel pins, top first: as dragged into place, then those not placed yet (components/Sidebar.tsx). */
function pinnedHere(): string[] {
  const { pins, pinOrder } = useLibraryOrder.getState();
  const { playlists, pinnedSingles } = useLibrary.getState();
  const likedPinned = pinnedSingles?.liked ?? true;
  const lists = pinnedPlaylists(playlists);
  const smart = new Set(useSmartPlaylists.getState().playlists.map((p) => p.id));
  const isPinned = (id: string): boolean => (id === LIKED_ROW ? likedPinned : lists.includes(id) || pins.includes(id));
  const unplaced = [...(likedPinned ? [LIKED_ROW] : []), ...pins.filter((id) => smart.has(id)), ...lists, ...pins.filter((id) => !smart.has(id))];
  const rows = [...pinOrder.filter(isPinned), ...unplaced.filter((id) => !pinOrder.includes(id))];
  return [...new Set(rows.map(keyOfRow).filter((k): k is string => !!k))];
}

function readOrder(): OrderDoc {
  const m = useMoments.getState();
  const played: Record<string, number> = {};
  for (const [row, at] of Object.entries(useLibraryOrder.getState().played)) {
    const key = keyOfRow(row);
    if (key) played[key] = at;
  }
  return {
    sort: { at: m.sortAt ?? OLD_ON_COMPUTER, v: useSettings.getState().libraryOrder },
    pins: { at: m.pinsAt ?? OLD_ON_COMPUTER, v: withOwnPins(m.pins ?? [], pinnedHere(), isComputerKind) },
    ...(Object.keys(played).length ? { played } : {}),
  };
}

function newestPlayed(played: Record<string, number>): Record<string, number> {
  const ids = Object.keys(played);
  if (ids.length <= MAX_PLAYED) return played;
  return Object.fromEntries(ids.sort((a, b) => played[b] - played[a]).slice(0, MAX_PLAYED).map((id) => [id, played[id]]));
}

function applyOrder(doc: OrderDoc): void {
  quietly(() => {
    if (doc.sort?.v && doc.sort.v !== useSettings.getState().libraryOrder) useSettings.getState().setLibraryOrder(doc.sort.v);
    if (doc.pins?.v) {
      const keys = doc.pins.v;
      const pinOrder = keys.filter(isComputerKind).map(rowOfKey).filter((id): id is string => !!id);
      const pins = keys
        .filter((k) => kindOfKey(k) === "album" || kindOfKey(k) === "smart")
        .map(rowOfKey)
        .filter((id): id is string => !!id);
      const order = useLibraryOrder.getState();
      if (canonical(order.pins) !== canonical(pins) || canonical(order.pinOrder) !== canonical(pinOrder)) useLibraryOrder.setState({ pins, pinOrder });
      const singles = useLibrary.getState().pinnedSingles;
      const liked = keys.includes(LIKED_KEY);
      if ((singles?.liked ?? true) !== liked) useLibrary.setState({ pinnedSingles: { ...singles, liked } });
    }
    if (doc.played) {
      const local = useLibraryOrder.getState().played;
      let next = local;
      for (const [key, at] of Object.entries(doc.played)) {
        const kind = kindOfKey(key);
        if (kind !== "album" && kind !== "playlist" && kind !== LIKED_KEY) continue;
        const row = rowOfKey(key);
        if (!row || (next[row] ?? -1) >= at) continue;
        if (next === local) next = { ...local };
        next[row] = at;
      }
      if (next !== local) useLibraryOrder.setState({ played: newestPlayed(next) });
    }
  });
  useMoments.setState((m) => ({ sortAt: doc.sort?.at ?? m.sortAt, pinsAt: doc.pins?.at ?? m.pinsAt, pins: doc.pins?.v ?? m.pins }));
}

/* ------------------------------------------------------------------ groups */

function readGroupsHere(): GroupsDoc {
  const m = useMoments.getState();
  const { groups, exploreGroups } = useLibraryOrder.getState();
  return {
    library: { at: m.libraryGroupsAt ?? OLD_ON_COMPUTER, v: groups },
    explore: { at: m.exploreGroupsAt ?? OLD_ON_COMPUTER, v: exploreGroups },
  };
}

function applyGroups(doc: GroupsDoc): void {
  quietly(() => {
    const { groups, exploreGroups } = useLibraryOrder.getState();
    const next: Partial<Pick<ReturnType<typeof useLibraryOrder.getState>, "groups" | "exploreGroups">> = {};
    if (doc.library?.v && canonical(doc.library.v) !== canonical(groups)) next.groups = readGroups(doc.library.v);
    if (doc.explore?.v && canonical(doc.explore.v) !== canonical(exploreGroups)) next.exploreGroups = readExploreGroups(doc.explore.v);
    if (next.groups || next.exploreGroups) useLibraryOrder.setState(next);
  });
  useMoments.setState((m) => ({ libraryGroupsAt: doc.library?.at ?? m.libraryGroupsAt, exploreGroupsAt: doc.explore?.at ?? m.exploreGroupsAt }));
}

/* ------------------------------------------------------------------ album edits */

const readEdits = (): AlbumEditsDoc => albumEditsDoc(useAlbumEdits.getState(), useMoments.getState().edits, OLD_ON_COMPUTER);

function applyEdits(doc: AlbumEditsDoc): void {
  const { edits, stamps } = albumEditsFrom(doc);
  const current = useAlbumEdits.getState();
  const next: Partial<EditValues> = {};
  for (const field of EDIT_FIELDS) {
    if (canonical(current[field] ?? {}) !== canonical(edits[field])) (next as Record<string, unknown>)[field] = edits[field];
  }
  if (Object.keys(next).length) quietly(() => useAlbumEdits.setState(next));
  useMoments.setState({ edits: stamps });
}

/* ------------------------------------------------------------------ album pictures */

/** Each album's picture as it goes out: its file here (localart://) and the small copy for the document. */
const shared = new Map<string, { cover: string; data?: string; failed?: boolean }>();

function prepare(key: string, cover: string): void {
  shared.set(key, { cover });
  void albumPictureToShare(cover).then(
    (data) => {
      if (shared.get(key)?.cover !== cover) return;
      shared.set(key, { cover, data });
      tell?.("albumpictures");
    },
    () => {
      // Gone from the cover cache: it stays this computer's own.
      if (shared.get(key)?.cover === cover) shared.set(key, { cover, failed: true });
      tell?.("albumpictures");
    }
  );
}

function readPictures(): AlbumPicturesDoc | null {
  const covers = useAlbumEdits.getState().covers ?? {};
  const times = useMoments.getState().covers;
  const out: StampedMap<string> = {};
  let waiting = false;
  for (const key of new Set([...Object.keys(covers), ...Object.keys(times)])) {
    const cover = covers[key];
    if (!cover) {
      if (times[key] !== undefined) out[key] = { at: times[key] };
      continue;
    }
    const known = shared.get(key);
    if (known?.cover !== cover) {
      prepare(key, cover);
      waiting = true;
    } else if (known.data) out[key] = { at: times[key] ?? OLD_ON_COMPUTER, v: known.data };
    else if (!known.failed) waiting = true;
  }
  if (waiting) return null;
  return Object.keys(out).length ? { covers: out } : {};
}

async function applyPictures(doc: AlbumPicturesDoc): Promise<void> {
  for (const [key, entry] of Object.entries(doc.covers ?? {})) {
    const before = useMoments.getState().covers[key];
    const cover = useAlbumEdits.getState().covers?.[key];
    if (before === entry.at && !!cover === (entry.v !== undefined)) continue;
    if (entry.v === undefined) {
      shared.delete(key);
      if (cover) quietly(() => useAlbumEdits.getState().setCover(key, null));
    } else {
      const known = shared.get(key);
      const file = known?.data === entry.v ? known.cover : await keepSharedAlbumPicture(entry.v).catch(() => null);
      // Not kept, or chosen anew here meanwhile: this one doesn't count as taken over.
      if (!file || useMoments.getState().covers[key] !== before) continue;
      shared.set(key, { cover: file, data: entry.v });
      quietly(() => useAlbumEdits.getState().setCover(key, file));
    }
    useMoments.setState((m) => ({ covers: { ...m.covers, [key]: entry.at } }));
  }
}

/* ------------------------------------------------------------------ the engine's side */

export function libraryDocHosts(): Partial<Record<LibraryDocName, LibraryDocHost>> {
  return {
    order: side("order", readOrder, (doc) => applyOrder(doc as OrderDoc)),
    groups: side("groups", readGroupsHere, (doc) => applyGroups(doc as GroupsDoc)),
    albumedits: side("albumedits", readEdits, (doc) => applyEdits(doc as AlbumEditsDoc)),
    albumpictures: side("albumpictures", readPictures, (doc) => applyPictures(doc as AlbumPicturesDoc)),
  };
}

/** Changes made here, as they happen: each gets its moment, and `onChange` says which document to send. */
export function watchLibraryDocs(onChange: (name: LibraryDocName) => void): () => void {
  tell = onChange;
  // What the stores read from disk at the start isn't anything somebody just did.
  const ready = (store: { persist: { hasHydrated(): boolean } }): boolean => !applying && useMoments.persist.hasHydrated() && store.persist.hasHydrated();
  const offs = [
    useSettings.subscribe((s, prev) => {
      if (!ready(useSettings) || s.libraryOrder === prev.libraryOrder) return;
      useMoments.setState({ sortAt: now() });
      changedHere("order");
    }),
    useLibraryOrder.subscribe((s, prev) => {
      if (!ready(useLibraryOrder)) return;
      if (s.pins !== prev.pins || s.pinOrder !== prev.pinOrder) {
        useMoments.setState({ pinsAt: now() });
        changedHere("order");
      } else if (s.played !== prev.played) changedHere("order");
      if (s.groups !== prev.groups) {
        useMoments.setState({ libraryGroupsAt: now() });
        changedHere("groups");
      }
      if (s.exploreGroups !== prev.exploreGroups) {
        useMoments.setState({ exploreGroupsAt: now() });
        changedHere("groups");
      }
    }),
    useLibrary.subscribe((s, prev) => {
      if (!ready(useLibrary)) return;
      if ((s.pinnedSingles?.liked ?? true) !== (prev.pinnedSingles?.liked ?? true)) {
        useMoments.setState({ pinsAt: now() });
        changedHere("order");
      } else if (s.playlists !== prev.playlists && pinnedPlaylists(s.playlists).join() !== pinnedPlaylists(prev.playlists).join()) {
        // A playlist pinned anywhere (its pin travels with the playlists) takes its place among the pins.
        changedHere("order");
      }
    }),
    useAlbumEdits.subscribe((s, prev) => {
      if (!ready(useAlbumEdits)) return;
      const fields = EDIT_FIELDS.filter((field) => s[field] !== prev[field]);
      if (fields.length) {
        const at = now();
        const edits = { ...useMoments.getState().edits };
        for (const field of fields) edits[field] = restamp<unknown>(prev[field], s[field], edits[field], at);
        useMoments.setState({ edits });
        changedHere("albumedits");
      }
      if (s.covers !== prev.covers) {
        const at = now();
        useMoments.setState((m) => ({ covers: restamp(prev.covers, s.covers, m.covers, at) }));
        changedHere("albumpictures");
      }
    }),
  ];
  return () => {
    tell = null;
    offs.forEach((off) => off());
  };
}
