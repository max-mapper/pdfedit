// Shapes → the page's rule segments (table rulings, separators), panel candidates and pictures.
import type { PageInput, Rect, Shape } from './types.ts';
import { area, height, width } from './geom.ts';

/** An axis-aligned segment: horizontal when y0 = y1, vertical when x0 = x1. */
export type Seg = { x0: number; y0: number; x1: number; y1: number; shape: number };

export function ruleSegments(shapes: Shape[]): Seg[] {
  const out: Seg[] = [];
  for (const sh of shapes) {
    if (sh.kind !== 'path') continue;
    const b = sh.bounds, w = width(b), h = height(b);
    if (!(w > 0 || h > 0)) continue;
    // a thin path: PDFium's own isRule, or a stroked straight line whose bounds include a thick stroke
    const thin = sh.isRule || (sh.stroke !== null && sh.segments <= 3 && Math.min(w, h) <= sh.strokeWidth + 1.5 && Math.max(w, h) > 6);
    if (thin) {
      if (w >= h) { const y = (b.y0 + b.y1) / 2; out.push({ x0: b.x0, y0: y, x1: b.x1, y1: y, shape: sh.index }); }
      else { const x = (b.x0 + b.x1) / 2; out.push({ x0: x, y0: b.y0, x1: x, y1: b.y1, shape: sh.index }); }
      continue;
    }
    // a stroked rectangle: its four edges (bounds include half the stroke on each side)
    if (sh.isRect && sh.stroke !== null && w > 3 && h > 3) {
      const k = sh.strokeWidth / 2;
      const r = { x0: b.x0 + k, y0: b.y0 + k, x1: b.x1 - k, y1: b.y1 - k };
      out.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y0, shape: sh.index }, { x0: r.x0, y0: r.y1, x1: r.x1, y1: r.y1, shape: sh.index },
        { x0: r.x0, y0: r.y0, x1: r.x0, y1: r.y1, shape: sh.index }, { x0: r.x1, y0: r.y0, x1: r.x1, y1: r.y1, shape: sh.index });
    }
  }
  return out;
}

/** Filled paths that could be panels: visible fill, not a rule, not the page background. */
export function panelCandidates(page: PageInput): number[] {
  const pageArea = page.w * page.h;
  const out: number[] = [];
  for (const sh of page.shapes) {
    if (sh.kind !== 'path' || !sh.fill || sh.fill[3] === 0 || sh.isRule) continue;
    const b = sh.bounds;
    if (Math.min(width(b), height(b)) < 4 || area(b) >= 0.95 * pageArea) continue;
    out.push(sh.index);
  }
  return out;
}

/** Images, shadings and drawn figures (paths with many segments that are not rules): what labels sit beside. */
export function pictures(shapes: Shape[]): Rect[] {
  return shapes.filter((sh) => sh.kind === 'image' || sh.kind === 'shading' ||
    (sh.kind === 'path' && !sh.isRule && !sh.isRect && sh.segments > 8 && area(sh.bounds) > 400)).map((sh) => sh.bounds);
}

/** Rules parallel to a frame's lines, in its local coordinates: what a paragraph or box never spans. */
export type Par = { v: number; s0: number; s1: number };
export function parallelBarriers(segs: Seg[], f: { axis: boolean; dx: number; dy: number; nx: number; ny: number }): Par[] {
  if (!f.axis) return [];
  const out: Par[] = [];
  for (const sg of segs) {
    const a0 = sg.x0 * f.dx + sg.y0 * f.dy, a1 = sg.x1 * f.dx + sg.y1 * f.dy;
    const b0 = sg.x0 * f.nx + sg.y0 * f.ny, b1 = sg.x1 * f.nx + sg.y1 * f.ny;
    if (Math.abs(b1 - b0) < 0.5 && Math.abs(a1 - a0) > 0.5) out.push({ v: (b0 + b1) / 2, s0: Math.min(a0, a1), s1: Math.max(a0, a1) });
  }
  return out;
}
/** A parallel rule lies strictly between v levels `lo` < `hi` and overlaps the along range [s0, s1]. */
export const parBetween = (bars: Par[], lo: number, hi: number, s0: number, s1: number) =>
  bars.some((b) => b.v > lo && b.v < hi && Math.min(b.s1, s1) - Math.max(b.s0, s0) > 1);
