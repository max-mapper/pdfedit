// The sample document (src/objects/sample.ts): two pages, the second turned by /Rotate 90; paragraph boxes to edit,
// one of them with two paragraphs to split; a picture, a logo and a chart that are proposed as groups, a badge form; and
// a picture on the turned page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openPdfium } from '../engine/pdfium.ts';
import { detectBoxes } from '../layout/detect.ts';
import { autoGroups } from './groups.ts';
import { listObjects } from './list.ts';
import { samplePdf, SAMPLE_AT } from './sample.ts';

type R = { x0: number; y0: number; x1: number; y1: number };
const near = (a: R, b: R, tol = 1.5) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;

test('the sample: text boxes on both pages, one of two paragraphs; the second page turned', async () => {
  const bytes = await samplePdf();
  const P = await openPdfium();
  const doc = P.open(bytes);
  assert.equal(doc.pageCount, 2);
  const boxes = [0, 1].map((n) => {
    const pg = doc.page(n);
    return detectBoxes({ w: pg.size.w, h: pg.size.h, chars: pg.chars(), textObjects: pg.textObjects(), shapes: pg.shapes() }).boxes;
  });
  assert.ok(boxes[0].length >= 10, `page 1: ${boxes[0].length} boxes`);
  assert.ok(boxes[0].some((b) => b.paragraphs.length === 2), 'a box of two paragraphs, to split');
  assert.ok(boxes[1].length >= 2, `page 2: ${boxes[1].length} boxes`);
  const [, turned] = await listObjects(bytes);
  assert.equal(turned.view.rotate, 90);
  doc.close();
});

test('the sample: the picture, the logo, the chart and the badge are objects to select; logo and chart are proposed groups', async () => {
  const [m, turned] = await listObjects(await samplePdf());
  const picture = m.objects.find((o) => o.kind === 'image' && near(o.bounds, SAMPLE_AT.picture));
  assert.ok(picture, 'the picture');
  const badge = m.objects.find((o) => o.kind === 'form' && near(o.bounds, SAMPLE_AT.badge));
  assert.ok(badge, 'the badge form');
  const groups = autoGroups(m).filter((g) => g.parent === null);
  const inside = (r: R, c: R) => r.x0 >= c.x0 - 3 && r.y0 >= c.y0 - 3 && r.x1 <= c.x1 + 3 && r.y1 <= c.y1 + 3;
  assert.ok(groups.some((g) => g.why === 'marked' && inside(g.bounds, SAMPLE_AT.logo)), `the logo: ${JSON.stringify(groups.map((g) => g.bounds))}`);
  assert.ok(groups.some((g) => near(g.bounds, SAMPLE_AT.chart, 2)), `the chart: ${JSON.stringify(groups.map((g) => g.bounds))}`);
  assert.ok(turned.objects.some((o) => o.kind === 'image' && near(o.bounds, SAMPLE_AT.turnedPicture)), 'the picture on the turned page');
});
