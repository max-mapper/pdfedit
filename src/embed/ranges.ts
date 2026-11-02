// Segment ranges inside a linked paragraph (docs/EMBED.md, "Write-through"). A paragraph linked to several segments
// shows their texts joined in link order (src/embed/match.ts joinTargets: a space between two parts unless one side is
// CJK); each segment owns a range of the paragraph's text, and the text between two ranges (the joiner) belongs to
// none. A paragraph linked to one segment is one range over its whole text.
//
// Edits are allowed inside one range only:
//   - a selection replaced or deleted must lie in one range;
//   - Backspace at the start of a range (not the first) and Delete at the end of a range (not the last) are refused,
//     with or without a joiner;
//   - typing at a caret goes into the leftmost range the caret is in: at the end of a range it extends that range, so
//     at an exact boundary (two ranges touching, no joiner) it goes into the range on the caret's left. With a space
//     joiner the caret after the space is at the next range's start and types into that range; inside the joiner there
//     is no caret position.
// After an edit the ranges follow (applyChange): the range the edit was confined to grows or shrinks, the ones after it
// move. Pure: no I/O, Node and the browser.

/** A segment's range in a paragraph's text: [start, end), and `base`, the text the segment has as the editor knows it
 *  (what the range showed when it was loaded or last written). */
export type SegRange = { seg: string; start: number; end: number; base: string };

export type InputEdit = {
  /** The input type (InputEvent.inputType): insertText, insertFromPaste, deleteContentBackward, … */
  type: string;
  /** The selection before the edit, as offsets in the paragraph's text (start ≤ end). */
  start: number;
  end: number;
};
export type InputVerdict =
  | { ok: true; range: number }
  | { ok: false; why: 'crosses_boundary' | 'boundary_backspace' | 'boundary_delete' | 'between_segments' };

const WORDISH = /[\p{L}\p{N}]/u;
const LEAD_MARKER = /^[^\p{L}\p{N}\s]{1,3}[\s　]+/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** One range over a whole paragraph (a paragraph linked to one segment). */
export const wholeRange = (seg: string, text: string, base = text): SegRange[] => [{ seg, start: 0, end: text.length, base }];

/** Each segment's text (trimmed) found in the paragraph's text, in order; a first text whose leading list marker the
 *  paragraph does not show is found without it. Between ranges, and before the first and after the last, there may be
 *  no letters or digits. An empty text is an empty range where the previous one ends. A null text (a segment the
 *  editor does not know) is the text between its neighbours' ranges. Null when a text is not found. */
export function locateRanges(text: string, parts: { seg: string; text: string | null }[]): SegRange[] | null {
  const out: SegRange[] = [];
  let at = 0;
  let first = true;
  let open: SegRange | null = null;          // an unknown segment's range, waiting for where the next one starts
  const close = (upTo: number) => {
    if (!open) return;
    let a = open.start, z = upTo;
    while (a < z && /\s/u.test(text[a])) a++;
    while (z > a && /\s/u.test(text[z - 1])) z--;
    open.start = a; open.end = z; open.base = text.slice(a, z);
    open = null;
  };
  for (const part of parts) {
    if (part.text === null) {
      if (open) return null;                 // two unknown neighbours cannot be told apart
      open = { seg: part.seg, start: at, end: at, base: '' };
      out.push(open);
      first = false;
      continue;
    }
    const t = part.text.trim();
    if (!t) { if (!open) out.push({ seg: part.seg, start: at, end: at, base: '' }); else return null; continue; }
    let found = t;
    let idx = text.indexOf(t, at);
    if (idx < 0 && first) {
      const m = LEAD_MARKER.exec(t);
      if (m) { found = t.slice(m[0].length); idx = text.indexOf(found, at); }
    }
    if (idx < 0 || (!open && WORDISH.test(text.slice(at, idx)))) return null;
    close(idx);
    out.push({ seg: part.seg, start: idx, end: idx + found.length, base: found });
    at = idx + found.length;
    first = false;
  }
  if (open) { close(text.length); return out; }
  return WORDISH.test(text.slice(at)) ? null : out;
}

/** The range a change of the paragraph's text is confined to (everything before its start and after its end is the
 *  same), or -1. When several are (an insertion at a boundary, a change next to a joiner), `hint` wins when it is one
 *  of them, else the leftmost. */
export function confinedRange(ranges: SegRange[], oldText: string, newText: string, hint?: number): number {
  const d = newText.length - oldText.length;
  const fits = (r: SegRange) => r.end + d >= r.start && newText.startsWith(oldText.slice(0, r.start)) && newText.slice(r.end + d) === oldText.slice(r.end);
  const all = ranges.map((r, i) => (fits(r) ? i : -1)).filter((i) => i >= 0);
  if (!all.length) return -1;
  return hint !== undefined && all.includes(hint) ? hint : all[0];
}

/** The ranges after a change of `d` characters confined to range `i`. */
export function applyChange(ranges: SegRange[], i: number, d: number): SegRange[] {
  return ranges.map((r, k) => (k < i ? { ...r } : k === i ? { ...r, end: r.end + d } : { ...r, start: r.start + d, end: r.end + d }));
}

function prevGrapheme(text: string, p: number): number {
  let prev = 0;
  for (const s of graphemes.segment(text)) { if (s.index >= p) break; prev = s.index; }
  return Math.min(prev, p);
}
function nextGrapheme(text: string, p: number): number {
  for (const s of graphemes.segment(text)) if (s.index > p) return s.index;
  return text.length;
}
const prevWord = (text: string, p: number) => { let a = p; while (a > 0 && /\s/u.test(text[a - 1])) a--; while (a > 0 && !/\s/u.test(text[a - 1])) a--; return a; };
const nextWord = (text: string, p: number) => { let b = p; while (b < text.length && /\s/u.test(text[b])) b++; while (b < text.length && !/\s/u.test(text[b])) b++; return b; };

/** Whether an input inside one paragraph keeps to one range (see the header), and which. A deletion at a collapsed
 *  caret covers what the browser deletes: a grapheme, a word for the word deletions, else up to the paragraph's edge. */
export function checkInput(ranges: SegRange[], text: string, input: InputEdit): InputVerdict {
  const { type, start, end } = input;
  if (start !== end) {
    const i = ranges.findIndex((r) => r.start <= start && end <= r.end);
    return i < 0 ? { ok: false, why: 'crosses_boundary' } : { ok: true, range: i };
  }
  const p = start;
  if (type.startsWith('delete')) {
    const back = /Backward$/.test(type);
    const last = ranges.length - 1;
    if (back && ranges.some((r, i) => i > 0 && r.end > r.start && r.start === p)) return { ok: false, why: 'boundary_backspace' };
    if (!back && ranges.some((r, i) => i < last && r.end > r.start && r.end === p)) return { ok: false, why: 'boundary_delete' };
    let a = p, b = p;
    if (type === 'deleteContentBackward') a = prevGrapheme(text, p);
    else if (type === 'deleteContentForward') b = nextGrapheme(text, p);
    else if (type === 'deleteWordBackward') a = prevWord(text, p);
    else if (type === 'deleteWordForward') b = nextWord(text, p);
    else if (back) a = 0;
    else b = text.length;
    const i = ranges.findIndex((r) => r.start <= a && b <= r.end);
    return i < 0 ? { ok: false, why: 'crosses_boundary' } : { ok: true, range: i };
  }
  const i = ranges.findIndex((r) => r.start <= p && p <= r.end);
  return i < 0 ? { ok: false, why: 'between_segments' } : { ok: true, range: i };
}

/** A range's new text as its segment's text: what the segment has around the text the range showed (a list marker
 *  the layout draws, spaces the join trimmed) kept. */
export function segmentTextFor(segText: string, base: string, text: string): string {
  if (!base || segText === base) return text;
  const idx = segText.indexOf(base);
  if (idx < 0) return text;
  const lead = segText.slice(0, idx), trail = segText.slice(idx + base.length);
  return (WORDISH.test(lead) ? '' : lead) + text + (/^\s*$/u.test(trail) ? trail : '');
}
