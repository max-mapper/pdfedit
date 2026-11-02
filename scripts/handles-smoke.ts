// Handles on page objects (app/tools/select.ts with app/tools/place.ts), headless: serves dist-app (build it
// first: npm run app:build), opens it in headless Chromium, drops a synthetic two-page PDF on the window
// (src/objects/handlekit.ts) and checks with real mouse and key events:
//   - a selected image gets eight resize handles and a rotation handle;
//   - a drag of its body moves it: while the pointer moves, its pixels are drawn at the new place over the page; once
//     released the move is one transform op, drawn at once from the original render (the underlay) and then shown by
//     the page's commit render, which differs from the original at the old and the new place only;
//   - a corner handle resizes it freely; with Shift held the proportions stay; the rotation handle turns it, with
//     Shift in steps of 15°; Turn right makes a quarter turn; Delete removes a path, and the status line says once that
//     a delete is not a redaction; arrows nudge;
//   - an image cropped by a rectangle clip it shares: the move goes "with its crop" (the commit render shows it cropped
//     at its new place) and "Move without the crop" shows it whole; an image cropped by a triangle clip moves with its
//     crop too;
//   - an added image (Add image) is selected by the same tool: a handle resizes its frame, Turn left gives it a
//     quarter turn;
//   - the app's export writes all of it and verifies;
//   - on a page turned by /Rotate 90 with an offset crop box: a handle drag lands where the pointer let go, ArrowRight
//     nudges it right as shown, and a text box is edited: the typed text is drawn turned in the box, the caret lies
//     across the turned line, and the commit render shows it;
//   - the times: drawing the drag preview, and from releasing the pointer to the commit render on screen.
//   node scripts/handles-smoke.ts [out-dir]
// Playwright comes from PW_CORE (default: the playwright-core package), Chromium from CHROME (default: the one
// Playwright installed). Synthetic material only.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { HANDLE_AT, handlePages } from '../src/objects/handlekit.ts';
import { writePng } from '../src/objects/placekit.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const ROOT = join(import.meta.dirname, '..', 'dist-app');
const OUT = process.argv[2] || (await mkdtemp(join(tmpdir(), 'pdfedit-handles-smoke-')));

const fx = await handlePages();
await writeFile(join(OUT, 'handles.pdf'), fx.bytes);
const png = writePng({ width: 80, height: 40, ctype: 2, depth: 8, pixel: (x) => (x < 40 ? [200, 40, 160] : [40, 200, 200]) });

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
type M = [number, number, number, number, number, number];
const blocked = new Set<string>();
const errors: string[] = [];
const checks: Record<string, boolean> = {};
const summary: Record<string, unknown> = {};
const timings: Record<string, number[]> = { previewMs: [], underlayMs: [], workerCommitMs: [], releaseToCommitMs: [] };
const ap = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const mapR = (r: R, m: M): R => { const p = [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]].map(([x, y]) => ap(m, x, y)); return { x0: Math.min(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) }; };
const shrink = (r: R, d: number): R => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });
const angleOf = (m: M) => (Math.atan2(m[1], m[0]) * 180) / Math.PI;
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
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
  await page.goto(`${base}/`);
  await page.evaluate(async ([b64]: [string]) => {
    const u = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([u], 'handles.pdf', { type: 'application/pdf' }));
    for (const type of ['dragenter', 'dragover', 'drop']) document.body.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [Buffer.from(fx.bytes).toString('base64')]);
  await page.waitForFunction(() => { const a = (window as any).__app; return a?.ready && a.doc.pages[0] && a.rendered(0).orig; }, undefined, { timeout: 60000 });
  await app((a) => a.tools.select.load(0));
  const items = (await app((a) => a.tools.select.items(0))) as A[];
  const at = (r: R) => items.find((s) => s.kind !== 'text' && Math.abs(s.bounds.x0 - r.x0) < 0.6 && Math.abs(s.bounds.y0 - r.y0) < 0.6 && Math.abs(s.bounds.x1 - r.x1) < 0.6);
  const blue = at(HANDLE_AT.blue), orange = at(HANDLE_AT.orange), green = at(HANDLE_AT.green), red = at(HANDLE_AT.red);
  checks.fixtureRead = !!(blue && orange && green && red);

  const status = () => page.$eval('#st-msg', (e: Element) => e.textContent ?? '').catch(() => '');
  const state = () => app((a) => a.tools.select.state) as Promise<A>;
  const ops = (n = 0) => app((a, k) => a.doc.pages[k].objectOps ?? [], n) as Promise<A[]>;
  const lastOp = async (n = 0) => { const o = await ops(n); return o[o.length - 1]; };
  const client = (n: number, x: number, y: number) => app((a, p) => { const r = a.clientRect(p.n, { x0: p.x, y0: p.y, x1: p.x, y1: p.y }); return { x: r.x, y: r.y }; }, { n, x, y }) as Promise<{ x: number; y: number }>;
  const reveal = (n: number, r: R) => app((a, p) => a.reveal(p.n, p.r), { n, r });
  const handles = () => app((a) => a.tools.select.handles()) as Promise<{ id: string; x: number; y: number }[]>;
  const handle = async (id: string) => (await handles()).find((h) => h.id === id)!;
  const waitSel = (id: string) => page.waitForFunction((want: string) => (window as any).__app.tools.select.state.selected?.id === want, id, { timeout: 10000 });
  const waitCommit = (n = 0) => page.waitForFunction((k: number) => { const r = (window as any).__app.rendered(k); return r.mode === 'commit' && r.committedVersion === r.version; }, n, { timeout: 60000 });
  const diff = (n: number, r: R) => app((a, p) => a.diffInside(p.n, p.r), { n, r }) as Promise<{ diff: number; total: number } | null>;
  const painted = (n: number, r: R) => app((a, p) => a.overlayPainted(p.n, p.r), { n, r }) as Promise<number | null>;
  const select = async (n: number, x: number, y: number, id: string) => {
    const c = await client(n, x, y);
    await page.mouse.click(c.x, c.y);
    await waitSel(id);
  };
  /** A drag from one client point to another; `during` runs before the release. Returns ms from release to the commit render on screen. */
  const dragTo = async (from: { x: number; y: number }, to: { x: number; y: number }, opts: { shift?: boolean; during?: () => Promise<void>; released?: () => Promise<void>; n?: number } = {}) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    if (opts.shift) await page.keyboard.down('Shift');
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    if (opts.during) await opts.during();
    const t0 = Date.now();
    await page.mouse.up();
    if (opts.shift) await page.keyboard.up('Shift');
    if (opts.released) await opts.released();
    await waitCommit(opts.n ?? 0);
    const ms = Date.now() - t0;
    timings.releaseToCommitMs.push(ms);
    return ms;
  };
  /** A pixel of the drag preview canvas at a client point (null when there is none). */
  const previewPixel = (p: { x: number; y: number }) => page.evaluate(([x, y]: [number, number]) => {
    const c = document.querySelector('.tool-layer[data-tool="select"] .obj-preview') as HTMLCanvasElement | null;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const d = c.getContext('2d')!.getImageData(Math.floor(((x - r.left) * c.width) / r.width), Math.floor(((y - r.top) * c.height) / r.height), 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  }, [p.x, p.y]);
  const like = (c: number[] | null, want: number[], tol = 45) => !!c && want.every((v, i) => Math.abs(c[i] - v) <= tol);

  // 1. select the image: handles
  await reveal(0, { x0: 40, y0: 150, x1: 520, y1: 620 });
  await select(0, 150, 225, blue.id);
  const hs = await handles();
  summary.handles = hs.map((h) => h.id);
  checks.handlesShown = hs.length === 9 && ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rot'].every((id) => hs.some((h) => h.id === id));
  const ne0 = await handle('ne'), neWant = await client(0, HANDLE_AT.blue.x1, HANDLE_AT.blue.y1);
  checks.handleOnCorner = Math.hypot(ne0.x - neWant.x, ne0.y - neWant.y) < 1.5;
  const ptPerPx = (HANDLE_AT.blue.x1 - HANDLE_AT.blue.x0) / ((await client(0, HANDLE_AT.blue.x1, 0)).x - (await client(0, HANDLE_AT.blue.x0, 0)).x);
  summary.ptPerPx = ptPerPx;

  // 2. move by dragging its body; the preview while dragging; the underlay, then the commit render
  const c0 = await client(0, 150, 225);
  const moveTo = { x: c0.x + 60, y: c0.y + 90 };
  let during: A = null;
  const ms1 = await dragTo(c0, moveTo, {
    during: async () => { during = { dragging: (await state()).dragging, atNew: await previewPixel(moveTo), atOld: await previewPixel({ x: c0.x - 30, y: c0.y }) }; },
    released: async () => {
      // right after the release: the op, and the page drawn from the original render until the commit arrives
      const r = await app((a) => { const ops = a.doc.pages[0].objectOps ?? []; const op = ops[ops.length - 1]; return { op, mode: a.rendered(0).mode, version: a.rendered(0).version, committed: a.rendered(0).committedVersion }; }) as A;
      const op = r.op;
      during.afterRelease = { ...r, painted: op?.op === 'transform' ? await painted(0, shrink(mapR(HANDLE_AT.blue, op.m), 5)) : null };
    },
  });
  summary.move = { during, ms: ms1 };
  const mv = await ops();
  const moveOp = mv.find((o) => o.op === 'transform');
  const dxPt = 60 * ptPerPx, dyPt = -90 * ptPerPx;
  checks.moveDuringDrag = !!during?.dragging && like(during.atNew, [30, 60, 200, 255]) && like(during.atOld, [255, 255, 255, 255]);
  checks.moveOneOp = mv.length === 1 && !!moveOp && near(moveOp.m[4], dxPt, 1) && near(moveOp.m[5], dyPt, 1) && moveOp.m[0] === 1 && moveOp.m[3] === 1;
  checks.moveShownBeforeCommit = during?.afterRelease?.mode === 'commit' || (during?.afterRelease?.painted ?? 0) > 0;
  const movedTo = mapR(HANDLE_AT.blue, moveOp?.m ?? [1, 0, 0, 1, 0, 0]);
  const dNew = await diff(0, shrink(movedTo, 4)), dOld = await diff(0, shrink(HANDLE_AT.blue, 4)), dElse = await diff(0, { x0: 300, y0: 100, x1: 500, y1: 180 });
  summary.moveCommit = { dNew, dOld, dElse };
  checks.moveCommitShows = !!dNew && dNew.diff > dNew.total * 0.9 && !!dOld && dOld.diff > dOld.total * 0.9 && !!dElse && dElse.diff === 0;
  checks.moveStaysSelected = (await state()).selected?.id === blue.id;

  // 3. resize: the ne handle freely, then with Shift (proportions kept)
  const q1 = (await app((a) => a.tools.select.quad())) as [number, number][];
  const ne1 = await handle('ne');
  await dragTo(ne1, { x: ne1.x + 40, y: ne1.y - 10 });
  const rz = await lastOp();
  const q2 = q1.map(([x, y]) => ap(rz.m, x, y));
  checks.resizeFree = rz.op === 'transform' && near(q2[0][0], q1[0][0], 0.01) && near(q2[0][1], q1[0][1], 0.01) &&
    near(q2[2][0], q1[2][0] + 40 * ptPerPx, 1) && near(q2[2][1], q1[2][1] + 10 * ptPerPx, 1) && !near(rz.m[0], rz.m[3], 0.01);
  const q3 = (await app((a) => a.tools.select.quad())) as [number, number][];
  const ne2 = await handle('ne');
  await dragTo(ne2, { x: ne2.x + 50, y: ne2.y - 5 }, { shift: true });
  const rs = await lastOp();
  checks.resizeShiftKeepsProportions = rs.op === 'transform' && near(rs.m[0], rs.m[3], 1e-6) && rs.m[0] > 1.05 && near(ap(rs.m, q3[0][0], q3[0][1])[0], q3[0][0], 0.01);
  summary.resize = { free: rz.m, shift: rs.m };

  // 4. turn: the rotation handle (free, then Shift: 15° steps); Turn right: a quarter turn
  const q4 = (await app((a) => a.tools.select.quad())) as [number, number][];
  const cx = (q4[0][0] + q4[2][0]) / 2, cy = (q4[0][1] + q4[2][1]) / 2;
  const cc = await client(0, cx, cy);
  const rot = await handle('rot');
  const r0 = Math.hypot(rot.x - cc.x, rot.y - cc.y), a0 = Math.atan2(rot.y - cc.y, rot.x - cc.x);
  const turnTo = (deg: number) => ({ x: cc.x + r0 * Math.cos(a0 + (deg * Math.PI) / 180), y: cc.y + r0 * Math.sin(a0 + (deg * Math.PI) / 180) });
  await dragTo(rot, turnTo(37));   // 37° clockwise on screen
  const t1 = await lastOp();
  const rotB = await handle('rot');
  // the handle turned 22° further about the centre (on screen, clockwise): Shift makes it a multiple of 15°
  const k22 = (22 * Math.PI) / 180, bx = rotB.x - cc.x, by = rotB.y - cc.y;
  await dragTo(rotB, { x: cc.x + bx * Math.cos(k22) - by * Math.sin(k22), y: cc.y + bx * Math.sin(k22) + by * Math.cos(k22) }, { shift: true });
  const t2 = await lastOp();
  await page.click('[data-tool="select"] button[data-cmd="turn-right"]');
  const t3 = await lastOp();
  await waitCommit();
  summary.turn = { free: angleOf(t1.m), shift: angleOf(t2.m), quarter: angleOf(t3.m) };
  checks.turnFree = t1.op === 'transform' && near(angleOf(t1.m), -37, 1.5);
  checks.turnShiftSnaps = t2.op === 'transform' && Math.abs(angleOf(t2.m) / 15 - Math.round(angleOf(t2.m) / 15)) < 1e-6 && angleOf(t2.m) !== 0;
  checks.turnQuarter = t3.op === 'transform' && near(angleOf(t3.m), -90, 1e-6);
  checks.turnCommitted = (await diff(0, shrink(HANDLE_AT.blue, 4)))!.diff > 0;

  // 5. nudge with the arrows; delete a path (the note once per session); undo brings it back
  const before = (await ops()).length;
  await page.keyboard.press('Shift+ArrowLeft');
  const nd = await lastOp();
  checks.nudge = (await ops()).length === before + 1 && near(nd.m[4], -10, 1e-6) && near(nd.m[5], 0, 1e-6);
  await select(0, 340, 220, orange.id);
  await page.keyboard.press('Delete');
  const del = await lastOp();
  const s1 = await status();
  checks.deleteOp = del.op === 'delete' && del.ids.includes(orange.id) && (await state()).selected === null;
  checks.deleteNote = /not a redaction/.test(s1);
  await waitCommit();
  const dDel = await diff(0, shrink(HANDLE_AT.orange, 3));
  checks.deleteCommitted = !!dDel && dDel.diff > dDel.total * 0.9;
  await page.keyboard.press('Control+z');
  checks.undoDelete = (await lastOp()).op !== 'delete';
  await waitCommit();
  await select(0, 340, 220, orange.id);
  await page.keyboard.press('Delete');
  const s2 = await status();
  checks.deleteNoteOnce = /Deleted/.test(s2) && !/not a redaction/.test(s2);
  summary.delete = { first: s1, second: s2 };
  await page.keyboard.press('Control+z');
  await waitCommit();

  // 6. the shared crop: a rectangle clip (with its crop, then without), and a triangle clip
  await select(0, 150, 540, green.id);
  const cg = await client(0, 150, 540);
  const cropTo = { x: cg.x + 300 / ptPerPx, y: cg.y - 150 / ptPerPx };   // 300 pt right, 150 pt up
  await dragTo(cg, cropTo);
  const cm = await lastOp();
  const crop = await app((a) => a.tools.select.crop);
  const T = cm.m as M;
  const clipAt = mapR(HANDLE_AT.rectClip, T), wholeAt = mapR(HANDLE_AT.green, T);
  const strip = { x0: wholeAt.x0 + 2, y0: wholeAt.y0 + 2, x1: clipAt.x0 - 4, y1: wholeAt.y1 - 2 };   // inside the image, left of the clip
  const inClip = await diff(0, shrink(clipAt, 3)), outClip = await diff(0, strip);
  summary.cropWith = { op: cm, crop, inClip, outClip, msg: await status(), skipped: await app((a) => a.tools.select.lastSkipped) };
  checks.cropOffered = cm.op === 'transform' && cm.sharedClip === 'move' && !!crop?.shown && crop.choice === 'move' &&
    (await page.$eval('[data-tool="select"] .crop', (e: Element) => !(e as HTMLElement).hidden));
  checks.cropMovesWithIt = !!inClip && inClip.diff > inClip.total * 0.9 && !!outClip && outClip.diff === 0;
  checks.cropMateStays = (await diff(0, shrink(HANDLE_AT.rectMate, 3)))!.diff === 0;
  await page.click('[data-tool="select"] button[data-crop="drop"]');
  const cd = await lastOp();
  await waitCommit();
  const outClip2 = await diff(0, strip);
  summary.cropWithout = { op: cd, outClip: outClip2 };
  checks.cropWithoutShowsWhole = cd.sharedClip === 'drop' && near(cd.m[4], T[4], 1e-9) && (await ops()).filter((o) => o.op === 'transform' && o.ids.includes(green.id)).length === 1 &&
    !!outClip2 && outClip2.diff > outClip2.total * 0.9;
  await select(0, 350, 560, red.id);
  const cr = await client(0, 350, 560);
  await dragTo(cr, { x: cr.x - 230 / ptPerPx, y: cr.y + 150 / ptPerPx });
  const tri = await lastOp();
  const triT = tri.m as M;
  const [tx, ty] = ap(triT, 350, 540), [ox, oy] = ap(triT, 305, 590);
  const triIn = await diff(0, { x0: tx - 3, y0: ty - 3, x1: tx + 3, y1: ty + 3 }), triOut = await diff(0, { x0: ox - 2, y0: oy - 2, x1: ox + 2, y1: oy + 2 });
  summary.cropTriangle = { op: tri, triIn, triOut };
  checks.cropTriangle = tri.sharedClip === 'move' && !!triIn && triIn.diff === triIn.total && !!triOut && triOut.diff === 0 && (await app((a) => a.tools.select.lastSkipped)) === null;

  // 7. an added image: selected by the select tool; a handle resizes its frame; Turn left turns it a quarter
  await reveal(0, { x0: 380, y0: 40, x1: 560, y1: 200 });
  summary.added = await app((a, b64) => a.tools.place.add(b64, 'image/png', 0, { x: 480, y: 100 }), Buffer.from(png).toString('base64'));
  await page.waitForFunction(() => (window as any).__app.tools.select.state.selected?.id?.startsWith('add:'), undefined, { timeout: 20000 });
  const a1 = (await app((a) => a.tools.place.added(0)))[0];
  const addId = `add:${a1.key}`;
  checks.addedSelected = (await state()).selected?.id === addId && (await app((a) => a.tools.place.state.selected?.key)) === a1.key;
  await waitCommit();
  const ane = await handle('ne');
  await dragTo(ane, { x: ane.x + 20, y: ane.y - 10 });
  const a2 = (await app((a) => a.tools.place.added(0)))[0];
  checks.addedResized = near(a2.frame.x0, a1.frame.x0, 0.01) && near(a2.frame.y0, a1.frame.y0, 0.01) && near(a2.frame.x1, a1.frame.x1 + 20 * ptPerPx, 1) && near(a2.frame.y1, a1.frame.y1 + 10 * ptPerPx, 1);
  await page.click('[data-tool="select"] button[data-cmd="turn-left"]');
  const a3 = (await app((a) => a.tools.place.added(0)))[0];
  // a quarter turn left (counter-clockwise) is a clockwise turn of 270° in the op's terms
  checks.addedTurned = a3.rotate === 270 && near(a3.frame.x1 - a3.frame.x0, a2.frame.y1 - a2.frame.y0, 0.01);
  await waitCommit();
  summary.addedFrames = { a1: a1.frame, a2: a2.frame, a3: { frame: a3.frame, rotate: a3.rotate } };

  // 8. export
  await page.click('#export');
  await page.waitForSelector('#download:not([hidden])', { timeout: 120000 });
  const rep = await app((a) => a.lastExport.report);
  const pr0 = rep?.pages?.find((p: A) => p.page === 0);
  summary.export = { ok: rep?.ok, failures: rep?.failures, changed: pr0?.objectsChanged?.map((c: A) => `${c.action} ${c.id}${c.split?.length ? ' split' : ''}${c.dropped?.length ? ' dropped' : ''}`), skipped: pr0?.objectsSkipped, added: pr0?.imagesAdded?.length };
  checks.exportOk = !!rep?.ok && rep.verified && !(pr0?.objectsSkipped?.length);
  checks.exportHasAll = !!pr0?.objectsChanged?.some((c: A) => c.id === blue.id && c.action === 'transform') && !!pr0.objectsChanged.some((c: A) => c.id === green.id && c.dropped?.length) &&
    !!pr0.objectsChanged.some((c: A) => c.id === red.id && c.split?.length) && pr0.imagesAdded?.length === 1;

  // 9. the turned page: a handle drag lands under the pointer; ArrowRight nudges right as shown; a text box is edited
  await app((a) => a.scrollToPage(1));
  await page.waitForFunction(() => { const a = (window as any).__app; return a.doc.pages[1] && a.rendered(1)?.orig; }, undefined, { timeout: 60000 });
  await app((a) => a.tools.select.load(1));
  const items1 = (await app((a) => a.tools.select.items(1))) as A[];
  const rimg = items1.find((s) => s.kind === 'image');
  await reveal(1, { x0: 60, y0: 120, x1: 380, y1: 480 });
  await select(1, 290, 220, rimg.id);
  const rq = (await app((a) => a.tools.select.quad())) as [number, number][];
  const rh = await handle('ne');
  const rneWant = await client(1, rq[2][0], rq[2][1]);
  checks.rotatedHandleOnCorner = Math.hypot(rh.x - rneWant.x, rh.y - rneWant.y) < 1.5;
  const rTo = { x: rh.x + 25, y: rh.y + 15 };
  await dragTo(rh, rTo, { n: 1 });
  const rop = await lastOp(1);
  const [nx, ny] = ap(rop.m, rq[2][0], rq[2][1]);
  const landed = await client(1, nx, ny);
  summary.rotatedResize = { op: rop.m, landed, at: rTo };
  checks.rotatedResizeUnderPointer = Math.hypot(landed.x - rTo.x, landed.y - rTo.y) < 1.5;
  await page.keyboard.press('ArrowRight');
  const rn = await lastOp(1);
  checks.rotatedNudgeAsShown = near(rn.m[4], 0, 1e-9) && near(rn.m[5], 1, 1e-9);   // shown right is user +y on a page turned 90°
  await waitCommit(1);
  // text: the editor selects the box; a double-click edits it
  const box = (await app((a) => a.doc.pages[1].boxes.map((b: A) => ({ id: b.id, frame: b.frame, text: b.paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join('')).join('\n') }))))[0];
  const bc = await app((a, p) => a.clientRect(1, p), box.frame);
  summary.rotatedBox = { box, client: bc };
  checks.rotatedBoxShownTurned = bc.h > bc.w * 2;   // a line of text, turned: tall and narrow as shown
  await page.mouse.click(bc.x + bc.w / 2, bc.y + bc.h / 2);
  await page.waitForFunction((id: string) => (window as any).__app.selected?.id === id, box.id, { timeout: 10000 });
  await page.mouse.dblclick(bc.x + bc.w / 2, bc.y + bc.h * 0.85);
  await page.waitForFunction(() => (window as any).__app.editing, undefined, { timeout: 10000 });
  await page.keyboard.press('End');
  await page.keyboard.type(' more');
  const caret = await app((a) => a.caret());
  const laid = await app((a, id) => a.laid(1, id).frame, box.id);
  const after = await app((a, id) => a.doc.pages[1].boxes.find((b: A) => b.id === id).paragraphs.map((p: A) => p.runs.map((r: A) => r.text).join('')).join('\n'), box.id);
  const paintedText = await painted(1, laid);
  summary.rotatedEdit = { after, caret, laid, paintedText };
  checks.rotatedTextEdited = after === `${box.text} more`;
  checks.rotatedTextDrawn = (paintedText ?? 0) > 50;
  checks.rotatedCaretAcross = !!caret && !caret.hidden && caret.rect.w > caret.rect.h * 3;
  const lc = await app((a, p) => a.clientRect(1, p), laid);
  // the caret after the last word, inside the box as shown (the text wrapped onto a second line, a column to the left)
  checks.rotatedCaretInBox = !!caret && caret.rect.x >= lc.x - 1 && caret.rect.x + caret.rect.w <= lc.x + lc.w + 1 && caret.rect.y >= lc.y - 1 && caret.rect.y <= lc.y + lc.h + 1;
  await page.keyboard.press('Escape');   // editing ends
  await waitCommit(1);
  await page.keyboard.press('Escape');   // the box is let go: the page shows its commit render alone
  await page.waitForFunction(() => !(window as any).__app.selected, undefined, { timeout: 10000 });
  const dText = await diff(1, laid);
  const leftOver = await painted(1, laid);
  summary.rotatedCommit = { dText, leftOver, state: await app((a) => a.pageState(1)) };
  checks.rotatedTextCommitted = !!dText && dText.diff > 20 && leftOver === 0;

  const st = (await app((a) => a.tools.select.stats)) as A;
  timings.previewMs = st.previewMs;
  timings.underlayMs = st.underlayMs;
  timings.workerCommitMs = st.commitMs;
  checks.noErrors = errors.length === 0;
  checks.noOutsideRequests = blocked.size === 0;
} catch (e) {
  errors.push(`smoke: ${(e as Error).message.split('\n')[0]}`);
  if (pageRef) {
    summary.failure = await pageRef.evaluate(() => { const a = (window as any).__app; return a && { select: a.tools.select?.state && { ...a.tools.select.state, list: undefined }, msg: document.getElementById('st-msg')?.textContent }; }).catch(() => null);
    await pageRef.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}
const stat = (xs: number[]) => (xs.length ? { n: xs.length, median: [...xs].sort((a, b) => a - b)[xs.length >> 1], max: Math.max(...xs) } : null);
const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify({ ok, checks, ...summary, timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, stat(v)])), errors, blocked: [...blocked] }, null, 1));
if (!ok) process.exitCode = 1;
