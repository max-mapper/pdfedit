// Font choices for export:
//   (a) which Unicode values a document's own font can show (from its ToUnicode CMap), so export can say whether an
//       edited run could have stayed in the document font (for translated text it rarely can);
//   (b) which shipped face substitutes for a run (Noto Sans / Noto Sans JP, 400 or 700; serif and italic are not
//       shipped, so they fall back to the upright sans and are flagged);
//   (c) resolving a FontRef naming a shipped face to a loaded Face, one Face per id so FontWriter shares fonts.

import { PDFName, PDFStream } from 'pdf-lib';
import type { PdfEdit } from '../pdf/edit.ts';
import { decodeStream } from '../pdf/edit.ts';
import { pageFontDict, resolve } from '../pdf/fonts.ts';
import { parseToUnicode } from '../pdf/textdecode.ts';
import { loadFace, type Face } from '../text/face.ts';
import type { FontRef, Run } from '../model/types.ts';

// ---------------------------------------------------------------------------------------------------------------
// (a) ToUnicode CMaps and document-font coverage

export { parseToUnicode };

/** The single code points a code → text map shows. A code that maps to several characters (a ligature, an expanded
 *  form) does not make any of them available on its own, so such entries are left out. */
export function coverageOf(map: Map<number, string>): Set<number> {
  const s = new Set<number>();
  for (const v of map.values()) {
    const cps = [...v];
    if (cps.length === 1) s.add(cps[0].codePointAt(0)!);
  }
  return s;
}

/**
 * The set of Unicode values the page's font resource `resourceName` can show, from its ToUnicode CMap. Only Type0
 * fonts with the Identity-H or Identity-V encoding are read; any other font, or one without a ToUnicode stream,
 * gives null (coverage unknown).
 */
export function documentFontCoverage(edit: PdfEdit, page: number, resourceName: string): Set<number> | null {
  const ctx = edit.context;
  const font = pageFontDict(ctx, edit.doc.getPage(page).node, resourceName);
  const subtype = resolve(ctx, font.get(PDFName.of('Subtype')));
  const enc = resolve(ctx, font.get(PDFName.of('Encoding')));
  if (!(subtype instanceof PDFName) || subtype.decodeText() !== 'Type0') return null;
  if (!(enc instanceof PDFName) || !/^Identity-[HV]$/.test(enc.decodeText())) return null;
  const tu = resolve(ctx, font.get(PDFName.of('ToUnicode')));
  if (!(tu instanceof PDFStream)) return null;
  return coverageOf(parseToUnicode(decodeStream(ctx, tu, `ToUnicode of /${resourceName}`)));
}

/** What of `text` (whitespace aside) a coverage set lacks. */
export function missingFrom(coverage: Set<number>, text: string): string[] {
  const miss = new Set<string>();
  for (const ch of text) if (!/\s/u.test(ch) && !coverage.has(ch.codePointAt(0)!)) miss.add(ch);
  return [...miss];
}

// ---------------------------------------------------------------------------------------------------------------
// (b) substitution

/** Kana, CJK ideographs (BMP and astral), CJK symbols and punctuation, fullwidth forms, Hangul. */
const CJK = /[⺀-㏿㐀-䶿一-鿿가-힯豈-﫿︰-﹏＀-￯\u{20000}-\u{3FFFF}]/u;

export type SubstituteFlag = 'serif-not-shipped' | 'italic-not-shipped';
export type Substitute = { id: string; family: 'NotoSans' | 'NotoSansJP'; weight: 400 | 700; flags: SubstituteFlag[] };

/**
 * The shipped face for a run, by class: Noto Sans JP for any run with CJK text (so mixed runs stay in one face),
 * otherwise Noto Sans; weight 700 for bold runs, else 400. Serif and italic faces are not shipped: the run falls
 * back to the upright sans and the result says so.
 */
export function pickSubstitute(run: Pick<Run, 'text' | 'bold' | 'italic'> & { font?: Pick<FontRef, 'bold' | 'italic' | 'serif'> }): Substitute {
  const bold = run.bold || !!run.font?.bold;
  const italic = run.italic || !!run.font?.italic;
  const flags: SubstituteFlag[] = [];
  if (run.font?.serif) flags.push('serif-not-shipped');
  if (italic) flags.push('italic-not-shipped');
  const family = CJK.test(run.text) ? 'NotoSansJP' : 'NotoSans';
  const weight = bold ? 700 : 400;
  const id = family === 'NotoSansJP' ? `NotoSansJP:${weight}` : weight === 700 ? 'NotoSans-Bold' : 'NotoSans-Regular';
  return { id, family, weight, flags };
}

// ---------------------------------------------------------------------------------------------------------------
// (c) shipped faces

export type ShippedSpec = { id: string; file: string; variations?: Record<string, number> };

/**
 * The file and instance behind a shipped face id. Accepted: 'NotoSans-Regular', 'NotoSans-Bold', 'NotoSans:400',
 * 'NotoSans:700', 'NotoSansJP:<wght>' (100–900), 'NotoSansJP-Regular', 'NotoSansJP-Bold'. The returned id is the
 * canonical one (faces are cached on it).
 */
export function shippedSpec(name: string): ShippedSpec {
  const n = name.trim();
  if (/^NotoSans(-Regular|:400)?$/.test(n)) return { id: 'NotoSans-Regular', file: 'NotoSans-Regular.ttf' };
  if (/^NotoSans(-Bold|:700)$/.test(n)) return { id: 'NotoSans-Bold', file: 'NotoSans-Bold.ttf' };
  let m = /^NotoSansJP:(\d{3})$/.exec(n);
  let w = m ? Number(m[1]) : NaN;
  m = /^NotoSansJP(?:-(Regular|Bold))?$/.exec(n);
  if (m) w = m[1] === 'Bold' ? 700 : 400;
  if (w >= 100 && w <= 900) return { id: `NotoSansJP:${w}`, file: 'NotoSansJP-VF.ttf', variations: { wght: w } };
  throw new Error(`no shipped face '${name}' (shipped: Noto Sans 400/700, Noto Sans JP 100–900)`);
}

/** A FontRef → Face resolver over the shipped files, loading each face once. HarfBuzz must be loaded. `read` gives
 *  a font file's bytes by file name (Node: from fonts/; a browser: from its own origin). */
export function shippedFaces(read: (file: string) => Uint8Array): (font: FontRef) => Face {
  const files = new Map<string, Uint8Array>();
  const faces = new Map<string, Face>();
  return (font) => {
    if (font.source !== 'shipped') throw new Error(`font '${font.name}' is the document's own, not a shipped face`);
    const spec = shippedSpec(font.name);
    let f = faces.get(spec.id);
    if (!f) {
      let bytes = files.get(spec.file);
      if (!bytes) files.set(spec.file, (bytes = read(spec.file)));
      f = loadFace(bytes, spec.variations ? { variations: spec.variations } : {});
      faces.set(spec.id, f);
    }
    return f;
  };
}

/** Node only: shippedFaces reading from the repository's fonts/ directory (or `dir`). */
export async function nodeShippedFaces(dir?: string): Promise<(font: FontRef) => Face> {
  const fsName = 'node:fs';
  const fs = (await import(/* @vite-ignore */ fsName)) as { readFileSync(p: string | URL): Uint8Array };
  const base = dir ? (dir.endsWith('/') ? dir : dir + '/') : new URL('../../fonts/', import.meta.url);
  return shippedFaces((file) => new Uint8Array(fs.readFileSync(typeof base === 'string' ? base + file : new URL(file, base))));
}

