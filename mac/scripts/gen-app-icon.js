// Builds a macOS-style app icon from a square source image: scales the art into
// an 824x824 squircle (rounded corners) centered on a 1024 transparent canvas
// (~100px padding, the macOS icon grid). Self-contained — Node built-ins only
// (zlib) for the imaging; iconutil (macOS) for the .icns container.
//
//   node scripts/gen-app-icon.js <source.png> assets/pulsar.icns   # → .icns (via iconutil)
//   node scripts/gen-app-icon.js <source.png> out-1024.png         # → 1024 master PNG
//
// Regenerate the app icon: npm run icon:app

const fs = require('fs');
const zlib = require('zlib');

const CANVAS = 1024;
const INNER = 824; // rounded square size within the canvas
const MARGIN = (CANVAS - INNER) / 2; // 100px padding
const RADIUS = 185; // corner radius (~22.4% of INNER, the macOS grid)

// ---- PNG decode (8-bit, non-interlaced, RGB or RGBA) ----
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  let p = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('only 8-bit PNG supported');
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('only RGB/RGBA PNG supported');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = raw[rp + i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 255;
      else if (filter !== 0) throw new Error('bad filter ' + filter);
      cur[i] = v;
    }
    rp += stride;
    for (let x = 0; x < width; x++) {
      const si = x * channels, di = (y * width + x) * 4;
      out[di] = cur[si];
      out[di + 1] = cur[si + 1];
      out[di + 2] = cur[si + 2];
      out[di + 3] = channels === 4 ? cur[si + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba: out };
}

// ---- box-filter downscale ----
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * sh) / dh);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * sw) / dw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * sw + sx) * 4;
          r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3]; n++;
        }
      }
      const di = (y * dw + x) * 4;
      out[di] = (r / n) | 0;
      out[di + 1] = (g / n) | 0;
      out[di + 2] = (b / n) | 0;
      out[di + 3] = (a / n) | 0;
    }
  }
  return out;
}

// ---- PNG encode (RGBA) ----
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
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---- main ----
const [srcPath, outPath] = process.argv.slice(2);
if (!srcPath || !outPath) {
  console.error('usage: node gen-app-icon.js <source.png> <out-1024.png>');
  process.exit(1);
}

const src = decodePng(fs.readFileSync(srcPath));
const inner = resize(src.rgba, src.width, src.height, INNER, INNER);

const canvas = Buffer.alloc(CANVAS * CANVAS * 4); // transparent
const half = INNER / 2;
for (let y = 0; y < INNER; y++) {
  for (let x = 0; x < INNER; x++) {
    // rounded-rectangle signed distance for the squircle mask
    const px = Math.abs(x + 0.5 - half) - (half - RADIUS);
    const py = Math.abs(y + 0.5 - half) - (half - RADIUS);
    const qx = Math.max(px, 0), qy = Math.max(py, 0);
    const d = Math.hypot(qx, qy) - RADIUS;
    let m = 0.5 - d; // ~1px anti-aliased edge
    if (m < 0) m = 0;
    else if (m > 1) m = 1;

    const si = (y * INNER + x) * 4;
    const di = ((y + MARGIN) * CANVAS + (x + MARGIN)) * 4;
    canvas[di] = inner[si];
    canvas[di + 1] = inner[si + 1];
    canvas[di + 2] = inner[si + 2];
    canvas[di + 3] = Math.round((inner[si + 3] / 255) * m * 255);
  }
}

if (outPath.endsWith('.icns')) {
  const os = require('os');
  const path = require('path');
  const cp = require('child_process');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'icns-'));
  const iconset = path.join(work, 'pulsar.iconset');
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), encodePng(s, s, resize(canvas, CANVAS, CANVAS, s, s)));
    const d = s * 2;
    fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), encodePng(d, d, resize(canvas, CANVAS, CANVAS, d, d)));
  }
  cp.execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outPath]);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`wrote ${outPath} (squircle, ${MARGIN}px padding, r=${RADIUS})`);
} else {
  fs.writeFileSync(outPath, encodePng(CANVAS, CANVAS, canvas));
  console.log(`wrote ${outPath} (${CANVAS}x${CANVAS} squircle master)`);
}
