// Font substitution: which open family (src/fonts/catalog.ts) should draw new text in place of a document font that
// cannot (a subset lacking the glyphs, or a font that is not embedded). Pure and local: it reads only what the caller
// passes (the font's name, descriptor values, the embedded program's OS/2 / hhea / post numbers, glyph widths) and
// sends nothing anywhere.
//
//   1. the name is decoded (Shift_JIS names too), NFKC-folded, stripped of the subset prefix, CMap suffix and
//      ",Bold"-style suffix, and split into tokens; weight, width and slant are read from the tokens (Latin words,
//      W1–W12, weight letter codes, HG suffixes);
//   2. a curated alias table names the families for well-known fonts (Arial → Arimo, metric-compatible; Kozuka Gothic
//      → Noto Sans JP; MS Gothic → IPAGothic for Japanese text, metric-compatible; Myriad → Source Sans 3; …);
//   3. every family that covers the script the new text needs is scored on classification, alias rank, weight,
//      width (nominal, or measured from glyph widths), slant, pitch and x-height, and the best few are returned with
//      the instance to load (file and variation coordinates).

import { CATALOG, type Classification, type Family, type FamilyId, type FontFileSpec, type Tier } from './catalog.ts';

// ---------------------------------------------------------------------------------------------------------------
// Types

/** OS/2 values of an embedded TrueType/OpenType program (font units where a length). */
export type Os2Info = {
  weightClass?: number;
  widthClass?: number;       // 1–9
  avgCharWidth?: number;
  familyClass?: number;      // sFamilyClass high byte (1–7 serif, 8 sans, 10 script, 12 symbolic)
  fsSelection?: number;
  fsType?: number;           // OS/2 fsType: the licence flags of the document's own font
  panose?: number[];         // 10 bytes
  xHeight?: number;          // sxHeight (OS/2 v2+)
  capHeight?: number;
};

export type SourceFontInfo = {
  /** The PDF BaseFont (with or without its subset prefix), or its raw bytes (a Shift_JIS name is decoded here). */
  name: string | Uint8Array;
  /** Descriptor /FontFamily, when present. */
  familyName?: string;
  /** Descriptor /Flags (FixedPitch 1, Serif 2, Symbolic 4, Script 8, Italic 64, ForceBold 1<<18). */
  flags?: number;
  /** Descriptor /FontWeight, or PDFium's FPDFText_GetFontWeight (derived from /StemV; ≤ 0 means unknown). */
  weight?: number;
  stemV?: number;
  /** Descriptor /ItalicAngle, degrees (negative leans right). */
  italicAngle?: number;
  /** Descriptor /FontStretch (UltraCondensed … UltraExpanded). */
  fontStretch?: string;
  /** Descriptor /XHeight, /CapHeight, /Ascent, /Descent, /AvgWidth: glyph space, 1/1000 em. */
  xHeight?: number;
  capHeight?: number;
  ascent?: number;
  descent?: number;
  avgWidth?: number;
  /** 10 PANOSE bytes (descriptor /Style /Panose minus its 2-byte sFamilyClass, or OS/2). */
  panose?: number[];
  fixedPitch?: boolean;
  /** From the embedded program, when it is TrueType/OpenType (readSfntInfo). */
  upem?: number;
  os2?: Os2Info;
  hhea?: { ascender: number; descender: number; lineGap: number };
  /** Advance widths by character, 1/1000 em (the font's /W or /Widths read through its ToUnicode). */
  widths?: Record<string, number>;
  /** What the new text needs: 'latn' (default) or 'jpan' (it holds kana or kanji). */
  script?: 'latn' | 'jpan';
};

export type SourceStyle = {
  /** The cleaned name (no subset prefix or CMap). */
  name: string;
  /** The well-known font the name was recognised as (alias table), if any. */
  recognised?: string;
  classification: Classification;
  weight: number;
  width: number;             // percent (100 normal)
  italic: boolean;
  fixed: boolean;
  symbolic: boolean;
  xHeight?: number;          // 1/1000 em
};

export type Suggestion = {
  family: FamilyId;
  name: string;
  /** The font file to load (fonts/<file>). */
  file: string;
  /** Axis coordinates for a variable file (wght, and wdth when narrowed). */
  variations?: Record<string, number>;
  weight: number;
  width: number;
  /** The file is an italic face. */
  italic: boolean;
  /** Italic was wanted and the family has none: slant it with the text matrix (about 12°) or leave upright. */
  synthesizeItalic: boolean;
  /** 0–1, higher is better; comparable within one call. */
  score: number;
  /** metric: reproduces the original's widths (Arimo for Arial); alias: named for this font; similar: by style. */
  match: 'metric' | 'alias' | 'similar';
  reasons: string[];
};

export type SuggestOptions = {
  /** How many suggestions (default 5). */
  limit?: number;
  /** Only files the app can load: a set of file names, or a predicate. */
  available?: ReadonlySet<string> | ((file: string) => boolean);
  /** Only these catalog tiers (default: all). */
  tiers?: Tier[];
};

// ---------------------------------------------------------------------------------------------------------------
// Names

/** A font name from a string or bytes: PDF #xx escapes undone; bytes (or a string of byte-valued characters) read
 *  as UTF-8 when valid, else Shift_JIS (Japanese producers write BaseFont in Shift_JIS), else Latin-1. */
export function decodeFontName(input: string | Uint8Array): string {
  let bytes: Uint8Array | null = null;
  if (typeof input === 'string') {
    let s = input;
    if (/#[0-9A-Fa-f]{2}/.test(s)) s = s.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
    bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
  } else bytes = input;
  for (const enc of ['utf-8', 'shift_jis']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch { /* next */ }
  }
  return String.fromCharCode(...bytes);
}

export type ParsedName = {
  /** The name without subset prefix, CMap suffix or style suffix, NFKC-folded. */
  base: string;
  /** Lowercase letters, digits and CJK of `base` plus the style suffix: what the alias table matches. */
  key: string;
  tokens: string[];
  weight?: number;
  width?: number;
  italic: boolean;
};

const CMAP_TOKENS = new Set(['h', 'v', 'identity', '90ms', '90msp', '90pv', '83pv', '78', '78ms', 'add', 'ext', 'nwp', 'euc', 'rksj',
  'unijis', 'unijis2004', 'unijisx0213', 'unijisx02132004', 'unijispro', 'ucs2', 'utf8', 'utf16', 'utf32', 'hw', 'hankaku']);

const WEIGHT_WORDS: Record<string, number> = {
  thin: 100, hairline: 100, extrathin: 100, ultrathin: 100,
  extralight: 200, ultralight: 200, xlight: 200,
  light: 300, lt: 300,
  semilight: 350, demilight: 350,
  regular: 400, normal: 400, book: 400, roman: 400, plain: 400, reg: 400, rg: 400,
  medium: 500, med: 500, md: 500,
  semibold: 600, demibold: 600, demi: 600, debold: 600, sb: 600, sbold: 600,
  bold: 700, bd: 700,
  extrabold: 800, ultrabold: 800, xbold: 800, xb: 800,
  black: 900, heavy: 900, hv: 900, blk: 900, ultra: 900, extrablack: 950, ultrablack: 950, ub: 900,
  // Japanese
  '太字': 700, 'ボールド': 700, '細字': 300,
};
/** Weight letter codes as whole tokens (ShinGoPro-DB, RodinPro-EB). */
const LETTER_CODES: Record<string, number> = { l: 300, r: 400, m: 500, d: 600, db: 600, b: 700, eb: 800, h: 900, u: 900 };
/** HG suffixes: M is the regular weight, E extra bold. */
const HG_CODES: Record<string, number> = { l: 300, m: 400, db: 600, b: 700, e: 800, eb: 800, ub: 900, u: 900 };
const W_NUMBER: Record<number, number> = { 0: 100, 1: 200, 2: 250, 3: 350, 4: 400, 5: 500, 6: 600, 7: 700, 8: 800, 9: 900, 10: 900, 11: 950, 12: 950 };
const WIDTH_WORDS: Record<string, number> = {
  ultracondensed: 50, extracondensed: 62.5, xcondensed: 62.5, compressed: 62.5,
  condensed: 75, cond: 75, cn: 75, narrow: 82, narr: 82, compact: 82,
  semicondensed: 87.5, semicond: 87.5,
  semiexpanded: 112.5, semiextended: 112.5,
  expanded: 125, extended: 125, wide: 125, exp: 125,
  extraexpanded: 150, extraextended: 150, ultraexpanded: 200, ultraextended: 200,
};
const ITALIC_WORDS = new Set(['italic', 'oblique', 'it', 'ital', 'obl', 'inclined', 'slanted', 'kursiv', 'ita']);
const JOINERS = new Set(['semi', 'demi', 'de', 'extra', 'ultra', 'x']);

/** Split a name into tokens on separators and case changes (TimesNewRomanPS-BoldMT → Times New Roman PS Bold MT). */
function tokenize(s: string): string[] {
  const spaced = s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([　-鿿])([A-Za-z])/g, '$1 $2');
  const raw = spaced.split(/[\s\-_,+.]+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (JOINERS.has(t.toLowerCase()) && i + 1 < raw.length) { out.push(t + raw[++i]); continue; }
    out.push(t);
  }
  return out;
}

/** Parse a BaseFont: clean it and read the weight, width and slant its name states. */
export function parseFontName(input: string | Uint8Array): ParsedName {
  let s = decodeFontName(input).normalize('NFKC').trim();
  s = s.replace(/^[A-Z]{6}\+/, '');
  let style = '';
  const comma = s.indexOf(',');
  if (comma >= 0) { style = s.slice(comma + 1); s = s.slice(0, comma); }
  // a Type0 BaseFont ends with its CMap (KozMinPr6N-Regular-Identity-H, Ryumin-Light-83pv-RKSJ-H)
  const parts = s.split('-');
  let cut = parts.length;
  while (cut > 1 && CMAP_TOKENS.has(parts[cut - 1].toLowerCase())) cut--;
  if (cut < parts.length && parts.slice(cut).some((p) => /^(h|v|identity)$/i.test(p))) s = parts.slice(0, cut).join('-');
  s = s.replace(/^A-OTF[\s-]*/i, '').trim();
  const base = s;
  const tokens = tokenize(`${base} ${style}`);
  const lower = tokens.map((t) => t.toLowerCase());
  const isHg = /^HG[SP]?/i.test(base);

  let weight: number | undefined;
  let width: number | undefined;
  let italic = false;
  for (let i = 0; i < lower.length; i++) {
    const t = lower[i];
    if (i === 0 && !/^(bold|black|light|thin|heavy|medium)$/.test(t)) {
      // the family's first token is never a style ('Book Antiqua', 'Ultra' families aside)
      if (ITALIC_WORDS.has(t) || t in WIDTH_WORDS) continue;
      if (tokens.length > 1) continue;
    }
    if (t in WEIGHT_WORDS) weight = WEIGHT_WORDS[t];
    else if (/^w(\d{1,2})$/.test(t)) weight = W_NUMBER[Number(t.slice(1))] ?? weight;
    else if (/^m[ab](31|1)$/.test(t)) weight = t.endsWith('31') ? 700 : 800;          // Midashi MB31 / MA1
    else if (isHg && t in HG_CODES && i === lower.length - 1) weight = HG_CODES[t];
    else if (!isHg && t in LETTER_CODES && tokens[i] === tokens[i].toUpperCase()) weight = LETTER_CODES[t];
    if (t in WIDTH_WORDS) {
      width = WIDTH_WORDS[t];
      const n = Number(lower[i + 1]);
      if (n >= 50 && n < 100) width = n;                                                 // Condensed 80
    }
    if (ITALIC_WORDS.has(t)) italic = true;
  }
  // a weight glued to a Japanese family name: HGゴシックE, HGP創英角ゴシックUB, 見出ゴMB31
  const glued = /[぀-ヿ㐀-鿿](UB|EB|DB|[LMBEUHR])(?:-?PRO)?$/i.exec(base);
  if (weight === undefined && glued) weight = (isHg ? HG_CODES : LETTER_CODES)[glued[1].toLowerCase()];
  const key = `${base}${style}`.toLowerCase().replace(/[^a-z0-9぀-ヿ㐀-鿿+]/g, '');
  return { base, key, tokens, weight, width, italic };
}

// ---------------------------------------------------------------------------------------------------------------
// The alias table

export type Alias = {
  re: RegExp;
  label: string;
  cls: Classification;
  /** Families for Latin text, best first. */
  latn: FamilyId[];
  /** Families for Japanese text (default: those of `latn` that cover Japanese, then the class default). */
  jpan?: FamilyId[];
  /** latn[0] reproduces the original's advance widths. */
  metric?: boolean;
  /** jpan[0] reproduces the original's advance widths, kana and kanji included (IPAGothic for MS Gothic). */
  metricJpan?: boolean;
  weight?: number;
  width?: number;
  fixed?: boolean;
  symbolic?: boolean;
};

const SANS_JP = ['noto-sans-jp', 'zen-kaku-gothic-new', 'ibm-plex-sans-jp'];
const SERIF_JP = ['noto-serif-jp', 'zen-old-mincho', 'shippori-mincho'];
const ROUND_JP = ['zen-maru-gothic', 'mplus-rounded-1c', 'kosugi-maru'];

/** Ordered: the first match wins, so specific names come before the families they start with. */
export const ALIASES: readonly Alias[] = [
  // symbol fonts: no text substitute
  { re: /^(?:symbol|zapfdingbats|dingbats|wingdings|webdings|segoeui(?:symbol|emoji)|marlett|msoutlook|mtextra)/, label: 'symbol font', cls: 'display', latn: [], symbolic: true },
  // --- Japanese system and Office fonts
  { re: /^ms(?:ui|pui)?(?:gothic|ゴシック)ui|^msuigothic|^msuiゴシック/, label: 'MS UI Gothic', cls: 'sans', latn: ['biz-udpgothic', 'noto-sans-jp'] },
  { re: /^msp(?:gothic|ゴシック)/, label: 'MS PGothic', cls: 'sans', latn: ['biz-udpgothic', 'noto-sans-jp'] },
  { re: /^ms(?:gothic|ゴシック)/, label: 'MS Gothic', cls: 'sans', latn: ['biz-udgothic', 'noto-sans-jp'], jpan: ['ipa-gothic', 'biz-udgothic', 'noto-sans-jp'], metricJpan: true, fixed: true },
  { re: /^msp(?:mincho|明朝)/, label: 'MS PMincho', cls: 'serif', latn: ['biz-udpmincho', 'noto-serif-jp'] },
  { re: /^ms(?:mincho|明朝)/, label: 'MS Mincho', cls: 'serif', latn: ['biz-udmincho', 'noto-serif-jp'], jpan: ['ipa-mincho', 'biz-udmincho', 'noto-serif-jp'], fixed: true },
  { re: /^(?:meiryo|メイリオ)/, label: 'Meiryo', cls: 'sans', latn: ['noto-sans-jp', 'biz-udpgothic'] },
  { re: /^(?:yugo(?:thic|th)?|游ゴシック)/, label: 'Yu Gothic', cls: 'sans', latn: SANS_JP },
  { re: /^(?:yumin(?:cho)?|游明朝)/, label: 'Yu Mincho', cls: 'serif', latn: SERIF_JP },
  { re: /^(?:hira(?:gino)?kaku|hiraginosans|ヒラギノ角ゴ)/, label: 'Hiragino Kaku Gothic', cls: 'sans', latn: ['noto-sans-jp', 'ibm-plex-sans-jp', 'zen-kaku-gothic-new'] },
  { re: /^(?:hira(?:gino)?min|hiraginoserif|ヒラギノ明朝)/, label: 'Hiragino Mincho', cls: 'serif', latn: SERIF_JP },
  { re: /^(?:hira(?:gino)?maru|ヒラギノ丸ゴ)/, label: 'Hiragino Maru Gothic', cls: 'rounded', latn: ROUND_JP },
  // --- Kozuka, Ryumin, Shin Go and similar
  { re: /^(?:koz(?:uka)?go|小塚ゴシック)/, label: 'Kozuka Gothic', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-new'] },
  { re: /^(?:koz(?:uka)?min|小塚明朝)/, label: 'Kozuka Mincho', cls: 'serif', latn: ['noto-serif-jp', 'zen-old-mincho'] },
  { re: /^(?:sourcehansans|notosanscjk|notosansjp|源ノ角ゴシック)/, label: 'Source Han Sans', cls: 'sans', latn: ['noto-sans-jp'] },
  { re: /^(?:sourcehanserif|notoserifcjk|notoserifjp|源ノ明朝)/, label: 'Source Han Serif', cls: 'serif', latn: ['noto-serif-jp'] },
  // --- Midashi, Shin Go Pro, UD Shin Go and similar
  { re: /^(?:bizud)?(?:udshinmarugo|udshinmgo|ud新丸ゴ)/, label: 'UD Shin Maru Go', cls: 'rounded', latn: ROUND_JP },
  { re: /^(?:bizud)?(?:udshingo|ud新ゴ)/, label: 'UD Shin Go', cls: 'sans', latn: ['biz-udpgothic', 'noto-sans-jp'] },
  { re: /^(?:bizud)?(?:udreimin|ud黎ミン)/, label: 'UD Reimin', cls: 'serif', latn: ['biz-udpmincho', 'noto-serif-jp'] },
  { re: /^(?:uddigi(?:tal)?kyokasho|udデジタル教科書|ud教科書)/, label: 'UD Digi Kyokasho', cls: 'script', latn: ['klee-one', 'biz-udpmincho'] },
  { re: /^bizudp(?:gothic|ゴシック)/, label: 'BIZ UDPGothic', cls: 'sans', latn: ['biz-udpgothic'] },
  { re: /^bizud(?:gothic|ゴシック)/, label: 'BIZ UDGothic', cls: 'sans', latn: ['biz-udgothic'], fixed: true },
  { re: /^bizudp(?:mincho|明朝)/, label: 'BIZ UDPMincho', cls: 'serif', latn: ['biz-udpmincho'] },
  { re: /^bizud(?:mincho|明朝)/, label: 'BIZ UDMincho', cls: 'serif', latn: ['biz-udmincho'], fixed: true },
  { re: /^(?:shinmarugo|shinmgo|新丸ゴ)/, label: 'Shin Maru Go', cls: 'rounded', latn: ROUND_JP },
  { re: /^(?:shingo|新ゴ)/, label: 'Shin Go', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-new'] },
  { re: /^(?:midashigo|見出ゴ)/, label: 'Midashi Go', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-antique'], weight: 700 },
  { re: /^(?:midashimin|見出ミン)/, label: 'Midashi Min', cls: 'serif', latn: ['noto-serif-jp', 'zen-old-mincho'], weight: 700 },
  { re: /^(?:gothicmb101|ゴシックmb101)/, label: 'Gothic MB101', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-antique'] },
  { re: /^(?:futogo|太ゴ)/, label: 'Futo Go B101', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-antique'], weight: 800 },
  { re: /^(?:futomin|太ミン)/, label: 'Futo Min A101', cls: 'serif', latn: ['noto-serif-jp', 'zen-old-mincho'], weight: 800 },
  { re: /^(?:ryumin|リュウミン)/, label: 'Ryumin', cls: 'serif', latn: ['noto-serif-jp', 'shippori-mincho', 'zen-old-mincho'] },
  { re: /^(?:jun\d{2,3}|じゅん)/, label: 'Jun', cls: 'rounded', latn: ROUND_JP },
  // --- Rodin, Heisei, IPA, Takao
  { re: /^(?:fot)?(?:rodin|ロダン)/, label: 'Rodin', cls: 'sans', latn: ['noto-sans-jp', 'mplus-1'] },
  { re: /^(?:fot)?(?:matisse|マティス)/, label: 'Matisse', cls: 'serif', latn: ['noto-serif-jp', 'zen-old-mincho'] },
  { re: /^(?:heisei)?(?:marugo|丸ゴ)|^平成丸ゴ/, label: 'Maru Gothic', cls: 'rounded', latn: ROUND_JP },
  { re: /^(?:heisei(?:kaku)?go|平成角ゴ)/, label: 'Heisei Kaku Gothic', cls: 'sans', latn: ['noto-sans-jp'] },
  { re: /^(?:heiseimin|平成明朝)/, label: 'Heisei Mincho', cls: 'serif', latn: ['noto-serif-jp'] },
  { re: /^(?:ipa|takao)(?:ex)?p(?:gothic|ゴシック)/, label: 'IPA / IPAex PGothic', cls: 'sans', latn: ['biz-udpgothic', 'noto-sans-jp'] },
  { re: /^(?:ipa|takao)(?:gothic|ゴシック)/, label: 'IPA Gothic', cls: 'sans', latn: ['biz-udgothic', 'noto-sans-jp'], jpan: ['ipa-gothic', 'biz-udgothic'], metricJpan: true, fixed: true },
  { re: /^(?:ipa|takao)(?:mincho|明朝)/, label: 'IPA Mincho', cls: 'serif', latn: ['biz-udmincho', 'noto-serif-jp'], jpan: ['ipa-mincho', 'biz-udmincho'], metricJpan: true, fixed: true },
  { re: /^(?:ipa|takao)ex(?:gothic|ゴシック)/, label: 'IPAex Gothic', cls: 'sans', latn: ['noto-sans-jp', 'biz-udgothic'] },
  { re: /^(?:ipa|takao)(?:ex)?p?(?:mincho|明朝)/, label: 'IPAex / IPA P Mincho', cls: 'serif', latn: ['noto-serif-jp', 'biz-udpmincho'] },
  // --- HG fonts
  { re: /^hg[sp]?(?:soeikakugothic|創英角ゴシック)/, label: 'HG Soei Kaku Gothic', cls: 'sans', latn: ['noto-sans-jp', 'zen-kaku-gothic-antique'], weight: 900 },
  { re: /^hg[sp]?(?:soeikakupop|創英角ポップ|.*pop|.*ポップ)/, label: 'HG Soei Kaku Pop', cls: 'display', latn: ['mplus-rounded-1c', 'zen-maru-gothic'], weight: 800 },
  { re: /^hg[sp]?(?:soeipresence|創英プレゼンス)/, label: 'HG Soei Presence', cls: 'serif', latn: ['noto-serif-jp', 'zen-old-mincho'], weight: 800 },
  { re: /^hg[sp]?(?:marugothic|丸ゴシック)/, label: 'HG Maru Gothic', cls: 'rounded', latn: ROUND_JP },
  { re: /^hg[sp]?(?:seikaisho|正楷書|kaisho|楷書|gyosho|行書|kyokasho|教科書)/, label: 'HG kaisho / kyokasho', cls: 'script', latn: ['klee-one'] },
  { re: /^hg[sp]?(?:gothic|ゴシック)/, label: 'HG Gothic', cls: 'sans', latn: ['noto-sans-jp', 'biz-udpgothic'] },
  { re: /^hg[sp]?(?:mincho|明朝)/, label: 'HG Mincho', cls: 'serif', latn: ['noto-serif-jp', 'biz-udpmincho'] },
  // --- the catalog's own families, under their own names
  { re: /^(?:mplusrounded|roundedm\+|roundedmplus)/, label: 'M PLUS Rounded', cls: 'rounded', latn: ['mplus-rounded-1c'] },
  { re: /^(?:mplus|m\+)/, label: 'M PLUS', cls: 'sans', latn: ['mplus-1'] },
  { re: /^ibmplexsansjp/, label: 'IBM Plex Sans JP', cls: 'sans', latn: ['ibm-plex-sans-jp'] },
  { re: /^zenkakugothicnew/, label: 'Zen Kaku Gothic New', cls: 'sans', latn: ['zen-kaku-gothic-new'] },
  { re: /^zenkakugothicantique/, label: 'Zen Kaku Gothic Antique', cls: 'sans', latn: ['zen-kaku-gothic-antique'] },
  { re: /^zenmarugothic/, label: 'Zen Maru Gothic', cls: 'rounded', latn: ['zen-maru-gothic'] },
  { re: /^zenoldmincho/, label: 'Zen Old Mincho', cls: 'serif', latn: ['zen-old-mincho'] },
  { re: /^shipporimincho/, label: 'Shippori Mincho', cls: 'serif', latn: ['shippori-mincho', 'zen-old-mincho'] },
  { re: /^lineseed/, label: 'LINE Seed', cls: 'sans', latn: ['line-seed-jp'] },
  { re: /^kosugimaru/, label: 'Kosugi Maru', cls: 'rounded', latn: ['kosugi-maru'] },
  { re: /^kosugi/, label: 'Kosugi', cls: 'sans', latn: ['noto-sans-jp'] },
  { re: /^kleeone/, label: 'Klee One', cls: 'script', latn: ['klee-one'] },
  { re: /^sawarabigothic/, label: 'Sawarabi Gothic', cls: 'sans', latn: ['noto-sans-jp'] },
  { re: /^sawarabimincho/, label: 'Sawarabi Mincho', cls: 'serif', latn: ['noto-serif-jp'] },
  { re: /^notosansmono/, label: 'Noto Sans Mono', cls: 'mono', latn: ['noto-sans-mono'] },
  { re: /^notoserif/, label: 'Noto Serif', cls: 'serif', latn: ['noto-serif'] },
  { re: /^notosans/, label: 'Noto Sans', cls: 'sans', latn: ['noto-sans'] },
  { re: /^opensans/, label: 'Open Sans', cls: 'sans', latn: ['open-sans'] },
  { re: /^sourcesans/, label: 'Source Sans', cls: 'sans', latn: ['source-sans-3'] },
  { re: /^sourceserif/, label: 'Source Serif', cls: 'serif', latn: ['source-serif-4'] },
  { re: /^selawik/, label: 'Selawik', cls: 'sans', latn: ['selawik'] },
  { re: /^carlito/, label: 'Carlito', cls: 'sans', latn: ['carlito'], metric: true },
  { re: /^caladea/, label: 'Caladea', cls: 'serif', latn: ['caladea'], metric: true },
  { re: /^gelasio/, label: 'Gelasio', cls: 'serif', latn: ['gelasio'], metric: true },
  { re: /^jost/, label: 'Jost', cls: 'sans', latn: ['jost'] },
  // --- Western: metric-compatible first (fontconfig 30-metric-aliases.conf)
  { re: /^(?:arialnarrow|liberationsansnarrow|helvetica(?:neue)?(?:lt)?(?:std|pro|com)?(?:narrow|cond(?:ensed)?)|helveticanarrow|nimbussansnarrow|nimbussanscondensed)/, label: 'Arial Narrow', cls: 'sans', latn: ['noto-sans'], metric: true, width: 82 },
  { re: /^arialblack/, label: 'Arial Black', cls: 'sans', latn: ['noto-sans', 'arimo'], weight: 900 },
  { re: /^arialrounded/, label: 'Arial Rounded', cls: 'rounded', latn: ['mplus-rounded-1c', 'zen-maru-gothic'], weight: 700 },
  { re: /^arialunicode/, label: 'Arial Unicode MS', cls: 'sans', latn: ['arimo', 'noto-sans'], jpan: ['noto-sans-jp'] },
  { re: /^(?:arial|liberationsans|arimo|albany)/, label: 'Arial', cls: 'sans', latn: ['arimo', 'noto-sans'], metric: true },
  { re: /^helveticaneue/, label: 'Helvetica Neue', cls: 'sans', latn: ['arimo', 'noto-sans'] },
  { re: /^(?:helvetica|helv|nimbussans|texgyreheros|swiss721)/, label: 'Helvetica', cls: 'sans', latn: ['arimo', 'noto-sans'], metric: true },
  { re: /^(?:timesnewroman|times|tmsrmn|nimbusroman|texgyretermes|liberationserif|tinos|thorndale)/, label: 'Times New Roman', cls: 'serif', latn: ['tinos', 'noto-serif'], metric: true },
  { re: /^(?:couriernew|courier|nimbusmono|texgyrecursor|liberationmono|cousine|cumberland)/, label: 'Courier New', cls: 'mono', latn: ['cousine', 'noto-sans-mono'], metric: true },
  { re: /^calibri/, label: 'Calibri', cls: 'sans', latn: ['carlito', 'source-sans-3', 'noto-sans'], metric: true },
  { re: /^cambria/, label: 'Cambria', cls: 'serif', latn: ['caladea', 'noto-serif'], metric: true },
  { re: /^georgia/, label: 'Georgia', cls: 'serif', latn: ['gelasio', 'noto-serif'], metric: true },
  { re: /^segoeui/, label: 'Segoe UI', cls: 'sans', latn: ['selawik', 'open-sans', 'noto-sans'], metric: true },
  { re: /^(?:verdana|tahoma|dejavusans(?!mono)|bitstreamverasans(?!mono)|lucidagrande|lucidasans(?!typewriter|unicode))/, label: 'Verdana', cls: 'sans', latn: ['open-sans', 'noto-sans'] },
  { re: /^(?:consolas|inconsolata)/, label: 'Consolas', cls: 'mono', latn: ['inconsolata', 'cousine', 'noto-sans-mono'] },
  { re: /^(?:menlo|monaco|dejavusansmono|bitstreamverasansmono|lucidaconsole|lucidatypewriter|sfmono|andalemono)/, label: 'monospace', cls: 'mono', latn: ['noto-sans-mono', 'cousine'] },
  { re: /^(?:ebgaramond|garamond|adobegaramond|agaramond|itcgaramond|stempelgaramond|garamondpremier)/, label: 'Garamond', cls: 'serif', latn: ['eb-garamond', 'noto-serif'] },
  { re: /^minion/, label: 'Minion', cls: 'serif', latn: ['source-serif-4', 'noto-serif'] },
  { re: /^(?:myriad|frutiger|gillsans|optima|trebuchet|candara|corbel)/, label: 'humanist sans', cls: 'sans', latn: ['source-sans-3', 'noto-sans', 'open-sans'] },
  { re: /^(?:futura|centurygothic|avantgarde|itcavantgarde|urwgothic|texgyreadventor|gotham|montserrat)/, label: 'geometric sans', cls: 'sans', latn: ['jost', 'noto-sans'] },
  { re: /^(?:centuryschoolbook|newcenturyschlbk|newcenturyschoolbook|century|bookmanoldstyle|bookman|bookantiqua|palatino|pala|constantia)/, label: 'book serif', cls: 'serif', latn: ['noto-serif', 'source-serif-4', 'tinos'] },
  { re: /^roboto/, label: 'Roboto', cls: 'sans', latn: ['noto-sans', 'open-sans'] },
];

function findAlias(key: string): Alias | undefined {
  return ALIASES.find((a) => a.re.test(key));
}

/** Classification by words in the name, for names the alias table does not know. */
function classFromName(key: string, tokens: string[]): Classification | undefined {
  const t = new Set(tokens.map((x) => x.toLowerCase()));
  if (/mono|courier|consol|typewriter|code|fixed/.test(key)) return 'mono';
  if (/maru|rounded|丸/.test(key)) return 'rounded';
  if (/kyokasho|kaisho|gyosho|教科書|楷書|行書|brush|script|hand/.test(key)) return 'script';
  if (/pop|ポップ/.test(key)) return 'display';
  if (/mincho|明朝|ミン|serif|antiqua|garamond|baskerville|bodoni|caslon|didot|century/.test(key) || t.has('min')) return 'serif';
  if (/gothic|goth|ゴシック|角ゴ|sans|grotesk|grotesque|kakugo/.test(key) || t.has('go')) return 'sans';
  return undefined;
}

/** Classification from PANOSE (Latin text family) and OS/2 sFamilyClass. */
function classFromPanose(p: number[] | undefined): Classification | undefined {
  if (!p || p.length < 4 || p[0] !== 2) return undefined;
  if (p[3] === 9) return 'mono';
  if (p[1] >= 11 && p[1] <= 13) return 'sans';
  if (p[1] === 15) return 'rounded';
  if (p[1] >= 2 && p[1] <= 10) return 'serif';
  return undefined;
}
function classFromFamilyClass(c: number | undefined): Classification | undefined {
  if (c === undefined || c <= 0) return undefined;
  if (c >= 1 && c <= 7) return 'serif';
  if (c === 8) return 'sans';
  if (c === 10) return 'script';
  if (c === 9) return 'display';
  return undefined;
}

const US_WIDTH: Record<number, number> = { 1: 50, 2: 62.5, 3: 75, 4: 87.5, 5: 100, 6: 112.5, 7: 125, 8: 150, 9: 200 };

/** PDFium's weight from /StemV (CPDF_Font::GetFontWeight). */
export function weightFromStemV(stemV: number): number {
  return stemV < 140 ? stemV * 5 : stemV * 4 + 140;
}

/** What the source font is: classification, weight, width, slant, pitch and x-height, from every input given. */
export function describeSource(info: SourceFontInfo): SourceStyle {
  const parsed = parseFontName(info.name);
  let alias = findAlias(parsed.key);
  if (!alias && info.familyName) alias = findAlias(parseFontName(info.familyName).key);
  const flags = info.flags ?? 0;
  const panose = info.panose ?? info.os2?.panose;
  const classification = alias?.cls ?? classFromName(parsed.key, parsed.tokens) ?? classFromPanose(panose)
    ?? classFromFamilyClass(info.os2?.familyClass)
    ?? ((flags & 1) ? 'mono' : (flags & 2) ? 'serif' : (flags & 8) ? 'script' : 'sans');

  let weight = parsed.weight ?? alias?.weight;
  if (weight === undefined && info.os2?.weightClass && info.os2.weightClass >= 1 && info.os2.weightClass <= 1000) {
    weight = info.os2.weightClass < 10 ? info.os2.weightClass * 100 : info.os2.weightClass;   // a few fonts write 1–9
  }
  if (weight === undefined && info.weight !== undefined && info.weight > 0) weight = info.weight;
  if (weight === undefined && info.stemV !== undefined && info.stemV > 0) weight = weightFromStemV(info.stemV);
  if (weight === undefined && panose && panose[0] === 2 && panose[2] >= 2 && panose[2] <= 11) weight = [100, 200, 300, 400, 500, 600, 700, 800, 900, 950][panose[2] - 2];
  weight ??= 400;
  if (flags & (1 << 18)) weight = Math.max(weight, 700);
  weight = Math.min(1000, Math.max(1, Math.round(weight)));

  let width = parsed.width ?? alias?.width;
  if (width === undefined && info.os2?.widthClass) width = US_WIDTH[info.os2.widthClass];
  if (width === undefined && info.fontStretch) width = WIDTH_WORDS[info.fontStretch.toLowerCase()] ?? (/^normal$/i.test(info.fontStretch) ? 100 : undefined);
  if (width === undefined && panose && panose[0] === 2) width = ({ 5: 125, 6: 75, 7: 150, 8: 62.5 } as Record<number, number>)[panose[3]];
  width ??= 100;

  const italic = parsed.italic || (flags & 64) !== 0 || (info.italicAngle !== undefined && Math.abs(info.italicAngle) >= 3)
    || ((info.os2?.fsSelection ?? 0) & 1) !== 0;
  const fixed = alias?.fixed ?? (classification === 'mono' || (flags & 1) !== 0 || info.fixedPitch === true || (panose?.[0] === 2 && panose[3] === 9));

  let xHeight: number | undefined;
  if (info.xHeight && info.xHeight > 0) xHeight = info.xHeight;
  else if (info.os2?.xHeight && info.upem) xHeight = (info.os2.xHeight / info.upem) * 1000;

  return {
    name: parsed.base, recognised: alias?.label, classification, weight, width, italic, fixed,
    symbolic: alias?.symbolic ?? false, ...(xHeight ? { xHeight } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Scoring

const CLASS_COST: Record<Classification, Record<Classification, number>> = {
  sans: { sans: 0, rounded: 0.8, display: 1.2, mono: 1.6, serif: 2.2, script: 2.4 },
  serif: { serif: 0, script: 1.4, display: 1.6, mono: 1.8, sans: 2.2, rounded: 2.6 },
  mono: { mono: 0, sans: 1.4, serif: 1.8, rounded: 1.8, display: 2, script: 2.4 },
  rounded: { rounded: 0, sans: 0.7, display: 1, mono: 1.8, serif: 2.4, script: 2.4 },
  script: { script: 0, serif: 1, display: 1.4, rounded: 1.6, sans: 1.8, mono: 2.4 },
  display: { display: 0, sans: 0.8, rounded: 0.8, serif: 1, script: 1.2, mono: 1.8 },
};

/** The generic family per class and script: the choice when nothing but the style is known. */
const DEFAULTS: Record<'latn' | 'jpan', Record<Classification, FamilyId>> = {
  latn: { sans: 'noto-sans', serif: 'noto-serif', mono: 'noto-sans-mono', rounded: 'zen-maru-gothic', script: 'klee-one', display: 'noto-sans' },
  jpan: { sans: 'noto-sans-jp', serif: 'noto-serif-jp', mono: 'biz-udgothic', rounded: 'zen-maru-gothic', script: 'klee-one', display: 'noto-sans-jp' },
};

const range = (w: number | [number, number]): [number, number] => (Array.isArray(w) ? w : [w, w]);

/** The weight to use for a family: CSS font matching order (W3C CSS Fonts §5.2) over what its files offer. */
export function nearestWeight(achievable: [number, number][], target: number): number {
  const cands = new Set<number>();
  for (const [a, b] of achievable) cands.add(Math.min(b, Math.max(a, target)));
  const list = [...cands];
  if (list.includes(target)) return target;
  const above = list.filter((w) => w > target).sort((a, b) => a - b);
  const below = list.filter((w) => w < target).sort((a, b) => b - a);
  if (target >= 400 && target <= 500) {
    const upTo500 = above.filter((w) => w <= 500);
    if (upTo500.length) return upTo500[0];
    if (below.length) return below[0];
    return above[0];
  }
  if (target < 400) return below[0] ?? above[0];
  return above[0] ?? below[0];
}

/** Lowercase-weighted mean advance over the characters both sides have; null when there are too few. */
function widthRatio(src: Record<string, number>, cand: number[]): { ratio: number; n: number } | null {
  const order = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = 0, c = 0, n = 0;
  for (let i = 0; i < order.length; i++) {
    const w = src[order[i]];
    if (!(w > 0) || !(cand[i] > 0)) continue;
    s += w; c += cand[i]; n++;
  }
  return n >= 3 ? { ratio: s / c, n } : null;
}

/** How much a wdth coordinate scales advances, from the measured ratio at the axis minimum (linear in between;
 *  advances scale less than the coordinate: Noto Sans at wdth 62.5 keeps 74% of its advance). */
function advanceFactor(axis: [number, number], condensedRatio: number | undefined, wdth: number): number {
  if (wdth >= 100 || axis[0] >= 100) return 1;
  const cr = condensedRatio ?? axis[0] / 100;
  return 1 - ((1 - cr) * (100 - wdth)) / (100 - axis[0]);
}
/** The wdth coordinate whose advances are `factor` of the normal width's, clamped to the axis. */
function wdthFor(axis: [number, number], condensedRatio: number | undefined, factor: number): number {
  if (axis[0] >= 100) return 100;
  const cr = condensedRatio ?? axis[0] / 100;
  const w = 100 - ((1 - factor) / (1 - cr)) * (100 - axis[0]);
  return Math.round(Math.min(100, Math.max(axis[0], w)) * 10) / 10;
}

type Instance = { file: FontFileSpec; weight: number; width: number; italic: boolean; variations?: Record<string, number> };

/** The file and coordinates of a family for a weight, width and slant. `widthScale` asks a wdth axis to scale
 *  advances by that factor (measured widths), else the nominal width is matched. */
function instanceOf(f: Family, weight: number, width: number, italic: boolean): Instance {
  const pool = f.files.filter((x) => x.italic === italic);
  const files = pool.length ? pool : f.files.filter((x) => !x.italic);
  const usable = files.length ? files : f.files;
  const w = nearestWeight(usable.map((x) => range(x.weight)), weight);
  // among files offering that weight, the one whose width is nearest
  let best = usable[0], bestD = Infinity;
  for (const x of usable) {
    const [a, b] = range(x.weight);
    if (w < a || w > b) continue;
    const [wa, wb] = range(x.width ?? 100);
    const d = Math.abs(Math.min(wb, Math.max(wa, width)) - width);
    if (d < bestD) { best = x; bestD = d; }
  }
  const [wa, wb] = range(best.width ?? 100);
  const wd = Math.min(wb, Math.max(wa, width));
  const variations: Record<string, number> = {};
  if (Array.isArray(best.weight)) variations.wght = w;
  if (Array.isArray(best.width) && wd !== 100) variations.wdth = wd;
  return { file: best, weight: w, width: wd, italic: best.italic, ...(Object.keys(variations).length ? { variations } : {}) };
}

/**
 * The best substitutes for a document font, best first. A symbol font gives none (keep the document's font or ask
 * the user). Families that do not cover the script the new text needs are left out.
 */
export function suggestSubstitutes(info: SourceFontInfo, opts: SuggestOptions = {}): Suggestion[] {
  const src = describeSource(info);
  if (src.symbolic) return [];
  const script = info.script ?? 'latn';
  const alias = findAlias(parseFontName(info.name).key) ?? (info.familyName ? findAlias(parseFontName(info.familyName).key) : undefined);
  // Latin text set from a fixed-pitch Japanese font (MS Gothic's half-width Latin) reads better proportional
  const wantFixed = script === 'jpan' ? src.fixed : src.classification === 'mono';
  const swap = (id: FamilyId): FamilyId => {
    const f = CATALOG.find((x) => x.id === id);
    return f && f.pitch === 'fixed' && f.proportional && !wantFixed ? f.proportional : id;
  };
  let listed = alias ? (script === 'jpan' ? alias.jpan ?? alias.latn : alias.latn).map(swap) : [];
  listed = listed.filter((id, i) => listed.indexOf(id) === i);
  const available = opts.available;
  const isAvailable = (file: string): boolean => !available ? true : typeof available === 'function' ? available(file) : available.has(file);

  const scored: (Suggestion & { cost: number })[] = [];
  for (const f of CATALOG) {
    if (!f.scripts.includes(script)) continue;
    if (opts.tiers && !opts.tiers.includes(f.tier)) continue;
    const reasons: string[] = [];
    let cost = 0;

    const rank = listed.indexOf(f.id);
    if (rank >= 0) { cost += 0.3 * rank; reasons.push(`named for ${alias!.label}`); }
    else if (alias) cost += 1.2;
    else cost += 0.25;                                                   // an unrecognised name: every choice is a guess
    // by style alone, the generic family of the class comes first (Noto Sans, not Arimo, for an unknown sans)
    if (rank < 0 && DEFAULTS[script][src.classification] !== f.id) cost += 0.1;
    const metric = rank === 0 && (script === 'latn' ? alias?.metric : alias?.metricJpan) === true;
    if (metric) reasons.push(`metric-compatible with ${alias!.label}`);

    const cc = CLASS_COST[src.classification][f.classification];
    cost += cc;
    if (cc === 0) reasons.push(`${f.classification} like the original`);

    if (wantFixed !== (f.pitch === 'fixed')) cost += src.classification === 'mono' || script === 'jpan' ? 0.8 : 0.4;

    let inst = instanceOf(f, src.weight, src.width, src.italic);
    // measured widths: steer a wdth axis to the source's advances, and cost the remaining difference
    const m = f.metrics;
    const measured = info.widths && m ? widthRatio(info.widths, m.widths) : null;
    if (measured && !metric) {
      const boldK = m!.boldRatio && inst.weight > 400 ? 1 + (m!.boldRatio - 1) * Math.min(1, (inst.weight - 400) / 300) : 1;
      let r = measured.ratio / boldK;                                    // source over candidate at 400, wdth 100
      const axis = Array.isArray(inst.file.width) ? inst.file.width : null;
      if (axis && r < 1) {
        // a wdth axis: ask for the width whose advances close the gap
        inst = instanceOf(f, src.weight, wdthFor(axis, m!.condensedRatio, r), src.italic);
        r = r / advanceFactor(axis, m!.condensedRatio, inst.width);
      }
      cost += Math.abs(Math.log(r)) * 3;
      reasons.push(`widths ${Math.round(r * 100)}% of the original`);
    } else if (!metric) {
      cost += (Math.abs(inst.width - src.width) / 12.5) * 0.3;
    }

    cost += (Math.abs(inst.weight - src.weight) / 100) * 0.35;
    if (inst.weight === src.weight) reasons.push(`weight ${inst.weight}`);

    const synth = src.italic && !inst.italic;
    if (synth) cost += script === 'latn' ? 0.5 : 0.1;

    if (src.xHeight && m) {
      cost += (Math.abs(src.xHeight - m.xHeight) / 1000) * 6;
      if (Math.abs(src.xHeight - m.xHeight) <= 25) reasons.push('x-height close');
    }
    if (script === 'latn' && f.scripts.includes('jpan') && rank < 0) cost += 0.15;
    if (f.tier === 'extended') cost += 0.05;

    if (!isAvailable(inst.file.file)) continue;
    scored.push({
      family: f.id, name: f.name, file: inst.file.file, ...(inst.variations ? { variations: inst.variations } : {}),
      weight: inst.weight, width: inst.width, italic: inst.italic, synthesizeItalic: synth,
      score: Math.round((1 / (1 + cost)) * 1000) / 1000, match: metric ? 'metric' : rank >= 0 ? 'alias' : 'similar',
      reasons, cost,
    });
  }
  scored.sort((a, b) => a.cost - b.cost || a.family.localeCompare(b.family));
  return scored.slice(0, opts.limit ?? 5).map(({ cost: _c, ...s }) => s);
}

// ---------------------------------------------------------------------------------------------------------------
// The embedded program

/** The numbers the matcher reads from an embedded TrueType/OpenType program (FontFile2, or FontFile3/OpenType):
 *  head unitsPerEm, hhea, OS/2 and post. Null when the bytes are not an sfnt (a bare CFF or Type 1 program). */
export function readSfntInfo(bytes: Uint8Array): Pick<SourceFontInfo, 'upem' | 'os2' | 'hhea' | 'italicAngle' | 'fixedPitch' | 'panose'> | null {
  if (bytes.length < 12) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = v.getUint32(0);
  if (tag !== 0x00010000 && tag !== 0x4f54544f /* OTTO */ && tag !== 0x74727565 /* true */) return null;
  const n = v.getUint16(4);
  const tables = new Map<string, { off: number; len: number }>();
  for (let i = 0; i < n; i++) {
    const p = 12 + i * 16;
    if (p + 16 > bytes.length) break;
    const name = String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    tables.set(name, { off: v.getUint32(p + 8), len: v.getUint32(p + 12) });
  }
  const t = (name: string, min: number) => {
    const e = tables.get(name);
    return e && e.len >= min && e.off + min <= bytes.length ? e : undefined;
  };
  const out: ReturnType<typeof readSfntInfo> & object = {};
  const head = t('head', 54);
  if (head) out.upem = v.getUint16(head.off + 18);
  const hhea = t('hhea', 10);
  if (hhea) out.hhea = { ascender: v.getInt16(hhea.off + 4), descender: v.getInt16(hhea.off + 6), lineGap: v.getInt16(hhea.off + 8) };
  const post = t('post', 16);
  if (post) { out.italicAngle = v.getInt32(post.off + 4) / 65536; out.fixedPitch = v.getUint32(post.off + 12) !== 0; }
  const os2 = t('OS/2', 68);
  if (os2) {
    const o = os2.off;
    const version = v.getUint16(o);
    const panose = Array.from(bytes.subarray(o + 32, o + 42));
    out.os2 = {
      avgCharWidth: v.getInt16(o + 2), weightClass: v.getUint16(o + 4), widthClass: v.getUint16(o + 6), fsType: v.getUint16(o + 8),
      familyClass: v.getInt16(o + 30) >> 8, panose, fsSelection: v.getUint16(o + 62),
    };
    if (version >= 2 && os2.len >= 90) { out.os2.xHeight = v.getInt16(o + 86); out.os2.capHeight = v.getInt16(o + 88); }
    if (panose.some((x) => x !== 0)) out.panose = panose;
  }
  return out;
}

/** The 10 PANOSE bytes of a CIDFont descriptor's /Style /Panose string (12 bytes: sFamilyClass, then PANOSE). */
export function panoseFromStyle(bytes: Uint8Array | number[]): number[] | undefined {
  const a = Array.from(bytes);
  return a.length >= 12 ? a.slice(2, 12) : a.length === 10 ? a : undefined;
}
