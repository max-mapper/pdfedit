// Reflow fidelity: how much a box changes when the editor takes over drawing it. For every editable box on the given
// pages, the unedited source text is laid out with the editor's layout (what the app draws as soon as a box is
// selected) and compared with the source characters:
//   - same breaks: the share of boxes whose laid lines start at exactly the source's line starts;
//   - displacement: per glyph, the distance in points between the laid glyph's origin and the source character's
//     origin (horizontal boxes; vertical boxes compare centres), median and 95th percentile over all glyphs;
//   - frame: the share of boxes whose laid frame moves an edge by more than 1 pt from the source frame.
// --edit append|insert: the same after a synthetic edit of each box's first multi-line paragraph (a short word appended,
// or inserted at its second line's start): what an edit disturbs. Also the share of the box's other source lines (all
// but the edited line) still starting where the source's did with every glyph within 0.5 pt of its source position.
// The PDFs are read by path and never copied; the output holds numbers and box ids only, outside the repository.
//   node scripts/reflow-fidelity.ts --cases <cases.json> --out <dir> [--label run] [--edit append|insert] [--only k1,k2]
// cases.json: [{ "key": "d01", "pdf": "/abs/d01.pdf", "pages": [1, 2] }]   (1-based pages)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPdfium, type Char } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
import type { Result } from '../src/layout/types.ts';
import { buildPageFrom, readPage } from '../src/model/build.ts';
import { loadFonts } from '../src/model/fonts.ts';
import { layoutBox } from '../src/model/layout.ts';
import type { Box, LaidBox } from '../src/model/types.ts';

const REPO = resolve(import.meta.dirname, '..');
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
if (!arg('--cases') || !arg('--out')) { console.error('usage: node scripts/reflow-fidelity.ts --cases <cases.json> --out <dir> [--label run] [--edit append|insert] [--only k1,k2]'); process.exit(2); }
const out = resolve(arg('--out')!);
if (out.startsWith(REPO)) { console.error('--out must be outside the repository'); process.exit(2); }
const label = arg('--label', 'run')!;
const casesPath = arg('--cases')!;
const only = arg('--only')?.split(',');
const editMode = arg('--edit') as 'append' | 'insert' | undefined;

type Case = { key: string; pdf: string; pages: number[] };
const cases: Case[] = [];
if (existsSync(casesPath)) for (const c of JSON.parse(readFileSync(casesPath, 'utf8')) as Case[]) cases.push({ key: c.key, pdf: c.pdf, pages: c.pages });

const ink = (c: Char | undefined) => !!c && !c.generated && c.unicode !== '';

/** Greedy alignment of a text to ink characters (as src/model/build.ts sourceLinesOf): per UTF-16 offset, the matched
 *  character index or -1. */
function align(text: string, idx: number[], chars: Char[]): number[] {
  const inkIdx = idx.filter((i) => ink(chars[i]));
  const outA = new Array<number>(text.length).fill(-1);
  let j = 0, off = 0;
  for (const ch of text) {
    const k = nextMatch(ch, j, inkIdx.length, (q) => chars[inkIdx[q]].unicode);
    if (k >= 0) { outA[off] = inkIdx[k]; j = k + 1; }
    off += ch.length;
  }
  return outA;
}

/** The next character from `j` that a text character matches, or -1: a space only the very next one (an inserted
 *  space has none); another character skips spaces the text lacks and up to 3 other characters (a dropped hyphen, a
 *  character PDFium reports twice). */
function nextMatch(ch: string, j: number, n: number, uni: (k: number) => string): number {
  if (/\s/u.test(ch)) return j < n && uni(j) === ch ? j : -1;
  let skipped = 0;
  for (let k = j; k < n; k++) {
    const u = uni(k);
    if (u === ch) return k;
    if (/^\s+$/u.test(u)) continue;
    if (++skipped > 3) return -1;
  }
  return -1;
}

type BoxRow = { id: string; vertical: boolean; same: boolean; frameMoved: number; glyphs: number; p50: number; p95: number; srcLines: number; laidLines: number;
  /** Edit mode: source lines outside the edited one, and those still where the source drew them. */
  other?: number; kept?: number };

/** Per paragraph of the model: its source lines' start offsets and, per offset, the source character (the model text
 *  aligned to the paragraph's characters directly, so an edited text lines up too). */
function sourceMap(b: Box, det: Result, detBox: Result['boxes'][number], chars: Char[]) {
  return b.paragraphs.map((p, k) => {
    const text = p.runs.map((r) => r.text).join('');
    const P = det.paragraphs[detBox.paragraphs[k]];
    if (!P) return { text, srcChar: new Array<number>(text.length).fill(-1), starts: [] as number[], lineOf: new Map<number, number>() };
    const lines = P.lines.map((li) => det.lines[li].chars);
    const srcChar = align(text, lines.flat(), chars);
    const where = new Map<number, number>();
    srcChar.forEach((ci, o) => { if (ci >= 0 && !where.has(ci)) where.set(ci, o); });
    const starts: number[] = [];
    const lineOf = new Map<number, number>();     // char index → source line
    lines.forEach((cs, li) => {
      for (const ci of cs) lineOf.set(ci, li);
      const first = cs.find((ci) => ink(chars[ci]) && where.has(ci));
      if (first !== undefined) starts.push(where.get(first)!);
    });
    return { text, srcChar, starts, lineOf };
  });
}

function measureBox(b: Box, L: LaidBox, det: Result, detBox: Result['boxes'][number], chars: Char[], disp: number[], dispV: number[],
  edited?: { para: number; line: number | null }): BoxRow {
  const maps = sourceMap(b, det, detBox, chars);
  const T = maps.map((m) => m.text).join('\n');
  const base: number[] = [];
  let acc = 0;
  for (const m of maps) { base.push(acc); acc += m.text.length + 1; }
  const srcChar = new Array<number>(T.length).fill(-1);
  const srcLine = new Array<number>(T.length).fill(-1);     // a global source line id per offset
  const srcStarts = new Map<number, number>();               // global offset → global source line id
  let lineId = 0;
  maps.forEach((m, k) => {
    m.srcChar.forEach((ci, o) => { srcChar[base[k] + o] = ci; if (ci >= 0) srcLine[base[k] + o] = lineId + (m.lineOf.get(ci) ?? 0); });
    m.starts.forEach((s, li) => srcStarts.set(base[k] + s, lineId + li));
    lineId += Math.max(m.starts.length, det.paragraphs[detBox.paragraphs[k]]?.lines.length ?? 0);
  });
  const skip = edited && edited.line !== null ? [...srcStarts.entries()].find(([, id]) => id === (maps.slice(0, edited.para).reduce((n, _, i) =>
    n + Math.max(maps[i].starts.length, det.paragraphs[detBox.paragraphs[i]]?.lines.length ?? 0), 0) + edited.line!))?.[1] ?? -1 : -1;
  // laid glyphs aligned to T: each glyph's text found at the cursor, skipping whitespace only
  const laidStarts = new Set<number>();
  const ds: number[] = [];
  const worstOfLine = new Map<number, number>();
  let cur = 0;
  for (const line of L.lines) {
    let first = -1;
    for (const run of line.runs) {
      for (const g of run.glyphs) {
        if (!g.text || g.c === -1) continue;          // c = -1: a marker or an inserted hyphen (layouts that say so)
        let o = cur;
        while (o < T.length && /\s/u.test(T[o]) && !T.startsWith(g.text, o)) o++;
        if (!T.startsWith(g.text, o)) continue;     // a marker or an inserted hyphen
        if (first < 0) first = o;
        cur = o + g.text.length;
        const ci = srcChar[o];
        if (ci < 0 || /\s/u.test(g.text)) continue;
        const c = chars[ci];
        let d: number;
        if (L.vertical) {
          const s = run.size;
          const gx = line.x + g.x, gy = line.baseline + g.y;
          const cx = (c.loose.x0 + c.loose.x1) / 2, cy = (c.loose.y0 + c.loose.y1) / 2;
          // sideways glyphs: along the column only (their origin is the top of the rotated em box)
          d = run.orientation === 'sideways' ? Math.abs(gy - c.loose.y1) : Math.hypot(gx + s / 2 - cx, gy + 0.38 * s - cy);
        } else d = Math.hypot(line.x + g.x - c.origin[0], line.baseline + g.y - c.origin[1]);
        const id = srcLine[o];
        worstOfLine.set(id, Math.max(worstOfLine.get(id) ?? 0, d));
        if (id === skip) continue;                 // the edited line's glyphs move by design
        (L.vertical ? dispV : disp).push(d);
        ds.push(d);
      }
    }
    if (first >= 0) laidStarts.add(first);
  }
  const starts = [...srcStarts.keys()];
  const same = edited ? starts.every((s) => srcStarts.get(s) === skip || laidStarts.has(s))
    : laidStarts.size === srcStarts.size && starts.every((s) => laidStarts.has(s));
  let other = 0, kept = 0;
  if (edited) for (const [s, id] of srcStarts) { if (id === skip) continue; other++; if (laidStarts.has(s) && (worstOfLine.get(id) ?? 0) <= 0.5) kept++; }
  const f = L.frame, s = b.frame;
  const frameMoved = Math.max(Math.abs(f.x0 - s.x0), Math.abs(f.x1 - s.x1), Math.abs(f.y0 - s.y0), Math.abs(f.y1 - s.y1));
  ds.sort((x, y) => x - y);
  return { id: b.id, vertical: !!b.vertical, same, frameMoved: r2(frameMoved), glyphs: ds.length, p50: r2(q(ds, 0.5)), p95: r2(q(ds, 0.95)),
    srcLines: srcStarts.size, laidLines: laidStarts.size, ...(edited ? { other, kept } : {}) };
}

/** Edit mode: the box's first paragraph of two or more source lines gets a short synthetic word, appended to it or
 *  inserted at its second line's start (the runs edited directly, as the editor's typing keeps runs). Returns what was
 *  edited, or null when the box has no such paragraph. */
function applyEdit(b: Box, det: Result, detBox: Result['boxes'][number], chars: Char[], how: 'append' | 'insert'): { para: number; line: number | null } | null {
  const maps = sourceMap(b, det, detBox, chars);
  const k = maps.findIndex((m) => m.starts.length >= 2);
  if (k < 0) return null;
  const p = b.paragraphs[k];
  const WORD = 'zq';
  const text = maps[k].text;
  const at = how === 'append' ? text.length : maps[k].starts[1];
  const ins = how === 'append' ? (/[　-鿿]/u.test(text) ? 'テスト' : ` ${WORD}`) : (/[　-鿿]/u.test(text.slice(at, at + 2)) ? 'テスト' : `${WORD} `);
  let pos = 0;
  for (const r of p.runs) {
    if (at <= pos + r.text.length) { r.text = r.text.slice(0, at - pos) + ins + r.text.slice(at - pos); break; }
    pos += r.text.length;
  }
  b.edited = true;
  return { para: k, line: how === 'append' ? null : 1 };
}

const q = (s: number[], p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

const P = await openPdfium();
const fonts = await loadFonts();
mkdirSync(out, { recursive: true, mode: 0o700 });
const rows: Record<string, unknown>[] = [];
const disp: number[] = [], dispV: number[] = [];
let nBoxes = 0, nSame = 0, nFrame = 0, nV = 0, nVSame = 0, nVFrame = 0, nOther = 0, nKept = 0;
const t0 = performance.now();
for (const c of cases) {
  if (only && !only.includes(c.key)) continue;
  let doc;
  try { doc = P.open(new Uint8Array(readFileSync(c.pdf))); } catch (e) { rows.push({ key: c.key, error: String((e as Error).message).slice(0, 200) }); continue; }
  for (const n of c.pages) {
    if (n - 1 >= doc.pageCount) continue;
    const pg = doc.page(n - 1);
    try {
      const input = readPage(pg);
      const det = detectBoxes(input);
      const page = buildPageFrom(n - 1, input, det);
      const boxes: BoxRow[] = [];
      for (const [k, b] of page.boxes.entries()) {
        if (b.locked) continue;
        const edited = editMode ? applyEdit(b, det, det.boxes[k], input.chars, editMode) : undefined;
        if (edited === null) continue;
        const L = layoutBox(b, fonts);
        const r = measureBox(b, L, det, det.boxes[k], input.chars, disp, dispV, edited);
        nOther += r.other ?? 0; nKept += r.kept ?? 0;
        boxes.push(r);
        if (b.vertical) { nV++; if (r.same) nVSame++; if (r.frameMoved > 1) nVFrame++; }
        else { nBoxes++; if (r.same) nSame++; if (r.frameMoved > 1) nFrame++; }
      }
      rows.push({ key: c.key, page: n, boxes: boxes.length, same: boxes.filter((x) => x.same).length,
        frameMoved: boxes.filter((x) => x.frameMoved > 1).length, worst: boxes.filter((x) => !x.same || x.frameMoved > 1 || x.p95 > 1).map((x) => ({ ...x })) });
    } catch (e) {
      rows.push({ key: c.key, page: n, error: String((e as Error).stack ?? e).slice(0, 400) });
    } finally { pg.close(); }
  }
  doc.close();
}
disp.sort((a, b) => a - b);
dispV.sort((a, b) => a - b);
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
const summary = {
  label, at: new Date().toISOString(), seconds: Math.round((performance.now() - t0) / 1000), cases: cases.length, ...(editMode ? { edit: editMode,
    otherLinesKeptPct: pct(nKept, nOther), otherLines: nOther } : {}),
  horizontal: { boxes: nBoxes, sameBreaksPct: pct(nSame, nBoxes), glyphs: disp.length, dispMedianPt: r2(q(disp, 0.5)), dispP95Pt: r2(q(disp, 0.95)), frameMoved1ptPct: pct(nFrame, nBoxes) },
  vertical: { boxes: nV, sameBreaksPct: pct(nVSame, nV), glyphs: dispV.length, dispMedianPt: r2(q(dispV, 0.5)), dispP95Pt: r2(q(dispV, 0.95)), frameMoved1ptPct: pct(nVFrame, nV) },
  all: { boxes: nBoxes + nV, sameBreaksPct: pct(nSame + nVSame, nBoxes + nV), frameMoved1ptPct: pct(nFrame + nVFrame, nBoxes + nV) },
};
writeFileSync(join(out, `${label}.json`), JSON.stringify({ summary, rows }, null, 1), { mode: 0o600 });
console.log(JSON.stringify(summary, null, 1));
