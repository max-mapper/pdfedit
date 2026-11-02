// Synthetic image files for the tests of adding images (src/objects/place.test.ts, scripts/place-smoke.ts): a PNG
// writer for every colour type, bit depth and both interlace methods (each row with a different filter, so reading
// undoes all five), and a small baseline JPEG writer whose 8 × 8 blocks are each one colour (only the DC coefficient is
// coded, with the standard luminance DC table and a one-code AC table), with optional JFIF density, an Exif
// orientation and an Adobe marker (CMYK stored inverted, as such files are). Synthetic only.
import pako from 'pako';

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function chunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const td = new Uint8Array(4 + data.length);
  td.set([...type].map((c) => c.charCodeAt(0)));
  td.set(data, 4);
  return join([new Uint8Array(be32(data.length)), td, new Uint8Array(be32(crc32(td)))]);
}
function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngSpec = {
  width: number; height: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA. */
  ctype: 0 | 2 | 3 | 4 | 6;
  depth: 1 | 2 | 4 | 8 | 16;
  /** The samples of pixel (x, y), at the bit depth (palette: the index). */
  pixel: (x: number, y: number) => number[];
  palette?: [number, number, number][];
  /** tRNS: alpha per palette entry, or the transparent grey / RGB sample (at the bit depth). */
  trns?: number[];
  interlace?: boolean;
  /** pHYs in dots per inch. */
  dpi?: number;
};

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

export function writePng(s: PngSpec): Uint8Array {
  const ch = CHANNELS[s.ctype];
  const bpp = Math.max(1, Math.ceil((ch * s.depth) / 8));
  const out: Uint8Array[] = [];
  let rowNo = 0;
  const passes = s.interlace ? ADAM7 : [[0, 0, 1, 1]];
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((s.width - x0) / dx), h = Math.ceil((s.height - y0) / dy);
    if (w <= 0 || h <= 0) continue;
    const stride = Math.ceil((w * ch * s.depth) / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < h; y++) {
      const row = new Uint8Array(stride);
      for (let x = 0; x < w; x++) {
        const px = s.pixel(x0 + x * dx, y0 + y * dy);
        for (let k = 0; k < ch; k++) {
          const v = px[k], n = x * ch + k;
          if (s.depth === 16) { row[2 * n] = v >> 8; row[2 * n + 1] = v & 255; } else if (s.depth === 8) row[n] = v;
          else { const bit = n * s.depth; row[bit >> 3] |= v << (8 - s.depth - (bit & 7)); }
        }
      }
      const f = rowNo++ % 5;
      const fr = new Uint8Array(stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        fr[i] = (row[i] - pred) & 255;
      }
      out.push(new Uint8Array([f]), fr);
      prev = row;
    }
  }
  const parts: Uint8Array[] = [SIGNATURE];
  parts.push(chunk('IHDR', [...be32(s.width), ...be32(s.height), s.depth, s.ctype, 0, 0, s.interlace ? 1 : 0]));
  if (s.dpi) { const ppm = Math.round(s.dpi / 0.0254); parts.push(chunk('pHYs', [...be32(ppm), ...be32(ppm), 1])); }
  if (s.palette) parts.push(chunk('PLTE', s.palette.flat()));
  if (s.trns) parts.push(chunk('tRNS', s.ctype === 3 ? s.trns : s.trns.flatMap((v) => [v >> 8, v & 255])));
  const z = pako.deflate(join(out));
  // two IDAT chunks, so reading joins them
  const cut = Math.floor(z.length / 2);
  parts.push(chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)), chunk('IEND', []));
  return join(parts);
}

/** A PNG header that claims a size without the image data to match (for the size limits). */
export function pngHeaderOnly(width: number, height: number): Uint8Array {
  return join([SIGNATURE, chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]), chunk('IDAT', pako.deflate(new Uint8Array(10))), chunk('IEND', [])]);
}

// ── JPEG ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type JpegSpec = {
  width: number; height: number;
  /** 1 grey, 3 colour (YCbCr from RGB), 4 CMYK (with an Adobe marker, stored inverted). */
  comps: 1 | 3 | 4;
  /** The colour of the 8 × 8 block (bx, by): [grey], [r, g, b] or [c, m, y, k] (0–255; CMYK as ink amounts). */
  block: (bx: number, by: number) => number[];
  orientation?: number;
  dpi?: number;
  /** Write a frame header of this kind instead of baseline (0xc0), for refusals. */
  sof?: number;
  /** Sample precision written in the frame header (default 8). */
  precision?: number;
};

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** Canonical Huffman codes from code-length counts (ITU T.81 Annex C). */
function huffCodes(bits: number[], vals: number[]): Map<number, [number, number]> {
  const m = new Map<number, [number, number]>();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) m.set(vals[k++], [code++, len]);
    code <<= 1;
  }
  return m;
}
const DC_CODES = huffCodes(DC_BITS, DC_VALS);

export function writeJpeg(s: JpegSpec): Uint8Array {
  const out: number[] = [0xff, 0xd8];
  const seg = (m: number, d: number[]) => out.push(0xff, m, ((d.length + 2) >> 8) & 255, (d.length + 2) & 255, ...d);
  const str = (t: string) => [...t].map((c) => c.charCodeAt(0));
  if (s.dpi) seg(0xe0, [...str('JFIF'), 0, 1, 1, 1, s.dpi >> 8, s.dpi & 255, s.dpi >> 8, s.dpi & 255, 0, 0]);
  if (s.orientation) {
    // Exif: big-endian TIFF header, IFD0 with one entry (0x0112, SHORT, 1)
    seg(0xe1, [...str('Exif'), 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, s.orientation, 0, 0, 0, 0, 0, 0]);
  }
  if (s.comps === 4) seg(0xee, [...str('Adobe'), 0, 100, 0, 0, 0, 0, 0]);   // transform 0: no colour conversion
  seg(0xdb, [0, ...new Array(64).fill(1)]);   // one quantisation table of ones
  const ids = Array.from({ length: s.comps }, (_, i) => i + 1);
  seg(s.sof ?? 0xc0, [s.precision ?? 8, s.height >> 8, s.height & 255, s.width >> 8, s.width & 255, s.comps, ...ids.flatMap((id) => [id, 0x11, 0])]);
  seg(0xc4, [0x00, ...DC_BITS, ...DC_VALS]);
  seg(0xc4, [0x10, 1, ...new Array(15).fill(0), 0x00]);   // AC: one code, end of block
  seg(0xda, [s.comps, ...ids.flatMap((id) => [id, 0x00]), 0, 63, 0]);
  // entropy-coded data
  let acc = 0, nbits = 0;
  const put = (code: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((code >> i) & 1);
      if (++nbits === 8) { out.push(acc); if (acc === 0xff) out.push(0); acc = 0; nbits = 0; }
    }
  };
  const pred = new Array(s.comps).fill(0);
  const bw = Math.ceil(s.width / 8), bh = Math.ceil(s.height / 8);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const c = s.block(bx, by);
      const comps = s.comps === 1 ? [c[0]] : s.comps === 3
        ? [0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2], -0.168736 * c[0] - 0.331264 * c[1] + 0.5 * c[2] + 128, 0.5 * c[0] - 0.418688 * c[1] - 0.081312 * c[2] + 128]
        : c.map((v) => 255 - v);
      for (let k = 0; k < s.comps; k++) {
        const dc = Math.round(8 * (comps[k] - 128));
        const diff = dc - pred[k];
        pred[k] = dc;
        const mag = Math.abs(diff);
        const cat = mag === 0 ? 0 : Math.floor(Math.log2(mag)) + 1;
        const [code, len] = DC_CODES.get(cat)!;
        put(code, len);
        if (cat) put(diff > 0 ? diff : diff + (1 << cat) - 1, cat);
        put(0, 1);   // end of block
      }
    }
  }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
  out.push(0xff, 0xd9);
  return new Uint8Array(out);
}
