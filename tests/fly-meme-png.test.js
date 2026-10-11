'use strict';
// Photosensitivity + size checks on the generated starter PNGs (web/memes/png). A tiny PNG decoder (8-bit, palette / RGB / RGBA) keeps this dependency-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '../web/memes/png');
const PAGE_BG = [11, 15, 26];
const LIMITS = { meanMin: 0.04, meanMax: 0.42, brightMax: 0.22, darkMax: 0.38 }; // same numbers as scripts/make_meme_pngs.py
const LUT = Array.from({ length: 256 }, (_, i) => { const v = i / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });

function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, plte = null, trns = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; assert.equal(data[12], 0, 'interlaced PNG not supported'); }
    else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  assert.equal(depth, 8, 'only 8-bit PNGs are supported by this checker');
  const bpp = { 2: 3, 3: 1, 6: 4, 0: 1, 4: 2 }[ctype]; assert.ok(bpp, 'colour type ' + ctype);
  const raw = zlib.inflateSync(Buffer.concat(idat)); const stride = w * bpp; const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, ctype, px, plte, trns, bpp };
}
// luminance stats over the page background (transparent pixels count as the page)
function stats(img) {
  let tot = 0, bright = 0, dark = 0; const n = img.w * img.h;
  for (let i = 0; i < n; i++) {
    let r, g, b, a = 255;
    if (img.ctype === 3) { const k = img.px[i]; r = img.plte[k * 3]; g = img.plte[k * 3 + 1]; b = img.plte[k * 3 + 2]; if (img.trns && k < img.trns.length) a = img.trns[k]; }
    else if (img.ctype === 6) { r = img.px[i * 4]; g = img.px[i * 4 + 1]; b = img.px[i * 4 + 2]; a = img.px[i * 4 + 3]; }
    else { r = img.px[i * 3]; g = img.px[i * 3 + 1]; b = img.px[i * 3 + 2]; }
    const k = a / 255; r = Math.round(r * k + PAGE_BG[0] * (1 - k)); g = Math.round(g * k + PAGE_BG[1] * (1 - k)); b = Math.round(b * k + PAGE_BG[2] * (1 - k));
    const l = 0.2126 * LUT[r] + 0.7152 * LUT[g] + 0.0722 * LUT[b];
    tot += l; if (l > 0.8) bright++; if (l < 0.0015) dark++;
  }
  return { mean: tot / n, bright: bright / n, dark: dark / n };
}

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.png')).sort();

test('starter set: at least 48 PNGs, each 480-720 px and under 120 KB, total well under 6 MB', () => {
  assert.ok(files.length >= 48, `only ${files.length} PNGs`);
  let total = 0;
  for (const f of files) {
    const buf = fs.readFileSync(path.join(DIR, f)); total += buf.length;
    assert.ok(buf.length < 120 * 1024, `${f} is ${buf.length} bytes`);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.ok(w >= 480 && w <= 720 && h >= 480 && h <= 720, `${f} is ${w}x${h}`);
  }
  assert.ok(total < 6 * 1024 * 1024, `total ${total}`);
});

test('PHOTOSENSITIVITY: every starter PNG has moderate luminance (no big white or pure black fields, no bright flashes)', () => {
  for (const f of files) {
    const s = stats(decodePng(fs.readFileSync(path.join(DIR, f))));
    const tag = `${f} ${JSON.stringify(s)}`;
    assert.ok(s.mean >= LIMITS.meanMin && s.mean <= LIMITS.meanMax, 'mean luminance: ' + tag);
    assert.ok(s.bright <= LIMITS.brightMax, 'too much near-white: ' + tag);
    assert.ok(s.dark <= LIMITS.darkMax, 'too much pure black: ' + tag);
  }
});

test('the luminance checker itself detects a white flash and a black slab', () => {
  const mk = (rgb) => ({ w: 4, h: 4, ctype: 2, px: Buffer.from(Array.from({ length: 16 }, () => rgb).flat()) });
  assert.ok(stats(mk([255, 255, 255])).mean > LIMITS.meanMax);
  assert.ok(stats(mk([255, 255, 255])).bright === 1);
  assert.ok(stats(mk([0, 0, 0])).dark === 1);
  assert.ok(stats(mk([120, 40, 160])).mean > LIMITS.meanMin);
});

test('belly-man is a transparent emoji PNG about 720 px', () => {
  const img = decodePng(fs.readFileSync(path.join(DIR, 'belly-man.png')));
  assert.ok(img.w >= 640 && img.w <= 720 && img.h >= 640 && img.h <= 720);
  assert.ok(img.ctype === 6 || (img.ctype === 3 && img.trns), 'must keep its transparency');
});
