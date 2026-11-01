// pdfedit, the standalone editor: every page of a PDF in a scrolling view with thumbnails and zoom, editable text
// boxes detected per page when it is first shown, a typography panel, fit, undo/redo across pages and export.
//
// Threads: the worker (app/worker.ts) holds PDFium: it renders, detects and builds each page's model, and runs
// exports. This thread holds the model (src/model Editor), lays boxes out with HarfBuzz in the shipped faces and draws
// the live preview as glyph outlines over the page bitmap (app/overlay.ts), as web/ does.
//
// Focus: a selected box is drawn by pdfedit at once (its source glyphs masked), set by the keep-source-lines layout
// (src/model/layout.ts: unchanged lines where the source drew them), so the handles outline what is drawn and the caret
// (drawn from the laid glyphs, src/model/caret.ts) is on the text before any edit. Deselecting an unedited box gives
// the page its own glyphs back.
//
// Commit re-render: when editing of a box ends (Escape, a click outside) or after IDLE_MS without an edit, the page's
// current model is exported in the worker (incremental, verify 'report') and the result rendered by PDFium. The page
// then shows that true render and the overlay keeps only boxes changed since (and boxes export refused). A burst of
// edits makes one export; a commit overtaken by a newer edit is skipped or ignored.
import { faceGroups, catalogLabel } from './fontpicker.ts';
import { prepareSubstitutes } from '../src/fonts/apply.ts';
import { loadAppFonts, oflUrl } from './assets.ts';
import type { FontRegistry } from '../src/model/fonts.ts';
import { substituteRef, hasCjk, parseCatalogFaceId } from '../src/model/fonts.ts';
import { Editor, type Change, type StylePatch } from '../src/model/edit.ts';
import { TextInput } from '../web/textinput.ts';
import type { Box, Doc, FontRef, LaidBox, Page, Rect } from '../src/model/types.ts';
import type { FitReport } from '../src/fit/fit.ts';
import type { ExportReport } from '../src/export/export.ts';
import { drawnRect, movedPictures } from '../web/preview.ts';
import { Overlay, type OverlayMode } from './overlay.ts';
import { History } from './history.ts';
import { exportReportView, fitReportView, h } from './reports.ts';
import type { CommitResult, Req, Res } from './protocol.ts';

// ── constants ───────────────────────────────────────────────────────────────────────────────────────────────
const PT = 96 / 72;                       // CSS pixels per point at 100%
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const ZMIN = 0.5, ZMAX = 4;
const DPR = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
const MAX_PIXELS = 24e6;                  // a page bitmap's device pixels at most (memory); beyond, CSS scales it up
const IDLE_MS = 800;                      // no edit for this long: commit the page
const KEEP_BITMAPS = 10;                  // pages whose bitmaps stay in memory while off screen
const THUMB_W = 120;

// ── DOM ─────────────────────────────────────────────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewer = $<HTMLDivElement>('viewer');
const pagesEl = $<HTMLDivElement>('pages');
const thumbsEl = $<HTMLDivElement>('thumbs');
const emptyEl = $<HTMLDivElement>('empty');
const editbox = $<HTMLDivElement>('editbox');
const ta = $<HTMLTextAreaElement>('ta');
const caretEl = $<HTMLDivElement>('caret');
const selLayer = $<HTMLDivElement>('selrects');
const fileInput = $<HTMLInputElement>('file');
const ui = {
  open: $<HTMLButtonElement>('open'), open2: $<HTMLButtonElement>('open2'), docname: $<HTMLSpanElement>('docname'),
  zoomOut: $<HTMLButtonElement>('zoom-out'), zoomIn: $<HTMLButtonElement>('zoom-in'), zoomSel: $<HTMLSelectElement>('zoom-sel'),
  fitWidth: $<HTMLButtonElement>('fit-width'), fitPageZoom: $<HTMLButtonElement>('fit-page'),
  undo: $<HTMLButtonElement>('undo'), redo: $<HTMLButtonElement>('redo'),
  fitThis: $<HTMLButtonElement>('fit-this'), fitAll: $<HTMLButtonElement>('fit-all'),
  export: $<HTMLButtonElement>('export'), download: $<HTMLAnchorElement>('download'),
  typo: $<HTMLElement>('typo'), scope: $<HTMLDivElement>('scope'), paraN: $<HTMLSpanElement>('para-n'),
  font: $<HTMLSelectElement>('font'), fontNote: $<HTMLDivElement>('font-note'), size: $<HTMLInputElement>('size'),
  bold: $<HTMLButtonElement>('bold'), italic: $<HTMLButtonElement>('italic'), underline: $<HTMLButtonElement>('underline'),
  color: $<HTMLInputElement>('color'), align: $<HTMLDivElement>('align'), leading: $<HTMLInputElement>('leading'),
  spacing: $<HTMLInputElement>('spacing'), resetSpacing: $<HTMLButtonElement>('reset-spacing'),
  spaceBefore: $<HTMLInputElement>('space-before'), spaceAfter: $<HTMLInputElement>('space-after'), indent: $<HTMLInputElement>('indent'),
  bx: $<HTMLInputElement>('bx'), by: $<HTMLInputElement>('by'), bw: $<HTMLInputElement>('bw'), bh: $<HTMLInputElement>('bh'),
  pin: $<HTMLInputElement>('pin'), split: $<HTMLButtonElement>('split'), merge: $<HTMLButtonElement>('merge'), boxinfo: $<HTMLParagraphElement>('boxinfo'),
  fitBody: $<HTMLDivElement>('fit-body'), exportBody: $<HTMLDivElement>('export-body'),
  pageno: $<HTMLInputElement>('pageno'), pagecount: $<HTMLSpanElement>('pagecount'), stZoom: $<HTMLSpanElement>('st-zoom'),
  stDetect: $<HTMLSpanElement>('st-detect'), stEdits: $<HTMLSpanElement>('st-edits'), stCommit: $<HTMLSpanElement>('st-commit'),
  stMsg: $<HTMLSpanElement>('st-msg'), dropmask: $<HTMLDivElement>('dropmask'),
};
$<HTMLAnchorElement>('ofl').href = oflUrl;

// ── fonts: the registry for layout (the caret is drawn from the layout: no CSS faces are needed) ────────────
const fontsReady: Promise<FontRegistry> = loadAppFonts();
const FACES: Record<string, string> = {
  'NotoSans-Regular': 'Noto Sans Regular', 'NotoSans-Bold': 'Noto Sans Bold', 'NotoSansJP:400': 'Noto Sans JP Regular', 'NotoSansJP:700': 'Noto Sans JP Bold',
};
const faceLabel = (id: string) => { const k = id.replace(/#vertical$/, ''); return FACES[k] ?? catalogLabel(k) ?? k; };
let fontListKey = '';

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────
type Bitmap = { img: ImageData; scale: number };
type PageView = {
  n: number; w: number; h: number;
  el: HTMLDivElement; base: HTMLCanvasElement; over: HTMLCanvasElement; frames: HTMLDivElement; loading: HTMLDivElement;
  thumb: HTMLButtonElement; thumbCanvas: HTMLCanvasElement; thumbDot: HTMLSpanElement; thumbSource: string;
  visible: boolean; thumbVisible: boolean; seen: number;
  orig: Bitmap | null; commit: Bitmap | null; wantOrig: number; wantCommit: number; modelAsked: boolean;
  overlay: Overlay | null; mode: 'orig' | 'commit' | null;
  frameDivs: Map<string, HTMLDivElement>;
  detectMs: number | null; chars: number;
  // commit state
  version: number; committedVersion: number; dirty: Set<string>; structural: boolean;
  committed: { id: number; rects: Map<string, Rect>; ids: Set<string> } | null;
  inflight: { id: number; version: number; rects: Map<string, Rect>; ids: Set<string> } | null;
  refused: Map<string, string>; failures: string[]; timer: number;
  fit: FitReport | null;
};

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: Req, t: Transferable[] = []) => worker.postMessage(m, t);
let fonts: FontRegistry | null = null;
let doc: Doc | null = null;
let editor: Editor | null = null;
let history: History | null = null;
let fileName = '';
let views: PageView[] = [];
let zoom = 1;
let current = 0;
let sel: { page: number; id: string } | null = null;
let editing = false;
let second: string | null = null;
let focusPara = 0;
let scope: 'box' | 'para' = 'box';
let lastNudge = { box: '', at: 0 };
let reqSeq = 0, commitSeq = 0, exportSeq = 0, seenSeq = 0;
let globalVersion = 0, exportedVersion = -1;
let exportPending = 0;
let pendingExportVersion = -1;
let downloadUrl: string | null = null;
let lastFit: FitReport[] = [];
let lastExport: { report: ExportReport | null; error: string | null; bytes: number } | null = null;
const stats = { reflows: [] as number[], commits: 0, commitMs: [] as number[] };

const Z = () => zoom * PT;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const pageOf = (n: number): Page | undefined => doc?.pages[n];
const laidFn = (n: number) => (b: Box): LaidBox => editor!.cache!.get(n, b);
const findBox = (n: number, id: string) => pageOf(n)?.boxes.find((b) => b.id === id);
const paraText = (b: Box, i: number) => b.paragraphs[i].runs.map((r) => r.text).join('');
const msg = (s: string) => { ui.stMsg.textContent = s; ui.stMsg.title = s; };

function scaleFor(v: PageView): number {
  return Math.min(Z() * DPR, Math.sqrt(MAX_PIXELS / (v.w * v.h)));
}

// ── opening a file ──────────────────────────────────────────────────────────────────────────────────────────
async function openFile(f: File) {
  if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') { msg(`${f.name} is not a PDF.`); return; }
  reset();
  fileName = f.name;
  ui.docname.textContent = f.name;
  ui.docname.title = f.name;
  msg('Opening…');
  const bytes = await f.arrayBuffer();
  send({ kind: 'open', bytes }, [bytes]);
}

function reset() {
  deselect();
  for (const v of views) clearTimeout(v.timer);
  views = [];
  pagesEl.replaceChildren();
  thumbsEl.replaceChildren();
  doc = null; editor = null; history = null;
  lastFit = []; lastExport = null;
  globalVersion = 0; exportedVersion = -1;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  ui.download.hidden = true;
  ui.fitBody.replaceChildren(h('p', { class: 'muted' }, 'No fit run yet.'));
  ui.exportBody.replaceChildren(h('p', { class: 'muted' }, 'Not exported yet.'));
}

fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) openFile(f); fileInput.value = ''; });
ui.open.addEventListener('click', () => fileInput.click());
ui.open2.addEventListener('click', () => fileInput.click());

let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; ui.dropmask.hidden = false; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; ui.dropmask.hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.dropmask.hidden = true;
  const f = [...(e.dataTransfer?.files ?? [])].find((x) => /\.pdf$/i.test(x.name) || x.type === 'application/pdf');
  if (f) openFile(f); else msg('Drop a PDF file.');
});

// ── worker messages ─────────────────────────────────────────────────────────────────────────────────────────
worker.onmessage = async (e: MessageEvent<Res>) => {
  const m = e.data;
  if (m.kind === 'opened') {
    fonts = await fontsReady;
    doc = { pages: new Array<Page>(m.sizes.length) };
    editor = new Editor(doc, fonts);
    history = new History(editor);
    editor.onChange(onChange);
    buildViews(m.sizes);
    emptyEl.hidden = true;
    zoom = clamp(fitWidthZoom(), ZMIN, 1.5);
    for (const v of views) sizePage(v);
    syncZoomUi();
    viewer.scrollTop = 0;
    msg(`${m.sizes.length} page${m.sizes.length === 1 ? '' : 's'} opened in ${m.ms} ms. Click a box to select it, double-click to edit.`);
    updateAll();
    requestAnimationFrame(() => { for (const v of views) ensureRender(v); });
  } else if (m.kind === 'render') {
    const v = views[m.n];
    if (!v || !doc) return;
    if (m.page && !doc.pages[m.n]) {
      doc.pages[m.n] = m.page;
      // the matched substitute for each of the page's fonts, loaded before its boxes are laid out (src/fonts/apply.ts)
      if (fonts) await prepareSubstitutes(doc, fonts, { pages: [m.n], all: true }).catch(() => []);
      v.detectMs = m.detectMs;
      v.chars = m.chars;
      buildFrames(v);
      (window as unknown as { __detected: number }).__detected = ((window as unknown as { __detected?: number }).__detected ?? 0) + 1;
    }
    const img = new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height);
    if (m.source === 'orig') {
      if (near(m.scale, v.wantOrig)) v.wantOrig = 0;
      if (v.orig && !near(m.scale, scaleFor(v))) { /* a stale zoom level */ } else v.orig = { img, scale: m.scale };
    } else {
      if (near(m.scale, v.wantCommit)) v.wantCommit = 0;
      if (v.committed?.id !== m.commitId) return;
      if (v.commit && !near(m.scale, scaleFor(v))) return;
      v.commit = { img, scale: m.scale };
    }
    v.loading.hidden = true;
    paint(v);
    evict();
    if (m.n === current) updateStatus();
  } else if (m.kind === 'render-missing') {
    const v = views[m.n];
    if (!v) return;
    v.wantCommit = 0;
    if (v.committed?.id === m.commitId) {
      // the worker let the committed export go: commit the page again
      v.committed = null; v.commit = null; v.committedVersion = -1;
      paint(v);
      commit(v);
    }
  } else if (m.kind === 'thumb') {
    const v = views[m.n];
    if (!v) return;
    const c = v.thumbCanvas;
    c.width = m.width; c.height = m.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), 0, 0);
  } else if (m.kind === 'committed') {
    onCommitted(m);
  } else if (m.kind === 'exported') {
    onExported(m);
  } else if (m.kind === 'error') {
    msg(`Error (${m.context}): ${m.message}`);
  }
};

// ── pages and thumbnails ────────────────────────────────────────────────────────────────────────────────────
let pageObserver: IntersectionObserver | null = null;
let thumbObserver: IntersectionObserver | null = null;

function buildViews(sizes: { w: number; h: number }[]) {
  pageObserver?.disconnect();
  thumbObserver?.disconnect();
  pageObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = views[Number((en.target as HTMLElement).dataset.n)];
      if (!v) continue;
      v.visible = en.isIntersecting;
      if (v.visible) { v.seen = ++seenSeq; ensureRender(v); }
    }
  }, { root: viewer, rootMargin: '60% 0px' });
  thumbObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const v = views[Number((en.target as HTMLElement).dataset.n)];
      if (!v) continue;
      v.thumbVisible = en.isIntersecting;
      if (v.thumbVisible && !v.thumbSource) requestThumb(v);
    }
  }, { root: thumbsEl, rootMargin: '100% 0px' });
  views = sizes.map((s, n) => {
    const el = h('div', { class: 'page', 'data-n': String(n) }) as HTMLDivElement;
    const base = h('canvas', { class: 'base' }) as HTMLCanvasElement;
    const over = h('canvas', { class: 'over' }) as HTMLCanvasElement;
    const frames = h('div', { class: 'frames' }) as HTMLDivElement;
    const loading = h('div', { class: 'loading' }, 'Rendering…') as HTMLDivElement;
    el.append(base, over, frames, loading, h('div', { class: 'pn' }, `${n + 1}`));
    pagesEl.append(el);
    const thumbCanvas = h('canvas') as HTMLCanvasElement;
    const tc = h('span', { class: 'tc' }, thumbCanvas);
    tc.style.aspectRatio = `${s.w} / ${s.h}`;
    const thumbDot = h('span', { class: 'dot' }) as HTMLSpanElement;
    const thumb = h('button', { class: 'thumb', 'data-n': String(n), title: `Page ${n + 1}` }, tc, h('span', { class: 'tn' }, `${n + 1}`, thumbDot)) as HTMLButtonElement;
    thumb.addEventListener('click', () => scrollToPage(n));
    thumbsEl.append(thumb);
    const v: PageView = {
      n, w: s.w, h: s.h, el, base, over, frames, loading, thumb, thumbCanvas, thumbDot, thumbSource: '',
      visible: false, thumbVisible: false, seen: 0, orig: null, commit: null, wantOrig: 0, wantCommit: 0, modelAsked: false,
      overlay: null, mode: null, frameDivs: new Map(), detectMs: null, chars: 0,
      version: 0, committedVersion: 0, dirty: new Set(), structural: false, committed: null, inflight: null,
      refused: new Map(), failures: [], timer: 0, fit: null,
    };
    pageObserver!.observe(el);
    thumbObserver!.observe(thumb);
    return v;
  });
  ui.pagecount.textContent = String(views.length);
  ui.pageno.max = String(views.length);
}

function sizePage(v: PageView) {
  v.el.style.width = `${v.w * Z()}px`;
  v.el.style.height = `${v.h * Z()}px`;
}

function ensureRender(v: PageView) {
  if (!v.visible || !doc) return;
  const s = scaleFor(v);
  if (!(v.orig && near(v.orig.scale, s)) && !near(v.wantOrig, s)) {
    v.wantOrig = s;
    const model = !doc.pages[v.n] && !v.modelAsked;
    if (model) v.modelAsked = true;
    send({ kind: 'render', req: ++reqSeq, n: v.n, scale: s, source: 'orig', model });
  }
  if (v.committed && !(v.commit && near(v.commit.scale, s)) && !near(v.wantCommit, s)) {
    v.wantCommit = s;
    send({ kind: 'render', req: ++reqSeq, n: v.n, scale: s, source: 'commit', commitId: v.committed.id, model: false });
  }
}

function requestThumb(v: PageView) {
  const source = v.committed ? 'commit' : 'orig';
  const key = source === 'commit' ? `commit:${v.committed!.id}` : 'orig';
  if (v.thumbSource === key) return;
  v.thumbSource = key;
  send({ kind: 'thumb', n: v.n, scale: (THUMB_W * DPR) / v.w, source, commitId: v.committed?.id });
}

/** Keeps at most KEEP_BITMAPS pages' bitmaps: the least recently seen off-screen pages let theirs go. */
function evict() {
  const held = views.filter((v) => v.orig || v.commit);
  if (held.length <= KEEP_BITMAPS) return;
  const cands = held.filter((v) => !v.visible && v.n !== sel?.page).sort((a, b) => a.seen - b.seen);
  for (const v of cands.slice(0, held.length - KEEP_BITMAPS)) {
    v.orig = null; v.commit = null; v.overlay = null; v.mode = null;
    v.base.width = v.base.height = 0;
    v.over.width = v.over.height = 0;
    v.loading.hidden = false;
  }
}

/** Whether the page can show its committed render: nothing structural changed since, and every box changed since
 *  is still edited and was on the page when it was committed. */
function useCommit(v: PageView): boolean {
  const c = v.committed;
  const page = pageOf(v.n);
  if (!c || !v.commit || v.structural || !page) return false;
  for (const id of v.dirty) {
    const b = page.boxes.find((x) => x.id === id);
    if (!b || !b.edited || !c.ids.has(id)) return false;
  }
  return true;
}

/** Draws the page: the base bitmap (original or committed render) and the overlay on it. */
function paint(v: PageView) {
  if (!v.orig) return;
  const commitMode = useCommit(v);
  const bmp = commitMode ? v.commit! : v.orig;
  v.mode = commitMode ? 'commit' : 'orig';
  for (const c of [v.base, v.over]) {
    if (c.width !== bmp.img.width || c.height !== bmp.img.height) { c.width = bmp.img.width; c.height = bmp.img.height; }
  }
  v.base.getContext('2d')!.putImageData(bmp.img, 0, 0);
  const focused = (b: Box) => sel?.page === v.n && sel.id === b.id;
  const mode: OverlayMode = commitMode
    ? { include: (b) => (b.edited && (v.dirty.has(b.id) || v.refused.has(b.id))) || focused(b), extra: (id) => v.committed?.rects.get(id), pictures: false }
    : { include: (b) => b.edited || focused(b), extra: () => undefined, pictures: true };
  v.overlay = new Overlay(v.over, bmp.img, { k: bmp.img.width / v.w, h: v.h }, mode);
  const page = pageOf(v.n);
  if (page && editor) v.overlay.drawAll(page, laidFn(v.n));
  else v.over.getContext('2d')!.clearRect(0, 0, v.over.width, v.over.height);
}

/** Redraws one box on its page's overlay (it gained or lost the focus). */
function redrawBox(n: number, id: string) {
  const v = views[n], page = pageOf(n);
  if (v?.overlay && page && editor) v.overlay.redraw(page, [id], laidFn(n));
}

// ── frames ──────────────────────────────────────────────────────────────────────────────────────────────────
function placePct(el: HTMLElement, v: PageView, r: Rect) {
  el.style.left = `${(r.x0 / v.w) * 100}%`;
  el.style.top = `${((v.h - r.y1) / v.h) * 100}%`;
  el.style.width = `${((r.x1 - r.x0) / v.w) * 100}%`;
  el.style.height = `${((r.y1 - r.y0) / v.h) * 100}%`;
}

function buildFrames(v: PageView) {
  const page = pageOf(v.n);
  v.frames.replaceChildren();
  v.frameDivs.clear();
  if (!page) return;
  for (const { pic, to } of movedPictures(page)) {
    const d = h('div', { class: 'picture', title: `${pic.id} (${pic.kind}) moved by the fitter` });
    placePct(d, v, to);
    v.frames.append(d);
  }
  for (const b of page.boxes) {
    const d = h('div', { class: 'frame', 'data-id': b.id }) as HTMLDivElement;
    v.frameDivs.set(b.id, d);
    v.frames.append(d);
    updateFrame(v, b);
  }
}

function updateFrame(v: PageView, b: Box) {
  const d = v.frameDivs.get(b.id);
  if (!d || !editor) return;
  const L = b.edited ? laidFn(v.n)(b) : null;
  placePct(d, v, L ? L.frame : b.frame);
  const unfit = v.fit?.boxes.find((x) => x.box === b.id && x.result === 'unfit');
  const refused = v.refused.get(b.id);
  d.classList.toggle('edited', b.edited);
  d.classList.toggle('locked', !!b.locked);
  d.classList.toggle('overflow', !!L?.overflow);
  d.classList.toggle('unfit', !!unfit);
  d.classList.toggle('refused', !!refused);
  d.classList.toggle('second', sel?.page === v.n && b.id === second);
  d.hidden = sel?.page === v.n && sel.id === b.id;
  let badge = d.querySelector<HTMLSpanElement>('.badge');
  const text = refused ? `export refused: ${refused}` : unfit ? `unfit: about ${unfit.charsOver} characters over` : '';
  if (text) {
    if (!badge) { badge = h('span', { class: 'badge' }) as HTMLSpanElement; d.append(badge); }
    badge.textContent = text;
  } else badge?.remove();
  d.title = b.locked ? `not editable: ${b.locked}` : text || `${b.id} (${b.kind}${b.vertical ? ', vertical' : ''})${b.edited ? ', edited' : ''}`;
}

function updateFrames(v: PageView) {
  const page = pageOf(v.n);
  if (page) for (const b of page.boxes) updateFrame(v, b);
}

// ── selection and the edit box ──────────────────────────────────────────────────────────────────────────────
function select(page: number, id: string): boolean {
  const v = views[page];
  const b = findBox(page, id);
  if (!v || !b || !editor) return false;
  if (b.locked) { msg(`${id} is not editable: ${b.locked}.`); return false; }
  if (sel && sel.page === page && sel.id === id) return true;
  if (editing) stopEditing();
  const prev = sel;
  sel = { page, id };
  second = null;
  focusPara = 0;
  if (prev) { const pv = views[prev.page]; const pb = findBox(prev.page, prev.id); if (pv && pb) updateFrame(pv, pb); redrawBox(prev.page, prev.id); if (prev.page !== page) flushCommit(prev.page); }
  updateFrame(v, b);
  redrawBox(page, id);                 // pdfedit draws the box from now on: what the handles outline and the caret follow
  v.el.append(editbox);
  editbox.hidden = false;
  placeEditbox();
  ui.typo.setAttribute('aria-disabled', 'false');
  updatePanel();
  return true;
}

function deselect() {
  if (editing) stopEditing();
  const prev = sel;
  sel = null;
  second = null;
  editbox.hidden = true;
  ui.typo.setAttribute('aria-disabled', 'true');
  if (prev) {
    const v = views[prev.page];
    redrawBox(prev.page, prev.id);     // an unedited box gets its source glyphs back
    if (v) { updateFrames(v); flushCommit(prev.page); }
  }
  updatePanel();
}

function cssRect(v: PageView, r: Rect) {
  const z = Z();
  return { left: r.x0 * z, top: (v.h - r.y1) * z, width: (r.x1 - r.x0) * z, height: (r.y1 - r.y0) * z };
}

/** The edit box over the laid frame (the box as drawn: the selection outline is what is drawn), with the caret. */
function placeEditbox() {
  if (!sel || !editor || !fonts) return;
  const v = views[sel.page];
  const b = findBox(sel.page, sel.id);
  if (!v || !b) return;
  const L = laidFn(sel.page)(b);
  const z = Z();
  const c = cssRect(v, L.frame);
  Object.assign(editbox.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` });
  editbox.classList.toggle('overflow', L.overflow);
  const vertical = !!(b.vertical && L.vertical);
  editbox.classList.toggle('vertical', vertical);
  const titles: Record<string, [string, string]> = {
    e: ['Width', 'Right edge (the columns start here)'], w: ['Width', 'Width of the column stack (pins it)'],
    s: ['Height (pins it)', 'Column length'], n: ['Height from the top (pins it)', 'Column start'],
  };
  for (const el of editbox.querySelectorAll<HTMLElement>('.h')) {
    const k = el.dataset.h!;
    if (k === 'move') continue;
    el.title = k.split('').map((c1) => titles[c1]?.[vertical ? 1 : 0]).filter(Boolean).join(' · ');
  }
  drawCaret();
}

// ── the text input (web/textinput.ts): a hidden textarea; the caret and the selection drawn from the laid glyphs ──
const input = new TextInput({
  ta, caret: caretEl, selection: selLayer,
  model: () => {
    if (!sel || !editor) return null;
    const box = findBox(sel.page, sel.id);
    return box ? { key: `${sel.page}/${sel.id}`, box, laid: laidFn(sel.page)(box) } : null;
  },
  toPdf: (clientX, clientY) => {
    const v = sel ? views[sel.page] : null;
    if (!v) return null;
    const pr = v.el.getBoundingClientRect(), z = Z();
    return { x: (clientX - pr.left) / z, y: v.h - (clientY - pr.top) / z };
  },
  toCss: (r, L) => {
    const z = Z();
    return { left: (r.x0 - L.frame.x0) * z, top: (L.frame.y1 - r.y1) * z, width: (r.x1 - r.x0) * z, height: (r.y1 - r.y0) * z };
  },
  edit: (texts, merge) => {
    if (!editor || !sel) return;
    const t0 = performance.now();
    editor.editText(sel.page, sel.id, texts, { merge });   // onChange lays out, redraws and syncs the input
    stats.reflows.push(performance.now() - t0);
  },
  onPara: (i) => { focusPara = i; updatePanel(); },
});
const drawCaret = () => input.draw();

function startEditing(x?: number, y?: number) {
  if (!sel || !editor || !findBox(sel.page, sel.id)) return;
  editing = true;
  editbox.classList.add('editing');
  placeEditbox();
  input.start(x, y);
  updatePanel();
  updateStatus();
}

function stopEditing() {
  if (!editing) return;
  editing = false;
  editbox.classList.remove('editing');
  input.stop();
  placeEditbox();
  if (sel) flushCommit(sel.page);
  updateStatus();
}

// pointer: select, shift-click a second box, double-click to edit, drag the selected box or its handles
pagesEl.addEventListener('pointerdown', (e) => {
  if (!editor) return;
  const t = e.target as HTMLElement;
  if (editbox.contains(t)) return;                     // the edit box handles its own
  const pageEl = t.closest<HTMLDivElement>('.page');
  const frame = t.closest<HTMLDivElement>('.frame');
  if (frame && pageEl) {
    const n = Number(pageEl.dataset.n), id = frame.dataset.id!;
    e.preventDefault();
    if (e.shiftKey && sel && sel.page === n && id !== sel.id) {
      const old = second;
      second = second === id ? null : id;
      for (const x of [old, second]) { const b = x ? findBox(n, x) : null; if (b) updateFrame(views[n], b); }
      updatePanel();
      return;
    }
    select(n, id);
    return;
  }
  if (sel) deselect();
});
viewer.addEventListener('pointerdown', (e) => {
  if (e.target === viewer || e.target === pagesEl) { if (sel) deselect(); }
});
viewer.addEventListener('dblclick', (e) => {
  if (!sel) return;
  const r = editbox.getBoundingClientRect();
  if ((e.target as HTMLElement).closest('.h')) return;
  if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
    if (!editing) { e.preventDefault(); startEditing(e.clientX, e.clientY); }
  }
});

type Drag = { h: string; x: number; y: number; frame: Rect; shown: Rect; pinned: boolean; first: boolean; page: number; id: string; vertical: boolean; started: boolean; pointer: number };
let drag: Drag | null = null;
editbox.addEventListener('pointerdown', (e) => {
  if (!editor || !sel) return;
  const t = e.target as HTMLElement;
  const hnd = t.dataset?.h ?? (editing ? null : 'body');
  if (!hnd) { input.pointerDown(e, editbox); return; }   // inside the text while editing: the caret, a selection
  if (hnd === 'body' && e.detail > 1) return;          // the second click of a double-click
  e.preventDefault();
  const b = findBox(sel.page, sel.id)!;
  drag = { h: hnd === 'body' ? 'move' : hnd, x: e.clientX, y: e.clientY, frame: { ...b.frame }, shown: { ...laidFn(sel.page)(b).frame },
    pinned: b.heightPinned, first: true, page: sel.page, id: sel.id, vertical: !!b.vertical, started: hnd !== 'body', pointer: e.pointerId };
  if (drag.started) t.setPointerCapture(e.pointerId);
});
editbox.addEventListener('pointermove', (e) => {
  if (input.pointerMove(e)) return;
  if (!drag || !editor) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
    drag.started = true;
    editbox.setPointerCapture(drag.pointer);
  }
  const z = Z();
  const dx = (e.clientX - drag.x) / z, dy = (e.clientY - drag.y) / z;   // points; dy down
  const f = drag.frame, s = drag.shown, k = drag.h;
  let r: Rect;
  let pin = drag.pinned;
  if (k === 'move') {
    r = drag.vertical ? { x0: s.x0 + dx, x1: s.x1 + dx, y0: f.y0 - dy, y1: f.y1 - dy } : { x0: f.x0 + dx, x1: f.x1 + dx, y0: f.y0 - dy, y1: f.y1 - dy };
  } else if (drag.vertical) {
    // columns hang from the right edge; the frame's height is the column length; its width follows the stack
    r = { ...s, y0: f.y0, y1: f.y1 };
    if (k.includes('e')) { r.x1 = Math.max(s.x0 + 4, s.x1 + dx); if (!pin) r.x0 = r.x1 - (s.x1 - s.x0); }
    if (k.includes('w')) { r.x0 = Math.min(s.x1 - 4, s.x0 + dx); pin = true; }
    if (k.includes('s')) r.y0 = Math.min(f.y1 - 4, f.y0 - dy);
    if (k.includes('n')) r.y1 = Math.max(f.y0 + 4, f.y1 - dy);
  } else {
    r = { ...f };
    if (k.includes('e')) r.x1 = Math.max(f.x0 + 4, f.x1 + dx);
    if (k.includes('w')) r.x0 = Math.min(f.x1 - 4, f.x0 + dx);
    if (k.includes('s')) { r.y0 = Math.min(s.y1 - 4, s.y0 - dy); pin = true; }
    if (k.includes('n')) { r.y1 = Math.max(s.y0 + 4, f.y1 - dy); if (!k.includes('s')) r.y0 = s.y0; pin = true; }
  }
  editor.setFrame(drag.page, drag.id, r, { merge: !drag.first, pinHeight: pin });
  drag.first = false;
});
const endDrag = () => { drag = null; input.pointerUp(); };
editbox.addEventListener('pointerup', endDrag);
editbox.addEventListener('pointercancel', endDrag);

// ── edits: lay out, redraw, frames, input, commit scheduling ────────────────────────────────────────────────
function onChange(c: Change) {
  const v = views[c.page];
  globalVersion++;
  if (c.how === 'do') history?.onDo();
  if (!v) return;
  const page = pageOf(c.page)!;
  const structural = c.edit.kind === 'split' || c.edit.kind === 'merge' || c.edit.kind === 'fit';
  v.version++;
  for (const id of c.boxes) v.dirty.add(id);
  if (structural) v.structural = true;
  if (c.edit.kind === 'fit' && c.how === 'undo') v.fit = null;
  if (v.inflight) send({ kind: 'invalidate', n: v.n, version: v.version });
  scheduleCommit(v, IDLE_MS);
  // draw: incrementally when the base stays, from scratch when it switches (committed ↔ original) or on a fit
  const want = useCommit(v) ? 'commit' : 'orig';
  if (v.overlay && want === v.mode && !structural) v.overlay.redraw(page, c.boxes, laidFn(c.page));
  else paint(v);
  if (structural) buildFrames(v);
  else for (const id of c.boxes) { const b = page.boxes.find((x) => x.id === id); if (b) updateFrame(v, b); }
  if (sel && sel.page === c.page) {
    const b = page.boxes.find((x) => x.id === sel!.id);
    if (!b) deselect();
    else {
      focusPara = Math.min(focusPara, b.paragraphs.length - 1);
      placeEditbox();
      if (editing && c.boxes.includes(sel.id)) input.sync();
    }
  }
  if (c.how !== 'do' && c.page !== current && !views[c.page].visible) scrollToPage(c.page);
  updatePanel();
  updateStatus();
}

function scheduleCommit(v: PageView, ms: number) {
  clearTimeout(v.timer);
  v.timer = window.setTimeout(() => commit(v), ms);
}

/** Commit soon (editing ended), if the page has changes the committed render does not show. */
function flushCommit(n: number) {
  const v = views[n];
  if (v && v.committedVersion !== v.version) scheduleCommit(v, 30);
}

function commit(v: PageView) {
  clearTimeout(v.timer);
  v.timer = 0;
  const page = pageOf(v.n);
  if (!page || !editor) return;
  if (v.committedVersion === v.version) return;
  if (v.inflight && v.inflight.version === v.version) return;
  const edited = page.boxes.filter((b) => b.edited);
  if (!edited.length) {
    // nothing left to write: the original render is the page
    v.committed = null; v.commit = null; v.dirty.clear(); v.structural = false; v.refused.clear(); v.failures = [];
    v.committedVersion = v.version; v.inflight = null;
    paint(v); updateFrames(v); requestThumb(v); updateStatus();
    return;
  }
  const id = ++commitSeq;
  const L = laidFn(v.n);
  v.inflight = { id, version: v.version, rects: new Map(edited.map((b) => [b.id, drawnRect(b, L(b))])), ids: new Set(page.boxes.map((b) => b.id)) };
  send({ kind: 'commit', n: v.n, id, version: v.version, page, scale: scaleFor(v) });
  updateStatus();
}

function onCommitted(m: CommitResult) {
  const v = views[m.n];
  if (!v) return;
  const fl = v.inflight;
  if (!fl || fl.id !== m.id) return;
  v.inflight = null;
  if (m.stale || fl.version !== v.version) { updateStatus(); return; }   // a newer edit: its own commit is scheduled
  stats.commits++;
  stats.commitMs.push(m.ms);
  v.committedVersion = fl.version;
  v.refused = new Map(m.skipped.map((s) => [s.box, s.reason]));
  v.failures = [];
  for (const f of m.failures) {
    const r = /^page \d+, box (\S+?): (.*)$/.exec(f);
    if (r) v.refused.set(r[1], r[2]);
    else v.failures.push(f.replace(/^page \d+: /, ''));
  }
  if (m.rgba && m.width && m.height) {
    v.committed = { id: m.id, rects: fl.rects, ids: fl.ids };
    v.commit = { img: new ImageData(new Uint8ClampedArray(m.rgba), m.width, m.height), scale: m.scale };
    v.dirty.clear();
    v.structural = false;
  } else {
    // nothing was written (the file was refused): the preview stays
    v.committed = null; v.commit = null;
  }
  paint(v);
  updateFrames(v);
  requestThumb(v);
  ensureRender(v);
  updateStatus();
}

type PageState = { kind: 'none' | 'preview' | 'rendering' | 'rendered' | 'refused'; text: string };
function pageState(v: PageView): PageState {
  const page = pageOf(v.n);
  if (!page) return { kind: 'none', text: '' };
  const edited = page.boxes.some((b) => b.edited);
  if (v.inflight && v.inflight.version === v.version) return { kind: 'rendering', text: 'rendering…' };
  if (v.committedVersion === v.version) {
    const why = [...v.refused].map(([id, r]) => `${id}: ${r}`)[0] ?? v.failures[0];
    if (why) return { kind: 'refused', text: `export refused: ${why}` };
    if (!edited) return { kind: 'none', text: v.version ? 'original' : 'no edits' };
    return { kind: 'rendered', text: 'rendered' };
  }
  return { kind: 'preview', text: 'preview' };
}

// ── toolbar, panel, status ──────────────────────────────────────────────────────────────────────────────────
const hex = (c: [number, number, number]) => '#' + c.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
const unhex = (s: string): [number, number, number] => [1, 3, 5].map((k) => parseInt(s.slice(k, k + 2), 16) / 255) as [number, number, number];
const r2 = (x: number) => String(Math.round(x * 100) / 100);
const setVal = (el: HTMLInputElement, x: string) => { if (document.activeElement !== el) el.value = x; };

function updateAll() { updatePanel(); updateStatus(); }

function updatePanel() {
  ui.undo.disabled = !editor?.canUndo;
  ui.redo.disabled = !editor?.canRedo;
  const anyEdited = !!doc && doc.pages.some((p) => p?.boxes.some((b) => b.edited));
  ui.fitAll.disabled = !anyEdited;
  ui.fitThis.disabled = !pageOf(sel?.page ?? current)?.boxes.some((b) => b.edited);
  ui.export.disabled = !doc || exportPending > 0;
  if (!sel || !editor || !fonts) { ui.typo.setAttribute('aria-disabled', 'true'); return; }
  const b = findBox(sel.page, sel.id);
  if (!b) return;
  ui.typo.setAttribute('aria-disabled', 'false');
  const pi = Math.min(focusPara, b.paragraphs.length - 1);
  const p = b.paragraphs[pi];
  const r = p.runs[0];
  for (const btn of ui.scope.querySelectorAll<HTMLButtonElement>('button')) btn.setAttribute('aria-pressed', String(btn.dataset.v === scope));
  ui.paraN.textContent = `${pi + 1}/${b.paragraphs.length}`;
  // font: the run's own choice, and what the model sets it in
  const resolved = fonts.resolve(r).font.name;
  const docFont = r.font.source === 'document' ? r.font.name : r.font.from;
  const cjk = hasCjk(r.text);
  const picked = r.font.source === 'shipped' && !r.font.from ? r.font.name : 'auto';   // a face the user chose
  const key = `${docFont}|${cjk}|${r.bold}|${r.italic}|${resolved}|${picked}`;
  if (key !== fontListKey) {
    fontListKey = key;
    const groups = faceGroups(docFont, { bold: r.bold, italic: r.italic, serif: r.font.serif, cjk });
    const opt = (o: { value: string; label: string }) => h('option', { value: o.value }, o.label);
    const known = new Set(groups.flatMap((g) => g.options.map((o) => o.value)));
    ui.font.replaceChildren(
      h('option', { value: 'auto' }, `Automatic: ${faceLabel(resolved)}`),
      ...groups.map((g) => { const og = document.createElement('optgroup'); og.label = g.label; og.append(...g.options.map(opt)); return og; }),
      (() => { const og = document.createElement('optgroup'); og.label = 'Default faces'; og.append(...Object.entries(FACES).map(([value, label]) => opt({ value, label }))); return og; })(),
      ...(picked !== 'auto' && !known.has(picked) && !(picked in FACES) ? [opt({ value: picked, label: faceLabel(picked) })] : []),
    );
  }
  ui.font.value = picked;
  const srcFont = docFont ? docFont.replace(/^[A-Z]{6}\+/, '') : null;
  ui.fontNote.textContent = `Set in ${faceLabel(resolved)}` + (picked === 'auto' && srcFont ? `, matched to the document's ${srcFont}` :
    picked !== 'auto' && picked !== resolved ? ' (the chosen face lacks these characters)' : '');
  setVal(ui.size, r2(r.size));
  ui.bold.setAttribute('aria-pressed', String(r.bold));
  ui.italic.setAttribute('aria-pressed', String(r.italic));
  ui.underline.setAttribute('aria-pressed', String(r.underline));
  setVal(ui.color, hex(r.color));
  for (const btn of ui.align.querySelectorAll<HTMLButtonElement>('button')) btn.setAttribute('aria-pressed', String(btn.dataset.v === p.align));
  setVal(ui.leading, r2(p.leading));
  setVal(ui.spacing, r2(r.charSpacing));
  setVal(ui.spaceBefore, r2(p.spaceBefore));
  setVal(ui.spaceAfter, r2(p.spaceAfter));
  setVal(ui.indent, r2(p.indent));
  const L = laidFn(sel.page)(b);
  const pg = pageOf(sel.page)!;
  setVal(ui.bx, r2(L.frame.x0));
  setVal(ui.by, r2(pg.h - L.frame.y1));
  setVal(ui.bw, r2(L.frame.x1 - L.frame.x0));
  setVal(ui.bh, r2(L.frame.y1 - L.frame.y0));
  ui.pin.checked = b.heightPinned;
  ui.merge.disabled = !second;
  ui.merge.textContent = second ? `Merge ${second}` : 'Merge';
  const unfit = views[sel.page]?.fit?.boxes.find((x) => x.box === b.id && x.result === 'unfit');
  ui.boxinfo.textContent = `${b.id} · ${b.kind}${b.vertical ? ' · vertical' : ''} · ${b.paragraphs.length} paragraph${b.paragraphs.length === 1 ? '' : 's'}` +
    (b.edited ? ' · edited' : '') + (L.overflow ? ' · text overflows' : '') + (unfit ? ` · unfit by about ${unfit.charsOver} characters` : '') +
    (views[sel.page]?.refused.get(b.id) ? ` · export refused: ${views[sel.page].refused.get(b.id)}` : '');
}

function updateStatus() {
  ui.stZoom.textContent = `${Math.round(zoom * 100)}%`;
  const v = views[current];
  if (document.activeElement !== ui.pageno) ui.pageno.value = String(current + 1);
  ui.stDetect.textContent = v?.detectMs !== null && v?.detectMs !== undefined
    ? `detection ${v.detectMs} ms · ${pageOf(v.n)?.boxes.length ?? 0} boxes` : 'detection –';
  if (editor && doc) {
    const editedBoxes = doc.pages.reduce((k, p) => k + (p?.boxes.filter((b) => b.edited).length ?? 0), 0);
    const editedPages = doc.pages.filter((p) => p?.boxes.some((b) => b.edited)).length;
    const steps = history?.steps ?? 0;
    ui.stEdits.textContent = steps === 0 && !editedBoxes ? 'no edits'
      : `${steps} edit${steps === 1 ? '' : 's'} · ${editedBoxes} box${editedBoxes === 1 ? '' : 'es'} on ${editedPages} page${editedPages === 1 ? '' : 's'}` +
        (exportedVersion === globalVersion ? ' · exported' : editedBoxes ? ' · not exported' : '') + (editing ? ' · editing text' : '');
  } else ui.stEdits.textContent = 'no document';
  // the page state of the selected box's page, else of the current page
  const sv = views[sel?.page ?? current];
  const st = sv ? pageState(sv) : { kind: 'none', text: '' };
  ui.stCommit.hidden = !st.text;
  ui.stCommit.className = `chip ${st.kind}`;
  ui.stCommit.textContent = sv && st.text ? (views.length > 1 ? `p${sv.n + 1}: ${st.text}` : st.text) : '';
  ui.stCommit.title = st.text;
  for (const x of views) {
    const s = pageState(x);
    x.thumbDot.className = `dot ${s.kind === 'none' ? '' : s.kind}`;
    x.thumb.classList.toggle('current', x.n === current);
  }
  ui.undo.disabled = !editor?.canUndo;
  ui.redo.disabled = !editor?.canRedo;
}

function style(patch: StylePatch, merge = false) {
  if (!editor || !sel) return;
  try { editor.setStyle(sel.page, sel.id, scope === 'para' ? focusPara : null, patch, { merge }); } catch (err) { msg(String((err as Error).message)); }
}
const num = (el: HTMLInputElement) => { const x = Number(el.value); return el.value.trim() !== '' && Number.isFinite(x) ? x : null; };

ui.scope.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (b?.dataset.v) { scope = b.dataset.v as 'box' | 'para'; updatePanel(); }
});
ui.font.addEventListener('change', () => {
  if (!sel) return;
  const b = findBox(sel.page, sel.id);
  if (!b) return;
  const r = b.paragraphs[Math.min(focusPara, b.paragraphs.length - 1)].runs[0];
  const val = ui.font.value;
  if (val === 'auto') { style({ font: substituteRef({ text: r.text, bold: r.bold, italic: r.italic, font: r.font }) }); return; }
  const cat = parseCatalogFaceId(val);
  if (cat) {
    // a catalogue face: load its file first (from this build's assets), then set the run in it
    void fonts?.ensure([cat.file]).then((ok) => {
      if (!ok.has(cat.file)) { msg(`${faceLabel(val)} is not available in this build.`); return; }
      const w = cat.variations?.wght ?? (/Bold/.test(cat.file) ? 700 : 400);
      style({ font: { source: 'shipped', name: val, bold: w >= 600, italic: /Italic/.test(cat.file), serif: false }, bold: w >= 600 });
    });
    return;
  }
  const bold = /Bold|700/.test(val);
  const font: FontRef = { source: 'shipped', name: val, bold, italic: r.italic, serif: false };
  style({ font, bold });
});
ui.size.addEventListener('input', () => { const x = num(ui.size); if (x && x > 0) style({ size: x }, true); });
ui.leading.addEventListener('input', () => { const x = num(ui.leading); if (x && x > 0) style({ leading: x }, true); });
ui.spacing.addEventListener('input', () => { const x = num(ui.spacing); if (x !== null) style({ charSpacing: x }, true); });
ui.spaceBefore.addEventListener('input', () => { const x = num(ui.spaceBefore); if (x !== null) style({ spaceBefore: x }, true); });
ui.spaceAfter.addEventListener('input', () => { const x = num(ui.spaceAfter); if (x !== null) style({ spaceAfter: x }, true); });
ui.indent.addEventListener('input', () => { const x = num(ui.indent); if (x !== null) style({ indent: x }, true); });
ui.color.addEventListener('input', () => style({ color: unhex(ui.color.value) }, true));
ui.bold.addEventListener('click', () => style({ bold: ui.bold.getAttribute('aria-pressed') !== 'true' }));
ui.underline.addEventListener('click', () => style({ underline: ui.underline.getAttribute('aria-pressed') !== 'true' }));
ui.align.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
  if (b?.dataset.v) style({ align: b.dataset.v as 'left' });
});
ui.resetSpacing.addEventListener('click', () => { if (editor && sel) editor.resetCharSpacing(sel.page, sel.id); });
ui.pin.addEventListener('change', () => { if (editor && sel) editor.setHeightPinned(sel.page, sel.id, ui.pin.checked); });
function frameInput() {
  if (!editor || !sel) return;
  const b = findBox(sel.page, sel.id);
  const pg = pageOf(sel.page);
  if (!b || !pg) return;
  const L = laidFn(sel.page)(b).frame;
  const x = num(ui.bx) ?? L.x0, y = num(ui.by) ?? pg.h - L.y1, w = Math.max(4, num(ui.bw) ?? L.x1 - L.x0), hh = Math.max(4, num(ui.bh) ?? L.y1 - L.y0);
  const heightChanged = Math.abs(hh - (L.y1 - L.y0)) > 0.005;
  const y1 = pg.h - y;
  const r: Rect = b.vertical
    ? { x0: x, x1: x + w, y1, y0: y1 - (b.frame.y1 - b.frame.y0 + (heightChanged ? hh - (L.y1 - L.y0) : 0)) }
    : { x0: x, x1: x + w, y1, y0: y1 - (heightChanged ? hh : b.frame.y1 - b.frame.y0) };
  editor.setFrame(sel.page, sel.id, r, { pinHeight: b.vertical ? (Math.abs(w - (L.x1 - L.x0)) > 0.005 || b.heightPinned) : (heightChanged || b.heightPinned) });
}
for (const el of [ui.bx, ui.by, ui.bw, ui.bh]) el.addEventListener('change', frameInput);
ui.split.addEventListener('click', () => {
  if (!editor || !sel) return;
  const b = findBox(sel.page, sel.id);
  if (!b) return;
  const at = input.pos?.para === focusPara ? input.pos.off : null;
  try {
    let id: string | null = null;
    if (at !== null && at > 0 && at < paraText(b, focusPara).length) id = editor.splitBox(sel.page, sel.id, focusPara, at);
    else if (focusPara > 0) id = editor.splitBox(sel.page, sel.id, focusPara);
    else if (b.paragraphs.length > 1) id = editor.splitBox(sel.page, sel.id, 1);
    else msg('Double-click the box and put the caret where it should split.');
    if (id) msg(`Split: the second part is ${id}.`);
  } catch (err) { msg(String((err as Error).message)); }
});
ui.merge.addEventListener('click', () => {
  if (!editor || !sel || !second) return;
  try { const s = second; editor.mergeBoxes(sel.page, sel.id, s); second = null; msg(`${s} merged into ${sel.id}.`); } catch (err) { msg(String((err as Error).message)); }
});
ui.undo.addEventListener('click', () => history?.undo());
ui.redo.addEventListener('click', () => history?.redo());

/** Delete on a selected box: its text cleared, one undo step. */
function clearText() {
  if (!editor || !history || !sel) return;
  const b = findBox(sel.page, sel.id);
  if (!b) return;
  const { page, id } = sel;
  input.breakMerge();
  history.group(() => b.paragraphs.forEach((_, i) => editor!.setText(page, id, i, '')));
  msg(`Text of ${id} cleared (Ctrl+Z brings it back).`);
}

function nudge(dx: number, dy: number) {
  if (!editor || !sel) return;
  const b = findBox(sel.page, sel.id);
  if (!b) return;
  const now = Date.now();
  const merge = lastNudge.box === sel.id && now - lastNudge.at < 1000;
  lastNudge = { box: sel.id, at: now };
  const f = b.frame;
  editor.setFrame(sel.page, sel.id, { x0: f.x0 + dx, x1: f.x1 + dx, y0: f.y0 + dy, y1: f.y1 + dy }, { merge });
}

// ── fit ─────────────────────────────────────────────────────────────────────────────────────────────────────
function runFit(pages: number[]) {
  if (!editor || !history) return;
  if (editing) stopEditing();
  const ed = editor;
  const reports = history.group(() => pages.map((n) => ed.fitPage(n)));
  for (const r of reports) { const v = views[r.page]; if (v) { v.fit = r; updateFrames(v); } }
  lastFit = reports;
  ui.fitBody.replaceChildren(fitReportView(reports));
  const unfit = reports.reduce((k, r) => k + r.boxes.filter((b) => b.result === 'unfit').length, 0);
  msg(`Fit ${reports.length} page${reports.length === 1 ? '' : 's'}: ${unfit ? `${unfit} box${unfit === 1 ? '' : 'es'} still unfit (outlined in red)` : 'everything fits'}.`);
  (window as unknown as { __fit: FitReport[] }).__fit = reports;
  updatePanel();
}
ui.fitThis.addEventListener('click', () => {
  const n = sel?.page ?? current;
  if (!pageOf(n)?.boxes.some((b) => b.edited)) { msg(`Nothing is edited on page ${n + 1}.`); return; }
  runFit([n]);
});
ui.fitAll.addEventListener('click', () => {
  if (!doc) return;
  runFit(doc.pages.map((p, n) => (p?.boxes.some((b) => b.edited) ? n : -1)).filter((n) => n >= 0));
});
const reportClick = (e: Event) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-box]');
  if (!b) return;
  const n = Number(b.dataset.page);
  scrollToPage(n);
  select(n, b.dataset.box!);
};
ui.fitBody.addEventListener('click', reportClick);
ui.exportBody.addEventListener('click', reportClick);

// ── export ──────────────────────────────────────────────────────────────────────────────────────────────────
ui.export.addEventListener('click', () => {
  if (!doc) return;
  if (editing) stopEditing();
  exportPending = ++exportSeq;
  exportedVersion = -1;
  const at = globalVersion;
  pendingExportVersion = at;
  ui.export.disabled = true;
  ui.export.textContent = 'Exporting…';
  ui.exportBody.replaceChildren(h('p', { class: 'muted' }, 'Writing and verifying…'));
  send({ kind: 'export', id: exportPending, doc: { pages: doc.pages } });
});
function onExported(m: Extract<Res, { kind: 'exported' }>) {
  if (m.id !== exportPending) return;
  exportPending = 0;
  ui.export.textContent = 'Export PDF';
  ui.exportBody.replaceChildren(exportReportView(m.report, m.error));
  lastExport = { report: m.report, error: m.error, bytes: m.bytes?.byteLength ?? 0 };
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = null;
  ui.download.hidden = true;
  if (m.bytes) {
    downloadUrl = URL.createObjectURL(new Blob([m.bytes], { type: 'application/pdf' }));
    const name = `${fileName.replace(/\.pdf$/i, '') || 'document'}-edited.pdf`;
    ui.download.href = downloadUrl;
    ui.download.download = name;
    ui.download.textContent = m.report?.ok ? `Download ${name}` : `Download anyway (${name})`;
    ui.download.title = m.report?.ok ? 'The verified export' : 'Verification failed: see the export report';
    ui.download.hidden = false;
    exportedVersion = pendingExportVersion;
    const r = m.report;
    msg(r?.ok ? `Exported: ${r.pages.reduce((k, p) => k + p.written.length, 0)} boxes written, verified.` : `Export finished with problems: ${r?.failures[0] ?? m.error}`);
  } else msg(`Export failed: ${m.report?.failures[0] ?? m.error ?? 'unknown error'}`);
  updateAll();
}

// ── zoom and scrolling ──────────────────────────────────────────────────────────────────────────────────────
let zoomTimer = 0;
function setZoom(z: number, anchor?: { x: number; y: number }) {
  z = clamp(Math.round(z * 1000) / 1000, ZMIN, ZMAX);
  if (near(z, zoom) || !views.length) { zoom = z; syncZoomUi(); updateStatus(); return; }
  const vr = viewer.getBoundingClientRect();
  const ax = anchor?.x ?? vr.left + vr.width / 2, ay = anchor?.y ?? vr.top + vr.height / 2;
  let ref: { v: PageView; fx: number; fy: number } | null = null;
  for (const v of views) {
    const r = v.el.getBoundingClientRect();
    if (ay >= r.top - 9 && ay <= r.bottom + 9) { ref = { v, fx: (ax - r.left) / r.width, fy: (ay - r.top) / r.height }; break; }
  }
  zoom = z;
  for (const v of views) sizePage(v);
  if (ref) {
    const r = ref.v.el.getBoundingClientRect();
    viewer.scrollTop += r.top + ref.fy * r.height - ay;
    viewer.scrollLeft += r.left + ref.fx * r.width - ax;
  }
  if (sel) placeEditbox();
  syncZoomUi();
  updateStatus();
  clearTimeout(zoomTimer);
  zoomTimer = window.setTimeout(() => { for (const v of views) ensureRender(v); }, 160);
}

function syncZoomUi() {
  const pct = Math.round(zoom * 100);
  const opts = ZOOMS.map((x) => Math.round(x * 100));
  const all = opts.includes(pct) ? opts : [...opts, pct].sort((a, b) => a - b);
  ui.zoomSel.replaceChildren(...all.map((p) => h('option', { value: String(p / 100) }, `${p}%`)));
  ui.zoomSel.value = String(pct / 100);
  ui.zoomOut.disabled = zoom <= ZMIN + 1e-6;
  ui.zoomIn.disabled = zoom >= ZMAX - 1e-6;
}

const stepZoom = (dir: 1 | -1) => {
  const next = dir > 0 ? ZOOMS.find((x) => x > zoom + 1e-3) ?? ZMAX : [...ZOOMS].reverse().find((x) => x < zoom - 1e-3) ?? ZMIN;
  setZoom(next);
};
function fitWidthZoom(): number {
  const maxW = Math.max(...views.map((v) => v.w), 1);
  return (viewer.clientWidth - 56) / (maxW * PT);
}
ui.zoomIn.addEventListener('click', () => stepZoom(1));
ui.zoomOut.addEventListener('click', () => stepZoom(-1));
ui.zoomSel.addEventListener('change', () => setZoom(Number(ui.zoomSel.value)));
ui.fitWidth.addEventListener('click', () => setZoom(fitWidthZoom()));
ui.fitPageZoom.addEventListener('click', () => {
  const v = views[current];
  if (!v) return;
  setZoom(Math.min((viewer.clientWidth - 56) / (v.w * PT), (viewer.clientHeight - 48) / (v.h * PT)));
  scrollToPage(current);
});
viewer.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !views.length) return;
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
}, { passive: false });

function scrollToPage(n: number) {
  const v = views[n];
  if (!v) return;
  viewer.scrollTop += v.el.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 16;
  current = n;
  updateStatus();
}
ui.pageno.addEventListener('change', () => scrollToPage(clamp((Number(ui.pageno.value) || 1) - 1, 0, views.length - 1)));

let scrollRaf = 0;
viewer.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const vr = viewer.getBoundingClientRect();
    const mid = vr.top + vr.height / 3;
    let best = current, bestD = Infinity;
    for (const v of views) {
      if (!v.visible) continue;
      const r = v.el.getBoundingClientRect();
      const d = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (d < bestD) { bestD = d; best = v.n; }
    }
    if (best !== current) {
      current = best;
      updateStatus();
      updatePanel();
      const t = views[current].thumb, tr = t.getBoundingClientRect(), sr = thumbsEl.getBoundingClientRect();
      if (tr.top < sr.top || tr.bottom > sr.bottom) t.scrollIntoView({ block: 'nearest' });
    }
  });
});

// ── keyboard ────────────────────────────────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const t = e.target as HTMLElement;
  const inField = !!t.closest('input, select, textarea') && !editbox.contains(t);
  const k = e.key.toLowerCase();
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); stepZoom(1); return; }
  if (mod && k === '-') { e.preventDefault(); stepZoom(-1); return; }
  if (mod && k === '0') { e.preventDefault(); setZoom(1); return; }
  if (!editor || !history) return;
  if (mod && k === 'z' && !inField) { e.preventDefault(); if (e.shiftKey) history.redo(); else history.undo(); return; }
  if (mod && k === 'y' && !inField) { e.preventDefault(); history.redo(); return; }
  if (e.key === 'Escape') {
    if (editing) { e.preventDefault(); stopEditing(); } else if (sel && !inField) deselect();
    return;
  }
  if (!sel || editing || inField || mod) return;
  const step = e.shiftKey ? 10 : 1;
  if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(-step, 0); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); nudge(step, 0); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(0, step); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(0, -step); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearText(); }
  else if (e.key === 'Enter') { e.preventDefault(); startEditing(); }
});

// ── the page's hooks for the headless check (scripts/app-smoke.ts) ──────────────────────────────────────────
const debug = {
  get ready() { return !!editor && views.length > 0; },
  get doc() { return doc; }, get editor() { return editor; }, get zoom() { return zoom; }, get selected() { return sel; },
  get editing() { return editing; }, get current() { return current; }, stats,
  get lastFit() { return lastFit; },
  get lastExport() { return lastExport; },
  get downloadName() { return ui.download.hidden ? null : ui.download.download; },
  pageState: (n: number) => (views[n] ? pageState(views[n]) : null),
  rendered: (n: number) => {
    const v = views[n];
    return v ? { orig: v.orig ? { w: v.orig.img.width, scale: v.orig.scale } : null, commit: v.commit ? { w: v.commit.img.width, scale: v.commit.scale } : null,
      mode: v.mode, model: !!pageOf(n), thumb: v.thumbSource, committedVersion: v.committedVersion, version: v.version } : null;
  },
  laid: (n: number, id: string) => { const b = findBox(n, id); return b ? laidFn(n)(b) : null; },
  /** The caret: its paragraph position, its textarea offsets and its client rectangle (null when not editing). */
  caret: () => {
    const pos = input.pos;
    if (!pos) return null;
    const { anchor, focus } = input.selection;
    const r = caretEl.getBoundingClientRect();
    return { pos, anchor, focus, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, hidden: caretEl.hidden };
  },
  select: (n: number, id: string) => select(n, id),
  /** Client-space rectangle of a page rectangle (for real mouse events). */
  clientRect: (n: number, r: Rect) => {
    const v = views[n];
    const pr = v.el.getBoundingClientRect();
    const c = cssRect(v, r);
    return { x: pr.left + c.left, y: pr.top + c.top, w: c.width, h: c.height };
  },
  scrollToPage: (n: number) => scrollToPage(n),
  /** Scrolls a page rectangle into view (near the viewer's top left). */
  reveal: (n: number, r: Rect) => {
    const v = views[n];
    const vr = viewer.getBoundingClientRect(), pr = v.el.getBoundingClientRect();
    const c = cssRect(v, r);
    viewer.scrollTop += pr.top + c.top - vr.top - 80;
    viewer.scrollLeft += pr.left + c.left - vr.left - 80;
  },
  /** Pixels that differ (any channel by more than 24) between the original render and the committed one inside a
   *  page rectangle, when both are at the same scale. */
  diffInside: (n: number, r: Rect) => {
    const v = views[n];
    if (!v?.orig || !v.commit || v.orig.img.width !== v.commit.img.width) return null;
    const a = v.orig.img, b = v.commit.img, k = a.width / v.w;
    const X0 = Math.max(0, Math.floor(r.x0 * k)), X1 = Math.min(a.width, Math.ceil(r.x1 * k));
    const Y0 = Math.max(0, Math.floor((v.h - r.y1) * k)), Y1 = Math.min(a.height, Math.ceil((v.h - r.y0) * k));
    let diff = 0, total = 0;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      const o = (y * a.width + x) * 4;
      total++;
      if (Math.abs(a.data[o] - b.data[o]) > 24 || Math.abs(a.data[o + 1] - b.data[o + 1]) > 24 || Math.abs(a.data[o + 2] - b.data[o + 2]) > 24) diff++;
    }
    return { diff, total };
  },
  /** Painted overlay pixels inside a page rectangle (0 when the page shows the committed render there). */
  overlayPainted: (n: number, r: Rect) => views[n]?.overlay?.paintedIn(r) ?? null,
};
(window as unknown as { __app: typeof debug }).__app = debug;
syncZoomUi();
updateAll();
