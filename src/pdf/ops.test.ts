import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOps, textShows } from './ops.ts';
import { latin1, text } from './testing.ts';

test('parseOps: operands with the operator, byte ranges cover both', () => {
  const src = latin1('q 1 0 0 1 10 20 cm BT /F1 9 Tf [(a) -5 (b)] TJ ET Q');
  const ops = parseOps(src);
  assert.deepEqual(ops.map((o) => o.op), ['q', 'cm', 'BT', 'Tf', 'TJ', 'ET', 'Q']);
  assert.equal(text(src.subarray(ops[1].start, ops[1].end)), '1 0 0 1 10 20 cm');
  assert.equal(text(src.subarray(ops[4].start, ops[4].end)), '[(a) -5 (b)] TJ');
});

test('textShows: content order, numbering and text state under q/Q nesting', () => {
  const src = latin1(
    [
      'BT /F1 10 Tf 1 Tc 2 Tw 80 Tz 12 TL (one) Tj ET',
      'q',
      '  BT /F2 20 Tf 0.5 Tc (two) Tj',
      '  q 150 Tz [(thr) -10 (ee)] TJ Q',
      '  (four) \' ET',
      'Q',
      'BT (five) Tj 3 4 (six) " (seven) Tj ET',
      '(outside) Tj',
    ].join('\n'),
  );
  const shows = textShows(parseOps(src));
  const pick = shows.map((s) => ({
    n: s.n,
    op: s.op,
    font: s.font,
    size: s.fontSize,
    tc: s.charSpacing,
    tw: s.wordSpacing,
    th: s.hScale,
    tl: s.leading,
    str: s.strings.map((b) => text(b)).join('|'),
    inBT: s.inBT,
  }));
  assert.deepEqual(pick, [
    { n: 0, op: 'Tj', font: 'F1', size: 10, tc: 1, tw: 2, th: 0.8, tl: 12, str: 'one', inBT: true },
    { n: 1, op: 'Tj', font: 'F2', size: 20, tc: 0.5, tw: 2, th: 0.8, tl: 12, str: 'two', inBT: true },
    { n: 2, op: 'TJ', font: 'F2', size: 20, tc: 0.5, tw: 2, th: 1.5, tl: 12, str: 'thr|ee', inBT: true },
    { n: 3, op: "'", font: 'F2', size: 20, tc: 0.5, tw: 2, th: 0.8, tl: 12, str: 'four', inBT: true },
    // after Q: back to F1 10, Tc 1
    { n: 4, op: 'Tj', font: 'F1', size: 10, tc: 1, tw: 2, th: 0.8, tl: 12, str: 'five', inBT: true },
    // " sets Tw 3 and Tc 4 for itself and for what follows
    { n: 5, op: '"', font: 'F1', size: 10, tc: 4, tw: 3, th: 0.8, tl: 12, str: 'six', inBT: true },
    { n: 6, op: 'Tj', font: 'F1', size: 10, tc: 4, tw: 3, th: 0.8, tl: 12, str: 'seven', inBT: true },
    { n: 7, op: 'Tj', font: 'F1', size: 10, tc: 4, tw: 3, th: 0.8, tl: 12, str: 'outside', inBT: false },
  ]);
  assert.equal(text(src.subarray(shows[5].start, shows[5].end)), '3 4 (six) "');
});

test('textShows: an unbalanced Q does not throw and keeps the state', () => {
  const shows = textShows(parseOps(latin1('Q Q BT /F3 7 Tf (x) Tj ET')));
  assert.equal(shows.length, 1);
  assert.equal(shows[0].font, 'F3');
  assert.equal(shows[0].fontSize, 7);
});

test('textShows: inline images and comments do not disturb the count', () => {
  const src = latin1('BT /F1 5 Tf (a) Tj ET % (no) Tj\nBI /W 1 /H 1 /BPC 8 /CS /G ID \x00 EI BT (b) Tj ET');
  const shows = textShows(parseOps(src));
  assert.deepEqual(shows.map((s) => text(s.strings[0])), ['a', 'b']);
});
