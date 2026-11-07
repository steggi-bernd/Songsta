/**
 * Generates the Songsta app icons from src/assets/brand/songsta-icon.svg
 * (full badge design — rounded dark tile with the white mark, on
 * transparent):
 *   build/icon.png  — 512x512 master used for the runtime window/Dock icon
 *   build/icon.ico  — Windows size ladder 16-256: BMP entries up to 128,
 *                     PNG-compressed 256 (the only size the ICO spec allows
 *                     as PNG)
 *   build/icon.icns — macOS size ladder 16-1024 incl. Retina @2x variants,
 *                     PNG-based (what iconutil itself emits)
 *   installer-logo.bmp — the logo on the installer's own dark page (build/installer.nsh)
 * Windows surfaces (Start menu previews, taskbar, UAC, the NSIS installer)
 * each request one specific size; the ico must carry that size natively or
 * the requester scales whatever closest entry it finds, which is what blurs
 * large previews when only a single 256px image is present.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
mkdirSync(buildDir, { recursive: true });

const svg = readFileSync(join(root, "src", "assets", "brand", "songsta-icon.svg"), "utf8");

/* ---------- render the badge artwork ---------- */

function renderMark(height) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "height", value: height },
    background: "rgba(0,0,0,0)",
    // Pure-path artwork, no <text>: skipping the system font scan keeps a
    // dozen per-size renders from each paying for a full font database.
    font: { loadSystemFonts: false },
  });
  const rendered = resvg.render();
  const srcW = rendered.width;
  const srcH = rendered.height;
  if (srcH !== height) throw new Error(`expected height ${height}, got ${srcH}`);

  // Read the pixel buffer once: `rendered.pixels` is a copying getter, so
  // touching it per-pixel in the loop below re-copies the whole image and
  // exhausts memory.
  const rgba = Buffer.alloc(srcW * srcH * 4);
  rgba.set(rendered.pixels); // RGBA, width*height*4
  return { width: srcW, height: srcH, rgba };
}

/* ---------- compose the badge centered on a square transparent canvas ---------- */

const fitCache = new Map();
/**
 * Render the square badge onto a size×size transparent canvas. contentScale
 * < 1 shrinks the badge inside the canvas: macOS expects the tile to occupy
 * ~824/1024 of the icon canvas so it sits evenly beside Apple's own Dock
 * icons; Windows wants full bleed.
 */
function renderFit(size, contentScale = 1) {
  const key = size + "@" + contentScale;
  const cached = fitCache.get(key);
  if (cached) return cached;

  const mark = renderMark(Math.round(size * contentScale));
  const rgba = Buffer.alloc(size * size * 4);
  const xOff = Math.floor((size - mark.width) / 2);
  const yOff = Math.floor((size - mark.height) / 2);
  for (let y = 0; y < mark.height; y++) {
    const srcRow = y * mark.width * 4;
    const dstRow = (y + yOff) * size * 4;
    for (let x = 0; x < mark.width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + (x + xOff) * 4;
      rgba[di] = mark.rgba[si];
      rgba[di + 1] = mark.rgba[si + 1];
      rgba[di + 2] = mark.rgba[si + 2];
      rgba[di + 3] = mark.rgba[si + 3];
    }
  }
  fitCache.set(key, rgba);
  return rgba;
}

/* ---------- PNG encoding ---------- */

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- ICO: BMP entries (bottom-up BGRA + AND mask) ---------- */

function bmpEntry(size, rgba) {
  const maskRow = Math.ceil(size / 32) * 4; // 1bpp rows padded to 32 bits
  const xorSize = size * size * 4;
  const maskSize = maskRow * size;

  const header = Buffer.alloc(40); // BITMAPINFOHEADER
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND stacked
  header.writeUInt16LE(1, 12); // planes
  header.writeUInt16LE(32, 14); // bpp
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(xorSize + maskSize, 20);

  const body = Buffer.alloc(xorSize + maskSize);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4; // bottom-up
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 4;
      body[di] = rgba[si + 2]; // B
      body[di + 1] = rgba[si + 1]; // G
      body[di + 2] = rgba[si]; // R
      body[di + 3] = rgba[si + 3]; // A
    }
  }
  // The AND mask stays all-zero: with 32bpp the alpha channel governs, and a
  // zero mask means "opaque" so alpha is never overridden.
  return Buffer.concat([header, body]);
}

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 72, 96, 128, 256];

function buildICO() {
  const images = ICO_SIZES.map((size) => {
    const rgba = renderFit(size);
    // PNG compression is only spec-sanctioned for the 256 entry; smaller ones
    // must be BMP so every legacy consumer can decode them.
    return size === 256 ? encodePNG(size, size, rgba) : bmpEntry(size, rgba);
  });

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(ICO_SIZES.length, 4);

  const entries = [];
  let offset = 6 + ICO_SIZES.length * 16;
  ICO_SIZES.forEach((size, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 encodes 256
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[i].length;
    entries.push(entry);
  });

  return Buffer.concat([header, ...entries, ...images]);
}

/* ---------- ICNS: PNG chunks, incl. Retina @2x variants ---------- */

const ICNS_TYPES = [
  ["icp4", 16], // 16x16
  ["icp5", 32], // 32x32
  ["ic07", 128], // 128x128
  ["ic08", 256], // 256x256
  ["ic09", 512], // 512x512
  ["ic10", 1024], // 512x512@2x
  ["ic11", 32], // 16x16@2x
  ["ic12", 64], // 32x32@2x
  ["ic13", 256], // 128x128@2x
  ["ic14", 512], // 256x256@2x
];

/** Apple's icon grid: the tile occupies 824 of the 1024px canvas. */
const MAC_CONTENT = 824 / 1024;

function buildICNS() {
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const data = encodePNG(size, size, renderFit(size, MAC_CONTENT));
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

/* ---------- installer bitmaps for the NSIS assisted UI ---------- */

// BMP file: BITMAPFILEHEADER + BITMAPINFOHEADER + bottom-up BGRA rows.
// Always opaque: the wizard header strip and welcome sidebar are solid
// panels, and 32bpp BI_RGB is the most widely decoded BMP flavour.
function encodeBMP(width, height, pixels) {
  const stride = width * 4;
  const header = Buffer.alloc(54);
  header.write("BM", 0, "ascii");
  header.writeUInt32LE(54 + stride * height, 2);
  header.writeUInt32LE(54, 10); // bfOffBits
  header.writeUInt32LE(40, 14); // BITMAPINFOHEADER
  header.writeInt32LE(width, 18);
  header.writeInt32LE(height, 22);
  header.writeUInt16LE(1, 26); // planes
  header.writeUInt16LE(32, 28); // bpp
  header.writeUInt32LE(0, 30); // BI_RGB
  header.writeUInt32LE(stride * height, 34);
  const body = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * stride; // bottom-up
    const dstRow = y * stride;
    pixels.copy(body, dstRow, srcRow, srcRow + stride);
    // BMP stores BGRA; the pixel buffers are RGBA. The old symmetric colors
    // (pure white / flat gray) hid the difference — the gradient tile needs
    // the swap or its hue shifts.
    for (let x = 0; x < width; x++) {
      const di = dstRow + x * 4;
      const r = body[di];
      body[di] = body[di + 2];
      body[di + 2] = r;
    }
  }
  return Buffer.concat([header, body]);
}

// Solid panel with the badge centered on it, composited in its true colors:
// out = bg*(1-a) + badge*a per channel. (The previous white mark needed ink
// substitution — a white mark on the white header strip was invisible, the
// "ghosted logo" the default NSIS header icon produced. The badge carries
// its own tile background, so straight alpha compositing works on both the
// white header strip and the dark sidebar.)
function panelBMP(width, height, bg, markHeight) {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = bg[0];
    px[i * 4 + 1] = bg[1];
    px[i * 4 + 2] = bg[2];
    px[i * 4 + 3] = 255;
  }
  // renderFit returns a square size×size RGBA buffer (no width/height
  // fields) — the badge side is markHeight by construction.
  const badge = renderFit(markHeight);
  const xOff = Math.floor((width - markHeight) / 2);
  const yOff = Math.floor((height - markHeight) / 2);
  for (let y = 0; y < markHeight; y++) {
    const srcRow = y * markHeight * 4;
    for (let x = 0; x < markHeight; x++) {
      const si = srcRow + x * 4;
      const a = badge[si + 3] / 255;
      const di = ((yOff + y) * width + (xOff + x)) * 4;
      px[di] = Math.round(bg[0] + (badge[si] - bg[0]) * a);
      px[di + 1] = Math.round(bg[1] + (badge[si + 1] - bg[1]) * a);
      px[di + 2] = Math.round(bg[2] + (badge[si + 2] - bg[2]) * a);
      px[di + 3] = 255;
    }
  }
  return encodeBMP(width, height, px);
}

/* ---------- outputs ---------- */

writeFileSync(join(buildDir, "icon.png"), encodePNG(512, 512, renderFit(512)));
writeFileSync(join(buildDir, "icon.ico"), buildICO());
writeFileSync(join(buildDir, "icon.icns"), buildICNS());

// On the installer's dark page, which scales it down to fit the screen.
writeFileSync(join(buildDir, "installer-logo.bmp"), panelBMP(192, 192, [18, 18, 18], 192));

console.log(
  "Wrote build/icon.png (512), build/icon.ico (sizes " +
    ICO_SIZES.join(", ") +
    "), build/icon.icns (16-1024) and installer-logo.bmp (192)"
);
