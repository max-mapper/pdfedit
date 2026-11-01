import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { openForEdit } from './edit.ts';
import { readTail } from './incremental.ts';
import { parseOps, textShows } from './ops.ts';
import { blankOut } from './surgery.ts';
import {
  hasNoto,
  hasPdftotext,
  hasQpdf,
  lastStartxref,
  latin1,
  makePdf,
  pdftotext,
  qpdfCheck,
  readXrefSection,
  text,
} from './testing.ts';

const CONTENT = (hex: (t: string) => string, withType0: boolean) =>
  [
    'BT /F1 14 Tf 72 700 Td (Remove this sentence. ) Tj (KeepAfter) Tj ET',
    'BT /F1 12 Tf 72 650 Td (Untouched line on page {page}) Tj ET',
    withType0 ? `BT /F2 12 Tf 72 600 Td ${hex('Type0 stays')} Tj ET` : '',
    '0 0 1 rg 72 500 100 20 re f',
  ].join('\n');

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
}

for (const objectStreams of [false, true]) {
  const kind = objectStreams ? 'xref stream' : 'classic xref';

  test(`incremental save over a ${kind} original`, async () => {
    const original = await makePdf({ content: (f) => CONTENT(f.hex, hasNoto), objectStreams, pages: 2 });
    assert.equal(readTail(original).kind, objectStreams ? 'stream' : 'table');

    const e = await openForEdit(original);
    assert.equal(e.pageCount, 2);
    const c = e.contents(0);
    const shows = textShows(parseOps(c));
    const victim = shows.find((s) => text(s.strings[0]).startsWith('Remove'))!;
    const blanked = blankOut(c, [victim], (n) => e.fontInfo(0, n));
    e.setContents(0, blanked);

    // New text through a font object registered via the context after open, under a fresh resource name.
    const bold = e.context.register(e.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' }));
    e.appendContent(0, latin1('q BT /NewF 16 Tf 72 400 Td (Brand new words) Tj ET Q'), { NewF: bold });
    const out = e.save();

    // 1. The original bytes are a prefix, byte for byte.
    assert.ok(sameBytes(out.subarray(0, original.length), original));
    assert.ok(out.length > original.length);

    // 2. The new section is of the original's kind, chains to the original's, and every entry is right.
    const sec = readXrefSection(out, lastStartxref(out));
    assert.equal(sec.kind, objectStreams ? 'stream' : 'table');
    assert.equal(sec.prev, lastStartxref(original));
    readXrefSection(original, sec.prev!);
    const origSize = readTail(original).size;
    for (const n of sec.entries.keys()) assert.ok(n < sec.size);
    assert.ok(sec.size > origSize);
    // only the touched page, the new streams and the new font: page 1 is not rewritten
    const page1 = (await PDFDocument.load(original, { updateMetadata: false })).getPage(1).ref.objectNumber;
    assert.ok(!sec.entries.has(page1));
    assert.ok(sec.entries.has(e.doc.getPage(0).ref.objectNumber));
    assert.ok(sec.entries.has(bold.objectNumber));

    // 3. Reloads with the change visible.
    const re = await openForEdit(out);
    const reContents = text(re.contents(0));
    assert.ok(reContents.startsWith('q\n'), 'original contents bracketed by q … Q');
    assert.ok(reContents.includes(text(blanked)));
    assert.ok(reContents.includes('(Brand new words) Tj'));
    assert.ok(!reContents.includes('Remove this'));
    assert.equal(text(re.contents(1)), text(e.contents(1)));

    // 4. poppler reads it without repairs; the blanked sentence is gone, the rest is still there.
    if (hasPdftotext) {
      const { text: txt, stderr } = pdftotext(out, `inc-${objectStreams}.pdf`);
      assert.equal(stderr.trim(), '', stderr);
      const p1 = pdftotext(out, `inc-${objectStreams}-p1.pdf`, 1).text;
      assert.ok(!p1.includes('Remove this sentence'), p1);
      assert.ok(p1.includes('KeepAfter') && p1.includes('Brand new words'), p1);
      assert.ok(pdftotext(out, `inc-${objectStreams}-p2.pdf`, 2).text.includes('Remove this sentence'), 'page 2 untouched');
      for (const kept of ['KeepAfter', 'Untouched line on page 1', 'Untouched line on page 2', 'Brand new words']) {
        assert.ok(txt.includes(kept), `${kept} missing:\n${txt}`);
      }
      if (hasNoto) assert.ok(txt.includes('Type0 stays'), txt);
    }
    if (hasQpdf) {
      const q = qpdfCheck(out, `inc-${objectStreams}-q.pdf`);
      assert.ok(q.ok, q.out);
    }

    // 5. A second round on the saved file appends again and chains to the first update.
    const e2 = await openForEdit(out);
    e2.setContents(1, latin1('BT /F1 12 Tf 72 650 Td (Second update) Tj ET'));
    const out2 = e2.save();
    assert.ok(sameBytes(out2.subarray(0, out.length), out));
    assert.equal(readXrefSection(out2, lastStartxref(out2)).prev, lastStartxref(out));
    if (hasPdftotext) {
      const { text: txt2, stderr } = pdftotext(out2, `inc2-${objectStreams}.pdf`);
      assert.equal(stderr.trim(), '', stderr);
      assert.ok(txt2.includes('Second update') && txt2.includes('Brand new words') && !txt2.includes('page 2'), txt2);
    }
  });
}

test('appendContent copies inherited resources and never mutates the shared dict', async () => {
  const original = await makePdf({ content: (f) => CONTENT(f.hex, false), pages: 2, inheritResources: true, type0: false });
  const e = await openForEdit(original);
  const ctx = e.context;
  const pageDict = (i: number) => ctx.lookup(e.doc.getPage(i).ref) as PDFDict;
  assert.equal(pageDict(0).get(PDFName.of('Resources')), undefined, 'fixture: resources are inherited');
  const pages = ctx.lookup(pageDict(0).get(PDFName.of('Parent'))!) as PDFDict;
  const sharedRes = ctx.lookup(pages.get(PDFName.of('Resources'))!) as PDFDict;
  const sharedFonts = ctx.lookup(sharedRes.get(PDFName.of('Font'))!) as PDFDict;
  const before = sharedRes.toString() + sharedFonts.toString();

  const f1 = sharedFonts.get(PDFName.of('F1')) as PDFRef;
  e.appendContent(0, latin1('q BT /Fx 10 Tf 72 300 Td (Added) Tj ET Q'), { Fx: f1 });
  assert.equal(sharedRes.toString() + sharedFonts.toString(), before);
  assert.equal(pageDict(1).get(PDFName.of('Resources')), undefined, 'page 1 still inherits');
  const own = pageDict(0).get(PDFName.of('Resources')) as PDFDict;
  const ownFonts = own.get(PDFName.of('Font')) as PDFDict;
  assert.ok(ownFonts.get(PDFName.of('F1')) && ownFonts.get(PDFName.of('Fx')));
  assert.ok(pageDict(0).get(PDFName.of('Contents')) instanceof PDFArray);
  assert.throws(() => e.appendContent(0, latin1('q Q'), { F1: PDFRef.of(9999, 0) }), /already used/);

  const out = e.save();
  if (hasPdftotext) {
    const { text: txt, stderr } = pdftotext(out, 'inherit.pdf');
    assert.equal(stderr.trim(), '');
    assert.ok(txt.includes('Added') && txt.includes('Remove this sentence') && txt.includes('page 2'), txt);
  }
});

test('full save, no-change save, encrypted and image-filter refusals', async () => {
  const original = await makePdf({ content: (f) => CONTENT(f.hex, false), type0: false });
  const e = await openForEdit(original);
  assert.ok(sameBytes(e.save(), original), 'nothing changed: the original comes back');

  e.setContents(0, latin1('BT /F1 12 Tf 72 650 Td (Full save text) Tj ET'));
  const full = e.save({ incremental: false });
  assert.ok(!sameBytes(full.subarray(0, original.length), original));
  const sec = readXrefSection(full, lastStartxref(full));
  assert.equal(sec.prev, null);
  const re = await openForEdit(full);
  assert.equal(text(re.contents(0)), 'BT /F1 12 Tf 72 650 Td (Full save text) Tj ET');
  if (hasPdftotext) {
    const { text: txt, stderr } = pdftotext(full, 'full.pdf');
    assert.equal(stderr.trim(), '');
    assert.ok(txt.includes('Full save text') && !txt.includes('Untouched'), txt);
  }

  // An update section whose trailer carries /Encrypt.
  const tail = readTail(original);
  const root = (await PDFDocument.load(original)).context.trailerInfo.Root!.toString();
  const enc = Buffer.concat([
    Buffer.from(original),
    Buffer.from(`xref\n0 0\ntrailer\n<< /Size ${tail.size} /Root ${root} /Encrypt << /Filter /Standard /V 1 >> /Prev ${tail.startxref} >>\nstartxref\n${original.length}\n%%EOF\n`),
  ]);
  await assert.rejects(openForEdit(enc), /encrypted/);

  // A content stream with a filter other than FlateDecode is decoded (src/pdf/filters.ts); an image-only filter is
  // refused with the stream and the filter named.
  const doc = await PDFDocument.load(original);
  const hexStream = doc.context.stream('42 54 20 45 54>', { Filter: 'ASCIIHexDecode' });
  doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(hexStream));
  const ahx = await openForEdit(await doc.save({ useObjectStreams: false }));
  assert.equal(text(ahx.contents(0)), 'BT ET');
  const dct = doc.context.stream('BT ET', { Filter: ['DCTDecode', 'FlateDecode'] });
  doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(dct));
  const bad = await openForEdit(await doc.save({ useObjectStreams: false }));
  assert.throws(() => bad.contents(0), /content stream \d+ 0 R uses the filter \/DCTDecode .*image-only/);
});
