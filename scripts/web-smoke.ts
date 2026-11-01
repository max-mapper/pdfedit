// The browser smoke test: builds nothing itself; serves dist-web (npm run web:build) on a local port, opens it in
// headless Chromium, loads a PDF through the file input, and waits for page 1 to render in the worker. Every request
// to any other host is aborted and listed, so a pass also proves the page needs nothing from outside.
//   node scripts/web-smoke.ts <file.pdf>
// Playwright comes from PW_CORE (default: the playwright-core package), Chromium from CHROME.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || '/home/node/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome';
const ROOT = join(import.meta.dirname, '..', 'dist-web');
const pdf = process.argv[2];
if (!pdf) { console.error('usage: node scripts/web-smoke.ts <file.pdf>'); process.exit(2); }

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css' };
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
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const blocked = new Set<string>();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r: { request(): { url(): string }; continue(): unknown; abort(): unknown }) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    blocked.add(u); return r.abort();
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  await page.goto(`${base}/`);
  await page.setInputFiles('#file', pdf);
  await page.waitForFunction(() => (window as unknown as { __rendered?: unknown }).__rendered, null, { timeout: 60000 });
  const r = await page.evaluate(() => (window as unknown as { __rendered: unknown }).__rendered);
  console.log(JSON.stringify({ rendered: r, errors, blocked: [...blocked] }));
  if (errors.length || blocked.size) process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
