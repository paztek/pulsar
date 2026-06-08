// Generates the menu bar tray icons as colored status dots, one per serial
// connectivity state, at 16px (@1x) and 32px (@2x). Self-contained PNG encoder
// using only Node built-ins (zlib) — no image dependencies.
//
//   node scripts/gen-tray-icons.js  →  assets/tray/{connected,connecting,disconnected}{,@2x}.png

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function dot(size, [r, g, b]) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const a = Math.max(0, Math.min(1, radius - d + 0.5)); // ~1px anti-aliased edge
      const i = (y * size + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = Math.round(a * 255);
    }
  }
  return rgba;
}

const COLORS = {
  connected: [40, 200, 100], // green
  connecting: [240, 180, 40], // amber
  disconnected: [225, 70, 60], // red
};

const outDir = path.join(__dirname, '..', 'assets', 'tray');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, color] of Object.entries(COLORS)) {
  fs.writeFileSync(path.join(outDir, `${name}.png`), png(16, dot(16, color)));
  fs.writeFileSync(path.join(outDir, `${name}@2x.png`), png(32, dot(32, color)));
  console.log(`wrote ${name}.png + ${name}@2x.png`);
}
