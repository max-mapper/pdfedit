// Caret geometry from a laid-out box (src/model/layout.ts): where a text position is drawn, which position a point
// hits, the positions one line up or down, a line's start and end, and the rectangles a selection covers. All from
// the glyphs the editor draws (each glyph's cluster offset `c` and pen position `p`, each line's text range and
// `pEnd`), so the caret is always on the drawn text, before and after an edit, in horizontal and vertical boxes.
//
// A position is { para, off } (a UTF-16 offset in the paragraph's text). At a line break the same offset ends one line
// and starts the next: `affinity` 'up' shows it at the end of the first, 'down' at the start of the second. Units: PDF
// points, y up. Pure: no DOM.
import type { Box, LaidBox } from './types.ts';

export type CaretPos = { para: number; off: number };
export type Affinity = 'up' | 'down';

export type CaretLine = {
  para: number;
  start: number; end: number;          // the line's text range [start, end) in its paragraph
  last: boolean;                       // the paragraph's last line
  vertical: boolean;
  x: number; baseline: number;         // horizontal: a pen position p is at PDF x = x + p, on this baseline
  axis: number;                        // vertical: the column's axis (PDF x); a pen position p is at PDF y = baseline - p
  asc: number; desc: number;           // the caret's extent above and below the baseline (vertical: half its width each)
  stops: { off: number; p: number }[]; // cluster starts with their pen positions, and the end of the drawn text
};

/** The box's lines as caret lines, in drawing order (paragraphs in order, lines top to bottom or right to left). */
export function caretLines(laid: LaidBox, box: Box): CaretLine[] {
  const vertical = !!laid.vertical;
  const out: CaretLine[] = [];
  const paraOf = (i: number) => laid.lines[i].para ?? 0;
  laid.lines.forEach((line, i) => {
    const para = paraOf(i);
    const text = box.paragraphs[para]?.runs.map((r) => r.text).join('') ?? '';
    let size = 0;
    const stops: { off: number; p: number }[] = [];
    let lastOff = -1, lastLen = 0;
    for (const run of line.runs) {
      size = Math.max(size, run.size);
      for (const g of run.glyphs) {
        if (g.c === undefined || g.c < 0) continue;
        const p = g.p ?? (vertical ? -g.y : g.x);
        if (stops.length && stops[stops.length - 1].off === g.c) continue;
        stops.push({ off: g.c, p });
        if (g.c >= lastOff) { lastOff = g.c; lastLen = g.text.length || 1; }
      }
    }
    stops.sort((a, b) => a.off - b.off);
    const start = line.start ?? stops[0]?.off ?? 0;
    const end = line.end ?? (lastOff >= 0 ? lastOff + lastLen : start);
    const pEnd = line.pEnd ?? (stops.length ? stops[stops.length - 1].p : 0);
    const endOff = lastOff >= 0 ? Math.min(end, lastOff + lastLen) : start;
    if (!stops.length || stops[stops.length - 1].off < endOff) stops.push({ off: endOff, p: pEnd });
    if (!size) size = box.paragraphs[para]?.runs[0]?.size ?? 10;
    const next = laid.lines[i + 1];
    out.push({
      para, start: Math.min(start, end), end: Math.max(start, end, text.length && !next ? text.length : 0),
      last: !next || paraOf(i + 1) !== para,
      vertical, x: line.x, baseline: line.baseline, axis: line.axis ?? line.x,
      asc: vertical ? 0.55 * size : 0.92 * size, desc: vertical ? 0.55 * size : 0.26 * size,
      stops,
    });
  });
  // the last line of a paragraph reaches the paragraph's end (its trailing spaces and line breaks)
  for (const L of out) if (L.last) L.end = Math.max(L.end, box.paragraphs[L.para]?.runs.map((r) => r.text).join('').length ?? 0);
  return out;
}

/** The pen position of an offset on a line: its cluster's pen, inside a cluster interpolated, past the drawn text at
 *  its end. */
function penAt(L: CaretLine, off: number): number {
  const s = L.stops;
  if (!s.length) return 0;
  if (off <= s[0].off) return s[0].p;
  for (let i = 1; i < s.length; i++) {
    if (off < s[i].off) {
      const a = s[i - 1], b = s[i];
      return a.p + ((b.p - a.p) * (off - a.off)) / Math.max(1, b.off - a.off);
    }
    if (off === s[i].off) return s[i].p;
  }
  return s[s.length - 1].p;
}

/** The index of the line a position is drawn on. */
export function lineOf(lines: CaretLine[], pos: CaretPos, affinity: Affinity = 'down'): number {
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.para !== pos.para) continue;
    if (pos.off >= L.start && (pos.off < L.end || (pos.off === L.end && (L.last || affinity === 'up')))) return i;
    if (pos.off === L.end && best < 0) best = i;
    if (pos.off >= L.start) best = i;
  }
  if (best >= 0) return best;
  // a paragraph with no line (no runs): the nearest line before it
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].para < pos.para) return i;
  return 0;
}

/** The caret for a position: a bar in PDF space (horizontal text: x0 = x1; vertical: y0 = y1). */
export function caretRect(lines: CaretLine[], pos: CaretPos, affinity: Affinity = 'down'): { x0: number; y0: number; x1: number; y1: number; line: number } | null {
  if (!lines.length) return null;
  const i = lineOf(lines, pos, affinity);
  const L = lines[i];
  const p = penAt(L, pos.off);
  if (L.vertical) { const y = L.baseline - p; return { x0: L.axis - L.asc, x1: L.axis + L.desc, y0: y, y1: y, line: i }; }
  const x = L.x + p;
  return { x0: x, x1: x, y0: L.baseline - L.desc, y1: L.baseline + L.asc, line: i };
}

/** The position nearest a pen position on a line. */
function offAt(L: CaretLine, p: number): { off: number; affinity: Affinity } {
  let best = L.stops[0] ?? { off: L.start, p: 0 }, bd = Infinity;
  for (const s of L.stops) { const d = Math.abs(s.p - p); if (d < bd) { bd = d; best = s; } }
  const atEnd = best.off === L.stops[L.stops.length - 1]?.off && !L.last;
  return { off: best.off, affinity: atEnd ? 'up' : 'down' };
}

/** The position a point (PDF space) hits: the nearest line, then the nearest cluster boundary on it. */
export function hitTest(lines: CaretLine[], x: number, y: number): CaretPos & { affinity: Affinity; line: number } | null {
  if (!lines.length) return null;
  let bi = 0, bd = Infinity;
  lines.forEach((L, i) => {
    const d = L.vertical ? Math.max(0, Math.abs(x - L.axis) - L.asc)
      : Math.max(0, y - (L.baseline + L.asc), L.baseline - L.desc - y);
    if (d < bd - 1e-9) { bd = d; bi = i; }
  });
  const L = lines[bi];
  const r = offAt(L, L.vertical ? L.baseline - y : x - L.x);
  return { para: L.para, off: r.off, affinity: r.affinity, line: bi };
}

/** One line up (dir -1) or down (+1; vertical boxes: the next column, leftwards) at a pen position `goal` (the
 *  position's own when not given). Past the first or last line: the box's start or end. */
export function lineMove(lines: CaretLine[], pos: CaretPos, affinity: Affinity, dir: -1 | 1, goal?: number):
  { pos: CaretPos; affinity: Affinity; goal: number } {
  const i = lineOf(lines, pos, affinity);
  const g = goal ?? penAt(lines[i], pos.off);
  const j = i + dir;
  if (j < 0) { const L = lines[0]; return { pos: { para: L.para, off: L.start }, affinity: 'down', goal: g }; }
  if (j >= lines.length) { const L = lines[lines.length - 1]; return { pos: { para: L.para, off: L.end }, affinity: 'up', goal: g }; }
  const r = offAt(lines[j], g);
  return { pos: { para: lines[j].para, off: r.off }, affinity: r.affinity, goal: g };
}

/** The start or end of the line a position is on (the end: after its last drawn character). */
export function lineEdge(lines: CaretLine[], pos: CaretPos, affinity: Affinity, edge: 'start' | 'end'): { pos: CaretPos; affinity: Affinity } {
  const L = lines[lineOf(lines, pos, affinity)];
  if (edge === 'start') return { pos: { para: L.para, off: L.start }, affinity: 'down' };
  const endOff = L.last ? L.end : L.stops[L.stops.length - 1]?.off ?? L.end;
  return { pos: { para: L.para, off: endOff }, affinity: L.last ? 'down' : 'up' };
}

/** Rectangles (PDF space) covering the text between two positions, one per line. */
export function selectionRects(lines: CaretLine[], a: CaretPos, b: CaretPos): { x0: number; y0: number; x1: number; y1: number }[] {
  const before = (p: CaretPos, q: CaretPos) => p.para < q.para || (p.para === q.para && p.off < q.off);
  const [from, to] = before(b, a) ? [b, a] : [a, b];
  if (from.para === to.para && from.off === to.off) return [];
  const out: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const L of lines) {
    const ls: CaretPos = { para: L.para, off: L.start }, le: CaretPos = { para: L.para, off: L.end };
    if (!before(from, le) && !(from.para === le.para && from.off === le.off && L.last)) continue;
    if (!before(ls, to)) continue;
    const s = from.para === L.para && from.off > L.start ? from.off : L.start;
    const e = to.para === L.para && to.off < L.end ? to.off : L.end;
    let p0 = penAt(L, s), p1 = penAt(L, e);
    // a selection running on past the line's end shows a little of the break
    if (e >= L.end && (to.para > L.para || to.off > L.end)) p1 += 0.25 * (L.asc + L.desc);
    if (p1 < p0) [p0, p1] = [p1, p0];
    if (L.vertical) out.push({ x0: L.axis - L.asc, x1: L.axis + L.desc, y0: L.baseline - p1, y1: L.baseline - p0 });
    else out.push({ x0: L.x + p0, x1: L.x + p1, y0: L.baseline - L.desc, y1: L.baseline + L.asc });
  }
  return out;
}
