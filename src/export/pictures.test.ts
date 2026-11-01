// Picture moves in export (src/export/pictures.ts) on synthetic PDFs: solid-colour PNGs drawn with pdf-lib, an inline
// image, an image inside a form, an image with its own frame clip. Synthetic material only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFName, StandardFonts, type PDFRef } from 'pdf-lib';
import { PNG } from 'pngjs';
import { openPdfium, type Bitmap, type Rect, type Shape } from '../engine/pdfium.ts';
import { hasNoto } from '../pdf/testing.ts';
import { moveBetween, movedFrame } from '../fit/pictures.ts';
import { fitPage } from '../fit/fit.ts';
import { detectBoxes } from '../layout/detect.ts';
import { buildPageFrom, picturesOf, readPage } from '../model/build.ts';
import { loadFonts } from '../model/fonts.ts';
import { layoutBox } from '../model/layout.ts';
import { exportDoc } from './export.ts';
import { boxOf, docOf, laidText, readPages } from './testkit.ts';
import type { Box, LaidBox, Picture } from '../model/types.ts';

type RGB = [number, number, number];
const RED: RGB = [220, 30, 30], GREEN: RGB = [30, 160, 60];

function solidPng(rgb: RGB, w = 8, h = 8): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([...rgb, 255], i * 4);
  return new Uint8Array(PNG.sync.write(png));
}

async function shapesOf(bytes: Uint8Array, n = 0): Promise<Shape[]> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try { const pg = doc.page(n); try { return pg.shapes(); } finally { pg.close(); } } finally { doc.close(); }
}

async function render(bytes: Uint8Array, scale = 1): Promise<{ bmp: Bitmap; h: number }> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try { const pg = doc.page(0); try { return { bmp: pg.render(scale), h: pg.size.h }; } finally { pg.close(); } } finally { doc.close(); }
}

/** The colour at a page point (PDF y up) of a render at scale 1. */
function at(r: { bmp: Bitmap; h: number }, x: number, y: number): RGB {
  const k = (Math.floor(r.h - y) * r.bmp.width + Math.floor(x)) * 4;
  return [r.bmp.rgba[k], r.bmp.rgba[k + 1], r.bmp.rgba[k + 2]];
}
const like = (c: RGB, want: RGB, tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
const WHITE: RGB = [255, 255, 255];

const picOf = (s: Shape, id: string, to: Rect): Picture => {
  const p: Picture = { id, kind: 'image', frame: { ...s.bounds }, z: s.z, objs: [s.index] };
  p.move = moveBetween(p.frame, to);
  return p;
};

function laidFrom(m: Map<string, LaidBox>) {
  return (_page: number, box: Box) => {
    const l = m.get(box.id);
    if (!l) throw new Error(`no layout for ${box.id}`);
    return l;
  };
}

test('export moves and shrinks an image in the page stream: pixels at the new place, nothing else changed', { skip: !hasNoto && 'fonts missing' }, async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText('Old paragraph first line.', { x: 72, y: 700, size: 14, font: helv });
  page.drawText('Old paragraph second line.', { x: 72, y: 682, size: 14, font: helv });
  page.drawImage(await doc.embedPng(solidPng(RED)), { x: 350, y: 550, width: 150, height: 120 });
  page.drawText('Untouched line below.', { x: 72, y: 400, size: 12, font: helv });
  const original = await doc.save({ useObjectStreams: false });

  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const md = docOf([{ pr, boxes: [a, boxOf(pr, 'b', [2])] }]);
  const [img] = (await shapesOf(original)).filter((s) => s.kind === 'image');
  // 80% toward the top-right corner, then 40 pt down
  const to = { x0: 380, y0: 534, x1: 500, y1: 630 };
  const pic = picOf(img, 'pic', to);
  md.pages[0].pictures = [pic];
  const { bytes, report } = await exportDoc(original, md, laidFrom(new Map([['a', await laidText(a, 'A new English paragraph.')]])));

  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.picturesSkipped?.length ?? 0, 0, JSON.stringify(p.picturesSkipped));
  assert.equal(p.picturesMoved?.length, 1);
  const mv = p.picturesMoved![0];
  assert.equal(mv.id, 'pic');
  assert.equal(mv.wrapped, 'group');          // pdf-lib paints it as q … cm /Image Do Q
  assert.equal(mv.form, null);
  assert.ok(Math.abs(mv.scale - 0.8) < 1e-9);
  assert.deepEqual(mv.from, img.bounds);
  assert.deepEqual(mv.to, movedFrame(pic));
  assert.equal(p.verify!.pixelsChangedOutside, 0);

  // PDFium sees the image at its new frame
  const [moved] = (await shapesOf(bytes)).filter((s) => s.kind === 'image');
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) assert.ok(Math.abs(moved.bounds[k] - to[k]) < 0.05, `${k}: ${moved.bounds[k]} vs ${to[k]}`);
  // pixels: red where it went, white where it left
  const before = await render(original), after = await render(bytes);
  assert.ok(like(at(before, 440, 540), WHITE) && like(at(after, 440, 540), RED), 'new place');
  assert.ok(like(at(before, 360, 660), RED) && like(at(after, 360, 660), WHITE), 'old place');
  assert.ok(like(at(after, 440, 600), RED), 'still red inside');
});

/** A page with the paragraph to edit, an image with its own frame clip (red), an inline image (blue, ASCIIHex) and
 *  a form that paints a green image; `twice` paints the form a second time. */
async function mixedPdf(opts: { twice?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const red = await doc.embedPng(solidPng(RED));
  const green = await doc.embedPng(solidPng(GREEN));
  const ctx = doc.context;
  const form: PDFRef = ctx.register(ctx.flateStream('q 100 0 0 80 0 0 cm /Im1 Do Q', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 80], Matrix: [1, 0, 0, 1, 400, 100], Resources: { XObject: { Im1: green.ref } },
  }));
  const page = doc.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Im0: red.ref, Fm0: form } }));
  const content = [
    'BT /F1 12 Tf 72 700 Td (Old text to replace.) Tj ET',
    'q 300 300 100 80 re W n q 100 0 0 80 300 300 cm /Im0 Do Q Q',
    'q 60 0 0 40 100 100 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID 2020DC2020DC2020DC2020DC> EI Q',
    '/Fm0 Do',
    opts.twice ? 'q 1 0 0 1 0 500 cm /Fm0 Do Q' : '',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  return doc.save({ useObjectStreams: false });
}
const BLUE: RGB = [32, 32, 220];

test('export moves a clipped image with its clip, an inline image and an image inside a form', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await mixedPdf();
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const md = docOf([{ pr, boxes: [a] }]);
  const imgs = (await shapesOf(original)).filter((s) => s.kind === 'image');
  assert.equal(imgs.length, 3);
  const [clipped, inline, inForm] = imgs;
  assert.ok(Math.abs(clipped.bounds.x0 - 300) < 0.5 && Math.abs(inline.bounds.x0 - 100) < 0.5 && Math.abs(inForm.bounds.x0 - 400) < 0.5);
  md.pages[0].pictures = [
    picOf(clipped, 'clipped', { x0: 350, y0: 300, x1: 450, y1: 380 }),            // 50 pt right
    picOf(inline, 'inline', { x0: 100, y0: 130, x1: 154, y1: 166 }),              // 90%, 30 pt up
    picOf(inForm, 'form', { x0: 400, y0: 100, x1: 480, y1: 164 }),                // 80% toward its bottom-left
  ];
  const { bytes, report } = await exportDoc(original, md, laidFrom(new Map([['a', await laidText(a, 'New text.')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.deepEqual(p.picturesSkipped ?? [], []);
  const by = new Map(p.picturesMoved!.map((m) => [m.id, m]));
  assert.equal(by.get('clipped')!.wrapped, 'group');
  assert.equal(by.get('inline')!.operator, 'BI');
  assert.ok(by.get('form')!.form, 'changed in the form');
  assert.equal(p.verify!.pixelsChangedOutside, 0);

  const after = await render(bytes), before = await render(original);
  // the clipped image moved with its clip: red at 440, white where it left (310)
  assert.ok(like(at(before, 440, 340), WHITE) && like(at(after, 440, 340), RED), `clipped new ${at(after, 440, 340)}`);
  assert.ok(like(at(before, 310, 340), RED) && like(at(after, 310, 340), WHITE), 'clipped old');
  assert.ok(like(at(before, 120, 160), WHITE) && like(at(after, 120, 160), BLUE), `inline new ${at(after, 120, 160)}`);
  assert.ok(like(at(before, 120, 110), BLUE) && like(at(after, 120, 110), WHITE), 'inline old');
  assert.ok(like(at(after, 420, 120), GREEN) && like(at(after, 490, 170), WHITE) && like(at(before, 490, 170), GREEN), 'form image shrank');
  const now = (await shapesOf(bytes)).filter((s) => s.kind === 'image');
  assert.ok(Math.abs(now[2].bounds.x1 - 480) < 0.05 && Math.abs(now[2].bounds.y1 - 164) < 0.05, JSON.stringify(now[2].bounds));
});

test('a move that a clip would crop, or inside a form painted twice, is refused and reported', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await mixedPdf({ twice: true });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const md = docOf([{ pr, boxes: [a] }]);
  const [clipped, inline, inForm] = (await shapesOf(original)).filter((s) => s.kind === 'image');
  md.pages[0].pictures = [
    picOf(inForm, 'form', { x0: 400, y0: 110, x1: 480, y1: 174 }),
    picOf(clipped, 'clipped', { x0: 350, y0: 300, x1: 450, y1: 380 }),
  ];
  const { bytes, report } = await exportDoc(original, md, laidFrom(new Map([['a', await laidText(a, 'New text.')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.deepEqual(p.picturesMoved!.map((m) => m.id), ['clipped']);
  assert.deepEqual(p.picturesSkipped!.map((s) => s.id), ['form']);
  assert.match(p.picturesSkipped![0].reason, /painted more than once/);
  assert.ok(like(at(await render(bytes), 490, 170), GREEN), 'the form image stays');

  // an image whose clip is outside its own group (it holds another painting): moving it out would crop it
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const red = await doc.embedPng(solidPng(RED));
  const page = doc.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: helv.ref }, XObject: { Im0: red.ref } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream([
    'BT /F1 12 Tf 72 700 Td (Old text to replace.) Tj ET',
    'q 280 280 140 120 re W n 0 0 1 rg 280 280 10 10 re f q 100 0 0 80 300 300 cm /Im0 Do Q Q',
  ].join('\n'))));
  const o2 = await doc.save({ useObjectStreams: false });
  const [pr2] = await readPages(o2);
  const b = boxOf(pr2, 'a', [0], { edited: true });
  const md2 = docOf([{ pr: pr2, boxes: [b] }]);
  const [img] = (await shapesOf(o2)).filter((s) => s.kind === 'image');
  md2.pages[0].pictures = [picOf(img, 'far', { x0: 400, y0: 300, x1: 500, y1: 380 }), picOf(img, 'near', { x0: 300, y0: 300, x1: 380, y1: 364 })];
  const r2 = await exportDoc(o2, md2, laidFrom(new Map([['a', await laidText(b, 'New text.')]])));
  const p2 = r2.report.pages[0];
  assert.deepEqual(p2.picturesSkipped!.map((s) => s.id), ['far']);
  assert.match(p2.picturesSkipped![0].reason, /crop/);
  assert.deepEqual(p2.picturesMoved!.map((m) => [m.id, m.wrapped]), [['near', 'group']]);
  assert.ok(r2.report.ok, r2.report.failures.join('; '));
});

test('fit then export: the fitter shrinks a picture for a box, export moves it, text at full size, verified', { skip: !hasNoto && 'fonts missing' }, async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.drawText('Short source line here.', { x: 72, y: 700, size: 11, font: helv });
  page.drawImage(await doc.embedPng(solidPng(RED)), { x: 250, y: 600, width: 200, height: 150 });
  page.drawText('Figure 1. A synthetic picture.', { x: 260, y: 588, size: 8, font: helv });
  page.drawText('Small print below.', { x: 72, y: 688, size: 7, font: helv });     // stops the box growing down
  const original = await doc.save({ useObjectStreams: false });

  const P = await openPdfium();
  const pdf = P.open(original);
  const pg = pdf.page(0);
  const input = readPage(pg);
  pg.close(); pdf.close();
  const m = buildPageFrom(0, input, detectBoxes(input));
  assert.equal(m.pictures?.length, 1, JSON.stringify(m.pictures));
  const box = m.boxes.find((b) => b.paragraphs[0].runs.map((r) => r.text).join('').startsWith('Short source'))!;
  assert.ok(box, m.boxes.map((b) => b.paragraphs[0].runs[0].text).join(' | '));
  box.paragraphs[0].runs = [{ ...box.paragraphs[0].runs[0], text: 'A longer English sentence in this box.' }];
  box.edited = true;
  const fonts = await loadFonts();
  const fit = fitPage(m, (b) => layoutBox(b, fonts));
  const f = fit.boxes.find((x) => x.box === box.id)!;
  assert.equal(f.scale, 1, JSON.stringify(f));
  assert.ok(f.actions.includes('picture'), JSON.stringify(f));
  assert.equal(fit.pictures.length, 1);
  assert.ok(fit.pictures[0].scale >= 0.75 && fit.pictures[0].scale < 1, JSON.stringify(fit.pictures));

  const { bytes, report } = await exportDoc(original, { pages: [m] }, (_n, b) => layoutBox(b, fonts));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.deepEqual(p.written.map((w) => w.box), [box.id]);
  assert.equal(p.picturesMoved?.length, 1);
  assert.deepEqual(p.picturesMoved![0].to, fit.pictures[0].to);
  const [moved] = (await shapesOf(bytes)).filter((s) => s.kind === 'image');
  assert.ok(Math.abs(moved.bounds.x0 - fit.pictures[0].to.x0) < 0.05, JSON.stringify(moved.bounds));
  assert.ok(box.frame.x1 <= moved.bounds.x0, 'the box ends before the picture');
});

test('a figure drawn as one path object is a picture, and export moves it', { skip: !hasNoto && 'fonts missing' }, async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([600, 800]);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: helv.ref } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream([
    'BT /F1 12 Tf 72 700 Td (Old text to replace.) Tj ET',
    '0.1 0.6 0.2 rg 100 200 m 150 260 l 200 200 l 190 180 l 170 170 l 150 165 l 130 170 l 110 180 l 105 190 l h f',
  ].join('\n'))));
  const original = await doc.save({ useObjectStreams: false });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const shapes = await shapesOf(original);
  const pics = picturesOf(shapes, [a], 600, 800);
  assert.equal(pics.length, 1);
  assert.equal(pics[0].kind, 'figure');
  pics[0].move = { dx: 200, dy: 0, scale: 1 };
  const md = docOf([{ pr, boxes: [a] }]);
  md.pages[0].pictures = pics;
  const { bytes, report } = await exportDoc(original, md, laidFrom(new Map([['a', await laidText(a, 'New text.')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.deepEqual(p.picturesSkipped ?? [], []);
  assert.equal(p.picturesMoved![0].operator, 'path f');
  const before = await render(original), after = await render(bytes);
  const FIG: RGB = [26, 153, 51];
  assert.ok(like(at(before, 150, 210), FIG) && like(at(after, 150, 210), WHITE), 'old place');
  assert.ok(like(at(before, 350, 210), WHITE) && like(at(after, 350, 210), FIG), 'new place');
  assert.equal(p.verify!.pixelsChangedOutside, 0);
});
