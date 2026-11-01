// The editor over a Doc: every change is an Edit on an undo stack, marks its box edited (export rewrites only edited
// boxes) and invalidates the box's layout. Pure TypeScript: the UI, the fitter and headless export use it.
//
// Typing and dragging pass { merge: true }: an edit that continues the one on top of the stack (same kind, page,
// box, paragraph) is folded into it, so one undo takes back a burst of keystrokes or one drag.
//
// Two ways to change text: setText (a paragraph's new text in its dominant style, with the character spacing reset:
// translation, the fitter, clearing) and editText (the editor's typing: the box's paragraph texts after a keystroke,
// applied as a diff, so untouched characters keep their runs and inserted ones take the style next to them; a change
// in the number of paragraphs, Enter or a deletion across a paragraph break, is one 'paras' edit).
import type { FontRegistry } from './fonts.ts';
import { fitPage as runFit, type FitOptions, type FitReport } from '../fit/fit.ts';
import { layoutBox } from './layout.ts';
import { substituteRef } from './fonts.ts';
import { LEAD_END, dominantRun, styleKeyOf } from './style.ts';
import { LayoutCache } from './layout.ts';
import type { Box, Doc, Edit, LaidBox, Page, Paragraph, Rect, Run } from './types.ts';

/** What setStyle can change: run attributes (applied to every run of the paragraph, or of the box when para is
 *  null) and paragraph attributes. */
export type StylePatch = Partial<Pick<Run, 'size' | 'bold' | 'italic' | 'underline' | 'color' | 'charSpacing' | 'font'>> &
  Partial<Pick<Paragraph, 'align' | 'leading' | 'indent' | 'spaceBefore' | 'spaceAfter'>>;

export type EditOptions = { merge?: boolean };
export type Change = { page: number; boxes: string[]; edit: Edit; how: 'do' | 'undo' | 'redo' };

const RUN_KEYS = ['size', 'bold', 'italic', 'underline', 'color', 'charSpacing', 'font'] as const;
const PARA_KEYS = ['align', 'leading', 'indent', 'spaceBefore', 'spaceAfter'] as const;

type ParaSnap = Paragraph;

export class Editor {
  readonly doc: Doc;
  readonly fonts: FontRegistry | null;
  readonly cache: LayoutCache | null;
  private undoStack: Edit[] = [];
  private redoStack: Edit[] = [];
  private listeners = new Set<(c: Change) => void>();
  private seq = 0;

  constructor(doc: Doc, fonts: FontRegistry | null = null) {
    this.doc = doc;
    this.fonts = fonts;
    this.cache = fonts ? new LayoutCache(fonts) : null;
  }

  // ── reading ──────────────────────────────────────────────────────────────

  page(n: number): Page {
    const p = this.doc.pages[n];
    if (!p) throw new Error(`editor: no page ${n}`);
    return p;
  }

  box(page: number, id: string): Box {
    const b = this.page(page).boxes.find((x) => x.id === id);
    if (!b) throw new Error(`editor: no box ${id} on page ${page}`);
    return b;
  }

  /** The box laid out (cached until the box changes). Needs the font registry. */
  laid(page: number, id: string): LaidBox {
    if (!this.cache) throw new Error('editor: layout needs a font registry (new Editor(doc, fonts))');
    return this.cache.get(page, this.box(page, id));
  }

  get history(): readonly Edit[] { return this.undoStack; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  /** Called after every change (do, undo, redo) with the page and the ids of the boxes it touched. */
  onChange(fn: (c: Change) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── edits ────────────────────────────────────────────────────────────────

  /** Replaces a paragraph's text, set in a shipped face (the document's subset fonts lack the glyphs) with character
   *  spacing 0 (the reset for new text): one run in the paragraph's dominant style (the style of the most
   *  characters; the bullet is not in the runs). When the source paragraph opens with a short lead-in in another
   *  style (a bold or coloured "title:" before regular text) and the new text keeps a separator (a colon, or a
   *  spaced dash) in its first part, the text up to the separator keeps the lead-in's style. A bullet the new text
   *  repeats at its start is dropped (the layout draws the paragraph's own). */
  setText(page: number, boxId: string, para: number, text: string, opts: EditOptions = {}): void {
    const box = this.editable(page, boxId);
    const p = paraOf(box, para);
    const before = clone(p.runs);
    const top = this.top();
    const merging = !!opts.merge && !!top && top.kind === 'text' && top.page === page && top.box === boxId && top.para === para;
    // a burst of keystrokes takes its styles from the runs before the burst
    const src = merging && top.kind === 'text' ? top.before : p.runs;
    if (p.bullet) text = stripBullet(text, p.bullet);
    const base = dominantRun(src) ?? src[0];
    const make = (src: Run | undefined, t: string): Run => {
      const run: Run = src
        ? { ...clone(src), text: t, charSpacing: 0 }
        : { text: t, font: substituteRef({ text: t, bold: false, italic: false }), size: 10, color: [0, 0, 0], charSpacing: 0, bold: false, italic: false, underline: false };
      run.font = substituteRef({ text: t, bold: run.bold, italic: run.italic, font: run.font });
      return run;
    };
    let runs = [make(base, text)];
    const lead = leadIn(src, base, text);
    if (lead) runs = [make(src[0], text.slice(0, lead)), make(base, text.slice(lead))];
    if (merging && top.kind === 'text') {
      p.runs = clone(runs);
      top.runs = clone(runs);
      box.edited = true;
      this.redoStack = [];
      this.invalidate(page, boxId);
      this.changed(page, [boxId], top, 'do');
      return;
    }
    const wasEdited = box.edited;
    p.runs = clone(runs);
    this.push({ kind: 'text', page, box: boxId, para, runs: clone(runs), before, wasEdited }, [box]);
  }

  /**
   * The editor's typing: `texts` are the box's paragraph texts after a keystroke (a line break inside a paragraph is
   * '\n'). The change is applied as one diff over the box's text (its common prefix and suffix kept): kept characters
   * keep their runs, inserted ones take the style of the character before them (at a paragraph's start: after it).
   * The same number of paragraphs with one changed is a 'text' edit (merged with the one on top when opts.merge);
   * otherwise one 'paras' edit: a new paragraph takes the attributes of the paragraph its first character came from
   * (Enter in a list item makes another item). Paragraphs keep their source lines (Paragraph.src), so the layout keeps
   * every unchanged source line where it was.
   */
  editText(page: number, boxId: string, texts: string[], opts: EditOptions = {}): void {
    const box = this.editable(page, boxId);
    if (!texts.length) texts = [''];
    const old = box.paragraphs.map(textOf);
    if (old.length === texts.length && old.every((t, i) => t === texts[i])) return;
    const next = rebuildParagraphs(box.paragraphs, texts);
    if (old.length === texts.length) {
      const changed = texts.map((t, i) => (t !== old[i] ? i : -1)).filter((i) => i >= 0);
      if (changed.length === 1) {
        const para = changed[0];
        const p = box.paragraphs[para];
        const top = this.top();
        if (opts.merge && top && top.kind === 'text' && top.page === page && top.box === boxId && top.para === para) {
          p.runs = clone(next[para].runs);
          top.runs = clone(p.runs);
          box.edited = true;
          this.redoStack = [];
          this.invalidate(page, boxId);
          this.changed(page, [boxId], top, 'do');
          return;
        }
        const before = clone(p.runs);
        const wasEdited = box.edited;
        p.runs = clone(next[para].runs);
        this.push({ kind: 'text', page, box: boxId, para, runs: clone(p.runs), before, wasEdited }, [box]);
        return;
      }
    }
    const before = clone(box.paragraphs);
    const wasEdited = box.edited;
    box.paragraphs = next;
    this.push({ kind: 'paras', page, box: boxId, before, after: clone(next), wasEdited }, [box]);
  }

  /** Changes run and paragraph attributes of one paragraph, or of every paragraph of the box (para = null). */
  setStyle(page: number, boxId: string, para: number | null, patch: StylePatch, opts: EditOptions = {}): void {
    const box = this.editable(page, boxId);
    if (para !== null) paraOf(box, para);
    const top = this.top();
    const mergeable = opts.merge && top && top.kind === 'style' && top.page === page && top.box === boxId && top.para === para &&
      sameKeys(top.patch, patch);
    const before = mergeable ? null : snapParas(box);
    applyStyle(box, para, patch);
    if (mergeable) {
      top.patch = { ...top.patch, ...clone(patch) };
      this.redoStack = [];
      this.invalidate(page, boxId);
      this.changed(page, [boxId], top, 'do');
      return;
    }
    const wasEdited = box.edited;
    this.push({ kind: 'style', page, box: boxId, para, patch: clone(patch), before, wasEdited }, [box]);
  }

  /** Character spacing 0 on every run of the box: the one-click reset for tracking carried over from the source. */
  resetCharSpacing(page: number, boxId: string): void {
    this.setStyle(page, boxId, null, { charSpacing: 0 });
  }

  /** Moves or resizes the box. A width change reflows; a height set by the user pins it (pinHeight: true), and
   *  pinHeight: false lets it follow the text again. */
  setFrame(page: number, boxId: string, rect: Rect, opts: EditOptions & { pinHeight?: boolean } = {}): void {
    const box = this.editable(page, boxId);
    const frame = normRect(rect);
    const pinned = opts.pinHeight ?? box.heightPinned;
    const top = this.top();
    if (opts.merge && top && top.kind === 'frame' && top.page === page && top.box === boxId) {
      box.frame = { ...frame };
      box.heightPinned = pinned;
      top.frame = { ...frame };
      top.pinned = pinned;
      this.redoStack = [];
      this.invalidate(page, boxId);
      this.changed(page, [boxId], top, 'do');
      return;
    }
    const before = { ...box.frame };
    const pinnedBefore = box.heightPinned;
    const wasEdited = box.edited;
    box.frame = { ...frame };
    box.heightPinned = pinned;
    this.push({ kind: 'frame', page, box: boxId, frame: { ...frame }, before, wasEdited, pinned, pinnedBefore }, [box]);
  }

  /** Pins the box's height at its current frame, or lets it follow the text. */
  setHeightPinned(page: number, boxId: string, pinned: boolean): void {
    const box = this.box(page, boxId);
    let frame = box.frame;
    if (pinned && this.cache) frame = this.laid(page, boxId).frame;   // pin what the user sees
    this.setFrame(page, boxId, frame, { pinHeight: pinned });
  }

  /**
   * Splits the box before paragraph `para` (or inside it, at UTF-16 offset `at`): the paragraphs from there on move
   * to a new box directly below the first part, with the same width. Returns the new box's id.
   */
  splitBox(page: number, boxId: string, para: number, at?: number): string {
    const pg = this.page(page);
    const box = this.editable(page, boxId);
    paraOf(box, para);
    const order = pg.boxes.map((b) => b.id);
    const before = [clone(box)];
    let head = box.paragraphs.slice(0, para);
    let tail = box.paragraphs.slice(para);
    if (at !== undefined && at > 0 && at < textOf(box.paragraphs[para]).length) {
      const [a, b] = splitParagraph(box.paragraphs[para], at);
      head = [...head, a];
      tail = [b, ...tail.slice(1)];
    }
    if (!head.length || !tail.length) throw new Error('editor: a split needs paragraphs on both sides');
    const id = this.freshId(pg, `${boxId}.`);
    box.paragraphs = head;
    box.edited = true;
    box.heightPinned = false;
    this.invalidate(page, boxId);
    // the first part's height decides where the second starts (vertical text: its width, and the second part goes
    // to its left with the same column length)
    const frame = { ...box.frame };
    const share = head.length / (head.length + tail.length);
    let nbFrame: Box['frame'];
    if (box.vertical) {
      const headLeft = this.cache ? this.laid(page, boxId).frame.x0 : frame.x1 - (frame.x1 - frame.x0) * share;
      box.frame = { ...frame, x0: headLeft };
      nbFrame = { x0: Math.min(headLeft, frame.x0), x1: headLeft, y0: frame.y0, y1: frame.y1 };
    } else {
      const headBottom = this.cache ? this.laid(page, boxId).frame.y0 : frame.y1 - (frame.y1 - frame.y0) * share;
      box.frame = { ...frame, y0: headBottom };
      nbFrame = { x0: frame.x0, x1: frame.x1, y1: headBottom, y0: Math.min(headBottom, frame.y0) };
    }
    const nb: Box = {
      ...clone(box), id, paragraphs: clone(tail).map(withoutSource), frame: nbFrame,
      edited: true, heightPinned: false,
      source: { ...clone(box.source), baseline: undefined, axis: undefined, neighbours: [...box.source.neighbours, box.id] },
    };
    if (!box.source.neighbours.includes(id)) box.source.neighbours.push(id);
    pg.boxes.splice(pg.boxes.indexOf(box) + 1, 0, nb);
    const orderAfter = pg.boxes.map((b) => b.id);
    this.push({ kind: 'split', page, boxes: [boxId, id], before, after: [clone(box), clone(nb)], order, orderAfter }, [box, nb]);
    return id;
  }

  /** Appends box `b`'s paragraphs to box `a`; the frame becomes the union, and `a` takes over `b`'s source text
   *  objects (so export removes both). `b` is removed from the page. */
  mergeBoxes(page: number, a: string, b: string): void {
    if (a === b) throw new Error('editor: a box cannot merge with itself');
    const pg = this.page(page);
    const A = this.editable(page, a), B = this.editable(page, b);
    const order = pg.boxes.map((x) => x.id);
    const before = [clone(A), clone(B)];
    A.paragraphs = [...A.paragraphs, ...clone(B.paragraphs)];
    A.frame = unionRect(A.frame, B.frame);
    const s = A.source, t = B.source;
    A.source = {
      ...s,
      frame: unionRect(s.frame, t.frame), lines: s.lines + t.lines, paragraphs: [...s.paragraphs, ...t.paragraphs],
      objs: [...new Set([...s.objs, ...t.objs])].sort((x, y) => x - y),
      chars: [...new Set([...s.chars, ...t.chars])].sort((x, y) => x - y),
      panel: s.panel ?? t.panel,
      neighbours: [...new Set([...s.neighbours, ...t.neighbours])].filter((x) => x !== a && x !== b),
    };
    A.edited = true;
    A.heightPinned = A.heightPinned && B.heightPinned;
    pg.boxes.splice(pg.boxes.indexOf(B), 1);
    for (const x of pg.boxes) {
      const k = x.source.neighbours.indexOf(b);
      if (k >= 0) { x.source.neighbours.splice(k, 1); if (x !== A && !x.source.neighbours.includes(a)) x.source.neighbours.push(a); }
    }
    this.invalidate(page, a);
    this.invalidate(page, b);
    const orderAfter = pg.boxes.map((x) => x.id);
    this.push({ kind: 'merge', page, boxes: [a, b], before, after: [clone(A)], order, orderAfter }, [A]);
  }

  /** Fit every edited box of the page (src/fit/fit.ts) as one undoable step: frames, sizes, leading and picture
   *  moves are snapshotted before and after. */
  fitPage(page: number, opts: FitOptions = {}): FitReport {
    const pg = this.page(page);
    if (!this.fonts) throw new Error('editor: fitPage needs the font registry');
    const order = pg.boxes.map((b) => b.id);
    const before = pg.boxes.map((b) => clone(b));
    const pics = () => (pg.pictures ?? []).map((p) => ({ id: p.id, move: p.move ? { ...p.move } : undefined }));
    const picturesBefore = pics();
    const fonts = this.fonts;
    const report = runFit(pg, (b) => layoutBox(b, fonts), opts);
    const after = pg.boxes.map((b) => clone(b));
    for (const b of pg.boxes) this.invalidate(page, b.id);
    const ids = pg.boxes.map((b) => b.id);
    this.undoStack.push({ kind: 'fit', page, boxes: ids, before, after, order, orderAfter: ids, picturesBefore, picturesAfter: pics() });
    this.redoStack = [];
    this.changed(page, ids, this.undoStack[this.undoStack.length - 1], 'do');
    return report;
  }

  // ── undo / redo ──────────────────────────────────────────────────────────

  undo(): Edit | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.apply(e, 'undo');
    this.redoStack.push(e);
    return e;
  }

  redo(): Edit | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.apply(e, 'redo');
    this.undoStack.push(e);
    return e;
  }

  private apply(e: Edit, how: 'undo' | 'redo'): void {
    const fwd = how === 'redo';
    if (e.kind === 'text') {
      const box = this.box(e.page, e.box);
      paraOf(box, e.para).runs = clone(fwd ? e.runs : e.before);
      box.edited = fwd ? true : (e.wasEdited ?? true);
      this.invalidate(e.page, e.box);
      this.changed(e.page, [e.box], e, how);
    } else if (e.kind === 'paras') {
      const box = this.box(e.page, e.box);
      box.paragraphs = clone(fwd ? e.after : e.before);
      box.edited = fwd ? true : (e.wasEdited ?? true);
      this.invalidate(e.page, e.box);
      this.changed(e.page, [e.box], e, how);
    } else if (e.kind === 'style') {
      const box = this.box(e.page, e.box);
      if (fwd) applyStyle(box, e.para, e.patch as StylePatch);
      else restoreParas(box, e.before as ParaSnap[]);
      box.edited = fwd ? true : (e.wasEdited ?? true);
      this.invalidate(e.page, e.box);
      this.changed(e.page, [e.box], e, how);
    } else if (e.kind === 'frame') {
      const box = this.box(e.page, e.box);
      box.frame = { ...(fwd ? e.frame : e.before) };
      const pin = fwd ? e.pinned : e.pinnedBefore;
      if (pin !== undefined) box.heightPinned = pin;
      box.edited = fwd ? true : (e.wasEdited ?? true);
      this.invalidate(e.page, e.box);
      this.changed(e.page, [e.box], e, how);
    } else {
      const pg = this.page(e.page);
      const map = new Map(pg.boxes.map((b) => [b.id, b]));
      const restore = fwd ? (e.after ?? []) : e.before;
      for (const b of restore) map.set(b.id, clone(b));
      const ids = fwd ? (e.orderAfter ?? []) : (e.order ?? []);
      pg.boxes = ids.map((id) => map.get(id)).filter((b): b is Box => !!b);
      if (e.kind === 'fit') {
        const snap = fwd ? e.picturesAfter : e.picturesBefore;
        for (const p of pg.pictures ?? []) { const m = snap?.find((x) => x.id === p.id); p.move = m?.move ? { ...m.move } : undefined; }
      }
      const touched = [...new Set([...e.boxes, ...restore.map((b) => b.id)])];
      for (const id of touched) this.invalidate(e.page, id);
      this.changed(e.page, touched, e, how);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private editable(page: number, id: string): Box {
    const b = this.box(page, id);
    if (b.locked) throw new Error(`editor: box ${id} is locked (${b.locked})`);
    return b;
  }

  private top(): Edit | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  private push(e: Edit, boxes: Box[]): void {
    for (const b of boxes) { b.edited = true; this.invalidate(e.page, b.id); }
    this.undoStack.push(e);
    this.redoStack = [];
    this.changed(e.page, boxes.map((b) => b.id), e, 'do');
  }

  private invalidate(page: number, id: string): void {
    this.cache?.invalidate(page, id);
  }

  private changed(page: number, boxes: string[], edit: Edit, how: Change['how']): void {
    for (const fn of this.listeners) fn({ page, boxes, edit, how });
  }

  private freshId(pg: Page, prefix: string): string {
    let id: string;
    do id = `${prefix}${++this.seq}`; while (pg.boxes.some((b) => b.id === id));
    return id;
  }
}

const BULLET_CHARS = /^[•・●○■□◆◇▶►‣▪◦※*\-–‐]\s+/u;

/** New text without a list marker it repeats (the paragraph's own, or a common bullet followed by a space). */
function stripBullet(text: string, bullet: string): string {
  const t = text.replace(/^[\s\u3000]+/u, '');
  if (t.startsWith(bullet) && t.length > bullet.length && /^[\s\u3000]/u.test(t.slice(bullet.length))) return t.slice(bullet.length).replace(/^[\s\u3000]+/u, '');
  const m = BULLET_CHARS.exec(t);
  return m && t.length > m[0].length ? t.slice(m[0].length) : text;
}

/** The length of the new text's lead-in (through its separator and the space after it) when the source paragraph
 *  opens with a short run in another style than its dominant one, else 0. */
function leadIn(runs: Run[], base: Run | undefined, text: string): number {
  if (runs.length < 2 || !base || runs[0] === base || styleKeyOf(runs[0]) === styleKeyOf(base)) return 0;
  const total = runs.reduce((n, r) => n + r.text.length, 0);
  if (runs[0].text.trim().length === 0 || (!LEAD_END.test(runs[0].text) && runs[0].text.length > 0.5 * total)) return 0;
  const m = /^(.+?(?:[:：]|\s[–—-]))\s*/u.exec(text);
  if (!m || m[1].length < 2 || m[0].length >= text.length || m[0].length > Math.max(60, 0.5 * text.length)) return 0;
  return m[0].length;
}

function paraOf(box: Box, para: number): Paragraph {
  const p = box.paragraphs[para];
  if (!p) throw new Error(`editor: box ${box.id} has no paragraph ${para}`);
  return p;
}

function applyStyle(box: Box, para: number | null, patch: StylePatch): void {
  const paras = para === null ? box.paragraphs : [box.paragraphs[para]];
  // a change of anything but colour or underline sets the text anew: the source lines no longer apply
  const restyled = Object.keys(patch).some((k) => k !== 'color' && k !== 'underline' && (patch as Record<string, unknown>)[k] !== undefined);
  for (const p of paras) {
    if (restyled) delete p.src;
    for (const k of PARA_KEYS) if (patch[k] !== undefined) (p as Record<string, unknown>)[k] = patch[k];
    for (const r of p.runs) {
      for (const k of RUN_KEYS) if (patch[k] !== undefined) (r as Record<string, unknown>)[k] = clone(patch[k]);
      // a weight or slant change on a shipped face picks the matching face
      if (patch.font === undefined && (patch.bold !== undefined || patch.italic !== undefined)) {
        r.font = r.font.source === 'shipped' ? substituteRef({ text: r.text, bold: r.bold, italic: r.italic, font: r.font })
          : { ...r.font, bold: r.bold, italic: r.italic };
      }
    }
  }
}

function snapParas(box: Box): ParaSnap[] {
  return box.paragraphs.map((p) => clone(p));
}

function restoreParas(box: Box, snap: ParaSnap[]): void {
  box.paragraphs = snap.map((p) => clone(p));
}

function sameKeys(a: object, b: object): boolean {
  const ka = Object.keys(a).sort().join(), kb = Object.keys(b).sort().join();
  return ka === kb;
}

function textOf(p: Paragraph): string {
  return p.runs.map((r) => r.text).join('');
}

/** A paragraph cut in two at a UTF-16 offset; runs keep their styles, the second part has no first-line indent. */
function splitParagraph(p: Paragraph, at: number): [Paragraph, Paragraph] {
  const a: Run[] = [], b: Run[] = [];
  let pos = 0;
  for (const r of p.runs) {
    const end = pos + r.text.length;
    if (end <= at) a.push(clone(r));
    else if (pos >= at) b.push(clone(r));
    else { a.push({ ...clone(r), text: r.text.slice(0, at - pos) }); b.push({ ...clone(r), text: r.text.slice(at - pos) }); }
    pos = end;
  }
  const first = { ...clone(p), runs: a, spaceAfter: 0 };
  const second = { ...clone(p), runs: b.length ? b : [{ ...clone(p.runs[p.runs.length - 1]), text: '' }], indent: 0, spaceBefore: 0, bullet: null };
  return [first, second];
}

function withoutSource(p: Paragraph): Paragraph {
  delete p.src;
  return p;
}

/** The paragraphs after an edit of the box's text (Editor.editText): one diff over the paragraph texts joined with a
 *  separator, so kept characters keep their runs and paragraph attributes. */
function rebuildParagraphs(paras: Paragraph[], texts: string[]): Paragraph[] {
  const SEP = '\u2029';
  type Ch = { ch: string; run: Run; para: number };
  const oldChars: Ch[] = [];
  paras.forEach((p, pi) => {
    if (pi > 0) oldChars.push({ ch: SEP, run: p.runs[0], para: pi });
    for (const r of p.runs) for (const ch of r.text) oldChars.push({ ch, run: r, para: pi });
  });
  const O = oldChars.map((c) => c.ch);
  const N = Array.from(texts.join(SEP));
  let a = 0;
  while (a < O.length && a < N.length && O[a] === N[a]) a++;
  let z = 0;
  while (z < O.length - a && z < N.length - a && O[O.length - 1 - z] === N[N.length - 1 - z]) z++;
  // where inserted characters take their style from: the character before them, or after them at a paragraph start
  const fallbackRun = paras[0]?.runs[0];
  const styleAt = (): { run: Run | undefined; para: number } => {
    const before = oldChars[a - 1], after = oldChars[O.length - z];
    if (before && before.ch !== SEP) return { run: before.run, para: before.para };
    if (after && after.ch !== SEP) return { run: after.run, para: after.para };
    const near = before ?? after;
    const p = near ? paras[near.para] : paras[0];
    return { run: p ? (p.runs[p.runs.length - 1] ?? fallbackRun) : fallbackRun, para: near?.para ?? 0 };
  };
  const ins = styleAt();
  const newChars: Ch[] = [
    ...oldChars.slice(0, a),
    ...N.slice(a, N.length - z).map((ch) => ({ ch, run: ins.run!, para: ins.para })),
    ...oldChars.slice(O.length - z),
  ];
  // cut into paragraphs at the separators; each takes the attributes of the paragraph its first character (or the
  // separator before it) came from
  const out: Paragraph[] = [];
  let cur: Ch[] = [];
  let from = newChars[0]?.para ?? 0;
  const flush = () => {
    const tpl = paras[Math.min(from, paras.length - 1)];
    const runs: Run[] = [];
    let prevSrc: Run | null = null;
    for (const c of cur) {
      if (prevSrc === c.run) runs[runs.length - 1].text += c.ch;
      else { runs.push({ ...clone(c.run), text: c.ch }); prevSrc = c.run; }
    }
    if (!runs.length) runs.push({ ...clone(tpl.runs[tpl.runs.length - 1] ?? tpl.runs[0]), text: '' });
    // a shipped face that cannot draw the new text (CJK typed into a Latin face) switches to one that can
    for (const r of runs) if (r.font.source === 'shipped') r.font = fontForText(r);
    out.push({ ...clone(tpl), runs });
  };
  for (let i = 0; i < newChars.length; i++) {
    const c = newChars[i];
    if (c.ch === SEP) { flush(); cur = []; from = newChars[i + 1] && newChars[i + 1].ch !== SEP ? newChars[i + 1].para : c.para; continue; }
    if (!cur.length) from = c.para;
    cur.push(c);
  }
  flush();
  return out;
}

function fontForText(r: Run): Run['font'] {
  return substituteRef({ text: r.text, bold: r.bold, italic: r.italic, font: r.font });
}

function normRect(r: Rect): Rect {
  return { x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), y0: Math.min(r.y0, r.y1), y1: Math.max(r.y0, r.y1) };
}

function unionRect(a: Rect, b: Rect): Rect {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function clone<T>(x: T): T {
  return structuredClone(x);
}
