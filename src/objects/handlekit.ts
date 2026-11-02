// Synthetic pages for the select tool's handles (src/objects/handles.ts, app/tools/select.ts): an image cropped by a
// rectangle clip it shares with a square; an image cropped by a triangle clip it shares with a square; a plain image
// and a filled rectangle to move, resize and turn; a line of text; and a second page turned by /Rotate 90 with a crop
// box away from the origin, with a line of text and an image. Content streams are written by hand so every place is
// exact. Synthetic only.
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import { pngOf, type Fixture } from './testkit.ts';

/** Where things are (user space). */
export const HANDLE_AT = {
  /** the image cropped by a shared rectangle clip, the clip, and the square that shares it */
  green: { x0: 40, y0: 470, x1: 200, y1: 590 },
  rectClip: { x0: 72, y0: 500, x1: 172, y1: 560 },
  rectMate: { x0: 90, y0: 510, x1: 110, y1: 530 },
  /** the image cropped by a shared triangle clip (300,500) (400,500) (350,600), and the square that shares it */
  red: { x0: 300, y0: 500, x1: 400, y1: 600 },
  triClip: { x0: 300, y0: 500, x1: 400, y1: 600 },
  triMate: { x0: 345, y0: 510, x1: 355, y1: 520 },
  /** a plain image and a filled rectangle */
  blue: { x0: 100, y0: 200, x1: 200, y1: 250 },
  orange: { x0: 300, y0: 200, x1: 380, y1: 240 },
  /** page 2 (turned 90°, crop box 50 100 400 600): its image */
  r_image: { x0: 250, y0: 200, x1: 330, y1: 240 },
} as const;

/** Two pages: objects to move, resize and turn, two shared crops, text; and a turned page with text. */
export async function handlePages(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const green = await doc.embedPng(pngOf([20, 160, 60, 255]));
  const red = await doc.embedPng(pngOf([220, 30, 30, 255]));
  const blue = await doc.embedPng(pngOf([30, 60, 200, 255]));

  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Green: green.ref, Red: red.ref, Blue: blue.ref } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'BT /F1 16 Tf 72 760 Td (Synthetic handles page) Tj ET',
    'q 72 500 100 60 re W n',
    'q 160 0 0 120 40 470 cm /Green Do Q',
    '0.2 0.2 0.8 rg 90 510 20 20 re f',
    'Q',
    'q 300 500 m 400 500 l 350 600 l h W n',
    'q 100 0 0 100 300 500 cm /Red Do Q',
    '0 0 0 rg 345 510 10 10 re f',
    'Q',
    'q 100 0 0 50 100 200 cm /Blue Do Q',
    '0.9 0.5 0.1 rg 300 200 80 40 re f',
  ].join('\n'))));

  const turned = doc.addPage([500, 800]);
  turned.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Red: red.ref } }));
  turned.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'BT /F1 18 Tf 100 300 Td (Turned page text) Tj ET',
    'q 80 0 0 40 250 200 cm /Red Do Q',
  ].join('\n'))));
  turned.setRotation(degrees(90));
  turned.setCropBox(50, 100, 350, 500);

  return { bytes: await doc.save({ useObjectStreams: false }), at: { ...HANDLE_AT } };
}
