// Selecting page objects (labs: app/tools/select.ts and the Objects card, app/tools/objects.ts), headless: serves
// dist-app (build it first: npx vite build app --config app/vite.config.ts --outDir ../dist-app --emptyOutDir), opens
// it with ?labs in headless Chromium, drops synthetic pages on the window (src/objects/testkit.ts, selectkit.ts) and
// checks with real mouse and key events:
//   - the Objects card lists the page's objects in paint order, one row each, and hovering a row outlines it;
//   - under a point where two filled rectangles overlap, the one on top is listed first and painting, the other after
//     it and not painting; inside a stroked ring's middle nothing paints;
//   - where a vector lies over an image, a click selects the vector; Alt-click selects the image, then the vector
//     again (it wraps); a second click on the same spot goes down too; a white rectangle on the white page is found;
//   - where text lies over both, a click selects the text box as the editor always has, a double-click edits it, and
//     Alt-click goes below it;
//   - Tab and Shift-Tab step through the page's objects in paint order; Enter steps into a group, Escape out;
//   - pointing at the overlap lists its objects in the card; hovering a row outlines it; clicking a row selects it;
//   - on a page turned by /Rotate 90 with an offset crop box, clicks select the right objects and the outline sits
//     on the object;
//   - groups (src/objects/groups.ts): on a bar chart, a click on a bar selects the proposed chart group (outlined
//     dashed, marked in the card); Enter steps in, Escape out; Ungroup leaves the bars on their own (all selected);
//     Shift-click adds a bar to the selection and Ctrl+G groups the two; undo takes the group back, then the ungroup;
//   - paint order (src/objects/order.ts): Ctrl+] brings a rectangle forward; the app's export writes it and verifies,
//     and in PDFium the exported page differs from the original only where it overlaps the one it passed; Ctrl+[ on a path outside a clip's q … Q is refused with the
//     reason and records nothing; undo takes the order change back;
//   - without ?labs the card is not there, and nothing loads from another host.
//   node scripts/objects-smoke.ts [out-dir]
// Playwright comes from PW_CORE (default: the playwright-core package), Chromium from CHROME (default: the one
// Playwright installed). Synthetic material only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { changedOutside, colour, like, render } from '../src/objects/groupcheck.ts';
import { chartPage, orderPage } from '../src/objects/groupkit.ts';
import { OVERLAP_POINTS, overlapPages } from '../src/objects/selectkit.ts';
import { objectsPage } from '../src/objects/testkit.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-app');
const OUT = process.argv[2] || (await mkdtemp(join(tmpdir(), 'pdfedit-objects-smoke-')));

const fx = await objectsPage();
await writeFile(join(OUT, 'objects.pdf'), fx.bytes);
const ov = await overlapPages();
await writeFile(join(OUT, 'overlap.pdf'), ov.bytes);

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
const blocked = new Set<string>();
const errors: string[] = [];
const checks: Record<string, boolean> = {};
const summary: Record<string, unknown> = {};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.route('**/*', (r: { request(): { url(): string }; continue(): unknown; abort(): unknown }) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    blocked.add(u); return r.abort();
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: { type(): string; text(): string }) => { if (m.type() === 'error') errors.push(m.text()); });
  const drop = (bytes: Uint8Array = fx.bytes, name = 'objects.pdf') => page.evaluate(async ([b64, nm]: [string, string]) => {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([u], nm, { type: 'application/pdf' }));
    for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [Buffer.from(bytes).toString('base64'), name]);
  const app = <T>(fn: (a: A, arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([src, x]: [string, unknown]) => (0, eval)(src)((window as any).__app, x), [`(${fn.toString()})`, arg]);

  // without ?labs: no Objects card
  await page.goto(`${base}/`);
  await page.waitForFunction(() => !!(window as any).__app);
  checks.hiddenWithoutLabs = (await page.$('#objects')) === null;

  await page.goto(`${base}/?labs`);
  await drop();
  await page.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  checks.cardShown = (await page.$('#objects')) !== null;
  await page.click('#objects button');
  await page.waitForFunction(() => document.querySelectorAll('#objects .row[data-id]').length > 0, undefined, { timeout: 30000 });
  const listed = await app((a) => a.tools.objects.list(0));
  const rows = await page.$$eval('#objects .row[data-id]', (els: Element[]) => els.map((e) => (e as HTMLElement).dataset.id));
  summary.objects = (listed as A).objects.length;
  summary.notes = (listed as A).notes;
  checks.oneRowEach = rows.length === (listed as A).objects.length && rows.join() === (listed as A).objects.map((o: A) => o.id).join();
  checks.noNotes = (listed as A).notes.length === 0;
  // hovering a row outlines the object
  await app((a) => a.tools.select.load(0));
  const first = (listed as A).objects.find((o: A) => o.kind === 'path');
  await page.hover(`#objects .row[data-id="${first.id}"]`);
  checks.outline = await page.evaluate(() => document.querySelectorAll('.tool-layer .obj-outline').length === 1);

  // under the pointer: the overlap of grey and green, then the ring's middle
  const [grey, green, ring] = (listed as A).objects.filter((o: A) => o.kind === 'path' && o.path.length === 0);
  const probe = (x: number, y: number) => app((a, p) => a.tools.select.probe(0, p.x, p.y), { x, y });
  const over = (await probe(150, 660)) as A;
  summary.overlap = over;
  checks.topmostFirst = over.ids[0] === green.id && over.ids.includes(grey.id) && over.paints.includes(green.id) && !over.paints.includes(grey.id);
  const hole = (await probe(350, 640)) as A;
  summary.ringMiddle = hole;
  checks.ringMiddle = hole.ids.includes(ring.id) && hole.paints.length === 0;
  const bold = await page.$$eval('#objects .row.paints', (els: Element[]) => els.length);
  checks.panelUnderPointer = bold === 0;   // the last probe: nothing paints in the ring's middle

  // ── selection with overlapping objects ──────────────────────────────────────────────────────────────────
  await drop(ov.bytes, 'overlap.pdf');
  await page.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc.pages.length === 2 && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  await app((a) => a.tools.select.load(0));
  const items = (await app((a) => a.tools.select.items(0))) as A[];
  summary.items = items.map((s: A) => `${s.z} ${s.kind} ${s.id}${s.parent ? ` in ${s.parent}` : ''}`);
  const image = items.find((s) => s.kind === 'image' && !s.clipped);
  const [vector, white] = items.filter((s) => s.kind === 'vector' && s.parent === null);
  const box = items.find((s) => s.kind === 'text');
  const icon = items.find((s) => s.kind === 'vector-group');
  checks.overlapScene = !!(image && vector && white && box && icon);
  const state = () => app((a) => a.tools.select.state) as Promise<A>;
  const selId = async () => (await state()).selected?.id ?? null;
  const waitSel = async (id: string | null, timeout = 8000) => {
    try { await page.waitForFunction((want: string | null) => ((window as any).__app.tools.select.state.selected?.id ?? null) === want, id, { timeout }); return true; } catch { return false; }
  };
  const status = () => page.$eval('#st-msg', (e: Element) => e.textContent ?? '').catch(() => '');
  const clientOf = async (n: number, x: number, y: number) => {
    await app((a, p) => a.reveal(p.n, { x0: p.x, y0: p.y, x1: p.x, y1: p.y }), { n, x, y });
    return app((a, p) => a.clientRect(p.n, { x0: p.x, y0: p.y, x1: p.x, y1: p.y }), { n, x, y }) as Promise<{ x: number; y: number }>;
  };
  const click = async (n: number, [x, y]: [number, number], opts: { alt?: boolean; shift?: boolean } = {}) => {
    const c = await clientOf(n, x, y);
    await page.mouse.move(c.x, c.y);
    if (opts.alt) await page.keyboard.down('Alt');
    if (opts.shift) await page.keyboard.down('Shift');
    await page.mouse.click(c.x, c.y, { clickCount: 1 });
    if (opts.shift) await page.keyboard.up('Shift');
    if (opts.alt) await page.keyboard.up('Alt');
  };
  const P = OVERLAP_POINTS;
  if (checks.overlapScene) {
    // a vector over an image: the vector; Alt-click: the image, then the vector again; a second click: down again
    await click(0, P.two);
    checks.clickTopmost = await waitSel(vector.id);
    await click(0, P.two, { alt: true });
    checks.altClickBelow = await waitSel(image.id);
    summary.altStatus = await status();
    checks.statusPosition = /2 of 2 here/.test(summary.altStatus as string);
    await click(0, P.two, { alt: true });
    checks.altClickWraps = await waitSel(vector.id);
    await click(0, P.two);
    checks.secondClickBelow = await waitSel(image.id);
    // white on white: the geometry finds it
    await click(0, P.white);
    checks.whiteOnWhite = await waitSel(white.id);
    // text over both: the text box, as the editor always selected it; double-click edits; Alt-click goes below
    await click(0, P.all3);
    checks.textBoxSelected = (await waitSel(box.id)) && (await app((a) => a.selected?.id)) === box.box;
    const c3 = await clientOf(0, ...P.all3);
    await page.mouse.dblclick(c3.x, c3.y);
    try { await page.waitForFunction(() => (window as any).__app.editing, undefined, { timeout: 5000 }); checks.doubleClickEdits = true; } catch { checks.doubleClickEdits = false; }
    await page.keyboard.press('Escape');
    checks.escapeEndsEditing = !(await app((a) => a.editing));
    await click(0, P.all3, { alt: true });
    checks.altClickBelowText = (await waitSel(vector.id)) && (await app((a) => a.selected)) === null;
    // Tab and Shift-Tab: paint order on the page
    await app((a) => a.tools.select.clear());
    const order = (await app((a) => a.tools.select.tabOrder(0, null))) as string[];
    summary.tabOrder = order;
    const tabbed: (string | null)[] = [];
    for (let k = 0; k < 3; k++) { await page.keyboard.press('Tab'); await waitSel(order[k], 3000); tabbed.push(await selId()); }
    await page.keyboard.press('Shift+Tab'); await waitSel(order[1], 3000); tabbed.push(await selId());
    summary.tabbed = tabbed;
    checks.tabOrder = tabbed.join() === [order[0], order[1], order[2], order[1]].join();
    await app((a) => a.tools.select.clear());
    await page.keyboard.press('Shift+Tab');
    checks.shiftTabWraps = await waitSel(order[order.length - 1], 3000);
    // a group: Enter steps in (its topmost member), Tab among members, Escape out
    await app((a, id) => a.tools.select.select(0, id), icon.id);
    await page.keyboard.press('Enter');
    checks.enterGroup = (await waitSel(icon.members[icon.members.length - 1], 3000)) && (await state()).level.id === icon.id;
    await page.keyboard.press('Tab');
    checks.tabInGroup = await waitSel(icon.members[0], 3000);
    await page.keyboard.press('Escape');
    checks.escapeGroup = await waitSel(icon.id, 3000);
    // the card: pointing at the overlap lists its objects; hovering a row outlines it; a click on a row selects it
    await app((a) => a.tools.select.clear());
    const c2 = await clientOf(0, ...P.two);
    await page.mouse.move(c2.x - 6, c2.y);
    await page.mouse.move(c2.x, c2.y);
    try {
      await page.waitForFunction((want: string) => [...document.querySelectorAll('#objects .rows .row[data-id]')].map((e) => (e as HTMLElement).dataset.id).join() === want, [vector.id, image.id].join(), { timeout: 8000 });
      checks.cardUnderPointer = true;
    } catch { checks.cardUnderPointer = false; }
    summary.cardRows = await page.$$eval('#objects .rows .row[data-id]', (els: Element[]) => els.map((e) => e.textContent));
    if (checks.cardUnderPointer) {
      await page.hover(`#objects .rows .row[data-id="${image.id}"]`);
      checks.cardHoverOutlines = await page.evaluate(() => document.querySelectorAll('.tool-layer .obj-outline').length === 1);
      await page.click(`#objects .rows .row[data-id="${image.id}"]`);
      checks.cardPick = await waitSel(image.id);
    }
  }
  // a turned page with an offset crop box
  await app((a) => a.scrollToPage(1));
  await page.waitForFunction(() => (window as any).__app.rendered(1)?.orig, undefined, { timeout: 60000 });
  await app((a) => a.tools.select.load(1));
  const turned = (await app((a) => a.tools.select.items(1))) as A[];
  const [rImage, rPath] = turned;
  if (rImage && rPath) {
    await click(1, P.r_two);
    checks.rotatedClick = await waitSel(rPath.id);
    await click(1, P.r_two, { alt: true });
    checks.rotatedAltClick = await waitSel(rImage.id);
    // the outline sits on the image as shown
    const want = (await app((a, r) => a.clientRect(1, r), rImage.bounds)) as { x: number; y: number; w: number; h: number };
    const got = await page.evaluate(() => { const p = document.querySelector('.tool-layer .obj-sel polygon'); const r = p?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; });
    summary.rotatedOutline = { want, got };
    checks.rotatedOutline = !!got && Math.abs(got.x - want.x) < 3 && Math.abs(got.y - want.y) < 3 && Math.abs(got.w - want.w) < 3 && Math.abs(got.h - want.h) < 3;
  } else checks.rotatedScene = false;

  // ── groups ───────────────────────────────────────────────────────────────────────────────────────────────
  // a newly dropped one-page document: not the one open before the drop
  const mark = () => page.evaluate(() => { (window as any).__before = (window as any).__app.doc; });
  const ready1 = () => page.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc && a.doc !== (window as any).__before && a.doc.pages.length === 1 && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  const ops = () => app((a) => a.doc?.pages[0]?.objectOps ?? []) as Promise<A[]>;
  const waitFor = async (fn: () => Promise<boolean>, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return true; await page.waitForTimeout(100); }
    return false;
  };
  await mark();
  await drop((await chartPage()).bytes, 'chart.pdf');
  await ready1();
  await app((a) => a.tools.select.load(0));
  const gItems = (await app((a) => a.tools.select.items(0))) as A[];
  const chart = gItems.find((s) => s.group === 'auto' && s.parent === null && s.members.length === 10);
  summary.groups = gItems.filter((s) => s.group).map((s: A) => `${s.id}: ${s.members.length}`);
  checks.groupsProposed = !!chart && gItems.filter((s) => s.group === 'auto').length === 5;
  if (chart) {
    await click(0, [115, 470]);
    checks.clickSelectsGroup = await waitSel(chart.id);
    checks.groupDashed = await page.evaluate(() => document.querySelectorAll('.tool-layer .obj-sel.obj-auto').length === 1);
    checks.groupInCard = (await page.$$eval('#objects .rows .row.auto', (els: Element[]) => els.length)) > 0;
    await page.keyboard.press('Enter');
    checks.enterProposed = await waitFor(async () => chart.members.includes(await selId()));
    await page.keyboard.press('Escape');
    checks.escapeProposed = await waitSel(chart.id, 3000);
    await page.click('button[data-cmd="ungroup"]');
    checks.ungroup = await waitFor(async () => (await ops()).some((o) => o.op === 'ungroup' && o.id === chart.id) && (await state()).picked.length === 10);
    const bar = (await app((a) => a.tools.select.items(0)) as A[]).find((s) => s.kind === 'vector' && s.parent === null && s.bounds.x0 === 100 && s.bounds.y0 === 450);
    await click(0, [115, 470]);
    checks.barAlone = !!bar && (await waitSel(bar.id));
    await click(0, [170, 470], { shift: true });
    checks.shiftClickAdds = await waitFor(async () => (await state()).picked.length === 2);
    await page.keyboard.press('Control+g');
    checks.ctrlGGroups = await waitFor(async () => ((await selId()) ?? '').startsWith('group:') && (await ops()).some((o) => o.op === 'group' && o.members.length === 2));
    summary.groupStatus = await status();
    await page.keyboard.press('Control+z');
    checks.undoGroup = await waitFor(async () => !(await ops()).some((o) => o.op === 'group'));
    await page.keyboard.press('Control+z');
    checks.undoUngroup = await waitFor(async () => !(await ops()).length && ((await app((a) => a.tools.select.items(0))) as A[]).some((s) => s.id === chart.id));
  }

  // ── paint order ──────────────────────────────────────────────────────────────────────────────────────────
  const ofx = await orderPage();
  await mark();
  await drop(ofx.bytes, 'order.pdf');
  await ready1();
  await app((a) => a.tools.select.load(0));
  const oItems = (await app((a) => a.tools.select.items(0))) as A[];
  const same = (r: A, q: A) => Math.abs(r.x0 - q.x0) < 0.1 && Math.abs(r.y0 - q.y0) < 0.1 && Math.abs(r.x1 - q.x1) < 0.1 && Math.abs(r.y1 - q.y1) < 0.1;
  const rectA = oItems.find((s) => same(s.bounds, ofx.at.a)), outside = oItems.find((s) => same(s.bounds, ofx.at.outside));
  if (rectA && outside) {
    await app((a, id) => a.tools.select.select(0, id), rectA.id);
    await page.keyboard.press('Control+BracketRight');
    checks.orderRecorded = await waitFor(async () => (await ops()).some((o) => o.op === 'order' && o.id === rectA.id && o.to === 'forward'));
    summary.orderStatus = await status();
    checks.orderStatus = /brought forward past/.test(summary.orderStatus as string);
    // the app's export writes it (verified there); in PDFium, only the overlap with the rectangle it passed changed
    try {
      await page.click('#export');
      await page.waitForSelector('#download:not([hidden])', { timeout: 120000 });
      const rep = (await app((a) => { const r = a.lastExport.report; return r && { ok: r.ok, verified: r.verified, failures: r.failures, changed: r.pages[0]?.objectsChanged ?? [] }; })) as A;
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#download')]);
      const outPath = join(OUT, 'order-edited.pdf');
      await dl.saveAs(outPath);
      const out = new Uint8Array(await readFile(outPath));
      const overlap = { x0: 160, y0: 640, x1: 220, y1: 680 };
      const outside = await changedOutside(ofx.bytes, out, [overlap]);
      const red = like(colour(await render(out), 190, 660), [230, 51, 51]) && like(colour(await render(ofx.bytes), 190, 660), [51, 179, 77]);
      summary.orderExport = { ok: rep?.ok, verified: rep?.verified, failures: rep?.failures, changed: rep?.changed?.map((c: A) => `${c.action} ${c.id} ${c.order ?? ''}`), outside, red };
      checks.orderExported = !!rep?.ok && rep.verified && rep.changed.some((c: A) => c.action === 'order' && c.id === rectA.id) && outside === 0 && red;
    } catch (err) { summary.orderExport = String(err); checks.orderExported = false; }
    const before = (await ops()).length;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());   // the download link had the focus
    await app((a, id) => a.tools.select.select(0, id), outside.id);
    await page.keyboard.press('Control+BracketLeft');
    checks.orderRefused = await waitFor(async () => /different q … Q levels/.test(await status()));
    summary.refusedStatus = await status();
    checks.refusedRecordsNothing = (await ops()).length === before;
    await page.keyboard.press('Control+z');
    checks.undoOrder = await waitFor(async () => !(await ops()).length);
  } else checks.orderScene = false;
} finally {
  await browser.close();
  server.close();
}
checks.noOutsideRequests = blocked.size === 0;
checks.noErrors = errors.length === 0;
const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, checks, summary, blocked: [...blocked], errors }, null, 1));
if (!ok) process.exitCode = 1;
