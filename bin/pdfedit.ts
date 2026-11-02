#!/usr/bin/env node
// pdfedit on the command line. Every command runs locally.
//
//   node bin/pdfedit.ts detect <in.pdf> [--pages 1,3]                       boxes per page, as numbers (no text)
//   node bin/pdfedit.ts objects <in.pdf> [--pages 1,3] [--json]             the page objects in paint order (kind, id, bounds; no text)
//   node bin/pdfedit.ts replace <in.pdf> <out.pdf> --table <pairs.json> [--pages 1,3] [--no-substitute] [--full]
//        [--report <report.json>] [--verify-report: write a failed verification into the report instead of failing]
//        exact paragraph replacements; pairs.json: [{ "from": "...", "to": "..." }] or { "<from>": "<to>" }
// More commands load from bin/commands/<name>.ts when present (each exports run(argv) and starts with its usage lines).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { openPdfium } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
import { readPage } from '../src/model/build.ts';
import { replaceText } from '../src/export/replace.ts';
import { listObjects, objectLine } from '../src/objects/list.ts';

const COMMANDS = new URL('./commands/', import.meta.url);
const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);
const pagesOpt = () => flag('--pages')?.split(',').map((s) => Number(s.trim()) - 1).filter((n) => n >= 0);
const leading = (u: URL) => readFileSync(u, 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3));
const extra = () => (existsSync(COMMANDS) ? readdirSync(COMMANDS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')).sort() : []);
const usage = () => {
  console.error([...leading(new URL(import.meta.url)), ...extra().flatMap((f) => leading(new URL(f, COMMANDS)))].join('\n'));
  process.exit(2);
};

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
} else if (cmd === 'objects' && a) {
  const pages = await listObjects(new Uint8Array(readFileSync(a)), pagesOpt());
  for (const p of pages) {
    if (has('--json')) { console.log(JSON.stringify(p)); continue; }
    console.log(`page ${p.page + 1}: ${p.objects.length} objects (${p.view.rotate}°, ${p.view.w} × ${p.view.h} pt)${p.notes.length ? ` · ${p.notes.join('; ')}` : ''}`);
    for (const o of p.objects) console.log(`  ${objectLine(o)}`);
  }
} else if (cmd === 'replace' && a && b) {
  const t = JSON.parse(readFileSync(flag('--table') ?? usage()!, 'utf8'));
  const table: Record<string, string> = Array.isArray(t) ? Object.fromEntries(t.map((x: { from: string; to: string }) => [x.from, x.to])) : t;
  const res = await replaceText(new Uint8Array(readFileSync(a)), table, {
    pages: pagesOpt(), substitute: !has('--no-substitute'), incremental: !has('--full'), verify: has('--verify-report') ? 'report' : true,
  });
  if (res.bytes) writeFileSync(b, res.bytes);
  const summary = { out: res.bytes ? b : null, ...res.stats, replaced: res.replaced.length, overflow: res.overflow.length,
    skipped: res.export?.pages.reduce((n, p) => n + p.skipped.length, 0) ?? 0 };
  const reportPath = flag('--report');
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ summary, replaced: res.replaced, overflow: res.overflow, substitutions: res.substitutions, export: res.export }, null, 1));
  console.log(JSON.stringify(summary));
} else if (cmd && extra().includes(`${cmd}.ts`)) {
  const mod = (await import(new URL(`${cmd}.ts`, COMMANDS).href)) as { run(args: string[]): Promise<void> };
  await mod.run(argv.slice(1));
} else usage();
