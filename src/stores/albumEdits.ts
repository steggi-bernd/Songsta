/**
 * The user's album corrections (lib/albumEdits.ts), persisted. The catalogue
 * re-applies them on every change, so an edit shows everywhere at once —
 * album and artist pages, the discography, the library panel, search.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { withAlias, withMerge, withSplit, type AlbumEdits, type SongEdit } from "../lib/albumEdits";

interface AlbumEditsState extends AlbumEdits {
  /** an album's artist credit line; null goes back to its tags */
  setArtists(key: string, credit: string | null): void;
  merge(from: string, into: string): void;
  split(from: string): void;
  /** show an artist name as another spelling; null shows it as tagged again */
  setAlias(name: string, as: string | null): void;
  /** put songs on an album by hand, by song id (every copy's) */
  setSongs(edits: Record<string, SongEdit>): void;
  /** take songs off the album they were put on by hand */
  clearSongs(ids: string[]): void;
  /** the name an album is shown under; null goes back to its tags */
  setTitle(key: string, title: string | null): void;
  /** an album's picture; null goes back to the one its songs bring */
  setCover(key: string, cover: string | null): void;
}

export const useAlbumEdits = create<AlbumEditsState>()(
  persist(
    (set) => ({
      artists: {},
      mergedInto: {},
      aliases: {},
      songs: {},
      titles: {},
      covers: {},

      setArtists(key, credit) {
        set((s) => {
          const artists = { ...s.artists };
          const clean = credit?.trim();
          if (clean) artists[key] = clean;
          else delete artists[key];
          return { artists };
        });
      },

      merge(from, into) {
        set((s) => ({ mergedInto: withMerge(s.mergedInto, from, into) }));
      },

      split(from) {
        set((s) => ({ mergedInto: withSplit(s.mergedInto, from) }));
      },

      setAlias(name, as) {
        set((s) => ({ aliases: withAlias(s.aliases, name, as) }));
      },

      setSongs(edits) {
        set((s) => ({ songs: { ...(s.songs ?? {}), ...edits } }));
      },

      clearSongs(ids) {
        set((s) => {
          const songs = { ...(s.songs ?? {}) };
          for (const id of ids) delete songs[id];
          return { songs };
        });
      },

      setTitle(key, title) {
        set((s) => {
          const titles = { ...s.titles };
          const clean = title?.trim();
          if (clean) titles[key] = clean;
          else delete titles[key];
          return { titles };
        });
      },

      setCover(key, cover) {
        set((s) => {
          const covers = { ...s.covers };
          if (cover) covers[key] = cover;
          else delete covers[key];
          return { covers };
        });
      },
    }),
    {
      name: "album-edits",
      storage: createJSONStorage(() => storage),
      partialize: (s) => ({ artists: s.artists, mergedInto: s.mergedInto, aliases: s.aliases, songs: s.songs, titles: s.titles, covers: s.covers }) as unknown as AlbumEditsState,
    }
  )
);
