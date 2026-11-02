// Adding a PNG or JPEG image to a page: the op `add-image` (src/objects/ops.ts) records the image's file by a key, its
// frame in user space and a quarter turn; the file's bytes are held by key in this module's store (the app puts them
// in the worker's store before the op is made). Export writes each added image as an image XObject (an /SMask with
// it for PNG alpha; src/objects/imagefile.ts) painted on top of the page in one new content stream,
// `q a b c d e f cm /Name Do Q` per image (ISO 32000-1 §8.9.5: an image fills the unit square of the CTM), appended
// after every other change to the page, so the page's own streams keep their bytes.
//
// Placement: the image's natural size (its pixels at the resolution the file declares, else 72 dpi), made smaller to
// fit inside the page's shown box with a margin, centred on a point (a click or drop) or on the page, kept inside the
// page. On a page turned by /Rotate the image is turned the other way in user space, so it shows upright; the frame is
// the image's place in user space (src/engine/view.ts maps it from the shown page).
//
// `rotate` is the image's clockwise turn in user space, as /Rotate turns a page: 0, 90, 180 or 270. An added image is
// moved or resized by changing its op's frame and removed by removing its op (it has no object id in the source file).
import { PDFArray, PDFHexString, PDFName, PDFNumber, PDFRef, type PDFContext, type PDFObject } from 'pdf-lib';
import type { Rect } from '../engine/pdfium.ts';
import { fromView, toView, type ViewBox } from '../engine/view.ts';
import type { PdfEdit } from '../pdf/edit.ts';
import { inheritedResources } from '../pdf/fonts.ts';
import { mul, type M6 } from '../pdf/ops.ts';
import { fmtNum } from '../pdf/surgery.ts';
import { freshName, pdfName } from '../pdf/tree.ts';
import { ImageRefused, prepareImage, readImageInfo, type DictValue, type ImageInfo, type PreparedImage, type XImage } from './imagefile.ts';
import type { ObjectOp } from './ops.ts';

export type AddImage = Extract<ObjectOp, { op: 'add-image' }>;
export type Quarter = AddImage['rotate'];

// ── the store of image files, by key ───────────────────────────────────────────────────────────────────────────

const store = new Map<string, { bytes: Uint8Array; info: ImageInfo; prepared?: PreparedImage }>();

/** A key for a file's bytes: the first 128 bits of its SHA-256, in hex. */
export async function assetKey(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return [...d.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Checks an image file (ImageRefused when it is not a PNG or JPEG within the limits) and keeps it under its key. */
export async function putAsset(bytes: Uint8Array): Promise<{ key: string; info: ImageInfo }> {
  const info = readImageInfo(bytes);
  const key = await assetKey(bytes);
  if (!store.has(key)) store.set(key, { bytes: bytes.slice(), info });
  return { key, info };
}

export const hasAsset = (key: string) => store.has(key);

/** The XObject data for a stored file, made once (PNG decoding is the slow part). */
export function preparedAsset(key: string): PreparedImage | null {
  const a = store.get(key);
  if (!a) return null;
  return (a.prepared ??= prepareImage(a.bytes));
}

// ── placement ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The margin kept between a new image and the page's edge when it is made smaller to fit, as a share of each side. */
export const FIT_MARGIN = 0.05;

/** An image's natural size in points as shown: its shown pixels at the declared resolution, else 72 dpi. */
export function naturalSize(info: Pick<ImageInfo, 'shownW' | 'shownH' | 'dpi'>): { w: number; h: number } {
  const [dx, dy] = info.dpi && info.dpi[0] >= 1 && info.dpi[1] >= 1 ? info.dpi : [72, 72];
  return { w: (info.shownW * 72) / dx, h: (info.shownH * 72) / dy };
}

/** The clockwise turn in user space that shows an image upright on a page turned by `view.rotate`. */
export const uprightTurn = (view: ViewBox | null | undefined): Quarter => (((360 - (view?.rotate ?? 0)) % 360) as Quarter);

/**
 * Where a new image goes: its natural size made smaller (never larger) to fit inside the page's shown box less
 * FIT_MARGIN on each side, centred on `at` (user space) or the page's centre and kept inside the page; turned so it
 * shows upright. The frame is in user space.
 */
export function placeImage(info: Pick<ImageInfo, 'shownW' | 'shownH' | 'dpi'>, view: ViewBox, at?: { x: number; y: number } | null): { frame: Rect; rotate: Quarter } {
  const nat = naturalSize(info);
  const roomW = view.w * (1 - 2 * FIT_MARGIN), roomH = view.h * (1 - 2 * FIT_MARGIN);
  const k = Math.min(1, roomW / nat.w, roomH / nat.h);
  const w = nat.w * k, h = nat.h * k;   // shown size, view space
  let cx = view.w / 2, cy = view.h / 2;
  if (at) {
    const [ax, ay] = toView(view, at.x, at.y);
    cx = Math.min(Math.max(ax, w / 2), view.w - w / 2);
    cy = Math.min(Math.max(ay, h / 2), view.h - h / 2);
  }
  const [x0, y0] = fromView(view, cx - w / 2, cy - h / 2), [x1, y1] = fromView(view, cx + w / 2, cy + h / 2);
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return { frame: { x0: r(Math.min(x0, x1)), y0: r(Math.min(y0, y1)), x1: r(Math.max(x0, x1)), y1: r(Math.max(y0, y1)) }, rotate: uprightTurn(view) };
}

/** Exif orientation as a matrix from the stored image's unit square to the shown image's unit square. */
const ORIENT: Record<number, M6> = {
  1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, 1, 0], 3: [-1, 0, 0, -1, 1, 1], 4: [1, 0, 0, -1, 0, 1],
  5: [0, -1, -1, 0, 1, 1], 6: [0, -1, 1, 0, 0, 1], 7: [0, 1, 1, 0, 0, 0], 8: [0, 1, -1, 0, 1, 0],
};

/** The CTM that paints an image (its unit square) into `frame` turned clockwise by `rotate`, after its orientation. */
export function imageMatrix(frame: Rect, rotate: Quarter, orientation = 1): M6 {
  const { x0, y0, x1, y1 } = frame;
  const fw = x1 - x0, fh = y1 - y0;
  const place: M6 = rotate === 90 ? [0, -fh, fw, 0, x0, y1]
    : rotate === 180 ? [-fw, 0, 0, -fh, x1, y1]
    : rotate === 270 ? [0, fh, -fw, 0, x1, y0]
    : [fw, 0, 0, fh, x0, y0];
  return mul(ORIENT[orientation] ?? ORIENT[1], place);
}

// ── export ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** An added image the export writes: the op, its file's XObject data and its CTM. */
export type Placed = { op: AddImage; prepared: PreparedImage; m: M6 };

const finite = (r: Rect | undefined) => !!r && [r.x0, r.y0, r.x1, r.y1].every(Number.isFinite) && r.x1 - r.x0 > 1e-3 && r.y1 - r.y0 > 1e-3;

/** The added images that can be written, in order; the others are noted with the reason. */
export function planAdded(added: readonly AddImage[], notes: string[]): Placed[] {
  const out: Placed[] = [];
  for (const op of added) {
    if (!finite(op.frame)) { notes.push(`add-image ${op.key}: its frame is empty or not a number`); continue; }
    if (![0, 90, 180, 270].includes(op.rotate)) { notes.push(`add-image ${op.key}: a turn of ${op.rotate}° is not a quarter turn`); continue; }
    let prepared: PreparedImage | null;
    try { prepared = preparedAsset(op.asset); } catch (e) {
      notes.push(`add-image ${op.key}: ${e instanceof ImageRefused ? e.message : `the image cannot be read (${(e as Error).message})`}`);
      continue;
    }
    if (!prepared) { notes.push(`add-image ${op.key}: the image's file is not loaded here, so it was not written`); continue; }
    out.push({ op, prepared, m: imageMatrix(op.frame, op.rotate, prepared.info.orientation) });
  }
  return out;
}

function pdfValue(ctx: PDFContext, v: DictValue): PDFObject {
  if (typeof v === 'number') return PDFNumber.of(v);
  if (typeof v === 'string') return PDFName.of(v.replace(/^\//, ''));
  if (Array.isArray(v)) { const a = PDFArray.withContext(ctx); for (const x of v) a.push(pdfValue(ctx, x)); return a; }
  return PDFHexString.of([...v.hex].map((b) => b.toString(16).padStart(2, '0')).join(''));
}

function registerImage(ctx: PDFContext, x: XImage, extra: Record<string, PDFObject> = {}): PDFRef {
  const s = ctx.stream(x.data, {});
  s.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  s.dict.set(PDFName.of('Subtype'), PDFName.of('Image'));
  for (const [k, v] of Object.entries(x.dict)) s.dict.set(PDFName.of(k), pdfValue(ctx, v));
  for (const [k, v] of Object.entries(extra)) s.dict.set(PDFName.of(k), v);
  return ctx.register(s);
}

/**
 * Registers each placed image's XObjects in the document being written and makes the content that paints them, with
 * resource names the page does not use yet (read from its resources as they are now, so call this last).
 */
export function addedContent(edit: PdfEdit, page: number, placed: readonly Placed[]): { content: Uint8Array; xobjects: Record<string, PDFRef> } {
  const ctx = edit.context;
  const res = inheritedResources(ctx, edit.doc.getPage(page).node);
  const taken = new Set<string>();
  const xobjects: Record<string, PDFRef> = {};
  const lines: string[] = [];
  for (const p of placed) {
    const smask = p.prepared.smask ? registerImage(ctx, p.prepared.smask) : null;
    const ref = registerImage(ctx, p.prepared.image, smask ? { SMask: smask } : {});
    const name = freshName(ctx, res, 'XObject', 'PEIm', taken);
    taken.add(name);
    xobjects[name] = ref;
    lines.push(`q ${p.m.map(fmtNum).join(' ')} cm ${pdfName(name)} Do Q`);
  }
  return { content: new TextEncoder().encode(lines.join('\n') + '\n'), xobjects };
}

/** The page-space box an added image paints (its frame: quarter turns keep it a box). */
export const placedBounds = (p: Placed): Rect => ({ ...p.op.frame });
