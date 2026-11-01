// PDF content-stream tokenizer over raw bytes (ISO 32000-1 §7.2, §7.3, §8.9.7 for inline images).
// Every token carries its byte range [start, end) in the input, so callers can splice the stream without
// re-serialising anything they did not touch.

export type Token =
  | { type: 'number'; value: number; start: number; end: number }
  | { type: 'string' | 'hex'; value: Uint8Array; start: number; end: number }
  | { type: 'name'; value: string; start: number; end: number } // decoded (#xx), without the slash, latin1
  | { type: 'bool'; value: boolean; start: number; end: number }
  | { type: 'null'; start: number; end: number }
  | { type: 'array' | 'dict'; items: Token[]; start: number; end: number } // dict items alternate key, value
  | { type: 'op'; value: string; start: number; end: number } // operator or other bare keyword
  | { type: 'comment'; start: number; end: number }
  | {
      type: 'inlineImage'; // the whole BI … ID <data> EI
      dict: Token[];
      dataStart: number;
      dataEnd: number;
      start: number;
      end: number;
    };

/** Every content-stream operator (ISO 32000-1 Annex A). */
export const CONTENT_OPERATORS: ReadonlySet<string> = new Set([
  'b', 'B', 'b*', 'B*', 'BDC', 'BI', 'BMC', 'BT', 'BX', 'c', 'cm', 'CS', 'cs', 'd', 'd0', 'd1', 'Do', 'DP', 'EI',
  'EMC', 'ET', 'EX', 'f', 'F', 'f*', 'G', 'g', 'gs', 'h', 'i', 'ID', 'j', 'J', 'K', 'k', 'l', 'm', 'M', 'MP', 'n',
  'q', 'Q', 're', 'RG', 'rg', 'ri', 's', 'S', 'SC', 'sc', 'SCN', 'scn', 'sh', 'T*', 'Tc', 'Td', 'TD', 'Tf', 'TJ',
  'Tj', 'TL', 'Tm', 'Tr', 'Ts', 'Tw', 'Tz', 'v', 'w', 'W', 'W*', 'y', "'", '"',
]);

export function isWhite(c: number): boolean {
  return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;
}

export function isDelim(c: number): boolean {
  return (
    c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b ||
    c === 0x7d || c === 0x2f || c === 0x25
  );
}

function isRegular(c: number): boolean {
  return !isWhite(c) && !isDelim(c);
}

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x37;
  if (c >= 0x61 && c <= 0x66) return c - 0x57;
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const NUMBERISH = /^[+\-.0-9]+$/;

function parseNumber(text: string): number {
  // Lenient like PDFium/pdf.js: "--5" → -5, "4." → 4, "0.0.1" → 0.
  let s = text.replace(/^[+-]+/, (m) => (m.includes('-') ? '-' : ''));
  s = s.replace(/(?!^)-/g, '');
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
}

/** A pull lexer over bytes[pos, end). */
export class Lexer {
  readonly bytes: Uint8Array;
  readonly end: number;
  pos: number;

  constructor(bytes: Uint8Array, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  skipWhite(): void {
    const b = this.bytes;
    while (this.pos < this.end && isWhite(b[this.pos])) this.pos++;
  }

  /** The next token (comments included), or null at the end. */
  next(): Token | null {
    this.skipWhite();
    if (this.pos >= this.end) return null;
    const b = this.bytes;
    const start = this.pos;
    const c = b[start];
    switch (c) {
      case 0x25: {
        // % comment, up to (not including) the end of line
        let p = start + 1;
        while (p < this.end && b[p] !== 0x0a && b[p] !== 0x0d) p++;
        this.pos = p;
        return { type: 'comment', start, end: p };
      }
      case 0x28:
        return this.literalString();
      case 0x3c:
        if (start + 1 < this.end && b[start + 1] === 0x3c) return this.dict();
        return this.hexString();
      case 0x5b:
        return this.array();
      case 0x2f:
        return this.name();
      case 0x3e: {
        // stray '>' or '>>'
        const len = start + 1 < this.end && b[start + 1] === 0x3e ? 2 : 1;
        this.pos = start + len;
        return { type: 'op', value: len === 2 ? '>>' : '>', start, end: this.pos };
      }
      case 0x29:
      case 0x5d:
      case 0x7b:
      case 0x7d:
        this.pos = start + 1;
        return { type: 'op', value: String.fromCharCode(c), start, end: this.pos };
    }
    let p = start;
    while (p < this.end && isRegular(b[p])) p++;
    this.pos = p;
    const text = latin1(b, start, p);
    if (NUMBERISH.test(text) && /[0-9]/.test(text)) return { type: 'number', value: parseNumber(text), start, end: p };
    if (text === 'true' || text === 'false') return { type: 'bool', value: text === 'true', start, end: p };
    if (text === 'null') return { type: 'null', start, end: p };
    if (text === 'BI') return this.inlineImage(start);
    return { type: 'op', value: text, start, end: p };
  }

  private literalString(): Token {
    const b = this.bytes;
    const start = this.pos;
    let p = start + 1;
    let depth = 1;
    const out: number[] = [];
    while (p < this.end) {
      const c = b[p++];
      if (c === 0x5c) {
        if (p >= this.end) break;
        const d = b[p++];
        switch (d) {
          case 0x6e: out.push(0x0a); break; // n
          case 0x72: out.push(0x0d); break; // r
          case 0x74: out.push(0x09); break; // t
          case 0x62: out.push(0x08); break; // b
          case 0x66: out.push(0x0c); break; // f
          case 0x0d: // line continuation: \CR, \CRLF
            if (p < this.end && b[p] === 0x0a) p++;
            break;
          case 0x0a: // \LF
            break;
          default:
            if (d >= 0x30 && d <= 0x37) {
              let v = d - 0x30;
              for (let k = 0; k < 2 && p < this.end && b[p] >= 0x30 && b[p] <= 0x37; k++) v = v * 8 + (b[p++] - 0x30);
              out.push(v & 0xff);
            } else {
              out.push(d); // \( \) \\ and unknown escapes: the character itself
            }
        }
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 0x0d) {
        out.push(0x0a); // an unescaped EOL is read as LF
        if (p < this.end && b[p] === 0x0a) p++;
      } else {
        out.push(c);
      }
    }
    this.pos = p;
    return { type: 'string', value: Uint8Array.from(out), start, end: p };
  }

  private hexString(): Token {
    const b = this.bytes;
    const start = this.pos;
    let p = start + 1;
    const out: number[] = [];
    let hi = -1;
    while (p < this.end && b[p] !== 0x3e) {
      const v = hexVal(b[p++]);
      if (v < 0) continue; // whitespace and junk are ignored
      if (hi < 0) hi = v;
      else {
        out.push(hi * 16 + v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi * 16);
    if (p < this.end) p++; // '>'
    this.pos = p;
    return { type: 'hex', value: Uint8Array.from(out), start, end: p };
  }

  private name(): Token {
    const b = this.bytes;
    const start = this.pos;
    let p = start + 1;
    let s = '';
    while (p < this.end && isRegular(b[p])) {
      const c = b[p];
      if (c === 0x23 && p + 2 < this.end && hexVal(b[p + 1]) >= 0 && hexVal(b[p + 2]) >= 0) {
        s += String.fromCharCode(hexVal(b[p + 1]) * 16 + hexVal(b[p + 2]));
        p += 3;
      } else {
        s += String.fromCharCode(c);
        p++;
      }
    }
    this.pos = p;
    return { type: 'name', value: s, start, end: p };
  }

  private array(): Token {
    const b = this.bytes;
    const start = this.pos;
    this.pos++;
    const items: Token[] = [];
    for (;;) {
      this.skipWhite();
      if (this.pos >= this.end) break;
      if (b[this.pos] === 0x5d) {
        this.pos++;
        break;
      }
      const t = this.next();
      if (!t) break;
      if (t.type !== 'comment') items.push(t);
    }
    return { type: 'array', items, start, end: this.pos };
  }

  private dict(): Token {
    const b = this.bytes;
    const start = this.pos;
    this.pos += 2;
    const items: Token[] = [];
    for (;;) {
      this.skipWhite();
      if (this.pos >= this.end) break;
      if (b[this.pos] === 0x3e && this.pos + 1 < this.end && b[this.pos + 1] === 0x3e) {
        this.pos += 2;
        break;
      }
      const t = this.next();
      if (!t) break;
      if (t.type !== 'comment') items.push(t);
    }
    return { type: 'dict', items, start, end: this.pos };
  }

  /** After the `BI` keyword: key/value pairs up to `ID`, one whitespace byte, the data, then `EI`. */
  private inlineImage(start: number): Token {
    const b = this.bytes;
    const dict: Token[] = [];
    let sawId = false;
    for (;;) {
      const t = this.next();
      if (!t) break;
      if (t.type === 'comment') continue;
      if (t.type === 'op' && t.value === 'ID') {
        sawId = true;
        break;
      }
      dict.push(t);
    }
    if (!sawId) return { type: 'inlineImage', dict, dataStart: this.pos, dataEnd: this.pos, start, end: this.pos };
    let dataStart = this.pos;
    if (dataStart < this.end && isWhite(b[dataStart])) {
      // A single white-space byte separates ID from the data; CR LF counts as one EOL.
      if (b[dataStart] === 0x0d && dataStart + 1 < this.end && b[dataStart + 1] === 0x0a) dataStart += 2;
      else dataStart += 1;
    }
    const found = this.findEI(dict, dataStart);
    if (found < 0) {
      // No credible EI: the image swallows the rest of the stream (PDFium does the same).
      this.pos = this.end;
      return { type: 'inlineImage', dict, dataStart, dataEnd: this.end, start, end: this.end };
    }
    let dataEnd = found;
    if (dataEnd > dataStart && isWhite(b[dataEnd - 1])) dataEnd--;
    this.pos = found + 2;
    return { type: 'inlineImage', dict, dataStart, dataEnd, start, end: this.pos };
  }

  /** Byte offset of the `E` of the closing EI, or −1. */
  private findEI(dict: Token[], dataStart: number): number {
    const b = this.bytes;
    const isEI = (i: number) =>
      i + 1 < this.end &&
      b[i] === 0x45 &&
      b[i + 1] === 0x49 &&
      (i + 2 >= this.end || isWhite(b[i + 2]) || isDelim(b[i + 2]));
    // 1. Unfiltered images have a computable length: use it when EI is right there.
    const len = inlineImageLength(dict);
    if (len !== null) {
      let i = dataStart + len;
      while (i < this.end && isWhite(b[i])) i++;
      if (isEI(i) && this.followsCleanly(i + 2)) return i;
    }
    // 2. Scan for whitespace + EI + whitespace/delimiter/end, followed by something that parses as content.
    for (let i = dataStart; i + 1 < this.end; i++) {
      if (b[i] !== 0x45) continue;
      if (i === 0 || !isWhite(b[i - 1])) continue;
      if (!isEI(i)) continue;
      if (this.followsCleanly(i + 2)) return i;
    }
    return -1;
  }

  /** Do the bytes after a candidate EI lex as content (known operators, printable bytes)? */
  private followsCleanly(from: number): boolean {
    const probe = new Lexer(this.bytes, from, Math.min(this.end, from + 256));
    const b = this.bytes;
    for (let n = 0; n < 8; n++) {
      probe.skipWhite();
      if (probe.pos >= probe.end) return true;
      const c = b[probe.pos];
      if (c < 0x20 || c > 0x7e) return false; // binary right after EI: we are still inside the data
      let t: Token | null;
      try {
        t = probe.next();
      } catch {
        return false;
      }
      if (!t) return true;
      if (t.type === 'op') return CONTENT_OPERATORS.has(t.value) && t.value !== 'EI' && t.value !== 'ID';
      if (t.type === 'inlineImage') return true;
    }
    return true;
  }
}

function dictLookup(dict: Token[], ...keys: string[]): Token | undefined {
  for (let i = 0; i + 1 < dict.length; i += 2) {
    const k = dict[i];
    if (k.type === 'name' && keys.includes(k.value)) return dict[i + 1];
  }
  return undefined;
}

/** Byte length of an unfiltered inline image's data, or null when it cannot be known. */
export function inlineImageLength(dict: Token[]): number | null {
  if (dictLookup(dict, 'F', 'Filter')) return null;
  const w = dictLookup(dict, 'W', 'Width');
  const h = dictLookup(dict, 'H', 'Height');
  if (w?.type !== 'number' || h?.type !== 'number') return null;
  const im = dictLookup(dict, 'IM', 'ImageMask');
  let bpc = 8;
  let comps = 1;
  if (im?.type === 'bool' && im.value) {
    bpc = 1;
  } else {
    const bt = dictLookup(dict, 'BPC', 'BitsPerComponent');
    if (bt?.type !== 'number') return null;
    bpc = bt.value;
    const cs = dictLookup(dict, 'CS', 'ColorSpace');
    if (!cs) return null;
    if (cs.type === 'name') {
      const m: Record<string, number> = { G: 1, DeviceGray: 1, RGB: 3, DeviceRGB: 3, CMYK: 4, DeviceCMYK: 4 };
      if (!(cs.value in m)) return null; // a named resource colour space: unknown component count
      comps = m[cs.value];
    } else if (cs.type === 'array' && cs.items[0]?.type === 'name' && ['I', 'Indexed'].includes(cs.items[0].value)) {
      comps = 1;
    } else {
      return null;
    }
  }
  return Math.ceil((w.value * comps * bpc) / 8) * h.value;
}

/** All top-level tokens of a content stream, comments included, in byte order. */
export function tokenize(bytes: Uint8Array): Token[] {
  const lx = new Lexer(bytes);
  const out: Token[] = [];
  for (let t = lx.next(); t; t = lx.next()) out.push(t);
  return out;
}

/** Decoded string bytes of a 'string' or 'hex' token. */
export function stringBytes(t: Token): Uint8Array | null {
  return t.type === 'string' || t.type === 'hex' ? t.value : null;
}
