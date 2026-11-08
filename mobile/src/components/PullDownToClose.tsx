/**
 * A page closed by pulling it down, as the player is: from anywhere on it, while the list it shows is
 * at its top. It follows the finger, and past a quarter of the screen, or flung, it goes; otherwise it
 * springs back. Scrolling and sideways swipes stay the page's own. Android gives a drag to a scrolling
 * list before JavaScript sees it, so the pull is caught natively (PullDownView.kt).
 */
import type { ReactNode } from "react";
import { PullDownView } from "../../modules/media3-player";

export function PullDownToClose({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <PullDownView style={{ flex: 1 }} onClose={onClose}>
      {children}
    </PullDownView>
  );
}
