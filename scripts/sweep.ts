// Robustness sweep: open every page of every listed PDF with PDFium, read characters, text objects and
// shapes, run box detection, and record failures and timings. Writes numbers only (no text) to --out.
//   node scripts/sweep.ts --list <files.txt> --out <report.json> [--max-pages 60]
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { openPdfium } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const list = readFileSync(arg('--list')!, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const out = resolve(arg('--out')!);
if (out.startsWith(resolve(import.meta.dirname, '..'))) { console.error('--out must be outside the repository'); process.exit(2); }
const maxPages = Number(arg('--max-pages', '60'));
const P = await openPdfium();
const files: unknown[] = [];
let pages = 0, failures = 0, slowest = 0;
const times: number[] = [];
for (const [fi, f] of list.entries()) {
  const row: Record<string, unknown> = { file: fi, kb: Math.round(statSync(f).size / 1024) };
  try {
    const doc = P.open(new Uint8Array(readFileSync(f)));
    row.pages = doc.pageCount;
    const errs: { page: number; error: string }[] = [];
    let chars = 0, boxes = 0, ms = 0;
    for (let i = 0; i < Math.min(doc.pageCount, maxPages); i++) {
      try {
        const pg = doc.page(i);
        const input = { w: pg.size.w, h: pg.size.h, chars: pg.chars(), textObjects: pg.textObjects(), shapes: pg.shapes() };
        const t0 = performance.now();
        const r = detectBoxes(input);
        const t = performance.now() - t0;
        times.push(t); slowest = Math.max(slowest, t); ms += t;
        chars += input.chars.length; boxes += r.boxes.length; pages++;
        pg.close();
      } catch (e) { errs.push({ page: i + 1, error: String((e as Error).message || e).slice(0, 160) }); failures++; }
    }
    doc.close();
    Object.assign(row, { chars, boxes, detect_ms: Math.round(ms), errors: errs });
  } catch (e) { row.open_error = String((e as Error).message || e).slice(0, 160); failures++; }
  files.push(row);
}
times.sort((a, b) => a - b);
const summary = { files: list.length, pages, failures, detect_ms_median: +(times[Math.floor(times.length / 2)] ?? 0).toFixed(1),
  detect_ms_p95: +(times[Math.floor(times.length * 0.95)] ?? 0).toFixed(1), detect_ms_max: +slowest.toFixed(1),
  rss_mb: Math.round(process.memoryUsage().rss / 1e6) };
writeFileSync(out, JSON.stringify({ summary, files }, null, 1));
console.log(JSON.stringify(summary));
