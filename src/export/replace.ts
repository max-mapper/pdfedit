// Headless text replacement: the same engine the browser editor uses, in Node. Open → detect → model → replace the
// paragraphs a table names (exact matches) → export (surgery, subset faces, incremental save) → verify. A replaced
// paragraph is set in its own box, as the editor sets typed text: nothing moves or shrinks to make room, so a longer
// text may overflow its box (listed in `overflow`).
import { prepareSubstitutes, type SubstitutionRow } from '../fonts/apply.ts';
import { openPdfium, type Pdfium } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { buildPageFrom, readPage } from '../model/build.ts';
import { loadFonts, type FontRegistry } from '../model/fonts.ts';
import { layoutBox } from '../model/layout.ts';
import { Editor } from '../model/edit.ts';
import type { Doc, Page } from '../model/types.ts';
import { exportDoc, type ExportReport } from './export.ts';

export type ReplaceOptions = {
  pages?: number[];            // 0-based; default every page
  incremental?: boolean;       // default true
  verify?: boolean | 'report'; // default true
  pdfium?: Pdfium;
  fonts?: FontRegistry;
  /** Set edited text in the catalogue face matched to each document font (src/fonts/apply.ts), default true;
   *  false keeps the generic Noto faces. */
  substitute?: boolean;
  /** Pixels allowed to differ outside the edited regions at the check's 1.5× render, default 250. */
  maxPixelsOutside?: number;
};

export type ReplaceResult = {
  bytes: Uint8Array | null;    // null when nothing was replaced
  doc: Doc;
  replaced: { page: number; box: string; para: number }[];
  overflow: { page: number; box: string }[];
  substitutions: SubstitutionRow[];
  export: ExportReport | null;
  stats: { pages: number; boxes: number; edited: number; locked: number; ms: { read: number; export: number } };
};

/** Replaces every paragraph whose text is a key of `table` with its value, and exports the result. */
export async function replaceText(original: Uint8Array, table: Record<string, string>, opts: ReplaceOptions = {}): Promise<ReplaceResult> {
  const P = opts.pdfium ?? await openPdfium();
  const fonts = opts.fonts ?? await loadFonts();
  const t0 = performance.now();
  const pdf = P.open(original);
  const pageIdx = (opts.pages ?? [...Array(pdf.pageCount).keys()]).filter((i) => i >= 0 && i < pdf.pageCount);
  const doc: Doc = { pages: new Array<Page>(pdf.pageCount) };
  for (const i of pageIdx) {
    const pg = pdf.page(i);
    try {
      const input = readPage(pg);
      doc.pages[i] = buildPageFrom(i, input, detectBoxes(input));
    } finally { pg.close(); }
  }
  pdf.close();
  // pages not read stay as empty pages so indices line up for export
  for (let i = 0; i < doc.pages.length; i++) if (!doc.pages[i]) doc.pages[i] = { n: i, w: 0, h: 0, boxes: [] };
  const read = performance.now() - t0;

  const editor = new Editor(doc, fonts);
  const replaced: ReplaceResult['replaced'] = [];
  let boxes = 0, locked = 0;
  const touched = new Set<string>();
  for (const i of pageIdx) {
    for (const b of doc.pages[i].boxes) {
      boxes++;
      if (b.locked) { locked++; continue; }
      b.paragraphs.forEach((p, k) => {
        const text = p.runs.map((r) => r.text).join('');
        const to = Object.hasOwn(table, text) ? table[text] : undefined;
        if (to === undefined || to === text) return;
        editor.setText(i, b.id, k, to);
        replaced.push({ page: i, box: b.id, para: k });
        touched.add(`${i}/${b.id}`);
      });
    }
  }

  const substitutions: SubstitutionRow[] = touched.size && opts.substitute !== false ? await prepareSubstitutes(doc, fonts, { pages: pageIdx }) : [];
  const overflow: ReplaceResult['overflow'] = [];
  for (const key of touched) {
    const [n, id] = [Number(key.slice(0, key.indexOf('/'))), key.slice(key.indexOf('/') + 1)];
    if (editor.laid(n, id).overflow) overflow.push({ page: n, box: id });
  }

  let bytes: Uint8Array | null = null, report: ExportReport | null = null, exportMs = 0;
  if (touched.size) {
    const t1 = performance.now();
    const out = await exportDoc(original, doc, (_n, b) => layoutBox(b, fonts), {
      incremental: opts.incremental ?? true, verify: opts.verify ?? true, pdfium: P, maxPixelsOutside: opts.maxPixelsOutside ?? 250,
    });
    bytes = out.bytes; report = out.report;
    exportMs = performance.now() - t1;
  }
  return {
    bytes, doc, replaced, overflow, substitutions, export: report,
    stats: { pages: pageIdx.length, boxes, edited: touched.size, locked, ms: { read: Math.round(read), export: Math.round(exportMs) } },
  };
}
