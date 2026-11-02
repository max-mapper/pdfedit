// Paragraph layout: shape each run, find break opportunities (UAX #14 from @cto.af/linebreak, then Japanese
// kinsoku on top), fill lines greedily, align, and place baselines.
//
// Typography (horizontal text; each is off unless the paragraph or the options turn it on):
// - indent: a first-line indent (positive) or a hanging indent (negative: the other lines start at −indent).
// - marker: a list marker (bullet, number) drawn in its own style at the start of the first line; the text starts
//   `marker.indent` points after the marker's left edge (at least the marker's width plus 0.15 em) and the other
//   lines start there too (a hanging indent), less any positive `indent` (continuation lines under the marker).
// - hyphenate: Latin words that do not fit at a line end are broken at an en-us hyphenation point (hyphenate.ts:
//   lowercase words only, 3+ characters each side) when the line would otherwise be loose (ragged: more than 15% of
//   the measure left; justified: word gaps over 1.5× a space), and a word wider than the measure is hyphenated
//   before it is cut. Never more than 2 hyphenated lines in a row (a word wider than the measure excepted). The
//   hyphen is a real '-' glyph (text '-') at the line's end.
// - justifyPolicy: a justified Latin paragraph stays justified only when its justified lines average at least
//   `minChars` characters and no word gap exceeds `maxSpace`× a space once justified; otherwise it is set left
//   (Line.alignUsed / Layout.paras say which). Japanese text (a third or more CJK) keeps its inter-character justify.
// - avoidWidow: in a paragraph of 3+ lines whose last line is one word under 10% of the measure, the other lines
//   are re-broken with a slightly shorter measure (down to 82%) until a word comes down, keeping the line count.
// - balance: a 2–3 line paragraph (headings) is broken at the narrowest measure that keeps its line count, so its
//   lines are of similar length; alignment still uses the full measure. Not applied to justified text.
//
// Coordinates: x in points from the box's left edge (alignment included); a glyph's `y` is its offset above the
// baseline (up positive, as in PDF space); a line's `baseline` is its distance below the box top. Line boxes
// follow the CSS inline model: each run on a line contributes `leading × size` split around its ascent and
// descent (half-leading on each side), so a line of one size is exactly `leading × size` tall.
//
// Vertical text (opts.vertical, 縦書き): the same breaker and kinsoku run along columns of length `box.height`,
// stacked from the box's right edge leftwards. Upright glyphs (CJK, and Latin runs of one or two letters or digits)
// are shaped top to bottom (HarfBuzz TTB: the font's `vert` forms and vmtx advances); other Latin runs are shaped
// horizontally and set sideways, rotated 90° clockwise, as one run. Each column is `leading × size` wide with its
// axis in the middle; upright glyphs are centred on the axis, sideways glyphs have their em box centred on it.
// Positions in a vertical layout: each glyph's x, y is its horizontal origin (where its outline is drawn from):
// x from the box's left edge (columns start at x = box.width and go left; pass width 0 for offsets from the right
// edge), y up from the box's top (so negative), with every line's `baseline` 0. Runs carry the view faces
// verticalFace() / sidewaysFace() and `orientation`, which the font writer and emit() act on.

import { Rules } from '@cto.af/linebreak';
import type { Face } from './face.ts';
import { emCenter, sidewaysFace, verticalFace, vMetrics } from './face.ts';
import { shape } from './shape.ts';
import { hyphenPoints } from './hyphenate.ts';
import { isCjkChar, isLatinSpace, isLineBreakChar, isWhitespace, noLineEnd, noLineStart, verticalUpright } from './unicode.ts';
import { mapText } from './textdiff.ts';

export type Align = 'left' | 'center' | 'right' | 'justify';
export type Rgb = [number, number, number];

export type RunIn = { text: string; face: Face; size: number; charSpacing?: number; color?: Rgb };
export type ParaIn = {
  runs: RunIn[]; align?: Align; leading?: number /* × size, default 1.2 */;
  /** First-line indent, points (horizontal text): positive moves the first line right; negative is a hanging
   *  indent (the other lines start at −indent). With a marker: how far the text of the first line starts right of
   *  the continuation lines (0, the default, is the usual hanging list item). */
  indent?: number;
  /** A list marker drawn at the start of the first line in its own run's style (see the header). */
  marker?: { run: RunIn; indent: number };
  /** Hyphenate Latin words at line ends (see the header). Default: LayoutOptions.hyphenate, else false. */
  hyphenate?: boolean;
  /** Keep justify only where it sets well (see the header). Default: LayoutOptions.justifyPolicy, else off. */
  justifyPolicy?: boolean | JustifyPolicy;
  /** Pull a word down onto a one-short-word last line (see the header). Default: LayoutOptions.avoidWidows. */
  avoidWidow?: boolean;
  /** Balance the lines of a 2–3 line paragraph (headings, titles). Default false. */
  balance?: boolean;
};

/** When a justified paragraph stays justified: its justified lines average at least `minChars` characters and no
 *  word gap exceeds `maxSpace` × the font's space after justification. */
export type JustifyPolicy = { minChars: number; maxSpace: number };
export const DEFAULT_JUSTIFY_POLICY: JustifyPolicy = { minChars: 40, maxSpace: 2 };

/** What the layout did with a paragraph (horizontal text). */
export type ParaInfo = {
  alignUsed: Align;        // the alignment the lines were set with (justify may become left: justifyPolicy)
  lines: number;
  hyphenated: number;      // lines ending in an inserted hyphen
  balanced: boolean;       // broken at a narrower measure to balance the lines
  widowFixed: boolean;     // re-broken so the last line is not a single short word
};

export type LayoutOptions = {
  /** Default alignment for paragraphs that set none. */
  align?: Align;
  /** Default leading (× size) for paragraphs that set none; 1.2 if neither does. */
  leading?: number;
  /** Extra space between paragraphs, points. Default 0. */
  paragraphSpacing?: number;
  /** HarfBuzz feature strings passed to shape() (kerning is on by default). */
  features?: string[];
  /** Vertical writing: columns of length box.height, right to left (see the header). */
  vertical?: boolean;
  /** Defaults for the paragraphs' typography switches (ParaIn.hyphenate, justifyPolicy, avoidWidow). */
  hyphenate?: boolean;
  justifyPolicy?: boolean | JustifyPolicy;
  avoidWidows?: boolean;
};

/** `c`: the cluster's offset in the paragraph text (-1: not text, a marker or an inserted hyphen); `p`: the pen position
 *  before the glyph along the line (x without the glyph's offset; vertical: distance down the column). */
export type LineGlyph = { gid: number; x: number; y: number; text: string; c?: number; p?: number };
export type LineRun = {
  face: Face; size: number; color: Rgb; glyphs: LineGlyph[];
  /** Vertical layouts only: upright glyphs (face is verticalFace(run face)) or sideways (sidewaysFace(run face)). */
  orientation?: 'upright' | 'sideways';
};
export type Line = {
  /** Distance of the baseline below the box top; 0 in a vertical layout (glyph y is measured from the top). */
  baseline: number;
  width: number;
  runs: LineRun[];
  /** Line box height (points). */
  height: number;
  /** Index of the paragraph this line belongs to. */
  para: number;
  /** True when the line was broken inside a word because the word is wider than the box. */
  overflow: boolean;
  /** Horizontal text: the alignment the line's paragraph was set with (ParaInfo.alignUsed). */
  alignUsed?: Align;
  /** True when the line ends in an inserted hyphen (its last glyph is a '-' with text '-'). */
  hyphen?: boolean;
  /** Vertical layouts only: x of the column's axis from the box's left edge. In a vertical layout a line is a
   *  column: `width` is its length used and `height` its width (leading × size). */
  axis?: number;
  /** The line's text range in the paragraph [start, end) (trailing spaces and the break included) and the pen
   *  position after its last drawn character (as LineGlyph.p): what caret placement needs. */
  start?: number; end?: number; pEnd?: number;
};
/** `width` and `height` are the text's physical extent: in a vertical layout, width is the column stack and height
 *  the longest column. */
export type Layout = { lines: Line[]; height: number; width: number; overflow: boolean; vertical?: boolean;
  /** Horizontal layouts: per paragraph, what was done with it. */
  paras?: ParaInfo[] };

type Item = {
  run: number;
  gid: number;
  cluster: number;
  clusterStart: boolean;
  cp: number;
  text: string;
  adv: number; // points, charSpacing included
  cs: number;
  dx: number;
  dy: number;
  ws: boolean;
  hidden: boolean;
  /** 'h' horizontal; vertical text: 'u' upright, 's' sideways. dx is along the line (down a column), dy across it
   *  (up, or right of a column's axis), both from the pen to the glyph's horizontal origin. */
  orient: 'h' | 'u' | 's';
  /** An inserted hyphen (not in the text). */
  ins?: boolean;
};

type Chunk = { items: Item[]; forced: boolean };

const EPS = 1e-6;
let rules: Rules | null = null;

/** Lays paragraphs out in a box: lines of `box.width`, or with `opts.vertical`, columns of `box.height`. */
export function layoutParagraphs(paras: ParaIn[], box: { width: number; height?: number }, opts: LayoutOptions = {}): Layout {
  const vertical = !!opts.vertical;
  if (vertical && !(box.height !== undefined && box.height >= 0)) throw new Error('layoutParagraphs: vertical text needs box.height (the column length)');
  const W = vertical ? box.height! : box.width;
  const lines: Line[] = [];
  const infos: ParaInfo[] = [];
  let y = 0;
  let overflow = false;
  paras.forEach((para, pi) => {
    if (pi > 0) y += opts.paragraphSpacing ?? 0;
    const r = vertical ? layoutOne(para, pi, W, opts, y, box.width) : layoutHorizontal(para, pi, W, opts, y);
    lines.push(...r.lines);
    y = r.bottom;
    overflow ||= r.overflow;
    const info = (r as { info?: ParaInfo }).info;
    if (info) infos.push(info);
  });
  const longest = lines.reduce((m, l) => Math.max(m, l.width), 0);
  return vertical ? { lines, height: longest, width: y, overflow, vertical: true } : { lines, height: y, width: longest, overflow, paras: infos };
}

/** One paragraph of horizontal text: break (with the typography switches), align, place baselines. */
function layoutHorizontal(para: ParaIn, pi: number, W: number, opts: LayoutOptions, top: number) {
  const runs = para.runs;
  const align = para.align ?? opts.align ?? 'left';
  const leading = para.leading ?? opts.leading ?? 1.2;
  const P = runs.map((r) => r.text).join('');
  const items = buildItems(runs, P, opts.features, false);
  const chunks = chunksOf(items, P);

  // the marker: its own run (index runs.length), shaped alone
  const marker = para.marker && para.marker.run.text ? para.marker : null;
  const allRuns = marker ? [...runs, marker.run] : runs;
  let markerItems: Item[] = [];
  let markerW = 0;
  if (marker) {
    markerItems = buildItems([marker.run], marker.run.text, opts.features, false)
      .filter((it) => !it.hidden).map((it) => ({ ...it, run: runs.length }));
    markerItems = withoutTrailingWs(markerItems);
    markerW = markerItems.length ? sum(markerItems) - markerItems[markerItems.length - 1].cs : 0;
  }
  // where each line starts (x offset) and its measure
  const indent = para.indent ?? 0;
  let xFirst = 0, xRest = 0;
  if (marker) {
    xFirst = Math.max(marker.indent, markerW + 0.15 * marker.run.size);
    xRest = Math.max(0, xFirst - Math.max(0, indent));
  } else if (indent > 0) xFirst = indent;
  else if (indent < 0) xRest = -indent;
  const cap = Math.max(0, W * 0.6);
  xFirst = Math.min(xFirst, cap);
  xRest = Math.min(xRest, cap);
  const xOff = (li: number) => (li === 0 ? xFirst : xRest);
  const measure = (li: number) => W - xOff(li);

  const hyphenate = para.hyphenate ?? opts.hyphenate ?? false;
  const pol = para.justifyPolicy ?? opts.justifyPolicy ?? false;
  const policy: JustifyPolicy | null = pol === true ? DEFAULT_JUSTIFY_POLICY : pol || null;
  const avoidWidow = para.avoidWidow ?? opts.avoidWidows ?? false;
  const hyphenOf = hyphenItems(runs);
  const run = (scale: (li: number) => number, justify: boolean) =>
    breakLines(chunks, P, { width: (li) => measure(li) * scale(li), hyphenate, justify, hyphenOf });

  let alignUsed: Align = align;
  let br = run(() => 1, align === 'justify');
  if (align === 'justify' && policy && !justifyOk(br.raw, P, measure, policy)) {
    alignUsed = 'left';
    br = run(() => 1, false);
  }
  let balanced = false, widowFixed = false;
  const n = br.raw.length;
  const clean = (b: Broken) => !b.overflow && !b.raw.some((rl) => rl.forced);
  if (para.balance && alignUsed !== 'justify' && (n === 2 || n === 3) && clean(br)) {
    // the narrowest measure that keeps the line count
    let lo = 0.3, hi = 1;
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      const b = run(() => mid, false);
      if (b.raw.length === n && !b.overflow) hi = mid; else lo = mid;
    }
    if (hi < 0.995) {
      const b = run(() => hi, false);
      if (b.raw.length === n && !b.overflow) { br = b; balanced = true; }
    }
  } else if (avoidWidow && n >= 3 && isWidow(br.raw[n - 1], measure(n - 1))) {
    for (let k = 0.97; k >= 0.82 - EPS; k -= 0.03) {
      const b = run((li) => (li < n - 1 ? k : 1), alignUsed === 'justify');
      if (b.raw.length !== n || b.overflow || isWidow(b.raw[n - 1], measure(n - 1))) continue;
      if (alignUsed === 'justify' && policy && !justifyOk(b.raw, P, measure, policy)) continue;
      br = b;
      widowFixed = true;
      break;
    }
  }
  const raw = br.raw;

  const lines: Line[] = [];
  let y = top;
  raw.forEach((rl, li) => {
    const isLast = li === raw.length - 1;
    const Wl = measure(li);
    const visible = withoutTrailingWs(rl.items).filter((it) => !it.hidden);
    const xs: number[] = [];
    let pen = 0;
    for (const it of visible) {
      xs.push(pen);
      pen += it.adv;
    }
    let width = visible.length ? pen - visible[visible.length - 1].cs : 0;
    let offset = 0;
    const avail = Wl - width;
    const lineAlign = rl.overflow ? 'left' : alignUsed;
    if (lineAlign === 'justify' && !isLast && !rl.forced && avail > EPS) {
      const slotAfter = justifySlots(visible);
      const slots = slotAfter.filter(Boolean).length;
      if (slots) {
        const extra = avail / slots;
        let shift = 0;
        for (let i = 0; i < visible.length; i++) {
          xs[i] += shift;
          if (slotAfter[i]) shift += extra;
        }
        width = Wl;
      }
    } else if (lineAlign === 'right') offset = avail;
    else if (lineAlign === 'center') offset = avail / 2;

    // vertical metrics (the marker counts on the first line)
    const runIdx = new Set(visible.map((it) => it.run));
    if (li === 0 && markerItems.length) runIdx.add(runs.length);
    if (!runIdx.size) runIdx.add(Math.min(rl.lastRun, Math.max(0, runs.length - 1)));
    let above = 0;
    let below = 0;
    for (const ri of runIdx) {
      const r = allRuns[ri];
      if (!r) continue;
      const s = r.size / r.face.upem;
      const A = r.face.ascent * s;
      const D = -r.face.descent * s;
      const half = (leading * r.size - (A + D)) / 2;
      above = Math.max(above, half + A);
      below = Math.max(below, half + D);
    }
    const height = above + below;

    const outRuns: LineRun[] = [];
    if (li === 0 && markerItems.length) {
      let mx = offset;
      outRuns.push({
        face: marker!.run.face, size: marker!.run.size, color: marker!.run.color ?? [0, 0, 0],
        glyphs: markerItems.map((it) => { const g = { gid: it.gid, x: mx + it.dx, y: it.dy, text: it.text, c: -1, p: mx }; mx += it.adv; return g; }),
      });
    }
    let prevRun = -1;
    const x0 = xOff(li) + offset;
    visible.forEach((it, i) => {
      if (it.run !== prevRun) {
        const r = runs[it.run];
        outRuns.push({ face: r.face, size: r.size, color: r.color ?? [0, 0, 0], glyphs: [] });
        prevRun = it.run;
      }
      outRuns[outRuns.length - 1].glyphs.push({ gid: it.gid, x: x0 + xs[i] + it.dx, y: it.dy, text: it.text, c: it.ins ? -1 : it.cluster, p: x0 + xs[i] });
    });
    const lastText = visible.reduce((k, it, i) => (it.ins ? k : i), -1);
    const pEnd = lastText >= 0 ? x0 + xs[lastText] + visible[lastText].adv - visible[lastText].cs : x0;
    lines.push({
      baseline: y + above, width, runs: outRuns, height, para: pi, overflow: rl.overflow, alignUsed,
      ...(rl.hyphen ? { hyphen: true } : {}), ...lineRange(raw, li, P.length), pEnd,
    });
    y += height;
  });
  const info: ParaInfo = { alignUsed, lines: raw.length, hyphenated: raw.filter((r) => r.hyphen).length, balanced, widowFixed };
  return { lines, bottom: y, overflow: br.overflow, info };
}

type RawLine = { items: Item[]; forced: boolean; overflow: boolean; lastRun: number; hyphen: boolean };
type Broken = { raw: RawLine[]; overflow: boolean };
type BreakCtx = {
  width: (li: number) => number;
  hyphenate: boolean;
  /** Hyphenation's looseness test: word gaps (justified) or space left over (ragged). */
  justify: boolean;
  hyphenOf: (run: number) => Item | null;
};

/** Greedy line filling over the break chunks, with per-line measures and optional hyphenation. */
function breakLines(chunks: Chunk[], P: string, ctx: BreakCtx): Broken {
  const raw: RawLine[] = [];
  let cur: Item[] = [];
  let curSum = 0;
  let curOver = false;
  let overflow = false;
  let lastRun = 0;
  const flush = (forced: boolean, hyphen = false) => {
    raw.push({ items: cur, forced, overflow: curOver, lastRun, hyphen });
    cur = [];
    curSum = 0;
    curOver = false;
  };
  const add = (its: Item[]) => {
    for (const it of its) {
      cur.push(it);
      curSum += it.adv;
    }
  };
  const widthWith = (tail: Item[]) => curSum + sum(tail) - tail[tail.length - 1].cs;
  const hyphensInARow = () => { let k = 0; for (let i = raw.length - 1; i >= 0 && raw[i].hyphen; i--) k++; return k; };
  const loose = (W: number) => {
    const vis = withoutTrailingWs(cur);
    if (!vis.length) return true;
    const left = W - (sum(vis) - vis[vis.length - 1].cs);
    if (!ctx.justify) return left > 0.15 * W;
    const spaces = vis.filter((it) => it.clusterStart && isLatinSpace(it.cp));
    if (!spaces.length) return left > 0.1 * W;
    return left / spaces.length > 0.5 * spaces[0].adv;
  };
  // the head of a chunk up to a hyphenation point, with a hyphen, that fits in `room`; the rest as a chunk
  const split = (seg: Chunk, body: Item[], room: number): { head: Item[]; tail: Chunk } | null => {
    if (!body.length || body.some((it) => it.orient !== 'h')) return null;
    const start = body[0].cluster;
    const text = body.filter((it) => it.clusterStart).map((it) => it.text).join('');
    const m = /^([^\p{L}\p{N}]*)(\p{L}+)([^\p{L}\p{N}]*)$/u.exec(text);
    if (!m) return null;
    const pts = hyphenPoints(m[2]);
    for (let k = pts.length - 1; k >= 0; k--) {
      const c = start + m[1].length + pts[k];
      const at = body.findIndex((it) => it.cluster >= c);
      if (at <= 0 || body[at].cluster !== c || !body[at].clusterStart) continue;
      const hy = ctx.hyphenOf(body[at - 1].run);
      if (!hy) return null;
      const head = [...body.slice(0, at), { ...hy, cluster: c }];
      if (sum(head) - hy.cs > room + EPS) continue;
      return { head, tail: { items: seg.items.slice(seg.items.indexOf(body[at])), forced: seg.forced } };
    }
    return null;
  };
  const queue = [...chunks];
  for (let si = 0; si < queue.length; si++) {
    const seg = queue[si];
    const body = withoutTrailingWs(seg.items);
    if (seg.items.length) lastRun = seg.items[seg.items.length - 1].run;
    let W = ctx.width(raw.length);
    if (cur.length && body.length && widthWith(body) > W + EPS) {
      if (ctx.hyphenate && hyphensInARow() < 2 && loose(W)) {
        const sp = split(seg, body, W - curSum);
        if (sp) { add(sp.head); flush(false, true); queue.splice(si + 1, 0, sp.tail); continue; }
      }
      flush(false);
      W = ctx.width(raw.length);
    }
    if (!cur.length && body.length && widthWith(body) > W + EPS) {
      // a word wider than the measure: at a hyphenation point if it has one that fits, else cut at clusters
      const sp = ctx.hyphenate ? split(seg, body, W) : null;
      if (sp) { add(sp.head); flush(false, true); queue.splice(si + 1, 0, sp.tail); continue; }
      overflow = true;
      for (const group of clusterGroups(body)) {
        if (cur.length && widthWith(group) > ctx.width(raw.length) + EPS) {
          curOver = true;
          flush(false);
        }
        add(group);
      }
      add(seg.items.slice(body.length));
      curOver = true;
    } else {
      add(seg.items);
    }
    if (seg.forced) flush(true);
  }
  if (cur.length || !raw.length || endsWithLineBreak(P)) flush(false);
  return { raw, overflow };
}

/** Per run, a hyphen glyph item ('-' shaped in the run's face), or null when the face has no hyphen. */
function hyphenItems(runs: RunIn[]): (run: number) => Item | null {
  const memo = new Map<number, Item | null>();
  return (ri) => {
    if (memo.has(ri)) return memo.get(ri)!;
    const r = runs[ri];
    let it: Item | null = null;
    if (r) {
      const g = shape(r.face, '-')[0];
      if (g && g.gid !== 0) {
        const cs = r.charSpacing ?? 0;
        it = { run: ri, gid: g.gid, cluster: 0, clusterStart: true, cp: 0x2d, text: '-', adv: (g.ax * r.size) / r.face.upem + cs, cs,
          dx: (g.dx * r.size) / r.face.upem, dy: (g.dy * r.size) / r.face.upem, ws: false, hidden: false, orient: 'h', ins: true };
      }
    }
    memo.set(ri, it);
    return it;
  };
}

/** Where justification adds space: after a Latin space, or between clusters next to a CJK character. */
function justifySlots(visible: Item[]): boolean[] {
  return visible.map((it, i) => {
    const next = visible[i + 1];
    if (!next || !next.clusterStart) return false;
    return isLatinSpace(it.cp) || isCjkChar(it.cp) || isCjkChar(next.cp);
  });
}

/** The justify policy over broken lines (see the header). */
function justifyOk(raw: RawLine[], P: string, measure: (li: number) => number, policy: JustifyPolicy): boolean {
  let cjk = 0, ink = 0;
  for (const ch of P) {
    const cp = ch.codePointAt(0)!;
    if (isWhitespace(cp)) continue;
    ink++;
    if (isCjkChar(cp)) cjk++;
  }
  if (ink && cjk * 3 >= ink) return true;
  const lines = raw.map((rl, li) => ({ rl, li })).filter(({ rl, li }) => li < raw.length - 1 && !rl.forced && !rl.overflow);
  if (!lines.length) return false;
  let chars = 0;
  for (const { rl } of lines) chars += withoutTrailingWs(rl.items).filter((it) => it.clusterStart && !it.hidden).length;
  if (chars / lines.length < policy.minChars) return false;
  for (const { rl, li } of lines) {
    const visible = withoutTrailingWs(rl.items).filter((it) => !it.hidden);
    if (!visible.length) continue;
    const width = sum(visible) - visible[visible.length - 1].cs;
    const slots = justifySlots(visible);
    const k = slots.filter(Boolean).length;
    const space = visible.find((it) => it.clusterStart && isLatinSpace(it.cp));
    if (!k || !space) continue;
    if ((measure(li) - width) / k > (policy.maxSpace - 1) * space.adv + EPS) return false;
  }
  return true;
}

/** A last line holding one word under 10% of the measure. */
function isWidow(rl: RawLine, measure: number): boolean {
  const visible = withoutTrailingWs(rl.items).filter((it) => !it.hidden);
  if (!visible.length || visible.some((it) => it.ws)) return false;
  const width = sum(visible) - visible[visible.length - 1].cs;
  return width < 0.1 * measure;
}

// ── keep source lines ────────────────────────────────────────────────────────────────────────────────────────
//
// layoutSourceLines sets a horizontal paragraph the way its source set it (src/model/types.ts SourceLines). The
// paragraph's text is mapped to the source text (textdiff.ts). A line whose text is the source line's, unchanged, is
// kept: it breaks where the source broke and each glyph sits at its source character's x. Other lines are filled in
// the source's measure with the source's advances (a character the source had keeps its advance; a new one gets the
// face's advance scaled by the paragraph's source-to-face width ratio), starting where the source line started.
// Which break ends a line: after a kept line, a source break, a paragraph start or a forced break, the first source
// break within reach (a line that got shorter does not pull words up); after a line the breaker had to end itself
// (text pushed down), the first source break that ends a whole source line within reach, which brings the paragraph
// back onto its source lines; otherwise the greedy break. A source line that ended well short of the measure (a
// deliberate break) stays a forced break. Baselines are the caller's (src/model/layout.ts: the source's).
//
// Vertical text (opts.vertical): the same over columns. Positions run down the column (x in SourceParaIn is the
// distance below the box top); each glyph comes out with y = -(its position down the column) and x relative to its
// column's axis (upright and sideways runs as in layoutParagraphs), the caller placing the axes.

/** A paragraph's source lines in box coordinates (x from the box's left edge). */
export type SourceParaIn = {
  text: string; starts: number[]; x: (number | null)[]; adv: (number | null)[]; end: number[]; hard: boolean[];
  hyphen: (number | null)[]; marker?: number[]; rise?: number[];
  align: Align;
  measure: number;         // the right edge reflowed lines fill to
  justifyTo: number;       // where reflowed justified lines end
  firstLeft: number; left: number;   // where reflowed lines start (first line, the others) without a source start
  center: number; rightEdge: number; // reflowed centred lines' centre, right-aligned lines' right edge
  tol: number;             // how far past `keepTo` a kept line may reach
  /** Where a kept line may end (default `measure`): the source's own longest line, moved with the frame's edge. */
  keepTo?: number;
};
export type SourceLine = Line & { start: number; end: number; pEnd: number;
  /** The source line this line starts as (its start is that line's start), or null. */
  src: number | null;
  /** The source line, unchanged, where the source drew it. */
  kept: boolean;
  /** The line box above and below the baseline (CSS model, as layoutParagraphs). */
  above: number; below: number };
export type SourceLayout = { lines: SourceLine[]; overflow: boolean; info: ParaInfo; matched: number };

/** One paragraph on its source lines (see above), or null when too little of its text is the source's (under half). */
export function layoutSourceLines(para: ParaIn, src: SourceParaIn, opts: LayoutOptions = {}): SourceLayout | null {
  const vertical = !!opts.vertical;
  const runs = para.runs;
  const P = runs.map((r) => r.text).join('');
  if (!P.length || !runs.length) return null;
  const map = mapText(src.text, P);
  if (map.matched < 0.5 * P.length) return null;
  const leading = para.leading ?? opts.leading ?? 1.2;
  const items = buildItems(runs, P, opts.features, vertical);
  const segs = chunksOf(items, P);
  const S = src.starts.length;
  const oldEnd = (k: number) => (k + 1 < S ? src.starts[k + 1] : src.text.length);
  const srcLineOf = (o: number) => { let lo = 0, hi = S - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (src.starts[m] <= o) lo = m; else hi = m - 1; } return lo; };

  // clusters, their face advance and their advance here
  type Cl = { start: number; end: number; items: Item[]; face: number; ws: boolean; hidden: boolean; adv: number; srcAdv: number | null };
  const cls: Cl[] = [];
  for (const it of items) {
    const last = cls[cls.length - 1];
    if (it.clusterStart || !last) cls.push({ start: it.cluster, end: P.length, items: [it], face: it.adv, ws: it.ws, hidden: it.hidden, adv: 0, srcAdv: null });
    else { last.items.push(it); last.face += it.adv; }
  }
  for (let i = 0; i + 1 < cls.length; i++) cls[i].end = cls[i + 1].start;
  const clAt = new Int32Array(P.length + 1).fill(-1);
  cls.forEach((c, i) => { clAt[c.start] = i; });
  clAt[P.length] = cls.length;
  for (const c of cls) {
    const o = map.n2o[c.start];
    if (o < 0 || c.hidden) continue;
    let total = 0, ok = true;
    for (let q = c.start; q < c.end && ok; q++) {
      const same = map.n2o[q] === o + (q - c.start);
      const a = same ? src.adv[map.n2o[q]] : null;
      if (!same || (a === null && q === c.start)) ok = false;
      else total += a ?? 0;
    }
    if (!ok) continue;
    // a justified source line's spaces are stretched: a reflowed line uses the natural space
    if (src.align === 'justify' && isLatinSpace(c.items[0].cp) && srcLineOf(o) < S - 1) continue;
    c.srcAdv = total;
  }
  let sumSrc = 0, sumFace = 0;
  for (const c of cls) if (c.srcAdv !== null && !c.ws && c.face > 0) { sumSrc += c.srcAdv; sumFace += c.face; }
  const ratio = sumFace > 0 ? Math.min(1.6, Math.max(0.6, sumSrc / sumFace)) : 1;
  for (const c of cls) c.adv = c.hidden ? 0 : (c.srcAdv ?? c.face * ratio);
  const PX = new Float64Array(cls.length + 1);
  for (let i = 0; i < cls.length; i++) PX[i + 1] = PX[i] + cls[i].adv;
  // LV[i]: the pen after the last drawn (not blank) cluster before cluster i
  const LV = new Float64Array(cls.length + 1);
  for (let i = 0; i < cls.length; i++) LV[i + 1] = cls[i].ws || cls[i].hidden ? LV[i] : PX[i + 1];
  const widthOf = (a: number, b: number) => Math.max(0, LV[clAt[b]] - PX[clAt[a]]);

  // break positions: the breaker's opportunities, and the source's breaks mapped onto this text
  const brk = new Map<number, { forced: boolean; opp: boolean }>();
  for (let i = 1; i < segs.length; i++) {
    const pos = segs[i].items[0]?.cluster;
    if (pos !== undefined && pos > 0 && pos < P.length) brk.set(pos, { forced: segs[i - 1].forced, opp: true });
  }
  type End = { pos: number; k: number; hard: boolean; hyphen: number | null };
  const ends: End[] = [];
  const startNew = new Map<number, number>([[0, 0]]);   // source line → where it starts here
  for (let j = 1; j < S; j++) {
    const e = src.starts[j];
    const before = map.o2n[e - 1] ?? -1, after = map.o2n[e] ?? -1;
    const contiguous = before >= 0 && after === before + 1;
    let q = -1;
    if (contiguous) q = after;
    else if (before >= 0 && after >= 0) q = isWhitespace(src.text.charCodeAt(e - 1)) ? before + 1 : after;
    else if (after >= 0) q = after;
    else if (before >= 0) q = before + 1;
    if (q <= 0 || q >= P.length || clAt[q] < 0) continue;
    if (!contiguous && !brk.has(q)) continue;
    if (ends.length && q <= ends[ends.length - 1].pos) continue;
    ends.push({ pos: q, k: j - 1, hard: src.hard[j - 1], hyphen: src.hyphen[j - 1] });
    startNew.set(j, q);
    const had = brk.get(q);
    brk.set(q, { forced: (had?.forced ?? false) || src.hard[j - 1], opp: had?.opp ?? false });
  }
  const endAt = new Map(ends.map((e) => [e.pos, e]));
  const lineOfStart = new Map<number, number>();
  for (const [j, q] of startNew) lineOfStart.set(q, j);
  const bs = [...brk.keys()].sort((a, b) => a - b);
  bs.push(P.length);

  const greedy = (from: number, avail: number): { b: number; over: boolean } => {
    let best = -1;
    for (const b of bs) {
      if (b <= from) continue;
      const fits = widthOf(from, b) <= avail + EPS;
      if (fits) best = b;
      if (!fits || brk.get(b)?.forced) { if (best < 0) return { b, over: !fits }; break; }
    }
    return best < 0 ? { b: P.length, over: false } : { b: best, over: false };
  };
  const unchanged = (from: number, b: number, j: number) => {
    if (b - from !== oldEnd(j) - src.starts[j]) return false;
    for (let o = from; o < b; o++) if (map.n2o[o] !== src.starts[j] + (o - from)) return false;
    return true;
  };

  const align = para.align ?? src.align;
  const marker = para.marker && para.marker.run.text ? para.marker : null;
  let markerItems: Item[] = [];
  let markerW = 0;
  if (marker) {
    markerItems = withoutTrailingWs(buildItems([marker.run], marker.run.text, opts.features, false).filter((it) => !it.hidden)).map((it) => ({ ...it, run: runs.length }));
    markerW = markerItems.length ? sum(markerItems) - markerItems[markerItems.length - 1].cs : 0;
  }
  const allRuns = marker ? [...runs, marker.run] : runs;
  const hyphenOf = hyphenItems(runs);
  const lines: SourceLine[] = [];
  let s = 0;
  let kind: 'start' | 'source' | 'forced' | 'greedy' = 'start';
  let overflow = false, hyphenated = 0;
  for (let guard = 0; guard <= P.length + 1; guard++) {
    const li = lines.length;
    // the end: done, unless the text ends in a line break (an empty last line)
    if (s >= P.length && (li > 0 && !(endsWithLineBreak(P) && !lines.some((l) => l.start === P.length)))) break;
    const j = s === 0 ? 0 : lineOfStart.get(s) ?? null;
    const srcStartX = j !== null ? src.x[src.starts[j]] : null;
    const leftX = srcStartX ?? (li === 0 ? src.firstLeft : src.left);
    const avail = align === 'left' || align === 'justify' ? (align === 'justify' ? src.justifyTo : src.measure) - leftX : src.measure - Math.min(src.left, src.firstLeft);
    let b: number, over = false, kept = false;
    if (s >= P.length) b = P.length;
    else {
      const jEnd = j !== null ? (j + 1 < S ? startNew.get(j + 1) ?? -1 : P.length) : -1;
      if (j !== null && jEnd > s && unchanged(s, jEnd, j) && src.end[j] <= (src.keepTo ?? src.measure) + src.tol) { b = jEnd; kept = true; }
      else {
        const g = greedy(s, avail);
        b = g.b; over = g.over;
        const cands = ends.filter((e) => e.pos > s && e.pos <= b);
        const pick = kind === 'greedy' ? cands.filter((e) => (startNew.get(e.k) ?? -1) >= s) : cands;
        if (pick.length) { b = pick[0].pos; over = false; }
      }
    }
    const endInfo = endAt.get(b);
    kind = brk.get(b)?.forced ? 'forced' : endInfo ? 'source' : 'greedy';
    overflow ||= over;
    // the drawn clusters of [s, b)
    const c0 = clAt[s], c1 = clAt[b];
    let cEnd = c1;
    while (cEnd > c0 && (cls[cEnd - 1].ws || cls[cEnd - 1].hidden)) cEnd--;
    const xs: number[] = [];
    let pen = leftX, pEnd: number;
    if (kept) {
      for (let i = c0; i < cEnd; i++) {
        const x = src.x[map.n2o[cls[i].start]];
        xs.push(x ?? (i > c0 ? xs[xs.length - 1] + cls[i - 1].adv : leftX));
      }
      pEnd = src.end[j!];
    } else {
      for (let i = c0; i < cEnd; i++) { xs.push(pen); pen += cls[i].adv; }
      const width = pen - leftX;
      const last = b >= P.length;
      let shiftX = 0;
      if (align === 'center') shiftX = src.center - width / 2 - leftX;
      else if (align === 'right') shiftX = src.rightEdge - width - leftX;
      for (let i = 0; i < xs.length; i++) xs[i] += shiftX;
      pEnd = pen + shiftX;
      if (align === 'justify' && !last && kind !== 'forced' && !over) {
        const room = src.justifyTo - (leftX + width);
        const slot = (i: number) => i + 1 < cEnd && (isLatinSpace(cls[i].items[0].cp) || isCjkChar(cls[i].items[0].cp) || isCjkChar(cls[i + 1].items[0].cp));
        let slots = 0;
        for (let i = c0; i < cEnd; i++) if (slot(i)) slots++;
        if (room > EPS && slots) {
          const extra = room / slots;
          let add = 0;
          for (let i = c0; i < cEnd; i++) { xs[i - c0] += add; if (slot(i)) add += extra; }
          pEnd += add;
        }
      }
    }
    // glyphs: the marker first (first line), then the text, then a hyphen where the source broke a word
    const outRuns: LineRun[] = [];
    if (li === 0 && markerItems.length) {
      const xFirst = Math.max(marker!.indent, markerW + 0.15 * marker!.run.size);
      let mx = leftX - xFirst;
      outRuns.push({ face: marker!.run.face, size: marker!.run.size, color: marker!.run.color ?? [0, 0, 0],
        glyphs: markerItems.map((it) => { const at = src.marker?.[it.cluster] ?? mx; const g = { gid: it.gid, x: at + it.dx, y: it.dy, text: it.text, c: -1, p: at }; mx = at + it.adv; return g; }) });
    }
    let prevKey = '';
    const used = new Set<number>(li === 0 && markerItems.length ? [runs.length] : []);
    for (let i = c0; i < cEnd; i++) {
      const c = cls[i];
      let off = 0;
      for (const it of c.items) {
        if (it.hidden) continue;
        const key = `${it.run}${it.orient}`;
        if (key !== prevKey) {
          const r = runs[it.run];
          const face = it.orient === 'u' ? verticalFace(r.face) : it.orient === 's' ? sidewaysFace(r.face) : r.face;
          outRuns.push({ face, size: r.size, color: r.color ?? [0, 0, 0], glyphs: [],
            ...(it.orient === 'h' ? {} : { orientation: it.orient === 'u' ? 'upright' as const : 'sideways' as const }) });
          prevKey = key;
        }
        used.add(it.run);
        const x = xs[i - c0] + off;
        const o = map.n2o[c.start];
        const rise = o >= 0 ? src.rise?.[o] ?? 0 : 0;
        outRuns[outRuns.length - 1].glyphs.push(vertical
          ? { gid: it.gid, x: it.dy, y: -(x + it.dx), text: it.text, c: it.cluster, p: x }
          : { gid: it.gid, x: x + it.dx, y: it.dy + rise, text: it.text, c: it.cluster, p: x });
        off += c.items.length > 1 ? it.adv * (c.adv / (c.face || 1)) : 0;
      }
    }
    let hyphen = false;
    if (endInfo && endInfo.hyphen !== null && !brk.get(b)?.opp && cEnd > c0) {
      const hy = hyphenOf(cls[cEnd - 1].items[0].run);
      if (hy) {
        const hx = kept ? endInfo.hyphen : pEnd;
        const r = runs[hy.run];
        const lastRun = outRuns[outRuns.length - 1];
        const g = { gid: hy.gid, x: hx + hy.dx, y: hy.dy, text: '-', c: -1, p: hx };
        if (lastRun && lastRun.face === r.face && lastRun.size === r.size) lastRun.glyphs.push(g);
        else outRuns.push({ face: r.face, size: r.size, color: r.color ?? [0, 0, 0], glyphs: [g] });
        hyphen = true;
        hyphenated++;
      }
    }
    // the line box (CSS model, as layoutHorizontal); an empty line takes the run before it
    if (!used.size) used.add(Math.max(0, Math.min(runs.length - 1, cls[Math.max(0, Math.min(c1, cls.length) - 1)]?.items[0].run ?? 0)));
    let above = 0, below = 0;
    for (const ri of used) {
      const r = allRuns[ri];
      if (!r) continue;
      if (vertical) { above = Math.max(above, (leading * r.size) / 2); below = above; continue; }   // a column: the axis in its middle
      const sc = r.size / r.face.upem;
      const A = r.face.ascent * sc, D = -r.face.descent * sc;
      const half = (leading * r.size - (A + D)) / 2;
      above = Math.max(above, half + A);
      below = Math.max(below, half + D);
    }
    const width = xs.length ? Math.max(0, pEnd - xs[0]) : 0;
    lines.push({ baseline: above, width, runs: outRuns, height: above + below, para: 0, overflow: over, alignUsed: align,
      ...(hyphen ? { hyphen: true } : {}), start: s, end: b, pEnd, src: j, kept, above, below });
    if (b <= s) break;
    s = b;
  }
  const info: ParaInfo = { alignUsed: align, lines: lines.length, hyphenated, balanced: false, widowFixed: false };
  return { lines, overflow, info, matched: map.matched };
}

/** `right`: null for horizontal text; for vertical text, x of the box's right edge (columns go left from it). */
function layoutOne(para: ParaIn, pi: number, W: number, opts: LayoutOptions, top: number, right: number | null) {
  const vertical = right !== null;
  const runs = para.runs;
  const align = para.align ?? opts.align ?? 'left';
  const leading = para.leading ?? opts.leading ?? 1.2;
  const P = runs.map((r) => r.text).join('');
  const items = buildItems(runs, P, opts.features, vertical);
  const chunks = chunksOf(items, P);

  type RawLine = { items: Item[]; forced: boolean; overflow: boolean; lastRun: number };
  const raw: RawLine[] = [];
  let cur: Item[] = [];
  let curSum = 0; // sum of advances in `cur`
  let curOver = false;
  let overflow = false;
  let lastRun = 0;
  const flush = (forced: boolean) => {
    raw.push({ items: cur, forced, overflow: curOver, lastRun });
    cur = [];
    curSum = 0;
    curOver = false;
  };
  const add = (items: Item[]) => {
    for (const it of items) {
      cur.push(it);
      curSum += it.adv;
    }
  };
  // width of `cur` followed by `tail` (non-empty, no trailing whitespace): its last glyph's charSpacing excluded
  const widthWith = (tail: Item[]) => curSum + sum(tail) - tail[tail.length - 1].cs;

  for (const seg of chunks) {
    const body = withoutTrailingWs(seg.items);
    if (seg.items.length) lastRun = seg.items[seg.items.length - 1].run;
    if (cur.length && body.length && widthWith(body) > W + EPS) flush(false);
    if (!cur.length && body.length && widthWith(body) > W + EPS) {
      // A word wider than the box: break it at cluster boundaries and flag its lines.
      overflow = true;
      for (const group of clusterGroups(body)) {
        if (cur.length && widthWith(group) > W + EPS) {
          curOver = true;
          flush(false);
        }
        add(group);
      }
      add(seg.items.slice(body.length));
      curOver = true;
    } else {
      add(seg.items);
    }
    if (seg.forced) flush(true);
  }
  // the last line; a paragraph ending in a line break gets an empty line after it
  if (cur.length || !raw.length || endsWithLineBreak(P)) flush(false);

  const lines: Line[] = [];
  let y = top;
  raw.forEach((rl, li) => {
    const isLast = li === raw.length - 1;
    const visible = withoutTrailingWs(rl.items).filter((it) => !it.hidden);
    // positions
    const xs: number[] = [];
    let pen = 0;
    for (const it of visible) {
      xs.push(pen);
      pen += it.adv;
    }
    let width = visible.length ? pen - visible[visible.length - 1].cs : 0;
    let offset = 0;
    const avail = W - width;
    const lineAlign = rl.overflow ? 'left' : align;
    if (lineAlign === 'justify' && !isLast && !rl.forced && avail > EPS) {
      const slotAfter: boolean[] = visible.map((it, i) => {
        const next = visible[i + 1];
        if (!next || !next.clusterStart) return false;
        return isLatinSpace(it.cp) || isCjkChar(it.cp) || isCjkChar(next.cp);
      });
      const slots = slotAfter.filter(Boolean).length;
      if (slots) {
        const extra = avail / slots;
        let shift = 0;
        for (let i = 0; i < visible.length; i++) {
          xs[i] += shift;
          if (slotAfter[i]) shift += extra;
        }
        width = W;
      }
    } else if (lineAlign === 'right') offset = avail;
    else if (lineAlign === 'center') offset = avail / 2;

    // vertical metrics
    const runIdx = new Set(visible.map((it) => it.run));
    if (!runIdx.size) runIdx.add(Math.min(rl.lastRun, Math.max(0, runs.length - 1)));
    let above = 0;
    let below = 0;
    for (const ri of runIdx) {
      const run = runs[ri];
      if (!run) continue;
      const s = run.size / run.face.upem;
      if (vertical) {
        // a column: leading × size wide, the axis in the middle
        above = Math.max(above, (leading * run.size) / 2);
        below = above;
        continue;
      }
      const A = run.face.ascent * s;
      const D = -run.face.descent * s;
      const half = (leading * run.size - (A + D)) / 2;
      above = Math.max(above, half + A);
      below = Math.max(below, half + D);
    }
    const height = above + below;

    const outRuns: LineRun[] = [];
    let prevKey = '';
    const axis = vertical ? right - (y + above) : 0;
    visible.forEach((it, i) => {
      const key = `${it.run}${it.orient}`;
      if (key !== prevKey) {
        const run = runs[it.run];
        const face = it.orient === 'u' ? verticalFace(run.face) : it.orient === 's' ? sidewaysFace(run.face) : run.face;
        outRuns.push({
          face, size: run.size, color: run.color ?? [0, 0, 0], glyphs: [],
          ...(it.orient === 'h' ? {} : { orientation: it.orient === 'u' ? 'upright' as const : 'sideways' as const }),
        });
        prevKey = key;
      }
      const along = offset + xs[i] + it.dx;
      outRuns[outRuns.length - 1].glyphs.push(vertical
        ? { gid: it.gid, x: axis + it.dy, y: -along, text: it.text, c: it.cluster, p: offset + xs[i] }
        : { gid: it.gid, x: along, y: it.dy, text: it.text, c: it.cluster, p: offset + xs[i] });
    });
    const last = visible.length - 1;
    const range = { ...lineRange(raw, li, P.length), pEnd: last >= 0 ? offset + xs[last] + visible[last].adv - visible[last].cs : offset };
    lines.push(vertical
      ? { baseline: 0, width, runs: outRuns, height, para: pi, overflow: rl.overflow, axis, ...range }
      : { baseline: y + above, width, runs: outRuns, height, para: pi, overflow: rl.overflow, ...range });
    y += height;
  });
  return { lines, bottom: y, overflow };
}

/** A raw line's text range: from its first item to the next line's first item (the paragraph's end for the last). */
function lineRange(raw: { items: Item[] }[], li: number, len: number): { start: number; end: number } {
  const first = (k: number): number | null => { const it = raw[k]?.items.find((x) => !x.ins); return it ? it.cluster : null; };
  const start = first(li) ?? len;      // a line without items is the empty one after a final line break
  let end = len;
  for (let k = li + 1; k < raw.length; k++) { const f = first(k); if (f !== null) { end = f; break; } }
  return { start: Math.min(start, end), end };
}

function endsWithLineBreak(P: string): boolean {
  return P.length > 0 && isLineBreakChar(P.charCodeAt(P.length - 1));
}

/** Shape every run and flatten to items in logical order, clusters as indices into the paragraph text. In vertical
 *  text each run is cut where the orientation changes (verticalUpright over the whole paragraph, so a Latin word
 *  split across two styled runs is still one sideways run) and each piece is shaped in its direction. */
function buildItems(runs: RunIn[], P: string, features: string[] | undefined, vertical = false): Item[] {
  const items: Item[] = [];
  const upright = vertical ? verticalUpright(P) : null;
  let base = 0;
  let prev = -1;
  runs.forEach((run, ri) => {
    const face = run.face;
    const s = run.size / face.upem;
    const cs = run.charSpacing ?? 0;
    prev = -1;
    // pieces of one orientation
    const pieces: { start: number; end: number; orient: Item['orient'] }[] = [];
    if (!upright) pieces.push({ start: 0, end: run.text.length, orient: 'h' });
    else {
      for (let i = 0; i < run.text.length; i++) {
        const o = upright[base + i] ? 'u' : 's';
        const last = pieces[pieces.length - 1];
        if (last && last.orient === o) last.end = i + 1;
        else pieces.push({ start: i, end: i + 1, orient: o });
      }
    }
    for (const pc of pieces) {
      const glyphs = shape(face, run.text.slice(pc.start, pc.end), { features, direction: pc.orient === 'u' ? 'ttb' : 'ltr' });
      const mid = pc.orient === 's' ? emCenter(face) : 0;
      for (const g of glyphs) {
        const cluster = base + pc.start + g.cluster;
        const cp = P.codePointAt(cluster) ?? 0;
        const hidden = isLineBreakChar(cp);
        let adv: number, dx: number, dy: number;
        if (pc.orient === 'u') {
          // HarfBuzz offsets are from its own vertical origin (h_advance / 2, its v origin); what is left after
          // taking those out is GPOS positioning, kept on top of our origin (vMetrics: the one /W2 states)
          const vm = vMetrics(face, g.gid);
          const hbOriginY = face.hbFont.glyphVOrigin(g.gid)?.[1] ?? face.ascent;
          // (HarfBuzz rounds its offsets to whole units: a residue of a unit or less is that rounding)
          const resX = snap(g.dx + face.advance(g.gid) / 2);
          const resY = snap(g.dy + hbOriginY);
          adv = -g.ay * s;
          dx = (vm.vy - resY) * s;
          dy = (resX - vm.vx) * s;
        } else {
          adv = g.ax * s;
          dx = g.dx * s;
          dy = (g.dy - mid) * s;
        }
        items.push({
          run: ri,
          gid: g.gid,
          cluster,
          clusterStart: cluster !== prev,
          cp,
          text: '',
          adv: hidden ? 0 : adv + cs,
          cs: hidden ? 0 : cs,
          dx,
          dy,
          ws: isWhitespace(cp),
          hidden,
          orient: pc.orient,
        });
        prev = cluster;
      }
    }
    base += run.text.length;
  });
  // cluster text: from the cluster start to the next cluster's start
  let next = P.length;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.clusterStart) {
      it.text = P.slice(it.cluster, next);
      next = it.cluster;
    }
  }
  return items;
}

/** Break opportunities, kinsoku-filtered and restricted to cluster boundaries; items cut into chunks. */
function chunksOf(items: Item[], P: string): Chunk[] {
  rules ??= new Rules();
  const boundaries = new Set(items.filter((it) => it.clusterStart).map((it) => it.cluster));
  const breaks: { pos: number; required: boolean }[] = [];
  for (const b of rules.breaks(P)) {
    const pos = b.position;
    if (pos >= P.length) continue;
    if (!boundaries.has(pos)) continue;
    if (!b.required) {
      const next = P.codePointAt(pos)!;
      const prev = prevNonSpace(P, pos);
      if (noLineStart(next) || (prev >= 0 && noLineEnd(prev))) continue;
    }
    breaks.push({ pos, required: b.required });
  }
  const segs: Chunk[] = [];
  let bi = 0;
  let cur: Item[] = [];
  for (const it of items) {
    while (bi < breaks.length && it.cluster >= breaks[bi].pos) {
      if (cur.length || breaks[bi].required) segs.push({ items: cur, forced: breaks[bi].required });
      cur = [];
      bi++;
    }
    cur.push(it);
  }
  if (cur.length) segs.push({ items: cur, forced: endsWithLineBreak(P) });
  return segs;
}

/** The last non-whitespace code point before `pos`, or -1. */
function prevNonSpace(P: string, pos: number): number {
  let j = pos;
  while (j > 0) {
    const lo = P.charCodeAt(j - 1);
    const n = lo >= 0xdc00 && lo <= 0xdfff && j >= 2 ? 2 : 1;
    const cp = P.codePointAt(j - n)!;
    if (!isWhitespace(cp)) return cp;
    j -= n;
  }
  return -1;
}

function withoutTrailingWs(items: Item[]): Item[] {
  let n = items.length;
  while (n > 0 && (items[n - 1].ws || items[n - 1].hidden)) n--;
  return n === items.length ? items : items.slice(0, n);
}

const snap = (n: number) => (Math.abs(n) <= 1 ? 0 : n);

function sum(items: Item[]): number {
  let w = 0;
  for (const it of items) w += it.adv;
  return w;
}

function clusterGroups(items: Item[]): Item[][] {
  const groups: Item[][] = [];
  for (const it of items) {
    if (it.clusterStart || !groups.length) groups.push([it]);
    else groups[groups.length - 1].push(it);
  }
  return groups;
}
