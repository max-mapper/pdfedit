// A page made ready with links (src/embed/page.ts): links from the matcher, segment text as the translation, stored
// links verified, segment text winning over a saved box (frame and styles kept), a shortened paragraph kept while its
// segment still has the text it was shortened from; and the shortening pass (src/embed/shorten.ts): which paragraphs,
// their budgets, the page put back before the fit and the shorter text in. Synthetic boxes and text only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadFonts, type FontRegistry } from '../model/fonts.ts';
import { Editor } from '../model/edit.ts';
import { box, para } from '../model/testkit.ts';
import type { Doc } from '../model/types.ts';
import type { FitReport } from '../fit/fit.ts';
import { createMatcher, type Pair } from './match.ts';
import { preparePage } from './page.ts';
import { parseState, serialiseState } from './state.ts';
import { applyShortened, shortenFactor, shortenItems, snapshotPage, shortenedActive } from './shorten.ts';

let fonts: FontRegistry;
before(async () => { fonts = await loadFonts(); });

function detected(): Doc {
  return { pages: [{
    n: 0, w: 595, h: 842, panels: [], obstacles: [], pictures: [],
    boxes: [
      box('b0', { x0: 60, x1: 300, y0: 760, y1: 780 }, [para('見出しの文')]),
      box('b1', { x0: 60, x1: 300, y0: 680, y1: 740 }, [para('一文目です。二文目です。三文目です。')]),
      box('b2', { x0: 60, x1: 300, y0: 600, y1: 640 }, [para('対応のない段落')]),
    ],
  }] };
}
const PAIRS: Pair[] = [
  { id: 'g1', source: '見出しの文', target: 'Pair heading' },
  { id: 'g2', source: '一文目です。', target: 'One.' }, { id: 'g3', source: '二文目です。', target: 'Two.' }, { id: 'g4', source: '三文目です。', target: 'Three.' },
];
const SEGS: Record<string, string> = { g1: 'Segment heading', g2: 'First.', g3: 'Second.', g4: 'Third.' };
const text = (d: Doc, id: string) => d.pages[0].boxes.find((b) => b.id === id)!.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));

test('links from the matcher; linked paragraphs show their segments\' text, a run of segments joined', () => {
  const doc = detected();
  const prep = preparePage(new Editor(doc, fonts), 0, createMatcher(PAIRS), null, { links: { stored: null, text: (id) => SEGS[id] ?? null } });
  assert.deepEqual(prep.links.map((l) => [l.box, l.para, l.seg_ids, l.ok]), [['b0', 0, ['g1'], true], ['b1', 0, ['g2', 'g3', 'g4'], true]]);
  assert.deepEqual(text(doc, 'b0'), ['Segment heading'], 'the segment\'s text, not the pair\'s');
  assert.deepEqual(text(doc, 'b1'), ['First. Second. Third.']);
  assert.deepEqual(prep.untranslated.map((u) => u.box), ['b2']);
  assert.deepEqual(prep.translatedParas.sort(), ['b0#0', 'b1#0']);
  assert.equal(prep.slots.length, 3);
});

test('stored links are verified; a link that does not hold leaves the paragraph to the matcher', () => {
  const first = preparePage(new Editor(detected(), fonts), 0, createMatcher(PAIRS), null, { links: { stored: null, text: (id) => SEGS[id] ?? null } });
  const stored = first.links.map(({ page, box: b, para: p, seg_ids, src_sha }) => ({ page, box: b, para: p, seg_ids, src_sha }));
  stored[0] = { ...stored[0], src_sha: 'another' };
  const doc = detected();
  const prep = preparePage(new Editor(doc, fonts), 0, createMatcher(PAIRS), null, { links: { stored, text: (id) => SEGS[id] ?? null } });
  assert.deepEqual(prep.links.map((l) => [l.box, l.ok, l.why_not]), [['b0', false, 'source_changed'], ['b1', true, null]]);
  assert.deepEqual(text(doc, 'b0'), ['Pair heading'], 'unmapped: the pair\'s translation');
});

test('segment text wins over a saved box: its frame and styles stay; a shortened text stays while its segment is unchanged', () => {
  const links = { stored: null, text: (id: string) => SEGS[id] ?? null };
  const doc = detected();
  preparePage(new Editor(doc, fonts), 0, createMatcher(PAIRS), null, { links, fit: false });
  const ed = new Editor(doc, fonts);
  ed.setFrame(0, 'b0', { x0: 80, x1: 320, y0: 750, y1: 790 }, { pinHeight: true });
  ed.setStyle(0, 'b0', null, { color: [1, 0, 0] });
  ed.setText(0, 'b1', 0, 'Short.');
  const shortened = [{ page: 0, box: 'b1', para: 0, seg_id: null, before: 'First. Second. Third.', after: 'Short.', max_chars: 10, reason: 'unfit' as const }];
  const st = parseState(JSON.parse(JSON.stringify(serialiseState(doc, { shortened }))));
  assert.deepEqual(st.pages[0].shortened, [{ box: 'b1', para: 0, seg_id: null, before: 'First. Second. Third.', after: 'Short.', max_chars: 10, reason: 'unfit' }]);

  // the heading's segment changed elsewhere; the run's segments did not
  const changed: Record<string, string> = { ...SEGS, g1: 'Heading changed elsewhere' };
  const again = detected();
  const prep = preparePage(new Editor(again, fonts), 0, createMatcher(PAIRS), st.pages[0], { links: { stored: null, text: (id) => changed[id] ?? null } });
  const b0 = again.pages[0].boxes.find((b) => b.id === 'b0')!;
  assert.deepEqual(text(again, 'b0'), ['Heading changed elsewhere']);
  assert.deepEqual(b0.frame, { x0: 80, x1: 320, y0: 750, y1: 790 }, 'the saved frame');
  assert.deepEqual(b0.paragraphs[0].runs[0].color, [1, 0, 0], 'the saved style');
  assert.deepEqual(text(again, 'b1'), ['Short.'], 'still shortened');
  assert.deepEqual(prep.shortened.map((s) => [s.box, s.after]), [['b1', 'Short.']]);
  assert.equal(prep.fit, null);

  // once a segment of the run changes, the shortened text goes and the segments' text comes back
  const moved: Record<string, string> = { ...changed, g3: 'Second, edited.' };
  const third = detected();
  const prep3 = preparePage(new Editor(third, fonts), 0, createMatcher(PAIRS), st.pages[0], { links: { stored: null, text: (id) => moved[id] ?? null } });
  assert.deepEqual(text(third, 'b1'), ['First. Second, edited. Third.']);
  assert.deepEqual(prep3.shortened, []);
});

test('shortening: the paragraphs of unfit or shrunk boxes get budgets; shorter answers go in on the page as before the fit', () => {
  const doc = detected();
  const ed = new Editor(doc, fonts);
  ed.setText(0, 'b1', 0, 'A long translated paragraph that does not fit in its box at a readable size at all.');
  ed.setText(0, 'b0', 0, 'Heading that fits');
  const snap = snapshotPage(doc.pages[0]);
  ed.setFrame(0, 'b1', { x0: 60, x1: 400, y0: 600, y1: 740 });   // what a fit might have done
  const fit = { page: 0, pictures: [], ms: 0, boxes: [
    { box: 'b0', result: 'fits', scale: 1, charsOver: 0 }, { box: 'b1', result: 'unfit', scale: 0.7, charsOver: 30 },
  ] } as unknown as FitReport;
  const items = shortenItems(0, snap, fit, { translated: new Set(['b0#0', 'b1#0']), source: () => '原文', segment: (b) => (b === 'b1' ? 'g9' : null) });
  assert.equal(items.length, 1);
  const len = 'A long translated paragraph that does not fit in its box at a readable size at all.'.length;
  assert.equal(items[0].max_chars, Math.max(8, Math.floor(len * shortenFactor('unfit', 0.7, len, 30))));
  assert.ok(items[0].max_chars >= Math.floor(len * 0.5) && items[0].max_chars < len);
  assert.equal(items[0].seg_id, 'g9');
  assert.equal(shortenItems(0, snap, fit, { translated: new Set(['b0#0']), source: () => '原文', segment: () => null }).length, 0, 'only translated paragraphs');

  assert.deepEqual(applyShortened(ed, 0, snap, items, [items[0].english]), [], 'an answer that is not shorter changes nothing');
  assert.deepEqual(doc.pages[0].boxes[1].frame, { x0: 60, x1: 400, y0: 600, y1: 740 });
  const done = applyShortened(ed, 0, snap, items, [{ text: 'Shorter text.' }]);
  assert.deepEqual(done.map((d) => [d.box, d.after, d.seg_id]), [['b1', 'Shorter text.', 'g9']]);
  assert.deepEqual(doc.pages[0].boxes[1].frame, { x0: 60, x1: 300, y0: 680, y1: 740 }, 'back to the frame before the fit');
  assert.ok(shortenedActive(done[0], doc.pages[0]));
  ed.setText(0, 'b1', 0, done[0].before);
  assert.ok(!shortenedActive(done[0], doc.pages[0]), 'Use faithful');
});
