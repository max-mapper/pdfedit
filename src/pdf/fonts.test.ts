import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDict, PDFDocument, StandardFonts } from 'pdf-lib';
import { codesOf, fontInfoFromDict, standard14 } from './fonts.ts';
import { openForEdit } from './edit.ts';
import { hasNoto, makePdf } from './testing.ts';

test('standard-14 names and aliases', () => {
  assert.equal(standard14('Helvetica'), StandardFonts.Helvetica);
  assert.equal(standard14('ABCDEF+Arial,Bold'), StandardFonts.HelveticaBold);
  assert.equal(standard14('Arial-BoldItalicMT'), StandardFonts.HelveticaBoldOblique);
  assert.equal(standard14('TimesNewRomanPS-BoldItalicMT'), StandardFonts.TimesRomanBoldItalic);
  assert.equal(standard14('TimesNewRoman'), StandardFonts.TimesRoman);
  assert.equal(standard14('CourierNewPSMT'), StandardFonts.Courier);
  assert.equal(standard14('Courier-Oblique'), StandardFonts.CourierOblique);
  assert.equal(standard14('ArialNarrow'), null);
  assert.equal(standard14('NotoSans-Regular'), null);
});

test('simple fonts: /Widths with /FirstChar, MissingWidth, Type3 FontMatrix, standard 14 without /Widths', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const tt = fontInfoFromDict(
    ctx,
    ctx.obj({
      Type: 'Font', Subtype: 'TrueType', BaseFont: 'Synthetic', FirstChar: 32, LastChar: 34, Widths: [250, 300, 400],
      FontDescriptor: ctx.register(ctx.obj({ Type: 'FontDescriptor', MissingWidth: 111 })),
    }) as PDFDict,
  );
  assert.deepEqual([tt.codeBytes, tt.width(32), tt.width(34), tt.width(35), tt.width(10)], [1, 250, 400, 111, 111]);

  const t3 = fontInfoFromDict(
    ctx,
    ctx.obj({ Type: 'Font', Subtype: 'Type3', FirstChar: 65, Widths: [500], FontMatrix: [0.002, 0, 0, 0.002, 0, 0] }) as PDFDict,
  );
  assert.equal(t3.width(65), 1000);

  const helv = fontInfoFromDict(ctx, ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }) as PDFDict);
  assert.deepEqual([helv.width(72), helv.width(32), helv.width(39)], [722, 278, 222]); // StandardEncoding: 39 = quoteright
  const helvWin = fontInfoFromDict(
    ctx,
    ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }) as PDFDict,
  );
  assert.equal(helvWin.width(39), 191); // WinAnsi: 39 = quotesingle
  const diff = fontInfoFromDict(
    ctx,
    ctx.obj({
      Type: 'Font', Subtype: 'Type1', BaseFont: 'Times-Roman',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [65, 'i', 'W'] },
    }) as PDFDict,
  );
  assert.deepEqual([diff.width(65), diff.width(66), diff.width(67)], [278, 944, 667]);
  const cour = fontInfoFromDict(ctx, ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier-Bold' }) as PDFDict);
  assert.equal(cour.width(65), 600);

  const unknown = fontInfoFromDict(ctx, ctx.obj({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'Mystery' }) as PDFDict);
  assert.equal(unknown.widthsMissing, true);
  assert.equal(unknown.width(65), 0);
});

test('Type0: Identity-H and -V widths from /W, /DW, /W2; other CMaps unsupported', async () => {
  const doc = await PDFDocument.create();
  const ctx = doc.context;
  const cid = (extra: Record<string, unknown>) =>
    ctx.obj({ Type: 'Font', Subtype: 'CIDFontType2', BaseFont: 'Synth', DW: 900, W: [3, [100, 200], 10, 12, 555], ...extra } as never);
  const h = fontInfoFromDict(
    ctx,
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Synth', Encoding: 'Identity-H', DescendantFonts: [cid({})] }) as PDFDict,
  );
  assert.deepEqual([h.codeBytes, h.vertical, h.width(3), h.width(4), h.width(11), h.width(13)], [2, false, 100, 200, 555, 900]);

  const v = fontInfoFromDict(
    ctx,
    ctx.obj({
      Type: 'Font', Subtype: 'Type0', BaseFont: 'Synth', Encoding: 'Identity-V',
      DescendantFonts: [cid({ W2: [5, [-800, 500, 880]], DW2: [880, -1000] })],
    }) as PDFDict,
  );
  assert.equal(v.vertical, true);
  assert.deepEqual([v.vwidth!(5), v.vwidth!(6)], [-800, -1000]);

  const other = fontInfoFromDict(
    ctx,
    ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Synth', Encoding: 'UniJIS-UCS2-H', DescendantFonts: [cid({})] }) as PDFDict,
  );
  assert.equal(other.codeBytes, 0);

  assert.deepEqual(codesOf(Uint8Array.from([0, 3, 1, 2, 9]), 2), [3, 258]);
});

test('edit.fontInfo resolves the page resources (pdf-lib Helvetica and an embedded Noto Sans Type0)', { skip: !hasNoto }, async () => {
  const e = await openForEdit(await makePdf({ content: () => 'BT ET', inheritResources: true }));
  const f1 = e.fontInfo(0, 'F1');
  assert.equal(f1.type, 'Type1');
  assert.equal(f1.width(72), 722);
  const f2 = e.fontInfo(0, 'F2');
  assert.equal(f2.type, 'Type0');
  assert.equal(f2.codeBytes, 2);
  assert.throws(() => e.fontInfo(0, 'Nope'), /no font resource \/Nope/);
});
