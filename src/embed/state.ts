// A saved version's state: the edited boxes of a document, by page, to put back over a fresh detection of the same
// PDF. Detection is deterministic for one pdfedit build and one file, so box ids line up; a saved box replaces the
// detected box with its id, and a box the edits made (a split) is put in again. A page's `order` lists its box ids as
// saved, so boxes merged away are dropped and the saved order kept. Picture moves the fitter made are kept too.
// Boxes that are not edited are not saved: they come back from detection (and translation) as they are.
// Paragraphs linked to segments (src/embed/links.ts) are saved like any other, but their text is not the record: on
// load the segments' current text replaces it (src/embed/page.ts), so for them a state keeps the layout (frame, sizes,
// styles). A page also lists its paragraphs that hold a shortened text (src/embed/shorten.ts), with the faithful text.
// Pure: no I/O, Node and the browser.
import type { Box, Doc, PictureMove } from '../model/types.ts';
import type { Shortened } from './shorten.ts';

export const STATE_FORMAT = 'pdfedit-state@1';

export type PageState = {
  n: number;                                   // 0-based page index
  order: string[];                             // every box id of the page, in order, as saved
  boxes: Box[];                                // the edited boxes only
  pictures?: { id: string; move: PictureMove }[];
  shortened?: Omit<Shortened, 'page'>[];       // saved paragraphs that hold a shortened text
};
export type DocState = { format: typeof STATE_FORMAT; engine?: string; pages: PageState[] };

/** The edited boxes of every page (pages with none, and no moved picture, are left out). `shortened`: the
 *  paragraphs that hold a shortened text now; those on saved boxes are listed with their page. */
export function serialiseState(doc: Doc, opts: { engine?: string; shortened?: Shortened[] } = {}): DocState {
  const pages: PageState[] = [];
  doc.pages.forEach((page, n) => {
    if (!page) return;
    const boxes = page.boxes.filter((b) => b.edited);
    const pictures = (page.pictures ?? []).filter((p) => p.move).map((p) => ({ id: p.id, move: { ...p.move! } }));
    if (!boxes.length && !pictures.length) return;
    const saved = new Set(boxes.map((b) => b.id));
    const shortened = (opts.shortened ?? []).filter((s) => s.page === n && saved.has(s.box)).map(({ page: _p, ...s }) => ({ ...s }));
    pages.push({ n, order: page.boxes.map((b) => b.id), boxes: structuredClone(boxes), ...(pictures.length ? { pictures } : {}), ...(shortened.length ? { shortened } : {}) });
  });
  return { format: STATE_FORMAT, ...(opts.engine ? { engine: opts.engine } : {}), pages };
}

export class StateError extends Error {}

/** Checks a state read from a host (JSON) and returns it typed; throws StateError when it is not one. */
export function parseState(x: unknown): DocState {
  const s = x as DocState;
  if (!s || typeof s !== 'object' || s.format !== STATE_FORMAT || !Array.isArray(s.pages)) throw new StateError(`not a ${STATE_FORMAT} state`);
  for (const p of s.pages) {
    if (!p || !Number.isInteger(p.n) || p.n < 0 || !Array.isArray(p.order) || !Array.isArray(p.boxes)) throw new StateError('a page of the state is malformed');
    for (const b of p.boxes) {
      if (!b || typeof b.id !== 'string' || !Array.isArray(b.paragraphs) || !b.frame || !b.source) throw new StateError(`page ${p.n + 1}: a box of the state is malformed`);
    }
    if (p.shortened !== undefined && (!Array.isArray(p.shortened) || !p.shortened.every((x) => x && typeof x.box === 'string' && Number.isInteger(x.para) &&
      typeof x.before === 'string' && typeof x.after === 'string'))) throw new StateError(`page ${p.n + 1}: the shortened list is malformed`);
  }
  return s;
}

export type ApplyResult = {
  /** Pages the state changed. */
  pages: number[];
  /** Boxes put back (replaced or inserted), as `page/id`. */
  boxes: string[];
  /** State pages that are not in the document (another file, or a page count that changed). */
  missingPages: number[];
};

/** Puts one page's state over the page's detected boxes (see the header). */
export function applyPageState(doc: Doc, ps: PageState): boolean {
  const page = doc.pages[ps.n];
  if (!page) return false;
  const saved = new Map(ps.boxes.map((b) => [b.id, structuredClone(b)]));
  const detected = new Map(page.boxes.map((b) => [b.id, b]));
  const out: Box[] = [];
  const placed = new Set<string>();
  for (const id of ps.order) {
    const b = saved.get(id) ?? detected.get(id);
    if (b && !placed.has(id)) { out.push(b); placed.add(id); }
  }
  // a saved box missing from its own order (an older or hand-made state): keep it, at the end
  for (const [id, b] of saved) if (!placed.has(id)) { out.push(b); placed.add(id); }
  page.boxes = out;
  for (const pic of page.pictures ?? []) {
    const m = ps.pictures?.find((x) => x.id === pic.id);
    if (m) pic.move = { ...m.move };
    else delete pic.move;
  }
  return true;
}

/** Puts a saved state over a freshly detected document. */
export function applyState(doc: Doc, state: DocState): ApplyResult {
  const res: ApplyResult = { pages: [], boxes: [], missingPages: [] };
  for (const ps of state.pages) {
    if (!applyPageState(doc, ps)) { res.missingPages.push(ps.n); continue; }
    res.pages.push(ps.n);
    for (const b of ps.boxes) res.boxes.push(`${ps.n}/${b.id}`);
  }
  return res;
}
