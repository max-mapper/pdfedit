// Labs (?labs): selecting page objects where several overlap (src/objects/hit.ts).
//
// While "Select objects" is on, a press on a page selects the topmost object painted at that point (the render hit
// test, then the geometry where the render sees nothing). Alt-click, or a second press on the same spot without moving
// (not the second press of a double-click), selects the next object down under the point and wraps; Shift with Alt
// goes up. Tab and Shift-Tab step through the page's objects in paint order. A form XObject is one entry, a group:
// Enter steps into it (its members are then what clicks, Alt-clicks and Tab pick among), Escape steps out. A text box
// is an object like the others; the editor keeps it: a press on a text box that is on top selects it as before, a
// double-click edits it, and while editing the text input keeps every key and press inside the box. The Objects card
// (app/tools/objects.ts) lists the objects under the pointer, or the selection's context, and picks from the list.
//
// Groups (src/objects/groups.ts): paths painted close together (a logo, an icon, a chart) are proposed as one group,
// outlined dashed, selected as one and entered with Enter like a form. Shift-click adds objects to the selection (a
// press on a text box's frame stays the editor's); Group (Ctrl+G) makes the selection one group, Ungroup
// (Ctrl+Shift+G) undoes a group, the person's or a proposed one. Forward (Ctrl+]) and Backward (Ctrl+[) change the
// selection's paint order by one within its content stream (src/objects/order.ts); a move the stream cannot take is
// refused with the reason before anything is recorded. Each is one undo step (Page.objectOps, src/objects/ops.ts).
//
// Handles (src/objects/handles.ts): the selection (an object, a group, an added image, or several) gets eight resize
// handles on its outline, turned with it, and a rotation handle beyond the edge shown highest. Drag the selection's
// body to move it, a handle to resize it along its own axes (Shift keeps the proportions, Alt resizes about the
// centre), the rotation handle to turn it (Shift: steps of 15°); Turn left and Turn right (R, Shift+R) make quarter
// turns; arrows nudge it by 1 pt (Shift: 10 pt) on the page as shown; Delete or Backspace removes it (the status line
// says once per session that a delete is not a redaction). Images added with "Add image" (app/tools/place.ts) are
// selected, listed and moved like the page's own objects; their op's frame changes, so they turn by quarter turns.
// Pages turned by /Rotate need nothing extra: the pointer comes in through fromView and the handles go out through
// toView.
//
// What the page shows: while a drag is on, the selection's pixels are drawn at their new place over the page (its old
// place masked); once the edit is recorded the page is committed at once (the worker exports and renders it, as for
// text), and until that render arrives the same drawing stands in for it under the page's overlay (an underlay).
//
// A clip the moved objects share with others and that crops them: the move is recorded "with its crop" (a copy of the
// clip moves with them, so they keep the shape they had), and the toolbar offers "Move without the crop" instead.
import type { Rect } from '../../src/engine/pdfium.ts';
import { plainView, toView, viewStep, type ViewBox } from '../../src/engine/view.ts';
import {
  buildScene, candidatesAt, cycle, groupsOf, rank, renderQuery, tabOrder, tabStep,
  type HitGeometry, type ObjectEdits, type Pt, type Ranked, type Scene, type Selectable, type SelKind, type TextBoxRef,
} from '../../src/objects/hit.ts';
import { groupRefusal, memberObjects, newGroupId, proposedGroups, withGroups } from '../../src/objects/groups.ts';
import {
  ADD, addedAfter, addedQuad, dragAngle, HANDLES, inQuad, quadCentre, quadRect, resizeMatrix, rotationHandle, SNAP_DEG, squarePoint, translate, turnAbout,
} from '../../src/objects/handles.ts';
import { applyOps, DELETE_NOTE, effectiveMatrix, invert, isDeleted, isIdentity, type AppliedOps, type ObjectOp } from '../../src/objects/ops.ts';
import { reorderScene } from '../../src/objects/order.ts';
import type { AddImage } from '../../src/objects/place.ts';
import { clipFates } from '../../src/objects/surgery.ts';
import type { Clip, PageObjects } from '../../src/objects/types.ts';
import { mul, type M6 } from '../../src/pdf/ops.ts';
import type { Page } from '../../src/model/types.ts';
import { canvasMatrix, sampleBackground, viewOf, type Underlay } from '../../web/preview.ts';
import type { OrderAnswer } from '../ops/order.ts';
import { h } from '../reports.ts';
import type { Tool } from '../toolhost.ts';

/** A row of the Objects card (app/tools/objects.ts). */
export type ObjectRow = {
  id: string; kind: SelKind; label: string; depth: number; z: number; w: number; h: number;
  clipped: boolean; paints: boolean; group: boolean; uses?: number;
  /** A group the editor proposed (shown dashed). */
  auto?: boolean;
};
/** The list the Objects card shows: what is under the pointer, or the selection's context. */
export type ObjectList = { n: number; mode: 'here' | 'selection'; title: string; rows: ObjectRow[]; selected: string | null; picked?: string[] };

export const KIND_LABEL: Record<SelKind, string> = {
  text: 'text', image: 'image', 'inline-image': 'inline image', vector: 'vector', 'vector-group': 'vector group', shading: 'shading', 'form-group': 'form group',
  group: 'group',
};
const isAdded = (id: string) => id.startsWith(ADD);
const labelOf = (s: Selectable) => (isAdded(s.id) ? 'added image' : s.group === 'auto' ? 'proposed group' : KIND_LABEL[s.kind]);

/** The page's object edits (src/objects/ops.ts) with the proposed groups in force before them (src/objects/groups.ts),
 *  and which groups in force are proposals. */
function appliedOf(page: Page | undefined, model: PageObjects): { applied: AppliedOps; auto: Set<string> } {
  const proposed = proposedGroups(model);
  const applied = applyOps(model, page?.objectOps ?? [], { groups: proposed });
  return { applied, auto: new Set([...proposed.keys()].filter((id) => applied.groups.has(id))) };
}
const asEdits = (a: AppliedOps): ObjectEdits => a;

const CSS = `
[data-tool="select"] button[aria-pressed="true"] { background: var(--sel, #2563eb22); }
.tool-layer .obj-sel, .tool-layer .obj-outline, .tool-layer .obj-group { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.tool-layer .obj-sel polygon { fill: #2563eb14; stroke: #2563eb; stroke-width: 1.5px; vector-effect: non-scaling-stroke; }
.tool-layer .obj-outline polygon { fill: #f9ab0014; stroke: #e37400; stroke-width: 1.5px; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
.tool-layer .obj-group polygon { fill: none; stroke: #2563eb88; stroke-width: 1px; stroke-dasharray: 2 3; vector-effect: non-scaling-stroke; }
.tool-layer .obj-sel.obj-auto polygon { stroke-dasharray: 6 3; }
.tool-layer .obj-preview { position: absolute; inset: 0; width: 100%; height: 100%; }
.tool-layer .obj-h { position: absolute; width: 9px; height: 9px; margin: -5.5px 0 0 -5.5px; background: #fff; border: 1.5px solid #2563eb; border-radius: 1px; pointer-events: auto; touch-action: none; }
.tool-layer .obj-h.rot { border-radius: 50%; cursor: grab; }
.tool-layer .obj-stem { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.tool-layer .obj-stem line { stroke: #2563eb; stroke-width: 1px; vector-effect: non-scaling-stroke; }
[data-tool="select"] .crop { display: inline-flex; gap: 4px; align-items: center; }
`;
const NS = 'http://www.w3.org/2000/svg';
const REPEAT_PX = 4;   // a press this close to the last one, with no move beyond it in between, is the same spot
const HIT_PX = 2;      // the geometric test's tolerance around strokes and edges, in screen pixels
const DRAG_PX = 3;     // a press on the selection becomes a move once the pointer has gone this far
const STEM_PX = 22;    // the rotation handle's distance beyond the outline, in screen pixels
/** Whether the status line has said, this session, that a delete is not a redaction. */
let deleteNoted = false;

type PageData = { model: PageObjects; geometry: HitGeometry };
const rectQuad = (r: Rect): Pt[] => [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
const mapQuad = (q: Pt[], m: readonly number[]): Pt[] => q.map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] as Pt);
type Ranking = { ranked: Ranked; inner: Map<string, Ranked> };

const tool: Tool = {
  id: 'select',
  stage: 'labs',
  order: 85,
  setup(host) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const toggle = h('button', { 'aria-pressed': 'true', title: 'Click to select page objects (images, vectors, groups, text boxes); Alt-click or click again for the one below; Tab steps through them' }, 'Select objects') as HTMLButtonElement;
    const groupBtn = h('button', { 'data-cmd': 'group', disabled: '', title: 'Make the selected objects one group (Ctrl+G); Shift-click adds objects to the selection' }, 'Group') as HTMLButtonElement;
    const ungroupBtn = h('button', { 'data-cmd': 'ungroup', disabled: '', title: 'Undo the selected group, yours or a proposed one (Ctrl+Shift+G)' }, 'Ungroup') as HTMLButtonElement;
    const forwardBtn = h('button', { 'data-cmd': 'forward', disabled: '', title: 'Bring the selection forward by one, within its content stream (Ctrl+])' }, 'Forward') as HTMLButtonElement;
    const backwardBtn = h('button', { 'data-cmd': 'backward', disabled: '', title: 'Send the selection backward by one, within its content stream (Ctrl+[)' }, 'Backward') as HTMLButtonElement;
    const turnLeftBtn = h('button', { 'data-cmd': 'turn-left', disabled: '', title: 'Turn the selection a quarter turn left, as shown (Shift+R)' }, 'Turn left') as HTMLButtonElement;
    const turnRightBtn = h('button', { 'data-cmd': 'turn-right', disabled: '', title: 'Turn the selection a quarter turn right, as shown (R)' }, 'Turn right') as HTMLButtonElement;
    const deleteBtn = h('button', { 'data-cmd': 'delete', disabled: '', title: 'Remove the selection from the page (Delete); not a redaction: the file\'s earlier version keeps it' }, 'Delete') as HTMLButtonElement;
    const cropWith = h('button', { 'data-crop': 'move', 'aria-pressed': 'true', title: 'A copy of the crop moves with it, so it keeps the shape it had' }, 'Move with its crop') as HTMLButtonElement;
    const cropWithout = h('button', { 'data-crop': 'drop', 'aria-pressed': 'false', title: 'It moves without the crop and shows whole; the others keep the crop' }, 'Move without the crop') as HTMLButtonElement;
    const cropBar = h('span', { class: 'crop', hidden: '', title: 'A clip it shares with other objects crops it' }, cropWith, cropWithout) as HTMLSpanElement;
    host.toolbar(h('div', { role: 'group', 'aria-label': 'Objects' }, toggle, groupBtn, ungroupBtn, forwardBtn, backwardBtn, turnLeftBtn, turnRightBtn, deleteBtn, cropBar));

    let active = true;
    const data = new Map<number, PageData>();
    const loading = new Map<number, Promise<PageData | null>>();
    const scenes = new Map<number, Scene>();
    /** The selection: an object or a text box (`box:<id>`); `own`: outlined here (the editor refused the text box). */
    let cur: { n: number; id: string; own: boolean } | null = null;
    /** Further objects selected with Shift-click on cur's page and level (cur is the last one picked). */
    let extra: string[] = [];
    /** New paint order of reordered objects per page (the worker's plan of the page's order ops). */
    const orderZ = new Map<number, Map<string, number>>();
    /** The entered group on page n (null: the page). */
    let level: { n: number; id: string | null } = { n: -1, id: null };
    /** The last press, for a second press on the same spot, and the ranking there. */
    let last: { n: number; x: number; y: number; cx: number; cy: number; level: string | null; ranking: Promise<Ranking | null> } | null = null;
    let hover: { n: number; id: string } | null = null;
    let list: ObjectList | null = null;
    let listRanking: Ranking | null = null;   // the ranking a list shows (picking from it keeps it)
    let seq = 0;

    function load(n: number): Promise<PageData | null> {
      const have = data.get(n);
      if (have) return Promise.resolve(have);
      let p = loading.get(n);
      if (!p) {
        const gen = seq;
        p = host.callWorker<PageData>('objects-hit', { n }).then((d) => { if (gen === seq) data.set(n, d); return d; }, () => null).finally(() => loading.delete(n));
        loading.set(n, p);
      }
      return p;
    }

    function scene(n: number): Scene | null {
      const have = scenes.get(n);
      if (have) return have;
      const d = data.get(n);
      if (!d) return null;
      const page = host.doc()?.pages[n];
      const boxes: TextBoxRef[] = (page?.boxes ?? []).map((b) => ({ id: b.id, frame: b.edited ? host.laid(n, b).frame : b.frame, objs: b.source.objs }));
      const { applied, auto } = appliedOf(page, d.model);
      const sc = buildScene(d.model, { geometry: d.geometry, boxes, edits: asEdits(applied) });
      const z = orderZ.get(n);
      if (z) reorderScene(sc, d.model, z);
      withGroups(sc, applied.groups, auto);
      // images added with "Add image": painted on top of the page, in the order added
      let top = sc.items.reduce((m, s) => Math.max(m, s.z), -1) + 1;
      for (const op of addedOn(page)) { const s = addedItem(op, top++); sc.items.push(s); sc.byId.set(s.id, s); }
      scenes.set(n, sc);
      return sc;
    }

    // ── added images and the page's view ────────────────────────────────────────────────────────────────────
    const addedOn = (page: Page | undefined): AddImage[] => (page?.objectOps ?? []).filter((o): o is AddImage => o.op === 'add-image');
    function addedItem(op: AddImage, z: number): Selectable {
      const quad = addedQuad(op.frame, op.rotate);
      return { id: ADD + op.key, kind: 'image', z, parent: null, bounds: { ...op.frame }, quad, clips: [], clipped: false, members: [], moved: false, engine: [] };
    }
    /** A selectable of page n: from the scene, or for an added image from its op alone (before the page's objects are
     *  read). */
    function item(n: number, id: string): Selectable | null {
      const s = scene(n)?.byId.get(id);
      if (s) return s;
      if (!isAdded(id)) return null;
      const ops = addedOn(host.doc()?.pages[n]);
      const k = ops.findIndex((o) => ADD + o.key === id);
      return k < 0 ? null : addedItem(ops[k], 1e6 + k);
    }
    function pageView(n: number): ViewBox {
      const p = host.doc()?.pages[n];
      return data.get(n)?.model.view ?? p?.view ?? plainView(p?.w ?? 1, p?.h ?? 1);
    }
    /** The topmost added image of page n under a point. */
    function addedAt(n: number, x: number, y: number): string | null {
      const ops = addedOn(host.doc()?.pages[n]);
      for (let k = ops.length - 1; k >= 0; k--) if (inQuad(addedQuad(ops[k].frame, ops[k].rotate), x, y)) return ADD + ops[k].key;
      return null;
    }

    const levelOn = (n: number) => (level.n === n ? level.id : null);
    /** Screen pixels as points on page n. */
    function tol(n: number): number {
      const layer = host.pageLayer(n), d = data.get(n);
      const w = layer?.getBoundingClientRect().width ?? 0;
      return d && w > 0 ? (HIT_PX * d.model.view.w) / w : 1;
    }

    /** Candidates at a point ranked with the render test (one worker call), with each group's members ranked too. */
    async function rankAt(n: number, x: number, y: number, lv: string | null): Promise<Ranking | null> {
      if (!(await load(n))) return null;
      const sc = scene(n);
      if (!sc) return null;
      const t = tol(n);
      let cands = candidatesAt(sc, x, y, lv, t);
      if (lv && !cands.length) cands = candidatesAt(sc, x, y, null, t);   // outside the entered group
      const groups = cands.filter((s) => s.members.length);
      const innerCands = new Map(groups.map((g) => [g.id, candidatesAt(sc, x, y, g.id, t)]));
      const ask = [...new Set([...renderQuery(sc, cands, x, y), ...[...innerCands.values()].flatMap((c) => renderQuery(sc, c, x, y))])];
      let got: boolean[] = [];
      try { got = ask.length ? await host.callWorker<boolean[]>('objects-paint', { n, x, y, engine: ask }) : []; } catch { got = []; }
      const rendered = new Map(ask.map((e, k) => [e, !!got[k]]));
      return { ranked: rank(sc, cands, x, y, rendered, t), inner: new Map([...innerCands].map(([id, c]) => [id, rank(sc, c, x, y, rendered, t)])) };
    }

    // ── drawing ──────────────────────────────────────────────────────────────────────────────────────────────
    function polygon(cls: string, view: ViewBox, quads: Pt[][]): SVGSVGElement {
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', cls);
      svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      for (const q of quads) {
        const p = document.createElementNS(NS, 'polygon');
        p.setAttribute('points', q.map(([x, y]) => { const [vx, vy] = toView(view, x, y); return `${vx},${view.h - vy}`; }).join(' '));
        svg.append(p);
      }
      return svg;
    }
    const drawn = new Set<number>();
    function draw() {
      for (const n of drawn) host.pageLayer(n)?.replaceChildren();
      drawn.clear();
      const put = (n: number, el: Element) => { const l = host.pageLayer(n); if (l) { l.append(el); drawn.add(n); } };
      if (drag?.preview && drag.started) put(drag.n, drag.preview);
      if (level.id !== null) {
        const g = scene(level.n)?.byId.get(level.id);
        if (g) put(level.n, polygon('obj-group', pageView(level.n), [g.quad]));
      }
      if (cur && (cur.own || !cur.id.startsWith('box:'))) {
        const moving = drag?.started ? drag.T : null;
        for (const id of [...extra, cur.id]) {
          const s = item(cur.n, id);
          if (s) put(cur.n, polygon(s.group === 'auto' ? 'obj-sel obj-auto' : 'obj-sel', pageView(cur.n), [moving ? mapQuad(s.quad, moving) : s.quad]));
        }
        if (!drag?.started) drawHandles(put);
      }
      syncButtons();
      if (hover) {
        const sc = scene(hover.n), s = sc?.byId.get(hover.id) ?? sc?.byId.get(sc.claimed.get(hover.id) ?? '') ?? item(hover.n, hover.id);
        const o = s ? null : data.get(hover.n)?.model.objects.find((x) => x.id === hover!.id);
        const q: Pt[] | null = s ? s.quad : o ? rectQuad(o.bounds) : null;
        if (q) put(hover.n, polygon('obj-outline', pageView(hover.n), [q]));
      }
      const sel = cur && !cur.id.startsWith('box:') ? { n: cur.n, ids: [...extra, cur.id] } : null;
      host.emit('objects:selection', sel);
    }

    // ── the list for the Objects card ────────────────────────────────────────────────────────────────────────
    const r1 = (v: number) => Math.round(v * 10) / 10;
    function rowOf(s: Selectable, depth: number, paints: boolean): ObjectRow {
      const b = s.bounds;
      return { id: s.id, kind: s.kind, label: labelOf(s), depth, z: s.z, w: r1(b.x1 - b.x0), h: r1(b.y1 - b.y0), clipped: s.clipped, paints,
        group: s.members.length > 0, ...(s.object?.uses && s.object.uses > 1 ? { uses: s.object.uses } : {}), ...(s.group === 'auto' ? { auto: true } : {}) };
    }
    function hereRows(r: Ranking): ObjectRow[] {
      const rows: ObjectRow[] = [];
      for (const s of r.ranked.order) {
        rows.push(rowOf(s, 0, r.ranked.paints.has(s.id)));
        const inner = r.inner.get(s.id);
        if (inner) for (const m of inner.order) rows.push(rowOf(m, 1, inner.paints.has(m.id)));
      }
      return rows;
    }
    function publish(l: ObjectList | null, r: Ranking | null = null) { list = l; listRanking = r; host.emit('objects:list', l); }
    const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
    function publishHere(n: number, r: Ranking) {
      const k = r.ranked.order.length;
      publish({ n, mode: 'here', title: k ? `${plural(k, 'object')} under the pointer, topmost first (bold: painting there).` : 'No object under the pointer.', rows: hereRows(r), selected: cur?.n === n ? cur.id : null }, r);
    }
    /** The selection's context: its groups, itself, its members; or the ranking of the press that selected it. */
    function publishSelection(r?: Ranking | null) {
      if (!cur) { publish(null); return; }
      const sc = scene(cur.n), s = sc?.byId.get(cur.id);
      if (!sc || !s) { publish(null); return; }
      if (extra.length) {
        const ids = [...extra, cur.id];
        const rows = ids.map((id) => sc.byId.get(id)).filter((x): x is Selectable => !!x).map((x) => rowOf(x, 0, false));
        publish({ n: cur.n, mode: 'selection', title: `${plural(ids.length, 'object')} selected (Group or Ctrl+G makes them one group).`, rows, selected: s.id, picked: ids });
        return;
      }
      if (r && r.ranked.order.some((x) => x.id === s.id) || r?.inner && [...r.inner.values()].some((i) => i.order.some((x) => x.id === s.id))) {
        publish({ n: cur.n, mode: 'selection', title: `Selected: ${labelOf(s)} ${s.id}. Under the pressed point, topmost first:`, rows: hereRows(r!), selected: s.id }, r);
        return;
      }
      const ups = groupsOf(sc, s.id);
      const rows = [...ups.map((g, k) => rowOf(g, k, false)), rowOf(s, ups.length, false),
        ...s.members.map((id) => sc.byId.get(id)).filter((m): m is Selectable => !!m).reverse().map((m) => rowOf(m, ups.length + 1, false))];
      publish({ n: cur.n, mode: 'selection', title: `Selected: ${labelOf(s)} ${s.id}${s.members.length ? ` (${plural(s.members.length, 'member')}; Enter steps in${s.group ? ', Ungroup undoes it' : ''})` : ''}${ups.length ? ' (in a group; Escape steps out)' : ''}.`, rows, selected: s.id });
    }

    // ── selecting ───────────────────────────────────────────────────────────────────────────────────────────
    function clear() {
      cur = null;
      extra = [];
      hideCrop();
      host.deselect();
      draw();
      publish(null);
    }
    /** Selects one selectable of page n; a text box through the editor (it keeps editing it). */
    function choose(n: number, id: string, why: string | null = null, r?: Ranking | null, keep = false): Selectable | null {
      const sc = scene(n);
      const s = sc?.byId.get(id) ?? sc?.byId.get(sc.claimed.get(id) ?? '') ?? item(n, id);
      if (!s) return null;
      if (!keep) extra = [];
      if (cropOffer && !(cropOffer.n === n && cropOffer.ids.includes(s.id))) hideCrop();
      level = { n, id: s.parent };
      if (s.box) {
        cur = { n, id: s.id, own: false };
        const sel = host.selected();
        if (!(sel && sel.page === n && sel.id === s.box) && !host.select(n, s.box)) cur = { n, id: s.id, own: true };   // refused: outlined here
      } else {
        host.deselect();
        cur = { n, id: s.id, own: true };
      }
      draw();
      publishSelection(r);
      const b = s.bounds;
      const label = labelOf(s);
      if (why !== '') host.msg(`${label[0].toUpperCase()}${label.slice(1)} ${s.id}, ${r1(b.x1 - b.x0)} × ${r1(b.y1 - b.y0)} pt${s.clipped ? ', clipped' : ''}${why ? ` · ${why}` : ''}.`);
      return s;
    }

    // ── multi-selection, groups and paint order ─────────────────────────────────────────────────────────────
    /** Shift-click: the object under the point joins the selection (or leaves it, when it is in it already). */
    async function addAt(n: number, ranking: Promise<Ranking | null>) {
      const mine = ++presses;
      const r = await ranking;
      if (!r || mine !== presses || !cur || cur.n !== n) return;
      const hit = r.ranked.hit;
      if (!hit) { host.msg('Nothing is painted here to add to the selection.'); return; }
      togglePick(n, hit.id);
    }
    function togglePick(n: number, id: string): void {
      const sc = scene(n), s = sc?.byId.get(id);
      if (!sc || !s || !cur || cur.n !== n) return;
      if (s.box) { host.msg('A text box cannot be grouped with page objects; Shift-click adds objects to the selection.'); return; }
      if (isAdded(id) !== isAdded(cur.id) && !cur.id.startsWith('box:')) { host.msg('An added image is selected with other added images only: it is drawn on top of the page, apart from the file\'s objects.'); return; }
      const ids = [...extra, cur.id];
      if (ids.includes(id)) {
        const left = ids.filter((x) => x !== id);
        if (!left.length) { clear(); return; }
        extra = left.slice(0, -1);
        choose(n, left[left.length - 1], `${plural(left.length, 'object')} selected`, null, true);
        return;
      }
      const at = sc.byId.get(cur.id);
      if (at?.box) { choose(n, id); return; }
      if (at && at.parent !== s.parent) { host.msg('Shift-click adds objects of the same level (Escape steps out of a group first).'); return; }
      extra = ids;
      choose(n, id, `${plural(ids.length + 1, 'object')} selected; Group (Ctrl+G) makes them one`, null, true);
    }
    /** Records one object op on page n as an undo step. */
    function record(n: number, label: string, op: ObjectOp): boolean {
      const ed = host.editor();
      if (!ed) return false;
      const why = host.refused();
      if (why) { host.msg(why); return false; }
      ed.pageEdit(n, label, (pg) => { pg.objectOps = [...(pg.objectOps ?? []), op]; }, ['objectOps']);
      return true;
    }
    function groupSelection(): void {
      if (!cur) { host.msg('Select objects first: click one, Shift-click the others.'); return; }
      const n = cur.n, sc = scene(n);
      if (!sc) return;
      const ids = [...extra, cur.id];
      if (ids.some(isAdded)) { host.msg('Cannot group: an added image is drawn on top of the page, apart from the file\'s objects.'); return; }
      const why = groupRefusal(sc, ids);
      if (why) { host.msg(`Cannot group: ${why}.`); return; }
      const members = memberObjects(sc, ids);
      const taken = [...sc.items.filter((s) => s.group).map((s) => s.id), ...(host.doc()?.pages[n]?.objectOps ?? []).flatMap((o) => (o.op === 'group' ? [o.id] : []))];
      const id = newGroupId(taken);
      if (!record(n, 'group', { op: 'group', id, members })) return;
      choose(n, id, `${plural(members.length, 'object')} grouped; Enter steps in, Ungroup undoes it`);
    }
    function ungroupSelection(): void {
      if (!cur) { host.msg('Select a group first.'); return; }
      const n = cur.n, s = scene(n)?.byId.get(cur.id);
      if (!s?.group) { host.msg(s?.members.length ? 'A form XObject is one object of the file; it cannot be ungrouped here.' : 'Select a group first.'); return; }
      const members = [...s.members];
      if (!record(n, 'ungroup', { op: 'ungroup', id: s.id })) return;
      const live = members.filter((m) => scene(n)?.byId.has(m));
      if (!live.length) { clear(); return; }
      extra = live.slice(0, -1);
      choose(n, live[live.length - 1], `ungrouped: ${plural(live.length, 'object')} selected`, null, true);
    }
    async function reorder(to: 'forward' | 'backward'): Promise<void> {
      if (!cur || cur.id.startsWith('box:')) { host.msg('Select an object or a group first (a text box keeps its place in the paint order here).'); return; }
      if (extra.length) { host.msg('Group the selection first, or select one object: the paint order changes for one object or group at a time.'); return; }
      if (isAdded(cur.id)) { host.msg('An added image is painted on top of the page, in the order the images were added.'); return; }
      const n = cur.n, id = cur.id;
      const s = scene(n)?.byId.get(id);
      const op: ObjectOp = { op: 'order', id, to };
      const verb = to === 'forward' ? 'bring' : 'send';
      let ans: OrderAnswer;
      try { ans = await host.callWorker<OrderAnswer>('objects-order', { n, ops: [...(host.doc()?.pages[n]?.objectOps ?? []), op] }); } catch (err) { host.msg(`Cannot ${verb} it ${to}: ${(err as Error).message}`); return; }
      const res = ans.results[ans.results.length - 1];
      if (!res || res.id !== id || res.to !== to || !res.ok) { host.msg(`Cannot ${verb} ${s ? labelOf(s) : 'object'} ${id} ${to}: ${res?.reason ?? 'the stream cannot take it'}.`); return; }
      orderZ.set(n, new Map(ans.z));
      if (!record(n, to === 'forward' ? 'bring forward' : 'send backward', op)) return;
      choose(n, id, `${to === 'forward' ? 'brought forward' : 'sent backward'} past ${res.past?.join(', ') ?? 'its neighbour'}`);
    }
    /** The new paint order of page n after its order ops changed (an undo, a redo, a new op). */
    async function refreshOrder(n: number): Promise<void> {
      const ops = host.doc()?.pages[n]?.objectOps ?? [];
      if (!ops.some((o) => o.op === 'order')) { if (orderZ.delete(n)) { scenes.delete(n); draw(); } return; }
      try {
        const ans = await host.callWorker<OrderAnswer>('objects-order', { n, ops });
        orderZ.set(n, new Map(ans.z));
        scenes.delete(n);
        draw();
      } catch { /* the scene keeps the order it had */ }
    }
    function syncButtons(): void {
      const s = cur ? item(cur.n, cur.id) : null;
      const obj = !!s && !s.box;
      const added = !!cur && [...extra, cur.id].some(isAdded);
      groupBtn.disabled = !(active && obj && extra.length > 0 && !added);
      ungroupBtn.disabled = !(active && obj && !!s!.group && !extra.length);
      forwardBtn.disabled = backwardBtn.disabled = !(active && obj && !extra.length && !added);
      turnLeftBtn.disabled = turnRightBtn.disabled = deleteBtn.disabled = !(active && obj);
    }
    let presses = 0;
    /** A press the tool takes moves the keyboard focus off a field outside the pages (no mousedown follows it). */
    const takeFocus = () => { const a = document.activeElement; if (a instanceof HTMLElement && a !== document.body && !a.closest('#viewer')) a.blur(); };
    const position = (order: Selectable[], id: string) => `${order.findIndex((s) => s.id === id) + 1} of ${order.length}`;

    /** A press that selects: the topmost painted object at the point (or nothing). */
    async function pressAt(n: number, ranking: Promise<Ranking | null>) {
      const mine = ++presses;
      const r = await ranking;
      if (!r || mine !== presses) return;   // a later press won
      const { order, hit } = r.ranked;
      if (!hit) {
        clear();
        if (order.length) publishHere(n, r);
        host.msg(order.length ? `Nothing is painted here; ${plural(order.length, 'object')} around the point (Alt-click picks one).` : 'No object here.');
        return;
      }
      choose(n, hit.id, `${position(order, hit.id)} here${order.length > 1 ? '; Alt-click or click again for the one below' : ''}`, r);
    }
    /** Alt-click or a second press: the next object down (Shift: up) under the point. */
    async function cycleAt(n: number, dir: 1 | -1, ranking: Promise<Ranking | null>) {
      const mine = ++presses;
      const r = await ranking;
      if (mine !== presses) return;
      if (!r || !r.ranked.order.length) { if (r) clear(); return; }
      const order = r.ranked.order;
      const now = cur && cur.n === n && order.some((s) => s.id === cur!.id) ? cur.id : order[0].id;
      const next = order.length === 1 ? order[0] : cycle(order, now, dir)!;
      choose(n, next.id, `${position(order, next.id)} here`, r);
    }

    function press(e: PointerEvent, n: number, at: { x: number; y: number }, on: { frame: string | null; editbox: boolean; handle: boolean }): boolean {
      const took = grab(e, n, at, on) || take(e, n, at, on);
      if (took) takeFocus();
      return took;
    }
    /** A press that starts a drag: on a handle, or on the selection's body (a move once the pointer goes DRAG_PX; a
     *  press released without moving is a click, taken as take() takes it). An added image is selected at once. */
    function grab(e: PointerEvent, n: number, at: { x: number; y: number }, on: { frame: string | null; editbox: boolean; handle: boolean }): boolean {
      if (!active || e.altKey || e.detail > 1 || on.editbox) return false;
      const oh = (e.target as HTMLElement | null)?.dataset?.oh;
      const t = targets();
      if (oh && t && t.n === n) { startDrag(e, n, at, oh === 'rot' ? 'rotate' : 'resize', oh); return true; }
      if (e.shiftKey) return false;
      const a = on.frame ? null : addedAt(n, at.x, at.y);
      if (a && !(t && t.n === n && t.ids.includes(a))) {
        if (host.refused()) return false;
        choose(n, a, 'drag to move it, the handles resize and turn it');
      }
      const t2 = targets();
      if (t2 && t2.n === n && !on.frame && t2.ids.some((id) => { const s = item(n, id); return !!s && inQuad(s.quad, at.x, at.y, tol(n)); })) {
        startDrag(e, n, at, 'move', null, a ? null : () => { take(e, n, at, on); takeFocus(); });
        return true;
      }
      return !!a;
    }
    function take(e: PointerEvent, n: number, at: { x: number; y: number }, on: { frame: string | null; editbox: boolean; handle: boolean }): boolean {
      if (!active) return false;
      if (on.handle && !e.altKey) return false;                      // the selected text box's handles
      if (e.shiftKey && !e.altKey && on.frame) return false;         // the editor's second box
      if (e.shiftKey && !e.altKey && cur && cur.n === n && !cur.id.startsWith('box:') && data.get(n) && e.detail <= 1) {
        const ranking = rankAt(n, at.x, at.y, levelOn(n));          // Shift-click: add to the selection
        last = { n, x: at.x, y: at.y, cx: e.clientX, cy: e.clientY, level: levelOn(n), ranking };
        void addAt(n, ranking);
        return true;
      }
      const same = !!last && last.n === n && Math.hypot(e.clientX - last.cx, e.clientY - last.cy) <= REPEAT_PX;
      if (e.detail > 1) return !(on.editbox || on.frame);            // a double-click: the text box edits; otherwise nothing more
      const d = data.get(n);
      if (!d) {
        if (on.frame) { void load(n); return false; }                 // the editor handles it until the page's objects are read
        const lv0 = levelOn(n);
        const ranking = load(n).then(() => rankAt(n, at.x, at.y, lv0));
        last = { n, x: at.x, y: at.y, cx: e.clientX, cy: e.clientY, level: lv0, ranking };
        void (e.altKey ? cycleAt(n, e.shiftKey ? -1 : 1, ranking) : pressAt(n, ranking));
        return true;
      }
      // a second press on the same spot goes down, except on a selected text box: the editor keeps those (a
      // double-click edits it); Alt-click goes below it
      if (e.altKey || (same && cur && cur.n === n && !(on.editbox && cur.id.startsWith('box:')))) {
        const ranking = same && last ? last.ranking : rankAt(n, at.x, at.y, levelOn(n));
        if (!same) last = { n, x: at.x, y: at.y, cx: e.clientX, cy: e.clientY, level: levelOn(n), ranking };
        void cycleAt(n, e.shiftKey ? -1 : 1, ranking);
        return true;
      }
      const sc = scene(n)!;
      let lv = levelOn(n);
      let cands = candidatesAt(sc, at.x, at.y, lv, tol(n));
      if (lv && !cands.length) { lv = null; cands = candidatesAt(sc, at.x, at.y, null, tol(n)); }
      const ranking = rankAt(n, at.x, at.y, lv);
      last = { n, x: at.x, y: at.y, cx: e.clientX, cy: e.clientY, level: lv, ranking };
      // a text box on top of everything here: the editor selects it (and drags it) as before, where it can
      const top = cands[0];
      const box = top?.box ? host.doc()?.pages[n]?.boxes.find((b) => b.id === top.box) : undefined;
      if (top?.box && box && !box.locked && on.frame === top.box) {
        cur = { n, id: top.id, own: false };
        level = { n, id: top.parent };
        presses++;
        void ranking.then((r) => { if (cur?.id === top.id) { draw(); publishSelection(r); if (r) host.msg(`Text box ${top.box} · ${position(r.ranked.order, top.id)} here${r.ranked.order.length > 1 ? '; Alt-click for the one below' : ''}; double-click to edit.`); } });
        return false;
      }
      void pressAt(n, ranking);
      return true;
    }


    // ── handles ─────────────────────────────────────────────────────────────────────────────────────────────
    type Target = { n: number; ids: string[]; quad: Pt[]; items: Selectable[] };
    /** What the handles act on: the selection's objects, groups and added images (not a text box). */
    function targets(): Target | null {
      if (!active || !cur || cur.id.startsWith('box:')) return null;
      const n = cur.n;
      const items = [...extra, cur.id].map((id) => item(n, id)).filter((x): x is Selectable => !!x && !x.box);
      if (!items.length) return null;
      const quad = items.length === 1 ? items[0].quad : rectQuad(items.reduce<Rect>((r, x) => ({ x0: Math.min(r.x0, x.bounds.x0), y0: Math.min(r.y0, x.bounds.y0), x1: Math.max(r.x1, x.bounds.x1), y1: Math.max(r.y1, x.bounds.y1) }), { ...items[0].bounds }));
      return { n, ids: items.map((x) => x.id), quad, items };
    }
    /** Screen pixels as points on page n (before its objects are read too). */
    function pxToPt(n: number, px: number): number {
      const w = host.pageLayer(n)?.getBoundingClientRect().width ?? 0;
      return w > 0 ? (px * pageView(n).w) / w : px;
    }
    function placeAt(el: HTMLElement, v: ViewBox, p: Pt) {
      const [vx, vy] = toView(v, p[0], p[1]);
      el.style.left = `${(vx / v.w) * 100}%`;
      el.style.top = `${((v.h - vy) / v.h) * 100}%`;
    }
    /** The resize cursor for a handle at p (centre c), by its direction on the screen. */
    function cursorFor(v: ViewBox, c: Pt, p: Pt): string {
      const [cx, cy] = toView(v, c[0], c[1]), [px, py] = toView(v, p[0], p[1]);
      const a = ((((Math.atan2(cy - py, px - cx) * 180) / Math.PI) % 180) + 180) % 180;
      return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
    }
    function drawHandles(put: (n: number, el: Element) => void) {
      const t = targets();
      if (!t || host.refused()) return;
      const v = pageView(t.n), c = quadCentre(t.quad);
      const r = rotationHandle(t.quad, (x, y) => toView(v, x, y), pxToPt(t.n, STEM_PX));
      const stem = document.createElementNS(NS, 'svg');
      stem.setAttribute('class', 'obj-stem');
      stem.setAttribute('viewBox', `0 0 ${v.w} ${v.h}`);
      stem.setAttribute('preserveAspectRatio', 'none');
      const line = document.createElementNS(NS, 'line');
      const [ax, ay] = toView(v, r.edge[0], r.edge[1]), [bx, by] = toView(v, r.at[0], r.at[1]);
      line.setAttribute('x1', String(ax)); line.setAttribute('y1', String(v.h - ay)); line.setAttribute('x2', String(bx)); line.setAttribute('y2', String(v.h - by));
      stem.append(line);
      put(t.n, stem);
      for (const hd of HANDLES) {
        const p = squarePoint(t.quad, hd.s, hd.t);
        const el = h('div', { class: 'obj-h', 'data-oh': hd.id, title: 'Drag to resize (Shift keeps the proportions, Alt resizes about the centre)' }) as HTMLDivElement;
        placeAt(el, v, p);
        el.style.cursor = cursorFor(v, c, p);
        put(t.n, el);
      }
      const rot = h('div', { class: 'obj-h rot', 'data-oh': 'rot', title: t.ids.some(isAdded) ? 'Drag to turn it by quarter turns' : 'Drag to turn it (Shift: steps of 15°)' }) as HTMLDivElement;
      placeAt(rot, v, r.at);
      put(t.n, rot);
    }

    // ── drags: move, resize, turn ───────────────────────────────────────────────────────────────────────────
    type Drag = {
      n: number; mode: 'move' | 'resize' | 'rotate'; handle: string | null; ids: string[]; quad: Pt[]; items: Selectable[];
      start: Pt; cx: number; cy: number; started: boolean; T: M6;
      preview: HTMLCanvasElement | null; src: { canvas: OffscreenCanvas; view: ReturnType<typeof viewOf>; colours: string[] } | null;
      /** A press on the body released without moving: the click it is. */
      click: (() => void) | null;
    };
    let drag: Drag | null = null;
    const stats = { previewMs: [] as number[], underlayMs: [] as number[], commitMs: [] as number[] };
    function startDrag(e: PointerEvent, n: number, at: { x: number; y: number }, mode: Drag['mode'], handle: string | null, click: (() => void) | null = null) {
      const t = targets();
      if (!t) return;
      if (drag) endDrag();
      drag = { n, mode, handle, ids: t.ids, quad: t.quad, items: t.items, start: [at.x, at.y], cx: e.clientX, cy: e.clientY, started: false, T: [1, 0, 0, 1, 0, 0], preview: null, src: null, click };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
      window.addEventListener('pointercancel', cancelDrag);
    }
    function endDrag(): Drag | null {
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', cancelDrag);
      const d = drag;
      drag = null;
      return d;
    }
    function cancelDrag() { if (endDrag()?.started) draw(); }
    function dragMatrix(d: Drag, p: Pt, ev: PointerEvent): M6 {
      if (d.mode === 'move') return translate(p[0] - d.start[0], p[1] - d.start[1]);
      if (d.mode === 'resize') return resizeMatrix(d.quad, HANDLES.find((x) => x.id === d.handle)!, p, { keepAspect: ev.shiftKey, fromCentre: ev.altKey });
      const c = quadCentre(d.quad);
      return turnAbout(c, dragAngle(c, d.start, p, d.ids.some(isAdded) ? 90 : ev.shiftKey ? SNAP_DEG : null));
    }
    function onDragMove(ev: PointerEvent) {
      const d = drag;
      if (!d) return;
      if (!d.started) {
        if (d.mode === 'move' && Math.hypot(ev.clientX - d.cx, ev.clientY - d.cy) < DRAG_PX) return;
        const why = host.refused();
        if (why) { host.msg(why); endDrag(); return; }
        d.started = true;
        beginPreview(d);
      }
      const p = host.fromClient(d.n, ev.clientX, ev.clientY);
      if (!p) return;
      d.T = dragMatrix(d, [p.x, p.y], ev);
      paintPreview(d);
      draw();
    }
    function onDragUp() {
      const d = endDrag();
      if (!d) return;
      if (!d.started) { d.click?.(); return; }
      if (isIdentity(d.T)) { draw(); return; }
      transformSelection(d.T, d.mode === 'move' ? 'move' : d.mode === 'resize' ? 'resize' : 'turn', d);
    }

    // ── what the page shows: the selection drawn at its new place (a drag), then the edits until the commit ───
    /** The page as shown (its render and the overlay over it) as a drawing source, and its view. */
    function beginPreview(d: Drag) {
      const pageEl = host.pageLayer(d.n)?.parentElement;
      const base = pageEl?.querySelector<HTMLCanvasElement>('canvas.base'), over = pageEl?.querySelector<HTMLCanvasElement>('canvas.over');
      const page = host.doc()?.pages[d.n];
      if (!base || !base.width || !page) return;
      const src = new OffscreenCanvas(base.width, base.height);
      const g = src.getContext('2d')!;
      g.drawImage(base, 0, 0);
      if (over && over.width === base.width && over.height === base.height) g.drawImage(over, 0, 0);
      const view = viewOf(page, base.width / pageView(d.n).w);
      const img = g.getImageData(0, 0, src.width, src.height);
      const c = document.createElement('canvas');
      c.className = 'obj-preview';
      c.width = base.width;
      c.height = base.height;
      d.preview = c;
      d.src = { canvas: src, view, colours: d.items.map((x) => sampleBackground(img, view, x.bounds)) };
    }
    function paintPreview(d: Drag) {
      if (!d.preview || !d.src) return;
      const t0 = performance.now();
      const c = d.preview.getContext('2d')!;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, d.preview.width, d.preview.height);
      paintMoved(c, canvasMatrix(d.src.view), d.src.canvas, d.items.map((x, k) => ({ quad: x.quad, T: d.T, colour: d.src!.colours[k] })));
      stats.previewMs.push(performance.now() - t0);
    }
    /** Masks each quad with its background colour, then draws the source's pixels inside each quad through its matrix
     *  (null: deleted, only masked). D: user space → canvas pixels. */
    function paintMoved(c: CanvasRenderingContext2D, D: M6, src: CanvasImageSource, list: { quad: Pt[]; T: M6 | null; colour: string }[]) {
      const Di = invert(D);
      if (!Di) return;
      const path = (q: Pt[]) => {
        c.beginPath();
        q.forEach(([x, y], k) => { const X = D[0] * x + D[2] * y + D[4], Y = D[1] * x + D[3] * y + D[5]; if (k) c.lineTo(X, Y); else c.moveTo(X, Y); });
        c.closePath();
      };
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.lineWidth = 2;
      for (const it of list) { c.fillStyle = c.strokeStyle = it.colour; path(it.quad); c.fill(); c.stroke(); }
      c.restore();
      for (const it of list) {
        if (!it.T) continue;
        const M = mul(mul(Di, it.T), D);
        c.save();
        c.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
        path(it.quad);
        c.clip();
        c.drawImage(src, 0, 0);
        c.restore();
      }
    }
    /** The objects' own outlines in the file (before the edits): an image's unit square, a form's turned box, else the
     *  bounds. */
    function sourceQuad(o: PageObjects['objects'][number], g: HitGeometry): Pt[] {
      if (o.kind === 'image' || o.kind === 'inline-image') return [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => [o.ctm[0] * x + o.ctm[2] * y + o.ctm[4], o.ctm[1] * x + o.ctm[3] * y + o.ctm[5]] as Pt);
      if (o.kind === 'form' && o.engine !== undefined && g.quads[o.engine]?.length === 4) return g.quads[o.engine].map((p) => [p[0], p[1]] as Pt);
      return rectQuad(o.bounds);
    }
    /** Until the page's commit render shows the edits: moved objects' pixels at their new places, deleted ones masked,
     *  from the original render (the overlay's underlay). */
    function underlay(n: number): Underlay | null {
      const page = host.doc()?.pages[n], d = data.get(n);
      if (!page || !d || !(page.objectOps ?? []).some((o) => o.op === 'transform' || o.op === 'delete')) return null;
      const { applied } = appliedOf(page, d.model);
      const byId = new Map(d.model.objects.map((o) => [o.id, o]));
      const changed = (id: string) => applied.deleted.has(id) || applied.own.has(id);
      const list: { quad: Pt[]; T: M6 | null; bounds: Rect }[] = [];
      for (const o of d.model.objects) {
        if (!changed(o.id) || isDeleted(applied, byId, o.parent ?? '')) continue;
        let inMoved = false;
        for (let p = o.parent ? byId.get(o.parent) : undefined; p && !inMoved; p = p.parent ? byId.get(p.parent) : undefined) inMoved = applied.own.has(p.id);
        if (inMoved) continue;   // drawn with the form it is in
        list.push({ quad: sourceQuad(o, d.geometry), T: applied.deleted.has(o.id) ? null : effectiveMatrix(applied, byId, o.id), bounds: o.bounds });
      }
      if (!list.length) return null;
      return {
        rects: () => list.flatMap((it) => (it.T ? [it.bounds, quadRect(mapQuad(it.quad, it.T))] : [it.bounds])),
        paint: (c, _p, at) => {
          const t0 = performance.now();
          paintMoved(c, canvasMatrix(at.view), at.source(), list.map((it) => ({ quad: it.quad, T: it.T, colour: at.colour(`objects:${it.bounds.x0},${it.bounds.y0},${it.bounds.x1},${it.bounds.y1}`, it.bounds) })));
          stats.underlayMs.push(performance.now() - t0);
        },
      };
    }

    // ── edits: transforms, deletes, the shared-crop choice ──────────────────────────────────────────────────
    function edit(n: number, label: string, fn: (ops: ObjectOp[]) => ObjectOp[]): boolean {
      const ed = host.editor();
      if (!ed) return false;
      const why = host.refused();
      if (why) { host.msg(why); return false; }
      ed.pageEdit(n, label, (pg) => { pg.objectOps = fn(pg.objectOps ?? []); }, ['objectOps']);
      return true;
    }
    /** Clips that crop the objects a transform would move (they need the person's choice), or why it is refused. */
    function cropCheck(n: number, ids: string[], T: M6): { crops: Clip[]; refuse: string | null } {
      const d = data.get(n), page = host.doc()?.pages[n];
      if (!d || !page) return { crops: [], refuse: null };   // not read yet: the commit says what it refused
      const groups = proposedGroups(d.model);
      const before = applyOps(d.model, page.objectOps ?? [], { groups });
      const after = applyOps(d.model, [...(page.objectOps ?? []), { op: 'transform', ids, m: T }], { groups });
      const byId = new Map(d.model.objects.map((o) => [o.id, o]));
      const clipById = new Map(d.model.clips.map((c) => [c.id, c]));
      const crops = new Map<string, Clip>();
      for (const [id, own] of after.own) {
        const was = before.own.get(id);
        if (was && was.every((v, k) => Math.abs(v - own[k]) < 1e-9)) continue;
        const o = byId.get(id);
        if (!o || o.kind === 'text') continue;
        const f = clipFates(o, own, clipById);
        if (f.refuse) return { crops: [], refuse: f.refuse };
        if (after.moveClip.has(id) || after.dropClip.has(id)) continue;   // chosen before
        for (const c of f.clips) if (c.fate === 'crop') crops.set(c.clip.id, c.clip);
      }
      return { crops: [...crops.values()], refuse: null };
    }
    const PAST: Record<string, string> = { move: 'moved', resize: 'resized', turn: 'turned', nudge: 'nudged' };
    function describe(n: number, ids: string[]): string {
      if (ids.length !== 1) return plural(ids.length, 'object');
      const x = item(n, ids[0]);
      return x ? `${labelOf(x)} ${x.id}` : ids[0];
    }
    /** Applies a page-space matrix to the selection (or the drag's objects) as one undo step. */
    function transformSelection(T: M6, label: string, d: Drag | null = null): void {
      const t = d ? { n: d.n, ids: d.ids } : targets();
      if (!t) { draw(); return; }
      const page = host.doc()?.pages[t.n];
      if (!page) return;
      const why = host.refused();
      if (why) { host.msg(why); draw(); return; }
      const frames = new Map<string, { frame: Rect; rotate: AddImage['rotate'] }>();
      for (const id of t.ids.filter(isAdded)) {
        const op = addedOn(page).find((o) => ADD + o.key === id);
        if (!op) continue;
        const a = addedAfter(op.frame, op.rotate, T);
        if (!a) { host.msg('An added image turns by quarter turns only (Turn left, Turn right).'); draw(); return; }
        frames.set(op.key, a);
      }
      const objIds = t.ids.filter((id) => !isAdded(id));
      let op: ObjectOp | null = null;
      let crops: Clip[] = [];
      if (objIds.length) {
        const chk = cropCheck(t.n, objIds, T);
        if (chk.refuse) { host.msg(`Cannot ${label} ${describe(t.n, t.ids)}: ${chk.refuse}.`); draw(); return; }
        crops = chk.crops;
        op = { op: 'transform', ids: objIds, m: T, ...(crops.length ? { sharedClip: 'move' as const } : {}) };
      }
      const ok = edit(t.n, label, (ops) => [...ops.map((o) => (o.op === 'add-image' && frames.has(o.key) ? { ...o, ...frames.get(o.key)! } : o)), ...(op ? [op] : [])]);
      if (!ok) { draw(); return; }
      if (op && crops.length) offerCrop(t.n, t.ids, op, label, crops);
      else hideCrop();
      draw();
      const what = describe(t.n, t.ids);
      host.msg(`${PAST[label][0].toUpperCase()}${PAST[label].slice(1)} ${what}${crops.length ? ' with its crop: a clip it shares with other objects crops it, and a copy moves with it ("Move without the crop" shows it whole)' : ''}. Ctrl+Z undoes it.`);
    }
    function quarterTurn(dir: 1 | -1) {
      const t = targets();
      if (!t) { host.msg('Select an object first.'); return; }
      transformSelection(turnAbout(quadCentre(t.quad), 90 * dir), 'turn');
    }
    function deleteSelection() {
      const t = targets();
      if (!t) { host.msg('Select an object first.'); return; }
      const keys = new Set(t.ids.filter(isAdded).map((id) => id.slice(ADD.length)));
      const objIds = t.ids.filter((id) => !isAdded(id));
      const what = describe(t.n, t.ids);
      if (!edit(t.n, 'delete', (ops) => [...ops.filter((o) => !(o.op === 'add-image' && keys.has(o.key))), ...(objIds.length ? [{ op: 'delete' as const, ids: objIds }] : [])])) return;
      cur = null; extra = [];
      hideCrop();
      draw();
      publish(null);
      const note = objIds.length && !deleteNoted ? ` ${DELETE_NOTE}` : '';
      if (objIds.length) deleteNoted = true;
      host.msg(`Deleted ${what}. Ctrl+Z brings it back.${note}`);
    }
    let cropOffer: { n: number; ids: string[]; op: ObjectOp; label: string; choice: 'move' | 'drop'; clips: number } | null = null;
    let switching = false;
    function offerCrop(n: number, ids: string[], op: ObjectOp, label: string, crops: Clip[]) {
      cropOffer = { n, ids, op, label, choice: 'move', clips: crops.length };
      const others = Math.max(...crops.map((c) => c.users - 1));
      cropBar.title = `A clip it shares with ${others > 0 ? plural(others, 'other object') : 'others'} crops it`;
      cropBar.hidden = false;
      syncCrop();
    }
    function syncCrop() {
      cropWith.setAttribute('aria-pressed', String(cropOffer?.choice === 'move'));
      cropWithout.setAttribute('aria-pressed', String(cropOffer?.choice === 'drop'));
    }
    function hideCrop() { cropOffer = null; cropBar.hidden = true; }
    function switchCrop(choice: 'move' | 'drop') {
      const o = cropOffer;
      if (!o || o.choice === choice) return;
      const ops = host.doc()?.pages[o.n]?.objectOps ?? [];
      const last = ops[ops.length - 1];
      if (!last || JSON.stringify(last) !== JSON.stringify(o.op)) { host.msg('The page changed since that move; undo it and move it again to choose.'); hideCrop(); return; }
      const next = { ...(o.op as Extract<ObjectOp, { op: 'transform' }>), sharedClip: choice };
      switching = true;
      try {
        host.history()?.undo();
        if (!edit(o.n, o.label, (xs) => [...xs, next])) { hideCrop(); return; }
      } finally { switching = false; }
      o.op = next;
      o.choice = choice;
      syncCrop();
      host.msg(choice === 'move' ? 'Moved with its crop: it keeps the shape the shared clip gave it.' : 'Moved without the crop: it shows whole at its new place; the objects that share the clip keep it.');
    }
    cropWith.addEventListener('click', () => switchCrop('move'));
    cropWithout.addEventListener('click', () => switchCrop('drop'));
    turnLeftBtn.addEventListener('click', () => quarterTurn(1));
    turnRightBtn.addEventListener('click', () => quarterTurn(-1));
    deleteBtn.addEventListener('click', () => deleteSelection());
    /** What the last commits refused, per page (shown once each). */
    const shownSkips = new Map<number, string>();
    let lastSkipped: { n: number; skipped: { id: string; reason: string }[] } | null = null;
    host.on('objects:select', (x) => {
      const { n, id } = x as { n: number; id: string };
      if (!choose(n, id, '')) return;
      void load(n).then(() => { if (cur?.n === n && cur.id === id) { draw(); publishSelection(); } });
    });

    // ── keys ─────────────────────────────────────────────────────────────────────────────────────────────────
    function key(e: KeyboardEvent): boolean {
      if (!active || !host.doc()) return false;
      const t = e.target as HTMLElement;
      const onPage = t === document.body || !!t.closest?.('#viewer');
      if ((e.ctrlKey || e.metaKey) && !e.altKey && onPage && cur && !cur.id.startsWith('box:')) {
        if (e.key.toLowerCase() === 'g') { if (e.shiftKey) ungroupSelection(); else groupSelection(); return true; }
        if (e.key === ']' || e.code === 'BracketRight') { void reorder('forward'); return true; }
        if (e.key === '[' || e.code === 'BracketLeft') { void reorder('backward'); return true; }
      }
      if (e.ctrlKey || e.metaKey) return false;
      if (e.key === 'Tab' && onPage) {
        const n = cur?.n ?? host.current();
        const go = () => {
          const sc = scene(n);
          if (!sc) return;
          const from = cur && cur.n === n ? cur.id : null;
          const lv = from ? sc.byId.get(from)?.parent ?? null : levelOn(n);
          const next = tabStep(sc, from, e.shiftKey ? -1 : 1, lv);
          if (!next) { host.msg('No objects on this page.'); return; }
          const order = tabOrder(sc, next.parent);
          choose(n, next.id, `${position(order, next.id)} ${next.parent ? 'in the group' : 'on the page'} in paint order`);
        };
        if (data.get(n)) go(); else void load(n).then(go);
        return true;
      }
      if (!cur) return false;
      if (!cur.id.startsWith('box:') && !e.altKey) {
        if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return true; }
        const step = e.shiftKey ? 10 : 1;
        const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] } as Record<string, [number, number]>)[e.key];
        if (d) { const [dx, dy] = viewStep(pageView(cur.n), d[0], d[1]); transformSelection(translate(dx, dy), 'nudge'); return true; }
        if (e.key === 'r' || e.key === 'R') { quarterTurn(e.shiftKey ? 1 : -1); return true; }
      }
      const sc = scene(cur.n), s = sc?.byId.get(cur.id) ?? item(cur.n, cur.id);
      if (!s) return false;
      if (e.key === 'Enter' && s.members.length && !s.box && sc) {
        const first = sc.byId.get(s.members[s.members.length - 1])!;
        choose(cur.n, first.id, 'in the group; Tab steps among its members, Escape steps out');
        return true;
      }
      if (e.key === 'Escape') {
        if (drag) { cancelDrag(); return true; }
        if (extra.length) { choose(cur.n, cur.id, 'one object selected'); return true; }
        if (s.parent) choose(cur.n, s.parent, 'the group');
        else { level = { n: cur.n, id: null }; clear(); }
        return true;
      }
      return false;
    }

    // ── the pointer over the pages: the card lists what is under it while nothing is selected ────────────────
    let busy = false, nextAt: { n: number; x: number; y: number } | null = null;
    async function probe(at: { n: number; x: number; y: number }): Promise<Ranking | null> {
      if (busy) { nextAt = at; return null; }
      busy = true;
      try {
        const r = await rankAt(at.n, at.x, at.y, levelOn(at.n));
        if (r && !cur) publishHere(at.n, r);
        return r;
      } finally {
        busy = false;
        if (nextAt) { const a = nextAt; nextAt = null; void probe(a); }
      }
    }
    window.addEventListener('pointermove', (e) => {
      if (last && Math.hypot(e.clientX - last.cx, e.clientY - last.cy) > REPEAT_PX) last = null;
      if (!active || cur || !host.doc()) return;
      const pageEl = (e.target as HTMLElement).closest?.('.page') as HTMLElement | null;
      if (!pageEl) return;
      const n = Number(pageEl.dataset.n);
      const at = host.fromClient(n, e.clientX, e.clientY);
      if (at) void probe({ n, ...at });
    });

    // ── the card's requests ─────────────────────────────────────────────────────────────────────────────────
    host.on('objects:pick', (d) => {
      const { n, id } = d as { n: number; id: string };
      const r = list && list.n === n ? listRanking : null;
      void load(n).then(() => { choose(n, id, 'picked from the list', r); });
    });
    host.on('objects:hover', (d) => {
      const x = d as { n: number; id: string } | null;
      hover = x;
      if (x && !data.get(x.n)) void load(x.n).then(() => { if (hover === x) draw(); });
      else draw();
    });

    groupBtn.addEventListener('click', () => groupSelection());
    ungroupBtn.addEventListener('click', () => ungroupSelection());
    forwardBtn.addEventListener('click', () => { void reorder('forward'); });
    backwardBtn.addEventListener('click', () => { void reorder('backward'); });
    toggle.addEventListener('click', () => {
      active = !active;
      toggle.setAttribute('aria-pressed', String(active));
      if (!active) { cur = null; extra = []; hover = null; level = { n: -1, id: null }; draw(); publish(null); }
      host.msg(active ? 'Select objects: click an object; Alt-click for the one below; Tab steps through them.' : 'Object selection is off.');
    });

    return {
      pointerdown: press,
      keydown: key,
      underlay,
      opened() { seq++; endDrag(); hideCrop(); data.clear(); loading.clear(); scenes.clear(); orderZ.clear(); shownSkips.clear(); cur = null; extra = []; hover = null; last = null; level = { n: -1, id: null }; draw(); publish(null); },
      committed(n, r) {
        stats.commitMs.push(r.ms);
        if (!r.objectsSkipped.length) { shownSkips.delete(n); return; }
        lastSkipped = { n, skipped: r.objectsSkipped };
        const k = r.objectsSkipped.map((x) => `${x.id}:${x.reason}`).join('|');
        if (shownSkips.get(n) === k) return;
        shownSkips.set(n, k);
        const x = r.objectsSkipped[0];
        host.msg(`Page ${n + 1}: ${x.id} is not changed in the file: ${x.reason}.`);
      },
      changed(c) {
        scenes.delete(c.page);
        if (drag?.n === c.page) cancelDrag();
        if (cropOffer?.n === c.page && !switching) {
          const ops = host.doc()?.pages[c.page]?.objectOps ?? [];
          if (JSON.stringify(ops[ops.length - 1]) !== JSON.stringify(cropOffer.op)) hideCrop();
        }
        if (cur?.n === c.page) {
          extra = extra.filter((id) => !!item(c.page, id));
          if (!item(c.page, cur.id)) { cur = null; extra = []; }
        }
        draw();
        if (c.edit.kind === 'page' && c.how !== 'do') void refreshOrder(c.page);
      },
      updated() {
        // the editor's text box selection and this one stay one selection
        const s = host.selected();
        if (s) {
          const id = `box:${s.id}`;
          if (!cur || cur.n !== s.page || cur.id !== id) { cur = { n: s.page, id, own: false }; draw(); if (data.get(s.page)) publishSelection(); }
        } else if (cur && cur.id.startsWith('box:') && !cur.own) { cur = null; draw(); publish(null); }
      },
      debug: {
        get state() { return { active, selected: cur ? { ...cur } : null, picked: cur ? [...extra, cur.id] : [], level: { ...level }, list, dragging: !!drag?.started }; },
        /** The handles on screen: id and client centre. */
        handles: () => [...document.querySelectorAll<HTMLElement>('.tool-layer[data-tool="select"] .obj-h')].map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.oh!, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }),
        /** The selection's outline (page space), as the handles sit on it. */
        quad: () => targets()?.quad ?? null,
        get crop() { return cropOffer ? { n: cropOffer.n, ids: [...cropOffer.ids], choice: cropOffer.choice, shown: !cropBar.hidden } : null; },
        get lastSkipped() { return lastSkipped; },
        get deleteNoted() { return deleteNoted; },
        stats,
        turn: (dir: 1 | -1) => quarterTurn(dir),
        remove: () => deleteSelection(),
        cropChoice: (c: 'move' | 'drop') => switchCrop(c),
        load: (n: number) => load(n).then((d) => !!d),
        /** The page's selectables in paint order. */
        items: (n: number) => load(n).then(() => scene(n)?.items.map((s) => ({ id: s.id, kind: s.kind, z: s.z, parent: s.parent, members: s.members, box: s.box ?? null, bounds: s.bounds, clipped: s.clipped, group: s.group ?? null })) ?? null),
        tabOrder: (n: number, lv: string | null = null) => load(n).then(() => { const sc = scene(n); return sc ? tabOrder(sc, lv).map((s) => s.id) : null; }),
        /** What is under a point: the cycle order, the painting ones and the hit (the card shows it). */
        probe: (n: number, x: number, y: number) => probe({ n, x, y }).then((r) => r && { ids: r.ranked.order.map((s) => s.id), paints: [...r.ranked.paints], hit: r.ranked.hit?.id ?? null }),
        select: (n: number, id: string) => load(n).then(() => choose(n, id)?.id ?? null),
        clear: () => clear(),
        /** Adds an object to the selection (Shift-click's effect). */
        pick: (n: number, id: string) => load(n).then(() => togglePick(n, id)),
        group: () => groupSelection(),
        ungroup: () => ungroupSelection(),
        order: (to: 'forward' | 'backward') => reorder(to),
      },
    };
  },
};
export default tool;
