// Worker ops: optional handlers in the PDFium worker (app/ops/*.ts, loaded by app/worker.ts when present), called from
// the main thread by name (ToolHost.callWorker). An op reads the open document through the context and answers with
// structured-cloneable data. Ops run in order with renders and exports.
import type { Pdfium, PdfDoc } from '../src/engine/pdfium.ts';
import type { PdfEdit } from '../src/pdf/edit.ts';

export type OpContext = {
  pdfium: Pdfium;
  /** The open document's bytes, or null. */
  original(): Uint8Array | null;
  /** The open document in PDFium, or null. */
  doc(): PdfDoc | null;
  /** The open document parsed for editing (pdf-lib), made once per document. */
  edit(): Promise<PdfEdit>;
};

export type Op = (ctx: OpContext, args: unknown) => unknown | Promise<unknown>;
export type OpModule = { ops: Record<string, Op> };

/** Every op of the modules present in this build. A name defined twice is an error. */
export function loadOps(): Map<string, Op> {
  const mods = import.meta.glob<OpModule>('./ops/*.ts', { eager: true });
  const out = new Map<string, Op>();
  for (const key of Object.keys(mods).sort()) {
    for (const [name, fn] of Object.entries(mods[key].ops ?? {})) {
      if (out.has(name)) throw new Error(`worker op ${name} is defined twice (${key})`);
      out.set(name, fn);
    }
  }
  return out;
}
