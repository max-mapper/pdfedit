// A font face at fixed variation coordinates: the HarfBuzz font used for shaping plus the metrics the layout and
// the PDF font writer need. All metrics are in font units (upem) unless a name says otherwise.

import type { Font as HbFont } from 'harfbuzzjs';
import { hb } from './hb.ts';

export type AxisInfo = { tag: string; min: number; default: number; max: number };

export type Face = {
  /** Unique per loadFace() call; the font writer keys fonts on it. */
  id: number;
  upem: number;
  /** Ascender and descender (descent negative), from OS/2 typo metrics when USE_TYPO_METRICS is set, else hhea,
   *  with MVAR variations applied (HarfBuzz's horizontal font extents). */
  ascent: number;
  descent: number;
  lineGap: number;
  /** OS/2 sCapHeight (MVAR applied); 0.7 em when the table has none. */
  capHeight: number;
  /** post.italicAngle, degrees. */
  italicAngle: number;
  /** head xMin, yMin, xMax, yMax. */
  bbox: [number, number, number, number];
  /** name ID 16 (typographic family) or else 1. */
  familyName: string;
  /** A PostScript-style name for the instance, e.g. NotoSans-Regular, NotoSansJP-Bold. */
  postScriptName: string;
  /** wght coordinate for variable fonts, else OS/2 usWeightClass. */
  weight: number;
  italic: boolean;
  serif: boolean;
  fixedPitch: boolean;
  /** The variation coordinates in effect (every axis, defaults filled in). */
  variations: Record<string, number>;
  axes: AxisInfo[];
  /** The original font file, for subsetting. */
  bytes: Uint8Array;
  hbFont: HbFont;
  hasGlyph(cp: number): boolean;
  /** Nominal glyph for a code point, or undefined. */
  glyph(cp: number): number | undefined;
  /** Horizontal advance of a glyph, font units, variations applied. */
  advance(gid: number): number;
  /** OS/2 sTypoAscender / sTypoDescender (descent negative): the design em box, whose centre is the axis of
   *  vertical text. Absent when the font has no OS/2 table (ascent / descent are used then). */
  typoAscent?: number;
  typoDescent?: number;
  /** Set on the views verticalFace() and sidewaysFace() return: how glyphs of this face are set in vertical text.
   *  'vertical': upright in a column, written with an Identity-V font; 'sideways': rotated 90° clockwise, written
   *  with the base face's horizontal (Identity-H) font under a rotated text matrix. */
  orientation?: Orientation;
  /** The face a vertical or sideways view was made from. */
  base?: Face;
};

export type Orientation = 'vertical' | 'sideways';

let nextId = 1;

/**
 * Load a face. `variations` sets axis coordinates (e.g. `{ wght: 700 }`). Axes not given stay at their default,
 * except `wght`, which defaults to 400 when the axis covers it (Noto Sans JP VF's own default is 100, Thin).
 */
export function loadFace(bytes: Uint8Array, opts: { variations?: Record<string, number> } = {}): Face {
  const HB = hb();
  const data = new Uint8Array(bytes); // own copy: the caller's buffer may be reused
  const hbFace = new HB.Face(new HB.Blob(data));
  const font = new HB.Font(hbFace);

  const axes: AxisInfo[] = Object.values(hbFace.getAxisInfos()).map((a) => ({
    tag: a.tag,
    min: a.min,
    default: a.default,
    max: a.max,
  }));
  const variations: Record<string, number> = {};
  for (const a of axes) {
    let v = opts.variations?.[a.tag];
    if (v === undefined) v = a.tag === 'wght' && a.min <= 400 && a.max >= 400 ? 400 : a.default;
    variations[a.tag] = Math.min(a.max, Math.max(a.min, v));
  }
  for (const tag of Object.keys(opts.variations ?? {})) {
    if (!(tag in variations)) throw new Error(`loadFace: the font has no '${tag}' axis`);
  }
  if (axes.length) font.setVariations(axes.map((a) => new HB.Variation(a.tag, variations[a.tag])));

  const ext = font.hExtents();
  const cap = font.getMetricPosition(HB.MetricsTag.CAP_HEIGHT);
  const head = table(hbFace.referenceTable('head'));
  const post = table(hbFace.referenceTable('post'));
  const os2 = table(hbFace.referenceTable('OS/2'));
  const upem = hbFace.upem;

  const bbox: [number, number, number, number] = head
    ? [head.getInt16(36), head.getInt16(38), head.getInt16(40), head.getInt16(42)]
    : [0, Math.round(-0.2 * upem), upem, upem];
  const macStyle = head ? head.getUint16(44) : 0;
  const italicAngle = post ? post.getInt32(4) / 65536 : 0;
  const fixedPitch = post ? post.getUint32(12) !== 0 : false;
  const familyClass = os2 && os2.byteLength >= 32 ? os2.getInt16(30) >> 8 : 0;
  const weightClass = os2 && os2.byteLength >= 6 ? os2.getUint16(4) : 400;
  const typo = os2 && os2.byteLength >= 72 ? { typoAscent: os2.getInt16(68), typoDescent: os2.getInt16(70) } : {};
  const weight = variations.wght ?? weightClass;
  const italic = (macStyle & 2) !== 0 || italicAngle !== 0;

  const familyName = nameOf(hbFace, 16) || nameOf(hbFace, 1) || 'Unknown';
  const psName = axes.length
    ? `${sanitize(nameOf(hbFace, 25) || familyName)}-${weightName(weight)}${italic ? 'Italic' : ''}`
    : sanitize(nameOf(hbFace, 6) || `${familyName}-${weightName(weight)}`);

  const advCache = new Map<number, number>();
  return {
    id: nextId++,
    upem,
    ascent: ext.ascender,
    descent: ext.descender,
    lineGap: ext.lineGap,
    capHeight: cap !== undefined && cap > 0 ? cap : Math.round(0.7 * upem),
    italicAngle,
    bbox,
    familyName,
    postScriptName: psName,
    weight,
    italic,
    serif: familyClass >= 1 && familyClass <= 7 && familyClass !== 6,
    fixedPitch,
    variations,
    axes,
    bytes: data,
    hbFont: font,
    ...typo,
    hasGlyph: (cp) => {
      const g = font.glyph(cp);
      return g !== undefined && g !== 0;
    },
    glyph: (cp) => {
      const g = font.glyph(cp);
      return g === 0 ? undefined : g;
    },
    advance: (gid) => {
      let a = advCache.get(gid);
      if (a === undefined) {
        a = font.glyphHAdvance(gid);
        advCache.set(gid, a);
      }
      return a;
    },
  };
}

/** A glyph's width in PDF glyph space (1000 units per em), as written to /W and used by the emitter. */
export function pdfWidth(face: Face, gid: number): number {
  return Math.round((face.advance(gid) * 1000 * 100) / face.upem) / 100;
}

// ---------------------------------------------------------------------------------------------------------------
// Vertical text

const views = new WeakMap<Face, { vertical?: Face; sideways?: Face }>();

/** The face whose glyphs a view draws (the face itself when it is not a view). */
export function baseFace(face: Face): Face {
  return face.base ?? face;
}

/** A view of the face for upright glyphs in vertical text (one per face, so its id is stable): the font writer
 *  writes it as an Identity-V font with /W2 metrics, and emit() stacks its glyphs down a column. */
export function verticalFace(face: Face): Face {
  return view(baseFace(face), 'vertical');
}

/** A view of the face for sideways glyphs in vertical text (Latin rotated 90° clockwise): written with the base
 *  face's horizontal font, under a rotated text matrix. */
export function sidewaysFace(face: Face): Face {
  return view(baseFace(face), 'sideways');
}

function view(base: Face, orientation: Orientation): Face {
  let v = views.get(base);
  if (!v) views.set(base, (v = {}));
  let f = v[orientation];
  if (!f) {
    f = { ...base, id: nextId++, orientation, base };
    v[orientation] = f;
  }
  return f;
}

/** The centre of the face's design em box above the baseline, font units: where the axis of a vertical column
 *  passes through an upright glyph, and the line sideways glyphs are centred on. 380 for Noto Sans JP (880, -120). */
export function emCenter(face: Face): number {
  const f = baseFace(face);
  const a = f.typoAscent ?? f.ascent;
  const d = f.typoDescent ?? f.descent;
  return a > d ? (a + d) / 2 : (f.ascent + f.descent) / 2;
}

export type VMetrics = {
  /** Vertical advance, font units, positive (down the column). From vmtx (HarfBuzz), else one em. */
  advance: number;
  /** The position vector from the glyph's horizontal origin to its vertical origin (PDF /W2 vx, vy), font units:
   *  vx is half the horizontal advance (the glyph is centred on the column's axis), vy puts the font's em box
   *  centre in the middle of the vertical advance (880 for Noto Sans JP, its ideographic em box top). */
  vx: number;
  vy: number;
};

const vCache = new WeakMap<Face, Map<number, VMetrics>>();

/** Vertical metrics of a glyph (the same numbers the font writer puts in /W2 and emit() positions with). */
export function vMetrics(face: Face, gid: number): VMetrics {
  const f = baseFace(face);
  let m = vCache.get(f);
  if (!m) vCache.set(f, (m = new Map()));
  let v = m.get(gid);
  if (!v) {
    let advance = Math.abs(f.hbFont.glyphVAdvance(gid));
    if (!advance) advance = f.upem;
    v = { advance, vx: f.advance(gid) / 2, vy: emCenter(f) + advance / 2 };
    m.set(gid, v);
  }
  return v;
}

/** A glyph's vertical metrics in PDF glyph space (1000 units per em), as written to /W2: w1y (negative: down),
 *  and the position vector (vx, vy). vx is exactly half the /W width, so a glyph whose vy and w1y equal /DW2 needs
 *  no /W2 entry. */
export function pdfVMetrics(face: Face, gid: number): { w1y: number; vx: number; vy: number } {
  const f = baseFace(face);
  const v = vMetrics(f, gid);
  const k = 1000 / f.upem;
  const r2 = (n: number) => Math.round(n * k * 100) / 100;
  return { w1y: -r2(v.advance), vx: pdfWidth(f, gid) / 2, vy: r2(v.vy) };
}

function table(bytes: Uint8Array | undefined): DataView | null {
  return bytes && bytes.byteLength ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
}

function nameOf(face: { getName(id: number, lang: string): string }, id: number): string {
  try {
    return face.getName(id, 'en').trim();
  } catch {
    return '';
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '') || 'Font';
}

function weightName(w: number): string {
  const names: [number, string][] = [
    [150, 'Thin'],
    [250, 'ExtraLight'],
    [350, 'Light'],
    [450, 'Regular'],
    [550, 'Medium'],
    [650, 'SemiBold'],
    [750, 'Bold'],
    [850, 'ExtraBold'],
  ];
  for (const [limit, name] of names) if (w < limit) return name;
  return 'Black';
}
