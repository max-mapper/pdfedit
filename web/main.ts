// The live editor. The worker reads, detects and renders; this thread holds the model
// (src/model), lays boxes out with HarfBuzz (src/text) in the shipped faces, and draws the preview as glyph outlines
// over the PDFium bitmap with each edited box's source masked. Nothing loads from another host: PDFium's WASM,
// HarfBuzz's WASM and the fonts are files of this build.
import sansUrl from '../fonts/NotoSans-Regular.ttf?url';
import sansBoldUrl from '../fonts/NotoSans-Bold.ttf?url';
import jpUrl from '../fonts/NotoSansJP-VF.ttf?url';
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import oflUrl from '../fonts/OFL.txt?url';   // the fonts' licence ships with them (OFL 1.1)
import { loadFonts } from '../src/model/fonts.ts';
import type { FontRegistry } from '../src/model/fonts.ts';
import { Editor } from '../src/model/edit.ts';
import type { Change, StylePatch } from '../src/model/edit.ts';
import type { Box, Doc, LaidBox, Page, Rect } from '../src/model/types.ts';
import { Preview, viewOf, type Underlay } from './preview.ts';
import { dragInUser, fromView, rectToView } from '../src/engine/view.ts';
import type { WebTool, WebToolHooks } from './toolhost.ts';
import { TextInput } from './textinput.ts';
import type { WorkerReq, WorkerRes } from './worker.ts';

const Z = 1.5;                                                   // CSS pixels per point
const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const view = $<HTMLCanvasElement>('view');
const previewCanvas = $<HTMLCanvasElement>('preview');
const framesEl = $<HTMLDivElement>('frames');
const editbox = $<HTMLDivElement>('editbox');
const ta = $<HTMLTextAreaElement>('ta');
const caretEl = $<HTMLDivElement>('caret');
const selLayer = $<HTMLDivElement>('selrects');
const log = $<HTMLSpanElement>('log');
const pageInput = $<HTMLInputElement>('page');
const tools = $<HTMLDivElement>('tools');
const ui = {
  scope: $<HTMLSelectElement>('scope'), size: $<HTMLInputElement>('size'), bold: $<HTMLButtonElement>('bold'),
  italic: $<HTMLButtonElement>('italic'), color: $<HTMLInputElement>('color'), align: $<HTMLSelectElement>('align'),
  leading: $<HTMLInputElement>('leading'), spacing: $<HTMLInputElement>('spacing'), reset: $<HTMLButtonElement>('reset-spacing'),
  pin: $<HTMLInputElement>('pin'), split: $<HTMLButtonElement>('split'), merge: $<HTMLButtonElement>('merge'),
  show: $<HTMLButtonElement>('show'), undo: $<HTMLButtonElement>('undo'), redo: $<HTMLButtonElement>('redo'),
};

// ── fonts: the registry for layout (the caret is drawn from the layout: no CSS faces are needed) ────────────
const fontsReady: Promise<FontRegistry> = loadFonts(
  { 'NotoSans-Regular.ttf': sansUrl, 'NotoSans-Bold.ttf': sansBoldUrl, 'NotoSansJP-VF.ttf': jpUrl },
  { harfbuzz: { subsetWasm: subsetWasmUrl } },
);

$<HTMLAnchorElement>('ofl').href = oflUrl;

// ── state ────────────────────────────────────────────────────────────────────────────────────────────────
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: WorkerReq, t: Transferable[] = []) => worker.postMessage(m, t);
let fonts: FontRegistry | null = null;
let doc: Doc | null = null;
let editor: Editor | null = null;
const webTools: WebToolHooks[] = [];   // optional tools (web/tools/*.ts), loaded at the end of this module
let n = 0;
let pageCount = 0;
let preview: Preview | null = null;
let selected: string | null = null;
let second: string | null = null;
let focusPara = 0;
const frameDivs = new Map<string, HTMLDivElement>();
const stats = { reflows: [] as number[], redraws: 0 };
let first = true;

type Debug = {
  doc: Doc | null; editor: Editor | null; page: number; fonts: FontRegistry | null; stats: typeof stats;
  select(id: string): boolean; selected: string | null; laid(id: string): LaidBox; cssRect(r: Rect): { left: number; top: number; width: number; height: number };
  caret(): { para: number; off: number } | null;
};
const debug: Debug = {
  get doc() { return doc; }, get editor() { return editor; }, get page() { return n; }, get fonts() { return fonts; }, stats,
  select: (id) => select(id), get selected() { return selected; },
  laid: (id) => editor!.laid(n, id), cssRect: (r) => cssRect(r),
  caret: () => input.pos,
};

const pg = (): Page => doc!.pages[n];
const laidOf = (b: Box) => editor!.cache!.get(n, b);
const shownFrame = (b: Box): Rect => (b.edited ? laidOf(b).frame : b.frame);
function cssRect(r: Rect) {
  const p = pg(), q = rectToView(p.view, r);
  return { left: q.x0 * Z, top: (p.h - q.y1) * Z, width: (q.x1 - q.x0) * Z, height: (q.y1 - q.y0) * Z };
}
const place = (el: HTMLElement, r: Rect) => {
  const c = cssRect(r);
  el.style.left = `${c.left}px`; el.style.top = `${c.top}px`; el.style.width = `${c.width}px`; el.style.height = `${c.height}px`;
};
const paraText = (b: Box, i: number) => b.paragraphs[i].runs.map((r) => r.text).join('');

// ── worker ───────────────────────────────────────────────────────────────────────────────────────────────
function requestPage(i: number) {
  n = i;
  send({ kind: 'page', n: i, scale: Z * DPR, model: !doc?.pages[i] });
}

worker.onmessage = async (e: MessageEvent<WorkerRes>) => {
  const m = e.data;
  if (m.kind === 'opened') {
    pageCount = m.pages;
    pageInput.max = String(pageCount);
    pageInput.value = '1';
    fonts = await fontsReady;
    doc = { pages: new Array<Page>(pageCount) };
    editor = new Editor(doc, fonts);
    editor.onChange(onChange);
    deselect();
    requestPage(0);
  } else if (m.kind === 'page') {
    if (!doc || m.n !== n) return;
    if (m.page) doc.pages[m.n] = m.page;
    showPage(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height));
    const p = pg();
    log.textContent = `page ${n + 1} of ${pageCount}: ${p.boxes.length} boxes, ${m.chars} characters, ${m.objs} text objects; ` +
      `render ${m.ms} ms, detection ${m.detectMs} ms. Click a box to edit it; shift-click a second box to merge.`;
    if (first) {
      first = false;
      const w = window as unknown as { __rendered: unknown; __editor: Debug };
      w.__editor = debug;
      w.__rendered = { chars: m.chars, objs: m.objs, ms: m.ms, w: m.width };
    }
  } else if (m.kind === 'error') {
    log.textContent = `error: ${m.message}`;
  }
};

function showPage(image: ImageData) {
  const p = pg();
  stage.style.width = `${p.w * Z}px`;
  stage.style.height = `${p.h * Z}px`;
  for (const c of [view, previewCanvas]) {
    c.width = image.width; c.height = image.height;
    c.style.width = `${p.w * Z}px`; c.style.height = `${p.h * Z}px`;
  }
  view.getContext('2d')!.putImageData(image, 0, 0);
  preview = new Preview(previewCanvas, image, viewOf(p, image.width / p.w));
  preview.underlays = webTools.map((t) => t.underlay?.(p)).filter((u): u is Underlay => !!u);
  preview.drawAll(p, laidOf);
  deselect();
  renderFrames();
}

// ── frames ───────────────────────────────────────────────────────────────────────────────────────────────
function renderFrames() {
  framesEl.replaceChildren();
  frameDivs.clear();
  for (const t of webTools) t.frames?.(pg(), (el, r) => { place(el, r); framesEl.append(el); });
  for (const b of pg().boxes) {
    const d = document.createElement('div');
    d.className = 'frame';
    d.dataset.id = b.id;
    frameDivs.set(b.id, d);
    updateFrame(b);
    framesEl.append(d);
  }
}

function updateFrame(b: Box) {
  const d = frameDivs.get(b.id);
  if (!d) return;
  place(d, shownFrame(b));
  d.classList.toggle('edited', b.edited);
  d.classList.toggle('locked', !!b.locked);
  d.classList.toggle('overflow', b.edited && laidOf(b).overflow);
  d.classList.toggle('second', b.id === second);
  d.hidden = b.id === selected;
  d.classList.toggle('vertical', !!b.vertical);
  d.title = b.locked ? `not editable: ${b.locked}` : `${b.id} (${b.kind}${b.vertical ? ', vertical' : ''})`;
}

framesEl.addEventListener('pointerdown', (e) => {
  const d = (e.target as HTMLElement).closest<HTMLDivElement>('.frame');
  if (!d || !editor) return;
  const id = d.dataset.id!;
  if (e.shiftKey && selected && id !== selected) {
    const old = second;
    second = second === id ? null : id;
    for (const x of [old, second]) if (x) updateFrame(editor.box(n, x));
    updateToolbar();
    e.preventDefault();
    return;
  }
  e.preventDefault();
  select(id, e.clientX, e.clientY);
});
stage.addEventListener('pointerdown', (e) => {
  if (e.target === stage || e.target === previewCanvas || e.target === view || e.target === framesEl) deselect();
});

// ── the box editor ───────────────────────────────────────────────────────────────────────────────────────
// Selecting a box hands it to the preview (drawn by the editor at once, its source masked, set on its source lines by
// the layout) and starts the text input there: a hidden textarea, the caret drawn from the laid glyphs
// (web/textinput.ts), at the click.
const input = new TextInput({
  ta, caret: caretEl, selection: selLayer,
  model: () => {
    if (!selected || !editor) return null;
    const box = pg().boxes.find((b) => b.id === selected);
    return box ? { key: `${n}/${selected}`, box, laid: laidOf(box) } : null;
  },
  toPdf: (clientX, clientY) => {
    if (!doc) return null;
    const r = framesEl.getBoundingClientRect();
    const [x, y] = fromView(pg().view, (clientX - r.left) / Z, pg().h - (clientY - r.top) / Z);
    return { x, y };
  },
  toCss: (r, L) => {
    const v = pg().view, q = rectToView(v, r), f = rectToView(v, L.frame);
    return { left: (q.x0 - f.x0) * Z, top: (f.y1 - q.y1) * Z, width: (q.x1 - q.x0) * Z, height: (q.y1 - q.y0) * Z };
  },
  edit: (texts, merge) => {
    if (!editor || !selected) return;
    const t0 = performance.now();
    editor.editText(n, selected, texts, { merge });    // onChange lays out, redraws and syncs the input
    stats.reflows.push(performance.now() - t0);
  },
  onPara: (i) => { focusPara = i; updateToolbar(); },
});

function select(id: string, clientX?: number, clientY?: number): boolean {
  if (!editor) return false;
  const b = editor.box(n, id);
  if (b.locked) { log.textContent = `${id} is not editable: ${b.locked}.`; return false; }
  const prev = selected;
  if (prev === id) return true;
  input.stop();
  selected = id;
  second = null;
  focusPara = 0;
  if (preview) { preview.focused = id; preview.redraw(pg(), prev ? [prev, id] : [id], laidOf); }
  if (prev && prev !== id) { const pb = pg().boxes.find((x) => x.id === prev); if (pb) updateFrame(pb); }
  updateFrame(b);
  placeEditbox();
  editbox.hidden = false;
  tools.setAttribute('aria-disabled', 'false');
  updateToolbar();
  input.start(clientX, clientY);
  return true;
}

function deselect() {
  const prev = selected;
  input.stop();
  selected = null;
  second = null;
  editbox.hidden = true;
  if (preview && prev && doc?.pages[n]) { preview.focused = null; preview.redraw(pg(), [prev], laidOf); }
  tools.setAttribute('aria-disabled', 'true');
  if (prev && doc?.pages[n]) { for (const b of pg().boxes) if (b.id === prev || b.edited) updateFrame(b); }
  updateUndo();
}

const HANDLE_TITLES: [string, string, string][] = [
  ['e', 'Width', 'Right edge (the columns start here)'], ['w', 'Width', 'Width of the column stack (pins it)'],
  ['s', 'Height (pins it)', 'Column length'], ['se', 'Width and height', 'Right edge and column length'],
];

/** The edit box over the laid frame (what is drawn), with the caret. */
function placeEditbox() {
  if (!selected || !editor || !fonts) return;
  const b = editor.box(n, selected);
  const L = editor.laid(n, selected);
  place(editbox, L.frame);
  editbox.classList.toggle('overflow', L.overflow);
  const vertical = !!(b.vertical && L.vertical);
  editbox.classList.toggle('vertical', vertical);
  for (const [h, horiz, vert] of HANDLE_TITLES) {
    const el = editbox.querySelector<HTMLElement>(`.h.${h}`);
    if (el) el.title = vertical ? vert : horiz;
  }
  input.draw();
}

// ── changes: lay out, redraw the preview, move frames, keep the input in step ────────────────────────────────
function onChange(c: Change) {
  if (c.page !== n || !preview) return;
  const p = pg();
  const structural = c.edit.kind === 'split' || c.edit.kind === 'merge' || c.edit.kind === 'page';
  // a page edit (done, undone or redone) may change every box and what the underlays paint: everything is drawn again
  if (c.edit.kind === 'page') preview.drawAll(p, laidOf);
  else preview.redraw(p, c.boxes, laidOf);
  for (const t of webTools) t.changed?.(c);
  stats.redraws++;
  if (structural) renderFrames();
  else for (const id of c.boxes) { const b = p.boxes.find((x) => x.id === id); if (b) updateFrame(b); }
  if (selected) {
    const b = p.boxes.find((x) => x.id === selected);
    if (!b) deselect();
    else {
      focusPara = Math.min(focusPara, b.paragraphs.length - 1);
      placeEditbox();
      if (c.boxes.includes(selected)) input.sync();
    }
  }
  updateToolbar();
}

// ── toolbar ──────────────────────────────────────────────────────────────────────────────────────────────
const hex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const unhex = (s: string): [number, number, number] => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16) / 255) as [number, number, number];

function updateUndo() {
  ui.undo.disabled = !editor?.canUndo;
  ui.redo.disabled = !editor?.canRedo;
}

function updateToolbar() {
  updateUndo();
  if (!selected || !editor) return;
  const b = editor.box(n, selected);
  const p = b.paragraphs[Math.min(focusPara, b.paragraphs.length - 1)];
  const r = p.runs[0];
  if (document.activeElement !== ui.size) ui.size.value = String(Math.round(r.size * 100) / 100);
  ui.bold.setAttribute('aria-pressed', String(r.bold));
  ui.italic.setAttribute('aria-pressed', String(r.italic));
  ui.color.value = hex(r.color);
  ui.align.value = p.align;
  if (document.activeElement !== ui.leading) ui.leading.value = String(Math.round(p.leading * 100) / 100);
  if (document.activeElement !== ui.spacing) ui.spacing.value = String(Math.round(r.charSpacing * 100) / 100);
  ui.pin.checked = b.heightPinned;
  ui.merge.disabled = !second;
}

const scopePara = () => (ui.scope.value === 'para' ? focusPara : null);
function style(patch: StylePatch, merge = false) {
  if (!editor || !selected) return;
  editor.setStyle(n, selected, scopePara(), patch, { merge });
}
const num = (el: HTMLInputElement) => { const v = Number(el.value); return Number.isFinite(v) ? v : null; };
ui.size.addEventListener('input', () => { const v = num(ui.size); if (v && v > 0) style({ size: v }, true); });
ui.leading.addEventListener('input', () => { const v = num(ui.leading); if (v && v > 0) style({ leading: v }, true); });
ui.spacing.addEventListener('input', () => { const v = num(ui.spacing); if (v !== null) style({ charSpacing: v }, true); });
ui.color.addEventListener('input', () => style({ color: unhex(ui.color.value) }, true));
ui.align.addEventListener('change', () => style({ align: ui.align.value as 'left' }));
ui.bold.addEventListener('click', () => style({ bold: ui.bold.getAttribute('aria-pressed') !== 'true' }));
ui.italic.addEventListener('click', () => style({ italic: ui.italic.getAttribute('aria-pressed') !== 'true' }));
ui.reset.addEventListener('click', () => { if (editor && selected) editor.resetCharSpacing(n, selected); });
ui.pin.addEventListener('change', () => { if (editor && selected) editor.setHeightPinned(n, selected, ui.pin.checked); });
ui.split.addEventListener('click', () => {
  if (!editor || !selected) return;
  const at = input.pos?.para === focusPara ? input.pos.off : null;
  const b = editor.box(n, selected);
  try {
    if (at !== null && at > 0 && at < paraText(b, focusPara).length) editor.splitBox(n, selected, focusPara, at);
    else if (focusPara > 0) editor.splitBox(n, selected, focusPara);
    else if (b.paragraphs.length > 1) editor.splitBox(n, selected, 1);
    else log.textContent = 'Put the caret inside the text where the box should split.';
  } catch (err) { log.textContent = String((err as Error).message); }
});
ui.merge.addEventListener('click', () => {
  if (!editor || !selected || !second) return;
  try { editor.mergeBoxes(n, selected, second); } catch (err) { log.textContent = String((err as Error).message); }
});
ui.show.addEventListener('click', () => {
  const on = ui.show.getAttribute('aria-pressed') !== 'true';
  ui.show.setAttribute('aria-pressed', String(on));
  editbox.classList.toggle('show', on);      // the hidden text input, shown (a debugging aid)
});
ui.undo.addEventListener('click', () => editor?.undo());
ui.redo.addEventListener('click', () => editor?.redo());
document.addEventListener('keydown', (e) => {
  if (!editor) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) editor.redo(); else editor.undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); }
  else if (e.key === 'Escape') deselect();
});

// ── move and resize ──────────────────────────────────────────────────────────────────────────────────────
// Horizontal boxes: e / w set the width (a reflow), s sets the height and pins it. Vertical boxes (columns from the
// right edge): s sets the column length (the frame's height, never pinned by it), w sets the column stack's width and
// pins it (text wider than that is an overflow), e moves the right edge the columns hang from. On a page turned by
// /Rotate a handle acts on the user-space edge it sits on as shown (src/engine/view.ts dragInUser).
let drag: { h: string; x: number; y: number; frame: Rect; shown: Rect; pinned: boolean; first: boolean; id: string; vertical: boolean } | null = null;
editbox.addEventListener('pointerdown', (e) => {
  const h = (e.target as HTMLElement).dataset?.h;
  if (!editor || !selected) return;
  if (!h) { input.pointerDown(e, editbox); return; }    // on the text: the caret, a selection
  e.preventDefault();
  const b = editor.box(n, selected);
  drag = { h, x: e.clientX, y: e.clientY, frame: { ...b.frame }, shown: { ...editor.laid(n, selected).frame }, pinned: b.heightPinned,
    first: true, id: selected, vertical: !!b.vertical };
  (e.target as HTMLElement).setPointerCapture(e.pointerId);
});
editbox.addEventListener('pointermove', (e) => {
  if (input.pointerMove(e)) return;
  if (!drag || !editor) return;
  // points, dy down, on the user-space edges the handle is on (a page turned by /Rotate shows them turned)
  const { h: dh, dx, dy } = dragInUser(pg().view, drag.h, e.clientX - drag.x, e.clientY - drag.y, Z);
  const f = drag.frame, s = drag.shown;
  let r: Rect = { ...f };
  let pin = drag.pinned;
  const move = dh === 'move', on = (edge: string) => !move && dh.includes(edge);
  if (drag.vertical) {
    // the frame as shown (its width follows the stack unless pinned)
    r = { ...s, y0: f.y0, y1: f.y1 };
    if (move) r = { x0: s.x0 + dx, x1: s.x1 + dx, y0: f.y0 - dy, y1: f.y1 - dy };
    if (on('e')) { r.x1 = Math.max(s.x0 + 4, s.x1 + dx); if (!pin) r.x0 = r.x1 - (s.x1 - s.x0); }
    if (on('w')) { r.x0 = Math.min(s.x1 - 4, s.x0 + dx); pin = true; }
    if (on('s')) r.y0 = Math.min(f.y1 - 4, f.y0 - dy);
    if (on('n')) r.y1 = Math.max(f.y0 + 4, f.y1 - dy);
  } else {
    if (move) r = { x0: f.x0 + dx, x1: f.x1 + dx, y0: f.y0 - dy, y1: f.y1 - dy };
    if (on('e')) r.x1 = Math.max(f.x0 + 4, f.x1 + dx);
    if (on('w')) r.x0 = Math.min(f.x1 - 4, f.x0 + dx);
    if (on('s')) { r.y0 = Math.min(s.y1 - 4, s.y0 - dy); pin = true; }
    if (on('n')) { r.y1 = Math.max(s.y0 + 4, f.y1 - dy); if (!on('s')) r.y0 = s.y0; pin = true; }
  }
  editor.setFrame(n, drag.id, r, { merge: !drag.first, pinHeight: pin });
  drag.first = false;
});
const endDrag = () => { drag = null; input.pointerUp(); };
editbox.addEventListener('pointerup', endDrag);
editbox.addEventListener('pointercancel', endDrag);

// ── file and page ────────────────────────────────────────────────────────────────────────────────────────
$<HTMLInputElement>('file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const bytes = await f.arrayBuffer();
  send({ kind: 'open', bytes }, [bytes]);
};
pageInput.onchange = () => {
  if (!doc) return;
  const i = Math.min(Math.max(1, Number(pageInput.value) || 1), pageCount) - 1;
  deselect();
  requestPage(i);
};

// ── optional tools (web/tools/*.ts): each adds its own controls to the toolbar ─────────────────────────────────
for (const m of Object.values(import.meta.glob<{ default: WebTool }>(['./tools/*.ts', '!./tools/*.worker.ts'], { eager: true }))) {
  const hooks = m.default({ editor: () => editor, page: () => (doc ? pg() : null), pageNo: () => n, log: (t) => { log.textContent = t; }, group: ui.split.parentElement! });
  if (hooks) webTools.push(hooks);
}
