// A box's paragraphs laid out in its frame (src/text layoutParagraphs), mapped to PDF space: what the live preview
// draws and export writes.
//
// Vertical placement: the first baseline sits where the source's did (SourceState.baseline below the frame's top,
// scaled by the size change); a box with no source baseline (a split-off part) starts its first line box at the
// frame's top, so the parts of a split keep the line rhythm. Later lines follow
// the layout's line boxes (CSS model: leading × size per line), with each paragraph's spaceBefore / spaceAfter.
// The text's height runs from the frame's top to the bottom of the last line box. The frame's height follows the
// text unless the box's height is pinned; then a taller text is an overflow, as is a word wider than the box.
//
// Vertical boxes (Box.vertical, writingMode 'vertical-rl'): src/text lays each paragraph out in columns of the
// frame's height, stacked right to left from the frame's right edge. The first column's axis sits where the source's
// did (SourceState.axis left of the frame's right edge, scaled by the size change); paragraphs follow each other
// leftwards with their spaceBefore / spaceAfter. The frame's height stays (it is the column length: growing the
// frame down makes the columns longer); its width follows the column stack, leftwards from the right edge, unless the
// box's height is pinned (then a wider stack is an overflow, as is a word longer than a column).
//
// Horizontal typography (src/text layoutParagraphs switches): a paragraph starts Paragraph.leftIndent points right
// of the frame's left edge; Paragraph.indent is a first-line (positive) or hanging (negative) indent; a bullet is
// drawn in its own style (bulletStyle, else the dominant run's) at the paragraph's start, the text starting
// bulletIndent points after it and the continuation lines hanging under the text. Latin text is hyphenated (not in
// headings), justify is kept only where it sets well (40+ characters a line, word gaps up to 2× a space; otherwise
// left), a one-short-word last line is avoided, and headings (short paragraphs in bold or large type) are balanced.
// LaidBox.paragraphs and each line's alignUsed / hyphen say what was done.
//
// Keep source lines (the focus layout): a paragraph still in the style its source set it in (Paragraph.src, recorded by
// src/model/build.ts) is set by src/text layoutSourceLines: while its text is unchanged every line breaks where the
// source broke and every glyph sits at its source character's x on the source baseline, and the frame stays the
// source's, so selecting a box changes nothing but the face the glyphs are drawn in; once it is edited, lines whose
// text is unchanged stay where they were and the rest reflow in the source's measure with the source's advances (see
// layoutKeep and layoutKeepVertical). A size, leading, alignment, indent, font or spacing change (Editor.setStyle)
// leaves the source lines and the paragraph flows as described above.
//
// Every line carries its text range (start, end), its pen end (pEnd) and each glyph its cluster offset (c) and pen
// position (p): src/model/caret.ts places the caret and hit-tests clicks on them.
//
// Not yet laid out: italic (no italic face ships).
import type { Face } from '../text/face.ts';
import { baseFace } from '../text/face.ts';
import { layoutParagraphs, layoutSourceLines } from '../text/layout.ts';
import type { Layout, Line as TextLine, RunIn, SourceLayout, SourceParaIn } from '../text/layout.ts';
import type { FontRegistry } from './fonts.ts';
import type { Box, FontRef, LaidBox, Paragraph, Rect, RGB } from './types.ts';
import type { ParaIn } from '../text/layout.ts';
import { dominantRun } from './style.ts';

const EPS = 0.01;

export function layoutBox(box: Box, fonts: FontRegistry): LaidBox {
  if (box.vertical) return layoutVertical(box, fonts);
  if (box.paragraphs.some((p) => keepable(p) && !p.src!.vertical)) {
    const kept = layoutKeep(box, fonts);
    if (kept) return kept;
  }
  const frame = box.frame;
  const W = Math.max(1, frame.x1 - frame.x0);
  const fontOf = new Map<Face, FontRef>();
  type Ln = { depth: number; runs: LaidBox['lines'][number]['runs']; para: number; alignUsed?: LaidBox['lines'][number]['alignUsed']; hyphen?: boolean;
    start?: number; end?: number; pEnd?: number };
  const out: Ln[] = [];
  const infos: NonNullable<LaidBox['paragraphs']> = [];
  let y = 0;
  let overflow = false;
  const smallest = smallestSize(box);
  box.paragraphs.forEach((p, pi) => {
    if (pi > 0) y += p.spaceBefore;
    const r = layoutFlowPara(p, W, smallest, fonts, fontOf);
    if (!r) return;
    const { L, left } = r;
    overflow ||= L.overflow;
    const info = L.paras?.[0];
    if (info) infos.push({ ...info });
    for (const line of L.lines) out.push({ depth: y + line.baseline, para: pi, ...laidLineOf(line, left, fontOf) });
    y += L.height + p.spaceAfter;
  });
  const b0 = out.length ? out[0].depth : 0;
  // where the first baseline goes, below the frame's top
  const d0 = firstDepth(box, b0);
  const shift = d0 - b0;              // layout depth → depth below the frame's top
  const height = Math.max(0, shift + y);
  const pinned = box.heightPinned;
  const frameH = frame.y1 - frame.y0;
  if (pinned && height > frameH + EPS) overflow = true;
  const used: Rect = pinned ? { ...frame } : { x0: frame.x0, x1: frame.x1, y1: frame.y1, y0: frame.y1 - height };
  return {
    box: box.id, frame: used, height, overflow,
    lines: out.map(({ depth, ...l }) => ({ ...l, baseline: frame.y1 - shift - depth, x: frame.x0 })),
    textTop: frame.y1 - shift,
    paragraphs: infos,
  };
}

/** The smallest dominant size among the box's paragraphs (what isHeading compares with). */
function smallestSize(box: Box): number {
  const sizes = box.paragraphs.map((p) => dominantRun(p.runs)?.size ?? 0).filter((x) => x > 0);
  return sizes.length ? Math.min(...sizes) : 0;
}

/** Depth below the frame's top of the first baseline: where the source's was (scaled by the size change), else
 *  where the layout put it. */
function firstDepth(box: Box, laid: number): number {
  const src = box.source;
  const firstSize = box.paragraphs[0]?.runs[0]?.size;
  if (src.baseline !== undefined && src.baseline > 0 && firstSize && src.paragraphs[0]?.size) return src.baseline * (firstSize / src.paragraphs[0].size);
  return laid;
}

/** One paragraph in the flowing layout (src/text layoutParagraphs with the editor's typography), or null when it has
 *  no runs. `left`: the paragraph's left indent, added to its glyphs' x. */
function layoutFlowPara(p: Paragraph, W: number, smallest: number, fonts: FontRegistry, fontOf: Map<Face, FontRef>): { L: Layout; left: number } | null {
  const runs: RunIn[] = p.runs.map((r) => {
    const { face, font } = fonts.resolve(r);
    fontOf.set(face, font);
    return { text: r.text, face, size: r.size, charSpacing: r.charSpacing, color: r.color };
  });
  if (!runs.length) return null;
  const left = Math.max(0, Math.min(p.leftIndent ?? 0, W / 2));
  const heading = isHeading(p, smallest);
  const para: ParaIn = {
    runs, align: p.align, leading: p.leading, indent: p.indent,
    // hyphenate only justified text on a wide measure (book and report body text); slides, labels and narrow
    // columns break at spaces (hyphens there read as broken words)
    hyphenate: !heading && p.align === 'justify' && W - left >= 30 * (p.runs[0]?.size ?? 10), justifyPolicy: true, avoidWidow: true, balance: heading,
  };
  const marker = markerOf(p, fonts, fontOf);
  if (marker) para.marker = marker;
  return { L: layoutParagraphs([para], { width: Math.max(1, W - left) }), left };
}

/** A src/text line as a LaidBox line's content (glyph x, pen positions shifted by `left`). */
function laidLineOf(line: TextLine, left: number, fontOf: Map<Face, FontRef>) {
  return {
    runs: line.runs.map((r) => ({
      font: fontOf.get(r.face)!, size: r.size, color: [r.color[0], r.color[1], r.color[2]] as RGB,
      glyphs: r.glyphs.map((g) => ({ gid: g.gid, x: g.x + left, y: g.y, text: g.text, ...(g.c !== undefined ? { c: g.c } : {}), ...(g.p !== undefined ? { p: g.p + left } : {}) })),
      face: r.face,
    })),
    ...(line.alignUsed ? { alignUsed: line.alignUsed } : {}), ...(line.hyphen ? { hyphen: true } : {}),
    ...(line.start !== undefined ? { start: line.start, end: line.end } : {}), ...(line.pEnd !== undefined ? { pEnd: line.pEnd + left } : {}),
  };
}

/** Whether a paragraph can be set on its source lines: it has them and is still in the style they were set in. */
export function keepable(p: Paragraph): boolean {
  const s = p.src;
  if (!s || !s.starts.length) return false;
  const d = dominantRun(p.runs);
  if (!d) return false;
  return Math.abs(d.size - s.size) < 0.01 && Math.abs(p.leading - s.leading) < 1e-3 && p.align === s.align && Math.abs(p.indent - s.indent) < 0.01;
}

/** A paragraph's source lines in the box's coordinates (src/text SourceParaIn): x from the frame's left edge, the
 *  right edges following the frame's right edge when it was resized. */
function sourceParaIn(box: Box, p: Paragraph): SourceParaIn {
  const s = p.src!;
  // horizontal: x from the frame's left edge, the measure its width; vertical: positions down the column from the
  // frame's top (SourceLines.x is -y there), the measure the column length
  const ox = s.vertical ? -box.source.frame.y1 : box.source.frame.x0;
  const W = s.vertical ? box.frame.y1 - box.frame.y0 : box.frame.x1 - box.frame.x0;
  const dW = W - (s.vertical ? box.source.frame.y1 - box.source.frame.y0 : box.source.frame.x1 - box.source.frame.x0);
  const rel = (v: number | null) => (v === null ? null : v - ox);
  const startX = s.starts.map((o, k) => rel(s.x[o]) ?? rel(s.end[k])!);
  const ends = s.end.map((e) => e - ox);
  const med = (xs: number[]) => { const t = [...xs].sort((a, b) => a - b); return t.length ? t[t.length >> 1] : 0; };
  const firstLeft = startX[0];
  const left = startX.length > 1 ? med(startX.slice(1)) : firstLeft - Math.max(0, s.indent);
  const justifyTo = Math.max(...ends) + dW;
  return {
    text: s.text, starts: s.starts, x: s.x.map(rel), adv: s.adv, end: ends, hard: s.hard, hyphen: s.hyphen.map(rel),
    ...(s.marker ? { marker: s.marker.map((m) => m - ox) } : {}), ...(s.rise ? { rise: s.rise } : {}),
    align: s.align,
    measure: s.align === 'justify' ? justifyTo : W,
    justifyTo,
    firstLeft, left,
    center: med(startX.map((x, k) => (x + ends[k]) / 2)) + dW / 2,
    rightEdge: med(ends) + dW,
    tol: Math.max(1, 0.15 * s.size),
    keepTo: Math.max(s.align === 'justify' ? justifyTo : W, Math.max(...ends) + dW),
  };
}

/**
 * The keep-source-lines layout (a box with a paragraph still in its source style): such paragraphs are set by src/text
 * layoutSourceLines (unchanged lines where the source drew them), the others flow as in layoutBox. Baselines: a line
 * that starts as a source line and follows the line that preceded it in the source keeps the source's distance to it
 * (the box's first line: its source baseline); other lines follow the flow (the paragraph's source line pitch, or the
 * line boxes and paragraph spacing at a paragraph start). The frame's bottom stays the source's when the last line is
 * the source's last. Null when no paragraph could be set on its source lines.
 */
function layoutKeep(box: Box, fonts: FontRegistry): LaidBox | null {
  const frame = box.frame;
  const W = Math.max(1, frame.x1 - frame.x0);
  const fontOf = new Map<Face, FontRef>();
  const smallest = smallestSize(box);
  const srcTop = box.source.frame.y1;
  type Anchor = { id: number; prev: number; base: number };
  type Ln = LaidBox['lines'][number] & { depth: number; above: number };
  const out: Ln[] = [];
  const infos: NonNullable<LaidBox['paragraphs']> = [];
  let overflow = false, any = false;
  let prev: { d: number; below: number; anchor: Anchor | null } | null = null;
  let paraBottom = 0, lastPad: number | null = null, lastSpaceAfter = 0, bottom = 0;
  // the source's lowest baseline in the box: a kept line there keeps the source frame's bottom
  const lowest = Math.min(...box.paragraphs.flatMap((p) => (p.src && !p.src.vertical ? p.src.base : [])));
  box.paragraphs.forEach((p, pi) => {
    const spaceBefore = pi > 0 ? p.spaceBefore : 0;
    let R: SourceLayout | null = null;
    if (keepable(p) && !p.src!.vertical) {
      const runs: RunIn[] = p.runs.map((r) => {
        const { face, font } = fonts.resolve(r);
        fontOf.set(face, font);
        return { text: r.text, face, size: r.size, charSpacing: r.charSpacing, color: r.color };
      });
      const para: ParaIn = { runs, align: p.align, leading: p.leading, indent: p.indent };
      const marker = markerOf(p, fonts, fontOf);
      if (marker) para.marker = marker;
      R = layoutSourceLines(para, sourceParaIn(box, p));
    }
    if (R) {
      any = true;
      const s = p.src!;
      const size = s.size;
      const steps = s.base.slice(1).map((b, k) => s.base[k] - b).filter((x) => x > 0).sort((a, b) => a - b);
      const step = steps.length ? steps[steps.length >> 1] : p.leading * size;
      overflow ||= R.overflow;
      infos.push({ ...R.info });
      lastPad = null;
      R.lines.forEach((line, li) => {
        const a: Anchor | null = line.src !== null ? { id: s.ids[line.src], prev: s.prev[line.src], base: s.base[line.src] } : null;
        let d: number;
        if (a && (!prev || (prev.anchor && a.prev === prev.anchor.id))) d = prev ? prev.d + (prev.anchor!.base - a.base) : srcTop - a.base;
        else if (!prev) d = firstDepth(box, line.above);
        else if (li === 0) d = paraBottom + spaceBefore + line.above;
        else d = prev.d + step;
        out.push({ depth: d, above: line.above, baseline: 0, x: frame.x0, para: pi, ...laidLineOf(line, 0, fontOf), kept: line.kept });
        prev = { d, below: line.below, anchor: a };
        paraBottom = d + line.below + p.spaceAfter;
        const pad = a ? a.base - box.source.frame.y0 : -1;
        // on the source's lowest baseline (kept, or edited in place): the source frame's bottom below it
        const inPlace = !!a && Math.abs(d - (srcTop - a.base)) < 0.01;
        lastPad = a && (line.kept || inPlace) && pad >= 0 && a.base <= lowest + 0.01 ? pad : null;
        bottom = Math.max(bottom, d + (lastPad ?? line.below));
      });
      lastSpaceAfter = 0;
      return;
    }
    const r = layoutFlowPara(p, W, smallest, fonts, fontOf);
    if (!r) return;
    const { L, left } = r;
    overflow ||= L.overflow;
    const info = L.paras?.[0];
    if (info) infos.push({ ...info });
    let top = 0;                      // the line box's top in the paragraph (line boxes stack)
    L.lines.forEach((line, li) => {
      let d: number;
      if (!prev) d = firstDepth(box, line.baseline);
      else if (li === 0) d = paraBottom + spaceBefore + line.baseline;
      else d = prev.d + (line.baseline - L.lines[li - 1].baseline);
      const below = top + line.height - line.baseline;
      out.push({ depth: d, above: line.baseline - top, baseline: 0, x: frame.x0, para: pi, ...laidLineOf(line, left, fontOf) });
      top += line.height;
      prev = { d, below, anchor: null };
      paraBottom = d + below + p.spaceAfter;
      bottom = Math.max(bottom, paraBottom);
    });
    lastPad = null;
    lastSpaceAfter = p.spaceAfter;
  });
  if (!any || !out.length) return null;
  const last = out[out.length - 1];
  const lastBelow = (prev as { below: number } | null)?.below ?? 0;
  // the text's height: to the lowest line box (a kept last source line: the source frame's bottom)
  const height = Math.max(0, bottom, last.depth + (lastPad ?? lastBelow + lastSpaceAfter));
  const pinned = box.heightPinned;
  if (pinned && height > frame.y1 - frame.y0 + EPS) overflow = true;
  const used: Rect = pinned ? { ...frame } : { x0: frame.x0, x1: frame.x1, y1: frame.y1, y0: frame.y1 - height };
  return {
    box: box.id, frame: used, height, overflow,
    lines: out.map(({ depth, above: _a, ...l }) => ({ ...l, baseline: frame.y1 - depth })),
    textTop: frame.y1 - (out[0].depth - out[0].above),
    paragraphs: infos,
  };
}

/** A heading or title: a short paragraph (at most 120 characters) set bold, at 14 pt or more, or at least 1.2× the
 *  box's smallest text. Its lines are balanced and never hyphenated. */
function isHeading(p: Paragraph, smallest: number): boolean {
  const text = p.runs.map((r) => r.text).join('');
  if (!text.trim() || [...text].length > 120) return false;
  const d = dominantRun(p.runs);
  if (!d) return false;
  return d.bold || d.size >= 14 || (smallest > 0 && d.size >= 1.2 * smallest);
}

/** The paragraph's list marker as a src/text marker: its own style (bulletStyle, else the dominant run's), in a face
 *  that has its glyphs (Noto Sans JP when the Latin face lacks them, e.g. ● or ・). */
function markerOf(p: Paragraph, fonts: FontRegistry, fontOf: Map<Face, FontRef>): ParaIn['marker'] | undefined {
  if (!p.bullet) return undefined;
  const base = dominantRun(p.runs);
  const st = p.bulletStyle ?? (base ? { font: base.font, size: base.size, color: base.color } : null);
  if (!st) return undefined;
  const bold = st.font.bold;
  let { face, font } = fonts.resolve({ text: p.bullet, font: st.font, bold, italic: st.font.italic });
  const missing = (f: Face) => [...p.bullet!].some((ch) => !/\s/u.test(ch) && !f.hasGlyph(ch.codePointAt(0)!));
  if (missing(face)) {
    const id = bold ? 'NotoSansJP:700' : 'NotoSansJP:400';
    if (fonts.has(id)) {
      const jp = fonts.face(id);
      if (!missing(jp)) { face = jp; font = { source: 'shipped', name: id, bold, italic: false, serif: false }; }
    }
  }
  fontOf.set(face, font);
  return { run: { text: p.bullet, face, size: st.size, color: st.color }, indent: p.bulletIndent ?? st.size };
}

function layoutVertical(box: Box, fonts: FontRegistry): LaidBox {
  if (box.paragraphs.some((p) => keepable(p) && p.src!.vertical)) {
    const kept = layoutKeepVertical(box, fonts);
    if (kept) return kept;
  }
  const frame = box.frame;
  const H = Math.max(1, frame.y1 - frame.y0);
  const fontOf = new Map<Face, FontRef>();
  type Col = { left: number /* axis distance left of the right edge, before the shift */; runs: LaidBox['lines'][number]['runs'];
    para: number; start?: number; end?: number; pEnd?: number };
  const cols: Col[] = [];
  let x = 0;              // the stack so far, points left of the right edge
  let longest = 0;
  let overflow = false;
  box.paragraphs.forEach((p, pi) => {
    if (pi > 0) x += p.spaceBefore;
    const runs: RunIn[] = p.runs.map((r) => {
      const { face, font } = fonts.resolve(r);
      fontOf.set(face, font);
      return { text: r.text, face, size: r.size, charSpacing: r.charSpacing, color: r.color };
    });
    if (!runs.length) return;
    // width 0: glyph x and column axes come out relative to the right edge
    const L = layoutParagraphs([{ runs, align: p.align, leading: p.leading }], { width: 0, height: H }, { vertical: true });
    overflow ||= L.overflow;
    longest = Math.max(longest, L.height);
    for (const line of L.lines) {
      cols.push({
        left: x - (line.axis ?? 0), para: pi,
        ...(line.start !== undefined ? { start: line.start, end: line.end } : {}), ...(line.pEnd !== undefined ? { pEnd: line.pEnd } : {}),
        runs: line.runs.map((r) => {
          const font = fontOf.get(baseFace(r.face))!;
          return {
            // the vertical font is another PDF font than the horizontal one: its own name, so consumers keyed on the
            // font name (export) keep the two apart
            font: r.orientation === 'upright' ? { ...font, name: `${font.name}${VERTICAL_SUFFIX}` } : font,
            size: r.size, color: [r.color[0], r.color[1], r.color[2]],
            // x relative to the right edge and this paragraph's place in the stack; fixed below
            glyphs: r.glyphs.map((g) => ({ gid: g.gid, x: g.x - x, y: g.y, text: g.text, ...(g.c !== undefined ? { c: g.c, p: g.p } : {}) })),
            face: r.face, ...(r.orientation ? { orientation: r.orientation } : {}),
          };
        }),
      });
    }
    x += L.width + p.spaceAfter;
  });
  // the first axis where the source's was
  const a0 = cols.length ? cols[0].left : 0;
  let d0 = a0;
  const src = box.source;
  const firstSize = box.paragraphs[0]?.runs[0]?.size;
  if (src.axis !== undefined && src.axis > 0 && firstSize && src.paragraphs[0]?.size) d0 = src.axis * (firstSize / src.paragraphs[0].size);
  const shift = d0 - a0;
  const width = Math.max(0, shift + x);
  const pinned = box.heightPinned;
  const frameW = frame.x1 - frame.x0;
  if (pinned && width > frameW + EPS) overflow = true;
  if (longest > H + EPS) overflow = true;
  const used: Rect = pinned ? { ...frame } : { x0: frame.x1 - width, x1: frame.x1, y0: frame.y0, y1: frame.y1 };
  const right = frame.x1 - shift;     // PDF x the layout's right edge maps to
  return {
    box: box.id, frame: used, height: longest, width, overflow, vertical: true,
    lines: cols.map((c) => ({
      baseline: frame.y1, x: used.x0, axis: right - c.left, para: c.para,
      ...(c.start !== undefined ? { start: c.start, end: c.end } : {}), ...(c.pEnd !== undefined ? { pEnd: c.pEnd } : {}),
      runs: c.runs.map((r) => ({ ...r, glyphs: r.glyphs.map((g) => ({ ...g, x: right + g.x - used.x0 })) })),
    })),
    textTop: frame.y1,
  };
}

/**
 * The keep-source-lines layout of a vertical box (columns): as layoutKeep, across. A paragraph still in its source
 * style is set by src/text layoutSourceLines with `vertical` (unchanged columns where the source drew them, glyph for
 * glyph down the column); the others are laid out as in layoutVertical. Axes: a column that starts as a source column
 * and follows the column that preceded it in the source keeps the source's distance to it (the box's first column:
 * its source axis, moved with the frame's right edge); others follow the stack (the paragraph's source column pitch,
 * or the column boxes and paragraph spacing at a paragraph start). The stack's left edge stays the source frame's when
 * the last column is the source's last. Null when no paragraph could be set on its source columns.
 */
function layoutKeepVertical(box: Box, fonts: FontRegistry): LaidBox | null {
  const frame = box.frame;
  const H = Math.max(1, frame.y1 - frame.y0);
  const fontOf = new Map<Face, FontRef>();
  const dx = frame.x1 - box.source.frame.x1;
  type Anchor = { id: number; prev: number; base: number };
  type Col = { axis: number; runs: LaidBox['lines'][number]['runs']; para: number; start?: number; end?: number; pEnd?: number; kept?: boolean };
  const cols: Col[] = [];
  let prev: { axis: number; half: number; anchor: Anchor | null } | null = null;
  let paraLeft = 0, minLeft = Infinity, longest = 0, lastLeft: number | null = null;
  let overflow = false, any = false;
  const lowest = Math.min(...box.paragraphs.flatMap((p) => p.src?.vertical ? p.src.base : []));   // the leftmost source axis
  const runsOf = (runs: TextLine['runs'], place: (x: number) => number) => runs.map((r) => {
    const font = fontOf.get(baseFace(r.face))!;
    return {
      font: r.orientation === 'upright' ? { ...font, name: `${font.name}${VERTICAL_SUFFIX}` } : font,
      size: r.size, color: [r.color[0], r.color[1], r.color[2]] as RGB,
      glyphs: r.glyphs.map((g) => ({ gid: g.gid, x: place(g.x), y: g.y, text: g.text, ...(g.c !== undefined ? { c: g.c, p: g.p } : {}) })),
      face: r.face, ...(r.orientation ? { orientation: r.orientation } : {}),
    };
  });
  box.paragraphs.forEach((p, pi) => {
    const spaceBefore = pi > 0 ? p.spaceBefore : 0;
    const runs: RunIn[] = p.runs.map((r) => {
      const { face, font } = fonts.resolve(r);
      fontOf.set(face, font);
      return { text: r.text, face, size: r.size, charSpacing: r.charSpacing, color: r.color };
    });
    if (!runs.length) return;
    const R = keepable(p) && p.src!.vertical ? layoutSourceLines({ runs, align: p.align, leading: p.leading }, sourceParaIn(box, p), { vertical: true }) : null;
    if (R) {
      any = true;
      const s = p.src!;
      const steps = s.base.slice(1).map((b, k) => s.base[k] - b).filter((x) => x > 0).sort((a, b) => a - b);
      const pitch = steps.length ? steps[steps.length >> 1] : p.leading * s.size;
      overflow ||= R.overflow;
      R.lines.forEach((line, li) => {
        const a: Anchor | null = line.src !== null ? { id: s.ids[line.src], prev: s.prev[line.src], base: s.base[line.src] } : null;
        let axis: number;
        if (a && (!prev || (prev.anchor && a.prev === prev.anchor.id))) axis = prev ? prev.axis - (prev.anchor!.base - a.base) : a.base + dx;
        else if (!prev) axis = box.source.axis !== undefined ? frame.x1 - box.source.axis : frame.x1 - line.above;
        else if (li === 0) axis = paraLeft - spaceBefore - line.above;
        else axis = prev.axis - pitch;
        cols.push({ axis, para: pi, start: line.start, end: line.end, pEnd: line.pEnd, kept: line.kept, runs: runsOf(line.runs, (x) => axis + x) });
        prev = { axis, half: line.above, anchor: a };
        paraLeft = axis - line.below - p.spaceAfter;
        const left = axis - line.below;
        lastLeft = a && line.kept && a.base <= lowest + 0.01 ? box.source.frame.x0 + dx : null;
        minLeft = Math.min(minLeft, lastLeft ?? left);
        if (!line.kept) longest = Math.max(longest, line.pEnd);
      });
      return;
    }
    // a paragraph on no source columns: as layoutVertical (width 0: axes and glyph x from the paragraph's right edge)
    const L = layoutParagraphs([{ runs, align: p.align, leading: p.leading }], { width: 0, height: H }, { vertical: true });
    overflow ||= L.overflow;
    longest = Math.max(longest, L.height);
    const first = L.lines[0]?.axis ?? 0;
    let right: number;
    if (!prev) right = (box.source.axis !== undefined && box.source.axis > 0 ? frame.x1 - box.source.axis : frame.x1 + first) - first;
    else right = paraLeft - spaceBefore;
    for (const line of L.lines) {
      const axis = right + (line.axis ?? 0);
      const half = line.height / 2;
      cols.push({ axis, para: pi, ...(line.start !== undefined ? { start: line.start, end: line.end } : {}), ...(line.pEnd !== undefined ? { pEnd: line.pEnd } : {}),
        runs: runsOf(line.runs, (x) => right + x) });
      prev = { axis, half, anchor: null };
      paraLeft = axis - half - p.spaceAfter;
      minLeft = Math.min(minLeft, axis - half);
      lastLeft = null;
    }
  });
  if (!any || !cols.length) return null;
  const width = Math.max(0, frame.x1 - minLeft);
  const pinned = box.heightPinned;
  if (pinned && width > frame.x1 - frame.x0 + EPS) overflow = true;
  if (longest > H + EPS) overflow = true;
  const used: Rect = pinned ? { ...frame } : { x0: frame.x1 - width, x1: frame.x1, y0: frame.y0, y1: frame.y1 };
  const tallest = Math.max(longest, ...cols.map((c) => c.pEnd ?? 0));
  return {
    box: box.id, frame: used, height: tallest, width, overflow, vertical: true,
    lines: cols.map((c) => ({
      baseline: frame.y1, x: used.x0, axis: c.axis, para: c.para,
      ...(c.start !== undefined ? { start: c.start, end: c.end } : {}), ...(c.pEnd !== undefined ? { pEnd: c.pEnd } : {}), ...(c.kept ? { kept: true } : {}),
      runs: c.runs.map((r) => ({ ...r, glyphs: r.glyphs.map((g) => ({ ...g, x: g.x - used.x0 })) })),
    })),
    textTop: frame.y1,
  };
}

/** Appended to a FontRef name for runs set upright in vertical text (their PDF font is the Identity-V one). */
export const VERTICAL_SUFFIX = '#vertical';

/** Laid-out boxes keyed by page and box id, invalidated by the editor on every edit of a box. A box object that
 *  was replaced (undo of a split or merge) is laid out afresh. */
export class LayoutCache {
  private fonts: FontRegistry;
  private map = new Map<string, { box: Box; laid: LaidBox }>();

  constructor(fonts: FontRegistry) {
    this.fonts = fonts;
  }

  get(page: number, box: Box): LaidBox {
    const k = `${page}/${box.id}`;
    const hit = this.map.get(k);
    if (hit && hit.box === box) return hit.laid;
    const laid = layoutBox(box, this.fonts);
    this.map.set(k, { box, laid });
    return laid;
  }

  invalidate(page: number, boxId: string): void {
    this.map.delete(`${page}/${boxId}`);
  }

  clear(): void {
    this.map.clear();
  }
}
