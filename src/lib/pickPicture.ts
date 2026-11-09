/**
 * A picture chosen by hand for an album or a playlist: asks for the file, then
 * makes it the size it's shown at. Nothing of the file stays but that copy.
 */

/** Asks for an image file; null when nobody chose one. */
function chooseImageFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp";
    input.style.display = "none";
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no picture"))), "image/jpeg", quality);
  });
}

/** The picture as a JPEG of at most `maxSide`, cut to a square when `square`, and below `maxBytes`. */
async function shrunk(file: Blob, { maxSide, square, maxBytes }: { maxSide: number; square: boolean; maxBytes: number }): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const cropW = square ? Math.min(bitmap.width, bitmap.height) : bitmap.width;
    const cropH = square ? cropW : bitmap.height;
    let side = maxSide;
    for (;;) {
      const scale = Math.min(1, side / Math.max(cropW, cropH));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(cropW * scale));
      canvas.height = Math.max(1, Math.round(cropH * scale));
      const draw = canvas.getContext("2d");
      if (!draw) throw new Error("no canvas");
      draw.imageSmoothingQuality = "high";
      // A transparent PNG goes on black, the way the app's own background is.
      draw.fillStyle = "#000";
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.drawImage(bitmap, (bitmap.width - cropW) / 2, (bitmap.height - cropH) / 2, cropW, cropH, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.86, 0.72]) {
        const blob = await toJpeg(canvas, quality);
        if (blob.size <= maxBytes) return blob;
      }
      side = Math.round(side * 0.75);
    }
  } finally {
    bitmap.close();
  }
}

function asDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsDataURL(blob);
  });
}

/** An album's cover: square, kept on this computer as a file like the covers read from music files. */
export async function pickAlbumCover(): Promise<string | null> {
  const file = await chooseImageFile();
  if (!file) return null;
  const blob = await shrunk(file, { maxSide: 1200, square: true, maxBytes: 1_500_000 });
  const url = await window.bytune?.saveArtwork(new Uint8Array(await blob.arrayBuffer()));
  if (!url) throw new Error("not saved");
  return url;
}

/** A playlist's picture: travels with the playlist to the other devices, so it's written into it, and small. */
export async function pickPlaylistPicture(): Promise<string | null> {
  const file = await chooseImageFile();
  if (!file) return null;
  return asDataUrl(await shrunk(file, { maxSide: 1000, square: false, maxBytes: 200_000 }));
}

/**
 * An album's picture as it goes to the other devices (lib/librarySync.ts): small, written into the
 * document. The bytes come from the main process: the page may not fetch localart:// itself.
 */
export async function albumPictureToShare(cover: string): Promise<string> {
  const bytes = (await window.bytune?.localArtBytes(cover)) as Uint8Array | null | undefined;
  if (!bytes?.length) throw new Error("unreadable");
  return asDataUrl(await shrunk(new Blob([new Uint8Array(bytes)]), { maxSide: 600, square: true, maxBytes: 120_000 }));
}

/** An album's picture from another device, kept on this computer like one chosen here; resolves to its localart:// address. */
export async function keepSharedAlbumPicture(data: string): Promise<string> {
  const base64 = data.slice(data.indexOf(",") + 1);
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const url = await window.bytune?.saveArtwork(bytes);
  if (!url) throw new Error("not saved");
  return url;
}
