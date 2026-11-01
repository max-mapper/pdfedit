// Shaping with HarfBuzz. Text is split into script runs (Latin vs CJK; Common characters such as spaces, digits
// and punctuation join the surrounding run), each run is shaped separately with its script, language and LTR
// direction, and the glyphs come back in logical order with clusters as UTF-16 indices into the whole text.

import type { Feature as HbFeature } from 'harfbuzzjs';
import { hb } from './hb.ts';
import type { Face } from './face.ts';
import { cjkScript, scriptClass } from './unicode.ts';

/** Font units. `cluster` is the UTF-16 index of the first character of the glyph's cluster in `text`. */
export type Glyph = { gid: number; cluster: number; ax: number; ay: number; dx: number; dy: number };

export type ScriptRun = { start: number; end: number; script: string; language: string };

/** Split text into runs of one script class. Common characters attach to the preceding run, or to the following
 *  one at the start of the text. */
export function scriptRuns(text: string): ScriptRun[] {
  type Raw = { start: number; end: number; cls: 'latin' | 'cjk' | 'common'; first: number };
  const raws: Raw[] = [];
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    const cls = scriptClass(cp);
    const last = raws[raws.length - 1];
    if (last && (cls === 'common' || last.cls === cls)) {
      last.end = i + n;
    } else if (last && last.cls === 'common') {
      last.cls = cls; // leading Common text takes the first strong script
      last.first = cp;
      last.end = i + n;
    } else {
      raws.push({ start: i, end: i + n, cls, first: cp });
    }
    i += n;
  }
  return raws.map((r) =>
    r.cls === 'cjk'
      ? { start: r.start, end: r.end, script: cjkScript(r.first), language: 'ja' }
      : { start: r.start, end: r.end, script: 'Latn', language: 'en' },
  );
}

/** `direction: 'ttb'` shapes for vertical text: HarfBuzz applies the font's `vert` substitutions and returns vertical
 *  advances (ay, negative: down) and offsets from its own vertical origin (dx = -h_advance/2, dy = -origin y). */
export function shape(face: Face, text: string, opts: { features?: string[]; direction?: 'ltr' | 'ttb' } = {}): Glyph[] {
  const HB = hb();
  const features: HbFeature[] = [];
  for (const f of opts.features ?? []) {
    const parsed = HB.Feature.fromString(f);
    if (!parsed) throw new Error(`shape: bad feature string '${f}'`);
    features.push(parsed);
  }
  const out: Glyph[] = [];
  for (const run of scriptRuns(text)) {
    const buf = new HB.Buffer();
    buf.addText(text, run.start, run.end - run.start);
    buf.setDirection(opts.direction === 'ttb' ? HB.Direction.TTB : HB.Direction.LTR);
    buf.setScript(run.script);
    buf.setLanguage(run.language);
    HB.shape(face.hbFont, buf, features);
    for (const g of buf.getGlyphInfosAndPositions()) {
      out.push({
        gid: g.codepoint,
        cluster: g.cluster,
        ax: g.xAdvance ?? 0,
        ay: g.yAdvance ?? 0,
        dx: g.xOffset ?? 0,
        dy: g.yOffset ?? 0,
      });
    }
  }
  return out;
}
