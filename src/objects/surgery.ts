// Object surgery: moving, resizing, turning and deleting page objects by editing the content streams that paint them,
// without re-serialising anything else (ISO 32000-1 §8.2 graphics objects, §8.3.4 transformation matrices, §8.4.2
// graphics state stack, §8.5.4 clipping paths, §8.10 form XObjects, §14.6 marked content).
//
// Transform: the object's operator range, or the q … Q group it has to itself (so a clip set inside it moves with
// it), is wrapped in `q X cm … Q` with X = C × T × C⁻¹, C the CTM in force at the insertion point and T the object's
// own page-space matrix (src/objects/ops.ts): X composes before C, so everything the range paints lands at T of where
// it was. When the group starts with one `cm`, that `cm` is rewritten to M × X instead (the same result, fewer bytes).
//
// Clips set outside the wrapped range stay where they are. One that contains the object at its old and new places
// changes nothing. One that is a rectangle containing the object but not its new place is split: the clip's q … Q
// is closed before the object, the object is painted in a q … Q of its own that replays the state of the closed
// levels after `X cm` (so the clip becomes T(clip) for the object alone), and the levels are reopened with the same
// state for whatever comes after. A clip that already crops the object, or is not a rectangle, refuses the move
// unless the person chose what happens to it: "Move with its crop" (`sharedClip: 'move'`) splits it the same way, so
// the object keeps the shape the clip gave it, whatever the clip's shape; "Move without the crop" (`'drop'`, or
// `dropSharedClip`) splits and leaves it out. A clip set in an
// enclosing stream (a form's /BBox, or a clip around the form's Do) cannot be split there: a move whose new place
// leaves such a clip is refused. A soft mask or a text clip in force refuses a move, and so does a pattern fill or
// stroke (a pattern stays anchored to its stream's space, ISO 32000-1 §8.7.3.1).
//
// Delete: the operator range or its own group is removed; a marked-content pair left with nothing painted inside is
// removed with it. The earlier revision of an incrementally saved file still holds the old bytes: a delete here is not
// a redaction.
//
// Objects moved by one matrix and painted one after another (a group's members) share one wrap: `q X cm` before the
// first and `Q` after the last, with the state operators between them replayed after the `Q` so that what follows
// sees the state it saw before.
//
// Paint order (src/objects/order.ts): the stretch of a stream from the first unit that changed place to the last is
// rewritten, each unit's bytes copied unchanged into its new place; a move or deletion of a unit in the stretch is
// folded into its copy.
//
// Forms: a stream painted once in the document is replaced in place; one painted more than once is copied for this
// use (copy-on-write) and the Do that paints this use renamed in its parent, which is then written the same way, up to
// the page. The page's own stream is not written here: its edits are returned (offsets in its bytes as read).
import { PDFArray, PDFDict, PDFName, type PDFContext, type PDFObject, type PDFRef } from 'pdf-lib';
import type { Rect } from '../engine/pdfium.ts';
import type { PdfEdit } from '../pdf/edit.ts';
import { lookupByName, resolve } from '../pdf/fonts.ts';
import { IDENTITY, mul, parseOps, type M6, type Op } from '../pdf/ops.ts';
import { fmtNum } from '../pdf/surgery.ts';
import { freshName, pdfName, refKey, resourcesWith, type ContentTree, type StreamNode } from '../pdf/tree.ts';
import { invert, mapRect, type AppliedOps } from './ops.ts';
import { orderText, planOrder, type OrderText, type UnitFold } from './order.ts';
import { qPairs } from './read.ts';
import type { Clip, PageObject, PageObjects } from './types.ts';

/** A change to a stream's bytes: [start, end) replaced by `text` (latin1), offsets in the stream as read. */
export type ByteEdit = { start: number; end: number; text: string };

export type ObjectChanged = {
  id: string;
  kind: PageObject['kind'];
  action: 'transform' | 'delete' | 'order';
  from: Rect;                       // its bounds before (page space)
  to: Rect | null;                  // its bounds after (null: deleted)
  m?: M6;                           // transform: its own page-space matrix
  /** What was wrapped or removed: its operator range, the q … Q it has to itself, or that group's first cm rewritten. */
  how: 'operator' | 'group' | 'cm';
  /** Transform: clips outside the range that it was split from (replayed moved), and those it was moved without. */
  split?: string[];
  dropped?: string[];
  form: string | null;              // the form XObject ("n g") whose stream paints it; null: the page's own stream
  marked?: number;                  // delete: marked-content pairs removed with it (nothing left inside)
  /** Transform: the first object of the wrap it shares with others moved by the same matrix (painted one after another). */
  wrap?: string;
  /** Order: the direction, and the objects it was moved past. `id` may be a group's. */
  order?: 'forward' | 'backward';
  past?: string[];
};

export type ObjectSkipped = { id: string; reason: string };

export type Surgery = {
  changed: ObjectChanged[];
  skipped: ObjectSkipped[];
  /** Edits to the page's own stream (offsets in tree.root.contents). */
  pageEdits: ByteEdit[];
  /** Form copies the page's resources must name (the page's Do operators renamed in `pageEdits`). */
  pageXObjects: Record<string, PDFRef>;
  /** Every edit per stream, by its content path ('' the page, '12', '12/3'), offsets in its bytes as read. */
  streamEdits: Map<string, ByteEdit[]>;
  formsEdited: string[];
  formsCopied: { from: string; to: string }[];
  /** Pixels may change here: each changed object's old and new bounds. */
  regions: Rect[];
  /** New bounds of the changed objects (page space), where they are not simply their old bounds through the matrix. */
  bounds: Map<string, Rect>;
  /** Stretches rewritten for paint order, by content path: where each of their operators went. */
  reordered: Map<string, OrderText[]>;
};

export type SurgeryInput = {
  edit: PdfEdit;
  /** The page's content tree as read before any change (its bytes are what the edits' offsets refer to). */
  tree: ContentTree;
  /** The page's objects, read from that tree. */
  model: PageObjects;
  applied: AppliedOps;
  uses: () => Map<string, number>;
  /** Why a stream cannot be edited here (another change wrote it already), or null. */
  busy?: (node: StreamNode) => string | null;
  /** Why a byte range of the page's own stream cannot be rewritten (edited text in it), or null. */
  touched?: (start: number, end: number) => string | null;
};

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const FILLS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const STROKES = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const PAINT_OPS = new Set([...PATH_PAINT, 'sh', 'Do', 'BI', 'Tj', 'TJ', "'", '"']);
/** Graphics and text state operators replayed when a clip's q … Q is split (ISO 32000-1 Tables 57, 74, 105). */
const STATE_OPS = new Set(['cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts']);

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const latin1Bytes = (s: string) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xff; return o; };
const mat = (m: readonly number[]) => m.map(fmtNum).join(' ');
const inside = (r: Rect, c: Rect, tol = 0.5) => r.x0 >= c.x0 - tol && r.y0 >= c.y0 - tol && r.x1 <= c.x1 + tol && r.y1 <= c.y1 + tol;
const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
const numAt = (o: Op, k: number): number => { const t = o.operands[o.operands.length - k]; return t?.type === 'number' ? t.value : NaN; };
const six = (o: Op): M6 | null => { const v = [6, 5, 4, 3, 2, 1].map((k) => numAt(o, k)); return v.every(Number.isFinite) ? (v as M6) : null; };

/** Splices edits (non-overlapping; insertions at one offset kept in the order given) into bytes, text as latin1. */
export function spliceEdits(bytes: Uint8Array, edits: readonly ByteEdit[]): Uint8Array {
  const sorted = edits.map((e, k) => ({ e, k })).sort((a, b) => a.e.start - b.e.start || a.k - b.k).map((x) => x.e);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const e of sorted) { parts.push(bytes.subarray(pos, e.start), latin1Bytes(e.text)); pos = Math.max(pos, e.end); }
  parts.push(bytes.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * Where each operator of a stream lands after `edits`: its new index, or null when an edit removed it. An edit that
 * replaces exactly one operator by one operator keeps its place (a rewritten cm, a blanked text show).
 */
export function opIndexMap(ops: readonly Op[], edits: readonly ByteEdit[]): (i: number) => number | null {
  const eds = edits.map((e) => ({ ...e, k: e.text ? parseOps(latin1Bytes(e.text)).length : 0, covers: 0 }));
  const cover = ops.map((o) => eds.find((e) => e.start < e.end && e.start <= o.start && o.end <= e.end) ?? null);
  for (const c of cover) if (c) c.covers++;
  const out: (number | null)[] = [];
  let kept = 0;
  ops.forEach((o, i) => {
    const before = eds.reduce((n, e) => n + (e.end <= o.start && e !== cover[i] ? e.k : 0), 0);
    const c = cover[i];
    if (!c) { out.push(kept + before); kept++; return; }
    out.push(c.covers === 1 && c.k === 1 ? kept + before : null);
  });
  return (i) => (i >= 0 && i < out.length ? out[i] : null);
}

/** The content path of a stream node: the Do operator indices from the page's stream down, '/'-joined ('' the page). */
export function nodeKey(n: StreamNode): string {
  const parts: number[] = [];
  for (let p: StreamNode | null = n; p && p.parent && p.call; p = p.parent) parts.unshift(p.call.opIndex);
  return parts.join('/');
}

type GState = { ctm: M6; smask: boolean; fillPat: boolean; strokePat: boolean };
/** The state before each operator (and after the last): page-space CTM, the q and marked-content operators open. */
type St = GState & { q: number[]; mc: number[] };

function category(ctx: PDFContext, res: PDFDict | undefined, cat: string, name: string): PDFObject | undefined {
  const d = res && resolve(ctx, res.get(PDFName.of(cat)));
  return d instanceof PDFDict ? resolve(ctx, lookupByName(d, name)) : undefined;
}
/** A gs name's soft mask: true (one is set), false (/None), or null (the dictionary does not say). */
function softMaskOf(ctx: PDFContext, res: PDFDict | undefined, name: string): boolean | null {
  const g = category(ctx, res, 'ExtGState', name);
  if (!(g instanceof PDFDict)) return null;
  const sm = resolve(ctx, g.get(PDFName.of('SMask')));
  if (sm === undefined) return null;
  return !(sm instanceof PDFName && sm.decodeText() === 'None');
}
function patternSpace(ctx: PDFContext, res: PDFDict | undefined, name: string): boolean {
  if (name === 'Pattern') return true;
  const cs = category(ctx, res, 'ColorSpace', name);
  const first = cs instanceof PDFArray ? resolve(ctx, cs.get(0)) : cs;
  return first instanceof PDFName && first.decodeText() === 'Pattern';
}

function walkStates(ctx: PDFContext, node: StreamNode, init: GState): St[] {
  const out: St[] = [];
  let st: St = { ...init, q: [], mc: [] };
  const stack: St[] = [];
  node.ops.forEach((o, i) => {
    out.push(st);
    const last = o.operands[o.operands.length - 1];
    switch (o.op) {
      case 'q': stack.push(st); st = { ...st, q: [...st.q, i] }; break;
      case 'Q': { const p = stack.pop(); if (p) st = { ...p, mc: st.mc }; break; }
      case 'cm': { const m = six(o); if (m) st = { ...st, ctm: mul(m, st.ctm) }; break; }
      case 'BMC': case 'BDC': st = { ...st, mc: [...st.mc, i] }; break;
      case 'EMC': st = { ...st, mc: st.mc.slice(0, -1) }; break;
      case 'gs': if (last?.type === 'name') { const s = softMaskOf(ctx, node.resources, last.value); if (s !== null) st = { ...st, smask: s }; } break;
      case 'cs': if (last?.type === 'name') st = { ...st, fillPat: patternSpace(ctx, node.resources, last.value) }; break;
      case 'CS': if (last?.type === 'name') st = { ...st, strokePat: patternSpace(ctx, node.resources, last.value) }; break;
      case 'scn': if (last?.type === 'name') st = { ...st, fillPat: true }; break;
      case 'SCN': if (last?.type === 'name') st = { ...st, strokePat: true }; break;
      case 'g': case 'rg': case 'k': st = { ...st, fillPat: false }; break;
      case 'G': case 'RG': case 'K': st = { ...st, strokePat: false }; break;
    }
  });
  out.push(st);
  return out;
}

/** What a move by T does to one clip in force where an object is painted: `own` (set inside the range that moves: it
 *  moves along), `stays` (it holds the object at both places), `split` (a rectangle holding the object, but not its new
 *  place: a copy moves with it), `crop` (it crops the object, or is not a rectangle: the person chooses whether a copy
 *  moves with it or it is left out). */
export type ClipFate = { clip: Clip; fate: 'own' | 'stays' | 'split' | 'crop' };

/**
 * The fate of every clip in force where an object is painted when it moves by T (its own page-space matrix), or why
 * the move is refused (a clip set in an enclosing stream that it would leave, or that is not a rectangle). Selection
 * reads this before recording a move, to offer the choice for the clips that crop it.
 */
export function clipFates(o: PageObject, T: M6, clipById: ReadonlyMap<string, Clip>): { clips: ClipFate[]; refuse: string | null } {
  const [s0, s1] = o.group ?? o.ops;
  const newB = mapRect(o.bounds, T);
  const out: ClipFate[] = [];
  for (const cid of o.clips) {
    const c = clipById.get(cid);
    if (!c) continue;
    const site = clipSite(c);
    const here = site && site.key === o.path.join('/');
    if (here && site.op >= s0 && site.op <= s1) { out.push({ clip: c, fate: 'own' }); continue; }
    if (!here) {
      if (!c.rect) return { clips: out, refuse: 'a clip that is not a rectangle, set outside the stream that paints it, is in force' };
      if (!inside(newB, c.bounds)) return { clips: out, refuse: c.kind === 'bbox' ? 'its new place leaves the box of the form it is in (/BBox), which clips it' : 'a clip set outside the stream that paints it would crop it in its new place' };
      out.push({ clip: c, fate: 'stays' });
      continue;
    }
    const contains = c.rect && inside(o.bounds, c.bounds);
    out.push({ clip: c, fate: contains ? (inside(newB, c.bounds) ? 'stays' : 'split') : 'crop' });
  }
  return { clips: out, refuse: null };
}

/** Why a move is refused when a clip crops the object and the person has not chosen what happens to it. */
export function cropRefusal(c: Clip): string {
  const what = c.rect ? 'crops it' : 'is not a rectangle';
  return c.users > 1
    ? `a clip it shares with ${c.users - 1} other object${c.users > 2 ? 's' : ''} ${what}; moving it needs "move with its crop" or "move without the shared crop"`
    : `a clip set outside its own q … Q ${what}; moving it needs "move with its crop" or "move without the shared crop"`;
}

/** Where a clip is set: its stream's content path and operator index; null for a form's /BBox. */
function clipSite(c: Clip): { key: string; op: number } | null {
  if (c.kind === 'bbox') return null;
  const parts = c.id.split('/');
  const op = Number(parts.pop());
  return Number.isInteger(op) ? { key: parts.join('/'), op } : null;
}

/**
 * The state the levels `chain` (q operators open at `end`, outermost first) set up between their q and `end`, per
 * level, as operator text to replay: state operators and clipping paths (`drop`: clip ids left out), not what paints.
 * Closed q … Q groups in between are skipped (they restore what they set). Null when the stream is not nested so.
 */
function replayLevels(node: StreamNode, pairs: Map<number, number>, chain: number[], end: number, prefix: string, drop: Set<string>): string[][] | null {
  const ops = node.ops;
  const raw = (o: Op) => latin1(node.contents.subarray(o.start, o.end));
  const levels: string[][] = chain.map(() => []);
  let L = 0;
  let path: Op[] = [];
  let clip: string | null = null;
  for (let i = chain[0] + 1; i < end; i++) {
    const o = ops[i];
    if (o.op === 'q') {
      const lv = chain.indexOf(i);
      if (lv >= 0) { L = lv; continue; }
      const close = pairs.get(i);
      if (close === undefined || close >= end) return null;
      i = close;
      continue;
    }
    if (o.op === 'Q') return null;
    if (PATH_BUILD.has(o.op)) { path.push(o); continue; }
    if (o.op === 'W' || o.op === 'W*') { clip = o.op; continue; }
    if (PATH_PAINT.has(o.op) || o.op === 'n') {
      if (clip && path.length && !drop.has(`${prefix}${i}`)) levels[L].push(`${path.map(raw).join(' ')} ${clip} n`);
      path = [];
      clip = null;
      continue;
    }
    if (STATE_OPS.has(o.op)) { levels[L].push(raw(o)); continue; }
    if (o.op === 'TD') { const ty = numAt(o, 1); if (Number.isFinite(ty)) levels[L].push(`${fmtNum(-ty)} TL`); continue; }
    if (o.op === '"') {
      const aw = numAt(o, 3), ac = numAt(o, 2);
      if (Number.isFinite(aw) && Number.isFinite(ac)) levels[L].push(`${fmtNum(aw)} Tw ${fmtNum(ac)} Tc`);
    }
  }
  return levels;
}

type Action = {
  o: PageObject;
  action: 'transform' | 'delete';
  s0: number; s1: number;
  edits: ByteEdit[];
  done: ObjectChanged;
  /** Transform: its page-space matrix, and whether it is a plain wrap of its range (no clip split), so it can share one. */
  T?: M6;
  plain?: boolean;
};

const overlaps = (a: ByteEdit, b: ByteEdit) => {
  if (a.start < a.end && b.start < b.end) return a.start < b.end && b.start < a.end;
  if (a.start === a.end && b.start < b.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end && a.start < a.end) return b.start > a.start && b.start < a.end;
  return false;
};

/** Plans and writes the page's object changes: form streams are written; the page's own stream edits are returned. */
export function objectSurgery(inp: SurgeryInput): Surgery {
  const { edit, tree, model, applied } = inp;
  const ctx = edit.context;
  const out: Surgery = { changed: [], skipped: [], pageEdits: [], pageXObjects: {}, streamEdits: new Map(), formsEdited: [], formsCopied: [], regions: [], bounds: new Map(), reordered: new Map() };
  const byId = new Map(model.objects.map((o) => [o.id, o]));
  const clipById = new Map(model.clips.map((c) => [c.id, c]));
  const nodeOf = new Map(tree.nodes.map((n) => [nodeKey(n), n]));
  const statesOf = new Map<StreamNode, St[]>();
  const states = (n: StreamNode): St[] => {
    let s = statesOf.get(n);
    if (s) return s;
    let init: GState = { ctm: [...IDENTITY], smask: false, fillPat: false, strokePat: false };
    if (n.parent && n.call) {
      const p = states(n.parent)[n.call.opIndex];
      init = { ctm: mul(n.matrix, n.toPage), smask: p.smask, fillPat: p.fillPat, strokePat: p.strokePat };
    }
    statesOf.set(n, (s = walkStates(ctx, n, init)));
    return s;
  };
  const pairsOf = new Map<StreamNode, Map<number, number>>();
  const pairs = (n: StreamNode) => { let p = pairsOf.get(n); if (!p) pairsOf.set(n, (p = qPairs(n.ops))); return p; };
  const ancestorsOf = (o: PageObject) => { const a: PageObject[] = []; for (let p = o.parent ? byId.get(o.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) a.push(p); return a; };

  // what to do, per stream
  const targets: { o: PageObject; action: 'transform' | 'delete' }[] = [];
  for (const id of applied.deleted) {
    const o = byId.get(id);
    if (o && !ancestorsOf(o).some((p) => applied.deleted.has(p.id))) targets.push({ o, action: 'delete' });
  }
  for (const id of applied.own.keys()) {
    const o = byId.get(id);
    if (o && !ancestorsOf(o).some((p) => applied.deleted.has(p.id))) targets.push({ o, action: 'transform' });
  }
  targets.sort((a, b) => a.o.z - b.o.z);
  const byNode = new Map<StreamNode, Action[]>();
  const ownTo = new Map<string, Rect>();   // a moved object's new bounds where its enclosing forms were

  for (const { o, action } of targets) {
    const skip = (reason: string) => { out.skipped.push({ id: o.id, reason }); };
    if (o.kind === 'text') { skip('text is changed through its text box'); continue; }
    const node = nodeOf.get(o.path.join('/'));
    if (!node || node.error) { skip('the stream that paints it cannot be read'); continue; }
    let why: string | null = null;
    for (let n: StreamNode | null = node; n && !why; n = n.parent) why = inp.busy?.(n) ?? null;
    if (why) { skip(why); continue; }
    const ops = node.ops;
    const st = states(node);
    const [s0, s1] = o.group ?? o.ops;
    const prefix = o.path.length ? `${o.path.join('/')}/` : '';
    const form = node.ref ? refKey(node.ref) : null;
    const ownClip = clipById.get(o.id);
    if (!o.group && ownClip && ownClip.users > 0) { skip(`it also sets a clip that ${ownClip.users === 1 ? 'another object is' : `${ownClip.users} other objects are`} painted under`); continue; }

    if (action === 'delete') {
      byNodePush(byNode, node, { o, action, s0, s1, edits: [{ start: ops[s0].start, end: ops[s1].end, text: ' ' }],
        done: { id: o.id, kind: o.kind, action, from: { ...o.bounds }, to: null, how: o.group ? 'group' : 'operator', form } });
      continue;
    }

    // transform
    const T = applied.own.get(o.id)!;
    const st0 = st[s0];
    if (st0.smask || st[o.ops[1]].smask) { skip('a soft mask is in force where it is painted; moving it would change how the mask falls on it'); continue; }
    if (o.clips.some((c) => clipById.get(c)?.kind === 'text')) { skip('text is used as a clip where it is painted'); continue; }
    if (o.kind === 'path' && o.paint && ((FILLS.has(o.paint) && st[o.ops[1]].fillPat) || (STROKES.has(o.paint) && st[o.ops[1]].strokePat))) {
      skip('it is painted with a pattern, which stays anchored to the page; moving it would show another part of the pattern');
      continue;
    }
    const newB = mapRect(o.bounds, T);
    const choice = applied.moveClip.has(o.id) ? 'move' : applied.dropClip.has(o.id) ? 'drop' : null;
    const fates = clipFates(o, T, clipById);
    let refuse: string | null = fates.refuse;
    const escape: { c: Clip; drop: boolean }[] = [];
    for (const f of fates.clips) {
      if (f.fate === 'split') escape.push({ c: f.clip, drop: false });
      else if (f.fate === 'crop') {
        if (choice) escape.push({ c: f.clip, drop: choice === 'drop' });
        else refuse ??= cropRefusal(f.clip);
      }
    }
    if (refuse) { skip(refuse); continue; }

    // a split: the q levels from the outermost one that sets an escaping clip down to the object
    let chain: number[] = [];
    if (escape.length) {
      const open = st0.q;
      let j = open.length;
      for (const { c } of escape) {
        const site = clipSite(c)!;
        const scope = st[site.op].q[st[site.op].q.length - 1];
        const lv = scope === undefined ? -1 : open.indexOf(scope);
        if (lv < 0) { refuse = 'a clip it is painted under has no q … Q around it in its stream, so it cannot be split'; break; }
        j = Math.min(j, lv);
      }
      if (refuse) { skip(refuse); continue; }
      chain = open.slice(j);
      const atQ = st[chain[0]];
      if (atQ.mc.length !== st0.mc.length || st0.mc.some((m, k) => atQ.mc[k] !== m)) { skip('a marked-content sequence starts inside the clip\'s q … Q and around it, so the clip cannot be split'); continue; }
    }
    const dropped = new Set(escape.filter((e) => e.drop).map((e) => e.c.id));

    // new visible bounds (own space): a shading fills the clips in force, those that move with it moved
    let to = newB;
    if (o.kind === 'shading') {
      let b = model.view.crop;
      for (const cid of o.clips) {
        const c = clipById.get(cid);
        if (!c || dropped.has(cid)) continue;
        const site = clipSite(c);
        const here = !!site && site.key === o.path.join('/');
        const moves = here && (site!.op >= s0 || (chain.length > 0 && site!.op > chain[0]));
        b = meet(b, moves ? mapRect(c.bounds, T) : c.bounds);
      }
      to = b;
    }
    ownTo.set(o.id, to);
    const done: ObjectChanged = { id: o.id, kind: o.kind, action, from: { ...o.bounds }, to, m: [...T], how: o.group ? 'group' : 'operator', form };
    const C = (chain.length ? st[chain[0]] : st0).ctm;
    const inv = invert(C);
    if (!inv) { skip('the transformation where it is painted cannot be inverted'); continue; }
    const X = mul(mul(C, T), inv);
    let edits: ByteEdit[];
    if (!chain.length) {
      const first = o.group ? ops[s0 + 1] : undefined;
      const M = first && first.op === 'cm' && s0 + 1 < s1 ? six(first) : null;
      if (M) {
        edits = [{ start: first!.start, end: first!.end, text: `${mat(mul(M, X))} cm` }];
        done.how = 'cm';
      } else {
        edits = [{ start: ops[s0].start, end: ops[s0].start, text: `\nq ${mat(X)} cm\n` }, { start: ops[s1].end, end: ops[s1].end, text: '\nQ\n' }];
      }
    } else {
      // close the levels, paint the object under X with their state replayed (escaping clips moved or dropped), reopen
      const full = replayLevels(node, pairs(node), chain, s0, prefix, new Set());
      const moved = dropped.size ? replayLevels(node, pairs(node), chain, s0, prefix, dropped) : full;
      if (!full || !moved) { skip('the q … Q nesting around it cannot be split'); continue; }
      const before = `\n${'Q\n'.repeat(chain.length)}q ${mat(X)} cm\n${moved.flat().join('\n')}\n`;
      const after = `\nQ\n${full.map((l) => `q\n${l.join('\n')}\n`).join('')}`;
      edits = [{ start: ops[s0].start, end: ops[s0].start, text: before }, { start: ops[s1].end, end: ops[s1].end, text: after }];
      done.split = escape.filter((e) => !e.drop).map((e) => e.c.id);
      if (dropped.size) done.dropped = [...dropped];
    }
    if (!node.ref && edits.some((e) => /[^\x00-\x7f]/.test(e.text))) { skip('its replayed state has bytes outside ASCII'); continue; }
    byNodePush(byNode, node, { o, action, s0, s1, edits, done, T, plain: !chain.length });
  }

  // paint order, planned against the streams as read
  const plan = applied.order.length ? planOrder(model, tree, applied) : null;
  for (const r of plan?.results ?? []) if (!r.ok) out.skipped.push({ id: r.op.id, reason: r.reason! });
  const reorderedNodes = new Set(plan?.streams.map((so) => so.node) ?? []);

  // per stream: accept actions whose edits do not collide; moves by one matrix painted one after another share a wrap
  const nodeEdits = new Map<StreamNode, ByteEdit[]>();
  const nodeActions = new Map<StreamNode, Action[]>();
  for (const [node, actions] of byNode) {
    const accepted: ByteEdit[] = [];
    const kept: Action[] = [];
    actions.sort((a, b) => a.s0 - b.s0 || a.o.z - b.o.z);
    for (const a of actions) {
      if (a.edits.some((e) => accepted.some((x) => overlaps(e, x)))) { out.skipped.push({ id: a.o.id, reason: 'it overlaps another change in the same stream' }); continue; }
      accepted.push(...a.edits);
      out.changed.push(a.done);
      kept.push(a);
    }
    if (!reorderedNodes.has(node)) shareWraps(node, kept, states(node), accepted);
    nodeEdits.set(node, accepted);
    nodeActions.set(node, kept);
  }

  // paint order: each changed stretch rewritten (deepest streams first, so a form copied for a change below is known)
  if (plan) {
    const edited = (n: StreamNode) => (nodeEdits.get(n)?.length ?? 0) > 0;
    const below = (k: StreamNode) => tree.nodes.some((n) => { for (let p: StreamNode | null = n; p; p = p.parent) if (p === k) return edited(n); return false; });
    for (const so of [...plan.streams].sort((a, b) => b.node.depth - a.node.depth)) {
      const node = so.node;
      const results = plan.results.filter((r) => r.ok && r.stream === so.key);
      const refuse = (reason: string) => { for (const r of results) out.skipped.push({ id: r.op.id, reason }); };
      let why: string | null = null;
      for (let n: StreamNode | null = node; n && !why; n = n.parent) why = inp.busy?.(n) ?? null;
      const r0 = so.units[so.changed[0]].range[0], r1 = so.units[so.changed[1]].range[1];
      const start = node.ops[r0].start, end = node.ops[r1].end;
      if (!why && !node.ref) why = inp.touched?.(start, end) ?? null;
      const edits = nodeEdits.get(node) ?? [];
      const fold = new Map<number, UnitFold>();
      const folded = new Set<ByteEdit>();
      for (const a of nodeActions.get(node) ?? []) {
        if (why) break;
        const inside = a.edits.filter((e) => e.start >= start && e.end <= end);
        if (!inside.length) continue;
        const u = so.units.find((x) => x.range[0] === a.s0 && x.range[1] === a.s1);
        if (inside.length !== a.edits.length || !u || a.done.split) { why = 'it is also moved out of a shared clip in this export, which the new order cannot carry'; break; }
        fold.set(u.index, a.action === 'delete' ? { deleted: true } : { edits: a.edits });
        for (const e of a.edits) folded.add(e);
      }
      const others = edits.filter((e) => !folded.has(e));
      if (!why && others.some((e) => overlaps(e, { start, end, text: '' }))) why = 'it overlaps another change in the same stream';
      for (let k = so.changed[0]; k <= so.changed[1] && !why; k++) {
        const u = so.units[k];
        const o = u.text ? undefined : byId.get(u.objects[0]);
        if (o?.kind !== 'form') continue;
        const kid = tree.nodes.find((n) => n.parent === node && n.call?.opIndex === o.ops[1]);
        if (kid?.ref && below(kid) && (inp.uses().get(refKey(kid.ref)) ?? 1) > 1) why = 'a form XObject in the reordered stretch is copied for another change in this export';
      }
      if (why) { refuse(why); continue; }
      const ot = orderText(so, fold, opIndexMap);
      if (!node.ref && /[^\x00-\x7f]/.test(ot.edit.text)) { refuse('binary data (an inline image or a string) lies in the reordered stretch of the page\'s stream'); continue; }
      nodeEdits.set(node, [...others, ot.edit]);
      out.reordered.set(so.key, [...(out.reordered.get(so.key) ?? []), ot]);
      for (const r of results) {
        const ms = r.op.members.map((m) => byId.get(m)!).filter(Boolean);
        const from = ms.reduce<Rect>((a, m) => ({ x0: Math.min(a.x0, m.bounds.x0), y0: Math.min(a.y0, m.bounds.y0), x1: Math.max(a.x1, m.bounds.x1), y1: Math.max(a.y1, m.bounds.y1) }), { ...ms[0].bounds });
        out.changed.push({ id: r.op.id, kind: ms[0].kind, action: 'order', from, to: { ...from }, how: ms.length === 1 && ms[0].group ? 'group' : 'operator', form: node.ref ? refKey(node.ref) : null, order: r.op.to, past: r.past });
        // pixels change only where it and what it passed both paint
        for (const id of r.past ?? []) {
          const p = byId.get(id);
          if (!p) continue;
          const i = meet(from, p.bounds);
          if (i.x1 > i.x0 && i.y1 > i.y0) out.regions.push(i);
        }
      }
    }
  }

  // empty marked-content pairs left by deletions
  for (const [node, kept] of nodeActions) {
    const dels = kept.filter((a) => a.action === 'delete');
    if (dels.length) nodeEdits.get(node)!.push(...emptyMarked(node, dels, nodeEdits.get(node)!));
  }

  // regions and new bounds from what was accepted: the old bounds, and the new ones through every enclosing form's move
  const okOwn = new Map(out.changed.filter((c) => c.action === 'transform').map((c) => [c.id, c.m!]));
  const effOk = (o: PageObject | undefined): M6 => {
    let m: M6 = [...IDENTITY];
    for (let p = o; p; p = p.parent ? byId.get(p.parent) : undefined) m = mul(m, okOwn.get(p.id) ?? IDENTITY);
    return m;
  };
  for (const c of out.changed) {
    if (c.action === 'order') continue;
    const o = byId.get(c.id)!;
    out.regions.push(o.bounds);
    if (c.action !== 'transform') continue;
    c.to = mapRect(ownTo.get(c.id)!, effOk(o.parent ? byId.get(o.parent) : undefined));
    out.regions.push(c.to);
    if (o.kind === 'shading') out.bounds.set(c.id, c.to);
  }

  // write forms deepest first (copy-on-write), collecting renames into their parents
  const renames = new Map<StreamNode, ByteEdit[]>();
  const renameRefs = new Map<StreamNode, Record<string, PDFRef>>();
  const pageRenames: ByteEdit[] = [];
  const pending = new Set([...nodeEdits.keys()].filter((n) => n.ref));
  const uses = pending.size ? inp.uses() : new Map<string, number>();
  while (pending.size) {
    const node = [...pending].sort((a, b) => b.depth - a.depth)[0];
    pending.delete(node);
    const rn = renames.get(node) ?? [];
    const all = [...(nodeEdits.get(node) ?? []), ...rn];
    out.streamEdits.set(nodeKey(node), all);
    const bytes = spliceEdits(node.contents, all);
    const patch: Record<string, PDFObject> = {};
    const entries = renameRefs.get(node);
    if (entries && Object.keys(entries).length) patch.Resources = resourcesWith(ctx, node.resources, 'XObject', entries);
    const key = refKey(node.ref!);
    if ((uses.get(key) ?? 1) <= 1) {
      edit.replaceStream(node.ref!, bytes, patch);
      out.formsEdited.push(key);
      continue;
    }
    const copy = edit.copyStream(node.stream!, bytes, patch);
    out.formsCopied.push({ from: key, to: refKey(copy) });
    const parent = node.parent!;
    const taken = new Set(Object.keys(renameRefs.get(parent) ?? {}));
    const name = freshName(ctx, parent.resources, 'XObject', `${node.call!.name}_pe`, taken);
    const r: ByteEdit = { start: node.call!.nameStart, end: node.call!.nameEnd, text: pdfName(name) };
    if (!renameRefs.has(parent)) renameRefs.set(parent, {});
    renameRefs.get(parent)![name] = copy;
    if (parent.ref) {
      renames.set(parent, [...(renames.get(parent) ?? []), r]);
      pending.add(parent);
    } else {
      out.pageXObjects[name] = copy;
      pageRenames.push(r);
    }
  }
  // the page's own edits first: an insertion before a Do goes before the renamed name at the same offset
  out.pageEdits.push(...(nodeEdits.get(tree.root) ?? []), ...pageRenames);
  out.streamEdits.set('', [...out.pageEdits]);
  return out;
}

/**
 * Moves by one matrix of objects painted one after another in a stream share one wrap: `q X cm` before the first,
 * `Q` after the last and the state operators between them replayed after it (X × C = C × T holds under any cm in
 * between, so each object still lands at T of where it was). Only plain wraps join, and only across state operators.
 */
function shareWraps(node: StreamNode, actions: Action[], st: St[], accepted: ByteEdit[]) {
  const ops = node.ops;
  const raw = (o: Op) => latin1(node.contents.subarray(o.start, o.end));
  const same = (a: M6, b: M6) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);
  const moves = actions.filter((a) => a.action === 'transform' && a.plain && a.T).sort((a, b) => a.s0 - b.s0);
  const runs: Action[][] = [];
  for (const a of moves) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    let ok = !!prev && same(prev.T!, a.T!) && a.s0 > prev.s1;
    for (let i = prev ? prev.s1 + 1 : 0; ok && i < a.s0; i++) ok = STATE_OPS.has(ops[i].op);
    if (ok) run.push(a);
    else runs.push([a]);
  }
  for (const run of runs) {
    if (run.length < 2) continue;
    const first = run[0], last = run[run.length - 1];
    const inv = invert(st[first.s0].ctm);
    if (!inv) continue;
    const replay: string[] = [];
    for (let k = 1; k < run.length; k++) for (let i = run[k - 1].s1 + 1; i < run[k].s0; i++) replay.push(raw(ops[i]));
    const text = replay.join(' ');
    if (!node.ref && /[^\x00-\x7f]/.test(text)) continue;
    const X = mul(mul(st[first.s0].ctm, first.T!), inv);
    for (const a of run) {
      for (const e of a.edits) { const k = accepted.indexOf(e); if (k >= 0) accepted.splice(k, 1); }
      a.edits = [];
      a.done.wrap = first.o.id;
      if (a.done.how === 'cm') a.done.how = 'group';
    }
    first.edits.push({ start: ops[first.s0].start, end: ops[first.s0].start, text: `\nq ${mat(X)} cm\n` });
    last.edits.push({ start: ops[last.s1].end, end: ops[last.s1].end, text: `\nQ\n${text ? `${text}\n` : ''}` });
    accepted.push(...first.edits, ...(last === first ? [] : last.edits));
  }
}

function byNodePush(m: Map<StreamNode, Action[]>, n: StreamNode, a: Action) {
  let l = m.get(n);
  if (!l) m.set(n, (l = []));
  l.push(a);
}

/** Edits removing marked-content pairs (BMC/BDC … EMC) left with nothing painted inside by the deletions, innermost
 *  first; each deletion that was inside one counts it. */
function emptyMarked(node: StreamNode, dels: Action[], accepted: ByteEdit[]): ByteEdit[] {
  const ops = node.ops;
  const pairs: [number, number][] = [];
  const st: number[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'BMC' || o.op === 'BDC') st.push(i);
    else if (o.op === 'EMC') { const a = st.pop(); if (a !== undefined) pairs.push([a, i]); }
  });
  pairs.sort((p, q) => p[1] - p[0] - (q[1] - q[0]));
  const gone: [number, number][] = dels.map((d) => [d.s0, d.s1]);
  const within = (k: number) => gone.some(([a, b]) => k >= a && k <= b);
  const out: ByteEdit[] = [];
  for (const [a, b] of pairs) {
    if (within(a) || within(b)) continue;
    if (!gone.some(([x, y]) => x > a && y < b)) continue;
    let paints = false;
    for (let k = a + 1; k < b && !paints; k++) if (PAINT_OPS.has(ops[k].op) && !within(k)) paints = true;
    if (paints) continue;
    const e1 = { start: ops[a].start, end: ops[a].end, text: ' ' }, e2 = { start: ops[b].start, end: ops[b].end, text: ' ' };
    if ([e1, e2].some((e) => [...accepted, ...out].some((x) => overlaps(e, x)))) continue;
    out.push(e1, e2);
    gone.push([a, b]);
    for (const d of dels) if (d.s0 > a && d.s1 < b) d.done.marked = (d.done.marked ?? 0) + 1;
  }
  return out;
}
