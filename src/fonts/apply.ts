// Font substitution applied to a document: for every document font that edited text is
// set in, the best catalogue face the registry can load, per script (Latin or Japanese text) and weight. Runs in
// that font are then laid out (and exported) in it instead of the generic Noto face. Local only: names, descriptor
// flags and weights go into the matcher; no text or font data leaves the machine.
import type { Doc } from '../model/types.ts';
import { catalogFaceId, hasCjk, parseCatalogFaceId, type FontRegistry } from '../model/fonts.ts';
import { suggestSubstitutes, type Suggestion } from './substitute.ts';

export type SubstitutionRow = { font: string; script: 'latn' | 'jpan'; bold: boolean; family: string; face: string; match: Suggestion['match'] };

/** Chooses and loads a substitute for each (document font, script, weight) the edited runs need. Returns what it chose. */
/** `all`: every box's fonts (not only edited ones), for Latin and Japanese text and both weights, so an editor can
 *  resolve any run however it is edited (the editor app runs this on each page as it arrives, and its worker before
 *  export: the choice depends only on the font name and the available files, so both make the same one). */
export async function prepareSubstitutes(doc: Doc, fonts: FontRegistry, opts: { pages?: number[]; limit?: number; all?: boolean } = {}): Promise<SubstitutionRow[]> {
  type Need = { font: string; script: 'latn' | 'jpan'; bold: boolean; italic: boolean; serif: boolean };
  const needs = new Map<string, Need>();
  const pages = opts.pages ? opts.pages.map((i) => doc.pages[i]).filter(Boolean) : doc.pages;
  for (const page of pages) for (const b of page.boxes) {
    if (!b.edited && !opts.all) continue;
    for (const p of b.paragraphs) for (const r of p.runs) {
      const name = r.font.source === 'document' ? r.font.name : r.font.from;
      if (!name || (!opts.all && !r.text.trim())) continue;
      const combos: ['latn' | 'jpan', boolean][] = opts.all ? [['latn', false], ['latn', true], ['jpan', false], ['jpan', true]] : [[hasCjk(r.text) ? 'jpan' : 'latn', r.bold]];
      for (const [script, bold] of combos) {
        const key = `${name}\u0000${script}\u0000${bold}`;
        if (!needs.has(key) && !fonts.substituteFor(name, script, bold)) needs.set(key, { font: name, script, bold, italic: r.italic, serif: r.font.serif });
      }
    }
  }
  // faces the user picked from the catalogue: loaded too, so a worker lays them out (and exports them) as drawn
  const picked = new Set<string>();
  for (const page of pages) for (const b of page.boxes) for (const p of b.paragraphs) for (const r of p.runs) {
    const c = r.font.source === 'shipped' ? parseCatalogFaceId(r.font.name) : null;
    if (c) picked.add(c.file);
  }
  if (picked.size) await fonts.ensure([...picked]);
  const rows: SubstitutionRow[] = [];
  for (const n of needs.values()) {
    const sugg = suggestSubstitutes({
      name: n.font, script: n.script, weight: n.bold ? 700 : 400,
      flags: (n.serif ? 2 : 0) | (n.italic ? 64 : 0) | (n.bold ? 1 << 18 : 0),
    }, { limit: opts.limit ?? 5 });
    // the best suggestion whose file the registry can load (fonts/ in Node, the app's own files in a browser)
    const ok = await fonts.ensure(sugg.map((s) => s.file));
    const best = sugg.find((s) => ok.has(s.file));
    if (!best) continue;
    const id = catalogFaceId(best.file, best.variations);
    fonts.setSubstitute(n.font, n.script, n.bold, { id, family: best.family, match: best.match });
    rows.push({ font: n.font, script: n.script, bold: n.bold, family: best.family, face: id, match: best.match });
  }
  return rows;
}
