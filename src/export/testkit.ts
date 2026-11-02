// Shared by the src/export tests: synthetic documents, a minimal Doc built from PDFium's own reading, and LaidBoxes
// made with src/text directly (the model's layout is not imported). Synthetic text only.

import { openPdfium, type Char, type Rect, type TextObj } from '../engine/pdfium.ts';
import { loadHarfBuzz } from '../text/hb.ts';
import { layoutParagraphs, type Align } from '../text/layout.ts';
import type { Box, Doc, FontRef, LaidBox, Page } from '../model/types.ts';
import { nodeShippedFaces } from './fonts.ts';

export type PageRead = { n: number; w: number; h: number; chars: Char[]; objs: TextObj[] };

/** PDFium's characters and text objects (forms flattened) of every page. */
export async function readPages(bytes: Uint8Array): Promise<PageRead[]> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try {
    const out: PageRead[] = [];
    for (let n = 0; n < doc.pageCount; n++) {
      const pg = doc.page(n);
      const chars = pg.chars();
      out.push({ n, w: pg.size.w, h: pg.size.h, chars, objs: pg.textObjects() });
      pg.close();
    }
    return out;
  } finally {
    doc.close();
  }
}

const union = (rs: Rect[]): Rect => ({
  x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)),
  x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)),
});

/** A box over the given text objects, by their index in PDFium's page.textObjects() (forms flattened, the index
 *  Char.obj and the model's SourceState.objs use), or only some of their characters, by a filter. */
export function boxOf(pr: PageRead, id: string, objs: number[], opts: { edited?: boolean; chars?: (c: Char) => boolean; noChars?: boolean; text?: string } = {}): Box {
  const all = pr.objs;
  const chars = objs.flatMap((t) => all[t].chars).filter((i) => !pr.chars[i].generated && (!opts.chars || opts.chars(pr.chars[i])));
  const frame = union(chars.length ? chars.map((i) => pr.chars[i].loose) : objs.map((t) => all[t].bounds));
  const text = opts.text ?? chars.map((i) => pr.chars[i].unicode).join('');
  const font: FontRef = { source: 'shipped', name: 'NotoSans-Regular', bold: false, italic: false, serif: false };
  return {
    id, kind: 'text', frame, rot: 0, vertical: false,
    paragraphs: [{ runs: [{ text, font, size: 12, color: [0, 0, 0], charSpacing: 0, bold: false, italic: false, underline: false }],
      align: 'left', leading: 1.2, spaceBefore: 0, spaceAfter: 0, indent: 0, bullet: null }],
    source: { frame, paragraphs: [{ text, size: 12, align: 'left', leading: 1.2 }], objs, chars: opts.noChars ? [] : chars },
    edited: opts.edited ?? false, locked: null, heightPinned: false,
  };
}

export function docOf(pages: { pr: PageRead; boxes: Box[] }[]): Doc {
  return { pages: pages.map(({ pr, boxes }): Page => ({ n: pr.n, w: pr.w, h: pr.h, boxes })) };
}

/** Lays `text` out in the box's frame width with src/text and returns it as a LaidBox (line x = frame left, glyph x
 *  from there, baselines in PDF y). */
export async function laidText(box: Box, text: string, opts: { font?: string; size?: number; align?: Align; color?: [number, number, number]; withFace?: boolean } = {}): Promise<LaidBox> {
  await loadHarfBuzz();
  const faces = await sharedFaces();
  const font: FontRef = { source: 'shipped', name: opts.font ?? 'NotoSans-Regular', bold: false, italic: false, serif: false };
  const face = faces(font);
  const size = opts.size ?? 12;
  const color = opts.color ?? [0, 0, 0];
  const width = Math.max(box.frame.x1 - box.frame.x0, 50);
  const layout = layoutParagraphs([{ runs: [{ text, face, size, color }], align: opts.align ?? 'left' }], { width });
  const top = box.frame.y1;
  return {
    box: box.id,
    frame: { x0: box.frame.x0, x1: box.frame.x0 + width, y1: top, y0: top - layout.height },
    height: layout.height,
    overflow: layout.overflow,
    lines: layout.lines.map((l) => ({
      baseline: top - l.baseline, x: box.frame.x0,
      runs: l.runs.map((r) => ({ font, size: r.size, color: r.color, glyphs: r.glyphs, ...(opts.withFace ? { face: r.face } : {}) })),
    })),
  };
}

let faces: ReturnType<typeof nodeShippedFaces> | null = null;
function sharedFaces() {
  faces ??= nodeShippedFaces();
  return faces;
}

export const latin = (b: Uint8Array) => String.fromCharCode(...b);
export const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

// ---------------------------------------------------------------------------------------------------------------
// Form XObjects, encryption, broken files (synthetic)

export type FormSpec = { content: string; matrix?: number[]; bbox?: number[]; uses?: string[] /* forms it paints */ };

/**
 * A PDF whose pages paint Form XObjects. Every page and form has /F1 Helvetica; each page's /XObject lists every
 * form, and each form's own /Resources list the forms named in `uses`. Text only, synthetic.
 */
export async function makeFormPdf(pages: string[], forms: Record<string, FormSpec>): Promise<Uint8Array> {
  const { PDFDocument, PDFName, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const refs: Record<string, import('pdf-lib').PDFRef> = {};
  for (const name of Object.keys(forms)) refs[name] = ctx.nextRef();
  for (const [name, f] of Object.entries(forms)) {
    const xo: Record<string, import('pdf-lib').PDFRef> = {};
    for (const u of f.uses ?? []) xo[u] = refs[u];
    const res = ctx.obj({ Font: { F1: helv.ref }, ...(f.uses?.length ? { XObject: xo } : {}) });
    ctx.assign(refs[name], ctx.flateStream(f.content, {
      Type: 'XObject', Subtype: 'Form', BBox: f.bbox ?? [0, 0, 600, 800], Matrix: f.matrix ?? [1, 0, 0, 1, 0, 0], Resources: res,
    }));
  }
  for (const content of pages) {
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: refs }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  }
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

/** The file encrypted by PDFium (EPDF_SetEncryption, AES-256): an owner password, and a user password when given.
 *  Permissions: print only (no copy, no change). */
export async function encryptWithPdfium(bytes: Uint8Array, owner: string, user = ''): Promise<Uint8Array> {
  const P = await openPdfium();
  const M = P.module as unknown as Record<string, (...a: unknown[]) => number> & { pdfium: { HEAPU8: Uint8Array; wasmExports: { malloc(n: number): number; free(p: number): void } } };
  const raw = M.pdfium;
  const mem = raw.wasmExports.malloc(bytes.length);
  raw.HEAPU8.set(bytes, mem);
  const doc = M.FPDF_LoadMemDocument(mem, bytes.length, '');
  try {
    if (!doc) throw new Error('PDFium could not open the fixture');
    if (!M.EPDF_SetEncryption(doc, user, owner, 0xfffff0c4 | 0)) throw new Error('EPDF_SetEncryption failed');
    const w = M.PDFiumExt_OpenFileWriter();
    if (!M.PDFiumExt_SaveAsCopy(doc, w)) throw new Error('save failed');
    const n = M.PDFiumExt_GetFileWriterSize(w);
    const p = raw.wasmExports.malloc(n);
    M.PDFiumExt_GetFileWriterData(w, p, n);
    const out = raw.HEAPU8.slice(p, p + n);
    raw.wasmExports.free(p);
    M.PDFiumExt_CloseFileWriter(w);
    return out;
  } finally {
    if (doc) M.FPDF_CloseDocument(doc);
    raw.wasmExports.free(mem);
  }
}

/** The file with its last startxref offset moved by `delta` bytes (so it no longer points at the table). */
export function breakStartxref(bytes: Uint8Array, delta = -37): Uint8Array {
  const s = Buffer.from(bytes).toString('latin1');
  const m = /startxref\s+(\d+)(\s+%%EOF\s*)$/.exec(s);
  if (!m) throw new Error('no startxref at the end');
  return new Uint8Array(Buffer.from(s.slice(0, m.index) + `startxref\n${Number(m[1]) + delta}${m[2]}`, 'latin1'));
}
