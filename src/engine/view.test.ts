// The page view (src/engine/view.ts) against PDFium: synthetic pages with /Rotate 0, 90, 180 and 270, with and
// without a crop box away from the origin. A red rectangle drawn at a known user-space place must render where
// toView says, PDFium's page size must be the view's, and the pixel diff must skip exactly that rectangle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { openPdfium, type Bitmap, type Rect } from './pdfium.ts';
import { diffOutside } from './diff.ts';
import { deviceMatrix, dragInUser, fromView, isPlain, plainView, rectFromView, rectToPixels, rectToView, toView, viewBox } from './view.ts';

const RED: Rect = { x0: 60, y0: 110, x1: 100, y1: 130 };

async function page(rotate: number, crop: Rect | null, red = true): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const pg = d.addPage([500, 800]);
  if (red) pg.drawRectangle({ x: RED.x0, y: RED.y0, width: RED.x1 - RED.x0, height: RED.y1 - RED.y0, color: rgb(1, 0, 0) });
  pg.drawRectangle({ x: 300, y: 500, width: 30, height: 30, color: rgb(0, 0, 1) });
  pg.setRotation(degrees(rotate));
  if (crop) pg.setCropBox(crop.x0, crop.y0, crop.x1 - crop.x0, crop.y1 - crop.y0);
  return d.save();
}

/** The device-pixel bounds of the red ink in a render. */
function redInk(b: Bitmap): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const k = (y * b.width + x) * 4;
    if (b.rgba[k] > 200 && b.rgba[k + 1] < 60 && b.rgba[k + 2] < 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
  }
  return { x0, y0, x1, y1 };
}

const near = (a: Rect, b: Rect, tol = 1.01) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;

for (const rotate of [0, 90, 180, 270]) {
  for (const crop of [null, { x0: 50, y0: 100, x1: 450, y1: 700 }]) {
    test(`/Rotate ${rotate}${crop ? ', crop box at 50,100' : ''}: size, render placement and the pixel diff follow the view`, async () => {
      const P = await openPdfium();
      const doc = P.open(await page(rotate, crop));
      const pg = doc.page(0);
      try {
        const v = pg.view;
        assert.equal(v.rotate, rotate);
        const c = crop ?? { x0: 0, y0: 0, x1: 500, y1: 800 };
        assert.ok(near(v.crop, c, 0.01), JSON.stringify(v.crop));
        const want = viewBox(rotate, c);
        assert.ok(Math.abs(pg.size.w - want.w) < 0.01 && Math.abs(pg.size.h - want.h) < 0.01, JSON.stringify(pg.size));
        assert.equal(isPlain(v), rotate === 0 && !crop);
        for (const scale of [1, 1.5]) {
          const bmp = pg.render(scale);
          const ink = redInk(bmp);
          const px = rectToPixels(v, RED, scale, v.h);
          assert.ok(near(ink, px, 1.01 + scale), `scale ${scale}: ink ${JSON.stringify(ink)} predicted ${JSON.stringify(px)}`);
        }
        // the diff against the same page without the red rectangle: everything differing is inside RED's region
        const d2 = P.open(await page(rotate, crop, false));
        const p2 = d2.page(0);
        try {
          const a = pg.render(1), b = p2.render(1);
          assert.ok(diffOutside(a, b, [], 1, v).differing > 100, 'the red rectangle differs');
          assert.equal(diffOutside(a, b, [RED], 1, v).differing, 0);
        } finally { p2.close(); d2.close(); }
      } finally { pg.close(); doc.close(); }
    });
  }
}

test('toView and fromView are inverse; rectangles map exactly under quarter turns', () => {
  for (const rotate of [0, 90, 180, 270, -90, 450]) {
    const v = viewBox(rotate, { x0: 50, y0: 100, x1: 450, y1: 700 });
    for (const [x, y] of [[50, 100], [450, 700], [60, 110], [123.5, 456.25]]) {
      const [vx, vy] = toView(v, x, y);
      const [ux, uy] = fromView(v, vx, vy);
      assert.ok(Math.abs(ux - x) < 1e-9 && Math.abs(uy - y) < 1e-9, `${rotate}: ${x},${y}`);
      assert.ok(vx >= -1e-9 && vx <= v.w + 1e-9 && vy >= -1e-9 && vy <= v.h + 1e-9, `${rotate}: inside the shown page`);
    }
    const r = rectToView(v, RED);
    assert.ok(near(rectFromView(v, r), RED, 1e-9));
    assert.ok(Math.abs((r.x1 - r.x0) * (r.y1 - r.y0) - 800) < 1e-9);
  }
  const plain = plainView(595, 842);
  assert.deepEqual(toView(plain, 10, 20), [10, 20]);
  assert.deepEqual(toView(undefined, 10, 20), [10, 20]);
  // a turned page: the user-space bottom-left corner of the crop box is the shown page's top-left at 90
  assert.deepEqual(toView(viewBox(90, { x0: 0, y0: 0, x1: 500, y1: 800 }), 0, 0), [0, 500]);
});

test('deviceMatrix puts a user point where rectToPixels does, on every turn and crop', () => {
  for (const rotate of [0, 90, 180, 270]) for (const crop of [{ x0: 0, y0: 0, x1: 500, y1: 800 }, { x0: 50, y0: 100, x1: 450, y1: 700 }]) {
    const v = viewBox(rotate, crop);
    const m = deviceMatrix(v, 2);
    const r = rectToPixels(v, RED, 2, v.h);
    const pts = [[RED.x0, RED.y0], [RED.x1, RED.y1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const got: Rect = { x0: Math.min(pts[0][0], pts[1][0]), y0: Math.min(pts[0][1], pts[1][1]), x1: Math.max(pts[0][0], pts[1][0]), y1: Math.max(pts[0][1], pts[1][1]) };
    assert.ok(near(got, r, 1e-9), `${rotate}: ${JSON.stringify(got)} vs ${JSON.stringify(r)}`);
  }
});

test('dragInUser: a handle as the person sees it is the user-space edge it is on; movement in user points', () => {
  const crop = { x0: 50, y0: 100, x1: 450, y1: 700 };
  assert.deepEqual(dragInUser(viewBox(0, crop), 'se', 30, 15, 1.5), { h: 'se', dx: 20, dy: 10 });
  // turned 90° clockwise: the shown right edge is the user top (n); moving right on screen is user +y
  const r90 = dragInUser(viewBox(90, crop), 'e', 30, 0, 1.5);
  assert.equal(r90.h, 'n');
  assert.ok(Math.abs(r90.dx) < 1e-9 && Math.abs(r90.dy + 20) < 1e-9, JSON.stringify(r90));
  // 180: the shown top-left corner is the user bottom-right; moving down on screen is user +y
  const r180 = dragInUser(viewBox(180, crop), 'nw', 0, 15, 1.5);
  assert.equal(r180.h, 'se');
  assert.ok(Math.abs(r180.dy + 10) < 1e-9, JSON.stringify(r180));
  // 270: the shown bottom edge is the user left edge
  assert.equal(dragInUser(viewBox(270, crop), 's', 0, 0, 1).h, 'w');
  assert.equal(dragInUser(viewBox(90, crop), 'move', 3, 3, 1).h, 'move');
});
