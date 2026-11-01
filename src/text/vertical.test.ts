// Vertical text (縦書き): layout in columns, kinsoku, upright and sideways runs, the Identity-V font writer and the
// emitter, checked with PDFium (src/engine) and poppler (pdftotext, pdffonts, pdftoppm). Synthetic text only; files
// go to the OS temp dir.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber } from 'pdf-lib';
import type { PDFContext, PDFRef } from 'pdf-lib';
import { openPdfium } from '../engine/pdfium.ts';
import type { Char } from '../engine/pdfium.ts';
import { FontWriter } from './font-writer.ts';
import { emit, useLayout } from './emit.ts';
import { layoutParagraphs } from './layout.ts';
import type { Layout, Line } from './layout.ts';
import { emCenter, pdfVMetrics, pdfWidth, verticalFace } from './face.ts';
import type { Face } from './face.ts';
import { shape } from './shape.ts';
import { noLineEnd, noLineStart, verticalUpright } from './unicode.ts';
import { testFaces } from './testkit.ts';
import type { Faces } from './testkit.ts';

const HEAD = '縦書きのテスト用見出し';
const BODY = '第3四半期の売上高は前年同期比12%増となりました。「テスト用の見出し」は、ちょっとキャッシュの説明です。';
const MIXED = '売上高はRevenue Growthと呼びます。';
// upright only: one and two digits stay upright (no sideways run, which poppler reads out of place; see the report)
const UPRIGHT = '第3四半期の売上高は前年同期比12倍となりました。「テスト用の見出し」は、ちょっとキャッシュの説明です。';
const PAGE: [number, number] = [420, 400];

const colText = (l: Line) => l.runs.map((r) => r.glyphs.map((g) => g.text).join('')).join('');
const one = (text: string, face: Face, size: number, box: { width: number; height: number }, extra: Record<string, unknown> = {}): Layout =>
  layoutParagraphs([{ runs: [{ text, face, size }], ...extra }], box, { vertical: true });

let F: Faces;
before(async () => {
  F = await testFaces();
});

test('a vertical paragraph lays out in columns, right to left, inside the box', () => {
  const box = { width: 200, height: 120 };
  const L = one(BODY, F.ja, 12, box);
  assert.equal(L.vertical, true);
  assert.ok(L.lines.length >= 5, `${L.lines.length} columns`);
  assert.equal(L.lines.map(colText).join(''), BODY);
  // the first column hugs the right edge: its axis half a column (leading × size / 2) inside it
  assert.ok(Math.abs(L.lines[0].axis! - (200 - 0.6 * 12)) < 1e-9);
  for (const [i, l] of L.lines.entries()) {
    assert.equal(l.baseline, 0);
    assert.ok(Math.abs(l.height - 14.4) < 1e-9, 'a column is leading × size wide');
    assert.ok(l.width <= box.height + 1e-6, `column ${i} is ${l.width} long`);
    if (i > 0) assert.ok(Math.abs(L.lines[i - 1].axis! - l.axis! - 14.4) < 1e-9, 'columns step left by their width');
    for (const r of l.runs) for (const g of r.glyphs) {
      assert.ok(g.y <= 1e-9 && g.y >= -box.height - 1e-6, `glyph ${g.text} at y ${g.y}`);
      assert.ok(g.x >= 200 - L.width - 1e-6 && g.x <= 200, `glyph ${g.text} at x ${g.x}`);
    }
  }
  assert.ok(Math.abs(L.width - 14.4 * L.lines.length) < 1e-9, 'the stack is the columns side by side');
  assert.equal(L.height, Math.max(...L.lines.map((l) => l.width)));
  // upright CJK: 10 full-width glyphs per 120 pt column at 12 pt; each glyph centred on the axis, stacked one em apart
  const g0 = L.lines[0].runs[0].glyphs;
  assert.equal(L.lines[0].runs[0].orientation, 'upright');
  assert.equal(L.lines[0].runs[0].face.orientation, 'vertical');
  const v = pdfVMetrics(F.ja, g0[0].gid);
  assert.ok(Math.abs(g0[0].x + (v.vx * 12) / 1000 - L.lines[0].axis!) < 1e-6, 'the vertical origin is on the axis');
  assert.ok(Math.abs(g0[0].y + (v.vy * 12) / 1000) < 1e-6, 'the first vertical origin is at the box top');
  assert.ok(Math.abs(g0[2].y - g0[3].y - 12) < 1e-6);
  // width 0: offsets from the right edge
  const R = one(BODY, F.ja, 12, { width: 0, height: 120 });
  assert.ok(Math.abs(R.lines[0].axis! + 7.2) < 1e-9);
  // a box height that is too short for one glyph overflows rather than looping
  assert.equal(one(HEAD, F.ja, 12, { width: 50, height: 5 }).overflow, true);
  assert.throws(() => layoutParagraphs([{ runs: [{ text: HEAD, face: F.ja, size: 12 }] }], { width: 50 }, { vertical: true }), /height/);
});

test('kinsoku holds in vertical text: no column starts with 、。」 or a small kana, none ends with 「', () => {
  // 8 glyphs a column would put 、 at the top of column 2: the break moves back one character
  assert.deepEqual(one('テスト用の見出し、売上高。', F.ja, 10, { width: 100, height: 80 }).lines.map(colText), ['テスト用の見出', 'し、売上高。']);
  assert.deepEqual(one('前年同期比「テスト用」', F.ja, 10, { width: 100, height: 60 }).lines.map(colText), ['前年同期比', '「テスト用」']);
  for (let h = 30; h <= 250; h += 10) {
    const L = one(BODY, F.ja, 10, { width: 300, height: h });
    for (const [i, l] of L.lines.entries()) {
      const t = colText(l);
      if (i > 0) assert.ok(!noLineStart(t.codePointAt(0)!), `height ${h}: column ${i} starts with ${t[0]}`);
      assert.ok(!noLineEnd(t.codePointAt(t.length - 1)!), `height ${h}: column ${i} ends with ${t.at(-1)}`);
    }
    assert.equal(L.lines.map(colText).join(''), BODY);
  }
});

test('a Latin word in vertical text is set sideways as one run; one or two letters or digits stay upright', () => {
  assert.deepEqual(verticalUpright('第3期A4、xyz。'), [true, true, true, true, true, true, false, false, false, true]);
  assert.deepEqual(verticalUpright('A4 xyz'), [false, false, false, false, false, false], 'one Latin run of six characters');
  assert.deepEqual(verticalUpright('比 12 倍'), [true, false, true, true, false, true], 'edge spaces of an upright core stay sideways');
  assert.deepEqual(verticalUpright('比12%増'), [true, false, false, false, true]);
  const L = one(MIXED, F.ja, 12, { width: 100, height: 300 });
  assert.equal(L.lines.length, 1);
  const runs = L.lines[0].runs;
  assert.deepEqual(runs.map((r) => [r.orientation, r.glyphs.map((g) => g.text).join('')]),
    [['upright', '売上高は'], ['sideways', 'Revenue Growth'], ['upright', 'と呼びます。']]);
  const side = runs[1];
  assert.equal(side.face.orientation, 'sideways');
  assert.equal(side.face.base, F.ja);
  // the sideways run: one baseline down the column, its em box centred on the axis; glyphs advance downward by their
  // horizontal advances
  const axis = L.lines[0].axis!;
  for (const g of side.glyphs) assert.ok(Math.abs(g.x - (axis - (emCenter(F.ja) * 12) / 1000)) < 1e-6);
  // horizontal shaping (kerning on) for the sideways run
  const shaped = shape(F.ja, 'Revenue Growth');
  assert.deepEqual(side.glyphs.map((g) => g.gid), shaped.map((g) => g.gid));
  for (let i = 1; i < side.glyphs.length; i++) {
    const p = side.glyphs[i - 1];
    assert.ok(Math.abs(p.y - side.glyphs[i].y - (shaped[i - 1].ax * 12) / F.ja.upem) < 1e-6, `advance after ${p.text}`);
  }
  // digits: one upright, three sideways
  const D = one(BODY.slice(0, 30), F.ja, 12, { width: 100, height: 600 });
  const r3 = D.lines[0].runs.find((r) => r.glyphs.some((g) => g.text === '3'))!;
  assert.equal(r3.orientation, 'upright');
  const r12 = D.lines[0].runs.find((r) => r.glyphs.some((g) => g.text === '1'))!;
  assert.equal(r12.orientation, 'sideways');
  assert.equal(r12.glyphs.map((g) => g.text).join(''), '12%');
  // vertical forms: 。 and 「 take their vert alternates
  const stop = D.lines[0].runs.flatMap((r) => r.glyphs).find((g) => g.text === '。')!;
  assert.notEqual(stop.gid, shape(F.ja, '。')[0].gid);
  assert.equal(stop.gid, shape(F.ja, '。', { direction: 'ttb' })[0].gid);
});

// ---------------------------------------------------------------------------------------------------------------
// One PDF: a Japanese vertical block, a mixed block with a sideways word, and a horizontal line in the same face

type Block = { layout: Layout; at: { x: number; yTop: number }; box: { width: number; height: number }; text: string };
let dir: string;
let pdfPath: string;
let bytes: Uint8Array;
let blocks: Block[];
let refs: Record<string, PDFRef>;
let ctx: PDFContext;
let keyOf: (f: Face) => string;

before(async () => {
  F = await testFaces();
  dir = mkdtempSync(join(tmpdir(), 'pdfedit-vertical-'));
  const doc = await PDFDocument.create();
  ctx = doc.context;
  const page = doc.addPage(PAGE);
  const writer = new FontWriter(doc.context);
  const specs: [string, { width: number; height: number }, { x: number; yTop: number }, number][] = [
    [HEAD + UPRIGHT, { width: 150, height: 160 }, { x: 240, yTop: 360 }, 12],
    [MIXED, { width: 60, height: 300 }, { x: 120, yTop: 360 }, 14],
  ];
  blocks = specs.map(([text, box, at, size]) => ({ layout: one(text, F.ja, size, box), at, box, text }));
  const horiz = layoutParagraphs([{ runs: [{ text: HEAD, face: F.ja, size: 10 }] }], { width: 300 });
  const keys = [...blocks.map((b) => useLayout(writer, b.layout)), useLayout(writer, horiz)];
  keyOf = keys[0];
  refs = writer.finish();
  for (const [k, ref] of Object.entries(refs)) page.node.setFontDictionary(PDFName.of(k), ref);
  const parts = [...blocks.map((b, i) => emit(b.layout, b.at, keys[i])), emit(horiz, { x: 20, yTop: 40 }, keys[2])];
  page.node.addContentStream(doc.context.register(doc.context.flateStream(concat(parts))));
  bytes = await doc.save({ useObjectStreams: false });
  pdfPath = join(dir, 'vertical.pdf');
  writeFileSync(pdfPath, bytes);
});

test('pdffonts shows the face twice, Identity-V and Identity-H, one shared subset, embedded with ToUnicode', () => {
  const out = execFileSync('/usr/bin/pdffonts', [pdfPath], { encoding: 'utf8' });
  const rows = out.split('\n').slice(2).filter((l) => l.trim());
  assert.equal(rows.length, 2, out);
  assert.match(rows[0], /^([A-Z]{6})\+NotoSansJP-Regular\s+CID TrueType\s+Identity-V\s+yes\s+yes\s+yes\s/);
  assert.match(rows[1], /^([A-Z]{6})\+NotoSansJP-Regular\s+CID TrueType\s+Identity-H\s+yes\s+yes\s+yes\s/);
  assert.equal(rows[0].slice(0, 6), rows[1].slice(0, 6), 'one subset tag: the same program');
});

test('the Identity-V font: /DW2 and /W2 on its own descendant, sharing FontFile2 and ToUnicode with Identity-H', () => {
  const fonts = Object.values(refs).map((r) => ctx.lookup(r, PDFDict));
  const v = fonts.find((f) => f.get(PDFName.of('Encoding'))?.toString() === '/Identity-V')!;
  const h = fonts.find((f) => f.get(PDFName.of('Encoding'))?.toString() === '/Identity-H')!;
  assert.ok(v && h);
  const desc = (t0: PDFDict) => ctx.lookup((t0.get(PDFName.of('DescendantFonts')) as PDFArray).get(0), PDFDict);
  const dv = desc(v), dh = desc(h);
  assert.notEqual(dv, dh);
  assert.equal(dv.get(PDFName.of('DW2'))?.toString(), '[ 880 -1000 ]');
  assert.equal(dh.get(PDFName.of('DW2')), undefined);
  assert.equal(dh.get(PDFName.of('W2')), undefined);
  assert.equal(dv.get(PDFName.of('FontDescriptor'))?.toString(), dh.get(PDFName.of('FontDescriptor'))?.toString());
  assert.equal(v.get(PDFName.of('ToUnicode'))?.toString(), h.get(PDFName.of('ToUnicode'))?.toString());
  // every upright glyph used is covered by DW2 or W2 with the metrics emit() positioned it with
  const w2 = dv.get(PDFName.of('W2')) as PDFArray | undefined;
  const listed = new Map<number, number[]>();
  if (w2) for (let i = 0; i < w2.size(); i += 2) {
    const c = (w2.get(i) as PDFNumber).asNumber();
    const vals = (w2.get(i + 1) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    for (let k = 0; k * 3 < vals.length; k++) listed.set(c + k, vals.slice(k * 3, k * 3 + 3));
  }
  for (const b of blocks) for (const l of b.layout.lines) for (const r of l.runs) {
    if (r.orientation !== 'upright') continue;
    for (const g of r.glyphs) {
      const m = pdfVMetrics(r.face, g.gid);
      const got = listed.get(g.gid) ?? [-1000, pdfWidth(F.ja, g.gid) / 2, 880];
      assert.deepEqual(got, [m.w1y, m.vx, m.vy], `gid ${g.gid} (${g.text})`);
    }
  }
});

test('emit places every glyph at its laid-out origin within 0.01 pt (TJ numbers move along y in Identity-V)', () => {
  const faceOf = new Map<string, Face>();
  for (const b of blocks) for (const l of b.layout.lines) for (const r of l.runs) faceOf.set(keyOf(r.face), r.face);
  for (const b of blocks) {
    const content = new TextDecoder().decode(emit(b.layout, b.at, keyOf));
    const shown = simulate(content, faceOf);
    const expected = b.layout.lines.flatMap((l) => l.runs.flatMap((r) => r.glyphs.map((g) => ({ gid: g.gid, x: b.at.x + g.x, y: b.at.yTop - l.baseline + g.y }))));
    assert.equal(shown.length, expected.length);
    for (const [i, e] of expected.entries()) {
      assert.equal(shown[i].gid, e.gid);
      assert.ok(Math.abs(shown[i].x - e.x) < 0.01 && Math.abs(shown[i].y - e.y) < 0.01, `glyph ${i}: ${shown[i].x},${shown[i].y} vs ${e.x},${e.y}`);
    }
    // one Tm per column (plus one per orientation change, and none for the column's last glyph, shown by its own TJ)
    const tms = content.match(/ Tm\n/g)!.length;
    const changes = b.layout.lines.reduce((n, l) => n + l.runs.filter((r) => r.glyphs.length).length, 0);
    assert.equal(tms, changes);
  }
  const side = new TextDecoder().decode(emit(blocks[1].layout, blocks[1].at, keyOf));
  assert.match(side, /\n0 -1 1 0 [\d.]+ [\d.]+ Tm\n/, 'sideways Latin under a matrix rotated 90° clockwise');
});

test('PDFium (src/engine) reads the vertical text back in order, inside each block', async () => {
  const P = await openPdfium();
  const d = P.open(bytes);
  try {
    const pg = d.page(0);
    const chars = pg.chars();
    pg.close();
    for (const b of blocks) {
      const x1 = b.at.x + b.box.width, x0 = x1 - b.layout.width, y1 = b.at.yTop, y0 = y1 - b.box.height;
      const inside = chars.filter((c) => {
        const cx = (c.box.x0 + c.box.x1) / 2, cy = (c.box.y0 + c.box.y1) / 2;
        return !c.generated && cx >= x0 - 1 && cx <= x1 + 1 && cy >= y0 - 1 && cy <= y1 + 1;
      });
      assert.equal(text(inside), b.text.replace(/\s+/g, ''));
      for (const c of inside) assert.ok(c.box.x0 >= x0 - 1 && c.box.x1 <= x1 + 1 && c.box.y0 >= y0 - 1 && c.box.y1 <= y1 + 1, `${c.unicode} ${JSON.stringify(c.box)}`);
    }
    // the sideways word's characters are turned; the upright ones are not
    const latin = chars.filter((c) => /[A-Za-z]/.test(c.unicode));
    assert.equal(latin.map((c) => c.unicode).join(''), 'RevenueGrowth');
    assert.ok(latin.every((c) => Math.abs(Math.abs(c.angle) - Math.PI / 2) < 0.01), JSON.stringify(latin.map((c) => c.angle)));
    assert.ok(chars.filter((c) => c.unicode === '縦').every((c) => c.angle === 0));
    // sideways glyphs run down the page
    for (let i = 1; i < 7; i++) assert.ok(latin[i].box.y1 < latin[i - 1].box.y1);
  } finally {
    d.close();
  }
});

test('pdftotext reads the Japanese vertical block back in order (upright digits included)', () => {
  const b = blocks[0];
  const x0 = Math.floor(b.at.x + b.box.width - b.layout.width) - 2, y0 = Math.floor(PAGE[1] - b.at.yTop) - 2;
  const out = execFileSync('/usr/bin/pdftotext', ['-enc', 'UTF-8', '-x', String(x0), '-y', String(y0), '-W', String(Math.ceil(b.layout.width) + 4), '-H', String(Math.ceil(b.box.height) + 4), pdfPath, '-'], { encoding: 'utf8' });
  assert.equal(out.replace(/\s+/g, ''), b.text);
});

test('pdftoppm renders the page without errors; the ink stays inside each column stack', () => {
  const prefix = join(dir, 'render');
  const r = spawnSync('/usr/bin/pdftoppm', ['-r', '72', '-png', '-singlefile', pdfPath, prefix], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr.trim(), '', r.stderr);
  const png = PNG.sync.read(readFileSync(prefix + '.png'));
  for (const b of blocks) {
    const x1 = b.at.x + b.box.width, x0 = x1 - b.layout.width, top = PAGE[1] - b.at.yTop;
    const ink = inkBox(png, Math.floor(x0) - 10, Math.floor(top) - 10, Math.ceil(x1) + 10, Math.ceil(top + b.box.height) + 10);
    assert.ok(ink, 'block has ink');
    assert.ok(ink.x0 >= x0 - 1 && ink.x1 <= x1 + 1, `ink x ${ink.x0}–${ink.x1} vs ${x0}–${x1}`);
    assert.ok(ink.y0 >= top - 1 && ink.y1 <= top + b.layout.height + 1, `ink y ${ink.y0}–${ink.y1} vs ${top}–${top + b.layout.height}`);
    // the first column's ink is centred on its axis
    const axis = b.at.x + b.layout.lines[0].axis!;
    const col = inkBox(png, Math.floor(axis - 8), Math.floor(top), Math.ceil(axis + 8), Math.ceil(top + 40));
    assert.ok(col && Math.abs((col.x0 + col.x1 + 1) / 2 - axis) < 1.5, `column ink ${col?.x0}–${col?.x1} around ${axis}`);
  }
});

test('FontWriter.use(face, glyphs, { vertical: true }) gives the Identity-V key without a view face', async () => {
  const doc = await PDFDocument.create();
  const w = new FontWriter(doc.context, { prefix: 'VT' });
  const g = shape(F.jaBold, HEAD, { direction: 'ttb' }).map((x, i) => ({ gid: x.gid, text: HEAD[i] }));
  const kv = w.use(F.jaBold, g, { vertical: true });
  const kh = w.use(F.jaBold, g);
  assert.notEqual(kv, kh);
  assert.equal(w.use(verticalFace(F.jaBold), g), kv);
  assert.equal(w.keyOf(F.jaBold, { vertical: true }), kv);
  assert.equal(w.keyOf(verticalFace(F.jaBold)), kv);
  const out = w.finish();
  assert.equal(doc.context.lookup(out[kv], PDFDict).get(PDFName.of('Encoding'))?.toString(), '/Identity-V');
  assert.equal(doc.context.lookup(out[kh], PDFDict).get(PDFName.of('Encoding'))?.toString(), '/Identity-H');
});

// ---------------------------------------------------------------------------------------------------------------

const text = (cs: Char[]) => cs.map((c) => c.unicode).join('').replace(/\s+/g, '');

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A minimal interpreter for emit()'s vertical output: Tm, Tf and TJ (Tc = Tw = 0, Tz = 100, Ts = 0). Returns each
 *  glyph's horizontal origin in page space: for an Identity-V font the pen is the vertical origin, so the glyph sits
 *  at pen − v; advances and TJ numbers move along y. */
function simulate(content: string, faceOf: Map<string, Face>) {
  const toks = content.match(/\[|\]|<[0-9A-F]*>|\/[^\s[\]<>/]+|-?\d*\.?\d+|[A-Za-z*']+/g)!;
  const glyphs: { gid: number; x: number; y: number }[] = [];
  let stack: string[] = [];
  let m = [1, 0, 0, 1, 0, 0];
  let tx = 0, ty = 0, size = 0;
  let face: Face | undefined;
  let arr: string[] | null = null;
  const page = (x: number, y: number) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
  for (const t of toks) {
    if (t === '[') arr = [];
    else if (t === ']') stack.push('ARRAY');
    else if (arr && !/^[A-Za-z]/.test(t)) arr.push(t);
    else if (/^[A-Za-z*']+$/.test(t)) {
      if (t === 'Tm') {
        m = stack.slice(0, 6).map(Number);
        tx = ty = 0;
      } else if (t === 'Tf') {
        face = faceOf.get(stack[0].slice(1));
        size = +stack[1];
      } else if (t === 'TJ') {
        const vertical = face!.orientation === 'vertical';
        for (const e of arr!) {
          if (e.startsWith('<')) {
            for (let i = 1; i + 4 <= e.length - 1; i += 4) {
              const gid = parseInt(e.slice(i, i + 4), 16);
              if (vertical) {
                const v = pdfVMetrics(face!, gid);
                glyphs.push({ gid, ...page(tx - (v.vx * size) / 1000, ty - (v.vy * size) / 1000) });
                ty += (v.w1y * size) / 1000;
              } else {
                glyphs.push({ gid, ...page(tx, ty) });
                tx += (pdfWidth(face!, gid) * size) / 1000;
              }
            }
          } else if (vertical) ty -= (+e * size) / 1000;
          else tx -= (+e * size) / 1000;
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
