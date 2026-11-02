// The standalone editor (app/), headless: builds a synthetic two-page PDF (Helvetica paragraphs, a Japanese line and
// two vertical Japanese columns set with src/text), serves dist-app (build it first:
//   npx vite build app --config app/vite.config.ts --outDir ../dist-app --emptyOutDir),
// opens it in headless Chromium, drops the file on the window, zooms, double-clicks a glyph of an unedited box and checks
// the caret lands at that glyph (the box is drawn by pdfedit on focus, its outline unchanged), types there, makes a new
// paragraph with Enter and a line break with Shift+Enter and checks both survive the commit, undo and redo,
// double-clicks a box and types, leaves the box
// and waits for the page's commit re-render ("rendered": the page bitmap is PDFium's render of the exported page, and
// it differs from the original inside the box), types into a vertical box, fits the page, exports, downloads the
// result and checks in PDFium that the typed text is in it. Every request to another host is aborted and listed.
//   node scripts/app-smoke.ts [out-dir]
// SHOT=<file.png> saves a screenshot of the window after the fit. Playwright comes from PW_CORE (default: the
// playwright-core package), Chromium from CHROME (default: the one Playwright installed). Synthetic text only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPdf, helveticaWidth, paragraphOps, wrap, type DrawOp } from '../src/layout/testkit.ts';
import { filler } from '../src/model/testkit.ts';
import { openPdfium } from '../src/engine/pdfium.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-app');
const OUT = process.argv[2] || (await mkdtemp(join(tmpdir(), 'pdfedit-app-smoke-')));

// ── the synthetic document ──────────────────────────────────────────────────────────────────────────────────
const JA_LINE = '第3四半期の売上高は前年同期比12%増となりました。';
async function syntheticPdf(): Promise<Uint8Array> {
  const measure = await helveticaWidth();
  const para = (text: string, x: number, y: number, width: number, size = 10): DrawOp[] =>
    paragraphOps(wrap(text, width, (s) => measure(s, size)), { x, y, size, leading: size * 1.25, width, measure: (s) => measure(s, size) });
  const p1 = await buildPdf([
    { t: 'text', text: 'Synthetic quarterly report', x: 60, y: 780, size: 18, font: 'helvB' },
    ...para(filler(260, 3), 60, 740, 220),
    ...para(filler(200, 5), 320, 740, 220),
    { t: 'set', text: JA_LINE, x: 60, y: 560, size: 12, face: 'ja' },
    { t: 'vtext', text: '縦書きの文章です。', x: 520, yTop: 520, size: 12 },
    { t: 'vtext', text: '二行目の文字列', x: 504, yTop: 520, size: 12 },
    { t: 'rect', x: 60, y: 380, w: 160, h: 90, fill: [0.85, 0.9, 0.97] },
    ...para(filler(160, 9), 60, 340, 300),
  ]);
  const p2 = await buildPdf([
    { t: 'text', text: 'Second page heading', x: 60, y: 780, size: 16, font: 'helvB' },
    ...para(filler(320, 11), 60, 740, 470),
    ...para(filler(180, 13), 60, 600, 470),
  ]);
  const out = await PDFDocument.create();
  for (const src of [p1, p2]) {
    const d = await PDFDocument.load(src);
    const [pg] = await out.copyPages(d, [0]);
    out.addPage(pg);
  }
  return out.save({ useObjectStreams: false });
}

const pdfBytes = await syntheticPdf();
const inPath = join(OUT, 'synthetic-report.pdf');
await writeFile(inPath, pdfBytes);

// ── serve dist-app ──────────────────────────────────────────────────────────────────────────────────────────
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url || '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const file = join(ROOT, path === '/' || path === '.' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

type R = { x0: number; y0: number; x1: number; y1: number };
type A = any;   // the page's window.__app (app/main.ts debug)
const strip = (s: string) => s.normalize('NFKC').replace(/[\u0002­-]/gu, '').replace(/\s+/gu, '');
const TYPED = ' Zap wok 42 qix';
const TYPED_V = 'テスト';

const blocked = new Set<string>();
const errors: string[] = [];
const summary: Record<string, unknown> = { pdf: inPath };
const checks: Record<string, boolean> = {};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let pageRef: A = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
  await ctx.route('**/*', (r: { request(): { url(): string }; continue(): unknown; abort(): unknown }) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    blocked.add(u); return r.abort();
  });
  const page = await ctx.newPage();
  pageRef = page;
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/`);
  const app = <T>(fn: (a: A, arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([src, x]: [string, unknown]) => (0, eval)(src)((window as any).__app, x), [`(${fn.toString()})`, arg]);
  const waitApp = (fn: (a: A, arg: any) => unknown, arg?: unknown, timeout = 60000) =>
    page.waitForFunction(([src, x]: [string, unknown]) => { const a = (window as any).__app; return !!a && (0, eval)(src)(a, x); }, [`(${fn.toString()})`, arg], { timeout });

  // 1. open: drop the file on the window
  const t0 = Date.now();
  await page.evaluate(async (b64: string) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], 'synthetic-report.pdf', { type: 'application/pdf' }));
    for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, Buffer.from(pdfBytes).toString('base64'));
  await waitApp((a) => a.ready && a.doc.pages[0] && a.rendered(0).orig);
  summary.openMs = Date.now() - t0;
  const pages = await app((a) => a.doc.pages.length);
  await app((a) => a.scrollToPage(1));
  await waitApp((a) => a.doc.pages[1] && a.rendered(1).orig);
  await app((a) => a.scrollToPage(0));
  summary.pages = await app((a) => a.doc.pages.map((p: A, n: number) => ({ n, boxes: p.boxes.length, vertical: p.boxes.filter((b: A) => b.vertical).length,
    locked: p.boxes.filter((b: A) => b.locked).length })));
  checks.opened = pages === 2;

  // 2. zoom: a button, then Ctrl + wheel; the visible page re-renders at the new scale
  const z0 = await app((a) => a.zoom);
  await page.click('#zoom-in');
  await waitApp((a) => Math.abs(a.rendered(0).orig.scale - a.zoom * 96 / 72 * devicePixelRatio) < 1e-6);
  const z1 = await app((a) => a.zoom);
  const vb = await page.locator('#viewer').boundingBox();
  await page.mouse.move(vb.x + vb.width / 2, vb.y + 200);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -120);
  await page.keyboard.up('Control');
  await waitApp((a, z) => a.zoom > z + 1e-6, z1, 5000);
  await waitApp((a) => Math.abs(a.rendered(0).orig.scale - a.zoom * 96 / 72 * devicePixelRatio) < 1e-6);
  const z2 = await app((a) => a.zoom);
  summary.zoom = { start: z0, button: z1, wheel: z2, renderScale: await app((a) => a.rendered(0).orig.scale) };
  checks.zoom = z1 > z0 && z2 > z1;
  summary.thumbs = await app((a) => [0, 1].map((n) => a.rendered(n).thumb));

  // 3a. the caret before any edit: double-click inside a glyph of the second line of an unedited multi-line box; the
  // caret is at that glyph (its offset, and on screen at its pen position), the box is drawn by pdfedit with its frame
  // unchanged, and a typed character lands there
  const probe = await app((a) => {
    const boxes = a.doc.pages[0].boxes.filter((b: A) => !b.locked && !b.vertical && !b.edited && b.paragraphs.length === 1 &&
      !/[　-鿿]/.test(b.paragraphs[0].runs.map((r: A) => r.text).join('')));
    for (const b of boxes) {
      const L = a.laid(0, b.id);
      if (L.lines.length < 3) continue;
      const line = L.lines[1];
      const gs = line.runs.flatMap((r: A) => r.glyphs.map((g: A) => ({ ...g, size: r.size }))).filter((g: A) => g.c >= 0);
      const k = gs.length >> 1;
      const g = gs[k], n = gs[k + 1];
      if (!g || !n || /\s/.test(g.text)) continue;
      const X = line.x + g.p, adv = n.p - g.p;
      return { id: b.id, frame: b.frame, c: g.c, para: line.para, X, clickX: X + 0.3 * adv, clickY: line.baseline + 0.3 * g.size, kept: line.kept };
    }
    return null;
  });
  if (probe) {
    await app((a, t) => a.reveal(0, t.frame), probe);
    const pt = await app((a, t) => a.clientRect(0, { x0: t.clickX, x1: t.clickX, y0: t.clickY, y1: t.clickY }), probe);
    const pen = await app((a, t) => a.clientRect(0, { x0: t.X, x1: t.X, y0: t.clickY, y1: t.clickY }), probe);
    await page.mouse.dblclick(pt.x, pt.y);
    await waitApp((a, id) => a.editing && a.selected?.id === id, probe.id, 5000);
    const c0 = await app((a, id) => ({ caret: a.caret(), edited: a.editor.box(0, id).edited, painted: a.overlayPainted(0, a.laid(0, id).frame),
      laid: a.laid(0, id).frame }), probe.id);
    await page.keyboard.type('Q');
    const after = await app((a, id) => a.editor.box(0, id).paragraphs[0].runs.map((r: A) => r.text).join(''), probe.id);
    const frameSame = ['x0', 'y0', 'x1', 'y1'].every((k) => Math.abs(c0.laid[k] - probe.frame[k]) < 0.5);
    summary.caretBeforeEdit = { box: probe.id, keptLine: probe.kept, expected: { para: probe.para, off: probe.c }, caret: c0.caret?.pos,
      caretX: c0.caret?.rect.x, penX: pen.x, edited: c0.edited, overlayPixels: c0.painted, frameSame, typedAt: after.indexOf('Q') };
    checks.caretAtGlyph = !!c0.caret && c0.caret.pos.para === probe.para && c0.caret.pos.off === probe.c && Math.abs(c0.caret.rect.x + c0.caret.rect.w / 2 - pen.x) < 2;
    checks.focusDrawsBox = !c0.edited && c0.painted > 0 && frameSame;
    checks.typedAtCaret = after.indexOf('Q') === probe.c;

    // 3b. newlines: Enter at the end makes a paragraph, Shift+Enter a line break in it; both survive the commit, undo
    // and redo
    const paras = (a: A, id: string) => a.editor.box(0, id).paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join(''));
    const n0 = (await app(paras, probe.id)).length;
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Nova');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Linea');
    const p1 = await app(paras, probe.id);
    await page.keyboard.press('Escape');
    await waitApp((a) => !a.editing && ['rendered', 'refused'].includes(a.pageState(0).kind), undefined, 60000);
    const p2 = await app(paras, probe.id);
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+z');
    const p3 = await app(paras, probe.id);
    await page.keyboard.press('Control+Shift+z');
    await page.keyboard.press('Control+Shift+z');
    const p4 = await app(paras, probe.id);
    const want = 'Nova\nLinea';
    summary.newlines = { paragraphs: [n0, p1.length, p2.length, p3.length, p4.length], last: [p1, p2, p4].map((p) => p[p.length - 1] === want) };
    checks.newlines = p1.length === n0 + 1 && p1[p1.length - 1] === want && p2.length === n0 + 1 && p2[p2.length - 1] === want &&
      p3.length === n0 && p4.length === n0 + 1 && p4[p4.length - 1] === want;
  } else {
    summary.caretBeforeEdit = null;
    checks.caretAtGlyph = false;
  }

  // 3. a horizontal Latin box: double-click, type, leave
  const target = await app((a) => {
    const boxes = a.doc.pages[0].boxes.filter((b: A) => !b.locked && !b.vertical && !b.edited && !/[　-鿿]/.test(b.paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join('')).join('')));
    boxes.sort((p: A, q: A) => (q.frame.x1 - q.frame.x0) * (q.frame.y1 - q.frame.y0) - (p.frame.x1 - p.frame.x0) * (p.frame.y1 - p.frame.y0));
    const b = boxes.find((x: A) => x.frame.y1 - x.frame.y0 > 20) ?? boxes[0];
    return { id: b.id, frame: b.frame };
  });
  await app((a, t) => a.reveal(0, t.frame), target);
  const cr = await app((a, t) => a.clientRect(0, t.frame), target);
  await page.mouse.dblclick(cr.x + cr.w / 2, cr.y + Math.min(cr.h / 2, 12));
  await waitApp((a) => a.editing, undefined, 5000);
  await page.keyboard.press('Control+End');
  await page.keyboard.type(TYPED);
  const typed = await app((a, id) => {
    const b = a.editor.box(0, id);
    const r = a.stats.reflows.slice().sort((p: number, q: number) => p - q);
    return { text: b.paragraphs.map((p: A) => p.runs.map((x: A) => x.text).join('')).join('\n'), edited: b.edited,
      keystrokes: r.length, p50: r[r.length >> 1], p95: r[Math.floor(r.length * 0.95)], state: a.pageState(0).kind };
  }, target.id);
  checks.typed = typed.text.endsWith(TYPED) && typed.edited;
  checks.previewWhileTyping = typed.state === 'preview' || typed.state === 'rendering';
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');      // and deselect: a selected box is drawn by pdfedit, a committed one is not
  const tLeave = Date.now();
  await waitApp((a) => !a.editing && ['rendered', 'refused'].includes(a.pageState(0).kind), undefined, 60000);
  const commit = await app((a, id) => {
    const L = a.laid(0, id);
    return { state: a.pageState(0), mode: a.rendered(0).mode, diff: a.diffInside(0, L.frame), overlay: a.overlayPainted(0, L.frame), frame: L.frame,
      commitMs: a.stats.commitMs.slice(-1)[0] };
  }, target.id);
  summary.commit = { box: target.id, state: commit.state, mode: commit.mode, diffInside: commit.diff, overlayPixelsInBox: commit.overlay,
    leaveToRenderedMs: Date.now() - tLeave, exportMs: commit.commitMs };
  checks.rendered = commit.state.kind === 'rendered' && commit.mode === 'commit';
  checks.bitmapChanged = !!commit.diff && commit.diff.diff > 50;
  checks.overlayDropped = commit.overlay === 0;
  summary.typing = { box: target.id, keystrokes: typed.keystrokes, p50Ms: typed.p50, p95Ms: typed.p95 };

  // 4. a vertical box: double-click, the input is vertical, type, leave
  const vbox = await app((a) => { const b = a.doc.pages[0].boxes.find((x: A) => x.vertical && !x.locked); return b ? { id: b.id, frame: b.frame } : null; });
  if (vbox) {
    await app((a) => { a.select(0, a.doc.pages[0].boxes[0].id); });   // select something else first: a real switch
    await app((a, t) => a.reveal(0, t.frame), vbox);
    const vr = await app((a, t) => a.clientRect(0, t.frame), vbox);
    await page.mouse.dblclick(vr.x + vr.w / 2, vr.y + vr.h / 2);
    await waitApp((a, id) => a.editing && a.selected?.id === id, vbox.id, 5000);
    // the caret of a vertical box is a bar across the column
    const vc = await app((a) => a.caret());
    const vertical = await page.evaluate(() => document.getElementById('editbox')!.classList.contains('vertical')) && !!vc && vc.rect.w > vc.rect.h;
    await page.keyboard.press('Control+End');
    await page.keyboard.type(TYPED_V);
    const vt = await app((a, id) => a.editor.box(0, id).paragraphs.map((p: A) => p.runs.map((x: A) => x.text).join('')).join(''), vbox.id);
    await page.keyboard.press('Escape');
    await waitApp((a) => !a.editing && ['rendered', 'refused'].includes(a.pageState(0).kind), undefined, 60000);
    summary.vertical = { box: vbox.id, verticalInput: vertical, text: vt, state: await app((a) => a.pageState(0)) };
    checks.vertical = vertical && vt.endsWith(TYPED_V);
  } else {
    summary.vertical = null;
    checks.vertical = false;
  }

  // 4b. keyboard on a selected box: an arrow nudges it, Delete clears its text, and each is one undo step
  await app((a, id) => a.select(0, id), target.id);
  const kb = (a: A, id: string) => { const b = a.editor.box(0, id); return { x0: b.frame.x0, text: b.paragraphs.map((p: A) => p.runs.map((x: A) => x.text).join('')).join('\n') }; };
  const k0 = await app(kb, target.id);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Delete');
  const k1 = await app(kb, target.id);
  await page.keyboard.press('Control+z');
  const k2 = await app(kb, target.id);
  await page.keyboard.press('Control+z');
  const k3 = await app(kb, target.id);
  summary.keyboard = { nudged: k1.x0 - k0.x0, cleared: k1.text === '', undoRestoresText: k2.text === k0.text, undoRestoresFrame: k3.x0 === k0.x0 };
  checks.keyboard = Math.abs(k1.x0 - k0.x0 - 1) < 1e-9 && k1.text === '' && k2.text === k0.text && Math.abs(k2.x0 - k1.x0) < 1e-9 && Math.abs(k3.x0 - k0.x0) < 1e-9;

  // 5. fit this page (the selected box's page)
  await page.click('#fit-this');
  await waitApp((a) => a.lastFit.length > 0, undefined, 10000);
  summary.fit = await app((a) => a.lastFit.map((r: A) => ({ page: r.page, boxes: r.boxes.length, fixed: r.boxes.filter((b: A) => b.result === 'fixed').length,
    fits: r.boxes.filter((b: A) => b.result === 'fits').length, unfit: r.boxes.filter((b: A) => b.result === 'unfit').map((b: A) => ({ box: b.box, charsOver: b.charsOver })),
    pictures: r.pictures.length, ms: r.ms })));
  await waitApp((a) => ['rendered', 'refused'].includes(a.pageState(0).kind), undefined, 60000);
  summary.afterFit = await app((a) => a.pageState(0));
  checks.fit = (summary.fit as A[]).length === 1;
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  // 6. undo and redo across the fit
  const ur = await app((a) => ({ before: a.editor.history.length }));
  await page.keyboard.press('Control+z');
  const afterUndo = await app((a) => ({ len: a.editor.history.length, canRedo: a.editor.canRedo }));
  await page.keyboard.press('Control+Shift+z');
  const afterRedo = await app((a) => ({ len: a.editor.history.length, canRedo: a.editor.canRedo }));
  checks.undoRedo = afterUndo.len === ur.before - 1 && afterUndo.canRedo && afterRedo.len === ur.before && !afterRedo.canRedo;

  // 7. export, download, check the bytes in PDFium
  await page.click('#export');
  await page.waitForSelector('#download:not([hidden])', { timeout: 120000 });
  const rep = await app((a) => {
    const r = a.lastExport.report;
    return r && { ok: r.ok, verified: r.verified, incremental: r.incremental, failures: r.failures, bytesIn: r.bytesIn, bytesOut: r.bytesOut, ms: r.ms,
      pages: r.pages.map((p: A) => ({ page: p.page, written: p.written.map((w: A) => w.box), skipped: p.skipped,
        verify: p.verify && { ok: p.verify.ok, text: p.verify.text, pixelsChangedOutside: p.verify.pixelsChangedOutside } })) };
  });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
  const outPath = join(OUT, dl.suggestedFilename());
  await dl.saveAs(outPath);
  const outBytes = new Uint8Array(await readFile(outPath));
  const P = await openPdfium();
  const d = P.open(outBytes);
  let text0 = '', pagesOut = 0;
  try {
    pagesOut = d.pageCount;
    const pg = d.page(0);
    text0 = pg.chars().map((c) => c.unicode).join('');
    pg.close();
  } finally { d.close(); }
  const incremental = Buffer.from(outBytes.subarray(0, pdfBytes.length)).equals(Buffer.from(pdfBytes));
  summary.export = { report: rep, download: dl.suggestedFilename(), bytes: outBytes.length, pages: pagesOut, incrementalPrefix: incremental,
    typedFound: strip(text0).includes(strip(TYPED)), verticalFound: strip(text0).includes(strip(TYPED_V)) };
  checks.exportOk = !!rep?.ok && rep.verified && rep.incremental;
  checks.download = dl.suggestedFilename() === 'synthetic-report-edited.pdf' && pagesOut === 2 && incremental;
  checks.typedInPdf = strip(text0).includes(strip(TYPED));
  if (probe) checks.newlinesInPdf = strip(text0).includes('NovaLinea');
  checks.verticalInPdf = strip(text0).includes(strip(TYPED_V));
  checks.noErrors = errors.length === 0;
  checks.noOutsideRequests = blocked.size === 0;
} catch (e) {
  errors.push(`smoke: ${(e as Error).message.split('\n')[0]}`);
  if (pageRef) {
    summary.failure = await pageRef.evaluate(() => { const a = (window as any).__app; return a && { selected: a.selected, editing: a.editing, zoom: a.zoom,
      states: [0, 1].map((n) => a.pageState(n)), msg: document.getElementById('st-msg')?.textContent }; }).catch(() => null);
    await pageRef.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}
const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, ...summary, errors, blocked: [...blocked] }, null, 1));
if (!ok) process.exitCode = 1;
