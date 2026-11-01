// Debug: our boxes on one page as numbers (frames, kinds, paragraphs with size, alignment and line count, text
// length), never the text itself, so the output can be shared without the document's text.
//   node scripts/dump-boxes.ts <file.pdf> <page> [thresholds-json]
import { readFileSync } from 'node:fs';
import { openPdfium } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
const [file, pg, th] = process.argv.slice(2);
const P = await openPdfium(); const doc = P.open(new Uint8Array(readFileSync(file))); const page = doc.page(Number(pg) - 1);
const res = detectBoxes({ w: page.size.w, h: page.size.h, chars: page.chars(), textObjects: page.textObjects(), shapes: page.shapes() }, th ? { thresholds: JSON.parse(th) } : {});
const r = (v: number) => Math.round(v);
for (const b of res.boxes) {
  console.log(b.id, b.kind, `[${r(b.frame.x0)},${r(b.frame.y0)},${r(b.frame.x1)},${r(b.frame.y1)}]`, 'panel', b.panel, 'paras', b.paragraphs.map((k) => {
    const p = res.paragraphs[k]; return `${p.lines.length}L/${p.size.toFixed(1)}pt/${p.align}/${[...p.text].length}c`;
  }).join(' | '));
}
