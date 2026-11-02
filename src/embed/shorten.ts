// Targeted shortening in embed mode (docs/EMBED.md, "Shortening"): after a page's fit, the translated paragraphs of
// every box that ended unfit or under 80% of its size get a character budget, the host shortens them, and the page is
// fitted again with the shorter text. The budget follows src/pipeline.ts: the share of the text that fitted at the
// scale reached, then the area ratio from that scale up to a readable size (0.85 unfit, 0.9 shrunk), never under half
// the length nor over 0.95 of it. A shortened text is layout only: the host's segments keep the faithful text, and the
// editor never writes a shortened text back. Pure: no I/O.
import type { Editor } from '../model/edit.ts';
import type { FitReport } from '../fit/fit.ts';
import type { Page, Paragraph, PictureMove, Rect } from '../model/types.ts';
import { paraKey } from './links.ts';

/** What the host is asked to shorten (POST <api>/shorten items, plus where it is). */
export type ShortenItem = {
  page: number; box: string; para: number;
  seg_id: string | null; source: string; english: string; max_chars: number; reason: 'unfit' | 'shrunk';
};
/** A paragraph whose text was shortened. `before` is the faithful text, `after` the paragraph's text now. */
export type Shortened = {
  page: number; box: string; para: number;
  seg_id: string | null; before: string; after: string; max_chars: number; reason: 'unfit' | 'shrunk';
};
/** A page's boxes and pictures before its fit, to fit again from. */
export type PageSnapshot = {
  boxes: { id: string; frame: Rect; paragraphs: Paragraph[]; heightPinned: boolean }[];
  pictures: { id: string; move?: PictureMove }[];
};

export const SHORTEN_BELOW = 0.8;
export const MIN_SHORTEN_CHARS = 12;
const textOf = (p: Paragraph) => p.runs.map((r) => r.text).join('');
const chars = (s: string) => [...s].length;

export function snapshotPage(page: Page): PageSnapshot {
  return {
    boxes: page.boxes.map((b) => structuredClone({ id: b.id, frame: b.frame, paragraphs: b.paragraphs, heightPinned: b.heightPinned })),
    pictures: (page.pictures ?? []).map((p) => ({ id: p.id, ...(p.move ? { move: { ...p.move } } : {}) })),
  };
}

function restorePage(page: Page, snap: PageSnapshot): void {
  for (const s of snap.boxes) {
    const b = page.boxes.find((x) => x.id === s.id);
    if (b) { b.frame = { ...s.frame }; b.paragraphs = structuredClone(s.paragraphs); b.heightPinned = s.heightPinned; }
  }
  for (const p of page.pictures ?? []) {
    const m = snap.pictures.find((x) => x.id === p.id)?.move;
    if (m) p.move = { ...m }; else delete p.move;
  }
}

/** The share of a box's text to keep (see the header). */
export function shortenFactor(result: 'unfit' | 'shrunk', scale: number, total: number, charsOver: number): number {
  const fitted = result === 'unfit' ? Math.max(0, total - charsOver) / Math.max(1, total) : 1;
  return Math.min(0.95, Math.max(0.5, fitted * (scale / (result === 'unfit' ? 0.85 : 0.9)) ** 2));
}

export type ShortenContext = {
  /** The paragraphs translated on this load (paraKey), the only ones shortened. */
  translated: Set<string>;
  /** A paragraph's source text as detected. */
  source(box: string, para: number): string;
  /** The one segment a paragraph is linked to, or null. */
  segment(box: string, para: number): string | null;
  /** Below this size scale a box that fits is shortened too (default 0.8). */
  below?: number;
};

/** The paragraphs of a fitted page to shorten, each with its budget. `before` is the page before its fit. */
export function shortenItems(n: number, before: PageSnapshot, fit: FitReport, ctx: ShortenContext): ShortenItem[] {
  const below = ctx.below ?? SHORTEN_BELOW;
  const items: ShortenItem[] = [];
  for (const r of fit.boxes) {
    const reason = r.result === 'unfit' ? 'unfit' : r.scale < below - 1e-9 ? 'shrunk' : null;
    if (!reason) continue;
    const s = before.boxes.find((x) => x.id === r.box);
    if (!s) continue;
    const texts = s.paragraphs.map(textOf);
    const factor = shortenFactor(reason, r.scale, texts.reduce((k, t) => k + chars(t), 0), r.charsOver);
    texts.forEach((english, para) => {
      if (!ctx.translated.has(paraKey(r.box, para)) || chars(english) < MIN_SHORTEN_CHARS) return;
      const source = ctx.source(r.box, para);
      if (!source) return;
      items.push({ page: n, box: r.box, para, seg_id: ctx.segment(r.box, para), source, english, reason,
        max_chars: Math.max(8, Math.floor(chars(english) * factor)) });
    });
  }
  return items;
}

/** Puts the host's answers in: when one or more is shorter than its text, the page goes back to how it was before
 *  the fit and takes the shorter texts (the caller fits it again). An answer that is not shorter keeps the text.
 *  Returns the paragraphs shortened (none: the page is not touched). */
export function applyShortened(editor: Editor, n: number, before: PageSnapshot, items: ShortenItem[], answers: unknown[]): Shortened[] {
  const picks = items.map((it, k) => ({ it, text: answerText(answers[k]) }))
    .filter((x): x is { it: ShortenItem; text: string } => !!x.text && x.text !== x.it.english && chars(x.text) < chars(x.it.english));
  if (!picks.length) return [];
  restorePage(editor.page(n), before);
  return picks.map(({ it, text }) => {
    editor.setText(n, it.box, it.para, text);
    const after = textOf(editor.box(n, it.box).paragraphs[it.para]);
    return { page: n, box: it.box, para: it.para, seg_id: it.seg_id, before: it.english, after, max_chars: it.max_chars, reason: it.reason };
  });
}

/** An answer of the host: a string, or { text } / { english }; anything else is no answer. */
function answerText(a: unknown): string | null {
  const t = typeof a === 'string' ? a : a && typeof a === 'object' ? ((a as { text?: unknown }).text ?? (a as { english?: unknown }).english) : null;
  return typeof t === 'string' && t.trim() ? t.trim() : null;
}

/** Whether a shortened paragraph still shows its shortened text (an undo or "Use faithful" may have changed it). */
export const shortenedActive = (s: Shortened, page: Page | undefined): boolean => {
  const b = page?.boxes.find((x) => x.id === s.box);
  const p = b?.paragraphs[s.para];
  return !!p && textOf(p) === s.after;
};
