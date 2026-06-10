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
const INNER = 824; // the rounded tile occupies this within the canvas
const MARGIN = (CANVAS - INNER) / 2; // 100px padding (the macOS icon grid)

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

// ---- background removal + crop ----
function lum(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Flood-fill near-white pixels reachable from the border → transparent, feathering
// the anti-aliased edge. Interior light pixels (not connected to the border) are
// left untouched.
function removeBackground(rgba, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  const light = (i) => lum(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) >= 225;
  const seed = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) stack.push(y * w + x); };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }

  while (stack.length) {
    const i = stack.pop();
    if (bg[i] || !light(i)) continue;
    bg[i] = 1;
    const x = i % w, y = (i / w) | 0;
    seed(x + 1, y); seed(x - 1, y); seed(x, y + 1); seed(x, y - 1);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (bg[i]) { rgba[i * 4 + 3] = 0; continue; }
      const L = lum(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
      if (L < 170) continue; // clearly foreground
      // light pixel touching the background = an AA edge: feather it out
      let edge = false;
      for (let dy = -1; dy <= 1 && !edge; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && bg[ny * w + nx]) { edge = true; break; }
        }
      }
      if (edge) {
        const a = Math.round(255 * Math.max(0, Math.min(1, (255 - L) / 85)));
        rgba[i * 4 + 3] = Math.min(rgba[i * 4 + 3], a);
      }
    }
  }
}

// Crop to the bounding box of pixels with alpha above `threshold`.
function cropToContent(rgba, w, h, threshold) {
  let minx = w, miny = h, maxx = -1, maxy = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > threshold) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  }
  if (maxx < 0) return { rgba, w, h };
  const cw = maxx - minx + 1, ch = maxy - miny + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    rgba.copy(out, y * cw * 4, ((miny + y) * w + minx) * 4, ((miny + y) * w + minx) * 4 + cw * 4);
  }
  return { rgba: out, w: cw, h: ch };
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

// The source is already a rounded tile on a white background. Make that
// background transparent (flood-fill from the borders so interior whites — the
// center node, icons, dashed rings — are preserved), then crop to the tile and
// re-pad to the macOS grid. No mask is added; the artwork's own shape is kept.
removeBackground(src.rgba, src.width, src.height);
const tile = cropToContent(src.rgba, src.width, src.height, 16);

// Fit the tile into INNER (preserving aspect), centered on the canvas.
const scale = INNER / Math.max(tile.w, tile.h);
const tw = Math.round(tile.w * scale);
const th = Math.round(tile.h * scale);
const fitted = resize(tile.rgba, tile.w, tile.h, tw, th);

const canvas = Buffer.alloc(CANVAS * CANVAS * 4); // transparent
const offX = MARGIN + ((INNER - tw) >> 1);
const offY = MARGIN + ((INNER - th) >> 1);
for (let y = 0; y < th; y++) {
  for (let x = 0; x < tw; x++) {
    const si = (y * tw + x) * 4;
    const di = ((y + offY) * CANVAS + (x + offX)) * 4;
    canvas[di] = fitted[si];
    canvas[di + 1] = fitted[si + 1];
    canvas[di + 2] = fitted[si + 2];
    canvas[di + 3] = fitted[si + 3];
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
  console.log(`wrote ${outPath} (transparent background, ${MARGIN}px padding)`);
} else {
  fs.writeFileSync(outPath, encodePng(CANVAS, CANVAS, canvas));
  console.log(`wrote ${outPath} (${CANVAS}x${CANVAS} master)`);
}
