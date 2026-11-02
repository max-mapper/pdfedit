// Paint order (src/objects/order.ts through src/objects/surgery.ts and src/export/objects.ts) on a synthetic page:
// bring forward and send backward by one, twice, there and back; past an image's own q … Q, past text whose state
// the text after it relies on, inside a form XObject; a group as a block; a move folded with a reorder; and the
// refusals (another q … Q level, marked content, a form's boundary, the top of the stream, text). Each export must
// pass verification; pixels may change only where the object and what it passed overlap (no tolerance), and every
// object keeps its operator bytes. Synthetic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Rect } from '../engine/pdfium.ts';
import { openForEdit } from '../pdf/edit.ts';
import { contentTree } from '../pdf/tree.ts';
import { appended, changedOutside, colour, like, meet, near, operatorBytes, passed, render, run, type RGB } from './groupcheck.ts';
import { orderPage } from './groupkit.ts';
import { buildScene } from './hit.ts';
import { proposedGroups } from './groups.ts';
import { listObjects } from './list.ts';
import { applyOps, mapRect, type ObjectOp } from './ops.ts';
import { planOrder, reorderScene, streamUnits } from './order.ts';
import type { PageObjects } from './types.ts';

const RED: RGB = [230, 51, 51], GREEN: RGB = [51, 179, 77], BLUE: RGB = [51, 77, 230];
const at = (m: PageObjects, r: Rect) => m.objects.find((o) => o.kind !== 'text' && near(o.bounds, r, 0.1))!;
const order = (id: string, to: 'forward' | 'backward'): ObjectOp => ({ op: 'order', id, to });
/** The output's objects of the page's own stream with these bounds, in paint order. */
const zOf = (m: PageObjects, r: Rect) => m.objects.find((o) => o.kind !== 'text' && near(o.bounds, r, 0.1))!.z;
async function sameBytes(a: Uint8Array, b: Uint8Array) { assert.deepEqual(await operatorBytes(b), await operatorBytes(a), 'every object keeps its operator bytes'); }

test('bring forward: a rectangle over the one above it; only their overlap changes; every object keeps its bytes', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const A = at(m, f.at.a), B = at(m, f.at.b);
  const r = await run(f.bytes, [order(A.id, 'forward')]);
  passed(r);
  assert.deepEqual(r.pr.objectsChanged!.map((c) => [c.id, c.action, c.order, c.past]), [[A.id, 'order', 'forward', [B.id]]]);
  assert.equal(await changedOutside(f.bytes, r.out, [meet(A.bounds, B.bounds)]), 0, 'nothing outside the overlap');
  const before = await render(f.bytes), after = await render(r.out);
  assert.ok(like(colour(before, 190, 660), GREEN) && like(colour(after, 190, 660), RED), 'the overlap is red now');
  assert.ok(like(colour(after, 110, 610), RED) && like(colour(after, 270, 650), GREEN) && like(colour(after, 300, 750), BLUE));
  await sameBytes(f.bytes, r.out);
  assert.ok(zOf(r.after, f.at.a) > zOf(r.after, f.at.b) && zOf(r.after, f.at.a) < zOf(r.after, f.at.c), 'a is between b and c');
  assert.deepEqual(appended(f.bytes, r.out), { old: [(await openForEdit(f.bytes)).doc.getPage(0).ref.objectNumber], added: 1 }, 'the page and its new stream');
});

test('send backward, twice forward, and there and back again', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const A = at(m, f.at.a), B = at(m, f.at.b), C = at(m, f.at.c);
  const r = await run(f.bytes, [order(C.id, 'backward')]);
  passed(r);
  assert.equal(await changedOutside(f.bytes, r.out, [meet(B.bounds, C.bounds)]), 0);
  assert.ok(like(colour(await render(r.out), 260, 705), GREEN), 'b over c where they overlap');
  await sameBytes(f.bytes, r.out);
  // twice forward: past b, then past c (which a does not touch: only a ∩ b changes)
  const t = await run(f.bytes, [order(A.id, 'forward'), order(A.id, 'forward')]);
  passed(t);
  assert.deepEqual(t.pr.objectsChanged!.map((c) => c.past), [[B.id], [C.id]]);
  assert.equal(await changedOutside(f.bytes, t.out, [meet(A.bounds, B.bounds)]), 0);
  assert.ok(zOf(t.after, f.at.a) > zOf(t.after, f.at.c), 'a is on top of the three');
  await sameBytes(f.bytes, t.out);
  // forward then backward: the order as read, nothing written
  const u = await run(f.bytes, [order(A.id, 'forward'), order(A.id, 'backward')]);
  assert.ok(u.ok && !u.pr.objectsChanged?.length, JSON.stringify(u.pr.objectsChanged));
  assert.equal(await changedOutside(f.bytes, u.out, []), 0);
});

test('past an image\'s own q … Q; past text whose font and colour the next line relies on', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const img = at(m, f.at.image), over = at(m, f.at.over);
  const r = await run(f.bytes, [order(over.id, 'backward')]);
  passed(r);
  assert.equal(await changedOutside(f.bytes, r.out, [meet(img.bounds, over.bounds)]), 0);
  assert.ok(like(colour(await render(f.bytes), 175, 475), [0, 0, 204]) && like(colour(await render(r.out), 175, 475), [220, 30, 30]), 'the image on top now');
  await sameBytes(f.bytes, r.out);
  // the yellow bar over the first line of text: the second line keeps its font and colour (replayed after the stretch)
  const bar = at(m, f.at.under);
  const [line1, line2] = m.objects.filter((o) => o.kind === 'text');
  const t = await run(f.bytes, [order(bar.id, 'forward')]);
  passed(t);
  const both = meet(bar.bounds, line1.bounds);
  assert.equal(await changedOutside(f.bytes, t.out, [both]), 0, 'the second line is unchanged');
  const dark = async (bytes: Uint8Array, r: Rect) => {
    const img = await render(bytes);
    let k = 0;
    for (let x = r.x0 + 0.25; x < r.x1; x += 0.5) for (let y = r.y0 + 0.25; y < r.y1; y += 0.5) if (colour(img, x, y).every((v) => v < 80)) k++;
    return k;
  };
  assert.ok((await dark(f.bytes, both)) > 50 && (await dark(t.out, both)) === 0, 'the bar covers the first line');
  assert.ok((await dark(t.out, line2.bounds)) > 50, 'the second line still prints in black');
  await sameBytes(f.bytes, t.out);
  assert.ok(t.after.objects.filter((o) => o.kind === 'text').every((q, k) => near(q.bounds, [line1, line2][k].bounds, 0.1)));
});

test('inside a form XObject (edited in place), a group as a block, and a move folded into a reorder', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const low = at(m, f.at.pairLow), high = at(m, f.at.pairHigh);
  const form = m.objects.find((o) => o.kind === 'form')!;
  const r = await run(f.bytes, [order(low.id, 'forward')]);
  passed(r);
  assert.deepEqual(r.pr.objectForms, { edited: [form.ref!], copied: [] });
  assert.equal(r.pr.objectsChanged![0].form, form.ref);
  assert.equal(await changedOutside(f.bytes, r.out, [meet(low.bounds, high.bounds)]), 0);
  assert.ok(like(colour(await render(r.out), 445, 180), [230, 153, 0]), 'the orange path over the blue one');
  await sameBytes(f.bytes, r.out);
  // the three rectangles, proposed as a group, forward past the image: one block, nothing overlaps
  const g = [...proposedGroups(m).keys()][0];
  const img = at(m, f.at.image);
  const b = await run(f.bytes, [order(g, 'forward')]);
  passed(b);
  assert.deepEqual(b.pr.objectsChanged!.map((c) => [c.id, c.past]), [[g, [img.id]]]);
  assert.equal(await changedOutside(f.bytes, b.out, []), 0);
  assert.ok(zOf(b.after, f.at.image) < zOf(b.after, f.at.a), 'the image is below the three now');
  await sameBytes(f.bytes, b.out);
  // a moved and brought forward in one export: the move is folded into its copy
  const A = at(m, f.at.a), B = at(m, f.at.b);
  const M: [number, number, number, number, number, number] = [1, 0, 0, 1, 20, 0];
  const t = await run(f.bytes, [{ op: 'transform', ids: [A.id], m: M }, order(A.id, 'forward')]);
  passed(t);
  assert.deepEqual(t.pr.objectsChanged!.map((c) => c.action).sort(), ['order', 'transform']);
  const to = mapRect(A.bounds, M);
  assert.equal(await changedOutside(f.bytes, t.out, [A.bounds, to]), 0);
  assert.ok(like(colour(await render(t.out), 230, 660), RED), 'moved, and over b');
  assert.ok(near(t.after.objects.find((o) => o.kind === 'path' && near(o.bounds, to, 0.5))!.bounds, to));
  assert.ok(zOf(t.after, to) > zOf(t.after, B.bounds));
});

test('refused with the reason: another q … Q level, marked content, a form\'s boundary, the top of the stream, text', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const reason = async (op: ObjectOp) => {
    const r = await run(f.bytes, [op]);
    assert.ok(r.ok, r.failures.join('; '));
    assert.equal(r.pr.objectsChanged?.length ?? 0, 0);
    assert.equal(await changedOutside(f.bytes, r.out, []), 0);
    return r.pr.objectsSkipped!.map((s) => s.reason).join('; ');
  };
  assert.match(await reason(order(at(m, f.at.outside).id, 'backward')), /different q … Q levels/);
  const inClip = await run(f.bytes, [order(at(m, f.at.clipped).id, 'forward')]);
  passed(inClip);
  assert.deepEqual(inClip.pr.objectsChanged!.map((c) => c.past), [[at(m, f.at.clipped2).id]], 'two paths under one clip trade places');
  assert.match(await reason(order(at(m, f.at.after).id, 'backward')), /marked-content boundary/);
  assert.match(await reason(order(at(m, f.at.pairHigh).id, 'forward')), /topmost object in its form XObject; the paint order changes only within one content stream/);
  assert.match(await reason(order(at(m, f.at.pairLow).id, 'backward')), /lowest object in its form XObject/);
  assert.match(await reason(order(m.objects.find((o) => o.kind === 'form')!.id, 'forward')), /topmost object in the page's content stream/);
  assert.match(await reason(order(m.objects.find((o) => o.kind === 'text')!.id, 'forward')), /text keeps its place/);
  assert.match(await reason(order(at(m, f.at.a).id, 'backward')), /lowest/);
});

test('the plan: units, runs and the new paint order; the selection scene takes it', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const tree = contentTree(await openForEdit(f.bytes), 0);
  const units = streamUnits(tree.root, m.objects, new Map(m.clips.map((c) => [c.id, c])));
  const text = units.filter((u) => u.text);
  assert.equal(text.length, 2);
  assert.deepEqual(text[0].state, ['/F1 18 Tf', '0 0 0 rg'], 'the first line\'s state that outlives its ET');
  const A = at(m, f.at.a), B = at(m, f.at.b);
  assert.equal(units[0].run, units[1].run);
  const outside = units.find((u) => u.objects[0] === at(m, f.at.outside).id)!;
  assert.notEqual(outside.run, units[outside.index - 1].run);
  assert.match(units[outside.index - 1].next!, /q … Q/);
  const plan = planOrder(m, tree, applyOps(m, [order(A.id, 'forward')]));
  assert.deepEqual([...plan.z].sort(), [[A.id, B.z], [B.id, A.z]].sort());
  const sc = reorderScene(buildScene(m), m, plan.z);
  const ids = sc.items.map((s) => s.id);
  assert.ok(ids.indexOf(A.id) > ids.indexOf(B.id), 'a after b in the scene');
  assert.ok(sc.stale.some((r) => near(r, A.bounds, 0.1)), 'the render is not trusted where a was');
});
