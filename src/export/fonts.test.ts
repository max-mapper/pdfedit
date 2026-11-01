import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openForEdit } from '../pdf/edit.ts';
import { hasNoto, makePdf } from '../pdf/testing.ts';
import { loadHarfBuzz } from '../text/hb.ts';
import { coverageOf, documentFontCoverage, missingFrom, nodeShippedFaces, parseToUnicode, pickSubstitute, shippedSpec } from './fonts.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('parseToUnicode reads bfchar and both bfrange forms', () => {
  const cmap = enc(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def /CMapType 2 def
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar
<0003> <0020>
<0010> <00660069>
<0011> <D842DFB7>
endbfchar
2 beginbfrange
<0020> <0022> <0041>
<0030> <0031> [<3042> <30A2>]
endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`);
  const m = parseToUnicode(cmap);
  assert.equal(m.get(3), ' ');
  assert.equal(m.get(0x10), 'fi');
  assert.equal(m.get(0x11), '𠮷');
  assert.deepEqual([m.get(0x20), m.get(0x21), m.get(0x22)], ['A', 'B', 'C']);
  assert.deepEqual([m.get(0x30), m.get(0x31)], ['あ', 'ア']);
  const cov = coverageOf(m);
  // a ligature mapping does not make its letters available on their own
  assert.ok(!cov.has('f'.codePointAt(0)!) && cov.has('A'.codePointAt(0)!) && cov.has(0x20bb7));
  assert.deepEqual(missingFrom(cov, 'AB fix'), ['f', 'i', 'x']);
});

test('documentFontCoverage: a Type0 Identity-H font from its ToUnicode; simple fonts are unknown', { skip: !hasNoto && 'fonts missing' }, async () => {
  const pdf = await makePdf({ content: (f) => `BT /F1 12 Tf 72 700 Td (abc) Tj /F2 12 Tf 0 -20 Td ${f.hex('Kanji-free text')} Tj ET` });
  const edit = await openForEdit(pdf);
  const cov = documentFontCoverage(edit, 0, 'F2');
  assert.ok(cov);
  for (const ch of 'Kanjifretx-') assert.ok(cov.has(ch.codePointAt(0)!), ch);
  assert.ok(!cov.has('Z'.codePointAt(0)!));
  assert.equal(documentFontCoverage(edit, 0, 'F1'), null);
  assert.throws(() => documentFontCoverage(edit, 0, 'F9'), /no font resource/);
});

test('pickSubstitute picks Noto Sans or Noto Sans JP by class and weight, flagging serif and italic', () => {
  const run = (text: string, o: { bold?: boolean; italic?: boolean; serif?: boolean } = {}) =>
    pickSubstitute({ text, bold: !!o.bold, italic: !!o.italic, font: { bold: false, italic: false, serif: !!o.serif } });
  assert.deepEqual(run('Revenue rose'), { id: 'NotoSans-Regular', family: 'NotoSans', weight: 400, flags: [] });
  assert.equal(run('Revenue', { bold: true }).id, 'NotoSans-Bold');
  assert.equal(run('売上 rose').id, 'NotoSansJP:400');
  assert.equal(run('ｶﾀｶﾅ', { bold: true }).id, 'NotoSansJP:700');
  assert.deepEqual(run('Minutes', { serif: true, italic: true }).flags, ['serif-not-shipped', 'italic-not-shipped']);
  assert.equal(run('Minutes', { serif: true }).family, 'NotoSans');
});

test('shipped faces resolve by id, one Face per id', { skip: !hasNoto && 'fonts missing' }, async () => {
  assert.deepEqual(shippedSpec('NotoSansJP-Bold'), { id: 'NotoSansJP:700', file: 'NotoSansJP-VF.ttf', variations: { wght: 700 } });
  assert.equal(shippedSpec('NotoSans:700').id, 'NotoSans-Bold');
  assert.throws(() => shippedSpec('NotoSerif-Regular'), /no shipped face/);
  await loadHarfBuzz();
  const faces = await nodeShippedFaces();
  const ref = { source: 'shipped' as const, name: 'NotoSans-Regular', bold: false, italic: false, serif: false };
  const a = faces(ref);
  assert.equal(a, faces({ ...ref, name: 'NotoSans:400' }));
  assert.equal(a.postScriptName, 'NotoSans-Regular');
  assert.throws(() => faces({ ...ref, source: 'document' }), /document's own/);
});
