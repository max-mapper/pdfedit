// Geometry and script helpers shared by the layout stages. Page space: points, y up.
// A Frame is a line direction: `s` runs along the text, `v` across it, with "up" (the previous line) at larger v.
// Horizontal text is the frame at 0°, text rotated counter-clockwise by θ the frame at θ, and vertical CJK the
// frame at -90° (s runs down the page, v = x, so the next column, to the left, has a smaller v).
import type { Rect } from './types.ts';

export type Frame = { deg: number; dx: number; dy: number; nx: number; ny: number; axis: boolean };
export type Span = { s0: number; s1: number; v0: number; v1: number };

export function frameOf(deg: number): Frame {
  const r = (deg * Math.PI) / 180;
  let dx = Math.cos(r), dy = Math.sin(r);
  const axis = Math.abs(((deg % 90) + 90) % 90) < 1e-9;
  if (axis) { dx = Math.round(dx); dy = Math.round(dy); }
  return { deg, dx, dy, nx: -dy, ny: dx, axis };
}

export const sOf = (f: Frame, x: number, y: number) => x * f.dx + y * f.dy;
export const vOf = (f: Frame, x: number, y: number) => x * f.nx + y * f.ny;

export function spanOf(f: Frame, r: Rect): Span {
  const xs = [r.x0, r.x1, r.x0, r.x1], ys = [r.y0, r.y0, r.y1, r.y1];
  let s0 = Infinity, s1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let k = 0; k < 4; k++) {
    const s = sOf(f, xs[k], ys[k]), v = vOf(f, xs[k], ys[k]);
    if (s < s0) s0 = s; if (s > s1) s1 = s; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  return { s0, s1, v0, v1 };
}

/** The page-space bounding box of a local span. */
export function rectOfSpan(f: Frame, sp: Span): Rect {
  const pts: [number, number][] = [[sp.s0, sp.v0], [sp.s1, sp.v0], [sp.s0, sp.v1], [sp.s1, sp.v1]];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [s, v] of pts) {
    const x = s * f.dx + v * f.nx, y = s * f.dy + v * f.ny;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

export function union(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
export const width = (r: Rect) => r.x1 - r.x0;
export const height = (r: Rect) => r.y1 - r.y0;
export const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
/** `inner` lies inside `outer`, allowing it to stick out by `tol` points on any side. */
export const inside = (inner: Rect, outer: Rect, tol = 0) =>
  inner.x0 >= outer.x0 - tol && inner.x1 <= outer.x1 + tol && inner.y0 >= outer.y0 - tol && inner.y1 <= outer.y1 + tol;
/** Length of the overlap of two intervals (negative: the gap between them). */
export const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
/** Distance between two rectangles (0 when they touch or overlap). */
export function rectDistance(a: Rect, b: Rect): number {
  const dx = Math.max(0, a.x0 - b.x1, b.x0 - a.x1), dy = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
  return Math.hypot(dx, dy);
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export const spread = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

/** Han, kana, CJK symbols and punctuation, full-width forms: scripts written without spaces between words.
 *  Hangul is excluded (Korean puts spaces between words). */
export function isCjkCp(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x2fdf) || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0x3190 && cp <= 0x31ff) ||
    (cp >= 0x3200 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x20000 && cp <= 0x3ffff);
}
export const isCjkStr = (s: string) => s.length > 0 && isCjkCp(s.codePointAt(0)!);
export const lastCp = (s: string): number => { const a = [...s]; return a.length ? a[a.length - 1].codePointAt(0)! : 0; };

/** Lower bound: first index in a sorted array with key(x) >= k. */
export function lowerBound<T>(a: T[], k: number, key: (x: T) => number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (key(a[m]) < k) lo = m + 1; else hi = m; }
  return lo;
}
