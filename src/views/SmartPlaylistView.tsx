/**
 * A smart playlist's page: its live songs (worked out from the rules every
 * time the catalogue changes), the rules as a subtitle, edit and delete.
 */
import { useMemo } from "react";
import { Pencil, Sparkles, Trash2 } from "lucide-react";
import { CollectionHeader } from "../components/LibraryCards";
import { useSmartEditor } from "../components/SmartPlaylistEditor";
import { TrackList } from "../components/TrackList";
import { EmptyState } from "../components/primitives";
import { describeRules, evaluateSmartPlaylist, readsPlays } from "../lib/smartPlaylists";
import { useCatalog, useFreshPlayCounts, type PlayCounts } from "../stores/catalog";
import { useLibrary } from "../stores/library";
import { soundOf, useSound } from "../stores/sound";
import { skipsOf } from "../stores/skips";
import { useSmartPlaylists } from "../stores/smartPlaylists";
import { useUI } from "../stores/ui";
import { T } from "../lib/i18n";

const NO_COUNTS: PlayCounts = {};

export function SmartPlaylistView({ id }: { id: string }) {
  const sp = useSmartPlaylists((s) => s.playlists.find((p) => p.id === id) ?? null);
  const tracks = useCatalog((s) => s.tracks);
  const loaded = useCatalog((s) => s.loaded);
  const counts = useCatalog((s) => s.playCounts);
  const liked = useLibrary((s) => s.liked);
  useFreshPlayCounts();
  const likedIds = useMemo(() => new Set(liked.map((t) => t.id)), [liked]);
  // Rules on how songs sound, and the flowing order, read the sound analysis.
  const facts = useSound((s) => s.facts);
  // A play counted changes only the lists that read play counts: the others aren't worked out again.
  const plays = sp && readsPlays(sp) ? counts : NO_COUNTS;
  const songs = useMemo(() => (sp ? evaluateSmartPlaylist(sp, tracks, plays, likedIds, (t) => soundOf(t, facts), (t) => skipsOf(t.id)) : []), [sp, tracks, plays, likedIds, facts]);

  if (!sp) return <EmptyState icon={Sparkles} title={T("Smart playlist not found")} body={T("It may have been deleted.")} />;
  if (!loaded) return null;

  const remove = (): void =>
    useUI.getState().openDialog({
      title: T("Delete “{name}”?", { name: sp.name }),
      body: T("Only the rules are deleted — your songs stay where they are."),
      confirmLabel: T("Delete"),
      danger: true,
      onConfirm: () => {
        useSmartPlaylists.getState().remove(sp.id);
        useUI.getState().navigate({ name: "home" });
      },
    });

  return (
    <div className="space-y-6">
      <CollectionHeader
        label={T("Smart playlist")}
        title={sp.name}
        subtitle={describeRules(sp)}
        tracks={songs}
        actions={
          <>
            <button
              onClick={() => useSmartEditor.getState().open(sp, false)}
              title={T("Edit rules")}
              aria-label={T("Edit rules")}
              className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-ink-hi hover:scale-105 transition-all"
            >
              <Pencil className="w-5 h-5" />
            </button>
            <button
              onClick={remove}
              title={T("Delete smart playlist")}
              aria-label={T("Delete smart playlist")}
              className="w-10 h-10 grid place-items-center rounded-full text-ink-hi/70 hover:text-red-400 hover:scale-105 transition-all"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </>
        }
      />
      {songs.length ? (
        <TrackList tracks={songs} showAlbum sourceName={sp.name} emptyLabel={T("No songs.")} />
      ) : (
        <EmptyState icon={Sparkles} title={T("No songs match yet")} body={T("Change the rules, or add music that fits them.")} />
      )}
    </div>
  );
}
