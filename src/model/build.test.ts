// buildPage on synthetic pages: boxes, runs (size, colour, bold, measured character spacing) and source state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdfium } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { buildPdf } from '../layout/testkit.ts';
import { buildDoc, buildPage, readPage } from './build.ts';
import type { Box, Page } from './types.ts';

async function modelOf(bytes: Uint8Array): Promise<Page> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try {
    const pg = doc.page(0);
    const input = readPage(pg);
    const page = buildPage(pg, detectBoxes(input), { input });
    pg.close();
    return page;
  } finally { doc.close(); }
}

const textOf = (b: Box) => b.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const find = (p: Page, s: string) => {
  const b = p.boxes.find((x) => textOf(x).includes(s));
  assert.ok(b, `no box with '${s}': ${JSON.stringify(p.boxes.map(textOf))}`);
  return b;
};

test('runs carry size, colour, bold and the document font; source state is filled', async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Quarterly Overview', { x: 60, y: 760, size: 18, font: bold, color: rgb(0.8, 0.1, 0.1) });
  const body = ['The committee met twice and the figures rose', 'in every region that reported on time, with the',
    'remaining regions expected to follow next month.'];
  body.forEach((t, k) => page.drawText(t, { x: 60, y: 700 - k * 13, size: 10, font: helv }));
  page.drawText('A note beside', { x: 330, y: 700, size: 10, font: helv, color: rgb(0, 0, 1) });
  const m = await modelOf(await doc.save({ useObjectStreams: false }));

  const head = find(m, 'Quarterly');
  assert.equal(head.paragraphs.length, 1);
  const hr = head.paragraphs[0].runs;
  assert.equal(hr.length, 1);
  assert.equal(hr[0].text, 'Quarterly Overview');
  assert.equal(hr[0].size, 18);
  assert.equal(hr[0].bold, true);
  assert.equal(hr[0].font.source, 'document');
  assert.match(hr[0].font.name, /Helvetica-Bold/);
  assert.deepEqual(hr[0].color.map((c) => Math.round(c * 10) / 10), [0.8, 0.1, 0.1]);
  assert.equal(head.locked, null);
  assert.equal(head.edited, false);

  const para = find(m, 'committee');
  assert.equal(para.paragraphs.length, 1);
  const pr = para.paragraphs[0].runs;
  assert.equal(pr.length, 1, JSON.stringify(pr.map((r) => r.text)));
  assert.equal(pr[0].text, body.join(' '));
  assert.equal(pr[0].bold, false);
  assert.equal(pr[0].size, 10);
  assert.equal(pr[0].charSpacing, 0);
  assert.ok(Math.abs(para.paragraphs[0].leading - 1.3) < 0.01, `leading ${para.paragraphs[0].leading}`);
  const s = para.source;
  assert.equal(s.lines, 3);
  assert.deepEqual(s.frame, para.frame);
  assert.equal(s.paragraphs[0].text, body.join(' '));
  assert.equal(s.paragraphs[0].size, 10);
  assert.ok(s.objs.length === 3, `objs ${s.objs}`);
  assert.ok(s.chars.length >= body.join('').replace(/ /g, '').length);
  assert.ok(s.baseline! > 8.5 && s.baseline! < 10, `baseline ${s.baseline}`);   // the frame is the em box: ascent ≈ 0.95 em
  assert.equal(s.panel, null);

  const note = find(m, 'beside');
  assert.deepEqual(note.paragraphs[0].runs[0].color, [0, 0, 1]);
  assert.ok(!note.source.neighbours.includes(para.id), 'apart boxes are not neighbours');
});

test('character spacing is measured from the characters; vertical text is editable; pictures and panels', async () => {
  const bytes = await buildPdf([
    { t: 'set', text: 'Tracked', x: 60, y: 760, size: 12, face: 'sans', spacing: 1.5 },
    { t: 'set', text: 'Plain words', x: 60, y: 700, size: 12, face: 'sans' },
    { t: 'vtext', text: '縦書きの見出し', x: 500, yTop: 780, size: 14 },
    { t: 'rect', x: 50, y: 400, w: 240, h: 120, fill: [0.9, 0.9, 1] },
    { t: 'text', text: 'Inside the panel', x: 70, y: 480, size: 11 },
    { t: 'text', text: 'Also inside it', x: 70, y: 430, size: 11 },
    { t: 'image', x: 350, y: 380, w: 150, h: 150 },
    { t: 'text', text: 'Touching A', x: 60, y: 300, size: 10 },
    { t: 'text', text: 'Touching B', x: 112, y: 300, size: 10 },
  ]);
  const m = await modelOf(bytes);
  const tracked = find(m, 'Tracked');
  assert.equal(tracked.paragraphs[0].runs[0].charSpacing, 1.5);
  assert.equal(tracked.source.charSpacing, 1.5);
  assert.equal(find(m, 'Plain').paragraphs[0].runs[0].charSpacing, 0);

  const v = m.boxes.find((b) => b.vertical);
  assert.ok(v, 'a vertical box');
  assert.equal(v.locked, null);
  assert.equal(v.writingMode, 'vertical-rl');
  assert.ok(v.source.axis! > 0 && Math.abs(v.frame.x1 - v.source.axis! - 500) < 0.5, `axis ${v.source.axis}`);

  const inside = find(m, 'Inside the panel');
  assert.ok(inside.source.panel, 'the panel is recorded');
  assert.ok(Math.abs(inside.source.panel!.x0 - 50) < 1 && Math.abs(inside.source.panel!.y1 - 520) < 1);
  assert.ok(m.panels.length >= 1);
  assert.ok(m.obstacles.some((r) => Math.abs(r.x0 - 350) < 1 && Math.abs(r.y1 - 530) < 1), JSON.stringify(m.obstacles));

  // two boxes on one baseline whose frames meet are neighbours (when detection keeps them apart)
  const a = find(m, 'Touching A'), b = find(m, 'Touching B');
  if (a !== b) assert.ok(a.source.neighbours.includes(b.id) && b.source.neighbours.includes(a.id));
});

test('rotated text is locked as rotated; buildDoc covers every page', async () => {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([400, 400]);
  p1.drawText('Upright line', { x: 40, y: 300, size: 12, font: helv });
  const p2 = doc.addPage([400, 400]);
  const { degrees } = await import('pdf-lib');
  p2.drawText('Turned line of text', { x: 200, y: 60, size: 12, font: helv, rotate: degrees(90) });
  const P = await openPdfium();
  const pdf = P.open(await doc.save({ useObjectStreams: false }));
  try {
    const d = buildDoc(pdf);
    assert.equal(d.pages.length, 2);
    assert.deepEqual([d.pages[0].n, d.pages[1].n], [0, 1]);
    assert.equal(d.pages[0].boxes[0].locked, null);
    const turned = d.pages[1].boxes[0];
    assert.ok(turned, 'a box on page 2');
    assert.equal(turned.locked, 'rotated text');
    assert.equal(turned.rot, 90);
    // a plain-data model: it survives structured clone (the worker posts it to the main thread)
    assert.deepEqual(structuredClone(d), d);
  } finally { pdf.close(); }
});
