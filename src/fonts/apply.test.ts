// prepareSubstitutes on a synthetic model: edited runs in a document font get the matched catalogue face.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadFonts, parseCatalogFaceId } from '../model/fonts.ts';
import { prepareSubstitutes } from './apply.ts';
import type { Box, Doc, Run } from '../model/types.ts';

const run = (text: string, name: string, bold = false, serif = false): Run => ({
  text, size: 10, color: [0, 0, 0], charSpacing: 0, bold, italic: false, underline: false,
  font: { source: 'shipped', name: bold ? 'NotoSans-Bold' : 'NotoSans-Regular', bold, italic: false, serif, from: name },
});
const box = (id: string, runs: Run[]): Box => ({
  id, kind: 'text', frame: { x0: 0, y0: 0, x1: 100, y1: 20 }, rot: 0, vertical: false, edited: true, locked: null, heightPinned: false,
  paragraphs: [{ runs, align: 'left', leading: 1.2, spaceBefore: 0, spaceAfter: 0, indent: 0, bullet: null }],
  source: { frame: { x0: 0, y0: 0, x1: 100, y1: 20 }, lines: 1, paragraphs: [], objs: [], chars: [], panel: null, neighbours: [] },
});

test('edited runs in Times and Arial are set in their metric-compatible faces; the layout resolves them', { skip: !existsSync(new URL('../../fonts/Tinos-Bold.ttf', import.meta.url)) && !existsSync(new URL('../../fonts/Tinos[wght].ttf', import.meta.url)) ? 'catalogue fonts not fetched' : false }, async () => {
  const fonts = await loadFonts();
  const doc: Doc = { pages: [{ n: 0, w: 600, h: 800, panels: [], obstacles: [], boxes: [
    box('a', [run('Annual report', 'ABCDEF+TimesNewRomanPS-BoldMT', true, true)]),
    box('b', [run('Net sales rose', 'ArialMT')]),
  ] }] };
  const rows = await prepareSubstitutes(doc, fonts);
  const fam = Object.fromEntries(rows.map((r) => [r.font, r.family]));
  assert.equal(fam['ABCDEF+TimesNewRomanPS-BoldMT'], 'tinos');
  assert.equal(fam['ArialMT'], 'arimo');
  const r = fonts.resolve(doc.pages[0].boxes[1].paragraphs[0].runs[0]);
  assert.ok(parseCatalogFaceId(r.font.name), r.font.name);
  assert.match(r.font.name, /Arimo/);
  assert.equal(r.font.from, 'ArialMT');
});
