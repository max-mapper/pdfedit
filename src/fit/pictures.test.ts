// The fitter's picture step (pictures moved or shrunk by at most 25%, never cropped; text never
// shortened) on hand-built pages with a stand-in layout, and the model's pictures from a synthetic PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PNG } from 'pngjs';
import { fitPage } from './fit.ts';
import { anchorOf, candidates, movedFrame, shrinkToward } from './pictures.ts';
import { openPdfium } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { buildPageFrom, readPage } from '../model/build.ts';
import type { Page, Box, LaidBox, Picture, Rect } from '../model/types.ts';

// A stand-in layout: each character is 0.5 em wide, lines are size × leading tall.
function lay(box: Box): LaidBox {
  const width = box.frame.x1 - box.frame.x0;
  let height = 0, overflow = false;
  for (const p of box.paragraphs) {
    for (const r of p.runs) {
      const perLine = Math.max(1, Math.floor(width / (0.5 * r.size)));
      if (0.5 * r.size > width) overflow = true;
      height += Math.ceil([...r.text].length / perLine) * r.size * p.leading;
    }
  }
  return { box: box.id, frame: box.frame, height, overflow, lines: [] };
}

function mkBox(id: string, frame: Rect, text: string, size = 10, extra: Partial<Box> = {}): Box {
  return {
    id, kind: 'text', frame: { ...frame }, rot: 0, vertical: false, edited: true, locked: null, heightPinned: false,
    paragraphs: [{ runs: [{ text, size, color: [0, 0, 0], charSpacing: 0, bold: false, italic: false, underline: false,
      font: { source: 'shipped', name: 'NotoSans-Regular', bold: false, italic: false, serif: false } }], align: 'left', leading: 1.2, spaceBefore: 0, spaceAfter: 0, indent: 0, bullet: null }],
    source: { frame: { ...frame }, lines: 1, paragraphs: [{ text: '', size, align: 'left', leading: 1.2 }], objs: [], chars: [], panel: null, neighbours: [] },
    ...extra,
  };
}
const fixedBox = (id: string, frame: Rect, text = id) => mkBox(id, frame, text, 10, { edited: false });
const pic = (id: string, frame: Rect): Picture => ({ id, kind: 'image', frame: { ...frame }, z: 0, objs: [0] });
const page = (boxes: Box[], pictures: Picture[]): Page =>
  ({ n: 0, w: 600, h: 800, boxes, panels: [], obstacles: pictures.map((p) => ({ ...p.frame })), pictures });
const touches = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// The page of the first tests: box a (100–300) with a picture P to its right (310–510) and a box below it (d), so a
// can neither widen past P nor grow; P has a caption under it, so it may shrink (toward its caption and the right
// page edge) but not move.
const A = { x0: 100, x1: 300, y0: 700, y1: 712 };
const D = { x0: 90, x1: 310, y0: 680, y1: 697 };
const P = { x0: 310, x1: 510, y0: 600, y1: 760 };
const CAP = { x0: 330, x1: 490, y0: 585, y1: 597 };

test('anchor: the side nearest the caption, else the page edge; candidates cheapest first, shrinks ≤ 25%', () => {
  const p = pic('P', P);
  const cap = fixedBox('cap', CAP, 'Figure 1');
  assert.deepEqual(anchorOf(p, { w: 600, h: 800, boxes: [cap] }).anchor, { x: 'x1', y: 'y0' });
  assert.equal(anchorOf(p, { w: 600, h: 800, boxes: [cap] }).caption, cap);
  assert.deepEqual(anchorOf(p, { w: 600, h: 800, boxes: [] }), { anchor: { x: 'x1', y: 'y1' }, caption: null });
  assert.deepEqual(shrinkToward(P, { x: 'x1', y: 'y0' }, 0.5), { x0: 410, x1: 510, y0: 600, y1: 680 });
  const cs = candidates(P, { x: 'x1', y: 'y0' }, { maxShrink: 0.25, step: 0.05, canMove: true });
  assert.ok(cs.every((c, i) => i === 0 || c.cost >= cs[i - 1].cost));
  assert.equal(cs[0].kind, 'shrink');
  for (const c of cs) {
    const w = c.frame.x1 - c.frame.x0, h = c.frame.y1 - c.frame.y0;
    assert.ok(w >= 0.75 * 200 - 1e-9 && h >= 0.75 * 160 - 1e-9, 'never more than 25% smaller');
    assert.ok(near(w / 200, h / 160), 'proportions kept (never cropped)');
    if (c.kind === 'move') assert.ok(Math.abs(c.frame.x0 - P.x0) <= 200 + 1e-9 && Math.abs(c.frame.y0 - P.y0) <= 160 + 1e-9, 'moves by at most its size');
  }
  assert.ok(!candidates(P, { x: 'x1', y: 'y0' }, { maxShrink: 0.25, step: 0.05, canMove: false }).some((c) => c.kind === 'move'));
});

test('a box blocked by a picture fits after the picture shrinks by ≤ 25%, its text at full size', () => {
  const a = mkBox('a', A, 'x'.repeat(48));          // 240 pt on one line; 200 pt wide in the source
  const p = pic('P', P);
  const pg = page([a, fixedBox('d', D), fixedBox('cap', CAP, 'Figure 1')], [p]);
  const r = fitPage(pg, lay);
  const f = r.boxes[0];
  assert.equal(f.result, 'fixed');
  assert.deepEqual(f.actions, ['widen', 'picture']);
  assert.equal(f.scale, 1);
  assert.equal(a.paragraphs[0].runs[0].size, 10, 'text at full size');
  assert.equal([...a.paragraphs[0].runs[0].text].length, 48, 'never shortened');
  // the least change that fits: 20% (15% leaves 238 pt), toward the right edge and the caption below
  assert.equal(f.pictures.length, 1);
  assert.ok(near(f.pictures[0].scale, 0.8, 1e-4), JSON.stringify(f.pictures));
  assert.ok(p.move && near(p.move.scale, 0.8, 1e-9));
  const now = movedFrame(p);
  assert.ok(near(now.x1, P.x1) && near(now.y0, P.y0), 'the anchor corner stays');
  assert.ok(a.frame.x1 <= now.x0, `box ${a.frame.x1} vs picture ${now.x0}`);
  assert.deepEqual(r.pictures.map((x) => [x.id, x.box]), [['P', 'a']]);
  assert.deepEqual(r.pictures[0].from, P);
  assert.ok(near(r.pictures[0].to.x0, 350, 1e-6));
});

test('a picture never shrinks more than 25%: the box goes unfit (or shrinks its text) instead', () => {
  // needs the picture at 54%: even when asked for 60% the cap is 25%, and with no text shrink allowed it is unfit
  const a = mkBox('a', A, 'x'.repeat(60));
  const p = pic('P', P);
  const r = fitPage(page([a, fixedBox('d', D), fixedBox('cap', CAP, 'Figure 1')], [p]), lay, { pictureShrink: 0.6, floor: 1 });
  assert.equal(r.boxes[0].result, 'unfit');
  assert.equal(p.move, undefined, 'no picture change kept for an unfit box');
  assert.deepEqual(r.pictures, []);
  assert.equal([...a.paragraphs[0].runs[0].text].length, 60);

  // with the text shrink allowed: the picture at 75% and the text at 85% (at 100% even 75% is not enough)
  const b = mkBox('a', A, 'x'.repeat(60));
  const q = pic('P', P);
  const r2 = fitPage(page([b, fixedBox('d', D), fixedBox('cap', CAP, 'Figure 1')], [q]), lay);
  assert.equal(r2.boxes[0].result, 'fixed');
  assert.ok(r2.boxes[0].actions.includes('picture') && r2.boxes[0].actions.includes('shrink'));
  assert.ok(near(r2.boxes[0].scale, 0.85, 1e-6), String(r2.boxes[0].scale));
  assert.ok(q.move && q.move.scale >= 0.75 - 1e-9, JSON.stringify(q.move));

  // far too much text: unfit, the picture untouched
  const c = mkBox('a', A, 'x'.repeat(200));
  const s = pic('P', P);
  const r3 = fitPage(page([c, fixedBox('d', D), fixedBox('cap', CAP, 'Figure 1')], [s]), lay);
  assert.equal(r3.boxes[0].result, 'unfit');
  assert.equal(s.move, undefined);
});

// Picture Q (no caption) right of box a; a's 60 characters need 300 pt, so Q has to get out of a's row.
const Q = { x0: 310, x1: 410, y0: 650, y1: 760 };

test('a picture without a caption moves out of the way, onto no text', () => {
  const a = mkBox('a', A, 'x'.repeat(60));
  const q = pic('Q', Q);
  const boxes = [a, fixedBox('d', D)];
  const r = fitPage(page(boxes, [q]), lay);
  assert.equal(r.boxes[0].result, 'fixed');
  assert.equal(r.boxes[0].scale, 1);
  assert.ok(r.boxes[0].actions.includes('picture'));
  assert.ok(q.move && q.move.scale === 1, JSON.stringify(q.move));
  assert.ok(Math.abs(q.move.dx) <= 100 && Math.abs(q.move.dy) <= 110, 'by at most its own size');
  const now = movedFrame(q);
  for (const b of boxes) assert.ok(!touches(now, b.source.frame) && !touches(now, b.frame), `onto ${b.id}`);
  assert.ok(now.x0 >= 36 && now.y0 >= 36 && now.x1 <= 564 && now.y1 <= 764, 'inside the page margin');
});

test('a picture never moves onto other text', () => {
  // text right of Q and below it: every move that would free box a lands on text, so Q only shrinks (with text shrink)
  const a = mkBox('a', A, 'x'.repeat(60));
  const q = pic('Q', Q);
  const boxes = [a, fixedBox('d', D), fixedBox('east', { x0: 420, x1: 560, y0: 650, y1: 760 }), fixedBox('south', { x0: 300, x1: 420, y0: 560, y1: 640 })];
  const r = fitPage(page(boxes, [q]), lay);
  const now = movedFrame(q);
  for (const b of boxes) assert.ok(!touches(now, b.source.frame) && !touches(now, b.frame), `onto ${b.id}: ${JSON.stringify(now)}`);
  assert.ok(!q.move || q.move.scale < 1, 'not moved, at most shrunk');
  assert.ok(!q.move || q.move.scale >= 0.75 - 1e-9);
  assert.ok(r.boxes[0].scale < 1, 'the text shrank instead');
});

test('a picture moved for one box is an obstacle in its new place for the boxes after it', () => {
  const a = mkBox('a', A, 'x'.repeat(60));
  const q = pic('Q', Q);
  const b = mkBox('b', { x0: 200, x1: 300, y0: 600, y1: 612 }, 'x'.repeat(30));   // would widen to 400 past old Q
  fitPage(page([a, fixedBox('d', D), b], [q]), lay);
  const now = movedFrame(q);
  assert.ok(q.move, 'Q moved for a');
  assert.ok(touches(now, { x0: 300, x1: 400, y0: 600, y1: 612 }), 'Q now sits in b\'s row');
  assert.ok(!touches(b.frame, now), `b ${JSON.stringify(b.frame)} over Q ${JSON.stringify(now)}`);
  assert.ok(b.frame.x1 <= now.x0, 'b widened only up to Q');
  assert.equal(b.paragraphs[0].runs[0].size, 10);
});

test('pictures: false keeps every picture fixed; a picture under text never moves', () => {
  const a = mkBox('a', A, 'x'.repeat(48));
  const p = pic('P', P);
  const r = fitPage(page([a, fixedBox('d', D), fixedBox('cap', CAP, 'Figure 1')], [p]), lay, { pictures: false });
  assert.equal(p.move, undefined);
  assert.ok(r.boxes[0].scale < 1);
  // text on the picture (a label inside it): the picture stays where it is
  const b = mkBox('a', A, 'x'.repeat(48));
  const s = pic('P', P);
  fitPage(page([b, fixedBox('d', D), fixedBox('label', { x0: 350, x1: 450, y0: 650, y1: 662 })], [s]), lay);
  assert.equal(s.move, undefined);
});

// ---------------------------------------------------------------------------------------------------------------
// The model's pictures (src/model/build.ts picturesOf), from a synthetic PDF

function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([...rgb, 255], i * 4);
  return new Uint8Array(PNG.sync.write(png));
}

test('model: a free image is a picture; one under text is only an obstacle', async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const pg = doc.addPage([600, 800]);
  const img = await doc.embedPng(solidPng(8, 8, [220, 30, 30]));
  pg.drawText('A paragraph of synthetic text on the left.', { x: 60, y: 700, size: 11, font: helv });
  pg.drawImage(img, { x: 350, y: 600, width: 150, height: 120 });
  pg.drawText('Figure 1. A caption.', { x: 360, y: 588, size: 9, font: helv });
  pg.drawImage(img, { x: 60, y: 300, width: 200, height: 150 });
  pg.drawText('Text over a photo', { x: 80, y: 380, size: 14, font: helv });
  const P2 = await openPdfium();
  const pdf = P2.open(await doc.save({ useObjectStreams: false }));
  try {
    const p = pdf.page(0);
    const input = readPage(p);
    p.close();
    const m = buildPageFrom(0, input, detectBoxes(input));
    assert.equal(m.obstacles.length, 2);
    assert.equal(m.pictures?.length, 1, JSON.stringify(m.pictures));
    const [pc] = m.pictures!;
    assert.equal(pc.kind, 'image');
    const shape = input.shapes[pc.objs[0]];
    assert.equal(shape.kind, 'image');
    assert.equal(pc.z, shape.z);
    assert.ok(near(pc.frame.x0, 350, 0.5) && near(pc.frame.y1, 720, 0.5), JSON.stringify(pc.frame));
    assert.deepEqual(structuredClone(m.pictures), m.pictures);
  } finally { pdf.close(); }
});
