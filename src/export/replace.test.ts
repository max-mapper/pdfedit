// End to end on a synthetic page: detect → model → replace (a fixed table) → export → verify. Synthetic material only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { loadHarfBuzz } from '../text/hb.ts';
import { loadFace } from '../text/face.ts';
import { layoutParagraphs } from '../text/layout.ts';
import { FontWriter } from '../text/font-writer.ts';
import { emit } from '../text/emit.ts';
import { replaceText } from './replace.ts';

const FONTS = new URL('../../fonts/', import.meta.url);
const HEAD = 'テスト用の見出し';
const BODY = '第3四半期の売上高は前年同期比12%増となりました。主力製品の出荷が堅調に推移しました。';

async function japanesePage(): Promise<Uint8Array> {
  await loadHarfBuzz();
  const jp = loadFace(readFileSync(new URL('NotoSansJP-VF.ttf', FONTS)), { variations: { wght: 400 } });
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const writer = new FontWriter(doc.context);
  const head = layoutParagraphs([{ runs: [{ text: HEAD, face: jp, size: 18 }] }], { width: 400 });
  const body = layoutParagraphs([{ runs: [{ text: BODY, face: jp, size: 11 }] }], { width: 250 });
  const keys = new Map<unknown, string>();
  for (const L of [head, body]) for (const line of L.lines) for (const run of line.runs) keys.set(run.face, writer.use(run.face, run.glyphs));
  const fonts = writer.finish();
  const content = new Uint8Array([...emit(head, { x: 60, yTop: 780 }, (f) => keys.get(f)!), 10, ...emit(body, { x: 60, yTop: 730 }, (f) => keys.get(f)!)]);
  const stream = doc.context.flateStream(content);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  const fontDict = doc.context.obj({});
  for (const [k, ref] of Object.entries(fonts)) fontDict.set(PDFName.of(k), ref);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: fontDict }));
  doc.setTitle(PDFString.of('synthetic').asString());
  return doc.save({ useObjectStreams: false });
}

test('replace: the named paragraphs get the new text, saved incrementally and verified', async () => {
  const bytes = await japanesePage();
  const table = {
    [HEAD]: 'Heading for the test',
    [BODY]: 'Net sales for the third quarter rose 12% year on year. Shipments of our main products remained firm.',
  };
  const res = await replaceText(bytes, table);
  assert.ok(res.bytes, 'something was written');
  assert.equal(res.stats.edited, 2);
  assert.equal(res.replaced.length, 2);
  assert.equal(Buffer.compare(Buffer.from(res.bytes!.subarray(0, bytes.length)), Buffer.from(bytes)), 0, 'incremental: original bytes kept');
  assert.equal(res.export!.pages[0].written.length, 2);
  assert.ok(res.export!.ok, JSON.stringify(res.export!.failures));
  const dir = mkdtempSync(join(tmpdir(), 'pdfedit-replace-'));
  const out = join(dir, 'out.pdf');
  writeFileSync(out, res.bytes!);
  const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  assert.match(text, /Heading for the test/);
  assert.match(text, /Net sales for the third quarter rose 12% year on year/);
  assert.doesNotMatch(text, /売上高/);
});

test('replace: a table that names no paragraph writes nothing', async () => {
  const bytes = await japanesePage();
  const res = await replaceText(bytes, { 'not on the page': 'x' });
  assert.equal(res.bytes, null);
  assert.equal(res.replaced.length, 0);
  assert.equal(res.export, null);
});
