import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FontInfo } from './fonts.ts';
import { openForEdit } from './edit.ts';
import { parseOps, textShows, type TextShow } from './ops.ts';
import { blankOutDetailed, fmtNum, showDisplacement } from './surgery.ts';
import { hasNoto, hasPdftotext, latin1, makePdf, pdfWords, text } from './testing.ts';

const fixedWidth = (w: number, extra: Partial<FontInfo> = {}): FontInfo => ({
  type: 'Type1', baseFont: 'Synth', codeBytes: 1, width: () => w, vertical: false, ...extra,
});

/** Bytes outside the replaced ranges are identical, and each replacement moves the pen exactly as the original. */
function checkSurgery(src: Uint8Array, shows: TextShow[], fonts: (n: string) => FontInfo) {
  const { bytes, replacements } = blankOutDetailed(src, shows, fonts);
  let a = 0;
  let b = 0;
  for (const r of replacements) {
    assert.deepEqual(Buffer.from(bytes.subarray(b, r.newStart)), Buffer.from(src.subarray(a, r.start)));
    a = r.end;
    b = r.newEnd;
  }
  assert.deepEqual(Buffer.from(bytes.subarray(b)), Buffer.from(src.subarray(a)));

  // Re-read the result: the replacement TJ has the same state, so its displacement must equal the original's.
  const after = textShows(parseOps(bytes));
  for (const s of shows) {
    const r = replacements.find((x) => x.n === s.n)!;
    const rep = after.find((x) => x.start >= r.newStart && x.end <= r.newEnd);
    const want = showDisplacement(src, s, fonts(s.font));
    if (!rep) {
      assert.ok(s.fontSize * s.hScale === 0, `no replacement TJ for show #${s.n}`);
      continue;
    }
    assert.equal(rep.op, 'TJ');
    assert.equal(rep.strings.length, 0, 'the replacement shows no glyphs');
    const got = showDisplacement(bytes, rep, fonts(rep.font));
    assert.ok(Math.abs(got.tx - want.tx) < 1e-5 && Math.abs(got.ty - want.ty) < 1e-5, `#${s.n}: ${JSON.stringify({ got, want })}`);
  }
  return { bytes, replacements };
}

test('displacement by hand: Helvetica "Hello" with Tc, Tw, Tz', async () => {
  const e = await openForEdit(await makePdf({ content: () => 'BT ET', type0: false }));
  const helv = e.fontInfo(0, 'F1');
  const src = latin1('BT /F1 12 Tf 1 Tc 2 Tw 50 Tz (Hello) Tj (a b) Tj [(He) -250 (llo)] TJ ET');
  const shows = textShows(parseOps(src));
  const d = shows.map((s) => showDisplacement(src, s, helv).tx);
  const hello = (2278 / 1000) * 12 + 5 * 1; // H e l l o = 722 556 222 222 556
  assert.ok(Math.abs(d[0] - hello * 0.5) < 1e-9);
  assert.ok(Math.abs(d[1] - ((556 + 278 + 556) / 1000 * 12 + 3 * 1 + 2) * 0.5) < 1e-9); // Tw once for the space
  assert.ok(Math.abs(d[2] - (hello + (250 / 1000) * 12) * 0.5) < 1e-9);
  checkSurgery(src, shows, () => helv);
});

test('blankOut: Tj, TJ, \' and " with the exact text written', () => {
  const src = latin1('BT/F1 10 Tf 2 Tc 50 Tz 14 TL(ab)Tj[(a)-500(b)]TJ(c)\' 3 1(d)"(keep)Tj ET');
  const shows = textShows(parseOps(src)).slice(0, 4);
  const { bytes, replacements } = checkSurgery(src, shows, () => fixedWidth(500));
  // Tc 2, Th 0.5, w 500, Tfs 10: each glyph moves (5 + 2)·0.5 = 3.5; k = −tx·1000/(Tfs·Th) = −tx·200
  assert.deepEqual(replacements.map((r) => r.text.trim()), [
    '[-1400] TJ', // ab: 7
    '[-1900] TJ', // a −500 b: 3.5 + 2.5 + 3.5 = 9.5
    'T* [-700] TJ', // c: 3.5
    '3 Tw 1 Tc T* [-600] TJ', // " sets Tw 3, Tc 1: (5 + 1)·0.5 = 3
  ]);
  assert.match(text(bytes), /\(keep\)Tj ET$/);
});

test('blankOut keeps tokens apart and handles Tfs = 0', () => {
  const src = latin1('BT/F1 0 Tf 1 0 0 1 5 5 Tm(x)Tj(y)\' ET');
  const shows = textShows(parseOps(src));
  const { bytes } = checkSurgery(src, shows, () => fixedWidth(500));
  assert.equal(text(bytes), 'BT/F1 0 Tf 1 0 0 1 5 5 Tm T* ET');
});

test('blankOut: Type0 codes are 2 bytes and Tw does not apply', () => {
  const widths: Record<number, number> = { 0x20: 260, 0x41: 600 };
  const t0: FontInfo = { type: 'Type0', baseFont: 'Synth', codeBytes: 2, width: (c) => widths[c] ?? 1000, vertical: false };
  const src = latin1('BT /F2 20 Tf 5 Tw 1 Tc <00410020 0041> Tj [<0041> 100 <0020>] TJ ET');
  const shows = textShows(parseOps(src));
  const d = showDisplacement(src, shows[0], t0).tx;
  assert.ok(Math.abs(d - ((600 + 260 + 600) / 1000 * 20 + 3)) < 1e-9);
  checkSurgery(src, shows, () => t0);
});

test('vertical fonts: displacement on ty from w1; no vertical metrics is refused; codeBytes 0 is refused', () => {
  const v: FontInfo = { type: 'Type0', baseFont: 'Synth', codeBytes: 2, width: () => 1000, vertical: true, vwidth: () => -1000 };
  const src = latin1('BT /V 10 Tf 1 Tc 50 Tz <00010002> Tj [<0003> -200 <0004>] TJ ET');
  const shows = textShows(parseOps(src));
  assert.deepEqual(showDisplacement(src, shows[0], v), { tx: 0, ty: 2 * (-10 + 1) });
  assert.deepEqual(showDisplacement(src, shows[1], v), { tx: 0, ty: 2 * (-10 + 1) + 2 });
  const { replacements } = checkSurgery(src, shows, () => v);
  assert.equal(replacements[0].text, '[1800] TJ'); // ty = −18 → k = −ty·1000/Tfs
  assert.throws(() => blankOutDetailed(src, shows, () => ({ ...v, vwidth: undefined })), /vertical/);
  assert.throws(() => blankOutDetailed(src, shows, () => ({ ...v, codeBytes: 0 })), /cannot be blanked/);
});

test('fmtNum writes plain decimals', () => {
  assert.deepEqual([fmtNum(-1400), fmtNum(0.1 + 0.2), fmtNum(-0.0000001), fmtNum(1e-7), fmtNum(123456789.5)], [
    '-1400', '0.3', '0', '0', '123456789.5',
  ]);
});

// Independent check through poppler: blank the first show of each line and verify that the marker word after it
// keeps its exact position (and that the T* of ' and " still moves to the next line).
const lines = (f: string, s: (t: string) => string) =>
  [
    `BT /${f} 12 Tf 14 TL 0.7 Tc 3 Tw 90 Tz 50 700 Td ${s('Hello World ')} Tj ${s('MARKA')} Tj ET`,
    `BT /${f} 12 Tf 50 650 Td [${s('Hel')} -250 ${s('lo Wo')} 120 ${s('rld ')}] TJ ${s('MARKB')} Tj ET`,
    `BT /${f} 11 Tf 16 TL 1 Tc 50 600 Td ${s('first ')} Tj ${s('Quote line ')} ' ${s('MARKC')} Tj ET`,
    `BT /${f} 10 Tf 16 TL 50 540 Td ${s('second ')} Tj 4 1.5 ${s('Dquote line ')} " ${s('MARKD')} Tj ET`,
  ].join('\n');

for (const kind of ['simple', 'type0'] as const) {
  test(`poppler sees the markers where they were (${kind} font)`, { skip: !hasPdftotext || (kind === 'type0' && !hasNoto) }, async () => {
    const f = kind === 'simple' ? 'F1' : 'F2';
    const pdf = await makePdf({
      content: (fx) => lines(f, kind === 'simple' ? (t) => `(${t})` : (t) => fx.hex(t)),
      type0: kind === 'type0',
    });
    const e = await openForEdit(pdf);
    const src = e.contents(0);
    const shows = textShows(parseOps(src));
    assert.equal(shows.length, 10);
    const victims = [0, 2, 5, 8].map((i) => shows[i]); // Hello World, the TJ, Quote line ', Dquote line "
    const { bytes } = checkSurgery(src, victims, (n) => e.fontInfo(0, n));
    e.setContents(0, bytes);
    const out = e.save();

    const before = pdfWords(pdf, `${kind}-before.pdf`);
    const after = pdfWords(out, `${kind}-after.pdf`);
    const at = (ws: typeof before, w: string) => {
      const m = ws.filter((x) => x.word === w);
      assert.equal(m.length, 1, `${w} in ${JSON.stringify(ws.map((x) => x.word))}`);
      return m[0];
    };
    for (const m of ['MARKA', 'MARKB', 'MARKC', 'MARKD']) {
      const a = at(before, m);
      const b = at(after, m);
      assert.ok(Math.abs(a.xMin - b.xMin) < 0.01 && Math.abs(a.yMin - b.yMin) < 0.01, `${m}: ${JSON.stringify({ a, b })}`);
    }
    const words = after.map((w) => w.word);
    for (const gone of ['Hello', 'World', 'Hel', 'Quote', 'Dquote', 'line']) assert.ok(!words.includes(gone), `${gone} still there`);
    for (const kept of ['first', 'second']) assert.ok(words.includes(kept), `${kept} missing`);
  });
}
