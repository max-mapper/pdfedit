import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitPage } from './fit.ts';
import type { Page, Box, LaidBox, Rect } from '../model/types.ts';

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
const page = (boxes: Box[], extra: Partial<Page> = {}): Page => ({ n: 0, w: 600, h: 800, boxes, panels: [], obstacles: [], ...extra });

test('a box that fits stays as it is', () => {
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'short');
  const r = fitPage(page([b]), lay);
  assert.equal(r.boxes[0].result, 'fits');
  assert.equal(b.paragraphs[0].runs[0].size, 10);
  assert.deepEqual(b.frame, { x0: 100, x1: 300, y0: 700, y1: 712 });
});

test('widening into free space comes first', () => {
  // 50 chars at 5 pt each = 250 pt: two lines in 200 pt, one line in 260 pt
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(50));
  const r = fitPage(page([b]), lay);
  assert.equal(r.boxes[0].result, 'fixed');
  assert.deepEqual(r.boxes[0].actions, ['widen']);
  assert.ok(b.frame.x1 - b.frame.x0 >= 250, `width ${b.frame.x1 - b.frame.x0}`);
  assert.equal(b.paragraphs[0].runs[0].size, 10);
});

test('a neighbour on the right stops widening; growing down is next', () => {
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(50));
  const n = mkBox('n', { x0: 305, x1: 500, y0: 700, y1: 712 }, 'neighbour', 10, { edited: false });
  const r = fitPage(page([b, n]), lay);
  assert.equal(r.boxes[0].result, 'fixed');
  assert.ok(r.boxes[0].actions.includes('grow'));
  assert.ok(b.frame.x1 <= 303, `x1 ${b.frame.x1}`);
  assert.ok(b.frame.y0 < 700, 'grew down');
});

test('no room anywhere: shrink to the floor, then unfit with the characters over', () => {
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(400));
  const right = mkBox('r', { x0: 305, x1: 500, y0: 650, y1: 760 }, 'r', 10, { edited: false });
  const below = mkBox('d', { x0: 90, x1: 310, y0: 680, y1: 697 }, 'd', 10, { edited: false });
  const r = fitPage(page([b, right, below]), lay);
  assert.equal(r.boxes[0].result, 'unfit');
  assert.ok(Math.abs(r.boxes[0].scale - 0.7) < 1e-6);
  assert.ok(Math.abs(b.paragraphs[0].runs[0].size - 7) < 1e-6);
  assert.ok(r.boxes[0].charsOver > 0);
  assert.equal([...b.paragraphs[0].runs[0].text].length, 400, 'never shortened');
});

test('a box never grows out of its panel', () => {
  const panel = { x0: 90, x1: 320, y0: 650, y1: 730 };
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(50));
  b.source.panel = panel;
  fitPage(page([b], { panels: [panel] }), lay);
  assert.ok(b.frame.x1 <= panel.x1, `x1 ${b.frame.x1}`);
});

test('a row of labels with the same size and width ends at one scale', () => {
  const a = mkBox('a', { x0: 100, x1: 150, y0: 700, y1: 712 }, 'x'.repeat(40));
  const b = mkBox('b', { x0: 160, x1: 210, y0: 700, y1: 712 }, 'x'.repeat(10));
  const wall = mkBox('w', { x0: 90, x1: 260, y0: 670, y1: 697 }, 'w', 10, { edited: false });
  const c = mkBox('c', { x0: 215, x1: 265, y0: 700, y1: 712 }, 'c', 10, { edited: false });
  const r = fitPage(page([a, b, wall, c]), lay);
  const sa = r.boxes.find((x) => x.box === 'a')!.scale, sb = r.boxes.find((x) => x.box === 'b')!.scale;
  assert.equal(sa, sb);
});

// A stand-in vertical layout: columns of `length / (size)` characters, each column `size × leading` wide.
function layV(box: Box): LaidBox {
  const length = box.frame.y1 - box.frame.y0;
  let width = 0;
  for (const p of box.paragraphs) for (const r of p.runs) {
    const perCol = Math.max(1, Math.floor(length / r.size));
    width += Math.ceil([...r.text].length / perCol) * r.size * p.leading;
  }
  return { box: box.id, frame: { ...box.frame, x0: box.frame.x1 - width }, height: length, width, overflow: false, lines: [] } as LaidBox;
}

test('a vertical box widens to the left, then grows down, then shrinks', () => {
  // 10 pt, leading 1.2: a 100 pt column holds 10 characters; the source is 2 columns wide (24 pt)
  const v = mkBox('v', { x0: 300, x1: 324, y0: 600, y1: 700 }, 'あ'.repeat(30), 10, { vertical: true });
  const r = fitPage(page([v]), layV as (b: Box) => LaidBox);
  assert.equal(r.boxes[0].result, 'fixed');
  assert.ok(v.frame.x0 < 300 && v.frame.x1 === 324, `frame ${JSON.stringify(v.frame)}`);   // widened to the left
  assert.equal(v.paragraphs[0].runs[0].size, 10);
  const left = mkBox('l', { x0: 270, x1: 296, y0: 550, y1: 720 }, 'l', 10, { edited: false });
  const v2 = mkBox('v2', { x0: 300, x1: 324, y0: 600, y1: 700 }, 'あ'.repeat(30), 10, { vertical: true });
  const r2 = fitPage(page([v2, left]), layV as (b: Box) => LaidBox);
  assert.ok(r2.boxes[0].actions.includes('grow'), JSON.stringify(r2.boxes[0]));
  assert.ok(v2.frame.y0 < 600, 'longer columns');
});

test('a box never widens into a neighbour it touched in the source', () => {
  const a = mkBox('a', { x0: 100, x1: 200, y0: 700, y1: 712 }, 'x'.repeat(60));
  const b = mkBox('b', { x0: 200.5, x1: 300, y0: 700, y1: 712 }, 'neighbour', 10, { edited: false });
  a.source.neighbours = ['b']; b.source.neighbours = ['a'];
  fitPage(page([a, b]), lay);
  assert.ok(a.frame.x1 <= 200.6, `x1 ${a.frame.x1}`);
});

test('a vertical box grows its columns only as far as it needs', () => {
  const left = mkBox('l', { x0: 270, x1: 296, y0: 300, y1: 720 }, 'l', 10, { edited: false });
  const v = mkBox('v', { x0: 300, x1: 324, y0: 600, y1: 700 }, 'あ'.repeat(30), 10, { vertical: true });
  fitPage(page([v, left]), layV as (b: Box) => LaidBox);
  // 30 characters in 2 columns of 12 pt need columns of 150 pt; the page would allow ~650
  assert.ok(v.frame.y1 - v.frame.y0 <= 160, `length ${v.frame.y1 - v.frame.y0}`);
});

test('a column keeps its gutter: widening stops short of the next column by the source gap', () => {
  const a = mkBox('a', { x0: 100, x1: 200, y0: 700, y1: 712 }, 'x'.repeat(60));
  const b = mkBox('b', { x0: 212, x1: 300, y0: 690, y1: 712 }, 'next column', 10, { edited: false });
  fitPage(page([a, b]), lay);
  assert.ok(a.frame.x1 <= 200.01, `x1 ${a.frame.x1} (gutter of 12 pt kept)`);
});

test('a rule below the box stops it growing down across it', () => {
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(120));
  const n = mkBox('n', { x0: 305, x1: 500, y0: 700, y1: 712 }, 'neighbour', 10, { edited: false });
  const r = fitPage(page([b, n], { rules: [{ x0: 90, x1: 510, y0: 679.5, y1: 680.5 }] }), lay);
  assert.ok(b.frame.y0 >= 680.5, `y0 ${b.frame.y0}`);
  assert.ok(r.boxes[0].actions.includes('shrink'));
});

test('a filled shape the box did not touch (a chart bar) bounds its widening', () => {
  const b = mkBox('a', { x0: 100, x1: 200, y0: 700, y1: 712 }, 'x'.repeat(30));
  fitPage(page([b], { fills: [{ x0: 230, x1: 260, y0: 600, y1: 720 }] }), lay);
  assert.ok(b.frame.x1 <= 228.01, `x1 ${b.frame.x1}`);
});

test('the right edge stops at the page content edge, not the paper edge', () => {
  const b = mkBox('a', { x0: 100, x1: 300, y0: 700, y1: 712 }, 'x'.repeat(120));
  const far = mkBox('f', { x0: 100, x1: 520, y0: 100, y1: 112 }, 'other', 10, { edited: false });
  fitPage(page([b, far]), lay);
  assert.ok(b.frame.x1 <= 558.01, `x1 ${b.frame.x1}`);   // 0.93 × 600 is the floor of the content edge
});

test('a label in a small cell widens within the cell, centred, instead of breaking or shrinking hard', () => {
  const cell = { x0: 100, x1: 140, y0: 690, y1: 720 };
  const b = mkBox('l', { x0: 110, x1: 130, y0: 700, y1: 708 }, 'x'.repeat(9), 6, { kind: 'label' });
  const r = fitPage(page([b], { fills: [cell] }), lay);
  assert.equal(r.boxes[0].result, 'fixed');
  assert.ok(b.frame.x0 > cell.x0 && b.frame.x1 < cell.x1, JSON.stringify(b.frame));
  assert.ok(Math.abs((b.frame.x0 + b.frame.x1) / 2 - 120) < 0.01, 'centred');
  assert.equal(b.paragraphs[0].align, 'center');
});
