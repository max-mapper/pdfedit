// The live preview over one page: edited boxes (and the selected box) drawn as the exact glyph outlines export writes (HarfBuzz glyphToPath)
// over their masked source, as web/preview.ts does, with one addition for the commit re-render: the page's base
// bitmap is either PDFium's render of the original (then every edited box and every moved picture is drawn) or the
// render of the page's committed export (then only the boxes changed since the commit, and boxes export refused,
// are drawn; each one's mask also covers where the committed render drew it, `extra`).
import type { Box, LaidBox, Page, Rect } from '../src/model/types.ts';
import type { Face } from '../src/text/face.ts';
import { drawnRect, maskRect, movedPictures, pictureMaskRect, sampleBackground, type View } from '../web/preview.ts';

export type OverlayMode = {
  /** Which boxes the overlay draws (edited boxes, and the selected one: the editor draws a box as soon as it has the
   *  focus, so what the handles outline and the caret follow is what is drawn). */
  include(b: Box): boolean;
  /** More area to mask for a box: where the committed render drew it. */
  extra(id: string): Rect | undefined;
  /** Draw the fitter's moved pictures (the base is the original render). */
  pictures: boolean;
};

const paths = new Map<number, Map<number, Path2D>>();
function glyphPath(face: Face, gid: number): Path2D {
  let m = paths.get(face.id);
  if (!m) { m = new Map(); paths.set(face.id, m); }
  let p = m.get(gid);
  if (!p) { p = new Path2D(face.hbFont.glyphToPath(gid)); m.set(gid, p); }
  return p;
}

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private view: View;
  private bitmap: ImageData;
  private mode: OverlayMode;
  private drawn = new Map<string, Rect>();
  private colours = new Map<string, string>();
  private picRects: Rect[] = [];
  private source: OffscreenCanvas | null = null;

  constructor(canvas: HTMLCanvasElement, bitmap: ImageData, view: View, mode: OverlayMode) {
    this.ctx = canvas.getContext('2d')!;
    this.view = view;
    this.bitmap = bitmap;
    this.mode = mode;
  }

  private maskOf(b: Box): Rect {
    const x = this.mode.extra(b.id);
    return x ? union(maskRect(b), x) : maskRect(b);
  }

  private areaOf(b: Box, L: LaidBox): Rect {
    const x = this.mode.extra(b.id);
    return x ? union(drawnRect(b, L), x) : drawnRect(b, L);
  }

  private shown(page: Page): Box[] {
    return page.boxes.filter((b) => this.mode.include(b));
  }

  /** Clears and draws everything the mode includes. */
  drawAll(page: Page, laid: (b: Box) => LaidBox): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    this.drawn.clear();
    const pics = this.mode.pictures ? movedPictures(page) : [];
    this.picRects = pics.flatMap(({ pic, to }) => [pictureMaskRect(pic), to]);
    this.pictures(page);
    const boxes = this.shown(page);
    const L = new Map(boxes.map((b) => [b.id, laid(b)]));
    for (const b of boxes) this.mask(b);
    for (const b of boxes) { this.text(L.get(b.id)!); this.drawn.set(b.id, this.areaOf(b, L.get(b.id)!)); }
  }

  /** Redraws the boxes `ids` changed: what they covered and cover now is cleared, and every drawn box meeting that
   *  area is drawn again inside it (masks first, then text). */
  redraw(page: Page, ids: string[], laid: (b: Box) => LaidBox): void {
    let dirty: Rect | null = null;
    const now = new Map<string, Rect>();
    for (const id of ids) {
      const old = this.drawn.get(id);
      if (old) dirty = union(dirty, old);
      const b = page.boxes.find((x) => x.id === id);
      if (b && this.mode.include(b)) { const r = this.areaOf(b, laid(b)); now.set(id, r); dirty = union(dirty, r); }
      else this.drawn.delete(id);
    }
    for (const [id, r] of now) this.drawn.set(id, r);
    for (const id of [...this.drawn.keys()]) if (!page.boxes.some((b) => b.id === id)) { dirty = union(dirty, this.drawn.get(id)!); this.drawn.delete(id); }
    if (!dirty) return;
    const d = dirty;
    const c = this.ctx, { k, h } = this.view;
    const px = { x: Math.floor(d.x0 * k) - 1, y: Math.floor((h - d.y1) * k) - 1 };
    const pw = Math.ceil(d.x1 * k) + 1 - px.x, ph = Math.ceil((h - d.y0) * k) + 1 - px.y;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.beginPath();
    c.rect(px.x, px.y, pw, ph);
    c.clip();
    c.clearRect(px.x, px.y, pw, ph);
    if (this.picRects.some((r) => meets(r, d))) this.pictures(page);
    const hit = this.shown(page).filter((b) => this.drawn.has(b.id) && meets(this.drawn.get(b.id)!, d));
    for (const b of hit) this.mask(b);
    for (const b of hit) this.text(laid(b));
    c.restore();
  }

  /** Canvas pixels with any paint inside a page rectangle (the smoke check that committed boxes left the overlay). */
  paintedIn(r: Rect): number {
    const { k, h } = this.view;
    const x = Math.max(0, Math.floor(r.x0 * k)), y = Math.max(0, Math.floor((h - r.y1) * k));
    const w = Math.max(1, Math.ceil((r.x1 - r.x0) * k)), hh = Math.max(1, Math.ceil((r.y1 - r.y0) * k));
    const px = this.ctx.getImageData(x, y, w, hh).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) n++;
    return n;
  }

  private colour(key: string, r: Rect): string {
    let col = this.colours.get(key);
    if (!col) { col = sampleBackground(this.bitmap, this.view, r); this.colours.set(key, col); }
    return col;
  }

  private mask(b: Box): void {
    const c = this.ctx, { k, h } = this.view;
    const r = this.maskOf(b);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = this.colour(`${b.id}:${r.x0},${r.y0},${r.x1},${r.y1}`, r);
    c.fillRect(r.x0 * k, (h - r.y1) * k, (r.x1 - r.x0) * k, (r.y1 - r.y0) * k);
    c.restore();
  }

  private pictures(page: Page): void {
    if (!this.mode.pictures) return;
    const pics = movedPictures(page);
    if (!pics.length) return;
    const c = this.ctx, { k, h } = this.view;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    for (const { pic } of pics) {
      const r = pictureMaskRect(pic);
      c.fillStyle = this.colour(`pic:${pic.id}:${r.x0},${r.y0},${r.x1},${r.y1}`, r);
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
        // sideways glyphs (vertical text) are written under `0 -1 1 0 x y Tm`: on the canvas (y down) (0, s, s, 0)
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

export function union(a: Rect | null, b: Rect): Rect {
  return a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b };
}

function meets(a: Rect, b: Rect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}
