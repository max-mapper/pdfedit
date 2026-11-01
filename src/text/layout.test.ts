import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutParagraphs } from './layout.ts';
import type { Layout, Line } from './layout.ts';
import type { Face } from './face.ts';
import { noLineEnd, noLineStart } from './unicode.ts';
import { testFaces } from './testkit.ts';

const lineText = (l: Line) => l.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('');
const lastGlyphEnd = (l: Line) => {
  const run = l.runs[l.runs.length - 1];
  const g = run.glyphs[run.glyphs.length - 1];
  return g.x + (run.face.advance(g.gid) * run.size) / run.face.upem;
};
const one = (text: string, face: Face, size: number, width: number, extra: Record<string, unknown> = {}): Layout =>
  layoutParagraphs([{ runs: [{ text, face, size }], ...extra }], { width });

const EN =
  'The third quarter results show steady growth across every region. Revenue rose twelve percent ' +
  'compared with the same period last year, and the outlook for the coming months remains positive.';

test('Japanese wraps at the expected character counts (10 pt full-width glyphs in a 100 pt box)', async () => {
  const { ja } = await testFaces();
  const text = 'テスト用の見出しテスト用の見出しテスト用の見出し';
  const L = one(text, ja, 10, 100);
  assert.deepEqual(L.lines.map(lineText), ['テスト用の見出しテス', 'ト用の見出しテスト用', 'の見出し']);
  assert.equal(L.overflow, false);
  assert.ok(Math.abs(L.lines[0].width - 100) < 1e-9);
});

test('English wraps greedily: every line fits, and the next word would not have', async () => {
  const { sans } = await testFaces();
  const width = 160;
  const L = one(EN, sans, 11, width);
  assert.ok(L.lines.length >= 5, `${L.lines.length} lines`);
  const words = L.lines.map((l) => lineText(l).split(' '));
  assert.equal(words.flat().join(' '), EN, 'no text lost, spaces dropped only at line ends');
  for (let i = 0; i < L.lines.length; i++) {
    assert.ok(L.lines[i].width <= width + 1e-6);
    if (i + 1 < L.lines.length) {
      const tryLine = lineText(L.lines[i]) + ' ' + words[i + 1][0];
      assert.ok(one(tryLine, sans, 11, 1e6).lines[0].width > width, `line ${i} could have taken '${words[i + 1][0]}'`);
    }
  }
});

test('kinsoku: no line starts with 、 or 。 or a small kana, none ends with 「', async () => {
  const { ja } = await testFaces();
  // 8 characters per line would put 、 at the start of line 2: the break moves back one character
  assert.deepEqual(one('テスト用の見出し、売上高。', ja, 10, 80).lines.map(lineText), ['テスト用の見出', 'し、売上高。']);
  // 6 characters per line would end line 1 with 「: the bracket moves down
  assert.deepEqual(one('前年同期比「テスト用」', ja, 10, 60).lines.map(lineText), ['前年同期比', '「テスト用」']);
  const text = '第3四半期の売上高は前年同期比12%増となりました。「テスト用の見出し」は、ちょっとキャッシュの説明です。';
  for (let w = 30; w <= 250; w += 10) {
    const L = one(text, ja, 10, w);
    for (const [i, l] of L.lines.entries()) {
      const t = lineText(l);
      if (i > 0) assert.ok(!noLineStart(t.codePointAt(0)!), `width ${w}: line ${i} starts with ${t[0]}`);
      assert.ok(!noLineEnd(t.codePointAt(t.length - 1)!), `width ${w}: line ${i} ends with ${t.at(-1)}`);
    }
    assert.equal(L.lines.map(lineText).join(''), text);
  }
});

test('justify fills the width: inter-word for Latin, inter-character for Japanese; the last line stays left', async () => {
  const { sans, ja } = await testFaces();
  const width = 150;
  const L = one(EN, sans, 11, width, { align: 'justify' });
  const last = L.lines.length - 1;
  for (const [i, l] of L.lines.entries()) {
    if (i < last) {
      assert.ok(Math.abs(l.width - width) < 1e-6);
      assert.ok(Math.abs(lastGlyphEnd(l) - width) < 1e-6, `line ${i} ends at ${lastGlyphEnd(l)}`);
      // letters inside a word keep their natural spacing: only space glyphs grow
      const plain = one(lineText(l), sans, 11, 1e6).lines[0];
      const g0 = l.runs[0].glyphs;
      const p0 = plain.runs[0].glyphs;
      assert.ok(Math.abs(g0[1].x - g0[0].x - (p0[1].x - p0[0].x)) < 1e-9);
    } else {
      assert.ok(l.width < width);
      assert.equal(l.runs[0].glyphs[0].x, 0);
    }
  }
  const J = one('第3四半期の売上高は前年同期比12%増となりました。テスト用の見出しです。', ja, 10, 95, { align: 'justify' });
  assert.ok(J.lines.length > 2);
  for (const l of J.lines.slice(0, -1)) assert.ok(Math.abs(lastGlyphEnd(l) - 95) < 1e-6, `${lineText(l)}`);
});

test('right and center alignment', async () => {
  const { sans } = await testFaces();
  const r = one('Short line', sans, 12, 200, { align: 'right' }).lines[0];
  assert.ok(Math.abs(lastGlyphEnd(r) - 200) < 1e-6);
  const c = one('Short line', sans, 12, 200, { align: 'center' }).lines[0];
  const left = c.runs[0].glyphs[0].x;
  assert.ok(Math.abs(left - (200 - c.width) / 2) < 1e-9);
});

test('a word wider than the box is broken at glyph boundaries and flagged', async () => {
  const { sans } = await testFaces();
  const L = one('A Supercalifragilisticexpialidocious example', sans, 12, 60);
  assert.equal(L.overflow, true);
  assert.ok(L.lines.some((l) => l.overflow));
  assert.equal(L.lines.map(lineText).join(''), 'ASupercalifragilisticexpialidociousexample');
  for (const l of L.lines) assert.ok(l.width <= 60 + 1e-6);
  assert.equal(one('A short example', sans, 12, 60).overflow, false);
});

test('leading: 1.2 × size by default, para leading overrides; height sums the lines', async () => {
  const { sans } = await testFaces();
  const L = one(EN, sans, 10, 150);
  for (let i = 1; i < L.lines.length; i++) assert.ok(Math.abs(L.lines[i].baseline - L.lines[i - 1].baseline - 12) < 1e-9);
  assert.ok(Math.abs(L.height - 12 * L.lines.length) < 1e-9);
  const M = one(EN, sans, 10, 150, { leading: 1.5 });
  assert.ok(Math.abs(M.lines[1].baseline - M.lines[0].baseline - 15) < 1e-9);
  // first baseline: half-leading above the ascender
  const s = 10 / sans.upem;
  assert.ok(Math.abs(L.lines[0].baseline - ((12 - (sans.ascent - sans.descent) * s) / 2 + sans.ascent * s)) < 1e-9);
});

test('mixed runs: Latin and Japanese faces and sizes on one line; the line takes the largest size', async () => {
  const { sans, ja } = await testFaces();
  const L = layoutParagraphs(
    [{ runs: [{ text: 'Q3 report: ', face: sans, size: 10 }, { text: 'テスト用の見出し', face: ja, size: 14, color: [1, 0, 0] }] }],
    { width: 400 },
  );
  assert.equal(L.lines.length, 1);
  const [a, b] = L.lines[0].runs;
  assert.equal(a.face, sans);
  assert.equal(b.face, ja);
  assert.deepEqual(b.color, [1, 0, 0]);
  assert.ok(b.glyphs[0].x > a.glyphs[a.glyphs.length - 1].x);
  assert.ok(L.lines[0].height >= 14 * 1.2 - 1e-9);
});

test('charSpacing widens a line by charSpacing per glyph gap; line breaks and paragraphs', async () => {
  const { sans } = await testFaces();
  const base = layoutParagraphs([{ runs: [{ text: 'Spacing', face: sans, size: 12 }] }], { width: 500 });
  const wide = layoutParagraphs([{ runs: [{ text: 'Spacing', face: sans, size: 12, charSpacing: 1.5 }] }], { width: 500 });
  assert.ok(Math.abs(wide.lines[0].width - base.lines[0].width - 1.5 * 6) < 1e-9);
  const nl = one('First line\nSecond line\n', sans, 12, 500);
  assert.deepEqual(nl.lines.map(lineText), ['First line', 'Second line', '']);
  const two = layoutParagraphs(
    [{ runs: [{ text: 'One', face: sans, size: 12 }] }, { runs: [{ text: 'Two', face: sans, size: 12 }] }],
    { width: 500 },
    { paragraphSpacing: 6 },
  );
  assert.deepEqual(two.lines.map((l) => l.para), [0, 1]);
  assert.ok(Math.abs(two.height - (12 * 1.2 * 2 + 6)) < 1e-9);
});
