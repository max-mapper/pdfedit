// How PDF user space maps onto a page as it is shown (ISO 32000-1 §7.7.3.3, Table 30: /CropBox and /Rotate; §8.3.2.3).
// The shown page is the crop box turned clockwise by /Rotate (0, 90, 180 or 270), as PDFium renders it. "View space"
// here is that shown page in points with the origin at its bottom-left corner and y up, so an unrotated page whose
// crop box starts at 0,0 has view space equal to user space. Everything the editor draws over a render goes through
// toView; everything a pointer gives goes back through fromView.
//
// Measured on PDFium (src/engine/view.test.ts): FPDF_GetPageWidthF/HeightF give the shown size (the crop box, sides
// swapped at 90 and 270), text and object bounds are in user space, and a render at scale k puts user point (x, y) at
// device pixel (k·vx, k·(h − vy)) with (vx, vy) = toView(x, y).
import type { Rect } from './pdfium.ts';

export type ViewBox = {
  rotate: 0 | 90 | 180 | 270;
  crop: Rect;              // the crop box in user space (the media box when the page has none)
  media: Rect | null;      // the media box in user space, when PDFium reports one
  w: number; h: number;    // the shown size in points
};

/** A matrix [a b c d e f] taking user space to view space. */
export type M6 = [number, number, number, number, number, number];

const quarter = (deg: number): ViewBox['rotate'] => (((Math.round(deg / 90) % 4) + 4) % 4 * 90) as ViewBox['rotate'];

/** A view box from a rotation in degrees and a crop rectangle (user space). */
export function viewBox(rotate: number, crop: Rect, media: Rect | null = null): ViewBox {
  const r = quarter(rotate);
  const W = crop.x1 - crop.x0, H = crop.y1 - crop.y0;
  return { rotate: r, crop: { ...crop }, media: media ? { ...media } : null, w: r % 180 ? H : W, h: r % 180 ? W : H };
}

/** The identity view of a page w × h points (no rotation, crop at the origin). */
export function plainView(w: number, h: number): ViewBox {
  return viewBox(0, { x0: 0, y0: 0, x1: w, y1: h });
}

/** True when view space is user space. */
export function isPlain(v: ViewBox | undefined | null): boolean {
  return !v || (v.rotate === 0 && Math.abs(v.crop.x0) < 1e-9 && Math.abs(v.crop.y0) < 1e-9);
}

/** The matrix taking user space to view space. */
export function viewMatrix(v: ViewBox): M6 {
  const { x0, y0, x1, y1 } = v.crop;
  const W = x1 - x0, H = y1 - y0;
  // u = x − x0, w = y − y0, then turn clockwise and shift into the shown page
  switch (v.rotate) {
    case 0: return [1, 0, 0, 1, -x0, -y0];
    case 90: return [0, -1, 1, 0, -y0, W + x0];           // (u, w) → (w, W − u)
    case 180: return [-1, 0, 0, -1, W + x0, H + y0];      // (u, w) → (W − u, H − w)
    case 270: return [0, 1, -1, 0, H + y0, -x0];          // (u, w) → (H − w, u)
  }
}

/** A user-space point in view space. */
export function toView(v: ViewBox | undefined | null, x: number, y: number): [number, number] {
  if (!v) return [x, y];
  const m = viewMatrix(v);
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** A view-space point in user space. */
export function fromView(v: ViewBox | undefined | null, x: number, y: number): [number, number] {
  if (!v) return [x, y];
  const [a, b, c, d, e, f] = viewMatrix(v);
  const det = a * d - b * c;   // ±1 for a quarter turn
  const px = x - e, py = y - f;
  return [(d * px - c * py) / det, (-b * px + a * py) / det];
}

/** The view-space bounding rectangle of a user-space rectangle (exact: a quarter turn keeps rectangles upright). */
export function rectToView(v: ViewBox | undefined | null, r: Rect): Rect {
  if (!v) return { ...r };
  const [ax, ay] = toView(v, r.x0, r.y0), [bx, by] = toView(v, r.x1, r.y1);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** The user-space rectangle of a view-space rectangle. */
export function rectFromView(v: ViewBox | undefined | null, r: Rect): Rect {
  if (!v) return { ...r };
  const [ax, ay] = fromView(v, r.x0, r.y0), [bx, by] = fromView(v, r.x1, r.y1);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** A user-space rectangle as device pixels of a render at `scale` (y down from the top of the shown page). */
export function rectToPixels(v: ViewBox | undefined | null, r: Rect, scale: number, pageH: number): Rect {
  const q = rectToView(v, r);
  const h = v ? v.h : pageH;
  return { x0: q.x0 * scale, x1: q.x1 * scale, y0: (h - q.y1) * scale, y1: (h - q.y0) * scale };
}

/** The matrix taking user space to the device pixels of a render at `scale` (y down from the shown page's top). */
export function deviceMatrix(v: ViewBox, scale: number): M6 {
  const [a, b, c, d, e, f] = viewMatrix(v);
  // view (vx, vy) → device (k·vx, k·(h − vy))
  return [a * scale, -b * scale, c * scale, -d * scale, e * scale, (v.h - f) * scale];
}

/** A step on the shown page (view space, y up) as a user-space vector. */
export function viewStep(v: ViewBox | undefined | null, dx: number, dy: number): [number, number] {
  const [ox, oy] = fromView(v, 0, 0), [x, y] = fromView(v, dx, dy);
  return [x - ox, y - oy];
}

const EDGE_OF: Record<string, [number, number]> = { e: [1, 0], w: [-1, 0], n: [0, 1], s: [0, -1] };
const edgeName = (x: number, y: number) => (Math.abs(x) > Math.abs(y) ? (x > 0 ? 'e' : 'w') : y > 0 ? 'n' : 's');

/**
 * A drag of a box's handle on the shown page, read in user space: the handle's edges ('n', 'e', 'se', … as the person
 * sees them, or 'move') as the user-space edges they are on a turned page, and the pointer's movement (CSS pixels at
 * `zoom` pixels per point, y down) as user-space points in the same y-down form (dy positive when the pointer moves
 * towards smaller user y). Code written for unturned pages takes the result as it is.
 */
export function dragInUser(v: ViewBox | undefined | null, handle: string, dxCss: number, dyCss: number, zoom: number): { h: string; dx: number; dy: number } {
  const [ux, uy] = viewStep(v, dxCss / zoom, -dyCss / zoom);
  const fix = (x: number) => (Math.abs(x) < 1e-12 ? 0 : x);
  if (handle === 'move' || handle === 'body') return { h: handle, dx: fix(ux), dy: fix(-uy) };
  const edges = handle.split('').map((ch) => { const d = EDGE_OF[ch]; if (!d) return ch; const [x, y] = viewStep(v, d[0], d[1]); return edgeName(x, y); });
  const h = [...edges.filter((ch) => ch === 'n' || ch === 's'), ...edges.filter((ch) => ch === 'e' || ch === 'w')].join('');
  return { h, dx: fix(ux), dy: fix(-uy) };
}
