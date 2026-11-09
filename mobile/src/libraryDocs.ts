/**
 * This phone's side of the library documents (lib/librarySync.ts): what the sync engine reads
 * and changes here for the order (pins, Your Library's sort, when things played), the groups,
 * the album edits and their pictures. A change made here gets its moment and goes out; what
 * another device changed goes into the stores as it came. The computer's side is
 * src/lib/libraryDocs.ts.
 */
import {
  albumEditsDoc,
  albumEditsFrom,
  canonical,
  EDIT_FIELDS,
  kindOfKey,
  latestMoment,
  OLD_ON_PHONE,
  readExploreGroups,
  readGroups,
  withOwnPins,
  type AlbumEditsDoc,
  type AlbumPicturesDoc,
  type EditValues,
  type GroupsDoc,
  type LibraryDocHost,
  type LibraryDocName,
  type LibrarySort,
  type OrderDoc,
  type StampedMap,
} from "./shared";
import { useAlbumEdits } from "./stores/albumEdits";
import { useExplore } from "./stores/explore";
import { useLibrarySync } from "./stores/librarySync";
import { usePlayed } from "./stores/played";
import { useSettings } from "./stores/settings";

/** what Your Library pins itself; Liked Songs, playlists' places and smart playlists are kept as they come */
const PHONE_KINDS = new Set(["album", "artist", "mix"]);
const isPhoneKind = (key: string): boolean => PHONE_KINDS.has(kindOfKey(key));

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
  const sync = useLibrarySync.getState();
  const merge = sync.merges[name];
  if (merge && !merge.changed) sync.change({ merges: { ...sync.merges, [name]: { ...merge, changed: true } } });
  tell?.(name);
}

function side(name: LibraryDocName, read: () => object | null, apply: (doc: object) => void): LibraryDocHost {
  // Signed out meanwhile: the account's library is cleared, and nothing of it is read or brought back.
  const born = useLibrarySync.getState().generation;
  const current = (): boolean => useLibrarySync.getState().generation === born;
  return {
    read() {
      if (!current()) return null;
      readAt[name] = localChanges[name];
      return read();
    },
    apply(doc) {
      if (!current()) return;
      useLibrarySync.getState().saw(latestMoment(doc));
      apply(doc);
    },
    lastMerge: () => useLibrarySync.getState().merges[name] ?? null,
    merged(rev) {
      if (!current()) return;
      const sync = useLibrarySync.getState();
      sync.change({ merges: { ...sync.merges, [name]: { rev, changed: localChanges[name] !== readAt[name] } } });
    },
  };
}

/* ------------------------------------------------------------------ order */

function readOrder(): OrderDoc {
  const sync = useLibrarySync.getState();
  const played = usePlayed.getState().at;
  return {
    ...(sync.sort ? { sort: sync.sort } : {}),
    pins: { at: sync.pinsAt ?? OLD_ON_PHONE, v: withOwnPins(sync.pins ?? [], useSettings.getState().pins, isPhoneKind) },
    ...(Object.keys(played).length ? { played } : {}),
  };
}

function applyOrder(doc: OrderDoc): void {
  const sync = useLibrarySync.getState();
  if (doc.pins?.v) {
    const mine = doc.pins.v.filter(isPhoneKind);
    if (canonical(mine) !== canonical(useSettings.getState().pins)) quietly(() => useSettings.getState().change({ pins: mine }));
  }
  sync.change({
    ...(doc.sort ? { sort: doc.sort } : {}),
    ...(doc.pins ? { pinsAt: doc.pins.at, pins: doc.pins.v } : {}),
  });
  if (doc.played) quietly(() => usePlayed.getState().adopt(doc.played as Record<string, number>));
}

/** Your Library's sort chosen here: it goes to the other devices like one chosen on the computer. */
export function chooseLibrarySort(sort: LibrarySort): void {
  const sync = useLibrarySync.getState();
  if (sync.sort?.v === sort) return;
  sync.change({ sort: { at: sync.stamp(), v: sort } });
  changedHere("order");
}

/* ------------------------------------------------------------------ groups */

function readGroupsHere(): GroupsDoc {
  const sync = useLibrarySync.getState();
  return {
    library: { at: sync.libraryGroupsAt ?? OLD_ON_PHONE, v: useSettings.getState().libraryGroups },
    explore: { at: sync.exploreGroupsAt ?? OLD_ON_PHONE, v: useExplore.getState().groups },
  };
}

function applyGroups(doc: GroupsDoc): void {
  quietly(() => {
    if (doc.library?.v && canonical(doc.library.v) !== canonical(useSettings.getState().libraryGroups)) {
      useSettings.getState().change({ libraryGroups: readGroups(doc.library.v) });
    }
    if (doc.explore?.v && canonical(doc.explore.v) !== canonical(useExplore.getState().groups)) {
      useExplore.setState({ groups: readExploreGroups(doc.explore.v) });
    }
  });
  const sync = useLibrarySync.getState();
  sync.change({ libraryGroupsAt: doc.library?.at ?? sync.libraryGroupsAt, exploreGroupsAt: doc.explore?.at ?? sync.exploreGroupsAt });
}

/* ------------------------------------------------------------------ album edits and pictures */

function readEdits(): AlbumEditsDoc {
  const edits = useAlbumEdits.getState();
  return albumEditsDoc(edits, edits.stamps, OLD_ON_PHONE);
}

function applyEdits(doc: AlbumEditsDoc): void {
  const { edits, stamps } = albumEditsFrom(doc);
  const current = useAlbumEdits.getState();
  const next = {} as EditValues;
  for (const field of EDIT_FIELDS) (next as Record<string, unknown>)[field] = canonical(current[field]) === canonical(edits[field]) ? current[field] : edits[field];
  quietly(() => useAlbumEdits.getState().adopt(next, stamps));
}

function readPictures(): AlbumPicturesDoc {
  const { covers, coverStamps, coverData } = useAlbumEdits.getState();
  const out: StampedMap<string> = {};
  for (const key of new Set([...Object.keys(covers), ...Object.keys(coverStamps)])) {
    if (!covers[key]) {
      if (coverStamps[key] !== undefined) out[key] = { at: coverStamps[key] };
      continue;
    }
    // A file that can't be read stays this phone's own.
    const data = coverData(key);
    if (data) out[key] = { at: coverStamps[key] ?? OLD_ON_PHONE, v: data };
  }
  return Object.keys(out).length ? { covers: out } : {};
}

function applyPictures(doc: AlbumPicturesDoc): void {
  for (const [key, entry] of Object.entries(doc.covers ?? {})) {
    const { covers, coverStamps } = useAlbumEdits.getState();
    if (coverStamps[key] === entry.at && !!covers[key] === (entry.v !== undefined)) continue;
    quietly(() => useAlbumEdits.getState().adoptCover(key, entry.v ?? null, entry.at));
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

/** Changes made here, as they happen: pins, groups and the played times get noted, `onChange` says which document to send. */
export function watchLibraryDocs(onChange: (name: LibraryDocName) => void): () => void {
  tell = onChange;
  const offs = [
    useSettings.subscribe((s, prev) => {
      if (applying) return;
      if (s.pins !== prev.pins) {
        useLibrarySync.getState().change({ pinsAt: useLibrarySync.getState().stamp() });
        changedHere("order");
      }
      if (s.libraryGroups !== prev.libraryGroups) {
        useLibrarySync.getState().change({ libraryGroupsAt: useLibrarySync.getState().stamp() });
        changedHere("groups");
      }
    }),
    useExplore.subscribe((s, prev) => {
      if (applying || s.groups === prev.groups) return;
      useLibrarySync.getState().change({ exploreGroupsAt: useLibrarySync.getState().stamp() });
      changedHere("groups");
    }),
    usePlayed.subscribe((s, prev) => {
      if (!applying && s.at !== prev.at) changedHere("order");
    }),
    // The edits keep their own moments (stores/albumEdits.ts).
    useAlbumEdits.subscribe((s, prev) => {
      if (applying) return;
      if (EDIT_FIELDS.some((field) => s[field] !== prev[field])) changedHere("albumedits");
      if (s.covers !== prev.covers) changedHere("albumpictures");
    }),
  ];
  return () => {
    tell = null;
    offs.forEach((off) => off());
  };
}
