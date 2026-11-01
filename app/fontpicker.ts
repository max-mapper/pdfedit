// The typography panel's font list: "Automatic" (the face matched to the document font),
// the matcher's suggestions for the run's document font, then every bundled catalogue family by class, regular and
// bold. Values are face ids the registry resolves: 'auto', a shipped id, or 'cat:<file>[@wght=…]'.
import { CATALOG, type Family, type FontFileSpec } from '../src/fonts/catalog.ts';
import { suggestSubstitutes } from '../src/fonts/substitute.ts';
import { catalogFaceId, parseCatalogFaceId } from '../src/model/fonts.ts';
import { catalogSource } from './assets.ts';

export type FaceOption = { value: string; label: string };
export type FaceGroup = { label: string; options: FaceOption[] };

const CLASS_LABEL: Record<string, string> = { sans: 'Sans serif', serif: 'Serif', mono: 'Monospace', rounded: 'Rounded', script: 'Script', display: 'Display' };
const available = (f: FontFileSpec) => catalogSource(f.file) !== null;

/** The face id for a family at a weight: a static file of that weight, or the variable file at it. */
export function faceAt(fam: Family, weight: number, italic = false): string | null {
  const files = fam.files.filter((f) => f.italic === italic && available(f));
  const fixed = files.find((f) => f.weight === weight);
  if (fixed) return catalogFaceId(fixed.file);
  const vf = files.find((f) => Array.isArray(f.weight) && weight >= f.weight[0] && weight <= f.weight[1]);
  if (vf) return catalogFaceId(vf.file, { wght: weight });
  const near = files.filter((f) => typeof f.weight === 'number').sort((a, b) => Math.abs((a.weight as number) - weight) - Math.abs((b.weight as number) - weight))[0];
  return near ? catalogFaceId(near.file) : null;
}

const byFile = new Map(CATALOG.flatMap((fam) => fam.files.map((f) => [f.file, fam] as const)));

/** A readable label for any face id the registry may report. */
export function catalogLabel(id: string): string | null {
  const c = parseCatalogFaceId(id);
  if (!c) return null;
  const fam = byFile.get(c.file);
  const spec = fam?.files.find((f) => f.file === c.file);
  const w = c.variations?.wght ?? (typeof spec?.weight === 'number' ? spec.weight : 400);
  const wl = w >= 700 ? 'Bold' : w >= 600 ? 'Semibold' : w >= 500 ? 'Medium' : w <= 300 ? 'Light' : w < 400 ? `${w}` : 'Regular';
  return `${fam?.name ?? c.file} ${wl}${spec?.italic ? ' Italic' : ''}`;
}

/** The groups for a run: suggestions for its document font first (when it has one), then the catalogue by class. */
export function faceGroups(docFont: string | undefined, run: { bold: boolean; italic: boolean; serif: boolean; cjk: boolean }): FaceGroup[] {
  const groups: FaceGroup[] = [];
  if (docFont) {
    const sugg = suggestSubstitutes({ name: docFont, script: run.cjk ? 'jpan' : 'latn', weight: run.bold ? 700 : 400,
      flags: (run.serif ? 2 : 0) | (run.italic ? 64 : 0) }, { limit: 6, available: (f) => catalogSource(f) !== null });
    if (sugg.length) groups.push({ label: `Suggested for ${docFont.replace(/^[A-Z]{6}\+/, '')}`, options: sugg.map((s) => ({
      value: catalogFaceId(s.file, s.variations),
      label: `${catalogLabel(catalogFaceId(s.file, s.variations))} · ${s.match === 'metric' ? 'same widths' : s.match === 'alias' ? 'named match' : 'similar'}`,
    })) });
  }
  const byClass = new Map<string, FaceOption[]>();
  for (const fam of CATALOG) {
    if (run.cjk && !fam.scripts.includes('jpan')) continue;
    for (const w of [400, 700]) {
      const id = faceAt(fam, w);
      if (!id) continue;
      const list = byClass.get(fam.classification) ?? [];
      if (!list.some((o) => o.value === id)) list.push({ value: id, label: catalogLabel(id)! });
      byClass.set(fam.classification, list);
    }
  }
  for (const [cls, options] of byClass) groups.push({ label: CLASS_LABEL[cls] ?? cls, options });
  return groups;
}
