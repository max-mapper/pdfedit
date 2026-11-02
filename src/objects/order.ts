// Paint order: bringing an object (or a group) forward or sending it backward by one, within the content stream that
// paints it (ISO 32000-1 §8.2: later objects paint over earlier ones; §8.4.2 graphics state stack; §8.5.4 clipping;
// §9.3 text state; §14.6 marked content).
//
// A stream is read as units in paint order: an object's own q … Q (src/objects/read.ts ownGroup), else its operator
// range, or a whole BT … ET for text. Two neighbouring units can trade places when only graphics or text state
// operators lie between them (no q or Q, no clipping path, no marked-content operator), they are under the same clips
// and marked content, and the earlier one leaves no clip in force behind it. Units joined so form a run; a move stays
// inside its run. Anything else is refused with the reason: a form XObject's boundary, another q … Q level, another
// clip, another marked-content sequence. A group moves as a block when its members are units painted one after
// another in one stream.
//
// Writing a new order (orderText) rewrites the stretch of the stream from the first unit that moved to the last: each
// unit, in its new place, is painted inside q … Q after the state operators that came before it in the stretch (so
// it sees the state it saw before), and after the stretch every state operator of it is replayed in its first order
// (so what follows sees the state it saw before). The units' own bytes are copied unchanged, so every object keeps its
// operator bytes; a move or deletion of a unit in the same export is folded into its copy.
import { fmtNum } from '../pdf/surgery.ts';
import { parseOps, type Op } from '../pdf/ops.ts';
import type { ContentTree, StreamNode } from '../pdf/tree.ts';
import { outerClips } from './groups.ts';
import type { Scene } from './hit.ts';
import type { AppliedOps } from './ops.ts';
import type { Clip, PageObject, PageObjects } from './types.ts';

/** Graphics and text state operators (ISO 32000-1 Tables 57, 74, 105): the only operators allowed between units that
 *  trade places, replayed when the order is written. */
export const STATE_OPS = new Set(['cm', 'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs', 'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts']);

export type Unit = {
  /** Its place among the stream's units as read. */
  index: number;
  /** Operator indices: its own q … Q, its operators, or its BT … ET. */
  range: [number, number];
  /** Object ids it paints directly (text: every text object of the BT … ET). */
  objects: string[];
  /** Paint order of its first object and of its last (a form: its last descendant). */
  z: [number, number];
  text: boolean;
  /** State operators set inside it that stay in force after it, as operator text (a BT … ET's text state). */
  state: string[];
  /** Why the next unit cannot trade places with it, or null. */
  next: string | null;
  /** Units of one run can be put in any order among themselves. */
  run: number;
};

export type OrderResult = {
  op: AppliedOps['order'][number];
  ok: boolean;
  reason?: string;
  /** The objects it moved past (their units' objects). */
  past?: string[];
  /** The stream's content path ('' the page, '12', '12/3'). */
  stream?: string;
};

export type StreamOrder = {
  key: string;
  node: StreamNode;
  units: Unit[];
  /** Unit indices in the new paint order. */
  order: number[];
  /** First and last unit index (as read) whose place changed. */
  changed: [number, number];
};

export type OrderPlan = {
  /** Streams whose order changed. */
  streams: StreamOrder[];
  results: OrderResult[];
  /** New paint order of every object in a changed stretch (others keep their z). */
  z: Map<string, number>;
};

const latin1 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const latin1Bytes = (s: string) => { const o = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 0xff; return o; };
const numAt = (o: Op, k: number): number => { const t = o.operands[o.operands.length - k]; return t?.type === 'number' ? t.value : NaN; };
const PATH_OPS = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're', 'W', 'W*', 'n', 'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

/** The content path of a stream node, as object ids name it ('' the page). */
export function streamKey(n: StreamNode): string {
  const parts: number[] = [];
  for (let p: StreamNode | null = n; p && p.parent && p.call; p = p.parent) parts.unshift(p.call.opIndex);
  return parts.join('/');
}

function whyBetween(o: Op): string {
  if (o.op === 'q' || o.op === 'Q') return 'they are in different q … Q levels of the stream';
  if (PATH_OPS.has(o.op)) return 'a clip is set between them';
  if (o.op === 'BMC' || o.op === 'BDC' || o.op === 'EMC' || o.op === 'MP' || o.op === 'DP') return 'a marked-content boundary lies between them';
  return `the operator ${o.op} lies between them`;
}

/** A text unit's state that outlives its ET, as operator text (TD sets the leading, " the spacings). */
function textState(node: StreamNode, r: [number, number]): string[] {
  const out: string[] = [];
  for (let i = r[0]; i <= r[1]; i++) {
    const o = node.ops[i];
    if (STATE_OPS.has(o.op) && o.op !== 'cm') out.push(latin1(node.contents.subarray(o.start, o.end)));
    else if (o.op === 'TD') { const ty = numAt(o, 1); if (Number.isFinite(ty)) out.push(`${fmtNum(-ty)} TL`); }
    else if (o.op === '"') { const aw = numAt(o, 3), ac = numAt(o, 2); if (Number.isFinite(aw) && Number.isFinite(ac)) out.push(`${fmtNum(aw)} Tw ${fmtNum(ac)} Tc`); }
  }
  return out;
}

/** The units of one stream in paint order, with what joins them (see the top of this file). */
export function streamUnits(node: StreamNode, objects: readonly PageObject[], clips: ReadonlyMap<string, Clip>): Unit[] {
  const key = streamKey(node);
  const prefix = key ? `${key}/` : '';
  const ops = node.ops;
  const mine = objects.filter((o) => o.path.join('/') === key).sort((a, b) => a.z - b.z);
  const lastZ = (o: PageObject) => {
    if (o.kind !== 'form') return o.z;
    const p = `${o.id}/`;
    return objects.reduce((z, x) => (x.id.startsWith(p) ? Math.max(z, x.z) : z), o.z);
  };
  const units: Unit[] = [];
  const textAt = new Map<number, Unit>();
  for (const o of mine) {
    if (o.kind === 'text') {
      let bt = -1, et = -1;
      for (let i = o.ops[0]; i >= 0; i--) { if (ops[i].op === 'BT') { bt = i; break; } if (ops[i].op === 'ET' && i !== o.ops[0]) break; }
      for (let i = o.ops[1]; i < ops.length; i++) { if (ops[i].op === 'ET') { et = i; break; } if (ops[i].op === 'BT' && i !== o.ops[1]) break; }
      const r: [number, number] = bt >= 0 && et >= 0 ? [bt, et] : [...o.ops];
      const have = textAt.get(r[0]);
      if (have) { have.objects.push(o.id); have.z[1] = Math.max(have.z[1], o.z); continue; }
      const u: Unit = { index: 0, range: r, objects: [o.id], z: [o.z, o.z], text: true, state: [], next: null, run: 0 };
      textAt.set(r[0], u);
      units.push(u);
      continue;
    }
    units.push({ index: 0, range: [...(o.group ?? o.ops)], objects: [o.id], z: [o.z, lastZ(o)], text: false, state: [], next: null, run: 0 });
  }
  units.sort((a, b) => a.range[0] - b.range[0]);
  const byId = new Map(mine.map((o) => [o.id, o]));
  const first = (u: Unit) => byId.get(u.objects[0])!;
  let run = 0;
  units.forEach((u, k) => {
    u.index = k;
    if (u.text) u.state = textState(node, u.range);
    u.run = run;
    const v = units[k + 1];
    let why: string | null = null;
    // its own balance: marked content opened or closed inside it would change the nesting where it lands
    let mc = 0;
    for (let i = u.range[0]; i <= u.range[1]; i++) { const op = ops[i].op; if (op === 'BMC' || op === 'BDC') mc++; else if (op === 'EMC') mc--; }
    if (mc !== 0) why = 'a marked-content sequence starts or ends inside it';
    if (!why && !first(u).group && clips.has(`${prefix}${u.range[1]}`)) why = 'it sets a clip that stays in force after it';
    if (v && !why) {
      if (v.range[0] <= u.range[1]) why = 'their operators overlap';
      for (let i = u.range[1] + 1; i < v.range[0] && !why; i++) if (!STATE_OPS.has(ops[i].op)) why = whyBetween(ops[i]);
      if (!why && JSON.stringify(outerClips(first(u))) !== JSON.stringify(outerClips(first(v)))) why = 'they are painted under different clips';
      if (!why && JSON.stringify(first(u).marked) !== JSON.stringify(first(v).marked)) why = 'they are in different marked-content sequences';
    }
    if (!v) why = null;
    u.next = why;
    if (why) run++;
  });
  return units;
}

/** Plans the page's order ops (AppliedOps.order) in order, against the content tree as read. */
export function planOrder(model: PageObjects, tree: ContentTree, applied: Pick<AppliedOps, 'order'>): OrderPlan {
  const results: OrderResult[] = [];
  const byId = new Map(model.objects.map((o) => [o.id, o]));
  const clips = new Map(model.clips.map((c) => [c.id, c]));
  const nodes = new Map(tree.nodes.map((n) => [streamKey(n), n]));
  if (!nodes.has('')) nodes.set('', tree.root);
  const state = new Map<string, { node: StreamNode; units: Unit[]; seq: number[]; unitOf: Map<string, number> }>();
  const streamOf = (key: string) => {
    let s = state.get(key);
    if (s) return s;
    const node = nodes.get(key);
    if (!node || node.error) return null;
    const units = streamUnits(node, model.objects, clips);
    const unitOf = new Map<string, number>();
    for (const u of units) for (const id of u.objects) unitOf.set(id, u.index);
    state.set(key, (s = { node, units, seq: units.map((u) => u.index), unitOf }));
    return s;
  };
  for (const op of applied.order) {
    const refuse = (reason: string, stream?: string) => { results.push({ op, ok: false, reason, ...(stream !== undefined ? { stream } : {}) }); };
    const objs = op.members.map((m) => byId.get(m)).filter((o): o is PageObject => !!o);
    if (!objs.length) { refuse(`there is no object or group ${op.id} on the page`); continue; }
    if (objs.some((o) => o.kind === 'text')) { refuse('text keeps its place in the paint order here'); continue; }
    const keys = new Set(objs.map((o) => o.path.join('/')));
    if (keys.size > 1) { refuse('its members are painted by different content streams (across a form XObject boundary)'); continue; }
    const key = [...keys][0];
    const s = streamOf(key);
    if (!s) { refuse('the stream that paints it cannot be read', key); continue; }
    const pos = objs.map((o) => s.seq.indexOf(s.unitOf.get(o.id) ?? -1)).sort((a, b) => a - b);
    if (pos[0] < 0) { refuse('it is not a unit of its stream', key); continue; }
    if (pos.some((p, k) => k > 0 && p !== pos[k - 1] + 1)) { refuse('its members are not painted one after another', key); continue; }
    const p = pos[0], q = pos[pos.length - 1];
    const runs = new Set(pos.map((k) => s.units[s.seq[k]].run));
    const runEnd = (r: number, dir: 1 | -1) => {
      const inRun = s.units.filter((u) => u.run === r);
      return dir > 0 ? inRun[inRun.length - 1] : s.units[inRun[0].index - 1];
    };
    if (runs.size > 1) { refuse(`its members cannot be moved together: ${s.units[s.seq[p]].next ?? 'they are in different runs'}`, key); continue; }
    const run = [...runs][0];
    const n = op.to === 'forward' ? q + 1 : p - 1;
    if (n < 0 || n >= s.seq.length) {
      refuse(key === ''
        ? `it is already the ${op.to === 'forward' ? 'topmost' : 'lowest'} object in the page's content stream`
        : `it is already the ${op.to === 'forward' ? 'topmost' : 'lowest'} object in its form XObject; the paint order changes only within one content stream`, key);
      continue;
    }
    const nb = s.units[s.seq[n]];
    if (nb.run !== run) {
      const edge = runEnd(run, op.to === 'forward' ? 1 : -1);
      refuse(`the next object ${op.to === 'forward' ? 'above' : 'below'} it cannot trade places with it: ${edge?.next ?? 'it is out of reach'}`, key);
      continue;
    }
    s.seq.splice(n, 1);
    if (op.to === 'forward') s.seq.splice(p, 0, nb.index);
    else s.seq.splice(q, 0, nb.index);
    results.push({ op, ok: true, past: [...nb.objects], stream: key });
  }
  const streams: StreamOrder[] = [];
  const z = new Map<string, number>();
  const byZ = [...model.objects].sort((a, b) => a.z - b.z);
  for (const [key, s] of state) {
    const diff = s.seq.map((u, k) => (u !== k ? k : -1)).filter((k) => k >= 0);
    if (!diff.length) continue;
    const changed: [number, number] = [diff[0], diff[diff.length - 1]];
    streams.push({ key, node: s.node, units: s.units, order: [...s.seq], changed });
    let at = s.units[changed[0]].z[0];
    for (let k = changed[0]; k <= changed[1]; k++) {
      const u = s.units[s.seq[k]];
      for (const o of byZ) if (o.z >= u.z[0] && o.z <= u.z[1]) z.set(o.id, at + o.z - u.z[0]);
      at += u.z[1] - u.z[0] + 1;
    }
  }
  return { streams, results, z };
}

type ByteEdit = { start: number; end: number; text: string };

/** How a unit is copied into its new place: unchanged, with byte edits inside it (a move), or left out (deleted). */
export type UnitFold = { deleted?: boolean; edits?: ByteEdit[] };

export type OrderText = {
  /** The edit to the stream: [start, end) (byte offsets as read) replaced by `text` (latin1). */
  edit: { start: number; end: number; text: string };
  /** Operator indices (as read) of the stretch: the first unit's first and the last unit's last. */
  ops: [number, number];
  /** Operators the new text has. */
  total: number;
  /** For each operator of a unit in the stretch (as read), its index in the new text (null: left out). */
  at: Map<number, number>;
};

/** Where each operator lands after byte edits: its new index, or null when an edit removed it (src/objects/surgery.ts
 *  opIndexMap). */
export type IndexMap = (ops: readonly Op[], edits: readonly ByteEdit[]) => (i: number) => number | null;

/** The new text of a stream's changed stretch (see the top of this file). `fold`: unit index → how to copy it;
 *  `indexMap`: how operators shift under a unit's own edits. */
export function orderText(so: StreamOrder, fold: ReadonlyMap<number, UnitFold>, indexMap: IndexMap): OrderText {
  const { node, units, order, changed } = so;
  const ops = node.ops;
  const raw = (i: number) => latin1(node.contents.subarray(ops[i].start, ops[i].end));
  // the state operators before each unit of the stretch, in their first order
  const before: string[][] = [];
  const acc: string[] = [];
  for (let k = changed[0]; k <= changed[1]; k++) {
    before[k] = [...acc];
    const u = units[k];
    acc.push(...u.state);
    const v = units[k + 1];
    if (k < changed[1] && v) for (let i = u.range[1] + 1; i < v.range[0]; i++) acc.push(raw(i));
  }
  const parts: string[] = [];
  const at = new Map<number, number>();
  let count = 0;
  const countOps = (t: string) => (t.trim() ? parseOps(latin1Bytes(t)).length : 0);
  for (let k = changed[0]; k <= changed[1]; k++) {
    const u = units[order[k]];
    const f = fold.get(u.index);
    if (f?.deleted) continue;
    const pre = before[u.index].join('\n');
    const head = `q\n${pre ? `${pre}\n` : ''}`;
    const start = ops[u.range[0]].start, end = ops[u.range[1]].end;
    const edits = (f?.edits ?? []).map((e) => ({ start: e.start - start, end: e.end - start, text: e.text })).sort((a, b) => a.start - b.start);
    let body = '';
    let pos = 0;
    const bytes = node.contents.subarray(start, end);
    for (const e of edits) { body += latin1(bytes.subarray(pos, e.start)) + e.text; pos = Math.max(pos, e.end); }
    body += latin1(bytes.subarray(pos));
    const base = count + countOps(head);
    const idx = indexMap(ops.slice(u.range[0], u.range[1] + 1), f?.edits ?? []);
    for (let i = u.range[0]; i <= u.range[1]; i++) { const j = idx(i - u.range[0]); if (j !== null) at.set(i, base + j); }
    const piece = `${head}${body}\nQ\n`;
    parts.push(piece);
    count += countOps(piece);
  }
  const tail = acc.join('\n');
  if (tail) { parts.push(`${tail}\n`); count += countOps(tail); }
  const r0 = units[changed[0]].range[0], r1 = units[changed[1]].range[1];
  return { edit: { start: ops[r0].start, end: ops[r1].end, text: parts.join('') }, ops: [r0, r1], total: count, at };
}

/**
 * A selection scene (src/objects/hit.ts) with a new paint order (OrderPlan.z): the objects that changed place take
 * their new z, a text box the highest of its text objects', and their old bounds are where the render of the file no
 * longer shows the page as edited (the render test is not trusted there). Mutates and returns the scene.
 */
export function reorderScene(sc: Scene, model: PageObjects, z: ReadonlyMap<string, number>): Scene {
  if (!z.size) return sc;
  const byId = new Map(model.objects.map((o) => [o.id, o]));
  const boxZ = new Map<string, number>();
  for (const [obj, box] of sc.claimed) {
    const o = byId.get(obj);
    if (!o) continue;
    boxZ.set(box, Math.max(boxZ.get(box) ?? -Infinity, z.get(obj) ?? o.z));
  }
  for (const s of sc.items) {
    const nz = s.object ? z.get(s.object.id) : s.box ? boxZ.get(s.id) : undefined;
    if (nz === undefined || nz === s.z) continue;
    s.z = nz;
    sc.stale.push({ ...s.bounds });
  }
  sc.items.sort((a, b) => a.z - b.z || (a.kind === 'text' ? 1 : 0) - (b.kind === 'text' ? 1 : 0));
  for (const s of sc.items) if (s.members.length) s.members.sort((a, b) => (sc.byId.get(a)?.z ?? 0) - (sc.byId.get(b)?.z ?? 0));
  return sc;
}
