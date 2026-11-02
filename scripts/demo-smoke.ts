// The editor as a first-time visitor meets it, headless: serves dist-app (build it first: npm run app:build), opens it
// with no flag in the page URL in headless Chromium and checks with real clicks and keys:
//   - the welcome shows (open a file, try the sample, what is possible), and the bar's groups are there with the
//     object tools disabled, their tooltips saying why;
//   - ? opens the help panel, Escape closes it; the ? button opens it too;
//   - "Try the sample" opens the sample document (src/objects/sample.ts): two pages, the second turned;
//   - each group of the bar once: View (zoom in, fit page), Objects (select the picture and drag it, add an image,
//     a click on the chart selects its proposed group, Ungroup, Group, Forward or Backward, Turn right, Delete),
//     Text (select a box, Edit text and type, Split, Shift-click and Merge, Font… focuses the font list), Edit (Undo,
//     Redo) and Export (verified, offered for download);
//   - at phone width (390 px) nothing is wider than the window: the welcome, the sample open, the Tools menu open and
//     the panel sheet open; the menu shows the groups;
//   - no errors, and nothing loads from another host.
//   node scripts/demo-smoke.ts [out-dir]
// SHOTS=<dir> saves screenshots there. Playwright comes from PW_CORE (default: the playwright-core package), Chromium
// from CHROME (default: the one Playwright installed). Synthetic material only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { writePng } from '../src/objects/placekit.ts';
import { SAMPLE_AT } from '../src/objects/sample.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-app');
const OUT = process.argv[2] || (await mkdtemp(join(tmpdir(), 'pdfedit-demo-smoke-')));
const SHOT = process.env.SHOTS || '';

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
const png = writePng({ width: 60, height: 40, ctype: 2, depth: 8, pixel: (x, y) => (x < 30 === y < 20 ? [230, 120, 30] : [30, 90, 200]) });
const near = (a: R, b: R, tol = 1.5) => Math.abs(a.x0 - b.x0) <= tol && Math.abs(a.y0 - b.y0) <= tol && Math.abs(a.x1 - b.x1) <= tol && Math.abs(a.y1 - b.y1) <= tol;

/** Visible elements of the bar, the welcome, the panel and the status line that reach past the window's edges. */
const overflowOf = (page: A) => page.evaluate(() => {
  const W = window.innerWidth;
  const wide = [...document.querySelectorAll<HTMLElement>('#bar *, #empty *, #panel *, #status *, #bar, #empty, #panel, #status, #body')].filter((el) => {
    if (!el.getClientRects().length) return false;
    if (el.closest('#pages')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > W + 0.5 || r.left < -0.5);
  }).map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').join('.') : ''}`);
  return { scroll: document.documentElement.scrollWidth - W, wide: wide.slice(0, 8) };
});

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
  const waitApp = (fn: (a: A, arg: any) => unknown, arg?: unknown, timeout = 60000) =>
    page.waitForFunction(([src, x]: [string, unknown]) => { const a = (window as any).__app; return !!a && !!(0, eval)(src)(a, x); }, [`(${fn.toString()})`, arg], { timeout });
  const visible = (sel: string) => page.$eval(sel, (e: Element) => (e as HTMLElement).getClientRects().length > 0 && !(e as HTMLElement).closest('[hidden]')).catch(() => false);
  const shot = async (name: string) => { if (SHOT) await page.screenshot({ path: join(SHOT, `${name}.png`) }); };

  // 1. the welcome, the bar
  await page.goto(`${base}/`);
  await waitApp((a) => !!a);
  summary.welcome = await page.$eval('#empty', (e: Element) => (e as HTMLElement).innerText);
  checks.welcome = (await visible('#empty')) && (await visible('#sample')) && (await visible('#open2')) && /Try the sample/.test(String(summary.welcome)) && /group and reorder/.test(String(summary.welcome));
  summary.groups = await page.$$eval('#bar .grp[data-cap]', (els: Element[]) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => (e as HTMLElement).dataset.cap));
  checks.groups = ['File', 'Edit', 'View', 'Text', 'Objects'].every((g) => (summary.groups as string[]).includes(g));
  const tools = await page.$$eval('#g-objects button', (bs: Element[]) => bs.map((b) => ({ text: (b as HTMLButtonElement).getAttribute('aria-label') || b.textContent, disabled: (b as HTMLButtonElement).disabled, title: (b as HTMLButtonElement).title })));
  summary.objectTools = tools.map((t: A) => t.text);
  checks.objectToolsShown = ['Select', 'Add image', 'Group', 'Ungroup', 'Forward', 'Backward', 'Turn left', 'Turn right', 'Delete'].every((n) => tools.some((t: A) => t.text === n));
  checks.disabledSayWhy = tools.filter((t: A) => t.text !== 'Select' && !/crop/.test(t.text)).every((t: A) => t.disabled && /open a PDF first/.test(t.title));
  await shot('welcome');

  // 2. help
  await page.keyboard.press('?');
  await page.waitForSelector('#help[open]', { timeout: 5000 });
  summary.help = await page.$$eval('#help section:not([hidden]) h3', (els: Element[]) => els.map((e) => e.textContent));
  checks.helpKeys = (await page.$eval('#help', (e: Element) => (e as HTMLElement).innerText)).includes('Ctrl') && (summary.help as string[]).length >= 4;
  await shot('help');
  await page.keyboard.press('Escape');
  checks.helpCloses = await page.$eval('#help', (e: Element) => !(e as HTMLDialogElement).open);
  await page.click('#help-btn');
  checks.helpButton = await page.$eval('#help', (e: Element) => (e as HTMLDialogElement).open);
  await page.click('#help-close');

  // 3. the sample
  await page.click('#sample');
  await waitApp((a) => a.ready && a.doc.pages[0] && a.rendered(0).orig);
  await app((a) => a.scrollToPage(1));
  await waitApp((a) => a.doc.pages[1] && a.rendered(1).orig);
  await app((a) => a.scrollToPage(0));
  summary.sample = await app((a) => ({ pages: a.doc.pages.length, boxes: a.doc.pages.map((p: A) => p?.boxes.length ?? null), turned: a.doc.pages[1]?.view?.rotate ?? 0, name: document.getElementById('docname')!.textContent }));
  const s = summary.sample as A;
  checks.sampleOpens = s.pages === 2 && s.boxes[0] >= 10 && s.boxes[1] >= 2 && s.turned === 90 && s.name === 'sample.pdf' && !(await visible('#empty'));
  await shot('sample');

  // 4. View
  const z0 = await app((a) => a.zoom);
  await page.click('#zoom-in');
  const z1 = await app((a) => a.zoom);
  await page.click('#fit-page');
  const z2 = await app((a) => a.zoom);
  summary.zoom = [z0, z1, z2];
  checks.view = z1 > z0 && z2 !== z1;
  await page.click('#fit-width');

  // 5. Objects
  const client = (n: number, x: number, y: number) => app((a, p) => { const r = a.clientRect(p.n, { x0: p.x, y0: p.y, x1: p.x, y1: p.y }); return { x: r.x, y: r.y }; }, { n, x, y }) as Promise<{ x: number; y: number }>;
  const state = () => app((a) => a.tools.select.state) as Promise<A>;
  const ops = () => app((a) => a.doc.pages[0].objectOps ?? []) as Promise<A[]>;
  const waitCommit = () => page.waitForFunction(() => { const r = (window as any).__app.rendered(0); return r.mode === 'commit' && r.committedVersion === r.version; }, undefined, { timeout: 60000 });
  const cmd = (c: string) => page.click(`#g-objects button[data-cmd="${c}"]`);
  await app((a) => a.tools.select.load(0));
  const items = (await app((a) => a.tools.select.items(0))) as A[];
  const picture = items.find((x) => x.kind === 'image' && near(x.bounds, SAMPLE_AT.picture));
  const badge = items.find((x) => near(x.bounds, SAMPLE_AT.badge, 2) && !x.box);
  checks.sampleObjects = !!picture && !!badge;
  const pc = { x: (SAMPLE_AT.picture.x0 + SAMPLE_AT.picture.x1) / 2, y: (SAMPLE_AT.picture.y0 + SAMPLE_AT.picture.y1) / 2 };
  await app((a, r) => a.reveal(0, r), SAMPLE_AT.picture);
  const c0 = await client(0, pc.x, pc.y);
  await page.mouse.click(c0.x, c0.y);
  await page.waitForFunction((id: string) => (window as any).__app.tools.select.state.selected?.id === id, picture.id, { timeout: 10000 });
  const handles = (await app((a) => a.tools.select.handles())) as A[];
  checks.handles = handles.length === 9;
  checks.enabledWhenSelected = await page.$$eval('#g-objects button[data-cmd="turn-right"], #g-objects button[data-cmd="delete"]', (bs: Element[]) => bs.every((b) => !(b as HTMLButtonElement).disabled));
  await page.mouse.move(c0.x, c0.y);
  await page.mouse.down();
  await page.mouse.move(c0.x + 20, c0.y + 10, { steps: 4 });
  await page.mouse.move(c0.x + 40, c0.y + 20, { steps: 4 });
  await page.mouse.up();
  const moved = (await ops()).at(-1);
  checks.dragMoves = moved?.op === 'transform' && moved.ids.includes(picture.id) && moved.m[4] > 0 && moved.m[5] < 0;
  await waitCommit();

  // Add image
  await page.setInputFiles('[data-tool="place"] input[type=file]', { name: 'tiles.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await waitApp((a) => (a.doc.pages[0].objectOps ?? []).some((o: A) => o.op === 'add-image'), undefined, 20000);
  checks.addImage = String((await state()).selected?.id ?? '').startsWith('add:') || (await ops()).some((o) => o.op === 'add-image');
  summary.added = (await state()).selected?.id;

  // a click on a bar selects the chart's proposed group; Ungroup, then Group
  const bar = { x: 108 + 3 * 44 + 14, y: 250 };
  await app((a, r) => a.reveal(0, r), SAMPLE_AT.chart);
  const cb = await client(0, bar.x, bar.y);
  await page.mouse.click(cb.x, cb.y);
  await page.waitForFunction(() => String((window as any).__app.tools.select.state.selected?.id ?? '').startsWith('auto:'), undefined, { timeout: 10000 });
  summary.chartGroup = (await state()).selected.id;
  await cmd('ungroup');
  const afterUngroup = await state();
  checks.ungroup = (await ops()).at(-1)?.op === 'ungroup' && afterUngroup.picked.length > 1;
  await cmd('group');
  const grouped = (await ops()).at(-1);
  checks.group = grouped?.op === 'group' && grouped.members.length > 1;

  // paint order: the group, else the picture, one step forward or backward
  const orderOnce = async () => {
    for (const c of ['forward', 'backward']) {
      const before = (await ops()).length;
      if (await page.$eval(`#g-objects button[data-cmd="${c}"]`, (b: Element) => (b as HTMLButtonElement).disabled)) continue;
      await cmd(c);
      await page.waitForFunction((k: number) => ((window as any).__app.doc.pages[0].objectOps ?? []).length > k || /Cannot/.test(document.getElementById('st-msg')!.textContent ?? ''), before, { timeout: 10000 }).catch(() => {});
      const last = (await ops()).at(-1);
      if ((await ops()).length > before && last?.op === 'order') return `${c}: ${last.id}`;
    }
    return null;
  };
  let order = await orderOnce();
  if (!order) { await app((a, id) => a.tools.select.select(0, id), picture.id); order = await orderOnce(); }
  summary.order = order ?? (await page.$eval('#st-msg', (e: Element) => e.textContent));
  checks.reorder = !!order;

  // Turn right, Delete
  await app((a, id) => a.tools.select.select(0, id), picture.id);
  await cmd('turn-right');
  const turned = (await ops()).at(-1);
  checks.turn = turned?.op === 'transform' && Math.abs(turned.m[0]) < 1e-6 && Math.abs(Math.abs(turned.m[1]) - 1) < 1e-6;
  await app((a, id) => a.tools.select.select(0, id), badge.id);
  await cmd('delete');
  const deleted = (await ops()).at(-1);
  checks.delete = deleted?.op === 'delete' && deleted.ids.length > 0;
  await waitCommit();
  await shot('objects');

  // 6. Text
  await page.keyboard.press('Escape');
  const boxes = (await app((a) => a.doc.pages[0].boxes.map((b: A) => ({ id: b.id, frame: b.frame, paras: b.paragraphs.length, text: b.paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join('')).join('\n') })))) as A[];
  const intro = boxes.find((b) => /made up for trying/.test(b.text));
  const two = boxes.find((b) => b.paras === 2);
  checks.textBoxes = !!intro && !!two;
  checks.textBarDisabled = await page.$eval('#edit-text', (b: Element) => (b as HTMLButtonElement).disabled && /select a text box first/.test((b as HTMLButtonElement).title));
  await app((a, r) => a.reveal(0, r), intro.frame);
  const ci = await client(0, intro.frame.x0 + 30, intro.frame.y1 - 6);
  await page.mouse.click(ci.x, ci.y);
  await waitApp((a, id) => a.selected?.id === id, intro.id, 10000);
  await page.click('#edit-text');
  await waitApp((a) => a.editing, undefined, 5000);
  await page.keyboard.type(' Typed in the demo.');
  await page.keyboard.press('Escape');
  const introText = await app((a, id) => a.editor.box(0, id).paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join('')).join('\n'), intro.id);
  checks.editText = String(introText).includes('Typed in the demo.');
  // Split, then Shift-click the second part and Merge
  await app((a, id) => a.select(0, id), two.id);
  const n0 = await app((a) => a.doc.pages[0].boxes.length);
  await page.click('#tb-split');
  const n1 = await app((a) => a.doc.pages[0].boxes.length);
  checks.split = n1 === n0 + 1;
  const parts = (await app((a, id) => a.doc.pages[0].boxes.filter((b: A) => b.id === id || b.id.startsWith(`${id}`) || b.edited).map((b: A) => ({ id: b.id, frame: b.frame })), two.id)) as A[];
  const second = parts.find((b) => b.id !== two.id && b.frame.y1 < two.frame.y1);
  if (second) {
    await app((a, id) => a.select(0, id), two.id);
    const c2 = await client(0, second.frame.x0 + 20, (second.frame.y0 + second.frame.y1) / 2);
    await page.keyboard.down('Shift');
    await page.mouse.click(c2.x, c2.y);
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => !(document.getElementById('tb-merge') as HTMLButtonElement).disabled, undefined, { timeout: 5000 }).catch(() => {});
    await page.click('#tb-merge');
  }
  const n2 = await app((a) => a.doc.pages[0].boxes.length);
  checks.merge = !!second && n2 === n0;
  await page.click('#tb-font');
  checks.fontButton = await page.evaluate(() => document.activeElement?.id === 'font');
  await page.keyboard.press('Escape');

  // 7. Edit: Undo, Redo
  const h0 = await app((a) => a.editor.history.length);
  await page.click('#undo');
  const h1 = await app((a) => a.editor.history.length);
  await page.click('#redo');
  const h2 = await app((a) => a.editor.history.length);
  checks.undoRedo = h1 === h0 - 1 && h2 === h0;

  // 8. Export
  await page.click('#export');
  await waitApp((a) => !!a.lastExport, undefined, 120000);
  const ex = (await app((a) => ({ ok: a.lastExport.report?.ok ?? false, error: a.lastExport.error, bytes: a.lastExport.bytes, failures: a.lastExport.report?.failures ?? [], download: a.downloadName }))) as A;
  summary.export = ex;
  checks.export = ex.ok && ex.bytes > 0 && ex.download === 'sample-edited.pdf';
  await shot('exported');

  // 9. phone width
  const phone = await ctx.newPage();
  phone.on('pageerror', (e: Error) => errors.push(`phone: ${e.message}`));
  phone.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(`phone: ${m.text()}`); });
  await phone.setViewportSize({ width: 390, height: 844 });
  await phone.goto(`${base}/`);
  await phone.waitForFunction(() => !!(window as any).__app);
  const o1 = await overflowOf(phone);
  await phone.click('#sample');
  await phone.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  const o2 = await overflowOf(phone);
  checks.phoneMenuClosed = !(await phone.$eval('#g-objects', (e: Element) => (e as HTMLElement).getClientRects().length > 0));
  await phone.click('#more');
  const o3 = await overflowOf(phone);
  checks.phoneMenuShows = await phone.$eval('#g-objects', (e: Element) => (e as HTMLElement).getClientRects().length > 0) &&
    await phone.$eval('#g-text', (e: Element) => (e as HTMLElement).getClientRects().length > 0);
  if (SHOT) await phone.screenshot({ path: join(SHOT, 'phone-menu.png') });
  await phone.click('#more');
  await phone.click('#panel-toggle');
  const o4 = await overflowOf(phone);
  checks.phonePanel = await phone.$eval('#panel', (e: Element) => (e as HTMLElement).getClientRects().length > 0);
  if (SHOT) await phone.screenshot({ path: join(SHOT, 'phone-panel.png') });
  summary.phoneOverflow = { welcome: o1, sample: o2, menu: o3, panel: o4 };
  checks.phoneNoOverflow = [o1, o2, o3, o4].every((o) => o.scroll <= 0 && o.wide.length === 0);

  checks.noErrors = errors.length === 0;
  checks.noOutsideRequests = blocked.size === 0;
} catch (e) {
  errors.push(`smoke: ${(e as Error).message.split('\n')[0]}`);
  if (pageRef) {
    summary.failure = await pageRef.evaluate(() => { const a = (window as any).__app; return a && { select: a.tools.select?.state, msg: document.getElementById('st-msg')?.textContent }; }).catch(() => null);
    await pageRef.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}
const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, ...summary, errors, blocked: [...blocked] }, null, 1));
if (!ok) process.exitCode = 1;
