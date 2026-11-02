// Adding PNG and JPEG images to a page (src/objects/place.ts, src/objects/imagefile.ts, the add-image op through
// src/export/objects.ts): reading every PNG colour type and bit depth (interlaced too) to the samples written, JPEG
// copied byte for byte with /DCTDecode, PNG alpha as an /SMask, palette images, Exif orientations, placement on pages
// turned by /Rotate, the size limits, undo and redo of the op, appendContent's resources map, and the export's checks
// (pixels change only inside the image's frame, every other object byte-identical, the image found at its frame).
// Synthetic images only (src/objects/placekit.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';
import { openPdfium, type Bitmap, type Rect } from '../engine/pdfium.ts';
import { diffOutside } from '../engine/diff.ts';
import { rectToPixels, type ViewBox } from '../engine/view.ts';
import { openForEdit } from '../pdf/edit.ts';
import { hasNoto, hasQpdf, lastStartxref, latin1, qpdfCheck, readXrefSection } from '../pdf/testing.ts';
import { loadFonts } from '../model/fonts.ts';
import { Editor } from '../model/edit.ts';
import type { Doc } from '../model/types.ts';
import { exportDoc, type ExportOptions, type PageReport } from '../export/export.ts';
import '../export/objects.ts';
import { boxOf, laidText, readPages } from '../export/testkit.ts';
import { listObjects } from './list.ts';
import type { ObjectOp } from './ops.ts';
import { IMAGE_LIMITS, decodePng, readImageInfo, ImageRefused } from './imagefile.ts';
import { imageMatrix, naturalSize, placeImage, putAsset, uprightTurn, FIT_MARGIN, type AddImage } from './place.ts';
import { pngHeaderOnly, writeJpeg, writePng, type PngSpec } from './placekit.ts';
import { objectsPage, rotatedPage } from './testkit.ts';
import type { PageObjects } from './types.ts';

type RGB = [number, number, number];
const RED: RGB = [220, 30, 30], GREEN: RGB = [20, 170, 60], BLUE: RGB = [30, 60, 200], YELLOW: RGB = [240, 210, 20], GREY: RGB = [153, 153, 153], WHITE: RGB = [255, 255, 255];
const like = (c: RGB, want: RGB, tol = 12) => c.every((v, i) => Math.abs(v - want[i]) <= tol);
const grow = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });
const near = (a: Rect, b: Rect, tol = 0.6) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
const noText = () => { throw new Error('no text is laid out in these tests'); };
const noFaces: ExportOptions['faces'] = () => { throw new Error('no fonts are needed in these tests'); };

type Run = { model: PageObjects; out: Uint8Array; pr: PageReport; after: PageObjects; ok: boolean; failures: string[] };
async function run(bytes: Uint8Array, ops: ObjectOp[], opts: Pick<ExportOptions, 'beforeVerify'> = {}): Promise<Run> {
  const [model] = await listObjects(bytes, [0]);
  const doc: Doc = { pages: [{ n: 0, w: model.view.w, h: model.view.h, boxes: [], view: model.view, objectOps: ops }] };
  const { bytes: out, report } = await exportDoc(bytes, doc, noText, { verify: 'report', faces: noFaces, ...opts });
  const [after] = await listObjects(out, [0]);
  return { model, out, pr: report.pages[0], after, ok: report.ok, failures: report.failures };
}
async function render(bytes: Uint8Array, scale = 2): Promise<{ bmp: Bitmap; view: ViewBox; scale: number; h: number }> {
  const P = await openPdfium();
  const doc = P.open(bytes);
  try { const pg = doc.page(0); try { return { bmp: pg.render(scale), view: pg.view, scale, h: pg.size.h }; } finally { pg.close(); } } finally { doc.close(); }
}
type Shot = Awaited<ReturnType<typeof render>>;
/** The colour at fractions (fx right, fy down) of a user-space rectangle as it is shown. */
function at(s: Shot, r: Rect, fx: number, fy: number): RGB {
  const q = rectToPixels(s.view, r, s.scale, s.h);
  const x = Math.floor(q.x0 + fx * (q.x1 - q.x0)), y = Math.floor(q.y0 + fy * (q.y1 - q.y0));
  const k = (y * s.bmp.width + x) * 4;
  return [s.bmp.rgba[k], s.bmp.rgba[k + 1], s.bmp.rgba[k + 2]];
}
/** Verification passed; no pixel outside the frame (grown 1 pt) changed at all; the output reads cleanly. */
async function clean(original: Uint8Array, r: Run, frames: Rect[]) {
  assert.ok(r.ok, r.failures.join('\n'));
  const [a, b] = [await render(original), await render(r.out)];
  const d = diffOutside(a.bmp, b.bmp, frames.map((f) => grow(f, 1)), a.scale, a.view, 0);
  assert.equal(d.differing, 0, `${d.differing} pixels changed outside the image's frame`);
  assert.deepEqual(r.after.notes, [], r.after.notes.join('; '));
  if (hasQpdf) assert.ok(qpdfCheck(r.out).ok, 'qpdf --check');
}
/** The original is a prefix; the objects the last update appends: old object numbers and how many new. */
function appended(original: Uint8Array, out: Uint8Array): { old: number[]; added: number } {
  assert.deepEqual(out.subarray(0, original.length), original, 'the original bytes are a prefix');
  const size = readXrefSection(original, lastStartxref(original)).size;
  const keys = [...readXrefSection(out, lastStartxref(out)).entries.keys()];
  return { old: keys.filter((k) => k < size).sort((p, q) => p - q), added: keys.filter((k) => k >= size).length };
}
/** The added image XObjects of the output's page 0, by resource name. */
async function addedXObjects(out: Uint8Array): Promise<Map<string, PDFRawStream>> {
  const doc = await PDFDocument.load(out, { updateMetadata: false });
  const res = doc.getPage(0).node.Resources()!;
  const x = res.lookup(PDFName.of('XObject'), PDFDict);
  const m = new Map<string, PDFRawStream>();
  for (const [k, v] of x.entries()) if (k.decodeText().startsWith('PEIm')) m.set(k.decodeText(), doc.context.lookup(v as PDFRef) as PDFRawStream);
  return m;
}
const nameOf = (d: PDFDict, k: string) => (d.get(PDFName.of(k)) as PDFName | undefined)?.decodeText();
const numOf = (d: PDFDict, k: string) => (d.get(PDFName.of(k)) as PDFNumber | undefined)?.asNumber();
const addOp = (key: string, asset: string, frame: Rect, rotate: AddImage['rotate'] = 0): AddImage => ({ op: 'add-image', key, asset, frame, rotate });

/** A quadrant image as shown: top left red, top right green, bottom left blue, bottom right yellow. */
const quadrant = (fx: number, fy: number): RGB => (fy < 0.5 ? (fx < 0.5 ? RED : GREEN) : fx < 0.5 ? BLUE : YELLOW);

// ---------------------------------------------------------------------------------------------------------------
// reading files

test('PNG: every colour type and bit depth, both interlace methods, read to the samples written', () => {
  const W = 13, H = 11;   // not multiples of 8, so the Adam7 passes are uneven
  const specs: { name: string; s: Omit<PngSpec, 'pixel' | 'width' | 'height'>; pixel: (x: number, y: number) => number[] }[] = [];
  for (const depth of [1, 2, 4, 8, 16] as const) specs.push({ name: `grey ${depth}`, s: { ctype: 0, depth }, pixel: (x, y) => [(x * 3 + y) % (1 << depth)] });
  for (const depth of [8, 16] as const) {
    const m = (1 << depth) - 1;
    specs.push({ name: `rgb ${depth}`, s: { ctype: 2, depth }, pixel: (x, y) => [(x * 977) % m, (y * 1531) % m, ((x + y) * 7919) % m] });
    specs.push({ name: `grey+alpha ${depth}`, s: { ctype: 4, depth }, pixel: (x, y) => [(x * 4099) % m, (y * 8191) % m] });
    specs.push({ name: `rgba ${depth}`, s: { ctype: 6, depth }, pixel: (x, y) => [(x * 977) % m, (y * 1531) % m, 7, ((x * y) * 613) % m] });
  }
  const pal: [number, number, number][] = Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, (i * 37) % 256]);
  for (const depth of [1, 2, 4, 8] as const) specs.push({ name: `palette ${depth}`, s: { ctype: 3, depth, palette: pal.slice(0, Math.min(16, 1 << depth)) }, pixel: (x, y) => [(x + 2 * y) % Math.min(16, 1 << depth)] });
  specs.push({ name: 'palette with tRNS', s: { ctype: 3, depth: 4, palette: pal, trns: [255, 0, 128] }, pixel: (x, y) => [(x + y) % 16] });
  specs.push({ name: 'grey 16 with a tRNS key', s: { ctype: 0, depth: 16, trns: [4660] }, pixel: (x) => [x === 3 ? 4660 : 4661] });
  specs.push({ name: 'rgb 8 with a tRNS key', s: { ctype: 2, depth: 8, trns: [1, 2, 3] }, pixel: (x) => (x === 5 ? [1, 2, 3] : [1, 2, 4]) });
  for (const { name, s, pixel } of specs) {
    for (const interlace of [false, true]) {
      const spec: PngSpec = { ...s, width: W, height: H, pixel, interlace };
      const d = decodePng(writePng(spec));
      const to8 = (v: number) => (s.depth === 16 ? Math.round(v / 257) : s.depth === 8 ? v : Math.round((v * 255) / ((1 << s.depth) - 1)));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const p = pixel(x, y), i = y * W + x, where = `${name}${interlace ? ' interlaced' : ''} at ${x},${y}`;
        let alpha = 255;
        if (s.ctype === 3) { assert.equal(d.samples[i], p[0], where); alpha = s.trns?.[p[0]] ?? 255; }
        else if (s.ctype === 0 || s.ctype === 4) { assert.equal(d.samples[i], to8(p[0]), where); if (s.ctype === 4) alpha = to8(p[1]); else if (s.trns && p[0] === s.trns[0]) alpha = 0; }
        else {
          for (let k = 0; k < 3; k++) assert.equal(d.samples[i * 3 + k], to8(p[k]), where);
          if (s.ctype === 6) alpha = to8(p[3]); else if (s.trns && p.every((v, k) => v === s.trns![k])) alpha = 0;
        }
        assert.equal(d.alpha ? d.alpha[i] : 255, alpha, `${where}: alpha`);
      }
      assert.equal(d.space, s.ctype === 3 ? 'palette' : s.ctype === 2 || s.ctype === 6 ? 'rgb' : 'grey');
    }
  }
  // an opaque image has no alpha plane
  assert.equal(decodePng(writePng({ width: 4, height: 4, ctype: 6, depth: 8, pixel: () => [1, 2, 3, 255] })).alpha, null);
});

test('file headers: size, resolution, orientation; files over the limits or unreadable are refused with a reason', () => {
  const png = readImageInfo(writePng({ width: 40, height: 20, ctype: 2, depth: 8, dpi: 144, pixel: () => [0, 0, 0] }));
  assert.deepEqual([png.format, png.width, png.height, png.shownW, png.shownH], ['png', 40, 20, 40, 20]);
  assert.ok(Math.abs(png.dpi![0] - 144) < 0.1);
  const nat = naturalSize(png);
  assert.ok(Math.abs(nat.w - 20) < 0.01 && Math.abs(nat.h - 10) < 0.01, `144 dpi: half the 72 dpi size (${nat.w} × ${nat.h})`);
  const jpg = readImageInfo(writeJpeg({ width: 48, height: 16, comps: 3, orientation: 6, dpi: 300, block: () => RED }));
  assert.deepEqual([jpg.format, jpg.width, jpg.height, jpg.orientation, jpg.shownW, jpg.shownH, jpg.coding], ['jpeg', 48, 16, 6, 16, 48, 'baseline']);
  assert.deepEqual(jpg.dpi, [300, 300]);
  const refused = (b: Uint8Array, re: RegExp) => assert.throws(() => readImageInfo(b), (e: Error) => e instanceof ImageRefused && re.test(e.message));
  refused(pngHeaderOnly(IMAGE_LIMITS.side + 1, 10), /pixels a side/);
  refused(pngHeaderOnly(4097, 4097), /PNG images up to 16\.8 million pixels/);
  const jpegHead = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
  assert.equal(readImageInfo(jpegHead(6000, 6000)).width, 6000, 'a 36 million pixel JPEG is taken');
  refused(jpegHead(7000, 7000), /JPEG images up to 40\.0 million pixels/);
  const big = new Uint8Array(IMAGE_LIMITS.bytes + 1);
  big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  refused(big, /image files up to 32 MB/);
  refused(writeJpeg({ width: 8, height: 8, comps: 1, sof: 0xc9, block: () => [0] }), /arithmetic-coded/);
  refused(writeJpeg({ width: 8, height: 8, comps: 1, precision: 12, block: () => [0] }), /12-bit/);
  refused(latin1('GIF89a\x01\x00\x01\x00'), /Only PNG and JPEG/);
  refused(writePng({ width: 4, height: 4, ctype: 2, depth: 8, pixel: () => [0, 0, 0] }).subarray(0, 40), /cannot be read/);
  // image data that does not match the header's size
  const short = pngHeaderOnly(100, 100);
  assert.equal(readImageInfo(short).width, 100, 'the header alone reads');
  assert.throws(() => decodePng(short), /cut short|more image data/);
});

test('placement: natural size, made smaller to fit the page with a margin, centred on a point and kept on the page', () => {
  const view: ViewBox = { rotate: 0, crop: { x0: 0, y0: 0, x1: 600, y1: 800 }, media: null, w: 600, h: 800 };
  const small = placeImage({ shownW: 100, shownH: 50, dpi: null }, view);
  assert.deepEqual(small.frame, { x0: 250, y0: 375, x1: 350, y1: 425 });
  const huge = placeImage({ shownW: 3000, shownH: 1000, dpi: null }, view);
  assert.ok(Math.abs(huge.frame.x1 - huge.frame.x0 - 600 * (1 - 2 * FIT_MARGIN)) < 0.01);
  assert.ok(Math.abs((huge.frame.x1 - huge.frame.x0) / (huge.frame.y1 - huge.frame.y0) - 3) < 1e-3, 'the aspect ratio is kept');
  const corner = placeImage({ shownW: 100, shownH: 50, dpi: null }, view, { x: 590, y: 10 });
  assert.deepEqual(corner.frame, { x0: 500, y0: 0, x1: 600, y1: 50 }, 'a point near the corner: kept on the page');
  // a turned page with a crop box away from the origin: the shown box is the turned crop box
  const turned: ViewBox = { rotate: 90, crop: { x0: 50, y0: 100, x1: 400, y1: 600 }, media: null, w: 500, h: 350 };
  const p = placeImage({ shownW: 200, shownH: 100, dpi: null }, turned);
  assert.equal(p.rotate, 270);
  assert.deepEqual(p.frame, { x0: 175, y0: 250, x1: 275, y1: 450 }, 'upright on the shown page: 100 wide in user space, 200 tall');
  assert.deepEqual([0, 90, 180, 270].map((r) => uprightTurn({ ...turned, rotate: r as ViewBox['rotate'] })), [0, 270, 180, 90]);
});

// ---------------------------------------------------------------------------------------------------------------
// export

test('a JPEG goes in byte for byte with /DCTDecode, on top of the page; nothing else changes', async () => {
  const f = await objectsPage();
  // 64 × 32: left half red, right half blue
  const jpeg = writeJpeg({ width: 64, height: 32, comps: 3, block: (bx) => (bx < 4 ? RED : BLUE) });
  const { key } = await putAsset(jpeg);
  const frame = { x0: 360, y0: 610, x1: 488, y1: 674 };   // over the ring's right side
  const r = await run(f.bytes, [addOp('j1', key, frame)]);
  await clean(f.bytes, r, [frame]);
  assert.deepEqual(r.pr.imagesAdded?.map((i) => [i.key, i.format, i.pixels, i.smask]), [['j1', 'jpeg', [64, 32], false]]);
  const xs = [...(await addedXObjects(r.out)).values()];
  assert.equal(xs.length, 1);
  assert.deepEqual(xs[0].getContents(), jpeg, 'the stream is the file');
  assert.equal(nameOf(xs[0].dict, 'Filter'), 'DCTDecode');
  assert.equal(nameOf(xs[0].dict, 'ColorSpace'), 'DeviceRGB');
  const s = await render(r.out);
  assert.ok(like(at(s, frame, 0.25, 0.5), RED), `left: ${at(s, frame, 0.25, 0.5)}`);
  assert.ok(like(at(s, frame, 0.75, 0.5), BLUE), `right: ${at(s, frame, 0.75, 0.5)}`);
  // the ring's stroke at x = 400 is under the image now; outside the frame it is still there
  assert.ok(like(at(s, { x0: 398, y0: 600, x1: 402, y1: 604 }, 0.5, 0.5), [0, 0, 0], 60));
  // the update: the page dictionary, the q and Q brackets, the new content stream, the image
  const ap = appended(f.bytes, r.out);
  assert.deepEqual(ap.old, [(await PDFDocument.load(f.bytes)).getPage(0).ref.objectNumber]);
  assert.equal(ap.added, 4);
  // the added image is the last object painted, at its frame
  const last = r.after.objects[r.after.objects.length - 1];
  assert.equal(last.kind, 'image');
  assert.ok(near(last.bounds, frame, 0.01), JSON.stringify(last.bounds));
  assert.equal(r.after.objects.length, r.model.objects.length + 1);
});

test('grey and CMYK JPEG: device colour spaces; an Adobe CMYK file is read with its inks inverted back', async () => {
  const f = await objectsPage();
  const grey = await putAsset(writeJpeg({ width: 16, height: 16, comps: 1, block: () => [90] }));
  // CMYK: cyan ink on the left, magenta on the right
  const cmyk = await putAsset(writeJpeg({ width: 32, height: 16, comps: 4, block: (bx) => (bx < 2 ? [255, 0, 0, 0] : [0, 255, 0, 0]) }));
  const fg = { x0: 420, y0: 700, x1: 452, y1: 732 }, fc = { x0: 460, y0: 700, x1: 524, y1: 732 };
  const r = await run(f.bytes, [addOp('g', grey.key, fg), addOp('c', cmyk.key, fc)]);
  await clean(f.bytes, r, [fg, fc]);
  const xs = [...(await addedXObjects(r.out)).values()];
  assert.deepEqual(xs.map((x) => nameOf(x.dict, 'ColorSpace')), ['DeviceGray', 'DeviceCMYK']);
  assert.deepEqual((xs[1].dict.get(PDFName.of('Decode')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber()), [1, 0, 1, 0, 1, 0, 1, 0]);
  const s = await render(r.out);
  assert.ok(like(at(s, fg, 0.5, 0.5), [90, 90, 90], 4), `grey: ${at(s, fg, 0.5, 0.5)}`);
  const cyan = at(s, fc, 0.25, 0.5), magenta = at(s, fc, 0.75, 0.5);
  assert.ok(cyan[0] < 80 && cyan[1] > 120 && cyan[2] > 180, `cyan ink shows cyan: ${cyan}`);
  assert.ok(magenta[1] < 80 && magenta[0] > 180 && magenta[2] > 80, `magenta ink shows magenta: ${magenta}`);
});

test('a PNG with alpha: colour re-compressed with Flate, alpha as an /SMask; see-through where alpha is 0', async () => {
  const f = await objectsPage();
  const frame = { x0: 80, y0: 610, x1: 180, y1: 670 };   // over the grey rectangle (72, 600 – 192, 680)
  for (const depth of [8, 16] as const) {
    const m = (1 << depth) - 1, k = (v: number) => Math.round((v * m) / 255);
    // left third clear, middle third half alpha, right third opaque green
    const png = writePng({ width: 30, height: 10, ctype: 6, depth, pixel: (x) => [k(GREEN[0]), k(GREEN[1]), k(GREEN[2]), x < 10 ? 0 : x < 20 ? k(128) : m] });
    const { key } = await putAsset(png);
    const r = await run(f.bytes, [addOp('p', key, frame)]);
    await clean(f.bytes, r, [frame]);
    const [x] = (await addedXObjects(r.out)).values();
    assert.equal(nameOf(x.dict, 'Filter'), 'FlateDecode');
    assert.equal(nameOf(x.dict, 'ColorSpace'), 'DeviceRGB');
    assert.equal(numOf(x.dict, 'BitsPerComponent'), 8);
    const sm = r.out && (await PDFDocument.load(r.out)).context.lookup(x.dict.get(PDFName.of('SMask')) as PDFRef) as PDFStream;
    assert.ok(sm instanceof PDFStream, `${depth}-bit: an /SMask`);
    assert.equal(nameOf(sm.dict, 'ColorSpace'), 'DeviceGray');
    const s = await render(r.out);
    assert.ok(like(at(s, frame, 1 / 6, 0.5), GREY, 3), `${depth}-bit, clear: the grey rectangle shows (${at(s, frame, 1 / 6, 0.5)})`);
    const half = at(s, frame, 0.5, 0.5), want = GREY.map((g, i) => g + (GREEN[i] - g) * (128 / 255)) as RGB;
    assert.ok(like(half, want, 6), `${depth}-bit, half: ${half} ≈ ${want}`);
    assert.ok(like(at(s, frame, 5 / 6, 0.5), GREEN, 3), `${depth}-bit, opaque: green`);
  }
});

test('a palette PNG: /Indexed over /DeviceRGB; its tRNS entries make the /SMask; interlaced reads the same', async () => {
  const f = await objectsPage();
  const frame = { x0: 80, y0: 610, x1: 180, y1: 670 };
  const palette: [number, number, number][] = [RED, GREEN, BLUE, YELLOW];
  // quadrants: index 0 1 / 2 3; entry 1 (green) fully clear
  const png = writePng({ width: 20, height: 12, ctype: 3, depth: 2, palette, trns: [255, 0, 255, 255], interlace: true, pixel: (x, y) => [(y < 6 ? 0 : 2) + (x < 10 ? 0 : 1)] });
  const { key } = await putAsset(png);
  const r = await run(f.bytes, [addOp('pal', key, frame)]);
  await clean(f.bytes, r, [frame]);
  const [x] = (await addedXObjects(r.out)).values();
  const cs = (x.dict.get(PDFName.of('ColorSpace')) as PDFArray).asArray();
  assert.deepEqual([(cs[0] as PDFName).decodeText(), (cs[1] as PDFName).decodeText(), (cs[2] as PDFNumber).asNumber()], ['Indexed', 'DeviceRGB', 3]);
  assert.ok(x.dict.get(PDFName.of('SMask')));
  const s = await render(r.out);
  assert.ok(like(at(s, frame, 0.25, 0.25), RED, 3));
  assert.ok(like(at(s, frame, 0.75, 0.25), [51, 179, 77], 3), `the clear entry shows the green rectangle under it: ${at(s, frame, 0.75, 0.25)}`);
  assert.ok(like(at(s, frame, 0.25, 0.75), BLUE, 3));
  assert.ok(like(at(s, frame, 0.75, 0.75), YELLOW, 3));
});

test('Exif orientations 1–8: the image shows as the file is meant to be seen', async () => {
  const f = await objectsPage();
  const frame = { x0: 420, y0: 690, x1: 500, y1: 730 };   // shown 32 × 16 → 80 × 40 pt
  // the shown image: 4 × 2 blocks in quadrant colours; stored so that the orientation brings it there
  const SW = 4, SH = 2;
  const shown = (bx: number, by: number) => quadrant((bx + 0.5) / SW, (by + 0.5) / SH);
  for (let o = 1; o <= 8; o++) {
    const swap = o >= 5;
    const W = swap ? SH : SW, H = swap ? SW : SH;   // stored blocks
    // where stored block (x, y) shows (y down), per the Exif definition of each orientation
    const map = (x: number, y: number): [number, number] => [
      [x, y], [W - 1 - x, y], [W - 1 - x, H - 1 - y], [x, H - 1 - y], [y, x], [H - 1 - y, x], [H - 1 - y, W - 1 - x], [y, W - 1 - x],
    ][o - 1] as [number, number];
    const jpeg = writeJpeg({ width: W * 8, height: H * 8, comps: 3, orientation: o, block: (x, y) => shown(...map(x, y)) });
    const { key, info } = await putAsset(jpeg);
    assert.deepEqual([info.shownW, info.shownH], [32, 16]);
    const r = await run(f.bytes, [addOp(`o${o}`, key, frame)]);
    await clean(f.bytes, r, [frame]);
    const s = await render(r.out);
    for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      assert.ok(like(at(s, frame, fx, fy), quadrant(fx, fy)), `orientation ${o} at ${fx},${fy}: ${at(s, frame, fx, fy)} for ${quadrant(fx, fy)}`);
    }
  }
});

test('pages turned by /Rotate with an offset crop box: placed through the page view, the image shows upright', async () => {
  // quadrant PNG, 40 × 20 pixels
  const png = writePng({ width: 40, height: 20, ctype: 2, depth: 8, pixel: (x, y) => quadrant((x + 0.5) / 40, (y + 0.5) / 20) });
  const { key, info } = await putAsset(png);
  for (const rot of [0, 90, 180, 270] as const) {
    const f = rot ? await rotatedPage(rot) : await objectsPage();
    const [model] = await listObjects(f.bytes, [0]);
    for (const point of [null, model.view.rotate ? { x: 120, y: 450 } : { x: 450, y: 720 }]) {
      const p = placeImage(info, model.view, point);
      assert.equal(p.rotate, uprightTurn(model.view));
      const r = await run(f.bytes, [addOp('q', key, p.frame, p.rotate)]);
      await clean(f.bytes, r, [p.frame]);
      const s = await render(r.out);
      // on the shown page: 40 × 20 pt, upright
      const q = rectToPixels(s.view, p.frame, 1, s.h);
      assert.ok(Math.abs(q.x1 - q.x0 - 40) < 0.01 && Math.abs(q.y1 - q.y0 - 20) < 0.01, `/Rotate ${rot}: shown ${q.x1 - q.x0} × ${q.y1 - q.y0}`);
      for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        assert.ok(like(at(s, p.frame, fx, fy), quadrant(fx, fy)), `/Rotate ${rot}${point ? ' at a point' : ''}, ${fx},${fy}: ${at(s, p.frame, fx, fy)}`);
      }
      if (point) {
        // centred on the point, as shown
        const c = rectToPixels(s.view, { x0: point.x, y0: point.y, x1: point.x, y1: point.y }, 1, s.h);
        assert.ok(Math.abs((q.x0 + q.x1) / 2 - c.x0) < 0.01 && Math.abs((q.y0 + q.y1) / 2 - c.y0) < 0.01, `/Rotate ${rot}: centred on the point`);
      }
    }
  }
});

test('quarter turns of the op: the matrix turns the image clockwise in its frame', async () => {
  const png = writePng({ width: 20, height: 20, ctype: 2, depth: 8, pixel: (x, y) => quadrant((x + 0.5) / 20, (y + 0.5) / 20) });
  const { key } = await putAsset(png);
  const f = await objectsPage();
  const frame = { x0: 420, y0: 690, x1: 460, y1: 730 };
  // turned clockwise by 90: the top-left quadrant (red) is now top right
  const want: Record<number, RGB[]> = { 0: [RED, GREEN, BLUE, YELLOW], 90: [BLUE, RED, YELLOW, GREEN], 180: [YELLOW, BLUE, GREEN, RED], 270: [GREEN, YELLOW, RED, BLUE] };
  for (const rot of [0, 90, 180, 270] as const) {
    const r = await run(f.bytes, [addOp('t', key, frame, rot)]);
    await clean(f.bytes, r, [frame]);
    const s = await render(r.out);
    const got = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => at(s, frame, x, y));
    got.forEach((c, i) => assert.ok(like(c, want[rot][i]), `turn ${rot}, quadrant ${i}: ${c}`));
    const m = imageMatrix(frame, rot);
    assert.ok(Math.abs(Math.abs(m[0] * m[3] - m[1] * m[2]) - 1600) < 1e-9, 'the unit square becomes the frame');
  }
});

test('added images with moves and deletes on the same page, and with edited text: all written, all verified', async () => {
  const f = await objectsPage();
  const [m] = await listObjects(f.bytes, [0]);
  const grey = m.objects.find((o) => o.kind === 'path' && !o.parent)!;
  const red = m.objects.find((o) => o.kind === 'image' && !o.parent)!;
  const a = await putAsset(writePng({ width: 8, height: 8, ctype: 2, depth: 8, pixel: () => YELLOW }));
  const b = await putAsset(writeJpeg({ width: 8, height: 8, comps: 3, block: () => BLUE }));
  const fa = { x0: 420, y0: 700, x1: 460, y1: 740 }, fb = { x0: 440, y0: 720, x1: 480, y1: 760 };   // b over a
  const ops: ObjectOp[] = [{ op: 'transform', ids: [grey.id], m: [1, 0, 0, 1, 0, -40] }, addOp('a', a.key, fa), { op: 'delete', ids: [red.id] }, addOp('b', b.key, fb)];
  const r = await run(f.bytes, ops);
  assert.ok(r.ok, r.failures.join('\n'));
  assert.equal(r.pr.objectsChanged!.length, 2);
  assert.deepEqual(r.pr.imagesAdded!.map((i) => i.key), ['a', 'b'], 'in the order of the ops');
  const s = await render(r.out);
  assert.ok(like(at(s, fb, 0.25, 0.75), BLUE), 'the later image is on top');
  assert.ok(like(at(s, fa, 0.25, 0.25), YELLOW));
  const tail = r.after.objects.slice(-2);
  assert.ok(tail.every((o) => o.kind === 'image') && near(tail[0].bounds, fa, 0.01) && near(tail[1].bounds, fb, 0.01));
  if (!hasNoto) return;
  // and text edited on the page: the new text is written, the images on top of it
  const [pr] = await readPages(f.bytes);
  const box = boxOf(pr, 'h', [0], { edited: true });
  const laid = await laidText(box, 'A new heading');
  const over = { x0: 70, y0: 770, x1: 110, y1: 800 };   // over the heading's start
  const doc: Doc = { pages: [{ n: 0, w: 595, h: 842, boxes: [box], view: m.view, objectOps: [addOp('a', a.key, over)] }] };
  const { bytes, report } = await exportDoc(f.bytes, doc, () => laid, { verify: 'report' });
  assert.ok(report.ok, report.failures.join('\n'));
  assert.equal(report.pages[0].written.length, 1);
  const s2 = await render(bytes);
  assert.ok(like(at(s2, over, 0.5, 0.5), YELLOW), 'the image covers the new text');
});

test('the verification finds an added image missing, misplaced, or extra objects', async () => {
  const f = await objectsPage();
  const { key } = await putAsset(writePng({ width: 8, height: 8, ctype: 2, depth: 8, pixel: () => GREEN }));
  const frame = { x0: 420, y0: 700, x1: 460, y1: 740 };
  const ops = [addOp('a', key, frame)];
  const tamper = (from: RegExp, to: string) => async (bytes: Uint8Array) => {
    const ed = await openForEdit(bytes);
    const s = String.fromCharCode(...ed.contents(0));
    assert.ok(from.test(s), s.slice(-200));
    ed.setContents(0, Uint8Array.from(s.replace(from, to), (ch) => ch.charCodeAt(0)));
    return ed.save();
  };
  const missing = await run(f.bytes, ops, { beforeVerify: async () => f.bytes });
  assert.ok(missing.failures.some((x) => x.includes('added image 1 is not in the output')), missing.failures.join('\n'));
  const moved = await run(f.bytes, ops, { beforeVerify: tamper(/40 0 0 40 420 700 cm/, '40 0 0 40 430 700 cm') });
  assert.ok(moved.failures.some((x) => x.includes('added image 1 is not in the output at 420.0,700.0')), moved.failures.join('\n'));
  assert.ok(moved.failures.some((x) => /pixels changed outside/.test(x)));
  const extra = await run(f.bytes, ops, { beforeVerify: tamper(/q 40 0 0 40 420 700 cm (\/PEIm1) Do Q/, 'q 40 0 0 40 420 700 cm $1 Do Q q 10 0 0 10 420 700 cm $1 Do Q') });
  assert.ok(extra.failures.some((x) => /objects where \d+ were expected/.test(x)), extra.failures.join('\n'));
});

test('an image whose file is not loaded, or a bad frame: noted, nothing written', async () => {
  const f = await objectsPage();
  const { key } = await putAsset(writePng({ width: 8, height: 8, ctype: 2, depth: 8, pixel: () => GREEN }));
  const r = await run(f.bytes, [addOp('gone', 'no-such-asset', { x0: 1, y0: 1, x1: 9, y1: 9 }), addOp('flat', key, { x0: 5, y0: 5, x1: 5, y1: 50 })]);
  assert.ok(r.ok, r.failures.join('\n'));
  assert.deepEqual(r.out, f.bytes, 'the file is unchanged');
  assert.ok(r.pr.objectNotes!.some((n) => n.includes('gone') && n.includes('not loaded')), r.pr.objectNotes!.join('; '));
  assert.ok(r.pr.objectNotes!.some((n) => n.includes('flat') && n.includes('empty')));
});

test('undo and redo of adding, moving and removing an image restore the op list exactly', async () => {
  const fonts = await loadFonts();
  const doc: Doc = { pages: [{ n: 0, w: 595, h: 842, boxes: [] }] };
  const ed = new Editor(doc, fonts);
  const edit = (fn: (ops: ObjectOp[]) => ObjectOp[]) => ed.pageEdit(0, 'objects', (pg) => { pg.objectOps = fn(pg.objectOps ?? []); }, ['objectOps']);
  const frame = { x0: 10, y0: 20, x1: 110, y1: 70 };
  edit((ops) => [...ops, addOp('i1', 'asset', frame)]);
  const one = structuredClone(doc.pages[0].objectOps);
  edit((ops) => ops.map((o) => (o.op === 'add-image' && o.key === 'i1' ? { ...o, frame: { x0: 20, y0: 20, x1: 120, y1: 70 } } : o)));
  const two = structuredClone(doc.pages[0].objectOps);
  edit((ops) => ops.filter((o) => !(o.op === 'add-image' && o.key === 'i1')));
  assert.deepEqual(doc.pages[0].objectOps, []);
  ed.undo();
  assert.deepEqual(doc.pages[0].objectOps, two);
  ed.undo();
  assert.deepEqual(doc.pages[0].objectOps, one);
  ed.undo();
  assert.equal(doc.pages[0].objectOps, undefined);
  ed.redo(); ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, two);
  ed.redo();
  assert.deepEqual(doc.pages[0].objectOps, []);
});

// ---------------------------------------------------------------------------------------------------------------
// appendContent's resources

test('appendContent: resources by category (Font, XObject, ExtGState), the font map as before, clashes refused', async () => {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const shared = ctx.register(ctx.obj({ Font: ctx.obj({}), XObject: ctx.obj({ Old: PDFRef.of(1, 0) }) }));
  const p0 = doc.addPage([200, 200]), p1 = doc.addPage([200, 200]), empty = doc.addPage([200, 200]);
  for (const p of [p0, p1]) { p.node.set(PDFName.of('Resources'), shared); p.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('0 0 1 rg 0 0 10 10 re f'))); }
  const bytes = await doc.save({ useObjectStreams: false });
  const e = await openForEdit(bytes);
  const img = e.context.register(e.context.obj({})), gs = e.context.register(e.context.obj({ Type: 'ExtGState', ca: 0.5 })), font = e.context.register(e.context.obj({}));
  assert.equal(e.appendContent(0, latin1('q /G1 gs /Im1 Do Q'), { XObject: { Im1: img }, ExtGState: { G1: gs } }), 1, 'bracketed: one operator before');
  assert.equal(e.appendContent(0, latin1('q BT /F9 9 Tf ET Q'), { F9: font }), 1);
  assert.equal(e.appendContent(2, latin1('q /Im1 Do Q'), { XObject: { Im1: img } }), 0, 'a page without content: nothing before');
  assert.throws(() => e.appendContent(0, latin1('q Q'), { XObject: { Old: img } }), /XObject resource name \/Old is already used/);
  const out = e.save();
  const back = await PDFDocument.load(out, { updateMetadata: false });
  const res = (n: number) => back.getPage(n).node.Resources()!;
  const names = (n: number, cat: string) => [...(res(n).lookup(PDFName.of(cat), PDFDict)?.keys() ?? [])].map((k) => k.decodeText()).sort();
  assert.deepEqual(names(0, 'XObject'), ['Im1', 'Old']);
  assert.deepEqual(names(0, 'ExtGState'), ['G1']);
  assert.deepEqual(names(0, 'Font'), ['F9']);
  assert.deepEqual(names(1, 'XObject'), ['Old'], 'the page that shares the resources is not changed');
  assert.deepEqual(names(2, 'XObject'), ['Im1']);
  const contents = (back.getPage(0).node.get(PDFName.of('Contents')) as PDFObject);
  assert.ok(contents instanceof PDFArray && contents.size() === 5, 'q, the original, Q, two new streams');
  if (hasQpdf) assert.ok(qpdfCheck(out).ok);
});
