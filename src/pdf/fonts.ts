// Font resources → code widths, for computing the advance of text-showing operators (ISO 32000-1 §9.2.4, §9.6, §9.7).

import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  StandardFontEmbedder,
  StandardFonts,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

export type FontInfo = {
  type: string; // /Subtype: Type0, Type1, TrueType, MMType1, Type3, …
  baseFont: string;
  codeBytes: 1 | 2 | 0; // 0 = a CMap other than Identity-H/V: unsupported, the caller must not blank such text
  width(code: number): number; // horizontal advance w0, glyph space, 1000 = 1 em (Type3: FontMatrix applied)
  vertical: boolean;
  /** Vertical advance w1 (1000 = 1 em, normally negative), for vertical fonts. */
  vwidth?(code: number): number;
  /** True when the font has no /Widths and is not a standard-14 font: width() returns 0 for every code. */
  widthsMissing?: boolean;
};

export function resolve(context: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  let cur = o;
  for (let i = 0; i < 32 && cur instanceof PDFRef; i++) cur = context.lookup(cur);
  return cur;
}

function numOf(context: PDFContext, o: PDFObject | undefined): number | undefined {
  const v = resolve(context, o);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function nameOf(context: PDFContext, o: PDFObject | undefined): string | undefined {
  const v = resolve(context, o);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

function arrOf(context: PDFContext, o: PDFObject | undefined): PDFArray | undefined {
  const v = resolve(context, o);
  return v instanceof PDFArray ? v : undefined;
}

function dictOf(context: PDFContext, o: PDFObject | undefined): PDFDict | undefined {
  const v = resolve(context, o);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

/** The page's /Resources, own or inherited through /Parent (§7.7.3.4). */
export function inheritedResources(context: PDFContext, page: PDFDict): PDFDict | undefined {
  let node: PDFDict | undefined = page;
  for (let depth = 0; node && depth < 64; depth++) {
    const r = dictOf(context, node.get(PDFName.of('Resources')));
    if (r) return r;
    node = dictOf(context, node.get(PDFName.of('Parent')));
  }
  return undefined;
}

/** Looks a name up in a dict by its decoded form (names may be written with #xx escapes). */
export function lookupByName(dict: PDFDict, name: string): PDFObject | undefined {
  const direct = dict.get(PDFName.of(name));
  if (direct !== undefined) return direct;
  for (const [k, v] of dict.entries()) if (k.decodeText() === name) return v;
  return undefined;
}

export function pageFontDict(context: PDFContext, page: PDFDict, resourceName: string): PDFDict {
  const res = inheritedResources(context, page);
  const fonts = res && dictOf(context, res.get(PDFName.of('Font')));
  const f = fonts && dictOf(context, lookupByName(fonts, resourceName));
  if (!f) throw new Error(`pdfedit: no font resource /${resourceName} on this page`);
  return f;
}

// ---------------------------------------------------------------------------------------------------------------
// Encodings for standard-14 metrics (only needed when a simple font has no /Widths).

const STANDARD_ENCODING: Record<number, string> = (() => {
  const t: Record<number, string> = {};
  const ascii =
    'space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma ' +
    'hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater ' +
    'question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright ' +
    'asciicircum underscore quoteleft a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar ' +
    'braceright asciitilde';
  ascii.split(' ').forEach((n, i) => (t[32 + i] = n));
  const high: [number, string][] = [
    [161, 'exclamdown'], [162, 'cent'], [163, 'sterling'], [164, 'fraction'], [165, 'yen'], [166, 'florin'],
    [167, 'section'], [168, 'currency'], [169, 'quotesingle'], [170, 'quotedblleft'], [171, 'guillemotleft'],
    [172, 'guilsinglleft'], [173, 'guilsinglright'], [174, 'fi'], [175, 'fl'], [177, 'endash'], [178, 'dagger'],
    [179, 'daggerdbl'], [180, 'periodcentered'], [182, 'paragraph'], [183, 'bullet'], [184, 'quotesinglbase'],
    [185, 'quotedblbase'], [186, 'quotedblright'], [187, 'guillemotright'], [188, 'ellipsis'], [189, 'perthousand'],
    [191, 'questiondown'], [193, 'grave'], [194, 'acute'], [195, 'circumflex'], [196, 'tilde'], [197, 'macron'],
    [198, 'breve'], [199, 'dotaccent'], [200, 'dieresis'], [202, 'ring'], [203, 'cedilla'], [205, 'hungarumlaut'],
    [206, 'ogonek'], [207, 'caron'], [208, 'emdash'], [225, 'AE'], [227, 'ordfeminine'], [232, 'Lslash'],
    [233, 'Oslash'], [234, 'OE'], [235, 'ordmasculine'], [241, 'ae'], [245, 'dotlessi'], [248, 'lslash'],
    [249, 'oslash'], [250, 'oe'], [251, 'germandbls'],
  ];
  for (const [c, n] of high) t[c] = n;
  return t;
})();

const MAC_HIGH =
  'Adieresis Aring Ccedilla Eacute Ntilde Odieresis Udieresis aacute agrave acircumflex adieresis atilde aring ' +
  'ccedilla eacute egrave ecircumflex edieresis iacute igrave icircumflex idieresis ntilde oacute ograve ' +
  'ocircumflex odieresis otilde uacute ugrave ucircumflex udieresis dagger degree cent sterling section bullet ' +
  'paragraph germandbls registered copyright trademark acute dieresis notequal AE Oslash infinity plusminus ' +
  'lessequal greaterequal yen mu partialdiff summation product pi integral ordfeminine ordmasculine Omega ae ' +
  'oslash questiondown exclamdown logicalnot radical florin approxequal Delta guillemotleft guillemotright ' +
  'ellipsis space Agrave Atilde Otilde OE oe endash emdash quotedblleft quotedblright quoteleft quoteright divide ' +
  'lozenge ydieresis Ydieresis fraction currency guilsinglleft guilsinglright fi fl daggerdbl periodcentered ' +
  'quotesinglbase quotedblbase perthousand Acircumflex Ecircumflex Aacute Edieresis Egrave Iacute Icircumflex ' +
  'Idieresis Igrave Oacute Ocircumflex apple Ograve Uacute Ucircumflex Ugrave dotlessi circumflex tilde macron ' +
  'breve dotaccent ring cedilla hungarumlaut ogonek caron';

// pdf-lib's StandardFonts and @pdf-lib/standard-fonts' FontNames are the same strings under two enum types.
const standardFontOf = (font: StandardFonts) =>
  StandardFontEmbedder.for(font as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);

/** code → glyph name from one of pdf-lib's bundled encodings (WinAnsi, Symbol, ZapfDingbats). */
function fromPdfLibEncoding(font: StandardFonts): Record<number, string> {
  const emb = standardFontOf(font);
  const maps = (emb.encoding as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings;
  const t: Record<number, string> = {};
  for (const [code, name] of Object.values(maps)) if (!(code in t)) t[code] = name;
  return t;
}

let encodingCache: Record<string, Record<number, string>> | null = null;
function encodings(): Record<string, Record<number, string>> {
  if (encodingCache) return encodingCache;
  const win = fromPdfLibEncoding(StandardFonts.Helvetica);
  const mac: Record<number, string> = {};
  for (let c = 32; c < 127; c++) mac[c] = win[c];
  MAC_HIGH.split(' ').forEach((n, i) => (mac[128 + i] = n));
  encodingCache = {
    StandardEncoding: STANDARD_ENCODING,
    WinAnsiEncoding: win,
    MacRomanEncoding: mac,
    Symbol: fromPdfLibEncoding(StandardFonts.Symbol),
    ZapfDingbats: fromPdfLibEncoding(StandardFonts.ZapfDingbats),
  };
  return encodingCache;
}

/** Maps a BaseFont (subset prefix, common aliases such as Arial, TimesNewRoman, CourierNew) to a standard-14 name. */
export function standard14(baseFont: string): StandardFonts | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/\s+/g, '');
  const exact = Object.values(StandardFonts) as string[];
  if (exact.includes(n)) return n as StandardFonts;
  if (/^Symbol/i.test(n)) return StandardFonts.Symbol;
  if (/^ZapfDingbats/i.test(n)) return StandardFonts.ZapfDingbats;
  let family: 'Helvetica' | 'Times' | 'Courier' | null = null;
  let rest = '';
  const m = /^(Helvetica|Arial(?:MT)?|Times(?:NewRoman(?:PS)?)?|Courier(?:New(?:PS)?)?)(.*)$/i.exec(n);
  if (!m) return null;
  const f = m[1].toLowerCase();
  family = f.startsWith('helv') || f.startsWith('arial') ? 'Helvetica' : f.startsWith('times') ? 'Times' : 'Courier';
  rest = m[2];
  if (/^(Narrow|Black|Condensed)/i.test(rest.replace(/^[-,]/, ''))) return null; // different metrics
  const bold = /bold|black|heavy|semibold|demi/i.test(rest);
  const italic = /italic|oblique/i.test(rest);
  if (family === 'Helvetica')
    return bold
      ? italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold
      : italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica;
  if (family === 'Times')
    return bold
      ? italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold
      : italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman;
  return bold
    ? italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold
    : italic ? StandardFonts.CourierOblique : StandardFonts.Courier;
}

/** code → glyph name of a simple font: its /Encoding (base encoding and /Differences) over the built-in encoding of
 *  its standard-14 font (StandardEncoding for any other font). */
export function simpleGlyphNames(context: PDFContext, font: PDFDict): Record<number, string> {
  const baseFont = nameOf(context, font.get(PDFName.of('BaseFont'))) ?? '';
  return simpleEncoding(context, font, standard14(baseFont));
}

let glyphTable: Map<string, string> | null = null;
const EXTRA_GLYPHS: Record<string, string> = {
  fi: '\ufb01', fl: '\ufb02', ff: '\ufb00', ffi: '\ufb03', ffl: '\ufb04', dotlessi: '\u0131', Lslash: '\u0141', lslash: '\u0142',
  fraction: '\u2044', hungarumlaut: '\u02dd', ogonek: '\u02db', caron: '\u02c7', breve: '\u02d8', dotaccent: '\u02d9',
  ring: '\u02da', minus: '\u2212', nbspace: '\u00a0', sfthyphen: '\u00ad',
};

/** The Unicode text of a glyph name (standard glyph names from pdf-lib's WinAnsi, Symbol and ZapfDingbats tables, uniXXXX,
 *  uXXXX[XX]), or null. */
export function glyphUnicode(name: string): string | null {
  if (!glyphTable) {
    glyphTable = new Map(Object.entries(EXTRA_GLYPHS));
    for (const f of [StandardFonts.Helvetica, StandardFonts.Symbol, StandardFonts.ZapfDingbats]) {
      const maps = (standardFontOf(f).encoding as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings;
      for (const [cp, [, n]] of Object.entries(maps)) if (!glyphTable.has(n)) glyphTable.set(n, String.fromCodePoint(Number(cp)));
    }
  }
  const hit = glyphTable.get(name);
  if (hit !== undefined) return hit;
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(name);
  if (m) {
    let s = '';
    for (let i = 3; i < name.length; i += 4) s += String.fromCharCode(parseInt(name.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : null;
  }
  const base = name.split('.')[0]; // a.sc, one.oldstyle
  return base !== name && base ? glyphUnicode(base) : null;
}

function simpleEncoding(context: PDFContext, font: PDFDict, std: StandardFonts | null): Record<number, string> {
  const enc = encodings();
  const symbolic = std === StandardFonts.Symbol || std === StandardFonts.ZapfDingbats;
  const builtin = std === StandardFonts.Symbol ? enc.Symbol : std === StandardFonts.ZapfDingbats ? enc.ZapfDingbats : enc.StandardEncoding;
  const e = resolve(context, font.get(PDFName.of('Encoding')));
  let base = builtin;
  let differences: PDFArray | undefined;
  if (e instanceof PDFName) {
    if (!symbolic && enc[e.decodeText()]) base = enc[e.decodeText()];
  } else if (e instanceof PDFDict) {
    const b = nameOf(context, e.get(PDFName.of('BaseEncoding')));
    if (b && !symbolic && enc[b]) base = enc[b];
    differences = arrOf(context, e.get(PDFName.of('Differences')));
  }
  if (!differences) return base;
  const t = { ...base };
  let code = 0;
  for (let i = 0; i < differences.size(); i++) {
    const it = resolve(context, differences.get(i));
    if (it instanceof PDFNumber) code = it.asNumber();
    else if (it instanceof PDFName) t[code++] = it.decodeText();
  }
  return t;
}

// ---------------------------------------------------------------------------------------------------------------

type CidWidths = { single: Map<number, number>; ranges: [number, number, number][]; dflt: number };

function parseW(context: PDFContext, w: PDFArray | undefined, dflt: number): CidWidths {
  const out: CidWidths = { single: new Map(), ranges: [], dflt };
  if (!w) return out;
  const items = w.asArray().map((x) => resolve(context, x));
  for (let i = 0; i < items.length; ) {
    const first = items[i];
    if (!(first instanceof PDFNumber)) {
      i++;
      continue;
    }
    const c = first.asNumber();
    const next = items[i + 1];
    if (next instanceof PDFArray) {
      next.asArray().forEach((x, k) => {
        const v = numOf(context, x);
        if (v !== undefined) out.single.set(c + k, v);
      });
      i += 2;
    } else {
      const last = numOf(context, next);
      const v = numOf(context, items[i + 2]);
      if (last !== undefined && v !== undefined) out.ranges.push([c, last, v]);
      i += 3;
    }
  }
  return out;
}

function cidWidth(w: CidWidths, cid: number): number {
  const s = w.single.get(cid);
  if (s !== undefined) return s;
  for (const [a, b, v] of w.ranges) if (cid >= a && cid <= b) return v;
  return w.dflt;
}

/** Vertical metrics /W2: c [w1 vx vy …] or c_first c_last w1 vx vy; default /DW2 [880 −1000]. Returns w1 only. */
function parseW2(context: PDFContext, w2: PDFArray | undefined, dw2: PDFArray | undefined): CidWidths {
  const dflt = (dw2 && numOf(context, dw2.get(1))) ?? -1000;
  const out: CidWidths = { single: new Map(), ranges: [], dflt };
  if (!w2) return out;
  const items = w2.asArray().map((x) => resolve(context, x));
  for (let i = 0; i < items.length; ) {
    const first = items[i];
    if (!(first instanceof PDFNumber)) {
      i++;
      continue;
    }
    const c = first.asNumber();
    const next = items[i + 1];
    if (next instanceof PDFArray) {
      const a = next.asArray();
      for (let k = 0; k * 3 < a.length; k++) {
        const v = numOf(context, a[k * 3]);
        if (v !== undefined) out.single.set(c + k, v);
      }
      i += 2;
    } else {
      const last = numOf(context, next);
      const v = numOf(context, items[i + 2]);
      if (last !== undefined && v !== undefined) out.ranges.push([c, last, v]);
      i += 5;
    }
  }
  return out;
}

/** Width information for a font dictionary. */
export function fontInfoFromDict(context: PDFContext, font: PDFDict): FontInfo {
  const type = nameOf(context, font.get(PDFName.of('Subtype'))) ?? 'Unknown';
  const baseFont = nameOf(context, font.get(PDFName.of('BaseFont'))) ?? '';

  if (type === 'Type0') {
    const enc = resolve(context, font.get(PDFName.of('Encoding')));
    const encName = enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFStream ? '(embedded CMap)' : '';
    const descendants = arrOf(context, font.get(PDFName.of('DescendantFonts')));
    const cid = descendants && dictOf(context, descendants.get(0));
    if ((encName !== 'Identity-H' && encName !== 'Identity-V') || !cid) {
      return { type, baseFont, codeBytes: 0, width: () => 0, vertical: encName.endsWith('-V') };
    }
    const w = parseW(context, arrOf(context, cid.get(PDFName.of('W'))), numOf(context, cid.get(PDFName.of('DW'))) ?? 1000);
    const vertical = encName === 'Identity-V';
    const info: FontInfo = { type, baseFont, codeBytes: 2, width: (c) => cidWidth(w, c), vertical };
    if (vertical) {
      const w2 = parseW2(context, arrOf(context, cid.get(PDFName.of('W2'))), arrOf(context, cid.get(PDFName.of('DW2'))));
      info.vwidth = (c) => cidWidth(w2, c);
    }
    return info;
  }

  // Simple fonts: Type1, MMType1, TrueType, Type3.
  let scale = 1; // glyph space → 1000-unit text space
  if (type === 'Type3') {
    const fm = arrOf(context, font.get(PDFName.of('FontMatrix')));
    scale = ((fm && numOf(context, fm.get(0))) ?? 0.001) * 1000;
  }
  const widths = arrOf(context, font.get(PDFName.of('Widths')));
  if (widths) {
    const first = numOf(context, font.get(PDFName.of('FirstChar'))) ?? 0;
    const desc = dictOf(context, font.get(PDFName.of('FontDescriptor')));
    const missing = (desc && numOf(context, desc.get(PDFName.of('MissingWidth')))) ?? 0;
    const table = widths.asArray().map((x) => numOf(context, x) ?? missing);
    return {
      type,
      baseFont,
      codeBytes: 1,
      vertical: false,
      width: (c) => {
        const i = c - first;
        return (i >= 0 && i < table.length ? table[i] : missing) * scale;
      },
    };
  }
  const std = type === 'Type3' ? null : standard14(baseFont);
  if (std) {
    const afm = standardFontOf(std).font;
    const enc = simpleEncoding(context, font, std);
    const cache = new Map<number, number>();
    return {
      type,
      baseFont,
      codeBytes: 1,
      vertical: false,
      width: (c) => {
        let v = cache.get(c);
        if (v === undefined) {
          const name = enc[c];
          v = (name && afm.getWidthOfGlyph(name)) || 0;
          cache.set(c, v);
        }
        return v;
      },
    };
  }
  return { type, baseFont, codeBytes: 1, vertical: false, width: () => 0, widthsMissing: true };
}

/** Splits a shown string into character codes for a font with the given code length. */
export function codesOf(bytes: Uint8Array, codeBytes: 1 | 2): number[] {
  const out: number[] = [];
  if (codeBytes === 1) for (const b of bytes) out.push(b);
  else {
    // A dangling odd byte is not a complete code and shows nothing (as pdf.js reads it).
    for (let i = 0; i + 1 < bytes.length; i += 2) out.push((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}
