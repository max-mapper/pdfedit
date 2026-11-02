// Hand marks (Box.hand, src/model/edit.ts): which edits mark a box as adjusted by hand, with undo and redo.
// Synthetic boxes only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadFonts, type FontRegistry } from './fonts.ts';
import { Editor } from './edit.ts';
import { box, para } from './testkit.ts';
import type { Doc } from './types.ts';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

const doc = (): Doc => ({ pages: [{
  n: 0, w: 595, h: 842,
  boxes: [
    box('b0', { x0: 60, x1: 300, y0: 760, y1: 780 }, [para('A heading')]),
    box('b1', { x0: 60, x1: 200, y0: 700, y1: 712 }, [para('A paragraph that will need more room than its source box has, once it is set again.')]),
    box('b2', { x0: 60, x1: 300, y0: 600, y1: 640 }, [para('Another paragraph')]),
  ],
}] });
const hand = (d: Doc, id: string) => !!d.pages[0].boxes.find((b) => b.id === id)!.hand;

test('a move, a resize and a pin mark the box; undo takes the mark back, redo puts it again', () => {
  const d = doc(), ed = new Editor(d, fonts);
  ed.setFrame(0, 'b0', { x0: 80, x1: 320, y0: 760, y1: 780 });
  assert.equal(hand(d, 'b0'), true);
  assert.equal(hand(d, 'b1'), false);
  ed.undo();
  assert.equal(hand(d, 'b0'), false, 'undo of the first hand edit clears the mark');
  ed.redo();
  assert.equal(hand(d, 'b0'), true);
  ed.setFrame(0, 'b0', { x0: 90, x1: 330, y0: 760, y1: 780 }, { merge: true });
  assert.equal(hand(d, 'b0'), true, 'a drag folded into the move keeps it');
  ed.setHeightPinned(0, 'b2', true);
  assert.equal(hand(d, 'b2'), true, 'pinning the height is a resize');
});

test('font, size and style changes mark the box; a second edit undone keeps the mark of the first', () => {
  const d = doc(), ed = new Editor(d, fonts);
  ed.setStyle(0, 'b0', null, { size: 14 });
  assert.equal(hand(d, 'b0'), true);
  ed.setStyle(0, 'b0', 0, { bold: true });
  ed.undo();
  assert.equal(hand(d, 'b0'), true, 'the size change still holds');
  ed.setStyle(0, 'b2', null, { font: { source: 'shipped', name: 'NotoSans-Bold', bold: true, italic: false, serif: false } });
  assert.equal(hand(d, 'b2'), true);
  ed.resetCharSpacing(0, 'b1');
  assert.equal(hand(d, 'b1'), true, 'resetting the character spacing is a style change');
});
