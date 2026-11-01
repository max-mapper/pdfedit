// The fitter: an order of moves run on the editor's model, measured with the editor's own layout. For every edited box, in reading order, stop as soon as the text fits inside the box's allowed area
// and touches nothing it did not touch in the source:
//   1. widen into free space to the right (bounded by the source neighbours, the panel and the page margin);
//   2. grow down into free space, bounded the same way;
//   3. single leading;
//   4. move or shrink a picture that blocks the box (src/fit/pictures.ts): shrink it toward its anchor (the side
//      nearest its caption or the page edge) by at most 25%, or move it by at most its own size inside its panel
//      and the page margin, never onto other text, other pictures or off the page, and never crop it; the change
//      that lets the box fit with the least picture change wins. A moved picture is an obstacle in its new place for
//      the boxes after it;
//   5. shrink the text in 5% steps down to the floor (70% of its size by default), at each step trying the text
//      as it is first and then with a picture change;
//   6. still too tall: mark it unfit, with the characters over; the text is never shortened.
// Role groups (boxes with the same size and width on one row in the source) end at the same scale.
import type { Page, Box, LaidBox, Picture, Rect } from '../model/types.ts';
import { anchorOf, candidates, moveBetween, sameRect } from './pictures.ts';

export type FitOptions = {
  floor?: number;          // smallest scale of a run's size, default 0.7
  step?: number;           // shrink step, default 0.05
  gap?: number;            // clearance kept from obstacles, points, default 2
  maxWiden?: number;       // a box widens to at most this × its source width, default 2
  margin?: number;         // page margin; default: the smallest distance of any source box to the page edge, ≥ 4
  pictures?: boolean;      // move or shrink pictures that block a box (page.pictures), default true
  pictureShrink?: number;  // largest shrink of a picture, default and most 0.25 (the rulings' limit)
};

/** A picture's change, as the model's PictureMove (dx, dy: the move of its bottom-left corner). */
export type PictureChange = { id: string; dx: number; dy: number; scale: number };

export type BoxFit = {
  box: string;
  result: 'fits' | 'fixed' | 'unfit';
  actions: ('widen' | 'grow' | 'leading' | 'picture' | 'shrink')[];
  scale: number;           // final size scale (1 = unchanged)
  widened: number;         // points
  grew: number;            // points
  overBy: number;          // points of text height that still do not fit (unfit only)
  charsOver: number;       // estimate of the characters that do not fit at the floor (unfit only)
  pictures: PictureChange[];  // pictures moved or shrunk for this box
  ms: number;
};
export type FitReport = {
  page: number; boxes: BoxFit[];
  /** Every picture changed on the page, as it ends: for which box (the last one that changed it), its source and
   *  new frame. */
  pictures: (PictureChange & { box: string; from: Rect; to: Rect })[];
  ms: number;
};

const W = (r: Rect) => r.x1 - r.x0;
const H = (r: Rect) => r.y1 - r.y0;
const overlapsX = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0.5;
const overlapsY = (a: Rect, b: Rect) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5;
const touches = (a: Rect, b: Rect) => overlapsX(a, b) && overlapsY(a, b);
const expand = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const textOf = (b: Box) => b.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Scale every run of the box from its source size (`base` holds the sizes before fitting). */
function setScale(box: Box, base: number[][], s: number) {
  box.paragraphs.forEach((p, i) => p.runs.forEach((r, j) => { r.size = base[i][j] * s; }));
}

export function fitPage(page: Page, lay: (box: Box) => LaidBox, opts: FitOptions = {}): FitReport {
  const t0 = performance.now();
  const floor = opts.floor ?? 0.7, step = opts.step ?? 0.05, gap = opts.gap ?? 2, maxWiden = opts.maxWiden ?? 2;
  const pictureShrink = Math.min(0.25, Math.max(0, opts.pictureShrink ?? 0.25));
  const src = page.boxes.map((b) => b.source.frame);
  const margin = opts.margin ?? Math.max(4, Math.min(...src.map((f) => Math.min(f.x0, page.w - f.x1, f.y0, page.h - f.y1)).filter((v) => v >= 0), 36));
  // The page's content area: text never grows past the outermost source content (text, rules, cells, figures) on
  // any side, so the designed margins stay; full-bleed shapes (touching the page edge) do not count.
  const bleed = (r: Rect) => r.x0 <= 1 || r.y0 <= 1 || r.x1 >= page.w - 1 || r.y1 >= page.h - 1;
  const content = [...src, ...(page.rules ?? []), ...(page.fills ?? []), ...page.obstacles].filter((r) => !bleed(r));
  // (a sparse page still has the usual 7% margins to grow into)
  const area: Rect = {
    x0: Math.max(margin, Math.min(0.07 * page.w, ...content.map((r) => r.x0))), y0: Math.max(margin, Math.min(0.07 * page.h, ...content.map((r) => r.y0))),
    x1: Math.min(page.w - margin, Math.max(0.93 * page.w, ...content.map((r) => r.x1))), y1: Math.min(page.h - margin, Math.max(0.93 * page.h, ...content.map((r) => r.y1))),
  };
  const report: BoxFit[] = [];
  const done = new Map<string, Rect>();        // final frames of boxes fitted so far

  // Pictures. The fitter owns their moves, so every run starts from the source. A picture with text on it stays
  // fixed (moving it would leave the text behind); so do all of them with `pictures: false`.
  const pics = page.pictures ?? [];
  for (const p of pics) delete p.move;
  const movable = opts.pictures === false ? [] : pics.filter((p) => !page.boxes.some((b) => touches(b.source.frame, p.frame)));
  const isMovable = new Set(movable);
  const fixed: Rect[] = [
    ...page.obstacles.filter((r) => !movable.some((p) => sameRect(p.frame, r))),
    ...pics.filter((p) => !isMovable.has(p) && !page.obstacles.some((r) => sameRect(r, p.frame))).map((p) => p.frame),
  ];
  const cur = new Map<Picture, Rect>(movable.map((p) => [p, { ...p.frame }]));   // where each picture is now
  const changedFor = new Map<Picture, string>();

  // Other boxes as obstacles: their current frame (fitted ones) or source frame; never the box's source neighbours
  // it already touched; obstacles and pictures it did not sit on in the source (pictures where they are now).
  type Ob = { r: Rect; pic: Picture | null; src?: Rect };   // src: another text box's source frame (gutters)
  const obstaclesFor = (b: Box): Ob[] => [
    // every other box bounds growth, the source neighbours included: touching a neighbour the box already touched is
    // allowed (the limits below only look right of and below the source frame), growing into it is not
    ...page.boxes.filter((o) => o !== b).map((o) => ({ r: done.get(o.id) ?? o.frame, pic: null, src: o.source.frame })),
    ...fixed.filter((r) => !touches(r, b.source.frame)).map((r) => ({ r, pic: null })),
    ...movable.filter((p) => !touches(p.frame, b.source.frame)).map((p) => ({ r: cur.get(p)!, pic: p })),
    // rules and filled shapes (table rulings, cells, chart bars, cards) the box did not touch in the source: text
    // does not grow across a rule or into another container
    ...[...(page.rules ?? []), ...(page.fills ?? [])].filter((r) => !touches(expand(r, 0.5), b.source.frame)).map((r) => ({ r, pic: null })),
  ];

  // Where a picture may go: inside its own panel, else inside the page margin (a picture already in the margin
  // may stay there); never onto text (source frames and fitted frames), other pictures or other obstacles, and no
  // closer than the clearance to anything it was not already that close to.
  const panelOf = (r: Rect): Rect | null => page.panels
    .filter((pn) => pn.x0 <= r.x0 + 0.5 && pn.y0 <= r.y0 + 0.5 && pn.x1 >= r.x1 - 0.5 && pn.y1 >= r.y1 - 0.5)
    .sort((a, b) => W(a) * H(a) - W(b) * H(b))[0] ?? null;
  const placeOk = (p: Picture, f: Rect): boolean => {
    const lim = panelOf(p.frame) ?? { x0: margin, y0: margin, x1: page.w - margin, y1: page.h - margin };
    const room = { x0: Math.min(lim.x0, p.frame.x0), y0: Math.min(lim.y0, p.frame.y0), x1: Math.max(lim.x1, p.frame.x1), y1: Math.max(lim.y1, p.frame.y1) };
    if (f.x0 < room.x0 - 0.01 || f.y0 < room.y0 - 0.01 || f.x1 > room.x1 + 0.01 || f.y1 > room.y1 + 0.01) return false;
    const clash = (r: Rect) => touches(f, r) || (touches(expand(f, gap), r) && !touches(expand(p.frame, gap), r));
    for (const o of page.boxes) {
      if (clash(o.source.frame)) return false;
      const d = done.get(o.id);
      if (d && clash(d)) return false;
    }
    for (const q of movable) if (q !== p && clash(cur.get(q)!)) return false;
    for (const r of fixed) if (!touches(r, p.frame) && clash(r)) return false;
    return true;
  };

  for (const box of page.boxes) {
    if (!box.edited || box.locked) continue;
    const t1 = performance.now();
    const base = box.paragraphs.map((p) => p.runs.map((r) => r.size));
    const baseLeading = box.paragraphs.map((p) => p.leading);
    const s0 = box.source.frame;
    // the innermost container: the detected panel, or a smaller filled rectangle the box sits in (a cell, a card)
    const holds = (c: Rect) => c.x0 <= s0.x0 + 0.5 && c.x1 >= s0.x1 - 0.5 && c.y0 <= s0.y0 + 0.5 && c.y1 >= s0.y1 - 0.5;
    const panel = [box.source.panel, ...(page.fills ?? []).filter(holds)].filter((c): c is Rect => c !== null)
      .sort((a, b) => W(a) * H(a) - W(b) * H(b))[0] ?? null;
    let obst = obstaclesFor(box);
    // the clearance kept from an obstacle: against another text box, the gap the two had in the source (a column
    // gutter, the space between paragraphs) up to 1.5 em of this box's text, never less than `gap`
    const em = box.source.paragraphs[0]?.size ?? 10;
    const keep = (o: Ob, sourceGap: number) => (o.src ? Math.max(gap, Math.min(Math.max(0, sourceGap), 1.5 * em)) : gap);
    // the area the box may use: page minus margin, inside its panel
    const limit: Rect = {
      x0: Math.min(s0.x0, Math.max(area.x0, panel ? panel.x0 + gap : 0)), x1: Math.max(s0.x1, Math.min(area.x1, panel ? panel.x1 - gap : page.w)),
      y0: Math.min(s0.y0, Math.max(area.y0, panel ? panel.y0 + gap : 0)), y1: Math.max(s0.y1, Math.min(area.y1, panel ? panel.y1 - gap : page.h)),
    };
    if (box.vertical) {
      // Vertical writing: columns run down and stack leftwards from the right edge (src/model/layout.ts). The same
      // order of moves, turned: widen to the left (more columns), grow down (longer columns), single leading, shrink.
      // What has to fit is the column stack's width.
      let left = limit.x0;
      for (const o of obst) if (o.r.x1 <= s0.x0 + 0.5 && overlapsY(o.r, s0)) left = Math.max(left, o.r.x1 + keep(o, o.src ? s0.x0 - o.src.x1 : 0));
      const widthMax = Math.max(W(s0), Math.min(s0.x1 - left, W(s0) * maxWiden));
      let bottom = limit.y0;
      for (const o of obst) if (o.r.y1 <= s0.y0 + 0.5 && overlapsX(o.r, { ...s0, x0: s0.x1 - widthMax })) bottom = Math.max(bottom, o.r.y1 + keep(o, o.src ? s0.y0 - o.src.y1 : 0));
      const lengthMax = Math.max(H(s0), s0.y1 - bottom);
      const tryV = (length: number, width: number) => {
        box.frame = { x0: s0.x0, x1: s0.x1, y1: s0.y1, y0: s0.y1 - length };
        box.heightPinned = false;
        const laid = lay(box);
        const need = laid.width ?? (laid.frame.x1 - laid.frame.x0);
        return { ok: !laid.overflow && need <= width + 0.01, need, laid, frame: { x0: s0.x1 - Math.max(need, W(s0)), x1: s0.x1, y1: s0.y1, y0: s0.y1 - length } };
      };
      const vActions: BoxFit['actions'] = [];
      let r = tryV(H(s0), W(s0));
      let scale = 1;
      if (!r.ok) { r = tryV(H(s0), widthMax); if (r.ok) vActions.push('widen'); }
      // grow down only as far as needed: the shortest column length (in 5% steps of the source length) that fits
      const growTo = (width: number) => {
        for (let len = H(s0) * 1.05; len < lengthMax; len += H(s0) * 0.05) { const t = tryV(len, width); if (t.ok) return t; }
        return tryV(lengthMax, width);
      };
      if (!r.ok) { r = growTo(widthMax); if (r.ok) vActions.push('widen', 'grow'); }
      if (!r.ok) {
        box.paragraphs.forEach((p, i) => { p.leading = Math.min(baseLeading[i], Math.max(1.15, baseLeading[i] * 0.8)); });
        r = growTo(widthMax);
        if (r.ok) vActions.push('widen', 'grow', 'leading');
      }
      if (!r.ok) {
        vActions.splice(0, vActions.length, 'widen', 'grow', 'leading', 'shrink');
        for (let sc = 1 - step; sc >= floor - 1e-9; sc -= step) {
          scale = Math.max(floor, +sc.toFixed(4));
          setScale(box, base, scale);
          r = tryV(lengthMax, widthMax);
          if (r.ok) break;
        }
      }
      box.frame = r.frame;
      done.set(box.id, r.frame);
      const overBy = r.ok ? 0 : Math.max(0, r.need - widthMax);
      report.push({ box: box.id, result: r.ok ? (vActions.length ? 'fixed' : 'fits') : 'unfit', actions: [...new Set(vActions)], scale,
        widened: +(W(r.frame) - W(s0)).toFixed(1), grew: +(H(r.frame) - H(s0)).toFixed(1), overBy: +overBy.toFixed(1),
        charsOver: r.ok ? 0 : Math.ceil([...textOf(box)].length * overBy / Math.max(1, r.need)), pictures: [], ms: +(performance.now() - t1).toFixed(1) });
      continue;
    }
    // free space to the right of the source frame at its height, and below it at a width; and the pictures that
    // bound them (a picture that stops the widening, or the growth at the widest width)
    type Geo = { widthMax: number; bottomFor: (width: number) => number; blockers: Picture[] };
    const cap = W(s0) * maxWiden;
    // A label in a small container of its own (a table cell, a tag, a chip): it may use the container's width less
    // a quarter of its source insets (at least the clearance), centred in it, instead of shrinking hard or breaking a word.
    const cell = box.kind !== 'label' ? null : [...(page.fills ?? []), ...page.panels]
      .filter((c) => c.x0 <= s0.x0 + 0.5 && c.x1 >= s0.x1 - 0.5 && c.y0 <= s0.y0 + 0.5 && c.y1 >= s0.y1 - 0.5)
      .sort((a, b) => W(a) * H(a) - W(b) * H(b))[0] ?? null;
    const cellIn = cell && W(cell) <= 4 * W(s0) && W(cell) * H(cell) <= 12 * W(s0) * H(s0) ? (() => {
      const pad = Math.max(gap, Math.min(s0.x0 - cell.x0, cell.x1 - s0.x1) / 4);
      return { x0: cell.x0 + pad, x1: cell.x1 - pad, centred: Math.abs((s0.x0 - cell.x0) - (cell.x1 - s0.x1)) <= Math.max(2, 0.15 * W(cell)) };
    })() : null;
    const xFor = (width: number) => (cellIn && width > W(s0) + 0.01 ? (cellIn.x0 + cellIn.x1 - width) / 2 : s0.x0);
    const baseAlign = box.paragraphs.map((p) => p.align);
    const geo = (obs: Ob[]): Geo => {
      let right = limit.x1, rightBy: Picture | null = null;
      for (const o of obs) { if (!(o.r.x0 >= s0.x1 - 0.5 && overlapsY(o.r, s0))) continue; const lim = o.r.x0 - keep(o, o.src ? o.src.x0 - s0.x1 : 0); if (lim < right) { right = lim; rightBy = o.pic; } }
      // designed padding: a box keeps, toward its panel's edge (or the page margin), at least the inset it has on
      // the opposite side inside that panel (up to 3 em), so a paragraph never runs up to a container's border
      const padX = panel ? Math.max(gap, Math.min(Math.max(0, s0.x0 - panel.x0), 3 * em)) : gap;
      right = Math.min(right, panel ? panel.x1 - padX : limit.x1);
      // labels (and chart text) keep their width: they shrink, then wrap, but never spread over the graphics they label
      const widthMax = box.kind === 'label' ? Math.max(W(s0), cellIn ? cellIn.x1 - cellIn.x0 : 0) : Math.max(W(s0), Math.min(right - s0.x0, cap));
      const padY = panel ? Math.max(gap, Math.min(Math.max(0, panel.y1 - s0.y1), 2 * em)) : gap;
      const floorOf = (width: number): { y: number; by: Picture | null } => {
        const probe: Rect = { x0: s0.x0, x1: s0.x0 + width, y0: limit.y0, y1: s0.y0 };
        let y = Math.max(limit.y0, panel ? panel.y0 + padY : limit.y0), by: Picture | null = null;
        for (const o of obs) { if (!(o.r.y1 <= s0.y0 + 0.5 && overlapsX(o.r, probe))) continue; const lim = o.r.y1 + keep(o, o.src ? s0.y0 - o.src.y1 : 0); if (lim > y) { y = lim; by = o.pic; } }
        return { y, by };
      };
      const blockers = [right - s0.x0 < cap ? rightBy : null, floorOf(widthMax).by].filter((p): p is Picture => p !== null);
      return { widthMax, bottomFor: (width) => floorOf(width).y, blockers: [...new Set(blockers)] };
    };
    let g = geo(obst);
    const actions: BoxFit['actions'] = [];
    type Fit = { ok: boolean; laid: LaidBox; frame: Rect };
    // Pictures that cut into the box's own frame (a product shot in a card's corner) without holding it: the text was
    // set round them in the source, so no laid line may run under them.
    const cutIns = [...fixed, ...movable.map((p) => cur.get(p)!)].filter((r) => {
      if (!touches(r, s0)) return false;
      const ix = Math.min(r.x1, s0.x1) - Math.max(r.x0, s0.x0), iy = Math.min(r.y1, s0.y1) - Math.max(r.y0, s0.y0);
      return ix * iy < 0.5 * W(s0) * H(s0);
    });
    // a word split across lines with no hyphen (the layout's emergency break when a word is wider than the box)
    const brokenWord = (laid: LaidBox): boolean => {
      const texts = box.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));
      const cursor = texts.map(() => 0);
      for (let k = 0; k < laid.lines.length; k++) {
        const ln = laid.lines[k], pi = ln.para ?? 0, t = texts[pi];
        if (t === undefined) return false;
        const lt = ln.runs.flatMap((r) => r.glyphs.map((g) => g.text)).join('');
        let c = cursor[pi];
        while (c < t.length && /\s/u.test(t[c])) c++;
        const at = t.indexOf(lt.trim(), c);
        if (at < 0 || at - c > 2) return false;   // cannot follow the text (ligatures, markers): do not judge
        cursor[pi] = at + lt.trim().length;
        const next = laid.lines[k + 1];
        if (!next || (next.para ?? 0) !== pi || ln.hyphen) continue;
        const e = cursor[pi];
        if (e < t.length && /\p{L}/u.test(t[e]) && /\p{L}/u.test(t[e - 1] ?? '') && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(t[e])) return true;
      }
      return false;
    };
    const inkClash = (laid: LaidBox): boolean => {
      if (!cutIns.length) return false;
      for (const ln of laid.lines) {
        const gs = ln.runs.flatMap((r) => r.glyphs.map((g) => ({ x: g.x, size: r.size })));
        if (!gs.length) continue;
        const size = Math.max(...gs.map((g) => g.size));
        const ink: Rect = { x0: ln.x + gs[0].x, x1: ln.x + gs[gs.length - 1].x + 0.55 * size, y0: ln.baseline - 0.2 * size, y1: ln.baseline + 0.75 * size };
        if (cutIns.some((r) => touches(expand(r, gap / 2), ink))) return true;
      }
      return false;
    };
    const tryFit = (gg: Geo, width: number, allowGrow: boolean): Fit => {
      const x0 = xFor(width);
      box.frame = { x0, x1: x0 + width, y1: s0.y1, y0: s0.y0 };
      box.paragraphs.forEach((p, i) => { p.align = x0 !== s0.x0 && cellIn?.centred && p.align === 'left' ? 'center' : baseAlign[i]; });
      box.heightPinned = false;
      const laid = lay(box);
      const need = laid.height;
      const bottom = allowGrow ? gg.bottomFor(width) : s0.y0;
      const avail = s0.y1 - bottom;
      const ok = !laid.overflow && need <= Math.max(H(s0), avail) + 0.01 && !inkClash(laid) && !brokenWord(laid);
      return { ok, laid, frame: { x0, x1: x0 + width, y1: s0.y1, y0: s0.y1 - Math.max(need, H(s0)) } };
    };
    // leading comes down in steps (90%, then 80% of the source), never under 1.15 for Latin text (never raised)
    const leadAt = (base: number, level: number) => (level === 0 ? base : Math.min(base, Math.max(1.15, base * (level === 1 ? 0.9 : 0.8))));
    const setLeadingLevel = (level: number) => box.paragraphs.forEach((p, i) => { p.leading = leadAt(baseLeading[i], level); });
    const setLeading = (tight: boolean) => setLeadingLevel(tight ? 2 : 0);
    let res = tryFit(g, W(s0), false);
    let scale = 1, widened = 0, grew = 0;
    type Rung = { grow: boolean; leading: boolean; level?: number; act: BoxFit['actions'] };
    const ladder: Rung[] = [
      { grow: false, leading: false, act: ['widen'] },
      { grow: true, leading: false, act: ['widen', 'grow'] },
      { grow: true, leading: true, level: 1, act: ['widen', 'grow', 'leading'] },
      { grow: true, leading: true, level: 2, act: ['widen', 'grow', 'leading'] },
    ];
    // one-line titles and labels stay on one line if they can: after widening (labels do not widen), shrink a little
    // (titles to 85%, labels to the floor) before they are allowed to wrap
    const oneLine = box.source.lines <= 1;
    let early = false;
    if (!res.ok) {
      res = tryFit(g, g.widthMax, false);
      if (res.ok) { actions.push('widen'); early = true; }
      else if (oneLine && !g.blockers.length) {   // a blocking picture gives way first (pictures ≤ 25% before text)
        const stop = box.kind === 'label' ? floor : Math.max(floor, 0.85);
        for (let sc = 1 - step; sc >= stop - 1e-9; sc -= step) {
          scale = Math.max(stop, +sc.toFixed(4));
          setScale(box, base, scale);
          res = tryFit(g, g.widthMax, false);
          if (res.ok) { actions.push('widen', 'shrink'); early = true; break; }
        }
        if (!res.ok) { scale = 1; setScale(box, base, 1); }
      }
    }
    if (!res.ok && !early) {
      for (const rung of ladder.slice(1)) {
        setLeadingLevel(rung.level ?? 0);
        res = tryFit(g, g.widthMax, rung.grow);
        if (res.ok) { actions.push(...rung.act); break; }
      }
    }

    // a picture that blocks the box: the cheapest change (over all blocking pictures) with which one of the rungs
    // fits; null when none does (the leading is then as it was)
    const boxPictures: PictureChange[] = [];
    type Hit = { cost: number; res: Fit; rung: Rung; pic: Picture; frame: Rect; g: Geo };
    const tryPictures = (rungs: Rung[]): Hit | null => {
      if (!g.blockers.length) return null;
      const before = box.paragraphs.map((p) => p.leading);
      let best: Hit | null = null;
      for (const p of g.blockers) {
        const { anchor, caption } = anchorOf(p, page);
        for (const c of candidates(p.frame, anchor, { maxShrink: pictureShrink, step: 0.05, canMove: !caption })) {
          if (best && c.cost >= best.cost) break;
          if (!placeOk(p, c.frame)) continue;
          const g2 = geo(obst.map((o) => (o.pic === p ? { r: c.frame, pic: p } : o)));
          let hit = false;
          for (const rung of rungs) {
            setLeading(rung.leading);
            const r = tryFit(g2, g2.widthMax, rung.grow);
            if (r.ok) { best = { cost: c.cost, res: r, rung, pic: p, frame: c.frame, g: g2 }; hit = true; break; }
          }
          if (hit) break;   // the first candidate that fits is this picture's cheapest
        }
      }
      if (best) setLeading(best.rung.leading);
      else box.paragraphs.forEach((p, i) => { p.leading = before[i]; });
      return best;
    };
    const commit = (h: Hit) => {
      cur.set(h.pic, h.frame);
      const m = moveBetween(h.pic.frame, h.frame);
      h.pic.move = m;
      changedFor.set(h.pic, box.id);
      obst = obst.map((o) => (o.pic === h.pic ? { r: h.frame, pic: h.pic } : o));
      g = h.g;
      res = h.res;
      boxPictures.push({ id: h.pic.id, dx: r2(m.dx), dy: r2(m.dy), scale: +m.scale.toFixed(4) });
    };
    if (!res.ok) {
      const h = tryPictures(ladder);
      if (h) { commit(h); actions.push(...h.rung.act, 'picture'); }
    }
    if (!res.ok) {
      actions.splice(0, actions.length, 'widen', 'grow', 'leading', 'shrink');
      setLeading(true);
      for (let s = 1 - step; s >= floor - 1e-9; s -= step) {
        scale = Math.max(floor, +s.toFixed(4));
        setScale(box, base, scale);
        res = tryFit(g, g.widthMax, true);
        if (res.ok) break;
        const h = tryPictures([{ grow: true, leading: true, act: [] }]);
        if (h) { commit(h); actions.splice(3, 0, 'picture'); break; }
      }
    }
    // a box whose word still does not fit its width at the floor shrinks further (labels to 60%, other text to 55%)
    // rather than break the word: a broken word reads worse than slightly smaller text
    if (!res.ok && (res.laid.overflow || brokenWord(res.laid))) {
      for (let s = floor - step; s >= (box.kind === 'label' ? 0.6 : 0.55) - 1e-9; s -= step) {
        scale = +s.toFixed(4);
        setScale(box, base, scale);
        res = tryFit(g, g.widthMax, true);
        if (res.ok || !brokenWord(res.laid)) break;   // stop once no word breaks, even if the box is still unfit
      }
    }
    // undo moves that did not help (keep the smallest change that fits; if unfit, keep the floor and full growth)
    if (res.ok && actions.length === 0) setLeading(false);
    widened = W(res.frame) - W(s0);
    grew = H(res.frame) - H(s0);
    box.frame = res.frame;
    box.paragraphs.forEach((p, i) => { p.align = res.frame.x0 !== s0.x0 && cellIn?.centred && baseAlign[i] === 'left' ? 'center' : baseAlign[i]; });
    done.set(box.id, res.frame);
    let overBy = 0, charsOver = 0;
    if (!res.ok) {
      const avail = s0.y1 - g.bottomFor(W(res.frame));
      overBy = Math.max(0, res.laid.height - Math.max(H(s0), avail));
      const chars = [...textOf(box)].length;
      charsOver = Math.ceil(chars * overBy / Math.max(1, res.laid.height));
    }
    report.push({ box: box.id, result: res.ok ? (actions.length ? 'fixed' : 'fits') : 'unfit', actions, scale, widened: +widened.toFixed(1), grew: +grew.toFixed(1), overBy: +overBy.toFixed(1), charsOver, pictures: boxPictures, ms: +(performance.now() - t1).toFixed(1) });
  }

  // role groups: same source size, width (±2 pt) and row (baseline ±2 pt): all end at the smallest scale among them
  const sizeOf = (b: Box) => b.source.paragraphs[0]?.size ?? 0;
  const groups = new Map<string, Box[]>();
  for (const b of page.boxes) {
    if (!b.edited || b.locked) continue;
    const key = `${sizeOf(b).toFixed(1)}|${Math.round(W(b.source.frame) / 2)}|${Math.round(b.source.frame.y1 / 2)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(b);
  }
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const fits = members.map((b) => report.find((r) => r.box === b.id)!);
    const s = Math.min(...fits.map((f) => f.scale));
    for (const [k, b] of members.entries()) {
      if (fits[k].scale <= s) continue;
      const ratio = s / fits[k].scale;
      b.paragraphs.forEach((p) => p.runs.forEach((r) => { r.size *= ratio; }));
      fits[k].scale = s;
      if (!fits[k].actions.includes('shrink')) fits[k].actions.push('shrink');
      if (fits[k].result === 'fits') fits[k].result = 'fixed';
      const laid = lay(b);
      b.frame = { ...b.frame, y0: b.frame.y1 - Math.max(laid.height, H(b.source.frame)) };
    }
  }
  const pictures: FitReport['pictures'] = pics.filter((p) => p.move).map((p) => ({
    id: p.id, box: changedFor.get(p) ?? '', dx: r2(p.move!.dx), dy: r2(p.move!.dy), scale: +p.move!.scale.toFixed(4),
    from: { ...p.frame }, to: { ...cur.get(p)! },
  }));
  return { page: page.n, boxes: report, pictures, ms: +(performance.now() - t0).toFixed(1) };
}
