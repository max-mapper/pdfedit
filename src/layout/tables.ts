// Rule segments → table grids. Collinear pieces are joined, segments that cross or touch form connected groups,
// and a group with at least three distinct vertical and three distinct horizontal positions (2 × 2 cells) is a
// grid. A cell boundary with no rule along it merges the two cells (spanning cells).
import type { Rect } from './types.ts';
import type { Seg } from './rules.ts';

export type Region = { rect: Rect; r: number; c: number; r1: number; c1: number };
export type Grid = { frame: Rect; xs: number[]; ys: number[] /* top first */; rows: number; cols: number;
  regions: Region[]; slot: number[] /* row-major: grid cell → region index */ };

const TOL = 2;

function joinCollinear(segs: Seg[], horizontal: boolean): Seg[] {
  const pos = (s: Seg) => (horizontal ? s.y0 : s.x0);
  const a0 = (s: Seg) => (horizontal ? s.x0 : s.y0);
  const a1 = (s: Seg) => (horizontal ? s.x1 : s.y1);
  const sorted = [...segs].sort((p, q) => pos(p) - pos(q) || a0(p) - a0(q));
  const out: Seg[] = [];
  for (const s of sorted) {
    let merged = false;
    for (let k = out.length - 1; k >= 0 && pos(s) - pos(out[k]) <= 1; k--) {
      const o = out[k];
      if (a0(s) <= a1(o) + TOL && a1(s) >= a0(o) - TOL) {
        const lo = Math.min(a0(o), a0(s)), hi = Math.max(a1(o), a1(s)), p = (pos(o) + pos(s)) / 2;
        out[k] = horizontal ? { x0: lo, x1: hi, y0: p, y1: p, shape: o.shape } : { y0: lo, y1: hi, x0: p, x1: p, shape: o.shape };
        merged = true;
        break;
      }
    }
    if (!merged) out.push({ ...s });
  }
  return out;
}

function clusterPositions(vals: number[]): number[] {
  const a = [...vals].sort((p, q) => p - q);
  const out: number[][] = [];
  for (const v of a) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= TOL) last.push(v); else out.push([v]);
  }
  return out.map((g) => g.reduce((p, q) => p + q, 0) / g.length);
}

function find(p: number[], i: number): number { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; }

export function findTables(segs: Seg[]): Grid[] {
  const H = joinCollinear(segs.filter((s) => s.y0 === s.y1 && s.x1 - s.x0 > 3), true);
  const V = joinCollinear(segs.filter((s) => s.x0 === s.x1 && s.y1 - s.y0 > 3), false);
  if (H.length < 3 || V.length < 2 || H.length * V.length > 4e6) return [];
  const parent = Array.from({ length: H.length + V.length }, (_, i) => i);
  for (let h = 0; h < H.length; h++) for (let v = 0; v < V.length; v++) {
    const a = H[h], b = V[v];
    if (b.x0 >= a.x0 - TOL && b.x0 <= a.x1 + TOL && a.y0 >= b.y0 - TOL && a.y0 <= b.y1 + TOL) {
      const ra = find(parent, h), rb = find(parent, H.length + v);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map<number, { h: Seg[]; v: Seg[] }>();
  for (let k = 0; k < parent.length; k++) {
    const r = find(parent, k);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { h: [], v: [] }));
    if (k < H.length) g.h.push(H[k]); else g.v.push(V[k - H.length]);
  }
  const grids: Grid[] = [];
  for (const g of groups.values()) {
    const xs = clusterPositions(g.v.map((s) => s.x0));
    const ys = clusterPositions(g.h.map((s) => s.y0)).reverse();
    if (xs.length < 3 || ys.length < 3) continue;
    const rows = ys.length - 1, cols = xs.length - 1;
    const vSep = (x: number, y: number) => g.v.some((s) => Math.abs(s.x0 - x) <= TOL && y >= s.y0 - TOL && y <= s.y1 + TOL);
    const hSep = (y: number, x: number) => g.h.some((s) => Math.abs(s.y0 - y) <= TOL && x >= s.x0 - TOL && x <= s.x1 + TOL);
    const p = Array.from({ length: rows * cols }, (_, i) => i);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ym = (ys[r] + ys[r + 1]) / 2, xm = (xs[c] + xs[c + 1]) / 2;
      if (c + 1 < cols && !vSep(xs[c + 1], ym)) { const a = find(p, r * cols + c), b = find(p, r * cols + c + 1); if (a !== b) p[b] = a; }
      if (r + 1 < rows && !hSep(ys[r + 1], xm)) { const a = find(p, r * cols + c), b = find(p, (r + 1) * cols + c); if (a !== b) p[b] = a; }
    }
    const byRoot = new Map<number, number>();
    const regions: Region[] = [];
    const slot: number[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const root = find(p, r * cols + c);
      let k = byRoot.get(root);
      const cell = { x0: xs[c], x1: xs[c + 1], y0: ys[r + 1], y1: ys[r] };
      if (k === undefined) {
        k = regions.length;
        byRoot.set(root, k);
        regions.push({ rect: cell, r, c, r1: r, c1: c });
      } else {
        const R = regions[k];
        R.rect = { x0: Math.min(R.rect.x0, cell.x0), y0: Math.min(R.rect.y0, cell.y0), x1: Math.max(R.rect.x1, cell.x1), y1: Math.max(R.rect.y1, cell.y1) };
        R.r1 = Math.max(R.r1, r); R.c1 = Math.max(R.c1, c);
      }
      slot.push(k);
    }
    if (regions.length < 3) continue;
    grids.push({ frame: { x0: xs[0], x1: xs[cols], y0: ys[rows], y1: ys[0] }, xs, ys, rows, cols, regions, slot });
  }
  return grids;
}
