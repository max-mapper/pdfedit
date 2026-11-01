// A page's content as PDFium flattens it: the page's own stream with every Form XObject it paints (`Do`) entered in
// place, recursively. PDFium's page.textObjects() lists text objects in exactly this order (a form's children in its
// stream's order, nested forms recursively), so the n-th entry of `sites` is the operator behind the n-th text object
// when the counts agree. Form streams are edited copy-on-write: a form painted more than once in the document is
// copied before its text is removed, so its other uses keep their text.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext, type PDFObject } from 'pdf-lib';
import { decodeStream, type PdfEdit } from './edit.ts';
import { fontInfoFromDict, inheritedResources, lookupByName, resolve, type FontInfo } from './fonts.ts';
import { IDENTITY, mul, parseOps, textShows, xobjectCalls, type M6, type Op, type TextShow, type XObjectCall } from './ops.ts';
import { blankOutDetailed, type Replacement } from './surgery.ts';

export type StreamNode = {
  id: number;
  page: number;
  parent: StreamNode | null;
  depth: number; // 0 = the page
  call: XObjectCall | null; // the Do in the parent's stream
  ref: PDFRef | null; // the form XObject (null for the page)
  stream: PDFStream | null;
  resources: PDFDict | undefined; // the form's own /Resources, else its parent's
  /** A show's page-space matrix is tm × show.ctm × toPage (show.ctm starts at the form's /Matrix). */
  toPage: M6;
  matrix: M6; // the form's /Matrix (identity for the page)
  contents: Uint8Array;
  ops: Op[];
  shows: TextShow[];
  error: string | null; // the form's stream could not be read: its text is not listed
};

export type TextSite = { node: StreamNode; show: TextShow };

export type ContentTree = { root: StreamNode; nodes: StreamNode[]; sites: TextSite[] };

const MAX_DEPTH = 16;

export const refKey = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;

function dictIn(ctx: PDFContext, res: PDFDict | undefined, category: string, name: string): PDFObject | undefined {
  const cat = res && resolve(ctx, res.get(PDFName.of(category)));
  return cat instanceof PDFDict ? lookupByName(cat, name) : undefined;
}

/** A font resource's dictionary in a resources dict. */
export function fontDictIn(ctx: PDFContext, res: PDFDict | undefined, name: string): PDFDict {
  const f = resolve(ctx, dictIn(ctx, res, 'Font', name));
  if (f instanceof PDFDict) return f;
  throw new Error(`pdfedit: no font resource /${name}`);
}

/** The Form XObject a `Do` name refers to, or null for images and unknown names. */
function formOf(ctx: PDFContext, res: PDFDict | undefined, name: string): { ref: PDFRef; stream: PDFStream } | null {
  const raw = dictIn(ctx, res, 'XObject', name);
  if (!(raw instanceof PDFRef)) return null; // streams are always indirect
  const s = ctx.lookup(raw);
  if (!(s instanceof PDFStream)) return null;
  const st = resolve(ctx, s.dict.get(PDFName.of('Subtype')));
  return st instanceof PDFName && st.decodeText() === 'Form' ? { ref: raw, stream: s } : null;
}

function matrixOf(ctx: PDFContext, s: PDFStream): M6 {
  const m = resolve(ctx, s.dict.get(PDFName.of('Matrix')));
  if (!(m instanceof PDFArray) || m.size() !== 6) return [...IDENTITY];
  const v = m.asArray().map((x) => {
    const n = resolve(ctx, x);
    return n instanceof PDFNumber ? n.asNumber() : NaN;
  });
  return v.every(Number.isFinite) ? (v as M6) : [...IDENTITY];
}

/** The node's font resolver (name → widths), for textShows and blanking. */
export function nodeFonts(ctx: PDFContext, node: StreamNode): (name: string) => FontInfo {
  const cache = new Map<string, FontInfo>();
  return (name) => {
    let f = cache.get(name);
    if (!f) cache.set(name, (f = fontInfoFromDict(ctx, fontDictIn(ctx, node.resources, name))));
    return f;
  };
}

/** The page's content tree. A form whose stream cannot be decoded is listed with `error` and not entered. */
export function contentTree(edit: PdfEdit, page: number): ContentTree {
  const ctx = edit.context;
  const pageDict = edit.doc.getPage(page).node;
  const nodes: StreamNode[] = [];
  const sites: TextSite[] = [];
  const make = (p: Omit<StreamNode, 'id' | 'ops' | 'shows' | 'error'> & { error?: string | null }): StreamNode => {
    const node: StreamNode = { ...p, id: nodes.length, ops: [], shows: [], error: p.error ?? null };
    nodes.push(node);
    if (!node.error) {
      node.ops = parseOps(node.contents);
      const fonts = nodeFonts(ctx, node);
      node.shows = textShows(node.ops, { fonts, ctm: node.matrix });
    }
    return node;
  };
  const root = make({
    page, parent: null, depth: 0, call: null, ref: null, stream: null,
    resources: inheritedResources(ctx, pageDict), toPage: [...IDENTITY], matrix: [...IDENTITY], contents: edit.contents(page),
  });
  const walk = (node: StreamNode, ancestors: Set<string>) => {
    if (node.error) return;
    const byOp = new Map(node.shows.map((s) => [s.opIndex, s]));
    const calls = new Map(xobjectCalls(node.ops, node.matrix).map((c) => [c.opIndex, c]));
    node.ops.forEach((_, i) => {
      const s = byOp.get(i);
      if (s) {
        if (s.strings.some((b) => b.length > 0)) sites.push({ node, show: s });
        return;
      }
      const call = calls.get(i);
      if (!call) return;
      const f = formOf(ctx, node.resources, call.name);
      if (!f) return;
      const key = refKey(f.ref);
      if (ancestors.has(key) || node.depth + 1 > MAX_DEPTH) return; // a cycle or absurd nesting: PDFium stops too
      let contents: Uint8Array = new Uint8Array(0);
      let error: string | null = null;
      try {
        contents = decodeStream(ctx, f.stream, `${key} R (form /${call.name})`);
      } catch (e) {
        error = (e as Error).message;
      }
      const own = resolve(ctx, f.stream.dict.get(PDFName.of('Resources')));
      const child = make({
        page, parent: node, depth: node.depth + 1, call, ref: f.ref, stream: f.stream,
        resources: own instanceof PDFDict ? own : node.resources,
        toPage: mul(call.ctm, node.toPage), matrix: matrixOf(ctx, f.stream), contents, error,
      });
      walk(child, new Set([...ancestors, key]));
    });
  };
  walk(root, new Set());
  return { root, nodes, sites };
}

/**
 * How many times each Form XObject is painted across the whole document (every page, nested forms counted once per
 * path). Annotation appearance streams are not counted.
 */
export function formUses(edit: PdfEdit): Map<string, number> {
  const ctx = edit.context;
  const memo = new Map<string, Map<string, number>>();
  const inProgress = new Set<string>();
  const countsOf = (contents: Uint8Array, res: PDFDict | undefined): Map<string, number> => {
    const out = new Map<string, number>();
    let ops: Op[];
    try {
      ops = parseOps(contents);
    } catch {
      return out;
    }
    for (const c of xobjectCalls(ops)) {
      const f = formOf(ctx, res, c.name);
      if (!f) continue;
      const key = refKey(f.ref);
      out.set(key, (out.get(key) ?? 0) + 1);
      let sub = memo.get(key);
      if (!sub && !inProgress.has(key)) {
        inProgress.add(key);
        let data: Uint8Array = new Uint8Array(0);
        try {
          data = decodeStream(ctx, f.stream, key);
        } catch {
          /* unreadable: no children */
        }
        const own = resolve(ctx, f.stream.dict.get(PDFName.of('Resources')));
        sub = countsOf(data, own instanceof PDFDict ? own : res);
        memo.set(key, sub);
        inProgress.delete(key);
      }
      if (sub) for (const [k, v] of sub) out.set(k, (out.get(k) ?? 0) + v);
    }
    return out;
  };
  const total = new Map<string, number>();
  for (let p = 0; p < edit.pageCount; p++) {
    let contents: Uint8Array;
    try {
      contents = edit.contents(p);
    } catch {
      continue;
    }
    for (const [k, v] of countsOf(contents, inheritedResources(ctx, edit.doc.getPage(p).node))) total.set(k, (total.get(k) ?? 0) + v);
  }
  return total;
}

/** A name not yet used in a resources category. */
export function freshName(ctx: PDFContext, res: PDFDict | undefined, category: string, base: string, also: Set<string> = new Set()): string {
  const cat = res && resolve(ctx, res.get(PDFName.of(category)));
  const used = (n: string) => also.has(n) || (cat instanceof PDFDict && lookupByName(cat, n) !== undefined);
  for (let k = 1; ; k++) if (!used(`${base}${k}`)) return `${base}${k}`;
}

/** A shallow copy of a resources dict with `entries` added to one category (the category dict copied too). */
export function resourcesWith(ctx: PDFContext, res: PDFDict | undefined, category: string, entries: Record<string, PDFRef>): PDFDict {
  const out = res ? res.clone(ctx) : ctx.obj({});
  const cat = resolve(ctx, out.get(PDFName.of(category)));
  const copy = cat instanceof PDFDict ? cat.clone(ctx) : ctx.obj({});
  for (const [n, r] of Object.entries(entries)) copy.set(PDFName.of(n), r);
  out.set(PDFName.of(category), copy);
  return out;
}

const enc = new TextEncoder();

/** Splices edits (non-overlapping byte ranges) into bytes. */
export function spliceBytes(bytes: Uint8Array, edits: { start: number; end: number; text: string }[]): Uint8Array {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const e of sorted) {
    parts.push(bytes.subarray(pos, e.start), enc.encode(e.text));
    pos = e.end;
  }
  parts.push(bytes.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Where an original byte offset (outside every replaced range) lands after blankOutDetailed. */
export function mapOffset(reps: Replacement[], at: number): number {
  let d = 0;
  for (const r of reps) if (r.end <= at) d += r.newEnd - r.newStart - (r.end - r.start);
  return at + d;
}

/** A name in PDF syntax, with #xx for anything that is not a regular character. */
export function pdfName(s: string): string {
  let o = '/';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    o += c > 0x20 && c < 0x7f && !'()<>[]{}/%#'.includes(ch) ? ch : `#${(c & 0xff).toString(16).padStart(2, '0')}`;
  }
  return o;
}

export type Rename = { call: XObjectCall; name: string; ref: PDFRef };

export type FormCommit = {
  /** `Do` operators of the page's own stream that must now paint a copy (the caller splices them into the page). */
  pageRenames: Rename[];
  edited: string[]; // form XObjects changed in place (n g)
  copied: { from: string; to: string }[]; // forms copied for one use
};

/**
 * Writes the forms' blanked streams. Deepest first: a form painted once in the whole document is changed in place;
 * one painted more than once is copied, and the `Do` that paints this use is renamed in its parent (which is then
 * edited the same way, up to the page). `blanks` lists the shows to blank per form node.
 */
export function commitForms(edit: PdfEdit, blanks: Map<StreamNode, TextShow[]>, uses: Map<string, number>): FormCommit {
  const ctx = edit.context;
  const renames = new Map<StreamNode, Rename[]>();
  const out: FormCommit = { pageRenames: [], edited: [], copied: [] };
  const pending = new Set<StreamNode>([...blanks.keys()].filter((n) => n.ref));
  const order = () => [...pending].sort((a, b) => b.depth - a.depth);
  while (pending.size) {
    const node = order()[0];
    pending.delete(node);
    const shows = blanks.get(node) ?? [];
    const { bytes: blanked, replacements } = blankOutDetailed(node.contents, shows, nodeFonts(ctx, node));
    const rn = renames.get(node) ?? [];
    const bytes = rn.length
      ? spliceBytes(blanked, rn.map((r) => ({ start: mapOffset(replacements, r.call.nameStart), end: mapOffset(replacements, r.call.nameEnd), text: pdfName(r.name) })))
      : blanked;
    const patch: Record<string, PDFObject> = {};
    if (rn.length) patch.Resources = resourcesWith(ctx, node.resources, 'XObject', Object.fromEntries(rn.map((r) => [r.name, r.ref])));
    const key = refKey(node.ref!);
    if ((uses.get(key) ?? 1) <= 1) {
      edit.replaceStream(node.ref!, bytes, patch);
      out.edited.push(key);
      continue;
    }
    const copy = edit.copyStream(node.stream!, bytes, patch);
    out.copied.push({ from: key, to: refKey(copy) });
    const parent = node.parent!;
    const taken = new Set((renames.get(parent) ?? []).map((r) => r.name));
    const name = freshName(ctx, parent.resources, 'XObject', `${node.call!.name}_pe`, taken);
    const r: Rename = { call: node.call!, name, ref: copy };
    if (parent.ref) {
      renames.set(parent, [...(renames.get(parent) ?? []), r]);
      pending.add(parent);
    } else {
      out.pageRenames.push(r);
    }
  }
  return out;
}
