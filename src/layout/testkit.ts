// Synthetic test pages for the layout tests: pdf-lib draws Helvetica text, rectangles and rules; the text layer
// (HarfBuzz + FontWriter) sets Noto Sans / Noto Sans JP, horizontally (Identity-H) or vertically (Identity-V).
// The PDF is read back with the engine, so the detector sees exactly what it sees on a real page. Synthetic only.

import { PDFDocument, PDFDict, PDFName, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import { openPdfium } from '../engine/pdfium.ts';
import { FontWriter, hex4 } from '../text/font-writer.ts';
import { shape } from '../text/shape.ts';
import { fontBytes, testFaces } from '../text/testkit.ts';
import type { Face } from '../text/face.ts';
import { loadFace } from '../text/face.ts';
import type { PageInput } from './types.ts';

export type RGB = [number, number, number];
export type DrawOp =
  | { t: 'text'; text: string; x: number; y: number; size: number; font?: 'helv' | 'helvB'; rotate?: number; color?: RGB }
  /** Set by the text layer: one text object per call, glyphs at their font advances (plus `spacing` points). */
  | { t: 'set'; text: string; x: number; y: number; size: number; face: 'sans' | 'ja'; spacing?: number }
  /** Vertical writing (Identity-V): one text object, glyphs stacked downward from (x, yTop). */
  | { t: 'vtext'; text: string; x: number; yTop: number; size: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; fill?: RGB; stroke?: RGB; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; lw?: number }
  | { t: 'image'; x: number; y: number; w: number; h: number };

// A 1×1 grey PNG.
const PNG_1PX = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

let verticalFace: Face | null = null;

export async function buildPdf(ops: DrawOp[], size: [number, number] = [595, 842]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage(size);
  const fonts: Record<string, PDFFont> = {};
  const F = ops.some((o) => o.t === 'set' || o.t === 'vtext') ? await testFaces() : null;
  // FontWriter makes one font per face, so vertical text needs a face of its own to get an Identity-V font
  verticalFace ??= F ? loadFace(fontBytes('NotoSansJP-VF.ttf'), { variations: { wght: 400 } }) : null;
  const writer = new FontWriter(doc.context, { prefix: 'LT' });
  const raw: string[] = [];
  const verticalKeys = new Set<string>();
  for (const op of ops) {
    if (op.t === 'text') {
      const name = op.font ?? 'helv';
      fonts[name] ??= await doc.embedFont(name === 'helvB' ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
      page.drawText(op.text, { x: op.x, y: op.y, size: op.size, font: fonts[name], rotate: op.rotate ? degrees(op.rotate) : undefined,
        color: op.color ? rgb(...op.color) : undefined });
    } else if (op.t === 'set' || op.t === 'vtext') {
      const face: Face = op.t === 'vtext' ? verticalFace! : op.face === 'sans' ? F!.sans : F!.ja;
      const glyphs = shape(face, op.text);
      const cps = [...op.text];
      // one glyph per character in these fixtures (no ligatures in the strings used)
      const used = glyphs.map((g, k) => ({ gid: g.gid, text: cps[k] ?? '' }));
      const key = writer.use(face, used);
      if (op.t === 'vtext') {
        verticalKeys.add(key);
        raw.push(`BT /${key} ${op.size} Tf 1 0 0 1 ${op.x} ${op.yTop} Tm <${used.map((g) => hex4(g.gid)).join('')}> Tj ET`);
      } else {
        const sp = op.spacing ?? 0;
        const parts = used.map((g, k) => (k && sp ? `${(-sp * 1000) / op.size} <${hex4(g.gid)}>` : `<${hex4(g.gid)}>`));
        raw.push(`BT /${key} ${op.size} Tf 1 0 0 1 ${op.x} ${op.y} Tm [${parts.join(' ')}] TJ ET`);
      }
    } else if (op.t === 'rect') {
      page.drawRectangle({ x: op.x, y: op.y, width: op.w, height: op.h, color: op.fill ? rgb(...op.fill) : undefined,
        borderColor: op.stroke ? rgb(...op.stroke) : undefined, borderWidth: op.stroke ? (op.lw ?? 1) : 0 });
    } else if (op.t === 'line') {
      page.drawLine({ start: { x: op.x1, y: op.y1 }, end: { x: op.x2, y: op.y2 }, thickness: op.lw ?? 0.75, color: rgb(0, 0, 0) });
    } else if (op.t === 'image') {
      const img = await doc.embedPng(PNG_1PX);
      page.drawImage(img, { x: op.x, y: op.y, width: op.w, height: op.h });
    }
  }
  if (raw.length) {
    const refs = writer.finish();
    for (const [k, ref] of Object.entries(refs)) {
      if (verticalKeys.has(k)) doc.context.lookup(ref, PDFDict).set(PDFName.of('Encoding'), PDFName.of('Identity-V'));
      page.node.setFontDictionary(PDFName.of(k), ref);
    }
    page.node.addContentStream(doc.context.register(doc.context.flateStream(new TextEncoder().encode(raw.join('\n') + '\n'))));
  }
  return doc.save({ useObjectStreams: false });
}

/** Builds the page and reads it back with the engine. */
export async function buildPage(ops: DrawOp[], size: [number, number] = [595, 842]): Promise<PageInput> {
  const P = await openPdfium();
  const doc = P.open(await buildPdf(ops, size));
  try {
    const page = doc.page(0);
    const input: PageInput = { w: page.size.w, h: page.size.h, chars: page.chars(), textObjects: page.textObjects(), shapes: page.shapes() };
    page.close();
    return input;
  } finally { doc.close(); }
}

let helv: { regular: PDFFont; bold: PDFFont } | null = null;
/** Width of a string in Helvetica (or Helvetica-Bold) at a size, for laying out synthetic paragraphs. */
export async function helveticaWidth(): Promise<(s: string, size: number, bold?: boolean) => number> {
  if (!helv) {
    const doc = await PDFDocument.create();
    helv = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold) };
  }
  const h = helv;
  return (s, size, bold = false) => (bold ? h.bold : h.regular).widthOfTextAtSize(s, size);
}

/** Greedy word wrap into lines no wider than `width`. */
export function wrap(text: string, width: number, measure: (s: string) => number, firstIndent = 0): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && measure(next) > width - (out.length ? 0 : firstIndent)) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/** Draw ops for a paragraph: ragged left (one text object per line) or justified (one object per word). */
export function paragraphOps(lines: string[], o: { x: number; y: number; size: number; leading: number; width: number;
  indent?: number; justify?: boolean; measure: (s: string) => number; font?: 'helv' | 'helvB' }): DrawOp[] {
  const ops: DrawOp[] = [];
  for (const [k, line] of lines.entries()) {
    const x = o.x + (k === 0 ? (o.indent ?? 0) : 0), y = o.y - k * o.leading;
    const words = line.split(' ');
    if (!o.justify || k === lines.length - 1 || words.length < 2) { ops.push({ t: 'text', text: line, x, y, size: o.size, font: o.font }); continue; }
    const avail = o.width - (k === 0 ? (o.indent ?? 0) : 0);
    const inkW = words.reduce((n, w) => n + o.measure(w), 0);
    const gap = (avail - inkW) / (words.length - 1);
    let cx = x;
    for (const w of words) { ops.push({ t: 'text', text: w, x: cx, y, size: o.size, font: o.font }); cx += o.measure(w) + gap; }
  }
  return ops;
}

export const BLUE: RGB = [0.1, 0.3, 0.8];

/** A 3-item list: blue bullet + bold title, regular description below, all at one leading. */
export function bulletListOps(x = 72, y = 700, lead = 14): DrawOp[] {
  const items = [
    ['Speed of delivery', 'Orders leave the warehouse within one working day.'],
    ['Careful packaging', 'Every parcel is checked and packed by hand before it ships.'],
    ['Friendly support', 'Questions are answered by people who know the product well.'],
  ];
  const ops: DrawOp[] = [];
  for (const [title, desc] of items) {
    ops.push({ t: 'text', text: '•', x, y, size: 10, color: BLUE });
    ops.push({ t: 'text', text: title, x: x + 12, y, size: 10, font: 'helvB' });
    y -= lead;
    ops.push({ t: 'text', text: desc, x: x + 12, y, size: 10 });
    y -= lead;
  }
  return ops;
}
