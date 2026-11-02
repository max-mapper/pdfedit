// Selecting page objects that overlap: which object a click at a point means.
//
// A page is a list of selectables in paint order (later on top): the objects of the page object model
// (src/objects/types.ts) with text replaced by the editor's text boxes that hold it, and every form XObject as one
// group whose members are the objects painted inside it. At a point, the candidates are the selectables of one level
// (the page, or an entered group) whose bounds contain the point and whose clips do not cut it away; a group is a
// candidate when one of its members is. The render hit test (PdfPage.paintsAt: hide the object, render one pixel,
// compare) keeps those whose hiding changes the pixel; the topmost of those is the hit. When none paints there (white
// on white, a hairline, the empty middle of an outline) the geometry decides: the point in the turned image square,
// in a filled path by its fill rule (curves flattened, ISO 32000-1 §8.5.3.3), within half the line width plus a
// tolerance of a stroked path's outline, inside a text box's frame. Clips cut every test (§8.5.4): a point outside an
// object's clip never hits it.
//
// Edits to objects (moves, deletions; src/objects/ops.ts) are read as `ObjectEdits`: a deleted object is not
// selectable; a moved one is tested at its new place by mapping the point back through its matrix, and the render
// test, which sees the file as it was, is not trusted near anything that moved.
//
// Units: user space (PDF points, y up). Rotated pages need nothing extra: the pointer comes in through fromView.
import type { PdfPage, Rect } from '../engine/pdfium.ts';
import type { PdfEdit } from '../pdf/edit.ts';
import { apply, IDENTITY, mul, type M6, type Op } from '../pdf/ops.ts';
import { contentTree, type ContentTree, type StreamNode } from '../pdf/tree.ts';
import type { Clip, PageObject, PageObjects } from './types.ts';

export type Pt = [number, number];

/** A path in page space, curves flattened: its subpaths, which of them are closed, how it is filled and stroked. */
export type Shape = {
  subs: Pt[][];
  closed: boolean[];
  fill: 'nonzero' | 'evenodd' | null;
  /** Half the stroke width in page space; 0 when not stroked. */
  half: number;
  stroked: boolean;
};

/** What the geometric test needs beyond the object model, read once per page (structured-cloneable). */
export type HitGeometry = {
  /** Path objects by id. */
  paths: Record<string, Shape>;
  /** Clipping paths by clip id (Clip.id). */
  clips: Record<string, Shape>;
  /** The turned quad of each PDFium object (EngineObject.quad) by its index; forms take theirs from here. */
  quads: Record<number, Pt[]>;
  /** For each text object PDFium lists (PdfPage.textObjects() order), its index in PdfPage.objects(). */
  textEngine: number[];
};

/** Object edits in force (the shape of src/objects/ops.ts applyOps' result, the parts selection reads). */
export type ObjectEdits = {
  deleted?: ReadonlySet<string>;
  /** Per moved object: its own page-space matrix, composed after its CTM and before any enclosing form's own. */
  own?: ReadonlyMap<string, readonly number[]>;
  /** Moved objects painted without a shared clip (the person confirmed it). */
  dropClip?: ReadonlySet<string>;
};

/** A text box of the editor: its id, its frame as shown, and the PDFium text objects (PdfPage.textObjects() indices)
 *  that hold its characters (Box.source.objs). */
export type TextBoxRef = { id: string; frame: Rect; objs: number[] };

export type SelKind = 'text' | 'image' | 'inline-image' | 'vector' | 'vector-group' | 'shading' | 'form-group' | 'group';

export type Selectable = {
  /** The object id (PageObject.id), or `box:<id>` for a text box. */
  id: string;
  kind: SelKind;
  /** Paint order (a text box: its last text object's). */
  z: number;
  /** The group (form) it is a member of, or null on the page. */
  parent: string | null;
  /** Page space, after edits. */
  bounds: Rect;
  /** The object's own outline turned with it, four corners in page space, after edits. */
  quad: Pt[];
  /** Clips in force (ids), outermost first; a form's own box not counted for its members in `clipped`. */
  clips: string[];
  clipped: boolean;
  /** Members (groups), in paint order. */
  members: string[];
  /** The editor's text box id (text boxes). */
  box?: string;
  /** The object, for objects of the model. */
  object?: PageObject;
  /** Moved by an edit (it or a group around it): the render of the file does not show it where it is. */
  moved: boolean;
  /** The PDFium objects whose hiding is the render test (a text box: its text objects). */
  engine: number[];
  /** A group of objects (src/objects/groups.ts withGroups): proposed by the editor, or made by the person. */
  group?: 'auto' | 'manual';
};

export type Scene = {
  page: number;
  items: Selectable[];
  byId: Map<string, Selectable>;
  clips: Map<string, Clip>;
  geometry: HitGeometry | null;
  /** Old bounds of everything an edit moved or deleted (the render test is not trusted there). */
  stale: Rect[];
  /** Matrix from page space back to an item's source place (identity unless moved). */
  back: Map<string, M6>;
  /** Text objects selected as a text box: object id → the box's selectable id. */
  claimed: Map<string, string>;
};

const contains = (r: Rect, x: number, y: number, d = 0) => x >= r.x0 - d && x <= r.x1 + d && y >= r.y0 - d && y <= r.y1 + d;
const rectQuad = (r: Rect): Pt[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
const quadRect = (q: Pt[]): Rect => ({
  x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])),
});
const mapQuad = (q: Pt[], m: readonly number[]): Pt[] => q.map(([x, y]) => apply(m, x, y));
const isIdentity = (m: readonly number[]) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) < 1e-9 && Math.abs(m[4]) < 1e-6 && Math.abs(m[5]) < 1e-6;

export function invert(m: readonly number[]): M6 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

// ── geometry from the content stream ───────────────────────────────────────────────────────────────────────

const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const CURVE_STEPS = 12;
const nums = (o: Op): number[] => o.operands.filter((t) => t.type === 'number').map((t) => (t as { value: number }).value);

/** The path built by construction operators ops[i0..i1) under matrix m, curves flattened (ISO 32000-1 §8.5.2). */
export function buildPath(ops: Op[], i0: number, i1: number, m: readonly number[]): { subs: Pt[][]; closed: boolean[] } {
  const subs: Pt[][] = [], closed: boolean[] = [];
  let cur: Pt[] | null = null, at: Pt = [0, 0], first: Pt = [0, 0];
  const put = (p: Pt) => { if (!cur) { cur = [apply(m, at[0], at[1])]; subs.push(cur); closed.push(false); } cur.push(apply(m, p[0], p[1])); at = p; };
  const bez = (p1: Pt, p2: Pt, p3: Pt) => {
    const p0 = at;
    for (let k = 1; k <= CURVE_STEPS; k++) {
      const t = k / CURVE_STEPS, u = 1 - t;
      const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      put([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
    }
  };
  for (let i = i0; i < i1; i++) {
    const o = ops[i];
    if (!PATH_BUILD.has(o.op)) continue;
    const v = nums(o);
    switch (o.op) {
      case 'm': if (v.length >= 2) { at = first = [v[v.length - 2], v[v.length - 1]]; cur = [apply(m, at[0], at[1])]; subs.push(cur); closed.push(false); } break;
      case 'l': if (v.length >= 2) put([v[v.length - 2], v[v.length - 1]]); break;
      case 'c': if (v.length >= 6) bez([v[0], v[1]], [v[2], v[3]], [v[4], v[5]]); break;
      case 'v': if (v.length >= 4) bez(at, [v[0], v[1]], [v[2], v[3]]); break;
      case 'y': if (v.length >= 4) bez([v[0], v[1]], [v[2], v[3]], [v[2], v[3]]); break;
      case 'h': if (cur) { closed[closed.length - 1] = true; at = first; cur = null; } break;
      case 're': {
        if (v.length < 4) break;
        const [x, y, w, h] = v.slice(-4);
        subs.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => apply(m, a, b)));
        closed.push(true);
        at = first = [x, y];
        cur = null;
        break;
      }
    }
  }
  return { subs, closed };
}

const FILL: Record<string, Shape['fill']> = { f: 'nonzero', F: 'nonzero', 'f*': 'evenodd', B: 'nonzero', 'B*': 'evenodd', b: 'nonzero', 'b*': 'evenodd' };
const STROKE = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const CLOSING = new Set(['s', 'b', 'b*']);

/** The node of each content path ('' for the page's stream, '4' or '4/7' for forms), as object ids name them. */
function nodesByPath(tree: ContentTree): Map<string, StreamNode> {
  const out = new Map<string, StreamNode>();
  const pathOf = (n: StreamNode): number[] => (n.parent && n.call ? [...pathOf(n.parent), n.call.opIndex] : []);
  for (const n of tree.nodes) out.set(pathOf(n).join('/'), n);
  if (!out.has('')) out.set('', tree.root);
  return out;
}

/** The page-space CTM before each operator of a stream (q, Q and cm followed from the form's /Matrix). */
function ctmsOf(node: StreamNode): M6[] {
  const out: M6[] = [];
  const stack: M6[] = [];
  let m: M6 = mul(node.matrix, node.toPage);
  for (const o of node.ops) {
    out.push(m);
    if (o.op === 'q') stack.push(m);
    else if (o.op === 'Q') m = stack.pop() ?? m;
    else if (o.op === 'cm') { const v = nums(o); if (v.length >= 6) m = mul(v.slice(-6), m); }
  }
  return out;
}

/** Paths and clipping paths of a page's objects, in page space, from the content stream. */
export function readGeometry(edit: PdfEdit, model: PageObjects, given?: ContentTree): Pick<HitGeometry, 'paths' | 'clips'> {
  const tree = given ?? contentTree(edit, model.page);
  const nodes = nodesByPath(tree);
  const paths: Record<string, Shape> = {};
  const clips: Record<string, Shape> = {};
  for (const o of model.objects) {
    if (o.kind !== 'path') continue;
    const node = nodes.get(o.path.join('/'));
    if (!node) continue;
    const paint = o.paint ?? node.ops[o.ops[1]]?.op ?? 'f';
    const { subs, closed } = buildPath(node.ops, o.ops[0], o.ops[1], o.ctm);
    if (CLOSING.has(paint) && closed.length) closed[closed.length - 1] = true;
    // the model widens a stroked path's bounds by half its line width: read it back from there
    const cp = subs.length ? quadRect(subs.flat()) : o.bounds;
    const half = STROKE.has(paint) ? Math.max(0, cp.x0 - o.bounds.x0, o.bounds.x1 - cp.x1, cp.y0 - o.bounds.y0, o.bounds.y1 - cp.y1) : 0;
    paths[o.id] = { subs, closed, fill: FILL[paint] ?? null, half, stroked: STROKE.has(paint) };
  }
  const ctms = new Map<StreamNode, M6[]>();
  for (const c of model.clips) {
    if (c.kind !== 'path') continue;
    const slash = c.id.lastIndexOf('/');
    const node = nodes.get(slash < 0 ? '' : c.id.slice(0, slash));
    const i = Number(slash < 0 ? c.id : c.id.slice(slash + 1));
    if (!node || !Number.isInteger(i)) continue;
    let s = i - 1;
    while (s >= 0 && (PATH_BUILD.has(node.ops[s].op) || node.ops[s].op === 'W' || node.ops[s].op === 'W*')) s--;
    let m = ctms.get(node);
    if (!m) ctms.set(node, (m = ctmsOf(node)));
    const { subs, closed } = buildPath(node.ops, s + 1, i, m[i] ?? IDENTITY);
    clips[c.id] = { subs, closed: closed.map(() => true), fill: c.evenOdd ? 'evenodd' : 'nonzero', half: 0, stroked: false };
  }
  return { paths, clips };
}

/** Everything the geometric test needs for one page: paths and clips from the content stream, quads and the text
 *  object order from PDFium. */
export function hitGeometry(edit: PdfEdit, pg: PdfPage, model: PageObjects, tree?: ContentTree): HitGeometry {
  const { paths, clips } = readGeometry(edit, model, tree);
  const quads: Record<number, Pt[]> = {};
  for (const e of pg.objects()) if (e.quad && e.quad.length === 4) quads[e.index] = e.quad.map((p) => [p[0], p[1]] as Pt);
  return { paths, clips, quads, textEngine: pg.textObjects().map((t) => t.z) };
}

// ── point tests ────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a point is inside a filled shape by its rule (every subpath closed for filling, §8.5.3.1). */
export function insideFill(shape: Pick<Shape, 'subs'>, rule: 'nonzero' | 'evenodd', x: number, y: number): boolean {
  let wind = 0, cross = 0;
  for (const sub of shape.subs) {
    const n = sub.length;
    if (n < 3) continue;
    for (let k = 0; k < n; k++) {
      const [x0, y0] = sub[k], [x1, y1] = sub[(k + 1) % n];
      if ((y0 <= y) !== (y1 <= y)) {
        const xi = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xi > x) { cross++; wind += y1 > y0 ? 1 : -1; }
      }
    }
  }
  return rule === 'evenodd' ? cross % 2 === 1 : wind !== 0;
}

function lineDist(x: number, y: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** The distance from a point to a shape's outline (closed subpaths include their closing line). */
export function outlineDistance(shape: Pick<Shape, 'subs' | 'closed'>, x: number, y: number): number {
  let d = Infinity;
  shape.subs.forEach((sub, s) => {
    if (sub.length === 1) d = Math.min(d, Math.hypot(x - sub[0][0], y - sub[0][1]));
    for (let k = 0; k + 1 < sub.length; k++) d = Math.min(d, lineDist(x, y, sub[k], sub[k + 1]));
    if (shape.closed[s] && sub.length > 2) d = Math.min(d, lineDist(x, y, sub[sub.length - 1], sub[0]));
  });
  return d;
}

/** Whether a shape paints at a point: in its fill by its rule, or within half its line width plus `tol` of its outline. */
export function shapeHit(shape: Shape, x: number, y: number, tol: number): boolean {
  if (shape.fill && insideFill(shape, shape.fill, x, y)) return true;
  return shape.stroked && outlineDistance(shape, x, y) <= shape.half + tol;
}

function inQuad(q: Pt[], x: number, y: number, tol = 0): boolean {
  if (q.length < 3) return false;
  if (insideFill({ subs: [q] }, 'nonzero', x, y)) return true;
  return tol > 0 && outlineDistance({ subs: [q], closed: [true] }, x, y) <= tol;
}

// ── the scene ──────────────────────────────────────────────────────────────────────────────────────────────

const kindOf = (o: PageObject, objects: Map<string, PageObject>): SelKind => {
  switch (o.kind) {
    case 'path': return 'vector';
    case 'form': {
      const kids = (o.children ?? []).map((id) => objects.get(id)).filter((c): c is PageObject => !!c);
      return kids.length && kids.every((c) => c.kind === 'path' || c.kind === 'shading') ? 'vector-group' : 'form-group';
    }
    default: return o.kind;
  }
};

/** The selectables of a page: the model's objects, text grouped into the editor's text boxes, edits applied. */
export function buildScene(model: PageObjects, opts: { boxes?: TextBoxRef[]; geometry?: HitGeometry | null; edits?: ObjectEdits | null } = {}): Scene {
  const geometry = opts.geometry ?? null;
  const edits = opts.edits ?? {};
  const objects = new Map(model.objects.map((o) => [o.id, o]));
  const byEngine = new Map(model.objects.filter((o) => o.engine !== undefined).map((o) => [o.engine!, o]));
  const deleted = (o: PageObject): boolean => {
    for (let p: PageObject | undefined = o; p; p = p.parent ? objects.get(p.parent) : undefined) if (edits.deleted?.has(p.id)) return true;
    return false;
  };
  // an object's matrix after edits: its own, then each enclosing form's own (as src/objects/ops.ts composes them)
  const eff = (o: PageObject | undefined): M6 => {
    let m: M6 = [...IDENTITY];
    for (let p = o; p; p = p.parent ? objects.get(p.parent) : undefined) { const own = edits.own?.get(p.id); if (own) m = mul(m, own); }
    return m;
  };
  const stale: Rect[] = model.objects.filter((o) => edits.deleted?.has(o.id) || edits.own?.has(o.id)).map((o) => o.bounds);
  const clips = new Map(model.clips.map((c) => [c.id, c]));
  const items: Selectable[] = [];
  const back = new Map<string, M6>();

  // text objects held by a text box are selected as the box
  const claimed = new Map<string, string>();
  const boxItems: Selectable[] = [];
  for (const b of opts.boxes ?? []) {
    const objs = b.objs.map((t) => geometry?.textEngine[t]).map((e) => (e === undefined ? undefined : byEngine.get(e))).filter((o): o is PageObject => !!o && o.kind === 'text');
    const live = objs.filter((o) => !deleted(o));
    if (objs.length && !live.length) continue;
    for (const o of objs) claimed.set(o.id, `box:${b.id}`);
    const parents = new Set(live.map((o) => o.parent));
    const z = live.length ? Math.max(...live.map((o) => o.z)) : model.objects.length + boxItems.length;
    boxItems.push({
      id: `box:${b.id}`, kind: 'text', z, parent: parents.size === 1 ? [...parents][0] : null, bounds: { ...b.frame }, quad: rectQuad(b.frame),
      clips: [], clipped: false, members: [], box: b.id, moved: false, engine: live.map((o) => o.engine!).filter((e) => e !== undefined),
    });
  }
  for (const o of model.objects) {
    if (deleted(o) || claimed.has(o.id)) continue;
    const m = eff(o);
    const moved = !isIdentity(m);
    if (moved) { const inv = invert(m); if (inv) back.set(o.id, inv); }
    let quad: Pt[];
    if (o.kind === 'image' || o.kind === 'inline-image') quad = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => apply(o.ctm, x, y));
    else if (o.kind === 'form' && o.engine !== undefined && geometry?.quads[o.engine]?.length === 4) quad = geometry.quads[o.engine].map((p) => [p[0], p[1]] as Pt);
    else quad = rectQuad(o.bounds);
    if (moved) quad = mapQuad(quad, m);
    const own = o.parent ? `${o.parent}#bbox` : null;
    items.push({
      id: o.id, kind: kindOf(o, objects), z: o.z, parent: o.parent, bounds: moved ? quadRect(quad) : { ...o.bounds }, quad,
      clips: edits.dropClip?.has(o.id) ? o.clips.filter((c) => clips.get(c)?.users === 1 || c === own) : [...o.clips],
      clipped: o.clips.some((c) => c !== own), members: [], object: o, moved,
      engine: o.engine !== undefined ? [o.engine] : [],
    });
  }
  items.push(...boxItems);
  items.sort((a, b) => a.z - b.z || (a.kind === 'text' ? 1 : 0) - (b.kind === 'text' ? 1 : 0));
  const byId = new Map(items.map((s) => [s.id, s]));
  for (const s of items) if (s.parent) byId.get(s.parent)?.members.push(s.id);
  // a group moves when any member does (the render no longer shows it as the file has it)
  for (let k = items.length - 1; k >= 0; k--) { const s = items[k]; if (s.moved && s.parent) { const p = byId.get(s.parent); if (p) p.moved = true; } }
  // a group with a moved member: its members' bounds (a form's box only clips them)
  for (let k = items.length - 1; k >= 0; k--) {
    const s = items[k];
    if (!s.members.length || !s.moved) continue;
    const ms = s.members.map((id) => byId.get(id)!).filter(Boolean);
    const u = ms.reduce<Rect | null>((a, m) => (a ? { x0: Math.min(a.x0, m.bounds.x0), y0: Math.min(a.y0, m.bounds.y0), x1: Math.max(a.x1, m.bounds.x1), y1: Math.max(a.y1, m.bounds.y1) } : { ...m.bounds }), null);
    if (u) { s.bounds = u; s.quad = rectQuad(u); }
  }
  return { page: model.page, items, byId, clips, geometry, stale, back, claimed };
}

/** The point an item is tested at: where it was in the file (moved items map the point back). */
const source = (sc: Scene, s: Selectable, x: number, y: number): Pt => {
  const m = sc.back.get(s.id);
  return m ? apply(m, x, y) : [x, y];
};

function inClips(sc: Scene, s: Selectable, x: number, y: number): boolean {
  const [sx, sy] = source(sc, s, x, y);
  for (const id of s.clips) {
    const c = sc.clips.get(id);
    if (!c) continue;
    const shape = sc.geometry?.clips[id];
    if (c.kind === 'path' && shape && shape.subs.length) { if (!insideFill(shape, shape.fill ?? 'nonzero', sx, sy)) return false; }
    else if (c.kind === 'bbox' && s.parent) {
      const form = sc.byId.get(id.slice(0, -'#bbox'.length));
      const q = form?.object && form.object.engine !== undefined ? sc.geometry?.quads[form.object.engine] : undefined;
      if (q && q.length === 4 ? !inQuad(q, sx, sy, 0.5) : !contains(c.bounds, sx, sy, 0.5)) return false;
    } else if (!contains(c.bounds, sx, sy, 0.5)) return false;
  }
  return true;
}

/** Whether the item's bounds contain the point and no clip cuts it there (a group: one of its members). */
function candidate(sc: Scene, s: Selectable, x: number, y: number, tol: number): boolean {
  if (s.members.length) return s.members.some((id) => { const m = sc.byId.get(id); return !!m && candidate(sc, m, x, y, tol); });
  return contains(s.bounds, x, y, tol) && inClips(sc, s, x, y);
}

/** The geometric test: whether the item covers the point by its shape (no render). `tol`: points. */
export function geometricHit(sc: Scene, s: Selectable, x: number, y: number, tol = 1): boolean {
  if (s.members.length) return s.members.some((id) => { const m = sc.byId.get(id); return !!m && geometricHit(sc, m, x, y, tol); });
  if (!contains(s.bounds, x, y, tol) || !inClips(sc, s, x, y)) return false;
  const [sx, sy] = source(sc, s, x, y);
  const o = s.object;
  if (s.kind === 'text') return true;   // a text box: its frame (as the editor has always selected it); a text object: its bounds
  if (!o) return true;
  if (o.kind === 'image' || o.kind === 'inline-image') {
    const inv = invert(o.ctm);
    if (!inv) return false;
    const [u, v] = apply(inv, sx, sy);
    const e = tol / Math.max(1e-9, Math.sqrt(Math.abs(o.ctm[0] * o.ctm[3] - o.ctm[1] * o.ctm[2])));
    return u >= -e && u <= 1 + e && v >= -e && v <= 1 + e;
  }
  if (o.kind === 'path') {
    const shape = sc.geometry?.paths[o.id];
    return shape ? shapeHit(shape, sx, sy, tol) : true;
  }
  return true;   // a shading fills its clips; the bounds and clips were tested
}

/** Candidates at a point on one level (null: the page; else an entered group's id), topmost first. */
export function candidatesAt(sc: Scene, x: number, y: number, level: string | null = null, tol = 1): Selectable[] {
  return sc.items.filter((s) => s.parent === level && candidate(sc, s, x, y, tol)).reverse();
}

/** Whether the render of the file can be trusted at a point (nothing moved or deleted there). */
export const renderTrusted = (sc: Scene, x: number, y: number) => !sc.stale.some((r) => contains(r, x, y, 1));

/** PDFium objects to ask the render test about, for these candidates at a point (empty where it is not trusted). */
export function renderQuery(sc: Scene, cands: Selectable[], x: number, y: number): number[] {
  if (!renderTrusted(sc, x, y)) return [];
  const out = new Set<number>();
  for (const s of cands) if (!s.moved && s.kind !== 'text') for (const e of s.engine) out.add(e);
  return [...out];
}

export type Ranked = {
  /** The candidates in the order a click cycles through them: painting ones topmost first, then those the
   *  geometry alone finds, then those whose bounds only contain the point. */
  order: Selectable[];
  /** Ids that paint at the point (render test, or the geometry where the render is not trusted). */
  paints: Set<string>;
  /** Ids the geometry finds there. */
  covers: Set<string>;
  /** What a click selects (null: nothing is there). */
  hit: Selectable | null;
};

/** The candidates ranked with the render test's answers (PDFium object index → paints). */
export function rank(sc: Scene, cands: Selectable[], x: number, y: number, rendered: ReadonlyMap<number, boolean>, tol = 1): Ranked {
  const trusted = renderTrusted(sc, x, y);
  const paints = new Set<string>(), covers = new Set<string>();
  for (const s of cands) {
    const geo = geometricHit(sc, s, x, y, tol);
    if (geo) covers.add(s.id);
    const asked = trusted && !s.moved && s.kind !== 'text' && s.engine.length > 0 && s.engine.every((e) => rendered.has(e));
    // a text box paints where its frame is (it is selected by its frame, as the editor always has)
    if (asked ? s.engine.some((e) => rendered.get(e)) : geo) paints.add(s.id);
  }
  const order = [...cands.filter((s) => paints.has(s.id)), ...cands.filter((s) => !paints.has(s.id) && covers.has(s.id)), ...cands.filter((s) => !covers.has(s.id))];
  const hit = order.length && (paints.has(order[0].id) || covers.has(order[0].id)) ? order[0] : null;
  return { order, paints, covers, hit };
}

/** The next entry after `current` in a cycle (wrapping; the first when `current` is not in it). */
export function cycle<T extends { id: string }>(order: readonly T[], current: string | null, dir: 1 | -1 = 1): T | null {
  if (!order.length) return null;
  const k = current === null ? -1 : order.findIndex((s) => s.id === current);
  if (k < 0) return dir > 0 ? order[0] : order[order.length - 1];
  return order[(k + dir + order.length) % order.length];
}

/** The selectables of one level in paint order (Tab order). */
export const tabOrder = (sc: Scene, level: string | null): Selectable[] => sc.items.filter((s) => s.parent === level);

/** Tab (dir 1) or Shift-Tab (dir −1) from `current` on its level (the first or last when nothing is selected). */
export function tabStep(sc: Scene, current: string | null, dir: 1 | -1, level: string | null = null): Selectable | null {
  const cur = current ? sc.byId.get(current) : undefined;
  return cycle(tabOrder(sc, cur ? cur.parent : level), cur ? cur.id : null, dir);
}

/** A member's enclosing groups, outermost first. */
export function groupsOf(sc: Scene, id: string): Selectable[] {
  const out: Selectable[] = [];
  for (let s = sc.byId.get(id); s?.parent; s = sc.byId.get(s.parent)) { const p = sc.byId.get(s.parent); if (p) out.unshift(p); else break; }
  return out;
}
