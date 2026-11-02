// What an embedded editor tells its host about an export (docs/EMBED.md, the X-Pdfedit-Report header): a compact
// summary of the export report, the font substitutions the edited text is set in, and whether verification passed.
// The header is JSON in ASCII (other characters as \u escapes, as HTTP header values must be ISO-8859-1), kept under
// a size limit by cutting the lists (then `truncated` is true). `shortened` lists the paragraphs that hold a shortened
// text (src/embed/shorten.ts) by place, segment and length: no text. Pure: no I/O.
import type { ExportReport } from '../export/export.ts';
import type { SubstitutionRow } from '../fonts/apply.ts';
import { hasCjk, parseCatalogFaceId, type FontRegistry } from '../model/fonts.ts';
import type { Doc } from '../model/types.ts';
import type { Shortened } from './shorten.ts';

export type ReportShortened = {
  page: number; box: string; para: number; seg_id: string | null;
  chars_before: number; chars_after: number; max_chars: number; reason: 'unfit' | 'shrunk';
};

export type HostReport = {
  ok: boolean;                 // nothing failed, verification included
  verified: boolean;
  engine?: string;             // the pdfedit build
  written: number;             // boxes written
  pages: number[];             // 0-based pages with boxes written
  skipped: { page: number; box: string; reason: string }[];
  fonts: { face: string; font: string; glyphs: number; bytes: number }[];
  substitutions: SubstitutionRow[];
  shortened: ReportShortened[]; // paragraphs that hold a shortened text
  failures: string[];
  bytesIn: number;
  bytesOut: number;
  truncated?: boolean;
};

const chars = (s: string) => [...s].length;

export function hostReport(report: ExportReport, substitutions: SubstitutionRow[], engine?: string, shortened: Shortened[] = []): HostReport {
  return {
    ok: report.ok, verified: report.verified, ...(engine ? { engine } : {}),
    written: report.pages.reduce((k, p) => k + p.written.length, 0),
    pages: report.pages.filter((p) => p.written.length).map((p) => p.page),
    skipped: report.pages.flatMap((p) => p.skipped.map((s) => ({ page: p.page, box: s.box, reason: s.reason }))),
    fonts: report.fonts.map((f) => ({ face: f.face, font: f.font, glyphs: f.glyphs, bytes: f.bytes })),
    substitutions,
    shortened: shortened.map((x) => ({ page: x.page, box: x.box, para: x.para, seg_id: x.seg_id, chars_before: chars(x.before), chars_after: chars(x.after), max_chars: x.max_chars, reason: x.reason })),
    failures: report.failures, bytesIn: report.bytesIn, bytesOut: report.bytesOut,
  };
}

const ascii = (s: string) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** The header value: ASCII JSON of at most `max` characters (lists cut to fit, `truncated: true`). */
export function encodeReportHeader(r: HostReport, max = 6000): string {
  let out = ascii(JSON.stringify(r));
  for (let keep = 64; out.length > max && keep >= 0; keep = keep ? keep >> 1 : -1) {
    const cut: HostReport = { ...r, truncated: true, skipped: r.skipped.slice(0, keep), fonts: r.fonts.slice(0, keep),
      substitutions: r.substitutions.slice(0, keep), shortened: r.shortened.slice(0, keep * 2), failures: r.failures.slice(0, keep).map((f) => f.slice(0, 200)), pages: r.pages.slice(0, keep * 4) };
    out = ascii(JSON.stringify(cut));
  }
  return out;
}

/** The catalogue faces the edited runs are set in instead of their document fonts (one row per font, script and
 *  weight), as the registry resolves them. A face the person picked is not a substitution. */
export function substitutionsOf(doc: Doc, fonts: FontRegistry): SubstitutionRow[] {
  const rows = new Map<string, SubstitutionRow>();
  for (const page of doc.pages) for (const b of page?.boxes ?? []) {
    if (!b.edited) continue;
    for (const p of b.paragraphs) for (const r of p.runs) {
      const docFont = r.font.source === 'document' ? r.font.name : r.font.from;
      if (!docFont || !r.text.trim()) continue;
      const script = hasCjk(r.text) ? 'jpan' : 'latn';
      const key = `${docFont}\u0000${script}\u0000${r.bold}`;
      if (rows.has(key)) continue;
      const c = fonts.substituteFor(docFont, script, r.bold);
      if (!c || !parseCatalogFaceId(c.id) || fonts.resolve(r).font.name !== c.id) continue;
      rows.set(key, { font: docFont, script, bold: r.bold, family: c.family, face: c.id, match: c.match as SubstitutionRow['match'] });
    }
  }
  return [...rows.values()];
}
