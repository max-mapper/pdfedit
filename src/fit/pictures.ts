// Picture geometry for the fitter: a picture may be shrunk toward its anchor by at most 25% or
// moved by at most its own size, never cropped. The fitter (fit.ts) picks among the candidates made here; export
// (src/export/pictures.ts) applies the chosen PictureMove to the page.
import type { Box, Page, Picture, PictureMove, Rect } from '../model/types.ts';

/** The sides a picture keeps when it shrinks: the one nearest its caption, else the one nearest the page edge. */
export type Anchor = { x: 'x0' | 'x1'; y: 'y0' | 'y1' };
export type Candidate = { frame: Rect; cost: number; kind: 'shrink' | 'move' };

const W = (r: Rect) => r.x1 - r.x0;
const H = (r: Rect) => r.y1 - r.y0;
const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/** The picture's frame with its move applied (its source frame when it has none). */
export function movedFrame(p: Pick<Picture, 'frame' | 'move'>): Rect {
  const f = p.frame;
  if (!p.move) return { ...f };
  const { dx, dy, scale } = p.move;
  return { x0: f.x0 + dx, y0: f.y0 + dy, x1: f.x0 + dx + W(f) * scale, y1: f.y0 + dy + H(f) * scale };
}

/** The move that takes a frame to another of the same proportions. */
export function moveBetween(from: Rect, to: Rect): PictureMove {
  return { dx: to.x0 - from.x0, dy: to.y0 - from.y0, scale: W(to) / W(from) };
}

/**
 * A picture's caption: the nearest box just below or above it, within 1.5 × its text size (at least 6 pt), that
 * overlaps at least half of the narrower of the two and is not much wider than the picture (a column of text beside
 * or under a picture is not its caption).
 */
export function captionOf(p: Picture, boxes: Box[]): { box: Box; side: 'below' | 'above' } | null {
  const f = p.frame;
  let best: { box: Box; side: 'below' | 'above'; d: number } | null = null;
  for (const b of boxes) {
    const s = b.source.frame;
    if (W(s) > 1.5 * W(f) || ov(s.x0, s.x1, f.x0, f.x1) < 0.5 * Math.min(W(s), W(f))) continue;
    const reach = Math.max(6, 1.5 * (b.source.paragraphs[0]?.size ?? 10));
    for (const [side, d] of [['below', f.y0 - s.y1], ['above', s.y0 - f.y1]] as const) {
      if (d >= -0.5 && d <= reach && (!best || d < best.d)) best = { box: b, side, d };
    }
  }
  return best ? { box: best.box, side: best.side } : null;
}

/** The anchor: vertically the caption's side, else the side nearest the page edge; horizontally the side nearest
 *  the page edge. */
export function anchorOf(p: Picture, page: Pick<Page, 'w' | 'h' | 'boxes'>): { anchor: Anchor; caption: Box | null } {
  const f = p.frame;
  const cap = captionOf(p, page.boxes);
  const anchor: Anchor = { x: f.x0 <= page.w - f.x1 ? 'x0' : 'x1', y: f.y0 <= page.h - f.y1 ? 'y0' : 'y1' };
  if (cap?.side === 'below') anchor.y = 'y0';
  else if (cap?.side === 'above') anchor.y = 'y1';
  return { anchor, caption: cap?.box ?? null };
}

/** The frame shrunk to `scale` toward the anchor's sides. */
export function shrinkToward(f: Rect, a: Anchor, scale: number): Rect {
  const w = W(f) * scale, h = H(f) * scale;
  return {
    x0: a.x === 'x0' ? f.x0 : f.x1 - w, x1: a.x === 'x0' ? f.x0 + w : f.x1,
    y0: a.y === 'y0' ? f.y0 : f.y1 - h, y1: a.y === 'y0' ? f.y0 + h : f.y1,
  };
}

/**
 * Every change the fitter may try, cheapest first. Cost: the share of the picture's size that changes (a 10% shrink
 * and a move by a tenth of its width both cost 0.1); a shrink comes before a move of the same cost. Shrinks run in
 * `step`s down to 1 − maxShrink; moves (only when `canMove`: a picture with a caption keeps its place) go left, right,
 * up or down in steps of `step` × its size, up to its size.
 */
export function candidates(f: Rect, a: Anchor, opts: { maxShrink: number; step: number; canMove: boolean }): Candidate[] {
  const out: Candidate[] = [];
  const n = Math.round(opts.maxShrink / opts.step);
  for (let k = 1; k <= n; k++) {
    const s = Math.max(1 - opts.maxShrink, +(1 - k * opts.step).toFixed(6));
    out.push({ frame: shrinkToward(f, a, s), cost: +(1 - s).toFixed(6), kind: 'shrink' });
  }
  if (opts.canMove) {
    const m = Math.round(1 / opts.step);
    for (let k = 1; k <= m; k++) {
      const c = +(k * opts.step).toFixed(6);
      const dx = W(f) * c, dy = H(f) * c;
      for (const [x, y] of [[dx, 0], [-dx, 0], [0, dy], [0, -dy]]) {
        out.push({ frame: { x0: f.x0 + x, x1: f.x1 + x, y0: f.y0 + y, y1: f.y1 + y }, cost: c, kind: 'move' });
      }
    }
  }
  // stable: shrinks were pushed first, so they win ties
  return out.sort((p, q) => p.cost - q.cost);
}

export const sameRect = (a: Rect, b: Rect, tol = 0.5) =>
  Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
