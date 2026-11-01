// The live preview: each edited box's source area masked, and its laid-out text drawn as glyph outlines (HarfBuzz
// glyphToPath → Path2D) at the positions layoutBox computed, so the preview is the export's glyph geometry, not the
// browser's own text layout. Redraws are per box: the area a box covered before and covers now is cleared and every
// edited box that meets it is drawn again inside that clip.
//
// Vertical boxes are drawn as export writes them (src/text/emit.ts): upright glyphs from their horizontal origin as
// in horizontal text; sideways glyphs under the text matrix `0 -1 1 0 x y`, rotated 90° clockwise about their origin.
//
// Pictures the fitter moved (Picture.move, applied by src/export/pictures.ts) are drawn at their new frame: the old
// frame masked with the colour sampled around it, and the picture's pixels copied from the page bitmap's old frame
// into the new one, scaled. They are drawn under the boxes (masks, then pictures, then box masks and text).
import type { Face } from '../src/text/face.ts';
import type { Box, LaidBox, Page, Picture, Rect } from '../src/model/types.ts';
import { movedFrame } from '../src/fit/pictures.ts';

export type View = {
  /** Canvas pixels per PDF point. */
  k: number;
  /** Page height in points (PDF y is up, canvas y is down). */
  h: number;
};

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
  const { k, h } = view;
  const X0 = Math.floor(r.x0 * k) - 2, X1 = Math.ceil(r.x1 * k) + 2;
  const Y0 = Math.floor((h - r.y1) * k) - 2, Y1 = Math.ceil((h - r.y0) * k) + 2;
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

/** The pictures of a page the fitter moved or shrank, with their new frames. */
export function movedPictures(page: Page): { pic: Picture; to: Rect }[] {
  return (page.pictures ?? []).filter((p) => p.move && (Math.abs(p.move.dx) > 1e-3 || Math.abs(p.move.dy) > 1e-3 ||
    Math.abs(p.move.scale - 1) > 1e-6)).map((pic) => ({ pic, to: movedFrame(pic) }));
}

/** The rectangle hiding a moved picture where it was: its frame with a margin for antialiased edges. */
export function pictureMaskRect(p: Picture): Rect {
  const f = p.frame;
  return { x0: f.x0 - 0.75, y0: f.y0 - 0.75, x1: f.x1 + 0.75, y1: f.y1 + 0.75 };
}

export class Preview {
  private ctx: CanvasRenderingContext2D;
  private view: View;
  private drawn = new Map<string, Rect>();
  private maskColour = new Map<string, string>();
  private bitmap: ImageData;
  private source: OffscreenCanvas | null = null;   // the page bitmap as a drawImage source (pictures)
  /** What the moved pictures cover (old frames and new), so a box redraw over them draws them again. */
  private picRects: Rect[] = [];
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
    const pics = movedPictures(page);
    this.picRects = pics.flatMap(({ pic, to }) => [pictureMaskRect(pic), to]);
    this.pictures(pics);
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
    const c = this.ctx, { k, h } = this.view;
    const px = { x: Math.floor(dirty.x0 * k) - 1, y: Math.floor((h - dirty.y1) * k) - 1 };
    const pw = Math.ceil(dirty.x1 * k) + 1 - px.x, ph = Math.ceil((h - dirty.y0) * k) + 1 - px.y;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.rect(px.x, px.y, pw, ph);
    c.clip();
    c.clearRect(px.x, px.y, pw, ph);
    if (this.picRects.some((r) => meets(r, dirty!))) this.pictures(movedPictures(page));
    const hit = page.boxes.filter((b) => this.shows(b) && this.drawn.has(b.id) && meets(this.drawn.get(b.id)!, dirty!));
    for (const b of hit) this.mask(b);
    for (const b of hit) this.text(laid(b));
    c.restore();
  }

  private mask(b: Box): void {
    const c = this.ctx, { k, h } = this.view;
    const r = maskRect(b);
    const key = `${b.id}:${r.x0},${r.y0},${r.x1},${r.y1}`;
    let col = this.maskColour.get(key);
    if (!col) { col = sampleBackground(this.bitmap, this.view, r); this.maskColour.set(key, col); }
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = col;
    c.fillRect(r.x0 * k, (h - r.y1) * k, (r.x1 - r.x0) * k, (r.y1 - r.y0) * k);
    c.restore();
  }

  /** Moved pictures: every old frame masked first, then every picture's pixels at its new frame. */
  private pictures(pics: { pic: Picture; to: Rect }[]): void {
    if (!pics.length) return;
    const c = this.ctx, { k, h } = this.view;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    for (const { pic } of pics) {
      const r = pictureMaskRect(pic);
      const key = `pic:${pic.id}:${r.x0},${r.y0},${r.x1},${r.y1}`;
      let col = this.maskColour.get(key);
      if (!col) { col = sampleBackground(this.bitmap, this.view, r); this.maskColour.set(key, col); }
      c.fillStyle = col;
      // whole device pixels, one more on each side: PDFium's image edges are antialiased into the next pixel
      const X0 = Math.floor(r.x0 * k) - 1, Y0 = Math.floor((h - r.y1) * k) - 1;
      c.fillRect(X0, Y0, Math.ceil(r.x1 * k) + 1 - X0, Math.ceil((h - r.y0) * k) + 1 - Y0);
    }
    if (!this.source) {
      this.source = new OffscreenCanvas(this.bitmap.width, this.bitmap.height);
      this.source.getContext('2d')!.putImageData(this.bitmap, 0, 0);
    }
    c.imageSmoothingEnabled = true;
    c.imageSmoothingQuality = 'high';
    for (const { pic, to } of pics) {
      const f = pic.frame;
      const sx = f.x0 * k, sy = (h - f.y1) * k, sw = (f.x1 - f.x0) * k, sh = (f.y1 - f.y0) * k;
      if (sw <= 0 || sh <= 0) continue;
      c.drawImage(this.source, sx, sy, sw, sh, to.x0 * k, (h - to.y1) * k, (to.x1 - to.x0) * k, (to.y1 - to.y0) * k);
    }
    c.restore();
  }

  private text(L: LaidBox): void {
    const c = this.ctx, { k, h } = this.view;
    c.save();
    for (const line of L.lines) {
      for (const run of line.runs) {
        const face = run.face;
        if (!face) continue;
        c.fillStyle = `rgb(${run.color.map((v) => Math.round(v * 255)).join(', ')})`;
        const s = (run.size / face.upem) * k;
        // sideways glyphs (vertical text): export's `0 -1 1 0 x y Tm`, i.e. glyph (gx, gy) → page (x + gy, y - gx);
        // on the canvas (y down) that is the matrix (0, s, s, 0)
        const sideways = run.orientation === 'sideways' || face.orientation === 'sideways';
        for (const g of run.glyphs) {
          const X = (line.x + g.x) * k, Y = (h - (line.baseline + g.y)) * k;
          if (sideways) c.setTransform(0, s, s, 0, X, Y);
          else c.setTransform(s, 0, 0, -s, X, Y);
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
