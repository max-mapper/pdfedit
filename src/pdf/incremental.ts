// Saving: an incremental update appended to the original bytes (ISO 32000-1 §7.5.6), with a cross-reference
// section of the same kind as the original's last one (table §7.5.4, or stream §7.5.8); and a synchronous full save.

import pako from 'pako';
import { PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import { decodeFilters, type DecodeParms } from './filters.ts';
import { Lexer, type Token } from './tokenizer.ts';

export type XrefKind = 'table' | 'stream';

export type OriginalTail = {
  startxref: number; // offset of the original's last cross-reference section
  kind: XrefKind | null; // null when the startxref offset does not point at a cross-reference section
  size: number; // the last section's /Size (0 if unknown)
  encrypted: boolean; // the last trailer has /Encrypt
  /** Why the cross-reference chain cannot be trusted (an offset that does not point at its object, a /Prev that
   *  points nowhere), or null when every section checked out. */
  broken: string | null;
};

export type TrailerInfo = { Root: PDFObject; Info?: PDFObject; ID?: PDFObject };

const enc = new TextEncoder();

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function lastIndexOf(bytes: Uint8Array, needle: string, from = bytes.length - needle.length): number {
  const n = enc.encode(needle);
  outer: for (let i = Math.min(from, bytes.length - n.length); i >= 0; i--) {
    for (let k = 0; k < n.length; k++) if (bytes[i + k] !== n[k]) continue outer;
    return i;
  }
  return -1;
}

function indexOf(bytes: Uint8Array, needle: string, from: number): number {
  const n = enc.encode(needle);
  outer: for (let i = from; i + n.length <= bytes.length; i++) {
    for (let k = 0; k < n.length; k++) if (bytes[i + k] !== n[k]) continue outer;
    return i;
  }
  return -1;
}

function dictGet(d: Token, key: string): Token | undefined {
  if (d.type !== 'dict') return undefined;
  for (let i = 0; i + 1 < d.items.length; i++) {
    const k = d.items[i];
    if (k.type === 'name' && k.value === key) return d.items[i + 1];
  }
  return undefined;
}

/** Reads the original's last startxref and the cross-reference section it points at. */
export function readTail(bytes: Uint8Array): OriginalTail {
  const at = lastIndexOf(bytes, 'startxref');
  if (at < 0) throw new Error('pdfedit: no startxref in the file');
  const lx = new Lexer(bytes, at + 'startxref'.length);
  const t = lx.next();
  if (!t || t.type !== 'number') throw new Error('pdfedit: startxref is not followed by an offset');
  const startxref = t.value;
  const tail: OriginalTail = { startxref, kind: null, size: 0, encrypted: false, broken: null };
  if (startxref < 0 || startxref >= bytes.length) {
    tail.broken = `startxref ${startxref} lies outside the file (${bytes.length} bytes)`;
    return tail;
  }
  const r = readTailSection(bytes, startxref, tail);
  if (r.kind === null) tail.broken = `startxref ${startxref} does not point at a cross-reference section`;
  else tail.broken = checkXrefChain(bytes, startxref);
  return r;
}

function readTailSection(bytes: Uint8Array, startxref: number, tail: OriginalTail): OriginalTail {
  const sx = new Lexer(bytes, startxref);
  sx.skipWhite();
  if (ascii(bytes, sx.pos, sx.pos + 4) === 'xref') {
    const tr = indexOf(bytes, 'trailer', sx.pos);
    if (tr < 0) return tail;
    const d = new Lexer(bytes, tr + 'trailer'.length).next();
    if (!d || d.type !== 'dict') return tail;
    tail.kind = 'table';
    const size = dictGet(d, 'Size');
    tail.size = size?.type === 'number' ? size.value : 0;
    tail.encrypted = dictGet(d, 'Encrypt') !== undefined;
    return tail;
  }
  // n g obj << /Type /XRef … >> stream
  const a = sx.next();
  const b = sx.next();
  const c = sx.next();
  const d = sx.next();
  if (a?.type !== 'number' || b?.type !== 'number' || c?.type !== 'op' || c.value !== 'obj' || d?.type !== 'dict') return tail;
  const type = dictGet(d, 'Type');
  if (type?.type !== 'name' || type.value !== 'XRef') return tail;
  tail.kind = 'stream';
  const size = dictGet(d, 'Size');
  tail.size = size?.type === 'number' ? size.value : 0;
  tail.encrypted = dictGet(d, 'Encrypt') !== undefined;
  return tail;
}

/** Does `n g obj` start at this offset (white space before it allowed)? */
function objectAt(bytes: Uint8Array, offset: number, num: number): boolean {
  if (offset <= 0 || offset >= bytes.length) return false;
  const lx = new Lexer(bytes, offset, Math.min(bytes.length, offset + 64));
  const a = lx.next();
  const b = lx.next();
  const c = lx.next();
  return a?.type === 'number' && a.value === num && b?.type === 'number' && c?.type === 'op' && c.value === 'obj';
}

const numOf = (t: Token | undefined) => (t?.type === 'number' ? t.value : null);

/** The in-use entries (object number → offset) of the section at `at`, its /Prev, or a reason it cannot be read. */
function sectionEntries(bytes: Uint8Array, at: number): { entries: [number, number][]; prev: number | null } | string {
  const lx = new Lexer(bytes, at);
  lx.skipWhite();
  const entries: [number, number][] = [];
  if (ascii(bytes, lx.pos, lx.pos + 4) === 'xref') {
    lx.pos += 4;
    for (let guard = 0; guard < 1_000_000; guard++) {
      const a = lx.next();
      if (!a) return `the cross-reference table at ${at} has no trailer`;
      if (a.type === 'op' && a.value === 'trailer') break;
      const count = lx.next();
      if (a.type !== 'number' || count?.type !== 'number') return `the cross-reference table at ${at} has a bad subsection header`;
      lx.skipWhite();
      for (let k = 0; k < count.value; k++) {
        const line = ascii(bytes, lx.pos, lx.pos + 20);
        const m = /^(\d{10}) (\d{5}) ([nf])/.exec(line);
        if (!m) return `the cross-reference table at ${at} has a malformed entry for object ${a.value + k}`;
        if (m[3] === 'n') entries.push([a.value + k, Number(m[1])]);
        lx.pos += 18;
        lx.skipWhite();
      }
    }
    const d = lx.next();
    if (!d || d.type !== 'dict') return `the trailer after the table at ${at} is not a dictionary`;
    return { entries, prev: numOf(dictGet(d, 'Prev')) };
  }
  // a cross-reference stream: n g obj << … >> stream … endstream
  lx.next();
  lx.next();
  lx.next();
  const d = lx.next();
  if (!d || d.type !== 'dict') return `the object at ${at} is not a cross-reference stream`;
  lx.skipWhite();
  if (ascii(bytes, lx.pos, lx.pos + 6) !== 'stream') return `the cross-reference stream at ${at} has no data`;
  let p = lx.pos + 6;
  if (bytes[p] === 0x0d) p++;
  if (bytes[p] === 0x0a) p++;
  const prev = numOf(dictGet(d, 'Prev'));
  const len = numOf(dictGet(d, 'Length'));
  if (len === null) return { entries: [], prev }; // an indirect /Length: the offsets are not checked here
  const filter = dictGet(d, 'Filter');
  const names = filter?.type === 'name' ? [filter.value] : filter?.type === 'array' ? filter.items.flatMap((x) => (x.type === 'name' ? [x.value] : [])) : [];
  const dp = dictGet(d, 'DecodeParms');
  const parms = (t: Token | undefined): DecodeParms | null => {
    if (t?.type !== 'dict') return null;
    const o: DecodeParms = {};
    for (const k of ['Predictor', 'Colors', 'BitsPerComponent', 'Columns', 'EarlyChange'] as const) {
      const v = numOf(dictGet(t, k));
      if (v !== null) o[k] = v;
    }
    return o;
  };
  let data: Uint8Array;
  try {
    data = decodeFilters(bytes.subarray(p, p + len), names.map((name, i) => ({ name, parms: parms(dp?.type === 'array' ? dp.items[i] : dp) })), `the cross-reference stream at ${at}`);
  } catch (e) {
    return (e as Error).message;
  }
  const w = dictGet(d, 'W');
  if (w?.type !== 'array' || w.items.length < 3) return `the cross-reference stream at ${at} has no /W`;
  const ws = w.items.map((x) => numOf(x) ?? 0);
  const size = numOf(dictGet(d, 'Size')) ?? 0;
  const idx = dictGet(d, 'Index');
  const index = idx?.type === 'array' ? idx.items.map((x) => numOf(x) ?? 0) : [0, size];
  let r = 0;
  const field = (width: number, dflt: number) => {
    if (width === 0) return dflt;
    let v = 0;
    for (let k = 0; k < width; k++) v = v * 256 + (data[r++] ?? 0);
    return v;
  };
  for (let s = 0; s + 1 < index.length; s += 2) {
    for (let k = 0; k < index[s + 1] && r < data.length; k++) {
      const t = field(ws[0], 1);
      const f2 = field(ws[1], 0);
      field(ws[2], 0);
      if (t === 1) entries.push([index[s] + k, f2]);
    }
  }
  return { entries, prev };
}

/**
 * Walks the cross-reference chain from `startxref` through /Prev (at most 64 sections) and checks that every in-use
 * entry points at its object. Returns the first problem found, or null.
 */
export function checkXrefChain(bytes: Uint8Array, startxref: number): string | null {
  const seen = new Set<number>();
  for (let at: number | null = startxref, n = 0; at !== null && n < 64; n++) {
    if (seen.has(at)) return `the cross-reference chain loops back to ${at}`;
    seen.add(at);
    if (at < 0 || at >= bytes.length) return `a /Prev offset (${at}) lies outside the file`;
    const sec = sectionEntries(bytes, at);
    if (typeof sec === 'string') return sec;
    for (const [num, off] of sec.entries) {
      if (num === 0) continue;
      if (!objectAt(bytes, off, num)) return `the cross-reference section at ${at} says object ${num} is at ${off}, but it is not there`;
    }
    at = sec.prev;
  }
  return null;
}

/** `n g obj\n<object>\nendobj\n` with pdf-lib's serialisation of the object. */
export function serializeIndirect(ref: PDFRef, obj: PDFObject): Uint8Array {
  const head = enc.encode(`${ref.objectNumber} ${ref.generationNumber} obj\n`);
  const foot = enc.encode('\nendobj\n');
  const size = obj.sizeInBytes();
  const out = new Uint8Array(head.length + size + foot.length);
  out.set(head, 0);
  const written = obj.copyBytesInto(out, head.length);
  out.set(foot, head.length + written);
  return out.subarray(0, head.length + written + foot.length);
}

class Out {
  chunks: Uint8Array[] = [];
  length = 0;
  push(b: Uint8Array | string): void {
    const u = typeof b === 'string' ? enc.encode(b) : b;
    this.chunks.push(u);
    this.length += u.length;
  }
  bytes(): Uint8Array {
    const r = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      r.set(c, o);
      o += c.length;
    }
    return r;
  }
}

function runs(nums: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const n of nums) {
    const last = out[out.length - 1];
    if (last && last[0] + last[1] === n) last[1]++;
    else out.push([n, 1]);
  }
  return out;
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

function trailerEntries(context: PDFContext, size: number, t: TrailerInfo, prev?: number): string {
  const d = context.obj({ Size: size, Root: t.Root, Info: t.Info, ID: t.ID, Prev: prev });
  return d.toString();
}

/**
 * The original bytes, untouched, followed by the given objects and a cross-reference section of the original's kind
 * whose /Prev points at the original's last one.
 */
export function writeIncremental(
  original: Uint8Array,
  tail: OriginalTail,
  objects: [PDFRef, PDFObject][],
  trailer: TrailerInfo,
  context: PDFContext,
): Uint8Array {
  if (tail.kind === null) {
    throw new Error(
      `pdfedit: the original's startxref (${tail.startxref}) does not point at a cross-reference section; ` +
        'an incremental update would chain to a broken section (use a full save)',
    );
  }
  if (tail.encrypted) throw new Error('pdfedit: encrypted PDFs are not supported');
  const out = new Out();
  out.push(original);
  const lastByte = original[original.length - 1];
  if (lastByte !== 0x0a && lastByte !== 0x0d) out.push('\n');

  const sorted = [...objects].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  const offsets = new Map<number, { offset: number; gen: number }>();
  for (const [ref, obj] of sorted) {
    offsets.set(ref.objectNumber, { offset: out.length, gen: ref.generationNumber });
    out.push(serializeIndirect(ref, obj));
  }
  const maxNum = sorted.length ? sorted[sorted.length - 1][0].objectNumber : 0;

  if (tail.kind === 'table') {
    const size = Math.max(tail.size, context.largestObjectNumber + 1, maxNum + 1);
    const xrefAt = out.length;
    out.push('xref\n');
    for (const [first, count] of runs([...offsets.keys()])) {
      out.push(`${first} ${count}\n`);
      for (let n = first; n < first + count; n++) {
        const e = offsets.get(n)!;
        out.push(`${pad(e.offset, 10)} ${pad(e.gen, 5)} n\r\n`);
      }
    }
    out.push(`trailer\n${trailerEntries(context, size, trailer, tail.startxref)}\nstartxref\n${xrefAt}\n%%EOF\n`);
    return out.bytes();
  }

  // Cross-reference stream: it is an object itself, numbered after everything else, and lists itself.
  const xrefNum = Math.max(tail.size, context.largestObjectNumber + 1, maxNum + 1);
  const size = xrefNum + 1;
  const xrefAt = out.length;
  offsets.set(xrefNum, { offset: xrefAt, gen: 0 });
  const nums = [...offsets.keys()].sort((a, b) => a - b);
  const maxOffset = Math.max(...[...offsets.values()].map((e) => e.offset));
  let ow = 1;
  while (ow < 8 && maxOffset >= 256 ** ow) ow++;
  const rowLen = 1 + ow + 2;
  const data = new Uint8Array(nums.length * rowLen);
  nums.forEach((n, i) => {
    const e = offsets.get(n)!;
    const r = i * rowLen;
    data[r] = 1;
    let v = e.offset;
    for (let k = ow; k >= 1; k--) {
      data[r + k] = v % 256;
      v = Math.floor(v / 256);
    }
    data[r + ow + 1] = (e.gen >> 8) & 0xff;
    data[r + ow + 2] = e.gen & 0xff;
  });
  const index = runs(nums).flat();
  const stream = context.stream(pako.deflate(data), {
    Type: 'XRef',
    Size: size,
    W: [1, ow, 2],
    Index: index,
    Prev: tail.startxref,
    Root: trailer.Root,
    Info: trailer.Info,
    ID: trailer.ID,
    Filter: 'FlateDecode',
  });
  out.push(serializeIndirect(PDFRef.of(xrefNum, 0), stream));
  out.push(`startxref\n${xrefAt}\n%%EOF\n`);
  return out.bytes();
}

/** A complete file: header, every object of the context, a classic table and trailer. Synchronous. */
export function writeFull(original: Uint8Array, context: PDFContext, trailer: TrailerInfo): Uint8Array {
  const m = /%PDF-(\d\.\d)/.exec(ascii(original, 0, 1024));
  const out = new Out();
  out.push(`%PDF-${m ? m[1] : '1.7'}\n`);
  out.push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  const offsets = new Map<number, { offset: number; gen: number }>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    offsets.set(ref.objectNumber, { offset: out.length, gen: ref.generationNumber });
    out.push(serializeIndirect(ref, obj));
  }
  const size = Math.max(context.largestObjectNumber + 1, ...[...offsets.keys()].map((n) => n + 1));
  const xrefAt = out.length;
  out.push('xref\n0 1\n0000000000 65535 f\r\n');
  for (const [first, count] of runs([...offsets.keys()].sort((a, b) => a - b))) {
    out.push(`${first} ${count}\n`);
    for (let n = first; n < first + count; n++) {
      const e = offsets.get(n)!;
      out.push(`${pad(e.offset, 10)} ${pad(e.gen, 5)} n\r\n`);
    }
  }
  out.push(`trailer\n${trailerEntries(context, size, trailer)}\nstartxref\n${xrefAt}\n%%EOF\n`);
  return out.bytes();
}

