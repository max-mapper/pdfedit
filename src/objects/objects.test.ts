// The page object model (src/objects) on synthetic pages: every object kind in paint order with stable ids and
// page-space bounds, forms entered as groups, clips (a shared one, an own one, a form's box), marked content, the
// match with PDFium's object list, the render hit test with overlapping objects, and a rotated page with an offset
// crop box. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdfium, type Rect } from '../engine/pdfium.ts';
import { listObjects, objectLine } from './list.ts';
import { objectsPage, rotatedPage } from './testkit.ts';
import type { PageObject } from './types.ts';

const near = (a: Rect, b: Rect, tol = 0.6) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const inside = (r: Rect, x: number, y: number) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

test('every object kind in paint order, with ids, bounds, groups, clips and marked content; all matched to PDFium', async () => {
  const f = await objectsPage();
  const [p] = await listObjects(f.bytes);
  assert.deepEqual(p.notes, [], p.notes.join('; '));
  const kinds = p.objects.map((o) => o.kind);
  assert.deepEqual(kinds, [
    'text', 'path', 'path', 'path',            // heading, grey, green, ring
    'image', 'image',                          // red and blue under the shared clip
    'image',                                   // the masked image in its own q … Q
    'inline-image', 'shading',
    'form', 'path', 'path',                    // the badge (square, ring)
    'form', 'path', 'path',                    // the badge again
    'form', 'path', 'path', 'path',            // the logo: a vector group of three paths
  ], p.objects.map(objectLine).join('\n'));
  p.objects.forEach((o, k) => assert.equal(o.z, k));
  assert.ok(p.objects.every((o) => o.engine !== undefined), 'every object has its PDFium object');
  const by = (pred: (o: PageObject) => boolean) => p.objects.filter(pred);
  const [grey, green, ring] = by((o) => o.kind === 'path' && o.path.length === 0);
  assert.ok(near(grey.bounds, f.at.grey) && near(green.bounds, f.at.green), `${JSON.stringify(grey.bounds)} ${JSON.stringify(green.bounds)}`);
  assert.ok(near(ring.bounds, f.at.ring, 2.1), 'a stroked path is widened by half its line width');
  assert.equal(ring.paint, 'S');
  // ids: the operator index in the page's stream; inside a form, the Do's index first
  assert.match(grey.id, /^\d+$/);
  const [badge1, badge2, logo] = by((o) => o.kind === 'form');
  assert.ok(near(badge1.bounds, f.at.badge1) && near(badge2.bounds, f.at.badge2) && near(logo.bounds, f.at.logo));
  assert.equal(badge1.uses, 2, 'the badge is painted twice');
  assert.equal(logo.uses, 1);
  assert.equal(logo.children!.length, 3);
  for (const id of logo.children!) {
    const c = p.objects.find((o) => o.id === id)!;
    assert.equal(c.parent, logo.id);
    assert.ok(c.id.startsWith(`${logo.id}/`), c.id);
    assert.ok(c.clips.includes(`${logo.id}#bbox`), 'a form\'s contents are clipped to its box');
    assert.ok(c.bounds.x0 >= f.at.logo.x0 - 0.6 && c.bounds.x1 <= f.at.logo.x1 + 0.6);
  }
  assert.notEqual(badge1.children![0], badge2.children![0], 'one form painted twice gives two sets of objects');
  // images: the shared clip has two users, the masked image's own clip one; the masked image is in marked content
  const [red, blue, masked] = by((o) => o.kind === 'image');
  assert.ok(near(red.bounds, f.at.red) && near(blue.bounds, f.at.blue) && near(masked.bounds, f.at.masked));
  assert.deepEqual(red.clips, blue.clips);
  const shared = p.clips.find((c) => c.id === red.clips[0])!;
  assert.equal(shared.users, 2);
  assert.ok(shared.rect && near(shared.bounds, f.at.shared));
  assert.ok(red.group, 'each image has a q … Q of its own inside the shared clip');
  assert.ok(masked.smask, 'the PNG with transparency has a soft mask');
  assert.deepEqual(masked.pixels, [8, 8]);
  assert.deepEqual(masked.marked, [{ tag: 'Figure', mcid: 3 }]);
  const own = p.clips.find((c) => c.id === masked.clips[0])!;
  assert.equal(own.users, 1);
  assert.ok(masked.group, 'the clip and the image share one q … Q');
  const inline = by((o) => o.kind === 'inline-image')[0];
  assert.ok(near(inline.bounds, f.at.inline));
  assert.deepEqual(inline.pixels, [2, 2]);
  const sh = by((o) => o.kind === 'shading')[0];
  assert.ok(near(sh.bounds, f.at.shading), 'a shading fills its clip');
  assert.equal(sh.name, 'Sh1');
  const text = by((o) => o.kind === 'text')[0];
  assert.ok(text.bounds.x0 > 70 && text.bounds.x0 < 74 && text.bounds.y1 > 780, 'text takes PDFium\'s bounds');
  assert.equal(text.chars, 'Synthetic heading'.length);
});

test('the render hit test: the topmost painted object at a point, not just the bounds', async () => {
  const f = await objectsPage();
  const [p] = await listObjects(f.bytes);
  const P = await openPdfium();
  const doc = P.open(f.bytes);
  const pg = doc.page(0);
  try {
    const under = (x: number, y: number) => p.objects.filter((o) => inside(o.bounds, x, y));
    const paints = (x: number, y: number) => {
      const c = under(x, y);
      const hit = pg.paintsAt(c.map((o) => o.engine!), x, y);
      return c.filter((_, k) => hit[k]).map((o) => o.kind + ':' + o.id);
    };
    // where grey and green overlap: green is on top and hides grey there
    const [grey, green, ring] = p.objects.filter((o) => o.kind === 'path' && o.path.length === 0);
    assert.deepEqual(under(150, 660).map((o) => o.id), [grey.id, green.id]);
    assert.deepEqual(paints(150, 660), [`path:${green.id}`]);
    // grey alone
    assert.deepEqual(paints(90, 610), [`path:${grey.id}`]);
    // the ring's middle: inside its bounds, painted by nothing
    assert.ok(under(350, 640).some((o) => o.id === ring.id));
    assert.deepEqual(paints(350, 640), []);
    assert.deepEqual(paints(300, 640), [`path:${ring.id}`]);
    // the masked image's transparent half paints nothing; its opaque half paints
    const masked = p.objects.find((o) => o.kind === 'image' && o.smask)!;
    assert.deepEqual(paints(320, 450), []);
    assert.deepEqual(paints(380, 450), [`image:${masked.id}`]);
    // inside the logo: the white path on top of the blue one
    const logo = p.objects.find((o) => o.kind === 'form' && o.children!.length === 3)!;
    const hits = paints(300, 220);
    assert.ok(hits.includes(`path:${logo.children![1]}`), hits.join(' '));
    assert.ok(!hits.includes(`path:${logo.children![0]}`), 'the blue path is covered there');
  } finally { pg.close(); doc.close(); }
});

for (const rotate of [90, 180, 270] as const) {
  test(`a page with /Rotate ${rotate} and a crop box away from the origin: bounds stay in user space; the hit test follows the view`, async () => {
    const f = await rotatedPage(rotate);
    const [p] = await listObjects(f.bytes);
    assert.deepEqual(p.notes, []);
    assert.equal(p.view.rotate, rotate);
    const [img, sq] = p.objects;
    assert.equal(img.kind, 'image');
    assert.ok(near(img.bounds, f.at.image) && near(sq.bounds, f.at.square));
    const P = await openPdfium();
    const doc = P.open(f.bytes);
    const pg = doc.page(0);
    try {
      assert.deepEqual(pg.paintsAt([img.engine!, sq.engine!], 140, 220), [true, false]);
      assert.deepEqual(pg.paintsAt([img.engine!, sq.engine!], 330, 530), [false, true]);
    } finally { pg.close(); doc.close(); }
  });
}
