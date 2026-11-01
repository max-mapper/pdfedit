// Typography switches of layoutParagraphs: first-line and hanging indents, list markers, hyphenation (with the
// hyphen read back from a PDF), the justify policy, line balancing and widow avoidance. Synthetic text only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName } from 'pdf-lib';
import { layoutParagraphs } from './layout.ts';
import type { Layout, Line, ParaIn } from './layout.ts';
import { hyphenPoints } from './hyphenate.ts';
import { FontWriter } from './font-writer.ts';
import { emit, useLayout } from './emit.ts';
import { testFaces } from './testkit.ts';
import type { Faces } from './testkit.ts';
import { openPdfium } from '../engine/pdfium.ts';

let F: Faces;
before(async () => { F = await testFaces(); });

const lineText = (l: Line) => l.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('');
const firstX = (l: Line, run = 0) => l.runs[run].glyphs[0].x;
const inkEnd = (l: Line) => {
  const r = l.runs[l.runs.length - 1], g = r.glyphs[r.glyphs.length - 1];
  return g.x + (r.face.advance(g.gid) * r.size) / r.face.upem;
};
const lay = (text: string, width: number, p: Partial<ParaIn> = {}, size = 10): Layout =>
  layoutParagraphs([{ runs: [{ text, face: F.sans, size }], ...p }], { width });
const natural = (text: string, size = 10) => lay(text, 1e6, {}, size).lines[0].width;

const EN = 'The third quarter results show steady growth across every region. Revenue rose twelve percent ' +
  'compared with the same period last year, and the outlook for the coming months remains positive.';

test('a first-line indent and a hanging indent are laid out', () => {
  const ind = lay(EN, 200, { indent: 20 });
  assert.ok(ind.lines.length >= 3);
  assert.ok(Math.abs(firstX(ind.lines[0]) - 20) < 0.5, `first line at ${firstX(ind.lines[0])}`);
  for (const l of ind.lines.slice(1)) assert.ok(firstX(l) < 0.5, `other lines at the left edge: ${firstX(l)}`);
  for (const l of ind.lines) assert.ok(inkEnd(l) <= 200 + 0.01, 'every line inside the measure');
  const hang = lay(EN, 200, { indent: -15 });
  assert.ok(firstX(hang.lines[0]) < 0.5);
  for (const l of hang.lines.slice(1)) assert.ok(Math.abs(firstX(l) - 15) < 0.5, `hanging at ${firstX(l)}`);
});

test('a marker is drawn in its own style; the text hangs at the marker indent', () => {
  const L = lay(EN, 220, { marker: { run: { text: '•', face: F.sans, size: 12, color: [0.1, 0.3, 0.8] }, indent: 14 } });
  const [m, body] = L.lines[0].runs;
  assert.equal(m.glyphs.map((g) => g.text).join(''), '•');
  assert.deepEqual(m.color, [0.1, 0.3, 0.8]);
  assert.equal(m.size, 12);
  assert.ok(Math.abs(firstX(L.lines[0], 0)) < 0.5, 'the marker at the left edge');
  assert.ok(Math.abs(body.glyphs[0].x - 14) < 0.5, `text at ${body.glyphs[0].x}`);
  for (const l of L.lines.slice(1)) {
    assert.equal(l.runs.length, 1, 'no marker on continuation lines');
    assert.ok(Math.abs(firstX(l) - 14) < 0.5, `continuation at ${firstX(l)}`);
  }
  assert.equal(L.lines.map(lineText).join(' ').replace(/^•/, ''), EN);
});

test('hyphenation points: en-us patterns, 3+ characters a side, none in capitalised words or words with digits', () => {
  const pts = hyphenPoints('representatives');
  assert.ok(pts.length >= 2, JSON.stringify(pts));
  for (const p of pts) assert.ok(p >= 3 && 'representatives'.length - p >= 3);
  assert.deepEqual(hyphenPoints('Representatives'), []);
  assert.deepEqual(hyphenPoints('covid19cases'), []);
  assert.deepEqual(hyphenPoints('table'), []);
});

test('a long word at a line end is hyphenated at a pattern point; capitalised words never are', () => {
  const word = 'representatives';
  const pts = hyphenPoints(word);
  const p = pts[pts.length - 2];       // room for this point but not the next
  const W = natural(`we met the ${word.slice(0, p)}-`) + 0.5;
  assert.ok(natural(`we met the ${word.slice(0, pts[pts.length - 1])}-`) > W);
  const text = `we met the ${word} yesterday`;
  const L = lay(text, W, { hyphenate: true });
  assert.equal(lineText(L.lines[0]), `we met the ${word.slice(0, p)}-`);
  assert.equal(L.lines[0].hyphen, true);
  assert.equal(L.paras![0].hyphenated, 1);
  assert.ok(inkEnd(L.lines[0]) <= W + 0.01);
  assert.equal(L.lines.map(lineText).join('\n').replace('-\n', '').replace(/\n/g, ' '), text, 'nothing lost');
  // off by default, and never in a capitalised word
  assert.equal(lineText(lay(text, W).lines[0]), 'we met the');
  assert.equal(lineText(lay(`we met the Representatives yesterday`, W, { hyphenate: true }).lines[0]), 'we met the');
});

test('never more than two hyphenated lines in a row', () => {
  const words = 'characteristically uncharacteristically representatives internationalization incomprehensibilities ' +
    'disproportionately counterrevolutionaries electroencephalographic';
  const longest = Math.max(...words.split(' ').map((w) => natural(w)));
  for (let W = longest + 2; W < longest * 2.2; W += 7) {
    const L = lay(`${words} ${words}`, W, { hyphenate: true });
    let run = 0;
    for (const l of L.lines) { run = l.hyphen ? run + 1 : 0; assert.ok(run <= 2, `width ${W}: three hyphenated lines in a row`); }
  }
});

test('the hyphen is a real glyph: a PDF built from the layout reads it back', async () => {
  const word = 'representatives';
  const pts = hyphenPoints(word);
  const p = pts[pts.length - 2];
  const W = natural(`we met the ${word.slice(0, p)}-`, 12) + 0.5;
  const L = layoutParagraphs([{ runs: [{ text: `we met the ${word} yesterday`, face: F.sans, size: 12 }], hyphenate: true }], { width: W });
  assert.equal(L.lines[0].hyphen, true);
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const writer = new FontWriter(doc.context);
  const key = useLayout(writer, L);
  for (const [k, ref] of Object.entries(writer.finish())) page.node.setFontDictionary(PDFName.of(k), ref);
  page.node.addContentStream(doc.context.register(doc.context.flateStream(emit(L, { x: 40, yTop: 260 }, key))));
  const P = await openPdfium();
  const pdf = P.open(await doc.save({ useObjectStreams: false }));
  try {
    const pg = pdf.page(0);
    // PDFium reports a hyphen that ends a line as U+0002 (its soft-hyphen marker); the glyph maps to '-'
    const text = pg.chars().map((c) => c.unicode).join('').replace(/\u0002/g, '-');
    pg.close();
    assert.ok(text.includes(`${word.slice(0, p)}-`), JSON.stringify(text));
    assert.ok(text.includes(word.slice(p)), JSON.stringify(text));
  } finally { pdf.close(); }
});

test('justify policy: a narrow justified paragraph is set left; a wide one stays justified', () => {
  const narrow = layoutParagraphs([{ runs: [{ text: EN, face: F.sans, size: 11 }], align: 'justify', justifyPolicy: true }], { width: 150 });
  assert.equal(narrow.paras![0].alignUsed, 'left');
  for (const l of narrow.lines) assert.equal(l.alignUsed, 'left');
  assert.ok(narrow.lines.slice(0, -1).some((l) => l.width < 150 - 1), 'ragged right');
  // without the policy it is justified as asked
  const forced = layoutParagraphs([{ runs: [{ text: EN, face: F.sans, size: 11 }], align: 'justify' }], { width: 150 });
  assert.equal(forced.paras![0].alignUsed, 'justify');
  const wide = layoutParagraphs([{ runs: [{ text: `${EN} ${EN}`, face: F.sans, size: 9 }], align: 'justify', justifyPolicy: true, hyphenate: true }], { width: 420 });
  assert.equal(wide.paras![0].alignUsed, 'justify');
  for (const l of wide.lines.slice(0, -1)) assert.ok(Math.abs(l.width - 420) < 1e-6);
  // a 2× word-gap limit: one long line per paragraph with few gaps fails it
  const gappy = layoutParagraphs([{ runs: [{ text: 'a b incomprehensibilities and more words here to make a paragraph of text', face: F.sans, size: 11 }], align: 'justify', justifyPolicy: { minChars: 0, maxSpace: 2 } }], { width: 140 });
  assert.equal(gappy.paras![0].alignUsed, 'left');
});

test('a 2-line heading is balanced: lines of similar length, the same line count', () => {
  const text = 'Quarterly results and the outlook for next year';
  const size = 18;
  const W = natural(text.split(' ').slice(0, -1).join(' '), size) + 2;   // greedy: all but one word, then one word
  const greedy = lay(text, W, {}, size);
  assert.equal(greedy.lines.length, 2);
  const L = lay(text, W, { balance: true }, size);
  assert.equal(L.lines.length, 2);
  assert.equal(L.paras![0].balanced, true);
  const diff = (x: Layout) => Math.abs(x.lines[0].width - x.lines[1].width);
  assert.ok(diff(L) < diff(greedy) / 3, `balanced ${diff(L).toFixed(1)} vs greedy ${diff(greedy).toFixed(1)}`);
  assert.ok(diff(L) < 0.25 * W, `lines ${L.lines.map((l) => l.width.toFixed(0))}`);
  // centred headings centre each balanced line on the full measure
  const C = lay(text, W, { balance: true, align: 'center' }, size);
  for (const l of C.lines) assert.ok(Math.abs(firstX(l) + l.width / 2 - W / 2) < 0.5);
});

test('a widow is avoided: a word comes down onto a one-short-word last line, same line count', () => {
  const text = `${EN} ok`;
  let found = 0;
  for (let W = 140; W <= 320; W += 1) {
    const g = lay(text, W);
    const n = g.lines.length, last = g.lines[n - 1];
    if (n < 3 || lineText(last).includes(' ') || last.width >= 0.1 * W) continue;
    found++;
    const L = lay(text, W, { avoidWidow: true });
    assert.equal(L.lines.length, n, `width ${W}: line count kept`);
    assert.equal(L.paras![0].widowFixed, true, `width ${W}`);
    const l2 = L.lines[n - 1];
    assert.ok(lineText(l2).includes(' ') || l2.width >= 0.1 * W, `width ${W}: last line '${lineText(l2)}'`);
    assert.equal(L.lines.map(lineText).join(' '), text, 'nothing lost');
  }
  assert.ok(found > 0, 'some width leaves a widow without the switch');
});
