// Box detection on synthetic pages: pdf-lib (Helvetica, rectangles, rules) and the text layer (Noto Sans JP,
// horizontal and Identity-V vertical), read back with the engine. Synthetic text only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildPage, helveticaWidth, paragraphOps, wrap } from './testkit.ts';
import type { DrawOp } from './testkit.ts';
import { detectBoxes } from './detect.ts';
import type { Result } from './types.ts';

const LOREM = 'Synthetic paragraphs for the layout tests describe nothing in particular: the quarterly figures rose, the ' +
  'committee met twice, and the annual report was printed on recycled paper with wide margins and a modest typeface.';
const LOREM2 = 'A second paragraph follows with different words so that its text can be told apart from the first one ' +
  'when the boxes are compared, and it runs long enough to wrap onto several lines in a narrow column of text.';

let W: (s: string, size: number, bold?: boolean) => number;
before(async () => { W = await helveticaWidth(); });

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
function textBoxes(r: Result) { return r.boxes.map((b) => b.text); }

test('two-column text stays two boxes, left column first (gutter narrower than the 1.5 em line gap)', async () => {
  const size = 10, lead = 12, colW = 230, gutter = 13;    // 1.3 em gutter: only the gutter pass splits it
  const m = (s: string) => W(s, size);
  // justified so that lines on both sides of the gutter reach it on the same baselines
  const left = wrap(`${LOREM} ${LOREM2}`, colW, m), right = wrap(`${LOREM2} ${LOREM}`, colW, m);
  const ops = [
    ...paragraphOps(left, { x: 50, y: 700, size, leading: lead, width: colW, justify: true, measure: m }),
    ...paragraphOps(right, { x: 50 + colW + gutter, y: 700, size, leading: lead, width: colW, justify: true, measure: m }),
  ];
  const r = detectBoxes(await buildPage(ops), { debug: true });
  assert.equal(r.boxes.length, 2, JSON.stringify(textBoxes(r), null, 1));
  assert.ok(r.debug!.gutterSplits > 0, 'the gutter pass split the lines');
  assert.equal(squash(r.boxes[0].text), squash(left.join(' ')));
  assert.equal(squash(r.boxes[1].text), squash(right.join(' ')));
  assert.ok(r.boxes[0].frame.x1 < 50 + colW + 1 && r.boxes[1].frame.x0 > 50 + colW + gutter - 1);
  assert.deepEqual(r.boxes.map((b) => b.order), [0, 1]);
  assert.deepEqual(r.boxes.map((b) => b.id), ['b0', 'b1']);
  assert.equal(r.paragraphs[r.boxes[0].paragraphs[0]].align, 'justify');
});

test('reading order: a title, two columns whose paragraph gaps line up, then a footer', async () => {
  const size = 10, lead = 12, colW = 230;
  const m = (s: string) => W(s, size);
  const ops: DrawOp[] = [{ t: 'text', text: 'A Title Across Both Columns', x: 180, y: 760, size: 16, font: 'helvB' }];
  const paras: string[] = [];
  for (const [col, x] of [50, 310].entries()) {
    let y = 720;
    for (const [k, t] of [LOREM, LOREM2].entries()) {
      const ls = wrap(t, colW, m);
      paras.push(`${col}${k}:${ls.join(' ')}`);
      ops.push(...paragraphOps(ls, { x, y, size, leading: lead, width: colW, measure: m }));
      y -= ls.length * lead + 40;   // the same gap in both columns, at the same height
    }
  }
  ops.push({ t: 'text', text: 'Page 1 of 1', x: 270, y: 60, size: 8 });
  const r = detectBoxes(await buildPage(ops));
  const firstWords = r.boxes.map((b) => b.text.slice(0, 18));
  assert.equal(r.boxes.length, 6, JSON.stringify(firstWords));
  assert.equal(r.boxes[0].text, 'A Title Across Both Columns');
  assert.equal(r.boxes[5].text, 'Page 1 of 1');
  const mid = r.boxes.slice(1, 5);
  assert.deepEqual(mid.map((b) => b.frame.x0 < 300), [true, true, false, false], JSON.stringify(firstWords));
  assert.ok(mid[0].frame.y1 > mid[1].frame.y1 && mid[2].frame.y1 > mid[3].frame.y1);
});

test('a first-line indent and a justified paragraph get their alignment and indent', async () => {
  const size = 10, lead = 13, width = 300;
  const m = (s: string) => W(s, size);
  const a = wrap(LOREM, width, m, 20), b = wrap(LOREM2, width, m);
  const ops = [
    ...paragraphOps(a, { x: 72, y: 700, size, leading: lead, width, indent: 20, measure: m }),
    ...paragraphOps(b, { x: 72, y: 700 - a.length * lead - 30, size, leading: lead, width, justify: true, measure: m }),
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.equal(r.paragraphs.length, 2, JSON.stringify(r.paragraphs.map((p) => p.text)));
  const [pa, pb] = r.paragraphs;
  assert.equal(pa.align, 'left');
  assert.ok(Math.abs(pa.indent - 20) < 1, `indent ${pa.indent}`);
  assert.equal(pa.lines.length, a.length);
  assert.ok(Math.abs(pa.leading - lead) < 0.1, `leading ${pa.leading}`);
  assert.equal(squash(pa.text), squash(LOREM));
  assert.equal(pb.align, 'justify');
  assert.equal(pb.indent, 0);
  assert.equal(squash(pb.text), squash(LOREM2));
  // 30 pt apart: more than 1.5 line heights, so two boxes
  assert.equal(r.boxes.length, 2);
});

test('a bulleted list becomes one paragraph per item, with the marker; a numbered list too', async () => {
  const size = 10, lead = 13;
  const m = (s: string) => W(s, size);
  const items = ['First item of the list', 'Second item is long enough to wrap onto a second line that hangs under the text', 'Third item'];
  const ops: DrawOp[] = [];
  let y = 700;
  for (const it of items) {
    ops.push({ t: 'text', text: '•', x: 72, y, size });
    const ls = wrap(it, 200, m);
    for (const l of ls) { ops.push({ t: 'text', text: l, x: 84, y, size }); y -= lead; }
  }
  y -= 20;
  for (const [k, it] of ['Apples', 'Pears and plums', 'Cherries'].entries()) { ops.push({ t: 'text', text: `${k + 1}. ${it}`, x: 72, y, size }); y -= lead; }
  const r = detectBoxes(await buildPage(ops));
  const ps = r.paragraphs;
  assert.equal(ps.length, 6, JSON.stringify(ps.map((p) => p.text)));
  assert.deepEqual(ps.slice(0, 3).map((p) => p.bullet), ['•', '•', '•']);
  assert.equal(ps[1].lines.length, 2);
  assert.ok(ps[1].text.startsWith('• Second item'), ps[1].text);
  assert.equal(squash(ps[1].text.slice(2)), items[1]);
  assert.deepEqual(ps.slice(3).map((p) => p.bullet), ['1.', '2.', '3.']);
  assert.equal(ps[4].text, '2. Pears and plums');
});

test('a heading above a body becomes two paragraphs (size change)', async () => {
  const m = (s: string) => W(s, 10);
  const body = wrap(LOREM, 300, m);
  const ops: DrawOp[] = [
    { t: 'text', text: 'Annual Overview', x: 72, y: 720, size: 18, font: 'helvB' },
    ...paragraphOps(body, { x: 72, y: 700, size: 10, leading: 12, width: 300, measure: m }),
  ];
  const r = detectBoxes(await buildPage(ops));
  assert.equal(r.paragraphs.length, 2);
  assert.equal(r.paragraphs[0].text, 'Annual Overview');
  assert.equal(r.paragraphs[0].size, 18);
  assert.equal(r.paragraphs[1].size, 10);
  assert.equal(squash(r.paragraphs[1].text), squash(LOREM));
  assert.equal(r.paragraphs[0].leading, 0);
});

test('a label inside a small filled rectangle is kind label with its panel', async () => {
  const m = (s: string) => W(s, 10);
  const r = detectBoxes(await buildPage([
    { t: 'rect', x: 400, y: 600, w: 90, h: 24, fill: [0.85, 0.9, 1] },
    { t: 'text', text: 'Net sales', x: 410, y: 608, size: 10 },
    ...paragraphOps(wrap(LOREM, 250, m), { x: 72, y: 700, size: 10, leading: 12, width: 250, measure: m }),
  ]));
  const label = r.boxes.find((b) => b.text === 'Net sales');
  assert.ok(label);
  assert.equal(label.kind, 'label');
  assert.notEqual(label.panel, null);
  assert.deepEqual(r.panels[label.panel!].frame, { x0: 400, y0: 600, x1: 490, y1: 624 });
  assert.deepEqual(r.panels[label.panel!].boxes, [label.id]);
  assert.equal(r.boxes.find((b) => b.text !== 'Net sales')!.kind, 'text');
  assert.equal(r.boxes.find((b) => b.text !== 'Net sales')!.panel, null);
});

test('a short line alone beside a picture is a label; the same line far from anything is text', async () => {
  const r = detectBoxes(await buildPage([
    { t: 'image', x: 300, y: 500, w: 200, h: 120 },
    { t: 'text', text: 'Figure 1', x: 300, y: 488, size: 9 },
    { t: 'text', text: 'Standalone note', x: 72, y: 300, size: 9 },
  ]));
  assert.equal(r.boxes.find((b) => b.text === 'Figure 1')!.kind, 'label');
  assert.equal(r.boxes.find((b) => b.text === 'Standalone note')!.kind, 'text');
});

test('a panel does not split a paragraph that overlaps its edge by a little', async () => {
  const m = (s: string) => W(s, 10);
  const lines = wrap(LOREM, 250, m);
  // the panel's top edge cuts 1 pt into the first line's ascenders
  const top = 700 + 7.2 - 1;
  const r = detectBoxes(await buildPage([
    { t: 'rect', x: 60, y: 600, w: 280, h: top - 600, fill: [0.95, 0.95, 0.8] },
    ...paragraphOps(lines, { x: 72, y: 700, size: 10, leading: 12, width: 250, measure: m }),
  ]));
  assert.equal(r.paragraphs.length, 1);
  assert.equal(r.boxes.length, 1);
  assert.equal(r.boxes[0].panel, 0);
});

test('a 3×3 ruled table yields 9 cells that never merge, in row-major order', async () => {
  const xs = [60, 140, 220, 300], ys = [700, 670, 640, 610];
  const ops: DrawOp[] = [];
  for (const x of xs) ops.push({ t: 'line', x1: x, y1: ys[0], x2: x, y2: ys[3] });
  for (const y of ys) ops.push({ t: 'line', x1: xs[0], y1: y, x2: xs[3], y2: y });
  const texts: string[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    // text reaches within ~6 pt of the next cell's text: closer than the 2 em line gap
    const t = c === 0 ? `Row ${r + 1} label` : `${(r + 1) * 1000 + c} units`;
    texts.push(t);
    const w = W(t, 10);
    ops.push({ t: 'text', text: t, x: c === 0 ? xs[c] + 3 : xs[c + 1] - 3 - w, y: ys[r] - 19, size: 10 });
  }
  // a second line in the centre cell
  ops.push({ t: 'text', text: 'more', x: xs[2] - 3 - W('more', 10), y: ys[1] - 28, size: 8 });
  const res = detectBoxes(await buildPage(ops));
  assert.equal(res.tables.length, 1);
  const T = res.tables[0];
  assert.equal(T.rows, 3); assert.equal(T.cols, 3);
  assert.equal(T.cells.length, 9);
  assert.equal(new Set(T.cells).size, 9);
  const cells = T.cells.map((id) => res.boxes.find((b) => b.id === id)!);
  for (const [k, b] of cells.entries()) {
    assert.equal(b.kind, 'cell');
    assert.equal(b.table, 0);
    assert.equal(b.text.split('\n')[0].replace(' more', ''), texts[k]);
  }
  assert.equal(cells[4].text, `${texts[4]}\nmore`);
  // reading order follows the rows
  assert.deepEqual(cells.map((b) => b.order), [...cells.map((b) => b.order)].sort((a, b) => a - b));
  assert.equal(res.boxes.length, 9);
});

test('vertical Japanese (Identity-V, one object per column) becomes one vertical box, right column first', async () => {
  const r = detectBoxes(await buildPage([
    { t: 'vtext', text: '縦書きの文章です。', x: 400, yTop: 700, size: 12 },
    { t: 'vtext', text: '二行目の文字列', x: 382, yTop: 700, size: 12 },
  ]));
  assert.equal(r.boxes.length, 1, JSON.stringify(textBoxes(r)));
  const b = r.boxes[0];
  assert.equal(b.vertical, true);
  assert.equal(r.lines.length, 2);
  assert.ok(r.lines.every((l) => l.vertical));
  assert.equal(r.lines[0].text, '縦書きの文章です。');
  assert.ok(Math.abs(r.lines[0].baseline - 400) < 0.5, `axis ${r.lines[0].baseline}`);
  assert.equal(b.text, '縦書きの文章です。二行目の文字列');
  assert.equal(r.paragraphs[0].leading, 18);
});

test('vertical Japanese drawn one character per object (stacked at the same x) becomes one vertical box', async () => {
  const ops: DrawOp[] = [];
  for (const [k, ch] of [...'日本語の縦組み'].entries()) ops.push({ t: 'set', text: ch, x: 300, y: 700 - k * 13, size: 12, face: 'ja' });
  const r = detectBoxes(await buildPage(ops));
  assert.equal(r.boxes.length, 1, JSON.stringify(textBoxes(r)));
  assert.equal(r.boxes[0].vertical, true);
  assert.equal(r.boxes[0].text, '日本語の縦組み');
  assert.equal(r.boxes[0].objs.length, 7);
});

test('90° and 270° rotated text each become one rotated line', async () => {
  const r = detectBoxes(await buildPage([
    { t: 'text', text: 'Rotated caption text', x: 500, y: 300, size: 12, rotate: 90 },
    { t: 'text', text: 'Downward text', x: 100, y: 500, size: 12, rotate: 270 },
  ]));
  assert.equal(r.lines.length, 2, JSON.stringify(r.lines.map((l) => l.text)));
  const up = r.lines.find((l) => l.angle === 90)!, down = r.lines.find((l) => l.angle === 270)!;
  assert.equal(up.text, 'Rotated caption text');
  assert.equal(up.words.length, 3);
  assert.ok(Math.abs(up.baseline - 500) < 0.5);
  assert.equal(down.text, 'Downward text');
  assert.equal(r.boxes.length, 2);
  assert.ok(r.boxes.every((b) => !b.vertical && b.angle !== 0));
});

test('Japanese and Latin mixed lines join without spurious spaces', async () => {
  const ops: DrawOp[] = [
    { t: 'set', text: '日本語とEnglishの混在', x: 72, y: 700, size: 12, face: 'ja' },
    // one line from three text objects in two fonts, touching
    { t: 'set', text: '価格は', x: 72, y: 650, size: 12, face: 'ja' },
    { t: 'text', text: '100', x: 108, y: 650, size: 12 },
    { t: 'set', text: '円です', x: 108 + 0, y: 650, size: 12, face: 'ja' },
    // a two-line Japanese paragraph
    { t: 'set', text: '第3四半期の売上高は前年同期比', x: 72, y: 600, size: 12, face: 'ja' },
    { t: 'set', text: '12%増となりました。', x: 72, y: 582, size: 12, face: 'ja' },
  ];
  const w100 = W('100', 12);
  (ops[3] as { x: number }).x = 108 + w100;
  const r = detectBoxes(await buildPage(ops));
  const texts = r.lines.map((l) => l.text);
  assert.ok(texts.includes('日本語とEnglishの混在'), JSON.stringify(texts));
  assert.ok(texts.includes('価格は100円です'), JSON.stringify(texts));
  const para = r.paragraphs.find((p) => p.text.startsWith('第3'))!;
  assert.equal(para.text, '第3四半期の売上高は前年同期比12%増となりました。');
  assert.equal(para.lines.length, 2);
});

test('Latin words: gaps and spaces become single spaces; a real hyphen (PDFium: U+0002) at a line end is kept', async () => {
  const r = detectBoxes(await buildPage([
    { t: 'text', text: 'A well-', x: 72, y: 700, size: 10 },
    { t: 'text', text: 'known example of text', x: 72, y: 688, size: 10 },
  ]));
  assert.equal(r.paragraphs.length, 1);
  assert.equal(r.paragraphs[0].text, 'A well-known example of text');
  assert.deepEqual(r.lines[1].words.map((w) => w.text), ['known', 'example', 'of', 'text']);
});

test('a 2,000-character page is detected in under 50 ms', async () => {
  const ops: DrawOp[] = [];
  const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'.split(' ');
  let n = 0;
  for (let col = 0; col < 2; col++) for (let k = 0; k < 50; k++) {
    let s = '';
    for (let j = 0; s.length < 20; j++) s += (s ? ' ' : '') + words[(k * 3 + j + col) % words.length];
    s = s.slice(0, 20);
    n += s.replace(/ /g, '').length;
    ops.push({ t: 'text', text: s, x: 50 + col * 270, y: 780 - k * 14 - (k >= 25 ? 30 : 0), size: 9 });
  }
  const page = await buildPage(ops);
  assert.ok(page.chars.length >= 2000, `${page.chars.length} chars (${n} ink)`);
  detectBoxes(page);   // warm up
  const times: number[] = [];
  let r!: Result;
  for (let k = 0; k < 5; k++) { r = detectBoxes(page); times.push(r.ms); }
  times.sort((a, b) => a - b);
  assert.ok(times[2] < 50, `median ${times[2].toFixed(1)} ms`);
  assert.equal(r.boxes.length, 4, JSON.stringify(r.boxes.map((b) => b.text.slice(0, 30))));
});
