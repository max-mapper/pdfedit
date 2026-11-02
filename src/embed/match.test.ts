// The paragraph-to-pair matcher on synthetic Japanese pairs: exact matches, normalisation, a joined run of
// consecutive pairs, unmatched paragraphs, duplicate sources in reading order, the ids a paragraph matched (its
// segment link), empty targets. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher, joinTargets, matchPairs, normalise, type Pair } from './match.ts';

const PAIRS: Pair[] = [
  { id: 's1', source: '第3四半期の売上高は前年同期比12%増となりました。', target: 'Third-quarter sales rose 12% year on year.' },
  { id: 's2', source: '主力製品の出荷が堅調に推移しました。', target: 'Shipments of core products were steady.' },
  { id: 's3', source: '新工場の稼働を開始しました。', target: 'The new plant started operating.' },
  { id: 's4', source: '今後の見通し', target: 'Outlook' },
  { id: 's5', source: '今後の見通し', target: 'Outlook, second time' },
  { id: 's6', source: '未翻訳の見出し', target: '' },
  { id: 's7', source: '「重要」なお知らせ', target: '"Important" notice' },
];

test('an exact source gives its target', () => {
  const r = matchPairs(['新工場の稼働を開始しました。'], PAIRS);
  assert.deepEqual(r.translations, ['The new plant started operating.']);
  assert.deepEqual(r.used, ['s3']);
  assert.deepEqual(r.unmatched, []);
});

test('normalised: whitespace, full-width digits and percent, half-width forms, CJK punctuation, list markers', () => {
  const r = matchPairs([
    '第３四半期の売上高は 前年同期比１２％増と\nなりました。',   // full-width digits and percent, a space and a line break
    '・今後の見通し',                                           // a list marker the segment does not have
    '"重要"なお知らせ',                                          // ASCII quotes for 「」
    '新工場の稼働を開始しました.',                                // ASCII full stop for 。
  ], PAIRS);
  assert.deepEqual(r.translations, ['Third-quarter sales rose 12% year on year.', 'Outlook', '"Important" notice', 'The new plant started operating.']);
  assert.equal(normalise('ｶﾀｶﾅ　テキスト'), 'カタカナテキスト');
  assert.equal(normalise('A–B—C－D'), 'A-B-C-D');
});

test('a run of consecutive pairs whose sources together are the paragraph', () => {
  const para = '第3四半期の売上高は前年同期比12%増となりました。主力製品の出荷が堅調に推移しました。新工場の稼働を開始しました。';
  const r = matchPairs([para], PAIRS);
  assert.deepEqual(r.translations, ['Third-quarter sales rose 12% year on year. Shipments of core products were steady. The new plant started operating.']);
  assert.deepEqual(r.used, ['s1', 's2', 's3']);
});

test('pairs that are not consecutive do not join', () => {
  const r = matchPairs(['第3四半期の売上高は前年同期比12%増となりました。新工場の稼働を開始しました。'], PAIRS);
  assert.deepEqual(r.translations, [null]);
  assert.deepEqual(r.unmatched, [0]);
  assert.deepEqual(r.used, []);
});

test('unmatched paragraphs are listed; ones without letters are left alone', () => {
  const r = matchPairs(['どの文にも一致しない段落', '12%', '2024/10', '', '今後の見通し'], PAIRS);
  assert.deepEqual(r.translations, [null, null, null, null, 'Outlook']);
  assert.deepEqual(r.unmatched, [0]);
});

test('duplicate sources are taken in reading order; when all are used, the first', () => {
  const r = matchPairs(['今後の見通し', '今後の見通し', '今後の見通し'], PAIRS);
  assert.deepEqual(r.translations, ['Outlook', 'Outlook, second time', 'Outlook']);
  assert.deepEqual(r.ids, [['s4'], ['s5'], ['s4']]);
  assert.deepEqual(r.used, ['s4', 's5']);
});

test('reading order: the next duplicate after the last match, else the first unused one, across pages', () => {
  const pairs: Pair[] = [
    { id: 'h1', source: '見出し', target: 'Heading one' },
    { id: 'a', source: '本文その一。', target: 'Body one.' },
    { id: 'h2', source: '見出し', target: 'Heading two' },
    { id: 'b', source: '本文その二。', target: 'Body two.' },
  ];
  const m = createMatcher(pairs);
  // page 1: body two first (after h2), then a heading: the first unused one after b is none, so the first unused (h1)
  assert.deepEqual(m.match(['本文その二。', '見出し']).ids, [['b'], ['h1']]);
  // page 2: a heading after h1: h2 is the next one
  assert.deepEqual(m.match(['見出し']).ids, [['h2']]);
  // in document order from a fresh matcher: h1, a, h2, b
  assert.deepEqual(createMatcher(pairs).match(['見出し', '本文その一。', '見出し', '本文その二。']).ids, [['h1'], ['a'], ['h2'], ['b']]);
});

test('duplicate runs are taken in reading order too, and ids name every pair of the run', () => {
  const pairs: Pair[] = [
    { id: 'x1', source: '前の文。', target: 'Before.' }, { id: 'y1', source: '後の文。', target: 'After.' },
    { id: 'z', source: '間の段落。', target: 'Between.' },
    { id: 'x2', source: '前の文。', target: 'Before again.' }, { id: 'y2', source: '後の文。', target: 'After again.' },
  ];
  const r = matchPairs(['前の文。後の文。', '間の段落。', '前の文。後の文。'], pairs);
  assert.deepEqual(r.ids, [['x1', 'y1'], ['z'], ['x2', 'y2']]);
  assert.deepEqual(r.translations, ['Before. After.', 'Between.', 'Before again. After again.']);
});

test('ids: a source match is a link even when its target is empty; no match is null', () => {
  const r = matchPairs(['未翻訳の見出し', 'どの文にも一致しない段落'], PAIRS);
  assert.deepEqual(r.ids, [['s6'], null]);
  assert.deepEqual(r.translations, [null, null]);
});

test('an empty target is no translation', () => {
  const r = matchPairs(['未翻訳の見出し'], PAIRS);
  assert.deepEqual(r.translations, [null]);
  assert.deepEqual(r.unmatched, [0]);
  assert.deepEqual(r.used, []);
});

test('a run may step over pairs with an empty source; a matcher is reused across pages', () => {
  const pairs: Pair[] = [{ id: 'a', source: '前半の文。', target: 'First half.' }, { id: 'gap', source: '  ', target: '' }, { id: 'b', source: '後半の文。', target: 'Second half.' }];
  const m = createMatcher(pairs);
  assert.deepEqual(m.match(['前半の文。後半の文。']).translations, ['First half. Second half.']);
  assert.deepEqual(m.match(['後半の文。']).translations, ['Second half.']);
});

test('joined targets: a space between Latin parts, none next to CJK', () => {
  assert.equal(joinTargets(['One.', ' Two. ', '']), 'One. Two.');
  assert.equal(joinTargets(['日本語の文。', '次の文。']), '日本語の文。次の文。');
  assert.equal(joinTargets(['English.', '日本語。']), 'English.日本語。');
});
