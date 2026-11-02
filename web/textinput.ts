// The text input of a selected box, shared by the editors (app/, web/). A hidden textarea holds the box's text
// (paragraphs joined by '\n'; a line break inside a paragraph is U+2028 there and '\n' in the model) and the selection,
// and takes the keyboard, the IME and the clipboard. The caret and the selection are drawn from the laid-out glyphs
// (src/model/caret.ts) and clicks and line moves are hit-tested against them, so the caret sits on the text the editor
// draws, before and after an edit, horizontal or vertical. Enter makes a new paragraph, Shift+Enter a line break in the
// paragraph; each keystroke goes to the model as Editor.editText (a diff: untouched characters keep their runs).
import { caretLines, caretRect, hitTest, lineEdge, lineMove, selectionRects, type Affinity, type CaretLine, type CaretPos } from '../src/model/caret.ts';
import type { Box, LaidBox, Rect } from '../src/model/types.ts';

export type TextInputHost = {
  ta: HTMLTextAreaElement;
  caret: HTMLElement;
  selection: HTMLElement;
  /** The box being edited and its layout, or null. `key` names it (typing merges per box and paragraph). */
  model(): { key: string; box: Box; laid: LaidBox } | null;
  /** A client point in PDF space on the box's page. */
  toPdf(clientX: number, clientY: number): { x: number; y: number } | null;
  /** A PDF rectangle in the CSS pixels of the caret's and the selection's container (the edit box), through the
   *  page's view (a page turned by /Rotate shows it turned). */
  toCss(r: Rect, laid: LaidBox): { left: number; top: number; width: number; height: number };
  /** The new paragraph texts; `merge`: continue the undo step on top. */
  edit(texts: string[], merge: boolean): void;
  /** The paragraph the caret is in changed. */
  onPara?(para: number): void;
  /** The caret was drawn at this place (every move and edit). */
  onCaret?(pos: CaretPos): void;
  /** Asked before an input changes the text: its type (InputEvent.inputType), the text it inserts and the selection
   *  as textarea offsets. False refuses it (nothing changes; the host says why). A paste is asked with its text. */
  guard?(input: { type: string; data: string | null; start: number; end: number }): boolean;
};

const PSEP = '\n', LSEP = '\u2028';
const MERGE_MS = 1500;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const paraText = (b: Box, i: number) => b.paragraphs[i].runs.map((r) => r.text).join('');

export class TextInput {
  editing = false;
  /** Keystroke layout times (ms), for the smoke checks. */
  readonly reflows: number[] = [];
  private h: TextInputHost;
  private aff: Affinity = 'down';
  private goal: number | null = null;
  private composing = false;
  private drag: { anchor: number } | null = null;
  private para = -1;
  private last = { key: '', para: -1, at: 0 };

  constructor(host: TextInputHost) {
    this.h = host;
    const ta = host.ta;
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') { e.preventDefault(); return; }
      if (this.h.guard && !this.h.guard({ type: e.inputType, data: e.data ?? e.dataTransfer?.getData('text/plain') ?? null, start: ta.selectionStart, end: ta.selectionEnd })) e.preventDefault();
    });
    ta.addEventListener('paste', (e) => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      if (this.h.guard && !this.h.guard({ type: 'insertFromPaste', data: text, start: ta.selectionStart, end: ta.selectionEnd })) e.preventDefault();
    });
    ta.addEventListener('compositionstart', () => { this.composing = true; });
    ta.addEventListener('compositionend', () => { this.composing = false; this.draw(); });
    ta.addEventListener('input', () => this.onInput());
    ta.addEventListener('select', () => this.draw());
    document.addEventListener('selectionchange', () => { if (this.editing && document.activeElement === ta) this.draw(); });
    ta.addEventListener('blur', () => { if (this.editing) host.caret.hidden = true; });
    ta.addEventListener('focus', () => { if (this.editing) this.draw(); });
    ta.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** The box's text as the textarea holds it. */
  static textOf(b: Box): string {
    return b.paragraphs.map((_, i) => paraText(b, i).split('\n').join(LSEP)).join(PSEP);
  }

  /** The caret's position (the selection's focus) in the box, or null when not editing. */
  get pos(): CaretPos | null {
    const m = this.editing ? this.h.model() : null;
    return m ? this.toPos(m.box, this.sel().focus) : null;
  }

  get selection(): { anchor: number; focus: number } { return this.sel(); }

  /** Starts editing the box: the caret at a client point (on the laid glyphs), else at the end. */
  start(clientX?: number, clientY?: number): void {
    const m = this.h.model();
    if (!m) return;
    this.editing = true;
    const ta = this.h.ta;
    ta.value = TextInput.textOf(m.box);
    ta.focus({ preventScroll: true });
    let g = ta.value.length, aff: Affinity = 'down';
    if (clientX !== undefined && clientY !== undefined) {
      const hit = this.hit(clientX, clientY);
      if (hit) { g = this.toGlobal(m.box, hit); aff = hit.affinity; }
    }
    this.set(g, g, aff);
  }

  stop(): void {
    if (!this.editing) return;
    this.editing = false;
    this.drag = null;
    if (document.activeElement === this.h.ta) this.h.ta.blur();
    this.h.ta.value = '';
    this.draw();
  }

  /** The textarea back in step with the model (after undo, redo, a page edit or a style change), then the caret drawn. */
  sync(): void {
    const m = this.editing ? this.h.model() : null;
    if (!m) { this.draw(); return; }
    const t = TextInput.textOf(m.box);
    if (this.h.ta.value !== t) {
      const { anchor, focus } = this.sel();
      this.h.ta.value = t;
      this.set(anchor, focus, this.aff, true);
    } else this.draw();
  }

  /** A pointer down on the text while editing: the caret there (shift extends; a double click selects a word, a
   *  triple click the paragraph; a drag selects). */
  pointerDown(e: PointerEvent, capture: Element): void {
    const m = this.h.model();
    e.preventDefault();
    this.h.ta.focus({ preventScroll: true });
    const hit = this.hit(e.clientX, e.clientY);
    if (!m || !hit) return;
    const b = m.box;
    if (e.detail >= 2) {
      const text = paraText(b, hit.para);
      let s = 0, en = text.length;
      if (e.detail === 2) for (const w of words.segment(text)) if (hit.off >= w.index && hit.off <= w.index + w.segment.length) { s = w.index; en = w.index + w.segment.length; if (w.isWordLike) break; }
      this.set(this.toGlobal(b, { para: hit.para, off: s }), this.toGlobal(b, { para: hit.para, off: en }));
      return;
    }
    const g = this.toGlobal(b, hit);
    const anchor = e.shiftKey ? this.sel().anchor : g;
    this.set(anchor, g, hit.affinity);
    this.drag = { anchor };
    capture.setPointerCapture(e.pointerId);
  }

  /** Extends a text drag; false when there is none. */
  pointerMove(e: PointerEvent): boolean {
    if (!this.drag) return false;
    const m = this.h.model(), hit = this.hit(e.clientX, e.clientY);
    if (m && hit) this.set(this.drag.anchor, this.toGlobal(m.box, hit), hit.affinity);
    return true;
  }

  pointerUp(): void { this.drag = null; }

  /** The next keystroke starts its own undo step (after an edit made elsewhere, e.g. clearing the box). */
  breakMerge(): void { this.last = { key: '', para: -1, at: 0 }; }

  /** Draws the caret (or the selection) where the layout puts the textarea's selection, and moves the textarea there
   *  (the IME's candidate window opens at it). */
  draw(): void {
    const { caret, selection, ta } = this.h;
    const m = this.editing ? this.h.model() : null;
    if (!m) { caret.hidden = true; selection.replaceChildren(); return; }
    const lines = caretLines(m.laid, m.box);
    const { anchor, focus } = this.sel();
    const fp = this.toPos(m.box, focus), ap = this.toPos(m.box, anchor);
    if (fp.para !== this.para) { this.para = fp.para; this.h.onPara?.(fp.para); }
    this.h.onCaret?.(fp);
    const r = caretRect(lines, fp, this.aff);
    if (r) {
      const k = this.h.toCss(r, m.laid);
      // the bar lies across the line: upright for horizontal text, flat for vertical text, and turned with a page
      // turned by /Rotate (toCss maps through the page's view), so its direction is read on the screen
      const vertical = k.height < k.width;
      Object.assign(caret.style, { left: `${k.left - (vertical ? 0 : 0.75)}px`, top: `${k.top - (vertical ? 0.75 : 0)}px`,
        width: `${vertical ? k.width : 1.5}px`, height: `${vertical ? 1.5 : k.height}px` });
      caret.hidden = anchor !== focus;
      caret.classList.remove('blink');
      void caret.offsetWidth;
      caret.classList.add('blink');
      Object.assign(ta.style, { left: `${k.left}px`, top: `${k.top}px`, height: `${Math.max(8, vertical ? 12 : k.height)}px` });
    }
    selection.replaceChildren(...selectionRects(lines, ap, fp).map((q) => {
      const k = this.h.toCss(q, m.laid);
      const d = document.createElement('div');
      d.className = 'selr';
      Object.assign(d.style, { left: `${k.left}px`, top: `${k.top}px`, width: `${k.width}px`, height: `${k.height}px` });
      return d;
    }));
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────

  private sel(): { anchor: number; focus: number } {
    const ta = this.h.ta;
    return ta.selectionDirection === 'backward' ? { anchor: ta.selectionEnd, focus: ta.selectionStart } : { anchor: ta.selectionStart, focus: ta.selectionEnd };
  }

  private set(anchor: number, focus: number, aff: Affinity = 'down', keepGoal = false): void {
    const ta = this.h.ta, n = ta.value.length;
    anchor = Math.max(0, Math.min(n, anchor));
    focus = Math.max(0, Math.min(n, focus));
    ta.setSelectionRange(Math.min(anchor, focus), Math.max(anchor, focus), focus < anchor ? 'backward' : 'forward');
    this.aff = aff;
    if (!keepGoal) this.goal = null;
    this.draw();
  }

  private toPos(b: Box, g: number): CaretPos {
    let off = Math.max(0, g);
    for (let i = 0; i < b.paragraphs.length; i++) {
      const n = paraText(b, i).length;
      if (off <= n || i === b.paragraphs.length - 1) return { para: i, off: Math.min(off, n) };
      off -= n + 1;
    }
    return { para: 0, off: 0 };
  }

  private toGlobal(b: Box, p: CaretPos): number {
    let g = 0;
    for (let i = 0; i < p.para && i < b.paragraphs.length; i++) g += paraText(b, i).length + 1;
    return g + p.off;
  }

  private lines(): { b: Box; lines: CaretLine[] } | null {
    const m = this.h.model();
    return m ? { b: m.box, lines: caretLines(m.laid, m.box) } : null;
  }

  private hit(clientX: number, clientY: number): (CaretPos & { affinity: Affinity }) | null {
    const c = this.lines(), p = this.h.toPdf(clientX, clientY);
    return c && p ? hitTest(c.lines, p.x, p.y) : null;
  }

  private onInput(): void {
    const m = this.editing ? this.h.model() : null;
    if (!m) return;
    const ta = this.h.ta;
    const texts = ta.value.split(PSEP).map((t) => t.split(LSEP).join('\n'));
    const para = ta.value.slice(0, this.sel().focus).split(PSEP).length - 1;
    const now = Date.now();
    const merge = texts.length === m.box.paragraphs.length && this.last.key === m.key && this.last.para === para && now - this.last.at < MERGE_MS;
    this.last = { key: m.key, para, at: now };
    this.aff = 'down';
    this.goal = null;
    const t0 = performance.now();
    this.h.edit(texts, merge);          // the host lays out, redraws and calls sync(), synchronously
    this.reflows.push(performance.now() - t0);
  }

  private insert(s: string): void {
    const ta = this.h.ta;
    if (this.h.guard && !this.h.guard({ type: s === LSEP ? 'insertLineBreak' : 'insertText', data: s, start: ta.selectionStart, end: ta.selectionEnd })) return;
    ta.setRangeText(s, ta.selectionStart, ta.selectionEnd, 'end');
    this.onInput();
  }

  private step(g: number, dir: 1 | -1): number {
    const v = this.h.ta.value;
    let prev = 0;
    for (const s of graphemes.segment(v)) {
      if (dir < 0 && s.index >= g) return prev;
      if (dir > 0 && s.index > g) return s.index;
      prev = s.index;
    }
    return dir > 0 ? v.length : prev;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.editing || this.composing || e.isComposing) return;
    const c = this.lines();
    if (!c) return;
    const { b, lines } = c;
    const vertical = !!b.vertical;
    const { anchor, focus } = this.sel();
    const fp = this.toPos(b, focus);
    const ext = e.shiftKey, mod = e.ctrlKey || e.metaKey;
    const go = (pos: CaretPos, aff: Affinity, keepGoal = false) => { const g = this.toGlobal(b, pos); this.set(ext ? anchor : g, g, aff, keepGoal); };
    // line moves: up and down (vertical text: the next column is to the left)
    const dir = vertical ? (e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0) : (e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0);
    if (dir && !mod && !e.altKey) {
      e.preventDefault();
      const r = lineMove(lines, fp, this.aff, dir as 1 | -1, this.goal ?? undefined);
      this.goal = r.goal;
      go(r.pos, r.affinity, true);
      return;
    }
    // vertical text: up and down move along the column (a character)
    if (vertical && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod && !e.altKey) {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      const g = !ext && anchor !== focus ? (d > 0 ? Math.max(anchor, focus) : Math.min(anchor, focus)) : this.step(focus, d);
      this.set(ext ? anchor : g, g);
      return;
    }
    if ((e.key === 'Home' || e.key === 'End') && !mod) {
      e.preventDefault();
      const r = lineEdge(lines, fp, this.aff, e.key === 'Home' ? 'start' : 'end');
      go(r.pos, r.affinity);
      return;
    }
    if (e.key === 'Enter' && e.shiftKey && !mod) { e.preventDefault(); this.insert(LSEP); return; }
    if (e.key === 'Tab') { e.preventDefault(); return; }
    this.goal = null;
    // the textarea moves its selection itself (left, right, word moves, select all): draw once it has
    requestAnimationFrame(() => { this.aff = 'down'; this.draw(); });
  }
}
