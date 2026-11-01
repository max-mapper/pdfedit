// Stream filters: each decoder against a known vector and a local encoder, predictors, filter chains on a page's
// content stream (checked against PDFium as an independent decoder), and the refusals. Synthetic data only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import pako from 'pako';
import { PDFDocument, PDFName, type PDFObject } from 'pdf-lib';
import { openPdfium } from '../engine/pdfium.ts';
import { openForEdit } from './edit.ts';
import {
  ascii85Decode, asciiHexDecode, decodeFilters, lzwDecode, runLengthDecode, unpredict, type DecodeParms,
} from './filters.ts';
import { latin1, makePdf, text } from './testing.ts';

// ---------------------------------------------------------------------------------------------------------------
// Encoders (test-only)

const hexEncode = (b: Uint8Array) => latin1(Buffer.from(b).toString('hex').replace(/(.{40})/g, '$1\n') + '>');

function a85Encode(b: Uint8Array): Uint8Array {
  let s = '';
  for (let i = 0; i < b.length; i += 4) {
    const chunk = [b[i], b[i + 1] ?? 0, b[i + 2] ?? 0, b[i + 3] ?? 0];
    const n = Math.min(4, b.length - i);
    let v = ((chunk[0] << 24) | (chunk[1] << 16) | (chunk[2] << 8) | chunk[3]) >>> 0;
    if (v === 0 && n === 4) { s += 'z'; continue; }
    const d: string[] = [];
    for (let k = 0; k < 5; k++) { d.unshift(String.fromCharCode((v % 85) + 33)); v = Math.floor(v / 85); }
    s += d.slice(0, n + 1).join('');
  }
  return latin1(s.replace(/(.{60})/g, '$1\n') + '~>');
}

/** LZW with the same code-width rule as the decoder (the decoder's table lags the encoder's by one entry). */
function lzwEncode(data: Uint8Array, earlyChange = 1): Uint8Array {
  const bits: number[] = [];
  let width = 9;
  const put = (code: number) => { for (let k = width - 1; k >= 0; k--) bits.push((code >> k) & 1); };
  let dict = new Map<string, number>();
  let next = 258;
  const reset = () => { dict = new Map(); for (let k = 0; k < 256; k++) dict.set(String.fromCharCode(k), k); next = 258; width = 9; };
  reset();
  put(256);
  let w = '';
  let emitted = 0; // codes since the last clear
  const grow = (decoderNext: number) => { if (decoderNext + earlyChange >= 1 << width && width < 12) width++; };
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    if (dict.has(w + c)) { w += c; continue; }
    put(dict.get(w)!);
    emitted++;
    if (next < 4096) dict.set(w + c, next++);
    // after the decoder reads this code it has next − 1 entries (none added for the first code after a clear)
    grow(emitted > 1 ? next - 1 + 1 - 1 : 258);
    if (next >= 4096) { put(256); reset(); emitted = 0; }
    w = c;
  }
  if (w) { put(dict.get(w)!); emitted++; grow(emitted > 1 ? next : 258); }
  put(257);
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) for (let k = 0; k < 8; k++) out[i] = (out[i] << 1) | bits[i * 8 + k];
  return out;
}

function rleEncode(b: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < b.length; ) {
    let run = 1;
    while (i + run < b.length && b[i + run] === b[i] && run < 128) run++;
    if (run >= 2) { out.push(257 - run, b[i]); i += run; continue; }
    let lit = 1;
    while (i + lit < b.length && lit < 128 && !(i + lit + 1 < b.length && b[i + lit] === b[i + lit + 1])) lit++;
    out.push(lit - 1, ...b.subarray(i, i + lit));
    i += lit;
  }
  out.push(128);
  return Uint8Array.from(out);
}

/** PNG-predicted rows: each row gets the given filter type (cycled), as an encoder would choose them. */
function pngPredict(b: Uint8Array, columns: number, colors: number, types: number[]): Uint8Array {
  const rowBytes = columns * colors;
  const rows = Math.ceil(b.length / rowBytes);
  const out: number[] = [];
  let prev = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r++) {
    const row = new Uint8Array(rowBytes);
    row.set(b.subarray(r * rowBytes, (r + 1) * rowBytes));
    const t = types[r % types.length];
    out.push(t);
    const len = Math.min(rowBytes, b.length - r * rowBytes); // a short last row stays short
    for (let i = 0; i < len; i++) {
      const left = i >= colors ? row[i - colors] : 0, up = prev[i], ul = i >= colors ? prev[i - colors] : 0;
      let pred = 0;
      if (t === 1) pred = left;
      else if (t === 2) pred = up;
      else if (t === 3) pred = (left + up) >> 1;
      else if (t === 4) { const pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul); pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      out.push((row[i] - pred) & 0xff);
    }
    prev = row;
  }
  return Uint8Array.from(out);
}

function tiffPredict(b: Uint8Array, columns: number, colors: number): Uint8Array {
  const out = new Uint8Array(b);
  const rowBytes = columns * colors;
  for (let r = 0; r * rowBytes < b.length; r++) {
    for (let i = rowBytes - 1; i >= colors; i--) {
      const at = r * rowBytes + i;
      if (at < b.length) out[at] = (b[at] - b[at - colors]) & 0xff;
    }
  }
  return out;
}

const CONTENT = latin1(
  Array.from({ length: 40 }, (_, i) => `BT /F1 10 Tf 72 ${760 - i * 18} Td (Filtered line ${i} of the synthetic page) Tj ET`).join('\n'),
);
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

// ---------------------------------------------------------------------------------------------------------------

test('ASCIIHexDecode: white space, lower and upper case, odd final digit, data after >', () => {
  assert.equal(text(asciiHexDecode(latin1('48 65 6c\n6C 6f>trailing'))), 'Hello');
  assert.deepEqual([...asciiHexDecode(latin1('414>'))], [0x41, 0x40]);
  assert.deepEqual([...asciiHexDecode(latin1('4142'))], [0x41, 0x42]); // no EOD marker
  assert.throws(() => asciiHexDecode(latin1('4G>')), /ASCIIHexDecode found the byte 0x47/);
  assert.ok(same(asciiHexDecode(hexEncode(CONTENT)), CONTENT));
});

test('ASCII85Decode: z, partial groups, <~ prefix, white space', () => {
  assert.equal(text(ascii85Decode(latin1('87cURD]i,"Ebo80~>'))), 'Hello World!'); // a well-known vector
  assert.deepEqual([...ascii85Decode(latin1('z~>'))], [0, 0, 0, 0]);
  assert.equal(text(ascii85Decode(latin1('<~87cURD]i,"Ebo80~>'))), 'Hello World!');
  for (const n of [0, 1, 2, 3, 4, 5, 7, 8]) {
    const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
    assert.ok(same(ascii85Decode(a85Encode(b)), b), `length ${n}`);
  }
  assert.ok(same(ascii85Decode(a85Encode(CONTENT)), CONTENT));
  assert.throws(() => ascii85Decode(latin1('87cUR v~>')), /ASCII85Decode found the byte 0x76/);
});

test('LZWDecode: the spec example, code-width changes, table resets, EarlyChange 0', () => {
  // ISO 32000-1 §7.4.4.2, example: 45 45 45 45 45 65 45 45 45 66
  const spec = Uint8Array.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
  assert.deepEqual([...lzwDecode(spec)], [45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
  // long, varied input: 9 → 12-bit codes and at least one clear
  const big = new Uint8Array(60_000);
  let x = 1;
  for (let i = 0; i < big.length; i++) { x = (x * 1103515245 + 12345) >>> 0; big[i] = i % 3 ? CONTENT[i % CONTENT.length] : (x >>> 24) & 0x3f; }
  for (const early of [1, 0]) {
    assert.ok(same(lzwDecode(lzwEncode(big, early), early), big), `EarlyChange ${early}`);
    assert.ok(same(lzwDecode(lzwEncode(CONTENT, early), early), CONTENT));
  }
});

test('RunLengthDecode: literal and repeated runs, EOD', () => {
  assert.deepEqual([...runLengthDecode(Uint8Array.from([2, 1, 2, 3, 254, 9, 128, 7]))], [1, 2, 3, 9, 9, 9]);
  const b = latin1('aaaaaaaabcdeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeef');
  assert.ok(same(runLengthDecode(rleEncode(b)), b));
  assert.ok(same(runLengthDecode(rleEncode(CONTENT)), CONTENT));
});

test('predictors: PNG None/Sub/Up/Average/Paeth (10–15), TIFF 2, 16-bit and sub-byte TIFF', () => {
  const data = Uint8Array.from({ length: 4 * 30 + 7 }, (_, i) => (i * 13 + (i >> 3) * 7) & 0xff); // last row short
  for (const pred of [10, 11, 12, 13, 14, 15]) {
    const types = pred === 15 ? [0, 1, 2, 3, 4] : [pred - 10];
    const p: DecodeParms = { Predictor: pred, Colors: 2, BitsPerComponent: 8, Columns: 15 };
    assert.ok(same(unpredict(pngPredict(data, 15, 2, types), p), data), `PNG ${pred}`);
  }
  assert.ok(same(unpredict(tiffPredict(data, 10, 3), { Predictor: 2, Colors: 3, Columns: 10 }), data), 'TIFF 8-bit');
  // 16-bit TIFF: samples 0x0102, 0x0304 → stored 0x0102, 0x0202
  assert.deepEqual([...unpredict(Uint8Array.from([1, 2, 2, 2]), { Predictor: 2, Colors: 1, BitsPerComponent: 16, Columns: 2 })], [1, 2, 3, 4]);
  // 4-bit TIFF: samples 1, 2, 3, 4 → differences 1, 1, 1, 1 → bytes 0x11 0x11
  assert.deepEqual([...unpredict(Uint8Array.from([0x11, 0x11]), { Predictor: 2, Colors: 1, BitsPerComponent: 4, Columns: 4 })], [0x12, 0x34]);
  assert.throws(() => unpredict(Uint8Array.from([7, 1, 2]), { Predictor: 12, Columns: 2 }), /filter type 7/);
  assert.throws(() => unpredict(Uint8Array.from([1]), { Predictor: 5 }), /Predictor 5 is not defined/);
});

test('decodeFilters: chains in order, abbreviations, refusals with reasons', () => {
  const flate = pako.deflate(CONTENT);
  assert.ok(same(decodeFilters(a85Encode(flate), [{ name: 'ASCII85Decode' }, { name: 'FlateDecode' }]), CONTENT));
  assert.ok(same(decodeFilters(hexEncode(rleEncode(CONTENT)), [{ name: 'AHx' }, { name: 'RL' }]), CONTENT));
  const png = pako.deflate(pngPredict(CONTENT, 60, 1, [0, 1, 2, 3, 4]));
  assert.ok(same(decodeFilters(png, [{ name: 'Fl', parms: { Predictor: 15, Columns: 60 } }]), CONTENT));
  const lzwPng = lzwEncode(pngPredict(CONTENT, 33, 1, [2]), 0);
  assert.ok(same(decodeFilters(lzwPng, [{ name: 'LZWDecode', parms: { EarlyChange: 0, Predictor: 12, Columns: 33 } }]), CONTENT));
  assert.ok(same(decodeFilters(CONTENT, [{ name: 'Crypt', parms: { Name: 'Identity' } }]), CONTENT));
  for (const f of ['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'DCT']) {
    assert.throws(() => decodeFilters(CONTENT, [{ name: f }], 'content stream 4 0 R'), /4 0 R uses the filter \/\w+ .*image-only filter/);
  }
  assert.throws(() => decodeFilters(CONTENT, [{ name: 'Crypt', parms: { Name: 'StdCF' } }]), /\/Crypt filter \/StdCF.*decryptCopy/);
  assert.throws(() => decodeFilters(CONTENT, [{ name: 'Bogus' }]), /\/Bogus.*supported: \/FlateDecode/);
});

test('a page whose content streams use every filter: our decoding matches PDFium\'s', async () => {
  const base = await makePdf({ content: () => 'BT ET', type0: false });
  const doc = await PDFDocument.load(base, { updateMetadata: false });
  const ctx = doc.context;
  const parts = Array.from({ length: 8 }, (_, k) => latin1(
    Array.from({ length: 5 }, (_, i) => `BT /F1 9 Tf 40 ${780 - (k * 5 + i) * 18} Td (Stream ${k} line ${i} filtered) Tj ET`).join('\n') + '\n',
  ));
  const streams: [Uint8Array, Record<string, PDFObject | string | number | (string | number | Record<string, number>)[]>][] = [
    [hexEncode(parts[0]), { Filter: 'ASCIIHexDecode' }],
    [a85Encode(parts[1]), { Filter: 'ASCII85Decode' }],
    [lzwEncode(parts[2]), { Filter: 'LZWDecode' }],
    [lzwEncode(parts[3], 0), { Filter: 'LZWDecode', DecodeParms: { EarlyChange: 0 } as unknown as PDFObject }],
    [rleEncode(parts[4]), { Filter: 'RunLengthDecode' }],
    [a85Encode(pako.deflate(parts[5])), { Filter: ['ASCII85Decode', 'FlateDecode'] }],
    [pako.deflate(pngPredict(parts[6], 24, 1, [0, 1, 2, 3, 4])), { Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Columns: 24 } as unknown as PDFObject }],
    [hexEncode(lzwEncode(tiffPredict(parts[7], 16, 1))), { Filter: ['ASCIIHexDecode', 'LZWDecode'], DecodeParms: [null as unknown as string, { Predictor: 2, Columns: 16 }] }],
  ];
  const refs = streams.map(([data, dict]) => ctx.register(ctx.stream(data, dict as never)));
  doc.getPage(0).node.set(PDFName.of('Contents'), ctx.obj(refs));
  const bytes = await doc.save({ useObjectStreams: false });

  const e = await openForEdit(bytes);
  const ours = text(e.contents(0));
  for (let k = 0; k < 8; k++) for (let i = 0; i < 5; i++) assert.ok(ours.includes(`(Stream ${k} line ${i} filtered) Tj`), `stream ${k} line ${i}`);
  // predictors pad the last row: what remains after the real content must be NUL padding only
  const P = await openPdfium();
  const pd = P.open(bytes);
  const pg = pd.page(0);
  const objs = pg.textObjects();
  pg.close();
  pd.close();
  assert.equal(objs.length, 40, 'PDFium reads the same 40 text objects from the same streams');
  assert.deepEqual(objs.map((o) => o.text), parts.flatMap((_, k) => Array.from({ length: 5 }, (_, i) => `Stream ${k} line ${i} filtered`)));
});
