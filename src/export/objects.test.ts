// Export of object edits (src/export/objects.ts, src/objects/surgery.ts) on synthetic pages, per object kind and op:
// an image, an inline image, a path and a vector path group, a shading, a form painted once and one painted twice (its
// contents copied for one use), a form inside a form painted at two depths, an image with its own clip, a clip shared
// by two images (moved inside it, and out of it: the split), a clip that crops its image (refused, then moved without
// it), nested clips, marked content, and a turned page with an offset crop box. Each export must pass verification
// (pixels outside the old and new bounds unchanged; every object the ops did not name byte-identical, at the same
// bounds); the tests also check pixels with no tolerance, the objects at their new places, and exactly which objects
// the incremental update appends. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, type PDFRef } from 'pdf-lib';
import { openPdfium, type Bitmap, type Rect } from '../engine/pdfium.ts';
import { diffOutside } from '../engine/diff.ts';
import { toView, type ViewBox } from '../engine/view.ts';
import { openForEdit } from '../pdf/edit.ts';
import { mul, type M6 } from '../pdf/ops.ts';
import { hasNoto, hasQpdf, lastStartxref, qpdfCheck, readXrefSection } from '../pdf/testing.ts';
import { listObjects } from '../objects/list.ts';
import { mapRect, type ObjectOp } from '../objects/ops.ts';
import { objectsPage, pngOf, rotatedPage } from '../objects/testkit.ts';
import type { PageObject, PageObjects } from '../objects/types.ts';
import type { Doc } from '../model/types.ts';
import { exportDoc, type ExportOptions, type PageReport } from './export.ts';
import { boxOf, laidText, readPages } from './testkit.ts';
import { addObjectOpSource, DELETE_NOTE } from './objects.ts';

type RGB = [number, number, number];
const WHITE: RGB = [255, 255, 255];
const T = (dx: number, dy: number, s = 1): M6 => [s, 0, 0, s, dx, dy];
/** Scale by s about (x, y), then move by (dx, dy). */
const about = (x: number, y: number, s: number, dx = 0, dy = 0): M6 => [s, 0, 0, s, x - s * x + dx, y - s * y + dy];
/** A turn by `deg` counter-clockwise about (x, y). */
function turn(deg: number, x: number, y: number): M6 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return mul(mul([1, 0, 0, 1, -x, -y], [c, s, -s, c, 0, 0]), [1, 0, 0, 1, x, y]);
}
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const near = (a: Rect, b: Rect, tol = 0.6) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const mid = (r: Rect): [number, number] => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2];

const noText = () => { throw new Error('no text is laid out in these tests'); };
const noFaces: ExportOptions['faces'] = () => { throw new Error('no fonts are needed in these tests'); };

type Run = { model: PageObjects; out: Uint8Array; pr: PageReport; after: PageObjects; ok: boolean; failures: string[] };

async function run(bytes: Uint8Array, ops: ObjectOp[], opts: Pick<ExportOptions, 'beforeVerify'> = {}): Promise<Run> {
  const [model] = await listObjects(bytes, [0]);
  assert.deepEqual(model.notes, [], `the fixture reads cleanly: ${model.notes.join('; ')}`);
  const doc: Doc = { pages: [{ n: 0, w: model.view.w, h: model.view.h, boxes: [], view: model.view, objectOps: ops }] };
  const { bytes: out, report } = await exportDoc(bytes, doc, noText, { verify: 'report', faces: noFaces, ...opts });
  const [after] = await listObjects(out, [0]);
  return { model, out, pr: report.pages[0], after, ok: report.ok, failures: report.failures };
}

async function render(bytes: Uint8Array, scale = 2): Promise<{ bmp: Bitmap; view: ViewBox; scale: number }> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try { const pg = doc.page(0); try { return { bmp: pg.render(scale), view: pg.view, scale }; } finally { pg.close(); } } finally { doc.close(); }
}
/** The colour at a user-space point. */
function colour(r: Awaited<ReturnType<typeof render>>, x: number, y: number): RGB {
  const [vx, vy] = toView(r.view, x, y);
  const k = (Math.floor(r.scale * (r.view.h - vy)) * r.bmp.width + Math.floor(r.scale * vx)) * 4;
  return [r.bmp.rgba[k], r.bmp.rgba[k + 1], r.bmp.rgba[k + 2]];
}
const like = (c: RGB, want: RGB, tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);

/** Passed verification; no pixel outside `regions` (grown 1 pt) changed at all; refused nothing unless allowed. */
async function clean(original: Uint8Array, r: Run, regions: Rect[], opts: { skipped?: number } = {}) {
  assert.ok(r.ok, r.failures.join('\n'));
  assert.equal(r.pr.objectsSkipped?.length ?? 0, opts.skipped ?? 0, JSON.stringify(r.pr.objectsSkipped));
  const [a, b] = [await render(original), await render(r.out)];
  const d = diffOutside(a.bmp, b.bmp, regions.map((x) => grow(x, 1)), a.scale, a.view, 0);
  assert.equal(d.differing, 0, `${d.differing} pixels changed outside the old and new bounds`);
  assert.deepEqual(r.after.notes, [], r.after.notes.join('; '));
  if (hasQpdf) assert.ok(qpdfCheck(r.out).ok);
}

/** The original is a prefix; the objects the last update appends, as old object numbers and a count of new ones. */
function appended(original: Uint8Array, out: Uint8Array): { old: number[]; added: number } {
  assert.deepEqual(out.subarray(0, original.length), original, 'the original bytes are a prefix');
  const size = readXrefSection(original, lastStartxref(original)).size;
  const keys = [...readXrefSection(out, lastStartxref(out)).entries.keys()];
  return { old: keys.filter((k) => k < size).sort((p, q) => p - q), added: keys.filter((k) => k >= size).length };
}
async function pageObj(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPage(0).ref.objectNumber;
}
const refNum = (o: PageObject) => Number(o.ref!.split(' ')[0]);
const find = (p: PageObjects, pred: (o: PageObject) => boolean, k = 0) => p.objects.filter(pred)[k];
const absent = (r: Run, o: PageObject) => !r.after.objects.some((q) => q.kind === o.kind && near(q.bounds, o.bounds, 0.1));

// ---------------------------------------------------------------------------------------------------------------
// fixtures beyond src/objects/testkit.ts

/** Two images inside a shared rectangle clip with a path after them; a clip that crops an image and a square; an image
 *  under two nested clips, each with a path after the image. */
async function clipsPage(): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const red = await doc.embedPng(pngOf([220, 30, 30, 255]));
  const blue = await doc.embedPng(pngOf([30, 60, 200, 255]));
  const green = await doc.embedPng(pngOf([20, 160, 60, 255]));
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Red: red.ref, Blue: blue.ref, Green: green.ref } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'q 50 500 300 150 re W n',
    'q 100 0 0 80 70 530 cm /Red Do Q',
    'q 100 0 0 80 220 530 cm /Blue Do Q',
    '0 0 0 rg 60 510 20 10 re f',
    'Q',
    'q 72 200 100 60 re W n',
    'q 160 0 0 120 40 170 cm /Green Do Q',
    '0.2 0.2 0.8 rg 90 210 20 20 re f',
    'Q',
    'q 300 100 250 250 re W n 0.5 w q 320 120 200 200 re W n q 50 0 0 50 340 140 cm /Red Do Q 0 0.5 0 rg 330 300 10 10 re f Q',
    '1 0 0 rg 310 110 10 10 re f Q',
    // a path that fills and sets a clip the next path is painted under (no q … Q of its own)
    'q 0 0 1 rg 400 700 50 50 re W f 0.5 0.5 0.5 rg 400 700 100 20 re f Q',
  ].join('\n'))));
  return { bytes: await doc.save({ useObjectStreams: false }) };
}

/** A form (Outer, painted once) that paints another form (Inner) twice; Inner is also painted twice on the page itself,
 *  once in a q … Q of its own and once not. */
async function nestedPage(): Promise<{ bytes: Uint8Array }> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const inner = ctx.register(ctx.flateStream('0 0.6 0 rg 0 0 30 30 re f 1 1 1 rg 10 10 10 10 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 30, 30], Resources: ctx.obj({}),
  }));
  const outer = ctx.register(ctx.flateStream('0.9 0.9 0.2 rg 0 0 100 100 re f q 1 0 0 1 20 20 cm /In Do Q q 1 0 0 1 60 60 cm /In Do Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 100], Resources: ctx.obj({ XObject: { In: inner } }),
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Outer: outer, Inner: inner as PDFRef } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'q 1 0 0 1 100 500 cm /Outer Do Q',
    'q 1 0 0 1 300 500 cm /Inner Do Q',
    // a use without a q … Q of its own (a path follows it in the same q … Q)
    'q 1 0 0 1 400 650 cm /Inner Do 0 0 0 rg 0 -10 5 5 re f Q',
  ].join('\n'))));
  return { bytes: await doc.save({ useObjectStreams: false }) };
}

// ---------------------------------------------------------------------------------------------------------------
// transforms

test('a path moved: wrapped in q … cm … Q in the page stream; only its old and new places change', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const grey = find(m, (o) => o.kind === 'path' && !o.parent);
  const r = await run(f.bytes, [{ op: 'transform', ids: [grey.id], m: T(10, -20) }]);
  const to = mapRect(grey.bounds, T(10, -20));
  await clean(f.bytes, r, [grey.bounds, to]);
  assert.deepEqual(r.pr.objectsChanged!.map((c) => [c.id, c.how, c.form]), [[grey.id, 'operator', null]]);
  const img = await render(r.out);
  assert.ok(like(colour(img, 90, 585), [153, 153, 153]), 'grey at its new place');
  assert.ok(like(colour(img, 80, 670), WHITE), 'nothing where it was');
  const moved = r.after.objects.find((o) => o.kind === 'path' && near(o.bounds, to))!;
  assert.ok(moved, 'the output\'s model has it at its new bounds');
  assert.deepEqual(appended(f.bytes, r.out), { old: [await pageObj(f.bytes)], added: 1 }, 'the page and its new stream');
});

test('a stroked ring resized about its centre and turned 30°: new bounds, the rest untouched', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const ring = find(m, (o) => o.kind === 'path' && o.paint === 'S' && !o.parent);
  const S = about(350, 640, 0.5);
  const r = await run(f.bytes, [{ op: 'transform', ids: [ring.id], m: S }]);
  await clean(f.bytes, r, [ring.bounds]);
  assert.ok(r.after.objects.some((o) => o.paint === 'S' && near(o.bounds, mapRect(ring.bounds, S))), 'the ring at half size');
  const R = turn(30, 350, 640);
  const t = await run(f.bytes, [{ op: 'transform', ids: [ring.id], m: R }]);
  await clean(f.bytes, t, [ring.bounds, mapRect(ring.bounds, R)]);
});

test('an image with its own q … Q and clip, in marked content: the group moves with its clip; a quarter turn', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const masked = find(m, (o) => o.kind === 'image' && !!o.smask);
  const M = T(150, 220);
  const r = await run(f.bytes, [{ op: 'transform', ids: [masked.id], m: M }]);
  const to = mapRect(masked.bounds, M);
  await clean(f.bytes, r, [masked.bounds, to]);
  assert.equal(r.pr.objectsChanged![0].how, 'group');
  const img = await render(r.out);
  assert.ok(like(colour(img, ...mid(to)), [20, 160, 60]) && like(colour(img, to.x0 + 10, to.y0 + 50), WHITE), 'its opaque half and its clear half');
  const q = r.after.objects.find((o) => o.kind === 'image' && o.smask)!;
  assert.ok(near(q.bounds, to) && q.marked[0]?.mcid === 3, 'still in its marked content');
  const own = r.after.clips.find((c) => c.id === q.clips[0])!;
  assert.ok(near(own.bounds, to), 'its clip moved with it');
  const Q = turn(90, ...mid(masked.bounds));
  const t = await run(f.bytes, [{ op: 'transform', ids: [masked.id], m: Q }]);
  await clean(f.bytes, t, [masked.bounds]);
  const tq = t.after.objects.find((o) => o.kind === 'image' && o.smask)!;
  assert.ok(near(tq.bounds, masked.bounds) && Math.abs(tq.ctm[1] - 100) < 1e-3, 'turned in place');
});

test('an inline image resized: its group\'s cm is rewritten (no new operators)', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const inl = find(m, (o) => o.kind === 'inline-image');
  const M = about(inl.bounds.x0, inl.bounds.y0, 2, -60, 0);
  const r = await run(f.bytes, [{ op: 'transform', ids: [inl.id], m: M }]);
  const to = mapRect(inl.bounds, M);
  await clean(f.bytes, r, [inl.bounds, to]);
  assert.equal(r.pr.objectsChanged![0].how, 'cm');
  const q = r.after.objects.find((o) => o.kind === 'inline-image')!;
  assert.equal(q.id, inl.id, 'the same operator index');
  assert.ok(near(q.bounds, to));
});

test('a shading with its own clip moved: it fills its moved clip', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const sh = find(m, (o) => o.kind === 'shading');
  const M = T(-300, 150);
  const r = await run(f.bytes, [{ op: 'transform', ids: [sh.id], m: M }]);
  const to = mapRect(sh.bounds, M);
  await clean(f.bytes, r, [sh.bounds, to]);
  const q = r.after.objects.find((o) => o.kind === 'shading')!;
  assert.ok(near(q.bounds, to), JSON.stringify(q.bounds));
  const img = await render(r.out);
  assert.ok(!like(colour(img, ...mid(to)), WHITE, 10) && like(colour(img, ...mid(sh.bounds)), WHITE), 'painted at the new place, gone from the old');
});

test('a form painted once moved as a whole; one of its paths moved in its stream, in place; a vector group', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const logo = find(m, (o) => o.kind === 'form' && o.uses === 1);
  const M = T(200, 400);
  const r = await run(f.bytes, [{ op: 'transform', ids: [logo.id], m: M }]);
  await clean(f.bytes, r, [logo.bounds, mapRect(logo.bounds, M)]);
  for (const id of logo.children!) {
    const c = m.objects.find((o) => o.id === id)!;
    assert.ok(r.after.objects.some((o) => o.id === id && near(o.bounds, mapRect(c.bounds, M))), `child ${id} moved with the form`);
  }
  assert.deepEqual(appended(f.bytes, r.out), { old: [await pageObj(f.bytes)], added: 1 });

  // the white path inside the logo, smaller about its own centre: the form's stream is replaced, the page is not touched
  const white = m.objects.find((o) => o.id === logo.children![1])!;
  const S = about(...mid(white.bounds), 0.5);
  const c = await run(f.bytes, [{ op: 'transform', ids: [white.id], m: S }]);
  await clean(f.bytes, c, [white.bounds]);
  assert.deepEqual(c.pr.objectsChanged![0].form, logo.ref);
  assert.deepEqual(c.pr.objectForms, { edited: [logo.ref], copied: [] });
  assert.deepEqual(appended(f.bytes, c.out), { old: [refNum(logo)], added: 0 }, 'only the form is appended');

  // the logo's three paths as one group, moved up inside the form's box
  const g = await run(f.bytes, [{ op: 'group', id: 'logo-paths', members: logo.children! }, { op: 'transform', ids: ['logo-paths'], m: about(300, 230, 0.5) }]);
  await clean(f.bytes, g, [logo.bounds]);
  assert.equal(g.pr.objectsChanged!.length, 3);
  assert.deepEqual(appended(f.bytes, g.out), { old: [refNum(logo)], added: 0 });
  // a move that leaves the form's box is refused
  const out = await run(f.bytes, [{ op: 'transform', ids: [white.id], m: T(0, 100) }]);
  assert.match(out.pr.objectsSkipped![0].reason, /BBox/);
  assert.equal(out.pr.objectsChanged!.length, 0);
});

test('a path inside a form painted twice: the form is copied for this use; the other use is untouched', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const badge2 = find(m, (o) => o.kind === 'form' && o.uses === 2, 1);
  const square = m.objects.find((o) => o.id === badge2.children![0])!;
  const S = about(...mid(square.bounds), 0.5);
  const r = await run(f.bytes, [{ op: 'transform', ids: [square.id], m: S }]);
  await clean(f.bytes, r, [square.bounds]);
  assert.equal(r.pr.objectForms!.copied.length, 1);
  assert.equal(r.pr.objectForms!.copied[0].from, badge2.ref);
  assert.deepEqual(appended(f.bytes, r.out), { old: [await pageObj(f.bytes)], added: 2 }, 'the page, its stream and the copy');
  const badge1 = find(m, (o) => o.kind === 'form' && o.uses === 2, 0);
  const b1 = r.after.objects.find((o) => o.id === badge1.id)!;
  assert.equal(b1.name, 'Badge', 'the first use still paints the original');
  assert.notEqual(r.after.objects.find((o) => o.id === badge2.id)!.name, 'Badge');
});

test('a form inside a form, painted at two depths: the inner one is copied for its use inside the outer one', async () => {
  const f = await nestedPage();
  const [m] = await listObjects(f.bytes);
  const [outer, in1, , inPage, bare] = m.objects.filter((o) => o.kind === 'form');
  assert.equal(outer.uses, 1);
  assert.equal(in1.uses, 4, 'twice inside the outer form, twice on the page');
  assert.equal(bare.group, null);
  const white = m.objects.find((o) => o.id === in1.children![1])!;
  const S = about(...mid(white.bounds), 1.5);
  const r = await run(f.bytes, [{ op: 'transform', ids: [white.id], m: S }]);
  await clean(f.bytes, r, [white.bounds, mapRect(white.bounds, S)]);
  assert.deepEqual(r.pr.objectForms!.edited, [outer.ref], 'the outer form, painted once, is edited in place');
  assert.equal(r.pr.objectForms!.copied.length, 1);
  assert.deepEqual(appended(f.bytes, r.out), { old: [refNum(outer)], added: 1 }, 'the outer form and the copy; the page is not touched');
  const img = await render(r.out);
  const pw = m.objects.find((o) => o.id === inPage.children![1])!;
  assert.ok(like(colour(img, pw.bounds.x0 + 1, pw.bounds.y0 + 1), WHITE), 'the use on the page keeps its white square');
  // delete the square in the page's own use: the inner form is copied for it, the outer one untouched
  const d = await run(f.bytes, [{ op: 'delete', ids: [pw.id] }]);
  await clean(f.bytes, d, [pw.bounds]);
  assert.deepEqual(appended(f.bytes, d.out), { old: [await pageObj(f.bytes)], added: 2 });
  assert.ok(like(colour(await render(d.out), ...mid(pw.bounds)), [0, 153, 0]), 'the green square shows through');
  // the use without its own q … Q moved, and its white square deleted: the wrap and the rename meet at its Do
  const bw = m.objects.find((o) => o.id === bare.children![1])!;
  const M = T(50, 20);
  const b = await run(f.bytes, [{ op: 'transform', ids: [bare.id], m: M }, { op: 'delete', ids: [bw.id] }]);
  await clean(f.bytes, b, [bare.bounds, mapRect(bare.bounds, M)]);
  assert.deepEqual(b.pr.objectsChanged!.map((c) => c.how), ['operator', 'operator']);
  assert.equal(b.pr.objectForms!.copied.length, 1);
  const bi = await render(b.out);
  const nb = mapRect(bw.bounds, M);
  assert.ok(like(colour(bi, ...mid(nb)), [0, 153, 0]) && like(colour(bi, ...mid(bw.bounds)), WHITE), 'moved, without its white square');
});

test('a clip shared by two images: moved inside it, the group\'s cm changes; moved out of it, the clip is split', async () => {
  const f = await clipsPage();
  const [m] = await listObjects(f.bytes);
  const [red, blue, , red2] = m.objects.filter((o) => o.kind === 'image');
  const shared = m.clips.find((c) => c.id === red.clips[0])!;
  assert.equal(shared.users, 3, 'the two images and the path after them');
  const inside = await run(f.bytes, [{ op: 'transform', ids: [red.id], m: T(20, 20) }]);
  await clean(f.bytes, inside, [red.bounds, mapRect(red.bounds, T(20, 20))]);
  assert.equal(inside.pr.objectsChanged![0].how, 'cm');
  assert.equal(inside.pr.objectsChanged![0].split, undefined);

  const M = T(0, -150);
  const to = mapRect(red.bounds, M);
  const out = await run(f.bytes, [{ op: 'transform', ids: [red.id], m: M }]);
  await clean(f.bytes, out, [red.bounds, to]);
  assert.deepEqual(out.pr.objectsChanged![0].split, [shared.id]);
  const img = await render(out.out);
  assert.ok(like(colour(img, ...mid(to)), [220, 30, 30]) && like(colour(img, to.x0 + 2, to.y0 + 2), [220, 30, 30]), 'all of it shows at its new place');
  assert.ok(like(colour(img, ...mid(blue.bounds)), [30, 60, 200]), 'the other image is where it was');
  assert.ok(like(colour(img, 70, 515), [0, 0, 0]), 'the path after it is painted under the clip as before');
  const q = out.after.objects.find((o) => o.kind === 'image' && near(o.bounds, to))!;
  const moved = out.after.clips.find((c) => c.id === q.clips[0])!;
  assert.ok(near(moved.bounds, mapRect(shared.bounds, M)), 'its copy of the clip moved with it');
  assert.deepEqual(appended(f.bytes, out.out), { old: [await pageObj(f.bytes)], added: 1 });

  // nested clips: out of both, the split closes and reopens two levels
  const N = T(-150, 0);
  const n = await run(f.bytes, [{ op: 'transform', ids: [red2.id], m: N }]);
  await clean(f.bytes, n, [red2.bounds, mapRect(red2.bounds, N)]);
  assert.equal(n.pr.objectsChanged![0].split!.length, 2);
  const ni = await render(n.out);
  assert.ok(like(colour(ni, 335, 305), [0, 128, 0]) && like(colour(ni, 315, 115), [255, 0, 0]), 'the paths after it, at both levels, still paint');
  assert.ok(like(colour(ni, 215, 165), [220, 30, 30]), 'the image at its new place');
});

test('a clip that crops its image: the move is refused, then done without the shared crop when confirmed', async () => {
  const f = await clipsPage();
  const [m] = await listObjects(f.bytes);
  const green = find(m, (o) => o.kind === 'image', 2);
  const M = T(350, 500);
  const r = await run(f.bytes, [{ op: 'transform', ids: [green.id], m: M }]);
  assert.ok(r.ok, r.failures.join('\n'));
  assert.match(r.pr.objectsSkipped![0].reason, /crops it.*move without the shared crop/);
  assert.deepEqual(r.out, f.bytes, 'nothing was written');
  const d = await run(f.bytes, [{ op: 'transform', ids: [green.id], m: M, dropSharedClip: true }]);
  const to = mapRect(green.bounds, M);
  await clean(f.bytes, d, [green.bounds, to]);
  assert.deepEqual(d.pr.objectsChanged![0].dropped, [green.clips[0]]);
  const img = await render(d.out);
  assert.ok(like(colour(img, to.x0 + 2, to.y0 + 2), [20, 160, 60]) && like(colour(img, to.x1 - 2, to.y1 - 2), [20, 160, 60]), 'all of it, uncropped');
  assert.ok(like(colour(img, 100, 220), [51, 51, 204]), 'the square that shares the clip is painted as before');
});

test('a turned page with an offset crop box: an image moved and a path deleted', async () => {
  const f = await rotatedPage(90);
  const [m] = await listObjects(f.bytes);
  const [img, sq] = m.objects;
  const M = T(60, 100);
  const r = await run(f.bytes, [{ op: 'transform', ids: [img.id], m: M }, { op: 'delete', ids: [sq.id] }]);
  const to = mapRect(img.bounds, M);
  await clean(f.bytes, r, [img.bounds, to, sq.bounds]);
  const pic = await render(r.out);
  assert.equal(pic.view.rotate, 90);
  assert.ok(like(colour(pic, ...mid(to)), [220, 30, 30]) && like(colour(pic, ...mid(img.bounds)), WHITE));
  assert.ok(like(colour(pic, ...mid(sq.bounds)), WHITE), 'the square is gone');
});

// ---------------------------------------------------------------------------------------------------------------
// deletes

test('deletes of every kind: gone from the output\'s model, the rest identical; an emptied marked-content pair goes too', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const pick = {
    path: find(m, (o) => o.kind === 'path' && !o.parent),
    image: find(m, (o) => o.kind === 'image' && !o.smask),
    masked: find(m, (o) => o.kind === 'image' && !!o.smask),
    inline: find(m, (o) => o.kind === 'inline-image'),
    shading: find(m, (o) => o.kind === 'shading'),
    form: find(m, (o) => o.kind === 'form' && o.uses === 1),
  };
  for (const [what, o] of Object.entries(pick)) {
    const r = await run(f.bytes, [{ op: 'delete', ids: [o.id] }]);
    await clean(f.bytes, r, [o.bounds]);
    assert.ok(absent(r, o), `${what} is gone`);
    assert.equal(r.after.objects.length, m.objects.length - 1 - (o.children?.length ?? 0), what);
    assert.ok(r.pr.objectNotes!.includes(DELETE_NOTE), 'the report says it is not a redaction');
    assert.deepEqual(appended(f.bytes, r.out), { old: [await pageObj(f.bytes)], added: 1 }, what);
    if (what === 'masked') {
      assert.equal(r.pr.objectsChanged![0].marked, 1, 'its marked-content pair was left empty and removed');
      const ed = await openForEdit(r.out);
      assert.ok(!String.fromCharCode(...ed.contents(0)).includes('BDC'));
    }
  }
  // inside a form painted twice: copied for this use
  const badge2 = find(m, (o) => o.kind === 'form' && o.uses === 2, 1);
  const ring = m.objects.find((o) => o.id === badge2.children![1])!;
  const r = await run(f.bytes, [{ op: 'delete', ids: [ring.id] }]);
  await clean(f.bytes, r, [ring.bounds]);
  assert.equal(r.pr.objectForms!.copied.length, 1);
  assert.deepEqual(appended(f.bytes, r.out), { old: [await pageObj(f.bytes)], added: 2 });
  // text, and a path that sets a clip later objects are painted under, are refused
  const text = find(m, (o) => o.kind === 'text');
  const t = await run(f.bytes, [{ op: 'delete', ids: [text.id] }]);
  assert.match(t.pr.objectsSkipped![0].reason, /text box/);
  const c = await clipsPage();
  const [cm] = await listObjects(c.bytes);
  const clipper = find(cm, (o) => o.kind === 'path' && cm.clips.some((k) => k.id === o.id));
  for (const op of [{ op: 'delete', ids: [clipper.id] }, { op: 'transform', ids: [clipper.id], m: T(5, 5) }] as ObjectOp[]) {
    const x = await run(c.bytes, [op]);
    assert.match(x.pr.objectsSkipped![0].reason, /sets a clip that another object is painted under/);
    assert.deepEqual(x.out, c.bytes);
  }
});

test('object edits and edited text on one page: both written, both verified', { skip: !hasNoto && 'fonts missing' }, async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const [pr] = await readPages(f.bytes);
  const box = boxOf(pr, 'h', [0], { edited: true });
  const laid = await laidText(box, 'A new heading');
  const grey = find(m, (o) => o.kind === 'path' && !o.parent);
  const logo = find(m, (o) => o.kind === 'form' && o.uses === 1);
  const white = m.objects.find((o) => o.id === logo.children![1])!;
  const doc: Doc = { pages: [{ n: 0, w: 595, h: 842, boxes: [box], view: m.view, objectOps: [
    { op: 'transform', ids: [grey.id], m: T(10, -20) }, { op: 'delete', ids: [white.id] },
  ] }] };
  const { bytes, report } = await exportDoc(f.bytes, doc, () => laid, { verify: 'report' });
  assert.ok(report.ok, report.failures.join('\n'));
  const p = report.pages[0];
  assert.equal(p.written.length, 1);
  assert.equal(p.objectsChanged!.length, 2);
  const [after] = await listObjects(bytes);
  assert.ok(after.objects.some((o) => o.kind === 'path' && near(o.bounds, mapRect(grey.bounds, T(10, -20)))));
  assert.ok(!after.objects.some((o) => o.parent && near(o.bounds, white.bounds, 0.1)), 'the white path is gone');
});

test('ops another module adds at export: one surgery with the page\'s own ops, its own report, the same verification', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const [grey, green] = m.objects.filter((o) => o.kind === 'path' && !o.parent);
  // the source answers only for the pages it marks, and names objects of the model it is given
  const mine = new WeakSet<object>();
  const seen: { changed: string[]; skipped: string[] }[] = [];
  addObjectOpSource({
    wants: (page) => mine.has(page),
    ops: (_a, model) => {
      const o = model.objects.find((x) => x.id === green.id)!;
      return { ops: [{ op: 'transform', ids: [o.id], m: T(0, -30) }],
        report: (r) => { seen.push({ changed: r.changed.map((c) => c.id), skipped: r.skipped.map((c) => c.id) }); return { sourceMoved: r.changed.length }; } };
    },
  });
  const both = async (ops: ObjectOp[]) => {
    const doc: Doc = { pages: [{ n: 0, w: m.view.w, h: m.view.h, boxes: [], view: m.view, objectOps: ops }] };
    mine.add(doc.pages[0]);
    const { bytes, report } = await exportDoc(f.bytes, doc, noText, { verify: 'report', faces: noFaces });
    return { bytes, report, pr: report.pages[0] as PageReport & { sourceMoved?: number } };
  };
  // with the page's own move of another object: both written, verified; each report lists its own
  const a = await both([{ op: 'transform', ids: [grey.id], m: T(10, -20) }]);
  assert.ok(a.report.ok, a.report.failures.join('\n'));
  assert.deepEqual(a.pr.objectsChanged!.map((c) => c.id), [grey.id]);
  assert.equal(a.pr.sourceMoved, 1);
  assert.deepEqual(seen.at(-1), { changed: [green.id], skipped: [] });
  const [after] = await listObjects(a.bytes);
  for (const [o, M] of [[grey, T(10, -20)], [green, T(0, -30)]] as const) {
    assert.ok(after.objects.some((q) => q.kind === 'path' && near(q.bounds, mapRect(o.bounds, M))), `${o.id} at its new place`);
  }
  assert.deepEqual(appended(f.bytes, a.bytes), { old: [await pageObj(f.bytes)], added: 1 }, 'one new page stream for both');
  // alone, on a page with no ops of its own: written and verified; no object fields in the report
  const b = await both([]);
  assert.ok(b.report.ok, b.report.failures.join('\n'));
  assert.equal(b.pr.sourceMoved, 1);
  assert.equal(b.pr.objectsChanged, undefined);
  assert.ok(b.pr.verify && b.pr.verify.pixelsChangedOutside === 0);
});

// ---------------------------------------------------------------------------------------------------------------
// verification

test('the verification catches an output that changed an object the ops did not name', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes);
  const [grey, green] = m.objects.filter((o) => o.kind === 'path' && !o.parent);
  const tamper = (from: string, to: string) => async (bytes: Uint8Array) => {
    const ed = await openForEdit(bytes);
    const s = String.fromCharCode(...ed.contents(0));
    assert.ok(s.includes(from));
    ed.setContents(0, Uint8Array.from(s.replace(from, to), (ch) => ch.charCodeAt(0)));
    return ed.save();
  };
  const ops: ObjectOp[] = [{ op: 'transform', ids: [grey.id], m: T(10, -20) }];
  // green's rectangle nudged by 0.05 pt: no pixel and no bound tells, its operator bytes do
  const a = await run(f.bytes, ops, { beforeVerify: tamper('132 640 120 80 re', '132.05 640 120 80 re') });
  assert.ok(!a.ok);
  assert.ok(a.failures.some((x) => x.includes(`path ${green.id}: its operators changed`)), a.failures.join('\n'));
  // green moved by 30 pt: its bounds and the pixels tell
  const b = await run(f.bytes, ops, { beforeVerify: tamper('132 640 120 80 re', '162 640 120 80 re') });
  assert.ok(b.failures.some((x) => x.includes(`path ${green.id} moved`)), b.failures.join('\n'));
  assert.ok(b.failures.some((x) => /pixels changed outside/.test(x)));
  // the unchanged file: the moved object is not where the edit put it
  const c = await run(f.bytes, ops, { beforeVerify: async () => f.bytes });
  assert.ok(c.failures.some((x) => x.includes(`path ${grey.id} is not in the output's object model`)), c.failures.join('\n'));
  // the moved object moved by a different amount
  const e = await run(f.bytes, ops, { beforeVerify: tamper('q 1 0 0 1 10 -20 cm', 'q 1 0 0 1 10 -25 cm') });
  assert.ok(e.failures.some((x) => x.includes(`moved path ${grey.id} is at`)), e.failures.join('\n'));
  // an extra object
  const d = await run(f.bytes, ops, { beforeVerify: tamper('4 w', '0 0 1 rg 500 800 5 5 re f 4 w') });
  assert.ok(d.failures.some((x) => /objects where \d+ were expected/.test(x)), d.failures.join('\n'));
});
