// The page object model, read and checked: the content-stream objects (src/objects/read.ts) matched in order, kind by
// kind, to PDFium's own object list (PdfPage.objects()). A text object takes PDFium's bounds (the content stream
// alone cannot measure glyphs without the fonts); other kinds keep their own and are checked against PDFium's. Objects
// PDFium lists but the walk did not find, or the other way round, are reported in `notes`.
import { openPdfium, type EngineObject, type PdfPage, type Pdfium, type Rect } from '../engine/pdfium.ts';
import type { PdfEdit } from '../pdf/edit.ts';
import { openEditable } from '../pdf/editable.ts';
import type { ContentTree } from '../pdf/tree.ts';
import { readObjects } from './read.ts';
import type { PageObject, PageObjects } from './types.ts';

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
function overlap(a: Rect, b: Rect): number {
  const i = area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}
const engineKind = (k: PageObject['kind']): EngineObject['kind'] => (k === 'inline-image' ? 'image' : k);

/** The objects of one page: the content-stream walk matched with PDFium's list (`tree`: the page's content tree, when
 *  the caller has it). */
export function pageObjects(edit: PdfEdit, pg: PdfPage, tree?: ContentTree): PageObjects {
  const view = pg.view;
  const got = readObjects(edit, pg.index, view.crop, tree);
  const engine = pg.objects();
  const notes = [...got.notes];
  // match in order within each kind (both lists are in paint order, forms entered at their Do)
  const queues = new Map<EngineObject['kind'], EngineObject[]>();
  for (const e of engine) { let q = queues.get(e.kind); if (!q) queues.set(e.kind, (q = [])); q.push(e); }
  let unmatched = 0, offBounds = 0;
  for (const o of got.objects) {
    const e = queues.get(engineKind(o.kind))?.shift();
    if (!e) { unmatched++; continue; }
    o.engine = e.index;
    if (o.kind === 'text') o.bounds = { ...e.bounds };
    // PDFium gives a form the union of what it paints, not its /BBox; a shading's bounds are its clips'
    else if (o.kind !== 'shading' && o.kind !== 'form' && overlap(o.bounds, e.bounds) < 0.5 && area(e.bounds) > 0) offBounds++;
  }
  const left = [...queues.values()].reduce((k, q) => k + q.length, 0);
  if (unmatched) notes.push(`${unmatched} object${unmatched === 1 ? '' : 's'} of the content stream not in PDFium's list`);
  if (left) notes.push(`${left} PDFium object${left === 1 ? '' : 's'} not found in the content stream`);
  if (offBounds) notes.push(`${offBounds} object${offBounds === 1 ? '' : 's'} with bounds unlike PDFium's`);
  return { page: pg.index, view, objects: got.objects, clips: [...got.clips.values()], notes };
}

/** Every listed page's objects (all pages by default), from the file's bytes. */
export async function listObjects(bytes: Uint8Array, pages?: number[], opts: { pdfium?: Pdfium } = {}): Promise<PageObjects[]> {
  const P = opts.pdfium ?? (await openPdfium());
  const { edit } = await openEditable(bytes, P); // an owner-password-only file: PDFium's decrypted copy
  const doc = P.open(bytes);
  try {
    const want = pages ?? [...Array(doc.pageCount).keys()];
    return want.filter((n) => n >= 0 && n < doc.pageCount).map((n) => {
      const pg = doc.page(n);
      try { return pageObjects(edit, pg); } finally { pg.close(); }
    });
  } finally { doc.close(); }
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** One object as a line of numbers and names (no text). */
export function objectLine(o: PageObject): string {
  const b = o.bounds;
  const size = `${r1(b.x1 - b.x0)} × ${r1(b.y1 - b.y0)} at ${r1(b.x0)},${r1(b.y0)}`;
  const depth = '  '.repeat(o.path.length);
  const bits = [
    o.name ? `/${o.name}` : '', o.paint ? `paint ${o.paint}` : '', o.pathSegs ? `${o.pathSegs} steps` : '',
    o.pixels ? `${o.pixels[0]}×${o.pixels[1]} px` : '', o.smask ? 'masked' : '', o.chars !== undefined ? `${o.chars} chars` : '',
    o.uses && o.uses > 1 ? `painted ${o.uses}×` : '', o.clips.length ? `clips ${o.clips.join(',')}` : '',
    o.marked.length ? `in ${o.marked.map((m) => m.tag + (m.mcid !== undefined ? `#${m.mcid}` : '')).join('>')}` : '',
    o.group ? 'own q…Q' : '', o.engine === undefined ? 'not in PDFium' : '',
  ].filter(Boolean);
  return `${depth}${String(o.z).padStart(3)} ${o.kind.padEnd(12)} ${o.id.padEnd(10)} ${size}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}
