// The deck bench: pdfedit's pipeline on a list of PDF pages, rendering each page as original, English (no fit) and
// English fitted, for a judge and the compare viewer. Cases and outputs live outside the repository (private documents).
//   node scripts/bench-decks.ts --cases <cases.json> --out <dir> --translate-cmd "<cmd> [args]" [--width 1280] [--only d01,d02]
//     [--shorten-cmd "<cmd> [args]"]   targeted shortening of unfit and over-shrunk boxes (listed in report.json)
// cases.json: [{ "key": "d01", "pdf": "/abs/d01.pdf", "pages": [1, 2, 3] }]   (1-based pages)
// Writes <out>/<key>/p<n>-{orig,en,fit}.png, <out>/<key>/{en,fit}.pdf, <out>/<key>/report.json and <out>/bench.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openPdfium } from '../src/engine/pdfium.ts';
import { toPng } from '../src/engine/png.ts';
import { loadFonts } from '../src/model/fonts.ts';
import { translateAndFit, commandTranslator, commandShortener } from '../src/pipeline.ts';

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const out = resolve(arg('--out')!);
if (out.startsWith(resolve(import.meta.dirname, '..'))) { console.error('--out must be outside the repository'); process.exit(2); }
const cases: { key: string; pdf: string; pages: number[] }[] = JSON.parse(readFileSync(arg('--cases')!, 'utf8'));
const only = arg('--only')?.split(',');
const width = Number(arg('--width', '1280'));
const [cmd, ...cmdArgs] = arg('--translate-cmd')!.split(' ').filter(Boolean);
const translate = commandTranslator(cmd, cmdArgs);
const shortenCmd = arg('--shorten-cmd')?.split(' ').filter(Boolean);
const shorten = shortenCmd ? commandShortener(shortenCmd[0], shortenCmd.slice(1)) : undefined;
const P = await openPdfium();
const fonts = await loadFonts();
mkdirSync(out, { recursive: true, mode: 0o700 });
const rows: unknown[] = [];

function render(bytes: Uint8Array, pages: number[], dir: string, suffix: string) {
  const doc = P.open(bytes);
  try {
    for (const n of pages) {
      const pg = doc.page(n - 1);
      writeFileSync(join(dir, `p${n}-${suffix}.png`), toPng(pg.render(width / pg.size.w)));
      pg.close();
    }
  } finally { doc.close(); }
}

for (const c of cases) {
  if (only && !only.includes(c.key)) continue;
  const dir = join(out, c.key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bytes = new Uint8Array(readFileSync(c.pdf));
  const row: Record<string, unknown> = { key: c.key, pages: c.pages.length };
  const t0 = performance.now();
  try {
    render(bytes, c.pages, dir, 'orig');
    const pages0 = c.pages.map((n) => n - 1);
    const en = await translateAndFit(bytes, { pages: pages0, translate, fit: false, verify: 'report', pdfium: P, fonts });
    const fit = await translateAndFit(bytes, { pages: pages0, translate, fit: true, verify: 'report', pdfium: P, fonts, shorten });
    for (const [name, res] of [['en', en], ['fit', fit]] as const) {
      const b = res.bytes ?? bytes;
      writeFileSync(join(dir, `${name}.pdf`), b);
      render(b, c.pages, dir, name);
    }
    const unfit = fit.fit.flatMap((f) => f.boxes.filter((x) => x.result === 'unfit').map((x) => ({ page: f.page + 1, box: x.box, charsOver: x.charsOver })));
    const verifyFailed = (fit.export?.pages ?? []).filter((p) => p.verify && !p.verify.ok).map((p) => p.page + 1);
    Object.assign(row, { ...fit.stats, fitted: fit.fit.reduce((n, f) => n + f.boxes.filter((x) => x.result === 'fixed').length, 0), unfit: unfit.length,
      skipped: (fit.export?.pages ?? []).reduce((n, p) => n + p.skipped.length, 0), verifyFailed, shortened: fit.shortened.length, s: Math.round((performance.now() - t0) / 1000) });
    writeFileSync(join(dir, 'report.json'), JSON.stringify({ row, fit: fit.fit, shortened: fit.shortened, export: fit.export }, null, 1));
  } catch (e) { row.error = String((e as Error).message || e).slice(0, 300); }
  rows.push(row);
  console.log(JSON.stringify(row));
}
writeFileSync(join(out, 'bench.json'), JSON.stringify(rows, null, 1));
