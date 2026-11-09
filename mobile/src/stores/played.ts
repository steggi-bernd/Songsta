/**
 * When each album, artist, playlist and mix last played as a whole: Your Library's "Recently played"
 * order. What counts is what was started, an album's page or an artist's or a playlist's, not where
 * a song comes from: a song from a playlist makes the playlist recent, not its album or its artist.
 * Only while the list started plays: what's added to the queue after it, or comes by itself once
 * it's through, isn't it. The times start once from the plays the library knows (seedPlayed, as on
 * the computer: two songs of an album in a row count for the album, three of a playlist for it).
 */
import { create } from "zustand";
import { seedPlayed } from "../shared";
import { readJson, writeJson } from "../storage";
import { useLibrary } from "./library";
import { usePlayer } from "./player";
import { playlistTracks, usePlaylists } from "./playlists";

const FILE = "played.json";

interface Saved {
  /** "album:…", "artist:…" (lower case), "playlist:…", "mix:…" → when it last played */
  at: Record<string, number>;
  seeded: boolean;
}

interface PlayedState extends Saved {
  restored: boolean;
  touch(key: string): void;
  /** When things played on the other devices (lib/librarySync.ts): the later time of each stays. */
  adopt(times: Record<string, number>): void;
}

function save(): void {
  const { at, seeded } = usePlayed.getState();
  writeJson(FILE, { at, seeded } satisfies Saved);
}

export const usePlayed = create<PlayedState>((set, get) => ({
  at: {},
  seeded: false,
  restored: false,
  touch(key) {
    set({ at: { ...get().at, [key]: Date.now() } });
    save();
  },
  adopt(times) {
    const now = get().at;
    let next = now;
    for (const [key, at] of Object.entries(times)) {
      if ((next[key] ?? -1) >= at) continue;
      if (next === now) next = { ...now };
      next[key] = at;
    }
    if (next === now) return;
    set({ at: next });
    save();
  },
}));

/** Once, from the plays the library knows, in their order. */
function seedOnce(): void {
  const { seeded, restored } = usePlayed.getState();
  const { loaded, data, albums } = useLibrary.getState();
  if (seeded || !restored || !loaded || !data.tracks.length) return;
  const albumOf = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const a of albums) {
    sizes.set(`album:${a.key}`, a.tracks.length);
    for (const t of a.tracks) albumOf.set(t.id, `album:${a.key}`);
  }
  const lastAt = (id: string): number => data.counts[id]?.lastAt ?? 0;
  const history = data.tracks.filter((t) => lastAt(t.id) > 0).sort((a, b) => lastAt(b.id) - lastAt(a.id));
  const collections = usePlaylists.getState().playlists.map((p) => ({ id: `playlist:${p.id}`, keys: new Set(playlistTracks(p).map((t) => t.id)) }));
  const at = seedPlayed(history, { keyOf: (t) => t.id, albumOf: (t) => albumOf.get(t.id) ?? null, albumSize: (album) => sizes.get(album) ?? 0, collections }, Date.now());
  usePlayed.setState({ at: { ...at, ...usePlayed.getState().at }, seeded: true });
  save();
}

export function watchPlayed(): void {
  void Promise.all([readJson<Saved>(FILE), usePlaylists.getState().restore()]).then(([saved]) => {
    usePlayed.setState({ at: { ...(saved?.at ?? {}), ...usePlayed.getState().at }, seeded: saved?.seeded ?? false, restored: true });
    seedOnce();
  });
  useLibrary.subscribe(seedOnce);
  usePlaylists.subscribe(seedOnce);
  // The list as it was started.
  let list: { source: string; ids: Set<string> } | null = null;
  usePlayer.subscribe((s, prev) => {
    if (s.source !== (list?.source ?? null)) list = s.source ? { source: s.source, ids: new Set(s.queue.map((t) => t.id)) } : null;
    // Another device's music, shown here, is that device's to count.
    if (!list || s.remote) return;
    const started = s.playWhenReady && (!prev.playWhenReady || s.index !== prev.index || s.queue !== prev.queue);
    const song = s.queue[s.index];
    if (started && song && list.ids.has(song.id)) usePlayed.getState().touch(list.source);
  });
}
