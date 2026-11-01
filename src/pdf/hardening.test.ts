// Stream-layer tests: the content tree's order against PDFium's, form use counts and copy-on-write, the
// tracked text matrix, font text decoding, the fallback matcher and the cross-reference chain check. Synthetic only.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { openPdfium } from '../engine/pdfium.ts';
import { openForEdit } from './edit.ts';
import { checkXrefChain, readTail } from './incremental.ts';
import { matchObjects, type ObjectKey, type SiteKey } from './match.ts';
import { apply, mul, parseOps, textShows } from './ops.ts';
import { fontDecoder } from './textdecode.ts';
import { commitForms, contentTree, fontDictIn, formUses, refKey } from './tree.ts';
import { hasNoto, latin1, makePdf, text } from './testing.ts';

async function formPdf(pages: string[], forms: Record<string, { content: string; matrix?: number[]; uses?: string[] }>): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const refs = Object.fromEntries(Object.keys(forms).map((n) => [n, ctx.nextRef()]));
  for (const [n, f] of Object.entries(forms)) {
    const xo = Object.fromEntries((f.uses ?? []).map((u) => [u, refs[u]]));
    ctx.assign(refs[n], ctx.flateStream(f.content, {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 600, 800], Matrix: f.matrix ?? [1, 0, 0, 1, 0, 0],
      Resources: ctx.obj({ Font: { F1: helv.ref }, ...(f.uses?.length ? { XObject: xo } : {}) }),
    }));
  }
  for (const c of pages) {
    const page = doc.addPage([600, 800]);
    page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: refs }));
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(c)));
  }
  return doc.save({ useObjectStreams: false });
}

const FORMS = {
  A: { content: 'BT /F1 10 Tf 10 10 Td (a1) Tj ET /B Do BT /F1 10 Tf 10 30 Td (a2) Tj ET', matrix: [2, 0, 0, 2, 5, 5], uses: ['B'] },
  B: { content: 'BT /F1 10 Tf 40 40 Td (b1) Tj (b2) Tj ET' },
  C: { content: 'BT /F1 10 Tf 0 0 Td (c1) Tj ET' },
};

test('contentTree flattens forms in PDFium\'s order; the tracked matrices give PDFium\'s positions', async () => {
  const bytes = await formPdf(['BT /F1 12 Tf 72 700 Td (p1) Tj ET q 1 0 0 1 100 200 cm /A Do Q BT /F1 12 Tf 72 650 Td (p2) Tj ET /C Do /B Do'], FORMS);
  const e = await openForEdit(bytes);
  const tree = contentTree(e, 0);
  const P = await openPdfium();
  const d = P.open(bytes);
  const pg = d.page(0);
  const chars = pg.chars();
  const objs = pg.textObjects();
  pg.close();
  d.close();
  assert.deepEqual(tree.sites.map((s) => text(s.show.strings[0])), objs.map((o) => o.text));
  assert.deepEqual(tree.sites.map((s) => s.node.depth > 0), objs.map((o) => o.inForm));
  assert.deepEqual(tree.nodes.map((n) => [n.depth, n.call?.name ?? null]), [[0, null], [1, 'A'], [2, 'B'], [1, 'C'], [1, 'B']]);
  tree.sites.forEach((s, i) => {
    const local = mul(s.show.tm, s.show.ctm);
    const pagePos = apply(mul(local, s.node.toPage), 0, s.show.rise);
    const origin = chars[objs[i].chars[0]].origin;
    assert.ok(Math.hypot(pagePos[0] - origin[0], pagePos[1] - origin[1]) < 0.01, `${objs[i].text}: ${pagePos} vs ${origin}`);
    assert.ok(s.show.tmExact);
  });
  // (b2) Tj follows (b1) Tj on the same line: its start is past b1's advance (Helvetica widths)
  const b2 = tree.sites.find((s) => text(s.show.strings[0]) === 'b2')!;
  assert.ok(Math.abs(b2.show.tm[4] - (40 + ((556 + 556) / 1000) * 10)) < 1e-9);
});

test('formUses counts paints across pages and nesting; commitForms copies shared forms and edits single ones in place', async () => {
  const bytes = await formPdf(['/A Do /C Do', '/A Do'], FORMS);
  const e = await openForEdit(bytes);
  const uses = formUses(e);
  const tree = contentTree(e, 0);
  const [, nA, nB, nC] = tree.nodes;
  assert.deepEqual([uses.get(refKey(nA.ref!)), uses.get(refKey(nB.ref!)), uses.get(refKey(nC.ref!))], [2, 2, 1]);
  const b1 = nB.shows[0], c1 = nC.shows[0];
  const r = commitForms(e, new Map([[nB, [b1]], [nC, [c1]]]), uses);
  assert.deepEqual(r.edited, [refKey(nC.ref!)]);
  assert.equal(r.copied.length, 2); // B, then A because it must paint B's copy
  assert.deepEqual(r.pageRenames.map((x) => [x.call.name, x.name]), [['A', 'A_pe1']]);
  const out = await openForEdit(e.save());
  // page 2 still paints the original A and B, untouched
  const t2 = contentTree(out, 1);
  assert.deepEqual(t2.sites.map((s) => text(s.show.strings[0])), ['a1', 'b1', 'b2', 'a2']);
});

test('textShows tracks Tm, Td, TD, T*, \' and " and the CTM; advances need widths', () => {
  const ops = parseOps(latin1('q 2 0 0 2 10 20 cm BT /F1 10 Tf 12 TL 1 0 0 1 50 60 Tm (a) Tj (b) Tj T* (c) Tj 5 -6 TD (d) \' 1 2 (e) " ET Q BT (f) Tj ET'));
  const width = (c: number) => (c === 0x61 ? 500 : 600);
  const shows = textShows(ops, { fonts: () => ({ type: 'Type1', baseFont: 'X', codeBytes: 1, vertical: false, width }) });
  const pos = shows.map((s) => [s.tm[4], s.tm[5]]);
  assert.deepEqual(pos, [[50, 60], [55, 60], [50, 48], [55, 36], [55, 30], [0, 0]]); // TD sets TL 6; ' and " move by it first
  assert.deepEqual(shows[0].ctm, [2, 0, 0, 2, 10, 20]);
  assert.deepEqual(shows[5].ctm, [1, 0, 0, 1, 0, 0]);
  const blind = textShows(ops);
  assert.deepEqual([blind[1].tmExact, blind[2].tmExact], [false, true]);
});

test('fontDecoder: ToUnicode for Type0, the encoding for simple fonts', { skip: !hasNoto && 'fonts missing' }, async () => {
  const bytes = await makePdf({ content: (f) => `BT /F2 12 Tf 72 700 Td ${f.hex('Héllo ﬁ')} Tj /F1 12 Tf (Caf\\351) Tj ET` });
  const e = await openForEdit(bytes);
  const tree = contentTree(e, 0);
  const [s2, s1] = tree.sites;
  const d2 = fontDecoder(e.context, fontDictIn(e.context, tree.root.resources, 'F2'));
  const d1 = fontDecoder(e.context, fontDictIn(e.context, tree.root.resources, 'F1'));
  assert.equal(d2.source, 'ToUnicode');
  assert.equal(d1.source, 'encoding');
  assert.equal(d2.text(s2.show.strings)?.normalize('NFKC'), 'Héllo fi');
  assert.equal(d1.text(s1.show.strings), 'Café');
});

test('matchObjects: skipped operators, dropped objects, same text at other positions, disagreeing text', () => {
  const site = (text: string | null, x: number, y: number, exact = true): SiteKey => ({ inForm: false, text, baseFont: 'Helvetica', objPos: [x, y], pagePos: [x, y], exact });
  const obj = (text: string, x: number, y: number): ObjectKey => ({ inForm: false, text, fontName: 'Helvetica', matrix: [1, 0, 0, 1, x, y], origin: [x, y], size: 12 });
  const sites = [site(null, 72, 720), site('Clip', 72, 700), site('Target', 72, 650), site('Same', 72, 600), site('Same', 300, 600)];
  // PDFium skipped the font-less operator and (in another build) the clip text
  assert.deepEqual(matchObjects([obj('Target', 72, 650), obj('Same', 300, 600)], sites).site, [2, 4]);
  // PDFium's own trailing character is ignored
  assert.deepEqual(matchObjects([obj('Clip ', 72, 700)], sites).site, [1]);
  // a position that is not exact: the text decides
  assert.deepEqual(matchObjects([obj('Target', 80, 650)], [site('Target', 0, 0, false)]).site, [0]);
  // text that disagrees at the right position is not a match; an unknown text at the right position is
  const m = matchObjects([obj('Other', 72, 650), obj('Ghost', 72, 720)], sites);
  assert.deepEqual(m.site, [null, 0]);
  assert.deepEqual(m.unmatched, [0]);
  // a font that disagrees is not a match
  assert.deepEqual(matchObjects([{ ...obj('Target', 72, 650), fontName: 'ABCDEF+Times-Roman' }], sites).site, [null]);
});

test('readTail and checkXrefChain: sound files, a startxref off its table, wrong offsets, a /Prev into nowhere', async () => {
  const good = await makePdf({ content: () => 'BT /F1 12 Tf 72 700 Td (x) Tj ET', type0: false });
  assert.equal(readTail(good).broken, null);
  const streams = await makePdf({ content: () => 'BT ET', type0: false, objectStreams: true });
  assert.equal(readTail(streams).kind, 'stream');
  assert.equal(readTail(streams).broken, null);
  const s = Buffer.from(good).toString('latin1');
  const at = readTail(good).startxref;
  const off = new Uint8Array(Buffer.from(s.replace(/startxref\s+\d+/, `startxref\n${at + 5}`), 'latin1'));
  assert.match(readTail(off).broken!, /does not point at a cross-reference section/);
  const past = new Uint8Array(Buffer.from(s.replace(/startxref\s+\d+/, 'startxref\n999999'), 'latin1'));
  assert.match(readTail(past).broken!, /lies outside the file/);
  const prev = new Uint8Array(Buffer.from(s.replace('trailer\n<<', 'trailer\n<< /Prev 5'), 'latin1'));
  assert.match(checkXrefChain(prev, at) ?? '', /cross-reference|not there|no trailer/);
});
