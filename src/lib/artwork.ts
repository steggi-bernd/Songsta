/**
 * Scheme gate for artwork URLs. Thumb strings come from servers and backups
 * (hostile data in a shared-backup scenario); only web image, data, blob and
 * the app's own schemes may reach an <img src>. file:/UNC and other schemes
 * collapse to "" — the UI's fallback art takes over. Exported for regression
 * tests.
 */
export function artworkUrlOk(url: string): boolean {
  return /^(https?:\/\/|data:image\/|blob:|localart:|jfart:|ssart:)/i.test(url);
}

/** A cover's address, checked; online covers in the sizes 50x50 and 150x150 come as the 500x500 they also exist in. */
export function upgradeArtwork(url: string | null | undefined): string {
  if (!url || typeof url !== "string") return "";
  const out = url.trim();
  if (!out || !artworkUrlOk(out)) return "";
  return out.replace(/150x150|50x50/g, "500x500");
}
