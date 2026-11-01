// Picture moves in export: a picture the fitter moved or shrank (Picture.move) is moved by
// surgery where it is painted. Its painting operator (an image's `Do` or inline `BI … EI`, a figure's path and its
// painting operator) is found in the page's content tree in PDFium's object order (the n-th image object is the n-th
// image painted, forms entered at their `Do`), and checked against PDFium's bounds. It is wrapped in
// `q a b c d e f cm … Q`: the move is a page-space transform T (scale about nothing, then translate: the frame's
// corner lands where the model says), and the inserted matrix is X = C × T × C⁻¹ with C the CTM in force at the
// insertion point, so that X composes before the CTM and the picture lands at T of where it was.
//
// When the operator sits in a q … Q group that paints nothing else (an image with its own frame clip, as layout
// programs write it), the whole group is wrapped, so its clip moves with it. A picture is never cropped: a move is
// refused when a clip outside the wrapped range would cut the picture in its new place (or already cuts it), when
// such a clip is not a rectangle, or when a soft mask is in force. A picture inside a Form XObject is moved in the
// form's stream when the form (and every form around it) is painted once in the document; otherwise it is refused.
// Refused moves are reported with the reason; the page is still written.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext } from 'pdf-lib';
import type { PdfDoc, Rect, Shape } from '../engine/pdfium.ts';
import { decodeStream, type PdfEdit } from '../pdf/edit.ts';
import { lookupByName, resolve } from '../pdf/fonts.ts';
import { apply, mul, parseOps, type M6, type Op } from '../pdf/ops.ts';
import { fmtNum, type Replacement } from '../pdf/surgery.ts';
import { mapOffset, refKey, spliceBytes, type ContentTree, type StreamNode } from '../pdf/tree.ts';
import { movedFrame } from '../fit/pictures.ts';
import type { Page } from '../model/types.ts';

export type PictureMoved = {
  id: string;
  kind: 'image' | 'figure';
  from: Rect;               // the picture's frame in the source (page space)
  to: Rect;                 // its frame now
  dx: number; dy: number; scale: number;
  operator: string;         // what paints it: 'Do /Im1', 'BI', 'path f'
  form: string | null;      // the Form XObject ("n g") whose stream was changed, null for the page's own stream
  wrapped: 'operator' | 'group';   // the operator alone, or the q … Q group it has to itself (its clip moves too)
};
export type PictureSkipped = { id: string; reason: string };
export type PictureResult = { moved: PictureMoved[]; skipped: PictureSkipped[]; regions: Rect[] };

/** Graphics state as far as moving a picture cares: the CTM (page space), the clips in force (page-space
 *  rectangles) and why a move would change what shows, other than by a rectangle clip (null when nothing). */
type GS = { ctm: M6; clips: Rect[]; odd: string | null };
type Ev = {
  kind: 'image' | 'path';
  node: StreamNode;
  local: number;            // index among the node's own events (images and paths)
  i0: number; i1: number;   // op range painting it (a path: its first construction operator to its painting one)
  bounds: Rect;             // page space
  why: string | null;       // why it cannot be wrapped on its own
  label: string;
};

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const PAINTS = new Set([...PATH_PAINT, 'sh', 'Do', 'BI', 'Tj', 'TJ', "'", '"', 'BT', 'd0', 'd1']);

const num = (o: Op, k: number): number => { const t = o.operands[o.operands.length - k]; return t?.type === 'number' ? t.value : NaN; };
const six = (o: Op): M6 | null => { const v = [6, 5, 4, 3, 2, 1].map((k) => num(o, k)); return v.every(Number.isFinite) ? (v as M6) : null; };
const axisAligned = (m: M6) => (Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9) || (Math.abs(m[0]) < 1e-9 && Math.abs(m[3]) < 1e-9);
function bbox(pts: [number, number][], m: M6): Rect {
  const q = pts.map(([x, y]) => apply(m, x, y));
  return { x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])) };
}
function invert(m: M6): M6 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
function iou(a: Rect, b: Rect): number {
  const i = area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}
const inside = (r: Rect, c: Rect, tol = 1) => r.x0 >= c.x0 - tol && r.y0 >= c.y0 - tol && r.x1 <= c.x1 + tol && r.y1 <= c.y1 + tol;

function category(ctx: PDFContext, res: PDFDict | undefined, cat: string, name: string) {
  const d = res && resolve(ctx, res.get(PDFName.of(cat)));
  return d instanceof PDFDict ? lookupByName(d, name) : undefined;
}
/** 'image', 'form' or null for what a Do name paints. */
function xobjectKind(ctx: PDFContext, res: PDFDict | undefined, name: string): 'image' | 'form' | null {
  const raw = category(ctx, res, 'XObject', name);
  const s = raw instanceof PDFRef ? ctx.lookup(raw) : raw;
  if (!(s instanceof PDFStream)) return null;
  const st = resolve(ctx, s.dict.get(PDFName.of('Subtype')));
  const v = st instanceof PDFName ? st.decodeText() : '';
  return v === 'Image' ? 'image' : v === 'Form' ? 'form' : null;
}
function softMasked(ctx: PDFContext, res: PDFDict | undefined, name: string): boolean {
  const g = resolve(ctx, category(ctx, res, 'ExtGState', name));
  if (!(g instanceof PDFDict)) return false;
  const sm = resolve(ctx, g.get(PDFName.of('SMask')));
  return sm !== undefined && !(sm instanceof PDFName && sm.decodeText() === 'None');
}

/**
 * Walks one stream's operators: the state before each operator, and the images and path objects it paints (as
 * PDFium makes them: a painted path of two or more points; `n` paints nothing). `enter` is called at every `Do`
 * that is not an image (the caller enters forms there, so events come in PDFium's flattened order).
 */
function walkOps(ctx: PDFContext, node: StreamNode, ops: Op[], init: GS, emit: (e: Ev) => void, enter?: (i: number, gs: GS) => void): GS[] {
  const states: GS[] = new Array(ops.length);
  const stack: GS[] = [];
  let gs = init;
  let local = 0;
  let pts: [number, number][] = [];
  let npts = 0, start = -1, onlyRe = true, res = 0, foreign = false, clip = false, textClip = false;
  const endPath = () => { pts = []; npts = 0; start = -1; onlyRe = true; res = 0; foreign = false; clip = false; };
  ops.forEach((o, i) => {
    states[i] = gs;
    const op = o.op;
    if (PATH_BUILD.has(op)) {
      if (start < 0) start = i;
      if (op === 're') {
        const [x, y, w, h] = [4, 3, 2, 1].map((k) => num(o, k));
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
    if (op === 'W' || op === 'W*') { clip = true; return; }
    if (PATH_PAINT.has(op) || op === 'n') {
      if (op !== 'n' && npts >= 2 && start >= 0) {
        const why = clip ? 'its path also sets a clip' : foreign ? 'other operators sit inside its path' : null;
        emit({ kind: 'path', node, local: local++, i0: start, i1: i, bounds: bbox(pts, gs.ctm), why, label: `path ${op}` });
      }
      if (clip && pts.length) {
        const r = bbox(pts, gs.ctm);
        const rect = onlyRe && res === 1 && axisAligned(gs.ctm);
        gs = { ...gs, clips: [...gs.clips, r], odd: gs.odd ?? (rect ? null : 'a clip that is not a rectangle') };
      }
      endPath();
      return;
    }
    if (start >= 0) foreign = true;
    switch (op) {
      case 'q': stack.push(gs); break;
      case 'Q': gs = stack.pop() ?? gs; break;
      case 'cm': { const m = six(o); if (m) gs = { ...gs, ctm: mul(m, gs.ctm) }; break; }
      case 'gs': {
        const n = o.operands[o.operands.length - 1];
        if (n?.type === 'name' && softMasked(ctx, node.resources, n.value)) gs = { ...gs, odd: gs.odd ?? 'a soft mask' };
        break;
      }
      case 'BT': textClip = false; break;
      case 'Tr': if (num(o, 1) >= 4) textClip = true; break;
      case 'ET': if (textClip) gs = { ...gs, odd: gs.odd ?? 'a text clip' }; break;
      case 'BI':
        emit({ kind: 'image', node, local: local++, i0: i, i1: i, bounds: bbox([[0, 0], [1, 0], [0, 1], [1, 1]], gs.ctm), why: null, label: 'BI' });
        break;
      case 'Do': {
        const n = o.operands[o.operands.length - 1];
        if (n?.type !== 'name') break;
        if (xobjectKind(ctx, node.resources, n.value) === 'image') {
          emit({ kind: 'image', node, local: local++, i0: i, i1: i, bounds: bbox([[0, 0], [1, 0], [0, 1], [1, 1]], gs.ctm), why: null, label: `Do /${n.value}` });
        } else enter?.(i, gs);
        break;
      }
    }
  });
  return states;
}

/** The state a form's stream starts in: the parent's at its `Do`, the form's matrix, its /BBox as a clip. */
function formInit(ctx: PDFContext, node: StreamNode, parent: GS): GS {
  const ctm = mul(node.matrix, node.toPage);
  const b = node.stream ? resolve(ctx, node.stream.dict.get(PDFName.of('BBox'))) : undefined;
  if (!(b instanceof PDFArray) || b.size() !== 4) return { ...parent, ctm };
  const v = b.asArray().map((x) => { const n = resolve(ctx, x); return n instanceof PDFNumber ? n.asNumber() : NaN; });
  if (!v.every(Number.isFinite)) return { ...parent, ctm };
  const [x0, y0, x1, y1] = v;
  const r = bbox([[x0, y0], [x1, y0], [x0, y1], [x1, y1]], ctm);
  return { ctm, clips: [...parent.clips, r], odd: parent.odd ?? (axisAligned(ctm) ? null : 'a turned form bounding box') };
}

/** Pairs of matching q and Q. */
function qPairs(ops: Op[]): Map<number, number> {
  const out = new Map<number, number>();
  const st: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'q') st.push(i);
    else if (o.op === 'Q') { const a = st.pop(); if (a !== undefined) out.set(a, i); }
  });
  return out;
}

/** The outermost q … Q group around [i0, i1] that paints nothing else and keeps marked content balanced. */
function ownGroup(ops: Op[], pairs: Map<number, number>, i0: number, i1: number): [number, number] | null {
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

/**
 * Applies the page's picture moves. The page's own stream is changed through `pageEdits` (offsets in the original
 * stream, mapped through the blanking's `replacements`); a form's stream is re-read (after any blanking) and
 * replaced in place. Returns what moved, what was refused and why, and the regions that may change (old and new
 * frames) for the verification.
 */
export function applyPictureMoves(a: {
  edit: PdfEdit; page: Page; tree: ContentTree; src: PdfDoc;
  replacements: Replacement[]; pageEdits: { start: number; end: number; text: string }[];
  uses: () => Map<string, number>;
}): PictureResult {
  const out: PictureResult = { moved: [], skipped: [], regions: [] };
  const todo = (a.page.pictures ?? []).filter((p) => p.move && (Math.abs(p.move.dx) > 1e-3 || Math.abs(p.move.dy) > 1e-3 || Math.abs(p.move.scale - 1) > 1e-6));
  if (!todo.length) return out;
  const ctx = a.edit.context;
  const pg = a.src.page(a.page.n);
  let shapes: Shape[];
  try { shapes = pg.shapes(); } finally { pg.close(); }

  // every image and path event of the page, in PDFium's order
  const kids = new Map<StreamNode, Map<number, StreamNode>>();
  for (const n of a.tree.nodes) if (n.parent && n.call) {
    let m = kids.get(n.parent);
    if (!m) kids.set(n.parent, (m = new Map()));
    m.set(n.call.opIndex, n);
  }
  const events: Ev[] = [];
  const initOf = new Map<StreamNode, GS>();
  const statesOf = new Map<StreamNode, GS[]>();
  const visit = (node: StreamNode, init: GS) => {
    initOf.set(node, init);
    if (node.error) return;
    statesOf.set(node, walkOps(ctx, node, node.ops, init, (e) => events.push(e), (i, gs) => {
      const kid = kids.get(node)?.get(i);
      if (kid) visit(kid, formInit(ctx, kid, gs));
    }));
  };
  visit(a.tree.root, { ctm: [1, 0, 0, 1, 0, 0], clips: [], odd: null });
  const images = events.filter((e) => e.kind === 'image');
  const paths = events.filter((e) => e.kind === 'path');

  const formEdits = new Map<StreamNode, { ops: Op[]; bytes: Uint8Array; edits: { start: number; end: number; text: string }[] }>();
  for (const p of todo) {
    const skip = (reason: string) => out.skipped.push({ id: p.id, reason });
    const shape = p.objs.length === 1 ? shapes[p.objs[0]] : undefined;
    if (!shape || (shape.kind === 'image') !== (p.kind === 'image') || (shape.kind !== 'image' && shape.kind !== 'path')) { skip('its page object is not one image or path'); continue; }
    if (iou(shape.bounds, p.frame) < 0.98) { skip('its frame does not match its page object'); continue; }
    const ord = shapes.slice(0, shape.index).filter((s) => s.kind === shape.kind).length;
    const ev = (shape.kind === 'image' ? images : paths)[ord];
    const fits = (e: Ev | undefined): e is Ev => !!e && (shape.kind === 'image'
      ? iou(e.bounds, shape.bounds) > 0.95
      : inside(e.bounds, shape.bounds, Math.max(2, 0.05 * Math.max(shape.bounds.x1 - shape.bounds.x0, shape.bounds.y1 - shape.bounds.y0))) && iou(e.bounds, shape.bounds) > 0.6);
    if (!fits(ev)) { skip('its painting operator was not found in the content stream'); continue; }
    if (ev.why) { skip(ev.why); continue; }
    const node = ev.node;
    const shared: string[] = [];
    for (let n: StreamNode | null = node; n && n.ref; n = n.parent) if ((a.uses().get(refKey(n.ref)) ?? 1) > 1) shared.push(refKey(n.ref));
    if (shared.length) { skip(`it is inside a form painted more than once (${shared[0]} R)`); continue; }

    // the stream as it is now (a form may have been blanked already) and the event in it
    let ops = node.ops, states = statesOf.get(node)!, e: Ev | undefined = ev, fe = formEdits.get(node);
    if (node.ref) {
      if (!fe) {
        const cur = ctx.lookup(node.ref);
        if (!(cur instanceof PDFStream)) { skip('its form is not a stream'); continue; }
        let bytes: Uint8Array;
        try { bytes = decodeStream(ctx, cur, `${refKey(node.ref)} R`); } catch (err) { skip(`its form cannot be read: ${(err as Error).message}`); continue; }
        formEdits.set(node, (fe = { ops: parseOps(bytes), bytes, edits: [] }));
      }
      ops = fe.ops;
      const local: Ev[] = [];
      states = walkOps(ctx, node, ops, initOf.get(node)!, (x) => local.push(x));
      e = local[ev.local];
      if (!e || e.kind !== ev.kind || iou(e.bounds, ev.bounds) < 0.95) { skip('its operator moved when the form was edited'); continue; }
    }
    const group = ownGroup(ops, qPairs(ops), e.i0, e.i1);
    const [s0, s1] = group ?? [e.i0, e.i1];
    const gs = states[s0];
    const from = { ...p.frame }, to = movedFrame(p);
    if (gs.odd) { skip(`moving it would change how it shows: ${gs.odd} is in force where it is painted`); continue; }
    if (gs.clips.some((c) => !inside(from, c))) { skip('a clip already crops it; moving it would show another part (never crop)'); continue; }
    if (gs.clips.some((c) => !inside(to, c))) { skip('a clip that does not move with it would crop it in its new place (never crop)'); continue; }
    const s = p.move!.scale;
    const T: M6 = [s, 0, 0, s, to.x0 - s * from.x0, to.y0 - s * from.y0];
    const inv = invert(gs.ctm);
    if (!inv) { skip('its transformation cannot be inverted'); continue; }
    const X = mul(mul(gs.ctm, T), inv);
    const before = `q ${X.map(fmtNum).join(' ')} cm\n`, after = '\nQ';
    const at0 = ops[s0].start, at1 = ops[s1].end;
    if (node.ref) {
      fe!.edits.push({ start: at0, end: at0, text: before }, { start: at1, end: at1, text: after });
    } else {
      const m0 = mapOffset(a.replacements, at0), m1 = mapOffset(a.replacements, at1);
      a.pageEdits.push({ start: m0, end: m0, text: before }, { start: m1, end: m1, text: after });
    }
    out.regions.push(from, to);
    out.moved.push({
      id: p.id, kind: p.kind, from, to, dx: p.move!.dx, dy: p.move!.dy, scale: s, operator: e.label,
      form: node.ref ? refKey(node.ref) : null, wrapped: group ? 'group' : 'operator',
    });
  }
  for (const [node, fe] of formEdits) if (fe.edits.length) a.edit.replaceStream(node.ref!, spliceBytes(fe.bytes, fe.edits));
  return out;
}

