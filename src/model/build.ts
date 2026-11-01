// Detection (src/layout) + engine characters (src/engine) → the editor's document model (src/model/types.ts).
// Pure TypeScript with no font or DOM dependency, so it runs in the PDFium worker, in Node and in the fitter.
import type { Char, PdfDoc, PdfPage, Rect } from '../engine/pdfium.ts';
import type { PageInput, Result, Shape } from '../layout/types.ts';
import { detectBoxes } from '../layout/detect.ts';
import { isBoldChar } from '../layout/fontstyle.ts';
import type { Box, Doc, FontRef, Page, Paragraph, Picture, RGB, Run, SourceLines, SourceState } from './types.ts';
export { dominantRun, styleKeyOf } from './style.ts';
import { dominantRun } from './style.ts';

// Bold: src/layout/fontstyle.ts (PDFium weight ≥ 600, a bold font name such as W6–W9, DB, B, Bold, Heavy, Black,
// or the ForceBold flag), shared with detection.
const ITALIC_NAME = /italic|oblique/i;
const SERIF_NAME = /serif|mincho|minchō|ming|song|times|georgia|garamond|century|明朝/i;
const SANS_NAME = /sans|gothic|goth|helvetica|arial|meiryo|ゴシック/i;
/** PDF font descriptor flags (PDF 32000 §9.8.2), as PDFium reports them. */
const FLAG_SERIF = 1 << 1;
const FLAG_ITALIC = 1 << 6;

/** Ascent − descent of a typical face, em: where a line box puts its baseline (src/text/layout.ts, CSS model). */
const LINE_AD = 0.8;

/** Frames closer than this (points) touch. */
const TOUCH_TOL = 0.5;

export type BuildOptions = {
  /** The page's characters, text objects and shapes when the caller has read them already (detection needs the
   *  same input), so the page is not read twice. */
  input?: PageInput;
};

/** One page of the model from the engine page and the detector's result for it. */
export function buildPage(page: PdfPage, detection: Result, opts: BuildOptions = {}): Page {
  const input = opts.input ?? readPage(page);
  return buildPageFrom(page.index, input, detection);
}

/** Reads what detection and the model need from an engine page. */
export function readPage(page: PdfPage): PageInput {
  return { w: page.size.w, h: page.size.h, chars: page.chars(), textObjects: page.textObjects(), shapes: page.shapes() };
}

/** Every page: read, detect, build. Pages are closed after reading. */
export function buildDoc(pdf: PdfDoc, opts: { title?: string } = {}): Doc {
  const pages: Page[] = [];
  for (let i = 0; i < pdf.pageCount; i++) pages.push(detectAndBuild(pdf, i));
  return { pages, ...(opts.title ? { title: opts.title } : {}) };
}

/** One page of a document: read, detect, build, close. */
export function detectAndBuild(pdf: PdfDoc, i: number): Page {
  const pg = pdf.page(i);
  try {
    const input = readPage(pg);
    return buildPageFrom(i, input, detectBoxes(input));
  } finally { pg.close(); }
}

/** The model page from the page input (engine data) and its detection result. */
export function buildPageFrom(n: number, input: PageInput, det: Result): Page {
  const chars = input.chars;
  const boxes: Box[] = det.boxes.map((b) => {
    const paragraphs: Paragraph[] = [];
    const srcParas: SourceState['paragraphs'] = [];
    const horizontal = !b.vertical && b.angle === 0;
    const geo: { lines: number; first: number; last: number; size: number }[] = [];
    const srcIn: { lines: number[][]; marker: number[]; baselines: number[] }[] = [];   // for sourceLinesOf
    let lineCount = 0;
    for (const pi of b.paragraphs) {
      const P = det.paragraphs[pi];
      let lineChars: number[] = [];
      for (const li of P.lines) for (const ci of det.lines[li].chars) lineChars.push(ci);
      lineCount += P.lines.length;
      const size = P.size > 0 ? P.size : 10;
      const leading = P.leading > 0 ? round(P.leading / size, 3) : 0;   // one-line paragraphs: filled in below
      const firstBaseline = det.lines[P.lines[0]]?.baseline ?? 0;
      geo.push({ lines: P.lines.length, first: firstBaseline, last: det.lines[P.lines[P.lines.length - 1]]?.baseline ?? firstBaseline, size });
      let text = P.text, indent = P.indent, bullet: string | null = null;
      let extra: Pick<Paragraph, 'bulletStyle' | 'bulletIndent' | 'leftIndent'> = {};
      if (horizontal && P.bullet) {
        const mk = markerOf(P.bullet, P.text, P.lines.map((li) => det.lines[li].chars), chars);
        if (mk) {
          const st = styleOf(chars[mk.chars[0]], new Map());
          bullet = P.bullet;
          text = mk.text;
          indent = mk.indent;
          const drop = new Set(mk.chars);
          lineChars = lineChars.filter((ci) => !drop.has(ci));
          extra = { bulletStyle: { font: { ...st.font }, size: st.size, color: [...st.color] as RGB }, bulletIndent: round(mk.bulletIndent, 2) };
        }
      }
      if (horizontal && (P.align === 'left' || P.align === 'justify' || bullet)) {
        const left = paraLeft(P.lines.map((li) => det.lines[li].chars), chars);
        if (left !== null && left - b.frame.x0 > 0.75) extra.leftIndent = round(left - b.frame.x0, 2);
      }
      paragraphs.push({
        runs: runsOf(text, lineChars, chars), align: P.align, leading, spaceBefore: 0, spaceAfter: 0,
        indent, bullet, ...extra,
      });
      if (horizontal || (b.vertical && b.angle === 0)) {
        const keep = new Set(lineChars);
        srcIn.push({ lines: P.lines.map((li) => det.lines[li].chars.filter((ci) => keep.has(ci))),
          marker: bullet ? (det.lines[P.lines[0]]?.chars ?? []).filter((ci) => !keep.has(ci)) : [], baselines: P.lines.map((li) => det.lines[li].baseline) });
      }
      srcParas.push({ text: P.text, size, align: P.align, leading });
    }
    // One-line paragraphs have no leading of their own: the box's multi-line paragraphs of about the same size give
    // it, else the baseline step to the nearest line above or below on the page that overlaps it and has about its
    // size, when that step is a plausible leading (1.05–2.3 em), else 1.2. Vertical boxes: 1.2.
    paragraphs.forEach((p, k) => {
      if (p.leading > 0) return;
      if (!horizontal) { p.leading = 1.2; srcParas[k].leading = 1.2; return; }
      const g = geo[k];
      const same = paragraphs.filter((q, j) => j !== k && geo[j].lines > 1 && Math.abs(geo[j].size - g.size) <= 0.1 * g.size).map((q) => q.leading);
      const lead = same.length ? medianOf(same) : neighbourLeading(det, det.paragraphs[b.paragraphs[k]].lines[0]);
      p.leading = lead || 1.2;
      srcParas[k].leading = p.leading;
    });
    // Space before a paragraph: the source's baseline step from the previous paragraph's last line, less what the
    // layout's line boxes put there (half of each line's leading box around an ascent − descent of about 0.8 em;
    // for two paragraphs of one size and leading, step − leading × size).
    if (horizontal) {
      for (let k = 1; k < paragraphs.length; k++) {
        const a = geo[k - 1], c = geo[k];
        const step = a.last - c.first;
        const boxes = (a.size * (paragraphs[k - 1].leading - LINE_AD)) / 2 + (c.size * (paragraphs[k].leading + LINE_AD)) / 2;
        paragraphs[k].spaceBefore = Math.max(0, round(step - boxes, 2));
      }
    }
    // where the source drew each paragraph's lines, for the keep-source-lines layout (src/model/layout.ts)
    if (srcIn.length === paragraphs.length) {
      let prevId = -1;
      paragraphs.forEach((p, k) => {
        const src = sourceLinesOf(p, srcIn[k], chars, horizontal ? b.frame.x1 : -b.frame.y0, prevId, !horizontal);
        if (src) { p.src = src; prevId = src.ids[src.ids.length - 1]; } else prevId = -1;
      });
    }
    const firstLine = det.lines[det.paragraphs[b.paragraphs[0]]?.lines[0]];
    const allRuns = paragraphs.flatMap((p) => p.runs);
    const source: SourceState = {
      frame: { ...b.frame }, lines: lineCount, paragraphs: srcParas, objs: [...b.objs], chars: [...b.chars],
      panel: b.panel !== null && det.panels[b.panel] ? { ...det.panels[b.panel].frame } : null,
      neighbours: [],
      baseline: firstLine && !b.vertical && b.angle === 0 ? round(b.frame.y1 - firstLine.baseline, 3) : undefined,
      charSpacing: medianOf(allRuns.filter((r) => r.text.trim()).map((r) => r.charSpacing)),
      angle: b.angle,
      // vertical lines: Line.baseline is the x of the column's centre axis
      ...(firstLine && b.vertical ? { axis: round(b.frame.x1 - firstLine.baseline, 3) } : {}),
    };
    const rot = rotOf(b.angle);
    return {
      id: b.id, kind: b.kind, frame: { ...b.frame }, rot, vertical: b.vertical, paragraphs, source, edited: false,
      // vertical text is laid out in columns (layout.ts) and written with Identity-V fonts; rotated text stays locked
      locked: !b.vertical && b.angle !== 0 ? 'rotated text' : null,
      heightPinned: false, writingMode: b.vertical ? 'vertical-rl' : 'horizontal-tb',
    };
  });
  // neighbours: boxes whose source frames touch or overlap
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (gap(boxes[i].frame, boxes[j].frame) <= TOUCH_TOL) {
        boxes[i].source.neighbours.push(boxes[j].id);
        boxes[j].source.neighbours.push(boxes[i].id);
      }
    }
  }
  return {
    n, w: input.w, h: input.h, boxes,
    panels: det.panels.map((p) => ({ ...p.frame })),
    obstacles: obstaclesOf(input.shapes),
    pictures: picturesOf(input.shapes, boxes, input.w, input.h),
    rules: input.shapes.filter((s) => s.kind === 'path' && (s.isRule || s.isStrokeLine)).map((s) => ({ ...s.bounds })),
    fills: fillsOf(input.shapes, input.w, input.h),
  };
}

/** Filled rectangles smaller than most of the page (cells, chart bars, cards, panels): page backgrounds excluded. */
export function fillsOf(shapes: Shape[], w: number, h: number): Rect[] {
  return shapes.filter((s) => s.kind === 'path' && (s.isRect || s.rects) && !s.isRule && s.fill !== null && s.fill[3] > 0)
    .flatMap((s) => s.rects ?? [s.bounds]).filter((r) => area(r) < 0.6 * w * h && Math.min(r.x1 - r.x0, r.y1 - r.y0) >= 1.5)
    .map((r) => ({ ...r }));
}

/**
 * Where the source drew a paragraph (src/model/types.ts SourceLines): its text aligned to its ink characters as
 * runsOf aligns them (a text character takes the next matching ink character; inserted spaces take none), then per
 * line the offset it starts at, its baseline and right edge, a dropped line-end hyphen, and whether it ends well
 * short of the measure (the next line's first word would have fitted: a deliberate break); per offset the origin x and
 * the advance to the next character on the line. Null when the text and the characters do not line up.
 */
export function sourceLinesOf(p: Paragraph, inp: { lines: number[][]; marker: number[]; baselines: number[] }, chars: Char[],
  frameRight: number, prevId: number, vertical = false): SourceLines | null {
  const text = p.runs.map((r) => r.text).join('');
  const isInk = (c: Char | undefined) => !!c && !c.generated && c.unicode !== '';
  const ink: { ci: number; line: number }[] = [];
  inp.lines.forEach((cs, li) => { for (const ci of cs) if (isInk(chars[ci])) ink.push({ ci, line: li }); });
  if (!text || !ink.length) return null;
  const n = text.length;
  const at = new Array<number>(n).fill(-1);            // per offset: index into ink
  let j = 0, off = 0, matched = 0;
  for (const ch of text) {
    // a space matches only the next character (an inserted space must not swallow a real one further on)
    const k = nextMatch(ch, j, ink.length, (q) => chars[ink[q].ci].unicode);
    if (k >= 0) { at[off] = k; j = k + 1; matched++; }
    off += ch.length;
  }
  // the text must line up with the characters (PDFium may report a character twice: a fake bold drawn twice)
  const dark = [...text].filter((ch) => !/\s/u.test(ch)).length;
  if (matched < 0.8 * dark || matched < 0.4 * ink.filter((e) => !/^\s+$/u.test(chars[e.ci].unicode)).length) return null;
  // positions along the line: x (horizontal), or down the column as -y of a character's em box top (vertical: the
  // origin PDFium reports is the glyph's horizontal origin, 0.88 em below the top: the usual vertical origin, DW2 880,
  // which the shipped Japanese face has too)
  const em = (c: Char) => (c.fontSize > 0 ? c.fontSize : Math.max(1, c.box.y1 - c.box.y0));
  const pos = vertical ? (c: Char) => -(c.origin[1] + V_ORIGIN * em(c)) : (c: Char) => c.origin[0];
  const right = vertical ? (c: Char) => -(c.origin[1] - (1 - V_ORIGIN) * em(c)) : (c: Char) => (c.loose.x1 > c.loose.x0 ? c.loose.x1 : c.box.x1);
  const lineOf = (o: number) => (at[o] >= 0 ? ink[at[o]].line : -1);
  // line starts: the first offset holding a character of the line (a line none of whose characters matched joins
  // the line before)
  const starts: number[] = [], lineIdx: number[] = [];
  for (let o = 0; o < n; o++) {
    const li = lineOf(o);
    if (li >= 0 && (!lineIdx.length || li > lineIdx[lineIdx.length - 1])) { starts.push(lineIdx.length ? o : 0); lineIdx.push(li); }
  }
  if (!starts.length) return null;
  // per offset: origin x and advance
  const x: (number | null)[] = new Array(n).fill(null);
  const adv: (number | null)[] = new Array(n).fill(null);
  const next = (o: number) => o + (text.codePointAt(o)! > 0xffff ? 2 : 1);
  for (let o = 0; o < n; o = next(o)) {
    if (at[o] < 0) continue;
    const c = chars[ink[at[o]].ci];
    x[o] = round(pos(c), 2);
    const q = next(o);
    adv[o] = round(q < n && at[q] >= 0 && lineOf(q) === lineOf(o) ? pos(chars[ink[at[q]].ci]) - pos(c) : right(c) - pos(c), 2);
  }
  // inserted characters: between two characters of one line they share the gap; elsewhere they have no advance
  for (let o = 0; o < n;) {
    if (at[o] >= 0 || (o > 0 && text.charCodeAt(o) >= 0xdc00 && text.charCodeAt(o) <= 0xdfff)) { o++; continue; }
    let e = o;
    while (e < n && at[e] < 0) e++;
    let pv = o - 1;
    while (pv >= 0 && at[pv] < 0) pv--;
    const a = pv >= 0 ? chars[ink[at[pv]].ci] : null;
    const b = e < n ? chars[ink[at[e]].ci] : null;
    const same = a && b && lineOf(pv) === lineOf(e);
    const from = a ? right(a) : null;
    const gap = same ? Math.max(0, pos(b!) - from!) / (e - o) : null;
    for (let k = o; k < e; k++) {
      x[k] = from === null ? null : round(from + (gap ?? 0) * (k - o), 2);
      adv[k] = gap === null ? null : round(gap, 2);
    }
    if (same && pv >= 0) adv[pv] = round(right(a!) - pos(a!), 2);
    o = e;
  }
  const L = starts.length;
  const base: number[] = [], ids: number[] = [], prev: number[] = [], end: number[] = [], hyphen: (number | null)[] = [];
  const used = new Set(at.filter((k) => k >= 0));
  for (let k = 0; k < L; k++) {
    const li = lineIdx[k];
    const allInk = ink.map((e, i) => ({ ...e, i })).filter((e) => e.line === li);
    const dark = allInk.filter((e) => !/^\s+$/u.test(chars[e.ci].unicode));
    const lineInk = dark.length ? dark : allInk;
    base.push(round(inp.baselines[li] ?? 0, 3));
    ids.push(allInk[0]?.ci ?? -1);
    prev.push(k === 0 ? prevId : ids[k - 1]);
    end.push(round(Math.max(...lineInk.map((e) => right(chars[e.ci]))), 2));
    const last = lineInk[lineInk.length - 1];
    hyphen.push(!vertical && last && !used.has(last.i) && /^[-‐­]$/u.test(chars[last.ci].unicode) ? round(chars[last.ci].origin[0], 2) : null);
  }
  // deliberate breaks: the line ends short by more than the next line's first word (and a space) plus a margin
  const size = dominantRun(p.runs)?.size ?? 10;
  const spaces = adv.filter((a, o) => a !== null && text[o] === ' ') as number[];
  const space = spaces.length ? Math.min(medianOf(spaces), 0.4 * size) : 0.28 * size;
  const width = (k: number) => end[k] - (x[starts[k]] ?? end[k]);
  const widest = Math.max(...end.map((_, k) => width(k)));
  const rightMost = Math.max(...end);
  const hard: boolean[] = [];
  for (let k = 0; k < L; k++) {
    if (k === L - 1) { hard.push(false); continue; }
    const s1 = starts[k + 1], e1 = k + 2 < L ? starts[k + 2] : n;
    let w = 0;
    for (let o = s1; o < e1; o = next(o)) {
      const cp = text.codePointAt(o)!;
      if (/\s/u.test(text[o])) break;
      w += adv[o] ?? 0.5 * size;
      if (isCjkCodePoint(cp) && !(o + 1 < e1 && /^[、。，．・：；？！）」』】〕ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]$/u.test(text[next(o)]))) break;
    }
    const join = /\s/u.test(text[s1 - 1] ?? '') ? space : 0;
    const tol = Math.max(1, 0.25 * size);
    const room = p.align === 'center' || p.align === 'right' ? widest - width(k) : (p.align === 'justify' ? rightMost : frameRight) - end[k];
    hard.push(room > join + w + tol);
  }
  // characters off their line's baseline (a raised or lowered figure), when any is
  const rise = new Array<number>(n).fill(0);
  let raised = false;
  for (let o = 0; o < n && !vertical; o++) {
    if (at[o] < 0) continue;
    const k = starts.findLastIndex((s0) => s0 <= o);
    const r = round(chars[ink[at[o]].ci].origin[1] - (base[Math.max(0, k)] ?? 0), 2);
    if (Math.abs(r) > 0.3) { rise[o] = r; raised = true; }
  }
  let marker: number[] | undefined;
  if (p.bullet && inp.marker.length) {
    const mk = inp.marker.filter((ci) => isInk(chars[ci]));
    const xs: number[] = [];
    let i = 0, lastX = mk.length ? chars[mk[0]].origin[0] : 0;
    for (let u = 0; u < p.bullet.length; u++) {
      if (/\s/u.test(p.bullet[u]) || i >= mk.length) { xs.push(round(lastX, 2)); continue; }
      const c = chars[mk[i++]];
      xs.push(round(c.origin[0], 2));
      lastX = right(c);
    }
    marker = xs;
  }
  return { text, starts, base, ids, prev, end, hard, hyphen, x, adv, ...(marker ? { marker } : {}), ...(raised ? { rise } : {}), ...(vertical ? { vertical: true } : {}),
    size, leading: p.leading, align: p.align, indent: p.indent };
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

/** The vertical origin's height above the horizontal origin, em (PDF DW2 default 880). */
const V_ORIGIN = 0.88;

function isCjkCodePoint(cp: number): boolean {
  return (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0xac00 && cp <= 0xd7af);
}

/** Pictures text must not grow over: images, shadings and drawn figures (paths of many segments). */
export function obstaclesOf(shapes: Shape[]): Rect[] {
  return shapes.filter((s) => s.kind === 'image' || s.kind === 'shading' ||
    (s.kind === 'path' && !s.isRule && !s.isRect && s.segments > 8 && area(s.bounds) > 100)).map((s) => ({ ...s.bounds }));   // icons from 10 × 10 pt
}

/** The obstacles the fitter may move or shrink: images, and figures drawn as one path object. A picture stays fixed
 *  when text lies on it, when another object overlaps it (an outline, an overlay, a figure of several paths) unless
 *  that object holds it with room on every side (a panel), or when it covers most of the page (a background). */
export function picturesOf(shapes: Shape[], boxes: Box[], w: number, h: number): Picture[] {
  const isFigure = (s: Shape) => s.kind === 'path' && !s.isRule && !s.isRect && s.segments > 8 && area(s.bounds) > 400;
  const over = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > TOUCH_TOL && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > TOUCH_TOL;
  const holds = (a: Rect, b: Rect) => a.x0 <= b.x0 - 3 && a.y0 <= b.y0 - 3 && a.x1 >= b.x1 + 3 && a.y1 >= b.y1 + 3;
  const out: Picture[] = [];
  for (const s of shapes) {
    if (s.kind !== 'image' && !isFigure(s)) continue;
    const f = s.bounds;
    if (area(f) <= 0 || area(f) > 0.6 * w * h) continue;
    if (boxes.some((b) => over(b.source.frame, f))) continue;
    if (shapes.some((o) => o !== s && over(o.bounds, f) && !holds(o.bounds, f))) continue;
    out.push({ id: `pic${s.index}`, kind: s.kind === 'image' ? 'image' : 'figure', frame: { ...f }, z: s.z, objs: [s.index] });
  }
  return out;
}

/** The marker's characters on a bullet paragraph's first line, the text without it, the distance from the marker's
 *  left edge to the text start, and the first-line indent relative to the continuation lines (with a marker: how
 *  far the first line's text starts right of them, 0 when they hang under the text). Null when the marker cannot be
 *  told apart from the text. */
function markerOf(bullet: string, text: string, lineChars: number[][], chars: Char[]):
  { chars: number[]; text: string; bulletIndent: number; indent: number } | null {
  if (!text.startsWith(bullet)) return null;
  const ink = (cs: number[]) => cs.filter((i) => { const c = chars[i]; return c && !c.generated && c.unicode && !/^\s+$/u.test(c.unicode); });
  const first = ink(lineChars[0] ?? []);
  const k = [...bullet.replace(/\s+/gu, '')].length;
  if (first.length <= k) return null;
  const left = (i: number) => { const c = chars[i]; return c.loose.x1 > c.loose.x0 ? c.loose.x0 : c.box.x0; };
  const m0 = left(first[0]), t0 = left(first[k]);
  if (!(t0 > m0)) return null;
  let indent = 0;
  const conts = lineChars.slice(1).map(ink).filter((cs) => cs.length).map((cs) => left(cs[0]));
  if (conts.length) {
    indent = round(t0 - medianOf(conts), 2);
    if (Math.abs(indent) < 0.75) indent = 0;
  }
  return { chars: first.slice(0, k), text: text.slice(bullet.length).replace(/^[\s\u3000]+/u, ''), bulletIndent: t0 - m0, indent };
}

/** The baseline step (× size) from a line to the nearest horizontal line above or below it that overlaps it along
 *  and has about its size, when the step is a plausible leading (1.05–2.3 em); else 0. */
function neighbourLeading(det: Result, li: number): number {
  const L = det.lines[li];
  if (!L || L.vertical || L.angle !== 0) return 0;
  let best = Infinity;
  for (const [j, M] of det.lines.entries()) {
    if (j === li || M.vertical || M.angle !== 0) continue;
    if (Math.abs(M.size - L.size) > 0.2 * Math.max(M.size, L.size)) continue;
    if (Math.min(M.box.x1, L.box.x1) - Math.max(M.box.x0, L.box.x0) <= 0) continue;
    const r = Math.abs(M.baseline - L.baseline) / Math.max(M.size, L.size);
    if (r >= 1.05 && r <= 2.3 && r < best) best = r;
  }
  return Number.isFinite(best) ? round(best, 3) : 0;
}

/** The paragraph's leftmost line start (its first ink character's left edge), or null. */
function paraLeft(lineChars: number[][], chars: Char[]): number | null {
  let x: number | null = null;
  for (const cs of lineChars) {
    const i = cs.find((j) => { const c = chars[j]; return c && !c.generated && c.unicode && !/^\s+$/u.test(c.unicode); });
    if (i === undefined) continue;
    const c = chars[i];
    const l = c.loose.x1 > c.loose.x0 ? c.loose.x0 : c.box.x0;
    x = x === null ? l : Math.min(x, l);
  }
  return x;
}

type Style = { font: FontRef; size: number; color: RGB; bold: boolean; italic: boolean; key: string };

/** Styles per character, then runs over the paragraph text. The paragraph text has spaces the detector inserted
 *  (word gaps, line joins) and lacks dropped soft hyphens, so characters are aligned to the text greedily: a text
 *  character that matches the next ink character takes its style; an inserted one takes the previous style. */
export function runsOf(text: string, charIdx: number[], chars: Char[]): Run[] {
  const ink = charIdx.map((i) => chars[i]).filter((c) => c && !c.generated && c.unicode !== '');
  const styleCache = new Map<string, Style>();
  const styles: (Style | null)[] = [];
  const csOf: (number | null)[] = [];
  const cps = Array.from(text);
  let j = 0;
  let prev: Style | null = null;
  for (const ch of cps) {
    let k = j;
    // look a few characters ahead for the match (skipped ink: a dropped hyphen, a duplicate PDFium reported)
    while (k < ink.length && k < j + 4 && ink[k].unicode !== ch) k++;
    if (k < ink.length && ink[k].unicode === ch) {
      const c = ink[k];
      const st = styleOf(c, styleCache);
      styles.push(st);
      csOf.push(spacingAfter(c, ink[k + 1]));
      prev = st;
      j = k + 1;
    } else {
      styles.push(prev);
      csOf.push(null);
    }
  }
  // characters before the first matched one take the first style
  const first = styles.find((s) => s) ?? (ink[0] ? styleOf(ink[0], styleCache) : defaultStyle());
  const runs: Run[] = [];
  let cur: { st: Style; text: string; cs: number[] } | null = null;
  const flush = () => {
    if (!cur) return;
    runs.push({
      text: cur.text, font: { ...cur.st.font }, size: cur.st.size, color: [...cur.st.color] as RGB,
      charSpacing: spacingEstimate(cur.cs, cur.st.size), bold: cur.st.bold, italic: cur.st.italic, underline: false,
    });
  };
  cps.forEach((ch, k) => {
    const st = styles[k] ?? first;
    if (!cur || cur.st.key !== st.key) { flush(); cur = { st, text: '', cs: [] }; }
    cur.text += ch;
    const cs = csOf[k];
    if (cs !== null) cur.cs.push(cs);
  });
  flush();
  if (!runs.length) {
    const st = first;
    runs.push({ text: '', font: { ...st.font }, size: st.size, color: [...st.color] as RGB, charSpacing: 0, bold: st.bold, italic: st.italic, underline: false });
  }
  return runs;
}

function styleOf(c: Char, cache: Map<string, Style>): Style {
  const size = round(c.fontSize > 0 ? c.fontSize : Math.max(1, c.box.y1 - c.box.y0), 2);
  // the colour the text shows in: the fill, or the stroke for outline-only text (render mode 1) and for hollow
  // outlined text (mode 2 with a near-white fill and a darker stroke), which new text is set solid in
  const lum = (k: number[]) => (0.299 * k[0] + 0.587 * k[1] + 0.114 * k[2]) / 255;
  const useStroke = !!c.stroke && (c.renderMode === 1 || (c.renderMode === 2 && lum(c.fill) > 0.85 && lum(c.stroke) < lum(c.fill) - 0.25));
  const k = useStroke ? c.stroke! : c.fill;
  const color: RGB = [round(k[0] / 255, 4), round(k[1] / 255, 4), round(k[2] / 255, 4)];
  const key = `${c.fontName}|${size}|${color.join(',')}|${c.weight}|${c.fontFlags}`;
  let st = cache.get(key);
  if (st) return st;
  const name = c.fontName;
  const bold = isBoldChar(c);
  const italic = ITALIC_NAME.test(name) || (c.fontFlags >= 0 && (c.fontFlags & FLAG_ITALIC) !== 0);
  const serif = SERIF_NAME.test(name) || (!SANS_NAME.test(name) && c.fontFlags >= 0 && (c.fontFlags & FLAG_SERIF) !== 0);
  st = { font: { source: 'document', name, bold, italic, serif }, size, color, bold, italic, key };
  cache.set(key, st);
  return st;
}

function defaultStyle(): Style {
  return { font: { source: 'document', name: '', bold: false, italic: false, serif: false }, size: 10, color: [0, 0, 0], bold: false, italic: false, key: '' };
}

/** The space between a character's advance and the next character's origin, in the same text object on the same
 *  baseline: the character spacing (Tc) plus any TJ adjustment. Word spaces and other objects are not measured. */
function spacingAfter(c: Char, next: Char | undefined): number | null {
  if (!next || next.obj !== c.obj || c.obj < 0) return null;
  if (c.angle !== 0 || next.angle !== 0) return null;
  if (/\s/.test(c.unicode) || /\s/.test(next.unicode)) return null;
  if (Math.abs(next.origin[1] - c.origin[1]) > 0.1 * c.fontSize) return null;
  if (c.loose.x1 <= c.loose.x0) return null;
  const gap = next.origin[0] - c.loose.x1;
  if (Math.abs(gap) > c.fontSize) return null;   // a jump, not spacing
  return gap;
}

/** The median gap, rounded; noise under 2% of the size is 0. */
function spacingEstimate(gaps: number[], size: number): number {
  if (!gaps.length) return 0;
  const m = medianOf(gaps);
  return Math.abs(m) < 0.02 * size ? 0 : round(m, 2);
}

function medianOf(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

function rotOf(angle: number): 0 | 90 | 180 | 270 {
  const a = ((Math.round(angle / 90) * 90) % 360 + 360) % 360;
  return a as 0 | 90 | 180 | 270;
}

function gap(a: Rect, b: Rect): number {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1));
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1));
  return Math.hypot(dx, dy);
}

const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const round = (x: number, d: number) => { const f = 10 ** d; return Math.round(x * f) / f; };
