import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFace } from './face.ts';
import { shape } from './shape.ts';
import { fontBytes, testFaces } from './testkit.ts';

test('metrics come from head, hhea/OS/2, post and name', async () => {
  const { sans, sansBold, ja } = await testFaces();
  assert.equal(sans.upem, 1000);
  assert.equal(sans.familyName, 'Noto Sans');
  assert.equal(sans.postScriptName, 'NotoSans-Regular');
  assert.equal(sansBold.postScriptName, 'NotoSans-Bold');
  assert.ok(sans.ascent > 900 && sans.descent < -200, `${sans.ascent} ${sans.descent}`);
  assert.ok(sans.capHeight > 600 && sans.capHeight < 800);
  assert.equal(sans.italicAngle, 0);
  assert.ok(sans.bbox[0] < 0 && sans.bbox[3] > 900);
  assert.equal(sans.weight, 400);
  assert.equal(sansBold.weight, 700);
  assert.equal(ja.familyName, 'Noto Sans JP');
  assert.equal(ja.postScriptName, 'NotoSansJP-Regular');
  assert.ok(sans.hasGlyph(0x41) && !sans.hasGlyph(0x3042));
  assert.ok(ja.hasGlyph(0x3042) && ja.hasGlyph(0x41));
});

test('Noto Sans JP: wght 400 and 700 give different advances and outlines', async () => {
  const { ja, jaBold } = await testFaces();
  assert.deepEqual(ja.variations, { wght: 400 });
  assert.deepEqual(jaBold.variations, { wght: 700 });
  assert.equal(jaBold.postScriptName, 'NotoSansJP-Bold');
  const a = ja.glyph(0x41)!;
  assert.equal(a, jaBold.glyph(0x41));
  assert.notEqual(ja.advance(a), jaBold.advance(a), 'Latin A advance changes with weight');
  const shaped400 = shape(ja, 'Sales').reduce((s, g) => s + g.ax, 0);
  const shaped700 = shape(jaBold, 'Sales').reduce((s, g) => s + g.ax, 0);
  assert.ok(shaped700 > shaped400);
  const kanji = ja.glyph(0x58f2)!; // 売
  assert.notEqual(ja.hbFont.glyphToPath(kanji), jaBold.hbFont.glyphToPath(kanji), 'outline changes with weight');
});

test('the wght axis defaults to 400, not the font default of 100; unknown axes are refused', async () => {
  await testFaces();
  const def = loadFace(fontBytes('NotoSansJP-VF.ttf'));
  assert.equal(def.variations.wght, 400);
  const thin = loadFace(fontBytes('NotoSansJP-VF.ttf'), { variations: { wght: 100 } });
  assert.equal(thin.postScriptName, 'NotoSansJP-Thin');
  assert.throws(() => loadFace(fontBytes('NotoSans-Regular.ttf'), { variations: { wght: 700 } }), /no 'wght' axis/);
});
