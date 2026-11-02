// A version's state: the edited boxes serialised (and nothing else), through JSON, and put back over a fresh copy
// of the same detected document, with split and merged boxes, box order and picture moves; then one page made ready
// from pairs (translate, saved boxes back, fit). Synthetic boxes and text only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadFonts, type FontRegistry } from '../model/fonts.ts';
import { Editor } from '../model/edit.ts';
import { box, para } from '../model/testkit.ts';
import type { Doc } from '../model/types.ts';
import { applyState, parseState, serialiseState, StateError, STATE_FORMAT } from './state.ts';
import { createMatcher } from './match.ts';
import { preparePage } from './page.ts';
import { encodeReportHeader, hostReport, substitutionsOf } from './report.ts';
import type { ExportReport } from '../export/export.ts';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

/** The same detected document every call (detection is deterministic: same ids, same boxes). */
function detected(): Doc {
  const page = (n: number) => ({
    n, w: 595, h: 842, panels: [], obstacles: [{ x0: 300, y0: 400, x1: 500, y1: 500 }],
    pictures: [{ id: 'pic0', kind: 'image' as const, frame: { x0: 300, y0: 400, x1: 500, y1: 500 }, z: 0, objs: [0] }],
    boxes: [
      box('b0', { x0: 60, x1: 260, y0: 760, y1: 780 }, [para('見出しの文')]),
      box('b1', { x0: 60, x1: 260, y0: 700, y1: 740 }, [para('第一段落の文。'), para('第二段落の文。')]),
      box('b2', { x0: 60, x1: 260, y0: 640, y1: 680 }, [para('別の箱の文。')]),
      box('b3', { x0: 60, x1: 260, y0: 580, y1: 620 }, [para('最後の箱の文。')]),
    ],
  });
  return { pages: [page(0), page(1)] };
}

test('only edited boxes are saved; JSON round trip; put back over a fresh detection', () => {
  const doc = detected();
  const ed = new Editor(doc, fonts);
  ed.setText(0, 'b0', 0, 'Heading text');
  ed.setFrame(0, 'b2', { x0: 70, x1: 300, y0: 630, y1: 680 }, { pinHeight: true });
  const tail = ed.splitBox(0, 'b1', 1);
  ed.mergeBoxes(0, 'b3', 'b2');              // b2 merged into b3: gone from the page
  doc.pages[0].pictures![0].move = { dx: 4, dy: -6, scale: 0.9 };
  ed.setText(1, 'b3', 0, 'Last box text');

  const state = serialiseState(doc, { engine: 'test' });
  assert.equal(state.format, STATE_FORMAT);
  assert.equal(state.engine, 'test');
  assert.deepEqual(state.pages.map((p) => p.n), [0, 1]);
  assert.deepEqual(state.pages[0].boxes.map((b) => b.id).sort(), ['b0', 'b1', 'b3', tail].sort());
  assert.deepEqual(state.pages[1].boxes.map((b) => b.id), ['b3'], 'unedited boxes are not saved');
  assert.deepEqual(state.pages[0].order, doc.pages[0].boxes.map((b) => b.id));
  assert.deepEqual(state.pages[0].pictures, [{ id: 'pic0', move: { dx: 4, dy: -6, scale: 0.9 } }]);

  const wire = parseState(JSON.parse(JSON.stringify(state)));
  const fresh = detected();
  const res = applyState(fresh, wire);
  assert.deepEqual(res.pages, [0, 1]);
  assert.deepEqual(res.missingPages, []);
  for (const n of [0, 1]) {
    assert.deepEqual(JSON.parse(JSON.stringify(fresh.pages[n].boxes)), JSON.parse(JSON.stringify(doc.pages[n].boxes)), `page ${n} boxes as saved`);
    assert.deepEqual(fresh.pages[n].pictures, JSON.parse(JSON.stringify(doc.pages[n].pictures)));
  }
  assert.ok(!fresh.pages[0].boxes.some((b) => b.id === 'b2'), 'the merged-away box is dropped');
  // the restored boxes are editable as before
  const ed2 = new Editor(fresh, fonts);
  ed2.setText(0, tail, 0, 'More');
  assert.equal(ed2.laid(0, tail).overflow, false);
});

test('a document without edits saves no pages', () => {
  assert.deepEqual(serialiseState(detected()).pages, []);
});

test('a state for pages the document lacks is reported, and a malformed state refused', () => {
  const doc = detected();
  new Editor(doc, fonts).setText(1, 'b0', 0, 'X');
  const st = serialiseState(doc);
  st.pages[0].n = 7;
  const res = applyState(detected(), st);
  assert.deepEqual(res.missingPages, [7]);
  assert.throws(() => parseState({ format: 'other', pages: [] }), StateError);
  assert.throws(() => parseState({ format: STATE_FORMAT, pages: [{ n: 0, order: [], boxes: [{ id: 'x' }] }] }), StateError);
  assert.throws(() => parseState(null), StateError);
});

test('a page made ready: translated from pairs, untranslated listed, fitted; saved boxes win and skip the fit', () => {
  const pairs = createMatcher([
    { id: 'p1', source: '見出しの文', target: 'Heading' },
    { id: 'p2', source: '第一段落の文。', target: 'The first paragraph, translated at some length so that it needs more room than the source.' },
    { id: 'p3', source: '別の箱の', target: 'Another box' },
    { id: 'p4', source: '文。', target: 'sentence.' },
  ]);
  const doc = detected();
  const prep = preparePage(new Editor(doc, fonts), 0, pairs, null);
  const text = (d: Doc, id: string) => d.pages[0].boxes.find((b) => b.id === id)!.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));
  assert.deepEqual(text(doc, 'b0'), ['Heading']);
  assert.equal(text(doc, 'b1')[0].startsWith('The first paragraph'), true);
  assert.deepEqual(text(doc, 'b2'), ['Another box sentence.'], 'a joined run');
  assert.deepEqual(prep.translated.sort(), ['b0', 'b1', 'b2']);
  assert.deepEqual(prep.untranslated.map((u) => [u.box, u.para]), [['b1', 1], ['b3', 0]]);
  assert.equal(prep.paragraphs, 5);
  assert.ok(prep.fit && prep.fit.boxes.length === 3, 'fitted');
  assert.deepEqual(prep.used, ['p1', 'p2', 'p3', 'p4']);

  // the person edits and saves; on the next load the saved boxes replace the translations, and no fit runs
  new Editor(doc, fonts).setText(0, 'b1', 1, 'Typed by hand');
  const st = parseState(JSON.parse(JSON.stringify(serialiseState(doc))));
  const again = detected();
  const prep2 = preparePage(new Editor(again, fonts), 0, pairs, st.pages[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(again.pages[0].boxes)), JSON.parse(JSON.stringify(doc.pages[0].boxes)));
  assert.equal(prep2.fit, null);
  assert.deepEqual(prep2.restored.sort(), ['b0', 'b1', 'b2']);
  assert.deepEqual(prep2.untranslated.map((u) => u.box), ['b3'], 'saved boxes are not listed');
});

test('the export report header: ASCII JSON, cut to its size limit', () => {
  const rep = {
    ok: true, verified: true, incremental: true, decrypted: false, encrypted: false, repaired: false, notes: [], bytesIn: 1000, bytesOut: 1500,
    growth: 0.5, growthPerEditedPage: 0.5, allPagesRender: true, ms: 1,
    fonts: [{ key: 'F1', face: 'NotoSans-Regular', font: 'NotoSans-Regular', glyphs: 20, bytes: 900, programBytes: 800, pages: [0] }],
    pages: [{ page: 0, written: [{ box: 'b0' }, { box: 'b1' }], skipped: [{ box: 'b9', reason: '縦書きの箱' }] }, { page: 1, written: [], skipped: [] }],
    failures: [],
  } as unknown as ExportReport;
  const r = hostReport(rep, [], 'abc123');
  assert.equal(r.written, 2);
  assert.deepEqual(r.pages, [0]);
  assert.deepEqual(r.skipped, [{ page: 0, box: 'b9', reason: '縦書きの箱' }]);
  const header = encodeReportHeader(r);
  assert.match(header, /^[\x20-\x7e]*$/, 'ASCII only');
  assert.deepEqual(JSON.parse(header), r);
  const big = { ...r, failures: Array.from({ length: 400 }, (_, i) => `page ${i + 1}: something long went wrong here ${'x'.repeat(80)}`) };
  const cut = encodeReportHeader(big, 4000);
  assert.ok(cut.length <= 4000, `${cut.length}`);
  assert.equal(JSON.parse(cut).truncated, true);
  assert.equal(JSON.parse(cut).written, 2);
});

test('substitutions: the catalogue face each document font of the edited runs is set in', async () => {
  const doc = detected();
  const ed = new Editor(doc, fonts);
  ed.setText(0, 'b0', 0, 'Latin text');
  const ok = await fonts.ensure(['Arimo-VF.ttf']);
  assert.ok(ok.has('Arimo-VF.ttf'), 'fonts/Arimo-VF.ttf (npm run fonts)');
  fonts.setSubstitute('ABCDEF+Synthetic-Gothic', 'latn', false, { id: 'cat:Arimo-VF.ttf@wght=400', family: 'Arimo', match: 'similar' });
  const rows = substitutionsOf(doc, fonts);
  assert.deepEqual(rows, [{ font: 'ABCDEF+Synthetic-Gothic', script: 'latn', bold: false, family: 'Arimo', face: 'cat:Arimo-VF.ttf@wght=400', match: 'similar' }]);
});
