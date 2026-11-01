// A PDF opened for content-stream editing: decode a page's contents, replace or extend them, save incrementally.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';
import { fontInfoFromDict, inheritedResources, lookupByName, pageFontDict, resolve, type FontInfo } from './fonts.ts';
import { decodeFilters, type DecodeParms, type FilterSpec } from './filters.ts';
import { readTail, writeFull, writeIncremental, type OriginalTail } from './incremental.ts';

function filterList(context: PDFContext, o: PDFObject | undefined): string[] {
  const v = resolve(context, o);
  if (v instanceof PDFName) return [v.decodeText()];
  if (v instanceof PDFArray) return v.asArray().map((x) => {
    const n = resolve(context, x);
    return n instanceof PDFName ? n.decodeText() : String(n);
  });
  return [];
}

function parmsOf(context: PDFContext, o: PDFObject | undefined): DecodeParms | null {
  const d = resolve(context, o);
  if (!(d instanceof PDFDict)) return null;
  const out: DecodeParms = {};
  for (const k of ['Predictor', 'Colors', 'BitsPerComponent', 'Columns', 'EarlyChange'] as const) {
    const v = resolve(context, d.get(PDFName.of(k)));
    if (v instanceof PDFNumber) out[k] = v.asNumber();
  }
  const name = resolve(context, d.get(PDFName.of('Name')));
  if (name instanceof PDFName) out.Name = name.decodeText();
  return out;
}

/** A stream's filters with their /DecodeParms (one dict for a single filter, or an array parallel to /Filter). */
export function streamFilters(context: PDFContext, stream: PDFStream): FilterSpec[] {
  const names = filterList(context, stream.dict.get(PDFName.of('Filter')));
  const raw = resolve(context, stream.dict.get(PDFName.of('DecodeParms')) ?? stream.dict.get(PDFName.of('DP')));
  return names.map((name, i) => ({ name, parms: parmsOf(context, raw instanceof PDFArray ? raw.get(i) : i === 0 ? raw : undefined) }));
}

/**
 * A stream's decoded bytes: FlateDecode, LZWDecode (with /EarlyChange), ASCIIHexDecode, ASCII85Decode and
 * RunLengthDecode, applied in /Filter order, with PNG and TIFF predictors (src/pdf/filters.ts). Image-only filters
 * and /Crypt are refused with the stream named in the error.
 */
export function decodeStream(context: PDFContext, stream: PDFStream, label: string): Uint8Array {
  return decodeFilters(stream.getContents(), streamFilters(context, stream), `content stream ${label}`);
}

const refKey = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;

export class PdfEdit {
  readonly doc: PDFDocument;
  readonly context: PDFContext;
  readonly pageCount: number;
  readonly #original: Uint8Array;
  readonly #tail: OriginalTail;
  readonly #baseline: number;
  readonly #pageRefs: PDFRef[];
  readonly #touched = new Map<string, PDFRef>();
  readonly #wrapped = new Set<number>();
  #pushRef: PDFRef | null = null;
  #popRef: PDFRef | null = null;

  constructor(original: Uint8Array, doc: PDFDocument, tail: OriginalTail) {
    this.#original = original;
    this.doc = doc;
    this.context = doc.context;
    this.#tail = tail;
    this.#pageRefs = doc.getPages().map((p) => p.ref);
    this.pageCount = this.#pageRefs.length;
    // New objects must not reuse numbers the original's xref already accounts for (free entries, its xref stream).
    this.context.largestObjectNumber = Math.max(this.context.largestObjectNumber, tail.size - 1);
    this.#baseline = this.context.largestObjectNumber;
  }

  #page(i: number): { ref: PDFRef; dict: PDFDict } {
    if (!Number.isInteger(i) || i < 0 || i >= this.pageCount) {
      throw new Error(`pdfedit: page ${i} out of range (0–${this.pageCount - 1})`);
    }
    const ref = this.#pageRefs[i];
    const dict = this.context.lookup(ref);
    if (!(dict instanceof PDFDict)) throw new Error(`pdfedit: page ${i} (${refKey(ref)} R) is not a dictionary`);
    return { ref, dict };
  }

  /** The page's content stream objects, in order. */
  #streams(dict: PDFDict): { stream: PDFStream; label: string }[] {
    const raw = dict.get(PDFName.of('Contents'));
    const v = resolve(this.context, raw);
    const items: PDFObject[] = v instanceof PDFArray ? v.asArray() : v ? [raw!] : [];
    return items.flatMap((it) => {
      const s = resolve(this.context, it);
      if (!(s instanceof PDFStream)) return [];
      return [{ stream: s, label: it instanceof PDFRef ? `${refKey(it)} R` : '(direct)' }];
    });
  }

  /** The page's content streams, decoded and joined with a newline. */
  contents(page: number): Uint8Array {
    const { dict } = this.#page(page);
    const parts = this.#streams(dict).map(({ stream, label }) => decodeStream(this.context, stream, label));
    const total = parts.reduce((s, p) => s + p.length, 0) + Math.max(0, parts.length - 1);
    const out = new Uint8Array(total);
    let o = 0;
    parts.forEach((p, i) => {
      if (i) out[o++] = 0x0a;
      out.set(p, o);
      o += p.length;
    });
    return out;
  }

  fontInfo(page: number, resourceName: string): FontInfo {
    const { dict } = this.#page(page);
    return fontInfoFromDict(this.context, pageFontDict(this.context, dict, resourceName));
  }

  /** The page's /Contents becomes one new FlateDecode stream with these bytes. */
  setContents(page: number, contents: Uint8Array): void {
    const { ref, dict } = this.#page(page);
    const s = this.context.register(this.context.flateStream(contents));
    dict.set(PDFName.of('Contents'), s);
    this.#wrapped.delete(page);
    this.#touched.set(refKey(ref), ref);
  }

  /**
   * Appends a new content stream (the caller wraps it in q…Q). The first time on a page, the existing contents are
   * bracketed by q … Q streams so an unbalanced cm or q in the original cannot leak into the new content. The fonts
   * are added under the given names to the page's own copy of its (possibly inherited) resources.
   */
  appendContent(page: number, content: Uint8Array, fonts: Record<string, PDFRef>): void {
    const { ref, dict } = this.#page(page);
    const ctx = this.context;
    const existing = this.#streams(dict);
    const raw = dict.get(PDFName.of('Contents'));
    const v = resolve(ctx, raw);
    const refs: PDFObject[] = v instanceof PDFArray ? v.asArray() : v ? [raw!] : [];
    const arr = PDFArray.withContext(ctx);
    if (existing.length && !this.#wrapped.has(page)) {
      this.#pushRef ??= ctx.register(ctx.stream('q\n'));
      this.#popRef ??= ctx.register(ctx.stream('\nQ\n'));
      arr.push(this.#pushRef);
      for (const r of refs) arr.push(r);
      arr.push(this.#popRef);
    } else {
      for (const r of refs) arr.push(r);
    }
    arr.push(ctx.register(ctx.flateStream(content)));
    dict.set(PDFName.of('Contents'), arr);
    this.#wrapped.add(page);

    // Resources: a shallow copy of the resolved dict and of its /Font, never mutating one other pages may share.
    const res = inheritedResources(ctx, dict);
    const newRes = res ? res.clone(ctx) : ctx.obj({});
    const fontObj = resolve(ctx, newRes.get(PDFName.of('Font')));
    const newFont = fontObj instanceof PDFDict ? fontObj.clone(ctx) : ctx.obj({});
    for (const [name, fref] of Object.entries(fonts)) {
      const prior = lookupByName(newFont, name);
      if (prior !== undefined && !(prior instanceof PDFRef && refKey(prior) === refKey(fref))) {
        throw new Error(`pdfedit: font resource name /${name} is already used on page ${page}`);
      }
      newFont.set(PDFName.of(name), fref);
    }
    newRes.set(PDFName.of('Font'), newFont);
    dict.set(PDFName.of('Resources'), newRes);
    this.#touched.set(refKey(ref), ref);
  }

  /** A new FlateDecode stream with `bytes` and the old stream's dictionary (its filter entries dropped, `patch` set). */
  #restream(old: PDFStream, bytes: Uint8Array, patch: Record<string, PDFObject>): PDFStream {
    const ctx = this.context;
    const s = ctx.flateStream(bytes);
    const skip = new Set(['Length', 'Filter', 'DecodeParms', 'DL', 'F', 'FFilter', 'FDecodeParms']);
    for (const [k, v] of old.dict.entries()) if (!skip.has(k.decodeText())) s.dict.set(k, v);
    for (const [k, v] of Object.entries(patch)) s.dict.set(PDFName.of(k), v);
    return s;
  }

  /** Replaces an indirect stream (a form XObject) in place: same object number, new data, same dictionary. */
  replaceStream(ref: PDFRef, bytes: Uint8Array, patch: Record<string, PDFObject> = {}): void {
    const old = this.context.lookup(ref);
    if (!(old instanceof PDFStream)) throw new Error(`pdfedit: ${refKey(ref)} R is not a stream`);
    this.context.assign(ref, this.#restream(old, bytes, patch));
    this.#touched.set(refKey(ref), ref);
  }

  /** A new indirect stream with `bytes` and a copy of `old`'s dictionary (a form XObject copied for one use). */
  copyStream(old: PDFStream, bytes: Uint8Array, patch: Record<string, PDFObject> = {}): PDFRef {
    return this.context.register(this.#restream(old, bytes, patch));
  }

  /** Adds XObjects to the page's own copy of its (possibly inherited) resources. */
  addPageXObjects(page: number, entries: Record<string, PDFRef>): void {
    const { ref, dict } = this.#page(page);
    const ctx = this.context;
    const res = inheritedResources(ctx, dict);
    const newRes = res ? res.clone(ctx) : ctx.obj({});
    const x = resolve(ctx, newRes.get(PDFName.of('XObject')));
    const newX = x instanceof PDFDict ? x.clone(ctx) : ctx.obj({});
    for (const [name, r] of Object.entries(entries)) {
      if (lookupByName(newX, name) !== undefined) throw new Error(`pdfedit: XObject resource name /${name} is already used on page ${page}`);
      newX.set(PDFName.of(name), r);
    }
    newRes.set(PDFName.of('XObject'), newX);
    dict.set(PDFName.of('Resources'), newRes);
    this.#touched.set(refKey(ref), ref);
  }

  /** Marks an existing object as changed so the next incremental save writes it (for in-place edits through context). */
  markChanged(ref: PDFRef): void {
    this.#touched.set(refKey(ref), ref);
  }

  /** The objects an incremental save writes: touched ones and every object numbered after openForEdit. */
  changedObjects(): [PDFRef, PDFObject][] {
    const out = new Map<string, [PDFRef, PDFObject]>();
    for (const [k, r] of this.#touched) {
      const o = this.context.lookup(r);
      if (o) out.set(k, [r, o]);
    }
    for (const [r, o] of this.context.enumerateIndirectObjects()) {
      if (r.objectNumber > this.#baseline) out.set(refKey(r), [r, o]);
    }
    return [...out.values()].sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  }

  /** Incremental by default: the original bytes, then the changed and new objects, an xref and a trailer. */
  save(opts: { incremental?: boolean } = {}): Uint8Array {
    const t = this.context.trailerInfo;
    if (t.Encrypt) throw new Error('pdfedit: encrypted PDFs are not supported');
    if (!t.Root) throw new Error('pdfedit: the document has no /Root');
    const trailer = { Root: t.Root, Info: t.Info, ID: t.ID };
    if (opts.incremental === false) return writeFull(this.#original, this.context, trailer);
    const changed = this.changedObjects();
    if (!changed.length) return this.#original.slice();
    return writeIncremental(this.#original, this.#tail, changed, trailer, this.context);
  }
}

/** Parses the file with pdf-lib (metadata untouched). Encrypted files are refused. */
export async function openForEdit(bytes: Uint8Array): Promise<PdfEdit> {
  const original = bytes.slice();
  const tail = readTail(original);
  if (tail.encrypted) throw new Error('pdfedit: encrypted PDFs are not supported (the trailer has /Encrypt)');
  const doc = await PDFDocument.load(bytes.slice(), { updateMetadata: false, ignoreEncryption: true });
  if (doc.isEncrypted || doc.context.trailerInfo.Encrypt) {
    throw new Error('pdfedit: encrypted PDFs are not supported (the trailer has /Encrypt)');
  }
  return new PdfEdit(original, doc, tail);
}
