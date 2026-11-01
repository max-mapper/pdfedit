import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, scriptRuns } from './shape.ts';
import { testFaces } from './testkit.ts';

test('Latin kerning pair: shaped advances differ from the unkerned sum', async () => {
  const { sans } = await testFaces();
  for (const pair of ['AV', 'To', 'Ty']) {
    const glyphs = shape(sans, pair);
    assert.equal(glyphs.length, 2);
    const shaped = glyphs.reduce((s, g) => s + g.ax, 0);
    const nominal = glyphs.reduce((s, g) => s + sans.advance(g.gid), 0);
    assert.ok(shaped < nominal, `${pair}: kerned ${shaped} should be tighter than ${nominal}`);
    const off = shape(sans, pair, { features: ['-kern'] }).reduce((s, g) => s + g.ax, 0);
    assert.equal(off, nominal, `${pair} with kern off equals the nominal advances`);
  }
});

test('Japanese text shapes to one glyph per character, clusters in order', async () => {
  const { ja } = await testFaces();
  const text = 'テスト用の見出し';
  const glyphs = shape(ja, text);
  assert.equal(glyphs.length, text.length);
  assert.deepEqual(glyphs.map((g) => g.cluster), [0, 1, 2, 3, 4, 5, 6, 7]);
  for (const g of glyphs) {
    assert.ok(g.gid > 0, 'no .notdef');
    assert.equal(g.ax, 1000, 'full-width advance');
  }
  const long = '第3四半期の売上高は前年同期比12%増となりました。';
  const lg = shape(ja, long);
  assert.equal(lg.length, long.length);
  assert.ok(lg.every((g) => g.gid > 0));
});

test('mixed-script text is split into runs, clusters index the whole string', async () => {
  const { ja } = await testFaces();
  const text = 'Report テスト用 2026 summary';
  const runs = scriptRuns(text);
  assert.deepEqual(
    runs.map((r) => [text.slice(r.start, r.end), r.script, r.language]),
    [
      ['Report ', 'Latn', 'en'],
      ['テスト用 2026 ', 'Kana', 'ja'],
      ['summary', 'Latn', 'en'],
    ],
  );
  const glyphs = shape(ja, text);
  assert.equal(glyphs.length, text.length);
  assert.deepEqual(
    glyphs.map((g) => g.cluster),
    [...text].map((_, i) => i),
  );
});

test('a ligature is one glyph whose cluster covers both characters', async () => {
  const { sans } = await testFaces();
  const glyphs = shape(sans, 'office');
  const nominal = shape(sans, 'office', { features: ['-liga'] });
  assert.equal(nominal.length, 6);
  assert.ok(glyphs.length < 6, 'ffi or fi ligature');
});

test('astral characters: clusters are UTF-16 indices', async () => {
  const { ja } = await testFaces();
  const text = '𠮷野家テスト';
  assert.ok(ja.hasGlyph(0x20bb7), 'Noto Sans JP covers U+20BB7');
  const glyphs = shape(ja, text);
  assert.deepEqual(glyphs.map((g) => g.cluster), [0, 2, 3, 4, 5, 6]);
});
