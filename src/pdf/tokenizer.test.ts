import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineImageLength, isWhite, tokenize, type Token } from './tokenizer.ts';
import { latin1, text } from './testing.ts';

function roundTrip(input: Uint8Array): Token[] {
  const toks = tokenize(input);
  let pos = 0;
  const parts: Uint8Array[] = [];
  for (const t of toks) {
    assert.ok(t.start >= pos, `token at ${t.start} overlaps the previous one (ends ${pos})`);
    for (let i = pos; i < t.start; i++) assert.ok(isWhite(input[i]), `non-white byte ${input[i]} between tokens at ${i}`);
    parts.push(input.subarray(pos, t.start), input.subarray(t.start, t.end));
    pos = t.end;
  }
  for (let i = pos; i < input.length; i++) assert.ok(isWhite(input[i]));
  parts.push(input.subarray(pos));
  assert.deepEqual(Buffer.concat(parts), Buffer.from(input));
  return toks;
}

test('round trip: token bytes plus white gaps rebuild the input', () => {
  const s =
    '%PDF content\nq 1 0 0 1 72.5 -.25 cm BT/F1 12 Tf(Hello \\(world\\))Tj[(A)-120<0041 42>]TJ ET\r\n' +
    '/P <</MCID 3 /Alt (x) /K [1 2 /N#20x]>> BDC EMC true false null 4. +3 -.5 /Empty / <<>> [] () <> Q % end';
  const toks = roundTrip(latin1(s));
  assert.deepEqual(
    toks.filter((t) => t.type === 'op').map((t) => (t as { value: string }).value),
    ['q', 'cm', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BDC', 'EMC', 'Q'],
  );
  assert.equal(toks.filter((t) => t.type === 'comment').length, 2);
});

test('literal strings: escapes, nesting, octal, line continuation, EOL normalisation', () => {
  const cases: [string, number[] | string][] = [
    ['(a\\(b\\)c)', 'a(b)c'],
    ['(nested (paren) ok)', 'nested (paren) ok'],
    ['(\\101\\60\\0063)', [65, 48, 6, 51]],
    ['(\\777)', [255]],
    ['(\\n\\r\\t\\b\\f\\\\)', [10, 13, 9, 8, 12, 92]],
    ['(\\q)', 'q'],
    ['(line\\\ncont)', 'linecont'],
    ['(line\\\r\ncont)', 'linecont'],
    ['(a\r\nb\rc)', 'a\nb\nc'],
    ['(%not a comment)', '%not a comment'],
    ['((()))', '(())'],
  ];
  for (const [src, want] of cases) {
    const toks = roundTrip(latin1(src));
    assert.equal(toks.length, 1, src);
    const t = toks[0];
    assert.equal(t.type, 'string', src);
    const got = Array.from((t as { value: Uint8Array }).value);
    assert.deepEqual(got, typeof want === 'string' ? Array.from(latin1(want)) : want, src);
  }
});

test('hex strings, names, numbers, dicts', () => {
  const [h] = tokenize(latin1('<48 65 6C6c6>'));
  assert.equal(h.type, 'hex');
  assert.deepEqual(Array.from((h as { value: Uint8Array }).value), [0x48, 0x65, 0x6c, 0x6c, 0x60]);

  const names = tokenize(latin1('/A#20B /F1 /#2Fslash /'));
  assert.deepEqual(names.map((t) => (t as { value: string }).value), ['A B', 'F1', '/slash', '']);

  const nums = tokenize(latin1('1 -2 +3.5 .25 -.5 4. --6'));
  assert.deepEqual(nums.map((t) => (t as { value: number }).value), [1, -2, 3.5, 0.25, -0.5, 4, -6]);

  const [d] = tokenize(latin1('<< /A [1 2 <</B (x)>>] /C true /D null >>'));
  assert.equal(d.type, 'dict');
  const items = (d as { items: Token[] }).items;
  assert.equal(items.length, 6);
  assert.equal(items[1].type, 'array');
  assert.equal((items[1] as { items: Token[] }).items[2].type, 'dict');
  assert.equal(items[3].type, 'bool');
  assert.equal(items[5].type, 'null');
});

test('comments end at the line end and are tokens of their own', () => {
  const toks = roundTrip(latin1('1 0 0 RG % a comment (with a paren\n0 g'));
  assert.deepEqual(toks.map((t) => t.type), ['number', 'number', 'number', 'op', 'comment', 'number', 'op']);
});

test('inline image without a filter: length from W/H/BPC/CS, even with EI inside the data', () => {
  const data = [0x20, 0x45, 0x49, 0x20, 0x00, 0x45, 0x49, 0x0a, 0xff, 0x01, 0x02, 0x03];
  const pre = latin1('q BI /W 4 /H 1 /BPC 8 /CS /RGB ID ');
  const post = latin1(' EI Q');
  const bytes = new Uint8Array([...pre, ...data, ...post]);
  const toks = roundTrip(bytes);
  assert.deepEqual(toks.map((t) => t.type), ['op', 'inlineImage', 'op']);
  const img = toks[1] as Extract<Token, { type: 'inlineImage' }>;
  assert.equal(img.dataStart, pre.length);
  assert.equal(img.dataEnd, pre.length + data.length);
  assert.equal(text(bytes.subarray(img.end - 2, img.end)), 'EI');
  assert.equal(inlineImageLength(img.dict), 12);
});

test('inline image with a filter: an EI followed by binary is data, the real EI is found', () => {
  const data = latin1('\x01\x02 EI \xff\xfe\x80garbage\x00 EIx');
  const pre = latin1('BI /W 10 /H 10 /BPC 8 /CS /G /F /DCT ID\n');
  const post = latin1('\nEI\nBT /F1 12 Tf (after) Tj ET');
  const bytes = new Uint8Array([...pre, ...data, ...post]);
  const toks = roundTrip(bytes);
  const img = toks[0] as Extract<Token, { type: 'inlineImage' }>;
  assert.equal(img.type, 'inlineImage');
  assert.equal(img.dataStart, pre.length);
  assert.equal(img.dataEnd, pre.length + data.length);
  assert.deepEqual(
    toks.slice(1).filter((t) => t.type === 'op').map((t) => (t as { value: string }).value),
    ['BT', 'Tf', 'Tj', 'ET'],
  );
});

test('inline image at the very end of the stream', () => {
  const bytes = latin1('BI /W 1 /H 1 /BPC 8 /CS /G /F /AHx ID 00> EI');
  const toks = roundTrip(bytes);
  assert.equal(toks.length, 1);
  assert.equal(toks[0].end, bytes.length);
});
