// layoutSourceLines (keep source lines) on synthetic source geometry: unchanged lines stay where the source drew them;
// an edit reflows from its line only; a deletion pulls nothing up; a deliberate break and a broken word's hyphen stay.
// Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testFaces } from './testkit.ts';
import { layoutSourceLines, type SourceParaIn, type SourceLine } from './layout.ts';
import { mapText } from './textdiff.ts';

const SIZE = 10, ADV = 5, SPACE = 2.5;

/** Source geometry for `text` broken at `starts`: every character 5 pt wide, a space 2.5 pt, lines from x = 10. */
function source(text: string, starts: number[], o: Partial<SourceParaIn> = {}): SourceParaIn {
  const x: (number | null)[] = [], adv: (number | null)[] = [], end: number[] = [];
  for (let k = 0; k < starts.length; k++) {
    const e = k + 1 < starts.length ? starts[k + 1] : text.length;
    let pen = 10;
    for (let i = starts[k]; i < e; i++) {
      const a = text[i] === ' ' ? SPACE : ADV;
      x.push(pen); adv.push(a);
      pen += a;
    }
    let last = e - 1;
    while (last > starts[k] && text[last] === ' ') last--;
    end.push((x[last] ?? 10) + ADV);
  }
  return { text, starts, x, adv, end, hard: starts.map(() => false), hyphen: starts.map(() => null), align: 'left',
    measure: 100, justifyTo: 100, firstLeft: 10, left: 10, center: 50, rightEdge: 100, tol: 1, ...o };
}

async function lay(text: string, src: SourceParaIn): Promise<SourceLine[]> {
  const { sans } = await testFaces();
  const r = layoutSourceLines({ runs: [{ text, face: sans, size: SIZE }], align: src.align, leading: 1.2 }, src);
  assert.ok(r, 'laid out on the source lines');
  return r.lines;
}

const xs = (L: SourceLine) => L.runs.flatMap((r) => r.glyphs.filter((g) => (g.c ?? -1) >= 0).map((g) => [g.c!, g.x]));
const textOf = (P: string, L: SourceLine) => P.slice(L.start, L.end);

const TEXT = 'alpha bravo charlie delta echo foxtrot';
const STARTS = [0, 12, 26];          // 'alpha bravo ' | 'charlie delta ' | 'echo foxtrot'

test('unchanged text: the source breaks and every glyph at its source x, even where the measure would fit more', async () => {
  const src = source(TEXT, STARTS, { measure: 1000 });
  const lines = await lay(TEXT, src);
  assert.deepEqual(lines.map((l) => l.start), STARTS);
  assert.ok(lines.every((l) => l.kept));
  for (const L of lines) for (const [c, x] of xs(L)) assert.ok(Math.abs(x - src.x[c]!) < 1e-9, `glyph ${c} at ${x}, source ${src.x[c]}`);
});

test('an insertion reflows from its own line: the lines before it are kept, glyph for glyph', async () => {
  const src = source(TEXT, STARTS, { measure: 80 });
  const before = await lay(TEXT, src);
  const P = TEXT.replace('charlie', 'charlie kilo lima');
  const after = await lay(P, src);
  assert.ok(after[0].kept);
  assert.deepEqual(xs(after[0]), xs(before[0]));
  assert.equal(after[1].kept, false);
  assert.ok(after.every((l) => l.width <= 80 + 1e-6 || l.kept), 'reflowed lines stay in the measure');
  assert.equal(after.map((l) => textOf(P, l)).join(''), P);
});

test('a deletion pulls nothing up: the shorter line ends where the source line did, the next lines are kept', async () => {
  const src = source(TEXT, STARTS, { measure: 80 });
  const P = TEXT.replace('bravo ', '');
  const lines = await lay(P, src);
  assert.equal(lines.length, 3);
  assert.equal(textOf(P, lines[0]), 'alpha ');
  assert.ok(lines[1].kept && lines[2].kept);
  const ref = await lay(TEXT, src);
  // same positions, offsets moved by the deletion
  assert.deepEqual(xs(lines[1]).map(([c, x]) => [c + 6, x]), xs(ref[1]));
});

test('a deliberate break (a source line ending well short) stays when the text before it reflows', async () => {
  const text = 'alpha bravo charlie delta echo foxtrot golf';
  const starts = [0, 12, 20, 31];    // 'alpha bravo ' | 'charlie ' (short: hard) | 'delta echo ' | 'foxtrot golf'
  const src = source(text, starts, { measure: 80 });
  src.hard[1] = true;
  const P = text.replace('alpha', 'alpha kilo lima mike');
  const lines = await lay(P, src);
  const breakAt = P.indexOf('delta');
  assert.ok(lines.some((l) => l.start === breakAt), `a line starts at the deliberate break: ${JSON.stringify(lines.map((l) => textOf(P, l)))}`);
  assert.ok(lines.some((l) => l.kept && textOf(P, l) === 'foxtrot golf'), 'the lines after it are the source\'s');
});

test('a word the source broke across lines keeps its hyphen, at the source hyphen\'s x', async () => {
  const text = 'an example here';
  const src = source(text, [0, 7]);   // 'an exam' | 'ple here' (the source drew 'exam-')
  src.hyphen[0] = 50;
  const lines = await lay(text, src);
  assert.deepEqual(lines.map((l) => l.start), [0, 7]);
  const hy = lines[0].runs.flatMap((r) => r.glyphs).at(-1)!;
  assert.equal(hy.text, '-');
  assert.equal(hy.c, -1);
  assert.equal(hy.x, 50);
  assert.equal(lines[0].hyphen, true);
});

test('a new paragraph cut from a source line (Enter): its first line is the rest of that line, then the source lines', async () => {
  const src = source(TEXT, STARTS, { measure: 80 });
  const P = TEXT.slice(TEXT.indexOf('delta'));    // 'delta echo foxtrot'
  const lines = await lay(P, src);
  assert.equal(textOf(P, lines[0]), 'delta ');
  assert.ok(lines[1].kept && textOf(P, lines[1]) === 'echo foxtrot');
});

test('too little of the text is the source\'s: no source layout (the caller flows it)', async () => {
  const { sans } = await testFaces();
  const src = source(TEXT, STARTS);
  assert.equal(layoutSourceLines({ runs: [{ text: 'november oscar papa quebec romeo', face: sans, size: SIZE }] }, src), null);
});

test('mapText: one local edit maps everything around it; separate edits keep the text between them', () => {
  const m = mapText('alpha bravo charlie delta', 'alpha brave charlie delta echo');
  assert.equal(m.n2o[0], 0);
  assert.equal(m.n2o['alpha brave '.length], 'alpha bravo '.length);
  const m2 = mapText('one two three four five six', 'one twoo three four fiv six');
  assert.equal(m2.n2o['one twoo '.length], 'one two '.length);    // 'three' between the two edits
  assert.equal(m2.n2o['one twoo three four fiv '.length], 'one two three four five '.length);
});
