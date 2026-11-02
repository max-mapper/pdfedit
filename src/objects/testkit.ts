// Synthetic pages for the page object model: content streams written by hand (pdf-lib only builds the objects), so
// every object kind and arrangement is exact: overlapping paths, a clip shared by two images, an image with its own
// q … Q and clip, an image with a soft mask, an inline image, an axial shading under a clip, a form XObject painted
// twice, a form painted once with a vector group inside, marked content, and a rotated page with an offset crop box.
// Synthetic only.
import { PDFDocument, PDFName, StandardFonts, degrees, type PDFRef } from 'pdf-lib';
import { PNG } from 'pngjs';

export type RGBA = [number, number, number, number];

/** A w × h PNG of one colour (alpha 255) or with a transparent left half (alpha < 255: pdf-lib writes an /SMask). */
export function pngOf(rgba: RGBA, w = 8, h = 8, halfClear = false): Uint8Array {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) png.data.set([rgba[0], rgba[1], rgba[2], halfClear && x < w / 2 ? 0 : rgba[3]], (y * w + x) * 4);
  return new Uint8Array(PNG.sync.write(png));
}

export type Fixture = { bytes: Uint8Array; /** where things are, in user space */ at: Record<string, { x0: number; y0: number; x1: number; y1: number }> };

/** One page with every object kind (595 × 842). */
export async function objectsPage(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const red = await doc.embedPng(pngOf([220, 30, 30, 255]));
  const blue = await doc.embedPng(pngOf([30, 60, 200, 255]));
  const masked = await doc.embedPng(pngOf([20, 160, 60, 255], 8, 8, true));
  const shading = ctx.register(ctx.obj({ ShadingType: 2, ColorSpace: 'DeviceRGB', Coords: [400, 100, 520, 100], Extend: [true, true],
    Function: ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: [1, 1, 0], C1: [0, 0.6, 1], N: 1 }) }));
  // a form painted twice: a small badge (a filled square and a ring), /BBox 0 0 40 40
  const badge = ctx.register(ctx.flateStream('0.9 0.5 0.1 rg 0 0 40 40 re f 2 w 0 0 0 RG 10 10 20 20 re S', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 40, 40], Resources: ctx.obj({}),
  }));
  // a form painted once: a logo of three paths (a vector group), /BBox 0 0 100 60
  const logo = ctx.register(ctx.flateStream([
    '0.1 0.2 0.7 rg 0 0 m 50 60 l 100 0 l h f',
    '1 1 1 rg 35 10 m 50 40 l 65 10 l h f',
    '0.8 0.1 0.1 rg 40 0 20 6 re f',
  ].join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 60], Resources: ctx.obj({}) }));
  page.node.set(PDFName.of('Resources'), ctx.obj({
    Font: { F1: helv.ref }, XObject: { Red: red.ref, Blue: blue.ref, Masked: masked.ref, Badge: badge, Logo: logo }, Shading: { Sh1: shading },
  }));
  const content = [
    'BT /F1 14 Tf 72 780 Td (Synthetic heading) Tj ET',
    // two overlapping filled rectangles: grey first, then green on top
    '0.6 0.6 0.6 rg 72 600 120 80 re f',
    '0.2 0.7 0.3 rg 132 640 120 80 re f',
    // a stroked ring: its middle is not painted
    '4 w 0 0 0 RG 300 600 100 80 re S',
    // a clip shared by two images
    'q 72 400 200 100 re W n',
    'q 120 0 0 80 60 410 cm /Red Do Q',
    'q 120 0 0 80 170 410 cm /Blue Do Q',
    'Q',
    // an image in a q … Q of its own with its own frame clip, inside marked content
    '/Figure <</MCID 3>> BDC q 300 400 100 100 re W n 100 0 0 100 300 400 cm /Masked Do Q EMC',
    // an inline image (2 × 2 grey)
    'q 40 0 0 40 450 450 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x80\xc0\xc0\x80 EI Q',
    // an axial shading under a rectangle clip
    'q 400 60 120 80 re W n /Sh1 sh Q',
    // the badge twice, the logo once
    'q 1 0 0 1 72 200 cm /Badge Do Q',
    'q 1 0 0 1 132 200 cm /Badge Do Q',
    'q 1 0 0 1 250 200 cm /Logo Do Q',
  ].join('\n');
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content)));
  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    at: {
      grey: { x0: 72, y0: 600, x1: 192, y1: 680 }, green: { x0: 132, y0: 640, x1: 252, y1: 720 }, ring: { x0: 300, y0: 600, x1: 400, y1: 680 },
      shared: { x0: 72, y0: 400, x1: 272, y1: 500 }, red: { x0: 60, y0: 410, x1: 180, y1: 490 }, blue: { x0: 170, y0: 410, x1: 290, y1: 490 },
      masked: { x0: 300, y0: 400, x1: 400, y1: 500 }, inline: { x0: 450, y0: 450, x1: 490, y1: 490 }, shading: { x0: 400, y0: 60, x1: 520, y1: 140 },
      badge1: { x0: 72, y0: 200, x1: 112, y1: 240 }, badge2: { x0: 132, y0: 200, x1: 172, y1: 240 }, logo: { x0: 250, y0: 200, x1: 350, y1: 260 },
    },
  };
}

/** A page turned by /Rotate with a crop box away from the origin, with an image and a path on it. */
export async function rotatedPage(rotate: 90 | 180 | 270 = 90): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([500, 800]);
  const ctx = doc.context;
  const red = await doc.embedPng(pngOf([220, 30, 30, 255]));
  page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Red: red.ref as PDFRef } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 80 0 0 40 100 200 cm /Red Do Q\n0 0 1 rg 300 500 60 60 re f')));
  page.setRotation(degrees(rotate));
  page.setCropBox(50, 100, 400, 600);
  return { bytes: await doc.save({ useObjectStreams: false }), at: { image: { x0: 100, y0: 200, x1: 180, y1: 240 }, square: { x0: 300, y0: 500, x1: 360, y1: 560 } } };
}
