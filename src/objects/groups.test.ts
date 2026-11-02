// Groups (src/objects/groups.ts) on synthetic pages: a logo of many paths in one marked-content sequence and a sun of
// touching paths proposed as groups, a bar chart (gridlines, axes, bars; its text labels stay text) in either paint
// order, icons in one form XObject, shapes that merely overlap left alone; groups made and undone through the ops
// (src/objects/ops.ts) with undo and redo; groups in the selection scene (src/objects/hit.ts); and a group moved on
// export: one wrap when its members are painted one after another, one per run otherwise, with verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../model/edit.ts';
import { loadFonts } from '../model/fonts.ts';
import type { Doc } from '../model/types.ts';
import { mapRect } from './ops.ts';
import { appended, changedOutside, colour, like, near, operatorBytes, pageOpCount, passed, render, run } from './groupcheck.ts';
import { chartPage, logoPage, orderPage } from './groupkit.ts';
import { buildScene, candidatesAt, tabOrder } from './hit.ts';
import { AUTO_PREFIX, autoGroups, groupRefusal, memberObjects, newGroupId, proposedGroups, withGroups } from './groups.ts';
import { listObjects } from './list.ts';
import { applyOps, type ObjectOp } from './ops.ts';
import { overlapPages } from './selectkit.ts';
import { objectsPage } from './testkit.ts';
import type { PageObjects } from './types.ts';

const inside = (r: { x0: number; y0: number; x1: number; y1: number }, c: typeof r, tol = 1) => r.x0 >= c.x0 - tol && r.y0 >= c.y0 - tol && r.x1 <= c.x1 + tol && r.y1 <= c.y1 + tol;
const ids = (m: PageObjects, pred: (o: PageObjects['objects'][number]) => boolean) => m.objects.filter(pred).map((o) => o.id);

test('a logo of twelve paths in marked content and a sun of nine touching paths are proposed; the background and a lone path are not', async () => {
  const f = await logoPage();
  const [m] = await listObjects(f.bytes);
  assert.deepEqual(m.notes, []);
  const groups = autoGroups(m);
  assert.equal(groups.length, 2, JSON.stringify(groups));
  const [logo, sun] = groups;
  assert.equal(logo.why, 'marked');
  assert.deepEqual(logo.members, ids(m, (o) => o.marked[0]?.mcid === 1), 'every path of the tagged figure, though 6 pt apart');
  assert.ok(near(logo.bounds, f.at.logo));
  assert.equal(sun.why, 'near');
  assert.equal(sun.members.length, 9);
  assert.ok(inside(sun.bounds, f.at.sun) && near(sun.bounds, f.at.sun, 1));
  const lone = m.objects.find((o) => near(o.bounds, f.at.lone))!;
  const background = m.objects[0];
  for (const o of [lone, background]) assert.ok(!groups.some((g) => g.members.includes(o.id)), `${o.id} stays alone`);
  assert.ok(groups.every((g) => g.id.startsWith(AUTO_PREFIX) && !m.objects.some((o) => o.id === g.id)), 'proposal ids are not object ids');
});

test('a bar chart: gridlines, axes and bars are one group and its labels stay text, in either paint order; icons in a form are a group each', async () => {
  const f = await chartPage();
  const [m] = await listObjects(f.bytes);
  const groups = autoGroups(m);
  const page = groups.filter((g) => g.parent === null);
  assert.equal(page.length, 2, JSON.stringify(groups));
  const [chart, chart2] = page;
  const kinds = (g: typeof chart) => g.members.map((id) => m.objects.find((o) => o.id === id)!);
  assert.equal(chart.members.length, 3 + 2 + 5, 'three gridlines, two axes, five bars');
  assert.ok(kinds(chart).every((o) => o.kind === 'path'));
  assert.ok(near(chart.bounds, f.at.chart, 0.6), JSON.stringify(chart.bounds));
  const labels = m.objects.filter((o) => o.kind === 'text');
  assert.equal(labels.length, 6);
  assert.ok(labels.every((t) => !groups.some((g) => g.members.includes(t.id))), 'text is never a member');
  assert.equal(chart2.members.length, 4 + 2, 'bars painted before the axes still join them');
  assert.ok(near(chart2.bounds, f.at.chart2, 0.6));
  const form = m.objects.find((o) => o.kind === 'form')!;
  const icons = groups.filter((g) => g.parent === form.id);
  assert.equal(icons.length, 3, 'one per icon, not the whole form');
  assert.ok(icons.every((g) => g.members.length === 3 && g.members.every((id) => id.startsWith(`${form.id}/`))));
  // a form whose paths all belong together is the group already: no proposal inside it
  const [o] = await listObjects((await objectsPage()).bytes);
  const logoForm = o.objects.find((x) => x.kind === 'form' && x.uses === 1)!;
  assert.ok(!autoGroups(o).some((g) => g.parent === logoForm.id));
});

test('shapes that merely overlap, and an image with a path over it, stay separate objects', async () => {
  const [o] = await listObjects((await objectsPage()).bytes);
  assert.deepEqual(autoGroups(o).filter((g) => g.parent === null), [], 'two overlapping rectangles, a ring, images: no proposal');
  const [ov] = await listObjects((await overlapPages()).bytes, [0]);
  assert.deepEqual(autoGroups(ov), []);
});

test('groups through the ops: proposals in force, ungrouped, regrouped; a group takes its members from another; undo and redo', async () => {
  const f = await orderPage();
  const [m] = await listObjects(f.bytes);
  const proposed = proposedGroups(m);
  const abc = [...proposed.keys()][0];
  assert.equal(proposed.get(abc)!.length, 3, 'the three rectangles are proposed');
  const [a, b, c] = proposed.get(abc)!;
  let g = applyOps(m, [], { groups: proposed }).groups;
  assert.deepEqual(g.get(abc), [a, b, c]);
  g = applyOps(m, [{ op: 'ungroup', id: abc }], { groups: proposed }).groups;
  assert.ok(!g.has(abc));
  // a group of the person's takes two members: the proposal is left with one and dissolves
  const x = applyOps(m, [{ op: 'group', id: 'group:1', members: [a, b] }], { groups: proposed });
  assert.deepEqual(x.groups.get('group:1'), [a, b]);
  assert.ok(!x.groups.has(abc));
  // grouping a group with another object takes its members; ungrouping leaves both alone
  const img = m.objects.find((o) => o.kind === 'image')!.id;
  const y = applyOps(m, [{ op: 'group', id: 'group:1', members: [a, b] }, { op: 'group', id: 'group:2', members: ['group:1', img] }, { op: 'ungroup', id: 'group:2' }], { groups: proposed });
  assert.deepEqual([...y.groups.keys()], []);
  assert.equal(newGroupId(['group:1', 'group:3']), 'group:2');
  // moving a group moves its members; an order op on a group carries its members as they were then
  const z = applyOps(m, [{ op: 'transform', ids: [abc], m: [1, 0, 0, 1, 5, 0] }, { op: 'order', id: abc, to: 'backward' }, { op: 'ungroup', id: abc }], { groups: proposed });
  assert.deepEqual([...z.own.keys()].sort(), [a, b, c].sort());
  assert.deepEqual(z.order.map((o) => o.members), [[a, b, c]]);
  // undo and redo through the editor restore the list
  const fonts = await loadFonts();
  const doc: Doc = { pages: [{ n: 0, w: 595, h: 842, boxes: [] }] };
  const ed = new Editor(doc, fonts);
  const push = (op: ObjectOp) => ed.pageEdit(0, 'objects', (pg) => { pg.objectOps = [...(pg.objectOps ?? []), op]; }, ['objectOps']);
  push({ op: 'group', id: 'group:1', members: [a, c] });
  push({ op: 'ungroup', id: abc });
  const both = structuredClone(doc.pages[0].objectOps);
  ed.undo();
  assert.deepEqual(doc.pages[0].objectOps, [{ op: 'group', id: 'group:1', members: [a, c] }]);
  ed.undo();
  assert.equal(doc.pages[0].objectOps, undefined);
  ed.redo(); ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, both);
  assert.deepEqual([...applyOps(m, both!, { groups: proposed }).groups], [['group:1', [a, c]]]);
});

test('groups in the selection scene: one entry at its topmost member\'s place, members inside; the person\'s groups; refusals', async () => {
  const f = await chartPage();
  const [m] = await listObjects(f.bytes);
  const proposed = proposedGroups(m);
  const sc = withGroups(buildScene(m), proposed, new Set(proposed.keys()));
  const chart = sc.items.find((s) => s.group === 'auto' && s.parent === null && s.members.length === 10)!;
  assert.ok(chart && chart.kind === 'group');
  assert.equal(chart.z, Math.max(...chart.members.map((id) => sc.byId.get(id)!.z)));
  const bar = m.objects.find((o) => o.kind === 'path' && o.paint === 'f' && !o.parent)!;
  const at: [number, number] = [(bar.bounds.x0 + bar.bounds.x1) / 2, (bar.bounds.y0 + bar.bounds.y1) / 2];
  assert.deepEqual(candidatesAt(sc, ...at).map((s) => s.id), [chart.id], 'a click on a bar finds the chart');
  assert.deepEqual(candidatesAt(sc, ...at, chart.id).map((s) => s.id), [bar.id], 'inside the group: the bar');
  assert.ok(!tabOrder(sc, null).some((s) => s.id === bar.id) && tabOrder(sc, null).some((s) => s.id === chart.id));
  const form = sc.items.find((s) => s.object?.kind === 'form')!;
  assert.equal(form.members.length, 3, 'the form holds its three icon groups');
  assert.ok(form.members.every((id) => sc.byId.get(id)!.group === 'auto'));
  // the person's group of two bars, made from the scene's selection
  const bars = chart.members.filter((id) => sc.byId.get(id)!.object!.paint === 'f').slice(0, 2);
  assert.equal(groupRefusal(sc, bars), null);
  assert.match(groupRefusal(sc, [bars[0]])!, /two or more/);
  assert.match(groupRefusal(sc, [chart.id, form.members[0]])!, /one level/);
  const ops: ObjectOp[] = [{ op: 'group', id: 'group:1', members: memberObjects(sc, bars) }];
  const applied = applyOps(m, ops, { groups: proposed });
  const sc2 = withGroups(buildScene(m), applied.groups, new Set([...proposed.keys()].filter((id) => applied.groups.has(id))));
  const mine = sc2.byId.get('group:1')!;
  assert.equal(mine.group, 'manual');
  assert.deepEqual(mine.members, bars);
  assert.equal(sc2.byId.get(chart.id)!.members.length, 8, 'the chart keeps its other members');
  assert.equal(sc2.byId.get(bars[0])!.parent, 'group:1');
  // ungrouped: the bars are back in the chart's place on the page level
  const sc3 = withGroups(buildScene(m), applyOps(m, [{ op: 'ungroup', id: chart.id }], { groups: proposed }).groups);
  assert.ok(!sc3.byId.has(chart.id) && sc3.byId.get(bar.id)!.parent === null);
  // text boxes cannot be grouped
  const sc4 = buildScene(m, { boxes: [{ id: 'b1', frame: { x0: 80, y0: 660, x1: 180, y1: 685 }, objs: [] }] });
  assert.match(groupRefusal(sc4, ['box:b1', bar.id])!, /text box/);
});

test('export: a proposed group moved as one wrap; a group with an object between its members, one wrap per run', async () => {
  const f = await logoPage();
  const [m] = await listObjects(f.bytes);
  const [, sun] = autoGroups(m);
  const T: [number, number, number, number, number, number] = [1, 0, 0, 1, -200, -300];
  const r = await run(f.bytes, [{ op: 'transform', ids: [sun.id], m: T }]);
  passed(r);
  assert.equal(r.pr.objectsChanged!.length, 9);
  assert.ok(r.pr.objectsChanged!.every((c) => c.wrap === sun.members[0]), 'all nine share the first one\'s wrap');
  assert.equal(await pageOpCount(r.out, 'cm'), (await pageOpCount(f.bytes, 'cm')) + 1, 'one q X cm … Q');
  const to = mapRect(sun.bounds, T);
  assert.equal(await changedOutside(f.bytes, r.out, [sun.bounds, to]), 0);
  const img = await render(r.out);
  assert.ok(like(colour(img, 402 - 200, 702 - 300), [255, 178, 0]), 'the sun at its new place');
  assert.ok(!like(colour(img, 402, 702), [255, 178, 0]), 'not at the old one');
  assert.equal(appended(f.bytes, r.out).added, 1, 'one new content stream');
  // the untouched objects (the logo, the text, the background) keep their bytes
  const before = await operatorBytes(f.bytes), after = await operatorBytes(r.out);
  const moved = new Set(sun.members.map((id) => m.objects.find((o) => o.id === id)!));
  assert.equal(after.length, before.length);
  assert.ok(m.objects.filter((o) => !moved.has(o)).every((o) => r.after.objects.some((q) => q.kind === o.kind && near(q.bounds, o.bounds, 0.1))));

  // a group whose members have another object between them: the rectangles a and c of the order page
  const g = await orderPage();
  const [om] = await listObjects(g.bytes);
  const [a, b, c] = om.objects.filter((o) => o.kind === 'path').slice(0, 3);
  const r2 = await run(g.bytes, [{ op: 'group', id: 'group:1', members: [a.id, c.id] }, { op: 'transform', ids: ['group:1'], m: [1, 0, 0, 1, 0, -100] }]);
  passed(r2);
  assert.deepEqual(r2.pr.objectsChanged!.map((x) => [x.id, x.wrap ?? null]), [[a.id, null], [c.id, null]], 'two runs, two wraps');
  assert.equal(await pageOpCount(r2.out, 'cm'), (await pageOpCount(g.bytes, 'cm')) + 2);
  // the two painted one after another: one wrap
  const r3 = await run(g.bytes, [{ op: 'group', id: 'group:1', members: [a.id, b.id] }, { op: 'transform', ids: ['group:1'], m: [1, 0, 0, 1, 0, -100] }]);
  passed(r3);
  assert.deepEqual(r3.pr.objectsChanged!.map((x) => x.wrap), [a.id, a.id]);
  assert.equal(await pageOpCount(r3.out, 'cm'), (await pageOpCount(g.bytes, 'cm')) + 1);
  const i3 = await render(r3.out);
  assert.ok(like(colour(i3, 110, 510), [230, 51, 51]) && like(colour(i3, 270, 560), [51, 179, 77]), 'a and b moved down together');
  assert.ok(like(colour(i3, 350, 760), [51, 77, 230]), 'c stays, still blue (the colour replayed after the wrap)');
  assert.equal(await changedOutside(g.bytes, r3.out, [a.bounds, b.bounds, mapRect(a.bounds, [1, 0, 0, 1, 0, -100]), mapRect(b.bounds, [1, 0, 0, 1, 0, -100])]), 0);
  // ungrouped before the move: the move names nothing
  const r4 = await run(g.bytes, [{ op: 'group', id: 'group:1', members: [a.id, b.id] }, { op: 'ungroup', id: 'group:1' }, { op: 'transform', ids: ['group:1'], m: [1, 0, 0, 1, 0, -100] }]);
  assert.ok(r4.pr.objectNotes?.some((n) => n.includes('no object or group group:1')), JSON.stringify(r4.pr.objectNotes));
});
