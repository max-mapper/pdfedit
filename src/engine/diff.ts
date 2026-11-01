// Pixel comparison of two renders, outside given regions. Browser-safe (no PNG library).
import type { Bitmap, Rect } from './pdfium.ts';

/** Pixels whose RGB differs by more than `tol` (0–255) between two renders of the same size, counted outside the
 *  given regions (page rectangles in PDF points, converted with the render scale and page height). */
export function diffOutside(a: Bitmap, b: Bitmap, regions: Rect[], scale: number, pageH: number, tol = 24):
  { differing: number; total: number } {
  if (a.width !== b.width || a.height !== b.height) throw new Error('renders differ in size');
  const px = regions.map((r) => ({
    x0: Math.floor(r.x0 * scale) - 2, x1: Math.ceil(r.x1 * scale) + 2,
    y0: Math.floor((pageH - r.y1) * scale) - 2, y1: Math.ceil((pageH - r.y0) * scale) + 2,
  }));
  let differing = 0, total = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (px.some((r) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1)) continue;
      total++;
      const k = (y * a.width + x) * 4;
      if (Math.abs(a.rgba[k] - b.rgba[k]) > tol || Math.abs(a.rgba[k + 1] - b.rgba[k + 1]) > tol || Math.abs(a.rgba[k + 2] - b.rgba[k + 2]) > tol) differing++;
    }
  }
  return { differing, total };
}
