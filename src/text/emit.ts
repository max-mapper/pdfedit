// Turns a layout into a self-contained `q BT … ET Q` content fragment. Glyphs are shown as 2-byte CIDs (= GIDs,
// Identity-H) in TJ arrays; an adjustment number goes wherever the laid-out x differs from where the font's /W
// advance would put the glyph (kerning, charSpacing, justification), so every glyph lands at its laid-out x.
//
// Vertical text (runs whose face is a verticalFace() or sidewaysFace() view, see layout.ts): one `Tm` per column
// (per run of one orientation in it). Upright glyphs are shown with the Identity-V font: the text matrix sits at the
// first glyph's vertical origin (its horizontal origin plus the /W2 position vector), the font's vertical advances
// move down the column, and TJ numbers shift the next glyph along y (positive: down). Sideways glyphs are shown
// with the horizontal font under a matrix rotated 90° clockwise (`0 -1 1 0 x y Tm`), so their advances and TJ
// numbers run down the page as well. A glyph off the current axis (a GPOS offset across the column) gets a new Tm.

import type { Face } from './face.ts';
import { pdfVMetrics, pdfWidth } from './face.ts';
import type { FontWriter } from './font-writer.ts';
import { hex4 } from './font-writer.ts';
import type { Layout, LineRun } from './layout.ts';

const POS_EPS = 0.0005; // points; below this an adjustment is not written

export function emit(layout: Layout, at: { x: number; yTop: number }, fontKey: (face: Face) => string): Uint8Array {
  if (layout.vertical || layout.lines.some((l) => l.runs.some((r) => r.face.orientation))) return emitVertical(layout, at, fontKey);
  const out: string[] = ['q', 'BT', '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr'];
  let font = '';
  let size = NaN;
  let color = '';
  let rise = 0;
  for (const line of layout.lines) {
    const first = line.runs.find((r) => r.glyphs.length)?.glyphs[0];
    if (!first) continue;
    out.push(`1 0 0 1 ${num(at.x + first.x)} ${num(at.yTop - line.baseline)} Tm`);
    let pen = first.x; // box coordinates
    for (const run of line.runs) {
      if (!run.glyphs.length) continue;
      const key = fontKey(run.face);
      if (key !== font || run.size !== size) {
        out.push(`/${key} ${num(run.size)} Tf`);
        font = key;
        size = run.size;
      }
      const rgb = run.color.map((c) => num(c, 4)).join(' ');
      if (rgb !== color) {
        out.push(`${rgb} rg`);
        color = rgb;
      }
      const scale = run.size / 1000;
      let parts: string[] = [];
      let hex = '';
      const flushHex = () => {
        if (hex) parts.push(`<${hex}>`);
        hex = '';
      };
      const flushTJ = () => {
        flushHex();
        if (parts.length) out.push(`[${parts.join(' ')}] TJ`);
        parts = [];
      };
      for (const g of run.glyphs) {
        if (Math.abs(g.y - rise) > POS_EPS) {
          flushTJ();
          rise = g.y;
          out.push(`${num(rise)} Ts`);
        }
        const diff = g.x - pen;
        if (Math.abs(diff) > POS_EPS) {
          const adj = round(-diff / scale, 3);
          if (adj !== 0) {
            flushHex();
            parts.push(num(adj));
            pen -= adj * scale;
          }
        }
        hex += hex4(g.gid);
        pen += pdfWidth(run.face, g.gid) * scale;
      }
      flushTJ();
    }
  }
  if (rise !== 0) out.push('0 Ts');
  out.push('ET', 'Q');
  return new TextEncoder().encode(out.join('\n') + '\n');
}

function emitVertical(layout: Layout, at: { x: number; yTop: number }, fontKey: (face: Face) => string): Uint8Array {
  const out: string[] = ['q', 'BT', '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr'];
  let font = '';
  let size = NaN;
  let color = '';
  let parts: string[] = [];
  let hex = '';
  const flushHex = () => {
    if (hex) parts.push(`<${hex}>`);
    hex = '';
  };
  const flushTJ = () => {
    flushHex();
    if (parts.length) out.push(`[${parts.join(' ')}] TJ`);
    parts = [];
  };
  for (const line of layout.lines) {
    // PDFium's text page puts text objects that start at the same height in left-to-right order, which would swap
    // columns that all start at the box top. The column's last glyph is therefore shown by a TJ of its own (a text
    // object that starts at the column's foot), so the next column never follows an object at its own height.
    let lastRun: LineRun | null = null;
    for (const r of line.runs) if (r.glyphs.length) lastRun = r;
    // the text matrix: its mode, its x (the axis it moves down), and the depth (-y) of the pen on it
    let mode = '';
    let tmX = NaN;
    let pen = 0;
    for (const run of line.runs) {
      if (!run.glyphs.length) continue;
      const key = fontKey(run.face);
      if (key !== font || run.size !== size) {
        flushTJ();
        out.push(`/${key} ${num(run.size)} Tf`);
        font = key;
        size = run.size;
      }
      const rgb = run.color.map((c) => num(c, 4)).join(' ');
      if (rgb !== color) {
        flushTJ();
        out.push(`${rgb} rg`);
        color = rgb;
      }
      const scale = run.size / 1000;
      const upright = run.face.orientation === 'vertical';
      for (const g of run.glyphs) {
        if (run === lastRun && g === run.glyphs[run.glyphs.length - 1]) flushTJ();
        // the glyph's horizontal origin, page space
        const ox = at.x + g.x;
        const oy = at.yTop - line.baseline + g.y;
        if (upright) {
          const m = pdfVMetrics(run.face, g.gid);
          const px = ox + m.vx * scale;
          const py = oy + m.vy * scale;
          if (mode !== 'v' || Math.abs(px - tmX) > POS_EPS) {
            flushTJ();
            out.push(`1 0 0 1 ${num(px)} ${num(py)} Tm`);
            mode = 'v';
            tmX = px;
            pen = -py;
          } else {
            const adj = round((-py - pen) / scale, 3);
            if (adj !== 0) {
              flushHex();
              parts.push(num(adj));
              pen += adj * scale;
            }
          }
          hex += hex4(g.gid);
          pen -= m.w1y * scale;
        } else {
          if (mode !== 's' || Math.abs(ox - tmX) > POS_EPS) {
            flushTJ();
            out.push(`0 -1 1 0 ${num(ox)} ${num(oy)} Tm`);
            mode = 's';
            tmX = ox;
            pen = -oy;
          } else {
            const adj = round(-(-oy - pen) / scale, 3);
            if (adj !== 0) {
              flushHex();
              parts.push(num(adj));
              pen -= adj * scale;
            }
          }
          hex += hex4(g.gid);
          pen += pdfWidth(run.face, g.gid) * scale;
        }
      }
      flushTJ();
    }
  }
  out.push('ET', 'Q');
  return new TextEncoder().encode(out.join('\n') + '\n');
}

/** Registers every glyph of a layout with the font writer; returns the fontKey function emit() takes. */
export function useLayout(writer: FontWriter, layout: Layout): (face: Face) => string {
  for (const line of layout.lines) for (const run of line.runs) writer.use(run.face, run.glyphs);
  return (face) => writer.keyOf(face);
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function num(n: number, digits = 3): string {
  const s = round(n, digits).toFixed(digits).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}
