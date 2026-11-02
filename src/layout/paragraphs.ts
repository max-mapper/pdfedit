// Lines → paragraphs. Lines are taken top to bottom (in their direction's frame); a
// line joins the open paragraph above it in the same direction, panel and table cell when:
//   the baseline step is under paraStep × size (and, once the paragraph has a leading, under leading +
//   leadingJump × size), sizes agree within sizeTol, the lines overlap along, the alignment is compatible (left,
//   right or centre edges within alignTol em, or a first-line / hanging indent up to maxIndent em), no rule lies
//   between, the line does not start with a bullet or number, it is not an indented line after a short line,
//   and its style matches the line above: the same weight (bold or regular) and fill colour, the bullet itself not
//   counted (so a coloured bullet with a bold title, then a regular description, are two paragraphs; a bullet line
//   and an indented continuation in the same style stay one).
// A paragraph is closed once another paragraph's line lands below it over the same columns.
import type { Paragraph, Thresholds } from './types.ts';
import type { LineRec } from './lines.ts';
import { isCjkCp, lastCp, median, overlap, spread, union } from './geom.ts';
import type { Rect } from './types.ts';
import type { Par, Seg } from './rules.ts';
import { parBetween, parallelBarriers } from './rules.ts';

export type ParaRec = Omit<Paragraph, 'lines'> & {
  lines: number[];   // indices into the LineRec array
  group: string; s0: number; s1: number; lo: number; hi: number; cell: number; panel: number; vertical: boolean; angle: number;
};

const BULLETS = new Set(['•', '・', '●', '○', '■', '□', '◆', '◇', '▶', '►', '‐', '-', '*', '※', '◦', '‣', '▪', '–',
  '➢', '➤', '➣', '➔', '➜', '➨', '→', '⇒', '✓', '✔', '❖', '♦', '◎', '★', '☆', '▸', '▹', '▷']);
/** Symbol-font characters (Wingdings, Symbol, OpenSymbol) that PDFs report in the private-use block U+F020–U+F0FF:
 *  at the start of a line they are list markers (U+F0D8 is Wingdings' arrowhead, U+F0A7 its small square, …). */
const symbolPua = (ch: string) => { const cp = ch.codePointAt(0) ?? 0; return cp >= 0xf020 && cp <= 0xf0ff; };
const NEEDS_GAP = new Set(['‐', '-', '*', '–']);
const CIRCLED = /^[①-⑳⑴-⒇]/u;   // ①–⑳, ⑴–⒇
const NUMBERED = /^(\([0-9０-９]{1,3}\)|（[0-9０-９]{1,3}）|[0-9０-９]{1,3}[.)．）](?![0-9])|[a-zA-Z][.)](?![a-zA-Z0-9]))/u;

/** A character that is a list marker on its own (a bullet, a circled number, a symbol-font marker). */
export const isMarkerChar = (ch: string) => BULLETS.has(ch) || CIRCLED.test(ch) || symbolPua(ch);

/** The list marker a line starts with, or null. A marker needs text after it. */
export function bulletOf(L: LineRec): string | null {
  if (!L.words.length) return null;
  const first = L.ink[0].ch;
  if (BULLETS.has(first) || CIRCLED.test(first) || symbolPua(first)) {
    if (L.ink.length < 2) return null;
    if (NEEDS_GAP.has(first) && !(L.words[0].text === first && L.words.length > 1)) return null;
    return first;
  }
  const m = NUMBERED.exec(L.text);
  if (!m) return null;
  const rest = L.text.slice(m[0].length);
  if (!rest.trim()) return null;
  // "1." / "a." / "A)" need a space or a CJK character after them; parenthesised forms do not
  if (!/^[(（]/.test(m[0]) && !/^\s/.test(rest) && !isCjkCp(rest.codePointAt(0)!)) return null;
  return m[0];
}

type Open = { lines: number[]; s0: number; s1: number; open: boolean; bullet: string | null };

/** A line's style, its list marker not counted: weight by majority, fill colour and size by the most characters. */
export type LineStyle = { bold: boolean; color: number; size: number };

export function lineStyle(L: LineRec, bullet: string | null): LineStyle {
  let ink = L.ink;
  if (bullet) {
    const k = [...bullet.replace(/\s+/gu, '')].length;
    if (ink.length > k) ink = ink.slice(k);
  }
  let bold = 0;
  const colors = new Map<number, number>(), sizes = new Map<number, number>();
  for (const g of ink) {
    if (g.bold) bold++;
    colors.set(g.color, (colors.get(g.color) ?? 0) + 1);
    const k = Math.round(g.size * 10) / 10;
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
  }
  const mode = (m: Map<number, number>, dflt: number) => { let best = dflt, n = -1; for (const [k, c] of m) if (c > n) { best = k; n = c; } return best; };
  return { bold: bold * 2 > ink.length, color: mode(colors, 0), size: mode(sizes, L.size) };
}

/** Fill colours differ when a channel differs by more than this (0–255). */
const COLOR_TOL = 48;

export function sameStyle(a: LineStyle, b: LineStyle, th: Pick<Thresholds, 'sizeTol'>): boolean {
  if (a.bold !== b.bold) return false;
  for (const sh of [16, 8, 0]) if (Math.abs(((a.color >> sh) & 255) - ((b.color >> sh) & 255)) > COLOR_TOL) return false;
  return Math.abs(a.size - b.size) <= th.sizeTol * Math.max(a.size, b.size);
}

export function buildParagraphs(lines: LineRec[], segs: Seg[], th: Thresholds): ParaRec[] {
  const bars = new Map<string, Par[]>();
  const barsOf = (L: LineRec) => { let b = bars.get(L.group); if (!b) bars.set(L.group, (b = parallelBarriers(segs, L.frame))); return b; };
  const bullets = lines.map(bulletOf);
  const styles = lines.map((L, i) => lineStyle(L, bullets[i]));
  const order = lines.map((_, i) => i).sort((a, b) => (lines[a].group < lines[b].group ? -1 : lines[a].group > lines[b].group ? 1 : 0) ||
    lines[b].v - lines[a].v || lines[a].s0 - lines[b].s0);
  const paras: Open[] = [];
  const steps = (P: Open) => P.lines.slice(1).map((k, j) => lines[P.lines[j]].v - lines[k].v);
  for (const li of order) {
    const L = lines[li];
    let best: Open | null = null, bestScore = Infinity;
    for (const P of paras) {
      if (!P.open) continue;
      const qi = P.lines[P.lines.length - 1], Q = lines[qi];
      if (Q.group !== L.group || Q.cell !== L.cell || Q.panel !== L.panel) continue;
      const size = Math.max(Q.size, L.size), step = Q.v - L.v;
      const wide = Math.abs(Q.size - L.size) <= 0.03 * size && styles[qi].bold === styles[li].bold;
      if (step <= 0.3 * size || step > (wide ? th.paraStepWide : th.paraStep) * size) continue;
      if (Math.abs(Q.size - L.size) > th.sizeTol * size) continue;
      const ov = overlap(P.s0, P.s1, L.s0, L.s1);
      if (ov <= 0) continue;
      if (bullets[li]) continue;
      if (P.lines.length >= 2 && step > median(steps(P)) + th.leadingJump * size) continue;
      if (!sameStyle(styles[qi], styles[li], th)) continue;   // bold ↔ regular, another colour, another size
      if (parBetween(barsOf(L), L.v, Q.v, Math.max(P.s0, L.s0), Math.min(P.s1, L.s1))) continue;
      if (!compatible(P, L, lines, th)) continue;
      if (shortThenIndent(P, L, lines, th)) continue;
      if (bulletTitle(P, L, lines, th)) continue;
      const score = step - 0.01 * ov;
      if (score < bestScore) { best = P; bestScore = score; }
    }
    const target = best ?? { lines: [], s0: L.s0, s1: L.s1, open: true, bullet: bullets[li] };
    if (!best) paras.push(target);
    target.lines.push(li);
    target.s0 = Math.min(target.s0, L.s0); target.s1 = Math.max(target.s1, L.s1);
    // close paragraphs this line now sits under
    for (const P of paras) {
      if (P === target || !P.open) continue;
      const Q = lines[P.lines[P.lines.length - 1]];
      if (Q.group !== L.group || Q.v - L.v <= 0.3 * L.size) continue;
      const ov = overlap(P.s0, P.s1, L.s0, L.s1);
      if (ov > 0.3 * Math.min(P.s1 - P.s0, L.s1 - L.s0)) P.open = false;
      else if (Q.v - L.v > th.paraStep * 2 * Math.max(Q.size, L.size)) P.open = false;
    }
  }
  return paras.map((P) => finishParagraph(P, lines, th));
}

function compatible(P: Open, L: LineRec, lines: LineRec[], th: Thresholds): boolean {
  const em = L.size, tol = th.alignTol * em;
  const F = lines[P.lines[0]];
  const mid = (l: { s0: number; s1: number }) => (l.s0 + l.s1) / 2;
  if (P.lines.length === 1) {
    if (Math.abs(L.s0 - F.s0) <= tol || Math.abs(L.s1 - F.s1) <= tol || Math.abs(mid(L) - mid(F)) <= tol) return true;
    if (L.s0 < F.s0 && F.s0 - L.s0 <= th.maxIndent * em) return true;                      // first-line indent
    if (L.s0 > F.s0 && L.s0 - F.s0 <= th.maxIndent * em && (P.bullet !== null || F.s1 >= L.s1 - tol)) return true;   // hanging
    return false;
  }
  const body = P.lines.slice(1).map((k) => lines[k]);
  if (Math.abs(L.s0 - median(body.map((l) => l.s0))) <= tol) return true;
  const all = P.lines.map((k) => lines[k]);
  if (spread(all.map(mid)) <= tol && Math.abs(mid(L) - median(all.map(mid))) <= tol) return true;
  if (spread(all.map((l) => l.s1)) <= tol && Math.abs(L.s1 - median(all.map((l) => l.s1))) <= tol) return true;
  return false;
}

function shortThenIndent(P: Open, L: LineRec, lines: LineRec[], th: Thresholds): boolean {
  const em = L.size;
  const Q = lines[P.lines[P.lines.length - 1]];
  if (Math.abs((Q.s0 + Q.s1) / 2 - (L.s0 + L.s1) / 2) <= th.alignTol * em) return false;   // centred lines
  const right = Math.max(P.s1, L.s1);
  if (Q.s1 >= right - th.shortLine * em) return false;
  const bodyLeft = P.lines.length >= 2 ? median(P.lines.slice(1).map((k) => lines[k].s0)) : lines[P.lines[0]].s0;
  return L.s0 > bodyLeft + 0.5 * em;
}

/** A bulleted Japanese line that ends well short of the measure is a title: Japanese wraps at the full measure, so
 *  the line after it starts the item's description (its own paragraph), not a continuation. Only for a bullet item's
 *  first line: hand-broken headings and table cells stay one paragraph for editing. */
function bulletTitle(P: Open, L: LineRec, lines: LineRec[], th: Thresholds): boolean {
  if (P.bullet === null || P.lines.length !== 1) return false;
  const Q = lines[P.lines[0]];
  if (!isCjkCp(lastCp(Q.text))) return false;
  // a title is clearly short: under 60% of the measure as well as short of it by the short-line distance (a first
  // line that stops a character or two early is a kinsoku wrap, not a title)
  const left = Math.min(P.s0, L.s0), right = Math.max(P.s1, L.s1);
  return Q.s1 < right - th.shortLine * L.size && Q.s1 - left < 0.6 * (right - left);
}

/** Joins line texts: no space between CJK lines (either side CJK), a soft or generated hyphen is dropped, a real
 *  hyphen before a lowercase letter is kept with no space, otherwise one space. */
export function joinLines(ls: LineRec[]): string {
  let out = '';
  for (const [k, L] of ls.entries()) {
    if (k === 0) { out = L.text; continue; }
    const P = ls[k - 1];
    const first = L.text.codePointAt(0) ?? 0;
    if (P.softEnd === 'char') out = out.replace(/-$/, '') + L.text;
    else if (P.softEnd === 'generated') out += L.text;
    else if (isCjkCp(lastCp(out)) || isCjkCp(first)) out += L.text;
    else if (/[-‐]$/.test(out) && /^\p{Ll}/u.test(L.text)) out += L.text;
    else out += ' ' + L.text;
  }
  return out;
}

function finishParagraph(P: Open, lines: LineRec[], th: Thresholds): ParaRec {
  const ls = P.lines.map((k) => lines[k]).sort((a, b) => b.v - a.v);
  const idx = [...P.lines].sort((a, b) => lines[b].v - lines[a].v);
  const n = ls.length;
  const size = median(ls.flatMap((l) => Array(l.ink.length).fill(l.size)));
  const strict = Math.max(th.alignStrictPt, th.alignStrict * size);
  const lefts = ls.map((l) => l.s0), rights = ls.map((l) => l.s1), mids = ls.map((l) => (l.s0 + l.s1) / 2);
  let align: Paragraph['align'] = 'left';
  if (n === 2) {
    const leftsAgree = Math.abs(lefts[0] - lefts[1]) <= strict, rightsAgree = Math.abs(rights[0] - rights[1]) <= strict;
    if (leftsAgree) align = rightsAgree ? 'justify' : 'left';
    else if (Math.abs(mids[0] - mids[1]) <= strict) align = 'center';
    else if (rightsAgree) align = lefts[0] > lefts[1] && lefts[0] - lefts[1] <= th.maxIndent * size ? 'justify' : 'right';
    else align = 'left';
  } else if (n >= 3) {
    const bodyLefts = spread(lefts.slice(1)) <= strict;
    if (bodyLefts && spread(rights.slice(0, -1)) <= strict) align = 'justify';
    else if (bodyLefts && Math.abs(lefts[0] - median(lefts.slice(1))) <= th.maxIndent * size) align = 'left';
    else if (spread(mids) <= strict) align = 'center';
    else if (spread(rights) <= strict) align = 'right';
  }
  let indent = 0;
  if (n >= 2 && (align === 'left' || align === 'justify')) {
    indent = lefts[0] - median(lefts.slice(1));
    if (Math.abs(indent) <= strict) indent = 0;
  }
  const stepsArr = ls.slice(1).map((l, j) => ls[j].v - l.v);
  let box: Rect | null = null;
  for (const l of ls) box = union(box, l.box);
  return {
    lines: idx, text: joinLines(ls), box: box!, align, size, leading: n > 1 ? median(stepsArr) : 0, indent: round2(indent),
    bullet: P.bullet, group: ls[0].group, s0: Math.min(...lefts), s1: Math.max(...rights),
    lo: Math.min(...ls.map((l) => l.lo)), hi: Math.max(...ls.map((l) => l.hi)), cell: ls[0].cell, panel: ls[0].panel,
    vertical: ls[0].vertical, angle: ls[0].angle,
  };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
