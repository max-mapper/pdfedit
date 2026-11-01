// Characters → lines → words.
//
// 1. Classify: generated and empty/control characters are dropped; whitespace is kept for word gaps and for the
//    line's character list but never shapes geometry. U+00AD is a soft hyphen. PDFium rewrites a real hyphen
//    glyph at a line end as U+0002 (its hyphenation guess); the glyph is in the content, so it stays a hyphen.
// 2. Direction: PDFium's angle is clockwise; θ = −angle (counter-clockwise degrees). θ ≈ 0 is horizontal, any
//    other θ a rotated group of its own. Vertical CJK is found from geometry: consecutive characters (content
//    order) that stack downward on one axis with no horizontal advance, in the same text object, or CJK
//    characters in consecutive objects (one character per object). Chains of two or more are vertical.
// 3. Per direction group, in the group's local frame: band by baseline (within baselineTol × size), sort along
//    the line, and split where the gap exceeds lineGap em or a rule crosses between two characters.
// 4. Column gutters narrower than lineGap: a gap ≥ gutterGap em splits its line when most nearby lines leave the
//    same place empty. Small satellites (superscripts, footnote marks) join the line they sit on.
// 5. Words: Latin breaks at a gap > wordGap em (plus the line's median letter gap), a real space, or a PDFium
//    generated space; CJK breaks at script changes, and only a real space or a wide gap becomes a space.
import { isMarkerChar } from './paragraphs.ts';
import type { Char, PageInput, Rect, Thresholds, Word } from './types.ts';
import type { Frame, Span } from './geom.ts';
import { frameOf, isCjkCp, lowerBound, median, rectOfSpan, sOf, spanOf, union, vOf } from './geom.ts';
import type { Seg } from './rules.ts';
import { isBoldChar } from './fontstyle.ts';

export type G = {
  i: number; ch: string; ws: boolean; soft: boolean; cjk: boolean; dup: boolean; bold: boolean;
  /** Fill colour, 0xRRGGBB. */
  color: number;
  size: number; obj: number;
  s0: number; s1: number; v: number; lo: number; hi: number; box: Rect;
};

export type LineRec = {
  group: string; frame: Frame; vertical: boolean; angle: number;
  glyphs: G[];        // along the line, whitespace and duplicates included
  ink: G[];           // the drawn glyphs: no whitespace, no duplicates
  s0: number; s1: number; v: number; lo: number; hi: number; size: number; box: Rect;
  words: Word[]; spaceBefore: string[]; text: string;
  /** The line ends in a soft hyphen: 'char' (U+00AD / U+0002 in the text), 'generated' (PDFium inserted it). */
  softEnd: 'none' | 'char' | 'generated';
  bold: boolean;
  cell: number; panel: number;   // set by detect: global table-cell region, panel candidate (-1 = none)
};

type Cross = { s: number; v0: number; v1: number };

function classify(c: Char): 'skip' | 'ws' | 'soft' | 'ink' {
  if (c.generated || !c.unicode) return 'skip';
  const cp = c.unicode.codePointAt(0)!;
  if (cp === 0xad) return 'soft';
  if (cp === 0x02) return 'ink';
  if (cp < 0x20 || cp === 0x7f || cp === 0xfffe || cp === 0xffff) return 'skip';
  if (/^\s+$/u.test(c.unicode)) return 'ws';
  return 'ink';
}

const ccwDeg = (c: Char) => { const d = ((((-c.angle * 180) / Math.PI) % 360) + 360) % 360; return d; };
const isHorizontal = (c: Char) => { const d = ccwDeg(c); return d < 0.5 || d > 359.5; };
const sizeOf = (c: Char) => (c.fontSize > 0 ? c.fontSize : Math.max(1, c.box.y1 - c.box.y0, c.loose.y1 - c.loose.y0));
const degenerate = (r: Rect) => r.x1 - r.x0 < 0.01 || r.y1 - r.y0 < 0.01;
const cxLoose = (c: Char) => (c.loose.x0 + c.loose.x1) / 2;

/** Vertical-run detection over the horizontal (θ ≈ 0) characters, in content order. */
function verticalChars(chars: Char[], kinds: string[], th: Thresholds): Set<number> {
  const out = new Set<number>();
  let prev = -1;
  let chain: number[] = [];
  const flush = () => { if (chain.length >= 2) for (const i of chain) out.add(i); chain = []; };
  for (let i = 0; i < chars.length; i++) {
    if (kinds[i] === 'skip' || kinds[i] === 'ws') continue;
    const b = chars[i];
    if (!isHorizontal(b)) { flush(); prev = -1; continue; }
    if (prev >= 0) {
      const a = chars[prev];
      const sa = sizeOf(a), sb = sizeOf(b), em = Math.max(sa, sb);
      const dy = a.origin[1] - b.origin[1];
      const stacks = Math.min(sa, sb) / em >= 0.8 && Math.abs(cxLoose(a) - cxLoose(b)) <= th.verticalAxisTol * em &&
        dy >= th.verticalStepMin * em && dy <= th.verticalStepMax * em &&
        ((a.obj === b.obj && a.obj >= 0) || (isCjkCp(a.unicode.codePointAt(0)!) && isCjkCp(b.unicode.codePointAt(0)!)));
      if (stacks) { if (!chain.length) chain.push(prev); chain.push(i); }
      else flush();
    }
    prev = i;
  }
  flush();
  return out;
}

function glyphOf(c: Char, kind: string, f: Frame, vertical: boolean): G {
  const size = sizeOf(c);
  const cp = c.unicode.codePointAt(0)!;
  const ws = kind === 'ws';
  const g: G = { i: c.i, ch: cp === 0x02 ? '-' : c.unicode, ws, soft: kind === 'soft', cjk: isCjkCp(cp), dup: false,
    bold: isBoldChar(c),
    color: c.fill ? ((c.fill[0] & 255) << 16) | ((c.fill[1] & 255) << 8) | (c.fill[2] & 255) : 0, size, obj: c.obj, s0: 0, s1: 0, v: 0, lo: 0, hi: 0, box: c.box };
  if (vertical) {
    // the em square on the character's axis; loose y is the vertical advance when it is a plausible em
    const cx = cxLoose(c);
    let top = c.loose.y1, bottom = c.loose.y0;
    if (degenerate(c.loose) || top - bottom > 1.3 * size) { top = c.origin[1] + 0.88 * size; bottom = c.origin[1] - 0.12 * size; }
    g.s0 = -top; g.s1 = -bottom; g.v = cx; g.lo = cx - size / 2; g.hi = cx + size / 2;
    g.box = degenerate(c.box) ? { x0: cx - size / 2, x1: cx + size / 2, y0: bottom, y1: top } : c.box;
    return g;
  }
  const o = c.origin;
  g.v = vOf(f, o[0], o[1]);
  // along: the loose box is the advance for axis-aligned text; otherwise project the tight box
  const along = f.axis && !degenerate(c.loose) ? spanOf(f, c.loose) : spanOf(f, degenerate(c.box) ? c.loose : c.box);
  g.s0 = along.s0; g.s1 = along.s1;
  if (g.s1 - g.s0 > 3 * size || g.s1 < g.s0) { const t = spanOf(f, c.box); g.s0 = t.s0; g.s1 = t.s1; }
  if (ws) { g.lo = g.v; g.hi = g.v; return g; }
  if (degenerate(c.box)) {
    const em: Span = { s0: g.s0, s1: g.s1, v0: g.v - 0.12 * size, v1: g.v + 0.88 * size };
    g.lo = em.v0; g.hi = em.v1; g.box = rectOfSpan(f, em);
  } else {
    const t = spanOf(f, c.box);
    g.lo = t.v0; g.hi = t.v1;
  }
  return g;
}

function crossBarriers(segs: Seg[], f: Frame): Cross[] {
  if (!f.axis) return [];
  const out: Cross[] = [];
  for (const sg of segs) {
    const a0 = sOf(f, sg.x0, sg.y0), a1 = sOf(f, sg.x1, sg.y1), b0 = vOf(f, sg.x0, sg.y0), b1 = vOf(f, sg.x1, sg.y1);
    if (Math.abs(a1 - a0) < 0.5 && Math.abs(b1 - b0) > 0.5) out.push({ s: (a0 + a1) / 2, v0: Math.min(b0, b1), v1: Math.max(b0, b1) });
  }
  return out.sort((p, q) => p.s - q.s);
}

function crosses(bar: Cross[], a: G, b: G, vertical: boolean): boolean {
  if (!bar.length) return false;
  const lo = (a.s0 + a.s1) / 2, hi = (b.s0 + b.s1) / 2;
  const vp = vertical ? a.v : a.v + 0.3 * a.size;
  for (let k = lowerBound(bar, lo, (c) => c.s); k < bar.length && bar[k].s < hi; k++)
    if (vp >= bar[k].v0 - 1 && vp <= bar[k].v1 + 1) return true;
  return false;
}

/** Finishes a line from its glyphs: extents, size, words, text. */
function finishLine(base: Pick<LineRec, 'group' | 'frame' | 'vertical' | 'angle'>, glyphs: G[], chars: Char[], th: Thresholds): LineRec | null {
  glyphs.sort((p, q) => p.s0 - q.s0 || p.i - q.i);
  const ink = glyphs.filter((g) => !g.ws && !g.dup);
  if (!ink.length) return null;
  let s0 = Infinity, s1 = -Infinity, lo = Infinity, hi = -Infinity, box: Rect | null = null;
  const sizes = new Map<number, number>();
  let boldN = 0;
  for (const g of ink) {
    s0 = Math.min(s0, g.s0); s1 = Math.max(s1, g.s1); lo = Math.min(lo, g.lo); hi = Math.max(hi, g.hi);
    box = union(box, g.box);
    const k = Math.round(g.size * 10) / 10;
    sizes.set(k, (sizes.get(k) ?? 0) + 1);
    if (g.bold) boldN++;
  }
  let size = 0, best = -1;
  for (const [k, n] of sizes) if (n > best || (n === best && k > size)) { size = k; best = n; }
  const v = median(ink.filter((g) => Math.abs(g.size - size) < 0.05 * size).map((g) => g.v));
  // words
  const latinGaps: number[] = [];
  for (let k = 1; k < ink.length; k++) if (!ink[k].cjk && !ink[k - 1].cjk) latinGaps.push(ink[k].s0 - ink[k - 1].s1);
  const letterGap = latinGaps.length >= 3 ? Math.max(0, median(latinGaps)) : 0;
  const words: Word[] = [];
  const spaceBefore: string[] = [];
  let cur: G[] = [];
  let wsSeen = '';
  let prev: G | null = null;
  const emit = (sep: string) => {
    if (!cur.length) return;
    let wbox: Rect | null = null;
    for (const g of cur) wbox = union(wbox, g.box);
    words.push({ chars: cur.map((g) => g.i), text: cur.map((g) => (g.soft ? '' : g.ch)).join(''), box: wbox! });
    spaceBefore.push(sep);
    cur = [];
  };
  let pendingSep = '';
  for (const g of glyphs) {
    if (g.ws) { if (prev) wsSeen = wsSeen === '　' || g.ch === '　' ? '　' : ' '; continue; }
    if (g.dup) continue;
    if (prev) {
      const em = (prev.size + g.size) / 2, gap = g.s0 - prev.s1;
      let space = '', brk = false;
      if (prev.cjk || g.cjk) {
        space = wsSeen || (gap > th.cjkSpaceGap * em ? ' ' : '');
        brk = space !== '' || prev.cjk !== g.cjk;
      } else {
        const gen = g.i > prev.i && genSpaceAfter(chars, prev.i, g.i);
        space = wsSeen || (gen || gap > th.wordGap * em + letterGap ? ' ' : '');
        brk = space !== '';
      }
      if (brk) { emit(pendingSep); pendingSep = space; }
    }
    cur.push(g);
    prev = g;
    wsSeen = '';
  }
  emit(pendingSep);
  const last = ink[ink.length - 1];
  let softEnd: LineRec['softEnd'] = last.soft ? 'char' : 'none';
  const nx = chars[last.i + 1];
  if (softEnd === 'none' && nx && nx.generated && (nx.unicode === '-' || nx.unicode === '­' || nx.unicode === '\u0002')) softEnd = 'generated';
  if (last.soft) words[words.length - 1].text += '-';
  const text = words.map((w, k) => (k ? spaceBefore[k] : '') + w.text).join('');
  return { ...base, glyphs, ink, s0, s1, v, lo, hi, size, box: box!, words, spaceBefore, text, softEnd,
    bold: boldN * 2 > ink.length, cell: -1, panel: -1 };
}

/** A generated space follows character `a` (and nothing but generated characters or whitespace up to `b`). */
function genSpaceAfter(chars: Char[], a: number, b: number): boolean {
  if (b - a > 6) return false;
  let space = false;
  for (let k = a + 1; k < b; k++) {
    const c = chars[k];
    if (c.generated) { if (c.unicode === ' ') space = true; }
    else if (!/^\s*$/u.test(c.unicode)) return false;
  }
  return space;
}

export function buildLines(page: PageInput, segs: Seg[], th: Thresholds): { lines: LineRec[]; gutterSplits: number } {
  const { chars } = page;
  const kinds = chars.map(classify);
  // Characters covered by an opaque filled shape or image painted after them are not visible (a tag or sticker laid
  // over the end of a line, a mask): they take no part in lines, so they cannot fuse with the text on top.
  const covers = page.shapes.filter((s) => (s.kind === 'image' || (s.kind === 'path' && s.fill !== null && s.fill[3] === 255)) && s.z > 0);
  // and each visible character's backdrop: the topmost opaque shape painted before it under its centre (-1: the page)
  const backdrop = new Int32Array(chars.length).fill(-1);
  if (covers.length) {
    for (let i = 0; i < chars.length; i++) {
      if (kinds[i] === 'skip') continue;
      const c = chars[i], o = page.textObjects[c.obj];
      if (!o) continue;
      const cx = (c.box.x0 + c.box.x1) / 2, cy = (c.box.y0 + c.box.y1) / 2;
      let bz = -1;
      for (const [si, s] of covers.entries()) {
        if (s.z < o.z) {
          if (s.z > bz && (s.rects ?? [s.bounds]).some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) && s.kind === 'path') { bz = s.z; backdrop[i] = si; }
          continue;
        }
        const rs = s.rects ?? [s.bounds];
        if (rs.some((r) => cx > r.x0 && cx < r.x1 && cy > r.y0 && cy < r.y1) && (s.kind === 'image' || s.isRect || s.rects || s.segments <= 12)) { kinds[i] = 'skip'; break; }
      }
    }
  }
  const vert = verticalChars(chars, kinds, th);
  // direction groups
  const groups = new Map<string, { frame: Frame; vertical: boolean; angle: number; glyphs: G[] }>();
  for (let i = 0; i < chars.length; i++) {
    const kind = kinds[i];
    if (kind === 'skip') continue;
    const c = chars[i];
    let key: string, deg: number, vertical = false;
    if (vert.has(i)) { key = 'v'; deg = -90; vertical = true; }
    else if (isHorizontal(c)) { key = 'h'; deg = 0; }
    else { deg = Math.round(ccwDeg(c)) % 360; key = `r${deg}`; }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { frame: frameOf(deg), vertical, angle: vertical ? 0 : deg, glyphs: [] }));
    g.glyphs.push(glyphOf(c, kind, g.frame, vertical));
  }
  // text on another backdrop in another colour (white on a navy tag beside black body text) is another line
  const layerChange = (a: G, b: G) => backdrop[a.i] !== backdrop[b.i] &&
    [16, 8, 0].some((sh) => Math.abs(((a.color >> sh) & 255) - ((b.color >> sh) & 255)) > 48);
  const out: LineRec[] = [];
  let gutterSplits = 0;
  for (const [key, grp] of groups) {
    const bar = crossBarriers(segs, grp.frame);
    const base = { group: key, frame: grp.frame, vertical: grp.vertical, angle: grp.angle };
    const gs = grp.glyphs.sort((p, q) => q.v - p.v || p.s0 - q.s0);
    // bands of equal baseline
    const segsOut: G[][] = [];
    for (let k = 0; k < gs.length; ) {
      const ref = gs[k];
      let refSize = ref.ws ? 0 : ref.size;
      const band: G[] = [ref];
      // chained: each glyph within baselineTol of the one above it in the band (a raised superscript at the top of
      // the band does not split the line under it), the whole band within 0.6 em
      let prevV = ref.v;
      let j = k + 1;
      for (; j < gs.length; j++) {
        const g = gs[j];
        const sz = Math.max(g.ws ? 0 : g.size, refSize, 1);
        if (prevV - g.v > th.baselineTol * sz || ref.v - g.v > 0.6 * sz) break;
        band.push(g);
        if (!g.ws) { refSize = Math.max(refSize, g.size); prevV = g.v; }
      }
      k = j;
      band.sort((p, q) => p.s0 - q.s0 || p.i - q.i);
      let cur: G[] = [];
      let last: G | null = null;
      for (const g of band) {
        if (!g.ws && last) {
          const em = Math.max(g.size, last.size);
          if (g.ch === last.ch && Math.abs(g.s0 - last.s0) < 0.15 * em && Math.abs(g.v - last.v) < 0.15 * em) {
            // a glyph drawn twice (a halo or outline copy under the visible one): the copy painted last is what shows,
            // so it is the ink (its colour and weight become the run's) and the other is the duplicate
            if (g.i > last.i) { last.dup = true; cur.push(g); last = g; } else { g.dup = true; cur.push(g); }
            continue;
          }
          if (g.s0 - last.s1 > th.lineGap * em || crosses(bar, last, g, grp.vertical) || layerChange(last, g)) { segsOut.push(cur); cur = []; }
        }
        cur.push(g);
        if (!g.ws) last = g;
      }
      segsOut.push(cur);
    }
    let lines = segsOut.map((s) => finishLine(base, s, chars, th)).filter((l): l is LineRec => l !== null);
    const split = splitGutters(lines, th, (glyphs) => finishLine(base, glyphs, chars, th));
    gutterSplits += split.n;
    lines = mergeSatellites(split.lines, bar, (glyphs) => finishLine(base, glyphs, chars, th));
    out.push(...lines);
  }
  return { lines: out, gutterSplits };
}

/** Splits lines at column gutters narrower than lineGap: a wide internal gap that the lines around it also leave
 *  empty (they have a gap there, or end or start beside it) more often than they cover it. */
const NEEDS_GAP_MARK = new Set(['‐', '-', '*', '–']);

function splitGutters(lines: LineRec[], th: Thresholds, finish: (g: G[]) => LineRec | null): { lines: LineRec[]; n: number } {
  const byV = [...lines].sort((p, q) => p.v - q.v);
  const cuts = new Map<LineRec, number[]>();
  for (const L of lines) {
    for (let k = 1; k < L.ink.length; k++) {
      const a = L.ink[k - 1], b = L.ink[k], em = Math.max(a.size, b.size);
      if (b.s0 - a.s1 < th.gutterGap * em) continue;
      if (k === 1 && isMarkerChar(a.ch) && !NEEDS_GAP_MARK.has(a.ch)) continue;   // a list marker is never cut from its text
      const xm = (a.s1 + b.s0) / 2, strip = 0.1 * em, reach = th.lineGap * em + (b.s0 - a.s1) / 2;
      let support = 0, counter = 0;
      const win = th.gutterWindow * L.size;
      for (let j = lowerBound(byV, L.v - win, (l) => l.v); j < byV.length && byV[j].v <= L.v + win; j++) {
        const M = byV[j];
        if (M === L || Math.abs(M.v - L.v) < th.baselineTol * L.size) continue;
        if (M.s1 < xm - reach || M.s0 > xm + reach) continue;
        if (M.ink.some((g) => g.s0 < xm + strip && g.s1 > xm - strip)) counter++; else support++;
      }
      if (support >= 2 && support > counter) { let c = cuts.get(L); if (!c) cuts.set(L, (c = [])); c.push(xm); }
    }
  }
  if (!cuts.size) return { lines, n: 0 };
  const out: LineRec[] = [];
  let n = 0;
  for (const L of lines) {
    const c = cuts.get(L);
    if (!c) { out.push(L); continue; }
    const parts: G[][] = Array.from({ length: c.length + 1 }, () => []);
    for (const g of L.glyphs) parts[c.filter((x) => (g.s0 + g.s1) / 2 > x).length].push(g);
    for (const p of parts) { const l = finish(p); if (l) out.push(l); }
    n += c.length;
  }
  return { lines: out, n };
}

/** Superscripts, subscripts and footnote marks: a short line of smaller type that sits within a larger line's
 *  height, right beside it, joins that line. */
function mergeSatellites(lines: LineRec[], bar: Cross[], finish: (g: G[]) => LineRec | null): LineRec[] {
  const gone = new Set<LineRec>();
  const extra = new Map<LineRec, G[]>();
  for (const S of lines) {
    if (S.ink.length > 3) continue;
    const h = S.hi - S.lo;
    let host: LineRec | null = null;
    for (const L of lines) {
      if (L === S || gone.has(L) || L.ink.length <= S.ink.length || S.size > 0.85 * L.size) continue;
      if (Math.abs(S.v - L.v) < 0.1 * L.size) continue;   // same baseline: split on purpose (gap or rule)
      const ov = Math.min(S.hi, L.hi) - Math.max(S.lo, L.lo);
      if (ov < 0.5 * h) continue;
      const gap = Math.max(S.s0 - L.s1, L.s0 - S.s1);
      if (gap > 0.5 * L.size) continue;
      const [a, b] = S.s0 >= L.s1 - 0.01 ? [L.ink[L.ink.length - 1], S.ink[0]] : [S.ink[S.ink.length - 1], L.ink[0]];
      if (crosses(bar, a, b, L.vertical)) continue;
      host = L;
      break;
    }
    if (host) { gone.add(S); let e = extra.get(host); if (!e) extra.set(host, (e = [])); e.push(...S.glyphs); }
  }
  if (!gone.size) return lines;
  const out: LineRec[] = [];
  for (const L of lines) {
    if (gone.has(L)) continue;
    const e = extra.get(L);
    if (!e) { out.push(L); continue; }
    const merged = finish([...L.glyphs, ...e]);
    if (merged) { merged.v = L.v; merged.size = L.size; out.push(merged); }
  }
  return out;
}
