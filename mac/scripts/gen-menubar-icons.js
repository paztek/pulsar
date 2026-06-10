// Generates the menu bar icons: a simplified "pulsar" glyph (central hub + four
// radiating arms ending in nodes) with a colored status badge in the corner.
// Non-template (so the badge can be colored), rendered per theme — a dark glyph
// for a light menu bar and a light glyph for a dark one. Each glyph carries a
// contrasting halo so its silhouette still reads if macOS shows the "wrong"
// variant (the menu bar can be dark in Light mode over a dark wallpaper, where
// `nativeTheme.shouldUseDarkColors` is still false). Self-contained (Node zlib
// only); supersampled then downscaled for anti-aliasing.
//
//   node scripts/gen-menubar-icons.js          # → assets/menubar/*.png
//   node scripts/gen-menubar-icons.js preview   # → /tmp/menubar-preview.png (a grid to eyeball)

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SS = 8; // supersample factor

const GLYPH_DARK = [28, 28, 32]; // for a light menu bar
const GLYPH_LIGHT = [255, 255, 255]; // for a dark menu bar
const STATUS = {
  connected: [42, 196, 102],
  connecting: [240, 176, 48],
  disconnected: [228, 72, 60],
};

// Each variant pairs a glyph color with a halo in the opposite tone, so the
// silhouette reads on either menu bar background.
const VARIANTS = [
  { name: 'light', glyph: GLYPH_DARK, halo: GLYPH_LIGHT }, // light menu bar
  { name: 'dark', glyph: GLYPH_LIGHT, halo: GLYPH_DARK }, // dark menu bar
];

// ---- drawing on an RGBA buffer (W x W) ----
function px(buf, W, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
function disc(buf, W, cx, cy, rad, color, a = 255) {
  const r2 = rad * rad;
  for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++) {
    for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) px(buf, W, x, y, color[0], color[1], color[2], a);
    }
  }
}
function rect(buf, W, x0, y0, x1, y1, color) {
  for (let y = Math.round(y0); y < Math.round(y1); y++) {
    for (let x = Math.round(x0); x < Math.round(x1); x++) px(buf, W, x, y, color[0], color[1], color[2], 255);
  }
}

// `grow` dilates every shape by a uniform margin (in px) — used to paint the
// halo pass underneath the glyph at grow=0.
function drawGlyph(buf, W, color, grow = 0) {
  const c = W / 2;
  const armLen = W * 0.39;
  const armHW = W * 0.043 + grow;
  const centerR = W * 0.16 + grow;
  const endR = W * 0.092 + grow;
  const armEnd = armLen + grow; // outer end of each arm, extended by the halo
  // four orthogonal arms
  rect(buf, W, c - armHW, c - armEnd, c + armHW, c + grow, color); // up
  rect(buf, W, c - armHW, c - grow, c + armHW, c + armEnd, color); // down
  rect(buf, W, c - armEnd, c - armHW, c + grow, c + armHW, color); // left
  rect(buf, W, c - grow, c - armHW, c + armEnd, c + armHW, color); // right
  // end nodes
  disc(buf, W, c, c - armLen, endR, color);
  disc(buf, W, c, c + armLen, endR, color);
  disc(buf, W, c - armLen, c, endR, color);
  disc(buf, W, c + armLen, c, endR, color);
  // hub
  disc(buf, W, c, c, centerR, color);
}

function drawStatus(buf, W, color) {
  const cx = W * 0.8, cy = W * 0.8;
  const r = W * 0.22;
  disc(buf, W, cx, cy, r + W * 0.055, [0, 0, 0], 0); // transparent moat so it reads on the glyph
  disc(buf, W, cx, cy, r, color);
}

// ---- box downscale ----
function resize(src, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor((y * sh) / dh), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor((x * sw) / dw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * sw) / dw));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const si = (sy * sw + sx) * 4; r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3]; n++;
      }
      const di = (y * dw + x) * 4; out[di] = (r / n) | 0; out[di + 1] = (g / n) | 0; out[di + 2] = (b / n) | 0; out[di + 3] = (a / n) | 0;
    }
  }
  return out;
}

const HALO = 0.06; // halo thickness as a fraction of icon width

function icon(size, glyphColor, haloColor, statusColor) {
  const W = size * SS;
  const big = Buffer.alloc(W * W * 4);
  drawGlyph(big, W, haloColor, W * HALO); // halo pass underneath
  drawGlyph(big, W, glyphColor); // glyph on top
  drawStatus(big, W, statusColor);
  return resize(big, W, W, size, size);
}

// ---- PNG encode ----
function crc32(buf) { let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(t, d) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length, 0); const tb = Buffer.from(t, 'ascii'); const cr = Buffer.alloc(4); cr.writeUInt32BE(crc32(Buffer.concat([tb, d])), 0); return Buffer.concat([l, tb, d, cr]); }
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- outputs ----
if (process.argv[2] === 'preview') {
  // grid: rows = light/dark bar, cols = status × variant (each variant shown on
  // both bars so the halo's cross-background legibility is visible)
  const cell = 72, s = 48, pad = (cell - s) / 2;
  const statuses = Object.keys(STATUS);
  const cols = statuses.flatMap((st) => VARIANTS.map((v) => ({ st, v })));
  const rows = [[245, 245, 247], [40, 40, 42]];
  const W = cell * cols.length, H = cell * rows.length;
  const out = Buffer.alloc(W * H * 4);
  rows.forEach((bg, ri) => {
    cols.forEach(({ st, v }, ci) => {
      const ic = icon(s, v.glyph, v.halo, STATUS[st]);
      for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const X = ci * cell + x, Y = ri * cell + y, di = (Y * W + X) * 4;
        out[di] = bg[0]; out[di + 1] = bg[1]; out[di + 2] = bg[2]; out[di + 3] = 255;
      }
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const si = (y * s + x) * 4, a = ic[si + 3] / 255;
        if (!a) continue;
        const X = ci * cell + pad + x, Y = ri * cell + pad + y, di = (Y * W + X) * 4;
        out[di] = Math.round(ic[si] * a + out[di] * (1 - a));
        out[di + 1] = Math.round(ic[si + 1] * a + out[di + 1] * (1 - a));
        out[di + 2] = Math.round(ic[si + 2] * a + out[di + 2] * (1 - a));
      }
    });
  });
  fs.writeFileSync('/tmp/menubar-preview.png', encodePng(W, H, out));
  console.log('wrote /tmp/menubar-preview.png');
} else {
  const dir = path.join(__dirname, '..', 'assets', 'menubar');
  fs.mkdirSync(dir, { recursive: true });
  for (const [st, color] of Object.entries(STATUS)) {
    for (const v of VARIANTS) {
      fs.writeFileSync(path.join(dir, `${st}-${v.name}.png`), encodePng(16, 16, icon(16, v.glyph, v.halo, color)));
      fs.writeFileSync(path.join(dir, `${st}-${v.name}@2x.png`), encodePng(32, 32, icon(32, v.glyph, v.halo, color)));
    }
  }
  console.log('wrote assets/menubar/*.png');
}
