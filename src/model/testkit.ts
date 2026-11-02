// Synthetic material for the model tests, the perf gate and the editor smoke run. Synthetic text only.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { Box, Page, Paragraph, Run } from './types.ts';

export const WORDS = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa ' +
  'quebec romeo sierra tango uniform victor whiskey xray yankee zulu').split(' ');

/** Deterministic filler text of about `n` characters. */
export function filler(n: number, seed = 1): string {
  let s = '', k = seed;
  while (s.length < n) { k = (k * 1103515245 + 12345) & 0x7fffffff; s += (s ? ' ' : '') + WORDS[k % WORDS.length]; }
  return s;
}

export function run(text: string, o: Partial<Run> = {}): Run {
  return {
    text, font: { source: 'document', name: 'ABCDEF+Synthetic-Gothic', bold: false, italic: false, serif: false },
    size: 10, color: [0, 0, 0], charSpacing: 0, bold: false, italic: false, underline: false, ...o,
  };
}

export function para(text: string, o: Partial<Paragraph> & { run?: Partial<Run> } = {}): Paragraph {
  const { run: r, ...rest } = o;
  return { runs: [run(text, r)], align: 'left', leading: 1.2, spaceBefore: 0, spaceAfter: 0, indent: 0, bullet: null, ...rest };
}

/** A model box without a PDF behind it. */
export function box(id: string, frame: Box['frame'], paragraphs: Paragraph[]): Box {
  return {
    id, kind: 'text', frame: { ...frame }, rot: 0, vertical: false, paragraphs, edited: false, locked: null, heightPinned: false,
    source: {
      frame: { ...frame }, objs: [], chars: [],
      paragraphs: paragraphs.map((p) => ({ text: p.runs.map((r) => r.text).join(''), size: p.runs[0].size, align: p.align, leading: p.leading })),
    },
  };
}

/** A page of `n` boxes in a grid (4 columns), each one paragraph of about 160 characters at 8 pt. */
export function gridPage(n = 100): Page {
  const cols = 4, w = 595, h = 842, colW = 125, rowH = 842 / Math.ceil(n / cols) - 2;
  const boxes: Box[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x0 = 20 + c * (colW + 18), y1 = h - 20 - r * (rowH + 2);
    boxes.push(box(`b${i}`, { x0, x1: x0 + colW, y1, y0: y1 - rowH + 4 }, [para(filler(160, i + 1), { run: { size: 8, charSpacing: 0.4 } })]));
  }
  return { n: 0, w, h, boxes };
}

/** A synthetic PDF for the browser smoke run: `n` short paragraphs in a 4-column grid, Helvetica, every fifth
 *  paragraph in colour, every seventh with a bold first line, and a filled panel behind the first. */
export async function gridPdf(n = 100): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const cols = 4, colW = 125, size = 7, lead = 8.4;
  const rows = Math.ceil(n / cols), pitch = (842 - 60) / rows;
  page.drawRectangle({ x: 14, y: 842 - 30 - pitch + 8, width: colW + 12, height: pitch, color: rgb(0.93, 0.95, 1) });
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    const x = 20 + c * (colW + 18), y = 842 - 30 - r * pitch;
    const words = filler(48, i + 7).split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const wd of words) {
      const next = cur ? `${cur} ${wd}` : wd;
      if (cur && helv.widthOfTextAtSize(next, size) > colW) { lines.push(cur); cur = wd; } else cur = next;
    }
    if (cur) lines.push(cur);
    const color = i % 5 === 0 ? rgb(0.7, 0.1, 0.1) : rgb(0, 0, 0);
    lines.slice(0, 2).forEach((t, k) => page.drawText(t, { x, y: y - k * lead, size, font: k === 0 && i % 7 === 0 ? bold : helv, color }));
  }
  return doc.save({ useObjectStreams: false });
}
