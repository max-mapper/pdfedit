// Encrypted input on synthetic PDFs (src/pdf/cryptkit.ts: RC4 40-bit and 128-bit, AES-128 and AES-256). A file
// encrypted with an owner password only opens, lists its objects and exports (the output unencrypted); a file that needs
// a user password is refused with PDFium's needsPassword error everywhere.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPdfium, PdfiumOpenError } from '../engine/pdfium.ts';
import { ExportError, exportDoc } from '../export/export.ts';
import { boxOf, docOf, laidText, readPages } from '../export/testkit.ts';
import type { Box, LaidBox } from '../model/types.ts';
import { listObjects } from '../objects/list.ts';
import { CIPHERS, encryptPdf } from './cryptkit.ts';
import { openForEdit } from './edit.ts';
import { hasEncrypt, openEditable } from './editable.ts';
import { hasNoto, hasPdftotext, makePdf, pdftotext } from './testing.ts';
import { contentTree } from './tree.ts';

const REVISION = { 'rc4-40': 2, 'rc4-128': 3, 'aes-128': 4, 'aes-256': 6 } as const;
const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const plainPdf = () => makePdf({ content: () => 'BT /F1 14 Tf 72 700 Td (Restricted old text) Tj ET\nBT /F1 12 Tf 72 500 Td (Other line) Tj ET\n0 0 1 rg 72 300 120 40 re f' });
const streams = async (bytes: Uint8Array) => contentTree(await openForEdit(bytes), 0).nodes.map((n) => latin(n.contents));
const shape = (pages: Awaited<ReturnType<typeof listObjects>>) => pages.map((p) => p.objects.map((o) => [o.id, o.kind]));

for (const cipher of CIPHERS) {
  test(`${cipher}, owner password only: opened as PDFium's decrypted copy, objects listed, exported unencrypted`, { skip: !hasNoto && 'fonts missing' }, async () => {
    const plain = await plainPdf();
    const original = await encryptPdf(plain, { cipher, owner: 'owner-pw' });
    assert.ok(hasEncrypt(original) && !hasEncrypt(plain));
    assert.ok(!latin(original).includes('Restricted old'), 'the fixture\'s streams are encrypted');
    const P = await openPdfium();
    const sec = P.security(original);
    assert.deepEqual([sec.encrypted, sec.needsPassword, sec.revision], [true, false, REVISION[cipher]]);
    await assert.rejects(openForEdit(original), /encrypted/, 'pdf-lib alone cannot read it');

    const { edit, decrypted } = await openEditable(original, P);
    assert.equal(decrypted, true);
    assert.deepEqual(contentTree(edit, 0).nodes.map((n) => latin(n.contents)), await streams(plain));
    assert.ok(Buffer.from(P.decryptCopy(original)!).equals(Buffer.from(P.decryptCopy(original)!)), 'the copy is the same each time');
    assert.deepEqual(shape(await listObjects(original)), shape(await listObjects(plain)));

    const [pr] = await readPages(original);
    const a = boxOf(pr, 'a', [0], { edited: true });
    const laid = new Map<string, LaidBox>([['a', await laidText(a, 'Open new text')]]);
    const { bytes, report } = await exportDoc(original, docOf([{ pr, boxes: [a] }]), (_p: number, b: Box) => laid.get(b.id)!);
    assert.ok(report.ok && report.verified, report.failures.join('; '));
    assert.deepEqual([report.decrypted, report.encrypted, report.incremental], [true, false, false]);
    assert.equal(P.security(bytes).encrypted, false);
    assert.equal(hasEncrypt(bytes), false);
    if (hasPdftotext) {
      const t = pdftotext(bytes, `${cipher}.pdf`).text;
      assert.ok(t.includes('Open new text') && t.includes('Other line') && !t.includes('Restricted old'), t);
    }
  });

  test(`${cipher}, user password: refused (needsPassword) when opened, listed or exported`, async () => {
    const plain = await plainPdf();
    const original = await encryptPdf(plain, { cipher, owner: 'owner-pw', user: 'user-pw' });
    const P = await openPdfium();
    assert.equal(P.security(original).needsPassword, true);
    const needsPassword = (e: unknown) => e instanceof PdfiumOpenError && e.needsPassword;
    assert.throws(() => P.open(original), needsPassword);
    await assert.rejects(openEditable(original, P), needsPassword);
    await assert.rejects(listObjects(original), needsPassword);
    const [pr] = await readPages(plain);
    await assert.rejects(exportDoc(original, docOf([{ pr, boxes: [boxOf(pr, 'a', [0], { edited: true })] }]), () => { throw new Error('no layout'); }), (e: unknown) => {
      assert.ok(e instanceof ExportError);
      assert.match(e.report.failures[0], /^refused: the document is encrypted with a user password/);
      return true;
    });
  });
}

test('a file that is not encrypted is opened as it is', async () => {
  const plain = await plainPdf();
  const { edit, decrypted } = await openEditable(plain, await openPdfium());
  assert.equal(decrypted, false);
  assert.equal(latin(edit.save()), latin(plain), 'no change, no copy');
});
