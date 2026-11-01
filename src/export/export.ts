// Export: write edited boxes back into the PDF as real text.
//
// Per page with edited boxes:
//   0. input: an encrypted file (owner password only) is edited as PDFium's decrypted copy, and a file whose
//      cross-reference chain is broken (or that pdf-lib cannot parse) as PDFium's repaired copy; both are written
//      with a full save, and the output is not encrypted (re-encryption is not done);
//   1. removal by surgery: each box's source text objects (indices into PDFium's page.textObjects(), forms flattened)
//      are mapped to the non-empty text-showing operators of the page's content tree (src/pdf/tree.ts: the page's
//      stream with every Form XObject entered at its Do, the order PDFium flattens them in): the n-th operator is the
//      n-th text object. When the counts differ, objects are matched by decoded text and position
//      (src/pdf/match.ts). The operators are blanked with blankOut; inside a form, in the form's stream, the form
//      copied first when it is painted more than once (src/pdf/tree.ts commitForms). FPDFPage_GenerateContent is
//      never used. An operator that also shows characters of boxes not being written (a "mixed" operator) is split:
//      blanked, and those characters re-emitted in the appended stream with the document's own font resource, size
//      and colour, each at PDFium's character origin;
//   2. new text: the LaidBox's glyphs, set with one FontWriter per document (shipped Noto faces, subset with glyph IDs
//      kept, Type0/Identity-H, ToUnicode) and emit(), appended with appendContent (the original wrapped in q…Q), in
//      page space, also for text that was inside a form;
//   3. tagged PDF: if the removed operators sat in a marked-content sequence with an MCID, the new text is wrapped in
//      the same tag with the same MCID (and /ActualText when the source had one); the original sequence's BDC loses
//      its MCID when nothing else is left in it, so the MCID stays unique on the page. Text that was an /Artifact
//      stays one. The structure tree is not touched;
//   4. save: incremental by default (the original bytes are a prefix), full on request (and for decrypted or
//      repaired input);
//   5. verification: the output is re-opened in PDFium; each written box's new text must extract inside its frame
//      (the whole page's text as a fallback) and its old text be gone; pixels outside the edited regions must not
//      change; every page must open and render.

import pako from 'pako';
import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib';
import { openPdfium, PdfiumOpenError, type Char, type Pdfium, type Rect, type TextObj } from '../engine/pdfium.ts';
import { diffOutside } from '../engine/diff.ts';
import { openForEdit, type PdfEdit } from '../pdf/edit.ts';
import { inheritedResources, lookupByName, resolve, type FontInfo } from '../pdf/fonts.ts';
import { readTail } from '../pdf/incremental.ts';
import { matchObjects, type ObjectKey, type SiteKey } from '../pdf/match.ts';
import { apply, mul, type Op, type TextShow } from '../pdf/ops.ts';
import { blankOutDetailed, fmtNum, replacementFor } from '../pdf/surgery.ts';
import { fontDecoder, type FontDecoder } from '../pdf/textdecode.ts';
import type { Token } from '../pdf/tokenizer.ts';
import {
  commitForms, contentTree, fontDictIn, formUses, mapOffset, nodeFonts, pdfName, spliceBytes,
  type ContentTree, type StreamNode, type TextSite,
} from '../pdf/tree.ts';
import { emit } from '../text/emit.ts';
import type { Face } from '../text/face.ts';
import { FontWriter } from '../text/font-writer.ts';
import { loadHarfBuzz } from '../text/hb.ts';
import type { Layout, Line } from '../text/layout.ts';
import type { Box, Doc, FontRef, LaidBox, Page } from '../model/types.ts';
import { documentFontCoverage, missingFrom, nodeShippedFaces, pickSubstitute, type SubstituteFlag } from './fonts.ts';
import { applyPictureMoves, type PictureMoved, type PictureSkipped } from './pictures.ts';

// ---------------------------------------------------------------------------------------------------------------
// Public types

export type ExportOptions = {
  /** Incremental update (default) or a full rewrite. */
  incremental?: boolean;
  /** Run the verification pass (default true). 'report': run it, but return the report instead of throwing. */
  verify?: boolean | 'report';
  /** Resolves a run's FontRef to the Face its glyph IDs came from, for runs that do not carry their `face`.
   *  Default (Node): the shipped faces in fonts/. */
  faces?: (font: FontRef) => Face;
  /** A PDFium instance to use (default: the shared one). */
  pdfium?: Pdfium;
  /** Verification: pixels allowed to change outside the edited regions (default 0). */
  maxPixelsOutside?: number;
  /** Verification: render scale (default 1.5) and per-channel tolerance (default 24). */
  scale?: number;
  tolerance?: number;
};

export type FontReport = {
  key: string;             // resource name on the pages
  face: string;            // PostScript name of the instance, e.g. NotoSans-Regular, NotoSansJP-Bold
  font: string;            // the FontRef name it was asked for
  glyphs: number;          // glyphs in the subset (.notdef not counted)
  bytes: number;           // serialised size of the font's five objects (Type0, CIDFont, descriptor, FontFile2, ToUnicode)
  programBytes: number;    // the subset TrueType program, uncompressed (FontFile2 /Length1)
  pages: number[];         // pages that use it (one font object shared by all of them)
};

export type BoxWritten = {
  box: string;
  objs: number[];                       // source text objects removed (indices into PDFium's page.textObjects())
  operators: number[];                  // text-showing operator numbers blanked (TextShow.n, in each one's own stream)
  inForm: number;                       // how many of the objects were inside a Form XObject
  /** Mixed operators split for this box: the other characters it showed, re-emitted in the appended stream. */
  split: { obj: number; operator: number; kept: number; dropped: number }[];
  lines: number; glyphs: number;
  faces: string[];                      // FontRef names the new text is set in
  substituteFlags: SubstituteFlag[];    // serif / italic asked for but not shipped
  /** The source fonts' own coverage of the new text: could the box have stayed in the document font? */
  documentFont: { resource: string; baseFont: string; coverage: 'full' | 'partial' | 'unknown'; missing: number }[];
  couldStayInDocumentFont: boolean | null;
  /** Tagged PDF: the MCID the new text carries (null: the source text had none). */
  mcid: number | null;
  tag: string | null;
  mcidMoved: boolean;                   // the original sequence's BDC lost the MCID (nothing else was left in it)
  mcidsEmptied: number[];               // other MCIDs of the source text: their sequences stay, now without glyphs
  actualText: boolean;
  artifact: boolean;                    // the source text was an /Artifact and the new text is one too
};

export type BoxCheck = { box: string; newPresent: boolean; oldAbsent: boolean | null };

export type PageVerify = {
  opened: boolean;
  text: BoxCheck[];
  pixelsChangedOutside: number;
  pixelsCompared: number;
  ok: boolean;
};

export type PageReport = {
  page: number;
  written: BoxWritten[];
  skipped: { box: string; reason: string }[];
  operatorsBlanked: number;
  /** How PDFium's text objects were mapped to operators: by position in content order, or by decoded text and
   *  position because the counts differ ('fallback'). */
  matching: 'one-to-one' | 'fallback';
  textObjects: number;      // PDFium's text objects on the page (forms included)
  operators: number;        // non-empty text-showing operators in the content tree
  unmatched: number;        // text objects without an operator (fallback matching only)
  operatorsSplit: number;   // mixed operators split (their other characters re-emitted)
  formsEdited: string[];    // form XObjects changed in place ("n g")
  formsCopied: { from: string; to: string }[];  // forms copied for this page's use
  fonts: { key: string; face: string; glyphs: number; bytes: number }[];
  tagged: boolean;          // the page has /StructParents or the removed text was marked content
  contentBytes: number;     // compressed size of the page's new content streams
  fontBytes: number;        // bytes of the fonts first used on this page
  growth: number;           // (contentBytes + fontBytes) / original file size
  verify: PageVerify | null;
  /** Pictures the fitter moved or shrank (src/export/pictures.ts): old and new frames; and moves refused, why. */
  picturesMoved?: PictureMoved[];
  picturesSkipped?: PictureSkipped[];
};

export type ExportReport = {
  ok: boolean;              // nothing failed (verification included when it ran)
  verified: boolean;
  incremental: boolean;
  /** The input was encrypted (owner password only): the edit was made on PDFium's decrypted copy. */
  decrypted: boolean;
  /** The output is encrypted. Always false: re-encryption is not done, so a decrypted input comes out unencrypted. */
  encrypted: boolean;
  /** The input's cross-reference chain was broken (or pdf-lib could not parse it): edited on PDFium's repaired copy. */
  repaired: boolean;
  notes: string[];          // what was done to the input before editing, in sentences
  bytesIn: number;
  bytesOut: number;
  growth: number;           // (bytesOut − bytesIn) / bytesIn
  growthPerEditedPage: number;
  fonts: FontReport[];
  pages: PageReport[];
  allPagesRender: boolean | null;
  failures: string[];
  ms: number;
};

export class ExportError extends Error {
  readonly report: ExportReport;
  constructor(report: ExportReport) {
    super(`pdfedit export failed verification:\n  ${report.failures.join('\n  ')}`);
    this.name = 'ExportError';
    this.report = report;
  }
}

/** What the verification pass checks on one page. */
export type PageCheck = {
  page: number;
  /** `frame`: where the new text was laid (page space); its text is read from the characters inside it. */
  boxes: { box: string; newText: string; oldSegments: string[]; frame?: Rect }[];
  regions: Rect[];          // page rectangles that may change
};

// ---------------------------------------------------------------------------------------------------------------
// Helpers

// PDFium reports a hyphen that ends a line as U+0002 (its soft-hyphen marker) and may report U+00AD: both count as '-'.
const norm = (s: string) => s.normalize('NFKC').replace(/[\u0002\u00ad]/gu, '-').replace(/\s+/gu, '');
const union = (rs: Rect[]): Rect => ({
  x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)),
  x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)),
});
const enc = new TextEncoder();
const stripSubset = (n: string) => n.replace(/^[A-Z]{6}\+/, '');

/** Every character of `needle` occurs in `hay` in order (other characters, e.g. a neighbour's glyphs that overlap the
 *  frame and that PDFium's reading order interleaves, may come between). */
function subsequence(needle: string, hay: string): boolean {
  if (!needle) return true;
  const n = [...needle];
  let k = 0;
  for (const ch of hay) if (ch === n[k] && ++k === n.length) return true;
  return false;
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** A PDF text string as UTF-16BE hex with a BOM. */
function textString(s: string): string {
  let h = 'FEFF';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${h}>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Marked content

type Marked = {
  tag: string; mcid: number | null; actualText: boolean;
  op: Op;                    // the BDC/BMC operator
  shows: number[];           // non-empty text-showing operators inside (TextShow.n), nested sequences included
  paints: boolean;           // any other painting operator inside (paths, images, shadings, XObjects)
};

const PAINT = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'S', 's', 'sh', 'Do', 'BI']);

/** Every show's enclosing marked-content sequences, innermost last. */
function markedContent(ops: Op[], shows: TextShow[], props: (name: string) => PDFDict | undefined, ctx: PDFContext):
  Map<number, Marked[]> {
  const byOp = new Map(shows.map((s) => [s.opIndex, s]));
  const stack: Marked[] = [];
  const out = new Map<number, Marked[]>();
  const dictEntry = (d: Token, key: string): Token | undefined => {
    if (d.type !== 'dict') return undefined;
    for (let i = 0; i + 1 < d.items.length; i += 2) {
      const k = d.items[i];
      if (k.type === 'name' && k.value === key) return d.items[i + 1];
    }
    return undefined;
  };
  ops.forEach((o, i) => {
    if (o.op === 'BMC' || o.op === 'BDC') {
      const tagTok = o.operands[o.op === 'BMC' ? o.operands.length - 1 : o.operands.length - 2];
      const tag = tagTok?.type === 'name' ? tagTok.value : '';
      let mcid: number | null = null;
      let actualText = false;
      if (o.op === 'BDC') {
        const p = o.operands[o.operands.length - 1];
        if (p?.type === 'dict') {
          const m = dictEntry(p, 'MCID');
          if (m?.type === 'number') mcid = m.value;
          actualText = dictEntry(p, 'ActualText') !== undefined;
        } else if (p?.type === 'name') {
          const d = props(p.value);
          const m = d && resolve(ctx, d.get(PDFName.of('MCID')));
          if (m && 'asNumber' in m && typeof m.asNumber === 'function') mcid = (m as { asNumber(): number }).asNumber();
          actualText = !!d && d.get(PDFName.of('ActualText')) !== undefined;
        }
      }
      stack.push({ tag, mcid, actualText, op: o, shows: [], paints: false });
    } else if (o.op === 'EMC') {
      stack.pop();
    } else if (byOp.has(i)) {
      const s = byOp.get(i)!;
      if (s.strings.some((b) => b.length)) for (const m of stack) m.shows.push(s.n);
      out.set(s.n, [...stack]);
    } else if (PAINT.has(o.op)) {
      for (const m of stack) m.paints = true;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// LaidBox → content

/** A LaidBox in src/text's Layout shape (baselines from the frame top; glyph x from the frame's left edge). LaidBox
 *  glyph x is an offset from its line's x (the frame's left edge, src/model/types.ts), line baselines are PDF y. */
function toLayout(laid: LaidBox, faceOf: (f: FontRef) => Face): { layout: Layout; at: { x: number; yTop: number } } {
  const x0 = laid.frame.x0;
  const yTop = laid.frame.y1;
  const lines: Line[] = laid.lines.map((l) => ({
    baseline: yTop - l.baseline, width: 0, height: 0, para: 0, overflow: false,
    runs: l.runs.map((r) => ({
      face: faceOf(r.font), size: r.size, color: r.color,
      glyphs: r.glyphs.map((g) => ({ gid: g.gid, x: l.x - x0 + g.x, y: g.y, text: g.text })),
    })),
  }));
  return { layout: { lines, height: laid.height, width: laid.frame.x1 - laid.frame.x0, overflow: laid.overflow }, at: { x: x0, yTop } };
}

const laidText = (laid: LaidBox) => laid.lines.map((l) => l.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('')).join('\n');

// ---------------------------------------------------------------------------------------------------------------
// The export

type Cand = {
  box: Box; laid: LaidBox; objs: number[]; sites: TextSite[]; faces: Map<string, Face>; oldSegments: string[];
};

type PagePlan = {
  page: Page; report: PageReport; cands: Cand[]; content: Uint8Array[]; keys: Set<string>; check: PageCheck;
  fontAliases: Record<string, PDFRef>;
};

/** One code of a shown string and the PDFium characters it produced. */
type CodeChars = { code: number; bytes: Uint8Array; chars: number[] };

/** A mixed operator's split: the codes kept (re-emitted) and dropped (the edited boxes' characters). */
type Split = { site: TextSite; obj: number; codes: CodeChars[]; kept: CodeChars[]; dropped: CodeChars[] };

function fontNames(edit: PdfEdit, page: number): string[] {
  const res = inheritedResources(edit.context, edit.doc.getPage(page).node);
  const f = res && resolve(edit.context, res.get(PDFName.of('Font')));
  return f instanceof PDFDict ? [...f.keys()].map((k) => k.decodeText()) : [];
}

/** Old text as PDFium extracts it, in runs of consecutive character indices (each run is a substring of the page's
 *  extracted text, which is what the verification counts). */
function oldSegments(charIdx: number[], chars: Char[]): string[] {
  const idx = [...new Set(charIdx)].filter((i) => i >= 0 && i < chars.length).sort((a, b) => a - b);
  const segs: string[] = [];
  let cur = '';
  idx.forEach((i, k) => {
    if (k && i !== idx[k - 1] + 1) { if (norm(cur)) segs.push(norm(cur)); cur = ''; }
    if (!chars[i].generated) cur += chars[i].unicode;
  });
  if (norm(cur)) segs.push(norm(cur));
  return segs;
}

const quote = (s: string) => JSON.stringify(s.length > 20 ? s.slice(0, 20) + '…' : s);
const isSpace = (u: string) => !u || /^\s+$/u.test(u);
const siteKey = (s: TextSite) => `${s.node.id}:${s.show.n}`;

/**
 * Pairs an operator's codes with the object's PDFium characters (generated ones left out). A code gives as many
 * characters as its decoded text has code points (one when it decodes to nothing or is unknown); when that does not
 * add up, one character per code is tried. Returns a reason when neither lines up.
 */
function alignCodes(show: TextShow, dec: FontDecoder, obj: TextObj, chars: Char[]): CodeChars[] | string {
  if (dec.info.codeBytes === 0) return `its font (${dec.info.baseFont}) uses a CMap whose codes we cannot split`;
  const cb = dec.info.codeBytes;
  const codes: { code: number; bytes: Uint8Array }[] = [];
  for (const b of show.strings) for (let i = 0; i + cb <= b.length; i += cb) codes.push({ code: cb === 1 ? b[i] : (b[i] << 8) | b[i + 1], bytes: b.subarray(i, i + cb) });
  const real = obj.chars.filter((i) => chars[i] && !chars[i].generated);
  const lens = codes.map((c) => Math.max(1, [...(dec.decode(c.code) ?? '')].length));
  let take = lens;
  if (lens.reduce((a, b) => a + b, 0) !== real.length) {
    if (codes.length !== real.length) return `its ${codes.length} codes do not line up with PDFium's ${real.length} characters`;
    take = codes.map(() => 1);
  }
  let k = 0;
  return codes.map((c, i) => {
    const cs = real.slice(k, k + take[i]);
    k += take[i];
    return { ...c, chars: cs };
  });
}

/** The re-emission of a split operator's kept codes: one glyph per Tm at PDFium's origin, in the original font
 *  resource, size, horizontal scale and fill colour (the stream's own device-colour operator where there is one). */
function reemit(sp: Split, fontName: string, chars: Char[]): Uint8Array {
  const { show, node } = sp.site;
  const m = mul(mul(show.tm, show.ctm), node.toPage);
  const lin = [m[0], m[1], m[2], m[3]].map(fmtNum).join(' ');
  const out: string[] = ['q', 'BT', `${pdfName(fontName)} ${fmtNum(show.fontSize)} Tf`];
  if (Math.abs(show.hScale - 1) > 1e-9) out.push(`${fmtNum(show.hScale * 100)} Tz`);
  if (show.render === 3) out.push('3 Tr');
  // the original's own fill operator when it was set in a device space (CMYK stays CMYK), else PDFium's RGB
  let fill = '';
  for (const c of sp.kept) {
    const ch = chars[c.chars[0]];
    const f = show.fill ?? `${ch.fill.slice(0, 3).map((v) => fmtNum(v / 255)).join(' ')} rg`;
    if (f !== fill) { out.push(f); fill = f; }
    const hex = [...c.bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    out.push(`${lin} ${fmtNum(ch.origin[0])} ${fmtNum(ch.origin[1])} Tm <${hex}> Tj`);
  }
  out.push('ET', 'Q', '');
  return enc.encode(out.join('\n'));
}

let defaultFaces: ReturnType<typeof nodeShippedFaces> | null = null;

/** What exportDoc edits: the original, or PDFium's decrypted or repaired copy of it. */
async function prepareInput(original: Uint8Array, P: Pdfium): Promise<{ edit: PdfEdit; decrypted: boolean; repaired: boolean; notes: string[] }> {
  const notes: string[] = [];
  let base = original;
  let decrypted = false;
  let repaired = false;
  let sec: ReturnType<Pdfium['security']> | null = null;
  try { sec = P.security(original); } catch { sec = null; } // PDFium cannot open it: pdf-lib may still, below
  if (sec?.needsPassword) {
    throw new Error('the document is encrypted with a user password (it does not open without one); pdfedit cannot decrypt it, so it is not edited');
  }
  let brokenWhy: string | null = null;
  try { brokenWhy = readTail(original).broken; } catch (e) { brokenWhy = (e as Error).message.replace(/^pdfedit: /, ''); }
  if (sec?.encrypted) {
    base = P.decryptCopy(original)!;
    decrypted = true;
    notes.push(`the input is encrypted (security handler revision ${sec.revision}, owner password only); it was edited as PDFium's decrypted copy with a full save, and the output is not encrypted (re-encryption is not done)`);
    if (brokenWhy) { repaired = true; notes.push(`its cross-reference chain was also broken (${brokenWhy}); PDFium's copy rebuilt it`); }
  } else if (brokenWhy) {
    base = P.repairCopy(original);
    repaired = true;
    notes.push(`the input's cross-reference chain is broken (${brokenWhy}); it was edited as PDFium's repaired copy (PDFium rebuilds the table on load) with a full save`);
  }
  try {
    return { edit: await openForEdit(base), decrypted, repaired, notes };
  } catch (e) {
    if (decrypted || repaired) throw e;
    const why = (e as Error).message.replace(/^pdfedit: /, '');
    base = P.repairCopy(original);
    notes.push(`pdf-lib could not parse the input (${why}); it was edited as PDFium's repaired copy with a full save`);
    return { edit: await openForEdit(base), decrypted, repaired: true, notes };
  }
}

function emptyReport(original: Uint8Array, incremental: boolean): ExportReport {
  return {
    ok: true, verified: false, incremental, decrypted: false, encrypted: false, repaired: false, notes: [],
    bytesIn: original.length, bytesOut: original.length, growth: 0, growthPerEditedPage: 0,
    fonts: [], pages: [], allPagesRender: null, failures: [], ms: 0,
  };
}

export async function exportDoc(
  original: Uint8Array,
  doc: Doc,
  laid: (page: number, box: Box) => LaidBox,
  opts: ExportOptions = {},
): Promise<{ bytes: Uint8Array; report: ExportReport }> {
  const t0 = performance.now();
  await loadHarfBuzz();
  const P = opts.pdfium ?? (await openPdfium());
  const faceOf = opts.faces ?? (await (defaultFaces ??= nodeShippedFaces()));
  let prepared: Awaited<ReturnType<typeof prepareInput>>;
  try {
    prepared = await prepareInput(original, P);
  } catch (e) {
    const report = emptyReport(original, opts.incremental !== false);
    report.ok = false;
    report.failures = [`refused: ${(e as Error).message.replace(/^pdfedit: /, '')}`];
    report.ms = Math.round(performance.now() - t0);
    throw new ExportError(report);
  }
  const { edit, decrypted, repaired, notes } = prepared;
  const incremental = opts.incremental !== false && !decrypted && !repaired;
  if (opts.incremental !== false && !incremental) notes.push('an incremental update was asked for; the copy is written with a full save instead');
  const ctx = edit.context;
  const editedPages = doc.pages.filter((p) => p.boxes.some((b) => b.edited));

  // Resource names for the new fonts that no edited page already uses.
  const taken = new Set(editedPages.flatMap((p) => fontNames(edit, p.n)));
  let prefix = 'PE';
  for (let k = 0; [...taken].some((n) => new RegExp(`^${prefix}\\d+$`).test(n)); k++) prefix = `PE${String.fromCharCode(97 + (k % 26))}${k >= 26 ? k : ''}`;
  const writer = new FontWriter(ctx, { prefix });
  const keyFaces = new Map<string, { face: Face; font: string; gids: Set<number>; pages: Set<number> }>();
  const keyOfFace = new Map<number, string>();
  let uses: Map<string, number> | null = null;

  let src: ReturnType<Pdfium['open']>;
  try {
    src = P.open(original);
  } catch (e) {
    if (!(e instanceof PdfiumOpenError)) throw e;
    src = P.open(edit.save({ incremental: false })); // PDFium reads the repaired copy where it cannot read the original
  }
  const plans: PagePlan[] = [];
  try {
    for (const page of editedPages) {
      const n = page.n;
      const pr: PageReport = {
        page: n, written: [], skipped: [], operatorsBlanked: 0, matching: 'one-to-one', textObjects: 0, operators: 0,
        unmatched: 0, operatorsSplit: 0, formsEdited: [], formsCopied: [], fonts: [], tagged: false,
        contentBytes: 0, fontBytes: 0, growth: 0, verify: null,
      };
      const plan: PagePlan = { page, report: pr, cands: [], content: [], keys: new Set(), check: { page: n, boxes: [], regions: [] }, fontAliases: {} };
      plans.push(plan);
      const skip = (box: Box, reason: string) => pr.skipped.push({ box: box.id, reason });

      const pg = src.page(n);
      const chars = pg.chars();
      const objs = pg.textObjects();
      pg.close();
      pr.textObjects = objs.length;
      let tree: ContentTree;
      try {
        tree = contentTree(edit, n);
      } catch (e) {
        for (const b of page.boxes.filter((x) => x.edited)) skip(b, `the page's content cannot be read: ${(e as Error).message.replace(/^pdfedit: /, '')}`);
        continue;
      }
      const { root, sites } = tree;
      pr.operators = sites.length;
      const nodeFontCache = new Map<number, (name: string) => FontInfo>();
      const fontsOf = (node: StreamNode) => {
        let f = nodeFontCache.get(node.id);
        if (!f) nodeFontCache.set(node.id, (f = nodeFonts(ctx, node)));
        return f;
      };
      const decCache = new Map<string, FontDecoder | null>();
      const decoderOf = (s: TextSite): FontDecoder | null => {
        const k = `${s.node.id}/${s.show.font}`;
        if (!decCache.has(k)) {
          let d: FontDecoder | null = null;
          try { d = fontDecoder(ctx, fontDictIn(ctx, s.node.resources, s.show.font)); } catch { d = null; }
          decCache.set(k, d);
        }
        return decCache.get(k)!;
      };

      // 0. text objects → operators
      const oneToOne = sites.length === objs.length && objs.every((o, i) => o.inForm === sites[i].node.depth > 0);
      let siteOf: (TextSite | null)[];
      if (oneToOne) {
        siteOf = sites;
      } else {
        pr.matching = 'fallback';
        const okeys: ObjectKey[] = objs.map((o) => {
          const first = o.chars.map((i) => chars[i]).find((c) => c && !c.generated);
          return { inForm: o.inForm, text: o.text, fontName: o.fontName, matrix: o.matrix, origin: first ? first.origin : null,
            size: o.fontSize * (Math.hypot(o.matrix[2], o.matrix[3]) || 1) };
        });
        const skeys: SiteKey[] = sites.map((s) => {
          const d = decoderOf(s);
          const local = mul(s.show.tm, s.show.ctm);
          return {
            inForm: s.node.depth > 0, text: d ? d.text(s.show.strings) : null, baseFont: d?.info.baseFont ?? '',
            objPos: apply(local, 0, s.show.rise), pagePos: apply(mul(local, s.node.toPage), 0, s.show.rise), exact: s.show.tmExact,
          };
        });
        const m = matchObjects(okeys, skeys);
        siteOf = m.site.map((j) => (j === null ? null : sites[j]));
        pr.unmatched = m.unmatched.length;
      }
      const pageDict = edit.doc.getPage(n).node;
      pr.tagged = pageDict.get(PDFName.of('StructParents')) !== undefined;

      // 1. candidates
      let cands: Cand[] = [];
      for (const box of page.boxes.filter((b) => b.edited)) {
        if (box.locked) { skip(box, `locked: ${box.locked}`); continue; }
        if (box.rot !== 0) { skip(box, `rotated boxes (${box.rot}°) are not written in this phase`); continue; }
        const bad = box.source.objs.filter((t) => !Number.isInteger(t) || t < 0 || t >= objs.length);
        if (bad.length) { skip(box, `source text objects ${bad.join(', ')} do not exist on the page (it has ${objs.length})`); continue; }
        const objsSorted = [...new Set(box.source.objs)].sort((a, b) => a - b);
        const unmapped = objsSorted.filter((t) => !siteOf[t]);
        if (unmapped.length) {
          skip(box, `text object${unmapped.length > 1 ? 's' : ''} ${unmapped.join(', ')} ${unmapped.length > 1 ? 'have' : 'has'} no matching operator ` +
            `(the page has ${objs.length} text objects and ${sites.length} non-empty text operators; matched by decoded text and position)`);
          continue;
        }
        let lb: LaidBox;
        try { lb = laid(n, box); } catch (e) { skip(box, `layout failed: ${(e as Error).message}`); continue; }
        const docRuns = lb.lines.flatMap((l) => l.runs).filter((r) => r.font.source !== 'shipped' && r.glyphs.length);
        if (docRuns.length) { skip(box, `runs set in the document's own font (${docRuns[0].font.name}) are not written in this phase`); continue; }
        const faces = new Map<string, Face>();
        try {
          for (const l of lb.lines) for (const r of l.runs) if (!faces.has(r.font.name)) faces.set(r.font.name, r.face ?? faceOf(r.font));
        } catch (e) { skip(box, `font: ${(e as Error).message}`); continue; }
        const bsites = objsSorted.map((t) => siteOf[t]!);
        let why = '';
        for (const [k, s] of bsites.entries()) {
          const o = objs[objsSorted[k]];
          try {
            const fi = fontsOf(s.node)(s.show.font);
            const a = stripSubset(o.fontName), b = stripSubset(fi.baseFont);
            if (a && b && a !== b) { why = `text object ${o.index} is in ${a} but operator #${s.show.n} shows /${s.show.font} (${b}): the object-to-operator map is off`; break; }
            if (s.show.render >= 4) { why = `operator #${s.show.n} shows text in a clipping mode (${s.show.render} Tr): removing it would change the clip`; break; }
            replacementFor(s.node.contents, s.show, fi);
          } catch (e) { why = `operator #${s.show.n} cannot be blanked: ${(e as Error).message.replace(/^pdfedit: /, '')}`; break; }
        }
        if (why) { skip(box, why); continue; }
        // Old text for the verification: PDFium's own characters of the box, else the model's paragraph text, else
        // the text of the objects being removed.
        const paraText = box.source.paragraphs.map((p) => norm(p.text)).filter(Boolean);
        const old = box.source.chars.length ? oldSegments(box.source.chars, chars)
          : paraText.length ? paraText : oldSegments(objsSorted.flatMap((t) => objs[t].chars), chars);
        cands.push({ box, laid: lb, objs: objsSorted, sites: bsites, faces, oldSegments: old });
      }

      // Mixed operators: an operator that also shows characters of boxes not being written is split — blanked, and
      // those characters re-emitted. When it cannot be split, the box is refused; refusing one box can make another's
      // operator mixed, so repeat until nothing changes.
      const owner = new Map<number, string>();
      for (const b of page.boxes) for (const c of b.source.chars) if (!owner.has(c)) owner.set(c, b.id);
      let splits = new Map<string, Split>();
      for (let changed = true; changed; ) {
        changed = false;
        splits = new Map();
        const writing = new Set(cands.map((c) => c.box.id));
        // a site claimed whole: some box being written over it has no character list (the object is all it knows)
        const claimAll = new Set<string>();
        for (const c of cands) if (!c.box.source.chars.length) for (const s of c.sites) claimAll.add(siteKey(s));
        let refuse: { cand: Cand; reason: string } | null = null;
        outer: for (const c of cands) {
          for (const [k, t] of c.objs.entries()) {
            const s = c.sites[k];
            const sk = siteKey(s);
            if (splits.has(sk)) continue;
            const obj = objs[t];
            const keepChar = (ci: number) => {
              const ch = chars[ci];
              if (!ch || ch.generated) return false;
              const o = owner.get(ci);
              if (o !== undefined) return !writing.has(o);
              return !claimAll.has(sk) && !isSpace(ch.unicode);
            };
            if (!obj.chars.some(keepChar)) continue;
            const foreign = [...new Set(obj.chars.filter(keepChar).map((ci) => owner.get(ci)))];
            const whose = foreign.map((o) => (o === undefined ? 'characters that belong to no box' : `characters of box ${o}`)).join(' and ');
            const fail = (r: string) => {
              refuse = { cand: c, reason: `mixed operator: text operator #${s.show.n} (text object ${t}, ${quote(obj.text)}) also shows ${whose}, and it cannot be split: ${r}` };
            };
            const dec = decoderOf(s);
            if (!dec) { fail(`its font /${s.show.font} cannot be read`); break outer; }
            if (dec.info.vertical) { fail('it is set in a vertical font'); break outer; }
            if (s.show.render !== 0 && s.show.render !== 3) { fail(`its text render mode is ${s.show.render} (stroked text is not re-emitted)`); break outer; }
            const codes = alignCodes(s.show, dec, obj, chars);
            if (typeof codes === 'string') { fail(codes); break outer; }
            const kept = codes.filter((cc) => cc.chars.some(keepChar));
            const translucent = kept.find((cc) => chars[cc.chars[0]].fill[3] < 255);
            if (translucent) { fail('its fill is translucent'); break outer; }
            splits.set(sk, { site: s, obj: t, codes, kept, dropped: codes.filter((cc) => !kept.includes(cc)) });
          }
        }
        if (refuse) {
          const r = refuse as { cand: Cand; reason: string };
          skip(r.cand.box, r.reason);
          cands = cands.filter((x) => x !== r.cand);
          changed = true;
        }
      }
      plan.cands = cands;
      if (!cands.length) continue;
      pr.operatorsSplit = splits.size;

      // 2. blank, per stream
      const blankByNode = new Map<StreamNode, Map<number, TextShow>>();
      for (const c of cands) for (const s of c.sites) {
        let m = blankByNode.get(s.node);
        if (!m) blankByNode.set(s.node, (m = new Map()));
        m.set(s.show.n, s.show);
      }
      const rootBlanks = blankByNode.get(root) ?? new Map<number, TextShow>();
      const { bytes: blanked, replacements } = blankOutDetailed(root.contents, [...rootBlanks.values()], fontsOf(root));
      pr.operatorsBlanked = [...blankByNode.values()].reduce((k, m) => k + m.size, 0);
      const formBlanks = new Map([...blankByNode].filter(([node]) => node.ref).map(([node, m]) => [node, [...m.values()]] as [StreamNode, TextShow[]]));
      let pageRenames: ReturnType<typeof commitForms>['pageRenames'] = [];
      if (formBlanks.size) {
        uses ??= formUses(edit);
        const fc = commitForms(edit, formBlanks, uses);
        pageRenames = fc.pageRenames;
        pr.formsEdited = fc.edited;
        pr.formsCopied = fc.copied;
      }

      // 3. marked content (the page's own stream)
      const res = inheritedResources(ctx, pageDict);
      const propsDict = res && resolve(ctx, res.get(PDFName.of('Properties')));
      const props = (name: string) => {
        const d = propsDict instanceof PDFDict ? resolve(ctx, lookupByName(propsDict, name)) : undefined;
        return d instanceof PDFDict ? d : undefined;
      };
      const mc = markedContent(root.ops, root.shows, props, ctx);
      const pageEdits: { start: number; end: number; text: string }[] = [];
      const stripped = new Set<Op>();

      // the split operators' other characters, re-emitted first (they were painted before any new text)
      const pageFonts = new Set(fontNames(edit, n));
      const aliasOf = new Map<string, string>();
      for (const sp of splits.values()) {
        if (!sp.kept.length) continue;
        let name = sp.site.show.font;
        if (sp.site.node.ref) {
          const raw = resolve(ctx, sp.site.node.resources?.get(PDFName.of('Font')));
          const entry = raw instanceof PDFDict ? lookupByName(raw, name) : undefined;
          const fref = entry instanceof PDFRef ? entry : ctx.register(resolve(ctx, entry)!);
          const key = `${fref.objectNumber} ${fref.generationNumber}`;
          let alias = aliasOf.get(key);
          if (!alias) {
            for (let k = 1; !alias; k++) if (!pageFonts.has(`${prefix}f${k}`) && !(`${prefix}f${k}` in plan.fontAliases)) alias = `${prefix}f${k}`;
            aliasOf.set(key, alias);
            plan.fontAliases[alias] = fref;
          }
          name = alias;
        }
        plan.content.push(reemit(sp, name, chars));
      }

      for (const c of cands) {
        const seqs: Marked[] = [];
        let artifact = false;
        for (const s of c.sites) {
          if (s.node !== root) continue;
          const stack = mc.get(s.show.n) ?? [];
          const inner = [...stack].reverse().find((m) => m.mcid !== null);
          if (inner && !seqs.includes(inner)) seqs.push(inner);
          if (!inner && stack.some((m) => m.tag === 'Artifact')) artifact = true;
        }
        if (seqs.length) pr.tagged = true;
        const chosen = seqs[0] ?? null;
        let moved = false;
        if (chosen && chosen.op.op === 'BDC' && !chosen.paints && chosen.shows.every((k) => rootBlanks.has(k)) && !stripped.has(chosen.op)) {
          stripped.add(chosen.op);
          pageEdits.push({ start: mapOffset(replacements, chosen.op.start), end: mapOffset(replacements, chosen.op.end), text: `${pdfName(chosen.tag)} BMC` });
          moved = true;
        }
        const newText = laidText(c.laid);
        // the new text, through the shared font writer
        const keyOf = (face: Face) => keyOfFace.get(face.id)!;
        for (const l of c.laid.lines) for (const r of l.runs) {
          if (!r.glyphs.length) continue;
          const face = c.faces.get(r.font.name)!;
          const key = writer.use(face, r.glyphs);
          keyOfFace.set(face.id, key);
          let kf = keyFaces.get(key);
          if (!kf) keyFaces.set(key, (kf = { face, font: r.font.name, gids: new Set(), pages: new Set() }));
          for (const g of r.glyphs) kf.gids.add(g.gid);
          kf.pages.add(n);
          plan.keys.add(key);
        }
        const faceFor = (f: FontRef) => c.faces.get(f.name)!;
        const { layout, at } = toLayout(c.laid, faceFor);
        const hasGlyphs = layout.lines.some((l) => l.runs.some((r) => r.glyphs.length));
        if (hasGlyphs) {
          let body = emit(layout, at, keyOf);
          if (chosen) {
            const actual = chosen.actualText ? ` /ActualText ${textString(newText.replace(/\n/g, ' '))}` : '';
            body = concat([enc.encode(`${pdfName(chosen.tag)} <</MCID ${chosen.mcid}${actual}>> BDC\n`), body, enc.encode('EMC\n')]);
          } else if (artifact) {
            body = concat([enc.encode('/Artifact BMC\n'), body, enc.encode('EMC\n')]);
          }
          plan.content.push(body);
        }

        // report
        const docFonts: BoxWritten['documentFont'] = [];
        const rootFonts = [...new Set(c.sites.filter((s) => s.node === root).map((s) => s.show.font))];
        for (const name of rootFonts) {
          let cov: Set<number> | null = null;
          try { cov = documentFontCoverage(edit, n, name); } catch { cov = null; }
          const miss = cov ? missingFrom(cov, newText).length : 0;
          docFonts.push({ resource: name, baseFont: fontsOf(root)(name).baseFont, coverage: cov ? (miss ? 'partial' : 'full') : 'unknown', missing: miss });
        }
        const flags = new Set<SubstituteFlag>();
        for (const p of c.box.paragraphs) for (const r of p.runs) for (const f of pickSubstitute(r).flags) flags.add(f);
        const split = c.sites.flatMap((s) => {
          const sp = splits.get(siteKey(s));
          return sp && sp.kept.length ? [{ obj: sp.obj, operator: s.show.n, kept: sp.kept.length, dropped: sp.dropped.length }] : [];
        });
        pr.written.push({
          box: c.box.id, objs: c.objs, operators: c.sites.map((s) => s.show.n), inForm: c.sites.filter((s) => s.node.ref).length, split,
          lines: c.laid.lines.length, glyphs: c.laid.lines.reduce((k, l) => k + l.runs.reduce((m, r) => m + r.glyphs.length, 0), 0),
          faces: [...c.faces.keys()], substituteFlags: [...flags],
          documentFont: docFonts,
          couldStayInDocumentFont: docFonts.some((d) => d.coverage === 'full') ? true : docFonts.every((d) => d.coverage === 'unknown') ? null : false,
          mcid: chosen?.mcid ?? null, tag: chosen?.tag ?? null, mcidMoved: moved,
          mcidsEmptied: seqs.slice(1).map((m) => m.mcid!), actualText: !!chosen?.actualText, artifact: !chosen && artifact,
        });
        plan.check.boxes.push({ box: c.box.id, newText, oldSegments: c.oldSegments, frame: c.laid.frame });
        // what may change: the source frame, the box's frame and the laid frame; the removed objects (page space: a
        // top-level object's bounds, else its characters' boxes); of a split operator, only the dropped characters
        plan.check.regions.push(c.box.source.frame, c.box.frame, c.laid.frame);
        for (const [k, t] of c.objs.entries()) {
          const sp = splits.get(siteKey(c.sites[k]));
          const o = objs[t];
          if (sp && sp.kept.length) {
            for (const cc of sp.dropped) for (const ci of cc.chars) plan.check.regions.push(chars[ci].loose, chars[ci].box);
          } else if (!o.inForm) {
            plan.check.regions.push(o.bounds);
          } else {
            const boxes = o.chars.filter((ci) => chars[ci] && !chars[ci].generated).map((ci) => chars[ci].loose);
            if (boxes.length) plan.check.regions.push(union(boxes));
          }
        }
      }
      for (const r of pageRenames) pageEdits.push({ start: mapOffset(replacements, r.call.nameStart), end: mapOffset(replacements, r.call.nameEnd), text: pdfName(r.name) });
      if (pageRenames.length) edit.addPageXObjects(n, Object.fromEntries(pageRenames.map((r) => [r.name, r.ref])));
      // picture moves the fitter made: wrapped in q … cm … Q where they are painted; old and new frames may change
      const pics = applyPictureMoves({ edit, page, tree, src, replacements, pageEdits, uses: () => (uses ??= formUses(edit)) });
      if (pics.moved.length || pics.skipped.length) Object.assign(pr, { picturesMoved: pics.moved, picturesSkipped: pics.skipped });
      plan.check.regions.push(...pics.regions);
      if (rootBlanks.size || pageEdits.length) {
        const finalContents = pageEdits.length ? spliceBytes(blanked, pageEdits) : blanked;
        edit.setContents(n, finalContents);
        pr.contentBytes += pako.deflate(finalContents).length;
      }
    }
  } finally {
    src.close();
  }

  // 4. fonts (once for the document), new content streams, save
  const refs = writer.finish();
  const fonts: FontReport[] = [];
  const firstPage = new Map<string, number>();
  for (const [key, kf] of keyFaces) {
    const size = fontSize(ctx, refs[key]);
    fonts.push({ key, face: kf.face.postScriptName, font: kf.font, glyphs: kf.gids.size, bytes: size.bytes, programBytes: size.program, pages: [...kf.pages].sort((a, b) => a - b) });
    firstPage.set(key, Math.min(...kf.pages));
  }
  for (const plan of plans) {
    if (!plan.cands.length) continue;
    const n = plan.page.n;
    if (plan.content.length) {
      const content = concat(plan.content);
      const pageRefs: Record<string, PDFRef> = { ...plan.fontAliases };
      for (const k of plan.keys) pageRefs[k] = refs[k];
      edit.appendContent(n, content, pageRefs);
      plan.report.contentBytes += pako.deflate(content).length;
    }
    plan.report.fonts = fonts.filter((f) => plan.keys.has(f.key)).map((f) => ({ key: f.key, face: f.face, glyphs: f.glyphs, bytes: f.bytes }));
    plan.report.fontBytes = fonts.filter((f) => firstPage.get(f.key) === n).reduce((s, f) => s + f.bytes, 0);
    plan.report.growth = (plan.report.contentBytes + plan.report.fontBytes) / original.length;
  }
  const written = plans.filter((p) => p.cands.length);
  const bytes = edit.save({ incremental });

  const report: ExportReport = {
    ...emptyReport(original, incremental), decrypted, repaired, notes, bytesOut: bytes.length,
    growth: (bytes.length - original.length) / original.length,
    growthPerEditedPage: written.length ? (bytes.length - original.length) / original.length / written.length : 0,
    fonts, pages: plans.map((p) => p.report),
  };

  // 5. verification
  const verify = opts.verify ?? true;
  if (verify) {
    const v = await verifyExport(original, bytes, written.map((p) => p.check), { ...opts, pdfium: P });
    report.verified = true;
    report.allPagesRender = v.allPagesRender;
    report.failures = v.failures;
    report.ok = v.failures.length === 0;
    for (const p of written) p.report.verify = v.pages.get(p.page.n) ?? null;
  }
  report.ms = Math.round(performance.now() - t0);
  if (!report.ok && verify !== 'report') throw new ExportError(report);
  return { bytes, report };
}

/** Serialised size of a Type0 font's objects (Type0, descendant, descriptor, FontFile2, ToUnicode). */
function fontSize(ctx: PDFContext, ref: PDFRef | undefined): { bytes: number; program: number } {
  if (!ref) return { bytes: 0, program: 0 };
  const seen = new Set<PDFObject>();
  let bytes = 0;
  let program = 0;
  const add = (o: PDFObject | undefined) => {
    const v = resolve(ctx, o);
    if (!v || seen.has(v)) return v;
    seen.add(v);
    bytes += v.sizeInBytes();
    return v;
  };
  const t0 = add(ref);
  if (!(t0 instanceof PDFDict)) return { bytes, program };
  add(t0.get(PDFName.of('ToUnicode')));
  const desc = resolve(ctx, t0.get(PDFName.of('DescendantFonts')));
  const cid = add(desc instanceof PDFArray ? desc.get(0) : undefined);
  if (cid instanceof PDFDict) {
    const fd = add(cid.get(PDFName.of('FontDescriptor')));
    if (fd instanceof PDFDict) {
      const ff = add(fd.get(PDFName.of('FontFile2')));
      if (ff instanceof PDFStream) {
        const l1 = resolve(ctx, ff.dict.get(PDFName.of('Length1')));
        program = l1 && 'asNumber' in l1 ? (l1 as { asNumber(): number }).asNumber() : 0;
      }
    }
  }
  return { bytes, program };
}

// ---------------------------------------------------------------------------------------------------------------
// Verification

/**
 * Re-opens `output` in PDFium and checks, for each listed page: every box's new text extracts and its old text is
 * gone (NFKC, whitespace removed; old text is counted against the original page, so text that also occurs elsewhere
 * is handled), and no pixel changes outside the regions (render at `scale`, tolerance per channel). Every page of
 * the output must open and render. Returns the failures as sentences.
 */
export async function verifyExport(
  original: Uint8Array,
  output: Uint8Array,
  checks: PageCheck[],
  opts: Pick<ExportOptions, 'pdfium' | 'maxPixelsOutside' | 'scale' | 'tolerance'> = {},
): Promise<{ pages: Map<number, PageVerify>; allPagesRender: boolean; failures: string[] }> {
  const P = opts.pdfium ?? (await openPdfium());
  const scale = opts.scale ?? 1.5;
  const maxOut = opts.maxPixelsOutside ?? 0;
  const failures: string[] = [];
  const pages = new Map<number, PageVerify>();
  let a: ReturnType<Pdfium['open']>;
  try {
    a = P.open(output);
  } catch (e) {
    return { pages, allPagesRender: false, failures: [`the output does not open: ${(e as Error).message}`] };
  }
  const b = P.open(original);
  let allPagesRender = true;
  try {
    if (a.pageCount !== b.pageCount) failures.push(`the output has ${a.pageCount} pages, the original ${b.pageCount}`);
    const checked = new Set(checks.map((c) => c.page));
    for (let i = 0; i < a.pageCount; i++) {
      if (checked.has(i)) continue;
      try { const p = a.page(i); p.render(0.25); p.close(); } catch (e) {
        allPagesRender = false;
        failures.push(`page ${i + 1} does not render: ${(e as Error).message}`);
      }
    }
    for (const c of checks) {
      const v: PageVerify = { opened: false, text: [], pixelsChangedOutside: 0, pixelsCompared: 0, ok: false };
      pages.set(c.page, v);
      const at = `page ${c.page + 1}`;
      let pa, pb;
      try {
        pa = a.page(c.page);
        v.opened = true;
      } catch (e) {
        allPagesRender = false;
        failures.push(`${at} does not open: ${(e as Error).message}`);
        continue;
      }
      pb = b.page(c.page);
      try {
        const afterChars = pa.chars();
        const after = norm(afterChars.map((ch) => ch.unicode).join(''));
        const before = norm(pb.chars().map((ch) => ch.unicode).join(''));
        // the text inside a frame: the characters whose box centres lie in it (1 pt slack), in PDFium's order
        const inside = (f: Rect) => norm(afterChars.filter((ch) => {
          const cx = (ch.box.x0 + ch.box.x1) / 2, cy = (ch.box.y0 + ch.box.y1) / 2;
          return cx >= f.x0 - 1 && cx <= f.x1 + 1 && cy >= f.y0 - 1 && cy <= f.y1 + 1;
        }).map((ch) => ch.unicode).join(''));
        const news = c.boxes.map((x) => norm(x.newText));
        // old text: each distinct segment must occur fewer times than before, by the number of boxes that removed it
        const need = new Map<string, number>();
        for (const x of c.boxes) for (const s of x.oldSegments) need.set(s, (need.get(s) ?? 0) + 1);
        const segOk = new Map<string, boolean | null>();
        for (const [s, k] of need) {
          const was = count(before, s);
          if (was < k) { segOk.set(s, null); continue; }
          const now = count(after, s) - news.reduce((m, t) => m + count(t, s), 0);
          segOk.set(s, now <= was - k);
        }
        c.boxes.forEach((x, i) => {
          // inside the laid frame first (a page-level reading may interleave the box with a line beside it), the
          // whole page's text as the fallback
          const region = x.frame !== undefined ? inside(x.frame) : '';
          const newPresent = news[i] === '' || region.includes(news[i]) || after.includes(news[i]) || subsequence(news[i], region);
          const r = x.oldSegments.map((s) => segOk.get(s) ?? null);
          const oldAbsent = r.some((q) => q === false) ? false : r.some((q) => q === true) ? true : null;
          v.text.push({ box: x.box, newPresent, oldAbsent });
          if (!newPresent) failures.push(`${at}, box ${x.box}: the new text does not extract ("${x.newText.slice(0, 50)}")`);
          if (oldAbsent === false) failures.push(`${at}, box ${x.box}: the old text is still on the page ("${x.oldSegments.join(' ').slice(0, 50)}")`);
        });
        let rendered = false;
        try {
          const ra = pa.render(scale);
          rendered = true;
          const rb = pb.render(scale);
          const d = diffOutside(rb, ra, c.regions, scale, pb.size.h, opts.tolerance ?? 24);
          v.pixelsChangedOutside = d.differing;
          v.pixelsCompared = d.total;
          if (d.differing > maxOut) failures.push(`${at}: ${d.differing} pixels changed outside the edited boxes (allowed ${maxOut})`);
        } catch (e) {
          if (!rendered) allPagesRender = false;
          failures.push(`${at}: render comparison failed: ${(e as Error).message}`);
        }
        v.ok = !failures.some((f) => f.startsWith(at + ':') || f.startsWith(at + ','));
      } finally {
        pa.close();
        pb.close();
      }
    }
  } finally {
    a.close();
    b.close();
  }
  return { pages, allPagesRender, failures };
}
