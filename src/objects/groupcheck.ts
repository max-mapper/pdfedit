// Test helpers for groups and paint order (src/objects/groups.test.ts, src/objects/order.test.ts): export a page's
// object ops with verification, render pages, read colours, compare every object's operator bytes, and list what the
// incremental update appends. Synthetic only.
import assert from 'node:assert/strict';
import { openPdfium, type Bitmap, type Rect } from '../engine/pdfium.ts';
import { diffOutside } from '../engine/diff.ts';
import { toView, type ViewBox } from '../engine/view.ts';
import { exportDoc, type ExportOptions, type PageReport } from '../export/export.ts';
import '../export/objects.ts';
import { openForEdit } from '../pdf/edit.ts';
import { hasQpdf, lastStartxref, qpdfCheck, readXrefSection } from '../pdf/testing.ts';
import { contentTree } from '../pdf/tree.ts';
import type { Doc } from '../model/types.ts';
import { listObjects } from './list.ts';
import type { ObjectOp } from './ops.ts';
import type { PageObjects } from './types.ts';

export type RGB = [number, number, number];
export type Run = { model: PageObjects; out: Uint8Array; pr: PageReport; after: PageObjects; ok: boolean; failures: string[] };

const noText = () => { throw new Error('no text is laid out in these tests'); };
const noFaces: ExportOptions['faces'] = () => { throw new Error('no fonts are needed in these tests'); };
export const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
export const meet = (a: Rect, b: Rect): Rect => ({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
export const near = (a: Rect, b: Rect, tol = 0.6) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;

/** Exports page 0 with these object ops (verification on, as a report). */
export async function run(bytes: Uint8Array, ops: ObjectOp[]): Promise<Run> {
  const [model] = await listObjects(bytes, [0]);
  const doc: Doc = { pages: [{ n: 0, w: model.view.w, h: model.view.h, boxes: [], view: model.view, objectOps: ops }] };
  const { bytes: out, report } = await exportDoc(bytes, doc, noText, { verify: 'report', faces: noFaces });
  const [after] = await listObjects(out, [0]);
  return { model, out, pr: report.pages[0], after, ok: report.ok, failures: report.failures };
}

export async function render(bytes: Uint8Array, scale = 2): Promise<{ bmp: Bitmap; view: ViewBox; scale: number }> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try { const pg = doc.page(0); try { return { bmp: pg.render(scale), view: pg.view, scale }; } finally { pg.close(); } } finally { doc.close(); }
}

/** The colour at a user-space point. */
export function colour(r: Awaited<ReturnType<typeof render>>, x: number, y: number): RGB {
  const [vx, vy] = toView(r.view, x, y);
  const k = (Math.floor(r.scale * (r.view.h - vy)) * r.bmp.width + Math.floor(r.scale * vx)) * 4;
  return [r.bmp.rgba[k], r.bmp.rgba[k + 1], r.bmp.rgba[k + 2]];
}
export const like = (c: RGB, want: RGB, tol = 40) => c.every((v, i) => Math.abs(v - want[i]) <= tol);

/** Pixels that differ between two renders outside `regions` (grown 1 pt), with no tolerance. */
export async function changedOutside(a: Uint8Array, b: Uint8Array, regions: Rect[]): Promise<number> {
  const [ra, rb] = [await render(a), await render(b)];
  return diffOutside(ra.bmp, rb.bmp, regions.map((x) => grow(x, 1)), ra.scale, ra.view, 0).differing;
}

/** Passed verification, refused nothing (unless allowed), qpdf is content when present, and the output reads cleanly. */
export function passed(r: Run, opts: { skipped?: number } = {}) {
  assert.ok(r.ok, r.failures.join('\n'));
  assert.equal(r.pr.objectsSkipped?.length ?? 0, opts.skipped ?? 0, JSON.stringify(r.pr.objectsSkipped));
  assert.deepEqual(r.after.notes, r.model.notes, r.after.notes.join('; '));
  if (hasQpdf) assert.ok(qpdfCheck(r.out).ok);
}

/** Every object of page 0 as its kind and operator bytes (latin1), sorted: the same list means no object's bytes
 *  changed, wherever they now are in the stream. */
export async function operatorBytes(bytes: Uint8Array): Promise<string[]> {
  const [model] = await listObjects(bytes, [0]);
  const tree = contentTree(await openForEdit(bytes), 0);
  const key = (path: number[]) => path.join('/');
  const nodes = new Map(tree.nodes.map((n) => {
    const parts: number[] = [];
    for (let p: typeof n | null = n; p && p.parent && p.call; p = p.parent) parts.unshift(p.call.opIndex);
    return [key(parts), n] as const;
  }));
  return model.objects.map((o) => {
    const n = nodes.get(key(o.path))!;
    let s = '';
    for (const b of n.contents.subarray(n.ops[o.ops[0]].start, n.ops[o.ops[1]].end)) s += String.fromCharCode(b);
    return `${o.kind} ${s}`;
  }).sort();
}

/** The original is a prefix; the objects the last update appends, as old object numbers and a count of new ones. */
export function appended(original: Uint8Array, out: Uint8Array): { old: number[]; added: number } {
  assert.deepEqual(out.subarray(0, original.length), original, 'the original bytes are a prefix');
  const size = readXrefSection(original, lastStartxref(original)).size;
  const keys = [...readXrefSection(out, lastStartxref(out)).entries.keys()];
  return { old: keys.filter((k) => k < size).sort((p, q) => p - q), added: keys.filter((k) => k >= size).length };
}

/** The page's own stream's operators, by name, counted. */
export async function pageOpCount(bytes: Uint8Array, op: string): Promise<number> {
  return contentTree(await openForEdit(bytes), 0).root.ops.filter((o) => o.op === op).length;
}
