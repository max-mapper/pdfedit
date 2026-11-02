// Vertical boxes in the model: unlocked by build, laid out in columns by layoutBox (right to left, the frame's height
// the column length, the width following the stack), split to the left, and written by export end to end on a
// synthetic page built with the text layer (Identity-V source columns). Synthetic Japanese only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPdfium } from '../engine/pdfium.ts';
import { exportDoc } from '../export/export.ts';
import { buildPdf } from '../layout/testkit.ts';
import { detectAndBuild } from './build.ts';
import { Editor } from './edit.ts';
import { loadFonts } from './fonts.ts';
import type { FontRegistry } from './fonts.ts';
import { VERTICAL_SUFFIX, layoutBox } from './layout.ts';
import { box, para } from './testkit.ts';
import type { Box, Doc, LaidBox } from './types.ts';

const BODY = '第3四半期の売上高は前年同期比12%増となりました。';
const HEAD = '縦書きのテスト用見出し';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

const vbox = (id: string, frame: Box['frame'], text: string, size = 12): Box => {
  const b = box(id, frame, [para(text, { run: { size } })]);
  b.vertical = true;
  b.writingMode = 'vertical-rl';
  return b;
};
const colText = (l: LaidBox['lines'][number]) => l.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('');
const docOf = (...boxes: Box[]): Doc => ({ pages: [{ n: 0, w: 595, h: 842, boxes }] });

test('layoutBox lays a vertical box out in columns, right to left; the height stays, the width follows the text', () => {
  const frame = { x0: 360, x1: 400, y0: 500, y1: 620 };
  const b = vbox('v', frame, BODY);
  const L = layoutBox(b, fonts);
  assert.equal(L.vertical, true);
  assert.equal(L.overflow, false);
  assert.ok(L.lines.length >= 3, `${L.lines.length} columns`);
  assert.equal(L.lines.map(colText).join(''), BODY);
  // the frame keeps its right edge, top and bottom; its left edge follows the column stack
  assert.equal(L.frame.x1, 400);
  assert.equal(L.frame.y0, 500);
  assert.equal(L.frame.y1, 620);
  assert.ok(Math.abs(L.frame.x0 - (400 - L.width!)) < 1e-9);
  assert.ok(Math.abs(L.width! - 14.4 * L.lines.length) < 1e-6);
  assert.ok(L.height <= 120 + 1e-6);
  // no source axis: the first column hugs the right edge
  assert.ok(Math.abs(L.lines[0].axis! - (400 - 7.2)) < 1e-6);
  for (let i = 1; i < L.lines.length; i++) assert.ok(L.lines[i].axis! < L.lines[i - 1].axis!, 'right to left');
  for (const l of L.lines) {
    assert.equal(l.baseline, 620);
    assert.equal(l.x, L.frame.x0);
    for (const r of l.runs) for (const g of r.glyphs) {
      const px = l.x + g.x, py = l.baseline + g.y;
      assert.ok(px >= L.frame.x0 - 1e-6 && px <= L.frame.x1 + 1e-6 && py <= 620 + 1e-6 && py >= 500 - 1e-6, `${g.text} at ${px}, ${py}`);
    }
  }
  // upright runs are set in the vertical font (its own FontRef name), the sideways 12% in the horizontal one
  const runs = L.lines.flatMap((l) => l.runs);
  const side = runs.filter((r) => r.orientation === 'sideways');
  assert.deepEqual(side.map((r) => r.glyphs.map((g) => g.text).join('')), ['12%']);
  assert.equal(side[0].font.name, 'NotoSansJP:400');
  assert.equal(side[0].face!.orientation, 'sideways');
  for (const r of runs.filter((x) => x.orientation === 'upright')) {
    assert.equal(r.font.name, `NotoSansJP:400${VERTICAL_SUFFIX}`);
    assert.equal(r.face!.orientation, 'vertical');
  }

  // the source's first axis is kept (scaled by the size change)
  b.source.axis = 6;
  assert.ok(Math.abs(layoutBox(b, fonts).lines[0].axis! - 394) < 1e-6);
  b.paragraphs[0].runs[0].size = 24;
  assert.ok(Math.abs(layoutBox(b, fonts).lines[0].axis! - 388) < 1e-6);
});

test('frame changes: a taller frame makes longer, fewer columns; a pinned frame overflows when the stack is wider', () => {
  const short = layoutBox(vbox('v', { x0: 360, x1: 400, y0: 560, y1: 620 }, BODY), fonts);
  const tall = layoutBox(vbox('v', { x0: 360, x1: 400, y0: 380, y1: 620 }, BODY), fonts);
  assert.ok(tall.lines.length < short.lines.length);
  assert.ok(tall.frame.x0 > short.frame.x0, 'fewer columns: narrower');
  assert.ok(Math.max(...tall.lines.map((l) => l.runs.reduce((n, r) => n + r.glyphs.length, 0))) > 10);
  const pinned = vbox('v', { x0: 380, x1: 400, y0: 560, y1: 620 }, BODY);
  pinned.heightPinned = true;
  const P = layoutBox(pinned, fonts);
  assert.equal(P.overflow, true);
  assert.deepEqual(P.frame, pinned.frame);
  pinned.frame = { x0: 200, x1: 400, y0: 560, y1: 620 };
  const W = layoutBox(pinned, fonts);
  assert.equal(W.overflow, false);
  assert.ok(Math.abs(W.lines[0].axis! - 392.8) < 1e-6, 'columns still start at the right edge');
});

test('splitting a vertical box puts the second part to the left, with the same column length', () => {
  const b = vbox('v', { x0: 300, x1: 400, y0: 500, y1: 620 }, HEAD + BODY);
  const ed = new Editor(docOf(b), fonts);
  const id = ed.splitBox(0, 'v', 0, HEAD.length);
  const head = ed.box(0, 'v'), tail = ed.box(0, id);
  assert.equal(head.paragraphs[0].runs[0].text, HEAD);
  assert.equal(tail.vertical, true);
  assert.equal(tail.frame.x1, head.frame.x0);
  assert.deepEqual([tail.frame.y0, tail.frame.y1], [500, 620]);
  assert.ok(head.frame.x0 > 300 && head.frame.x1 === 400);
  const L = ed.laid(0, id);
  assert.ok(L.lines[0].axis! < head.frame.x0, 'the tail\'s columns are left of the head');
  assert.equal(L.lines.map(colText).join(''), BODY);
});

test('end to end: a vertical box on a synthetic page is unlocked, edited, exported with Identity-V and verified', async () => {
  // the source: two Identity-V columns (the text layer) and a horizontal line that must stay untouched
  const src = await buildPdf([
    { t: 'vtext', text: '縦書きの文章です。', x: 400, yTop: 700, size: 12 },
    { t: 'vtext', text: '二行目の文字列', x: 385, yTop: 700, size: 12 },
    { t: 'text', text: 'Untouched heading', x: 60, y: 760, size: 14 },
    { t: 'rect', x: 60, y: 600, w: 120, h: 40, fill: [0.2, 0.4, 0.8] },
  ]);
  const P = await openPdfium();
  const pdf = P.open(src);
  let doc: Doc;
  try { doc = { pages: [detectAndBuild(pdf, 0)] }; } finally { pdf.close(); }
  const v = doc.pages[0].boxes.find((b) => b.vertical);
  assert.ok(v, 'a vertical box');
  assert.equal(v.locked, null);
  assert.equal(v.writingMode, 'vertical-rl');
  assert.ok(Math.abs(v.frame.x1 - v.source.axis! - 400) < 0.5, 'the first source axis');

  const ed = new Editor(doc, fonts);
  ed.setText(0, v.id, 0, BODY);
  const laid = ed.laid(0, v.id);
  assert.equal(laid.vertical, true);
  assert.ok(Math.abs(laid.lines[0].axis! - 400) < 0.01, 'the new first column sits on the old one');
  assert.ok(laid.lines.length > 2);

  const { bytes, report } = await exportDoc(src, doc, (n, b) => ed.laid(n, b.id));
  assert.ok(report.ok, report.failures.join('; '));
  assert.ok(report.verified);
  const p = report.pages[0];
  assert.deepEqual(p.skipped, []);
  assert.deepEqual(p.written.map((w) => w.box), [v.id]);
  assert.deepEqual(p.verify!.text, [{ box: v.id, newPresent: true, oldAbsent: true }]);
  assert.equal(p.verify!.pixelsChangedOutside, 0);
  assert.deepEqual(report.fonts.map((f) => f.font).sort(), ['NotoSansJP:400', `NotoSansJP:400${VERTICAL_SUFFIX}`]);

  // PDFium reads the new text back in order inside the laid frame; the old text is gone
  const out = P.open(bytes);
  try {
    const pg = out.page(0);
    const chars = pg.chars();
    pg.close();
    const f = laid.frame;
    const inside = chars.filter((c) => {
      const cx = (c.box.x0 + c.box.x1) / 2, cy = (c.box.y0 + c.box.y1) / 2;
      return !c.generated && cx >= f.x0 - 1 && cx <= f.x1 + 1 && cy >= f.y0 - 1 && cy <= f.y1 + 1;
    });
    assert.equal(inside.map((c) => c.unicode).join('').replace(/\s+/g, ''), BODY);
    const all = chars.map((c) => c.unicode).join('');
    assert.ok(!all.includes('縦書きの文章') && !all.includes('二行目'), all);
    assert.ok(all.includes('Untouched heading'));
  } finally { out.close(); }

  const dir = mkdtempSync(join(tmpdir(), 'pdfedit-model-vertical-'));
  const path = join(dir, 'out.pdf');
  writeFileSync(path, bytes);
  const fontsOut = execFileSync('/usr/bin/pdffonts', [path], { encoding: 'utf8' });
  assert.match(fontsOut, /NotoSansJP-Regular\s+CID TrueType\s+Identity-V\s+yes\s+yes\s+yes/);
  assert.match(fontsOut, /NotoSansJP-Regular\s+CID TrueType\s+Identity-H\s+yes\s+yes\s+yes/, 'the sideways 12%');
  const text = execFileSync('/usr/bin/pdftotext', ['-enc', 'UTF-8', path, '-'], { encoding: 'utf8' }).replace(/\s+/g, '');
  for (const part of ['第3四半期の売上', '12%', 'た。']) assert.ok(text.includes(part), text);
});
