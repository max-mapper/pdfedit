// Synthetic tests for the font matcher: font names only (no documents), plus the catalog's own font files when
// scripts/fetch-fonts.ts has fetched them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { CATALOG, FAMILIES, catalogFiles, sourceUrl } from './catalog.ts';
import {
  ALIASES, decodeFontName, describeSource, nearestWeight, panoseFromStyle, parseFontName, readSfntInfo, suggestSubstitutes,
  weightFromStemV, type SourceFontInfo,
} from './substitute.ts';

const top = (info: SourceFontInfo, opts = {}) => {
  const s = suggestSubstitutes(info, opts);
  assert.ok(s.length > 0, `no suggestion for ${String(info.name)}`);
  return s[0];
};
const FONTS = new URL('../../fonts/', import.meta.url);
const onDisk = (file: string) => existsSync(new URL(file, FONTS));

test('names: subset prefix, CMap suffix and style suffix are stripped; weights are read', () => {
  const k = parseFontName('ABCDEF+KozGoPr6N-Medium');
  assert.equal(k.base, 'KozGoPr6N-Medium');
  assert.equal(k.weight, 500);
  assert.equal(parseFontName('KozMinPr6N-Regular-Identity-H').base, 'KozMinPr6N-Regular');
  const r = parseFontName('Ryumin-Light-83pv-RKSJ-H');
  assert.equal(r.base, 'Ryumin-Light');
  assert.equal(r.weight, 300);
  assert.equal(parseFontName('MS-Mincho').base, 'MS-Mincho');           // 'Mincho' is not a CMap
  const t = parseFontName('TimesNewRomanPS-BoldItalicMT');
  assert.equal(t.weight, 700);
  assert.equal(t.italic, true);
  assert.equal(parseFontName('Arial,Bold').weight, 700);
  assert.equal(parseFontName('Arial,BoldItalic').italic, true);
  assert.equal(parseFontName('ArialMT').weight, undefined);
});

test('names: Japanese weight systems (W numbers, weight letter codes, HG suffixes, Midashi grades)', () => {
  assert.equal(parseFontName('HiraKakuProN-W3').weight, 350);
  assert.equal(parseFontName('HiraKakuStd-W8').weight, 800);
  assert.equal(parseFontName('ShinGoProW6').weight, 600);
  assert.equal(parseFontName('RodinPro-DB').weight, 600);
  assert.equal(parseFontName('FOTRodinProDB').weight, 600);
  assert.equal(parseFontName('MidashiGoPr6N-MB31').weight, 700);
  assert.equal(parseFontName('GothicMB101Pro-DeBold').weight, 600);
  assert.equal(parseFontName('ShinGoPr6N-Ultra').weight, 900);
  assert.equal(parseFontName('HGｺﾞｼｯｸE').weight, 800);                 // half-width katakana, NFKC-folded
  assert.equal(parseFontName('HGｺﾞｼｯｸM').weight, 400);                 // HG 'M' is the regular weight
  assert.equal(parseFontName('HGP創英角ｺﾞｼｯｸUB').weight, 900);
  assert.equal(parseFontName('YuGothic-Medium').weight, 500);
  assert.equal(parseFontName('YuGothicUI-Semibold').weight, 600);
  assert.equal(parseFontName('Meiryo-Bold').weight, 700);
  assert.equal(parseFontName('GothicBBBPro-Medium').weight, 500);      // 'BBB' inside a name is not a weight
});

test('names: widths and slants', () => {
  assert.equal(parseFontName('HelveticaNeue-CondensedBold').width, 75);
  assert.equal(parseFontName('ArialNarrow-Bold').width, 82);
  assert.equal(parseFontName('FooSans-SemiCondensed').width, 87.5);
  assert.equal(parseFontName('MinionPro-It').italic, true);
  assert.equal(parseFontName('Calibri-BoldItalic').italic, true);
  assert.equal(parseFontName('Calibri-Bold').italic, false);
});

test('names: Shift_JIS BaseFont bytes and #xx escapes decode to Japanese', () => {
  // ＭＳ ゴシック in Shift_JIS, as a PDF name with #xx escapes
  assert.equal(decodeFontName('#82l#82r#20#83S#83V#83b#83N'), 'ＭＳ ゴシック');
  assert.equal(decodeFontName(new Uint8Array([0x83, 0x81, 0x83, 0x43, 0x83, 0x8a, 0x83, 0x49])), 'メイリオ');
  assert.equal(decodeFontName('ArialMT'), 'ArialMT');
  assert.equal(decodeFontName(new TextEncoder().encode('游ゴシック')), '游ゴシック');
  assert.equal(describeSource({ name: '#82l#82r#20#83S#83V#83b#83N' }).recognised, 'MS Gothic');
});

test('Kozuka Gothic Pr6N Medium → Noto Sans JP at wght 500, for Latin and for Japanese text', () => {
  for (const script of ['latn', 'jpan'] as const) {
    const s = top({ name: 'ABCDEF+KozGoPr6N-Medium', script });
    assert.equal(s.family, 'noto-sans-jp');
    assert.equal(s.weight, 500);
    assert.deepEqual(s.variations, { wght: 500 });
    assert.equal(s.match, 'alias');
  }
  assert.equal(top({ name: 'KozMinPr6N-Bold' }).family, 'noto-serif-jp');
});

test('ArialMT → Arimo (metric-compatible), regular', () => {
  const s = top({ name: 'ArialMT' });
  assert.equal(s.family, 'arimo');
  assert.equal(s.match, 'metric');
  assert.equal(s.weight, 400);
  assert.equal(s.file, 'Arimo-VF.ttf');
  assert.equal(top({ name: 'Arial-BoldItalicMT' }).file, 'Arimo-Italic-VF.ttf');
  assert.equal(top({ name: 'Helvetica-Bold' }).family, 'arimo');
});

test('TimesNewRomanPS-BoldMT → Tinos Bold; the italic face when the name says italic', () => {
  const s = top({ name: 'TimesNewRomanPS-BoldMT' });
  assert.equal(s.family, 'tinos');
  assert.equal(s.file, 'Tinos-Bold.ttf');
  assert.equal(s.weight, 700);
  assert.equal(s.match, 'metric');
  const i = top({ name: 'TimesNewRomanPS-BoldItalicMT' });
  assert.equal(i.file, 'Tinos-BoldItalic.ttf');
  assert.equal(i.italic, true);
  assert.equal(i.synthesizeItalic, false);
});

test('Meiryo-Bold → Noto Sans JP 700', () => {
  for (const script of ['latn', 'jpan'] as const) {
    const s = top({ name: 'Meiryo-Bold', script });
    assert.equal(s.family, 'noto-sans-jp');
    assert.equal(s.weight, 700);
  }
});

test('MS-Mincho → BIZ UDMincho for Japanese (fixed pitch kept), BIZ UDPMincho for Latin text', () => {
  const j = top({ name: 'MS-Mincho', script: 'jpan' });
  assert.equal(j.family, 'biz-udmincho');
  assert.equal(j.weight, 400);
  const l = top({ name: 'MS-Mincho', script: 'latn' });
  assert.equal(l.family, 'biz-udpmincho');
  assert.equal(FAMILIES.get(l.family)!.classification, 'serif');
  assert.equal(top({ name: 'MS-PGothic', script: 'jpan' }).family, 'biz-udpgothic');
  assert.equal(top({ name: 'MS-Gothic,Bold', script: 'jpan' }).file, 'BIZUDGothic-Bold.ttf');
  assert.equal(top({ name: '#82l#82r#20#83S#83V#83b#83N', script: 'jpan' }).family, 'biz-udgothic');
});

test('Shin Go, Hiragino, Yu and HG names map to the right class and weight', () => {
  const h = top({ name: 'HiraKakuProN-W6', script: 'jpan' });
  assert.equal(h.family, 'noto-sans-jp');
  assert.equal(h.weight, 600);
  const m = top({ name: 'ABCDEF+MidashiGoPr6N-MB31', script: 'jpan' });
  assert.equal(m.family, 'noto-sans-jp');
  assert.equal(m.weight, 700);
  assert.equal(top({ name: 'MidashiMinPr6N-MA31', script: 'jpan' }).family, 'noto-serif-jp');
  assert.equal(top({ name: 'UDShinGoPr6N-Regular', script: 'jpan' }).family, 'biz-udpgothic');
  assert.equal(top({ name: 'RyuminPr6N-Light', script: 'jpan' }).family, 'noto-serif-jp');
  assert.equal(top({ name: 'YuMincho-Demibold', script: 'jpan' }).family, 'noto-serif-jp');
  assert.equal(top({ name: 'YuGothic-Bold', script: 'jpan' }).weight, 700);
  assert.equal(top({ name: 'Jun501Pro-Bold', script: 'jpan' }).family, 'zen-maru-gothic');
  const hg = top({ name: 'HGP創英角ｺﾞｼｯｸUB', script: 'jpan' });
  assert.equal(hg.family, 'noto-sans-jp');
  assert.equal(hg.weight, 900);
  assert.equal(FAMILIES.get(top({ name: 'HG正楷書体-PRO', script: 'jpan' }).family)!.classification, 'script');
});

test('Office fonts: Calibri → Carlito, Cambria → Caladea, Segoe UI → Selawik, Georgia → Gelasio, Arial Narrow', () => {
  assert.equal(top({ name: 'Calibri-Bold' }).file, 'Carlito-Bold.ttf');
  assert.equal(top({ name: 'Cambria' }).family, 'caladea');
  const seg = top({ name: 'SegoeUI-Semibold' });
  assert.equal(seg.family, 'selawik');
  assert.equal(seg.weight, 600);
  assert.equal(top({ name: 'Georgia-Italic' }).file, 'Gelasio-Italic-VF.ttf');
  const n = top({ name: 'ArialNarrow-Bold' });
  assert.equal(n.family, 'noto-sans', 'Arial Narrow takes the narrowed Noto Sans');
  assert.equal(top({ name: 'CourierNewPSMT' }).family, 'cousine');
});

test('unknown names fall back on the descriptor: serif flag, weight, fixed pitch, italic angle', () => {
  const serif = top({ name: 'ABCDEF+Quuxface-Bold', flags: 2 | 32 });
  assert.equal(FAMILIES.get(serif.family)!.classification, 'serif');
  assert.equal(serif.weight, 700);
  const mono = top({ name: 'ABCDEF+Zzz', flags: 1 | 32 });
  assert.equal(FAMILIES.get(mono.family)!.classification, 'mono');
  const it = describeSource({ name: 'ABCDEF+Zzz', italicAngle: -12 });
  assert.equal(it.italic, true);
  assert.equal(describeSource({ name: 'Zzz', weight: 700 }).weight, 700);
  assert.equal(describeSource({ name: 'Zzz', stemV: 140 }).weight, 700);
  assert.equal(describeSource({ name: 'Zzz', flags: 32 | (1 << 18) }).weight, 700);
  assert.equal(describeSource({ name: 'Zzz', os2: { weightClass: 300, widthClass: 3 } }).width, 75);
  const jp = top({ name: 'XYZFoundry-Gothic-W3', script: 'jpan' });
  assert.equal(FAMILIES.get(jp.family)!.classification, 'sans');
  assert.ok(FAMILIES.get(jp.family)!.scripts.includes('jpan'));
});

test('a condensed source steers a wdth axis', () => {
  const s = top({ name: 'ABCDEF+Grotesk-Condensed' });
  assert.equal(FAMILIES.get(s.family)!.classification, 'sans');
  assert.ok(s.width < 100, `width ${s.width}`);
  if (s.variations) assert.equal(s.variations.wdth, s.width);
});

test('measured glyph widths pick the narrower instance', { skip: !FAMILIES.get('noto-sans')!.metrics }, () => {
  const m = FAMILIES.get('noto-sans')!.metrics!;
  const order = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const widths: Record<string, number> = {};
  for (const ch of 'adehinorstu') widths[ch] = m.widths[order.indexOf(ch)] * 0.8;
  const s = suggestSubstitutes({ name: 'ABCDEF+Unknownsans', widths }).find((x) => x.family === 'noto-sans')!;
  assert.ok(s.width < 95 && s.width >= 62.5, `wdth ${s.width}`);
});

test('symbol fonts get no text substitute; availability and tier filters apply', () => {
  assert.deepEqual(suggestSubstitutes({ name: 'ABCDEF+Wingdings-Regular' }), []);
  assert.deepEqual(suggestSubstitutes({ name: 'Symbol' }), []);
  const s = top({ name: 'ArialMT' }, { available: new Set(['NotoSans-VF.ttf', 'NotoSans-Italic-VF.ttf']) });
  assert.equal(s.family, 'noto-sans');
  const core = suggestSubstitutes({ name: 'YuGothic-Medium', script: 'jpan' }, { tiers: ['core'] });
  assert.ok(core.every((x) => FAMILIES.get(x.family)!.tier === 'core'));
  assert.ok(suggestSubstitutes({ name: 'ArialMT' }, { limit: 2 }).length === 2);
  const jp = suggestSubstitutes({ name: 'ArialMT', script: 'jpan' });
  assert.ok(jp.every((x) => FAMILIES.get(x.family)!.scripts.includes('jpan')));
});

test('suggestions are distinct families with scores in (0, 1], best first', () => {
  const s = suggestSubstitutes({ name: 'KozGoPr6N-Regular', script: 'jpan' }, { limit: 8 });
  assert.equal(new Set(s.map((x) => x.family)).size, s.length);
  for (let i = 1; i < s.length; i++) assert.ok(s[i - 1].score >= s[i].score);
  for (const x of s) assert.ok(x.score > 0 && x.score <= 1);
});

test('CSS weight matching', () => {
  const statics: [number, number][] = [[400, 400], [700, 700]];
  assert.equal(nearestWeight(statics, 500), 400);
  assert.equal(nearestWeight(statics, 600), 700);
  assert.equal(nearestWeight(statics, 300), 400);
  assert.equal(nearestWeight(statics, 900), 700);
  assert.equal(nearestWeight([[100, 900]], 350), 350);
  assert.equal(nearestWeight([[400, 700]], 900), 700);
  assert.equal(weightFromStemV(80), 400);
});

test('PANOSE from a descriptor /Style string', () => {
  assert.deepEqual(panoseFromStyle([8, 1, 2, 11, 6, 9, 7, 2, 5, 8, 2, 4]), [2, 11, 6, 9, 7, 2, 5, 8, 2, 4]);
  // MS Gothic's PANOSE: sans (11), monospaced (9)
  const d = describeSource({ name: 'ABCDEF+Unrecognised', panose: [2, 11, 6, 9, 7, 2, 5, 8, 2, 4] });
  assert.equal(d.classification, 'mono');
  assert.equal(describeSource({ name: 'Unrecognised', panose: [2, 2, 6, 3, 5, 4, 5, 2, 3, 4] }).classification, 'serif');
});

test('the catalog: every alias names catalog families; files are unique TrueType; licences allow embedding', () => {
  for (const a of ALIASES) for (const id of [...a.latn, ...(a.jpan ?? [])]) assert.ok(FAMILIES.has(id), `${a.label}: ${id}`);
  const files = catalogFiles();
  assert.equal(new Set(files).size, files.length);
  for (const f of files) assert.match(f, /\.ttf$/);
  for (const f of CATALOG) {
    assert.ok(['OFL-1.1', 'Apache-2.0'].includes(f.licence));
    assert.ok(f.scripts.includes('latn'));
    assert.ok(f.files.some((x) => !x.italic), `${f.id} has an upright face`);
    if (f.proportional) assert.equal(FAMILIES.get(f.proportional)?.pitch, 'proportional');
    for (const x of f.files) assert.match(sourceUrl(x.src), /^https:\/\//);
  }
  assert.match(sourceUrl({ kind: 'google', path: 'ofl/arimo/Arimo[wght].ttf' }), /Arimo%5Bwght%5D\.ttf$/);
});

test('fetched files match their pinned sums and read as TrueType', { skip: !onDisk('Arimo-VF.ttf') }, async () => {
  const { createHash } = await import('node:crypto');
  for (const f of CATALOG) for (const x of f.files) {
    if (!onDisk(x.file) || !x.sha256) continue;
    const b = readFileSync(new URL(x.file, FONTS));
    assert.equal(createHash('sha256').update(b).digest('hex'), x.sha256, x.file);
  }
  const info = readSfntInfo(new Uint8Array(readFileSync(new URL('Arimo-VF.ttf', FONTS))))!;
  assert.equal(info.upem, 2048);
  assert.equal(info.os2?.weightClass, 400);
  assert.equal(info.fixedPitch, false);
  assert.equal(readSfntInfo(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), null);
  // the embedded program's tables feed the describer: Cousine is fixed pitch
  const c = readSfntInfo(new Uint8Array(readFileSync(new URL('Cousine-Regular.ttf', FONTS))))!;
  assert.equal(describeSource({ name: 'ABCDEF+Unrecognised', ...c }).fixed, true);
});
