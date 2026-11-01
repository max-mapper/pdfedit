#!/usr/bin/env node
// pdfedit on the command line. Every command runs locally; nothing is sent anywhere unless the translator
// command you pass does so.
//
//   node bin/pdfedit.ts detect <in.pdf> [--pages 1,3]                       boxes per page, as numbers (no text)
//   node bin/pdfedit.ts translate-fit <in.pdf> <out.pdf> --translate-cmd "<cmd> [args]" [--pages 1,3] [--no-fit] [--no-substitute]
//        [--full] [--report <report.json>] [--verify-report: write a failed verification into the report instead of failing]
//   node bin/pdfedit.ts replace <in.pdf> <out.pdf> --table <pairs.json> [--pages …]   exact paragraph replacements
//        pairs.json: [{ "from": "...", "to": "..." }] or { "<from>": "<to>" }
import { readFileSync, writeFileSync } from 'node:fs';
import { openPdfium } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
import { readPage } from '../src/model/build.ts';
import { translateAndFit, commandTranslator, tableTranslator } from '../src/pipeline.ts';

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);
const pagesOpt = () => flag('--pages')?.split(',').map((s) => Number(s.trim()) - 1).filter((n) => n >= 0);
const usage = () => { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(2); };

const [cmd, a, b] = argv;
if (cmd === 'detect' && a) {
  const P = await openPdfium();
  const doc = P.open(new Uint8Array(readFileSync(a)));
  const pages = pagesOpt() ?? [...Array(doc.pageCount).keys()];
  for (const i of pages) {
    const pg = doc.page(i);
    const input = readPage(pg);
    const r = detectBoxes(input);
    console.log(JSON.stringify({ page: i + 1, chars: input.chars.length, boxes: r.boxes.length, labels: r.boxes.filter((x) => x.kind === 'label').length,
      cells: r.boxes.filter((x) => x.kind === 'cell').length, vertical: r.boxes.filter((x) => x.vertical).length, panels: r.panels.length, tables: r.tables.length, ms: +r.ms.toFixed(1) }));
    pg.close();
  }
  doc.close();
} else if ((cmd === 'translate-fit' || cmd === 'replace') && a && b) {
  let translate;
  if (cmd === 'replace') {
    const t = JSON.parse(readFileSync(flag('--table') ?? usage()!, 'utf8'));
    const table: Record<string, string> = Array.isArray(t) ? Object.fromEntries(t.map((x: { from: string; to: string }) => [x.from, x.to])) : t;
    translate = tableTranslator(table);
  } else {
    const tc = flag('--translate-cmd'); if (!tc) usage();
    const [c, ...rest] = tc!.split(' ').filter(Boolean);
    translate = commandTranslator(c, rest);
  }
  const res = await translateAndFit(new Uint8Array(readFileSync(a)), {
    pages: pagesOpt(), translate, fit: !has('--no-fit'), substitute: !has('--no-substitute'), incremental: !has('--full'), verify: has('--verify-report') ? 'report' : true,
    needsTranslation: cmd === 'replace' ? () => true : undefined,
  });
  if (res.bytes) writeFileSync(b, res.bytes);
  const unfit = res.fit.flatMap((f) => f.boxes.filter((x) => x.result === 'unfit').map((x) => ({ page: f.page + 1, box: x.box, charsOver: x.charsOver })));
  const summary = { out: res.bytes ? b : null, ...res.stats, fitted: res.fit.reduce((n, f) => n + f.boxes.filter((x) => x.result === 'fixed').length, 0), unfit: unfit.length,
    skipped: res.export?.pages.reduce((n, p) => n + p.skipped.length, 0) ?? 0 };
  const reportPath = flag('--report');
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ summary, substitutions: res.substitutions, shortened: res.shortened, fit: res.fit, export: res.export }, null, 1));
  console.log(JSON.stringify(summary));
} else usage();
