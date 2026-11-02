// Selecting overlapping objects (src/objects/hit.ts) on synthetic pages: the topmost painted object wins over the
// bounds alone; cycling down through the objects under a point; Tab order; groups (form XObjects) as one entry and
// their members inside; text boxes as candidates; the geometric test where the render sees nothing (white on white,
// a stroke, an even-odd hole, an image's transparent part); clips that cut; a turned page; and edits (a deleted or a
// moved object). Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdfium, type PdfPage } from '../engine/pdfium.ts';
import { openForEdit } from '../pdf/edit.ts';
import { buildPath, buildScene, candidatesAt, cycle, geometricHit, groupsOf, hitGeometry, insideFill, rank, renderQuery, tabOrder, tabStep, type ObjectEdits, type Scene, type TextBoxRef } from './hit.ts';
import { pageObjects } from './list.ts';
import { OVERLAP_POINTS as P, overlapPages } from './selectkit.ts';
import { objectsPage, rotatedPage } from './testkit.ts';

type Loaded = { scene: (o?: { boxes?: 'all' | TextBoxRef[]; edits?: ObjectEdits; }) => Scene; click: (sc: Scene, x: number, y: number, level?: string | null) => ReturnType<typeof rank>; close: () => void; pg: PdfPage };

async function load(bytes: Uint8Array, n = 0): Promise<Loaded> {
  const pdfium = await openPdfium();
  const edit = await openForEdit(bytes);
  const doc = pdfium.open(bytes);
  const pg = doc.page(n);
  const model = pageObjects(edit, pg);
  assert.deepEqual(model.notes, []);
  const geometry = hitGeometry(edit, pg, model);
  // a text box per PDFium text object, its frame the object's bounds (the editor detects boxes; this stands in)
  const allBoxes: TextBoxRef[] = pg.textObjects().map((t, i) => ({ id: `t${i}`, frame: t.bounds, objs: [i] }));
  const scene = (o: { boxes?: 'all' | TextBoxRef[]; edits?: ObjectEdits } = {}) =>
    buildScene(model, { geometry, boxes: o.boxes === 'all' ? allBoxes : o.boxes ?? [], edits: o.edits });
  const click = (sc: Scene, x: number, y: number, level: string | null = null) => {
    const c = candidatesAt(sc, x, y, level);
    const ask = renderQuery(sc, c, x, y);
    const got = ask.length ? pg.paintsAt(ask, x, y) : [];
    return rank(sc, c, x, y, new Map(ask.map((e, k) => [e, got[k]])));
  };
  return { scene, click, pg, close: () => { pg.close(); doc.close(); } };
}

const ids = (r: { order: { id: string }[] }) => r.order.map((s) => s.id);

test('overlapping filled paths: the one on top is hit, Alt-click cycles down and wraps; a ring\'s middle hits nothing', async () => {
  const L = await load((await objectsPage()).bytes);
  try {
    const sc = L.scene();
    const [grey, green, ring] = sc.items.filter((s) => s.kind === 'vector' && s.parent === null);
    const r = L.click(sc, 150, 660);
    assert.equal(r.hit?.id, green.id);
    assert.deepEqual(ids(r), [green.id, grey.id]);
    assert.ok(r.paints.has(green.id) && !r.paints.has(grey.id), 'grey is covered there');
    assert.equal(cycle(r.order, green.id)?.id, grey.id);
    assert.equal(cycle(r.order, grey.id)?.id, green.id, 'it wraps');
    assert.equal(cycle(r.order, green.id, -1)?.id, grey.id);
    const mid = L.click(sc, 350, 640);
    assert.equal(mid.hit, null, 'the ring\'s middle is inside its bounds but painted by nothing');
    assert.deepEqual(ids(mid), [ring.id]);
    assert.equal(L.click(sc, 300.5, 640).hit?.id, ring.id, 'on the ring\'s stroke');
  } finally { L.close(); }
});

test('clips cut: a point outside an object\'s clip never hits it; a masked image\'s clear part falls back to the geometry', async () => {
  const L = await load((await objectsPage()).bytes);
  try {
    const sc = L.scene();
    const [red, blue, masked] = sc.items.filter((s) => s.kind === 'image');
    assert.ok(red.clipped && blue.clipped && masked.clipped);
    assert.ok(!candidatesAt(sc, 65, 450).some((s) => s.id === red.id), 'red\'s bounds start at 60, the shared clip at 72');
    assert.equal(L.click(sc, 100, 450).hit?.id, red.id);
    assert.equal(L.click(sc, 175, 450).hit?.id, blue.id, 'blue is painted after red');
    const clear = L.click(sc, 320, 450);
    assert.equal(clear.paints.size, 0, 'nothing paints in the transparent half');
    assert.equal(clear.hit?.id, masked.id, 'the image\'s square decides');
    assert.ok(L.click(sc, 380, 450).paints.has(masked.id));
  } finally { L.close(); }
});

test('a form XObject is one entry (a vector group); entering it, its members are the candidates', async () => {
  const L = await load((await objectsPage()).bytes);
  try {
    const sc = L.scene();
    const logo = sc.items.find((s) => s.kind === 'vector-group' && s.members.length === 3)!;
    assert.ok(logo, sc.items.map((s) => s.kind).join(' '));
    const top = L.click(sc, 300, 220);
    assert.deepEqual(ids(top), [logo.id]);
    const inside = L.click(sc, 300, 220, logo.id);
    assert.equal(inside.hit?.id, logo.members[1], 'the white path is on top of the blue one there');
    assert.ok(inside.order.some((s) => s.id === logo.members[0]));
    assert.deepEqual(groupsOf(sc, logo.members[1]).map((s) => s.id), [logo.id]);
    // inside the triangle's bounds but outside every member's shape: the group is a candidate, nothing is hit
    const corner = L.click(sc, 252, 258);
    assert.deepEqual(ids(corner), [logo.id]);
    assert.equal(corner.hit, null);
    // tab order inside the group
    assert.deepEqual(tabOrder(sc, logo.id).map((s) => s.id), logo.members);
    assert.equal(tabStep(sc, logo.members[2], 1)?.id, logo.members[0], 'Tab wraps among the members');
  } finally { L.close(); }
});

test('text boxes are candidates: the heading\'s box takes its text object; Tab steps in paint order', async () => {
  const L = await load((await objectsPage()).bytes);
  try {
    const sc = L.scene({ boxes: 'all' });
    assert.ok(!sc.items.some((s) => s.object?.kind === 'text'), 'the text object is selected as its box');
    const box = sc.items.find((s) => s.kind === 'text')!;
    assert.equal(box.box, 't0');
    const r = L.click(sc, (box.bounds.x0 + box.bounds.x1) / 2, (box.bounds.y0 + box.bounds.y1) / 2);
    assert.equal(r.hit?.id, 'box:t0');
    const top = tabOrder(sc, null);
    assert.deepEqual(top.map((s) => s.z), [...top.map((s) => s.z)].sort((a, b) => a - b), 'paint order');
    assert.equal(top[0].id, 'box:t0', 'the heading is painted first');
    assert.equal(tabStep(sc, null, 1)?.id, top[0].id);
    assert.equal(tabStep(sc, null, -1)?.id, top[top.length - 1].id);
    assert.equal(tabStep(sc, top[0].id, 1)?.id, top[1].id);
    assert.equal(tabStep(sc, top[0].id, -1)?.id, top[top.length - 1].id, 'Shift-Tab wraps');
  } finally { L.close(); }
});

test('text over a vector over an image: the order down, the white rectangle, curves, an even-odd hole, a clip that cuts', async () => {
  const L = await load((await overlapPages()).bytes);
  try {
    const sc = L.scene({ boxes: 'all' });
    const image = sc.items.find((s) => s.kind === 'image' && !s.clipped)!;
    const [vector, white, circle, donut] = sc.items.filter((s) => s.kind === 'vector' && s.parent === null);
    const all3 = L.click(sc, ...P.all3);
    assert.deepEqual(ids(all3), ['box:t0', vector.id, image.id], 'topmost first');
    assert.equal(all3.hit?.id, 'box:t0');
    const two = L.click(sc, ...P.two);
    assert.deepEqual(ids(two), [vector.id, image.id]);
    assert.ok(two.paints.has(vector.id) && !two.paints.has(image.id));
    assert.equal(L.click(sc, ...P.imageOnly).hit?.id, image.id);
    // white on white: the render cannot see it; the geometry finds it
    const w = L.click(sc, ...P.white);
    assert.equal(w.paints.size, 0);
    assert.equal(w.hit?.id, white.id);
    // a circle stroked with four curves: the line hits, the middle does not
    assert.equal(L.click(sc, ...P.circleLine).hit?.id, circle.id);
    assert.equal(L.click(sc, ...P.circleMiddle).hit, null);
    assert.ok(geometricHit(sc, circle, 480 + 40 * Math.SQRT1_2, 400 + 40 * Math.SQRT1_2, 1), 'on the flattened curve');
    // an even-odd hole
    assert.equal(L.click(sc, ...P.donutRing).hit?.id, donut.id);
    const hole = L.click(sc, ...P.donutHole);
    assert.equal(hole.hit, null);
    assert.ok(!geometricHit(sc, donut, ...P.donutHole), 'the hole by the even-odd rule');
    // the icon: a form of two paths, one entry
    const icon = sc.items.find((s) => s.kind === 'vector-group')!;
    assert.equal(L.click(sc, ...P.iconInner).hit?.id, icon.id);
    assert.equal(L.click(sc, ...P.iconInner, icon.id).hit?.id, icon.members[1]);
    assert.equal(L.click(sc, ...P.iconOuter, icon.id).hit?.id, icon.members[0]);
    // the clip cuts its own image
    const cut = sc.items.find((s) => s.kind === 'image' && s.clipped)!;
    assert.equal(L.click(sc, ...P.cutKept).hit?.id, cut.id);
    assert.ok(!candidatesAt(sc, ...P.cutAway).some((s) => s.id === cut.id));
  } finally { L.close(); }
});

test('a turned page with an offset crop box: hit testing stays in user space', async () => {
  const L = await load((await overlapPages()).bytes, 1);
  try {
    const sc = L.scene();
    const [img, path] = sc.items;
    assert.equal(img.kind, 'image');
    const r = L.click(sc, ...P.r_two);
    assert.deepEqual(ids(r), [path.id, img.id]);
    assert.equal(r.hit?.id, path.id);
    assert.equal(L.click(sc, ...P.r_image).hit?.id, img.id);
  } finally { L.close(); }
  for (const rotate of [90, 180, 270] as const) {
    const R = await load((await rotatedPage(rotate)).bytes);
    try {
      const sc = R.scene();
      assert.equal(R.click(sc, 140, 220).hit?.kind, 'image', `rotate ${rotate}`);
      assert.equal(R.click(sc, 330, 530).hit?.kind, 'vector', `rotate ${rotate}`);
    } finally { R.close(); }
  }
});

test('edits: a deleted object is not selectable; a moved one is hit at its new place, the render not trusted there', async () => {
  const L = await load((await objectsPage()).bytes);
  try {
    const base = L.scene();
    const [grey, green] = base.items.filter((s) => s.kind === 'vector' && s.parent === null);
    const del = L.scene({ edits: { deleted: new Set([green.id]) } });
    assert.ok(!del.byId.has(green.id));
    assert.equal(L.click(del, 150, 660).hit?.id, grey.id, 'grey is under where green was');
    assert.deepEqual(renderQuery(del, candidatesAt(del, 150, 660), 150, 660), [], 'the file still paints green there');
    const moved = L.scene({ edits: { own: new Map([[green.id, [1, 0, 0, 1, 200, 0]]]) } });
    assert.ok(moved.byId.get(green.id)!.moved);
    assert.equal(L.click(moved, 150, 660).hit?.id, grey.id);
    assert.equal(L.click(moved, 440, 700).hit?.id, green.id, 'green at its new place');
    // a group moved: its members follow
    const logo = base.items.find((s) => s.kind === 'vector-group' && s.members.length === 3)!;
    const g = L.scene({ edits: { own: new Map([[logo.id, [1, 0, 0, 1, 0, 300]]]) } });
    assert.equal(L.click(g, 300, 520).hit?.id, logo.id);
    assert.equal(L.click(g, 300, 520, logo.id).hit?.id, logo.members[1]);
    assert.equal(candidatesAt(g, 300, 220).length, 0, 'nothing left at the old place');
  } finally { L.close(); }
});

test('path geometry: rectangles, curves and closing; fill rules', () => {
  const ops = (src: string) => src.split('\n').map((l) => { const t = l.trim().split(/\s+/); return { op: t[t.length - 1], operands: t.slice(0, -1).map((v) => ({ type: 'number', value: Number(v) })), start: 0, end: 0 }; }) as never;
  const sq = buildPath(ops('0 0 10 10 re\n20 20 10 10 re'), 0, 2, [2, 0, 0, 2, 5, 5]);
  assert.deepEqual(sq.subs[0], [[5, 5], [25, 5], [25, 25], [5, 25]]);
  assert.deepEqual(sq.closed, [true, true]);
  const nested = buildPath(ops('0 0 100 100 re\n25 25 50 50 re'), 0, 2, [1, 0, 0, 1, 0, 0]);
  assert.ok(insideFill(nested, 'nonzero', 50, 50), 'two rectangles the same way round: nonzero fills the middle');
  assert.ok(!insideFill(nested, 'evenodd', 50, 50));
  const tri = buildPath(ops('0 0 m\n10 0 l\n5 10 l\nh'), 0, 4, [1, 0, 0, 1, 0, 0]);
  assert.deepEqual(tri.closed, [true]);
  assert.ok(insideFill(tri, 'nonzero', 5, 3) && !insideFill(tri, 'nonzero', 1, 8));
});
