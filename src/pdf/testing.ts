// Synthetic fixtures and checks for the src/pdf tests: every PDF is built here with pdf-lib.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import pako from 'pako';
import { PDFDocument, PDFName, StandardFonts, type PDFFont } from 'pdf-lib';
import { Lexer, type Token } from './tokenizer.ts';

export const FONT_DIR = new URL('../../fonts/', import.meta.url);
export const NOTO = new URL('NotoSans-Regular.ttf', FONT_DIR);
export const hasNoto = existsSync(NOTO);

export type FixtureFonts = { hex: (text: string) => string };

/**
 * One- or more-page PDF whose page content is `content(fonts)` verbatim. /F1 is Helvetica (WinAnsi, no /Widths),
 * /F2 Noto Sans as Type0/Identity-H (fonts.hex encodes text as its glyph-id hex string).
 */
export async function makePdf(opts: {
  content: (f: FixtureFonts) => string;
  objectStreams?: boolean;
  pages?: number;
  inheritResources?: boolean;
  type0?: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  let noto: PDFFont | null = null;
  if (opts.type0 !== false && hasNoto) noto = await doc.embedFont(readFileSync(NOTO), { subset: true });
  const fonts: FixtureFonts = {
    hex: (t) => {
      if (!noto) throw new Error('Noto Sans missing: run npm run fonts');
      return noto.encodeText(t).toString();
    },
  };
  const n = opts.pages ?? 1;
  for (let i = 0; i < n; i++) {
    const page = doc.addPage([600, 800]);
    page.node.setFontDictionary(PDFName.of('F1'), helv.ref);
    if (noto) page.node.setFontDictionary(PDFName.of('F2'), noto.ref);
    const content = opts.content(fonts).replaceAll('{page}', String(i + 1));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(content)));
  }
  if (opts.inheritResources) {
    const pagesRef = doc.catalog.get(PDFName.of('Pages'))!;
    const pages = doc.context.lookup(pagesRef) as import('pdf-lib').PDFDict;
    const first = doc.getPage(0).node;
    const res = first.get(PDFName.of('Resources'))!;
    pages.set(PDFName.of('Resources'), doc.context.register(first.context.lookup(res)!));
    for (const p of doc.getPages()) p.node.delete(PDFName.of('Resources'));
  }
  return doc.save({ useObjectStreams: opts.objectStreams ?? false, addDefaultPage: false, updateFieldAppearances: false });
}

let dir: string | null = null;
export function tmpFile(name: string, bytes: Uint8Array): string {
  dir ??= mkdtempSync(join(tmpdir(), 'pdfedit-pdf-'));
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

export const hasPdftotext = spawnSync('pdftotext', ['-v']).status === 0;
export const hasQpdf = spawnSync('qpdf', ['--version']).status === 0;

/** pdftotext's text and stderr (syntax errors poppler had to repair show up there). */
export function pdftotext(bytes: Uint8Array, name = 'x.pdf', page?: number): { text: string; stderr: string } {
  const p = tmpFile(name, bytes);
  const range = page ? ['-f', String(page), '-l', String(page)] : [];
  const r = spawnSync('pdftotext', ['-layout', ...range, p, '-'], { encoding: 'utf8' });
  return { text: r.stdout, stderr: r.stderr };
}

export type WordBox = { word: string; xMin: number; yMin: number; xMax: number; yMax: number };

export function pdfWords(bytes: Uint8Array, name = 'w.pdf'): WordBox[] {
  const p = tmpFile(name, bytes);
  const html = execFileSync('pdftotext', ['-bbox', p, '-'], { encoding: 'utf8' });
  const out: WordBox[] = [];
  for (const m of html.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
    out.push({ word: m[5], xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4] });
  }
  return out;
}

export function qpdfCheck(bytes: Uint8Array, name = 'q.pdf'): { ok: boolean; out: string } {
  const p = tmpFile(name, bytes);
  const r = spawnSync('qpdf', ['--check', p], { encoding: 'utf8' });
  return { ok: r.status === 0, out: r.stdout + r.stderr };
}

const ascii = (b: Uint8Array, s: number, e: number) => String.fromCharCode(...b.subarray(s, Math.min(e, b.length)));

function dictGet(d: Token, key: string): Token | undefined {
  if (d.type !== 'dict') return undefined;
  for (let i = 0; i + 1 < d.items.length; i++) {
    const k = d.items[i];
    if (k.type === 'name' && k.value === key) return d.items[i + 1];
  }
  return undefined;
}

export type XrefSection = { at: number; kind: 'table' | 'stream'; entries: Map<number, number>; prev: number | null; size: number };

/** Reads the cross-reference section at `at` and checks every in-use entry points at "n g obj". */
export function readXrefSection(bytes: Uint8Array, at: number): XrefSection {
  const entries = new Map<number, number>();
  const lx = new Lexer(bytes, at);
  lx.skipWhite();
  let trailer: Token;
  let kind: 'table' | 'stream';
  if (ascii(bytes, lx.pos, lx.pos + 4) === 'xref') {
    kind = 'table';
    lx.pos += 4;
    for (;;) {
      const a = lx.next()!;
      if (a.type === 'op' && a.value === 'trailer') break;
      const count = lx.next()!;
      if (a.type !== 'number' || count.type !== 'number') throw new Error('bad subsection header');
      lx.skipWhite();
      for (let k = 0; k < count.value; k++) {
        const line = ascii(bytes, lx.pos, lx.pos + 20);
        if (!/^\d{10} \d{5} [nf](\r\n| \n| \r)$/.test(line)) throw new Error(`bad xref entry ${JSON.stringify(line)}`);
        if (line[17] === 'n') entries.set(a.value + k, Number(line.slice(0, 10)));
        lx.pos += 20;
      }
    }
    trailer = lx.next()!;
  } else {
    kind = 'stream';
    lx.next();
    lx.next();
    lx.next(); // n g obj
    trailer = lx.next()!;
    lx.skipWhite();
    if (ascii(bytes, lx.pos, lx.pos + 6) !== 'stream') throw new Error('xref stream: no stream keyword');
    let p = lx.pos + 6;
    if (bytes[p] === 0x0d) p++;
    if (bytes[p] === 0x0a) p++;
    const len = dictGet(trailer, 'Length');
    if (len?.type !== 'number') throw new Error('xref stream: /Length must be direct here');
    const data = pako.inflate(bytes.subarray(p, p + len.value));
    const w = dictGet(trailer, 'W');
    if (w?.type !== 'array') throw new Error('xref stream: no /W');
    const ws = w.items.map((x) => (x.type === 'number' ? x.value : 0));
    const sizeT = dictGet(trailer, 'Size');
    const idx = dictGet(trailer, 'Index');
    const index = idx?.type === 'array' ? idx.items.map((x) => (x.type === 'number' ? x.value : 0)) : [0, sizeT?.type === 'number' ? sizeT.value : 0];
    let r = 0;
    const field = (width: number, dflt: number) => {
      if (width === 0) return dflt;
      let v = 0;
      for (let k = 0; k < width; k++) v = v * 256 + data[r++];
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1]; k++) {
        const t = field(ws[0], 1);
        const f2 = field(ws[1], 0);
        field(ws[2], 0);
        if (t === 1) entries.set(index[s] + k, f2);
      }
    }
  }
  for (const [n, off] of entries) {
    const h = new Lexer(bytes, off);
    const a = h.next();
    const b = h.next();
    const c = h.next();
    if (a?.type !== 'number' || a.value !== n || b?.type !== 'number' || c?.type !== 'op' || c.value !== 'obj') {
      throw new Error(`xref entry for object ${n} points at ${off}, which is not "${n} g obj"`);
    }
  }
  const prev = dictGet(trailer, 'Prev');
  const size = dictGet(trailer, 'Size');
  return {
    at,
    kind,
    entries,
    prev: prev?.type === 'number' ? prev.value : null,
    size: size?.type === 'number' ? size.value : 0,
  };
}

export function lastStartxref(bytes: Uint8Array): number {
  const s = ascii(bytes, Math.max(0, bytes.length - 64), bytes.length);
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(s);
  if (!m) throw new Error('no startxref at the end');
  return Number(m[1]);
}

export const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
export const text = (b: Uint8Array) => String.fromCharCode(...b);
