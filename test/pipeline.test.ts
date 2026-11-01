// End to end on a synthetic page: detect → model → translate (a fixed table) → fit → export → verify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { loadHarfBuzz } from '../src/text/hb.ts';
import { loadFace } from '../src/text/face.ts';
import { layoutParagraphs } from '../src/text/layout.ts';
import { FontWriter } from '../src/text/font-writer.ts';
import { emit } from '../src/text/emit.ts';
import { translateAndFit, tableTranslator } from '../src/pipeline.ts';

const FONTS = new URL('../fonts/', import.meta.url);
const HEAD = 'テスト用の見出し';
const BODY = '第3四半期の売上高は前年同期比12%増となりました。主力製品の出荷が堅調に推移しました。';

async function japanesePage(ruleUnderBody = false): Promise<Uint8Array> {
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
  const rule = ruleUnderBody ? [...new TextEncoder().encode('\n0 0 0 RG 1 w 40 688 m 560 688 l S\n')] : [];
  const content = new Uint8Array([...emit(head, { x: 60, yTop: 780 }, (f) => keys.get(f)!), 10, ...emit(body, { x: 60, yTop: 730 }, (f) => keys.get(f)!), ...rule]);
  const stream = doc.context.flateStream(content);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  const fontDict = doc.context.obj({});
  for (const [k, ref] of Object.entries(fonts)) fontDict.set(PDFName.of(k), ref);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: fontDict }));
  doc.setTitle(PDFString.of('synthetic').asString());
  return doc.save({ useObjectStreams: false });
}

test('translate-and-fit: Japanese paragraphs become fitted English, saved incrementally and verified', async () => {
  const bytes = await japanesePage();
  const table = {
    [HEAD]: 'Heading for the test',
    [BODY]: 'Net sales for the third quarter rose 12% year on year. Shipments of our main products remained firm.',
  };
  const res = await translateAndFit(bytes, { translate: tableTranslator(table) });
  assert.ok(res.bytes, 'something was written');
  assert.equal(res.stats.edited, 2);
  assert.equal(Buffer.compare(Buffer.from(res.bytes!.subarray(0, bytes.length)), Buffer.from(bytes)), 0, 'incremental: original bytes kept');
  assert.equal(res.export!.pages[0].written.length, 2);
  const dir = mkdtempSync(join(tmpdir(), 'pdfedit-pipe-'));
  const out = join(dir, 'out.pdf');
  writeFileSync(out, res.bytes!);
  const text = execFileSync('pdftotext', [out, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  assert.match(text, /Heading for the test/);
  assert.match(text, /Net sales for the third quarter rose 12% year on year/);
  assert.doesNotMatch(text, /売上高/);
  // the body is longer in English than its 250 pt box allowed at one line per sentence: the fitter acted on it
  const body = res.fit[0].boxes.find((b) => b.result !== 'fits');
  assert.ok(body, JSON.stringify(res.fit));
});

test('targeted shortening: an over-long box is shortened within its budget, listed, and fitted again', async () => {
  const bytes = await japanesePage(true);   // a rule under the body: the box cannot grow down
  const long = 'Net sales for the third quarter of the fiscal year rose by twelve percent compared with the same period of the previous year, and shipments of our main products, which account for most of our revenue, remained firm throughout the whole of the quarter under review, according to management, who expect this trend to continue in the coming quarters as well.';
  const table = { [HEAD]: 'Heading for the test', [BODY]: long };
  const asked: { maxChars: number; english: string }[] = [];
  const shorten = async (_page: number, items: { source: string; english: string; maxChars: number }[]) =>
    items.map((it) => { asked.push(it); return 'Q3 net sales rose 12% YoY; main product shipments stayed firm.'; });
  const plain = await translateAndFit(bytes, { translate: tableTranslator(table), verify: false, substitute: false });
  const res = await translateAndFit(bytes, { translate: tableTranslator(table), shorten, verify: false, substitute: false });
  const before = plain.fit[0].boxes.find((b) => b.result === 'unfit' || b.scale < 0.8);
  assert.ok(before, 'the long English needs shortening without it');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].english, long);
  assert.ok(asked[0].maxChars < long.length && asked[0].maxChars >= Math.floor(long.length * 0.5), `budget ${asked[0].maxChars}`);
  assert.equal(res.shortened.length, 1);
  assert.equal(res.shortened[0].before, long);
  const after = res.fit[0].boxes.find((b) => b.box === res.shortened[0].box)!;
  assert.ok(after.result !== 'unfit' && after.scale >= 0.8, JSON.stringify(after));
  assert.equal(plain.shortened.length, 0, 'never without a shortener');
});
