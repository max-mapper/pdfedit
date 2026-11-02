// PDFium (WebAssembly, @embedpdf/pdfium) for reading and rendering only. See docs/CONTRACTS.md § src/engine.
// Nothing here writes a page: PDFium's content writer is lossy, so edits go through src/pdf.
import { init } from '@embedpdf/pdfium';
import { toView, viewBox, type ViewBox } from './view.ts';

export type Rect = { x0: number; y0: number; x1: number; y1: number };
export type Char = {
  i: number; unicode: string; box: Rect; loose: Rect; origin: [number, number];
  /** The effective size in points: the font's Tf size times the text matrix's vertical scale (a document may set
   *  Tf 1 and scale with Tm, as InDesign exports often do). `fontSizeRaw` is PDFium's Tf size. */
  fontSize: number; fontSizeRaw: number;
  fontName: string; fontFlags: number; weight: number; fill: [number, number, number, number]; angle: number;
  /** Stroke colour (RGBA) and the text object's render mode (0 fill, 1 stroke, 2 fill + stroke, 3 invisible, …). */
  stroke?: [number, number, number, number]; renderMode?: number;
  generated: boolean; obj: number;
};
export type TextObj = {
  index: number; topIndex: number | null; inForm: boolean; bounds: Rect; matrix: number[];
  fontName: string; embedded: boolean; fontSize: number; text: string; chars: number[];
  z: number;                // paint order among all page objects (forms' contents included), 0 = painted first
  renderMode: number;       // text rendering mode (Tr): 3 = invisible, 7 = clip only; -1 unknown
  fillAlpha: number;        // fill alpha 0..255 (255 when unknown)
  clip: Rect | null;        // bounding box of the object's clip region in page space (null: not clipped); text outside it is not painted
};
/** A non-text page object, in page space: the material panels, table rulings and pictures are detected from. */
export type Shape = {
  index: number; kind: 'path' | 'image' | 'shading'; bounds: Rect; inForm: boolean;
  fill: [number, number, number, number] | null; stroke: [number, number, number, number] | null; strokeWidth: number;
  isRect: boolean;          // an axis-aligned rectangle (one closed 4-corner subpath)
  isRule: boolean;          // a straight horizontal or vertical line, or a rectangle thinner than 1.5 pt
  pathSegs: number;         // a path's drawing steps (moves, lines, curves); 0 for images and shadings
  z: number;                // paint order, comparable with TextObj.z: a panel is painted before (behind) its text
  /** A path made only of axis-aligned rectangles (several cells or bars drawn as one object): each one, page space. */
  rects?: Rect[];
};
export type Bitmap = { width: number; height: number; rgba: Uint8ClampedArray<ArrayBuffer> };
/** A page object as PDFium lists it: every object in paint order, a form XObject before its contents (pre-order).
 *  Bounds and the quad are in page space (objects inside forms are mapped through the forms' matrices). */
export type EngineObject = {
  index: number;            // position in this list (paint order)
  kind: 'text' | 'path' | 'image' | 'shading' | 'form' | 'unknown';
  depth: number;            // forms entered to reach it (0: the page's own content)
  parent: number | null;    // the form object it is inside
  bounds: Rect;
  /** The object's own outline turned with it (FPDFPageObj_GetRotatedBounds), four corners; null when not given. */
  quad: [number, number][] | null;
  mcid: number;             // marked-content id, −1 when none
  marks: string[];          // marked-content tags around it, outermost first
  transparent: boolean;     // FPDFPageObj_HasTransparency
};

// PDFium constants (public/fpdfview.h, fpdf_edit.h)
const FPDF_PAGEOBJ_TEXT = 1;
const FPDF_PAGEOBJ_PATH = 2;
const FPDF_PAGEOBJ_IMAGE = 3;
const FPDF_PAGEOBJ_SHADING = 4;
const FPDF_SEGMENT_MOVETO = 2;
const FPDF_PAGEOBJ_FORM = 5;
const FPDF_SEGMENT_LINETO = 0;   // fpdf_edit.h: UNKNOWN -1, LINETO 0, BEZIERTO 1, MOVETO 2
const FPDFBitmap_BGRA = 4;
const FPDF_ANNOT = 0x01;
const FPDF_REVERSE_BYTE_ORDER = 0x10;
const FPDF_ERR_PASSWORD = 4;
const OPEN_ERRORS: Record<number, string> = {
  1: 'unknown error', 2: 'file not found or could not be opened', 3: 'not a PDF or corrupted', 4: 'a password is required',
  5: 'unsupported security scheme', 6: 'page not found or content error',
};

type Module = Awaited<ReturnType<typeof init>>;
type Raw = Module['pdfium'] & { HEAPU8: Uint8Array; _FPDF_RenderPageBitmap: (...a: number[]) => void };

export type Pdfium = {
  open(bytes: Uint8Array): PdfDoc; module: Module;
  /** An encrypted document's decrypted copy, written by PDFium (EPDF_RemoveEncryption, then a full save): for files
   *  that open without a user password (an owner password only). Null when the document is not encrypted. Throws a
   *  PdfiumOpenError with `needsPassword` when a user password is required. The copy is not encrypted. */
  decryptCopy(bytes: Uint8Array): Uint8Array | null;
  /** The document as PDFium saves it (a full save): PDFium rebuilds a broken cross-reference table on load, so this
   *  is the repaired file. Throws a PdfiumOpenError when PDFium cannot open it at all. */
  repairCopy(bytes: Uint8Array): Uint8Array;
  /** Encryption facts without opening pages: whether the trailer has /Encrypt, the security handler revision and
   *  the permission bits (−1 when not encrypted). `needsPassword`: it does not open without a user password. */
  security(bytes: Uint8Array): { encrypted: boolean; needsPassword: boolean; revision: number; permissions: number };
};

/** PDFium could not open a document; `code` is FPDF_GetLastError (3 format, 4 password, 5 security handler). */
export class PdfiumOpenError extends Error {
  readonly code: number;
  readonly needsPassword: boolean;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'PdfiumOpenError';
    this.code = code;
    this.needsPassword = code === FPDF_ERR_PASSWORD;
  }
}
export type PdfDoc = { pageCount: number; page(i: number): PdfPage; close(): void };
export type PdfPage = {
  index: number; size: { w: number; h: number };
  /** How user space maps onto the page as shown (src/engine/view.ts): /Rotate and the crop box. `size` is view.w × view.h. */
  view: ViewBox;
  chars(): Char[]; textObjects(): TextObj[]; shapes(): Shape[]; render(scale: number): Bitmap; close(): void;
  /** Every page object in paint order (forms entered), the material for the page object model (src/objects). */
  objects(): EngineObject[];
  /**
   * The render hit test: for each listed object (EngineObject.index), whether hiding it changes the pixel at user-space
   * point (x, y) of a render at `scale` pixels per point. An object whose paint there matches what is under it
   * (white on white) reads as false.
   */
  paintsAt(indices: number[], x: number, y: number, scale?: number): boolean[];
};

let shared: Promise<Pdfium> | null = null;

/** Load the WASM once. In Node the binary is read from node_modules; a browser passes `wasmBinary` or relies on
 *  the package's own URL resolution. */
export function openPdfium(opts: { wasmBinary?: ArrayBuffer | Uint8Array } = {}): Promise<Pdfium> {
  if (shared && !opts.wasmBinary) return shared;
  const p = (async () => {
    let wasmBinary = opts.wasmBinary;
    if (!wasmBinary && typeof process !== 'undefined' && process.versions?.node) {
      const { readFileSync } = await import('node:fs');
      const { createRequire } = await import('node:module');
      const req = createRequire(import.meta.url);
      const dir = req.resolve('@embedpdf/pdfium').replace(/[\\/][^\\/]*$/, '');
      wasmBinary = readFileSync(`${dir}/pdfium.wasm`);
    }
    const M = await init(wasmBinary ? { wasmBinary: wasmBinary as ArrayBuffer } : {});
    M.PDFiumExt_Init();
    return makePdfium(M);
  })();
  if (!opts.wasmBinary) shared = p;
  return p;
}

function makePdfium(M: Module): Pdfium {
  const raw = M.pdfium as Raw;
  const malloc = (n: number) => raw.wasmExports.malloc(n);
  const free = (p: number) => raw.wasmExports.free(p);
  const f64 = (p: number) => raw.getValue(p, 'double') as number;
  const f32 = (p: number) => raw.getValue(p, 'float') as number;
  const u32 = (p: number) => (raw.getValue(p, 'i32') as number) >>> 0;
  // A scratch block for out-parameters, reused across calls.
  const scratch = malloc(64);

  function utf16At(ptr: number, bytes: number): string {
    // bytes includes the 2-byte terminator
    const n = Math.max(0, bytes / 2 - 1);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(raw.getValue(ptr + i * 2, 'i16') as number & 0xffff);
    return s;
  }

  function fontName(font: number): string {
    if (!font) return '';
    const n = M.FPDFFont_GetBaseFontName(font, 0, 0);
    if (n <= 0) return '';
    const buf = malloc(n);
    try {
      M.FPDFFont_GetBaseFontName(font, buf, n);
      return raw.UTF8ToString(buf);
    } finally { free(buf); }
  }

  /** A page's view box: its rotation and crop box as PDFium reports them, checked against the shown size; when the
   *  boxes are inherited or missing, the crop box is found by mapping the shown page's corners back to user space. */
  function pageView(pg: number, size: { w: number; h: number }): ViewBox {
    const rotate = (M.FPDFPage_GetRotation(pg) & 3) * 90;
    const box = (get: 'FPDFPage_GetCropBox' | 'FPDFPage_GetMediaBox'): Rect | null => {
      if (!M[get](pg, scratch, scratch + 4, scratch + 8, scratch + 12)) return null;   // left, bottom, right, top
      const r = { x0: f32(scratch), y0: f32(scratch + 4), x1: f32(scratch + 8), y1: f32(scratch + 12) };
      return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
    };
    const media = box('FPDFPage_GetMediaBox');
    const shown = (r: Rect) => { const v = viewBox(rotate, r); return Math.abs(v.w - size.w) < 0.5 && Math.abs(v.h - size.h) < 0.5; };
    let crop = box('FPDFPage_GetCropBox');
    if (crop && media) crop = { x0: Math.max(crop.x0, media.x0), y0: Math.max(crop.y0, media.y0), x1: Math.min(crop.x1, media.x1), y1: Math.min(crop.y1, media.y1) };
    if (!crop || !shown(crop)) crop = media && shown(media) ? media : null;
    if (!crop) {
      // the corners of the shown page (device space at 64 pixels per point) back in user space
      const K = 64, sw = Math.round(size.w * K), sh = Math.round(size.h * K);
      const pts: [number, number][] = [];
      for (const [dx, dy] of [[0, 0], [sw, sh]]) {
        M.FPDF_DeviceToPage(pg, 0, 0, sw, sh, 0, dx, dy, scratch, scratch + 8);
        pts.push([f64(scratch), f64(scratch + 8)]);
      }
      crop = { x0: Math.min(pts[0][0], pts[1][0]), y0: Math.min(pts[0][1], pts[1][1]), x1: Math.max(pts[0][0], pts[1][0]), y1: Math.max(pts[0][1], pts[1][1]) };
    }
    const v = viewBox(rotate, crop, media);
    return { ...v, w: size.w, h: size.h };
  }

  function open(bytes: Uint8Array): PdfDoc {
    const mem = malloc(bytes.length);
    raw.HEAPU8.set(bytes, mem);
    const doc = M.FPDF_LoadMemDocument(mem, bytes.length, '');
    if (!doc) { free(mem); const code = M.FPDF_GetLastError(); throw new PdfiumOpenError(`PDFium could not open the document (error ${code})`, code); }
    const pageCount = M.FPDF_GetPageCount(doc);
    const open: Set<() => void> = new Set();

    function page(index: number): PdfPage {
      const pg = M.FPDF_LoadPage(doc, index);
      if (!pg) throw new Error(`PDFium could not load page ${index}`);
      const tp = M.FPDFText_LoadPage(pg);
      const size = { w: M.FPDF_GetPageWidthF(pg), h: M.FPDF_GetPageHeightF(pg) };
      const view = pageView(pg, size);
      let objs: { handle: number; rec: TextObj }[] | null = null;

      function walkObjects(): { handle: number; rec: TextObj }[] {
        if (objs) return objs;
        const out: { handle: number; rec: TextObj }[] = [];
        let top = 0, zc = 0;
        const visit = (handle: number, inForm: boolean) => {
          const z = zc++;
          const type = M.FPDFPageObj_GetType(handle);
          if (type === FPDF_PAGEOBJ_FORM) {
            const n = M.FPDFFormObj_CountObjects(handle);
            for (let k = 0; k < n; k++) visit(M.FPDFFormObj_GetObject(handle, k), true);
            return;
          }
          if (type !== FPDF_PAGEOBJ_TEXT) return;
          M.FPDFPageObj_GetBounds(handle, scratch, scratch + 4, scratch + 8, scratch + 12);
          const bounds = { x0: f32(scratch), y0: f32(scratch + 4), x1: f32(scratch + 8), y1: f32(scratch + 12) };
          M.FPDFPageObj_GetMatrix(handle, scratch);
          const matrix = [0, 1, 2, 3, 4, 5].map((k) => f32(scratch + k * 4));
          const font = M.FPDFTextObj_GetFont(handle);
          M.FPDFTextObj_GetFontSize(handle, scratch + 32);
          const tlen = M.FPDFTextObj_GetText(handle, tp, 0, 0);
          let text = '';
          if (tlen > 2) {
            const b = malloc(tlen);
            try { M.FPDFTextObj_GetText(handle, tp, b, tlen); text = utf16At(b, tlen); } finally { free(b); }
          }
          // The clip region is the intersection of the clip paths; each path's bounding box bounds it.
          let clip: Rect | null = null;
          const cp = M.FPDFPageObj_GetClipPath(handle);
          if (cp) {
            const np = M.FPDFClipPath_CountPaths(cp);
            for (let pi = 0; pi < np; pi++) {
              const ns = M.FPDFClipPath_CountPathSegments(cp, pi);
              if (ns <= 0) continue;
              let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
              for (let si = 0; si < ns; si++) {
                const sg = M.FPDFClipPath_GetPathSegment(cp, pi, si);
                if (!sg || !M.FPDFPathSegment_GetPoint(sg, scratch + 52, scratch + 56)) continue;
                const x = f32(scratch + 52), y = f32(scratch + 56);
                bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y);
              }
              if (!(bx1 >= bx0)) continue;
              clip = clip ? { x0: Math.max(clip.x0, bx0), y0: Math.max(clip.y0, by0), x1: Math.min(clip.x1, bx1), y1: Math.min(clip.y1, by1) }
                : { x0: bx0, y0: by0, x1: bx1, y1: by1 };
            }
          }
          out.push({ handle, rec: {
            index: out.length, topIndex: inForm ? null : top++, inForm, bounds, matrix,
            fontName: fontName(font), embedded: font ? M.FPDFFont_GetIsEmbedded(font) === 1 : false,
            fontSize: f32(scratch + 32), text, chars: [], z, renderMode: M.FPDFTextObj_GetTextRenderMode(handle),
            clip, fillAlpha: M.FPDFPageObj_GetFillColor(handle, scratch + 36, scratch + 40, scratch + 44, scratch + 48) ? u32(scratch + 48) : 255,
          } });
        };
        const n = M.FPDFPage_CountObjects(pg);
        for (let k = 0; k < n; k++) visit(M.FPDFPage_GetObject(pg, k), false);
        objs = out;
        return out;
      }

      function chars(): Char[] {
        const list = walkObjects();
        const byHandle = new Map(list.map((o) => [o.handle, o.rec]));
        for (const o of list) o.rec.chars = [];
        const n = M.FPDFText_CountChars(tp);
        const out: Char[] = [];
        const nameBuf = malloc(256);
        try {
          for (let i = 0; i < n; i++) {
            const cp = M.FPDFText_GetUnicode(tp, i);
            M.FPDFText_GetCharBox(tp, i, scratch, scratch + 8, scratch + 16, scratch + 24);
            const box = { x0: f64(scratch), x1: f64(scratch + 8), y0: f64(scratch + 16), y1: f64(scratch + 24) };
            M.FPDFText_GetLooseCharBox(tp, i, scratch + 32);   // FS_RECTF: left, top, right, bottom
            const loose = { x0: f32(scratch + 32), y1: f32(scratch + 36), x1: f32(scratch + 40), y0: f32(scratch + 44) };
            M.FPDFText_GetCharOrigin(tp, i, scratch, scratch + 8);
            const origin: [number, number] = [f64(scratch), f64(scratch + 8)];
            const nameLen = M.FPDFText_GetFontInfo(tp, i, nameBuf, 256, scratch + 48);
            const fontName = nameLen > 0 ? raw.UTF8ToString(nameBuf) : '';
            const flags = raw.getValue(scratch + 48, 'i32') as number;
            M.FPDFText_GetFillColor(tp, i, scratch, scratch + 4, scratch + 8, scratch + 12);
            const fill: [number, number, number, number] = [u32(scratch), u32(scratch + 4), u32(scratch + 8), u32(scratch + 12)];
            const stroke: [number, number, number, number] | undefined = M.FPDFText_GetStrokeColor(tp, i, scratch, scratch + 4, scratch + 8, scratch + 12)
              ? [u32(scratch), u32(scratch + 4), u32(scratch + 8), u32(scratch + 12)] : undefined;
            const h = M.FPDFText_GetTextObject(tp, i);
            const rec = h ? byHandle.get(h) : undefined;
            if (rec) rec.chars.push(i);
            const raw0 = M.FPDFText_GetFontSize(tp, i);
            let scale = 1;
            if (M.FPDFText_GetMatrix(tp, i, scratch)) {   // FS_MATRIX a b c d e f (floats)
              const c = f32(scratch + 8), d = f32(scratch + 12);
              const sy = Math.hypot(c, d);
              if (sy > 0) scale = sy;
            }
            out.push({
              i, unicode: cp ? String.fromCodePoint(cp) : '', box, loose, origin,
              fontSize: raw0 * scale, fontSizeRaw: raw0, fontName, fontFlags: flags,
              weight: M.FPDFText_GetFontWeight(tp, i), fill, ...(stroke ? { stroke } : {}), ...(rec ? { renderMode: rec.renderMode } : {}), angle: M.FPDFText_GetCharAngle(tp, i),
              generated: M.FPDFText_IsGenerated(tp, i) === 1, obj: rec ? rec.index : -1,
            });
          }
        } finally { free(nameBuf); }
        return out;
      }

      type M6 = [number, number, number, number, number, number];
      const mul = (a: M6, b: M6): M6 => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
      const apply = (m: M6, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
      const matrixOf = (h: number): M6 => { M.FPDFPageObj_GetMatrix(h, scratch); return [0, 1, 2, 3, 4, 5].map((k) => f32(scratch + k * 4)) as M6; };
      // Subpaths of a path object that are each an axis-aligned rectangle (move, three or four line-tos, optional
      // close), in page space; undefined unless every subpath is one and there are at least two.
      const rectsOf = (h: number, n: number, parent: M6 | null): Rect[] | undefined => {
        const m = matrixOf(h);
        if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6) return undefined;
        const out: Rect[] = [];
        let pts: [number, number][] = [];
        const flush = (): boolean => {
          if (!pts.length) return true;
          const xs = new Set(pts.map((p) => Math.round(p[0] * 10))), ys = new Set(pts.map((p) => Math.round(p[1] * 10)));
          if (pts.length < 4 || pts.length > 5 || xs.size !== 2 || ys.size !== 2) return false;
          let ps = pts.map(([x, y]) => apply(m, x, y));
          if (parent) ps = ps.map(([x, y]) => apply(parent, x, y));
          out.push({ x0: Math.min(...ps.map((p) => p[0])), y0: Math.min(...ps.map((p) => p[1])), x1: Math.max(...ps.map((p) => p[0])), y1: Math.max(...ps.map((p) => p[1])) });
          pts = [];
          return true;
        };
        for (let k = 0; k < n; k++) {
          const sg = M.FPDFPath_GetPathSegment(h, k);
          const t = M.FPDFPathSegment_GetType(sg);
          if (t === FPDF_SEGMENT_MOVETO && !flush()) return undefined;
          if (t !== FPDF_SEGMENT_MOVETO && t !== FPDF_SEGMENT_LINETO) return undefined;
          M.FPDFPathSegment_GetPoint(sg, scratch, scratch + 4);
          pts.push([f32(scratch), f32(scratch + 4)]);
        }
        if (!flush() || out.length < 2) return undefined;
        return out;
      };
      const rgba = (getter: 'FPDFPageObj_GetFillColor' | 'FPDFPageObj_GetStrokeColor', h: number): [number, number, number, number] | null =>
        M[getter](h, scratch, scratch + 4, scratch + 8, scratch + 12) ? [u32(scratch), u32(scratch + 4), u32(scratch + 8), u32(scratch + 12)] : null;

      function shapes(): Shape[] {
        const out: Shape[] = [];
        let zc = 0;
        const visit = (h: number, parent: M6 | null) => {
          const z = zc++;
          const type = M.FPDFPageObj_GetType(h);
          if (type === FPDF_PAGEOBJ_FORM) {
            const fm = matrixOf(h);
            const m = parent ? mul(fm, parent) : fm;
            const n = M.FPDFFormObj_CountObjects(h);
            for (let k = 0; k < n; k++) visit(M.FPDFFormObj_GetObject(h, k), m);
            return;
          }
          if (type !== FPDF_PAGEOBJ_PATH && type !== FPDF_PAGEOBJ_IMAGE && type !== FPDF_PAGEOBJ_SHADING) return;
          M.FPDFPageObj_GetBounds(h, scratch, scratch + 4, scratch + 8, scratch + 12);
          let b = { x0: f32(scratch), y0: f32(scratch + 4), x1: f32(scratch + 8), y1: f32(scratch + 12) };
          if (parent) {   // bounds of an object inside a form are in the form's space
            const pts = [apply(parent, b.x0, b.y0), apply(parent, b.x1, b.y0), apply(parent, b.x0, b.y1), apply(parent, b.x1, b.y1)];
            b = { x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])) };
          }
          let filled = true, stroked = false, pathSegs = 0, isRect = false, rects: Rect[] | undefined;
          if (type === FPDF_PAGEOBJ_PATH) {
            M.FPDFPath_GetDrawMode(h, scratch, scratch + 4);
            filled = (raw.getValue(scratch, 'i32') as number) !== 0;
            stroked = (raw.getValue(scratch + 4, 'i32') as number) !== 0;
            pathSegs = M.FPDFPath_CountSegments(h);
            if (pathSegs >= 4 && pathSegs <= 6) {
              const pts: [number, number][] = [];
              let straight = true;
              for (let k = 0; k < pathSegs; k++) {
                const sg = M.FPDFPath_GetPathSegment(h, k);
                if (k > 0 && M.FPDFPathSegment_GetType(sg) !== FPDF_SEGMENT_LINETO) straight = false;
                M.FPDFPathSegment_GetPoint(sg, scratch, scratch + 4);
                pts.push([f32(scratch), f32(scratch + 4)]);
              }
              const xs = new Set(pts.map((p) => Math.round(p[0] * 10))), ys = new Set(pts.map((p) => Math.round(p[1] * 10)));
              const m = matrixOf(h);
              isRect = straight && xs.size === 2 && ys.size === 2 && Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6;
            }
            if (pathSegs >= 8 && pathSegs <= 400) rects = rectsOf(h, pathSegs, parent);
          }
          M.FPDFPageObj_GetStrokeWidth(h, scratch + 48);
          const w = b.x1 - b.x0, ht = b.y1 - b.y0;
          const isRule = type === FPDF_PAGEOBJ_PATH && (Math.min(w, ht) < 1.5) && Math.max(w, ht) > 6;
          out.push({
            index: out.length, kind: type === FPDF_PAGEOBJ_PATH ? 'path' : type === FPDF_PAGEOBJ_IMAGE ? 'image' : 'shading',
            bounds: b, inForm: parent !== null,
            fill: type === FPDF_PAGEOBJ_PATH && !filled ? null : rgba('FPDFPageObj_GetFillColor', h),
            stroke: type === FPDF_PAGEOBJ_PATH && stroked ? rgba('FPDFPageObj_GetStrokeColor', h) : null,
            strokeWidth: f32(scratch + 48), isRect, isRule, pathSegs, z, ...(rects ? { rects } : {}),
          });
        };
        const n = M.FPDFPage_CountObjects(pg);
        for (let k = 0; k < n; k++) visit(M.FPDFPage_GetObject(pg, k), null);
        return out;
      }

      function render(scale: number): Bitmap {
        const width = Math.max(1, Math.round(size.w * scale));
        const height = Math.max(1, Math.round(size.h * scale));
        const bmp = M.FPDFBitmap_CreateEx(width, height, FPDFBitmap_BGRA, 0, 0);
        try {
          M.FPDFBitmap_FillRect(bmp, 0, 0, width, height, 0xffffffff);
          raw._FPDF_RenderPageBitmap(bmp, pg, 0, 0, width, height, 0, FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER);
          const buf = M.FPDFBitmap_GetBuffer(bmp);
          const stride = M.FPDFBitmap_GetStride(bmp);
          const rgba = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
          for (let y = 0; y < height; y++) rgba.set(raw.HEAPU8.subarray(buf + y * stride, buf + y * stride + width * 4), y * width * 4);
          return { width, height, rgba };
        } finally { M.FPDFBitmap_Destroy(bmp); }
      }

      // ── page objects (src/objects) ──────────────────────────────────────────────────────────────────
      let engineObjs: { handle: number; rec: EngineObject }[] | null = null;
      const KINDS: Record<number, EngineObject['kind']> = { [FPDF_PAGEOBJ_TEXT]: 'text', [FPDF_PAGEOBJ_PATH]: 'path', [FPDF_PAGEOBJ_IMAGE]: 'image', [FPDF_PAGEOBJ_SHADING]: 'shading', [FPDF_PAGEOBJ_FORM]: 'form' };
      const markName = (mark: number): string => {
        if (!M.FPDFPageObjMark_GetName(mark, 0, 0, scratch + 60)) return '';
        const n = u32(scratch + 60);
        if (n <= 2) return '';
        const b = malloc(n);
        try { M.FPDFPageObjMark_GetName(mark, b, n, scratch + 60); return utf16At(b, n); } finally { free(b); }
      };
      function listObjects(): { handle: number; rec: EngineObject }[] {
        if (engineObjs) return engineObjs;
        const out: { handle: number; rec: EngineObject }[] = [];
        const visit = (h: number, parent: number | null, depth: number, outer: M6 | null) => {
          const type = M.FPDFPageObj_GetType(h);
          M.FPDFPageObj_GetBounds(h, scratch, scratch + 4, scratch + 8, scratch + 12);
          const corners = (pts: [number, number][]) => (outer ? pts.map(([x, y]) => apply(outer, x, y)) : pts);
          const bb = corners([[f32(scratch), f32(scratch + 4)], [f32(scratch + 8), f32(scratch + 4)], [f32(scratch), f32(scratch + 12)], [f32(scratch + 8), f32(scratch + 12)]]);
          let quad: [number, number][] | null = null;
          if (M.FPDFPageObj_GetRotatedBounds(h, scratch + 16)) quad = corners([0, 1, 2, 3].map((k) => [f32(scratch + 16 + k * 8), f32(scratch + 20 + k * 8)] as [number, number]));
          const marks: string[] = [];
          const nm = M.FPDFPageObj_CountMarks(h);
          for (let k = 0; k < nm; k++) { const mk = M.FPDFPageObj_GetMark(h, k); if (mk) marks.push(markName(mk)); }
          const rec: EngineObject = {
            index: out.length, kind: KINDS[type] ?? 'unknown', depth, parent,
            bounds: { x0: Math.min(...bb.map((p) => p[0])), y0: Math.min(...bb.map((p) => p[1])), x1: Math.max(...bb.map((p) => p[0])), y1: Math.max(...bb.map((p) => p[1])) },
            quad, mcid: M.FPDFPageObj_GetMarkedContentID(h), marks, transparent: !!M.FPDFPageObj_HasTransparency(h),
          };
          out.push({ handle: h, rec });
          if (type === FPDF_PAGEOBJ_FORM) {
            const fm = matrixOf(h);
            const m = outer ? mul(fm, outer) : fm;
            const n = M.FPDFFormObj_CountObjects(h);
            for (let k = 0; k < n; k++) visit(M.FPDFFormObj_GetObject(h, k), rec.index, depth + 1, m);
          }
        };
        const n = M.FPDFPage_CountObjects(pg);
        for (let k = 0; k < n; k++) visit(M.FPDFPage_GetObject(pg, k), null, 0, null);
        engineObjs = out;
        return out;
      }

      function paintsAt(indices: number[], x: number, y: number, scale = 2): boolean[] {
        const list = listObjects();
        const [vx, vy] = toView(view, x, y);
        const px = Math.floor(vx * scale), py = Math.floor((size.h - vy) * scale);
        const W = Math.max(1, Math.round(size.w * scale)), H = Math.max(1, Math.round(size.h * scale));
        if (px < 0 || py < 0 || px >= W || py >= H) return indices.map(() => false);
        const bmp = M.FPDFBitmap_CreateEx(1, 1, FPDFBitmap_BGRA, 0, 0);
        const pixel = (): number => {
          M.FPDFBitmap_FillRect(bmp, 0, 0, 1, 1, 0xffffffff);
          raw._FPDF_RenderPageBitmap(bmp, pg, -px, -py, W, H, 0, FPDF_ANNOT);
          return u32(M.FPDFBitmap_GetBuffer(bmp));
        };
        const near = (a: number, b: number) => [0, 8, 16, 24].every((sh) => Math.abs(((a >>> sh) & 255) - ((b >>> sh) & 255)) <= 8);
        try {
          const base = pixel();
          return indices.map((i) => {
            const o = list[i];
            if (!o) return false;
            M.FPDFPageObj_SetIsActive(o.handle, false);
            try { return !near(pixel(), base); } finally { M.FPDFPageObj_SetIsActive(o.handle, true); }
          });
        } finally { M.FPDFBitmap_Destroy(bmp); }
      }

      const close = () => { M.FPDFText_ClosePage(tp); M.FPDF_ClosePage(pg); open.delete(close); };
      open.add(close);
      return { index, size, view, chars, textObjects: () => walkObjects().map((o) => o.rec), shapes, render, close, objects: () => listObjects().map((o) => o.rec), paintsAt };
    }

    return {
      pageCount, page,
      close() { for (const c of [...open]) c(); M.FPDF_CloseDocument(doc); free(mem); },
    };
  }

  /** Loads a document from a private copy of `bytes`; the caller closes it with the returned function. */
  function load(bytes: Uint8Array): { doc: number; close(): void } {
    const mem = malloc(Math.max(1, bytes.length));
    raw.HEAPU8.set(bytes, mem);
    const doc = M.FPDF_LoadMemDocument(mem, bytes.length, '');
    if (!doc) {
      free(mem);
      const code = M.FPDF_GetLastError();
      throw new PdfiumOpenError(`PDFium could not open the document: ${OPEN_ERRORS[code] ?? 'error'} (error ${code})`, code);
    }
    return { doc, close: () => { M.FPDF_CloseDocument(doc); free(mem); } };
  }

  /** A full save of an open document (PDFiumExt_SaveAsCopy into a memory writer). */
  function saveCopy(doc: number): Uint8Array {
    const w = M.PDFiumExt_OpenFileWriter();
    if (!w) throw new Error('PDFium could not create a file writer');
    try {
      if (!M.PDFiumExt_SaveAsCopy(doc, w)) throw new Error(`PDFium could not save the document (error ${M.FPDF_GetLastError()})`);
      const n = M.PDFiumExt_GetFileWriterSize(w);
      const p = malloc(Math.max(1, n));
      try {
        const got = M.PDFiumExt_GetFileWriterData(w, p, n);
        if (got !== n) throw new Error(`PDFium wrote ${n} bytes but returned ${got}`);
        return raw.HEAPU8.slice(p, p + n);
      } finally { free(p); }
    } finally { M.PDFiumExt_CloseFileWriter(w); }
  }

  function security(bytes: Uint8Array) {
    let h: { doc: number; close(): void };
    try { h = load(bytes); } catch (e) {
      if (e instanceof PdfiumOpenError && e.needsPassword) return { encrypted: true, needsPassword: true, revision: -1, permissions: -1 };
      throw e;
    }
    try {
      const encrypted = M.EPDF_IsEncrypted(h.doc);
      return { encrypted, needsPassword: false, revision: M.FPDF_GetSecurityHandlerRevision(h.doc), permissions: encrypted ? M.FPDF_GetDocPermissions(h.doc) : -1 };
    } finally { h.close(); }
  }

  function decryptCopy(bytes: Uint8Array): Uint8Array | null {
    let h: { doc: number; close(): void };
    try { h = load(bytes); } catch (e) {
      if (e instanceof PdfiumOpenError && e.needsPassword) {
        throw new PdfiumOpenError('the document is encrypted with a user password: it cannot be opened, so it cannot be decrypted', e.code);
      }
      throw e;
    }
    try {
      if (!M.EPDF_IsEncrypted(h.doc)) return null;
      if (!M.EPDF_RemoveEncryption(h.doc)) throw new Error('PDFium could not remove the encryption (EPDF_RemoveEncryption failed)');
      return saveCopy(h.doc);
    } finally { h.close(); }
  }

  function repairCopy(bytes: Uint8Array): Uint8Array {
    const h = load(bytes);
    try { return saveCopy(h.doc); } finally { h.close(); }
  }

  return { open, module: M, decryptCopy, repairCopy, security };
}
