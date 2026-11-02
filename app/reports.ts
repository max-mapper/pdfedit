// The export report, rendered as DOM (no innerHTML with model text: box text and reasons are set as text).
import type { ExportReport } from '../src/export/export.ts';

type Child = Node | string | null | undefined | false;
export function h(tag: string, attrs: Record<string, string> = {}, ...kids: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The export report: what was written, what was skipped and why, and the verification. */
export function exportReportView(report: ExportReport | null, error: string | null): HTMLElement {
  const root = h('div', { class: 'report' });
  if (!report) { root.append(h('p', { class: 'banner bad' }, `Export failed: ${error ?? 'unknown error'}`)); return root; }
  const written = report.pages.reduce((n, p) => n + p.written.length, 0);
  const skipped = report.pages.flatMap((p) => p.skipped.map((s) => ({ ...s, page: p.page })));
  root.append(h('p', { class: report.ok ? 'banner ok' : 'banner bad' },
    report.ok ? `Exported and verified: ${plural(written, 'box', 'boxes')} written on ${plural(report.pages.length, 'page')}.`
      : `Export ${report.verified ? 'failed verification' : 'failed'}: ${plural(report.failures.length, 'problem')}.`));
  if (report.failures.length) {
    const ul = h('ul', { class: 'failures' });
    for (const f of report.failures) ul.append(h('li', {}, f));
    root.append(h('h4', {}, 'Problems'), ul);
  }
  const facts = h('dl', { class: 'facts' });
  const fact = (k: string, v: string) => facts.append(h('dt', {}, k), h('dd', {}, v));
  fact('Save', report.incremental ? 'incremental (the original bytes are kept as a prefix)' : 'full rewrite');
  fact('Verification', report.verified ? (report.ok ? 'passed' : 'failed') : 'not run');
  fact('All pages render', report.allPagesRender === null ? '–' : report.allPagesRender ? 'yes' : 'no');
  fact('Size', `${kb(report.bytesIn)} → ${kb(report.bytesOut)} (+${(report.growth * 100).toFixed(1)}%)`);
  if (report.fonts.length) fact('Fonts', report.fonts.map((f) => `${f.face} (${f.glyphs} glyphs)`).join(', '));
  fact('Time', `${report.ms} ms`);
  root.append(facts);
  for (const n of report.notes) root.append(h('p', { class: 'muted' }, n));
  for (const p of report.pages) {
    const sec = h('div', { class: 'rep-page' }, h('h4', {}, `Page ${p.page + 1}`));
    const v = p.verify;
    sec.append(h('p', {}, `${plural(p.written.length, 'box', 'boxes')} written, ${p.skipped.length} skipped, ` +
      `${plural(p.operatorsBlanked, 'operator')} blanked` + (p.operatorsSplit ? `, ${p.operatorsSplit} split` : '') + '.'));
    if (v) {
      const okText = v.text.filter((t) => t.newPresent).length;
      const oldGone = v.text.filter((t) => t.oldAbsent === true).length;
      sec.append(h('p', { class: v.ok ? 'ok-text' : 'bad-text' },
        `Verification: new text found in ${okText} of ${v.text.length}, old text gone in ${oldGone}; ` +
        `${v.pixelsChangedOutside} of ${v.pixelsCompared} pixels changed outside the edited boxes.`));
      const bad = v.text.filter((t) => !t.newPresent || t.oldAbsent === false);
      if (bad.length) {
        const ul = h('ul', { class: 'failures' });
        for (const t of bad) ul.append(h('li', {}, `${t.box}: ${!t.newPresent ? 'new text not found' : ''}${!t.newPresent && t.oldAbsent === false ? '; ' : ''}${t.oldAbsent === false ? 'old text still there' : ''}`));
        sec.append(ul);
      }
    }
    const sk = skipped.filter((s) => s.page === p.page);
    if (sk.length) {
      const ul = h('ul', { class: 'skipped' });
      for (const s of sk) ul.append(h('li', {}, h('button', { class: 'link bad', 'data-page': String(s.page), 'data-box': s.box }, s.box), ` skipped: ${s.reason}`));
      sec.append(h('p', {}, 'Skipped:'), ul);
    }
    root.append(sec);
  }
  return root;
}

const kb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`);
