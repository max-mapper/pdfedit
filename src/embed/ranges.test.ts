// Segment ranges in a linked paragraph: found in the joined text, kept in step with edits confined to one range, and
// the boundary rules (a selection across two ranges, Backspace at a range's start, Delete at a range's end, typing at
// a boundary going into the range on the caret's left). Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, checkInput, confinedRange, locateRanges, segmentTextFor, wholeRange } from './ranges.ts';
import { joinTargets } from './match.ts';

const PARTS = [{ seg: 's1', text: 'First part.' }, { seg: 's2', text: ' Second part. ' }, { seg: 's3', text: 'Third part.' }];
const TEXT = joinTargets(PARTS.map((p) => p.text));   // 'First part. Second part. Third part.'

test('ranges are found in the joined text, trimmed, in order', () => {
  const r = locateRanges(TEXT, PARTS)!;
  assert.deepEqual(r.map((x) => [x.seg, TEXT.slice(x.start, x.end), x.base]), [['s1', 'First part.', 'First part.'], ['s2', 'Second part.', 'Second part.'], ['s3', 'Third part.', 'Third part.']]);
  assert.equal(locateRanges('Other text entirely', PARTS), null);
  assert.equal(locateRanges(`${TEXT} and more words`, PARTS), null, 'letters after the last range');
  // a leading list marker the paragraph does not show; CJK parts with no joiner; an empty part
  assert.deepEqual(locateRanges('Item text', [{ seg: 'a', text: '• Item text' }])!.map((x) => [x.start, x.end, x.base]), [[0, 9, 'Item text']]);
  const cjk = locateRanges('一つ目。二つ目。', [{ seg: 'a', text: '一つ目。' }, { seg: 'b', text: '' }, { seg: 'c', text: '二つ目。' }])!;
  assert.deepEqual(cjk.map((x) => [x.seg, x.start, x.end]), [['a', 0, 4], ['b', 4, 4], ['c', 4, 8]]);
  // a segment the editor does not know (retired): the text between its neighbours
  const gap = locateRanges(TEXT, [PARTS[0], { seg: 's2', text: null }, PARTS[2]])!;
  assert.deepEqual(gap.map((x) => [x.seg, TEXT.slice(x.start, x.end)]), [['s1', 'First part.'], ['s2', 'Second part.'], ['s3', 'Third part.']]);
  assert.deepEqual(locateRanges(TEXT, [PARTS[0], { seg: 's2', text: null }])!.map((x) => x.base), ['First part.', 'Second part. Third part.']);
});

test('an edit confined to one range moves the ranges after it; the hint settles a tie', () => {
  const r = locateRanges(TEXT, PARTS)!;
  const edited = TEXT.replace('Second part.', 'Second, longer part.');
  const i = confinedRange(r, TEXT, edited);
  assert.equal(i, 1);
  const r2 = applyChange(r, i, edited.length - TEXT.length);
  assert.deepEqual(r2.map((x) => edited.slice(x.start, x.end)), ['First part.', 'Second, longer part.', 'Third part.']);
  assert.deepEqual(r2.map((x) => x.base), ['First part.', 'Second part.', 'Third part.'], 'bases are what the segments have');
  // a change across the joiner fits no range
  assert.equal(confinedRange(r, TEXT, TEXT.replace('part. Second', 'part.Second')), -1);
  // typing a space at the end of range 1: both range 1 (end) and range 2 (start, after the joiner) fit; the hint wins
  const spaced = TEXT.replace('First part. ', 'First part.  ');
  assert.equal(confinedRange(r, TEXT, spaced), 0, 'leftmost without a hint');
  assert.equal(confinedRange(r, TEXT, spaced, 1), 1);
});

test('the boundary rules', () => {
  const r = locateRanges(TEXT, PARTS)!;     // [0,11) ' ' [12,24) ' ' [25,36)
  const ins = (p: number) => checkInput(r, TEXT, { type: 'insertText', start: p, end: p });
  assert.deepEqual(ins(5), { ok: true, range: 0 });
  assert.deepEqual(ins(11), { ok: true, range: 0 }, 'at the end of a range: into it (the range on the caret\'s left)');
  assert.deepEqual(ins(12), { ok: true, range: 1 }, 'after the joiner: the next range');
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteContentBackward', start: 12, end: 12 }), { ok: false, why: 'boundary_backspace' });
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteContentBackward', start: 11, end: 11 }), { ok: true, range: 0 });
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteContentForward', start: 24, end: 24 }), { ok: false, why: 'boundary_delete' });
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteContentForward', start: 23, end: 23 }), { ok: true, range: 1 }, 'inside a range');
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteContentBackward', start: 0, end: 5 }), { ok: true, range: 0 });
  assert.deepEqual(checkInput(r, TEXT, { type: 'insertText', start: 8, end: 14 }), { ok: false, why: 'crosses_boundary' }, 'a selection over a boundary');
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteWordBackward', start: 14, end: 14 }), { ok: true, range: 1 });
  assert.deepEqual(checkInput(r, TEXT, { type: 'deleteSoftLineBackward', start: 14, end: 14 }), { ok: false, why: 'crosses_boundary' });
  // no joiner (CJK): an exact boundary types into the left range; Backspace at the right range's start is refused
  const cjk = locateRanges('一つ目。二つ目。', [{ seg: 'a', text: '一つ目。' }, { seg: 'c', text: '二つ目。' }])!;
  assert.deepEqual(checkInput(cjk, '一つ目。二つ目。', { type: 'insertText', start: 4, end: 4 }), { ok: true, range: 0 });
  assert.deepEqual(checkInput(cjk, '一つ目。二つ目。', { type: 'deleteContentBackward', start: 4, end: 4 }), { ok: false, why: 'boundary_backspace' });
  // one range over the whole paragraph: nothing to cross
  const one = wholeRange('g', 'Whole text');
  assert.deepEqual(checkInput(one, 'Whole text', { type: 'deleteContentForward', start: 10, end: 10 }), { ok: true, range: 0 }, 'a paragraph\'s edge is the caller\'s (a join)');
  assert.deepEqual(checkInput(one, 'Whole text', { type: 'insertText', start: 0, end: 10 }), { ok: true, range: 0 });
});

test('a range\'s text written back keeps what its segment has around it', () => {
  assert.equal(segmentTextFor(' Second part. ', 'Second part.', 'Second, longer part.'), ' Second, longer part. ');
  assert.equal(segmentTextFor('• Item text', 'Item text', 'Item text, edited'), '• Item text, edited');
  assert.equal(segmentTextFor('Plain', 'Plain', 'Plain!'), 'Plain!');
  assert.equal(segmentTextFor('Changed elsewhere', 'Old text', 'New'), 'New');
});
