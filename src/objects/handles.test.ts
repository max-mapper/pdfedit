// The handles' geometry (src/objects/handles.ts) and "Move with its crop" (src/objects/surgery.ts clipFates and the
// split, through src/export/objects.ts) on synthetic pages (src/objects/handlekit.ts). Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rect } from '../engine/pdfium.ts';
import { toView, viewBox } from '../engine/view.ts';
import { apply, mul, type M6 } from '../pdf/ops.ts';
import { changedOutside, colour, like, near, passed, render, run } from './groupcheck.ts';
import { HANDLE_AT, handlePages } from './handlekit.ts';
import {
  addedAfter, addedQuad, dragAngle, HANDLES, inQuad, quadCentre, quadRect, rectQuad, resizeMatrix, rotationHandle, translate, turnAbout, type Pt,
} from './handles.ts';
import { listObjects } from './list.ts';
import { applyOps, mapRect } from './ops.ts';
import { imageMatrix } from './place.ts';
import { clipFates } from './surgery.ts';
import type { PageObjects } from './types.ts';

const H = (id: string) => HANDLES.find((h) => h.id === id)!;
const close = (a: Pt, b: Pt, tol = 1e-6) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;
const mapQ = (q: Pt[], m: M6) => q.map(([x, y]) => apply(m, x, y));
const GREEN: [number, number, number] = [20, 160, 60], WHITE: [number, number, number] = [255, 255, 255];

test('resize: a corner scales about the opposite corner; an edge along one axis; Shift keeps the proportions; Alt about the centre', () => {
  const q = rectQuad({ x0: 100, y0: 200, x1: 200, y1: 250 });
  // ne dragged to (240, 270): 1.4 × 1.4, sw fixed
  const T = resizeMatrix(q, H('ne'), [240, 270]);
  assert.ok(near(quadRect(mapQ(q, T)), { x0: 100, y0: 200, x1: 240, y1: 270 }, 1e-9));
  // e to x = 150: half as wide, the height kept
  assert.ok(near(quadRect(mapQ(q, resizeMatrix(q, H('e'), [150, 999]))), { x0: 100, y0: 200, x1: 150, y1: 250 }, 1e-9));
  // Shift on a corner: the axis that changed most sets both (x: 2×, y: 1.2× → 2×)
  const k = quadRect(mapQ(q, resizeMatrix(q, H('ne'), [300, 260], { keepAspect: true })));
  assert.ok(near(k, { x0: 100, y0: 200, x1: 300, y1: 300 }, 1e-9), JSON.stringify(k));
  // Shift on an edge: the other axis scales about its middle
  const ke = quadRect(mapQ(q, resizeMatrix(q, H('e'), [300, 0], { keepAspect: true })));
  assert.ok(near(ke, { x0: 100, y0: 175, x1: 300, y1: 275 }, 1e-9), JSON.stringify(ke));
  // Alt: about the centre (150, 225)
  const kc = quadRect(mapQ(q, resizeMatrix(q, H('ne'), [250, 275], { fromCentre: true })));
  assert.ok(near(kc, { x0: 50, y0: 175, x1: 250, y1: 275 }, 1e-9), JSON.stringify(kc));
  // past the anchor: never flipped, never below a point
  const tiny = quadRect(mapQ(q, resizeMatrix(q, H('ne'), [0, 0])));
  assert.ok(tiny.x1 - tiny.x0 >= 0.999 && tiny.y1 - tiny.y0 >= 0.999 && tiny.x0 === 100 && tiny.y0 === 200, JSON.stringify(tiny));
});

test('resize a turned image along its own axes: its angle stays and the opposite corner stays put', () => {
  const ctm = mul([100, 0, 0, 50, 0, 0], turnAbout([0, 0], 30));
  const q = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(mul(ctm, translate(300, 300)), x, y)) as Pt[];
  const ne = q[2];
  const T = resizeMatrix(q, H('ne'), [ne[0] + 20, ne[1] + 30]);
  const r = mapQ(q, T);
  assert.ok(close(r[0], q[0], 1e-9), 'sw fixed');
  const ang = (a: Pt, b: Pt) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  assert.ok(Math.abs(ang(r[0], r[1]) - ang(q[0], q[1])) < 1e-9 && Math.abs(ang(r[0], r[3]) - ang(q[0], q[3])) < 1e-9, 'edges keep their directions');
  assert.ok(Math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]) > 100 && Math.hypot(r[3][0] - r[0][0], r[3][1] - r[0][1]) > 50, 'it grew');
});

test('turns: the drag angle about the centre, Shift snaps to 15°; quarter turns map a box onto a box', () => {
  const c: Pt = [100, 100];
  assert.equal(dragAngle(c, [200, 100], [100, 200]), 90);
  assert.ok(Math.abs(dragAngle(c, [200, 100], [200, 120]) - (Math.atan2(20, 100) * 180) / Math.PI) < 1e-9);
  assert.equal(dragAngle(c, [200, 100], [200, 120], 15), 15);
  assert.equal(dragAngle(c, [200, 100], [200, 101], 15), 0);
  const q = rectQuad({ x0: 50, y0: 80, x1: 150, y1: 120 });
  const t = quadRect(mapQ(q, turnAbout(quadCentre(q), 90)));
  assert.ok(near(t, { x0: 80, y0: 50, x1: 120, y1: 150 }, 1e-9), JSON.stringify(t));
  assert.ok(inQuad(mapQ(q, turnAbout([0, 0], 45)), ...apply(turnAbout([0, 0], 45), 100, 100)));
  assert.ok(!inQuad(q, 151, 100) && inQuad(q, 151, 100, 1.5));
});

test('the rotation handle sits beyond the edge shown highest, on every page turn', () => {
  const q = rectQuad({ x0: 100, y0: 200, x1: 200, y1: 250 });
  const crop = { x0: 0, y0: 0, x1: 500, y1: 800 };
  const want: Record<number, Pt> = { 0: [150, 270], 90: [80, 225], 180: [150, 180], 270: [220, 225] };
  for (const r of [0, 90, 180, 270]) {
    const v = viewBox(r, crop);
    const { at } = rotationHandle(q, (x, y) => toView(v, x, y), 20);
    assert.ok(close(at, want[r], 1e-9), `${r}: ${at}`);
  }
});

test('added images: a move, a resize and a quarter turn read back as a frame and a quarter turn; a free turn does not', () => {
  const f: Rect = { x0: 100, y0: 100, x1: 220, y1: 160 };
  const m = addedAfter(f, 0, translate(10, -5));
  assert.deepEqual(m, { frame: { x0: 110, y0: 95, x1: 230, y1: 155 }, rotate: 0 });
  const q = addedQuad(f, 90);
  const s = addedAfter(f, 90, resizeMatrix(q, H('ne'), squarePoint(q, 2, 1)));
  assert.ok(s && s.rotate === 90, JSON.stringify(s));
  for (const r of [0, 90, 180, 270] as const) {
    const T = turnAbout(quadCentre(addedQuad(f, r)), 90);
    const a = addedAfter(f, r, T)!;
    assert.ok(a, `quarter turn from ${r}`);
    const got = imageMatrix(a.frame, a.rotate), want = mul(imageMatrix(f, r), T);
    assert.ok(got.every((v, k) => Math.abs(v - want[k]) < 1e-6), `${r}: ${got} vs ${want}`);
    assert.ok(near(a.frame, { x0: 130, y0: 70, x1: 190, y1: 190 }, 1e-9), JSON.stringify(a.frame));
  }
  assert.equal(addedAfter(f, 0, turnAbout([160, 130], 30)), null);
});
function squarePoint(q: Pt[], s: number, t: number): Pt { return [q[0][0] + s * (q[1][0] - q[0][0]) + t * (q[3][0] - q[0][0]), q[0][1] + s * (q[1][1] - q[0][1]) + t * (q[3][1] - q[0][1])]; }

test('the latest choice about a shared crop stands (sharedClip, dropSharedClip)', async () => {
  const f = await handlePages();
  const [m] = await listObjects(f.bytes, [0]);
  const img = m.objects.find((o) => o.kind === 'image')!;
  const a = applyOps(m, [{ op: 'transform', ids: [img.id], m: translate(1, 0), dropSharedClip: true }, { op: 'transform', ids: [img.id], m: translate(1, 0), sharedClip: 'move' }]);
  assert.ok(a.moveClip.has(img.id) && !a.dropClip.has(img.id));
  const b = applyOps(m, [{ op: 'transform', ids: [img.id], m: translate(1, 0), sharedClip: 'move' }, { op: 'transform', ids: [img.id], m: translate(1, 0), sharedClip: 'drop' }]);
  assert.ok(b.dropClip.has(img.id) && !b.moveClip.has(img.id));
});

/** The page's objects: the two cropped images and the squares sharing their clips. */
function cropped(m: PageObjects) {
  const imgs = m.objects.filter((o) => o.kind === 'image');
  const green = imgs.find((o) => near(o.bounds, HANDLE_AT.green))!, red = imgs.find((o) => near(o.bounds, HANDLE_AT.red))!;
  return { green, red, clips: new Map(m.clips.map((c) => [c.id, c])) };
}

test('clipFates: a shared clip that crops the object asks for the choice; one that holds it at both places stays', async () => {
  const f = await handlePages();
  const [m] = await listObjects(f.bytes, [0]);
  const { green, red, clips } = cropped(m);
  const g = clipFates(green, translate(250, -300), clips);
  assert.equal(g.refuse, null);
  assert.deepEqual(g.clips.map((c) => c.fate), ['crop']);
  assert.equal(g.clips[0].clip.users, 2);
  assert.deepEqual(clipFates(red, translate(0, 0), clips).clips.map((c) => [c.fate, c.clip.rect]), [['crop', false]]);
  const blue = m.objects.find((o) => near(o.bounds, HANDLE_AT.blue))!;
  assert.deepEqual(clipFates(blue, translate(10, 0), clips).clips, []);
});

for (const which of ['rect', 'triangle'] as const) {
  test(`move with its crop (${which} clip): the image keeps its cropped shape at the new place; the square sharing the clip stays`, async () => {
    const f = await handlePages();
    const [m] = await listObjects(f.bytes, [0]);
    const { green, red, clips } = cropped(m);
    const o = which === 'rect' ? green : red;
    const clip = clips.get(o.clips[0])!;
    const M = translate(which === 'rect' ? 300 : -230, which === 'rect' ? -150 : -150);
    const refused = await run(f.bytes, [{ op: 'transform', ids: [o.id], m: M }]);
    assert.match(refused.pr.objectsSkipped![0].reason, /move with its crop/);
    const r = await run(f.bytes, [{ op: 'transform', ids: [o.id], m: M, sharedClip: 'move' }]);
    passed(r);
    const to = mapRect(o.bounds, M);
    assert.equal(await changedOutside(f.bytes, r.out, [o.bounds, to]), 0, 'nothing changed outside the old and new bounds');
    assert.deepEqual(r.pr.objectsChanged![0].split, [clip.id], 'a copy of the clip moved with it');
    const img = await render(r.out);
    if (which === 'rect') {
      const c = mapRect(HANDLE_AT.rectClip, M);
      assert.ok(like(colour(img, c.x0 + 3, c.y0 + 3), GREEN) && like(colour(img, c.x1 - 3, c.y1 - 3), GREEN), 'inside the moved clip: the image');
      assert.ok(like(colour(img, to.x0 + 3, to.y0 + 3), WHITE) && like(colour(img, to.x1 - 3, to.y1 - 3), WHITE), 'outside it: still cropped away');
      assert.ok(like(colour(img, 100, 520), [51, 51, 204]), 'the square sharing the clip is painted as before');
      assert.ok(like(colour(img, 160, 540), WHITE), 'the old place is empty');
    } else {
      const [cx, cy] = apply(M, 350, 540);
      assert.ok(like(colour(img, cx, cy), [220, 30, 30]), 'inside the moved triangle: the image');
      const [ox, oy] = apply(M, 305, 590);
      assert.ok(like(colour(img, ox, oy), WHITE), 'outside the moved triangle: cropped away');
      assert.ok(like(colour(img, 350, 515), [0, 0, 0]), 'the square sharing the clip is painted as before');
      assert.ok(like(colour(img, 350, 560), WHITE), 'the old place is empty');
    }
  });
}

test('a page turned by /Rotate 90: edited text that wraps onto two lines is written and verified', async () => {
  const { replaceText } = await import('../export/replace.ts');
  const { openPdfium } = await import('../engine/pdfium.ts');
  const f = await handlePages();
  const res = await replaceText(f.bytes, { 'Turned page text': 'Turned page text more' }, { pages: [1] });
  assert.ok(res.export?.ok, JSON.stringify(res.export?.failures));
  assert.equal(res.replaced.length, 1);
  const P = await openPdfium();
  const d = P.open(res.bytes!);
  try {
    const pg = d.page(1);
    try {
      const chars = pg.chars().filter((c) => c.unicode.trim());
      const top = Math.max(...chars.map((c) => c.origin[1]));
      const lines = [chars.filter((c) => c.origin[1] > top - 5), chars.filter((c) => c.origin[1] <= top - 5)].map((l) => l.sort((a, b) => a.origin[0] - b.origin[0]).map((c) => c.unicode).join(''));
      assert.deepEqual(lines, ['Turnedpagetext', 'more'], 'two lines in user space, as the box lays them out');
    } finally { pg.close(); }
  } finally { d.close(); }
});
