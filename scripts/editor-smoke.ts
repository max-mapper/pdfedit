// The live editor, headless: builds a synthetic 100-paragraph PDF (src/model/testkit.ts gridPdf), serves dist-web
// (build it first: npx vite build web --config web/vite.config.ts --outDir ../dist-web --emptyOutDir), opens it in
// headless Chromium, selects a box, types into it, and reads the per-keystroke reflow time (model update + layoutBox +
// preview redraw + frame and input updates, measured in the page's input handler) from window.__editor. Then it
// checks the preview drew glyphs, the model holds the typed text, undo restores it, and nothing left the page.
//   node scripts/editor-smoke.ts [out.pdf]
// SHOT=<file.png> saves a screenshot around the edited box. Playwright comes from PW_CORE (default: the playwright-core package), Chromium from CHROME.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gridPdf } from '../src/model/testkit.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || '/home/node/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const ROOT = join(import.meta.dirname, '..', 'dist-web');
const pdfPath = process.argv[2] || '/tmp/pdfedit-grid100.pdf';
await writeFile(pdfPath, await gridPdf(100));

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

type W = { __rendered?: unknown; __editor?: any };
const blocked = new Set<string>();
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
  const info = await page.evaluate(() => {
    const E = (window as W).__editor;
    const boxes = E.doc.pages[0].boxes;
    const editable = boxes.filter((b: { locked: string | null }) => !b.locked);
    const target = editable[Math.floor(editable.length / 2)];
    E.select(target.id);
    return { rendered: (window as W).__rendered, boxes: boxes.length, target: target.id,
      before: target.paragraphs.map((p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join('')).join('\n') };
  });
  const typed = ' and the quick brown fox jumps over the lazy dog';
  await page.keyboard.type(typed);
  const after = await page.evaluate((id: string) => {
    const E = (window as W).__editor;
    const b = E.editor.box(E.page, id);
    const L = E.laid(id);
    // preview pixels inside the laid frame
    const cv = document.getElementById('preview') as HTMLCanvasElement;
    const k = cv.width / E.doc.pages[0].w, h = E.doc.pages[0].h;
    const x = Math.floor(L.frame.x0 * k), y = Math.floor((h - L.frame.y1) * k);
    const w = Math.max(1, Math.ceil((L.frame.x1 - L.frame.x0) * k)), hh = Math.max(1, Math.ceil((L.frame.y1 - L.frame.y0) * k));
    const px = cv.getContext('2d')!.getImageData(x, y, w, hh).data;
    let ink = 0, painted = 0;
    for (let i = 0; i < px.length; i += 4) { if (px[i + 3] > 0) painted++; if (px[i + 3] > 0 && px[i] + px[i + 1] + px[i + 2] < 300) ink++; }
    const r = E.stats.reflows.slice().sort((p: number, q: number) => p - q);
    return {
      text: b.paragraphs.map((p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join('')).join('\n'),
      edited: b.edited, lines: L.lines.length, overflow: L.overflow, history: E.editor.history.length,
      keystrokes: r.length, p50: r[r.length >> 1], p95: r[Math.floor(r.length * 0.95)], max: r[r.length - 1],
      painted, ink,
    };
  }, info.target);
  if (process.env.SHOT) {   // optional screenshot of the edited box and its surroundings
    const r = await page.evaluate((id: string) => { const E = (window as W).__editor; return E.cssRect(E.laid(id).frame); }, info.target);
    const st = await page.locator('#stage').boundingBox();
    await page.screenshot({ path: process.env.SHOT, clip: { x: st.x + r.left - 160, y: st.y + r.top - 120, width: r.width + 320, height: r.height + 240 } });
  }
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate((id: string) => {
    const E = (window as W).__editor;
    const b = E.editor.box(E.page, id);
    return { text: b.paragraphs.map((p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join('')).join('\n'), edited: b.edited };
  }, info.target);
  const ok = after.text.endsWith(typed) && after.edited && after.ink > 50 && undone.text === info.before && !undone.edited &&
    after.p95 < 16 && !errors.length && !blocked.size;
  console.log(JSON.stringify({ ok, ...info, before: undefined, after: { ...after, text: undefined }, typedOk: after.text.endsWith(typed),
    undoOk: undone.text === info.before && !undone.edited, errors, blocked: [...blocked] }, null, 1));
  if (!ok) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
