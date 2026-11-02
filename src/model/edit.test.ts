// The editor: setText + layoutBox reflow, undo/redo of text, style and frames, the character-spacing reset, split and
// merge, and the speed check (a keystroke's model update + layout under 16 ms on a 100-box page). Synthetic only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadFonts } from './fonts.ts';
import type { FontRegistry } from './fonts.ts';
import { layoutBox } from './layout.ts';
import { Editor } from './edit.ts';
import { box, filler, gridPage, para } from './testkit.ts';
import type { Doc } from './types.ts';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

const docOf = (...boxes: ReturnType<typeof box>[]): Doc => ({ pages: [{ n: 0, w: 595, h: 842, boxes }] });
const textOf = (ed: Editor, id: string) => ed.box(0, id).paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');

test('setText reflows inside the width and the height grows with the text', () => {
  const b = box('b0', { x0: 100, x1: 250, y0: 680, y1: 700 }, [para('Short', { run: { size: 10, charSpacing: 1.2 } })]);
  const ed = new Editor(docOf(b), fonts);
  const one = ed.laid(0, 'b0');
  assert.equal(one.lines.length, 1);
  assert.equal(one.overflow, false);
  ed.setText(0, 'b0', 0, filler(400));
  const r = b.paragraphs[0].runs;
  assert.equal(r.length, 1);
  assert.equal(r[0].charSpacing, 0, 'new text starts with character spacing 0');
  assert.equal(r[0].size, 10, 'the first run\'s style is kept');
  assert.equal(r[0].font.source, 'shipped');
  assert.equal(r[0].font.name, 'NotoSans-Regular');
  assert.equal(b.edited, true);
  const L = ed.laid(0, 'b0');
  assert.notEqual(L, one, 'the cache was invalidated');
  assert.ok(L.lines.length > 5, `lines ${L.lines.length}`);
  for (const line of L.lines) {
    assert.equal(line.x, 100);
    for (const run of line.runs) for (const g of run.glyphs) assert.ok(g.x >= -0.01 && g.x <= 150.01, `glyph at ${g.x}`);
  }
  // baselines go down by leading × size
  for (let k = 1; k < L.lines.length; k++) assert.ok(Math.abs(L.lines[k - 1].baseline - L.lines[k].baseline - 12) < 0.01);
  assert.equal(L.frame.y1, 700);
  assert.ok(L.frame.y0 < 700 - L.lines.length * 12 + 12, 'the frame grew down');
  assert.ok(Math.abs(L.frame.y1 - L.frame.y0 - L.height) < 1e-6);
  assert.equal(L.overflow, false);
  // no source baseline on this box: the first line box starts at the frame's top
  assert.ok(Math.abs(L.textTop! - 700) < 1e-6);
  assert.ok(700 - L.lines[0].baseline > 9 && 700 - L.lines[0].baseline < 11);
  assert.ok(L.lines[0].runs[0].face, 'the face is on the run');

  // pinned height: the same text overflows
  ed.setFrame(0, 'b0', { x0: 100, x1: 250, y0: 680, y1: 700 }, { pinHeight: true });
  const P = ed.laid(0, 'b0');
  assert.equal(P.overflow, true);
  assert.deepEqual(P.frame, { x0: 100, x1: 250, y0: 680, y1: 700 });
});

test('a word wider than the box overflows; Japanese text is set in Noto Sans JP', () => {
  const b = box('b0', { x0: 0, x1: 40, y0: 0, y1: 20 }, [para('x')]);
  const ed = new Editor(docOf(b), fonts);
  ed.setText(0, 'b0', 0, 'Internationalisation');
  assert.equal(ed.laid(0, 'b0').overflow, true);
  ed.setText(0, 'b0', 0, '日本語のテキスト', { merge: true });
  assert.equal(b.paragraphs[0].runs[0].font.name, 'NotoSansJP:400');
  assert.equal(ed.laid(0, 'b0').overflow, false);
  assert.equal(ed.history.length, 1, 'merged into one edit');
  ed.setStyle(0, 'b0', 0, { bold: true });
  assert.equal(b.paragraphs[0].runs[0].font.name, 'NotoSansJP:700');
  assert.equal(ed.laid(0, 'b0').lines[0].runs[0].face!.weight, 700);
});

test('undo and redo restore text, styles and frames', () => {
  const b = box('b0', { x0: 50, x1: 300, y0: 600, y1: 640 }, [para('First paragraph.'), para('Second paragraph.', { align: 'center' })]);
  const ed = new Editor(docOf(b), fonts);
  const frame0 = { ...b.frame };
  ed.setText(0, 'b0', 1, 'S');
  ed.setText(0, 'b0', 1, 'Se', { merge: true });
  ed.setText(0, 'b0', 1, 'Sec', { merge: true });
  ed.setStyle(0, 'b0', null, { size: 14, color: [0, 0.5, 0] });
  ed.setFrame(0, 'b0', { x0: 80, x1: 200, y0: 500, y1: 620 });
  ed.setFrame(0, 'b0', { x0: 90, x1: 210, y0: 500, y1: 620 }, { merge: true });
  assert.equal(ed.history.length, 3);
  assert.equal(textOf(ed, 'b0'), 'First paragraph.\nSec');
  const narrow = ed.laid(0, 'b0');
  assert.equal(narrow.frame.x0, 90);

  ed.undo();   // frame
  assert.deepEqual(b.frame, frame0);
  ed.undo();   // style
  assert.equal(b.paragraphs[0].runs[0].size, 10);
  assert.deepEqual(b.paragraphs[1].runs[0].color, [0, 0, 0]);
  assert.equal(b.paragraphs[1].align, 'center');
  ed.undo();   // text (one undo for the burst)
  assert.equal(textOf(ed, 'b0'), 'First paragraph.\nSecond paragraph.');
  assert.equal(b.paragraphs[1].runs[0].font.source, 'document', 'the original run is back');
  assert.equal(b.edited, false, 'every edit undone: the box is no longer edited');
  assert.equal(ed.undo(), null);

  ed.redo(); ed.redo(); ed.redo();
  assert.equal(textOf(ed, 'b0'), 'First paragraph.\nSec');
  assert.equal(b.paragraphs[0].runs[0].size, 14);
  assert.deepEqual(b.frame, { x0: 90, x1: 210, y0: 500, y1: 620 });
  assert.equal(b.edited, true);
  assert.equal(ed.canRedo, false);
  ed.undo();
  ed.setText(0, 'b0', 0, 'New branch');
  assert.equal(ed.canRedo, false, 'a new edit clears the redo stack');
});

test('resetCharSpacing sets every run to 0 and is undoable', () => {
  const b = box('b0', { x0: 0, x1: 200, y0: 0, y1: 40 }, [para('tracked one', { run: { charSpacing: 1.5 } }), para('tracked two', { run: { charSpacing: 0.8 } })]);
  const ed = new Editor(docOf(b), fonts);
  const wide = ed.laid(0, 'b0').lines[0].runs[0].glyphs;
  ed.resetCharSpacing(0, 'b0');
  assert.deepEqual(b.paragraphs.map((p) => p.runs[0].charSpacing), [0, 0]);
  const tight = ed.laid(0, 'b0').lines[0].runs[0].glyphs;
  assert.ok(tight[tight.length - 1].x < wide[wide.length - 1].x - 10, 'the line got tighter');
  ed.undo();
  assert.deepEqual(b.paragraphs.map((p) => p.runs[0].charSpacing), [1.5, 0.8]);
});

test('split and merge, with undo and redo', () => {
  const b = box('b0', { x0: 50, x1: 300, y0: 600, y1: 660 }, [para('Para one.'), para('Para two.'), para('Para three.')]);
  const c = box('b1', { x0: 50, x1: 300, y0: 500, y1: 520 }, [para('Other box.')]);
  const ed = new Editor(docOf(b, c), fonts);
  const id = ed.splitBox(0, 'b0', 1);
  const pg = ed.page(0);
  assert.deepEqual(pg.boxes.map((x) => x.id), ['b0', id, 'b1']);
  assert.equal(textOf(ed, 'b0'), 'Para one.');
  assert.equal(textOf(ed, id), 'Para two.\nPara three.');
  const top = ed.laid(0, 'b0'), bottom = ed.laid(0, id);
  assert.ok(Math.abs(bottom.frame.y1 - top.frame.y0) < 1e-6, 'the new box starts where the first ends');

  ed.mergeBoxes(0, id, 'b1');
  assert.deepEqual(pg.boxes.map((x) => x.id), ['b0', id]);
  assert.equal(textOf(ed, id), 'Para two.\nPara three.\nOther box.');
  assert.ok(ed.box(0, id).frame.y0 <= 500);

  ed.undo();
  assert.deepEqual(ed.page(0).boxes.map((x) => x.id), ['b0', id, 'b1']);
  ed.undo();
  assert.deepEqual(ed.page(0).boxes.map((x) => x.id), ['b0', 'b1']);
  assert.equal(textOf(ed, 'b0'), 'Para one.\nPara two.\nPara three.');
  assert.deepEqual(ed.box(0, 'b0').frame, { x0: 50, x1: 300, y0: 600, y1: 660 });
  ed.redo(); ed.redo();
  assert.equal(textOf(ed, id), 'Para two.\nPara three.\nOther box.');
  assert.equal(ed.page(0).boxes.length, 2);

  // a split inside a paragraph, at a text offset
  const d = box('b2', { x0: 0, x1: 300, y0: 0, y1: 20 }, [para('Hello there world')]);
  const ed2 = new Editor(docOf(d), fonts);
  const id2 = ed2.splitBox(0, 'b2', 0, 6);
  assert.equal(textOf(ed2, 'b2'), 'Hello ');
  assert.equal(textOf(ed2, id2), 'there world');
});

test('locked boxes refuse edits', () => {
  const b = box('b0', { x0: 0, x1: 20, y0: 0, y1: 200 }, [para('縦')]);
  b.locked = 'vertical text';
  const ed = new Editor(docOf(b), fonts);
  assert.throws(() => ed.setText(0, 'b0', 0, 'x'), /locked/);
});

test('layoutBox keeps the source baseline for an unedited box', () => {
  const b = box('b0', { x0: 10, x1: 400, y0: 700, y1: 712 }, [para('Same text', { run: { size: 12 } })]);
  b.source.baseline = 9;
  const L = layoutBox(b, fonts);
  assert.ok(Math.abs(L.lines[0].baseline - 703) < 1e-6);
  assert.ok(L.textTop! > 712, 'the CSS line box starts above the ink top');
});

test('gate: a keystroke (model update + layoutBox) under 16 ms on a 100-box page', () => {
  const page = gridPage(100);
  assert.equal(page.boxes.length, 100);
  const ed = new Editor({ pages: [page] }, fonts);
  for (const b of page.boxes) ed.laid(0, b.id);   // the page is laid out once, as the preview does on open
  const target = page.boxes[37];
  let text = target.paragraphs[0].runs.map((r) => r.text).join('');
  const typed = ' The quick brown fox jumps over the lazy dog while the committee reviews the figures again.';
  // warm-up keystrokes (JIT), then measure
  const times: number[] = [];
  for (let k = 0; k < typed.length * 3; k++) {
    text += typed[k % typed.length];
    const t0 = performance.now();
    ed.setText(0, target.id, 0, text, { merge: true });
    const L = ed.laid(0, target.id);
    const dt = performance.now() - t0;
    assert.ok(L.lines.length > 0);
    if (k >= 20) times.push(dt);
  }
  times.sort((a, b) => a - b);
  const p50 = times[times.length >> 1], p95 = times[Math.floor(times.length * 0.95)], max = times[times.length - 1];
  console.log(`# keystroke (setText + layoutBox), ${times.length} samples, ${text.length} chars: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms`);
  assert.ok(p95 < 16, `p95 ${p95} ms`);
  assert.ok(p50 < 8, `p50 ${p50} ms`);
  assert.equal(ed.history.length, 1);
});
