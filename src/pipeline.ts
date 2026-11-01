// The headless pipeline: the same engine the browser editor uses, in Node, for batch
// work such as the translate-and-fit lane. Open → detect → model → translate each box's paragraphs → fit → export
// (surgery, subset Noto faces, incremental save) → verify.
import { prepareSubstitutes, type SubstitutionRow } from './fonts/apply.ts';
import { openPdfium, type Pdfium } from './engine/pdfium.ts';
import { detectBoxes } from './layout/detect.ts';
import { buildPageFrom, readPage } from './model/build.ts';
import { loadFonts, type FontRegistry } from './model/fonts.ts';
import { layoutBox } from './model/layout.ts';
import { Editor } from './model/edit.ts';
import type { Doc, Page, Box } from './model/types.ts';
import { fitPage, type FitOptions, type FitReport } from './fit/fit.ts';
import { exportDoc, type ExportReport } from './export/export.ts';

/** Translates the paragraphs of one page: Japanese in, English out, same length and order. */
export type Translator = (page: number, paragraphs: string[]) => Promise<string[]>;

/** Targeted shortening (an opt-in last step, listed box by box): a meaning-preserving tighter English for each
 *  item within its character budget, same length and order; an item it cannot shorten comes back unchanged. */
export type Shortener = (page: number, items: { source: string; english: string; maxChars: number }[]) => Promise<string[]>;
/** One shortened paragraph, as the report lists them (never silent). */
export type Shortened = { page: number; box: string; para: number; before: string; after: string; maxChars: number; reason: 'unfit' | 'shrunk' };

export type PipelineOptions = {
  pages?: number[];            // 0-based; default every page
  translate?: Translator;      // without one, nothing is edited (detect and model only)
  fit?: boolean | FitOptions;  // default true
  incremental?: boolean;       // default true
  verify?: boolean | 'report'; // default true
  pdfium?: Pdfium;
  fonts?: FontRegistry;
  needsTranslation?: (text: string) => boolean;   // default: holds Japanese
  /** Vertical boxes: set the translation in vertical columns (Latin sideways), or leave them untranslated.
   *  Default 'sideways'. */
  vertical?: 'sideways' | 'skip';
  /** Pixels allowed to differ outside the edited regions at the check's 1.5× render (antialiased glyph edges that
   *  overhang a laid frame), default 250. */
  maxPixelsOutside?: number;
  /** Targeted shortening after the fit, for boxes that end unfit or under `shortenBelow` of their size (default
   *  0.8); those pages are fitted again with the shorter English. Off without a shortener. */
  shorten?: Shortener;
  shortenBelow?: number;
  /** Set edited text in the catalogue face matched to each document font (src/fonts/apply.ts), default true;
   *  false keeps the generic Noto faces. */
  substitute?: boolean;
};

export type PipelineResult = {
  bytes: Uint8Array | null;    // null when nothing was edited
  doc: Doc;
  fit: FitReport[];
  shortened: Shortened[];
  substitutions: SubstitutionRow[];
  export: ExportReport | null;
  stats: { pages: number; boxes: number; edited: number; locked: number; ms: { read: number; translate: number; fit: number; export: number } };
};

const JA = /[぀-ヿ㐀-鿿]/;

export async function translateAndFit(original: Uint8Array, opts: PipelineOptions = {}): Promise<PipelineResult> {
  const P = opts.pdfium ?? await openPdfium();
  const fonts = opts.fonts ?? await loadFonts();
  const needs = opts.needsTranslation ?? ((t: string) => JA.test(t));
  const ms = { read: 0, translate: 0, fit: 0, export: 0 };
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
  // pages not processed stay as empty pages so indices line up for export
  for (let i = 0; i < doc.pages.length; i++) if (!doc.pages[i]) doc.pages[i] = { n: i, w: 0, h: 0, boxes: [], panels: [], obstacles: [] };
  ms.read = performance.now() - t0;

  const editor = new Editor(doc, fonts);
  let boxes = 0, edited = 0, locked = 0;
  if (opts.translate) {
    const t1 = performance.now();
    for (const i of pageIdx) {
      const page = doc.pages[i];
      const slots: { box: Box; para: number; text: string }[] = [];
      for (const b of page.boxes) {
        boxes++;
        if (b.locked) { locked++; continue; }
        if (b.vertical && opts.vertical === 'skip') { locked++; continue; }
        b.paragraphs.forEach((p, k) => { const text = p.runs.map((r) => r.text).join(''); if (needs(text)) slots.push({ box: b, para: k, text }); });
      }
      if (!slots.length) continue;
      const en = await opts.translate(i, slots.map((s) => s.text));
      if (en.length !== slots.length) throw new Error(`translator returned ${en.length} paragraphs for ${slots.length} on page ${i + 1}`);
      const touched = new Set<string>();
      slots.forEach((s, k) => { if (en[k] && en[k] !== s.text) { editor.setText(i, s.box.id, s.para, en[k]); touched.add(s.box.id); } });
      edited += touched.size;
    }
    ms.translate = performance.now() - t1;
  } else {
    for (const i of pageIdx) for (const b of doc.pages[i].boxes) { boxes++; if (b.locked) locked++; }
  }

  const substitutions: SubstitutionRow[] = edited && opts.substitute !== false ? await prepareSubstitutes(doc, fonts, { pages: pageIdx }) : [];
  const fit: FitReport[] = [];
  const shortened: Shortened[] = [];
  if (opts.fit !== false && edited) {
    const t2 = performance.now();
    const fo = typeof opts.fit === 'object' ? opts.fit : {};
    for (const i of pageIdx) {
      if (!doc.pages[i].boxes.some((b) => b.edited)) continue;
      const page = doc.pages[i];
      const before = opts.shorten ? structuredClone(page.boxes.map((b) => ({ id: b.id, frame: b.frame, paragraphs: b.paragraphs, heightPinned: b.heightPinned }))) : null;
      let rep = fitPage(page, (b) => layoutBox(b, fonts), fo);
      if (opts.shorten && before) {
        const below = opts.shortenBelow ?? 0.8;
        const targets = rep.boxes.filter((r) => r.result === 'unfit' || r.scale < below - 1e-9);
        const items: { box: Box; para: number; source: string; english: string; maxChars: number; reason: Shortened['reason'] }[] = [];
        for (const t of targets) {
          const b = page.boxes.find((x) => x.id === t.box);
          const src = before.find((x) => x.id === t.box);
          if (!b || !src) continue;
          const en = src.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));
          const total = en.reduce((n, x) => n + [...x].length, 0);
          // the share of the English that fits at a readable size: what fitted at the scale reached, then the
          // area ratio from that scale up to 0.85 (unfit) or 0.9 (shrunk); never under half the length
          const fitted = t.result === 'unfit' ? Math.max(0, total - t.charsOver) / Math.max(1, total) : 1;
          const factor = Math.min(0.95, Math.max(0.5, fitted * (t.scale / (t.result === 'unfit' ? 0.85 : 0.9)) ** 2));
          en.forEach((e, k) => {
            const source = b.source.paragraphs[k]?.text ?? '';
            if (!source || !JA.test(source) || [...e].length < 12) return;
            items.push({ box: b, para: k, source, english: e, maxChars: Math.max(8, Math.floor([...e].length * factor)), reason: t.result === 'unfit' ? 'unfit' : 'shrunk' });
          });
        }
        if (items.length) {
          const out = await opts.shorten(i, items.map(({ source, english, maxChars }) => ({ source, english, maxChars })));
          // back to the page as it was before the fit, the shorter English in, then fit again
          for (const s0 of before) {
            const b = page.boxes.find((x) => x.id === s0.id);
            if (b) { b.frame = s0.frame; b.paragraphs = structuredClone(s0.paragraphs); b.heightPinned = s0.heightPinned; }
          }
          items.forEach((it, k) => {
            const after = out[k];
            if (!after || after === it.english || [...after].length >= [...it.english].length) return;
            editor.setText(i, it.box.id, it.para, after);
            shortened.push({ page: i, box: it.box.id, para: it.para, before: it.english, after, maxChars: it.maxChars, reason: it.reason });
          });
          rep = fitPage(page, (b) => layoutBox(b, fonts), fo);
        }
      }
      fit.push(rep);
    }
    ms.fit = performance.now() - t2;
  }

  let bytes: Uint8Array | null = null, report: ExportReport | null = null;
  if (edited) {
    const t3 = performance.now();
    const out = await exportDoc(original, doc, (_n, b) => layoutBox(b, fonts), { incremental: opts.incremental ?? true, verify: opts.verify ?? true, pdfium: P, maxPixelsOutside: opts.maxPixelsOutside ?? 250 });
    bytes = out.bytes; report = out.report;
    ms.export = performance.now() - t3;
  }
  return { bytes, doc, fit, shortened, substitutions, export: report, stats: { pages: pageIdx.length, boxes, edited, locked, ms: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])) as PipelineResult['stats']['ms'] } };
}

/** A shortener that runs a command: stdin {"items": [{source, english, max_chars}]}, stdout {"items": [english]}
 *  (the demo's shorten-boxes.py speaks this). */
export function commandShortener(cmd: string, args: string[] = []): Shortener {
  return async (page, items) => {
    if (!items.length) return [];
    const { spawnSync } = await import('node:child_process');   // Node only: the pipeline also runs in browsers
    const r = spawnSync(cmd, args, { input: JSON.stringify({ tag: `pdfedit-shorten:p${page}`, items: items.map((x) => ({ source: x.source, english: x.english, max_chars: x.maxChars })) }), maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`shortener failed: ${String(r.stderr).slice(0, 300)}`);
    const got = JSON.parse(String(r.stdout)) as { items: string[] };
    if (!Array.isArray(got.items) || got.items.length !== items.length) throw new Error(`shortener returned ${got.items?.length} items for ${items.length}`);
    return got.items;
  };
}

/** A translator that runs a command: stdin {"pages": {"<n>": [texts]}}, stdout the same shape with English
 *  (any translator script that reads and writes this shape). */
export function commandTranslator(cmd: string, args: string[] = []): Translator {
  return async (page, paragraphs) => {
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(cmd, args, { input: JSON.stringify({ pages: { [page]: paragraphs } }), maxBuffer: 1 << 28 });
    if (r.status !== 0) throw new Error(`translator failed: ${String(r.stderr).slice(-400)}`);
    const out = JSON.parse(String(r.stdout)).pages[page] as string[];
    return out;
  };
}

/** A translator from a fixed table (tests, replays): exact matches only, others unchanged. */
export function tableTranslator(table: Record<string, string>): Translator {
  return async (_page, paragraphs) => paragraphs.map((p) => table[p] ?? p);
}
