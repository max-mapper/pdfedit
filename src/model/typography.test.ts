// The model keeps list structure and source typography: bullets as structure in their own style with a hanging
// indent, descriptions in their own style, first-line indents, source leading and paragraph spacing, the dominant
// style (and a "title:" lead-in) for new text, and bold weights from font names. Synthetic text only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openPdfium } from '../engine/pdfium.ts';
import type { Char } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { BLUE, buildPdf, bulletListOps } from '../layout/testkit.ts';
import type { DrawOp } from '../layout/testkit.ts';
import { buildPage, readPage, runsOf } from './build.ts';
import { fontFor, loadFonts } from './fonts.ts';
import type { FontRegistry } from './fonts.ts';
import { layoutBox } from './layout.ts';
import { Editor } from './edit.ts';
import { exportDoc } from '../export/export.ts';
import { box, para, run } from './testkit.ts';
import type { LaidBox, Page, Paragraph } from './types.ts';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

async function modelOf(ops: DrawOp[] | Uint8Array): Promise<Page> {
  const P = await openPdfium();
  const doc = P.open(ops instanceof Uint8Array ? ops : await buildPdf(ops));
  try {
    const pg = doc.page(0);
    const input = readPage(pg);
    const page = buildPage(pg, detectBoxes(input), { input });
    pg.close();
    return page;
  } finally { doc.close(); }
}

const textOf = (p: Paragraph) => p.runs.map((r) => r.text).join('');
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol;
const lineX = (laid: LaidBox, l: LaidBox['lines'][number], run = 0) => l.x + l.runs[run].glyphs[0].x;

test('a bulleted list: bullets kept as structure in their colour, hanging indent; descriptions keep their style', async () => {
  const m = await modelOf(bulletListOps(72, 700, 14));
  const paras = m.boxes.flatMap((b) => b.paragraphs.map((p, k) => ({ b, p, k })));
  assert.equal(paras.length, 6, JSON.stringify(paras.map((x) => textOf(x.p))));
  const items = paras.filter((x) => x.p.bullet), descs = paras.filter((x) => !x.p.bullet);
  assert.equal(items.length, 3);
  for (const { p } of items) {
    assert.equal(p.bullet, '•');
    assert.ok(!textOf(p).includes('•'), `the bullet is not in the runs: ${textOf(p)}`);
    assert.ok(p.runs.every((r) => r.bold), 'titles are bold');
    assert.deepEqual(p.runs[0].color, [0, 0, 0]);
    assert.ok(p.bulletStyle, 'the bullet has its own style');
    assert.deepEqual(p.bulletStyle!.color.map((c) => Math.round(c * 10) / 10), BLUE);
    assert.ok(near(p.bulletIndent!, 12, 0.3), `bulletIndent ${p.bulletIndent}`);
    assert.equal(p.indent, 0);
  }
  for (const { b, p } of descs) {
    assert.ok(p.runs.every((r) => !r.bold), 'descriptions are regular');
    assert.ok(near(b.frame.x0 + (p.leftIndent ?? 0), 84, 0.6), `description starts at ${b.frame.x0 + (p.leftIndent ?? 0)}`);
  }
  // source leading 14 / 10 pt is kept for one-line paragraphs, with no extra space between them
  for (const { p } of paras) assert.ok(near(p.leading, 1.4, 0.02), `leading ${p.leading}`);
  for (const { p, k } of paras) if (k > 0) assert.ok(p.spaceBefore < 0.5, `spaceBefore ${p.spaceBefore}`);

  const ed = new Editor({ pages: [m] }, fonts);
  const en = ['Delivery speed: every order leaves the warehouse quickly and reliably',
    'Careful packaging of every single parcel, checked by hand', 'Friendly and knowledgeable customer support from people who use the product every day'];
  const enDesc = ['Orders ship within one working day of being placed, even at busy times of the year.',
    'Each parcel is checked and packed by hand before it is shipped to the customer.',
    'Questions are answered by people who know the product and its uses very well.'];
  items.forEach(({ b, k }, j) => ed.setText(0, b.id, k, `• ${en[j]}`));   // a repeated bullet is dropped
  descs.forEach(({ b, k }, j) => ed.setText(0, b.id, k, enDesc[j]));
  for (const [j, { b, k }] of items.entries()) {
    const p = ed.box(0, b.id).paragraphs[k];
    assert.equal(textOf(p), en[j]);
    assert.ok(p.runs.every((r) => r.bold && r.font.name === 'NotoSans-Bold'), 'English titles stay bold');
  }
  for (const { b, k } of descs) {
    const p = ed.box(0, b.id).paragraphs[k];
    assert.ok(p.runs.every((r) => !r.bold && r.font.name === 'NotoSans-Regular' && r.color.every((c) => c === 0)), 'regular, dark');
    assert.equal(p.runs[0].size, 10);
  }
  for (const b of new Set(paras.map((x) => x.b))) {
    const laid = layoutBox(ed.box(0, b.id), fonts);
    b.paragraphs.forEach((p, k) => {
      const ls = laid.lines.filter((l) => l.para === k);
      assert.ok(ls.length >= 1);
      if (p.bullet) {
        const [mk, body] = ls[0].runs;
        assert.equal(mk.glyphs.map((g) => g.text).join(''), '•');
        assert.deepEqual(mk.color.map((c) => Math.round(c * 10) / 10), BLUE, 'the bullet in its own colour');
        assert.ok(near(lineX(laid, ls[0], 0), 72), `bullet at ${lineX(laid, ls[0], 0)}`);
        assert.ok(near(ls[0].x + body.glyphs[0].x, 84), `text at ${ls[0].x + body.glyphs[0].x}`);
        assert.ok(ls.length >= 2, 'the English title wraps');
        for (const l of ls.slice(1)) {
          assert.equal(l.runs.length, 1);
          assert.ok(near(lineX(laid, l), 84), `continuation at ${lineX(laid, l)} (hanging, not under the bullet)`);
          assert.ok(l.runs[0].color.every((c) => c === 0));
        }
      } else {
        for (const l of ls) {
          assert.ok(near(lineX(laid, l), 84), `description line at ${lineX(laid, l)}`);
          assert.equal(l.runs[0].font.name, 'NotoSans-Regular');
          assert.ok(l.runs[0].color.every((c) => c === 0));
        }
      }
    });
  }
});

test('a description under a wider bulleted title shares its box and keeps its indent; the export verifies', async () => {
  const bytes = await buildPdf([
    { t: 'text', text: '•', x: 72, y: 700, size: 10, color: BLUE },
    { t: 'text', text: 'A long bold title for the first item of this list', x: 84, y: 700, size: 10, font: 'helvB' },
    { t: 'text', text: 'A shorter description below it.', x: 84, y: 686, size: 10 },
  ]);
  const m = await modelOf(bytes);
  const b = m.boxes.find((x) => x.paragraphs.length === 2);
  assert.ok(b, JSON.stringify(m.boxes.map((x) => x.paragraphs.map(textOf))));
  const [t, d] = b.paragraphs;
  assert.equal(t.bullet, '•');
  assert.equal(t.leftIndent, undefined);
  assert.ok(near(d.leftIndent!, 12, 0.3), `leftIndent ${d.leftIndent}`);
  assert.ok(near(d.leading, 1.4, 0.02) && d.spaceBefore < 0.5, `leading ${d.leading}, spaceBefore ${d.spaceBefore}`);
  const ed = new Editor({ pages: [m] }, fonts);
  ed.setText(0, b.id, 0, 'A long bold title for the first item, now in English and somewhat longer than before');
  ed.setText(0, b.id, 1, 'A shorter description below it, which the translation makes considerably longer, so that it wraps ' +
    'onto several lines underneath the title with recommendations and considerations.');
  const laid = layoutBox(ed.box(0, b.id), fonts);
  for (const l of laid.lines.filter((x) => x.para === 1)) assert.ok(near(lineX(laid, l), 84), `description line at ${lineX(laid, l)}`);
  for (const l of laid.lines.filter((x) => x.para === 0).slice(1)) assert.ok(near(lineX(laid, l), 84));
  assert.equal(laid.paragraphs?.length, 2);
  const { report } = await exportDoc(bytes, { pages: [m] }, (_n, x) => layoutBox(x, fonts), { verify: 'report', maxPixelsOutside: 250 });
  assert.ok(report.ok, JSON.stringify(report).slice(0, 2000));
});

test('source spacing: space between paragraphs is the baseline gap less the leading; layout reproduces it', async () => {
  const body = ['The committee met twice and the figures rose', 'in every region that reported on time, with the',
    'remaining regions expected to follow next month.'];
  const next = ['A second paragraph follows the first one after', 'a gap that is wider than the leading.'];
  const ops: DrawOp[] = [];
  body.forEach((t, k) => ops.push({ t: 'text', text: t, x: 72, y: 700 - 13 * k, size: 10 }));
  next.forEach((t, k) => ops.push({ t: 'text', text: t, x: 72, y: 700 - 26 - 19 - 13 * k, size: 10 }));
  const m = await modelOf(ops);
  const b = m.boxes.find((x) => x.paragraphs.length === 2);
  assert.ok(b, JSON.stringify(m.boxes.map((x) => x.paragraphs.map(textOf))));
  assert.ok(near(b.paragraphs[0].leading, 1.3, 0.01) && near(b.paragraphs[1].leading, 1.3, 0.01));
  assert.ok(near(b.paragraphs[1].spaceBefore, 6, 0.3), `spaceBefore ${b.paragraphs[1].spaceBefore}`);
  const laid = layoutBox(b, fonts);
  const last0 = laid.lines.filter((l) => l.para === 0).pop()!, first1 = laid.lines.find((l) => l.para === 1)!;
  assert.ok(near(last0.baseline - first1.baseline, 19, 0.3), `laid step ${last0.baseline - first1.baseline}`);
});

test('a first-line indent is laid out (and a hanging one)', () => {
  const frame = { x0: 100, x1: 300, y0: 600, y1: 700 };
  const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo';
  const L = layoutBox(box('b0', frame, [para(text, { indent: 24 })]), fonts);
  assert.ok(L.lines.length >= 2);
  assert.ok(near(lineX(L, L.lines[0]), 124), `first line at ${lineX(L, L.lines[0])}`);
  for (const l of L.lines.slice(1)) assert.ok(near(lineX(L, l), 100));
  const H = layoutBox(box('b0', frame, [para(text, { indent: -18 })]), fonts);
  assert.ok(near(lineX(H, H.lines[0]), 100));
  for (const l of H.lines.slice(1)) assert.ok(near(lineX(H, l), 118));
});

test('setText takes the dominant style, not a small coloured first run; a bold "title:" lead-in keeps its style', () => {
  const p = para('', {});
  p.runs = [run('★', { size: 6, color: [0.9, 0.2, 0.1] }), run('一つ目の項目について詳しく説明する文章です。', { size: 10 })];
  const q = para('', {});
  q.runs = [run('概要：', { bold: true, color: [0.1, 0.3, 0.8] }), run('この段落の本文は通常の太さで書かれています。', {})];
  const b = box('b0', { x0: 50, x1: 300, y0: 600, y1: 700 }, [p, q]);
  const ed = new Editor({ pages: [{ n: 0, w: 595, h: 842, boxes: [b], panels: [], obstacles: [] }] }, fonts);
  ed.setText(0, 'b0', 0, 'A detailed description of the first item.');
  const r = b.paragraphs[0].runs;
  assert.equal(r.length, 1);
  assert.equal(r[0].size, 10);
  assert.deepEqual(r[0].color, [0, 0, 0]);
  ed.setText(0, 'b0', 1, 'Overview: the body of this paragraph is set in the regular weight.');
  const s = b.paragraphs[1].runs;
  assert.deepEqual(s.map((x) => x.text), ['Overview: ', 'the body of this paragraph is set in the regular weight.']);
  assert.equal(s[0].bold, true);
  assert.equal(s[0].font.name, 'NotoSans-Bold');
  assert.deepEqual(s[0].color, [0.1, 0.3, 0.8]);
  assert.equal(s[1].bold, false);
  // typing (merged edits) keeps taking the styles from before the burst
  ed.setText(0, 'b0', 1, 'Over', { merge: true });
  ed.setText(0, 'b0', 1, 'Overview: t', { merge: true });
  assert.deepEqual(b.paragraphs[1].runs.map((x) => x.bold), [true, false]);
  // without a separator, all of it in the dominant style
  ed.setText(0, 'b0', 1, 'The body of this paragraph in the regular weight.');
  assert.deepEqual(b.paragraphs[1].runs.map((x) => x.bold), [false]);
});

test('bold from Japanese weight names and PDFium weight maps to the bold shipped face; Medium does not', () => {
  const ch = (unicode: string, fontName: string, weight = 400, i = 0): Char => ({
    i, unicode, box: { x0: i * 10, y0: 0, x1: i * 10 + 9, y1: 9 }, loose: { x0: i * 10, y0: -2, x1: i * 10 + 10, y1: 10 },
    origin: [i * 10, 0], fontSize: 10, fontSizeRaw: 10, fontName, fontFlags: 0, weight, fill: [0, 0, 0, 255], angle: 0, generated: false, obj: 0,
  }) as Char;
  const boldOf = (name: string, weight = 400) => {
    const r = runsOf('見出', [0, 1], [ch('見', name, weight, 0), ch('出', name, weight, 1)])[0];
    return { bold: r.bold, face: fontFor({ ...r, text: 'Heading' }).name };
  };
  for (const n of ['ABCDEF+HiraginoSans-W6', 'A-OTF-ShinGoPro-Bold', 'MeiryoUI-Bold', 'NotoSansJP-Bold', 'HiraKakuStd-W8', 'FOT-RodinPro-DB'])
    assert.deepEqual(boldOf(n), { bold: true, face: 'NotoSans-Bold' }, n);
  for (const n of ['KozGoPr6N-Medium', 'HiraginoSans-W3', 'MS-Gothic'])
    assert.deepEqual(boldOf(n), { bold: false, face: 'NotoSans-Regular' }, n);
  assert.equal(boldOf('SomeGothic', 700).bold, true, 'PDFium weight 700');
  assert.equal(boldOf('SomeGothic', 600).bold, true, 'PDFium weight 600');
});
