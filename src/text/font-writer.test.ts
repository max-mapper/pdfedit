// Builds a one-page PDF with pdf-lib whose content is emit() output and whose fonts come from FontWriter, then
// checks it with poppler (pdftotext, pdffonts, pdftoppm). Synthetic text only; files go to the OS temp dir.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pako from 'pako';
import { PNG } from 'pngjs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib';
import type { PDFContext } from 'pdf-lib';
import { FontWriter, buildW, toUnicodeCMap } from './font-writer.ts';
import { emit, useLayout } from './emit.ts';
import { layoutParagraphs } from './layout.ts';
import type { Layout } from './layout.ts';
import { pdfWidth } from './face.ts';
import type { Face } from './face.ts';
import { fontBytes, testFaces } from './testkit.ts';
import type { Faces } from './testkit.ts';

const EN = 'The office reported steady growth: revenue rose twelve percent, and the outlook for the coming year remains positive.';
const JA = '第3四半期の売上高は前年同期比12%増となりました。𠮷野テスト用の見出しです。';
const JA_BOLD = 'テスト用の見出し';
const PAGE: [number, number] = [400, 500];

type Block = { layout: Layout; at: { x: number; yTop: number }; key: (f: Face) => string };
let F: Faces;
let dir: string;
let pdfPath: string;
let blocks: Block[];
let refs: Record<string, PDFRef>;
let ctx: PDFContext;

before(async () => {
  F = await testFaces();
  dir = mkdtempSync(join(tmpdir(), 'pdfedit-text-'));
  const doc = await PDFDocument.create();
  ctx = doc.context;
  const page = doc.addPage(PAGE);
  const writer = new FontWriter(doc.context);
  const specs: [Layout, { x: number; yTop: number }][] = [
    [layoutParagraphs([{ runs: [{ text: EN, face: F.sans, size: 11 }], align: 'justify' }], { width: 300 }), { x: 50, yTop: 470 }],
    [layoutParagraphs([{ runs: [{ text: JA, face: F.ja, size: 12, charSpacing: 0.5 }] }], { width: 200 }), { x: 50, yTop: 360 }],
    [layoutParagraphs([{ runs: [{ text: JA_BOLD, face: F.jaBold, size: 18, color: [0.8, 0.1, 0.1] }] }], { width: 300 }), { x: 50, yTop: 200 }],
  ];
  blocks = specs.map(([layout, at]) => ({ layout, at, key: useLayout(writer, layout) }));
  refs = writer.finish();
  assert.deepEqual(Object.keys(refs), ['PE1', 'PE2', 'PE3']);
  for (const [k, ref] of Object.entries(refs)) page.node.setFontDictionary(PDFName.of(k), ref);
  const parts = blocks.map((b) => emit(b.layout, b.at, b.key));
  const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    content.set(p, o);
    o += p.length;
  }
  page.node.addContentStream(doc.context.register(doc.context.flateStream(content)));
  pdfPath = join(dir, 'text.pdf');
  writeFileSync(pdfPath, await doc.save({ useObjectStreams: false }));
});

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

test('pdftotext gives the English and Japanese text back (ligature and astral character included)', () => {
  const out = execFileSync('/usr/bin/pdftotext', ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf8' });
  const [enPart] = out.split('第');
  assert.equal(squash(enPart), EN);
  const noWs = out.replace(/\s+/g, '');
  assert.ok(noWs.includes(JA), `Japanese not found in ${JSON.stringify(out)}`);
  assert.ok(noWs.includes(JA_BOLD));
});

test('pdffonts lists CID TrueType, Identity-H, embedded and subset, with ToUnicode', () => {
  const out = execFileSync('/usr/bin/pdffonts', [pdfPath], { encoding: 'utf8' });
  const rows = out.split('\n').slice(2).filter((l) => l.trim());
  assert.equal(rows.length, 3, out);
  const names = ['NotoSans-Regular', 'NotoSansJP-Regular', 'NotoSansJP-Bold'];
  for (const [i, row] of rows.entries()) {
    assert.match(row, new RegExp(`^[A-Z]{6}\\+${names[i]}\\s+CID TrueType\\s+Identity-H\\s+yes\\s+yes\\s+yes\\s`), row);
  }
});

test('the embedded FontFile2 is a small static subset with glyph IDs kept and widths matching /W', async () => {
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const faces = [F.sans, F.ja, F.jaBold];
  const sources = ['NotoSans-Regular.ttf', 'NotoSansJP-VF.ttf', 'NotoSansJP-VF.ttf'];
  const used = new Map<string, Set<number>>();
  for (const b of blocks)
    for (const l of b.layout.lines) for (const r of l.runs) for (const g of r.glyphs) {
      const k = b.key(r.face);
      if (!used.has(k)) used.set(k, new Set());
      used.get(k)!.add(g.gid);
    }
  for (const [i, key] of ['PE1', 'PE2', 'PE3'].entries()) {
    const type0 = ctx.lookup(refs[key], PDFDict);
    assert.equal(type0.get(PDFName.of('Encoding'))?.toString(), '/Identity-H');
    assert.ok(type0.get(PDFName.of('ToUnicode')) instanceof PDFRef);
    const cid = ctx.lookup((type0.get(PDFName.of('DescendantFonts')) as PDFArray).get(0), PDFDict);
    assert.equal(cid.get(PDFName.of('Subtype'))?.toString(), '/CIDFontType2');
    assert.equal(cid.get(PDFName.of('CIDToGIDMap'))?.toString(), '/Identity');
    const desc = ctx.lookup(cid.get(PDFName.of('FontDescriptor')), PDFDict);
    assert.match(desc.get(PDFName.of('FontName'))!.toString(), /^\/[A-Z]{6}\+Noto/);
    assert.equal((desc.get(PDFName.of('Flags')) as PDFNumber).asNumber() & 4, 4);
    assert.equal((desc.get(PDFName.of('StemV')) as PDFNumber).asNumber(), i === 2 ? 140 : 80);
    const ff = ctx.lookup(desc.get(PDFName.of('FontFile2'))) as PDFRawStream;
    assert.ok(ff instanceof PDFRawStream);
    const length1 = (ff.dict.get(PDFName.of('Length1')) as PDFNumber).asNumber();
    const program = pako.inflate(ff.contents);
    assert.equal(program.length, length1);
    const srcLen = fontBytes(sources[i]).length;
    assert.ok(length1 < srcLen / (i === 0 ? 5 : 50), `${key}: subset ${length1} vs source ${srcLen}`);

    const font = fontkit.create(Buffer.from(program)) as unknown as {
      numGlyphs: number;
      directory: { tables: Record<string, unknown> };
      getGlyph(g: number): { advanceWidth: number };
    };
    assert.ok(!('fvar' in font.directory.tables) && !('gvar' in font.directory.tables), 'instanced: no variation tables');
    const gids = [...used.get(key)!];
    assert.equal(font.numGlyphs, Math.max(...gids) + 1, 'glyph IDs retained');
    const W = decodeW(cid);
    const dw = (cid.get(PDFName.of('DW')) as PDFNumber).asNumber();
    for (const g of gids) {
      const w = W.get(g) ?? dw;
      assert.equal(w, pdfWidth(faces[i], g));
      assert.ok(Math.abs(font.getGlyph(g).advanceWidth * (1000 / faces[i].upem) - w) < 0.01, `${key} gid ${g} advance`);
    }
  }
});

test('emit places every glyph at its laid-out position within 0.01 pt', () => {
  const faceOf = new Map<string, Face>();
  for (const b of blocks) for (const l of b.layout.lines) for (const r of l.runs) faceOf.set(b.key(r.face), r.face);
  for (const b of blocks) {
    const shown = simulate(new TextDecoder().decode(emit(b.layout, b.at, b.key)), faceOf);
    const expected = b.layout.lines.flatMap((l) => l.runs.flatMap((r) => r.glyphs.map((g) => ({ gid: g.gid, x: b.at.x + g.x, y: b.at.yTop - l.baseline }))));
    assert.equal(shown.length, expected.length);
    for (const [i, e] of expected.entries()) {
      assert.equal(shown[i].gid, e.gid);
      assert.ok(Math.abs(shown[i].x - e.x) < 0.01, `glyph ${i}: ${shown[i].x} vs ${e.x}`);
      assert.ok(Math.abs(shown[i].y - e.y) < 0.01);
    }
  }
  const text = new TextDecoder().decode(emit(blocks[0].layout, blocks[0].at, blocks[0].key));
  assert.match(text, /^q\nBT\n/);
  assert.match(text, /ET\nQ\n$/);
  assert.match(text, /\[<[0-9A-F]{4,}>( -?[\d.]+ <[0-9A-F]{4,}>)+\] TJ/, 'justified text carries adjustments');
});

test('pdftoppm renders the page without errors, and the ink sits inside each laid-out block', () => {
  const prefix = join(dir, 'render');
  const r = spawnSync('/usr/bin/pdftoppm', ['-r', '72', '-png', '-singlefile', pdfPath, prefix], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), '', r.stderr);
  const png = PNG.sync.read(readFileSync(prefix + '.png'));
  assert.equal(png.width, PAGE[0]);
  for (const b of blocks) {
    // 1 px = 1 pt at 72 dpi; image y grows down from the page top
    const top = PAGE[1] - b.at.yTop;
    const ink = inkBox(png, 0, Math.floor(top), png.width, Math.ceil(top + b.layout.height));
    assert.ok(ink, 'block has ink');
    assert.ok(Math.abs(ink.x0 - b.at.x) <= 3, `left edge ${ink.x0} vs ${b.at.x}`);
    assert.ok(ink.x1 <= b.at.x + b.layout.width + 3, `right edge ${ink.x1} vs ${b.at.x + b.layout.width}`);
    const firstCapTop = top + b.layout.lines[0].baseline - (b.layout.lines[0].runs[0].face.capHeight * b.layout.lines[0].runs[0].size) / 1000;
    assert.ok(Math.abs(ink.y0 - firstCapTop) <= 4, `top edge ${ink.y0} vs ${firstCapTop}`);
  }
});

test('ToUnicode CMap: bfchar in UTF-16BE, ligatures map to several characters, surrogate pairs kept', () => {
  const cmap = toUnicodeCMap(new Map([[0x105, 'fi'], [0x7, '𠮷'], [0x9, ''], [0x24, 'A']]));
  assert.match(cmap, /3 beginbfchar\n<0007> <D842DFB7>\n<0024> <0041>\n<0105> <00660069>\nendbfchar/);
  assert.match(cmap, /<0000> <FFFF>/);
  const many = toUnicodeCMap(new Map(Array.from({ length: 250 }, (_, i) => [i + 1, 'x'] as [number, string])));
  assert.deepEqual(many.match(/\d+ beginbfchar/g), ['100 beginbfchar', '100 beginbfchar', '50 beginbfchar']);
});

test('/W compresses equal-width runs into ranges and omits /DW widths', async () => {
  const doc = await PDFDocument.create();
  const w = buildW(doc.context, new Map([[1, 500], [2, 500], [3, 500], [4, 600], [6, 700], [7, 1000], [8, 250], [9, 260]]), 1000);
  assert.equal(w.toString(), '[ 1 3 500 4 [ 600 ] 6 [ 700 ] 8 [ 250 260 ] ]');
});

function decodeW(cid: PDFDict): Map<number, number> {
  const out = new Map<number, number>();
  const arr = cid.get(PDFName.of('W')) as PDFArray;
  const n = (i: number) => (arr.get(i) as PDFNumber).asNumber();
  for (let i = 0; i < arr.size(); ) {
    const first = n(i);
    const next = arr.get(i + 1);
    if (next instanceof PDFArray) {
      for (let j = 0; j < next.size(); j++) out.set(first + j, (next.get(j) as PDFNumber).asNumber());
      i += 2;
    } else {
      for (let c = first; c <= n(i + 1); c++) out.set(c, n(i + 2));
      i += 3;
    }
  }
  return out;
}

/** A minimal interpreter for emit()'s output: Tm, Tf, Ts and TJ, Tc = Tw = 0, Tz = 100. */
function simulate(content: string, faceOf: Map<string, Face>) {
  const toks = content.match(/\[|\]|<[0-9A-F]*>|\/[^\s[\]<>/]+|-?\d*\.?\d+|[A-Za-z*']+/g)!;
  const glyphs: { gid: number; x: number; y: number }[] = [];
  let stack: string[] = [];
  let x = 0;
  let y = 0;
  let size = 0;
  let face: Face | undefined;
  let arr: string[] | null = null;
  for (const t of toks) {
    if (t === '[') arr = [];
    else if (t === ']') {
      stack.push('ARRAY');
    } else if (arr && !/^[A-Za-z]/.test(t)) arr.push(t);
    else if (/^[A-Za-z*']+$/.test(t)) {
      if (t === 'Tm') {
        x = +stack[4];
        y = +stack[5];
      } else if (t === 'Tf') {
        face = faceOf.get(stack[0].slice(1));
        size = +stack[1];
      } else if (t === 'TJ') {
        for (const e of arr!) {
          if (e.startsWith('<')) {
            for (let i = 1; i + 4 <= e.length - 1; i += 4) {
              const gid = parseInt(e.slice(i, i + 4), 16);
              glyphs.push({ gid, x, y });
              x += (pdfWidth(face!, gid) * size) / 1000;
            }
          } else x -= (+e * size) / 1000;
        }
        arr = null;
      }
      stack = [];
    } else stack.push(t);
  }
  return glyphs;
}

function inkBox(png: PNG, x0: number, y0: number, x1: number, y1: number) {
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (let y = Math.max(0, y0); y < Math.min(png.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(png.width, x1); x++) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] + png.data[i + 1] + png.data[i + 2] < 3 * 160) {
        box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      }
    }
  return box;
}
