/**
 * Generate the PWA icon set.
 *
 * Chrome will not offer to install a PWA without a raster icon, so the icons are
 * real PNGs rather than an SVG. They are written from scratch (zlib is in the
 * Node standard library) to avoid pulling an image dependency into a package
 * that otherwise only needs Vue and Vite.
 *
 * Run with `npm run icons` after changing the artwork.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const BG = [0x10, 0x10, 0x14];
const ACCENT = [0x7d, 0xd3, 0xa7];
const DIM = [0x8a, 0x8f, 0x9a];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = pixels[i];
      raw[o + 1] = pixels[i + 1];
      raw[o + 2] = pixels[i + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** A `>_` prompt glyph on a rounded dark tile. */
function draw(size) {
  const px = Buffer.alloc(size * size * 3);
  const radius = size * 0.22;
  const put = (x, y, color, alpha = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    for (let c = 0; c < 3; c++) {
      px[i + c] = Math.round(px[i + c] * (1 - alpha) + color[c] * alpha);
    }
  };

  const inTile = (x, y) => {
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inTile(x + 0.5, y + 0.5)) put(x, y, BG);
      else put(x, y, [0x0a, 0x0a, 0x0d]);
    }
  }

  const stroke = Math.max(2, Math.round(size * 0.055));
  const paint = (x, y, color) => {
    for (let dy = 0; dy < stroke; dy++) for (let dx = 0; dx < stroke; dx++) put(x + dx, y + dy, color);
  };

  // Chevron `>`.
  const x0 = Math.round(size * 0.22);
  const yMid = Math.round(size * 0.5);
  const arm = Math.round(size * 0.2);
  for (let t = 0; t <= arm; t++) {
    const yTop = yMid - arm + t;
    const yBot = yMid + arm - t;
    for (let d = 0; d < stroke; d++) {
      const x = x0 + t;
      // Thickness applied perpendicular-ish by stacking rows.
      for (let k = -Math.floor(stroke / 2); k <= Math.floor(stroke / 2); k++) {
        put(x, yTop + k, ACCENT);
        put(x, yBot + k, ACCENT);
      }
    }
  }

  // Underscore.
  const ux = Math.round(size * 0.52);
  const uw = Math.round(size * 0.28);
  const uy = Math.round(size * 0.72);
  for (let x = ux; x < ux + uw; x++) for (let d = 0; d < stroke; d++) put(x, uy + d, DIM);

  return px;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [192, 512]) {
  writeFileSync(join(OUT_DIR, `icon-${size}.png`), png(size, draw(size)));
  console.log(`wrote public/icon-${size}.png`);
}
