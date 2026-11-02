// The object ops model (src/objects/ops.ts): ops applied in order (moves composed, a form and its contents moved in
// either order, groups expanded, deletes), and undo/redo of the page's op list through Editor.pageEdit. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apply, mul, type M6 } from '../pdf/ops.ts';
import { loadFonts } from '../model/fonts.ts';
import { Editor } from '../model/edit.ts';
import type { Doc } from '../model/types.ts';
import { applyOps, effectiveMatrix, isDeleted, type ObjectOp } from './ops.ts';
import type { PageObject } from './types.ts';

const obj = (id: string, parent: string | null, z: number): PageObject => ({
  id, kind: parent ? 'path' : 'form', z, path: [], ops: [z, z], parent, bounds: { x0: 0, y0: 0, x1: 10, y1: 10 },
  ctm: [1, 0, 0, 1, 0, 0], clips: [], marked: [], group: null, ...(parent ? {} : { children: [] }),
});
const objects = [obj('4', null, 0), obj('4/1', '4', 1), obj('4/2', '4', 2), obj('9', null, 3)];
const byId = new Map(objects.map((o) => [o.id, o]));
const T = (dx: number, dy: number, s = 1): M6 => [s, 0, 0, s, dx, dy];
const close = (a: readonly number[], b: readonly number[]) => a.every((v, k) => Math.abs(v - b[k]) < 1e-9);
/** Where a page point of an object ends up after the ops. */
const at = (ops: ObjectOp[], id: string, x: number, y: number) => apply(effectiveMatrix(applyOps(objects, ops), byId, id), x, y);

test('transforms compose in order; a form and its contents move together in either order, as seen', () => {
  const a = applyOps(objects, [{ op: 'transform', ids: ['9'], m: T(5, 0) }, { op: 'transform', ids: ['9'], m: T(0, 7, 2) }]);
  assert.ok(close(a.own.get('9')!, mul(T(5, 0), T(0, 7, 2))));
  // the form moved, then a child moved by what the person saw (page space after the form's move)
  const formFirst: ObjectOp[] = [{ op: 'transform', ids: ['4'], m: T(0, 0, 2) }, { op: 'transform', ids: ['4/1'], m: T(100, 0) }];
  assert.deepEqual(at(formFirst, '4/1', 1, 1), [102, 2]);
  assert.deepEqual(at(formFirst, '4/2', 1, 1), [2, 2], 'the other child moves with the form only');
  // the child first, then the form: the child's move is then scaled with the form
  const childFirst: ObjectOp[] = [{ op: 'transform', ids: ['4/1'], m: T(100, 0) }, { op: 'transform', ids: ['4'], m: T(0, 0, 2) }];
  assert.deepEqual(at(childFirst, '4/1', 1, 1), [202, 2]);
  // a move back to where it was leaves nothing to write
  assert.equal(applyOps(objects, [{ op: 'transform', ids: ['9'], m: T(3, 4) }, { op: 'transform', ids: ['9'], m: T(-3, -4) }]).own.size, 0);
});

test('groups expand to their members; a member inside a listed form moves with the form only; deletes', () => {
  const a = applyOps(objects, [
    { op: 'group', id: 'g1', members: ['4/1', '9'] },
    { op: 'transform', ids: ['g1'], m: T(1, 0) },
    { op: 'transform', ids: ['4', '4/2'], m: T(0, 1) },
    { op: 'delete', ids: ['9'] },
    { op: 'transform', ids: ['9', 'nope'], m: T(1, 1) },
  ]);
  assert.deepEqual([...a.own.keys()].sort(), ['4', '4/1']);
  assert.ok(!a.own.has('4/2'), 'listed with its form: moved by the form');
  assert.ok(isDeleted(a, byId, '9'));
  assert.deepEqual(a.groups.get('g1'), ['4/1'], 'a deleted member leaves its group');
  assert.ok(a.notes.some((n) => n.includes('9 is deleted')) && a.notes.some((n) => n.includes('nope')), a.notes.join('; '));
  const b = applyOps(objects, [{ op: 'delete', ids: ['4'] }, { op: 'transform', ids: ['4/1'], m: T(1, 0) }]);
  assert.ok(isDeleted(b, byId, '4/2'), 'a form\'s contents go with it');
  assert.equal(b.own.size, 0);
  const c = applyOps(objects, [{ op: 'group', id: 'g', members: ['9'] }, { op: 'ungroup', id: 'g' }, { op: 'transform', ids: ['g'], m: T(1, 0) }]);
  assert.equal(c.own.size, 0);
  assert.ok(c.notes.some((n) => n.includes('no object or group g')));
});

test('undo and redo of object ops through Editor.pageEdit restore the op list exactly', async () => {
  const fonts = await loadFonts();
  const doc: Doc = { pages: [{ n: 0, w: 595, h: 842, boxes: [] }] };
  const ed = new Editor(doc, fonts);
  const push = (op: ObjectOp) => ed.pageEdit(0, 'objects', (pg) => { pg.objectOps = [...(pg.objectOps ?? []), op]; }, ['objectOps']);
  push({ op: 'transform', ids: ['4'], m: T(10, 20, 0.5), dropSharedClip: true });
  const one = structuredClone(doc.pages[0].objectOps);
  push({ op: 'delete', ids: ['9'] });
  const two = structuredClone(doc.pages[0].objectOps);
  assert.equal(two!.length, 2);
  ed.undo();
  assert.deepEqual(doc.pages[0].objectOps, one);
  ed.undo();
  assert.equal(doc.pages[0].objectOps, undefined, 'the page had no ops before');
  ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, one);
  ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, two);
  (doc.pages[0].objectOps![0] as { ids: string[] }).ids.push('changed later');
  ed.undo();
  ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, two, 'the snapshots are copies');
});
