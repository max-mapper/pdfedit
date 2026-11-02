// Adding images (app/tools/place.ts), headless: serves dist-app (build it first: npx vite build app --config
// app/vite.config.ts --outDir ../dist-app --emptyOutDir), opens it in headless Chromium, drops a synthetic
// page on the window and checks with real input:
//   - "Add image" picks a PNG with alpha (the file input), placed at the page's centre, selected, drawn over the page
//     until the page's commit render shows it, which then differs from the original inside the frame only;
//   - a JPEG made by the browser's own encoder dropped on the page goes where it is dropped;
//   - Shift+Arrow nudges it by 10 pt, a drag moves it, undo and redo step back and forth, Delete removes it and undo
//     brings it back;
//   - a file over the limits is refused with a message;
//   - export: verified, both images in the report, the JPEG's bytes in the file as they were, the images in PDFium's
//     reading of the output at their frames;
//   - on a page turned by /Rotate 90 with an offset crop box, an image added at the centre shows upright in the
//     export;
//   - "Add image" is there without any flag in the page URL, disabled until a PDF is open, and nothing loads from
//     another host.
//   node scripts/place-smoke.ts [out-dir]
// Playwright comes from PW_CORE (default: the playwright-core package), Chromium from CHROME (default: the one
// Playwright installed). Synthetic material only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { openPdfium } from '../src/engine/pdfium.ts';
import { rectToPixels } from '../src/engine/view.ts';
import { listObjects } from '../src/objects/list.ts';
import { pngHeaderOnly, writePng } from '../src/objects/placekit.ts';
import { objectsPage, rotatedPage } from '../src/objects/testkit.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-app');
const OUT = process.argv[2] || (await mkdtemp(join(tmpdir(), 'pdfedit-place-smoke-')));

type RGB = [number, number, number];
const RED: RGB = [220, 30, 30], GREEN: RGB = [20, 170, 60], BLUE: RGB = [30, 60, 200], YELLOW: RGB = [240, 210, 20];
const quadrant = (fx: number, fy: number): RGB => (fy < 0.5 ? (fx < 0.5 ? RED : GREEN) : fx < 0.5 ? BLUE : YELLOW);
const fx = await objectsPage();
await writeFile(join(OUT, 'objects.pdf'), fx.bytes);
const rot = await rotatedPage(90);
await writeFile(join(OUT, 'rotated.pdf'), rot.bytes);
// 120 × 60 px quadrant PNG; its left 10 columns clear
const png = writePng({ width: 120, height: 60, ctype: 6, depth: 8, pixel: (x, y) => [...quadrant((x + 0.5) / 120, (y + 0.5) / 60), x < 10 ? 0 : 255] });
await writeFile(join(OUT, 'quadrant.png'), png);

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

type A = any;   // the page's window.__app (app/main.ts debug)
type R = { x0: number; y0: number; x1: number; y1: number };
const blocked = new Set<string>();
const errors: string[] = [];
const checks: Record<string, boolean> = {};
const summary: Record<string, unknown> = {};
const near = (a: R, b: R, tol = 0.6) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;
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
  const app = <T>(fn: (a: A, arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([src, x]: [string, unknown]) => (0, eval)(src)((window as any).__app, x), [`(${fn.toString()})`, arg]);
  const openPdf = async (bytes: Uint8Array, name: string) => {
    await page.evaluate(async ([b64, nm]: [string, string]) => {
      const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([u], nm, { type: 'application/pdf' }));
      for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [Buffer.from(bytes).toString('base64'), name]);
    await page.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  };
  const status = () => page.evaluate(() => document.getElementById('st-msg')?.textContent ?? '');
  const added = () => app((a) => a.tools.place.added(0)) as Promise<{ key: string; asset: string; frame: R; rotate: number }[]>;
  const waitAdded = (k: number) => page.waitForFunction((k: number) => (window as any).__app.tools.place.added(0).length === k, k, { timeout: 30000 });
  /** Waits until page 0 shows the commit render of its current version. */
  const waitCommit = () => page.waitForFunction(() => { const r = (window as any).__app.rendered(0); return r.mode === 'commit' && r.committedVersion === r.version; }, undefined, { timeout: 60000 });
  const exportNow = async () => {
    await page.click('#export');
    await page.waitForSelector('#download:not([hidden])', { timeout: 120000 });
    const rep = await app((a) => a.lastExport.report);
    const b64 = await page.evaluate(async () => {
      const r = await fetch((document.getElementById('download') as HTMLAnchorElement).href);
      const u = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
      return btoa(s);
    });
    return { rep, bytes: new Uint8Array(Buffer.from(b64, 'base64')) };
  };

  // no flag in the page URL: "Add image" is there, disabled until a PDF is open
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !!(window as any).__app);
  checks.shownByDefault = await page.$eval('[data-tool="place"] button', (b: Element) => (b as HTMLButtonElement).disabled).catch(() => false);

  await openPdf(fx.bytes, 'objects.pdf');
  checks.buttonShown = (await page.$('[data-tool="place"] button')) !== null;

  // 1. "Add image": the file input
  await page.setInputFiles('[data-tool="place"] input[type=file]', { name: 'quadrant.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await waitAdded(1);
  const [a1] = await added();
  summary.picked = { frame: a1.frame, rotate: a1.rotate, status: await status() };
  checks.pickedAtCentre = near(a1.frame, { x0: 297.5 - 60, y0: 421 - 30, x1: 297.5 + 60, y1: 421 + 30 }, 0.01) && a1.rotate === 0;
  checks.pickedSelected = (await app((a) => a.tools.place.state.selected?.key)) === a1.key;
  checks.workerHasFile = (await app((a) => a.tools.place.hasInWorker(0))).every(Boolean);
  checks.drawnBeforeCommit = ((await app((a, f) => a.overlayPainted(0, f), a1.frame)) ?? 0) > 0 || (await app((a) => a.rendered(0).mode)) === 'commit';
  await waitCommit();
  const inside = await app((a, f) => a.diffInside(0, { x0: f.x0 + 15, y0: f.y0 + 5, x1: f.x1 - 5, y1: f.y1 - 5 }), a1.frame);
  const clear = await app((a, f) => a.diffInside(0, { x0: f.x0 + 1, y0: f.y0 + 1, x1: f.x0 + 9, y1: f.y1 - 1 }), a1.frame);
  const outsideR = { x0: 40, y0: 40, x1: 200, y1: 150 };
  const outside = await app((a, r) => a.diffInside(0, r), outsideR);
  summary.commit = { inside, clear, outside };
  checks.commitShowsImage = !!inside && inside.diff > inside.total * 0.9;
  checks.commitClearPart = !!clear && clear.diff === 0;
  checks.commitNothingElse = !!outside && outside.diff === 0;

  // 2. a JPEG from the browser's encoder, dropped on the page at a point
  const dropAt = { x: 450, y: 720 };
  await page.evaluate(async ([pt]: [{ x: number; y: number }]) => {
    const a = (window as any).__app;
    const c = document.createElement('canvas');
    c.width = 64; c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgb(220,30,30)'; g.fillRect(0, 0, 32, 32);
    g.fillStyle = 'rgb(30,60,200)'; g.fillRect(32, 0, 32, 32);
    const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/jpeg', 0.92));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    (window as any).__jpeg = btoa(String.fromCharCode(...bytes));
    const r = a.clientRect(0, { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
    const pageEl = document.querySelector('.page[data-n="0"]')!;
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'browser.jpg', { type: 'image/jpeg' }));
    for (const type of ['dragenter', 'dragover', 'drop']) pageEl.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x, clientY: r.y }));
  }, [dropAt]);
  await waitAdded(2);
  const jpeg = new Uint8Array(Buffer.from(await page.evaluate(() => (window as any).__jpeg as string), 'base64'));
  const a2 = (await added())[1];
  summary.dropped = { frame: a2.frame, status: await status() };
  // the event's client point is whole pixels: within a pixel of the point
  checks.droppedAtPoint = Math.abs((a2.frame.x0 + a2.frame.x1) / 2 - dropAt.x) < 1 && Math.abs((a2.frame.y0 + a2.frame.y1) / 2 - dropAt.y) < 1 && Math.abs(a2.frame.x1 - a2.frame.x0 - 64) < 0.01;
  checks.dropMaskHidden = await page.evaluate(() => (document.getElementById('dropmask') as HTMLElement).hidden);

  // 3. nudge, drag, undo, redo, delete
  await page.keyboard.press('Shift+ArrowRight');
  const nudged = (await added())[1].frame;
  checks.nudge = Math.abs(nudged.x0 - a2.frame.x0 - 10) < 1e-6 && Math.abs(nudged.y0 - a2.frame.y0) < 1e-6;
  const cr = await app((a, f) => a.clientRect(0, f), nudged);
  const ptPerPx = (nudged.x1 - nudged.x0) / cr.w;
  await page.mouse.move(cr.x + cr.w / 2, cr.y + cr.h / 2);
  await page.mouse.down();
  await page.mouse.move(cr.x + cr.w / 2 - 20, cr.y + cr.h / 2 + 10, { steps: 4 });
  await page.mouse.move(cr.x + cr.w / 2 - 40, cr.y + cr.h / 2 + 20, { steps: 4 });
  await page.mouse.up();
  const dragged = (await added())[1].frame;
  summary.drag = { from: nudged, to: dragged, ptPerPx };
  checks.drag = Math.abs(dragged.x0 - (nudged.x0 - 40 * ptPerPx)) < 1 && Math.abs(dragged.y0 - (nudged.y0 - 20 * ptPerPx)) < 1;
  await page.keyboard.press('Control+z');
  checks.undoDrag = near((await added())[1].frame, nudged, 1e-6);
  await page.keyboard.press('Control+z');
  checks.undoNudge = near((await added())[1].frame, a2.frame, 1e-6);
  await page.keyboard.press('Control+Shift+z');
  await page.keyboard.press('Control+Shift+z');
  checks.redo = near((await added())[1].frame, dragged, 1e-6);
  // select it again with a click, then remove it
  const cr2 = await app((a, f) => a.clientRect(0, f), dragged);
  await page.mouse.click(cr2.x + cr2.w / 2, cr2.y + cr2.h / 2);
  checks.clickSelects = (await app((a) => a.tools.place.state.selected?.key)) === a2.key;
  await page.keyboard.press('Delete');
  checks.deleteRemoves = (await added()).length === 1;
  await page.keyboard.press('Control+z');
  checks.undoDelete = (await added()).length === 2;

  // 4. refused: a PNG over the pixel limit
  await page.setInputFiles('[data-tool="place"] input[type=file]', { name: 'huge.png', mimeType: 'image/png', buffer: Buffer.from(pngHeaderOnly(5000, 5000)) });
  await page.waitForFunction(() => /up to/.test(document.getElementById('st-msg')?.textContent ?? ''), undefined, { timeout: 10000 });
  summary.refused = await status();
  checks.refusedTooLarge = (await added()).length === 2;

  // 5. export
  const ex = await exportNow();
  const imgs = ex.rep?.pages?.[0]?.imagesAdded ?? [];
  summary.export = { ok: ex.rep?.ok, failures: ex.rep?.failures, imagesAdded: imgs, bytes: ex.bytes.length };
  checks.exportOk = !!ex.rep?.ok && ex.rep.verified && ex.rep.incremental;
  checks.exportBothImages = imgs.length === 2 && imgs[0].format === 'png' && imgs[0].smask && imgs[1].format === 'jpeg';
  checks.jpegPassThrough = Buffer.from(ex.bytes).indexOf(Buffer.from(jpeg)) > 0;
  checks.originalPrefix = Buffer.from(ex.bytes.subarray(0, fx.bytes.length)).equals(Buffer.from(fx.bytes));
  const [after] = await listObjects(ex.bytes, [0]);
  const tail = after.objects.slice(-2);
  checks.exportedAtFrames = tail.length === 2 && tail.every((o) => o.kind === 'image') && near(tail[0].bounds, a1.frame, 0.01) && near(tail[1].bounds, dragged, 0.01);

  // 6. a page turned by /Rotate 90 with an offset crop box
  await openPdf(rot.bytes, 'rotated.pdf');
  summary.rotatedAdd = await app((a, b64) => a.tools.place.add(b64, 'image/png', 0, null), Buffer.from(png).toString('base64'));
  await waitAdded(1);
  const [ar] = await added();
  checks.rotatedTurn = ar.rotate === 270;
  await waitCommit();
  const rx = await exportNow();
  checks.rotatedExportOk = !!rx.rep?.ok;
  const P = await openPdfium();
  const d = P.open(rx.bytes);
  try {
    const pg = d.page(0);
    try {
      const k = 2, bmp = pg.render(k), q = rectToPixels(pg.view, ar.frame, k, pg.size.h);
      const px = (fx: number, fy: number): RGB => { const x = Math.floor(q.x0 + fx * (q.x1 - q.x0)), y = Math.floor(q.y0 + fy * (q.y1 - q.y0)); const i = (y * bmp.width + x) * 4; return [bmp.rgba[i], bmp.rgba[i + 1], bmp.rgba[i + 2]]; };
      const got = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]].map(([x, y]) => ({ at: [x, y], got: px(x, y), want: quadrant(x, y) }));
      summary.rotated = { frame: ar.frame, shown: [(q.x1 - q.x0) / k, (q.y1 - q.y0) / k], got };
      checks.rotatedUpright = Math.abs((q.x1 - q.x0) / k - 120) < 0.01 && got.every((g) => g.got.every((v, i) => Math.abs(v - g.want[i]) <= 12));
    } finally { pg.close(); }
  } finally { d.close(); }

  checks.noErrors = errors.length === 0;
  checks.noOutsideRequests = blocked.size === 0;
} catch (e) {
  errors.push(`smoke: ${(e as Error).message.split('\n')[0]}`);
  if (pageRef) {
    summary.failure = await pageRef.evaluate(() => { const a = (window as any).__app; return a && { place: a.tools.place?.state, msg: document.getElementById('st-msg')?.textContent }; }).catch(() => null);
    await pageRef.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}
const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, ...summary, errors, blocked: [...blocked] }, null, 1));
if (!ok) process.exitCode = 1;
