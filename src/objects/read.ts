// The page object model from the content stream (ISO 32000-1 §8.2 graphics objects, §8.4 graphics state, §8.5 path
// construction and painting, §8.9 images, §8.10 form XObjects, §8.7.4.2 shading operator, §14.6 marked content).
// The page's stream is walked operator by operator with the graphics state (q/Q, cm, w, clipping paths, text render
// mode), entering every form XObject at its Do (src/pdf/tree.ts contentTree), so objects come in paint order, a form
// before its contents, as PDFium lists them. Each painted object gets its page-space bounds, the clips in force, the
// marked content around it and the q … Q group it has to itself. Nothing is written.
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext } from 'pdf-lib';
import type { Rect } from '../engine/pdfium.ts';
import type { PdfEdit } from '../pdf/edit.ts';
import { codesOf, lookupByName, resolve } from '../pdf/fonts.ts';
import { apply, mul, type M6, type Op } from '../pdf/ops.ts';
import type { Token } from '../pdf/tokenizer.ts';
import { contentTree, formUses, nodeFonts, refKey, type ContentTree, type StreamNode } from '../pdf/tree.ts';
import type { Clip, ObjectKind, PageObject } from './types.ts';

export type ContentObjects = { objects: PageObject[]; clips: Map<string, Clip>; notes: string[] };

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const PAINTS = new Set([...PATH_PAINT, 'sh', 'Do', 'BI', 'Tj', 'TJ', "'", '"', 'BT', 'd0', 'd1']);

type GS = { ctm: M6; clips: string[]; lw: number };
type Mark = { tag: string; mcid?: number };

const numAt = (o: Op, k: number): number => { const t = o.operands[o.operands.length - k]; return t?.type === 'number' ? t.value : NaN; };
const six = (o: Op): M6 | null => { const v = [6, 5, 4, 3, 2, 1].map((k) => numAt(o, k)); return v.every(Number.isFinite) ? (v as M6) : null; };
const axisAligned = (m: M6) => (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) || (Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);

function bbox(pts: [number, number][], m: M6): Rect {
  const q = pts.map(([x, y]) => apply(m, x, y));
  return { x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])) };
}
const unit = (m: M6) => bbox([[0, 0], [1, 0], [0, 1], [1, 1]], m);
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const join = (a: Rect | null, b: Rect): Rect => (a ? { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) } : { ...b });
/** How much a matrix scales lengths (the square root of its determinant's size). */
const scaleOf = (m: M6) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));

function category(ctx: PDFContext, res: PDFDict | undefined, cat: string, name: string) {
  const d = res && resolve(ctx, res.get(PDFName.of(cat)));
  return d instanceof PDFDict ? lookupByName(d, name) : undefined;
}
const numberOf = (ctx: PDFContext, d: PDFDict, key: string): number | undefined => {
  const v = resolve(ctx, d.get(PDFName.of(key)));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
};
function rectOf(ctx: PDFContext, d: PDFDict, key: string): [number, number, number, number] | null {
  const b = resolve(ctx, d.get(PDFName.of(key)));
  if (!(b instanceof PDFArray) || b.size() !== 4) return null;
  const v = b.asArray().map((x) => { const n = resolve(ctx, x); return n instanceof PDFNumber ? n.asNumber() : NaN; });
  return v.every(Number.isFinite) ? (v as [number, number, number, number]) : null;
}

/** An XObject by resource name: its kind, reference and dictionary. */
function xobject(ctx: PDFContext, res: PDFDict | undefined, name: string): { kind: 'image' | 'form' | null; ref: PDFRef | null; dict: PDFDict | null } {
  const raw = category(ctx, res, 'XObject', name);
  const s = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (!(s instanceof PDFStream)) return { kind: null, ref: null, dict: null };
  const st = resolve(ctx, s.dict.get(PDFName.of('Subtype')));
  const v = st instanceof PDFName ? st.decodeText() : '';
  return { kind: v === 'Image' ? 'image' : v === 'Form' ? 'form' : null, ref: raw instanceof PDFRef ? raw : null, dict: s.dict };
}

/** Pairs of matching q and Q. */
export function qPairs(ops: Op[]): Map<number, number> {
  const out = new Map<number, number>();
  const st: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'q') st.push(i);
    else if (o.op === 'Q') { const a = st.pop(); if (a !== undefined) out.set(a, i); }
  });
  return out;
}

/** The outermost q … Q pair around [i0, i1] that paints nothing else and keeps marked content balanced. */
export function ownGroup(ops: Op[], pairs: Map<number, number>, i0: number, i1: number): [number, number] | null {
  const around = [...pairs].filter(([a, b]) => a < i0 && b > i1).sort((p, q) => q[0] - p[0]);
  let best: [number, number] | null = null;
  for (const [a, b] of around) {
    let depth = 0, ok = true;
    for (let k = a + 1; k < b && ok; k++) {
      if (k >= i0 && k <= i1) continue;
      const op = ops[k].op;
      if (PAINTS.has(op)) ok = false;
      else if (op === 'BMC' || op === 'BDC') depth++;
      else if (op === 'EMC' && --depth < 0) ok = false;
    }
    if (!ok || depth !== 0) break;
    best = [a, b];
  }
  return best;
}

/** The marked-content tag and MCID of a BMC or BDC (an inline property list's /MCID; a named one is not resolved). */
function markOf(o: Op): Mark {
  const tag = o.operands.find((t) => t.type === 'name') as Extract<Token, { type: 'name' }> | undefined;
  const props = o.operands.find((t) => t.type === 'dict') as Extract<Token, { items: Token[] }> | undefined;
  let mcid: number | undefined;
  if (props) for (let k = 0; k + 1 < props.items.length; k += 2) {
    const key = props.items[k], val = props.items[k + 1];
    if (key.type === 'name' && key.value === 'MCID' && val.type === 'number') mcid = val.value;
  }
  return { tag: tag?.value ?? '', ...(mcid !== undefined ? { mcid } : {}) };
}

/** An inline image's sample size from its dictionary (/W or /Width, /H or /Height), and whether it is a mask. */
function inlineInfo(t: Token | undefined): { pixels?: [number, number]; mask: boolean } {
  if (!t || t.type !== 'inlineImage') return { mask: false };
  let w: number | undefined, h: number | undefined, mask = false;
  for (let k = 0; k + 1 < t.dict.length; k += 2) {
    const key = t.dict[k], val = t.dict[k + 1];
    if (key.type !== 'name') continue;
    if ((key.value === 'W' || key.value === 'Width') && val.type === 'number') w = val.value;
    if ((key.value === 'H' || key.value === 'Height') && val.type === 'number') h = val.value;
    if ((key.value === 'IM' || key.value === 'ImageMask') && val.type === 'bool') mask = val.value;
  }
  return { ...(w && h ? { pixels: [w, h] as [number, number] } : {}), mask };
}

/**
 * Every object page `page` paints, in paint order, with the clips in force. `crop` bounds a shading painted without
 * a clip (it fills the whole clip region, so the page when there is none). `tree`: the page's content tree when the
 * caller has it already (export reads the model from the tree it took before changing any stream).
 */
export function readObjects(edit: PdfEdit, page: number, crop: Rect, given?: ContentTree): ContentObjects {
  const ctx = edit.context;
  const tree = given ?? contentTree(edit, page);
  const notes: string[] = [];
  const objects: PageObject[] = [];
  const clips = new Map<string, Clip>();
  let uses: Map<string, number> | null = null;
  const useCount = (ref: PDFRef) => (uses ??= formUses(edit)).get(refKey(ref)) ?? 1;
  const kids = new Map<StreamNode, Map<number, StreamNode>>();
  for (const n of tree.nodes) if (n.parent && n.call) {
    let m = kids.get(n.parent);
    if (!m) kids.set(n.parent, (m = new Map()));
    m.set(n.call.opIndex, n);
  }
  const sitesOf = new Map<StreamNode, Map<number, (typeof tree.sites)[number]>>();
  for (const s of tree.sites) {
    let m = sitesOf.get(s.node);
    if (!m) sitesOf.set(s.node, (m = new Map()));
    m.set(s.show.opIndex, s);
  }

  const visit = (node: StreamNode, init: GS, path: number[], marks0: Mark[], parent: PageObject | null) => {
    if (node.error) { notes.push(`a form (${node.ref ? refKey(node.ref) : '?'}) could not be read: ${node.error}`); return; }
    const ops = node.ops;
    const prefix = path.length ? `${path.join('/')}/` : '';
    const pairs = qPairs(ops);
    const fonts = nodeFonts(ctx, node);
    const sites = sitesOf.get(node);
    const stack: GS[] = [];
    const marks: Mark[] = [...marks0];
    let gs = init;
    let pts: [number, number][] = [], npts = 0, start = -1, segs = 0, clipOp: string | null = null, onlyRe = true, res = 0;
    let textRender = 0, inText = false, textClip: Rect | null = null;
    const endPath = () => { pts = []; npts = 0; start = -1; segs = 0; clipOp = null; onlyRe = true; res = 0; };
    const emit = (kind: ObjectKind, i0: number, i1: number, bounds: Rect, ctm: M6, extra: Partial<PageObject> = {}): PageObject => {
      const o: PageObject = {
        id: `${prefix}${i1}`, kind, z: objects.length, path: [...path], ops: [i0, i1], parent: parent?.id ?? null, bounds, ctm,
        clips: [...gs.clips], marked: marks.map((m) => ({ ...m })), group: ownGroup(ops, pairs, i0, i1), ...extra,
      };
      objects.push(o);
      parent?.children?.push(o.id);
      for (const c of o.clips) { const cl = clips.get(c); if (cl) cl.users++; }
      return o;
    };
    ops.forEach((o, i) => {
      const op = o.op;
      if (PATH_BUILD.has(op)) {
        if (start < 0) start = i;
        segs++;
        if (op === 're') {
          const [x, y, w, h] = [4, 3, 2, 1].map((k) => numAt(o, k));
          if ([x, y, w, h].every(Number.isFinite)) pts.push([x, y], [x + w, y], [x + w, y + h], [x, y + h]);
          npts += 5; res++;
        } else if (op !== 'h') {
          onlyRe = false;
          const vals = o.operands.filter((t) => t.type === 'number').map((t) => (t as { value: number }).value);
          for (let k = 0; k + 1 < vals.length; k += 2) pts.push([vals[k], vals[k + 1]]);
          npts += op === 'm' || op === 'l' ? 1 : 3;
        }
        return;
      }
      if (op === 'W' || op === 'W*') { clipOp = op; return; }
      if (PATH_PAINT.has(op) || op === 'n') {
        if (op !== 'n' && npts >= 2 && start >= 0) {
          const stroked = op !== 'f' && op !== 'F' && op !== 'f*';
          const b = bbox(pts, gs.ctm);
          emit('path', start, i, stroked ? grow(b, (gs.lw * scaleOf(gs.ctm)) / 2) : b, gs.ctm, { paint: op, pathSegs: segs });
        }
        if (clipOp && pts.length) {
          const id = `${prefix}${i}`;
          clips.set(id, { id, kind: 'path', bounds: bbox(pts, gs.ctm), rect: onlyRe && res === 1 && axisAligned(gs.ctm), evenOdd: clipOp === 'W*', users: 0 });
          gs = { ...gs, clips: [...gs.clips, id] };
        }
        endPath();
        return;
      }
      switch (op) {
        case 'q': stack.push(gs); break;
        case 'Q': gs = stack.pop() ?? gs; break;
        case 'cm': { const m = six(o); if (m) gs = { ...gs, ctm: mul(m, gs.ctm) }; break; }
        case 'w': { const w = numAt(o, 1); if (Number.isFinite(w)) gs = { ...gs, lw: w }; break; }
        case 'BMC': case 'BDC': marks.push(markOf(o)); break;
        case 'EMC': marks.pop(); break;
        case 'BT': inText = true; textClip = null; break;
        case 'Tr': { const r = numAt(o, 1); if (Number.isFinite(r)) textRender = r; break; }
        case 'ET':
          inText = false;
          if (textClip) {
            const id = `${prefix}${i}`;
            clips.set(id, { id, kind: 'text', bounds: textClip, rect: false, evenOdd: false, users: 0 });
            gs = { ...gs, clips: [...gs.clips, id] };
          }
          textClip = null;
          break;
        case 'Tj': case 'TJ': case "'": case '"': {
          const site = sites?.get(i);
          if (!site) break;
          const sh = site.show;
          const m = mul(mul(sh.tm, sh.ctm), node.toPage);
          let chars = 0;
          try { const f = fonts(sh.font); for (const b of sh.strings) chars += f.codeBytes ? codesOf(b, f.codeBytes).length : b.length; } catch { chars = sh.strings.reduce((k, b) => k + b.length, 0); }
          const s = sh.fontSize || 1;
          // a rough box from the text matrix (PDFium's bounds replace it, src/objects/list.ts)
          const b = bbox([[0, -0.25 * s], [Math.max(1, chars) * 0.5 * s, 0.9 * s]], m);
          emit('text', i, i, b, m, { chars });
          if (inText && textRender >= 4) textClip = join(textClip, b);
          break;
        }
        case 'BI': {
          const info = inlineInfo(o.operands[0]);
          emit('inline-image', i, i, unit(gs.ctm), gs.ctm, { ...(info.pixels ? { pixels: info.pixels } : {}), smask: info.mask });
          break;
        }
        case 'sh': {
          const n = o.operands[o.operands.length - 1];
          const inForce = gs.clips.map((c) => clips.get(c)?.bounds).filter((r): r is Rect => !!r);
          const b = inForce.reduce((acc, r) => meet(acc, r), crop);
          emit('shading', i, i, b, gs.ctm, n?.type === 'name' ? { name: n.value } : {});
          break;
        }
        case 'Do': {
          const n = o.operands[o.operands.length - 1];
          if (n?.type !== 'name') break;
          const x = xobject(ctx, node.resources, n.value);
          if (x.kind === 'image' && x.dict) {
            const w = numberOf(ctx, x.dict, 'Width'), h = numberOf(ctx, x.dict, 'Height');
            const sm = x.dict.get(PDFName.of('SMask')) !== undefined || x.dict.get(PDFName.of('Mask')) !== undefined;
            emit('image', i, i, unit(gs.ctm), gs.ctm, { name: n.value, ...(x.ref ? { ref: refKey(x.ref) } : {}), ...(w && h ? { pixels: [w, h] as [number, number] } : {}), smask: sm });
          } else if (x.kind === 'form' && x.dict) {
            const kid = kids.get(node)?.get(i);
            const fm = kid?.matrix ?? [1, 0, 0, 1, 0, 0];
            const ctm = mul(fm, gs.ctm);
            const bb = rectOf(ctx, x.dict, 'BBox');
            const bounds = bb ? bbox([[bb[0], bb[1]], [bb[2], bb[1]], [bb[0], bb[3]], [bb[2], bb[3]]], ctm) : unit(ctm);
            const f = emit('form', i, i, bounds, ctm, { name: n.value, ...(x.ref ? { ref: refKey(x.ref), uses: useCount(x.ref) } : {}), children: [] });
            if (!kid) { notes.push(`form ${f.id} was not entered (a cycle, nesting too deep or an unreadable stream)`); break; }
            let inner: GS = { ctm, clips: [...gs.clips], lw: gs.lw };
            if (bb) {
              const id = `${f.id}#bbox`;
              clips.set(id, { id, kind: 'bbox', bounds, rect: axisAligned(ctm), evenOdd: false, users: 0 });
              inner = { ...inner, clips: [...inner.clips, id] };
            }
            visit(kid, inner, [...path, i], marks, f);
          }
          break;
        }
      }
    });
  };
  visit(tree.root, { ctm: [1, 0, 0, 1, 0, 0], clips: [], lw: 1 }, [], [], null);
  return { objects, clips, notes };
}
