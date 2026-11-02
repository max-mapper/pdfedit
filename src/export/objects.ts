// Export of object edits (Page.objectOps, src/objects/ops.ts): a page writer (addPageWriter) that applies the page's
// moves, resizes, turns, deletions and paint-order changes by surgery on the streams that paint the objects
// (src/objects/surgery.ts, src/objects/order.ts), and checks the result in the verification pass. Ops may name the
// groups the editor proposes (src/objects/groups.ts) as well as the person's own.
//
//   - pixels change only inside the changed objects' old and new bounds, and for a paint-order change only where the
//     object and those it moved past overlap (export's pixel check, with these regions);
//   - object identity: the output's object model (src/objects/list.ts, read back through PDFium) has every object the
//     ops did not name, with the same kind, the same operator bytes (ids mapped through the edits' operator shifts) and
//     bounds within 0.1 pt (a reordered stretch's objects found at their new operator indices); the moved objects and
//     their contents at their new bounds (0.5 pt, or inside the turned box for a turn that does not keep the axes);
//     the deleted ones gone; nothing else added.
//
// A delete removes the object from the page; an incremental save keeps the old bytes in the file's earlier revision,
// so it is not a redaction, and the report says so.
//
// Added images (src/objects/place.ts) are painted on top of the page in a new content stream appended after every
// other change; the check finds each one in the output's object model at its frame, and nothing else new.
//
// Other modules may add ops of their own to a page at export (addObjectOpSource): they are applied before the page's
// own, written in the same surgery (one plan per page, so two changes never wrap the same operators twice) and checked
// by the same verification. Each source reports what became of its ops in fields of its own; the object fields of
// the report list only the page's own ops.
import { PDFStream } from 'pdf-lib';
import type { Rect } from '../engine/pdfium.ts';
import { decodeStream } from '../pdf/edit.ts';
import { IDENTITY, mul, type M6 } from '../pdf/ops.ts';
import { contentTree, mapOffset, type ContentTree, type StreamNode } from '../pdf/tree.ts';
import { pageObjects } from '../objects/list.ts';
import { proposedGroups } from '../objects/groups.ts';
import { applyOps, DELETE_NOTE, isIdentity, keepsAxes, mapRect, type ObjectOp } from '../objects/ops.ts';
import { addedContent, planAdded, placedBounds, type Placed } from '../objects/place.ts';
import { nodeKey, objectSurgery, opIndexMap, type ByteEdit, type ObjectChanged, type ObjectSkipped, type Surgery } from '../objects/surgery.ts';
import type { PageObject, PageObjects } from '../objects/types.ts';
import type { Page } from '../model/types.ts';
import type { Replacement } from '../pdf/surgery.ts';
import { addPageWriter, type PageVerifier, type PageWriter } from './export.ts';

/** What the report says about a delete (the editor's status line says it too). */
export { DELETE_NOTE };

declare module './export.ts' {
  interface PageReport {
    /** Object edits written (src/export/objects.ts), and those refused with the reason. */
    objectsChanged?: ObjectChanged[];
    objectsSkipped?: ObjectSkipped[];
    /** Ops that did nothing (unknown ids, ops this writer does not write), and the note on deletes. */
    objectNotes?: string[];
    /** Forms the object edits changed in place ("n g"), and those copied for this page's use. */
    objectForms?: { edited: string[]; copied: { from: string; to: string }[] };
    /** Images added on top of the page: the op's key, the file's format and size in samples, and the frame. */
    imagesAdded?: { key: string; format: string; pixels: [number, number]; frame: Rect; smask: boolean }[];
  }
}

const near = (a: Rect, b: Rect, tol: number) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const within = (r: Rect, c: Rect, tol: number) => r.x0 >= c.x0 - tol && r.y0 >= c.y0 - tol && r.x1 <= c.x1 + tol && r.y1 <= c.y1 + tol;
const fmt = (r: Rect) => `${r.x0.toFixed(1)},${r.y0.toFixed(1)} – ${r.x1.toFixed(1)},${r.y1.toFixed(1)}`;
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const STROKED = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);

/** Where an offset in the blanked page stream was in the stream as read (outside every replaced range). */
function unmapOffset(reps: Replacement[], at: number): number {
  let d = 0;
  for (const r of reps) if (r.newEnd <= at) d += r.newEnd - r.newStart - (r.end - r.start);
  return at - d;
}

/** True when the object's new bounds are its old ones through `m` exactly (else they lie inside them). */
function exactUnder(o: PageObject, m: M6): boolean {
  if (keepsAxes(m)) {
    if (o.kind === 'path' && o.paint && STROKED.has(o.paint)) return Math.abs(Math.hypot(m[0], m[1]) - Math.hypot(m[2], m[3])) < 1e-6;
    return true;
  }
  return (o.kind === 'image' || o.kind === 'inline-image' || o.kind === 'form') && keepsAxes(o.ctm);
}

/** Streams another change already wrote in this export: a form whose bytes differ from the tree's, or whose Do on the
 *  page's stream is renamed by the page's edits. */
function busyCheck(a: Parameters<PageWriter>[0]): (n: StreamNode) => string | null {
  const ctx = a.edit.context;
  return (n) => {
    if (!n.ref) return null;
    const cur = ctx.lookup(n.ref);
    let same = false;
    try {
      const b = cur instanceof PDFStream ? decodeStream(ctx, cur, 'form') : null;
      same = !!b && b.length === n.contents.length && b.every((x, i) => x === n.contents[i]);
    } catch { same = false; }
    if (!same) return 'the form it is in is rewritten for edited text in the same export';
    if (n.parent && !n.parent.ref && n.call) {
      const at = mapOffset(a.replacements, n.call.nameStart);
      if (a.pageEdits.some((e) => e.start === at)) return 'the form it is in is copied for edited text in the same export';
    }
    return null;
  };
}

/** What an op source gives for a page: its ops (they name objects of `model` by id), and its report fields from what
 *  the surgery did (`changed` and `skipped` hold only the objects its ops name). */
export type SourcedOps = {
  ops: ObjectOp[];
  report?: (r: { changed: ObjectChanged[]; skipped: ObjectSkipped[] }) => Record<string, unknown>;
};
/** Another module's ops for a page. `wants` is asked first and cheaply (no object model is read for a page no source
 *  wants and without ops of its own); `ops` gets the writer's arguments and the page's object model. */
export type ObjectOpSource = {
  wants: (page: Page) => boolean;
  ops: (a: Parameters<PageWriter>[0], model: PageObjects) => SourcedOps | null;
};
const opSources: ObjectOpSource[] = [];
/** Adds an op source to every export (once). */
export function addObjectOpSource(s: ObjectOpSource): void {
  if (!opSources.includes(s)) opSources.push(s);
}
const sourced = (page: Page) => opSources.some((s) => s.wants(page));

/** The page writer: other modules' ops and Page.objectOps through src/objects/surgery.ts. */
export const objectWriter: PageWriter = (a) => {
  const own = a.page.objectOps ?? [];
  const sources = opSources.filter((s) => s.wants(a.page));
  if (!own.length && !sources.length) return null;
  const pg = a.src.page(a.page.n);
  let model: PageObjects;
  try { model = pageObjects(a.edit, pg, a.tree); } finally { pg.close(); }
  const extra = sources.map((s) => s.ops(a, model)).filter((x): x is SourcedOps => !!x);
  if (!own.length && !extra.some((x) => x.ops.length)) {
    // nothing to write: a source may still report what it refused
    const report = Object.assign({}, ...extra.map((x) => x.report?.({ changed: [], skipped: [] }) ?? {}));
    return Object.keys(report).length ? { regions: [], report } : null;
  }
  const claims = extra.map((x) => new Set(x.ops.flatMap((o) => ('ids' in o ? o.ids : []))));
  const claimed = (id: string) => claims.some((c) => c.has(id));
  const ops = [...extra.flatMap((x) => x.ops), ...own];
  const applied = applyOps(model, ops, { groups: proposedGroups(model) });
  const notes = [...applied.notes];
  const placed = planAdded(applied.added, notes);
  const busy = busyCheck(a);
  const textTouched = a.replacements.length > 0 || a.tree.nodes.some((n) => n.ref && busy(n) !== null);
  // a stretch of the page's stream with edited text in it is not rewritten for paint order
  const touched = (start: number, end: number) => {
    const s0 = mapOffset(a.replacements, start), s1 = mapOffset(a.replacements, end);
    return a.replacements.some((r) => r.start < end && start < r.end) || a.pageEdits.some((e) => e.start < s1 && s0 < Math.max(e.end, e.start + 1))
      ? 'text in this stretch of the page is rewritten in the same export' : null;
  };
  const sx = objectSurgery({ edit: a.edit, tree: a.tree, model, applied, uses: a.uses, busy, touched });
  for (const e of sx.pageEdits) a.pageEdits.push({ start: mapOffset(a.replacements, e.start), end: mapOffset(a.replacements, e.end), text: e.text });
  if (Object.keys(sx.pageXObjects).length) a.edit.addPageXObjects(a.page.n, sx.pageXObjects);
  const changed = sx.changed.filter((c) => !claimed(c.id)), skipped = sx.skipped.filter((c) => !claimed(c.id));
  if (changed.some((c) => c.action === 'delete')) notes.push(DELETE_NOTE);
  const sourceReports = extra.map((x, k) => x.report?.({ changed: sx.changed.filter((c) => claims[k].has(c.id)), skipped: sx.skipped.filter((c) => claims[k].has(c.id)) }) ?? {});
  const pageEdits = a.pageEdits, replacements = a.replacements;
  const added = placed.map(placedBounds);
  const verify: PageVerifier = async (v) => {
    // the page's own stream: the text blanking and every page edit (this writer's and others'), in its bytes as read
    const rootEdits: ByteEdit[] = [
      ...replacements.map((r) => ({ start: r.start, end: r.end, text: r.text })),
      ...pageEdits.map((e) => ({ start: unmapOffset(replacements, e.start), end: unmapOffset(replacements, e.end), text: e.text })),
    ];
    return checkObjects({ model, tree: a.tree, sx, rootEdits, prefixOps: v.check.prefixOps ?? 0, textTouched, added,
      out: async () => {
        const outEdit = await v.outEdit();
        const doc = v.pdfium.open(v.output);
        try { const p = doc.page(a.page.n); try { return { model: pageObjects(outEdit, p), tree: contentTree(outEdit, a.page.n) }; } finally { p.close(); } } finally { doc.close(); }
      } });
  };
  const n = a.page.n, edit = a.edit;
  return {
    regions: [...sx.regions, ...added].map((r) => grow(r, 1)),
    report: {
      ...Object.assign({}, ...sourceReports),
      ...(own.length ? { objectsChanged: changed, objectsSkipped: skipped, objectNotes: notes, objectForms: { edited: sx.formsEdited, copied: sx.formsCopied } } : {}),
      ...(placed.length ? { imagesAdded: placed.map(addedReport) } : {}),
    },
    verify: sx.changed.length || placed.length ? verify : undefined,
    append: placed.length ? () => { const c = addedContent(edit, n, placed); return { content: c.content, resources: { XObject: c.xobjects } }; } : undefined,
  };
};

const addedReport = (p: Placed) => ({
  key: p.op.key, format: p.prepared.info.format, pixels: [p.prepared.info.width, p.prepared.info.height] as [number, number], frame: { ...p.op.frame }, smask: !!p.prepared.smask,
});

export type ObjectCheckInput = {
  model: PageObjects; tree: ContentTree; sx: Surgery;
  /** Frames of images added on top of the page, in paint order. */
  added?: Rect[];
  /** The page stream's edits (offsets in its bytes as read). */
  rootEdits: ByteEdit[];
  prefixOps: number;
  /** Text on the page was rewritten too: text objects are left to the text checks. */
  textTouched: boolean;
  out: () => Promise<{ model: PageObjects; tree: ContentTree }>;
};

/** The object-identity check (see the top of this file). Returns failures as sentences. */
export async function checkObjects(c: ObjectCheckInput): Promise<string[]> {
  const fails: string[] = [];
  const { model, tree, sx } = c;
  const got = await c.out();
  const byId = new Map(model.objects.map((o) => [o.id, o]));
  const outById = new Map(got.model.objects.map((o) => [o.id, o]));
  const srcNodes = new Map(tree.nodes.map((n) => [nodeKey(n), n]));
  const outNodes = new Map(got.tree.nodes.map((n) => [nodeKey(n), n]));
  const own = new Map<string, M6>();
  const deleted = new Set<string>();
  for (const ch of sx.changed) {
    if (ch.action === 'delete') deleted.add(ch.id);
    else if (ch.action === 'transform') own.set(ch.id, ch.m!);
  }
  const chain = (o: PageObject) => { const l: PageObject[] = []; for (let p: PageObject | undefined = o; p; p = p.parent ? byId.get(p.parent) : undefined) l.push(p); return l; };
  const eff = (o: PageObject) => chain(o).reduce<M6>((m, p) => mul(m, own.get(p.id) ?? IDENTITY), [...IDENTITY]);
  const gone = (o: PageObject) => chain(o).some((p) => deleted.has(p.id));
  const changedAncestors = new Set<string>();
  for (const ch of sx.changed) { const o = ch.action === 'order' ? undefined : byId.get(ch.id); if (o) for (const p of chain(o).slice(1)) changedAncestors.add(p.id); }

  // operator index maps per stream, by content path
  const maps = new Map<string, (i: number) => number | null>();
  const mapFor = (key: string) => {
    let f = maps.get(key);
    if (f) return f;
    const node = srcNodes.get(key);
    if (!node) return () => null;
    const base = opIndexMap(node.ops, key === '' ? c.rootEdits : sx.streamEdits.get(key) ?? []);
    const plain = key === '' ? (i: number) => { const k = base(i); return k === null ? null : k + c.prefixOps; } : base;
    // a stretch rewritten for paint order: its operators sit in the new text, which ends just before the next operator
    const stretches = sx.reordered.get(key) ?? [];
    f = !stretches.length ? plain : (i: number) => {
      const r = stretches.find((x) => i >= x.ops[0] && i <= x.ops[1]);
      if (!r) return plain(i);
      const k = r.at.get(i);
      if (k === undefined) return null;
      const after = r.ops[1] + 1 < node.ops.length ? plain(r.ops[1] + 1) : null;
      if (after !== null) return after - r.total + k;
      const before = r.ops[0] > 0 ? plain(r.ops[0] - 1) : (key === '' ? c.prefixOps : 0) - 1;
      return before === null ? null : before + 1 + k;
    };
    maps.set(key, f);
    return f;
  };
  const mapped = (o: PageObject): { id: string; path: number[]; i0: number; i1: number } | null => {
    const path: number[] = [];
    for (let k = 0; k < o.path.length; k++) {
      const d = mapFor(o.path.slice(0, k).join('/'))(o.path[k]);
      if (d === null) return null;
      path.push(d);
    }
    const f = mapFor(o.path.join('/'));
    const i0 = f(o.ops[0]), i1 = f(o.ops[1]);
    if (i0 === null || i1 === null) return null;
    return { id: `${path.length ? `${path.join('/')}/` : ''}${i1}`, path, i0, i1 };
  };
  const bytesOf = (nodes: Map<string, StreamNode>, key: string, i0: number, i1: number): Uint8Array | null => {
    const n = nodes.get(key);
    return n && n.ops[i0] && n.ops[i1] ? n.contents.subarray(n.ops[i0].start, n.ops[i1].end) : null;
  };
  const same = (x: Uint8Array | null, y: Uint8Array | null) => !!x && !!y && x.length === y.length && x.every((b, i) => b === y[i]);

  let expected = 0;
  let checked = 0;
  const matched = new Set<string>();
  for (const o of model.objects) {
    const textLeft = o.kind === 'text' && c.textTouched;
    if (gone(o)) {
      const m = mapped(o);
      const q = m && outById.get(m.id);
      if (q && q.kind === o.kind && same(bytesOf(srcNodes, o.path.join('/'), o.ops[0], o.ops[1]), bytesOf(outNodes, m!.path.join('/'), m!.i0, m!.i1))) {
        fails.push(`deleted ${o.kind} ${o.id} is still on the page`);
      }
      continue;
    }
    if (textLeft) continue;
    expected++;
    const m = mapped(o);
    const q = m && outById.get(m.id);
    if (!m || !q || q.kind !== o.kind) { fails.push(`${o.kind} ${o.id} is not in the output's object model${m ? ` (looked for ${m.id})` : ''}`); continue; }
    checked++;
    matched.add(q.id);
    const E = eff(o);
    if (!isIdentity(E)) {
      const want = sx.bounds.get(o.id) ?? mapRect(o.bounds, E);
      const ok = sx.bounds.has(o.id) || !exactUnder(o, E) ? within(q.bounds, want, 0.5) : near(q.bounds, want, 0.5);
      if (!ok) fails.push(`moved ${o.kind} ${o.id} is at ${fmt(q.bounds)}, not ${fmt(want)}`);
      continue;
    }
    if (!near(q.bounds, o.bounds, 0.1)) fails.push(`${o.kind} ${o.id} moved from ${fmt(o.bounds)} to ${fmt(q.bounds)}`);
    // a form a change was made inside, or one copied for edited text, may paint under a new name
    if (o.kind === 'form' && (changedAncestors.has(o.id) || c.textTouched)) continue;
    if (!same(bytesOf(srcNodes, o.path.join('/'), o.ops[0], o.ops[1]), bytesOf(outNodes, m.path.join('/'), m.i0, m.i1))) {
      fails.push(`${o.kind} ${o.id}: its operators changed`);
    }
  }
  // added images: the output's objects nothing above accounts for, on the page's own streams, in order
  const extra = got.model.objects.filter((o) => !matched.has(o.id) && !(c.textTouched && o.kind === 'text') && o.kind === 'image' && !o.parent);
  for (const [k, frame] of (c.added ?? []).entries()) {
    expected++;
    const i = extra.findIndex((o) => near(o.bounds, frame, 0.5));
    if (i < 0) { fails.push(`added image ${k + 1} is not in the output at ${fmt(frame)}`); continue; }
    if (i > 0) fails.push(`added image ${k + 1} is painted out of order`);
    extra.splice(0, i + 1);
    checked++;
  }
  const outCount = got.model.objects.filter((o) => !(c.textTouched && o.kind === 'text')).length;
  if (outCount !== expected) fails.push(`the output has ${outCount} objects where ${expected} were expected`);
  const before = new Set(model.notes);
  for (const n of got.model.notes) if (!before.has(n)) fails.push(`the output's object model: ${n}`);
  if (!checked && expected) fails.push('no object could be checked');
  return fails;
}

addPageWriter(objectWriter, (page: Page) => !!page.objectOps?.length || sourced(page));
