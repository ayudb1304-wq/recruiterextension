/**
 * Generates the extension icons: a table with an arrow leaving it (docs/09 §5).
 *
 * Deliberately NOT a LinkedIn logo and not blue-in-a-square — that invites a
 * trademark complaint and a takedown.
 *
 * Zero dependencies: writes PNGs with node's zlib. Run with:
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../extension/public/icon');

const BG = [10, 92, 54]; // --accent
const FG = [255, 255, 255];
const SIZES = [16, 32, 48, 128];
/** Supersample then box-filter, so the small sizes stay legible. */
const SS = 8;

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Draw the glyph at a normalized 0..1 coordinate space. */
function sample(u, v) {
  // rounded-square background
  const r = 0.18;
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(dx, dy) > r) return null; // transparent outside

  // table: three rows in the left two-thirds
  const inTable = u > 0.17 && u < 0.63;
  const rowHeight = 0.1;
  const rows = [0.28, 0.46, 0.64];
  for (const top of rows) {
    if (inTable && v > top && v < top + rowHeight) return FG;
  }

  // arrow: shaft + head, leaving the table to the right
  const shaft = v > 0.44 && v < 0.54 && u > 0.6 && u < 0.78;
  if (shaft) return FG;
  // triangular head
  const hx = u - 0.72;
  const hy = Math.abs(v - 0.49);
  if (hx > 0 && hx < 0.16 && hy < 0.16 - hx * 0.9) return FG;

  return BG;
}

function render(size) {
  const big = size * SS;
  const acc = new Float64Array(size * size * 4);

  for (let y = 0; y < big; y += 1) {
    for (let x = 0; x < big; x += 1) {
      const color = sample((x + 0.5) / big, (y + 0.5) / big);
      const px = Math.floor(x / SS);
      const py = Math.floor(y / SS);
      const i = (py * size + px) * 4;
      if (color) {
        acc[i] += color[0];
        acc[i + 1] += color[1];
        acc[i + 2] += color[2];
        acc[i + 3] += 255;
      }
    }
  }

  const out = Buffer.alloc(size * size * 4);
  const per = SS * SS;
  for (let i = 0; i < size * size; i += 1) {
    // acc[3] accumulates 255 per covered subsample, so covered = acc[3] / 255.
    const covered = acc[i * 4 + 3] / 255;
    if (covered === 0) continue; // fully transparent pixel
    out[i * 4] = Math.round(acc[i * 4] / covered);
    out[i * 4 + 1] = Math.round(acc[i * 4 + 1] / covered);
    out[i * 4 + 2] = Math.round(acc[i * 4 + 2] / covered);
    out[i * 4 + 3] = Math.round((covered / per) * 255);
  }
  return encodePng(size, size, out);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(resolve(OUT_DIR, `${size}.png`), render(size));
  console.log(`wrote icon/${size}.png`);
}
