// Reading PNG and JPEG files for placing on a page: their size, resolution and orientation from the headers alone
// (cheap, and enough to refuse a file before decoding it), and the image XObject data the export writes.
//
//   - JPEG goes into the PDF as it is, with /DCTDecode (ISO 32000-1 §7.4.8): the file's bytes are the stream's bytes.
//     Baseline, extended and progressive Huffman-coded files with 8-bit samples and 1, 3 or 4 components are taken;
//     lossless, hierarchical and arithmetic-coded ones are refused (PDF readers need not decode them). A CMYK file with
//     an Adobe APP14 marker stores its inks inverted, so its XObject gets /Decode [1 0 1 0 1 0 1 0] (§8.6.4.4, §8.9.5.2).
//     The Exif orientation (tag 0x0112) is not applied to the samples; the placement matrix turns or mirrors the image
//     instead (imageMatrix in src/objects/place.ts), so the image shows as a browser shows the file.
//   - PNG is decoded (all colour types and bit depths, both interlace methods) and written again with /FlateDecode:
//     grey and grey with alpha as /DeviceGray, truecolour as /DeviceRGB, palette images as /Indexed over /DeviceRGB,
//     8 bits per component (16-bit samples rounded to 8; 1-, 2- and 4-bit grey scaled to 8). Alpha, from an alpha
//     channel or a tRNS chunk, becomes an /SMask (§11.6.5.3) when any pixel is not opaque. Colour profiles and gamma
//     chunks are not read: samples are taken as device RGB or grey.
//
// Units: pixels; resolution in dots per inch (null when the file does not say).
import pako from 'pako';

/**
 * The limits a file must keep. A PNG is decoded and compressed again here: a 4096 × 4096 RGBA PNG took 2.3 s and about
 * 130 MB of memory to prepare (Node 24, measured with a synthetic file). A JPEG is copied as it is, so a larger one is
 * taken: with a 6300 × 6300 JPEG (39.7 million pixels) the export with its checks took 0.6 s and one page render 0.4 s.
 * Every reader of the PDF decodes the whole image each time it draws the page, so the limits stay well below what a
 * PDF allows.
 */
export const IMAGE_LIMITS = {
  /** File size. */
  bytes: 32 * 1024 * 1024,
  /** Width and height, each. */
  side: 12000,
  /** Width × height of a JPEG (not decoded here). */
  jpegPixels: 40e6,
  /** Width × height of a PNG (decoded and compressed again here). */
  pngPixels: 4096 * 4096,
};
/** Why, for the person whose file is refused. */
export const IMAGE_LIMITS_WHY = 'Larger images make the PDF slow to open and to draw; a PNG is also decoded and compressed again here, which takes longer than copying a JPEG.';

/** A file refused, with the reason as a sentence for the person. */
export class ImageRefused extends Error {
  constructor(message: string) { super(message); this.name = 'ImageRefused'; }
}

export type ImageInfo = {
  format: 'png' | 'jpeg';
  /** Stored size in samples. */
  width: number;
  height: number;
  /** Exif orientation 1–8 (1: as stored). PNG: always 1. */
  orientation: number;
  /** Size as shown, after the orientation (sides swapped for 5–8). */
  shownW: number;
  shownH: number;
  /** Resolution the file declares, [x, y] in dots per inch, or null. */
  dpi: [number, number] | null;
  /** Components as stored: 'grey', 'rgb', 'cmyk', 'palette', 'grey+alpha', 'rgb+alpha'. */
  colour: string;
  bits: number;
  /** PNG: an alpha channel or a tRNS chunk (some pixels may be see-through). */
  alpha: boolean;
  /** JPEG: the coding (baseline, extended, progressive); PNG: whether interlaced. */
  coding: string;
};

const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

function sniff(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG' && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function checkSize(info: ImageInfo): ImageInfo {
  const { width: w, height: h } = info;
  const kind = info.format === 'png' ? 'PNG' : 'JPEG';
  if (!(w > 0 && h > 0)) throw new ImageRefused(`The ${kind} file has no size (${w} × ${h} pixels).`);
  if (w > IMAGE_LIMITS.side || h > IMAGE_LIMITS.side) {
    throw new ImageRefused(`The image is ${w} × ${h} pixels; images up to ${IMAGE_LIMITS.side} pixels a side can be added.`);
  }
  const most = info.format === 'png' ? IMAGE_LIMITS.pngPixels : IMAGE_LIMITS.jpegPixels;
  if (w * h > most) {
    const mp = (x: number) => `${(x / 1e6).toFixed(1)} million`;
    throw new ImageRefused(`The ${kind} image has ${mp(w * h)} pixels; ${kind} images up to ${mp(most)} pixels can be added${info.format === 'png' ? ' (a JPEG may be larger)' : ''}.`);
  }
  return info;
}

/** What the file is and how big, from its headers; refuses files over the limits or that cannot be read. */
export function readImageInfo(bytes: Uint8Array): ImageInfo {
  if (bytes.length > IMAGE_LIMITS.bytes) {
    throw new ImageRefused(`The file is ${(bytes.length / 1048576).toFixed(1)} MB; image files up to ${IMAGE_LIMITS.bytes / 1048576} MB can be added.`);
  }
  const kind = sniff(bytes);
  if (kind === 'png') return checkSize(pngInfo(readPngChunks(bytes)));
  if (kind === 'jpeg') return checkSize(readJpeg(bytes).info);
  throw new ImageRefused('Only PNG and JPEG images can be added (this file is neither).');
}

// ── PNG ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type PngChunks = {
  width: number; height: number; depth: number; ctype: number; interlace: number;
  palette: Uint8Array | null; trns: Uint8Array | null; dpi: [number, number] | null; idat: Uint8Array[];
};

const PNG_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_COLOUR: Record<number, string> = { 0: 'grey', 2: 'rgb', 3: 'palette', 4: 'grey+alpha', 6: 'rgb+alpha' };

function readPngChunks(b: Uint8Array): PngChunks {
  const bad = (why: string) => new ImageRefused(`The PNG file cannot be read: ${why}.`);
  let o = 8;
  let head: Omit<PngChunks, 'palette' | 'trns' | 'dpi' | 'idat'> | null = null;
  let palette: Uint8Array | null = null, trns: Uint8Array | null = null, dpi: [number, number] | null = null;
  const idat: Uint8Array[] = [];
  let ended = false;
  while (o + 8 <= b.length) {
    const len = u32(b, o), type = ascii(b, o + 4, 4);
    const data = o + 8;
    if (data + len + 4 > b.length) throw bad(`the ${type} chunk runs past the end of the file`);
    const d = b.subarray(data, data + len);
    if (!head && type !== 'IHDR') throw bad('it does not start with IHDR');
    if (type === 'IHDR') {
      if (len < 13) throw bad('IHDR is too short');
      head = { width: u32(d, 0), height: u32(d, 4), depth: d[8], ctype: d[9], interlace: d[12] };
      if (!PNG_DEPTHS[head.ctype]) throw bad(`colour type ${head.ctype} is not defined`);
      if (!PNG_DEPTHS[head.ctype].includes(head.depth)) throw bad(`bit depth ${head.depth} is not allowed for colour type ${head.ctype}`);
      if (d[10] !== 0 || d[11] !== 0) throw bad('it uses an unknown compression or filter method');
      if (head.interlace > 1) throw bad(`interlace method ${head.interlace} is not defined`);
    } else if (type === 'PLTE') {
      if (len % 3 || len === 0 || len > 768) throw bad('the palette has a wrong length');
      palette = d;
    } else if (type === 'tRNS') {
      trns = d;
    } else if (type === 'pHYs' && len >= 9 && d[8] === 1) {
      const x = u32(d, 0), y = u32(d, 4);   // pixels per metre
      if (x > 0 && y > 0) dpi = [x * 0.0254, y * 0.0254];
    } else if (type === 'IDAT') {
      idat.push(d);
    } else if (type === 'IEND') {
      ended = true;
      break;
    }
    o = data + len + 4;
  }
  if (!head) throw bad('there is no IHDR chunk');
  if (!idat.length) throw bad('there is no image data (IDAT)');
  if (!ended && o < b.length) throw bad('it is cut short');
  if (head.ctype === 3 && !palette) throw bad('a palette image has no PLTE chunk');
  return { ...head, palette, trns, dpi, idat };
}

function pngInfo(c: PngChunks): ImageInfo {
  return {
    format: 'png', width: c.width, height: c.height, orientation: 1, shownW: c.width, shownH: c.height, dpi: c.dpi,
    colour: PNG_COLOUR[c.ctype], bits: c.depth, alpha: c.ctype === 4 || c.ctype === 6 || !!c.trns, coding: c.interlace ? 'interlaced' : 'not interlaced',
  };
}

// Adam7 passes: first column, first row, column step, row step (PNG specification §8.2)
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

type Pass = { x0: number; y0: number; dx: number; dy: number; w: number; h: number; stride: number };
function passesOf(c: PngChunks): Pass[] {
  const bitsPerPixel = PNG_CHANNELS[c.ctype] * c.depth;
  const stride = (w: number) => Math.ceil((w * bitsPerPixel) / 8);
  if (!c.interlace) return [{ x0: 0, y0: 0, dx: 1, dy: 1, w: c.width, h: c.height, stride: stride(c.width) }];
  return ADAM7.map(([x0, y0, dx, dy]) => {
    const w = Math.max(0, Math.ceil((c.width - x0) / dx)), h = Math.max(0, Math.ceil((c.height - y0) / dy));
    return { x0, y0, dx, dy, w, h, stride: stride(w) };
  }).filter((p) => p.w > 0 && p.h > 0);
}

/** The zlib stream of the IDAT chunks inflated into exactly `size` bytes (more or fewer is an error). */
function inflateExact(parts: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let at = 0;
  const over = new ImageRefused('The PNG file cannot be read: it holds more image data than its size says.');
  const inf = new pako.Inflate();
  inf.onData = (chunk: Uint8Array) => {
    if (at + chunk.length > size) throw over;   // stops inflating at once
    out.set(chunk, at);
    at += chunk.length;
  };
  for (let i = 0; i < parts.length; i++) inf.push(parts[i], i === parts.length - 1);
  if (inf.err) throw new ImageRefused(`The PNG file cannot be read: its image data is damaged (${inf.msg || inf.err}).`);
  if (at < size) throw new ImageRefused('The PNG file cannot be read: its image data is cut short.');
  return out;
}

/** Undoes the row filters of one pass in place (PNG specification §9); returns the rows without filter bytes. */
function unfilter(raw: Uint8Array, start: number, p: Pass, bpp: number): Uint8Array {
  const rows = new Uint8Array(p.h * p.stride);
  for (let y = 0; y < p.h; y++) {
    const f = raw[start + y * (p.stride + 1)];
    const src = start + y * (p.stride + 1) + 1;
    const cur = y * p.stride, prev = cur - p.stride;
    for (let i = 0; i < p.stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? rows[cur + i - bpp] : 0;
      const b = y > 0 ? rows[prev + i] : 0;
      const c = y > 0 && i >= bpp ? rows[prev + i - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new ImageRefused(`The PNG file cannot be read: row filter ${f} is not defined.`);
      }
      rows[cur + i] = v & 0xff;
    }
  }
  return rows;
}

export type DecodedPng = {
  width: number; height: number;
  /** 'grey' (1 byte per pixel), 'rgb' (3) or 'palette' (1: the index). */
  space: 'grey' | 'rgb' | 'palette';
  samples: Uint8Array;
  /** The palette as RGB triples (palette images). */
  palette: Uint8Array | null;
  /** One byte per pixel, or null when every pixel is opaque. */
  alpha: Uint8Array | null;
  dpi: [number, number] | null;
};

/** Decodes a PNG to 8-bit samples (grey, RGB or palette indices) and an alpha plane when any pixel is not opaque. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const c = readPngChunks(bytes);
  checkSize(pngInfo(c));
  const { width: W, height: H, depth, ctype } = c;
  const channels = PNG_CHANNELS[ctype];
  const bpp = Math.max(1, Math.ceil((channels * depth) / 8));
  const passes = passesOf(c);
  const raw = inflateExact(c.idat, passes.reduce((s, p) => s + p.h * (p.stride + 1), 0));
  const space: DecodedPng['space'] = ctype === 3 ? 'palette' : ctype === 2 || ctype === 6 ? 'rgb' : 'grey';
  const nc = space === 'rgb' ? 3 : 1;
  const samples = new Uint8Array(W * H * nc);
  const alpha = new Uint8Array(W * H).fill(255);
  let seeThrough = false;
  const max = (1 << depth) - 1;
  const to8 = depth === 16 ? (v: number) => Math.round(v / 257) : depth === 8 ? (v: number) => v : (v: number) => Math.round((v * 255) / max);
  // tRNS: one grey sample, one RGB sample (each 16 bits as stored), or alpha per palette entry
  const keyGrey = ctype === 0 && c.trns && c.trns.length >= 2 ? u16(c.trns, 0) : -1;
  const keyRgb = ctype === 2 && c.trns && c.trns.length >= 6 ? [u16(c.trns, 0), u16(c.trns, 2), u16(c.trns, 4)] : null;
  const palAlpha = ctype === 3 ? c.trns : null;
  const entries = c.palette ? c.palette.length / 3 : 0;
  let start = 0;
  for (const p of passes) {
    const rows = unfilter(raw, start, p, bpp);
    start += p.h * (p.stride + 1);
    for (let y = 0; y < p.h; y++) {
      const row = y * p.stride;
      const Y = p.y0 + y * p.dy;
      for (let x = 0; x < p.w; x++) {
        const X = p.x0 + x * p.dx;
        const at = Y * W + X;
        const s = (k: number): number => {
          const n = x * channels + k;   // sample number in the row
          if (depth === 8) return rows[row + n];
          if (depth === 16) return (rows[row + 2 * n] << 8) | rows[row + 2 * n + 1];
          const bit = n * depth;
          return (rows[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & max;
        };
        let a = 255;
        switch (ctype) {
          case 0: { const g = s(0); samples[at] = to8(g); if (g === keyGrey) a = 0; break; }
          case 2: {
            const r = s(0), g = s(1), b = s(2);
            samples[at * 3] = to8(r); samples[at * 3 + 1] = to8(g); samples[at * 3 + 2] = to8(b);
            if (keyRgb && r === keyRgb[0] && g === keyRgb[1] && b === keyRgb[2]) a = 0;
            break;
          }
          case 3: {
            const i = s(0);
            if (i >= entries) throw new ImageRefused(`The PNG file cannot be read: palette index ${i} is past the palette's ${entries} entries.`);
            samples[at] = i;
            if (palAlpha && i < palAlpha.length) a = palAlpha[i];
            break;
          }
          case 4: samples[at] = to8(s(0)); a = to8(s(1)); break;
          case 6: samples[at * 3] = to8(s(0)); samples[at * 3 + 1] = to8(s(1)); samples[at * 3 + 2] = to8(s(2)); a = to8(s(3)); break;
        }
        if (a !== 255) { alpha[at] = a; seeThrough = true; }
      }
    }
  }
  return { width: W, height: H, space, samples, palette: ctype === 3 ? c.palette!.slice() : null, alpha: seeThrough ? alpha : null, dpi: c.dpi };
}

// ── JPEG ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Jpeg = { info: ImageInfo; adobe: boolean };

const SOF_TAKEN: Record<number, string> = { 0xc0: 'baseline', 0xc1: 'extended', 0xc2: 'progressive' };
const SOF_REFUSED: Record<number, string> = {
  0xc3: 'lossless', 0xc5: 'hierarchical', 0xc6: 'hierarchical', 0xc7: 'hierarchical lossless',
  0xc9: 'arithmetic-coded', 0xca: 'arithmetic-coded progressive', 0xcb: 'arithmetic-coded lossless',
  0xcd: 'arithmetic-coded hierarchical', 0xce: 'arithmetic-coded hierarchical', 0xcf: 'arithmetic-coded hierarchical lossless',
};

/** The Exif orientation in an APP1 payload (after "Exif\0\0"), or 1. */
function exifOrientation(d: Uint8Array): number {
  if (d.length < 14) return 1;
  const t = 6;   // the TIFF header
  const le = d[t] === 0x49 && d[t + 1] === 0x49;
  if (!le && !(d[t] === 0x4d && d[t + 1] === 0x4d)) return 1;
  const r16 = (o: number) => (le ? d[o] | (d[o + 1] << 8) : u16(d, o));
  const r32 = (o: number) => (le ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 2 ** 24 : u32(d, o));
  const ifd = t + r32(t + 4);
  if (ifd + 2 > d.length) return 1;
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > d.length) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function readJpeg(b: Uint8Array): Jpeg {
  const bad = (why: string) => new ImageRefused(`The JPEG file cannot be read: ${why}.`);
  let o = 2;
  let orientation = 1, adobe = false;
  let dpi: [number, number] | null = null;
  let frame: { coding: string; bits: number; height: number; width: number; comps: number } | null = null;
  while (o < b.length) {
    if (b[o] !== 0xff) throw bad(`there is no marker at byte ${o}`);
    while (o < b.length && b[o] === 0xff) o++;   // fill bytes
    const m = b[o++];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) continue;   // markers without a length
    if (m === 0xd9 || m === 0xda) break;   // the end, or the first scan: every header that matters comes before it
    if (o + 2 > b.length) throw bad('a marker runs past the end of the file');
    const len = u16(b, o);
    if (len < 2 || o + len > b.length) throw bad('a marker runs past the end of the file');
    const d = b.subarray(o + 2, o + len);
    if (SOF_TAKEN[m] || SOF_REFUSED[m]) {
      if (SOF_REFUSED[m]) throw new ImageRefused(`The JPEG file is ${SOF_REFUSED[m]}; only baseline and progressive JPEG images can be added.`);
      if (d.length < 6) throw bad('its frame header is too short');
      frame = { coding: SOF_TAKEN[m], bits: d[0], height: u16(d, 1), width: u16(d, 3), comps: d[5] };
    } else if (m === 0xe0 && d.length >= 12 && ascii(d, 0, 5) === 'JFIF\0') {
      const units = d[7], x = u16(d, 8), y = u16(d, 10);
      if (x > 0 && y > 0 && (units === 1 || units === 2)) dpi = units === 1 ? [x, y] : [x * 2.54, y * 2.54];
    } else if (m === 0xe1 && d.length >= 6 && ascii(d, 0, 6) === 'Exif\0\0') {
      orientation = exifOrientation(d);
    } else if (m === 0xee && d.length >= 5 && ascii(d, 0, 5) === 'Adobe') {
      adobe = true;
    }
    o += len;
  }
  if (!frame) throw bad('there is no frame header (SOF) before the image data');
  if (frame.bits !== 8) throw new ImageRefused(`The JPEG file has ${frame.bits}-bit samples; only 8-bit JPEG images can be added.`);
  if (![1, 3, 4].includes(frame.comps)) throw new ImageRefused(`The JPEG file has ${frame.comps} colour components; JPEG images with 1, 3 or 4 can be added.`);
  if (!frame.height) throw new ImageRefused('The JPEG file gives its height after the image data (DNL); such files cannot be added.');
  const swap = orientation >= 5;
  return {
    adobe,
    info: {
      format: 'jpeg', width: frame.width, height: frame.height, orientation, shownW: swap ? frame.height : frame.width, shownH: swap ? frame.width : frame.height,
      dpi: dpi && swap ? [dpi[1], dpi[0]] : dpi, colour: frame.comps === 1 ? 'grey' : frame.comps === 3 ? 'rgb' : 'cmyk', bits: 8, alpha: false, coding: frame.coding,
    },
  };
}

// ── XObject data ────────────────────────────────────────────────────────────────────────────────────────────────

/** A PDF value for an image dictionary: numbers, names (`/Name`), arrays, or a hex string (`<…>` bytes). */
export type DictValue = number | string | DictValue[] | { hex: Uint8Array };
/** An image XObject's dictionary entries (without /Type, /Subtype, /Length) and its stream bytes as written. */
export type XImage = { dict: Record<string, DictValue>; data: Uint8Array };
export type PreparedImage = { info: ImageInfo; image: XImage; smask: XImage | null };

/** The XObject data for a PNG or JPEG file (refused files throw ImageRefused). */
export function prepareImage(bytes: Uint8Array): PreparedImage {
  const info = readImageInfo(bytes);
  if (info.format === 'jpeg') {
    const { adobe } = readJpeg(bytes);
    const space = info.colour === 'grey' ? '/DeviceGray' : info.colour === 'rgb' ? '/DeviceRGB' : '/DeviceCMYK';
    const dict: Record<string, DictValue> = { Width: info.width, Height: info.height, ColorSpace: space, BitsPerComponent: 8, Filter: '/DCTDecode' };
    if (info.colour === 'cmyk' && adobe) dict.Decode = [1, 0, 1, 0, 1, 0, 1, 0];
    return { info, image: { dict, data: bytes }, smask: null };
  }
  const png = decodePng(bytes);
  const space: DictValue = png.space === 'grey' ? '/DeviceGray' : png.space === 'rgb' ? '/DeviceRGB'
    : ['/Indexed', '/DeviceRGB', png.palette!.length / 3 - 1, { hex: png.palette! }];
  const image: XImage = {
    dict: { Width: png.width, Height: png.height, ColorSpace: space, BitsPerComponent: 8, Filter: '/FlateDecode' },
    data: pako.deflate(png.samples),
  };
  const smask: XImage | null = png.alpha
    ? { dict: { Width: png.width, Height: png.height, ColorSpace: '/DeviceGray', BitsPerComponent: 8, Filter: '/FlateDecode' }, data: pako.deflate(png.alpha) }
    : null;
  return { info, image, smask };
}
