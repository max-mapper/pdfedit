// The font registry: the shipped OFL faces (fonts/), loaded once, and the choice of face for a run.
//
// Every run is set in a shipped or catalogue face: the document's own fonts are subsets that lack the glyphs of new
// text (a Japanese subset has almost no Latin), so canDocumentFontDraw() is false.
//
// A document font with a matched catalogue face (src/fonts/apply.ts) is set in that face. Otherwise, by class:
// Noto Sans for Latin text, Noto Sans JP for text holding CJK, weight kept (Noto Sans JP is variable: wght 400 / 700).
// Italic: without a catalogue italic the glyphs stay upright.
import type { Face } from '../text/face.ts';
import { loadFace } from '../text/face.ts';
import { loadHarfBuzz } from '../text/hb.ts';
import type { LoadOptions } from '../text/hb.ts';
import type { FontRef, Run } from './types.ts';

export const SHIPPED_FILES = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSansJP-VF.ttf'] as const;
export type FontFile = (typeof SHIPPED_FILES)[number];
/** Bytes, or a URL to fetch (the browser passes Vite `?url` imports; Node reads fonts/ by default). */
export type FontSource = Uint8Array | ArrayBuffer | string | URL;

/** Shipped face ids (FontRef.name when source = 'shipped'). */
export const SHIPPED_FACES = {
  'NotoSans-Regular': { file: 'NotoSans-Regular.ttf', variations: undefined },
  'NotoSans-Bold': { file: 'NotoSans-Bold.ttf', variations: undefined },
  'NotoSansJP:400': { file: 'NotoSansJP-VF.ttf', variations: { wght: 400 } },
  'NotoSansJP:700': { file: 'NotoSansJP-VF.ttf', variations: { wght: 700 } },
} as const satisfies Record<string, { file: FontFile; variations: Record<string, number> | undefined }>;
export type ShippedFaceId = keyof typeof SHIPPED_FACES;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;

/** True when the text holds a CJK character (Han, kana, Hangul, CJK punctuation or full-width forms). */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * Whether the run's own document font can draw its text. Always false: reading an embedded program and its
 * coverage (FPDFFont_GetFontData, the font's cmap) is not implemented.
 */
export function canDocumentFontDraw(_run: Pick<Run, 'text' | 'font'>): boolean {
  return false;
}

/** The shipped face for a run's text and style (pure: needs no loaded font). */
export function substituteRef(run: { text: string; bold: boolean; italic: boolean; font?: Pick<FontRef, 'serif'> & Partial<Pick<FontRef, 'source' | 'name' | 'from'>> }): FontRef {
  const serif = run.font?.serif ?? false;
  // serif → the sans faces until a serif face ships (see the header)
  const name: ShippedFaceId = hasCjk(run.text) ? (run.bold ? 'NotoSansJP:700' : 'NotoSansJP:400')
    : run.bold ? 'NotoSans-Bold' : 'NotoSans-Regular';
  const from = run.font?.source === 'document' ? run.font.name : run.font?.from;
  return { source: 'shipped', name, bold: run.bold, italic: run.italic, serif, ...(from ? { from } : {}) };
}

/** The font a run is set in: its own when the document font can draw it, else the shipped substitute. */
export function fontFor(run: Pick<Run, 'text' | 'font' | 'bold' | 'italic'>): FontRef {
  if (run.font.source === 'document' && canDocumentFontDraw(run)) return run.font;
  if (run.font.source === 'shipped' && run.font.name in SHIPPED_FACES) {
    // a shipped face of the run's weight that can draw the text stays (Noto Sans JP draws Latin too)
    const isJp = run.font.name.startsWith('NotoSansJP');
    if ((isJp || !hasCjk(run.text)) && run.font.bold === run.bold) return run.font;
  }
  return substituteRef(run);
}

/** A catalogue face id (src/fonts/catalog.ts): 'cat:<file>' or 'cat:<file>@wght=500,wdth=82'. */
export function catalogFaceId(file: string, variations?: Record<string, number>): string {
  const v = variations && Object.keys(variations).length ? '@' + Object.entries(variations).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}=${n}`).join(',') : '';
  return `cat:${file}${v}`;
}
export function parseCatalogFaceId(id: string): { file: string; variations?: Record<string, number> } | null {
  if (!id.startsWith('cat:')) return null;
  const [file, v] = id.slice(4).split('@');
  if (!v) return { file };
  return { file, variations: Object.fromEntries(v.split(',').map((kv) => { const [k, n] = kv.split('='); return [k, Number(n)]; })) };
}

/** The substitute chosen for a document font, per script and weight (src/fonts/apply.ts fills it). */
export type SubstituteChoice = { id: string; family: string; match: string };

export class FontRegistry {
  private bytes: Map<FontFile, Uint8Array>;
  private faces = new Map<string, Face>();
  private refOf = new Map<Face, FontRef>();
  private catBytes = new Map<string, Uint8Array>();
  private catSource: ((file: string) => FontSource | null) | null;
  /** document font name → 'latn' | 'jpan' → bold ('b') or regular ('r') → the catalogue face to set it in */
  private subs = new Map<string, SubstituteChoice>();

  constructor(bytes: Map<FontFile, Uint8Array>, catSource: ((file: string) => FontSource | null) | null = null) {
    this.bytes = bytes;
    this.catSource = catSource;
  }

  /** Loads catalogue files (fonts/ in Node, or the source given to loadFonts); returns the ones now available. */
  async ensure(files: string[]): Promise<Set<string>> {
    const ok = new Set<string>();
    await Promise.all([...new Set(files)].map(async (file) => {
      if (this.catBytes.has(file)) { ok.add(file); return; }
      const src = this.catSource ? this.catSource(file) : isNode() ? new URL(FONTS_DIR + file, import.meta.url) : null;
      if (src === null) return;
      try { this.catBytes.set(file, await fetchBytes(src)); ok.add(file); } catch { /* not available */ }
    }));
    return ok;
  }

  /** Sets the face for runs in a document font (by its PDF name), for a script and weight. */
  setSubstitute(docFont: string, script: 'latn' | 'jpan', bold: boolean, choice: SubstituteChoice) {
    this.subs.set(`${docFont}\u0000${script}\u0000${bold ? 'b' : 'r'}`, choice);
  }
  substituteFor(docFont: string, script: 'latn' | 'jpan', bold: boolean): SubstituteChoice | undefined {
    return this.subs.get(`${docFont}\u0000${script}\u0000${bold ? 'b' : 'r'}`);
  }

  /** Which shipped faces are available (the JP face is optional: without it CJK text falls back to Noto Sans). */
  has(id: ShippedFaceId): boolean {
    return this.bytes.has(SHIPPED_FACES[id].file);
  }

  /** The loaded face for a shipped face id (loaded on first use, synchronously: HarfBuzz is already loaded). */
  face(ref: FontRef | ShippedFaceId | string): Face {
    const cid = typeof ref === 'string' ? ref : ref.source === 'shipped' ? ref.name : '';
    const cat = parseCatalogFaceId(cid);
    if (cat && this.catBytes.has(cat.file)) {
      let f = this.faces.get(cid);
      if (!f) {
        f = loadFace(this.catBytes.get(cat.file)!, cat.variations ? { variations: { ...cat.variations } } : {});
        this.faces.set(cid, f);
        const w = cat.variations?.wght ?? (/bold/i.test(cat.file) ? 700 : 400);
        this.refOf.set(f, { source: 'shipped', name: cid, bold: w >= 600, italic: /italic/i.test(cat.file), serif: false });
      }
      return f;
    }
    if (cat) ref = substituteRef({ text: '', bold: typeof ref !== 'string' && ref.bold, italic: false }).name;   // not loaded: the default face
    let id = typeof ref === 'string' ? ref : ref.name;
    if (typeof ref !== 'string' && (ref.source !== 'shipped' || !(id in SHIPPED_FACES))) id = substituteRef({ text: '', bold: ref.bold, italic: ref.italic }).name;
    if (!this.has(id as ShippedFaceId)) id = (id.endsWith('700') || id.endsWith('Bold')) && this.has('NotoSans-Bold') ? 'NotoSans-Bold' : 'NotoSans-Regular';
    let f = this.faces.get(id);
    if (!f) {
      const spec = SHIPPED_FACES[id as ShippedFaceId];
      const b = this.bytes.get(spec.file);
      if (!b) throw new Error(`font registry: ${spec.file} is not loaded`);
      f = loadFace(b, spec.variations ? { variations: { ...spec.variations } } : {});
      this.faces.set(id, f);
      this.refOf.set(f, { source: 'shipped', name: id, bold: id.endsWith('700') || id.endsWith('Bold'), italic: false, serif: false });
    }
    return f;
  }

  /** The face and font a run is laid out in. */
  resolve(run: Pick<Run, 'text' | 'font' | 'bold' | 'italic'>): { face: Face; font: FontRef } {
    // a run picked into a catalogue face keeps it; a document font with a matched substitute is set in that
    if (run.font.source === 'shipped' && parseCatalogFaceId(run.font.name) && this.catBytes.has(parseCatalogFaceId(run.font.name)!.file))
      return { face: this.face(run.font), font: run.font };
    const docName = run.font.source === 'document' ? run.font.name : run.font.from;
    if (docName) {
      const c = this.substituteFor(docName, hasCjk(run.text) ? 'jpan' : 'latn', run.bold);
      if (c && this.catBytes.has(parseCatalogFaceId(c.id)!.file)) {
        const font: FontRef = { source: 'shipped', name: c.id, bold: run.bold, italic: run.italic, serif: run.font.serif, from: docName };
        return { face: this.face(c.id), font };
      }
    }
    const font = fontFor(run);
    return { face: this.face(font), font };
  }

  /** The shipped face id a loaded face came from. */
  idOf(face: Face): string | undefined {
    return this.refOf.get(face)?.name;
  }
}

/**
 * Loads HarfBuzz (once) and the shipped font files. Node: from fonts/ beside the repository root unless sources are
 * given. Browser: pass a URL (or bytes) per file, and `harfbuzz.subsetWasm` (src/text/hb.ts needs it outside Node).
 * A file that is not given and cannot be read is skipped (the JP face is then unavailable).
 */
export async function loadFonts(sources: Partial<Record<FontFile, FontSource>> = {}, opts: { harfbuzz?: LoadOptions; catalog?: (file: string) => FontSource | null } = {}): Promise<FontRegistry> {
  await loadHarfBuzz(opts.harfbuzz);
  const bytes = new Map<FontFile, Uint8Array>();
  await Promise.all(SHIPPED_FILES.map(async (file) => {
    const src = sources[file];
    try {
      const b = src !== undefined ? await fetchBytes(src) : isNode() ? await readNode(new URL(FONTS_DIR + file, import.meta.url)) : null;
      if (b) bytes.set(file, b);
    } catch (err) {
      if (src !== undefined) throw err;   // an explicit source that fails is an error; a missing default is not
    }
  }));
  if (!bytes.has('NotoSans-Regular.ttf')) throw new Error('font registry: NotoSans-Regular.ttf is required (npm run fonts)');
  return new FontRegistry(bytes, opts.catalog ?? null);
}

/** Node's default font folder, relative to this module (a variable, so bundlers do not glob the folder). */
const FONTS_DIR = '../../fonts/';

async function fetchBytes(src: FontSource): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  const url = src instanceof URL ? src : new URL(src, globalThis.location?.href ?? import.meta.url);
  if (url.protocol === 'file:' && isNode()) return readNode(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`font ${url.href}: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function isNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

async function readNode(url: URL): Promise<Uint8Array> {
  const name = 'node:fs/promises';   // computed: keeps bundlers from pulling node:fs into the browser build
  const fs = (await import(name)) as { readFile(u: URL): Promise<Uint8Array> };
  return new Uint8Array(await fs.readFile(url));
}
