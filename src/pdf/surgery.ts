// Content-stream surgery: blank text-showing operators while keeping the text position exactly where it would
// have been after them (ISO 32000-1 §9.4.4), so text later on the same line stays put.

import { codesOf, type FontInfo } from './fonts.ts';
import { parseOps, type TextShow } from './ops.ts';
import { isDelim, isWhite, type Token } from './tokenizer.ts';

export type Displacement = { tx: number; ty: number };

/** One replaced range: [start, end) in the input became [newStart, newEnd) in the output. */
export type Replacement = { n: number; start: number; end: number; newStart: number; newEnd: number; text: string };

function showOp(contents: Uint8Array, show: TextShow) {
  const ops = parseOps(contents.subarray(show.start, show.end));
  const o = ops[ops.length - 1];
  if (!o || o.op !== show.op) {
    throw new Error(`pdfedit: bytes ${show.start}–${show.end} do not end with the ${show.op} operator of show #${show.n}`);
  }
  return o;
}

/**
 * The text-space displacement of a text-showing operator (the T* of ' and " not included).
 * Horizontal: tx = Σ((w0/1000)·Tfs + Tc + Tw[single-byte code 32])·Th − Σ(n/1000)·Tfs·Th over TJ numbers.
 * Vertical:   ty = Σ((w1/1000)·Tfs + Tc + Tw[single-byte code 32])     − Σ(n/1000)·Tfs.
 */
export function showDisplacement(contents: Uint8Array, show: TextShow, font: FontInfo): Displacement {
  if (font.codeBytes === 0) {
    throw new Error(
      `pdfedit: font /${show.font} (${font.type} ${font.baseFont}) uses a CMap we cannot decode; its text cannot be blanked`,
    );
  }
  if (font.vertical && !font.vwidth) {
    throw new Error(`pdfedit: font /${show.font} is vertical but has no vertical metrics; refusing to blank it`);
  }
  const o = showOp(contents, show);
  const parts: (Uint8Array | number)[] = [];
  const last: Token | undefined = o.operands[o.operands.length - 1];
  if (show.op === 'TJ') {
    if (last?.type === 'array')
      for (const it of last.items) {
        if (it.type === 'string' || it.type === 'hex') parts.push(it.value);
        else if (it.type === 'number') parts.push(it.value);
      }
  } else if (last && (last.type === 'string' || last.type === 'hex')) {
    parts.push(last.value);
  }
  const Tfs = show.fontSize;
  const Tc = show.charSpacing;
  const Tw = show.wordSpacing;
  const Th = show.hScale;
  let d = 0;
  for (const p of parts) {
    if (typeof p === 'number') {
      d -= (p / 1000) * Tfs;
      continue;
    }
    for (const code of codesOf(p, font.codeBytes)) {
      const w = font.vertical ? font.vwidth!(code) : font.width(code);
      d += (w / 1000) * Tfs + Tc + (font.codeBytes === 1 && code === 32 ? Tw : 0);
    }
  }
  return font.vertical ? { tx: 0, ty: d } : { tx: d * Th, ty: 0 };
}

/** A number in content-stream syntax: no exponent, at most 6 decimals, no trailing zeros. */
export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`pdfedit: cannot write the number ${x}`);
  let s = x.toFixed(6);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0' || s === '') s = '0';
  return s;
}

/** The no-glyph replacement for one show (without padding). */
export function replacementFor(contents: Uint8Array, show: TextShow, font: FontInfo): string {
  const { tx, ty } = showDisplacement(contents, show, font);
  const Tfs = show.fontSize;
  const scale = font.vertical ? Tfs : Tfs * show.hScale;
  const move = font.vertical ? ty : tx;
  const tj = scale === 0 ? '' : `[${fmtNum((-move * 1000) / scale)}] TJ`;
  const pre: string[] = [];
  if (show.op === '"') {
    // aw ac string " ≡ aw Tw ac Tc string ' ; Tw and Tc stay set afterwards, so keep them.
    const o = showOp(contents, show);
    const [aw, ac] = o.operands.slice(-3, -1);
    const raw = (t: Token) => String.fromCharCode(...contents.subarray(show.start + t.start, show.start + t.end));
    pre.push(`${aw ? raw(aw) : fmtNum(show.wordSpacing)} Tw`, `${ac ? raw(ac) : fmtNum(show.charSpacing)} Tc`, 'T*');
  } else if (show.op === "'") {
    pre.push('T*');
  }
  return [...pre, tj].filter(Boolean).join(' ');
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** blankOut with the map of what was replaced where. */
export function blankOutDetailed(
  contents: Uint8Array,
  shows: TextShow[],
  fonts: (name: string) => FontInfo,
): { bytes: Uint8Array; replacements: Replacement[] } {
  const sorted = [...shows].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) throw new Error(`pdfedit: shows #${sorted[i - 1].n} and #${sorted[i].n} overlap`);
  }
  const chunks: Uint8Array[] = [];
  const replacements: Replacement[] = [];
  let pos = 0;
  let outLen = 0;
  for (const s of sorted) {
    if (s.start < 0 || s.end > contents.length) throw new Error(`pdfedit: show #${s.n} lies outside the stream`);
    let text = replacementFor(contents, s, fonts(s.font));
    // Keep tokens apart: the bytes either side may be regular characters (e.g. "Tm(x)Tj").
    if (text && s.start > 0 && !isWhite(contents[s.start - 1]) && !isDelim(contents[s.start - 1]) && !/^[[(<\/]/.test(text)) {
      text = ' ' + text;
    }
    if (text && s.end < contents.length && !isWhite(contents[s.end]) && !isDelim(contents[s.end])) text += ' ';
    const head = contents.subarray(pos, s.start);
    chunks.push(head);
    outLen += head.length;
    const rep = latin1Bytes(text);
    chunks.push(rep);
    replacements.push({ n: s.n, start: s.start, end: s.end, newStart: outLen, newEnd: outLen + rep.length, text });
    outLen += rep.length;
    pos = s.end;
  }
  const tail = contents.subarray(pos);
  chunks.push(tail);
  outLen += tail.length;
  const bytes = new Uint8Array(outLen);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { bytes, replacements };
}

/**
 * Replaces each listed text-showing operator (operands included) by a no-glyph equivalent that moves the text
 * position by the same amount: `[k] TJ`; `T* [k] TJ` for '; `aw Tw ac Tc T* [k] TJ` for ". When Tfs·Th is 0 no TJ
 * is written. Every other byte is unchanged. Throws for fonts whose codes cannot be decoded (codeBytes 0).
 */
export function blankOut(contents: Uint8Array, shows: TextShow[], fonts: (name: string) => FontInfo): Uint8Array {
  return blankOutDetailed(contents, shows, fonts).bytes;
}
