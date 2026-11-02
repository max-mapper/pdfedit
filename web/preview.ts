// The live preview: each edited box's source area masked, and its laid-out text drawn as glyph outlines (HarfBuzz
// glyphToPath → Path2D) at the positions layoutBox computed, so the preview is the export's glyph geometry, not the
// browser's own text layout. Redraws are per box: the area a box covered before and covers now is cleared and every
// edited box that meets it is drawn again inside that clip.
//
// Vertical boxes are drawn as export writes them (src/text/emit.ts): upright glyphs from their horizontal origin as
// in horizontal text; sideways glyphs under the text matrix `0 -1 1 0 x y`, rotated 90° clockwise about their origin.
// Everything is drawn through the view's matrix from user space to canvas pixels (canvasMatrix), so a page turned by
// /Rotate, or with a crop box away from the origin, is drawn as PDFium renders it.
import type { Face } from '../src/text/face.ts';
import type { Box, LaidBox, Page, Rect } from '../src/model/types.ts';
import { deviceMatrix } from '../src/engine/view.ts';
import { mul, type M6 } from '../src/pdf/ops.ts';

export type View = {
  /** Canvas pixels per PDF point. */
  k: number;
  /** User-space y at the canvas's top edge: the page height for a page whose crop box starts at 0,0, else the crop
   *  box's top (PDF y is up, canvas y is down). */
  h: number;
  /** User-space x at the canvas's left edge (the crop box's left), 0 by default. */
  x0?: number;
  /** The matrix from user space to canvas pixels, for a page turned by /Rotate (k, h and x0 then describe the crop box
   *  only); absent for an unturned page, where it is [k 0 0 −k −x0·k h·k]. */
  m?: M6;
};

/**
 * Something painted under the boxes from the page bitmap (masks, then pixels), before the boxes' masks and text:
 * `rects` are the page areas it paints, so a box redrawn over one of them paints it again. `paint` draws in canvas
 * pixels (identity transform); `source` is the page bitmap as a drawImage source and `colour` the background colour
 * sampled around a rectangle (cached by key).
 */
export type Underlay = {
  rects(page: Page): Rect[];
  paint(c: CanvasRenderingContext2D, page: Page, at: { view: View; source: () => OffscreenCanvas; colour: (key: string, r: Rect) => string }): void;
};

/** The view of a page's render at k pixels per point: a crop box away from the origin shifts the canvas, and /Rotate
 *  turns it (src/engine/view.ts). */
export function viewOf(page: Pick<Page, 'h' | 'view'>, k: number): View {
  if (!page.view) return { k, h: page.h };
  const v: View = { k, h: page.view.crop.y1, x0: page.view.crop.x0 };
  return page.view.rotate ? { ...v, m: deviceMatrix(page.view, k) } : v;
}

/** The matrix from user space to the canvas pixels of a view. */
export function canvasMatrix(view: View): M6 {
  const { k, h, x0 = 0 } = view;
  return view.m ?? [k, 0, 0, -k, -x0 * k, h * k];
}

/** A user-space rectangle in canvas pixels (exact: the views turn by quarter turns only). */
export function canvasRect(view: View, r: Rect): Rect {
  const m = canvasMatrix(view);
  const ax = m[0] * r.x0 + m[2] * r.y0 + m[4], ay = m[1] * r.x0 + m[3] * r.y0 + m[5];
  const bx = m[0] * r.x1 + m[2] * r.y1 + m[4], by = m[1] * r.x1 + m[3] * r.y1 + m[5];
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

/** The canvas transform that paints a glyph outline (font units, y up) at a user-space origin: upright, or sideways as
 *  export writes vertical text (`0 -1 1 0 x y Tm`, turned 90° clockwise). */
export function glyphMatrix(view: View, scale: number, x: number, y: number, sideways: boolean): M6 {
  return mul(sideways ? [0, -scale, scale, 0, x, y] : [scale, 0, 0, scale, x, y], canvasMatrix(view));
}

/** The canvas pixels of a dirty rectangle, grown to whole pixels with one to spare. */
export function dirtyPixels(view: View, r: Rect): { x: number; y: number; w: number; h: number } {
  const q = canvasRect(view, r);
  const x = Math.floor(q.x0) - 1, y = Math.floor(q.y0) - 1;
  return { x, y, w: Math.ceil(q.x1) + 1 - x, h: Math.ceil(q.y1) + 1 - y };
}

/** Paints the underlays (identity transform, state restored afterwards). */
export function paintUnderlays(c: CanvasRenderingContext2D, page: Page, list: Underlay[], at: Parameters<Underlay['paint']>[2]): void {
  if (!list.length) return;
  c.save();
  c.setTransform(1, 0, 0, 1, 0, 0);
  for (const u of list) u.paint(c, page, at);
  c.restore();
}

const paths = new Map<number, Map<number, Path2D>>();

function glyphPath(face: Face, gid: number): Path2D {
  let m = paths.get(face.id);
  if (!m) { m = new Map(); paths.set(face.id, m); }
  let p = m.get(gid);
  if (!p) {
    p = new Path2D(face.hbFont.glyphToPath(gid));
    m.set(gid, p);
  }
  return p;
}

/** The rectangle hiding the source paragraph: its frame with a small margin for ink outside the em box. */
export function maskRect(box: Box): Rect {
  const f = box.source.frame;
  const size = box.source.paragraphs[0]?.size ?? 10;
  const pad = Math.max(1, 0.12 * size);
  return { x0: f.x0 - pad, y0: f.y0 - pad, x1: f.x1 + pad, y1: f.y1 + pad };
}

/** Everything a box draws: the mask and the laid-out text. */
export function drawnRect(box: Box, laid: LaidBox): Rect {
  const m = maskRect(box);
  let r = union(m, laid.frame);
  if (laid.vertical) {
    // columns: every glyph's origin, padded by its size on every side (upright and sideways glyphs alike)
    for (const line of laid.lines) {
      for (const run of line.runs) {
        const pad = 1.2 * run.size;
        for (const g of run.glyphs) {
          const x = line.x + g.x, y = line.baseline + g.y;
          r = union(r, { x0: x - pad, x1: x + pad, y0: y - pad, y1: y + pad });
        }
      }
    }
    return r;
  }
  // glyphs may reach outside the frame (overflow, accents, descenders): include their lines' extents
  for (const line of laid.lines) {
    for (const run of line.runs) {
      const g0 = run.glyphs[0], g1 = run.glyphs[run.glyphs.length - 1];
      if (!g0) continue;
      r = union(r, { x0: line.x + g0.x - run.size, x1: line.x + g1.x + run.size, y0: line.baseline - 0.4 * run.size, y1: line.baseline + 1.1 * run.size });
    }
  }
  return r;
}

/** The colour around a rectangle on the page bitmap: the per-channel median of a ring of pixels just outside it. */
export function sampleBackground(img: ImageData, view: View, r: Rect): string {
  const q = canvasRect(view, r);
  const X0 = Math.floor(q.x0) - 2, X1 = Math.ceil(q.x1) + 2;
  const Y0 = Math.floor(q.y0) - 2, Y1 = Math.ceil(q.y1) + 2;
  const R: number[] = [], G: number[] = [], B: number[] = [];
  const take = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const o = (y * img.width + x) * 4;
    R.push(img.data[o]); G.push(img.data[o + 1]); B.push(img.data[o + 2]);
  };
  const step = Math.max(1, Math.floor((X1 - X0 + Y1 - Y0) / 400));
  for (let x = X0; x <= X1; x += step) { take(x, Y0); take(x, Y1); }
  for (let y = Y0; y <= Y1; y += step) { take(X0, y); take(X1, y); }
  if (!R.length) return '#ffffff';
  const med = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return `rgb(${med(R)}, ${med(G)}, ${med(B)})`;
}

export class Preview {
  private ctx: CanvasRenderingContext2D;
  private view: View;
  private drawn = new Map<string, Rect>();
  private maskColour = new Map<string, string>();
  private bitmap: ImageData;
  private source: OffscreenCanvas | null = null;   // the page bitmap as a drawImage source (underlays)
  private underRects: Rect[] = [];
  /** Painted under the boxes (set before drawAll). */
  underlays: Underlay[] = [];
  /** The selected box: drawn too (the editor draws a box as soon as it has the focus, so the caret and the outline
   *  follow what is drawn). Redraw it after changing this. */
  focused: string | null = null;
  private shows(b: Box): boolean { return b.edited || b.id === this.focused; }

  constructor(canvas: HTMLCanvasElement, bitmap: ImageData, view: View) {
    this.ctx = canvas.getContext('2d')!;
    this.view = view;
    this.bitmap = bitmap;
  }

  /** Clears and draws every edited box (and the focused one). */
  drawAll(page: Page, laid: (b: Box) => LaidBox): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    this.drawn.clear();
    this.underRects = this.underlays.flatMap((u) => u.rects(page));
    this.paintUnder(page);
    const edited = page.boxes.filter((b) => this.shows(b));
    const L = new Map(edited.map((b) => [b.id, laid(b)]));
    for (const b of edited) this.mask(b);
    for (const b of edited) { this.text(L.get(b.id)!); this.drawn.set(b.id, drawnRect(b, L.get(b.id)!)); }
  }

  /** Redraws the boxes `ids` changed: the union of what they covered and cover now is cleared, then every edited
   *  box meeting it is drawn again inside that clip (masks first, then text). */
  redraw(page: Page, ids: string[], laid: (b: Box) => LaidBox): void {
    let dirty: Rect | null = null;
    const now = new Map<string, Rect>();
    for (const id of ids) {
      const old = this.drawn.get(id);
      if (old) dirty = union(dirty, old);
      const b = page.boxes.find((x) => x.id === id);
      if (b && this.shows(b)) { const r = drawnRect(b, laid(b)); now.set(id, r); dirty = union(dirty, r); }
      else this.drawn.delete(id);
    }
    for (const [id, r] of now) this.drawn.set(id, r);
    if (!dirty) return;
    // boxes removed from the page (a merge) leave their area in `drawn`
    for (const id of [...this.drawn.keys()]) if (!page.boxes.some((b) => b.id === id)) { dirty = union(dirty, this.drawn.get(id)!); this.drawn.delete(id); }
    const c = this.ctx;
    const px = dirtyPixels(this.view, dirty);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.rect(px.x, px.y, px.w, px.h);
    c.clip();
    c.clearRect(px.x, px.y, px.w, px.h);
    if (this.underRects.some((r) => meets(r, dirty!))) this.paintUnder(page);
    const hit = page.boxes.filter((b) => this.shows(b) && this.drawn.has(b.id) && meets(this.drawn.get(b.id)!, dirty!));
    for (const b of hit) this.mask(b);
    for (const b of hit) this.text(laid(b));
    c.restore();
  }

  private mask(b: Box): void {
    const c = this.ctx;
    const r = maskRect(b);
    const key = `${b.id}:${r.x0},${r.y0},${r.x1},${r.y1}`;
    let col = this.maskColour.get(key);
    if (!col) { col = sampleBackground(this.bitmap, this.view, r); this.maskColour.set(key, col); }
    const q = canvasRect(this.view, r);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = col;
    c.fillRect(q.x0, q.y0, q.x1 - q.x0, q.y1 - q.y0);
    c.restore();
  }

  private paintUnder(page: Page): void {
    paintUnderlays(this.ctx, page, this.underlays, {
      view: this.view,
      source: () => {
        if (!this.source) { this.source = new OffscreenCanvas(this.bitmap.width, this.bitmap.height); this.source.getContext('2d')!.putImageData(this.bitmap, 0, 0); }
        return this.source;
      },
      colour: (key, r) => {
        let col = this.maskColour.get(key);
        if (!col) { col = sampleBackground(this.bitmap, this.view, r); this.maskColour.set(key, col); }
        return col;
      },
    });
  }

  private text(L: LaidBox): void {
    const c = this.ctx;
    c.save();
    for (const line of L.lines) {
      for (const run of line.runs) {
        const face = run.face;
        if (!face) continue;
        c.fillStyle = `rgb(${run.color.map((v) => Math.round(v * 255)).join(', ')})`;
        const s = run.size / face.upem;
        // sideways glyphs (vertical text): export's `0 -1 1 0 x y Tm`, i.e. glyph (gx, gy) → page (x + gy, y - gx)
        const sideways = run.orientation === 'sideways' || face.orientation === 'sideways';
        for (const g of run.glyphs) {
          const m = glyphMatrix(this.view, s, line.x + g.x, line.baseline + g.y, sideways);
          c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          c.fill(glyphPath(face, g.gid));
        }
      }
    }
    c.restore();
  }
}

function union(a: Rect | null, b: Rect): Rect {
  return a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };
}

function meets(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}
