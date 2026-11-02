// Groups of page objects: the groups the editor proposes for logos, icons and charts drawn as many vector paths, the
// groups a person makes from a multi-selection, and how both show in the selection scene (src/objects/hit.ts).
//
// Proposed groups (autoGroups) come from the page object model alone (src/objects/types.ts). Per content stream (the
// page's, or one form XObject's), the objects are taken in paint order; paths painted one after another make a run
// while they are under the same clips (a clip an object sets inside its own q … Q does not count) and in the same
// marked-content sequences (ISO 32000-1 §14.6). A path joins the run when its bounds come within NEAR_PT of the run's
// union; inside one marked-content sequence with an MCID (a tagged figure) every path, image and inline image joins.
// Runs of one stream that come within NEAR_PT of each other merge, so the order a chart paints its bars and axes in
// does not matter. Text, a shading, a form XObject (it is a group already), an image outside such a sequence, an
// object covering more than BACKGROUND_SHARE of the page, a change of clip or marked content, and MAX_MEMBERS end a
// run. A run is a proposal when it has MIN_NEAR members (two in a tagged figure), unless it is every object of its
// form (the form is the group). Two shapes that merely overlap stay two objects, so a click still picks between them.
//
// Groups the person makes, ungroups and moves are ops (src/objects/ops.ts: group, ungroup); applyOps takes the
// proposals as the groups in force before the first op, so a proposal can be ungrouped, moved or reordered by its id.
// A group is a selection convenience: it changes no content stream until it is moved or reordered.
//
// Units: user space (PDF points, y up). Synthetic tests: src/objects/groups.test.ts.
import type { Rect } from '../engine/pdfium.ts';
import type { Scene, Selectable } from './hit.ts';
import type { PageObject, PageObjects } from './types.ts';

/** Bounds within this many points of a run's union join it (ours; measured on the synthetic charts and icons). */
export const NEAR_PT = 2;
/** A run ends at this many members. */
export const MAX_MEMBERS = 200;
/** Paths painted close together are proposed as a group from this many (a logo, an icon, a chart has more than two). */
export const MIN_NEAR = 3;
/** An object covering more than this share of the page's crop box is a background, not part of a group. */
export const BACKGROUND_SHARE = 0.5;
/** Ids of proposed groups start with this (object ids are digits and slashes). */
export const AUTO_PREFIX = 'auto:';

export type AutoGroup = {
  id: string;
  /** Object ids in paint order. */
  members: string[];
  /** The form whose stream paints them, or null for the page's stream. */
  parent: string | null;
  bounds: Rect;
  /** Why they belong together: one marked-content sequence, or painted close together. */
  why: 'marked' | 'near';
};

const MARKED_JOINS = new Set<PageObject['kind']>(['path', 'image', 'inline-image']);
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const join = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const touches = (a: Rect, b: Rect, d: number) => a.x0 <= b.x1 + d && b.x0 <= a.x1 + d && a.y0 <= b.y1 + d && b.y0 <= a.y1 + d;

/** The clips in force around an object, without those it sets inside its own q … Q (they move with it). */
export function outerClips(o: PageObject): string[] {
  if (!o.group) return o.clips;
  const prefix = o.path.length ? `${o.path.join('/')}/` : '';
  return o.clips.filter((c) => {
    if (!c.startsWith(prefix) || c.includes('#')) return true;
    const rest = c.slice(prefix.length);
    if (!/^\d+$/.test(rest)) return true;
    const i = Number(rest);
    return i < o.group![0] || i > o.group![1];
  });
}

type Run = { members: PageObject[]; bounds: Rect; marked: boolean };

/** The groups proposed for a page (see the top of this file), in paint order of their first members. */
export function autoGroups(model: PageObjects | PageObject[], opts: { crop?: Rect } = {}): AutoGroup[] {
  const objects = Array.isArray(model) ? model : model.objects;
  const crop = opts.crop ?? (Array.isArray(model) ? null : model.view.crop);
  const pageArea = crop ? area(crop) : Infinity;
  const byId = new Map(objects.map((o) => [o.id, o]));
  const streams = new Map<string, PageObject[]>();
  for (const o of [...objects].sort((a, b) => a.z - b.z)) {
    const k = o.parent ?? '';
    let l = streams.get(k);
    if (!l) streams.set(k, (l = []));
    l.push(o);
  }
  const out: AutoGroup[] = [];
  for (const [key, list] of streams) {
    const parent = key === '' ? null : key;
    const done: Run[] = [];
    let chain: Run[] = [];   // runs of one context, not yet ended by anything between them
    let ctx: string | null = null;
    const end = () => { done.push(...chain); chain = []; ctx = null; };
    for (const o of list) {
      const inner = o.marked[o.marked.length - 1];
      const marked = inner?.mcid !== undefined;
      if (!(marked ? MARKED_JOINS.has(o.kind) : o.kind === 'path') || area(o.bounds) > BACKGROUND_SHARE * pageArea) { end(); continue; }
      const c = JSON.stringify([outerClips(o), o.marked]);
      if (c !== ctx) { end(); ctx = c; }
      const last = chain[chain.length - 1];
      if (last && last.members.length < MAX_MEMBERS && (marked || touches(last.bounds, o.bounds, NEAR_PT))) {
        last.members.push(o);
        last.bounds = join(last.bounds, o.bounds);
      } else {
        if (last && last.members.length >= MAX_MEMBERS) { done.push(...chain); chain = []; }
        chain.push({ members: [o], bounds: { ...o.bounds }, marked });
      }
      // runs of this context that now come close merge (bars painted before the axes that reach them)
      while (chain.length >= 2) {
        const b = chain[chain.length - 1], a = chain[chain.length - 2];
        if (a.members.length + b.members.length > MAX_MEMBERS || !touches(a.bounds, b.bounds, NEAR_PT)) break;
        chain.splice(chain.length - 2, 2, { members: [...a.members, ...b.members], bounds: join(a.bounds, b.bounds), marked: a.marked && b.marked });
      }
    }
    end();
    const form = parent ? byId.get(parent) : undefined;
    for (const r of done) {
      if (r.members.length < (r.marked ? 2 : MIN_NEAR)) continue;
      if (form && r.members.length === (form.children?.length ?? -1)) continue;   // the whole form: it is the group
      out.push({ id: `${AUTO_PREFIX}${r.members[0].id}`, members: r.members.map((m) => m.id), parent, bounds: r.bounds, why: r.marked ? 'marked' : 'near' });
    }
  }
  return out.sort((a, b) => byId.get(a.members[0])!.z - byId.get(b.members[0])!.z);
}

/** The proposals as the groups in force before any op (src/objects/ops.ts applyOps' `groups` option). */
export function proposedGroups(model: PageObjects | PageObject[], opts: { crop?: Rect } = {}): Map<string, string[]> {
  return new Map(autoGroups(model, opts).map((g) => [g.id, g.members]));
}

/** An id for a new group of the person's: `group:1`, `group:2`, … not yet taken. */
export function newGroupId(taken: Iterable<string>): string {
  const have = new Set(taken);
  let k = 1;
  while (have.has(`group:${k}`)) k++;
  return `group:${k}`;
}

/**
 * Why these selectables of a scene cannot become one group, or null when they can: two or more, all objects of the
 * page object model (a text box is changed through its text, not moved as an object), all at one level (the page, or
 * inside one form or group).
 */
export function groupRefusal(sc: Scene, ids: readonly string[]): string | null {
  const items = [...new Set(ids)].map((id) => sc.byId.get(id));
  if (items.some((s) => !s)) return 'an object of the selection is no longer on the page';
  const sel = items as Selectable[];
  if (sel.length < 2) return 'select two or more objects first (Shift-click adds to the selection)';
  if (sel.some((s) => s.box)) return 'a text box cannot be grouped with page objects';
  const parents = new Set(sel.map((s) => s.parent));
  if (parents.size > 1) return 'the objects are not on one level (some are inside a form or group, some not)';
  return null;
}

/** The object ids a group of these selectables has: groups expanded to their members (one group at a time). */
export function memberObjects(sc: Scene, ids: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (id: string, depth: number) => {
    const s = sc.byId.get(id);
    if (!s) return;
    if (s.group && depth < 16) { for (const m of s.members) visit(m, depth + 1); return; }
    out.push(s.id);
  };
  for (const id of ids) visit(id, 0);
  return [...new Set(out)];
}

/**
 * The scene with groups as selectables (src/objects/hit.ts): each group whose live members (two or more, at one level)
 * are selectables of the scene becomes one entry at its topmost member's place in paint order, its members inside it,
 * as a form's are. `auto`: the ids of proposals (shown dashed). Mutates and returns the scene.
 */
export function withGroups(sc: Scene, groups: ReadonlyMap<string, readonly string[]>, auto: ReadonlySet<string> = new Set()): Scene {
  for (const [id, ids] of groups) {
    if (sc.byId.has(id)) continue;
    const live = ids.map((m) => sc.byId.get(m)).filter((s): s is Selectable => !!s && !s.box);
    if (live.length < 2) continue;
    const parent = live[0].parent;
    const members = live.filter((s) => s.parent === parent).sort((a, b) => a.z - b.z);
    if (members.length < 2) continue;
    const u = members.reduce<Rect>((r, s) => join(r, s.bounds), { ...members[0].bounds });
    const g: Selectable = {
      id, kind: 'group', z: members[members.length - 1].z, parent, bounds: u,
      quad: [[u.x0, u.y0], [u.x1, u.y0], [u.x1, u.y1], [u.x0, u.y1]], clips: [], clipped: members.some((s) => s.clipped),
      members: members.map((s) => s.id), moved: members.some((s) => s.moved), engine: [...new Set(members.flatMap((s) => s.engine))],
      group: auto.has(id) ? 'auto' : 'manual',
    };
    const inGroup = new Set(g.members);
    for (const s of members) s.parent = id;
    sc.items.push(g);
    sc.byId.set(id, g);
    const p = parent ? sc.byId.get(parent) : undefined;
    if (p) p.members = [...p.members.filter((m) => !inGroup.has(m)), id].sort((a, b) => sc.byId.get(a)!.z - sc.byId.get(b)!.z);
  }
  sc.items.sort((a, b) => a.z - b.z || (a.group ? 1 : 0) - (b.group ? 1 : 0) || (a.kind === 'text' ? 1 : 0) - (b.kind === 'text' ? 1 : 0));
  return sc;
}
