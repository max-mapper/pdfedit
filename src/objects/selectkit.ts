// Synthetic pages for selecting overlapping objects (src/objects/hit.ts, app/tools/select.ts): an image, a filled
// vector and a line of text painted over one another; a white rectangle on the white page (the render cannot see it);
// a circle stroked with curves; a filled path with an even-odd hole; an icon of two paths in a form XObject; an image
// cut by its clip; and a second page turned by /Rotate 90 with a crop box away from the origin, where a path lies over
// an image. Content streams are written by hand so every place is exact. Synthetic only.
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { pngOf, type Fixture } from './testkit.ts';

/** Where things are on the two pages (user space), and points to click. */
export const OVERLAP_AT = {
  image: { x0: 100, y0: 500, x1: 300, y1: 700 },
  vector: { x0: 200, y0: 550, x1: 400, y1: 650 },
  white: { x0: 450, y0: 700, x1: 520, y1: 760 },
  circle: { x0: 440, y0: 360, x1: 520, y1: 440 },
  donut: { x0: 300, y0: 200, x1: 400, y1: 300 },
  icon: { x0: 100, y0: 200, x1: 160, y1: 260 },
  cut: { x0: 300, y0: 50, x1: 400, y1: 150 },
  cutClip: { x0: 300, y0: 50, x1: 350, y1: 150 },
  /** page 2 */
  r_image: { x0: 100, y0: 200, x1: 180, y1: 240 },
  r_path: { x0: 150, y0: 210, x1: 220, y1: 260 },
} as const;

/** Points: [x, y] in user space. */
export const OVERLAP_POINTS = {
  /** text over the vector over the image */
  all3: [250, 606] as [number, number],
  /** the vector over the image, no text */
  two: [250, 570] as [number, number],
  /** the image alone */
  imageOnly: [130, 520] as [number, number],
  white: [485, 730] as [number, number],
  circleLine: [520, 400] as [number, number],
  circleMiddle: [480, 400] as [number, number],
  donutRing: [310, 250] as [number, number],
  donutHole: [350, 250] as [number, number],
  iconInner: [130, 230] as [number, number],
  iconOuter: [105, 205] as [number, number],
  cutAway: [380, 100] as [number, number],
  cutKept: [320, 100] as [number, number],
  /** page 2: the path over the image, then the image alone */
  r_two: [165, 225] as [number, number],
  r_image: [120, 220] as [number, number],
};

const k = 22.09;   // a quarter circle of radius 40 as one Bézier curve: 40 × 0.5523

/** Two pages: overlapping objects of every kind, and a turned page. */
export async function overlapPages(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const blue = await doc.embedPng(pngOf([40, 80, 200, 255]));
  const red = await doc.embedPng(pngOf([210, 40, 40, 255]));
  const icon = ctx.register(ctx.flateStream('0.2 0.5 0.9 rg 0 0 60 60 re f\n1 0.8 0 rg 15 15 30 30 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 60, 60], Resources: ctx.obj({}),
  }));

  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Blue: blue.ref, Red: red.ref, Icon: icon } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'q 200 0 0 200 100 500 cm /Blue Do Q',
    '0.95 0.55 0.1 rg 200 550 200 100 re f',
    'BT /F1 20 Tf 0 0 0 rg 160 600 Td (Overlapping label) Tj ET',
    '1 1 1 rg 450 700 70 60 re f',
    `2 w 0 0 0 RG 520 400 m 520 ${400 + k} ${480 + k} 440 480 440 c ${480 - k} 440 440 ${400 + k} 440 400 c 440 ${400 - k} ${480 - k} 360 480 360 c ${480 + k} 360 520 ${400 - k} 520 400 c S`,
    '0.3 0.6 0.3 rg 300 200 100 100 re 330 230 40 40 re f*',
    'q 1 0 0 1 100 200 cm /Icon Do Q',
    'q 300 50 50 100 re W n 100 0 0 100 300 50 cm /Red Do Q',
  ].join('\n'))));

  const turned = doc.addPage([500, 800]);
  turned.node.set(PDFName.of('Resources'), ctx.obj({ XObject: { Red: red.ref } }));
  turned.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream('q 80 0 0 40 100 200 cm /Red Do Q\n0 0.4 1 rg 150 210 70 50 re f')));
  turned.setRotation(degrees(90));
  turned.setCropBox(50, 100, 400, 600);

  return { bytes: await doc.save({ useObjectStreams: false }), at: { ...OVERLAP_AT } };
}
