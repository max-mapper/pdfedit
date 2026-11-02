// Edits to a page's objects (the page object model, src/objects/types.ts), recorded against the source file's object
// ids and applied in order. A page keeps its list in `Page.objectOps`; export writes them by surgery on the content
// streams (src/objects/surgery.ts through src/export/objects.ts), so every object the list does not name stays as it
// was, byte for byte.
//
// A transform is a page-space matrix applied after the object's own placement (ISO 32000-1 §8.3.4: x' = a·x + c·y + e,
// y' = b·x + d·y + f). Inside a form that is moved too, each object's own matrix is kept relative to the form's
// original place, so moving a form and then one of its children, or the other way round, composes as the person saw it.
import type { Rect } from '../engine/pdfium.ts';
import { apply, IDENTITY, mul, type M6 } from '../pdf/ops.ts';
import type { PageObject, PageObjects } from './types.ts';

export type ObjectOp =
  /** Page-space matrix applied after the object's own. A clip the objects share with others (or that is set outside
   *  their own q … Q) and that crops them: `sharedClip: 'move'` moves a copy of it with them, so they keep the shape
   *  they had ("Move with its crop"); `'drop'` (or `dropSharedClip: true`) moves them without it ("Move
   *  without the crop"); absent, such a move is refused (src/objects/surgery.ts). */
  | { op: 'transform'; ids: string[]; m: M6; sharedClip?: 'move' | 'drop'; dropSharedClip?: boolean }
  | { op: 'delete'; ids: string[] }
  /** asset: a bytes key held by the app */
  | { op: 'add-image'; key: string; asset: string; frame: Rect; rotate: 0 | 90 | 180 | 270 }
  | { op: 'group'; id: string; members: string[] }
  | { op: 'ungroup'; id: string }
  | { op: 'order'; id: string; to: 'forward' | 'backward' };

/** What a delete means for the file, said by the export report and the editor: the object leaves the page, and the
 *  earlier revision an incremental save keeps still holds it. */
export const DELETE_NOTE = 'Deleted objects are removed from the page. The file\'s earlier version (an incremental save keeps it) still holds them: this is not a redaction.';

export type AppliedOps = {
  /** Per moved object: its own page-space matrix, composed after its CTM and before any enclosing form's own. */
  own: Map<string, M6>;
  /** Moved objects whose shared crop may be dropped (the person confirmed it). */
  dropClip: Set<string>;
  /** Moved objects whose shared crop moves with them (a copy of it, replayed at the new place). */
  moveClip: Set<string>;
  /** Deleted objects (their contents go with them and are not listed). */
  deleted: Set<string>;
  /** Groups in force after the ops: group id → member object ids, in paint order. */
  groups: Map<string, string[]>;
  added: Extract<ObjectOp, { op: 'add-image' }>[];
  /** Paint-order changes, in order, each with the objects it moves (a group's members as they were at that op). */
  order: (Extract<ObjectOp, { op: 'order' }> & { members: string[] })[];
  /** Ops or ids that did nothing, and why, as sentences. */
  notes: string[];
};

export function invert(m: readonly number[]): M6 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export const isIdentity = (m: readonly number[], eps = 1e-6) =>
  Math.abs(m[0] - 1) < eps && Math.abs(m[1]) < eps && Math.abs(m[2]) < eps && Math.abs(m[3] - 1) < eps && Math.abs(m[4]) < 1e-4 && Math.abs(m[5]) < 1e-4;

/** The bounding box of a rectangle's corners through a matrix. */
export function mapRect(r: Rect, m: readonly number[]): Rect {
  const q = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => apply(m, x, y));
  return { x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])) };
}

/** True when a matrix keeps the axes (no shear, no turn other than quarter turns): it maps a box onto a box. */
export const keepsAxes = (m: readonly number[], eps = 1e-9) =>
  (Math.abs(m[1]) < eps && Math.abs(m[2]) < eps) || (Math.abs(m[0]) < eps && Math.abs(m[3]) < eps);

function objectsOf(model: PageObjects | PageObject[]): PageObject[] {
  return Array.isArray(model) ? model : model.objects;
}

export type ApplyOptions = {
  /** Groups in force before the first op: the proposals of src/objects/groups.ts (autoGroups), so an op can name,
   *  move, reorder or ungroup them like groups the person made. */
  groups?: ReadonlyMap<string, readonly string[]>;
};

/** Applies the ops in order to the page's objects. An object is a member of one group at most: a group op takes its
 *  members out of any other group, and a group left with fewer than two members is dissolved. */
export function applyOps(model: PageObjects | PageObject[], ops: readonly ObjectOp[], opts: ApplyOptions = {}): AppliedOps {
  const objects = objectsOf(model);
  const byId = new Map(objects.map((o) => [o.id, o]));
  const out: AppliedOps = { own: new Map(), dropClip: new Set(), moveClip: new Set(), deleted: new Set(), groups: new Map(), added: [], order: [], notes: [] };
  for (const [id, members] of opts.groups ?? []) if (!byId.has(id)) out.groups.set(id, members.filter((m) => byId.has(m)));
  const ancestors = (o: PageObject): PageObject[] => {
    const a: PageObject[] = [];
    for (let p = o.parent ? byId.get(o.parent) : undefined; p; p = p.parent ? byId.get(p.parent) : undefined) a.push(p);
    return a;
  };
  const gone = (o: PageObject) => out.deleted.has(o.id) || ancestors(o).some((p) => out.deleted.has(p.id));
  const eff = (o: PageObject | undefined): M6 => {
    let m: M6 = [...IDENTITY];
    for (let p = o; p; p = p.parent ? byId.get(p.parent) : undefined) m = mul(m, out.own.get(p.id) ?? IDENTITY);
    return m;
  };
  /** Object ids for a list of object and group ids: groups expanded, unknown ids noted, and an object dropped when an
   *  enclosing form is listed too (it moves with the form). */
  const expand = (ids: readonly string[], what: string): PageObject[] => {
    const seen = new Set<string>();
    const found: PageObject[] = [];
    const visit = (id: string, depth: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      const g = out.groups.get(id);
      if (g && depth < 16) { for (const m of g) visit(m, depth + 1); return; }
      const o = byId.get(id);
      if (!o) { out.notes.push(`${what}: there is no object or group ${id} on the page`); return; }
      found.push(o);
    };
    for (const id of ids) visit(id, 0);
    const listed = new Set(found.map((o) => o.id));
    return found.filter((o) => !ancestors(o).some((p) => listed.has(p.id))).sort((a, b) => a.z - b.z);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'transform': {
        if (!op.m || op.m.length !== 6 || !op.m.every(Number.isFinite) || !invert(op.m)) { out.notes.push('transform: the matrix cannot be inverted'); break; }
        for (const o of expand(op.ids, 'transform')) {
          if (gone(o)) { out.notes.push(`transform: ${o.id} is deleted`); continue; }
          // own' such that eff(o)' = eff(o) × m: own' = own × P × m × P⁻¹, P the parent's effective matrix
          const P = eff(o.parent ? byId.get(o.parent) : undefined);
          const own = mul(mul(mul(out.own.get(o.id) ?? IDENTITY, P), op.m), invert(P)!);
          if (isIdentity(own)) out.own.delete(o.id);
          else out.own.set(o.id, own);
          // the latest choice about a shared crop stands
          if (op.dropSharedClip || op.sharedClip === 'drop') { out.dropClip.add(o.id); out.moveClip.delete(o.id); }
          else if (op.sharedClip === 'move') { out.moveClip.add(o.id); out.dropClip.delete(o.id); }
        }
        break;
      }
      case 'delete':
        for (const o of expand(op.ids, 'delete')) {
          if (gone(o)) continue;
          out.deleted.add(o.id);
          out.own.delete(o.id);
        }
        break;
      case 'group': {
        if (byId.has(op.id)) { out.notes.push(`group: ${op.id} is an object id`); break; }
        const members = expand(op.members, 'group').filter((o) => !gone(o)).map((o) => o.id);
        if (!members.length) break;
        const taken = new Set(members);
        out.groups.delete(op.id);
        for (const [id, ms] of out.groups) {
          const left = ms.filter((m) => !taken.has(m));
          if (left.length === ms.length) continue;
          if (left.length >= 2) out.groups.set(id, left);
          else out.groups.delete(id);
        }
        out.groups.set(op.id, members);
        break;
      }
      case 'ungroup':
        if (!out.groups.delete(op.id)) out.notes.push(`ungroup: there is no group ${op.id}`);
        break;
      case 'add-image': out.added.push(op); break;
      case 'order': {
        const o = byId.get(op.id);
        if (o && gone(o)) { out.notes.push(`order: ${op.id} is deleted`); break; }
        const members = o ? [o.id] : out.groups.has(op.id) ? expand([op.id], 'order').filter((m) => !gone(m)).map((m) => m.id) : [];
        if (!members.length) { if (!o) out.notes.push(`order: there is no object or group ${op.id}`); break; }
        out.order.push({ ...op, members });
        break;
      }
    }
  }
  for (const [id, members] of out.groups) {
    const left = members.filter((m) => { const o = byId.get(m); return o && !gone(o); });
    if (left.length) out.groups.set(id, left);
    else out.groups.delete(id);
  }
  // an order op's objects (a group's members as they were then) that were deleted later stay out of it
  out.order = out.order.map((op) => ({ ...op, members: op.members.filter((m) => { const o = byId.get(m); return !!o && !gone(o); }) })).filter((op) => op.members.length);
  return out;
}

/** An object's page-space matrix after the ops: its own, then every enclosing form's own (identity when none moved). */
export function effectiveMatrix(applied: AppliedOps, byId: Map<string, PageObject>, id: string): M6 {
  let m: M6 = [...IDENTITY];
  for (let p = byId.get(id); p; p = p.parent ? byId.get(p.parent) : undefined) m = mul(m, applied.own.get(p.id) ?? IDENTITY);
  return m;
}

/** True when the object or an enclosing form is deleted. */
export function isDeleted(applied: AppliedOps, byId: Map<string, PageObject>, id: string): boolean {
  for (let p = byId.get(id); p; p = p.parent ? byId.get(p.parent) : undefined) if (applied.deleted.has(p.id)) return true;
  return false;
}
