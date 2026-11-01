// Reading order: recursive XY-cut over node frames. A node is a box, a table (its
// cells in row-major order) or a panel (its contents ordered by their own XY-cut). At each level the widest
// whitespace gap is cut; a vertical cut (between columns) is preferred whenever one of at least cutGapX points
// exists, except where most boxes are vertical text, which prefers horizontal cuts and orders columns right to
// left. A horizontal cut avoids gaps that only continue a column structure (paragraph gaps that happen to line up
// across columns): of the gaps whose bottom-most nodes above and top-most nodes below share a column gutter, none
// is taken while another gap exists (XY-Cut++'s fix for interleaved columns under a spanning title). With no gap
// left, nodes go top to bottom, then left to right (right to left for vertical text).
import type { Rect, Thresholds } from './types.ts';

export type Node = { frame: Rect; vertical: boolean; box?: number; kids?: Node[]; rowMajor?: boolean };

type Gap = { w: number; at: number };

function widestGap(nodes: Node[], axis: 'x' | 'y'): Gap {
  const iv = nodes.map((n) => (axis === 'x' ? [n.frame.x0, n.frame.x1] : [n.frame.y0, n.frame.y1])).sort((a, b) => a[0] - b[0]);
  let best: Gap = { w: -Infinity, at: 0 };
  let end = iv[0][1];
  for (let k = 1; k < iv.length; k++) {
    if (iv[k][0] > end && iv[k][0] - end > best.w) best = { w: iv[k][0] - end, at: (iv[k][0] + end) / 2 };
    end = Math.max(end, iv[k][1]);
  }
  return best;
}

function gaps(nodes: Node[], axis: 'x' | 'y', min: number): Gap[] {
  const iv = nodes.map((n) => (axis === 'x' ? [n.frame.x0, n.frame.x1] : [n.frame.y0, n.frame.y1])).sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  let end = iv[0][1];
  for (let k = 1; k < iv.length; k++) {
    if (iv[k][0] - end >= min) out.push({ w: iv[k][0] - end, at: (iv[k][0] + end) / 2 });
    end = Math.max(end, iv[k][1]);
  }
  return out;
}

const xOverlap = (a: Node, b: Node) => Math.min(a.frame.x1, b.frame.x1) - Math.max(a.frame.x0, b.frame.x0) > 0;

/** A horizontal cut at `g` only continues columns: the nodes just above and just below share a gutter. */
function continuesColumns(nodes: Node[], g: Gap, th: Thresholds): boolean {
  const up = nodes.filter((n) => (n.frame.y0 + n.frame.y1) / 2 > g.at), down = nodes.filter((n) => (n.frame.y0 + n.frame.y1) / 2 <= g.at);
  const bottomMost = up.filter((n) => !up.some((m) => m !== n && xOverlap(n, m) && m.frame.y1 <= n.frame.y0));
  const topMost = down.filter((n) => !down.some((m) => m !== n && xOverlap(n, m) && m.frame.y0 >= n.frame.y1));
  if (bottomMost.length < 2 || topMost.length < 2) return false;
  const a = gaps(bottomMost, 'x', th.cutGapX), b = gaps(topMost, 'x', th.cutGapX);
  return a.some((p) => b.some((q) => Math.abs(p.at - q.at) < (p.w + q.w) / 2));
}

function cut(nodes: Node[], th: Thresholds): Node[] {
  if (nodes.length <= 1) return nodes;
  const vert = nodes.filter((n) => n.vertical).length * 2 > nodes.length;
  const gx = widestGap(nodes, 'x'), gy = widestGap(nodes, 'y');
  const canX = gx.w >= th.cutGapX, canY = gy.w >= th.cutGapY;
  const useX = vert ? canX && !canY : canX;
  if (useX) {
    const left = nodes.filter((n) => (n.frame.x0 + n.frame.x1) / 2 < gx.at), right = nodes.filter((n) => (n.frame.x0 + n.frame.x1) / 2 >= gx.at);
    return vert ? [...cut(right, th), ...cut(left, th)] : [...cut(left, th), ...cut(right, th)];
  }
  if (canY && !vert && nodes.length <= 80) {
    const ys = gaps(nodes, 'y', th.cutGapY).sort((a, b) => b.w - a.w);
    const clean = ys.find((g) => !continuesColumns(nodes, g, th));
    if (clean) { gy.w = clean.w; gy.at = clean.at; }
  }
  if (canY) {
    const top = nodes.filter((n) => (n.frame.y0 + n.frame.y1) / 2 > gy.at), bottom = nodes.filter((n) => (n.frame.y0 + n.frame.y1) / 2 <= gy.at);
    return [...cut(top, th), ...cut(bottom, th)];
  }
  return [...nodes].sort((a, b) => b.frame.y1 - a.frame.y1 || (vert ? b.frame.x1 - a.frame.x1 : a.frame.x0 - b.frame.x0));
}

/** Box indices in reading order. */
export function readingOrder(nodes: Node[], th: Thresholds): number[] {
  const out: number[] = [];
  const walk = (list: Node[]) => {
    for (const n of list) {
      if (n.box !== undefined) out.push(n.box);
      if (n.kids) walk(n.rowMajor ? n.kids : cut(n.kids, th));
    }
  };
  walk(cut(nodes, th));
  return out;
}
