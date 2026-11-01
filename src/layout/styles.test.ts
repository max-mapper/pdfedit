// Style changes split paragraphs: a bulleted list whose items are a coloured bullet with a bold title on one line
// and a regular description on the next becomes title and description paragraphs; a colour change splits too; a
// bullet with a same-style continuation stays one item. Bold font names. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPage, bulletListOps } from './testkit.ts';
import type { DrawOp } from './testkit.ts';
import { detectBoxes } from './detect.ts';
import { isBoldFontName } from './fontstyle.ts';

test('a bulleted list of bold titles and regular descriptions: 3 bullet paragraphs + 3 descriptions', async () => {
  const r = detectBoxes(await buildPage(bulletListOps()));
  const ps = r.paragraphs;
  assert.equal(ps.length, 6, JSON.stringify(ps.map((p) => p.text)));
  assert.deepEqual(ps.map((p) => p.bullet), ['•', null, '•', null, '•', null]);
  assert.equal(ps[0].text, '• Speed of delivery');
  assert.equal(ps[1].text, 'Orders leave the warehouse within one working day.');
  assert.ok(ps.every((p) => p.lines.length === 1));
});

test('a colour change between aligned lines at body leading starts a paragraph; the same style does not', async () => {
  const ops: DrawOp[] = [
    { t: 'text', text: 'The first line of a paragraph in black ink runs on', x: 72, y: 700, size: 10 },
    { t: 'text', text: 'and this second line is still the same paragraph.', x: 72, y: 687, size: 10 },
    { t: 'text', text: 'This line is set in red: a note of another kind', x: 72, y: 674, size: 10, color: [0.8, 0.1, 0.1] },
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.equal(r.paragraphs.length, 2, JSON.stringify(r.paragraphs.map((p) => p.text)));
  assert.equal(r.paragraphs[0].lines.length, 2);
});

test('a bullet line and an indented continuation in the same style stay one paragraph', async () => {
  const ops: DrawOp[] = [
    { t: 'text', text: '•', x: 72, y: 700, size: 10 },
    { t: 'text', text: 'A list item whose text is long enough that it', x: 84, y: 700, size: 10 },
    { t: 'text', text: 'wraps onto a second line under the text.', x: 84, y: 687, size: 10 },
    { t: 'text', text: '•', x: 72, y: 674, size: 10 },
    { t: 'text', text: 'A bold item', x: 84, y: 674, size: 10, font: 'helvB' },
    { t: 'text', text: 'with a regular continuation is two.', x: 84, y: 661, size: 10 },
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.deepEqual(r.paragraphs.map((p) => p.lines.length), [2, 1, 1], JSON.stringify(r.paragraphs.map((p) => p.text)));
  assert.deepEqual(r.paragraphs.map((p) => p.bullet), ['•', '•', null]);
});

test('bold font names: W6–W9, Bold, Heavy, Black, DB, B; Medium and DemiLight are not bold', () => {
  for (const n of ['HiraginoSans-W6', 'ABCDEF+HiraKakuProN-W7', 'HiraKakuPro-W6-90ms-RKSJ-H', 'A-OTF-ShinGoPro-Bold', 'MeiryoUI-Bold',
    'NotoSansJP-Bold', 'FOT-RodinPro-DB', 'FOT-NewRodinPro-B', 'KozGoPr6N-Heavy', 'SourceHanSans-Black', 'Meiryo-Bold', 'YuGothic-W8',
    'ShinGoProW6', 'Arial-BoldMT', 'NotoSans-SemiBold', 'HelveticaNeue-CondensedBlack'])
    assert.equal(isBoldFontName(n), true, n);
  for (const n of ['KozGoPr6N-Medium', 'A-OTF-GothicBBBPro-Medium', 'HiraginoSans-W3', 'HiraMinPro-W3-90ms-RKSJ-H', 'NotoSansCJKjp-DemiLight',
    'MS-PGothic', 'Meiryo', 'YuGothic-Regular', 'FOT-RodinPro-M', 'Helvetica', 'TimesNewRomanPSMT', ''])
    assert.equal(isBoldFontName(n), false, n);
});

test('a bulleted Japanese title line that ends short starts its own paragraph; a full first line wraps on', async () => {
  // synthetic Japanese: a short bulleted title, then its description flush with the bullet; then an item whose first
  // line runs to the full measure and wraps
  const ops: DrawOp[] = [
    { t: 'set', text: '●', x: 72, y: 700, size: 10, face: 'ja' },
    { t: 'set', text: '納期の短縮', x: 84, y: 700, size: 10, face: 'ja' },
    { t: 'set', text: 'ご注文の品は一営業日以内に倉庫から出荷します。', x: 72, y: 686, size: 10, face: 'ja' },
    { t: 'set', text: '●', x: 72, y: 668, size: 10, face: 'ja' },
    { t: 'set', text: '品質の管理では全ての製品を出荷前に検査', x: 84, y: 668, size: 10, face: 'ja' },
    { t: 'set', text: 'しています。', x: 84, y: 654, size: 10, face: 'ja' },
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.deepEqual(r.paragraphs.map((p) => [p.bullet, p.lines.length]), [['●', 1], [null, 1], ['●', 2]], JSON.stringify(r.paragraphs.map((p) => p.text)));
});

test('a raised superscript at the top of a line does not split the bullet marker off its line', async () => {
  const ops: DrawOp[] = [
    // as symbol-font markers often sit: the marker 2.4 pt above the text baseline, a superscript 2.4 pt above that
    { t: 'text', text: '•', x: 72, y: 702.4, size: 12 },
    { t: 'text', text: 'Certified', x: 90, y: 700, size: 12 },
    { t: 'text', text: '*', x: 142, y: 704.8, size: 7 },
    { t: 'text', text: 'as a supplier.', x: 150, y: 700, size: 12 },
    { t: 'text', text: '•', x: 72, y: 682, size: 12 },
    { t: 'text', text: 'A second item on its own line.', x: 90, y: 682, size: 12 },
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.deepEqual(r.paragraphs.map((p) => p.bullet), ['•', '•'], JSON.stringify(r.paragraphs.map((p) => p.text)));
});

test('symbol-font private-use characters and dingbat arrows count as list markers', async () => {
  const { isMarkerChar } = await import('./paragraphs.ts');
  for (const ch of ['', '', '', '➢', '✓', '•']) assert.ok(isMarkerChar(ch), `U+${ch.codePointAt(0)!.toString(16)}`);
  for (const ch of ['A', '1', '当']) assert.ok(!isMarkerChar(ch), ch);
});

test('a tag painted over the end of a line: its label is its own paragraph and the covered characters are dropped', async () => {
  const ops: DrawOp[] = [
    { t: 'text', text: 'Body text that runs under the tag and on to the right edge', x: 72, y: 700, size: 10 },
    { t: 'rect', x: 68, y: 696, w: 40, h: 13, fill: [0, 0.2, 0.57] },
    { t: 'text', text: 'Tag', x: 74, y: 700, size: 10, color: [1, 1, 1] },
  ];
  const r = detectBoxes(await buildPage(ops));
  const texts = r.paragraphs.map((p) => p.text);
  assert.ok(texts.includes('Tag'), JSON.stringify(texts));
  const body = texts.find((t) => t !== 'Tag')!;
  assert.ok(!body.includes('Tag') && !body.startsWith('Body'), body);   // the covered start of the line is not read
});
