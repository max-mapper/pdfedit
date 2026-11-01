// What a font's codes say as text: the ToUnicode CMap (ISO 32000-1 §9.10.3) where the font has one, else the glyph
// names of a simple font's encoding (§9.10.2). Used to match operators to PDFium's text objects by their text and to
// align an operator's codes with PDFium's characters.

import { PDFDict, PDFName, PDFStream, type PDFContext } from 'pdf-lib';
import { decodeStream } from './edit.ts';
import { codesOf, fontInfoFromDict, glyphUnicode, resolve, simpleGlyphNames, type FontInfo } from './fonts.ts';
import { tokenize, type Token } from './tokenizer.ts';

const codeOf = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);

function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]); // a stray byte: keep it as a Latin-1 char
  return s;
}

const bytesOf = (t: Token | undefined): Uint8Array | null => (t && (t.type === 'hex' || t.type === 'string') ? t.value : null);

/** Parses the bfchar and bfrange sections of a ToUnicode CMap (ISO 32000-1 §9.10.3): code → text. `usecmap` and
 *  codespace ranges are ignored (codes are read as big-endian numbers of whatever length the CMap writes). */
export function parseToUnicode(cmap: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  const t = tokenize(cmap);
  const isOp = (k: Token | undefined, v: string) => k?.type === 'op' && k.value === v;
  for (let i = 0; i < t.length; i++) {
    if (isOp(t[i], 'beginbfchar')) {
      i++;
      while (i + 1 < t.length && !isOp(t[i], 'endbfchar')) {
        const src = bytesOf(t[i]);
        const dst = t[i + 1];
        if (src) {
          if (dst.type === 'hex' || dst.type === 'string') out.set(codeOf(src), utf16be(dst.value));
          else if (dst.type === 'name') out.set(codeOf(src), dst.value);
        }
        i += 2;
      }
    } else if (isOp(t[i], 'beginbfrange')) {
      i++;
      while (i + 2 < t.length && !isOp(t[i], 'endbfrange')) {
        const lo = bytesOf(t[i]);
        const hi = bytesOf(t[i + 1]);
        const dst = t[i + 2];
        i += 3;
        if (!lo || !hi) continue;
        const a = codeOf(lo);
        const b = Math.min(codeOf(hi), a + 0xffff);
        if (dst.type === 'array') {
          dst.items.forEach((it, k) => {
            const v = bytesOf(it);
            if (v && a + k <= b) out.set(a + k, utf16be(v));
          });
        } else {
          const base = bytesOf(dst);
          if (!base || base.length < 2) continue;
          // The last UTF-16 code unit is incremented across the range (as viewers do).
          const head = utf16be(base.subarray(0, base.length - 2));
          const last = (base[base.length - 2] << 8) | base[base.length - 1];
          for (let c = a; c <= b; c++) out.set(c, head + String.fromCharCode((last + (c - a)) & 0xffff));
        }
      }
    }
  }
  return out;
}

export type FontDecoder = {
  info: FontInfo;
  /** The text of one code, or null when neither a ToUnicode entry nor a glyph name says. */
  decode(code: number): string | null;
  /** The codes of a shown string (empty for fonts whose CMap we cannot split, codeBytes 0). */
  codes(bytes: Uint8Array): number[];
  /** The text of shown strings, or null when any code is unknown. */
  text(strings: Uint8Array[]): string | null;
  source: 'ToUnicode' | 'encoding' | 'none';
};

/** A decoder for a font dictionary. */
export function fontDecoder(context: PDFContext, font: PDFDict): FontDecoder {
  const info = fontInfoFromDict(context, font);
  let map: Map<number, string> | null = null;
  const tu = resolve(context, font.get(PDFName.of('ToUnicode')));
  if (tu instanceof PDFStream) {
    try {
      map = parseToUnicode(decodeStream(context, tu, `ToUnicode of ${info.baseFont}`));
    } catch {
      map = null;
    }
  }
  let names: Record<number, string> | null = null;
  if (info.codeBytes === 1 && info.type !== 'Type0') {
    try {
      names = simpleGlyphNames(context, font);
    } catch {
      names = null;
    }
  }
  const decode = (code: number): string | null => {
    const m = map?.get(code);
    if (m !== undefined) return m;
    const n = names?.[code];
    return n ? glyphUnicode(n) : null;
  };
  const codes = (b: Uint8Array) => (info.codeBytes === 0 ? [] : codesOf(b, info.codeBytes));
  return {
    info,
    decode,
    codes,
    text(strings) {
      if (info.codeBytes === 0) return null;
      let s = '';
      for (const b of strings) for (const c of codes(b)) {
        const u = decode(c);
        if (u === null) return null;
        s += u;
      }
      return s;
    },
    source: map ? 'ToUnicode' : names ? 'encoding' : 'none',
  };
}
