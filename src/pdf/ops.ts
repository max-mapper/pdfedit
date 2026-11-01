// Operators with their operands, and the text-showing operators with the text state in force at each.

import { codesOf, type FontInfo } from './fonts.ts';
import { tokenize, type Token } from './tokenizer.ts';

/** A PDF matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type M6 = [number, number, number, number, number, number];
export const IDENTITY: M6 = [1, 0, 0, 1, 0, 0];

/** m × n (apply m first, then n), as PDF composes matrices. */
export function mul(m: readonly number[], n: readonly number[]): M6 {
  return [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function apply(m: readonly number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export type Op = { op: string; operands: Token[]; start: number; end: number }; // byte range of operands + operator

export type TextShow = {
  n: number; // index among text-showing operators, in content order
  opIndex: number; // index into the Op[] passed to textShows
  op: 'Tj' | 'TJ' | "'" | '"';
  font: string; // resource name from Tf ('' when no Tf was seen)
  fontSize: number; // Tfs
  charSpacing: number; // Tc (for ", the value its operand sets)
  wordSpacing: number; // Tw (for ", the value its operand sets)
  hScale: number; // Th = Tz / 100 (1 = 100 %)
  leading: number; // TL
  rise: number; // Ts
  strings: Uint8Array[]; // raw (decoded-escape) string bytes; for TJ every string element in order
  start: number;
  end: number;
  inBT: boolean;
  /** The text matrix where the first glyph starts (for ' and ", after their T*). Exact when textShows had a font
   *  resolver; without one, earlier shows on the same line are taken to advance nothing. */
  tm: M6;
  /** The CTM at the show, in the stream's own space (starting at `opts.ctm`, identity by default). */
  ctm: M6;
  render: number; // Tr
  /** The fill colour in force when it was set in a device colour space (`0 g`, `r g b rg`, `c m y k k`, written back
   *  in that syntax); null when it was set through cs/sc/scn (a named space, a pattern). Default black: `0 g`. */
  fill: string | null;
  /** False when an advance before this show on its line could not be computed (no or unusable font widths). */
  tmExact: boolean;
};

/** A `Do` operator with the CTM in force (the XObject is painted in `ctm` × its own /Matrix). */
export type XObjectCall = { opIndex: number; name: string; ctm: M6; start: number; end: number; nameStart: number; nameEnd: number };

/**
 * Groups the stream's tokens into operators. Comments are dropped; an inline image becomes one op 'BI' whose single
 * operand is the inlineImage token. Operands left over at the end (no operator) are ignored.
 */
export function parseOps(bytes: Uint8Array): Op[] {
  const ops: Op[] = [];
  let operands: Token[] = [];
  for (const t of tokenize(bytes)) {
    if (t.type === 'comment') continue;
    if (t.type === 'op') {
      ops.push({ op: t.value, operands, start: operands.length ? operands[0].start : t.start, end: t.end });
      operands = [];
    } else if (t.type === 'inlineImage') {
      // Operands before BI are junk; PDFium clears them. Keep them out of the image's range.
      ops.push({ op: 'BI', operands: [t], start: t.start, end: t.end });
      operands = [];
    } else {
      operands.push(t);
    }
  }
  return ops;
}

type TextState = {
  font: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  rise: number;
  render: number;
  fill: string | null;
};

const SIX = (o: Op): M6 | null => {
  const v = o.operands.slice(-6).map((t) => (t.type === 'number' ? t.value : NaN));
  return v.length === 6 && v.every(Number.isFinite) ? (v as M6) : null;
};

/** Every Do with the CTM at that point (q, Q and cm tracked from `ctm`). */
export function xobjectCalls(ops: Op[], ctm: readonly number[] = IDENTITY): XObjectCall[] {
  let cur = [...ctm] as M6;
  const stack: M6[] = [];
  const out: XObjectCall[] = [];
  ops.forEach((o, i) => {
    if (o.op === 'q') stack.push(cur);
    else if (o.op === 'Q') cur = stack.pop() ?? cur;
    else if (o.op === 'cm') {
      const m = SIX(o);
      if (m) cur = mul(m, cur);
    } else if (o.op === 'Do') {
      const n = o.operands[o.operands.length - 1];
      if (n?.type === 'name') out.push({ opIndex: i, name: n.value, ctm: cur, start: o.start, end: o.end, nameStart: n.start, nameEnd: n.end });
    }
  });
  return out;
}

/** The text-space advance of a show's operands (TJ numbers included), or null when the font cannot say. */
function advance(o: Op, op: TextShow['op'], ts: TextState, font: FontInfo | null): { tx: number; ty: number } | null {
  if (!font || font.codeBytes === 0 || font.widthsMissing || (font.vertical && !font.vwidth)) return null;
  const last = o.operands[o.operands.length - 1];
  const parts: (Uint8Array | number)[] = [];
  if (op === 'TJ') {
    if (last?.type === 'array') for (const it of last.items) {
      if (it.type === 'string' || it.type === 'hex') parts.push(it.value);
      else if (it.type === 'number') parts.push(it.value);
    }
  } else if (last && (last.type === 'string' || last.type === 'hex')) parts.push(last.value);
  let d = 0;
  for (const p of parts) {
    if (typeof p === 'number') { d -= (p / 1000) * ts.fontSize; continue; }
    for (const code of codesOf(p, font.codeBytes)) {
      const w = font.vertical ? font.vwidth!(code) : font.width(code);
      d += (w / 1000) * ts.fontSize + ts.charSpacing + (font.codeBytes === 1 && code === 32 ? ts.wordSpacing : 0);
    }
  }
  return font.vertical ? { tx: 0, ty: d } : { tx: d * ts.hScale, ty: 0 };
}

function num(t: Token | undefined): number | null {
  return t && t.type === 'number' ? t.value : null;
}

function str(t: Token | undefined): Uint8Array | null {
  return t && (t.type === 'string' || t.type === 'hex') ? t.value : null;
}

/**
 * Every Tj, TJ, ' and " in order, with the text state (part of the graphics state, so saved by q and restored by Q),
 * the text matrix and the CTM. With `opts.fonts` (resource name → widths) the text matrix advances past each show
 * exactly; `opts.ctm` is the CTM the stream starts with (a form's /Matrix, for instance).
 */
export function textShows(ops: Op[], opts: { fonts?: (name: string) => FontInfo | null; ctm?: readonly number[] } = {}): TextShow[] {
  let ts: TextState = { font: '', fontSize: 0, charSpacing: 0, wordSpacing: 0, hScale: 1, leading: 0, rise: 0, render: 0, fill: '0 g' };
  const stack: { ts: TextState; ctm: M6 }[] = [];
  let ctm = [...(opts.ctm ?? IDENTITY)] as M6;
  let tm: M6 = [...IDENTITY];
  let tlm: M6 = [...IDENTITY];
  let exact = true;
  let inBT = false;
  const out: TextShow[] = [];
  const fontCache = new Map<string, FontInfo | null>();
  const fontOf = (name: string) => {
    if (!opts.fonts) return null;
    if (!fontCache.has(name)) {
      let f: FontInfo | null = null;
      try { f = opts.fonts(name); } catch { f = null; }
      fontCache.set(name, f);
    }
    return fontCache.get(name)!;
  };
  const last = (o: Op, k = 1) => o.operands[o.operands.length - k];
  const newLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = [...tlm];
    exact = true;
  };
  const push = (o: Op, i: number, op: TextShow['op'], strings: Uint8Array[]) => {
    out.push({ n: out.length, opIndex: i, op, ...ts, strings, start: o.start, end: o.end, inBT, tm: [...tm], ctm: [...ctm], tmExact: exact });
    const d = advance(o, op, ts, fontOf(ts.font));
    if (d) tm = mul([1, 0, 0, 1, d.tx, d.ty], tm);
    else exact = false;
  };

  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    switch (o.op) {
      case 'q':
        stack.push({ ts: { ...ts }, ctm });
        break;
      case 'Q': {
        const s = stack.pop(); // an unbalanced Q is ignored, as viewers do
        if (s) { ts = s.ts; ctm = s.ctm; }
        break;
      }
      case 'cm': {
        const m = SIX(o);
        if (m) ctm = mul(m, ctm);
        break;
      }
      case 'BT':
        inBT = true;
        tm = [...IDENTITY];
        tlm = [...IDENTITY];
        exact = true;
        break;
      case 'Tm': {
        const m = SIX(o);
        if (m) { tlm = m; tm = [...m]; exact = true; }
        break;
      }
      case 'Td': {
        const tx = num(last(o, 2)), ty = num(last(o));
        if (tx !== null && ty !== null) newLine(tx, ty);
        break;
      }
      case 'T*':
        newLine(0, -ts.leading);
        break;
      case 'Tr': {
        const v = num(last(o));
        if (v !== null) ts.render = v;
        break;
      }
      case 'g':
      case 'rg':
      case 'k': {
        const k = o.op === 'g' ? 1 : o.op === 'rg' ? 3 : 4;
        const v = o.operands.slice(-k).map((t) => (t.type === 'number' ? t.value : NaN));
        ts.fill = v.length === k && v.every(Number.isFinite) ? `${v.map(String).join(' ')} ${o.op}` : null;
        break;
      }
      case 'cs':
      case 'sc':
      case 'scn':
        ts.fill = null;
        break;
      case 'ET':
        inBT = false;
        break;
      case 'Tf': {
        const name = o.operands[o.operands.length - 2];
        const size = num(last(o));
        if (name?.type === 'name') ts.font = name.value;
        if (size !== null) ts.fontSize = size;
        break;
      }
      case 'Tc': {
        const v = num(last(o));
        if (v !== null) ts.charSpacing = v;
        break;
      }
      case 'Tw': {
        const v = num(last(o));
        if (v !== null) ts.wordSpacing = v;
        break;
      }
      case 'Tz': {
        const v = num(last(o));
        if (v !== null) ts.hScale = v / 100;
        break;
      }
      case 'TL': {
        const v = num(last(o));
        if (v !== null) ts.leading = v;
        break;
      }
      case 'TD': {
        const tx = num(last(o, 2)), ty = num(last(o));
        if (ty !== null) ts.leading = -ty; // TD sets TL to −ty
        if (tx !== null && ty !== null) newLine(tx, ty);
        break;
      }
      case 'Ts': {
        const v = num(last(o));
        if (v !== null) ts.rise = v;
        break;
      }
      case 'Tj':
      case "'": {
        if (o.op === "'") newLine(0, -ts.leading);
        const s = str(last(o));
        push(o, i, o.op, s ? [s] : []);
        break;
      }
      case '"': {
        const aw = num(o.operands[o.operands.length - 3]);
        const ac = num(o.operands[o.operands.length - 2]);
        if (aw !== null) ts.wordSpacing = aw;
        if (ac !== null) ts.charSpacing = ac;
        newLine(0, -ts.leading);
        const s = str(last(o));
        push(o, i, '"', s ? [s] : []);
        break;
      }
      case 'TJ': {
        const a = last(o);
        const strings: Uint8Array[] = [];
        if (a?.type === 'array') for (const it of a.items) if (it.type === 'string' || it.type === 'hex') strings.push(it.value);
        push(o, i, 'TJ', strings);
        break;
      }
    }
  }
  return out;
}
