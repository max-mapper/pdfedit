// PDFium, detection and export in a dedicated worker (the app's main thread holds the model and draws the preview).
// The WASM comes from this build (Vite `?url`), never from a CDN. Besides rendering and detection (as web/worker.ts),
// the worker runs exports: the per-page "commit" (one page's current model exported in the background, verified in
// 'report' mode, and the result rendered, so the page can show the real PDF instead of the preview) and the final
// export of the whole document. Export lays the boxes out again here with the same fonts and code as the main thread
// (src/model/layout.ts is deterministic), so the glyphs written are the glyphs previewed.
import { prepareSubstitutes } from '../src/fonts/apply.ts';
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { openPdfium, type PdfDoc } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
import { buildPageFrom, readPage } from '../src/model/build.ts';
import { LayoutCache } from '../src/model/layout.ts';
import type { FontRegistry } from '../src/model/fonts.ts';
import type { Doc, Page } from '../src/model/types.ts';
import { ExportError, exportDoc, type ExportOptions, type ExportReport } from '../src/export/export.ts';
import '../src/export/objects.ts';   // export writes the pages' object edits (Page.objectOps)
import { loadAppFonts } from './assets.ts';
import type { CommitResult, Req, Res } from './protocol.ts';
import { loadOps, type OpContext } from './opshost.ts';
import { openForEdit, type PdfEdit } from '../src/pdf/edit.ts';
import type { ViewBox } from '../src/engine/view.ts';

const P = fetch(wasmUrl).then((r) => r.arrayBuffer()).then((wasmBinary) => openPdfium({ wasmBinary }));
let fontsP: Promise<FontRegistry> | null = null;
const fonts = () => (fontsP ??= loadAppFonts());

let original: Uint8Array | null = null;
let doc: PdfDoc | null = null;
let editP: Promise<PdfEdit> | null = null;
// worker ops (app/ops/*.ts): the modules load with the worker, so their page builders and export writers apply to
// every page this worker builds and every export it runs
const ops = loadOps();
/** Committed exports per page, most recent last; a few are kept (each holds a copy of the file in PDFium's heap). */
const committed = new Map<number, { id: number; doc: PdfDoc }>();
const KEEP_COMMITTED = 4;
const latestCommit = new Map<number, number>();
const minVersion = new Map<number, number>();
let chain: Promise<unknown> = Promise.resolve();   // exports run one at a time; renders interleave with them

const post = (m: Res, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

function exportOptions(F: FontRegistry, pdfium: Awaited<typeof P>): ExportOptions {
  // `faces`: export's default resolver reads fonts/ with node:fs, so a browser passes its own (runs carry their face
  // anyway; this is the fallback)
  return { pdfium, faces: (f) => F.face(f), incremental: true, verify: 'report', maxPixelsOutside: 250 };
}

function closeAll() {
  doc?.close();
  doc = null;
  editP = null;
  for (const c of committed.values()) c.doc.close();
  committed.clear();
  latestCommit.clear();
  minVersion.clear();
}

function docFor(source: 'orig' | 'commit', n: number, commitId?: number): PdfDoc | null {
  if (source === 'orig') return doc;
  const c = committed.get(n);
  return c && c.id === commitId ? c.doc : null;
}

async function commit(m: Extract<Req, { kind: 'commit' }>): Promise<void> {
  const t0 = performance.now();
  const base: CommitResult = { kind: 'committed', n: m.n, id: m.id, version: m.version, stale: false, scale: m.scale, written: [], skipped: [], failures: [], ms: 0 };
  if ((latestCommit.get(m.n) ?? 0) > m.id || (minVersion.get(m.n) ?? 0) > m.version || !original) { post({ ...base, stale: true }); return; }
  const [pdfium, F] = await Promise.all([P, fonts()]);
  const one: Doc = { pages: [] };
  one.pages[m.n] = m.page;
  await prepareSubstitutes(one, F, { pages: [m.n], all: true });   // the same faces the main thread drew with
  const cache = new LayoutCache(F);
  let bytes: Uint8Array | null = null;
  let report: ExportReport;
  try {
    const out = await exportDoc(original, one, (pn, b) => cache.get(pn, b), exportOptions(F, pdfium));
    bytes = out.bytes;
    report = out.report;
  } catch (e) {
    if (!(e instanceof ExportError)) throw e;
    report = e.report;
  }
  // a newer edit may have arrived while exporting
  if ((latestCommit.get(m.n) ?? 0) > m.id || (minVersion.get(m.n) ?? 0) > m.version) { post({ ...base, stale: true, ms: Math.round(performance.now() - t0) }); return; }
  const pr = report.pages.find((p) => p.page === m.n);
  base.written = pr?.written.map((w) => w.box) ?? [];
  base.skipped = pr?.skipped ?? [];
  base.failures = report.failures;
  if (pr?.objectsSkipped?.length) base.objectsSkipped = pr.objectsSkipped.map((x) => ({ id: x.id, reason: x.reason }));
  if (bytes) {
    const d = pdfium.open(bytes);
    const pg = d.page(m.n);
    try {
      const bmp = pg.render(m.scale);
      base.rgba = bmp.rgba.buffer;
      base.width = bmp.width;
      base.height = bmp.height;
    } finally { pg.close(); }
    committed.get(m.n)?.doc.close();
    committed.delete(m.n);
    committed.set(m.n, { id: m.id, doc: d });
    while (committed.size > KEEP_COMMITTED) {
      const [k, v] = committed.entries().next().value!;
      v.doc.close();
      committed.delete(k);
    }
  }
  base.ms = Math.round(performance.now() - t0);
  post(base, base.rgba ? [base.rgba] : []);
}

async function exportAll(m: Extract<Req, { kind: 'export' }>): Promise<void> {
  if (!original) { post({ kind: 'exported', id: m.id, bytes: null, report: null, error: 'no document is open' }); return; }
  const [pdfium, F] = await Promise.all([P, fonts()]);
  await prepareSubstitutes(m.doc, F, { all: true });
  const cache = new LayoutCache(F);
  try {
    const { bytes, report } = await exportDoc(original, m.doc, (pn, b) => cache.get(pn, b), exportOptions(F, pdfium));
    const buf = bytes.slice().buffer;
    post({ kind: 'exported', id: m.id, bytes: buf, report, error: null }, [buf]);
  } catch (e) {
    if (e instanceof ExportError) post({ kind: 'exported', id: m.id, bytes: null, report: e.report, error: e.message });
    else throw e;
  }
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const m = e.data;
  try {
    const pdfium = await P;
    if (m.kind === 'open') {
      closeAll();
      const t0 = performance.now();
      original = new Uint8Array(m.bytes);
      doc = pdfium.open(original);
      const sizes: { w: number; h: number }[] = [];
      const views: ViewBox[] = [];
      for (let i = 0; i < doc.pageCount; i++) { const pg = doc.page(i); sizes.push({ ...pg.size }); views.push(pg.view); pg.close(); }
      post({ kind: 'opened', sizes, views, ms: Math.round(performance.now() - t0) });
      fonts().catch(() => {});   // warm the worker's fonts for the first commit
    } else if (m.kind === 'render') {
      const d = docFor(m.source, m.n, m.commitId);
      if (!d) { post({ kind: 'render-missing', req: m.req, n: m.n, commitId: m.commitId }); return; }
      const t0 = performance.now();
      const pg = d.page(m.n);
      try {
        const bmp = pg.render(m.scale);
        const ms = Math.round(performance.now() - t0);
        let page: Page | null = null;
        let detectMs = 0, chars = 0, objs = 0;
        if (m.model && m.source === 'orig') {
          const t1 = performance.now();
          const input = readPage(pg);
          chars = input.chars.length;
          objs = input.textObjects.length;
          page = buildPageFrom(m.n, input, detectBoxes(input));
          detectMs = Math.round(performance.now() - t1);
        }
        const rgba = bmp.rgba.buffer;
        post({ kind: 'render', req: m.req, n: m.n, scale: m.scale, source: m.source, commitId: m.commitId, rgba, width: bmp.width,
          height: bmp.height, page, chars, objs, ms, detectMs }, [rgba]);
      } finally { pg.close(); }
    } else if (m.kind === 'thumb') {
      const d = docFor(m.source, m.n, m.commitId);
      if (!d) return;
      const pg = d.page(m.n);
      try {
        const bmp = pg.render(m.scale);
        post({ kind: 'thumb', n: m.n, source: m.source, rgba: bmp.rgba.buffer, width: bmp.width, height: bmp.height }, [bmp.rgba.buffer]);
      } finally { pg.close(); }
    } else if (m.kind === 'op') {
      const fn = ops.get(m.op);
      if (!fn) { post({ kind: 'op-result', id: m.id, error: `no worker op ${m.op}` }); return; }
      const ctx: OpContext = {
        pdfium, original: () => original, doc: () => doc,
        edit: () => { if (!original) return Promise.reject(new Error('no document is open')); return (editP ??= openForEdit(original)); },
      };
      try { post({ kind: 'op-result', id: m.id, result: await fn(ctx, m.args) }); } catch (err) {
        post({ kind: 'op-result', id: m.id, error: String((err as Error).message || err) });
      }
    } else if (m.kind === 'invalidate') {
      minVersion.set(m.n, Math.max(minVersion.get(m.n) ?? 0, m.version));
    } else if (m.kind === 'commit') {
      latestCommit.set(m.n, Math.max(latestCommit.get(m.n) ?? 0, m.id));
      chain = chain.then(() => commit(m)).catch((err) => {
        post({ kind: 'committed', n: m.n, id: m.id, version: m.version, stale: false, scale: m.scale, written: [], skipped: [],
          failures: [`export refused: ${String((err as Error).message || err)}`], ms: 0 });
      });
    } else if (m.kind === 'export') {
      chain = chain.then(() => exportAll(m)).catch((err) => {
        post({ kind: 'exported', id: m.id, bytes: null, report: null, error: String((err as Error).message || err) });
      });
    }
  } catch (err) {
    post({ kind: 'error', message: String((err as Error).message || err), context: m.kind });
  }
};
