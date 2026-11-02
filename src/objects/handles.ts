// Handles on a selected object (move, resize and rotate): the geometry behind the select tool's drags,
// as pure functions over user-space points (PDF points, y up), so a page turned by /Rotate needs nothing extra (the
// pointer comes in through fromView, the handles go out through toView).
//
// An object's outline is its quad: four corners in page space, q0 q1 q2 q3, the images of (0,0) (1,0) (1,1) (0,1) of
// its own unit square (an image's unit square through its CTM; for others the bounds), so a turned image keeps its
// angle and is resized along its own axes. A handle is a point (s, t) of that square: corners, edge middles. Dragging
// one scales the square about the opposite point (Alt: about the centre); Shift keeps the proportions. The rotation
// handle turns about the centre (Shift: steps of 15°). Every result is a page-space matrix T for a 'transform' op
// (src/objects/ops.ts): x' = T(x), composed after the object's own placement.
//
// Images added by the editor (src/objects/place.ts) keep a frame and a quarter turn rather than a matrix, so a change
// of one is the same matrix read back as a frame (addedAfter): moves, resizes and quarter turns; other turns snap.
import type { Rect } from '../engine/pdfium.ts';
import { apply, mul, type M6 } from '../pdf/ops.ts';
import { invert, mapRect } from './ops.ts';
import { imageMatrix, type Quarter } from './place.ts';

export type Pt = [number, number];

/** The selection's id of an image added with "Add image": this prefix and the add-image op's key. */
export const ADD = 'add:';

/** The handles in the object's own square: corners and edge middles, named by their place in it (n: t = 1). */
export const HANDLES: readonly { id: string; s: number; t: number }[] = [
  { id: 'sw', s: 0, t: 0 }, { id: 's', s: 0.5, t: 0 }, { id: 'se', s: 1, t: 0 }, { id: 'e', s: 1, t: 0.5 },
  { id: 'ne', s: 1, t: 1 }, { id: 'n', s: 0.5, t: 1 }, { id: 'nw', s: 0, t: 1 }, { id: 'w', s: 0, t: 0.5 },
];

/** The smallest side a resize leaves, in points. */
export const MIN_SIDE = 1;
/** Shift snaps a turn to steps of this many degrees. */
export const SNAP_DEG = 15;

export const rectQuad = (r: Rect): Pt[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
export const quadRect = (q: readonly Pt[]): Rect => ({
  x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])),
});
export const quadCentre = (q: readonly Pt[]): Pt => [(q[0][0] + q[2][0]) / 2, (q[0][1] + q[2][1]) / 2];
export const translate = (dx: number, dy: number): M6 => [1, 0, 0, 1, dx, dy];

/** The matrix from the object's unit square to page space. A side of length 0 (a straight line) is given a unit
 *  length across the other, so the matrix can be inverted. */
export function squareMatrix(q: readonly Pt[]): M6 {
  let u: Pt = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
  let v: Pt = [q[3][0] - q[0][0], q[3][1] - q[0][1]];
  const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1]);
  if (lu < 1e-9 && lv < 1e-9) { u = [1, 0]; v = [0, 1]; }
  else if (lu < 1e-9) u = [v[1] / lv, -v[0] / lv];
  else if (lv < 1e-9) v = [-u[1] / lu, u[0] / lu];
  return [u[0], u[1], v[0], v[1], q[0][0], q[0][1]];
}

/** A point of the object's square (s, t) in page space. */
export const squarePoint = (q: readonly Pt[], s: number, t: number): Pt => apply(squareMatrix(q), s, t);

/**
 * The page-space matrix that resizes the object when handle (s, t) is dragged to page point p: its square is scaled
 * along its own axes about the opposite point, or about the centre with `fromCentre`. With `keepAspect` both axes scale
 * alike (by the axis that changed most; an edge handle scales the other axis about its middle). No side goes below
 * MIN_SIDE and nothing flips.
 */
export function resizeMatrix(q: readonly Pt[], handle: { s: number; t: number }, p: Pt, opts: { keepAspect?: boolean; fromCentre?: boolean } = {}): M6 {
  const Q = squareMatrix(q), Qi = invert(Q)!;
  const [ls, lt] = apply(Qi, p[0], p[1]);
  const as = opts.fromCentre ? 0.5 : 1 - handle.s, at = opts.fromCentre ? 0.5 : 1 - handle.t;
  const lu = Math.hypot(Q[0], Q[1]), lv = Math.hypot(Q[2], Q[3]);
  let sx = handle.s === 0.5 ? 1 : (ls - as) / (handle.s - as);
  let sy = handle.t === 0.5 ? 1 : (lt - at) / (handle.t - at);
  sx = Math.max(sx, MIN_SIDE / Math.max(lu, 1e-9));
  sy = Math.max(sy, MIN_SIDE / Math.max(lv, 1e-9));
  if (opts.keepAspect) {
    const k = handle.s === 0.5 ? sy : handle.t === 0.5 ? sx : Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = sy = Math.max(k, MIN_SIDE / Math.max(Math.min(lu, lv), 1e-9));
  }
  const L: M6 = [sx, 0, 0, sy, as - sx * as, at - sy * at];
  return mul(mul(Qi, L), Q);
}

/** A turn by `deg` counter-clockwise (as shown: /Rotate keeps the sense of turning) about a page point. */
export function turnAbout(c: Pt, deg: number): M6 {
  const r = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r)) < 1e-12 ? 0 : Math.cos(r), sin = Math.abs(Math.sin(r)) < 1e-12 ? 0 : Math.sin(r);
  return mul(mul(translate(-c[0], -c[1]), [cos, sin, -sin, cos, 0, 0]), translate(c[0], c[1]));
}

/** The turn a drag of the rotation handle from page point `from` to `to` makes about `c`, in degrees counter-clockwise
 *  in (−180, 180]; with `snap`, rounded to steps of that many degrees. */
export function dragAngle(c: Pt, from: Pt, to: Pt, snap: number | null = null): number {
  let deg = ((Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0])) * 180) / Math.PI;
  while (deg <= -180) deg += 360;
  while (deg > 180) deg -= 360;
  if (snap) deg = Math.round(deg / snap) * snap;
  return deg === 0 ? 0 : deg;   // no −0
}

/** The point on the outward normal of the quad's edge shown highest on the page (view space y up), `dist` points from
 *  that edge's middle: where the rotation handle goes. `toView` maps page space to view space. */
export function rotationHandle(q: readonly Pt[], toView: (x: number, y: number) => Pt, dist: number): { at: Pt; edge: Pt } {
  const c = quadCentre(q);
  let best: Pt = q[0], bestY = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = q[k], b = q[(k + 1) % 4];
    const m: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const vy = toView(m[0], m[1])[1];
    if (vy > bestY + 1e-9) { bestY = vy; best = m; }
  }
  let nx = best[0] - c[0], ny = best[1] - c[1];
  const L = Math.hypot(nx, ny);
  if (L < 1e-9) { nx = 0; ny = 1; } else { nx /= L; ny /= L; }
  return { at: [best[0] + nx * dist, best[1] + ny * dist], edge: best };
}

/** True when a page point lies in the quad (corners in order, either sense). */
export function inQuad(q: readonly Pt[], x: number, y: number, tol = 0): boolean {
  const Q = squareMatrix(q), Qi = invert(Q);
  if (!Qi) return false;
  const [s, t] = apply(Qi, x, y);
  const es = tol / Math.hypot(Q[0], Q[1]), et = tol / Math.hypot(Q[2], Q[3]);
  return s >= -es && s <= 1 + es && t >= -et && t <= 1 + et;
}

/** An added image's quad: its unit square through the matrix that paints it. */
export const addedQuad = (frame: Rect, rotate: Quarter): Pt[] => {
  const m = imageMatrix(frame, rotate);
  return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(m, x, y));
};

const same = (a: readonly number[], b: readonly number[], eps = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) <= eps * Math.max(1, Math.abs(v), Math.abs(b[k])));

/** An added image's frame and quarter turn after a page-space matrix, or null when the matrix makes something a frame
 *  and a quarter turn cannot hold (a free turn, a shear, a flip). */
export function addedAfter(frame: Rect, rotate: Quarter, T: M6): { frame: Rect; rotate: Quarter } | null {
  const want = mul(imageMatrix(frame, rotate), T);
  const f = mapRect(frame, T);
  if (!(f.x1 - f.x0 > 1e-3 && f.y1 - f.y0 > 1e-3)) return null;
  for (const r of [0, 90, 180, 270] as Quarter[]) if (same(imageMatrix(f, r), want)) return { frame: f, rotate: r };
  return null;
}
