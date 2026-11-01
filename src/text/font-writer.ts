// Writes the faces used by new text into a PDF as Type0 / CIDFontType2 fonts: one font per face per document,
// subset once at finish() with glyph IDs retained (so CID = GID, /CIDToGIDMap /Identity, /Encoding /Identity-H),
// variation axes pinned, a /W array from the face's advances, and a ToUnicode CMap from the shaping clusters.
//
// Vertical text: a face used vertically (use() with { vertical: true }, or a verticalFace() view) gets a second Type0
// font with /Encoding /Identity-V whose CIDFontType2 carries /DW2 and /W2 (vertical advances and position vectors,
// face.ts pdfVMetrics). Both orientations of a face share one subset program (FontFile2), its font descriptor and
// its ToUnicode CMap; each has its own descendant (only the vertical one has /W2). A sidewaysFace() view is written
// with the base face's horizontal font.

import { PDFArray, PDFName, PDFNumber, PDFString } from 'pdf-lib';
import type { PDFContext, PDFDict, PDFRef } from 'pdf-lib';
import { baseFace, pdfVMetrics, pdfWidth } from './face.ts';
import type { Face } from './face.ts';
import { subsetFace } from './subset.ts';

type Entry = { key: string; face: Face; vertical: boolean; text: Map<number, string> };

export type FontWriterOptions = {
  /** Resource-name prefix for the keys: `${prefix}1`, `${prefix}2`, … Default 'PE'. */
  prefix?: string;
  /** Keep TrueType hinting instructions in the subsets. Default false (smaller files). */
  hinting?: boolean;
};

export class FontWriter {
  private readonly context: PDFContext;
  private readonly opts: FontWriterOptions;
  private readonly entries = new Map<string, Entry>();
  private finished = false;

  constructor(context: PDFContext, opts: FontWriterOptions = {}) {
    this.context = context;
    this.opts = opts;
  }

  /** Records glyphs (with the text each one stands for) for a face; returns its stable resource key. `vertical`
   *  (default: whether the face is a verticalFace() view) asks for the face's Identity-V font. */
  use(face: Face, glyphs: { gid: number; text: string }[], opts: { vertical?: boolean } = {}): string {
    if (this.finished) throw new Error('FontWriter: use() after finish()');
    const vertical = opts.vertical ?? face.orientation === 'vertical';
    const base = baseFace(face);
    const id = entryId(base, vertical);
    let e = this.entries.get(id);
    if (!e) {
      e = { key: `${this.opts.prefix ?? 'PE'}${this.entries.size + 1}`, face: base, vertical, text: new Map() };
      this.entries.set(id, e);
    }
    for (const g of glyphs) {
      const prev = e.text.get(g.gid);
      if (prev === undefined || (prev === '' && g.text !== '')) e.text.set(g.gid, g.text);
    }
    return e.key;
  }

  /** The key for a face already passed to use() (with the same orientation). */
  keyOf(face: Face, opts: { vertical?: boolean } = {}): string {
    const e = this.entries.get(entryId(baseFace(face), opts.vertical ?? face.orientation === 'vertical'));
    if (!e) throw new Error(`FontWriter: face ${face.postScriptName} was never used${face.orientation === 'vertical' ? ' vertically' : ''}`);
    return e.key;
  }

  /** Subsets every face and writes its font objects; returns key → ref of the Type0 font dictionary. */
  finish(): Record<string, PDFRef> {
    if (this.finished) throw new Error('FontWriter: finish() called twice');
    this.finished = true;
    const out: Record<string, PDFRef> = {};
    // the entries of one face (horizontal and vertical) share one subset
    const groups = new Map<number, Entry[]>();
    for (const e of this.entries.values()) {
      const g = groups.get(e.face.id);
      if (g) g.push(e);
      else groups.set(e.face.id, [e]);
    }
    for (const group of groups.values()) Object.assign(out, this.writeFonts(group));
    return out;
  }

  private writeFonts(group: Entry[]): Record<string, PDFRef> {
    const ctx = this.context;
    const face = group[0].face;
    const text = new Map<number, string>();
    for (const e of group) {
      for (const [g, t] of e.text) {
        const prev = text.get(g);
        if (prev === undefined || (prev === '' && t !== '')) text.set(g, t);
      }
    }
    const gids = [...text.keys()].sort((a, b) => a - b);
    const program = subsetFace(face, gids, { hinting: this.opts.hinting });
    const baseName = `${subsetTag(face, gids)}+${face.postScriptName}`;
    const k = 1000 / face.upem;
    const r = (n: number) => Math.round(n * k);

    const fontFile = ctx.flateStream(program, { Length1: program.length });
    const fontFileRef = ctx.register(fontFile);

    let flags = 4; // symbolic: glyphs are addressed by CID
    if (face.fixedPitch) flags |= 1;
    if (face.serif) flags |= 2;
    if (face.italic) flags |= 64;
    const descriptor = ctx.obj({
      Type: 'FontDescriptor',
      FontName: PDFName.of(baseName),
      Flags: flags,
      FontBBox: face.bbox.map(r),
      ItalicAngle: face.italicAngle,
      Ascent: r(face.ascent),
      Descent: r(face.descent),
      CapHeight: r(face.capHeight),
      StemV: face.weight >= 600 ? 140 : 80,
      FontFile2: fontFileRef,
    });
    const descriptorRef = ctx.register(descriptor);

    let toUnicodeRef: PDFRef | null = null;
    const out: Record<string, PDFRef> = {};
    for (const e of group) {
      const own = [...e.text.keys()].sort((a, b) => a - b);
      const widths = new Map(own.map((g) => [g, pdfWidth(face, g)] as const));
      const dw = mostCommon([...widths.values()]) ?? 1000;
      const cidFont = ctx.obj({
        Type: 'Font',
        Subtype: 'CIDFontType2',
        BaseFont: PDFName.of(baseName),
        CIDSystemInfo: ctx.obj({ Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 }),
        FontDescriptor: descriptorRef,
        DW: dw,
        W: buildW(ctx, widths, dw),
        CIDToGIDMap: 'Identity',
      });
      if (e.vertical) {
        const v = new Map(own.map((g) => [g, pdfVMetrics(face, g)] as const));
        const dw2 = mostCommonPair([...v.values()].map((m) => [m.vy, m.w1y] as [number, number])) ?? [880, -1000];
        cidFont.set(PDFName.of('DW2'), ctx.obj(dw2));
        const w2 = buildW2(ctx, v, dw2);
        if (w2.size()) cidFont.set(PDFName.of('W2'), w2);
      }
      const cidRef = ctx.register(cidFont);

      toUnicodeRef ??= ctx.register(ctx.flateStream(toUnicodeCMap(text)));

      const type0: PDFDict = ctx.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: PDFName.of(baseName),
        Encoding: e.vertical ? 'Identity-V' : 'Identity-H',
        DescendantFonts: [cidRef],
        ToUnicode: toUnicodeRef,
      });
      out[e.key] = ctx.register(type0);
    }
    return out;
  }
}

const entryId = (face: Face, vertical: boolean) => `${face.id}${vertical ? 'V' : 'H'}`;

/** /W2: the glyphs whose vertical metrics differ from /DW2 [vy w1y] (or whose vx is not half their width), as runs
 *  of consecutive CIDs `c [w1y vx vy …]`. */
export function buildW2(ctx: PDFContext, metrics: Map<number, { w1y: number; vx: number; vy: number }>, dw2: [number, number]): PDFArray {
  const arr = PDFArray.withContext(ctx);
  const gids = [...metrics.keys()].filter((g) => {
    const m = metrics.get(g)!;
    return m.vy !== dw2[0] || m.w1y !== dw2[1];
  }).sort((a, b) => a - b);
  let i = 0;
  while (i < gids.length) {
    let j = i;
    while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1) j++;
    const vals: number[] = [];
    for (let k = i; k <= j; k++) {
      const m = metrics.get(gids[k])!;
      vals.push(m.w1y, m.vx, m.vy);
    }
    arr.push(PDFNumber.of(gids[i]));
    arr.push(ctx.obj(vals));
    i = j + 1;
  }
  return arr;
}

function mostCommonPair(values: [number, number][]): [number, number] | undefined {
  const keyed = new Map<string, [number, number]>();
  for (const v of values) keyed.set(v.join(' '), v);
  const best = mostCommonKey(values.map((v) => v.join(' ')));
  return best === undefined ? undefined : keyed.get(best);
}

function mostCommonKey(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** /W: runs of consecutive CIDs as `c [w …]`, runs of ≥ 3 equal widths as `c1 c2 w`; widths equal to /DW omitted. */
export function buildW(ctx: PDFContext, widths: Map<number, number>, dw: number): PDFArray {
  const arr = PDFArray.withContext(ctx);
  const gids = [...widths.keys()].filter((g) => widths.get(g) !== dw).sort((a, b) => a - b);
  let i = 0;
  while (i < gids.length) {
    // a block of consecutive gids
    let j = i;
    while (j + 1 < gids.length && gids[j + 1] === gids[j] + 1) j++;
    let pending: number[] = [];
    let pendingStart = gids[i];
    const flushPending = () => {
      if (pending.length) {
        arr.push(PDFNumber.of(pendingStart));
        arr.push(ctx.obj(pending));
      }
      pending = [];
    };
    let a = i;
    while (a <= j) {
      let b = a;
      while (b + 1 <= j && widths.get(gids[b + 1]) === widths.get(gids[a])) b++;
      if (b - a + 1 >= 3) {
        flushPending();
        arr.push(PDFNumber.of(gids[a]));
        arr.push(PDFNumber.of(gids[b]));
        arr.push(PDFNumber.of(widths.get(gids[a])!));
      } else {
        if (!pending.length) pendingStart = gids[a];
        for (let c = a; c <= b; c++) pending.push(widths.get(gids[c])!);
      }
      a = b + 1;
    }
    flushPending();
    i = j + 1;
  }
  return arr;
}

/** A ToUnicode CMap mapping 2-byte CIDs (= GIDs) to UTF-16BE text. */
export function toUnicodeCMap(text: Map<number, string>): string {
  const entries = [...text.entries()].filter(([, t]) => t !== '').sort((a, b) => a[0] - b[0]);
  const lines = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
  ];
  for (let i = 0; i < entries.length; i += 100) {
    const chunk = entries.slice(i, i + 100);
    lines.push(`${chunk.length} beginbfchar`);
    for (const [gid, t] of chunk) lines.push(`<${hex4(gid)}> <${utf16beHex(t)}>`);
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
  return lines.join('\n') + '\n';
}

export function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

function utf16beHex(s: string): string {
  let h = '';
  for (let i = 0; i < s.length; i++) h += hex4(s.charCodeAt(i)); // JS strings are UTF-16: surrogates included
  return h;
}

function mostCommon(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  let best: number | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** Six capital letters, deterministic for the face and glyph set. */
function subsetTag(face: Face, gids: number[]): string {
  let h = 2166136261;
  const feed = (n: number) => {
    h ^= n & 0xff;
    h = Math.imul(h, 16777619) >>> 0;
  };
  for (const ch of face.postScriptName) feed(ch.charCodeAt(0));
  for (const g of gids) {
    feed(g);
    feed(g >> 8);
  }
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  }
  return tag;
}
