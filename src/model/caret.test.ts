// The focus layout and the caret on synthetic pages: an unedited paragraph laid out on its source lines (breaks, glyph
// x, frame), an edit that keeps the other lines, the caret mapping (offset → drawn position, click → offset, line moves,
// selection) before and after an edit, vertical boxes, and Enter / Shift+Enter through the editor with undo and redo.
// Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdfium } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { buildPdf, helveticaWidth, paragraphOps, wrap } from '../layout/testkit.ts';
import { buildPage, readPage } from './build.ts';
import { loadFonts } from './fonts.ts';
import { layoutBox, keepable } from './layout.ts';
import { caretLines, caretRect, hitTest, lineEdge, lineMove, selectionRects } from './caret.ts';
import { Editor } from './edit.ts';
import { filler } from './testkit.ts';
import type { Box, LaidBox, Page } from './types.ts';

const TEXT = filler(330, 21);

async function page(): Promise<{ page: Page; chars: { x: number; y: number }[]; lines: string[] }> {
  const measure = await helveticaWidth();
  const lines = wrap(TEXT, 230, (s) => measure(s, 10));
  const bytes = await buildPdf([
    ...paragraphOps(lines, { x: 72, y: 700, size: 10, leading: 12.5, width: 230, measure: (s) => measure(s, 10) }),
    { t: 'vtext', text: '縦書きの文章です。', x: 480, yTop: 700, size: 12 },
  ]);
  const P = await openPdfium();
  const doc = P.open(bytes);
  try {
    const pg = doc.page(0);
    const input = readPage(pg);
    const pageM = buildPage(pg, detectBoxes(input), { input });
    pg.close();
    return { page: pageM, chars: input.chars.map((c) => ({ x: c.origin[0], y: c.origin[1] })), lines };
  } finally { doc.close(); }
}

const latin = (p: Page) => p.boxes.find((b) => !b.vertical && b.paragraphs[0].runs.map((r) => r.text).join('').startsWith(TEXT.slice(0, 12)))!;
const glyphsOf = (L: LaidBox, i: number) => L.lines[i].runs.flatMap((r) => r.glyphs).filter((g) => (g.c ?? -1) >= 0);

test('an unedited paragraph is laid out on its source lines: same breaks, glyphs at the source x and baseline, same frame', async () => {
  const { page: pg, chars, lines } = await page();
  const fonts = await loadFonts();
  const b = latin(pg);
  assert.ok(b.paragraphs[0].src, 'build records the source lines');
  assert.equal(b.paragraphs[0].src!.starts.length, lines.length);
  assert.ok(keepable(b.paragraphs[0]));
  const L = layoutBox(b, fonts);
  assert.equal(L.lines.length, lines.length);
  assert.ok(L.lines.every((l) => l.kept));
  // each line starts with the word its source line started with
  const text = b.paragraphs[0].runs.map((r) => r.text).join('');
  L.lines.forEach((l, k) => assert.equal(text.slice(l.start!, l.end!).trim(), lines[k]));
  // every glyph on a source character's origin
  const near = (x: number, y: number) => chars.some((c) => Math.abs(c.x - x) < 0.02 && Math.abs(c.y - y) < 0.02);
  for (let i = 0; i < L.lines.length; i++) for (const g of glyphsOf(L, i)) if (g.text.trim()) assert.ok(near(L.lines[i].x + g.x, L.lines[i].baseline + g.y), `glyph ${g.c} off its source`);
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) assert.ok(Math.abs(L.frame[k] - b.frame[k]) < 0.01, `frame ${k}`);
});

test('an edit in the second line keeps the first line glyph for glyph and the frame top; only the paragraph reflows', async () => {
  const { page: pg } = await page();
  const fonts = await loadFonts();
  const ed = new Editor({ pages: [pg] }, fonts);
  const b = latin(pg);
  const before = layoutBox(b, fonts);
  const text = b.paragraphs[0].runs.map((r) => r.text).join('');
  const at = before.lines[1].start! + 3;
  ed.editText(0, b.id, [text.slice(0, at) + 'zulu ' + text.slice(at)]);
  const after = ed.laid(0, b.id);
  assert.ok(after.lines[0].kept);
  assert.deepEqual(glyphsOf(after, 0).map((g) => [g.c, g.x]), glyphsOf(before, 0).map((g) => [g.c, g.x]));
  assert.equal(after.lines[0].baseline, before.lines[0].baseline);
  assert.equal(after.frame.y1, before.frame.y1);
  assert.equal(after.lines[1].kept, false);
  // the run keeps its source style: untouched characters keep their run
  assert.equal(b.paragraphs[0].runs[0].font.source, 'document');
});

test('the caret is where the glyphs are drawn, before and after an edit; a click finds the glyph it is on', async () => {
  const { page: pg } = await page();
  const fonts = await loadFonts();
  const ed = new Editor({ pages: [pg] }, fonts);
  const b = latin(pg);
  for (const phase of ['before', 'after']) {
    const L = ed.laid(0, b.id);
    const lines = caretLines(L, b);
    for (let i = 0; i < L.lines.length; i++) {
      const gs = glyphsOf(L, i);
      for (let k = 0; k + 1 < gs.length; k++) {
        const g = gs[k];
        const r = caretRect(lines, { para: 0, off: g.c! }, 'down')!;
        assert.ok(Math.abs(r.x0 - (L.lines[i].x + g.p!)) < 1e-6, `${phase}: caret of ${g.c} at its glyph`);
        assert.ok(r.y0 < L.lines[i].baseline && r.y1 > L.lines[i].baseline);
        const adv = gs[k + 1].p! - g.p!;
        const hit = hitTest(lines, L.lines[i].x + g.p! + 0.3 * adv, L.lines[i].baseline + 2)!;
        assert.deepEqual([hit.para, hit.off], [0, g.c], `${phase}: a click on ${g.c}`);
      }
    }
    const text = b.paragraphs[0].runs.map((r) => r.text).join('');
    ed.editText(0, b.id, ['Zap ' + text]);
  }
});

test('line moves keep the column; Home and End are the line\'s; a selection is one rectangle per line', async () => {
  const { page: pg } = await page();
  const fonts = await loadFonts();
  const b = latin(pg);
  const L = layoutBox(b, fonts);
  const lines = caretLines(L, b);
  const g = glyphsOf(L, 0)[8];
  const down = lineMove(lines, { para: 0, off: g.c! }, 'down', 1);
  assert.ok(down.pos.off >= L.lines[1].start! && down.pos.off < L.lines[1].end!);
  const r = caretRect(lines, down.pos, down.affinity)!;
  assert.ok(Math.abs(r.x0 - (L.lines[0].x + g.p!)) < 4, 'the same column, within a glyph');
  const up = lineMove(lines, down.pos, down.affinity, -1, down.goal);
  assert.equal(up.pos.off, g.c);
  const home = lineEdge(lines, down.pos, down.affinity, 'start');
  assert.equal(home.pos.off, L.lines[1].start);
  const end = lineEdge(lines, down.pos, down.affinity, 'end');
  const er = caretRect(lines, end.pos, end.affinity)!;
  assert.ok(Math.abs(er.x0 - (L.lines[1].x + L.lines[1].pEnd!)) < 1e-6, 'End: after the line\'s last glyph, on that line');
  const rects = selectionRects(lines, { para: 0, off: g.c! }, { para: 0, off: L.lines[2].start! + 2 });
  assert.equal(rects.length, 3);
});

test('a vertical box: laid on its source column; the caret is a bar across the column at the glyph, and a click finds it', async () => {
  const { page: pg } = await page();
  const fonts = await loadFonts();
  const b = pg.boxes.find((x) => x.vertical)!;
  assert.ok(b, 'a vertical box');
  const L = layoutBox(b, fonts);
  // unedited: on its source column, the frame unchanged
  assert.ok(b.paragraphs[0].src?.vertical && L.lines.every((l) => l.kept));
  for (const k of ['x0', 'y0', 'x1', 'y1'] as const) assert.ok(Math.abs(L.frame[k] - b.frame[k]) < 0.01, `frame ${k}`);
  const lines = caretLines(L, b);
  const gs = glyphsOf(L, 0);
  const g = gs[3];
  const r = caretRect(lines, { para: 0, off: g.c! })!;
  assert.equal(r.y0, r.y1);
  assert.ok(r.x1 - r.x0 > 5);
  assert.ok(Math.abs(r.y0 - (L.lines[0].baseline - g.p!)) < 1e-6);
  const step = gs[4].p! - g.p!;
  const hit = hitTest(lines, L.lines[0].axis!, L.lines[0].baseline - g.p! - 0.3 * step)!;
  assert.equal(hit.off, g.c);
});

test('Enter makes a paragraph and Shift+Enter a line break (editText); undo and redo restore both', async () => {
  const { page: pg } = await page();
  const fonts = await loadFonts();
  const ed = new Editor({ pages: [pg] }, fonts);
  const b: Box = latin(pg);
  const text = b.paragraphs[0].runs.map((r) => r.text).join('');
  const cut = text.indexOf(' ', 60) + 1;
  ed.editText(0, b.id, [text.slice(0, cut), text.slice(cut)]);
  assert.equal(b.paragraphs.length, 2);
  assert.ok(b.paragraphs[1].src, 'the new paragraph keeps the source lines it came from');
  const L = ed.laid(0, b.id);
  const second = L.lines.filter((l) => l.para === 1);
  assert.ok(second.slice(1).some((l) => l.kept), 'after its first line the new paragraph is on its source lines');
  ed.editText(0, b.id, [text.slice(0, cut), text.slice(cut) + '\nzulu']);
  assert.equal(b.paragraphs[1].runs.map((r) => r.text).join('').endsWith('\nzulu'), true);
  assert.ok(ed.laid(0, b.id).lines.some((l) => l.para === 1 && l.start === text.length - cut + 1), 'the line break starts a line');
  ed.undo();
  assert.equal(b.paragraphs.length, 2);
  ed.undo();
  assert.equal(b.paragraphs.length, 1);
  assert.equal(b.paragraphs[0].runs.map((r) => r.text).join(''), text);
  ed.redo();
  ed.redo();
  assert.equal(b.paragraphs.length, 2);
  assert.ok(b.paragraphs[1].runs.map((r) => r.text).join('').endsWith('\nzulu'));
  // a size change sets the text anew: the source lines no longer apply
  ed.setStyle(0, b.id, 0, { size: 12 });
  assert.equal(b.paragraphs[0].src, undefined);
  ed.undo();
  assert.ok(b.paragraphs[0].src);
});
