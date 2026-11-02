// The curated substitute catalog: open-licence TrueType families that can stand in for the fonts Japanese and
// Western business documents use, with what the matcher needs to choose between them (classification, weights,
// widths, scripts, pitch, measured metrics) and where each file comes from (pinned upstream sources, fetched by
// scripts/fetch-fonts.ts into fonts/, never at run time).
//
// Every family here is TrueType-outline (glyf), because export writes CIDFontType2 / FontFile2 only (PDFium has no
// FontFile3 path), and every licence allows embedding a subset in a PDF. No file is fetched from a font service at
// run time: the app serves the files from its own origin.
//
// Pure data and small helpers: no I/O, so the browser bundle and Node can both import it.

export type FamilyId = string;
/** Gothic = sans, mincho = serif, maru = rounded, kyokasho/kaisho = script. */
export type Classification = 'sans' | 'serif' | 'mono' | 'rounded' | 'script' | 'display';
/** ISO 15924: Latin, and Japanese (Han + kana). */
export type Script = 'latn' | 'jpan';
export type Licence = 'OFL-1.1' | 'Apache-2.0';
export type Tier = 'core' | 'extended';

/** Where a file comes from. `google` paths are relative to the google/fonts repository at GOOGLE_FONTS_COMMIT. */
export type Source =
  | { kind: 'google'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'zip'; url: string; member: string };

export type FontFileSpec = {
  /** File name in fonts/. */
  file: string;
  src: Source;
  /** Upstream size in bytes (the GitHub listing at the pinned commit), for download budgets. */
  bytes: number;
  /** A static weight, or the wght axis range of a variable file. */
  weight: number | [number, number];
  /** A static width (OS/2 usWidthClass as a percentage), or the wdth axis range of a variable file. Default 100. */
  width?: number | [number, number];
  italic: boolean;
  /** SHA-256 of the file as fetched; scripts/fetch-fonts.ts refuses a file that does not match. */
  sha256?: string;
};

/** Metrics of the regular (400, or nearest) upright instance at wdth 100, in 1/1000 em, measured from the files. */
export type FamilyMetrics = {
  xHeight: number;
  capHeight: number;
  ascent: number;
  descent: number;
  /** Advances of a–z, A–Z and 0–9 (62 numbers), 1/1000 em. */
  widths: number[];
  /** Advance of a–z at 700 over the same at 400 (how much bold widens the face), when a bold instance exists. */
  boldRatio?: number;
  /** Advance of a–z at the wdth axis minimum over the same at wdth 100 (advances scale about linearly between). */
  condensedRatio?: number;
};

export type Family = {
  id: FamilyId;
  name: string;
  classification: Classification;
  scripts: Script[];
  pitch: 'proportional' | 'fixed';
  /** The proportional sibling of a fixed-pitch family (BIZ UDGothic → BIZ UDPGothic), used for Latin text. */
  proportional?: FamilyId;
  licence: Licence;
  licenceSrc: Source;
  tier: Tier;
  /** Families whose advance widths this one reproduces (Arimo ↔ Arial): a substitute that keeps line breaks. */
  metricCompatible?: string[];
  files: FontFileSpec[];
  metrics?: FamilyMetrics;
  note?: string;
};

/** The google/fonts commit every `google` source is read at. */
export const GOOGLE_FONTS_COMMIT = '6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec';
const SELAWIK_COMMIT = '89362e84731d1f5777fa078fd4d5ebbd339e4378';
const TINOS_COMMIT = '3b4482a99b80ea5fc75f187b1be3120a3f5905b3';
const MPLUS_COMMIT = 'eb604901d6f04b6f7f2a84b0378c58df84a9dba6';   // google/fonts ofl/mplusrounded1c carries no OFL.txt

/** The download URL of a source (for zip: the archive's URL). */
export function sourceUrl(src: Source): string {
  if (src.kind !== 'google') return src.url;
  const path = src.path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/${path}`;
}

const g = (path: string): Source => ({ kind: 'google', path });
const ofl = (dir: string): Source => g(`ofl/${dir}/OFL.txt`);

/** Static files of one google/fonts family directory: [suffix, weight, italic, bytes]. */
function statics(dir: string, prefix: string, list: [string, number, boolean, number][], width?: number): FontFileSpec[] {
  return list.map(([suffix, weight, italic, bytes]) => ({
    file: `${prefix}-${suffix}.ttf`, src: g(`ofl/${dir}/${prefix}-${suffix}.ttf`), bytes, weight, italic,
    ...(width !== undefined ? { width } : {}),
  }));
}

const SELAWIK_ZIP = 'https://github.com/microsoft/Selawik/releases/download/1.01/Selawik_Release.zip';

export const CATALOG: Family[] = [
  // ---------------------------------------------------------------------------------------------------- Latin core
  {
    id: 'noto-sans', name: 'Noto Sans', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('notosans'), tier: 'core',
    files: [
      { file: 'NotoSans-VF.ttf', src: g('ofl/notosans/NotoSans[wdth,wght].ttf'), bytes: 2049096, weight: [100, 900], width: [62.5, 100], italic: false },
      { file: 'NotoSans-Italic-VF.ttf', src: g('ofl/notosans/NotoSans-Italic[wdth,wght].ttf'), bytes: 2322640, weight: [100, 900], width: [62.5, 100], italic: true },
    ],
    note: 'The generic sans; its wdth axis (62.5–100) stands in for condensed faces.',
  },
  {
    id: 'noto-serif', name: 'Noto Serif', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('notoserif'), tier: 'core',
    files: [
      { file: 'NotoSerif-VF.ttf', src: g('ofl/notoserif/NotoSerif[wdth,wght].ttf'), bytes: 1887192, weight: [100, 900], width: [62.5, 100], italic: false },
      { file: 'NotoSerif-Italic-VF.ttf', src: g('ofl/notoserif/NotoSerif-Italic[wdth,wght].ttf'), bytes: 2448496, weight: [100, 900], width: [62.5, 100], italic: true },
    ],
    note: 'The generic serif.',
  },
  {
    id: 'noto-sans-mono', name: 'Noto Sans Mono', classification: 'mono', scripts: ['latn'], pitch: 'fixed',
    licence: 'OFL-1.1', licenceSrc: ofl('notosansmono'), tier: 'core',
    files: [{ file: 'NotoSansMono-VF.ttf', src: g('ofl/notosansmono/NotoSansMono[wdth,wght].ttf'), bytes: 1708408, weight: [100, 900], width: [62.5, 100], italic: false }],
  },
  {
    id: 'arimo', name: 'Arimo', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('arimo'), tier: 'core', metricCompatible: ['Arial', 'Helvetica', 'Liberation Sans'],
    files: [
      { file: 'Arimo-VF.ttf', src: g('ofl/arimo/Arimo[wght].ttf'), bytes: 496268, weight: [400, 700], italic: false },
      { file: 'Arimo-Italic-VF.ttf', src: g('ofl/arimo/Arimo-Italic[wght].ttf'), bytes: 543196, weight: [400, 700], italic: true },
    ],
    note: 'Croscore; the same design and metrics as Liberation Sans 2.x.',
  },
  {
    id: 'tinos', name: 'Tinos', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: { kind: 'url', url: `https://raw.githubusercontent.com/googlefonts/tinos/${TINOS_COMMIT}/OFL.txt` }, tier: 'core',
    metricCompatible: ['Times New Roman', 'Times', 'Liberation Serif'],
    files: statics('tinos', 'Tinos', [['Regular', 400, false, 521588], ['Bold', 700, false, 597880], ['Italic', 400, true, 565016], ['BoldItalic', 700, true, 578976]]),
    note: 'Croscore; the same design and metrics as Liberation Serif 2.x.',
  },
  {
    id: 'cousine', name: 'Cousine', classification: 'mono', scripts: ['latn'], pitch: 'fixed',
    licence: 'OFL-1.1', licenceSrc: ofl('cousine'), tier: 'core', metricCompatible: ['Courier New', 'Courier', 'Liberation Mono'],
    files: statics('cousine', 'Cousine', [['Regular', 400, false, 296856], ['Bold', 700, false, 298048], ['Italic', 400, true, 306880], ['BoldItalic', 700, true, 308292]]),
  },
  {
    id: 'carlito', name: 'Carlito', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('carlito'), tier: 'core', metricCompatible: ['Calibri'],
    files: statics('carlito', 'Carlito', [['Regular', 400, false, 628032], ['Bold', 700, false, 682468], ['Italic', 400, true, 615236], ['BoldItalic', 700, true, 808508]]),
  },
  {
    id: 'caladea', name: 'Caladea', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('caladea'), tier: 'core', metricCompatible: ['Cambria'],
    files: statics('caladea', 'Caladea', [['Regular', 400, false, 81600], ['Bold', 700, false, 84492], ['Italic', 400, true, 83780], ['BoldItalic', 700, true, 83356]]),
  },
  {
    id: 'gelasio', name: 'Gelasio', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('gelasio'), tier: 'core', metricCompatible: ['Georgia'],
    files: [
      { file: 'Gelasio-VF.ttf', src: g('ofl/gelasio/Gelasio[wght].ttf'), bytes: 168556, weight: [400, 700], italic: false },
      { file: 'Gelasio-Italic-VF.ttf', src: g('ofl/gelasio/Gelasio-Italic[wght].ttf'), bytes: 174212, weight: [400, 700], italic: true },
    ],
  },
  {
    id: 'selawik', name: 'Selawik', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: { kind: 'url', url: `https://raw.githubusercontent.com/microsoft/Selawik/${SELAWIK_COMMIT}/LICENSE.txt` }, tier: 'core',
    metricCompatible: ['Segoe UI'],
    files: ([['selawkl', 300, 44232], ['selawksl', 350, 44260], ['selawk', 400, 44224], ['selawksb', 600, 44192], ['selawkb', 700, 44068]] as const).map(([m, w, b]) => ({
      file: `Selawik-${w}.ttf`, src: { kind: 'zip', url: SELAWIK_ZIP, member: `${m}.ttf` } as Source, bytes: b, weight: w, italic: false,
    })),
    note: 'Open replacement for Segoe UI (metrically compatible; no kerning, no italic).',
  },
  // ------------------------------------------------------------------------------------------------- Japanese core
  {
    id: 'noto-sans-jp', name: 'Noto Sans JP', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: { kind: 'url', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/LICENSE' }, tier: 'core',
    files: [{ file: 'NotoSansJP-VF.ttf', src: { kind: 'url', url: 'https://github.com/notofonts/noto-cjk/raw/main/Sans/Variable/TTF/Subset/NotoSansJP-VF.ttf' }, bytes: 9590732, weight: [100, 900], italic: false }],
    note: 'Source Han Sans for Japan (gothic). Already fetched by scripts/fetch-fonts.sh.',
  },
  {
    id: 'noto-serif-jp', name: 'Noto Serif JP', classification: 'serif', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('notoserifjp'), tier: 'core',
    files: [{ file: 'NotoSerifJP-VF.ttf', src: g('ofl/notoserifjp/NotoSerifJP[wght].ttf'), bytes: 13574352, weight: [200, 900], italic: false }],
    note: 'Source Han Serif for Japan (mincho).',
  },
  {
    id: 'biz-udgothic', name: 'BIZ UDGothic', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'fixed', proportional: 'biz-udpgothic',
    licence: 'OFL-1.1', licenceSrc: ofl('bizudgothic'), tier: 'core',
    files: statics('bizudgothic', 'BIZUDGothic', [['Regular', 400, false, 4667376], ['Bold', 700, false, 4638128]]),
    note: 'From TypeBank UD Gothic; half-width Latin, the shape of MS Gothic documents.',
  },
  {
    id: 'biz-udpgothic', name: 'BIZ UDPGothic', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('bizudpgothic'), tier: 'core',
    files: statics('bizudpgothic', 'BIZUDPGothic', [['Regular', 400, false, 4669688], ['Bold', 700, false, 4640596]]),
  },
  {
    id: 'biz-udmincho', name: 'BIZ UDMincho', classification: 'serif', scripts: ['jpan', 'latn'], pitch: 'fixed', proportional: 'biz-udpmincho',
    licence: 'OFL-1.1', licenceSrc: ofl('bizudmincho'), tier: 'core',
    files: statics('bizudmincho', 'BIZUDMincho', [['Regular', 400, false, 6153932], ['Bold', 700, false, 7107032]]),
    note: 'From TypeBank UD Mincho; half-width Latin, the shape of MS Mincho documents.',
  },
  {
    id: 'biz-udpmincho', name: 'BIZ UDPMincho', classification: 'serif', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('bizudpmincho'), tier: 'core',
    files: statics('bizudpmincho', 'BIZUDPMincho', [['Regular', 400, false, 6156444], ['Bold', 700, false, 7109432]]),
  },
  // ------------------------------------------------------------------------------------------------ Latin extended
  {
    id: 'source-sans-3', name: 'Source Sans 3', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('sourcesans3'), tier: 'extended',
    files: [
      { file: 'SourceSans3-VF.ttf', src: g('ofl/sourcesans3/SourceSans3[wght].ttf'), bytes: 646340, weight: [200, 900], italic: false },
      { file: 'SourceSans3-Italic-VF.ttf', src: g('ofl/sourcesans3/SourceSans3-Italic[wght].ttf'), bytes: 395372, weight: [200, 900], italic: true },
    ],
    note: 'Humanist sans: Myriad / Frutiger-like, and the Latin of Noto Sans JP.',
  },
  {
    id: 'source-serif-4', name: 'Source Serif 4', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('sourceserif4'), tier: 'extended',
    files: [
      { file: 'SourceSerif4-VF.ttf', src: g('ofl/sourceserif4/SourceSerif4[opsz,wght].ttf'), bytes: 1209508, weight: [200, 900], italic: false },
      { file: 'SourceSerif4-Italic-VF.ttf', src: g('ofl/sourceserif4/SourceSerif4-Italic[opsz,wght].ttf'), bytes: 855432, weight: [200, 900], italic: true },
    ],
    note: 'Text serif: Minion-like, and the Latin of Noto Serif JP.',
  },
  {
    id: 'open-sans', name: 'Open Sans', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('opensans'), tier: 'extended',
    files: [
      { file: 'OpenSans-VF.ttf', src: g('ofl/opensans/OpenSans[wdth,wght].ttf'), bytes: 532636, weight: [300, 800], width: [75, 100], italic: false },
      { file: 'OpenSans-Italic-VF.ttf', src: g('ofl/opensans/OpenSans-Italic[wdth,wght].ttf'), bytes: 583992, weight: [300, 800], width: [75, 100], italic: true },
    ],
    note: 'Wide humanist sans with a large x-height: the nearest open look for Verdana, Tahoma and Segoe.',
  },
  {
    id: 'eb-garamond', name: 'EB Garamond', classification: 'serif', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('ebgaramond'), tier: 'extended',
    files: [
      { file: 'EBGaramond-VF.ttf', src: g('ofl/ebgaramond/EBGaramond[wght].ttf'), bytes: 851176, weight: [400, 800], italic: false },
      { file: 'EBGaramond-Italic-VF.ttf', src: g('ofl/ebgaramond/EBGaramond-Italic[wght].ttf'), bytes: 754468, weight: [400, 800], italic: true },
    ],
  },
  {
    id: 'jost', name: 'Jost', classification: 'sans', scripts: ['latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('jost'), tier: 'extended',
    files: [
      { file: 'Jost-VF.ttf', src: g('ofl/jost/Jost[wght].ttf'), bytes: 134996, weight: [100, 900], italic: false },
      { file: 'Jost-Italic-VF.ttf', src: g('ofl/jost/Jost-Italic[wght].ttf'), bytes: 144388, weight: [100, 900], italic: true },
    ],
    note: 'Geometric sans: Futura, Century Gothic, Avant Garde.',
  },
  {
    id: 'inconsolata', name: 'Inconsolata', classification: 'mono', scripts: ['latn'], pitch: 'fixed',
    licence: 'OFL-1.1', licenceSrc: ofl('inconsolata'), tier: 'extended',
    files: [{ file: 'Inconsolata-VF.ttf', src: g('ofl/inconsolata/Inconsolata[wdth,wght].ttf'), bytes: 347180, weight: [200, 900], width: [50, 200], italic: false }],
    note: 'Consolas-like monospace.',
  },
  // --------------------------------------------------------------------------------------------- Japanese extended
  {
    id: 'ibm-plex-sans-jp', name: 'IBM Plex Sans JP', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('ibmplexsansjp'), tier: 'extended',
    files: statics('ibmplexsansjp', 'IBMPlexSansJP', [['Thin', 100, false, 2418688], ['ExtraLight', 200, false, 2412964], ['Light', 300, false, 2405308],
      ['Regular', 400, false, 2396484], ['Medium', 500, false, 2389060], ['SemiBold', 600, false, 2388720], ['Bold', 700, false, 2391376]]),
    note: 'A crisp modern gothic (Hiragino Kaku Gothic-like kana).',
  },
  {
    id: 'zen-kaku-gothic-new', name: 'Zen Kaku Gothic New', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('zenkakugothicnew'), tier: 'extended',
    files: statics('zenkakugothicnew', 'ZenKakuGothicNew', [['Light', 300, false, 2181020], ['Regular', 400, false, 2360248], ['Medium', 500, false, 2328176],
      ['Bold', 700, false, 2314424], ['Black', 900, false, 2300600]]),
    note: 'A gothic with smaller, rounder kana: closer to Yu Gothic than Noto Sans JP is.',
  },
  {
    id: 'zen-kaku-gothic-antique', name: 'Zen Kaku Gothic Antique', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('zenkakugothicantique'), tier: 'extended',
    files: statics('zenkakugothicantique', 'ZenKakuGothicAntique', [['Light', 300, false, 2184344], ['Regular', 400, false, 2370412], ['Medium', 500, false, 2337952],
      ['Bold', 700, false, 2324476], ['Black', 900, false, 2308740]]),
    note: 'Traditional (old-style kana) gothic: Gothic MB101, Midashi Go.',
  },
  {
    id: 'mplus-1', name: 'M PLUS 1', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('mplus1'), tier: 'extended',
    files: [{ file: 'MPLUS1-VF.ttf', src: g('ofl/mplus1/MPLUS1[wght].ttf'), bytes: 4196856, weight: [100, 900], italic: false }],
    note: 'Light, open gothic; a compact variable alternative.',
  },
  {
    id: 'line-seed-jp', name: 'LINE Seed JP', classification: 'sans', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('lineseedjp'), tier: 'extended',
    files: statics('lineseedjp', 'LINESeedJP', [['Thin', 100, false, 3747104], ['Regular', 400, false, 3673280], ['Bold', 700, false, 3786144], ['ExtraBold', 800, false, 3603732]]),
    note: 'Geometric gothic for headings and slides.',
  },
  {
    id: 'zen-old-mincho', name: 'Zen Old Mincho', classification: 'serif', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('zenoldmincho'), tier: 'extended',
    files: statics('zenoldmincho', 'ZenOldMincho', [['Regular', 400, false, 5442512], ['Medium', 500, false, 5502836], ['SemiBold', 600, false, 5521388],
      ['Bold', 700, false, 5436460], ['Black', 900, false, 5416348]]),
    note: 'Old-style mincho with five weights: Yu Mincho, Ryumin and Midashi Min headings.',
  },
  {
    id: 'shippori-mincho', name: 'Shippori Mincho', classification: 'serif', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('shipporimincho'), tier: 'extended',
    files: statics('shipporimincho', 'ShipporiMincho', [['Regular', 400, false, 8677284], ['Medium', 500, false, 8678848], ['SemiBold', 600, false, 8650032],
      ['Bold', 700, false, 8563788], ['ExtraBold', 800, false, 8563208]]),
    note: 'A refined Ryumin-like mincho; 43 MB for five weights, so not fetched by default.',
  },
  {
    id: 'zen-maru-gothic', name: 'Zen Maru Gothic', classification: 'rounded', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('zenmarugothic'), tier: 'extended',
    files: statics('zenmarugothic', 'ZenMaruGothic', [['Light', 300, false, 3723392], ['Regular', 400, false, 3832756], ['Medium', 500, false, 3810988],
      ['Bold', 700, false, 3779008], ['Black', 900, false, 3710324]]),
    note: 'Rounded gothic: Jun, Shin Maru Go, HG Maru Gothic, Hiragino Maru Gothic.',
  },
  {
    id: 'mplus-rounded-1c', name: 'M PLUS Rounded 1c', classification: 'rounded', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: { kind: 'url', url: `https://raw.githubusercontent.com/coz-m/MPLUS_FONTS/${MPLUS_COMMIT}/OFL.txt` }, tier: 'extended',
    files: statics('mplusrounded1c', 'MPLUSRounded1c', [['Thin', 100, false, 2907880], ['Light', 300, false, 3294556], ['Regular', 400, false, 3389792],
      ['Medium', 500, false, 3432624], ['Bold', 700, false, 3542592], ['ExtraBold', 800, false, 3628512], ['Black', 900, false, 3635504]]),
  },
  {
    id: 'kosugi-maru', name: 'Kosugi Maru', classification: 'rounded', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'Apache-2.0', licenceSrc: g('apache/kosugimaru/LICENSE.txt'), tier: 'extended',
    files: [{ file: 'KosugiMaru-Regular.ttf', src: g('apache/kosugimaru/KosugiMaru-Regular.ttf'), bytes: 3565716, weight: 400, italic: false }],
    note: 'One weight; small. Apache 2.0 (embedding allowed; keep the licence and NOTICE with redistributed files).',
  },
  {
    id: 'klee-one', name: 'Klee One', classification: 'script', scripts: ['jpan', 'latn'], pitch: 'proportional',
    licence: 'OFL-1.1', licenceSrc: ofl('kleeone'), tier: 'extended',
    files: statics('kleeone', 'KleeOne', [['Regular', 400, false, 8724204], ['SemiBold', 600, false, 8905128]]),
    note: 'Pen-written textbook style: UD Digi Kyokasho, kyokasho and kaisho faces.',
  },
];

// ---------------------------------------------------------------------------------------------------------------
// Measured data (scripts/fetch-fonts.ts fetched the files; metrics read with src/text/face.ts at
// wght 400 or the nearest static, wdth 100). Re-measure when a source commit changes.

/** SHA-256 of each file as fetched from its pinned source. */
const SHA256: Record<string, string> = {
  'Arimo-Italic-VF.ttf': 'a80fc54fd0233c1dfe298577c4d00f5ae81d5bb83510975e473c47e699b7f4ed',
  'Arimo-VF.ttf': 'e43898b143ec826ac8cb4034816458a7047fbe0836558de2a1f8c6223ae3e0ca',
  'BIZUDGothic-Bold.ttf': '98a528b6b638463041968783cc0f63adaf4cdc26f5398afed68bab712d1113f3',
  'BIZUDGothic-Regular.ttf': '709fcd41e3209fb765da750472f55ccdf925653e9fa7e1eb007cb65c8f749c75',
  'BIZUDMincho-Bold.ttf': '1f077f8f84c1e09d5c4acdd6828048180c2f733ae5ae13271f48cf01bee4ae83',
  'BIZUDMincho-Regular.ttf': '468ee6d9b149ca144809e03841bf18740ecf014e055a00da6ecaf1aaf4165af2',
  'BIZUDPGothic-Bold.ttf': '30eba52fc837e8b62c97d4b82e6706583149fb7294e3712dd71a655eaea80a90',
  'BIZUDPGothic-Regular.ttf': '258d7156c165f2ff774b6efee637c22c3b950de0d8a10e501137061bc8085d01',
  'BIZUDPMincho-Bold.ttf': '99618e39b881597efc03d58706bd194757c968c1bf7a7017a893efead6b1b260',
  'BIZUDPMincho-Regular.ttf': 'dbcea04578ac1e9d3484525e870ce491bd04361768f4d2ba4b827d96e20f891d',
  'Caladea-Bold.ttf': 'ae3cb2dcbc925809dd29d2a44e9802211cab66be541bacbfc9c08c74b27c3742',
  'Caladea-BoldItalic.ttf': 'ccabaa7b7e2fdf253d2b1a5fa699dd8a3df8d835a9eb285ad82631a677eb76c0',
  'Caladea-Italic.ttf': '4359a8e24f748b6447b1ff6d7a174febe70961d29f8bb8634b56dacd740a3deb',
  'Caladea-Regular.ttf': 'f1e899278b7b4491aba5b6a8253c4b04c050cc59b21865be5c37559a775153cd',
  'Carlito-Bold.ttf': 'bb5d20f79b82599ec72983597437373a80f2d2085fa91fc144fd74e876a594db',
  'Carlito-BoldItalic.ttf': 'b32928186c119599e03ca6a1ffc680fdcb7fac95772f4b95d989cf6cd3861517',
  'Carlito-Italic.ttf': '0b019225e58d702bfedcbd35c21696769f8ee115cb6343f84c2f240312450d1c',
  'Carlito-Regular.ttf': 'f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595',
  'Cousine-Bold.ttf': '17c8a7245156d2253531c9e529474937b09d9f641c5ae7695c5e33f22822eef4',
  'Cousine-BoldItalic.ttf': '848e858726fee0ae27b754e4cd6a2755209bf1428a8c91f747696d58c33906c3',
  'Cousine-Italic.ttf': 'ea2a76ae3d0ece9cd59f0d30fdc08dd70e8f5f457beee5b0852a7b50c2286c7c',
  'Cousine-Regular.ttf': '1da22250675fc4c42fcf3a9736c44bc0570516105331443b663fd5cfbd1412fe',
  'EBGaramond-Italic-VF.ttf': 'bba2c4499c93c9612b90b9825d32b07da52fce2fe57562a1eb6b833553f93c4e',
  'EBGaramond-VF.ttf': 'ef9512f92f6d579e5dc75af59a5a4b1b8b47d2eda89e00b954d44520e5369027',
  'Gelasio-Italic-VF.ttf': '52559e845a4d33514e5f93bb9ae7dbeae1894a53f2c565a15f18af40cd337c09',
  'Gelasio-VF.ttf': '4daecea457258c9ebeb8bc99ed3fd24353618bfad3ea4b93fa0b5d0468fc04e4',
  'IBMPlexSansJP-Bold.ttf': 'bd8a98b9b55c9ea3f0fa1ed094c15981788cc9a41b0357f4453014fd1d44da19',
  'IBMPlexSansJP-ExtraLight.ttf': '83b3a8d967295c162938946d6a9395d539c95fd53e161e0e4b01e5d7f39a2ea6',
  'IBMPlexSansJP-Light.ttf': 'f6390231b0ce848866d5599765897d4b882d6b29dc0484dd4d1a5435b05761ba',
  'IBMPlexSansJP-Medium.ttf': '1d09f5e25b19e54b2c55da70de58f9962512c3e07ed7c3e1c9bad77ace5c22e6',
  'IBMPlexSansJP-Regular.ttf': '372f8bba95f386856ae435dc0e69f08db1cac29bed513d99171a0ae2d307ba2a',
  'IBMPlexSansJP-SemiBold.ttf': '5985c29d2d5d444072915cf5874dc80e0a3f5fadbf14a9e3013a03a8fe6d7ff5',
  'IBMPlexSansJP-Thin.ttf': '773042bf5e8f428d46fcf81b9255c6a451f20cbd39983f308e96808a2e15e134',
  'Inconsolata-VF.ttf': '23ded25b447074d00659392bf9b1123d89df55cb07b0ad9bfef3366d199b5fcb',
  'Jost-Italic-VF.ttf': '15a6f7e3e11f9e8e338a583a6fe03e8f6b1d9ce877efa3fe579282b6c1cb15fe',
  'Jost-VF.ttf': '6343b70971000b04c5d401c96ae08ce371086135e999d5e1e1413039c0213076',
  'KleeOne-Regular.ttf': 'bf4063f030cc2ae6adf0a11424a1888e5c0eb4438f1f6d02f52294af868e9b3a',
  'KleeOne-SemiBold.ttf': 'b031ec426c23ca1143ef1f7d58bee7a79efe119ed654152f121c922202b303fd',
  'KosugiMaru-Regular.ttf': '4b8d0022c8dadd090ef67cd1f71f130714767af7806cba2eb4ebe4b0271c1d68',
  'LINESeedJP-Bold.ttf': '67aec2dc10b3ad210d6f7d53b33bbfea42ea28e32fa3834624eee699a638d5ff',
  'LINESeedJP-ExtraBold.ttf': 'e310cf97ddae9e9deb15f769fd2f68a2ff24bd0a19953c5191df941cc7952c95',
  'LINESeedJP-Regular.ttf': '04a6c0077ddb8ba5af3638bd76b4600708dde7b38df047b40fbe6f3af358d3c3',
  'LINESeedJP-Thin.ttf': 'e59cfc7cde710b0968e850b5fae4714d719e39d9bb731f7aa8c957f661c6bbec',
  'MPLUS1-VF.ttf': '32dab296a06c3e87841ecd2bc9912434a964ad541e22ea19f764969dae93fced',
  'MPLUSRounded1c-Black.ttf': 'd5981a59ccc5f00da1bd3ae46750fa95cd165b0e6b3a5fc7a1945f94c59449e3',
  'MPLUSRounded1c-Bold.ttf': 'c358630584e8e2d8fbd6121d0f4693255ffef6d1e6d4f3441fd6e5a963a11f9e',
  'MPLUSRounded1c-ExtraBold.ttf': '8e7c15901dca87f1451b356dda594f7d092ba252a5dcc47da74523a242493c36',
  'MPLUSRounded1c-Light.ttf': 'ade5c673a5d097b59c7bc5b1a6c1e37d3dd63c3ac98468a647d8ab2392b98b49',
  'MPLUSRounded1c-Medium.ttf': 'adfde1b6bae58719c4e0144612a94232e72fc5ca655c4722165fe88d06521a70',
  'MPLUSRounded1c-Regular.ttf': 'b75708b53e45b06d17d470aeeca5b766e3d1b3999f03f13ec4eb863ca846c14c',
  'MPLUSRounded1c-Thin.ttf': '180c0959fff5af21637c3887c0ec47df8164877218ef7e866a7a227f2c1e1a9f',
  'NotoSans-Italic-VF.ttf': '58e6e0ebd1931b29a365aa2d3e2ee9a9e831a3af7cf3ad1462d4e72154f0b291',
  'NotoSans-VF.ttf': 'bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d',
  'NotoSansJP-VF.ttf': 'f4b373b226668ee33a6e54b02823dcd2d1209f17159f777421ae8c2275160369',
  'NotoSansMono-VF.ttf': '2cb2adb378a8f574213e23df697050b83c54c27df465a2015552740b2769a081',
  'NotoSerif-Italic-VF.ttf': 'e87acbc6c0efd0d9a20d6a8cbbda2b266c14be3a3a6f5af8ec9d7b2460570ad1',
  'NotoSerif-VF.ttf': '4d8e6761424656867019081a1a01336f3cb086982682698714054fc33f782713',
  'NotoSerifJP-VF.ttf': '2fd527ba12b6a44ec30d796d633360da0aeba6c5d4af1304ce12bb4dc15a7dfc',
  'OpenSans-Italic-VF.ttf': 'fe269381e992f32e135801740998544d6235061e37c93ec067ad2be3edd5b17b',
  'OpenSans-VF.ttf': '36643644f318a812aab2d2ed3bb98f8cf0872527f835fe9398d95fe6b9adb878',
  'Selawik-300.ttf': '8e19d073091a1e869b5b0d48b925e605c0a4c6ece7df7b22a364fb065314c4c5',
  'Selawik-350.ttf': '8620960344f12093482cded984a1aafa5a57d24cbf7e9299da125ccf0e9d4102',
  'Selawik-400.ttf': 'e9d98518d8ac2817782a9a382430463a2e0793ea68350b695bb727d9a830ee1c',
  'Selawik-600.ttf': '0a9e9d0549a10f24bef9b3a29e06fe6e0b5c21e7a784c503b048a307841a7783',
  'Selawik-700.ttf': 'f0db5e174a90e0956ad7d2844bdca1d5e6da92ec65b2c04e57ba9b180668c904',
  'SourceSans3-Italic-VF.ttf': '39e3ab05ccd7cb94907c31005bb5bec1d5432f0b096a2b782976e217a540eb6c',
  'SourceSans3-VF.ttf': '042fe2cc0b933e328410d7acbd0aa6a1873dca5aef81875f4bc214b08825c7b9',
  'SourceSerif4-Italic-VF.ttf': '15fbc7e4679489a501998c3669272637a6646388ef7e4bd77eebb5bf967a1f42',
  'SourceSerif4-VF.ttf': '97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b',
  'Tinos-Bold.ttf': '393269dbab8899f938db19783eca5eac92eb431f7ae0ab45b8349ca895f1a06b',
  'Tinos-BoldItalic.ttf': 'a5de79f0fe863ea0954757acb3d47b3ccd0a930ce3dd5b97230cd3866790a06e',
  'Tinos-Italic.ttf': '5942266ed398b155d7dc23e36833e7ec6be988f2439bdbeb8ef1bede808eaa91',
  'Tinos-Regular.ttf': '60a0e8ef0c04dd5dd69ffe91025fa2ae5836cbd35600a82ba031977557e2cb61',
  'ZenKakuGothicAntique-Black.ttf': 'a7283b2e53d78ed1368f3b73c54410d3fbeb9f0e2e9da93b6c2c67a1e7c2900a',
  'ZenKakuGothicAntique-Bold.ttf': 'c0c631a6a4e51d4c29c8c84c40fca30b820e966d9a521c039029a19b4e438c29',
  'ZenKakuGothicAntique-Light.ttf': '1f4fd2ad3f837f4b14cda167da22aee86ad3ade20a6ff8aa931360d4676b7b66',
  'ZenKakuGothicAntique-Medium.ttf': '02bdc45744fd357b04c1a8fb0f2392a8c31b3a9250acb9899252a933ec66f4b6',
  'ZenKakuGothicAntique-Regular.ttf': 'e79b874ef1ae0cfe5b9d750f5990d408874300b17c7a02cb6e86e73a14a33005',
  'ZenKakuGothicNew-Black.ttf': '795819a979184981842994d8f4eb9e14ce443d687bd5e731d6ca67ded8f92261',
  'ZenKakuGothicNew-Bold.ttf': '0081cedabc4921982fcd061f845a005664ac7fb642af2dd34b4007bc63ccd235',
  'ZenKakuGothicNew-Light.ttf': 'ad4e9733f96397ed0c99c295d9b3b56e39a0e0bc02b0ac56ce3ade7793a1eef1',
  'ZenKakuGothicNew-Medium.ttf': '651a3f7280b7f36262601ee76d8388a8dc4372dcc67aff025a608939a562b525',
  'ZenKakuGothicNew-Regular.ttf': 'b840cd07a67d89cacca44249ae49aa99ee7640eb5ce623be8d8983d6aabac801',
  'ZenMaruGothic-Black.ttf': '6bd74fe76cd39ee0ec18775c3661d845343fb3f6f8fa09a3076638417baf741f',
  'ZenMaruGothic-Bold.ttf': 'fe24426b9c8b5523a0146a8235c8674eccf0493af354a53ec895c3596d9eb745',
  'ZenMaruGothic-Light.ttf': 'c4e6fa10ff517df37cb0c13038fe2813f3c47afe6577fa4a5573200e4508b2c1',
  'ZenMaruGothic-Medium.ttf': '3cfdb98a13571ede17fcc769f5093a97c38b80a7b9b2ab754a26b4d822092b3b',
  'ZenMaruGothic-Regular.ttf': 'a0c0b53543e0993ae2225e629c833f3d51495ad31720694ff112ce4ce11111ef',
  'ZenOldMincho-Black.ttf': '84a80d8bca79d7d9478935045b216ed003ad40fdea5fd9116d524eb26e872cdc',
  'ZenOldMincho-Bold.ttf': 'd6b95c1ff45c8dac153d28961e4c37d7d03b648330c71f884d124dc652a13c0d',
  'ZenOldMincho-Medium.ttf': 'e60c7961e5110d0f08f902de43fe60865f1538845ff2092c779837257efac3bf',
  'ZenOldMincho-Regular.ttf': '4c051a78a21c4e8e9dccf1c754776d33f356b8cc6ef95d9b64761b9bae814b84',
  'ZenOldMincho-SemiBold.ttf': 'd98b9783652081f7f9e662b0568bddeaf6462962dd39edf68781268eb60ea3a0',
};

const MEASURED: Record<FamilyId, FamilyMetrics> = {
  'noto-sans': { xHeight: 536, capHeight: 714, ascent: 1069, descent: -293, boldRatio: 1.072, condensedRatio: 0.74,
    widths: [561, 615, 480, 615, 564, 344, 615, 618, 258, 258, 534, 258, 935, 618, 605, 615, 615, 413, 479, 361, 618, 508, 786, 529, 510, 470, 639, 650, 632, 730, 556, 519, 728, 741, 339, 273, 619, 524, 907, 760, 781, 605, 781, 622, 549, 556, 731, 600, 930, 586, 566, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572] },
  'noto-serif': { xHeight: 536, capHeight: 714, ascent: 1069, descent: -293, boldRatio: 1.063, condensedRatio: 0.805,
    widths: [563, 614, 492, 614, 535, 369, 538, 635, 320, 300, 585, 310, 945, 645, 577, 614, 614, 471, 451, 352, 635, 579, 862, 578, 565, 511, 705, 654, 614, 727, 623, 590, 714, 793, 367, 357, 700, 623, 938, 763, 742, 604, 742, 656, 544, 613, 717, 675, 1047, 660, 625, 592, 559, 559, 559, 559, 559, 559, 559, 559, 559, 559] },
  'noto-sans-mono': { xHeight: 536, capHeight: 714, ascent: 1069, descent: -293, boldRatio: 1, condensedRatio: 0.833,
    widths: [600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600] },
  'arimo': { xHeight: 528, capHeight: 688, ascent: 905, descent: -212, boldRatio: 1.1,
    widths: [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556] },
  'tinos': { xHeight: 459, capHeight: 655, ascent: 891, descent: -216, boldRatio: 1.065,
    widths: [444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'cousine': { xHeight: 528, capHeight: 659, ascent: 833, descent: -300, boldRatio: 1,
    widths: [600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600] },
  'carlito': { xHeight: 478, capHeight: 642, ascent: 952, descent: -269, boldRatio: 1.028,
    widths: [479, 525, 423, 525, 498, 305, 471, 525, 229, 239, 455, 229, 799, 525, 527, 525, 525, 349, 391, 335, 525, 452, 715, 433, 453, 395, 579, 544, 533, 615, 488, 459, 631, 623, 252, 319, 520, 420, 855, 646, 662, 517, 673, 543, 459, 487, 642, 567, 890, 519, 487, 468, 507, 507, 507, 507, 507, 507, 507, 507, 507, 507] },
  'caladea': { xHeight: 467, capHeight: 667, ascent: 900, descent: -250, boldRatio: 1.105,
    widths: [470, 520, 421, 520, 441, 313, 459, 554, 277, 255, 525, 271, 813, 558, 480, 520, 501, 396, 392, 325, 546, 470, 720, 483, 482, 428, 599, 579, 519, 625, 540, 509, 539, 696, 343, 304, 630, 501, 888, 693, 599, 533, 599, 613, 453, 557, 687, 598, 889, 571, 557, 507, 517, 362, 472, 461, 492, 475, 470, 470, 485, 478] },
  'gelasio': { xHeight: 485, capHeight: 693, ascent: 928, descent: -342, boldRatio: 1.171,
    widths: [504, 560, 454, 574, 483, 325, 509, 582, 293, 292, 536, 286, 881, 591, 539, 571, 560, 410, 432, 345, 575, 497, 737, 505, 492, 444, 671, 654, 642, 749, 653, 599, 725, 815, 390, 518, 694, 604, 927, 767, 744, 610, 744, 702, 561, 619, 756, 667, 976, 710, 615, 602, 614, 430, 559, 552, 565, 528, 566, 502, 596, 566] },
  'selawik': { xHeight: 476, capHeight: 700, ascent: 990, descent: -210, boldRatio: 1.086,
    widths: [509, 588, 462, 589, 523, 313, 589, 566, 242, 242, 497, 242, 861, 566, 586, 588, 589, 348, 424, 339, 566, 479, 723, 459, 484, 452, 645, 573, 619, 701, 506, 488, 686, 710, 266, 357, 580, 471, 898, 748, 754, 560, 754, 598, 531, 524, 687, 621, 934, 590, 553, 570, 539, 539, 539, 539, 539, 539, 539, 539, 539, 539] },
  'noto-sans-jp': { xHeight: 543, capHeight: 733, ascent: 1000, descent: -200, boldRatio: 1.068,
    widths: [563, 618, 510, 620, 554, 325, 564, 607, 275, 275, 552, 284, 926, 610, 606, 620, 620, 388, 468, 377, 607, 521, 802, 498, 521, 475, 608, 657, 638, 688, 589, 552, 689, 728, 293, 535, 646, 543, 812, 723, 742, 633, 742, 635, 596, 599, 721, 575, 878, 573, 531, 603, 555, 555, 555, 555, 555, 555, 555, 555, 555, 555] },
  'noto-serif-jp': { xHeight: 516, capHeight: 728, ascent: 1151, descent: -286, boldRatio: 1.05,
    widths: [557, 638, 538, 629, 547, 388, 566, 663, 332, 311, 607, 334, 974, 661, 596, 638, 607, 462, 473, 367, 653, 548, 838, 564, 552, 498, 718, 670, 691, 770, 652, 629, 741, 853, 405, 403, 731, 625, 975, 796, 767, 641, 767, 715, 567, 659, 797, 714, 1053, 700, 687, 605, 557, 471, 558, 557, 555, 558, 558, 549, 558, 562] },
  'biz-udgothic': { xHeight: 565, capHeight: 785, ascent: 880, descent: -120, boldRatio: 1,
    widths: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'biz-udpgothic': { xHeight: 565, capHeight: 785, ascent: 880, descent: -120, boldRatio: 1.027,
    widths: [650, 710, 640, 710, 690, 500, 670, 700, 320, 380, 630, 330, 940, 700, 680, 710, 710, 450, 590, 470, 700, 580, 880, 600, 610, 580, 760, 770, 800, 840, 700, 660, 840, 820, 420, 540, 750, 600, 980, 820, 860, 740, 890, 760, 710, 700, 840, 740, 980, 800, 720, 750, 760, 630, 760, 760, 760, 760, 760, 760, 760, 760] },
  'biz-udmincho': { xHeight: 540, capHeight: 760, ascent: 880, descent: -120, boldRatio: 1,
    widths: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'biz-udpmincho': { xHeight: 540, capHeight: 760, ascent: 880, descent: -120, boldRatio: 1.117,
    widths: [620, 640, 580, 630, 630, 460, 660, 670, 330, 400, 650, 330, 920, 660, 620, 650, 640, 460, 540, 420, 640, 610, 860, 660, 640, 550, 840, 740, 810, 800, 720, 660, 840, 800, 380, 500, 790, 630, 960, 840, 840, 700, 860, 750, 700, 700, 820, 760, 980, 800, 760, 720, 680, 520, 680, 680, 680, 680, 680, 680, 680, 680] },
  'source-sans-3': { xHeight: 486, capHeight: 656, ascent: 1024, descent: -400, boldRatio: 1.07,
    widths: [504, 553, 456, 555, 496, 292, 504, 544, 246, 247, 495, 255, 829, 547, 542, 555, 555, 347, 419, 338, 544, 467, 719, 446, 467, 425, 543, 588, 571, 615, 527, 494, 617, 652, 263, 479, 579, 486, 727, 647, 664, 566, 664, 569, 534, 536, 645, 515, 786, 513, 476, 539, 497, 497, 497, 497, 497, 497, 497, 497, 497, 497] },
  'source-serif-4': { xHeight: 475, capHeight: 670, ascent: 1036, descent: -335, boldRatio: 1.045,
    widths: [509, 577, 488, 567, 510, 354, 518, 601, 298, 277, 547, 298, 901, 606, 549, 583, 557, 423, 434, 325, 583, 505, 764, 526, 512, 456, 664, 629, 631, 710, 603, 579, 682, 788, 371, 374, 667, 596, 902, 735, 707, 589, 707, 651, 512, 604, 727, 674, 962, 648, 633, 551, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'open-sans': { xHeight: 535, capHeight: 714, ascent: 1069, descent: -293, boldRatio: 1.086, condensedRatio: 0.735,
    widths: [556, 612, 479, 612, 562, 336, 543, 613, 252, 252, 525, 252, 926, 613, 602, 612, 612, 409, 477, 356, 613, 500, 775, 523, 501, 469, 632, 646, 630, 726, 556, 516, 727, 737, 279, 269, 612, 522, 899, 753, 778, 602, 778, 617, 548, 551, 729, 596, 923, 578, 559, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572, 572] },
  'eb-garamond': { xHeight: 405, capHeight: 653, ascent: 1007, descent: -298, boldRatio: 1.098,
    widths: [399, 515, 407, 506, 390, 318, 435, 515, 245, 226, 469, 240, 778, 528, 495, 519, 522, 334, 323, 314, 527, 438, 685, 430, 438, 377, 692, 587, 710, 754, 564, 512, 729, 810, 340, 340, 681, 584, 901, 792, 763, 552, 763, 713, 465, 670, 738, 672, 916, 707, 578, 603, 480, 480, 480, 480, 480, 480, 480, 480, 480, 480] },
  'jost': { xHeight: 460, capHeight: 700, ascent: 1070, descent: -375, boldRatio: 1.122,
    widths: [481, 570, 478, 570, 515, 286, 570, 525, 260, 250, 440, 230, 780, 525, 546, 570, 570, 343, 403, 240, 525, 440, 680, 420, 440, 460, 660, 558, 685, 680, 550, 500, 775, 715, 245, 240, 565, 450, 810, 775, 790, 548, 790, 560, 548, 465, 626, 660, 990, 555, 561, 545, 600, 450, 569, 546, 583, 564, 576, 525, 546, 576] },
  'inconsolata': { xHeight: 457, capHeight: 623, ascent: 859, descent: -190, boldRatio: 1, condensedRatio: 0.5,
    widths: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'ibm-plex-sans-jp': { xHeight: 541, capHeight: 733, ascent: 1060, descent: -440, boldRatio: 1.059,
    widths: [561, 608, 527, 608, 575, 338, 554, 595, 261, 261, 550, 285, 916, 595, 587, 608, 608, 384, 510, 367, 595, 517, 806, 530, 524, 484, 671, 684, 650, 703, 611, 586, 727, 742, 418, 533, 663, 525, 853, 742, 741, 635, 741, 671, 608, 600, 711, 639, 936, 634, 620, 608, 630, 630, 630, 630, 630, 630, 630, 630, 630, 630] },
  'zen-kaku-gothic-new': { xHeight: 479, capHeight: 700, ascent: 1160, descent: -288, boldRatio: 1.015,
    widths: [535, 568, 485, 568, 524, 360, 549, 528, 241, 235, 477, 210, 799, 528, 539, 568, 568, 376, 458, 377, 519, 480, 683, 508, 482, 439, 653, 630, 671, 673, 579, 551, 673, 683, 230, 525, 605, 561, 771, 686, 732, 628, 732, 640, 608, 598, 651, 618, 844, 597, 585, 552, 504, 383, 445, 484, 493, 468, 493, 412, 509, 475] },
  'zen-kaku-gothic-antique': { xHeight: 479, capHeight: 700, ascent: 1160, descent: -288, boldRatio: 1.015,
    widths: [535, 568, 485, 568, 524, 360, 549, 528, 241, 235, 477, 210, 799, 528, 539, 568, 568, 376, 458, 377, 519, 480, 683, 508, 482, 439, 653, 630, 671, 673, 579, 551, 673, 683, 230, 525, 605, 561, 771, 686, 732, 628, 732, 640, 608, 598, 651, 618, 844, 597, 585, 552, 504, 383, 445, 484, 493, 468, 493, 412, 509, 475] },
  'mplus-1': { xHeight: 520, capHeight: 730, ascent: 1160, descent: -288, boldRatio: 1.031,
    widths: [546, 607, 537, 607, 560, 461, 607, 602, 279, 303, 580, 266, 869, 602, 592, 607, 607, 420, 488, 475, 592, 526, 771, 543, 533, 533, 699, 657, 716, 707, 630, 637, 780, 730, 289, 607, 698, 634, 880, 753, 841, 638, 834, 681, 641, 669, 735, 692, 924, 717, 679, 663, 633, 633, 633, 633, 633, 633, 634, 633, 633, 634] },
  'line-seed-jp': { xHeight: 509, capHeight: 751, ascent: 932, descent: -168, boldRatio: 1.075,
    widths: [659, 659, 580, 659, 583, 391, 659, 626, 249, 249, 577, 249, 978, 626, 630, 659, 659, 405, 500, 420, 623, 572, 854, 548, 571, 533, 761, 709, 823, 791, 638, 609, 842, 798, 279, 526, 735, 635, 985, 791, 875, 672, 890, 703, 622, 689, 771, 753, 1154, 691, 717, 655, 725, 466, 667, 669, 715, 669, 660, 629, 695, 658] },
  'zen-old-mincho': { xHeight: 430, capHeight: 726, ascent: 1160, descent: -288, boldRatio: 1.104,
    widths: [463, 523, 462, 520, 482, 352, 522, 516, 288, 286, 504, 288, 744, 517, 491, 516, 502, 448, 472, 356, 514, 483, 670, 495, 484, 455, 756, 700, 707, 720, 684, 670, 732, 752, 406, 495, 717, 679, 859, 751, 723, 682, 717, 698, 665, 726, 753, 706, 941, 701, 708, 668, 615, 535, 569, 558, 585, 572, 597, 547, 600, 593] },
  'zen-maru-gothic': { xHeight: 479, capHeight: 700, ascent: 1160, descent: -288, boldRatio: 1.015,
    widths: [535, 568, 485, 568, 524, 360, 549, 528, 241, 235, 477, 210, 799, 528, 539, 568, 568, 376, 458, 377, 519, 480, 683, 508, 482, 439, 653, 630, 671, 673, 579, 551, 673, 683, 230, 525, 605, 561, 771, 686, 732, 628, 732, 640, 608, 598, 651, 618, 844, 597, 585, 552, 504, 383, 445, 484, 493, 468, 493, 412, 509, 475] },
  'mplus-rounded-1c': { xHeight: 520, capHeight: 730, ascent: 1075, descent: -320, boldRatio: 1.048,
    widths: [534, 578, 493, 578, 524, 508, 563, 570, 310, 355, 523, 310, 785, 565, 556, 574, 574, 450, 497, 502, 560, 523, 770, 504, 522, 536, 639, 598, 613, 658, 587, 572, 687, 676, 316, 529, 586, 582, 816, 686, 714, 600, 722, 606, 553, 634, 656, 639, 864, 610, 610, 616, 620, 620, 620, 620, 620, 620, 620, 620, 620, 620] },
  'kosugi-maru': { xHeight: 533, capHeight: 763, ascent: 880, descent: -120,
    widths: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500] },
  'klee-one': { xHeight: 482, capHeight: 705, ascent: 1160, descent: -288,
    widths: [575, 573, 530, 575, 543, 370, 580, 588, 263, 301, 510, 263, 816, 588, 562, 572, 576, 430, 510, 360, 590, 490, 730, 500, 500, 490, 690, 650, 703, 728, 638, 560, 752, 700, 304, 492, 630, 547, 855, 738, 745, 600, 745, 635, 617, 577, 710, 620, 880, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600, 600] },
};

for (const f of CATALOG) {
  f.metrics ??= MEASURED[f.id];
  for (const x of f.files) x.sha256 ??= SHA256[x.file];
}

export const FAMILIES: ReadonlyMap<FamilyId, Family> = new Map(CATALOG.map((f) => [f.id, f]));

export function family(id: FamilyId): Family {
  const f = FAMILIES.get(id);
  if (!f) throw new Error(`font catalog: no family '${id}'`);
  return f;
}

/** Total upstream bytes of a family's font files. */
export function familyBytes(f: Family): number {
  return f.files.reduce((n, x) => n + x.bytes, 0);
}

/** Every font file name the catalog knows (what the app may serve from fonts/). */
export function catalogFiles(): string[] {
  return CATALOG.flatMap((f) => f.files.map((x) => x.file));
}
