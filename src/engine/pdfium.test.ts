import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { openPdfium, PdfiumOpenError } from './pdfium.ts';

async function syntheticPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('First line of a synthetic page', { x: 40, y: 240, size: 14, font, color: rgb(0.1, 0.2, 0.6) });
  page.drawText('Second line', { x: 40, y: 210, size: 12, font });
  page.drawRectangle({ x: 30, y: 150, width: 200, height: 30, color: rgb(0.9, 0.9, 0.9) });
  return doc.save({ useObjectStreams: false });
}

test('reads characters, text objects and the character-to-object link', async () => {
  const P = await openPdfium();
  const doc = P.open(await syntheticPdf());
  assert.equal(doc.pageCount, 1);
  const page = doc.page(0);
  assert.equal(Math.round(page.size.w), 400);
  const chars = page.chars();
  const text = chars.map((c) => c.unicode).join('');
  assert.match(text, /First line of a synthetic page/);
  const objs = page.textObjects();
  assert.equal(objs.length, 2);
  assert.deepEqual(objs.map((o) => o.topIndex), [0, 1]);
  assert.equal(objs[0].text, 'First line of a synthetic page');
  assert.ok(objs[0].fontName.includes('Helvetica'));
  assert.ok(Math.abs(objs[0].fontSize - 14) < 0.01 || Math.abs(objs[0].matrix[0] * objs[0].fontSize - 14) < 0.01);
  const first = chars.find((c) => c.unicode === 'F')!;
  assert.equal(first.obj, 0);
  assert.ok(first.box.x0 >= 39 && first.box.x0 <= 42, `F at x ${first.box.x0}`);
  assert.ok(first.fill[2] > first.fill[0], 'blue fill');
  page.close(); doc.close();
});

test('renders a page to RGBA', async () => {
  const P = await openPdfium();
  const doc = P.open(await syntheticPdf());
  const page = doc.page(0);
  const bmp = page.render(1);
  assert.equal(bmp.width, 400); assert.equal(bmp.height, 300);
  // the grey rectangle: pdf y 150–180 → bitmap rows 120–150, x 30–230
  const k = (135 * 400 + 100) * 4;
  assert.ok(Math.abs(bmp.rgba[k] - 230) < 8 && Math.abs(bmp.rgba[k + 2] - 230) < 8, `grey pixel ${bmp.rgba.slice(k, k + 4)}`);
  // white background
  const w = (290 * 400 + 390) * 4;
  assert.deepEqual([...bmp.rgba.slice(w, w + 3)], [255, 255, 255]);
  page.close(); doc.close();
});

test('lists shapes with fill, rectangles and rules', async () => {
  const P = await openPdfium();
  const doc = P.open(await syntheticPdf());
  const page = doc.page(0);
  const shapes = page.shapes();
  const rect = shapes.find((s) => s.kind === 'path' && s.isRect);
  assert.ok(rect, 'the grey rectangle is a rect path');
  assert.ok(Math.abs(rect!.bounds.x0 - 30) < 1 && Math.abs(rect!.bounds.y1 - 180) < 1, JSON.stringify(rect!.bounds));
  assert.ok(rect!.fill && Math.abs(rect!.fill[0] - 230) < 3, `fill ${rect!.fill}`);
  page.close(); doc.close();
});

/** The file encrypted by PDFium itself (EPDF_SetEncryption): owner password, and a user password when given. */
async function encrypted(bytes: Uint8Array, owner: string, user = ''): Promise<Uint8Array> {
  const P = await openPdfium();
  const M = P.module as unknown as Record<string, (...a: unknown[]) => number> & { pdfium: { HEAPU8: Uint8Array; wasmExports: { malloc(n: number): number; free(p: number): void } } };
  const mem = M.pdfium.wasmExports.malloc(bytes.length);
  M.pdfium.HEAPU8.set(bytes, mem);
  const doc = M.FPDF_LoadMemDocument(mem, bytes.length, '');
  assert.ok(doc && M.EPDF_SetEncryption(doc, user, owner, 0xfffff0c4 | 0));
  const w = M.PDFiumExt_OpenFileWriter();
  assert.ok(M.PDFiumExt_SaveAsCopy(doc, w));
  const n = M.PDFiumExt_GetFileWriterSize(w);
  const p = M.pdfium.wasmExports.malloc(n);
  M.PDFiumExt_GetFileWriterData(w, p, n);
  const out = M.pdfium.HEAPU8.slice(p, p + n);
  M.pdfium.wasmExports.free(p);
  M.PDFiumExt_CloseFileWriter(w);
  M.FPDF_CloseDocument(doc);
  M.pdfium.wasmExports.free(mem);
  return out;
}

const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');

test('security, decryptCopy and repairCopy', async () => {
  const P = await openPdfium();
  const plain = await syntheticPdf();
  assert.deepEqual(P.security(plain), { encrypted: false, needsPassword: false, revision: -1, permissions: -1 });
  assert.equal(P.decryptCopy(plain), null);

  const owner = await encrypted(plain, 'owner-only');
  const sec = P.security(owner);
  assert.equal(sec.encrypted, true);
  assert.equal(sec.needsPassword, false);
  assert.ok(sec.revision >= 2);
  assert.match(latin(owner), /\/Encrypt\s*\d+ 0 R/);
  const dec = P.decryptCopy(owner)!;
  assert.ok(dec && !/\/Encrypt\s*\d+ 0 R/.test(latin(dec)), 'the copy\'s trailer has no /Encrypt');
  assert.equal(P.security(dec).encrypted, false);
  const d = P.open(dec);
  const pg = d.page(0);
  assert.equal(pg.textObjects()[0].text, 'First line of a synthetic page');
  pg.close(); d.close();

  const user = await encrypted(plain, 'owner', 'user');
  assert.equal(P.security(user).needsPassword, true);
  assert.throws(() => P.decryptCopy(user), (e: unknown) => e instanceof PdfiumOpenError && e.needsPassword && /user password/.test(e.message));
  assert.throws(() => P.open(user), (e: unknown) => e instanceof PdfiumOpenError && e.code === 4);

  // a startxref that points into the middle of the file: PDFium rebuilds the table, the copy has a sound one
  const s = latin(plain);
  const broken = new Uint8Array(Buffer.from(s.replace(/startxref\s+(\d+)/, (_, n) => `startxref\n${Number(n) - 40}`), 'latin1'));
  const fixed = P.repairCopy(broken);
  assert.match(latin(fixed), /^%PDF-/);
  const at = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(latin(fixed))![1]);
  assert.ok(/^\s*(xref|\d+ \d+ obj)/.test(latin(fixed.subarray(at, at + 20))), 'startxref points at a cross-reference section');
  assert.throws(() => P.repairCopy(new Uint8Array([1, 2, 3])), PdfiumOpenError);
});
