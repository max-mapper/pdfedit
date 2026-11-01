// exportDoc on synthetic PDFs (pdf-lib, Helvetica and a fontkit-embedded Noto Sans Type0). Synthetic material only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib';
import { decodeStream, openForEdit } from '../pdf/edit.ts';
import { hasNoto, hasPdftotext, makePdf, pdftotext, pdfWords } from '../pdf/testing.ts';
import { ExportError, exportDoc } from './export.ts';
import { boxOf, countOf, docOf, laidText, latin, readPages } from './testkit.ts';
import type { Box, LaidBox } from '../model/types.ts';

const PARA = [
  'BT /F1 14 Tf 72 700 Td (Old paragraph first line.) Tj 0 -18 Td (Old paragraph second line.) Tj ET',
  'BT /F1 12 Tf 72 500 Td (Untouched text below on page {page}.) Tj ET',
  '0 0 1 rg 72 400 100 20 re f',
].join('\n');

const NEW = 'A new English paragraph replaces the old one.';

/** laid() for exportDoc from a prepared map. */
function laidFrom(m: Map<string, LaidBox>) {
  return (_page: number, box: Box) => {
    const l = m.get(box.id);
    if (!l) throw new Error(`no layout for ${box.id}`);
    return l;
  };
}

/** The decoded last content stream of page 1 (the one export appended). */
async function lastStream(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const arr = pdf.getPage(0).node.lookup(PDFName.of('Contents'), PDFArray);
  const s = pdf.context.lookup(arr.get(arr.size() - 1), PDFStream);
  return decodeStream(pdf.context, s, 'last');
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

test('one edited box on a one-page PDF: written, verified, incremental', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const b = boxOf(pr, 'b', [2]);
  const doc = docOf([{ pr, boxes: [a, b] }]);
  const { bytes, report } = await exportDoc(original, doc, laidFrom(new Map([['a', await laidText(a, NEW)]])));

  assert.ok(report.ok, report.failures.join('; '));
  assert.ok(report.verified && report.incremental);
  // incremental: the original is a byte-for-byte prefix
  assert.ok(sameBytes(bytes.subarray(0, original.length), original));
  const p = report.pages[0];
  assert.deepEqual(p.written.map((w) => w.box), ['a']);
  assert.deepEqual(p.skipped, []);
  assert.equal(p.operatorsBlanked, 2);
  assert.deepEqual(p.written[0].objs, [0, 1]);
  assert.equal(report.fonts.length, 1);
  assert.equal(report.fonts[0].face, 'NotoSans-Regular');
  assert.ok(report.fonts[0].glyphs > 10 && report.fonts[0].bytes > 1000 && report.fonts[0].programBytes > 1000);
  assert.deepEqual(p.fonts.map((f) => f.key), [report.fonts[0].key]);
  assert.equal(p.verify!.pixelsChangedOutside, 0);
  assert.ok(p.verify!.pixelsCompared > 500_000);
  assert.deepEqual(p.verify!.text, [{ box: 'a', newPresent: true, oldAbsent: true }]);
  assert.equal(report.allPagesRender, true);
  assert.ok(report.growth > 0 && report.bytesOut === bytes.length);
  assert.ok(p.growth > 0 && p.contentBytes > 0 && p.fontBytes === report.fonts[0].bytes);
  // Helvetica is not a Type0 font: its coverage is unknown
  assert.deepEqual(p.written[0].documentFont.map((d) => d.coverage), ['unknown']);
  assert.equal(p.written[0].couldStayInDocumentFont, null);
  assert.equal(p.written[0].mcid, null);

  // the untouched text stays in the original stream; the old text's operators are gone from it
  const re = await openForEdit(bytes);
  const c = latin(re.contents(0));
  assert.ok(!c.includes('Old paragraph'));
  assert.ok(c.includes('(Untouched text below on page 1.) Tj'));
  if (hasPdftotext) {
    const t = pdftotext(bytes, 'export-one.pdf').text.replace(/\s+/g, ' ');
    assert.ok(t.includes(NEW), t);
    assert.ok(!t.includes('Old paragraph'), t);
  }
});

test('full save on request also verifies', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA, objectStreams: true });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), laidFrom(new Map([['a', await laidText(a, NEW)]])), { incremental: false });
  assert.ok(report.ok, report.failures.join('; '));
  assert.equal(report.incremental, false);
  assert.ok(!sameBytes(bytes.subarray(0, original.length), original));
  assert.match(latin(bytes.subarray(0, 8)), /^%PDF-1\.\d/);
});

test('two boxes on two pages share one font object', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA, pages: 2 });
  const [p0, p1] = await readPages(original);
  const a = boxOf(p0, 'a', [0, 1], { edited: true });
  const b = boxOf(p1, 'b', [2], { edited: true });
  const laid = new Map([['a', await laidText(a, NEW)], ['b', await laidText(b, 'Second page, new words.')]]);
  const { bytes, report } = await exportDoc(original, docOf([{ pr: p0, boxes: [a] }, { pr: p1, boxes: [b] }]), laidFrom(laid));
  assert.ok(report.ok, report.failures.join('; '));
  assert.equal(report.fonts.length, 1);
  assert.deepEqual(report.fonts[0].pages, [0, 1]);
  // the font's bytes are counted on the first page that uses it only
  assert.equal(report.pages[0].fontBytes, report.fonts[0].bytes);
  assert.equal(report.pages[1].fontBytes, 0);
  const out = await PDFDocument.load(bytes, { updateMetadata: false });
  const key = report.fonts[0].key;
  const refOn = (i: number) => {
    const res = out.getPage(i).node.Resources()!;
    const fonts = res.lookup(PDFName.of('Font'), PDFDict);
    return fonts.get(PDFName.of(key)) as PDFRef;
  };
  assert.ok(refOn(0) instanceof PDFRef);
  assert.equal(refOn(0).objectNumber, refOn(1).objectNumber);
  // the second page's untouched first paragraph is still there
  const re = await openForEdit(bytes);
  assert.ok(latin(re.contents(1)).includes('(Old paragraph first line.) Tj'));
});

test('a mixed operator is split: the other box keeps its text, position and pixels; when both are edited, both are written', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => 'BT /F1 14 Tf 0.2 0.3 0.6 rg 72 700 Td (Hello World) Tj ET\nBT /F1 12 Tf 72 600 Td (Other line) Tj ET' });
  const [pr] = await readPages(original);
  const left = (edited: boolean) => boxOf(pr, 'hello', [0], { edited, chars: (c) => c.origin[0] < 105 });
  const right = (edited: boolean) => boxOf(pr, 'world', [0], { edited, chars: (c) => c.origin[0] >= 105 });
  assert.equal(left(false).source.paragraphs[0].text.trim(), 'Hello');
  assert.equal(right(false).source.paragraphs[0].text, 'World');

  // only "Hello" edited: the operator is blanked, "World" re-emitted in the appended stream
  const h = left(true);
  const r1 = await exportDoc(original, docOf([{ pr, boxes: [h, right(false)] }]), laidFrom(new Map([['hello', await laidText(h, 'Hi')]])));
  assert.ok(r1.report.ok, r1.report.failures.join('; '));
  const p1 = r1.report.pages[0];
  assert.deepEqual(p1.written.map((w) => w.box), ['hello']);
  assert.deepEqual(p1.skipped, []);
  assert.equal(p1.operatorsSplit, 1);
  assert.deepEqual(p1.written[0].split, [{ obj: 0, operator: 0, kept: 5, dropped: 6 }]);
  assert.equal(p1.verify!.pixelsChangedOutside, 0, 'World renders as before (within the tolerance)');
  assert.deepEqual(p1.verify!.text, [{ box: 'hello', newPresent: true, oldAbsent: true }]);
  const tail = latin(await lastStream(r1.bytes));
  assert.match(tail, /\/F1 14 Tf\n0\.2 0\.3 0\.6 rg\n1 0 0 1 [\d.]+ 700 Tm <57> Tj/, tail); // W in /F1 at its origin, the stream's own rg
  // "World" still extracts, at the same place (poppler's word boxes within 0.5 pt), and with PDFium's characters
  const [after] = await readPages(r1.bytes);
  const before = pr.chars.filter((c) => c.obj === 0 && c.origin[0] >= 105 && !c.generated);
  for (const c of before) {
    const m = after.chars.find((x) => x.unicode === c.unicode && Math.abs(x.origin[0] - c.origin[0]) < 0.01 && Math.abs(x.origin[1] - c.origin[1]) < 0.01);
    assert.ok(m, `"${c.unicode}" at ${c.origin}`);
    assert.ok(Math.abs(m.fontSize - c.fontSize) < 1e-6 && m.fill.join() === c.fill.join());
  }
  if (hasPdftotext) {
    const w0 = pdfWords(original, 'mixed-in.pdf').find((w) => w.word === 'World')!;
    const w1 = pdfWords(r1.bytes, 'mixed-out.pdf').find((w) => w.word === 'World')!;
    assert.ok(w0 && w1, 'World is a word in both');
    for (const k of ['xMin', 'yMin', 'xMax', 'yMax'] as const) assert.ok(Math.abs(w0[k] - w1[k]) <= 0.5, `${k}: ${w0[k]} → ${w1[k]}`);
    const t = pdftotext(r1.bytes, 'mixed-out2.pdf').text;
    assert.ok(/\bHi\b/.test(t) && t.includes('World') && !t.includes('Hello'), t);
  }

  // both edited: one operator blanked, nothing re-emitted, both new texts written
  const h2 = left(true), w2 = right(true);
  const laid = new Map([['hello', await laidText(h2, 'Greetings')], ['world', await laidText(w2, 'Everyone')]]);
  const r2 = await exportDoc(original, docOf([{ pr, boxes: [h2, w2] }]), laidFrom(laid));
  assert.ok(r2.report.ok, r2.report.failures.join('; '));
  assert.deepEqual(r2.report.pages[0].written.map((w) => w.box), ['hello', 'world']);
  assert.equal(r2.report.pages[0].operatorsBlanked, 1);
  assert.equal(r2.report.pages[0].operatorsSplit, 0);
  assert.deepEqual(r2.report.pages[0].verify!.text.map((t) => [t.newPresent, t.oldAbsent]), [[true, true], [true, true]]);
});

test('a tagged page keeps its MCIDs; ActualText and artifacts carry over', { skip: !hasNoto && 'fonts missing' }, async () => {
  const content = [
    '/P <</MCID 0>> BDC BT /F1 14 Tf 72 700 Td (Tagged old text) Tj ET EMC',
    '/Span <</MCID 1 /ActualText (Second tagged)>> BDC BT /F1 12 Tf 72 600 Td (Second tagged) Tj ET EMC',
    '/P <</MCID 2>> BDC BT /F1 12 Tf 72 500 Td (Kept tagged line) Tj ET EMC',
    '/Artifact BMC BT /F1 10 Tf 72 50 Td (Running footer) Tj ET EMC',
  ].join('\n');
  // a minimal structure tree: P → MCID 0, Span → MCID 1, P → MCID 2
  const base = await makePdf({ content: () => content });
  const pdf = await PDFDocument.load(base, { updateMetadata: false });
  const ctx = pdf.context;
  const page = pdf.getPage(0);
  const root = ctx.nextRef();
  const elems = [['P', 0], ['Span', 1], ['P', 2]].map(([s, k]) => ctx.register(ctx.obj({ Type: 'StructElem', S: s, P: root, Pg: page.ref, K: k })));
  ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: elems, ParentTree: ctx.obj({ Nums: [0, elems] }), ParentTreeNextKey: 1 }));
  pdf.catalog.set(PDFName.of('StructTreeRoot'), root);
  pdf.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
  page.node.set(PDFName.of('StructParents'), ctx.obj(0));
  const original = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

  const [pr] = await readPages(original);
  const boxes = [boxOf(pr, 'p', [0], { edited: true }), boxOf(pr, 'span', [1], { edited: true }), boxOf(pr, 'kept', [2]), boxOf(pr, 'footer', [3], { edited: true })];
  const laid = new Map([
    ['p', await laidText(boxes[0], 'Tagged new text')],
    ['span', await laidText(boxes[1], 'Second, rewritten')],
    ['footer', await laidText(boxes[3], 'New footer', { size: 10 })],
  ]);
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes }]), laidFrom(laid));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.tagged, true);
  const w = Object.fromEntries(p.written.map((x) => [x.box, x]));
  assert.deepEqual([w.p.mcid, w.p.tag, w.p.mcidMoved, w.p.actualText], [0, 'P', true, false]);
  assert.deepEqual([w.span.mcid, w.span.tag, w.span.mcidMoved, w.span.actualText], [1, 'Span', true, true]);
  assert.deepEqual([w.footer.mcid, w.footer.artifact], [null, true]);

  const c = latin((await openForEdit(bytes)).contents(0));
  // each MCID occurs exactly once on the page: the original sequences lost theirs, the new text carries it
  for (const k of [0, 1, 2]) assert.equal(countOf(c, `/MCID ${k}`), 1, `MCID ${k} in\n${c}`);
  assert.ok(c.includes('/P BMC BT') && c.includes('/Span BMC BT'), 'the emptied sequences stay balanced');
  const tail = latin(await lastStream(bytes));
  assert.match(tail, /\/P <<\/MCID 0>> BDC\nq\nBT[\s\S]*?ET\nQ\nEMC/);
  const actual = /\/Span <<\/MCID 1 \/ActualText <FEFF([0-9A-F]+)>>> BDC/.exec(tail);
  assert.ok(actual, tail);
  assert.equal(Buffer.from(actual[1], 'hex').swap16().toString('utf16le'), 'Second, rewritten');
  assert.match(tail, /\/Artifact BMC\nq\nBT/);
  // the structure tree is untouched: same object, not rewritten by the update
  const out = await PDFDocument.load(bytes, { updateMetadata: false });
  assert.equal((out.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef).objectNumber, root.objectNumber);
  assert.ok(!latin(bytes.subarray(original.length)).includes('StructTreeRoot'));
});

test('verification catches an export whose old text was not removed', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  // The model points the box at the wrong text object (the untouched line), without character indices: export
  // blanks that object, and the box's own text stays on the page.
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const broken: Box = { ...a, source: { ...a.source, objs: [2], chars: [] } };
  const laid = new Map([['a', await laidText(a, NEW)]]);
  await assert.rejects(exportDoc(original, docOf([{ pr, boxes: [broken] }]), laidFrom(laid)), (e: unknown) => {
    assert.ok(e instanceof ExportError);
    assert.equal(e.report.ok, false);
    assert.ok(e.report.failures.some((f) => /box a: the old text is still on the page/.test(f)), e.report.failures.join('; '));
    return true;
  });
  // verify: 'report' returns the same findings instead of throwing
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [broken] }]), laidFrom(laid), { verify: 'report' });
  assert.equal(report.ok, false);
  assert.deepEqual(report.pages[0].verify!.text, [{ box: 'a', newPresent: true, oldAbsent: false }]);
  assert.equal(report.pages[0].verify!.ok, false);
  // verify: false skips the pass
  const off = await exportDoc(original, docOf([{ pr, boxes: [broken] }]), laidFrom(laid), { verify: false });
  assert.equal(off.report.verified, false);
});

test('verification catches pixels changed outside the edited boxes', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  // new text laid far from the box (over the blue rectangle): it lands outside every region export may change
  const far = await laidText({ ...a, frame: { x0: 72, x1: 300, y0: 395, y1: 425 } }, NEW);
  const misplaced: LaidBox = { ...far, frame: a.frame };
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), () => misplaced, { verify: 'report' });
  assert.equal(report.ok, false);
  assert.ok(report.pages[0].verify!.pixelsChangedOutside > 0);
  assert.ok(report.failures.some((f) => /pixels changed outside/.test(f)), report.failures.join('; '));
});

test('a box in the document\'s Type0 font reports whether the new text could stay in it', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: (f) => `BT /F2 12 Tf 72 700 Td ${f.hex('Type zero stays')} Tj ET\nBT /F2 12 Tf 72 650 Td ${f.hex('Second line')} Tj ET` });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const b = boxOf(pr, 'b', [1], { edited: true });
  const laid = new Map([['a', await laidText(a, 'Tape stays')], ['b', await laidText(b, 'Quixotic')]]);
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [a, b] }]), laidFrom(laid));
  assert.ok(report.ok, report.failures.join('; '));
  const [wa, wb] = report.pages[0].written;
  assert.deepEqual(wa.documentFont.map((d) => [d.resource, d.coverage, d.missing]), [['F2', 'full', 0]]);
  assert.equal(wa.couldStayInDocumentFont, true);
  assert.equal(wb.documentFont[0].coverage, 'partial');
  assert.equal(wb.couldStayInDocumentFont, false);
});

test('skips locked, rotated and unknown-object boxes with reasons', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  const base = boxOf(pr, 'x', [0], { edited: true });
  const boxes: Box[] = [
    { ...base, id: 'locked', locked: 'Type 3 text' },
    { ...base, id: 'rot', rot: 90 },
    { ...base, id: 'ghost', source: { ...base.source, objs: [9] } },
    { ...base, id: 'nolayout' },
  ];
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes }]), (_p, b) => {
    if (b.id === 'nolayout') throw new Error('no layout');
    throw new Error('unexpected');
  });
  assert.deepEqual(report.pages[0].skipped.map((s) => s.box), ['locked', 'rot', 'ghost', 'nolayout']);
  assert.match(report.pages[0].skipped[0].reason, /locked: Type 3 text/);
  assert.match(report.pages[0].skipped[2].reason, /objects 9 do not exist/);
  assert.match(report.pages[0].skipped[3].reason, /layout failed: no layout/);
  assert.ok(sameBytes(bytes, original));
});

test('Japanese and English boxes on one page: one font per face, both verified', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const b = boxOf(pr, 'b', [2], { edited: true });
  const laid = new Map([['a', await laidText(a, NEW)], ['b', await laidText(b, '第3四半期の売上高は増加しました。', { font: 'NotoSansJP:700' })]]);
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [a, b] }]), laidFrom(laid));
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual(report.fonts.map((f) => f.face).sort(), ['NotoSans-Regular', 'NotoSansJP-Bold']);
  assert.deepEqual(report.pages[0].verify!.text.map((t) => t.newPresent), [true, true]);
  assert.equal(report.pages[0].verify!.pixelsChangedOutside, 0);
});

test('a run that carries its shaped face is set in that face (no resolver call)', { skip: !hasNoto && 'fonts missing' }, async () => {
  const original = await makePdf({ content: () => PARA });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const laid = await laidText(a, NEW, { withFace: true });
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), () => laid, {
    faces: () => { throw new Error('the resolver should not be called'); },
  });
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual(report.pages[0].skipped, []);
  assert.equal(report.fonts[0].face, 'NotoSans-Regular');
});
