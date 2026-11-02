// The sample document the editor offers when no PDF is open ("Try the sample", app/main.ts): two invented pages with
// something for every tool. Page 1 has a heading next to a vector logo (paths in one tagged figure, so they are
// proposed as one group), paragraphs to edit, split and merge, a picture (a PNG drawn here), a bar chart (gridlines,
// axes and bars painted close together, then their labels) and a badge in a form XObject. Page 2 is turned by
// /Rotate 90, with a heading, a paragraph and a second picture on it. Content streams are written by hand so every
// place is exact; the text is set in the standard Helvetica faces. Everything in it is made up.
//   samplePdf() → the PDF's bytes; SAMPLE_AT: where things are (user space, points).
import { PDFDocument, PDFName, StandardFonts, degrees, type PDFFont } from 'pdf-lib';
import { writePng } from './placekit.ts';

/** Where things are, in user space (page 1 unless the name says otherwise). */
export const SAMPLE_AT = {
  logo: { x0: 72, y0: 752, x1: 120, y1: 800 },
  picture: { x0: 72, y0: 452, x1: 312, y1: 602 },
  chart: { x0: 91.5, y0: 199.5, x1: 372.5, y1: 360.5 },
  badge: { x0: 420, y0: 210, x1: 520, y1: 250 },
  /** page 2 (turned 90°): its picture */
  turnedPicture: { x0: 320, y0: 420, x1: 480, y1: 520 },
} as const;

export const SAMPLE_NAME = 'sample.pdf';

const INTRO = 'This page is made up for trying the editor. Double-click a paragraph to edit its text: it reflows inside its own ' +
  'box, and the rest of the page stays where it is. Click a box once to select it, then change its font, size, colour or ' +
  'alignment in the Text panel.';
const OBJECTS = 'Pictures and shapes are objects too. Click one to select it, drag it to move it, pull a handle to resize it, ' +
  'or turn it with the round handle. Alt-click picks the object below.';
const SPLIT = 'This box holds two paragraphs. Put the caret in it and press Split to make two boxes; Shift-click another box ' +
  'and press Merge to join them again.';
const SPLIT2 = 'The second paragraph of the box. Undo and Redo take back any step, on any page.';
const EXPORT = 'Export writes the edits into the PDF as real, searchable text and checks the result before you download it.';
const TURNED = 'This page is turned a quarter turn, as scanned pages often are. Its text, its picture and the handles turn with it.';

/** A small landscape picture: sky, sun, two hills (w × h RGB pixels). */
function picturePng(w: number, h: number, hue: 0 | 1): Uint8Array {
  return writePng({
    width: w, height: h, ctype: 2, depth: 8,
    pixel: (x, y) => {
      const u = x / w, v = y / h;   // v grows downward
      const hill1 = 0.62 + 0.12 * Math.sin(u * 5.2 + 0.4), hill2 = 0.75 + 0.08 * Math.sin(u * 8.1 + 2);
      if (v > hill2) return hue ? [70, 120, 60] : [60, 140, 90];
      if (v > hill1) return hue ? [120, 160, 70] : [110, 180, 110];
      const dx = u - 0.72, dy = v - 0.28;
      if (dx * dx * (w / h) ** 2 + dy * dy < 0.012) return [255, 200, 60];
      const t = v / hill1;
      return hue ? [Math.round(250 - 40 * t), Math.round(180 + 30 * t), Math.round(140 + 60 * t)] : [Math.round(90 + 90 * t), Math.round(150 + 70 * t), 235];
    },
  });
}

/** Words of `text` in lines no wider than `width` at `size`. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && font.widthOfTextAtSize(next, size) > width) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** A paragraph as one text object: lines `lead` apart from the baseline (x, y) down. */
function para(font: PDFFont, key: string, text: string, o: { x: number; y: number; size: number; lead: number; width: number; rgb?: string }): string[] {
  const lines = wrap(font, text, o.size, o.width);
  return [`BT /${key} ${o.size} Tf ${o.lead} TL ${o.rgb ?? '0.12 0.14 0.16'} rg ${o.x} ${o.y} Td`, ...lines.map((l, k) => `${k ? 'T* ' : ''}${font.encodeText(l).toString()} Tj`), 'ET'];
}
const line1 = (font: PDFFont, key: string, text: string, x: number, y: number, size: number, rgb = '0.12 0.14 0.16') =>
  `BT /${key} ${size} Tf ${rgb} rg ${x} ${y} Td ${font.encodeText(text).toString()} Tj ET`;

/** The sample document's bytes. */
export async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setTitle('pdfedit sample');
  const ctx = doc.context;
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pic = await doc.embedPng(picturePng(240, 150, 0));
  const pic2 = await doc.embedPng(picturePng(160, 100, 1));

  // a badge in a form XObject: a rounded-looking tag with a check mark (/BBox 0 0 100 40)
  const badge = ctx.register(ctx.flateStream([
    '0.16 0.39 0.92 rg 6 0 m 94 0 l 100 6 l 100 34 l 94 40 l 6 40 l 0 34 l 0 6 l h f',
    '3 w 1 J 1 j 1 1 1 RG 14 20 m 22 12 l 36 28 l S',
    'BT /F2 13 Tf 1 1 1 rg 46 15 Td (DONE) Tj ET',
  ].join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: ctx.obj({ Font: { F2: bold.ref } }) }));

  // ── page 1 ──────────────────────────────────────────────────────────────────────────────────────────────────
  const page = doc.addPage([595, 842]);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref, F2: bold.ref }, XObject: { Pic: pic.ref, Badge: badge } }));
  // the logo: a ring of six petals around a dot, in one tagged figure (48 × 48 at 72, 752)
  const petals = Array.from({ length: 6 }, (_, k) => {
    const a = (k * Math.PI) / 3, cx = 96 + 14 * Math.cos(a), cy = 776 + 14 * Math.sin(a);
    const p = (r: number, t: number) => `${(cx + r * Math.cos(a + t)).toFixed(2)} ${(cy + r * Math.sin(a + t)).toFixed(2)}`;
    return `${(0.15 + k * 0.12).toFixed(2)} 0.45 ${(0.85 - k * 0.1).toFixed(2)} rg ${p(10, 0)} m ${p(8, 1.6)} l ${p(10, Math.PI)} l ${p(8, -1.6)} l h f`;
  });
  const heights = [52, 88, 70, 116, 96, 132];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
  const content = [
    '/Figure <</MCID 1>> BDC', ...petals, '0.98 0.75 0.18 rg 90 770 12 12 re f', 'EMC',
    line1(bold, 'F2', 'Sample document', 136, 778, 24),
    line1(helv, 'F1', 'Invented text, a picture, a logo and a chart to try every tool on', 136, 760, 11, '0.42 0.45 0.5'),
    '0.85 0.87 0.9 RG 0.75 w 72 738 m 523 738 l S',
    ...para(helv, 'F1', INTRO, { x: 72, y: 712, size: 11, lead: 15, width: 451 }),
    // the picture, and a paragraph beside it
    'q 240 0 0 150 72 452 cm /Pic Do Q',
    line1(bold, 'F2', 'Objects', 330, 588, 13),
    ...para(helv, 'F1', OBJECTS, { x: 330, y: 568, size: 11, lead: 15, width: 193 }),
    // the bar chart: gridlines, axes and bars painted one after another (proposed as one group), then the labels
    '0.5 w 0.82 0.84 0.88 RG', ...[240, 280, 320, 360].map((y) => `92 ${y} m 372 ${y} l S`),
    '1 w 0.2 0.2 0.2 RG 92 200 m 92 360 l S 92 200 m 372 200 l S',
    ...heights.map((hh, k) => `${(0.2 + k * 0.1).toFixed(2)} ${(0.45 + k * 0.05).toFixed(2)} 0.75 rg ${108 + k * 44} 200 28 ${hh} re f`),
    ...months.map((m, k) => line1(helv, 'F1', m, 112 + k * 44, 186, 9, '0.3 0.32 0.36')),
    line1(bold, 'F2', 'Visitors per month (made up)', 92, 372, 11),
    // the badge
    'q 1 0 0 1 420 210 cm /Badge Do Q',
    line1(helv, 'F1', 'A badge in a form', 420, 196, 9, '0.42 0.45 0.5'),
    // two paragraphs in one box, then one more
    ...para(helv, 'F1', SPLIT, { x: 72, y: 150, size: 11, lead: 15, width: 451 }),
    ...para(helv, 'F1', SPLIT2, { x: 72, y: 112, size: 11, lead: 15, width: 451 }),
    ...para(helv, 'F1', EXPORT, { x: 72, y: 80, size: 11, lead: 15, width: 451 }),
    line1(helv, 'F1', 'Sample page 1 of 2', 72, 40, 8, '0.55 0.57 0.6'),
  ];
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(content.join('\n'))));

  // ── page 2: turned by /Rotate 90 ──────────────────────────────────────────────────────────────────────────
  const turned = doc.addPage([595, 842]);
  turned.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: helv.ref, F2: bold.ref }, XObject: { Pic: pic2.ref } }));
  turned.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream([
    line1(bold, 'F2', 'A turned page', 72, 760, 20),
    ...para(helv, 'F1', TURNED, { x: 72, y: 730, size: 11, lead: 15, width: 420 }),
    `q 160 0 0 100 ${SAMPLE_AT.turnedPicture.x0} ${SAMPLE_AT.turnedPicture.y0} cm /Pic Do Q`,
    '0.9 0.45 0.15 rg 100 420 120 100 re f',
    line1(helv, 'F1', 'Sample page 2 of 2', 72, 40, 8, '0.55 0.57 0.6'),
  ].join('\n'))));
  turned.setRotation(degrees(90));

  return doc.save({ useObjectStreams: false });
}
