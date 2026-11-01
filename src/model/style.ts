// Run styles: which run's style new text takes (src/model/edit.ts setText) and when two runs look the same. No
// dependencies, so the layout and the editor can use it without pulling in detection.
import type { Run } from './types.ts';

/** The run whose style covers the most characters (whitespace not counted): what new text is set in. A first run
 *  that ends in a separator (a "title:" lead-in) is not counted when other runs have text. */
export function dominantRun(runs: Run[]): Run | undefined {
  const n = new Map<string, { run: Run; k: number }>();
  const skipLead = runs.length >= 2 && LEAD_END.test(runs[0].text) && runs.slice(1).some((r) => r.text.trim());
  for (const r of skipLead ? runs.slice(1) : runs) {
    const key = styleKeyOf(r);
    const e = n.get(key) ?? { run: r, k: 0 };
    e.k += [...r.text].filter((ch) => !/\s/u.test(ch)).length;
    n.set(key, e);
  }
  let best: { run: Run; k: number } | undefined;
  for (const e of n.values()) if (!best || e.k > best.k) best = e;
  return best?.run;
}

/** A lead-in's end: a colon, or a spaced dash, then spaces. */
export const LEAD_END = /(?:[:：]|\s[–—-])\s*$/u;

/** Two runs look the same (font, size, colour, weight, slant). */
export function styleKeyOf(r: Pick<Run, 'font' | 'size' | 'color' | 'bold' | 'italic'>): string {
  return `${r.font.source}|${r.font.name}|${r.size}|${r.color.join(',')}|${r.bold ? 1 : 0}${r.italic ? 1 : 0}`;
}
