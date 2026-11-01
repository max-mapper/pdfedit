// Paragraphs → boxes. Paragraphs in one table cell always form one box. Otherwise,
// top to bottom in each direction, a paragraph joins the box directly above it when they share a column (both
// edges within columnTol em, or one inside the other's span), the gap is under boxGap × line height, they are in
// the same panel, no rule lies between, the box above is the only one it touches, and the box does not span
// several columns at this paragraph's height (a paragraph beside it lies under the same box).
import type { Thresholds } from './types.ts';
import type { ParaRec } from './paragraphs.ts';
import type { Seg } from './rules.ts';
import { parBetween, parallelBarriers } from './rules.ts';
import { overlap } from './geom.ts';
import type { Frame } from './geom.ts';

export type BoxRec = { paras: number[]; group: string; s0: number; s1: number; lo: number; hi: number; cell: number; panel: number; open: boolean };

export function buildBoxes(paras: ParaRec[], frames: Map<string, Frame>, segs: Seg[], th: Thresholds): BoxRec[] {
  const order = paras.map((_, i) => i).sort((a, b) => (paras[a].group < paras[b].group ? -1 : paras[a].group > paras[b].group ? 1 : 0) ||
    paras[b].hi - paras[a].hi || paras[a].s0 - paras[b].s0);
  // paragraphs beside each other: same direction, overlapping across, disjoint along
  const beside: number[][] = paras.map(() => []);
  for (let a = 0; a < paras.length; a++) for (let b = a + 1; b < paras.length; b++) {
    const A = paras[a], B = paras[b];
    if (A.group !== B.group) continue;
    if (overlap(A.lo, A.hi, B.lo, B.hi) > 0 && overlap(A.s0, A.s1, B.s0, B.s1) <= 0) { beside[a].push(b); beside[b].push(a); }
  }
  const barCache = new Map<string, ReturnType<typeof parallelBarriers>>();
  const boxes: BoxRec[] = [];
  const byCell = new Map<string, BoxRec>();
  for (const pi of order) {
    const N = paras[pi];
    if (N.cell >= 0) {
      const key = `${N.group}:${N.cell}`;
      let X = byCell.get(key);
      if (!X) { X = { paras: [], group: N.group, s0: N.s0, s1: N.s1, lo: N.lo, hi: N.hi, cell: N.cell, panel: N.panel, open: false }; byCell.set(key, X); boxes.push(X); }
      add(X, N, pi);
      continue;
    }
    const em = N.size, colTol = th.columnTol * em;
    let bars = barCache.get(N.group);
    if (!bars) barCache.set(N.group, (bars = parallelBarriers(segs, frames.get(N.group)!)));
    let touching = 0;
    let cand: BoxRec | null = null;
    for (const X of boxes) {
      if (!X.open || X.group !== N.group || X.cell >= 0) continue;
      const P = paras[X.paras[X.paras.length - 1]];
      const lh = Math.max(1.2 * Math.max(N.size, P.size), P.leading, N.leading);
      const gap = X.lo - N.hi;
      if (gap > th.boxGap * lh || gap < -0.5 * lh) continue;
      if (overlap(X.s0, X.s1, N.s0, N.s1) <= 0) continue;
      touching++;
      if (X.panel !== N.panel) continue;
      if (Math.abs(P.size - N.size) > th.sizeTol * Math.max(P.size, N.size)) continue;   // a heading is not its body's box
      const share = (Math.abs(X.s0 - N.s0) <= colTol && Math.abs(X.s1 - N.s1) <= colTol) ||
        (N.s0 >= X.s0 - colTol && N.s1 <= X.s1 + colTol) || (X.s0 >= N.s0 - colTol && X.s1 <= N.s1 + colTol);
      if (!share) continue;
      if (parBetween(bars, N.hi - 0.01, X.lo + 0.01, Math.max(X.s0, N.s0), Math.min(X.s1, N.s1))) continue;
      if (beside[pi].some((m) => overlap(paras[m].s0, paras[m].s1, X.s0, X.s1) > 0)) continue;
      cand = X;
    }
    let target: BoxRec;
    if (cand && touching === 1) target = cand;
    else { target = { paras: [], group: N.group, s0: N.s0, s1: N.s1, lo: N.lo, hi: N.hi, cell: -1, panel: N.panel, open: true }; boxes.push(target); }
    add(target, N, pi);
    for (const X of boxes) {
      if (X === target || !X.open || X.group !== N.group) continue;
      if (X.lo >= N.hi - 0.5 * em && overlap(X.s0, X.s1, N.s0, N.s1) > 0) X.open = false;
    }
  }
  return boxes;
}

function add(X: BoxRec, N: ParaRec, pi: number) {
  X.paras.push(pi);
  X.s0 = Math.min(X.s0, N.s0); X.s1 = Math.max(X.s1, N.s1); X.lo = Math.min(X.lo, N.lo); X.hi = Math.max(X.hi, N.hi);
}
