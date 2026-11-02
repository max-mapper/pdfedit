// PDFium and box detection in a dedicated worker. The WASM comes from this app's own build (Vite `?url`), never from
// a CDN: the package's default URL points at jsDelivr, which would make the editor depend on, and talk to, an outside
// host. The worker reads a page, detects its boxes, builds the model page (src/model/build.ts) and renders the
// bitmap; the main thread holds the model from then on.
import wasmUrl from '@embedpdf/pdfium/pdfium.wasm?url';
import { openPdfium, type PdfDoc } from '../src/engine/pdfium.ts';
import { detectBoxes } from '../src/layout/detect.ts';
import { buildPageFrom, readPage } from '../src/model/build.ts';
import type { Page } from '../src/model/types.ts';

// optional modules for the worker (web/tools/*.worker.ts): loaded with it, so their page builders apply to every page
import.meta.glob('./tools/*.worker.ts', { eager: true });

export type WorkerReq =
  | { kind: 'open'; bytes: ArrayBuffer }
  /** Render page `n` at `scale` device pixels per point; `model: true` also detects and sends the model page. */
  | { kind: 'page'; n: number; scale: number; model: boolean };

export type WorkerRes =
  | { kind: 'opened'; pages: number }
  | { kind: 'page'; n: number; rgba: ArrayBuffer; width: number; height: number; page: Page | null; chars: number; objs: number; ms: number; detectMs: number }
  | { kind: 'error'; message: string };

let doc: PdfDoc | null = null;
const ready = fetch(wasmUrl).then((r) => r.arrayBuffer()).then((wasmBinary) => openPdfium({ wasmBinary }));
const post = (m: WorkerRes, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerReq>) => {
  const P = await ready;
  const m = e.data;
  try {
    if (m.kind === 'open') {
      doc?.close();
      doc = P.open(new Uint8Array(m.bytes));
      post({ kind: 'opened', pages: doc.pageCount });
    } else if (m.kind === 'page' && doc) {
      const t0 = performance.now();
      const pg = doc.page(m.n);
      try {
        const bmp = pg.render(m.scale);
        const input = readPage(pg);
        const ms = Math.round(performance.now() - t0);
        let page: Page | null = null;
        let detectMs = 0;
        if (m.model) {
          const t1 = performance.now();
          page = buildPageFrom(m.n, input, detectBoxes(input));
          detectMs = Math.round(performance.now() - t1);
        }
        const rgba = bmp.rgba.buffer;
        post({ kind: 'page', n: m.n, rgba, width: bmp.width, height: bmp.height, page, chars: input.chars.length,
          objs: input.textObjects.length, ms, detectMs }, [rgba]);
      } finally { pg.close(); }
    }
  } catch (err) {
    post({ kind: 'error', message: String((err as Error).message || err) });
  }
};
