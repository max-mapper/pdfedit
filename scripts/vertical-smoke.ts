// The editor on vertical text and moved pictures, headless. Builds a synthetic page with the text layer
// (src/layout/testkit.ts: two Identity-V columns of synthetic Japanese, Helvetica paragraphs) plus an orange image, serves
// dist-web (build it first: npx vite build web --config web/vite.config.ts --outDir ../dist-web --emptyOutDir), opens
// it in headless Chromium and:
//   1. selects the vertical box: the caret (drawn from the layout, web/textinput.ts) is a bar across the column; types
//      Japanese and Latin into it and checks the model, the caret (in the last laid column), and that the preview drew
//      glyphs, sideways ones too;
//   2. compares the preview's ink inside the laid frame with PDFium's render of what export writes for the same
//      model (done here in Node with the same fonts), over the whole box and around the sideways glyphs;
//   3. drags the vertical box's bottom handle: the column length changes, the height stays unpinned;
//   4. types into the paragraph beside the image and presses "fit page": the fitter moves the image; the preview
//      draws it at its new frame (orange there, masked where it was) with a dashed outline; undo and redo follow.
// Nothing may load from another host.
//   node scripts/vertical-smoke.ts [out.pdf]
// SHOT=<file.png> saves a screenshot of the page after step 4. Playwright from PW_CORE, Chromium from CHROME (default: the one Playwright installed).
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { buildPdf } from '../src/layout/testkit.ts';
import { openPdfium } from '../src/engine/pdfium.ts';
import { detectAndBuild } from '../src/model/build.ts';
import { Editor } from '../src/model/edit.ts';
import { loadFonts } from '../src/model/fonts.ts';
import { exportDoc } from '../src/export/export.ts';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import type { Doc, Rect } from '../src/model/types.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-web');
const pdfPath = process.argv[2] || '/tmp/pdfedit-vertical.pdf';

const LABEL = 'Short label text here for the synthetic page';
const ORANGE = [230, 120, 20];
// the text layer's page, then an orange image (a colour no text has) drawn on it with pdf-lib
const src = await (async () => {
  const bytes = await buildPdf([
    { t: 'vtext', text: '縦書きの文章です。', x: 300, yTop: 500, size: 12 },
    { t: 'vtext', text: '二行目の文字列', x: 285, yTop: 500, size: 12 },
    { t: 'text', text: LABEL, x: 100, y: 702, size: 10 },
    { t: 'text', text: 'Another paragraph below that blocks growth.', x: 100, y: 670, size: 10 },
  ]);
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < 16; i++) png.data.set([...ORANGE, 255], i * 4);
  const doc = await PDFDocument.load(bytes);
  const img = await doc.embedPng(PNG.sync.write(png));
  doc.getPage(0).drawImage(img, { x: 310, y: 600, width: 120, height: 120 });
  return doc.save({ useObjectStreams: false });
})();
await writeFile(pdfPath, src);

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf' };
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

type W = { __rendered?: unknown; __editor?: any; __fit?: any };
const text = (b: { paragraphs: { runs: { text: string }[] }[] }) => b.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
const blocked = new Set<string>();
const checks: Record<string, boolean> = {};
const out: Record<string, unknown> = {};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
  await ctx.route('**/*', (r: { request(): { url(): string }; continue(): unknown; abort(): unknown }) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    blocked.add(u); return r.abort();
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/`);
  await page.setInputFiles('#file', pdfPath);
  await page.waitForFunction(() => (window as W).__rendered && (window as W).__editor, null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);

  // ── 1. the vertical box ──────────────────────────────────────────────────────────────────────────────────
  const v = await page.evaluate(() => {
    const E = (window as W).__editor;
    const b = E.doc.pages[0].boxes.find((x: { vertical: boolean }) => x.vertical);
    if (!b) return null;
    const ok = E.select(b.id);
    const cr = document.getElementById('caret')!.getBoundingClientRect();
    return { id: b.id, ok, locked: b.locked, editboxVertical: document.getElementById('editbox')!.classList.contains('vertical'),
      caretAcross: cr.width > cr.height && cr.width > 4,
      before: b.paragraphs.map((p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join('')).join('\n') };
  });
  if (!v) throw new Error('no vertical box detected on the synthetic page');
  checks.verticalSelected = v.ok && !v.locked && v.editboxVertical && v.caretAcross;
  const typed = '追加した文字列ABCです';
  await page.keyboard.type(typed);
  const after = await page.evaluate((id: string) => {
    const E = (window as W).__editor;
    const b = E.editor.box(E.page, id);
    const L = E.laid(id);
    const cv = document.getElementById('preview') as HTMLCanvasElement;
    const pw = E.doc.pages[0].w, ph = E.doc.pages[0].h, k = cv.width / pw;
    const ctx2 = cv.getContext('2d')!;
    const ink = (r: { x0: number; y0: number; x1: number; y1: number }) => {
      const x = Math.max(0, Math.floor(r.x0 * k)), y = Math.max(0, Math.floor((ph - r.y1) * k));
      const w = Math.max(1, Math.ceil((r.x1 - r.x0) * k)), hh = Math.max(1, Math.ceil((r.y1 - r.y0) * k));
      const px = ctx2.getImageData(x, y, w, hh).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && px[i] + px[i + 1] + px[i + 2] < 300) n++;
      return n;
    };
    // the sideways run's glyph origins, and the region its glyphs cover when turned 90° clockwise (right of the
    // origins by up to an em, down the column by their advances)
    type G = { x: number; y: number; text: string };
    type Ln = { x: number; baseline: number; axis?: number; runs: { size: number; orientation?: string; glyphs: G[] }[] };
    const side = (L.lines as Ln[]).flatMap((l) => l.runs.filter((r) => r.orientation === 'sideways').map((r) => ({ l, r })));
    let sideRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const { l, r } of side) for (const g of r.glyphs) {
      const x = l.x + g.x, y = l.baseline + g.y;
      const q = { x0: x - 0.3 * r.size, x1: x + r.size, y0: y - r.size, y1: y + 0.1 * r.size };
      sideRect = sideRect ? { x0: Math.min(sideRect.x0, q.x0), y0: Math.min(sideRect.y0, q.y0), x1: Math.max(sideRect.x1, q.x1), y1: Math.max(sideRect.y1, q.y1) } : q;
    }
    // the caret against the laid columns: CSS px from the stage's left edge
    const st = document.getElementById('stage')!.getBoundingClientRect();
    const ce = document.getElementById('caret')!;
    const cr = ce.hidden ? null : ce.getBoundingClientRect();
    const eb = document.getElementById('editbox')!.getBoundingClientRect();
    const Z = st.width / pw;
    const axes = (L.lines as Ln[]).map((l) => (l.axis ?? 0) * Z);
    const caretX = cr ? (cr.left + cr.right) / 2 - st.left : NaN;
    const r = E.stats.reflows.slice().sort((p: number, q: number) => p - q);
    return {
      text: b.paragraphs.map((p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join('')).join('\n'),
      edited: b.edited, vertical: L.vertical, columns: L.lines.length, overflow: L.overflow, frame: L.frame, boxFrame: b.frame,
      sideways: side.map(({ r }) => r.glyphs.map((g) => g.text).join('')), ink: ink(L.frame), sidewaysInk: sideRect ? ink(sideRect) : 0, sideRect,
      caret: cr ? { x: caretX, y: (cr.top + cr.bottom) / 2 - st.top, w: cr.width, h: cr.height } : null,
      caretInBox: cr ? cr.left >= eb.left - 2 && cr.right <= eb.right + 2 && cr.top >= eb.top - 2 && cr.bottom <= eb.bottom + 2 : false,
      lastAxisCss: axes[axes.length - 1], caretToLastAxis: cr ? Math.abs(caretX - axes[axes.length - 1]) : NaN,
      lineHeightCss: 1.2 * 12 * Z,
      keystrokes: r.length, p50: r[r.length >> 1], p95: r[Math.floor(r.length * 0.95)],
    };
  }, v.id);
  checks.verticalTyped = after.text === v.before + typed && after.edited && after.vertical === true;
  checks.verticalInk = after.ink > 100 && after.sideways.join('').includes('ABC') && after.sidewaysInk > 20;
  // the caret is inside the edit box and in the last laid column (within half a column of its axis)
  checks.verticalCaret = after.caretInBox && after.caretToLastAxis < after.lineHeightCss / 2;
  out.vertical = { id: v.id, caretAcross: v.caretAcross, ...after, text: undefined };

  // ── 2. preview vs export: ink inside the laid frame, and around the sideways glyphs ─────────────────────────
  {
    const [pv, scale] = await page.evaluate((id: string) => {
      const E = (window as W).__editor;
      const cv = document.getElementById('preview') as HTMLCanvasElement;
      const vw = document.getElementById('view') as HTMLCanvasElement;
      const a = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
      const b = vw.getContext('2d')!.getImageData(0, 0, vw.width, vw.height).data;
      // the preview composited over the page bitmap, as the user sees it
      const dark = new Uint8Array(cv.width * cv.height);
      for (let i = 0; i < dark.length; i++) {
        const al = a[i * 4 + 3] / 255;
        const lum = (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) * al + (b[i * 4] + b[i * 4 + 1] + b[i * 4 + 2]) * (1 - al);
        dark[i] = lum < 384 ? 1 : 0;
      }
      void id;
      return [{ w: cv.width, h: cv.height, dark: Array.from(dark) }, cv.width / E.doc.pages[0].w] as const;
    }, v.id);
    const fonts = await loadFonts();
    const P = await openPdfium();
    const pdf = P.open(src);
    let doc: Doc;
    try { doc = { pages: [detectAndBuild(pdf, 0)] }; } finally { pdf.close(); }
    const ed = new Editor(doc, fonts);
    ed.setText(0, v.id, 0, v.before + typed);
    const laid = ed.laid(0, v.id);
    const { bytes, report } = await exportDoc(src, doc, (n, b) => ed.laid(n, b.id));
    const o = P.open(bytes);
    const pg = o.page(0);
    const bmp = pg.render(scale);
    pg.close(); o.close();
    const H = doc.pages[0].h;
    // ink agreement with a 1-pixel tolerance (antialiasing differs between Skia and PDFium): the share of the
    // preview's dark pixels with an export dark pixel within one pixel, and the other way round; the smaller of the
    // two. `shift` moves the preview sideways by that many pixels: the control, which must agree far less.
    const P2 = (x: number, y: number, dx = 0) => { const X = x - dx; return X >= 0 && X < pv.w && pv.dark[y * pv.w + X] === 1; };
    const E2 = (x: number, y: number) => { const i = (y * bmp.width + x) * 4; return x >= 0 && x < bmp.width && bmp.rgba[i] + bmp.rgba[i + 1] + bmp.rgba[i + 2] < 384; };
    const near = (f: (x: number, y: number) => boolean, x: number, y: number) => {
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (y + j >= 0 && y + j < pv.h && f(x + i, y + j)) return true;
      return false;
    };
    const agree = (r: Rect, shift = 0) => {
      let a = 0, b = 0, am = 0, bm = 0;
      const X0 = Math.max(0, Math.floor(r.x0 * scale)), X1 = Math.min(pv.w, Math.ceil(r.x1 * scale));
      const Y0 = Math.max(0, Math.floor((H - r.y1) * scale)), Y1 = Math.min(pv.h, Math.ceil((H - r.y0) * scale));
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
        if (P2(x, y, shift)) { a++; if (near(E2, x, y)) am++; }
        if (E2(x, y)) { b++; if (near((u, w) => P2(u, w, shift), x, y)) bm++; }
      }
      return +Math.min(a ? am / a : 1, b ? bm / b : 1).toFixed(3);
    };
    const iou = (r: Rect) => {
      let n = 0, a = 0, b = 0, inter = 0, uni = 0;
      const X0 = Math.max(0, Math.floor(r.x0 * scale)), X1 = Math.min(pv.w, Math.ceil(r.x1 * scale));
      const Y0 = Math.max(0, Math.floor((H - r.y1) * scale)), Y1 = Math.min(pv.h, Math.ceil((H - r.y0) * scale));
      for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
        const p = P2(x, y), e = E2(x, y);
        n++; if (p) a++; if (e) b++; if (p && e) inter++; if (p || e) uni++;
      }
      return { agreement: agree(r), control3px: agree(r, 3), iou: uni ? +(inter / uni).toFixed(3) : 1, previewInk: a, exportInk: b, pixels: n };
    };
    const sameLayout = JSON.stringify(laid.frame) === JSON.stringify(after.frame) && laid.lines.length === after.columns;
    const whole = iou(laid.frame);
    const side = iou(after.sideRect ?? { x0: 0, x1: 0, y0: 0, y1: 0 });
    checks.previewMatchesExport = report.ok && sameLayout && bmp.width === pv.w && whole.agreement > 0.95 && side.agreement > 0.95 &&
      whole.control3px < 0.8 && side.control3px < 0.8 && side.exportInk > 20;
    out.previewVsExport = { exportOk: report.ok, sameLayout, whole, sideways: side };
  }

  // ── 3. the bottom handle sets the column length ───────────────────────────────────────────────────────────
  {
    const hb = await page.locator('#editbox .h.s').boundingBox();
    const before = await page.evaluate((id: string) => { const E = (window as W).__editor; return { frame: { ...E.editor.box(E.page, id).frame }, cols: E.laid(id).lines.length }; }, v.id);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 60, { steps: 4 });
    await page.mouse.up();
    const res = await page.evaluate((id: string) => {
      const E = (window as W).__editor;
      const b = E.editor.box(E.page, id), L = E.laid(id);
      const eb = document.getElementById('editbox')!.getBoundingClientRect();
      return { frame: { ...b.frame }, pinned: b.heightPinned, cols: L.lines.length, laidH: L.frame.y1 - L.frame.y0,
        editboxH: eb.height, frameH: E.cssRect(L.frame).height };
    }, v.id);
    const longer = before.frame.y0 - res.frame.y0;
    checks.verticalResize = Math.abs(longer - 40) < 1 && !res.pinned && res.cols <= before.cols && Math.abs(res.laidH - (res.frame.y1 - res.frame.y0)) < 1e-6 &&
      Math.abs(res.frameH - res.editboxH) < 2;
    out.resize = { columnLongerBy: +longer.toFixed(2), columnsBefore: before.cols, columnsAfter: res.cols, pinned: res.pinned, editboxH: res.editboxH, frameH: res.frameH };
  }

  // ── 4. fit page moves the image; the preview draws it there ─────────────────────────────────────────────────
  {
    const lab = await page.evaluate((label: string) => {
      const E = (window as W).__editor;
      const b = E.doc.pages[0].boxes.find((x: { paragraphs: { runs: { text: string }[] }[] }) => x.paragraphs[0].runs[0].text.startsWith(label.slice(0, 10)));
      E.select(b.id);
      return b.id;
    }, LABEL);
    await page.keyboard.type(', now a good deal longer in English than it was before, so it needs room');
    await page.click('#fit');
    // the share of a rectangle the picture's orange covers, as the user sees it (the preview over the page bitmap)
    const orange = (r: Rect) => `((r, C) => {
      const E = window.__editor, cv = document.getElementById('preview'), vw = document.getElementById('view');
      const k = cv.width / E.doc.pages[0].w, H = E.doc.pages[0].h;
      const x = Math.floor(r.x0 * k), y = Math.floor((H - r.y1) * k), w = Math.ceil((r.x1 - r.x0) * k), h = Math.ceil((r.y1 - r.y0) * k);
      const a = cv.getContext('2d').getImageData(x, y, w, h).data, b = vw.getContext('2d').getImageData(x, y, w, h).data;
      let n = 0, g = 0;
      for (let i = 0; i < a.length; i += 4) {
        const al = a[i + 3] / 255, px = [0, 1, 2].map((c) => a[i + c] * al + b[i + c] * (1 - al));
        n++; if (px.every((v, c) => Math.abs(v - C[c]) < 40)) g++;
      }
      return +(g / n).toFixed(3);
    })(${JSON.stringify(r)}, ${JSON.stringify(ORANGE)})`;
    const fit = await page.evaluate(() => {
      const w = window as W, E = w.__editor;
      const pics = (E.doc.pages[0].pictures ?? []).filter((p: { move?: unknown }) => p.move);
      const outline = document.querySelectorAll('#frames .picture.moved');
      const d = outline[0] as HTMLElement | undefined;
      return { boxes: (w.__fit?.boxes ?? []).map((x: { box: string; result: string; actions: string[] }) => `${x.box} ${x.result} ${x.actions.join('+')}`), report: w.__fit?.pictures ?? [], moved: pics.map((p: { id: string; move: unknown }) => ({ id: p.id, move: p.move })),
        outlines: outline.length, outlineStyle: d ? getComputedStyle(d).outlineStyle : null, log: document.getElementById('log')!.textContent };
    });
    const rp = fit.report[0] as { from: Rect; to: Rect } | undefined;
    let newOnly = NaN, oldOnly = NaN, undone = NaN, undoneOutlines = -1, redone = NaN;
    if (rp) {
      // a strip of the new frame outside the old one, and a strip of the old frame outside the new one
      const nf = rp.to, of = rp.from;
      const newStrip = nf.y0 < of.y0 ? { x0: nf.x0 + 4, x1: nf.x1 - 4, y0: nf.y0 + 2, y1: Math.min(nf.y1, of.y0) - 2 } : { x0: nf.x0 + 4, x1: nf.x1 - 4, y0: Math.max(nf.y0, of.y1) + 2, y1: nf.y1 - 2 };
      const oldStrip = nf.y0 < of.y0 ? { x0: of.x0 + 4, x1: of.x1 - 4, y0: Math.max(of.y0, nf.y1) + 2, y1: of.y1 - 2 } : { x0: of.x0 + 4, x1: of.x1 - 4, y0: of.y0 + 2, y1: Math.min(of.y1, nf.y0) - 2 };
      newOnly = await page.evaluate(orange(newStrip));
      oldOnly = await page.evaluate(orange(oldStrip));
      if (process.env.SHOT) await page.locator('#stage').screenshot({ path: process.env.SHOT });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+z');
      undone = await page.evaluate(orange(newStrip));
      undoneOutlines = await page.evaluate(() => document.querySelectorAll('#frames .picture.moved').length);
      await page.keyboard.press('Control+Shift+z');
      redone = await page.evaluate(orange(newStrip));
    }
    checks.pictureMoved = fit.moved.length === 1 && fit.report.length === 1 && fit.outlines === 1 && fit.outlineStyle === 'dashed';
    checks.picturePreview = newOnly > 0.95 && oldOnly < 0.01;
    checks.pictureUndo = undone < 0.01 && undoneOutlines === 0 && redone > 0.95;
    out.picture = { box: lab, ...fit, orangeInNewStrip: newOnly, orangeInOldStrip: oldOnly, afterUndo: { orangeInNewStrip: undone, outlines: undoneOutlines }, afterRedo: { orangeInNewStrip: redone } };
  }

  const ok = Object.values(checks).every(Boolean) && !errors.length && !blocked.size;
  console.log(JSON.stringify({ ok, checks, ...out, errors, blocked: [...blocked] }, null, 1));
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
