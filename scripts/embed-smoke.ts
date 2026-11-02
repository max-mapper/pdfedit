// Embed mode (app/embed.ts, docs/EMBED.md), headless: a tiny local host serves an embed build at /pdf-editor/, the
// substitution catalogue at /fonts/<file> (from fonts/), the host API at /api/docs/d1 (doc, source, pairs paged two at
// a time, segment state paged four at a time, links, shorten, versions, exports) and the segment route at
// /host/segments/<seg>, for a synthetic two-page Japanese PDF with synthetic pairs. The doc has targeted
// shortening on. Headless Chromium opens the frame URL and checks:
//   - load: every page translated from the segments (an exact pair, a paragraph that is a run of three segments, a
//     duplicate source taken in reading order), the untranslated paragraph listed (a click selects its box), catalogue
//     fonts from the host and none from the bundle but the defaults;
//   - links: posted once, with the expected segments; the over-long box shortened through /shorten (budget, segment),
//     listed, and nothing of it written to its segment;
//   - write-through: an edit of a one-segment paragraph is a PATCH with base_version_id and the segment's marks; an
//     edit inside the second segment of a three-segment paragraph writes that segment only; in edit mode the ranges
//     are drawn with their boundaries and the caret names its segment (with the host's segment link, ?seglink= and ?seglabel=); Backspace at a
//     boundary, a selection across a boundary and Enter are refused (real keys); a locked middle segment refuses while
//     its neighbours write; a confirmed paragraph refuses; split and merge of linked boxes are refused; a 409 with the
//     current text reverts and lists the conflict; a 409 without one (locked elsewhere) reverts;
//   - Save posts a version (base_n, only edited boxes, the shortened list), a stale head gets 409 head_moved, Export
//     saves first and posts the verified PDF with its report (shortened filled), the PDF holds the edits;
//   - reload: links are not posted again, the saved version comes back, a segment changed on the host wins over the
//     saved box (whose frame stays), the shortened text stays, and "Use faithful" puts the faithful text back without
//     a write;
//   - a second frame without ?segments= and ?seglink=: the links load, linked text is read-only with the reason
//     shown, nothing is written, and the panel names segments without links.
// Every request to another host is aborted and listed.
//   node scripts/embed-smoke.ts <embed-build-dir> [out-dir]
// Build first: node scripts/build-embed.mjs <embed-build-dir> (base /pdf-editor/). Playwright comes from PW_CORE
// (default: the playwright-core package), Chromium from CHROME (default: the one Playwright installed). Synthetic text only.
import { createRequire } from 'node:module';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { buildPdf } from '../src/layout/testkit.ts';
import { openPdfium } from '../src/engine/pdfium.ts';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'playwright-core');
const CHROME = process.env.CHROME || chromium.executablePath();
const BUILD = process.argv[2];
if (!BUILD) { console.error('usage: node scripts/embed-smoke.ts <embed-build-dir> [out-dir]'); process.exit(2); }
const OUT = process.argv[3] || (await mkdtemp(join(tmpdir(), 'pdfedit-embed-smoke-')));
const FONTS = join(import.meta.dirname, '..', 'fonts');

// ── the synthetic document and pairs ────────────────────────────────────────────────────────────────────────
const HEAD = '統合報告書の概要';
const A1 = 'まず一文目です。', A2 = '次に二文目です。', A3 = '最後に三文目です。';
const B1 = 'ここは四文目です。', B2 = 'ここは五文目です。', B3 = 'ここは六文目です。';
const LONE = 'この段落には対応する訳がありません。';
const HEAD2 = '二ページ目の見出し';
const LONGSRC = '長い訳文になる短い原文です。';
const LONG = ('This short source sentence comes back as a very long English rendering that goes on and on, adding clause after ' +
  'clause about nothing in particular, so that it cannot possibly fit into the narrow space the original line had between ' +
  'the two rules drawn above and below it on this synthetic test page, whatever the fitter tries to do with it. ').repeat(2).trim();
const SHORT = 'A shorter synthetic sentence.';
const TYPED = 'Typed by hand';
const T = { g1: 'Overview of the integrated report', ga1: 'First sentence here.', ga2: 'Then the second one.', ga3: 'Finally the third.',
  gb1: 'Fourth sentence.', gb2: 'Fifth sentence.', gb3: 'Sixth sentence.', g5: 'Second page heading', g7: 'Overview, second occurrence' };
async function syntheticPdf(): Promise<Uint8Array> {
  const p1 = await buildPdf([
    { t: 'set', text: HEAD, x: 60, y: 760, size: 18, face: 'ja' },
    { t: 'set', text: A1 + A2 + A3, x: 60, y: 690, size: 12, face: 'ja' },
    { t: 'set', text: B1 + B2 + B3, x: 60, y: 620, size: 12, face: 'ja' },
    { t: 'set', text: LONE, x: 60, y: 550, size: 12, face: 'ja' },
  ]);
  const p2 = await buildPdf([
    { t: 'set', text: HEAD2, x: 60, y: 780, size: 16, face: 'ja' },
    { t: 'set', text: HEAD, x: 60, y: 740, size: 18, face: 'ja' },
    // rules above and below the long box: it cannot grow (the fit leaves it unfit, so it is shortened)
    { t: 'line', x1: 40, y1: 714, x2: 560, y2: 714, lw: 1 },
    { t: 'set', text: LONGSRC, x: 60, y: 688, size: 12, face: 'ja' },
    { t: 'line', x1: 40, y1: 668, x2: 560, y2: 668, lw: 1 },
  ]);
  const out = await PDFDocument.create();
  for (const src of [p1, p2]) { const [pg] = await out.copyPages(await PDFDocument.load(src), [0]); out.addPage(pg); }
  return out.save({ useObjectStreams: false });
}
type SegRow = { seg_id: string; source: string; text: string; version: number; marks: { start: number; end: number; type: string }[]; locked: boolean; confirmed: boolean };
const seg = (seg_id: string, source: string, text: string, o: Partial<SegRow> = {}): SegRow => ({ seg_id, source, text, version: 0, marks: [], locked: false, confirmed: false, ...o });
const SEGS: SegRow[] = [
  seg('g1', HEAD, T.g1, { marks: [{ start: 0, end: 8, type: 'b' }] }),
  seg('ga1', A1, T.ga1), seg('ga2', A2, T.ga2), seg('ga3', A3, T.ga3),
  seg('gb1', B1, T.gb1), seg('gb2', B2, T.gb2, { locked: true }), seg('gb3', B3, T.gb3),
  seg('g4', '使われない文。', 'An unused sentence.'),
  seg('g5', HEAD2, T.g5, { confirmed: true }),
  seg('g7', HEAD, T.g7),
  seg('g6', LONGSRC, LONG),
];
const pdfBytes = await syntheticPdf();
await writeFile(join(OUT, 'synthetic.pdf'), pdfBytes);

// ── the host ────────────────────────────────────────────────────────────────────────────────────────────────
type A = any;
const host = {
  head: 0,
  versions: [] as { n: number; base_n: number; state: A; summary: string }[],
  exports: [] as { n: number; bytes: Buffer; report: A; type: string }[],
  fontRequests: [] as string[],
  bundleFonts: [] as string[],
  pairPages: 0,
  statePages: 0,
  links: null as null | { engine: string; links: A[] },
  linkPosts: [] as { status: number; engine: unknown; count: number }[],
  shortenCalls: [] as A[][],
  patches: [] as { seg: string; status: number; body: A }[],
};
const segs = new Map(SEGS.map((s) => [s.seg_id, s]));
const vid = (s: SegRow) => `v-${s.seg_id}-${s.version}`;
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.ttf': 'font/ttf', '.txt': 'text/plain' };
const API = '/api/docs/d1';
const SEG_API = '/host/segments/';
const SEG_LINK = '/host/segment-editor?file=f1&seg={seg}';
const SEG_LABEL = 'Edit on the host';
const body = (req: IncomingMessage) => new Promise<Buffer>((r) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => r(Buffer.concat(parts))); });
const json = (res: ServerResponse, status: number, x: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(x)); };
const docView = () => ({ id: 'd1', head: host.head, title: 'synthetic.pdf', settings: { shorten: true },
  links: host.links ? { engine: host.links.engine, count: host.links.links.length } : null });
const stateRow = (s: SegRow) => ({ seg_id: s.seg_id, version_id: vid(s), text: s.text, marks: s.marks, locked: s.locked, confirmed: s.confirmed, stale: false,
  editable: !s.locked && !s.confirmed, why_not: s.locked ? 'locked' : s.confirmed ? 'confirmed' : null });

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  const path = decodeURIComponent(url.pathname);
  try {
    if (path.startsWith('/pdf-editor/')) {
      const rel = normalize(path.slice('/pdf-editor/'.length) || 'index.html').replace(/^(\.\.[/\\])+/, '');
      if (/\.ttf$/.test(rel)) host.bundleFonts.push(rel);
      const file = join(BUILD, rel);
      const b = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(b);
    } else if (path.startsWith('/fonts/')) {
      const name = path.slice(7);
      host.fontRequests.push(name);
      if (!/^[A-Za-z0-9._-]+\.ttf$/.test(name)) return json(res, 404, { error: 'no such font', code: 'not_found' });
      const b = await readFile(join(FONTS, name));
      res.writeHead(200, { 'content-type': 'font/ttf' });
      res.end(b);
    } else if (path === API && req.method === 'GET') {
      json(res, 200, { doc: docView(), versions: host.versions.map((v) => ({ n: v.n, summary: v.summary })), exports: host.exports.map((x) => ({ n: x.n })) });
    } else if (path === `${API}/source`) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(Buffer.from(pdfBytes));
    } else if (path === `${API}/pairs`) {
      host.pairPages++;
      const at = Number(url.searchParams.get('cursor') || 0);
      const next = at + 2 < SEGS.length ? String(at + 2) : null;
      json(res, 200, { pairs: SEGS.slice(at, at + 2).map((s) => ({ seg_id: s.seg_id, source: s.source, target: s.text, confirmed: s.confirmed })), next });
    } else if (path === `${API}/state`) {
      host.statePages++;
      const at = Number(url.searchParams.get('cursor') || 0);
      const next = at + 4 < SEGS.length ? String(at + 4) : null;
      json(res, 200, { segments: SEGS.slice(at, at + 4).map(stateRow), next });
    } else if (path === `${API}/links` && req.method === 'POST') {
      const b = JSON.parse(String(await body(req)));
      const fail = (status: number, x: A) => { host.linkPosts.push({ status, engine: b.engine, count: b.links?.length ?? 0 }); json(res, status, x); };
      if (typeof b.engine !== 'string' || !/^[A-Za-z0-9._:+-]{1,80}$/.test(b.engine)) return fail(400, { error: 'engine is 1-80 of [A-Za-z0-9._:+-]', code: 'bad_links' });
      if (!Array.isArray(b.links) || !b.links.every((l: A) => l.seg_ids.every((id: string) => segs.has(id)))) return fail(400, { error: 'a link names a segment of another copy', code: 'bad_links' });
      if (host.links) return fail(409, { error: 'links exist', code: host.links.engine === b.engine ? 'links_exist' : 'engine_mismatch' });
      host.links = { engine: b.engine, links: b.links };
      host.linkPosts.push({ status: 200, engine: b.engine, count: b.links.length });
      json(res, 200, { doc: docView() });
    } else if (path === `${API}/links` && req.method === 'GET') {
      if (!host.links) return json(res, 404, { error: 'no links', code: 'not_found' });
      json(res, 200, { links_version: 1, engine: host.links.engine, links: host.links.links });
    } else if (path === `${API}/shorten` && req.method === 'POST') {
      const b = JSON.parse(String(await body(req)));
      if (!docView().settings.shorten) return json(res, 403, { error: 'shortening is off for this doc', code: 'shorten_off' });
      if (!Array.isArray(b.items) || b.items.length > 30) return json(res, 400, { error: 'at most 30 items', code: 'bad_items' });
      host.shortenCalls.push(b.items);
      // only the long box's segment has a shorter text; any other item comes back as it was (kept by the editor)
      json(res, 200, { items: b.items.map((it: A) => (it.seg_id === 'g6' ? SHORT : it.english)) });
    } else if (path.startsWith(SEG_API) && req.method === 'PATCH') {
      const id = path.slice(SEG_API.length);
      const b = JSON.parse(String(await body(req)));
      const s = segs.get(id);
      const answer = (status: number, x: A) => { host.patches.push({ seg: id, status, body: b }); json(res, status, x); };
      if (!s) return answer(404, { error: `no segment ${id}` });
      if (!Object.hasOwn(b, 'base_version_id')) return answer(400, { error: 'base_version_id is required' });
      if (b.base_version_id !== vid(s)) return answer(409, { error: `${id} has moved on`, current: { id: vid(s), text: s.text, marks: s.marks } });
      if (s.locked) return answer(409, { error: `${id} is locked; unlock it first` });
      if (s.confirmed) return answer(409, { error: `${id} is confirmed; reopen it first` });
      if (!Array.isArray(b.marks) || b.marks.some((m: A) => m.end > b.text.length)) return answer(400, { error: 'a mark is {start, end} within the text' });
      s.version++; s.text = b.text; s.marks = b.marks;
      answer(201, { segment: { id }, version: { id: vid(s), text: s.text, marks: s.marks }, unchanged: false });
    } else if (path.startsWith(`${API}/versions/`) && req.method === 'GET') {
      const v = host.versions.find((x) => x.n === Number(path.split('/').pop()));
      if (!v) return json(res, 404, { error: 'no such version', code: 'not_found' });
      json(res, 200, { version: { n: v.n, summary: v.summary }, state: v.state });
    } else if (path === `${API}/versions` && req.method === 'POST') {
      const b = JSON.parse(String(await body(req)));
      if (b.base_n !== host.head) return json(res, 409, { error: `the doc is at version ${host.head}, not ${b.base_n}`, code: 'head_moved', head: host.head });
      const n = host.head + 1;
      host.versions.push({ n, base_n: b.base_n, state: b.state, summary: b.summary });
      host.head = n;
      json(res, 200, { doc: docView(), version: { n, summary: b.summary } });
    } else if (path === `${API}/exports` && req.method === 'POST') {
      const bytes = await body(req);
      const n = Number(url.searchParams.get('n'));
      if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return json(res, 400, { error: 'not a PDF', code: 'not_pdf' });
      host.exports.push({ n, bytes, report: JSON.parse(String(req.headers['x-pdfedit-report'] || 'null')), type: String(req.headers['content-type']) });
      json(res, 200, { export: { id: `x${host.exports.length}`, n } });
    } else json(res, 404, { error: 'not found', code: 'not_found' });
  } catch (e) { json(res, 500, { error: String((e as Error).message) }); }
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const FRAME_NO_SEGMENTS = `${base}/pdf-editor/index.html?doc=d1&api=${encodeURIComponent(API)}&fonts=/fonts`;
const FRAME = `${FRAME_NO_SEGMENTS}&segments=${encodeURIComponent(SEG_API)}&seglink=${encodeURIComponent(SEG_LINK)}&seglabel=${encodeURIComponent(SEG_LABEL)}`;
const segHref = (seg: string) => SEG_LINK.replace('{seg}', seg);

const strip = (s: string) => s.normalize('NFKC').replace(/[\u0002­-]/gu, '').replace(/\s+/gu, '');
const blocked = new Set<string>();
const errors: string[] = [];
const summary: Record<string, unknown> = { pdf: join(OUT, 'synthetic.pdf') };
const checks: Record<string, boolean> = {};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
let pageRef: A = null;
try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await ctx.route('**/*', (r: A) => {
    const u = r.request().url();
    if (u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')) return r.continue();
    blocked.add(u); return r.abort();
  });
  const page = await ctx.newPage();
  pageRef = page;
  page.on('pageerror', (e: Error) => errors.push(e.message));
  page.on('console', (m: A) => { if (m.type() === 'error' && !/409|Conflict/.test(m.text())) errors.push(m.text()); });
  const app = <T>(fn: (a: A, arg: any) => T, arg?: unknown): Promise<T> =>
    page.evaluate(([src, x]: [string, unknown]) => (0, eval)(src)((window as any).__app, x), [`(${fn.toString()})`, arg]);
  const waitApp = (fn: (a: A, arg: any) => unknown, arg?: unknown, timeout = 90000) =>
    page.waitForFunction(([src, x]: [string, unknown]) => { const a = (window as any).__app; return !!a && (0, eval)(src)(a, x); }, [`(${fn.toString()})`, arg], { timeout });
  const texts = (a: A) => a.doc.pages.map((p: A) => p.boxes.map((b: A) => ({ id: b.id, edited: b.edited, frame: b.frame, text: b.paragraphs.map((q: A) => q.runs.map((r: A) => r.text).join('')).join('\n') })));
  const stMsg = () => page.textContent('#st-msg');
  /** The box (page, id) whose text starts with `start`. */
  const boxOf = async (start: string): Promise<{ page: number; id: string; text: string }> => {
    const all = await app(texts) as A[][];
    for (let n = 0; n < all.length; n++) for (const b of all[n]) if (b.text.startsWith(start)) return { page: n, id: b.id, text: b.text };
    throw new Error(`no box starting with ${start}`);
  };
  const patchesOf = (id: string) => host.patches.filter((p) => p.seg === id);
  // Write-through runs when editing ends (or on Save or Export), never mid-typing: end it, then wait for the writes.
  const settle = async (count: number) => { await app((a) => a.endEditing()); await waitApp((a, n) => a.embed.writes.length >= n && !a.embed.writing && a.embed.pendingWrites.length === 0, count, 15000); };
  /** An input as the text box sends it (gate first), on a box's text. Returns the refusal, or null. */
  const input = (b: { page: number; id: string }, x: { type: string; data: string | null; start: number; end: number }) =>
    app((a, y) => a.input(y.page, y.id, y.x), { page: b.page, id: b.id, x });

  // 1. load: the frame reads the doc, the PDF, the pairs and the segments (paged), links, translates, shortens
  const t0 = Date.now();
  await page.goto(FRAME);
  await waitApp((a) => a.embed?.ready);
  await waitApp((a) => a.embed.linksStored !== null, undefined, 15000);
  summary.loadMs = Date.now() - t0;
  const t1 = await app(texts);
  summary.boxes = t1;
  const all = (t1 as A[]).flat();
  checks.pairsPaged = host.pairPages === 6 && host.statePages === 3;
  checks.exactPair = all.some((b: A) => b.text === T.g1 && b.edited);
  checks.threeSegments = all.some((b: A) => b.text === `${T.ga1} ${T.ga2} ${T.ga3}`);
  checks.duplicateInReadingOrder = (t1 as A[])[1]?.some((b: A) => b.text === T.g7) && (t1 as A[])[0]?.some((b: A) => b.text === T.g1);
  checks.secondPage = (t1 as A[])[1]?.some((b: A) => b.text === T.g5);
  const e1 = await app((a) => a.embed);
  summary.embed = { ...e1, links: e1.links.map((l: A) => ({ box: l.box, page: l.page, seg_ids: l.seg_ids, ok: l.ok })) };
  checks.untranslatedListed = e1.untranslated.length === 1 && strip(e1.untranslated[0].text) === strip(LONE);
  checks.openHidden = await page.evaluate(() => document.getElementById('open')!.hidden);
  checks.saveEnabledWhenUnsaved = await page.evaluate(() => !(document.getElementById('save') as HTMLButtonElement).disabled);
  // links posted once, with the run of three and the duplicate on page 2
  const posted = host.links?.links ?? [];
  summary.links = { posts: host.linkPosts, links: posted.map((l: A) => `${l.page}/${l.box}#${l.para}:${l.seg_ids.join('+')}`) };
  checks.linksPostedOnce = host.linkPosts.length === 1 && host.linkPosts[0].status === 200 && e1.linksPosts === 1 &&
    posted.every((l: A) => /^[0-9a-f]{64}$/.test(l.src_sha)) &&
    posted.some((l: A) => l.page === 0 && l.seg_ids.join() === 'ga1,ga2,ga3') && posted.some((l: A) => l.page === 1 && l.seg_ids.join() === 'g7') &&
    posted.some((l: A) => l.page === 0 && l.seg_ids.join() === 'g1') && posted.some((l: A) => l.seg_ids.join() === 'g6');
  // shortening: one call, the long box with its segment and budget; the box shows the shorter text; nothing written
  const items = host.shortenCalls.flat();
  summary.shorten = { calls: host.shortenCalls.length, items: items.map((i: A) => ({ seg_id: i.seg_id, max_chars: i.max_chars, chars: i.english.length })), shortened: e1.shortened };
  checks.shortenCalled = host.shortenCalls.length === 1 && items.some((i: A) => i.seg_id === 'g6' && i.english === LONG && i.max_chars < LONG.length && i.max_chars >= Math.floor(LONG.length * 0.5)) &&
    items.every((i: A) => typeof i.source === 'string' && i.source.length > 0);
  checks.shortenedApplied = all.some((b: A) => b.text === SHORT) && e1.shortened.some((s: A) => s.seg_id === 'g6' && s.after === SHORT && s.before === LONG && s.active);
  checks.shortenedListed = (await page.$$('#embed-shortened button[data-faithful]')).length === 1;
  checks.noWritesOnLoad = host.patches.length === 0 && e1.pendingWrites.length === 0;

  // 2. fonts: catalogue faces from the host's /fonts/, none from the bundle but the three defaults
  summary.fonts = { host: [...new Set(host.fontRequests)], bundle: [...new Set(host.bundleFonts)] };
  checks.hostFonts = host.fontRequests.length > 0;
  checks.bundleDefaultsOnly = host.bundleFonts.every((f) => /(NotoSans-Regular|NotoSans-Bold|NotoSansJP-VF)-[^/]*\.ttf$/.test(f));

  // 3. the untranslated list: a click selects the box
  await page.click('#embed-list button[data-box]');
  const selected = await app((a) => a.selected);
  checks.listSelects = !!selected && selected.page === e1.untranslated[0].page && selected.id === e1.untranslated[0].box;

  // 4. write-through, one segment: a PATCH with base_version_id and the segment's marks
  const g1 = await boxOf(T.g1);
  checks.g1Typed = await app((a, x) => a.textEdit(x.page, x.id, [x.text]), { ...g1, text: `${T.g1}, edited` });
  await page.waitForTimeout(1500);
  checks.noWriteWhileEditing = patchesOf('g1').length === 0 && (await app((a) => a.embed.pendingWrites.length)) === 1;
  await settle(1);
  const p1 = patchesOf('g1')[0];
  checks.writeThrough = !!p1 && p1.status === 201 && p1.body.text === `${T.g1}, edited` && p1.body.base_version_id === 'v-g1-0' &&
    JSON.stringify(p1.body.marks) === JSON.stringify([{ start: 0, end: 8, type: 'b' }]) && segs.get('g1')!.text === `${T.g1}, edited`;

  // 5. three segments: an edit inside the second writes the second only
  const ga = await boxOf(T.ga1);
  const at2 = ga.text.indexOf('one.') + 3;
  checks.gaTyped = (await input(ga, { type: 'insertText', data: ', edited', start: at2, end: at2 })) === null;
  await settle(2);
  checks.secondSegmentOnly = patchesOf('ga2').length === 1 && patchesOf('ga2')[0].body.text === 'Then the second one, edited.' &&
    patchesOf('ga2')[0].body.base_version_id === 'v-ga2-0' && patchesOf('ga1').length === 0 && patchesOf('ga3').length === 0;

  // 6. edit mode on the three-segment box: ranges drawn, the caret names its segment; real keys at the boundaries
  await app((a, x) => a.select(x.page, x.id), ga);
  await page.keyboard.press('Enter');
  await waitApp((a) => a.editing, undefined, 5000);
  const drawn = await page.evaluate(() => ({ ranges: document.querySelectorAll('#segrects .segr').length, bounds: document.querySelectorAll('#segrects .segb').length,
    segs: [...new Set([...document.querySelectorAll<HTMLElement>('#segrects .segr')].map((d) => d.dataset.seg))] }));
  summary.drawn = drawn;
  checks.rangesDrawn = drawn.ranges >= 3 && drawn.bounds === 2 && drawn.segs.join() === 'ga1,ga2,ga3';
  const gaNow = (await boxOf(T.ga1)).text;
  const start2 = gaNow.indexOf('Then');
  await page.evaluate((p: number) => { const ta = document.getElementById('ta') as HTMLTextAreaElement; ta.setSelectionRange(p, p); }, start2 + 2);
  await waitApp(() => document.getElementById('embed-current')?.dataset.seg === 'ga2', undefined, 5000);
  const cur = await page.evaluate(() => { const a = document.querySelector<HTMLAnchorElement>('#embed-current a.seg-link'); return a && { href: a.getAttribute('href'), target: a.target, label: a.textContent }; });
  summary.currentLink = cur;
  checks.caretNamesSegment = !!cur && cur.href === segHref('ga2') && cur.target === '_top' && cur.label === SEG_LABEL;
  const patchCount = host.patches.length;
  await page.evaluate((p: number) => { const ta = document.getElementById('ta') as HTMLTextAreaElement; ta.setSelectionRange(p, p); }, start2);
  await page.keyboard.press('Backspace');
  const backMsg = await stMsg();
  await page.evaluate((x: [number, number]) => { const ta = document.getElementById('ta') as HTMLTextAreaElement; ta.setSelectionRange(x[0], x[1]); }, [gaNow.indexOf('here'), start2 + 2]);
  await page.keyboard.press('Backspace');
  const selMsg = await stMsg();
  await page.evaluate((p: number) => { const ta = document.getElementById('ta') as HTMLTextAreaElement; ta.setSelectionRange(p, p); }, start2 + 2);
  await page.keyboard.press('Enter');
  const enterMsg = await stMsg();
  const gaAfter = await boxOf(T.ga1);
  summary.boundary = { backMsg, selMsg, enterMsg };
  checks.backspaceAtBoundaryRefused = /Backspace at the start of a segment/.test(backMsg);
  checks.crossBoundaryDeleteRefused = /crosses the boundary/.test(selMsg);
  checks.enterRefused = /Enter/.test(enterMsg) && /off/.test(enterMsg);
  checks.boundaryTextKept = gaAfter.text === gaNow && host.patches.length === patchCount;
  await page.keyboard.press('Escape');
  // the selection panel: the host's segment link per segment, opened in the top window
  const selLinks = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('#embed-selection a.seg-link')].map((a) => [a.dataset.seg, a.getAttribute('href'), a.target]));
  summary.selectionLinks = selLinks;
  checks.selectionLinks = selLinks.length === 3 && selLinks.every(([s, href, t]: (string | null | undefined)[]) => href === segHref(String(s)) && t === '_top');

  // 7. a locked middle segment refuses; its neighbours write
  const gb = await boxOf(T.gb1);
  const inB2 = gb.text.indexOf('Fifth') + 2, inB1 = gb.text.indexOf('Fourth') + 2;
  const refusedB2 = await input(gb, { type: 'insertText', data: 'X', start: inB2, end: inB2 });
  checks.lockedMiddleRefused = typeof refusedB2 === 'string' && /gb2/.test(refusedB2) && /locked/.test(refusedB2);
  checks.neighbourBefore = (await input(gb, { type: 'insertText', data: 'X', start: inB1, end: inB1 })) === null;
  const gb2 = await boxOf('FoXurth');
  const inB3 = gb2.text.indexOf('Sixth') + 5;
  checks.neighbourAfter = (await input(gb2, { type: 'insertText', data: ' too', start: inB3, end: inB3 })) === null;
  await settle(4);
  checks.neighboursWritten = patchesOf('gb1')[0]?.body.text === 'FoXurth sentence.' && patchesOf('gb3')[0]?.body.text === 'Sixth too sentence.' && patchesOf('gb2').length === 0;

  // 8. a confirmed paragraph refuses typing; split and merge of linked boxes are refused
  const g5 = await boxOf(T.g5);
  checks.confirmedRefused = (await app((a, x) => a.textEdit(x.page, x.id, ['Typed into a confirmed segment']), g5)) === false && /confirmed/.test(await stMsg());
  const boxesBefore = (await app(texts) as A[][])[0].length;
  await app((a, x) => a.select(x.page, x.id), g1);
  await page.click('#split');
  const splitMsg = await stMsg();
  await page.click(`.page[data-n="0"] .frame[data-id="${e1.untranslated[0].box}"]`, { modifiers: ['Shift'] });
  await page.click('#merge');
  const mergeMsg = await stMsg();
  summary.structure = { splitMsg, mergeMsg };
  checks.splitMergeRefused = /cannot be split/.test(splitMsg) && /cannot be merged/.test(mergeMsg) && (await app(texts) as A[][])[0].length === boxesBefore;

  // 9. changed elsewhere: a 409 with the current text reverts the paragraph and lists the conflict
  const s1 = segs.get('g1')!;
  s1.version++; s1.text = 'Changed in the grid';
  await app((a, x) => a.textEdit(x.page, x.id, ['Overview typed again']), g1);
  await settle(5);
  const c1 = await app((a) => a.embed);
  checks.conflictReverted = (await boxOf('Changed in the grid')).id === g1.id && c1.conflicts.some((c: A) => c.seg === 'g1' && c.mine === 'Overview typed again') &&
    patchesOf('g1').at(-1)?.status === 409 && (await page.$$('#embed-conflicts li')).length === 1;

  // 10. locked elsewhere: a 409 without a current text reverts, and the segment is read-only from then on
  segs.get('ga3')!.locked = true;
  const ga3 = await boxOf(T.ga1);
  const inA3 = ga3.text.indexOf('third') + 5;
  await input(ga3, { type: 'insertText', data: ' one', start: inA3, end: inA3 });
  await settle(6);
  const after3 = await boxOf(T.ga1);
  const again3 = await input(after3, { type: 'insertText', data: '!', start: inA3, end: inA3 });
  checks.lockedElsewhereReverted = patchesOf('ga3').at(-1)?.status === 409 && after3.text.endsWith(T.ga3) && typeof again3 === 'string' && /locked/.test(again3);

  // 11. an edit of the untranslated paragraph (not linked), a moved linked box, then Save: version 1 on head 0
  await app((a, x) => a.editor.setText(x.page, x.box, x.para, x.text), { ...e1.untranslated[0], text: TYPED });
  const movedFrame = await app((a, x) => { const b = a.doc.pages[x.page].boxes.find((y: A) => y.id === x.id); const f = { x0: b.frame.x0 + 20, x1: b.frame.x1 + 20, y0: b.frame.y0, y1: b.frame.y1 }; a.editor.setFrame(x.page, x.id, f); return f; }, g1);
  await waitApp((a) => a.embed.dirty, undefined, 5000);
  await page.click('#save');
  await waitApp((a) => !a.embed.busy && !a.embed.dirty && a.embed.head === 1, undefined, 15000);
  const v1 = host.versions[0];
  const savedBoxes = v1?.state.pages.flatMap((p: A) => p.boxes) ?? [];
  const editedNow = await app((a) => a.doc.pages.reduce((k: number, p: A) => k + p.boxes.filter((b: A) => b.edited).length, 0));
  summary.save = { base_n: v1?.base_n, summary: v1?.summary, pages: v1?.state.pages.map((p: A) => p.n), boxes: savedBoxes.length, editedNow, shortened: v1?.state.pages.map((p: A) => p.shortened) };
  checks.saved = !!v1 && v1.base_n === 0 && v1.state.format === 'pdfedit-state@1' && savedBoxes.length === editedNow && savedBoxes.every((b: A) => b.edited) &&
    savedBoxes.some((b: A) => b.paragraphs.some((p: A) => p.runs.map((r: A) => r.text).join('') === TYPED));
  checks.savedShortened = v1?.state.pages.some((p: A) => p.n === 1 && p.shortened?.some((s: A) => s.seg_id === 'g6' && s.after === SHORT && s.before === LONG));
  checks.statusSaved = /Version 1 · saved/.test(await page.textContent('#embed-status'));

  // 12. a head that moved elsewhere: 409 head_moved and the message; then a save on the real head
  await app((a, x) => a.editor.setText(x.page, x.box, x.para, `${x.text}!`), { ...e1.untranslated[0], text: TYPED });
  host.head = 5;
  await page.click('#save');
  await waitApp((a) => !a.embed.busy && a.embed.note?.kind === 'bad', undefined, 15000);
  const moved = await app((a) => a.embed.note.text);
  summary.headMoved = moved;
  checks.headMoved = /saved elsewhere/.test(moved) && /version 5/.test(moved) && host.versions.length === 1;
  host.head = 1;
  await app((a, x) => a.editor.setText(x.page, x.box, x.para, x.text), { ...e1.untranslated[0], text: TYPED });
  // the host's segment changes again: on the next load its text wins over the saved box
  s1.version++; s1.text = 'Segment text wins.';

  // 13. Export: the unsaved edit is saved first (version 2), then the verified PDF goes to the host with its report
  const before = await app((a) => a.embed.note?.text ?? '');
  await page.click('#export');
  await waitApp((a, prev) => a.embed.uploads.length > 0 || (['bad', 'warn'].includes(a.embed.note?.kind) && a.embed.note.text !== prev), before, 120000);
  const x1 = host.exports[0];
  summary.export = x1 && { n: x1.n, type: x1.type, bytes: x1.bytes.length, report: x1.report, versions: host.versions.map((v) => v.base_n), note: (await app((a) => a.embed.note)) };
  checks.savedBeforeExport = host.versions.length === 2 && host.versions[1].base_n === 1;
  checks.exported = !!x1 && x1.n === 2 && x1.type === 'application/pdf' && x1.bytes.subarray(0, 5).toString('latin1') === '%PDF-';
  checks.reportHeader = !!x1?.report && x1.report.ok === true && x1.report.verified === true && x1.report.written >= 4 && Array.isArray(x1.report.fonts) &&
    Array.isArray(x1.report.skipped) && Array.isArray(x1.report.substitutions) && typeof x1.report.engine === 'string';
  checks.reportShortened = !!x1?.report && x1.report.shortened.length === 1 && x1.report.shortened[0].seg_id === 'g6' && x1.report.shortened[0].page === 1 &&
    x1.report.shortened[0].chars_before === LONG.length && x1.report.shortened[0].chars_after === SHORT.length;
  if (x1) {
    await writeFile(join(OUT, 'exported.pdf'), x1.bytes);
    const P = await openPdfium();
    const d = P.open(new Uint8Array(x1.bytes));
    const pageText: string[] = [];
    try { for (let i = 0; i < d.pageCount; i++) { const pg = d.page(i); pageText.push(pg.chars().map((c) => c.unicode).join('')); pg.close(); } } finally { d.close(); }
    checks.pdfHasEdits = strip(pageText[0] ?? '').includes(strip(TYPED)) && strip(pageText[0] ?? '').includes(strip('Changed in the grid')) &&
      strip(pageText[0] ?? '').includes(strip('Then the second one, edited.')) && strip(pageText[1] ?? '').includes(strip(T.g5)) && strip(pageText[1] ?? '').includes(strip(SHORT));
  } else checks.pdfHasEdits = false;

  // 14. reload: links verified (not posted again), the version back, segment text over the saved box, shortened kept
  const writesBefore = host.patches.length;
  await page.reload();
  await waitApp((a) => a.embed?.ready);
  const t2 = (await app(texts) as A[]).flat();
  const e2 = await app((a) => a.embed);
  const g1Again = t2.find((b: A) => b.id === g1.id);
  summary.reload = { head: e2.head, restoredPages: e2.restoredPages, untranslated: e2.untranslated.length, dirty: e2.dirty, g1: g1Again, linksPosts: e2.linksPosts, shortened: e2.shortened };
  checks.reloaded = e2.head === 2 && t2.some((b: A) => b.text === TYPED) && e2.untranslated.length === 0 && !e2.dirty;
  checks.linksNotPostedAgain = host.linkPosts.length === 1 && e2.linksPosts === 0 && e2.linksStored === 'stored' && e2.links.every((l: A) => l.ok);
  checks.segmentTextWins = g1Again?.text === 'Segment text wins.' && JSON.stringify(g1Again.frame) === JSON.stringify(movedFrame);
  checks.shortenedKept = t2.some((b: A) => b.text === SHORT) && e2.shortenCalls === 0 && e2.shortened.some((s: A) => s.seg_id === 'g6' && s.active);

  // 15. "Use faithful": the faithful text back, and nothing written
  await page.click('#embed-shortened button[data-faithful]');
  await page.waitForTimeout(1500);
  const t3 = (await app(texts) as A[]).flat();
  checks.useFaithful = t3.some((b: A) => b.text === LONG) && !t3.some((b: A) => b.text === SHORT) && host.patches.length === writesBefore &&
    (await app((a) => a.embed.pendingWrites.length)) === 0;

  // 16. a frame without ?segments= (and without ?seglink=): links load, linked text is read-only, nothing is written
  const ro = await ctx.newPage();
  ro.on('pageerror', (e: Error) => errors.push(e.message));
  const roApp = <T>(fn: (a: A, arg: any) => T, arg?: unknown): Promise<T> =>
    ro.evaluate(([src, x]: [string, unknown]) => (0, eval)(src)((window as any).__app, x), [`(${fn.toString()})`, arg]);
  const patchesBeforeRo = host.patches.length;
  await ro.goto(FRAME_NO_SEGMENTS);
  await ro.waitForFunction(() => (window as any).__app?.embed?.ready, undefined, { timeout: 90000 });
  const e3 = await roApp((a) => a.embed);
  const roLinks = e3.links.filter((l: A) => l.ok);
  const g1Ro = roLinks.find((l: A) => l.seg_ids.join() === 'g1');
  const roRefusal = g1Ro ? await roApp((a, x) => a.input(x.page, x.box, { type: 'insertText', data: 'X', start: 0, end: 0 }), g1Ro) : null;
  if (g1Ro) await roApp((a, x) => a.select(x.page, x.box), g1Ro);
  await ro.waitForFunction(() => /segment g1/.test(document.getElementById('embed-selection')?.textContent ?? ''), undefined, { timeout: 5000 });
  const roPanel = await ro.evaluate(() => ({ text: document.getElementById('embed-selection')?.textContent ?? '', links: document.querySelectorAll('a.seg-link').length,
    summary: document.getElementById('embed')?.textContent ?? '' }));
  summary.noSegments = { refusal: roRefusal, panel: roPanel.text, links: roPanel.links, whys: roLinks.map((l: A) => l.info?.why_not) };
  checks.noSegmentsLinksLoad = e3.linksStored === 'stored' && roLinks.length > 0 && e3.linksPosts === 0;
  checks.noSegmentsReadOnly = roLinks.every((l: A) => ['no_segments_api', 'shortened'].includes(l.info?.why_not)) && roLinks.some((l: A) => l.info?.why_not === 'no_segments_api') &&
    typeof roRefusal === 'string' && /the host gave no segments API/.test(roRefusal);
  checks.noSegmentsReasonShown = /the host gave no segments API/.test(roPanel.text) && /linked text is read-only: the host gave no segments API/.test(roPanel.summary);
  checks.noSegLinkNoLinks = roPanel.links === 0;
  checks.noSegmentsNothingWritten = host.patches.length === patchesBeforeRo && e3.pendingWrites.length === 0;
  await ro.close();

  checks.noErrors = errors.length === 0;
  checks.noOutsideRequests = blocked.size === 0;
} catch (e) {
  errors.push(`smoke: ${(e as Error).message.split('\n')[0]}`);
  if (pageRef) {
    summary.failure = await pageRef.evaluate(() => { const a = (window as any).__app; return a && { embed: a.embed, msg: document.getElementById('st-msg')?.textContent }; }).catch(() => null);
    await pageRef.screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
  }
} finally {
  await browser.close();
  server.close();
}
summary.patches = host.patches.map((p) => ({ seg: p.seg, status: p.status, text: p.body.text, base: p.body.base_version_id }));
const ok = Object.values(checks).length > 0 && Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify({ ok, failed: Object.entries(checks).filter(([, v]) => !v).map(([k]) => k), checks, ...summary, errors, blocked: [...blocked] }, null, 1));
if (!ok) process.exitCode = 1;
