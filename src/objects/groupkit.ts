// Synthetic pages for groups and paint order (src/objects/groups.ts, src/objects/order.ts): a logo of twelve paths in
// one marked-content sequence, a sun of nine touching paths, a page-wide background, a lone path; two bar charts
// (gridlines, axes, bars and text labels; one paints its bars before its axes) and a set of three icons inside one form
// XObject; and a page of overlapping objects to reorder: three filled rectangles, an image with its own q … Q under a
// path, a path under two lines of text that share the first line's font, two paths under one clip, a path in marked content, and
// a form of two overlapping paths. Content streams are written by hand so every place is exact. Synthetic only.
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { pngOf, type Fixture } from './testkit.ts';

/** A logo in marked content, a sun of touching paths, a background and a lone path (595 × 842). */
export async function logoPage(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref } }));
  const letters = Array.from({ length: 12 }, (_, k) => `${(0.1 + k * 0.05).toFixed(2)} 0.2 0.6 rg ${100 + k * 14} 700 8 20 re f`);
  const rays = [
    '400 725 4 15 re f', '400 665 4 15 re f', '360 700 20 4 re f', '424 700 20 4 re f',
    '381 721 m 371 731 l 374 734 l 384 724 l h f', '421 721 m 431 731 l 428 734 l 418 724 l h f',
    '381 683 m 371 673 l 374 670 l 384 680 l h f', '421 683 m 431 673 l 428 670 l 418 680 l h f',
  ];
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    '0.97 0.97 0.95 rg 0 0 595 842 re f',
    '/Figure <</MCID 1>> BDC', ...letters, 'EMC',
    '1 0.7 0 rg 380 680 44 44 re f', ...rays,
    'BT /F1 16 Tf 0 0 0 rg 360 640 Td (Sunny) Tj ET',
    '0.5 0.5 0.5 rg 500 500 30 30 re f',
  ].join('\n'))));
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    at: { logo: { x0: 100, y0: 700, x1: 262, y1: 720 }, sun: { x0: 360, y0: 665, x1: 444, y1: 740 }, lone: { x0: 500, y0: 500, x1: 530, y1: 530 } },
  };
}

/** Two bar charts with labels, and three icons in one form XObject (595 × 842). */
export async function chartPage(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const icon = (x: number, r: number, g: number, b: number) =>
    `${r} ${g} ${b} rg ${x} 10 30 30 re f 1 1 1 rg ${x + 10} 20 10 10 re f 1.5 w 0 0 0 RG ${x - 3} 7 36 36 re S`;
  const icons = ctx.register(ctx.flateStream([icon(3, 0.9, 0.3, 0.1), icon(73, 0.1, 0.6, 0.3), icon(143, 0.2, 0.3, 0.9)].join('\n'), {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 50], Resources: ctx.obj({}),
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Icons: icons } }));
  const heights = [60, 120, 90, 150, 40];
  const bars = heights.map((h, k) => `${(0.2 + k * 0.15).toFixed(2)} 0.4 0.7 rg ${100 + k * 55} 450 30 ${h} re f`);
  const labels = heights.map((_, k) => `BT /F1 9 Tf 0 0 0 rg ${102 + k * 55} 437 Td (Q${k + 1}) Tj ET`);
  const bars2 = [50, 80, 30, 65].map((h, k) => `0.8 0.3 0.3 rg ${100 + k * 40} 100 20 ${h} re f`);
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    'BT /F1 14 Tf 0 0 0 rg 80 670 Td (Synthetic chart) Tj ET',
    '0.5 w 0.8 0.8 0.8 RG 80 500 m 380 500 l S 80 550 m 380 550 l S 80 600 m 380 600 l S',
    '1 w 0 0 0 RG 80 450 m 80 650 l S 80 450 m 380 450 l S',
    ...bars, ...labels,
    // the second chart paints its bars before its axes
    ...bars2,
    '1 w 0 0 0 RG 90 100 m 90 200 l S 90 100 m 270 100 l S',
    'q 1 0 0 1 350 100 cm /Icons Do Q',
  ].join('\n'))));
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    at: { chart: { x0: 79.5, y0: 449.5, x1: 380.5, y1: 650.5 }, chart2: { x0: 89.5, y0: 99.5, x1: 270.5, y1: 200.5 }, icons: { x0: 350, y0: 100, x1: 550, y1: 150 } },
  };
}

/** Objects to reorder (595 × 842). */
export async function orderPage(): Promise<Fixture> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const red = await doc.embedPng(pngOf([220, 30, 30, 255]));
  const pair = ctx.register(ctx.flateStream('0.9 0.6 0 rg 0 0 60 40 re f 0 0.5 0.9 rg 30 20 60 40 re f', {
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 70], Resources: ctx.obj({}),
  }));
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref }, XObject: { Red: red.ref, Pair: pair } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    // three rectangles, each over the one before
    '0.9 0.2 0.2 rg 100 600 120 80 re f',
    '0.2 0.7 0.3 rg 160 640 120 80 re f',
    '0.2 0.3 0.9 rg 240 690 120 80 re f',
    // an image with its own q … Q, then a path over it
    'q 100 0 0 100 100 400 cm /Red Do Q',
    '0 0 0.8 rg 150 450 100 100 re f',
    // a path, then text over it; the second line uses the first line's font and colour
    '0.95 0.8 0.2 rg 95 195 150 30 re f',
    'BT /F1 18 Tf 0 0 0 rg 100 200 Td (Synthetic text) Tj ET',
    'BT 100 170 Td (Second line) Tj ET',
    // two paths inside a clip, then one outside it
    'q 300 300 100 100 re W n 0.5 0 0.5 rg 310 310 60 60 re f 0.6 0.2 0.6 rg 320 380 10 10 re f Q',
    '0 0.5 0.5 rg 340 340 100 100 re f',
    // a path in marked content, then one outside it
    '/Artifact BMC 0.3 0.3 0.3 rg 450 450 60 60 re f EMC',
    '0.7 0.7 0 rg 480 480 60 60 re f',
    // a form of two overlapping paths, painted once
    'q 1 0 0 1 400 150 cm /Pair Do Q',
  ].join('\n'))));
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    at: {
      a: { x0: 100, y0: 600, x1: 220, y1: 680 }, b: { x0: 160, y0: 640, x1: 280, y1: 720 }, c: { x0: 240, y0: 690, x1: 360, y1: 770 },
      image: { x0: 100, y0: 400, x1: 200, y1: 500 }, over: { x0: 150, y0: 450, x1: 250, y1: 550 }, under: { x0: 95, y0: 195, x1: 245, y1: 225 },
      clipped: { x0: 310, y0: 310, x1: 370, y1: 370 }, clipped2: { x0: 320, y0: 380, x1: 330, y1: 390 }, outside: { x0: 340, y0: 340, x1: 440, y1: 440 },
      marked: { x0: 450, y0: 450, x1: 510, y1: 510 }, after: { x0: 480, y0: 480, x1: 540, y1: 540 },
      pairLow: { x0: 400, y0: 150, x1: 460, y1: 190 }, pairHigh: { x0: 430, y0: 170, x1: 490, y1: 210 },
    },
  };
}
