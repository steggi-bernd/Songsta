/**
 * Canvas lookup hook — resolves the current track's looping video artwork
 * once per track, off the render path, only when the user opted in. Asked by
 * title, artist and album, so a song from the music folder finds one as well
 * as the same song on a server (they used to be left out).
 */
import { useEffect, useState } from "react";
import { useSettings } from "../stores/settings";
import type { Track } from "../types";

export function useCanvas(track: Track | null): string | null {
  const enabled = useSettings((s) => s.animatedCanvas);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !track || !track.title || !track.artist) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    setUrl(null);
    window.bytune
      ?.getCanvas({ title: track.title, artist: track.artist, album: track.album })
      .then((hit) => {
        if (!cancelled && hit?.url) setUrl(hit.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, track?.id]);

  return url;
}
