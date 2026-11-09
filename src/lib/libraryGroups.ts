/**
 * Groups the user makes, the way Discord groups its servers: a row (or a tile) that stays folded
 * with its first covers in a small grid, opens to show what's in it, and plays all of it, in the
 * group's own order or shuffled. Two sets, each this device's own and kept apart:
 *   - the library's (the computer's library panel, stores/libraryOrder.ts; the phone's Your
 *     Library, its settings): albums and playlists;
 *   - Explore's, one set per tab (the computer's stores/libraryOrder.ts, the phone's
 *     stores/explore.ts): albums, artists or genres.
 * What's in a group is known by key: "album:…" and "playlist:…" as lists kept whole know them
 * (lib/keptLists.ts), "artist:…" and "genre:…" in Explore. Something the library doesn't have
 * right now (a server out of reach) keeps its place. Plain data, pure, one copy for both apps.
 */
export interface Group {
  id: string;
  name: string;
  /** what's in it, by key, in the group's own order; each key is in one group at most */
  items: string[];
}

/** Explore's groups, one set per tab. */
export interface ExploreGroups {
  albums: Group[];
  artists: Group[];
  genres: Group[];
}

export const NO_EXPLORE_GROUPS: ExploreGroups = { albums: [], artists: [], genres: [] };

export const artistGroupKey = (name: string): string => `artist:${name}`;
export const genreGroupKey = (key: string): string => `genre:${key}`;

/** A new group's id, unique on this device. */
export const newGroupId = (): string => `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Where something goes in a group: next to one of its items; without one, at the end. */
export type GroupPlace = { before: string } | { after: string };

/** The group something is in. */
export function groupOf(groups: readonly Group[], key: string): Group | undefined {
  return groups.find((g) => g.items.includes(key));
}

/** Every group without these keys; a group left with nothing goes. */
function without(groups: readonly Group[], keys: readonly string[]): Group[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((k) => !keys.includes(k)) })).filter((g) => g.items.length > 0);
}

/** A new group of these, in this order, each taken out of the group it was in. */
export function withNewGroup(groups: readonly Group[], id: string, name: string, keys: readonly string[]): Group[] {
  const items = [...new Set(keys)];
  return [...without(groups, items), { id, name: name.trim(), items }];
}

/**
 * Something put in a group, at the end or next to one of its items, and out of any other group.
 * Already in that group, it moves there: that's how a group's own order changes.
 */
export function withItemIn(groups: readonly Group[], groupId: string, key: string, place?: GroupPlace): Group[] {
  if (!groups.some((g) => g.id === groupId)) return [...groups];
  const anchor = place ? ("before" in place ? place.before : place.after) : undefined;
  if (anchor === key) return [...groups];
  return groups
    .map((g) => {
      const items = g.items.filter((k) => k !== key);
      if (g.id !== groupId) return items.length === g.items.length ? g : { ...g, items };
      const i = anchor === undefined ? -1 : items.indexOf(anchor);
      const at = i < 0 ? items.length : place && "before" in place ? i : i + 1;
      items.splice(at, 0, key);
      return { ...g, items };
    })
    .filter((g) => g.items.length > 0);
}

/** Taken out of its group; a group left empty goes. */
export function withItemOut(groups: readonly Group[], key: string): Group[] {
  return without(groups, [key]);
}

/**
 * One place up (-1) or down (+1) in its group, past the next item that's shown (`shown`: what the
 * library has right now; an item it doesn't have isn't something to move past).
 */
export function withItemMoved(groups: readonly Group[], key: string, by: -1 | 1, shown: (key: string) => boolean = () => true): Group[] {
  return groups.map((g) => {
    const from = g.items.indexOf(key);
    if (from < 0) return g;
    let to = from + by;
    while (to >= 0 && to < g.items.length && !shown(g.items[to])) to += by;
    if (to < 0 || to >= g.items.length) return g;
    const items = g.items.filter((k) => k !== key);
    items.splice(to, 0, key);
    return { ...g, items };
  });
}

export function withGroupNamed(groups: readonly Group[], groupId: string, name: string): Group[] {
  const trimmed = name.trim();
  return groups.map((g) => (g.id === groupId && trimmed ? { ...g, name: trimmed } : g));
}

/** The group dissolved: what was in it stands on its own again. */
export function withoutGroup(groups: readonly Group[], groupId: string): Group[] {
  return groups.filter((g) => g.id !== groupId);
}

/** A name for a new group that no other one has: "Group 1", "Group 2" … */
export function newGroupName(groups: readonly Group[], named: (n: number) => string): string {
  const taken = new Set(groups.map((g) => g.name));
  for (let n = groups.length + 1; ; n++) if (!taken.has(named(n))) return named(n);
}

export type Arranged<A> = { group: Group; members: A[] } | { entry: A };

/**
 * The groups as a list shows them, in that list's order: each group with its members found in the
 * list, in the group's own order, standing where the first of them would stand. A group none of
 * whose items is in the list right now isn't shown. Whatever is in no group stands as it was.
 */
export function arrangeGroups<A>(groups: readonly Group[], entries: readonly A[], keyOf: (entry: A) => string): Arranged<A>[] {
  const groupFor = new Map<string, Group>();
  for (const g of groups) for (const k of g.items) if (!groupFor.has(k)) groupFor.set(k, g);
  const found = new Map<string, A>();
  for (const e of entries) {
    const k = keyOf(e);
    if (groupFor.has(k) && !found.has(k)) found.set(k, e);
  }
  const order: Arranged<A>[] = [];
  const placed = new Set<string>();
  for (const e of entries) {
    const g = groupFor.get(keyOf(e));
    if (!g) {
      order.push({ entry: e });
      continue;
    }
    if (placed.has(g.id)) continue;
    placed.add(g.id);
    const members = g.items.filter((k) => groupFor.get(k) === g && found.has(k)).map((k) => found.get(k) as A);
    order.push({ group: g, members });
  }
  return order;
}

/**
 * Groups as saved, read with care: what anything broken holds is left out, an item stays in the
 * first group that has it, and what the test builds of 2026-11-08 saved ({ albums: [album key] },
 * albums only) comes along.
 */
export function readGroups(raw: unknown): Group[] {
  if (!Array.isArray(raw)) return [];
  const out: Group[] = [];
  const ids = new Set<string>();
  const taken = new Set<string>();
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const { id, name, items, albums } = g as { id?: unknown; name?: unknown; items?: unknown; albums?: unknown };
    if (typeof id !== "string" || !id || ids.has(id) || typeof name !== "string" || !name.trim()) continue;
    const keys = Array.isArray(items)
      ? items.filter((k): k is string => typeof k === "string" && !!k)
      : Array.isArray(albums)
        ? albums.filter((k): k is string => typeof k === "string" && !!k).map((k) => `album:${k}`)
        : [];
    const mine = keys.filter((k) => {
      if (taken.has(k)) return false;
      taken.add(k);
      return true;
    });
    if (!mine.length) continue;
    ids.add(id);
    out.push({ id, name: name.trim(), items: mine });
  }
  return out;
}

export function readExploreGroups(raw: unknown): ExploreGroups {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof ExploreGroups, unknown>>;
  return { albums: readGroups(r.albums), artists: readGroups(r.artists), genres: readGroups(r.genres) };
}
