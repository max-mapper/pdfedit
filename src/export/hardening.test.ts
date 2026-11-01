// Hardening tests for exportDoc, on synthetic PDFs only: flattened text-object indices, text inside Form XObjects
// (in place, copied for one use, nested), mixed operators split in a Type0 font and inside a form, pages that do not
// map one to one, encrypted input (owner password only) and broken cross-reference tables. Synthetic material only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPdfium } from '../engine/pdfium.ts';
import { diffOutside } from '../engine/diff.ts';
import { openForEdit } from '../pdf/edit.ts';
import { readTail } from '../pdf/incremental.ts';
import { hasNoto, hasPdftotext, makePdf, pdftotext, pdfWords } from '../pdf/testing.ts';
import { contentTree } from '../pdf/tree.ts';
import { ExportError, exportDoc } from './export.ts';
import { boxOf, breakStartxref, docOf, encryptWithPdfium, laidText, latin, makeFormPdf, readPages, type PageRead } from './testkit.ts';
import type { Box, LaidBox } from '../model/types.ts';

const skip = !hasNoto && 'fonts missing';

function laidFrom(m: Map<string, LaidBox>) {
  return (_page: number, box: Box) => {
    const l = m.get(box.id);
    if (!l) throw new Error(`no layout for ${box.id}`);
    return l;
  };
}

/** Every stream of the page's content tree (page first, then forms in painting order), decoded, as Latin-1. */
async function treeTexts(bytes: Uint8Array, page = 0): Promise<string[]> {
  const e = await openForEdit(bytes);
  return contentTree(e, page).nodes.map((n) => latin(n.contents));
}

/** Pixels that differ between two files' renders of one page (no regions excluded). */
async function pagePixelsDiffer(a: Uint8Array, b: Uint8Array, page: number): Promise<number> {
  const P = await openPdfium();
  const da = P.open(a), db = P.open(b);
  try {
    const pa = da.page(page), pb = db.page(page);
    const d = diffOutside(pa.render(1.5), pb.render(1.5), [], 1.5, pa.size.h);
    pa.close(); pb.close();
    return d.differing;
  } finally { da.close(); db.close(); }
}

const pageText = (pr: PageRead) => pr.chars.map((c) => c.unicode).join('');

// ---------------------------------------------------------------------------------------------------------------
// Flattened indices and Form XObjects

test('a form painted before ordinary text: source objects are textObjects() indices, forms counted', { skip }, async () => {
  const original = await makeFormPdf(
    ['q /Fx Do Q\nBT /F1 14 Tf 72 700 Td (Plain old text) Tj ET\nBT /F1 12 Tf 72 500 Td (Untouched line) Tj ET'],
    { Fx: { content: 'BT /F1 12 Tf 72 300 Td (Form text stays) Tj ET' } },
  );
  const [pr] = await readPages(original);
  assert.deepEqual(pr.objs.map((o) => [o.text, o.inForm, o.topIndex]), [['Form text stays', true, null], ['Plain old text', false, 0], ['Untouched line', false, 1]]);
  const a = boxOf(pr, 'a', [1], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a, boxOf(pr, 'b', [2]), boxOf(pr, 'f', [0])] }]), laidFrom(new Map([['a', await laidText(a, 'Plain new text')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.matching, 'one-to-one');
  assert.deepEqual(p.written.map((w) => [w.box, w.objs, w.inForm]), [['a', [1], 0]]);
  assert.deepEqual(p.formsEdited, []);
  const [after] = await readPages(bytes);
  const t = pageText(after);
  assert.ok(t.includes('Form text stays') && t.includes('Untouched line') && t.includes('Plain new text') && !t.includes('Plain old text'), t);
});

test('text inside a form: removed in the form\'s own stream (painted once: in place), new text in page space', { skip }, async () => {
  const original = await makeFormPdf(
    ['q 1 0 0 1 10 -20 cm /Fx Do Q\nBT /F1 12 Tf 72 300 Td (Page text) Tj ET'],
    { Fx: { matrix: [1, 0, 0, 1, 10, 20], content: 'BT /F1 14 Tf 52 680 Td (Inside the form) Tj ET\nBT /F1 12 Tf 52 480 Td (Form neighbour) Tj ET' } },
  );
  const [pr] = await readPages(original);
  assert.equal(pr.objs[0].text, 'Inside the form');
  const old = pr.chars[pr.objs[0].chars[0]];
  assert.ok(Math.abs(old.origin[0] - 72) < 0.01 && Math.abs(old.origin[1] - 680) < 0.01, `form text at ${old.origin} in page space`);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), laidFrom(new Map([['a', await laidText(a, 'Rewritten words')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.deepEqual(p.written.map((w) => [w.objs, w.inForm]), [[[0], 1]]);
  assert.equal(p.formsEdited.length, 1);
  assert.deepEqual(p.formsCopied, []);
  assert.equal(p.verify!.pixelsChangedOutside, 0);
  // the form's stream lost the edited text and kept its neighbour; the page's own stream was not rewritten
  const [pageS, formS] = await treeTexts(bytes);
  assert.ok(!formS.includes('Inside the form') && formS.includes('(Form neighbour) Tj'), formS);
  assert.ok(pageS.includes('/Fx Do') && pageS.includes('(Page text) Tj'));
  // the new text sits where the old did, in page space
  const [after] = await readPages(bytes);
  const r = after.chars.find((c) => c.unicode === 'R')!;
  assert.ok(Math.abs(r.origin[0] - a.frame.x0) < 2 && r.origin[1] > a.frame.y0 - 4 && r.origin[1] < a.frame.y1, `R at ${r.origin}, frame ${JSON.stringify(a.frame)}`);
  if (hasPdftotext) {
    const t = pdftotext(bytes, 'form-inplace.pdf').text;
    assert.ok(t.includes('Rewritten words') && t.includes('Form neighbour') && !t.includes('Inside the form'), t);
  }
});

test('a form painted on two pages: copied for the edited page; the other page keeps its text and pixels', { skip }, async () => {
  const original = await makeFormPdf(
    ['/Fx Do BT /F1 12 Tf 72 500 Td (Page one body) Tj ET', '/Fx Do BT /F1 12 Tf 72 500 Td (Page two body) Tj ET'],
    { Fx: { content: 'BT /F1 14 Tf 72 700 Td (Shared header) Tj ET' } },
  );
  const [p0, p1] = await readPages(original);
  const a = boxOf(p0, 'a', [0], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr: p0, boxes: [a] }, { pr: p1, boxes: [boxOf(p1, 'b', [0])] }]), laidFrom(new Map([['a', await laidText(a, 'New header')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.formsCopied.length, 1);
  assert.deepEqual(p.formsEdited, []);
  const [after0, after1] = await readPages(bytes);
  assert.ok(pageText(after0).includes('New header') && !pageText(after0).includes('Shared header'));
  assert.ok(pageText(after1).includes('Shared header') && pageText(after1).includes('Page two body'));
  assert.equal(await pagePixelsDiffer(original, bytes, 1), 0, 'page 2 renders exactly as before');
  // page 1 paints the copy under a new name; page 2 still paints the original object
  const [s0, f0] = await treeTexts(bytes, 0);
  const [s1, f1] = await treeTexts(bytes, 1);
  assert.match(s0, /\/Fx_pe1 Do/);
  assert.match(s1, /\/Fx Do/);
  assert.ok(!f0.includes('Shared header') && f1.includes('(Shared header) Tj'));
  assert.ok(Buffer.from(bytes.subarray(0, original.length)).equals(Buffer.from(original)), 'incremental');
});

test('a form painted twice on one page: only the edited use loses its text', { skip }, async () => {
  const original = await makeFormPdf(
    ['q /Fx Do Q\nq 1 0 0 1 0 -300 cm /Fx Do Q'],
    { Fx: { content: 'BT /F1 14 Tf 72 700 Td (Twice shown) Tj ET' } },
  );
  const [pr] = await readPages(original);
  assert.deepEqual(pr.objs.map((o) => [o.text.trim(), o.inForm]), [['Twice shown', true], ['Twice shown', true]]);
  const a = boxOf(pr, 'a', [1], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a, boxOf(pr, 'b', [0])] }]), laidFrom(new Map([['a', await laidText(a, 'Second use')]])));
  assert.ok(report.ok, report.failures.join('; '));
  assert.equal(report.pages[0].formsCopied.length, 1);
  const [after] = await readPages(bytes);
  const t = pageText(after);
  assert.equal(t.split('Twice shown').length - 1, 1, t);
  assert.ok(t.includes('Second use'));
  const top = after.chars.find((c) => c.unicode === 'T')!;
  assert.ok(Math.abs(top.origin[1] - 700) < 0.01, 'the first use (at y 700) kept its text');
});

test('nested forms: the inner text is removed through copies of both forms when the outer one is shared; in place when not', { skip }, async () => {
  const forms = {
    Inner: { content: 'BT /F1 12 Tf 72 650 Td (Nested inner text) Tj ET' },
    Outer: { content: 'BT /F1 12 Tf 72 700 Td (Outer text) Tj ET\n/Inner Do', uses: ['Inner'] },
  };
  const shared = await makeFormPdf(['/Outer Do', '/Outer Do BT /F1 12 Tf 72 300 Td (Second page) Tj ET'], forms);
  const [p0, p1] = await readPages(shared);
  assert.deepEqual(p0.objs.map((o) => [o.text, o.inForm]), [['Outer text', true], ['Nested inner text', true]]);
  const a = boxOf(p0, 'a', [1], { edited: true });
  const laid = new Map([['a', await laidText(a, 'Inner rewritten')]]);
  const r1 = await exportDoc(shared, docOf([{ pr: p0, boxes: [a, boxOf(p0, 'o', [0])] }, { pr: p1, boxes: [] }]), laidFrom(laid));
  assert.ok(r1.report.ok, r1.report.failures.join('; '));
  assert.equal(r1.report.pages[0].formsCopied.length, 2, 'inner and outer copied');
  const [after0, after1] = await readPages(r1.bytes);
  assert.ok(pageText(after0).includes('Outer text') && pageText(after0).includes('Inner rewritten') && !pageText(after0).includes('Nested inner text'));
  assert.ok(pageText(after1).includes('Nested inner text'));
  assert.equal(await pagePixelsDiffer(shared, r1.bytes, 1), 0);
  const [, outerCopy, innerCopy] = await treeTexts(r1.bytes, 0);
  assert.match(outerCopy, /\/Inner_pe1 Do/);
  assert.ok(!innerCopy.includes('Nested inner text'));

  // one page: the inner form is painted once in the document, so it is changed in place and the outer is untouched
  const single = await makeFormPdf(['/Outer Do'], forms);
  const [q0] = await readPages(single);
  const b = boxOf(q0, 'a', [1], { edited: true });
  const r2 = await exportDoc(single, docOf([{ pr: q0, boxes: [b] }]), laidFrom(new Map([['a', await laidText(b, 'Inner rewritten')]])));
  assert.ok(r2.report.ok, r2.report.failures.join('; '));
  assert.equal(r2.report.pages[0].formsEdited.length, 1);
  assert.deepEqual(r2.report.pages[0].formsCopied, []);
  const [, outer, inner] = await treeTexts(r2.bytes, 0);
  assert.match(outer, /\/Inner Do/);
  assert.ok(!inner.includes('Nested inner text'));
});

// ---------------------------------------------------------------------------------------------------------------
// Mixed operators

test('a mixed operator in a Type0 font: 2-byte codes from the original string, ToUnicode still maps them', { skip }, async () => {
  const original = await makePdf({ content: (f) => `BT /F2 16 Tf 0 0.5 0 rg 72 700 Td ${f.hex('Alpha Beta')} Tj ET\nBT /F1 12 Tf 72 600 Td (Below) Tj ET` });
  const [pr] = await readPages(original);
  const xBeta = pr.chars.find((c) => c.unicode === 'B' && c.obj === 0)!.origin[0];
  const a = boxOf(pr, 'alpha', [0], { edited: true, chars: (c) => c.origin[0] < xBeta - 1 });
  const b = boxOf(pr, 'beta', [0], { chars: (c) => c.origin[0] >= xBeta - 1 });
  assert.equal(b.source.paragraphs[0].text, 'Beta');
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a, b] }]), laidFrom(new Map([['alpha', await laidText(a, 'Ok')]])));
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual(report.pages[0].written[0].split.map((s) => [s.kept, s.dropped]), [[4, 6]]);
  assert.equal(report.pages[0].verify!.pixelsChangedOutside, 0);
  const [after] = await readPages(bytes);
  for (const c of pr.chars.filter((x) => x.obj === 0 && x.origin[0] >= xBeta - 1 && !x.generated)) {
    assert.ok(after.chars.some((x) => x.unicode === c.unicode && Math.hypot(x.origin[0] - c.origin[0], x.origin[1] - c.origin[1]) < 0.01), `${c.unicode} kept`);
  }
  if (hasPdftotext) {
    const w0 = pdfWords(original, 't0-in.pdf').find((w) => w.word === 'Beta')!;
    const w1 = pdfWords(bytes, 't0-out.pdf').find((w) => w.word === 'Beta')!;
    for (const k of ['xMin', 'yMin', 'xMax', 'yMax'] as const) assert.ok(Math.abs(w0[k] - w1[k]) <= 0.5, `${k}: ${w0[k]} → ${w1[k]}`);
  }
});

test('a mixed operator inside a form: the other characters are re-emitted in page space under an alias of the form\'s font', { skip }, async () => {
  const original = await makeFormPdf(
    ['q 1 0 0 1 30 -40 cm /Fx Do Q'],
    { Fx: { matrix: [1, 0, 0, 1, 0, 0], content: 'BT /F1 14 Tf 2 Tc 90 Tz 72 700 Td [(Left) -500 (Right)] TJ ET' } },
  );
  const [pr] = await readPages(original);
  const xR = pr.chars.find((c) => c.unicode === 'R')!.origin[0];
  const a = boxOf(pr, 'left', [0], { edited: true, chars: (c) => c.origin[0] < xR - 1 });
  const b = boxOf(pr, 'right', [0], { chars: (c) => c.origin[0] >= xR - 1 });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a, b] }]), laidFrom(new Map([['left', await laidText(a, 'Up')]])));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.operatorsSplit, 1);
  assert.equal(p.formsEdited.length, 1);
  assert.equal(p.verify!.pixelsChangedOutside, 0);
  const [after] = await readPages(bytes);
  for (const c of pr.chars.filter((x) => x.origin[0] >= xR - 1 && !x.generated)) {
    const m = after.chars.find((x) => x.unicode === c.unicode && Math.hypot(x.origin[0] - c.origin[0], x.origin[1] - c.origin[1]) < 0.01);
    assert.ok(m, `${c.unicode} at ${c.origin}`);
  }
  if (hasPdftotext) {
    const w0 = pdfWords(original, 'mf-in.pdf').find((w) => w.word === 'Right')!;
    const w1 = pdfWords(bytes, 'mf-out.pdf').find((w) => w.word === 'Right')!;
    for (const k of ['xMin', 'yMin', 'xMax', 'yMax'] as const) assert.ok(Math.abs(w0[k] - w1[k]) <= 0.5, `${k}: ${w0[k]} → ${w1[k]}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Pages that do not map one to one

test('counts differ (an empty Tj, a Tj with no font, a clipping-only block): fallback matching by text and position', { skip }, async () => {
  const content = [
    'BT 72 720 Td (Ghost) Tj ET', // before any Tf (the font persists across BT): PDFium makes no object, we count it
    'BT /F1 12 Tf 72 740 Td () Tj ET', // empty: neither PDFium nor the operator count has it
    'q BT /F1 12 Tf 7 Tr 72 700 Td (Clip) Tj ET Q', // a clipping-only text block
    'BT /F1 14 Tf 72 650 Td (Target old text) Tj ET',
    'BT /F1 12 Tf 72 600 Td (Untouched after) Tj ET',
  ].join('\n');
  const original = await makePdf({ content: () => content });
  const [pr] = await readPages(original);
  assert.deepEqual(pr.objs.map((o) => o.text), ['Clip', 'Target old text', 'Untouched after']);
  const target = boxOf(pr, 't', [1], { edited: true });
  const clip = boxOf(pr, 'c', [0], { edited: true });
  const laid = new Map([['t', await laidText(target, 'Target new text')], ['c', await laidText(clip, 'No')]]);
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [clip, target, boxOf(pr, 'u', [2])] }]), laidFrom(laid));
  assert.ok(report.ok, report.failures.join('; '));
  const p = report.pages[0];
  assert.equal(p.matching, 'fallback');
  assert.deepEqual([p.textObjects, p.operators, p.unmatched], [3, 4, 0]);
  assert.deepEqual(p.written.map((w) => [w.box, w.operators]), [['t', [3]]]); // operator #3 (0: Ghost, 1: (), 2: Clip)
  assert.deepEqual(p.skipped.map((s) => s.box), ['c']);
  assert.match(p.skipped[0].reason, /clipping mode \(7 Tr\)/);
  const c = latin((await openForEdit(bytes)).contents(0));
  assert.ok(c.includes('(Ghost) Tj') && c.includes('(Clip) Tj') && c.includes('(Untouched after) Tj') && !c.includes('Target old'), c);
});

// ---------------------------------------------------------------------------------------------------------------
// Verification

test('verification reads a box\'s new text inside its frame when the page\'s reading order interleaves it', { skip }, async () => {
  // two columns on the same baselines: PDFium reads "left1 right1 left2 right2"
  const original = await makePdf({ content: () => [
    'BT /F1 12 Tf 72 700 Td (Old left one) Tj 0 -16 Td (Old left two) Tj ET',
    'BT /F1 12 Tf 300 700 Td (Right column one) Tj 0 -16 Td (Right column two) Tj ET',
  ].join('\n') });
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0, 1], { edited: true });
  const l = await laidText({ ...a, frame: { ...a.frame, x1: a.frame.x0 + 120 } }, 'Alpha words here and then more beta words', { size: 12 });
  assert.ok(l.lines.length >= 2);
  const { report } = await exportDoc(original, docOf([{ pr, boxes: [a, boxOf(pr, 'b', [2, 3])] }]), () => l);
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual(report.pages[0].verify!.text, [{ box: 'a', newPresent: true, oldAbsent: true }]);
});

// ---------------------------------------------------------------------------------------------------------------
// Encrypted and broken input

test('an encrypted document (owner password only) is edited as PDFium\'s decrypted copy; the output is not encrypted', { skip }, async () => {
  const plain = await makePdf({ content: () => 'BT /F1 14 Tf 72 700 Td (Secret old text) Tj ET\nBT /F1 12 Tf 72 500 Td (Other) Tj ET' });
  const original = await encryptWithPdfium(plain, 'owner-secret');
  const P = await openPdfium();
  const sec = P.security(original);
  assert.equal(sec.encrypted, true);
  assert.equal(sec.needsPassword, false);
  await assert.rejects(openForEdit(original), /encrypted/, 'the stream layer alone refuses it');
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), laidFrom(new Map([['a', await laidText(a, 'Open new text')]])));
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual([report.decrypted, report.encrypted, report.repaired, report.incremental], [true, false, false, false]);
  assert.ok(report.notes.some((n) => /decrypted copy/.test(n) && /not encrypted/.test(n)), report.notes.join('; '));
  assert.equal(P.security(bytes).encrypted, false);
  assert.equal(report.pages[0].verify!.pixelsChangedOutside, 0);
  if (hasPdftotext) {
    const t = pdftotext(bytes, 'decrypted.pdf').text;
    assert.ok(t.includes('Open new text') && t.includes('Other') && !t.includes('Secret old'), t);
  }
});

test('a document that needs a user password is refused with the reason', { skip }, async () => {
  const plain = await makePdf({ content: () => 'BT /F1 14 Tf 72 700 Td (Locked) Tj ET' });
  const original = await encryptWithPdfium(plain, 'owner', 'user');
  const P = await openPdfium();
  assert.equal(P.security(original).needsPassword, true);
  assert.throws(() => P.decryptCopy(original), /user password/);
  // the model would come from elsewhere (PDFium cannot read the page without the password): any edited box will do
  const box = { ...boxOf(await readPages(plain).then((r) => r[0]), 'a', [0], { edited: true }) };
  await assert.rejects(exportDoc(original, docOf([{ pr: (await readPages(plain))[0], boxes: [box] }]), () => { throw new Error('no layout'); }), (e: unknown) => {
    assert.ok(e instanceof ExportError);
    assert.equal(e.report.ok, false);
    assert.match(e.report.failures[0], /^refused: the document is encrypted with a user password/);
    return true;
  });
});

test('a broken startxref: edited as PDFium\'s repaired copy with a full save', { skip }, async () => {
  const good = await makePdf({ content: () => 'BT /F1 14 Tf 72 700 Td (Repair old text) Tj ET\nBT /F1 12 Tf 72 500 Td (Kept) Tj ET' });
  const original = breakStartxref(good);
  assert.match(readTail(original).broken ?? '', /does not point at a cross-reference section/);
  const [pr] = await readPages(original);
  const a = boxOf(pr, 'a', [0], { edited: true });
  const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), laidFrom(new Map([['a', await laidText(a, 'Repaired new text')]])));
  assert.ok(report.ok, report.failures.join('; '));
  assert.deepEqual([report.repaired, report.decrypted, report.incremental], [true, false, false]);
  assert.ok(report.notes.some((n) => /repaired copy/.test(n)), report.notes.join('; '));
  const tail = readTail(bytes);
  assert.equal(tail.broken, null, 'the output\'s cross-reference table is sound');
  if (hasPdftotext) {
    const { text, stderr } = pdftotext(bytes, 'repaired.pdf');
    assert.equal(stderr.trim(), '', 'poppler needs no repair');
    const flat = text.replace(/\s+/g, ' ');
    assert.ok(flat.includes('Repaired new text') && flat.includes('Kept'), text);
  }

  // offsets in the table that do not point at their objects count as broken too
  const s = Buffer.from(good).toString('latin1');
  const garbled = new Uint8Array(Buffer.from(s.replace(/(\d{10}) 00000 n/g, (m, off, i) => (i > s.lastIndexOf('\nxref') ? `${String(Number(off) + 3).padStart(10, '0')} 00000 n` : m)), 'latin1'));
  assert.match(readTail(garbled).broken ?? '', /says object \d+ is at \d+, but it is not there/);
  const r2 = await exportDoc(garbled, docOf([{ pr, boxes: [a] }]), laidFrom(new Map([['a', await laidText(a, 'Repaired new text')]])));
  assert.ok(r2.report.ok && r2.report.repaired, r2.report.failures.join('; '));
});
