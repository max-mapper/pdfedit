// One page of an embedded document made ready: its paragraphs translated from the host's pairs (src/embed/match.ts)
// through the Editor, the saved version's boxes put back over them (src/embed/state.ts), then fitted. The fit runs
// only when the page has translated boxes the saved state does not cover: saved boxes come back as saved.
//
// With links (opts.links, src/embed/links.ts), every paragraph's source is hashed; stored links are checked against
// those hashes, or, when the host has none yet, the links are the matcher's. A paragraph linked to segments shows the
// segments' current text: on a fresh page it is the translation, and on a saved box it replaces the saved text (the
// saved box keeps its frame and styles; runs keep their styles where the text is the same). A saved paragraph that
// holds a shortened text keeps it while its segment still has the text it was shortened from.
import type { Editor } from '../model/edit.ts';
import type { FitReport } from '../fit/fit.ts';
import type { Paragraph } from '../model/types.ts';
import { joinTargets, normalise, type Matcher } from './match.ts';
import { applyPageState, type PageState } from './state.ts';
import { computeLinks, paraKey, sha256Hex, verifyLinks, type Link, type ParaLink, type Slot } from './links.ts';
import { snapshotPage, type PageSnapshot, type Shortened } from './shorten.ts';

export type Untranslated = { page: number; box: string; para: number; text: string };

export type PagePrep = {
  page: number;
  /** Paragraphs with letters on editable boxes (what could be translated). */
  paragraphs: number;
  /** Boxes that took a translation (and are still on the page after the state). */
  translated: string[];
  /** Boxes put back from the saved state. */
  restored: string[];
  /** Paragraphs with letters and no translation, on boxes the state does not cover. */
  untranslated: Untranslated[];
  /** Pair ids used on this page. */
  used: string[];
  fit: FitReport | null;
  /** The detected paragraphs that could be translated: source text, its hash, the pairs the matcher took. */
  slots: Slot[];
  /** Box ids as detected. */
  detected: string[];
  /** The page's links: stored ones verified, or the matcher's (none without opts.links). */
  links: ParaLink[];
  /** Paragraphs that took a translation on this load (paraKey). */
  translatedParas: string[];
  /** Shortened paragraphs of the saved state still in effect. */
  shortened: Shortened[];
  /** The page before its fit (opts.keepBeforeFit and a fit ran), for a shortening pass. */
  beforeFit: PageSnapshot | null;
};

export type PageLinks = {
  /** The stored links of this page, or null: the host has none yet and the matcher's are taken. */
  stored: Link[] | null;
  /** A segment's current target text, or null when the editor does not know the segment. */
  text(segId: string): string | null;
};

export type PrepareOptions = {
  /** Vertical boxes: translate them (set sideways or upright by the layout), or leave them. Default 'translate'. */
  vertical?: 'translate' | 'skip';
  /** Fit pages with translated boxes, default true (needs an Editor with fonts). */
  fit?: boolean;
  /** Links on: the page's paragraphs are linked to segments and show their text. */
  links?: PageLinks;
  /** Keep the page as it was before the fit (PagePrep.beforeFit). */
  keepBeforeFit?: boolean;
};

const LETTER = /\p{L}/u;
const textOf = (runs: { text: string }[]) => runs.map((r) => r.text).join('');
const paraTextOf = (p: Paragraph) => textOf(p.runs);

/** A segment's text for a paragraph with a bullet: the bullet it repeats at its start dropped (the layout draws the
 *  paragraph's own). */
export function withoutBullet(text: string, bullet: string | null | undefined): string {
  if (!bullet) return text;
  const t = text.replace(/^[\s　]+/u, '');
  return t.startsWith(bullet) && /^[\s　]/u.test(t.slice(bullet.length)) ? t.slice(bullet.length).replace(/^[\s　]+/u, '') : text;
}

export function preparePage(editor: Editor, n: number, matcher: Matcher, state: PageState | null, opts: PrepareOptions = {}): PagePrep {
  const page = editor.page(n);
  const detected = page.boxes.map((b) => b.id);
  const slots: Slot[] = [];
  for (const b of page.boxes) {
    if (b.locked || (b.vertical && opts.vertical === 'skip')) continue;
    b.paragraphs.forEach((p, k) => {
      const text = textOf(p.runs);
      const norm = normalise(text);
      if (LETTER.test(norm)) slots.push({ box: b.id, para: k, text, src_sha: sha256Hex(norm), seg_ids: null });
    });
  }
  const m = matcher.match(slots.map((s) => s.text));
  slots.forEach((s, k) => { s.seg_ids = m.ids[k]; });

  const L = opts.links;
  const links: ParaLink[] = !L ? [] : L.stored
    ? verifyLinks(L.stored, slots, detected)
    : computeLinks(n, slots).map((l) => ({ ...l, ok: true, why_not: null }));
  const linked = new Map(links.filter((l) => l.ok).map((l) => [paraKey(l.box, l.para), l]));
  /** The linked segments' text for a paragraph (joined for a run), or undefined when a segment is unknown. */
  const segText = (ids: string[]): string | undefined => {
    if (!L) return undefined;
    const t = ids.map((id) => L.text(id));
    if (t.some((x) => x === null)) return undefined;
    return ids.length === 1 ? t[0]! : joinTargets(t as string[]);
  };

  const translated = new Set<string>();
  const translatedParas: string[] = [];
  const untranslatedSlots: Slot[] = [];
  slots.forEach((s, k) => {
    const l = linked.get(paraKey(s.box, s.para));
    const fromSeg = l ? segText(l.seg_ids) : undefined;
    const t = fromSeg !== undefined ? (fromSeg.trim() ? fromSeg : null) : m.translations[k];
    if (t === null) { untranslatedSlots.push(s); return; }
    if (normalise(t) === normalise(s.text)) return;
    editor.setText(n, s.box, s.para, t);
    translated.add(s.box);
    translatedParas.push(paraKey(s.box, s.para));
  });

  const restored = state ? state.boxes.map((b) => b.id) : [];
  if (state) applyPageState(editor.doc, state);
  const covered = new Set(restored);
  const boxes = new Map(editor.page(n).boxes.map((b) => [b.id, b]));
  // a link whose box the saved state merged away, or whose paragraph it does not have, no longer holds
  for (const l of links) {
    const b = boxes.get(l.box);
    if (l.ok && (!b || l.para >= b.paragraphs.length)) { l.ok = false; l.why_not = 'box_missing'; linked.delete(paraKey(l.box, l.para)); }
  }

  // saved paragraphs: a shortened text stays while its segment has the text it was shortened from; otherwise the
  // segments' current text replaces the saved text
  const shortened: Shortened[] = [];
  const kept = new Set<string>();
  for (const sh of state?.shortened ?? []) {
    const p = boxes.get(sh.box)?.paragraphs[sh.para];
    if (!p || paraTextOf(p) !== sh.after) continue;
    const l = linked.get(paraKey(sh.box, sh.para));
    const want = l ? segText(l.seg_ids) : undefined;
    if (want !== undefined && normalise(want) !== normalise(sh.before)) continue;
    shortened.push({ ...sh, page: n });
    kept.add(paraKey(sh.box, sh.para));
  }
  if (state) {
    for (const l of linked.values()) {
      if (!covered.has(l.box) || kept.has(paraKey(l.box, l.para))) continue;
      const want = segText(l.seg_ids);
      if (want === undefined || !want.trim()) continue;
      const b = boxes.get(l.box)!;
      const now = paraTextOf(b.paragraphs[l.para]);
      if (normalise(now) === normalise(want)) continue;
      const texts = b.paragraphs.map(paraTextOf);
      texts[l.para] = withoutBullet(want, b.paragraphs[l.para].bullet);
      editor.editText(n, l.box, texts);
    }
  }

  const onPage = new Set(editor.page(n).boxes.map((b) => b.id));
  const fresh = [...translated].filter((id) => onPage.has(id) && !covered.has(id));
  const fitting = fresh.length > 0 && opts.fit !== false;
  const beforeFit = fitting && opts.keepBeforeFit ? snapshotPage(editor.page(n)) : null;
  const fit = fitting ? editor.fitPage(n) : null;
  return {
    page: n,
    paragraphs: slots.length,
    translated: [...translated].filter((id) => onPage.has(id)),
    restored,
    untranslated: untranslatedSlots.filter((s) => !covered.has(s.box) && onPage.has(s.box))
      .map((s) => ({ page: n, box: s.box, para: s.para, text: s.text })),
    used: m.used,
    fit,
    slots,
    detected,
    links,
    translatedParas,
    shortened,
    beforeFit,
  };
}
