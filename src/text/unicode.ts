// Character classes used by shaping (script runs) and layout (kinsoku, justification).

export type ScriptClass = 'latin' | 'cjk' | 'common';

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Hangul}]/u;
const HIRA_RE = /\p{Script=Hiragana}/u;
const KANA_RE = /\p{Script=Katakana}/u;
const HANGUL_RE = /\p{Script=Hangul}/u;
const COMMON_RE = /[\p{Script=Common}\p{Script=Inherited}]/u;

/** Strong script class of a code point; Common/Inherited characters take their neighbours' script. */
export function scriptClass(cp: number): ScriptClass {
  const ch = String.fromCodePoint(cp);
  if (CJK_RE.test(ch)) return 'cjk';
  if (COMMON_RE.test(ch)) return 'common';
  return 'latin';
}

/** ISO 15924 script for a strong CJK code point, for the HarfBuzz buffer. */
export function cjkScript(cp: number): string {
  const ch = String.fromCodePoint(cp);
  if (HIRA_RE.test(ch)) return 'Hira';
  if (KANA_RE.test(ch)) return 'Kana';
  if (HANGUL_RE.test(ch)) return 'Hang';
  return 'Hani';
}

/** Characters that take part in CJK inter-character justification: CJK letters plus full-width forms and CJK
 *  punctuation (U+3000–303F, U+FF00–FFEF), which are Common script. */
export function isCjkChar(cp: number): boolean {
  if ((cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef) || (cp >= 0x30a0 && cp <= 0x30ff)) return true;
  return scriptClass(cp) === 'cjk';
}

/** Latin inter-word spaces stretched by justification. */
export function isLatinSpace(cp: number): boolean {
  return cp === 0x20 || cp === 0xa0;
}

export function isWhitespace(cp: number): boolean {
  return cp === 0x20 || cp === 0x09 || cp === 0xa0 || cp === 0x3000 || isLineBreakChar(cp) || (cp >= 0x2000 && cp <= 0x200a);
}

/** Characters that end a line and are never drawn. */
export function isLineBreakChar(cp: number): boolean {
  return cp === 0x0a || cp === 0x0b || cp === 0x0c || cp === 0x0d || cp === 0x85 || cp === 0x2028 || cp === 0x2029;
}

// JLReq / CSS line-break: strict. Characters not allowed at the start of a line (行頭禁則).
const NO_START = new Set(
  Array.from(
    // closing brackets and quotes
    '）〕］｝〉》」』】〙〗｠」’”»›)]}' +
      // terminal and middle punctuation, iteration marks, prolonged sound mark, small kana
      '、。，．,.・：；:;？！?!‼⁇⁈⁉‐゠–〜～ーヽヾゝゞ々〻' +
      'ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ' +
      'ｧｨｩｪｫｯｬｭｮｰ｡､･' +
      // units that follow a number
      '%％‰℃°′″',
  ).map((c) => c.codePointAt(0)!),
);

// Characters not allowed at the end of a line (行末禁則).
const NO_END = new Set(Array.from('（〔［｛〈《「『【〘〖｟‘“«‹([{＄￥＃＠$¥£€#').map((c) => c.codePointAt(0)!));

export function noLineStart(cp: number): boolean {
  return NO_START.has(cp);
}

export function noLineEnd(cp: number): boolean {
  return NO_END.has(cp);
}

// Vertical text (縦書き). Characters set upright in a column: CJK letters and punctuation, full-width forms, and the
// symbol blocks whose Unicode Vertical_Orientation is U (enclosed alphanumerics, geometric shapes, miscellaneous
// symbols, enclosed CJK and compatibility, ※, §). Everything else (Latin, digits, ASCII punctuation, spaces) forms
// runs that are set sideways (rotated 90° clockwise), except a run of one or two letters or digits, which stays
// upright (第3四半期, A4).
function uprightChar(cp: number): boolean {
  if (isCjkChar(cp) || isLineBreakChar(cp)) return true;
  return (cp >= 0x2460 && cp <= 0x24ff) || (cp >= 0x25a0 && cp <= 0x27bf) || (cp >= 0x3200 && cp <= 0x33ff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || cp === 0x203b || cp === 0xa7 || cp === 0xb6 || (cp >= 0x2e80 && cp <= 0x2fff);
}

const ALNUM_RE = /^[\p{L}\p{N}]$/u;

/** Orientation of each UTF-16 code unit of `text` in vertical writing: true = upright, false = sideways. A
 *  sideways run is the maximal run of characters that are not upright by nature; when its text without leading and
 *  trailing whitespace is one or two letters or digits, that core is upright (its edge spaces stay sideways). */
export function verticalUpright(text: string): boolean[] {
  const out: boolean[] = new Array(text.length).fill(true);
  const cps: { i: number; n: number; cp: number }[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    cps.push({ i, n, cp });
    i += n;
  }
  for (let k = 0; k < cps.length; ) {
    if (uprightChar(cps[k].cp)) { k++; continue; }
    let e = k;
    while (e < cps.length && !uprightChar(cps[e].cp)) e++;
    let a = k, b = e;
    while (a < b && isWhitespace(cps[a].cp)) a++;
    while (b > a && isWhitespace(cps[b - 1].cp)) b--;
    const core = cps.slice(a, b);
    const upright = core.length >= 1 && core.length <= 2 && core.every((c) => ALNUM_RE.test(String.fromCodePoint(c.cp)));
    for (let j = k; j < e; j++) {
      const up = upright && j >= a && j < b;
      for (let u = 0; u < cps[j].n; u++) out[cps[j].i + u] = up;
    }
    k = e;
  }
  return out;
}
