// Embed mode: a host page frames the editor and serves one document through an HTTP API (docs/EMBED.md). The page
// URL carries ?doc=<id>&api=<base>, and optionally &fonts=<base> for the substitution catalogue, &segments=<base> for
// the segment write route (without it linked text is read-only), &seglink=<template> for a link to a segment in the
// host (`{seg}` is replaced by the segment id) and &seglabel=<text> for that link's label. The editor then:
//   - loads <api> (the doc and its head version), <api>/source (the PDF) and every page of <api>/pairs; when the doc
//     has links (doc.links present), also <api>/links (when stored) and every page of <api>/state (the segments);
//   - detects every page, links and translates its paragraphs (src/embed/match.ts, links.ts) through the Editor, puts
//     the head version's saved boxes back (src/embed/state.ts), lets linked paragraphs show their segment's current
//     text, fits (src/embed/page.ts) and, when the doc's settings ask for it, shortens what did not fit
//     (src/embed/shorten.ts, POST <api>/shorten);
//   - stores the links once when the host has none (POST <api>/links);
//   - writes typed text to the segment it was typed in (PATCH <segments>/<seg>): a linked paragraph is one range per
//     segment (src/embed/ranges.ts; a paragraph that is a run of segments has several), and an edit must stay inside
//     one range. Edits that would break the links are refused: paragraph-count changes, Enter, split and merge on
//     linked boxes, edits across a segment boundary, typing in a read-only segment;
//   - saves the edited boxes as a new version (POST <api>/versions), and exports: the worker's export, then
//     POST <api>/exports?n=<version> with the PDF and an X-Pdfedit-Report header (src/embed/report.ts).
// In edit mode app/main.ts tints each segment's range and marks the boundaries (rangesOf); the caret or the pointer
// in a range names its segment (pointAt). The side panel shows the selected box's paragraphs with their segments
// (with the host's segment link, per segment), the segment under the caret or the pointer, the ranges that are read-only
// and the links that did not hold, the shortened ones ("Use faithful") and the untranslated ones; a click selects the
// box. Without ?doc and ?api the editor is the standalone one (app/main.ts makes no Embed).
import { createMatcher, type Matcher, type Pair } from '../src/embed/match.ts';
import { parseState, serialiseState, type PageState } from '../src/embed/state.ts';
import { preparePage, withoutBullet, type PagePrep, type Untranslated } from '../src/embed/page.ts';
import { linkKey, parseLinks, verifyLinks, type Link, type ParaLink } from '../src/embed/links.ts';
import { applyChange, checkInput, confinedRange, locateRanges, segmentTextFor, wholeRange, type SegRange } from '../src/embed/ranges.ts';
import { applyShortened, shortenedActive, shortenItems, type Shortened, type ShortenItem } from '../src/embed/shorten.ts';
import { encodeReportHeader, hostReport, substitutionsOf } from '../src/embed/report.ts';
import { segLinkFor, segLinkTemplate } from '../src/embed/seglink.ts';
import { prepareSubstitutes } from '../src/fonts/apply.ts';
import { Editor, type Change } from '../src/model/edit.ts';
import { parseCatalogFaceId, type FontRegistry } from '../src/model/fonts.ts';
import type { Box, Doc, Page } from '../src/model/types.ts';
import type { FitReport } from '../src/fit/fit.ts';
import type { ExportReport } from '../src/export/export.ts';
import { h } from './reports.ts';

/** The pdfedit build (scripts/build-embed.mjs sets it from git), written into states, links and export reports. */
const ENGINE: string | undefined = import.meta.env.VITE_PDFEDIT_COMMIT || undefined;
const PAGE_SIZE = 500;
const MAX_LISTED = 300;
const SHORTEN_BATCH = 30;        // items per POST <api>/shorten (the host shortens them within the request)
/** The engine name the links are stored with: the build's commit, else 'dev' (1-80 of [A-Za-z0-9._:+-]). */
const LINKS_ENGINE = (ENGINE ?? 'dev').replace(/[^A-Za-z0-9._:+-]/g, '-').slice(0, 80) || 'dev';
const DEFAULT_SEGLABEL = 'Open segment';

export type EmbedParams = {
  doc: string; api: string; fonts: string | null;
  /** The segment write route's base (PATCH <segments>/<seg>), or null: linked text is read-only. */
  segments: string | null;
  /** The host's link to a segment, a template with `{seg}` (replaced by the URL-encoded segment id), or null. */
  seglink: string | null;
  /** The label of that link. */
  seglabel: string;
};

/** An absolute URL on the page's own origin, without a trailing slash, or null. */
function sameOrigin(value: string | null, href: string): string | null {
  if (!value) return null;
  try {
    const u = new URL(value, href);
    if (u.origin !== new URL(href).origin) return null;
    return u.href.replace(/\/+$/, '');
  } catch { return null; }
}

/** The host's font base (?fonts=), on the page's origin, or null. */
export function hostFonts(href: string): string | null {
  return sameOrigin(new URL(href).searchParams.get('fonts'), href);
}

/** The embed parameters of the page URL, or null (the standalone editor). The APIs must be on the page's origin. */
export function embedParams(href: string): EmbedParams | { error: string } | null {
  const q = new URL(href).searchParams;
  const doc = q.get('doc'), api = q.get('api');
  if (!doc && !api) return null;
  if (!doc || !api) return { error: 'the page needs both ?doc= and ?api=' };
  const base = sameOrigin(api, href);
  if (!base) return { error: 'the API must be on this page\'s own origin' };
  const segParam = q.get('segments');
  const segments = segParam ? sameOrigin(segParam, href) : null;
  if (segParam && !segments) return { error: 'the segment route must be on this page\'s own origin' };
  const link = segLinkTemplate(q.get('seglink'), href);
  if ('error' in link) return link;
  const seglabel = (q.get('seglabel') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60) || DEFAULT_SEGLABEL;
  return { doc, api: base, fonts: hostFonts(href), segments, seglink: link.template, seglabel };
}

export class HostError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly data: Record<string, unknown>;
  constructor(status: number, code: string | null, message: string, data: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export type HostDoc = {
  id?: string; head?: number | null; title?: string | null;
  /** Present (null or a record) when the host keeps links; absent: no links, no write-through. */
  links?: unknown;
  settings?: { shorten?: boolean } | null;
};
type HostPair = { seg_id: string | number; source?: string | null; target?: string | null; confirmed?: boolean };
type Mark = { start: number; end: number; type: string; href?: string | null };
type HostSegment = {
  seg_id: string | number; version_id?: string | null; text?: string | null; marks?: Mark[] | null;
  locked?: boolean; confirmed?: boolean; stale?: boolean; editable?: boolean; why_not?: string | null;
};
/** A segment as the editor knows it: its current target version and text, and whether it takes typing. */
type Seg = {
  id: string; version: string | null; text: string; marks: Mark[];
  locked: boolean; confirmed: boolean; editable: boolean; why_not: string | null;
  /** The host refused a write (409 without a current text): the reason; the segment is read-only from then on. */
  refused: string | null;
};

/** The host API (docs/EMBED.md), with the page's own credentials. */
export class HostApi {
  readonly base: string;
  readonly segmentsBase: string | null;
  constructor(base: string, segmentsBase: string | null = null) { this.base = base; this.segmentsBase = segmentsBase; }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
    if (!res.ok) {
      let body: Record<string, unknown> = {};
      try { body = await res.json(); } catch { /* not JSON */ }
      const message = typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`.trim();
      throw new HostError(res.status, typeof body.code === 'string' ? body.code : null, message, body);
    }
    return res;
  }
  private call(path: string, init: RequestInit = {}): Promise<Response> { return this.request(this.base + path, init); }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await (await this.call(path, init)).json()) as T;
  }
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.json<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  /** Every page of a paged list (`?limit=&cursor=`, answered `{ <key>: [...], next }`), in order. */
  private async paged<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (;;) {
      const q: URLSearchParams = new URLSearchParams({ limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
      const page: Record<string, unknown> & { next?: string | number | null } = await this.json(`${path}?${q}`);
      const list = page[key];
      if (!Array.isArray(list)) throw new HostError(200, 'bad_response', `the ${path.slice(1)} response has no ${key} list`);
      out.push(...(list as T[]));
      const next: string | null = page.next === null || page.next === undefined || page.next === '' ? null : String(page.next);
      if (next === null || seen.has(next)) return out;
      seen.add(next);
      cursor = next;
    }
  }

  doc() { return this.json<{ doc: HostDoc; versions?: unknown[]; exports?: unknown[] }>(''); }
  async source(): Promise<ArrayBuffer> { return (await this.call('/source')).arrayBuffer(); }
  /** Every page of the pairs, in order. */
  pairs(): Promise<HostPair[]> { return this.paged<HostPair>('/pairs', 'pairs'); }
  /** Every page of the segments' state, in order. */
  segments(): Promise<HostSegment[]> { return this.paged<HostSegment>('/state', 'segments'); }
  links() { return this.json<unknown>('/links'); }
  postLinks(engine: string, links: Link[]) { return this.post<{ doc?: HostDoc }>('/links', { engine, links }); }
  shorten(items: { seg_id: string | null; source: string; english: string; max_chars: number }[]) {
    return this.post<{ items?: unknown[] }>('/shorten', { items });
  }
  version(n: number) { return this.json<{ version?: unknown; state: unknown }>(`/versions/${n}`); }
  saveVersion(base_n: number, state: unknown, summary: string) {
    return this.post<{ doc?: HostDoc; version?: { n?: number } }>('/versions', { base_n, state, summary });
  }
  exportPdf(n: number, bytes: ArrayBuffer, report: string) {
    return this.json<{ export?: unknown }>(`/exports?n=${n}`, {
      method: 'POST', headers: { 'content-type': 'application/pdf', 'x-pdfedit-report': report }, body: bytes,
    });
  }
  /** A segment's new target text (the host's segment route). */
  async writeSegment(seg: string, body: { text: string; marks: Mark[]; base_version_id: string | null }) {
    if (!this.segmentsBase) throw new HostError(0, 'no_segments_api', 'the host gave no segments API');
    const res = await this.request(`${this.segmentsBase}/${encodeURIComponent(seg)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return (await res.json()) as { version?: { id?: string; text?: string; marks?: Mark[] }; unchanged?: boolean };
  }
}

/** What the embed needs from the editor (app/main.ts). */
export type EmbedHooks = {
  open(bytes: ArrayBuffer, name: string): void;
  fonts(): FontRegistry | null;
  doc(): Doc | null;
  /** The editor over the open document (write-through reverts and "Use faithful" go through it). */
  editor(): Editor | null;
  /** The editor's change counter (every edit, undo and redo moves it). */
  version(): number;
  reveal(page: number, box: string): void;
  msg(text: string): void;
  /** The toolbar's enabled states changed. */
  refresh(): void;
};

type Note = { kind: 'ok' | 'warn' | 'bad' | 'info'; text: string; action?: { label: string; run: () => void } };
type Conflict = { key: string; page: number; box: string; para: number; seg: string; mine: string; current: string };
/** A linked paragraph as write-through follows it: its text as last seen and its segments' ranges (null: the ranges
 *  are not known, a shortened text or segment texts not found; the paragraph is then read-only). */
type ParaState = { link: ParaLink; text: string; ranges: SegRange[] | null };
/** One segment's range in a paragraph, and whether it takes typing. */
export type RangeInfo = { seg: string; start: number; end: number; typable: boolean; why_not: string | null };
/** A paragraph as the panel and the gates see it. */
export type ParaInfo = {
  page: number; box: string; para: number; seg_ids: string[];
  /** The link holds on this load. */
  linked: boolean;
  /** Typing in some part of it is allowed (unlinked paragraphs: always; their text is the version's only). */
  typable: boolean;
  /** Why the whole paragraph is read-only or not linked (null: see the ranges). */
  why_not: string | null;
  ranges: RangeInfo[];
};
/** An input as the text box is about to apply it: the type, the inserted text and the selection, as offsets in the
 *  box's text (paragraphs joined by one separator). */
export type BoxInput = { type: string; data: string | null; start: number; end: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isPdf = (b: ArrayBuffer) => new TextDecoder('latin1').decode(new Uint8Array(b, 0, Math.min(1024, b.byteLength))).includes('%PDF-');
const paraText = (b: Box, i: number) => b.paragraphs[i].runs.map((r) => r.text).join('');
const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const canType = (s: Seg) => s.editable && !s.locked && !s.confirmed && !s.refused;

/** Why a paragraph is read-only or not linked, as the panel and the refusals say it. */
const WHY: Record<string, string> = {
  ranges_lost: 'its segments\' texts are not found in it; edit the segments in the host',
  crosses_boundary: 'the edit crosses the boundary between two segments',
  boundary_backspace: 'Backspace at the start of a segment would join it to the one before',
  boundary_delete: 'Delete at the end of a segment would join it to the one after',
  between_segments: 'the caret is between two segments',
  locked: 'its segment is locked',
  confirmed: 'its segment is confirmed; reopen it in the host to edit it',
  not_translatable: 'its segment is not for translation',
  not_editable: 'its segment cannot be edited',
  unknown_segment: 'its segment is no longer in the file (split, merged or retired in the host)',
  no_segments_api: 'the host gave no segments API',
  file_not_open: 'the file is no longer open for editing',
  shortened: 'it holds a shortened text; use the faithful text to edit it',
  source_changed: 'not linked: the source text is not the one the link was made on',
  box_missing: 'not linked: the linked box or paragraph is not on the page',
};
const whyText = (why: string) => WHY[why] ?? why;

/** A segment's marks kept for a new text: cut to the text's length (marks are the segment's own; the editor does
 *  not write formatting). */
function marksFor(marks: Mark[], length: number): Mark[] {
  return marks.map((m) => ({ ...m, end: Math.min(m.end, length) })).filter((m) => m.start < m.end);
}

export class Embed {
  readonly params: EmbedParams;
  readonly api: HostApi;
  private hooks: EmbedHooks;
  ready = false;
  busy = false;
  private head = 0;
  private savedAt = 0;
  /** Boxes the matcher translated on load (not put back from a saved version): unsaved until a first save. */
  private autoTranslated = 0;
  private matcher: Matcher | null = null;
  private pairCount = 0;
  private unconfirmed = new Set<string>();
  private state = new Map<number, PageState>();
  private pageCount = -1;
  private prepared = new Map<number, PagePrep | null>();
  private prepQueue: Promise<unknown> = Promise.resolve();
  private untranslated: Untranslated[] = [];
  private exportN: number | null = null;
  private note: Note | null = null;
  private uploads: { n: number; ok: boolean; at: number }[] = [];
  // links and segments
  private info: HostDoc = {};
  private linksOn = false;
  private stored: Link[] | null = null;
  private linksPosts = 0;
  private linksStored: 'stored' | 'posted' | 'raced' | 'failed' | null = null;
  private segs = new Map<string, Seg>();
  private links = new Map<string, ParaLink>();
  private linkedBoxes = new Set<string>();
  /** Per linked paragraph (linkKey): its text and its segments' ranges. */
  private paras = new Map<string, ParaState>();
  /** The range the input being applied goes to (the boundary rule), for the ranges' update after it. */
  private hint: { key: string; range: number } | null = null;
  private unsaved = new Set<string>();
  private conflicts: Conflict[] = [];
  private writes: { seg: string; ok: boolean; status: number | null }[] = [];
  private writing = false;
  private writeChain: Promise<boolean> = Promise.resolve(true);
  // shortening
  private shortenOn = false;
  private shortened: Shortened[] = [];
  private shortenCalls = 0;
  private shortenFailures: string[] = [];
  private selKey = '';
  private at: { page: number; box: string; para: number; off: number; from: 'caret' | 'hover' } | null = null;
  private el!: {
    save: HTMLButtonElement; status: HTMLElement; note: HTMLElement; summary: HTMLElement; selection: HTMLElement; current: HTMLElement;
    conflicts: HTMLElement; shortHead: HTMLElement; short: HTMLElement; attnHead: HTMLElement; attn: HTMLElement;
    listHead: HTMLElement; list: HTMLElement;
  };

  constructor(params: EmbedParams, hooks: EmbedHooks) {
    this.params = params;
    this.api = new HostApi(params.api, params.segments);
    this.hooks = hooks;
  }

  // a document with translations set on load and no saved version yet is unsaved too: its first save is version 1
  get dirty(): boolean { return this.ready && (this.hooks.version() !== this.savedAt || (this.head === 0 && this.autoTranslated > 0)); }
  get canExport(): boolean { return this.ready && !this.busy; }

  /** The toolbar's Save button and the panel's Document card; the open controls go (the host gives the file). */
  mount(): void {
    const $ = (id: string) => document.getElementById(id);
    $('open')!.hidden = true;
    const drop = document.querySelector('#empty .drop');
    if (drop) drop.replaceChildren(h('div', { class: 'drop-title' }, 'Loading the document…'));
    const exp = $('export') as HTMLButtonElement;
    exp.title = 'Save, write the edits into the PDF, verify it and send it to the host';
    const save = h('button', { id: 'save', title: 'Save the edits as a new version (Ctrl+S)', disabled: '' }, 'Save') as HTMLButtonElement;
    exp.parentElement!.insertBefore(save, exp.parentElement!.firstChild);
    save.addEventListener('click', () => { if (this.dirty) void this.save(); else void this.writeSegments(); });
    const status = h('p', { class: 'muted', id: 'embed-status' }, 'Loading…');
    const note = h('div', { id: 'embed-note' });
    const summary = h('div', { id: 'embed-summary' });
    const selection = h('div', { id: 'embed-selection' });
    const current = h('p', { id: 'embed-current', class: 'muted small', hidden: '' });
    const conflicts = h('div', { id: 'embed-conflicts' });
    const shortHead = h('h3', { hidden: '' }, 'Shortened');
    const short = h('ul', { class: 'untranslated', id: 'embed-shortened' });
    const attnHead = h('h3', { hidden: '' }, 'Read-only or not linked');
    const attn = h('ul', { class: 'untranslated', id: 'embed-links' });
    const listHead = h('h3', { hidden: '' }, 'Untranslated');
    const list = h('ul', { class: 'untranslated', id: 'embed-list' });
    const card = h('section', { id: 'embed', class: 'card' }, h('h2', {}, 'Document'), status, note, summary, selection, current, conflicts,
      shortHead, short, attnHead, attn, listHead, list);
    $('panel')!.prepend(card);
    card.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const faithful = t.closest<HTMLButtonElement>('button[data-faithful]');
      if (faithful) { this.useFaithful(Number(faithful.dataset.faithful)); return; }
      const b = t.closest<HTMLButtonElement>('button[data-box]');
      if (b) this.hooks.reveal(Number(b.dataset.page), b.dataset.box!);
    });
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save(); }
    });
    // The frame losing focus (the person clicked the host page) also ends an edit for write-through.
    window.addEventListener('blur', () => this.editingEnded());
    window.addEventListener('beforeunload', (e) => { if (this.dirty || this.pendingWrites().length) { e.preventDefault(); e.returnValue = ''; } });
    this.el = { save, status, note, summary, selection, current, conflicts, shortHead, short, attnHead, attn, listHead, list };
  }

  /** Loads the doc, the PDF, the pairs, the head version's state and, with links, the links and the segments; then
   *  opens the PDF in the editor. */
  async load(): Promise<void> {
    try {
      const info = await this.api.doc();
      this.info = info.doc ?? {};
      const head = Number(this.info.head ?? 0);
      this.head = Number.isInteger(head) && head > 0 ? head : 0;
      this.linksOn = Object.hasOwn(this.info, 'links');
      this.shortenOn = this.info.settings?.shorten === true;
      const hasStored = this.linksOn && this.info.links !== null && this.info.links !== undefined;
      const [bytes, pairs, version, links, segments] = await Promise.all([
        this.api.source(), this.api.pairs(), this.head > 0 ? this.api.version(this.head) : Promise.resolve(null),
        hasStored ? this.api.links().then(parseLinks).catch((e: Error) => e) : Promise.resolve(null),
        this.linksOn ? this.api.segments().catch((e: Error) => e) : Promise.resolve(null),
      ]);
      if (!isPdf(bytes)) throw new Error('the source is not a PDF');
      if (version) for (const p of parseState(version.state).pages) this.state.set(p.n, p);
      if (links instanceof Error) {
        // links that cannot be read are not made again (the host would refuse them): nothing is linked this time
        this.linksOn = false;
        this.show({ kind: 'warn', text: `The paragraph links could not be read (${links.message}): edits stay in this editor's versions and are not written to segments.` });
      } else if (links) {
        this.stored = links.links;
        this.linksStored = 'stored';
        if (ENGINE && links.engine && links.engine !== ENGINE) this.show({ kind: 'info', text: 'The links were made by another editor build; each one is checked against its source text.' });
      }
      if (segments instanceof Error) {
        this.show({ kind: 'warn', text: `The segments could not be read (${segments.message}): linked paragraphs are read-only.` });
      } else if (segments) {
        for (const s of segments) {
          const id = String(s.seg_id);
          this.segs.set(id, {
            id, version: s.version_id ?? null, text: String(s.text ?? ''), marks: Array.isArray(s.marks) ? s.marks : [],
            locked: !!s.locked, confirmed: !!s.confirmed, editable: s.editable !== false, why_not: s.why_not ?? null, refused: null,
          });
        }
      }
      const list: Pair[] = pairs.map((p) => ({ id: String(p.seg_id), source: String(p.source ?? ''), target: String(p.target ?? '') }));
      for (const p of pairs) if (p.confirmed === false) this.unconfirmed.add(String(p.seg_id));
      this.matcher = createMatcher(list);
      this.pairCount = list.length;
      this.status();
      this.hooks.open(bytes, String(this.info.title || this.params.doc));
    } catch (e) {
      const text = `The document could not be loaded: ${(e as Error).message}`;
      this.show({ kind: 'bad', text });
      this.el.status.textContent = 'Not loaded.';
      const drop = document.querySelector('#empty .drop');
      if (drop) drop.replaceChildren(h('div', { class: 'drop-title' }, 'The document could not be loaded'), h('p', { class: 'muted' }, (e as Error).message));
      this.hooks.msg(text);
    }
  }

  /** The PDF is open with this many pages (the editor then sends every page here, in order). */
  opened(pages: number): void {
    this.pageCount = pages;
    const missing = [...this.state.keys()].filter((n) => n >= pages);
    if (missing.length) this.show({ kind: 'warn', text: `The saved version has edits on ${plural(missing.length, 'page')} this file does not have; they are left out.` });
    if (pages === 0) this.finish();
  }

  /** Translates a freshly detected page, puts the saved boxes back, fits and (when on) shortens it. The page is
   *  changed in place. Pages are made ready one after the other, in the order they come (links follow reading order). */
  preparePage(page: Page): Promise<FitReport | null> {
    const run = this.prepQueue.then(() => this.prepareOne(page));
    this.prepQueue = run.catch(() => null);
    return run;
  }

  private async prepareOne(page: Page): Promise<FitReport | null> {
    const fonts = this.hooks.fonts();
    if (!fonts || !this.matcher) return null;
    const n = page.n;
    const one: Doc = { pages: [] };
    one.pages[n] = page;
    const st = this.state.get(n) ?? null;
    await prepareSubstitutes(one, fonts, { pages: [n], all: true }).catch(() => []);
    if (st) {
      // faces picked from the catalogue in the saved boxes: loaded before they are laid out
      const files = st.boxes.flatMap((b) => b.paragraphs.flatMap((p) => p.runs.map((r) => (r.font.source === 'shipped' ? parseCatalogFaceId(r.font.name)?.file : undefined))));
      const want = [...new Set(files.filter((f): f is string => !!f))];
      if (want.length) await fonts.ensure(want);
    }
    const editor = new Editor(one, fonts);
    const prep = preparePage(editor, n, this.matcher, st, {
      links: this.linksOn ? { stored: this.stored ? this.stored.filter((l) => l.page === n) : null, text: (id) => this.segs.get(id)?.text ?? null } : undefined,
      keepBeforeFit: this.shortenOn,
    });
    const shortened = [...prep.shortened];
    if (this.shortenOn && prep.fit && prep.beforeFit) {
      const single = new Map(prep.links.filter((l) => l.ok && l.seg_ids.length === 1).map((l) => [`${l.box}#${l.para}`, l.seg_ids[0]]));
      const sources = new Map(prep.slots.map((s) => [`${s.box}#${s.para}`, s.text]));
      const items = shortenItems(n, prep.beforeFit, prep.fit, {
        translated: new Set(prep.translatedParas), source: (b, k) => sources.get(`${b}#${k}`) ?? '', segment: (b, k) => single.get(`${b}#${k}`) ?? null,
      });
      if (items.length) {
        try {
          const answers = await this.shortenAll(items);
          const done = applyShortened(editor, n, prep.beforeFit, items, answers);
          if (done.length) { prep.fit = editor.fitPage(n); shortened.push(...done); }
        } catch (e) {
          this.shortenFailures.push(`page ${n + 1}: ${(e as Error).message}`);
          this.show({ kind: 'warn', text: `Shortening failed on page ${n + 1}: ${(e as Error).message}. The page keeps the faithful text.` });
        }
      }
    }
    this.shortened.push(...shortened);
    this.register(page, prep.links);
    this.prepared.set(n, prep);
    return prep.fit;
  }

  /** The host's shortened texts for the items, in their order (batches of SHORTEN_BATCH). */
  private async shortenAll(items: ShortenItem[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let i = 0; i < items.length; i += SHORTEN_BATCH) {
      const part = items.slice(i, i + SHORTEN_BATCH);
      this.shortenCalls++;
      const r = await this.api.shorten(part.map(({ seg_id, source, english, max_chars }) => ({ seg_id, source, english, max_chars })));
      if (!Array.isArray(r.items) || r.items.length !== part.length) throw new Error(`the host answered ${Array.isArray(r.items) ? r.items.length : 'no'} items for ${part.length}`);
      out.push(...r.items);
    }
    return out;
  }

  /** A prepared page's links: the gates, the panel and write-through use them from now on. Each linked paragraph
   *  gets its segments' ranges, each with the text it shows of its segment (a shortened paragraph: the faithful text). */
  private register(page: Page, links: ParaLink[]): void {
    const n = page.n;
    for (const l of links) {
      const key = linkKey(n, l.box, l.para);
      this.links.set(key, l);
      if (!l.ok) continue;
      this.linkedBoxes.add(`${n}/${l.box}`);
      const b = page.boxes.find((x) => x.id === l.box);
      if (!b || !b.paragraphs[l.para]) continue;
      const text = paraText(b, l.para);
      const sh = this.shortened.find((s) => s.page === n && s.box === l.box && s.para === l.para && shortenedActive(s, page));
      this.paras.set(key, { link: l, text, ranges: this.rangesFor(l, text, sh ?? null) });
    }
  }

  /** A linked paragraph's ranges for its text: one over the whole text for one segment; for several, each segment's
   *  text found in it (null when one is not, when a segment is unknown, or while it holds a shortened text). */
  private rangesFor(l: ParaLink, text: string, shortened: Shortened | null): SegRange[] | null {
    if (l.seg_ids.length === 1) return wholeRange(l.seg_ids[0], text, shortened ? shortened.before : text);
    if (shortened) return null;
    // a segment the host no longer has (retired) is the text between its neighbours, read-only
    const parts = l.seg_ids.map((id) => ({ seg: id, text: this.segs.get(id)?.text ?? null }));
    if (parts.every((p) => p.text === null)) return null;
    return locateRanges(text, parts);
  }

  /** Page `n` is in the editor (or could not be read: prep null). */
  pageDone(n: number, failed = false): void {
    if (failed) { this.prepared.set(n, null); this.show({ kind: 'warn', text: `Page ${n + 1} could not be read; it is left as it is.` }); }
    if (!this.prepared.has(n)) this.prepared.set(n, null);
    if (!this.ready && this.pageCount >= 0 && this.prepared.size >= this.pageCount) this.finish();
    else this.el.status.textContent = `Reading pages: ${this.prepared.size} of ${this.pageCount}…`;
  }

  private finish(): void {
    this.ready = true;
    this.savedAt = this.hooks.version();
    const preps = [...this.prepared.values()].filter((p): p is PagePrep => !!p).sort((a, b) => a.page - b.page);
    this.untranslated = preps.flatMap((p) => p.untranslated);
    const used = new Set(preps.flatMap((p) => p.used));
    const boxes = preps.reduce((k, p) => k + p.translated.length, 0);
    const restored = preps.reduce((k, p) => k + p.restored.length, 0);
    this.autoTranslated = boxes;
    const paragraphs = preps.reduce((k, p) => k + p.paragraphs, 0);
    const unconfirmedUsed = [...used].filter((id) => this.unconfirmed.has(id)).length;
    const linked = [...this.links.values()].filter((l) => l.ok).length;
    this.el.summary.replaceChildren(
      h('p', {}, `${plural(paragraphs, 'paragraph')} with text: ${plural(boxes, 'box', 'boxes')} translated from ${used.size} of ${plural(this.pairCount, 'segment')}` +
        (restored ? `, ${plural(restored, 'saved box', 'saved boxes')} put back` : '') + '.'),
      ...(this.linksOn ? [h('p', { class: 'muted small' }, `${plural(linked, 'paragraph')} linked to segments; ` +
        (this.params.segments ? 'typing in a paragraph linked to one segment writes to it.' : `linked text is read-only: ${WHY.no_segments_api}.`))] : []),
      ...(unconfirmedUsed ? [h('p', { class: 'muted small' }, `${plural(unconfirmedUsed, 'segment')} used ${unconfirmedUsed === 1 ? 'is' : 'are'} not confirmed.`)] : []),
    );
    this.renderLists();
    this.status();
    this.hooks.msg(`${plural(this.pageCount, 'page')} ready: ${plural(boxes, 'box', 'boxes')} translated, ${this.untranslated.length} untranslated` +
      (this.head ? `, version ${this.head} applied.` : '.'));
    this.hooks.refresh();
    if (this.linksOn && !this.stored) void this.storeLinks(preps);
  }

  /** The links made on this load, stored once (POST <api>/links). When another frame stored links first, those are
   *  read and checked instead. */
  private async storeLinks(preps: PagePrep[]): Promise<void> {
    if (this.linksPosts > 0) return;
    this.linksPosts++;
    const links: Link[] = preps.flatMap((p) => p.links.filter((l) => l.ok).map(({ page, box, para, seg_ids, src_sha }) => ({ page, box, para, seg_ids, src_sha })));
    try {
      await this.api.postLinks(LINKS_ENGINE, links);
      this.linksStored = 'posted';
    } catch (e) {
      if (e instanceof HostError && e.code === 'links_exist') {
        try {
          const blob = parseLinks(await this.api.links());
          this.stored = blob.links;
          this.linksStored = 'raced';
          const doc = this.hooks.doc();
          this.links.clear(); this.linkedBoxes.clear(); this.paras.clear();
          for (const p of preps) {
            const page = doc?.pages[p.page];
            if (page) this.register(page, verifyLinks(blob.links.filter((l) => l.page === p.page), p.slots, p.detected));
          }
          this.show({ kind: 'info', text: 'The links were stored by another window first; those are used.' });
        } catch (e2) {
          this.linksStored = 'failed';
          this.show({ kind: 'warn', text: `The links stored elsewhere could not be read: ${(e2 as Error).message}.` });
        }
      } else {
        this.linksStored = 'failed';
        this.show({ kind: 'warn', text: `The paragraph links were not stored (${(e as Error).message}); they are made again on the next load.` });
      }
    }
    this.renderLists();
  }

  // ── paragraphs, gates ────────────────────────────────────────────────────────────────────────────────────

  private pageOf(n: number): Page | undefined { return this.hooks.doc()?.pages[n]; }
  private boxOf(n: number, id: string): Box | undefined { return this.pageOf(n)?.boxes.find((x) => x.id === id); }

  /** A shortened paragraph that shows its shortened text now. */
  private activeShort(page: number, box: string, para: number): Shortened | undefined {
    return this.shortened.find((s) => s.page === page && s.box === box && s.para === para && shortenedActive(s, this.pageOf(page)));
  }
  private activeShortened(): Shortened[] {
    return this.shortened.filter((s) => shortenedActive(s, this.pageOf(s.page)));
  }

  /** A linked paragraph's ranges brought up to its text now: a change confined to one range moves the ranges after
   *  it (the input's range wins when several fit); any other change finds the segments' texts again. */
  private track(key: string, ps: ParaState): void {
    const b = this.boxOf(ps.link.page, ps.link.box);
    const p = b?.paragraphs[ps.link.para];
    if (!b || !p) return;
    const now = paraText(b, ps.link.para);
    if (now === ps.text) return;
    const hint = this.hint?.key === key ? this.hint.range : undefined;
    if (this.hint?.key === key) this.hint = null;
    let ranges: SegRange[] | null = null;
    if (ps.ranges) {
      const i = confinedRange(ps.ranges, ps.text, now, hint);
      if (i >= 0) ranges = applyChange(ps.ranges, i, now.length - ps.text.length);
    }
    if (!ranges && ps.link.seg_ids.length > 1) {
      const sh = this.activeShort(ps.link.page, ps.link.box, ps.link.para);
      const parts = ps.ranges ? ps.ranges.map((r) => ({ seg: r.seg, text: r.base })) : null;
      ranges = sh ? null : parts ? locateRanges(now, parts) : this.rangesFor(ps.link, now, null);
    }
    ps.text = now;
    ps.ranges = ranges;
  }

  /** Why a segment does not take typing, or null. */
  private segWhy(id: string): string | null {
    const s = this.segs.get(id);
    if (!s) return 'unknown_segment';
    if (canType(s)) return null;
    return s.refused ?? s.why_not ?? (s.locked ? 'locked' : s.confirmed ? 'confirmed' : 'not_editable');
  }

  /** A paragraph's link and what of it takes typing (null: the paragraph has no link). */
  paraInfo(page: number, box: string, para: number): ParaInfo | null {
    const key = linkKey(page, box, para);
    const l = this.links.get(key);
    if (!l) return null;
    const base = { page, box, para, seg_ids: [...l.seg_ids] };
    if (!l.ok) return { ...base, linked: false, typable: true, why_not: l.why_not, ranges: [] };
    const ps = this.paras.get(key);
    if (ps) this.track(key, ps);
    const ranges: RangeInfo[] = (ps?.ranges ?? []).map((r) => { const why = this.segWhy(r.seg); return { seg: r.seg, start: r.start, end: r.end, typable: !why, why_not: why }; });
    const paraWhy = this.activeShort(page, box, para) ? 'shortened'
      : !ps?.ranges ? (l.seg_ids.every((id) => !this.segs.has(id)) ? 'unknown_segment' : 'ranges_lost')
      : !this.params.segments ? 'no_segments_api' : null;
    return { ...base, linked: true, typable: !paraWhy && ranges.some((r) => r.typable), why_not: paraWhy, ranges };
  }

  /** Whether a box has paragraphs linked to segments (its structure is then fixed). */
  isLinked(page: number, box: string): boolean { return this.linkedBoxes.has(`${page}/${box}`); }

  /** The ranges of a box's linked paragraphs, for drawing them in edit mode (app/main.ts). */
  rangesOf(page: number, box: string): { para: number; index: number; seg: string; start: number; end: number; typable: boolean; why_not: string | null }[] {
    if (!this.isLinked(page, box)) return [];
    const b = this.boxOf(page, box);
    if (!b) return [];
    return b.paragraphs.flatMap((_, para) => {
      const inf = this.paraInfo(page, box, para);
      if (!inf || !inf.linked) return [];
      return inf.ranges.map((r, index) => ({ para, index, seg: r.seg, start: r.start, end: r.end, typable: inf.why_not ? false : r.typable, why_not: inf.why_not ?? r.why_not }));
    });
  }

  /** The caret (or, while the pointer is over the box, the pointer) is at this place: the panel names its segment.
   *  Returns a line for the box's tooltip, or ''. Null `off`: the pointer left. */
  pointAt(page: number, box: string, para: number, off: number | null, from: 'caret' | 'hover'): string {
    if (off === null) { if (this.at?.from === 'hover') this.at = null; this.renderCurrent(); return ''; }
    this.at = { page, box, para, off, from };
    return this.renderCurrent();
  }

  private renderCurrent(): string {
    if (!this.el) return '';
    const at = this.at;
    const inf = at ? this.paraInfo(at.page, at.box, at.para) : null;
    const r = inf && at ? inf.ranges.find((x) => x.start <= at.off && at.off <= x.end) ?? null : null;
    if (!at || !inf || !inf.linked || !r) { this.el.current.hidden = true; this.el.current.replaceChildren(); return ''; }
    const state = inf.why_not ? `read-only: ${whyText(inf.why_not)}` : r.typable ? 'typing writes to it' : `read-only: ${whyText(r.why_not ?? '')}`;
    const line = `${at.from === 'caret' ? 'Caret' : 'Pointer'} in segment ${r.seg}` + (inf.ranges.length > 1 ? ` (${inf.ranges.indexOf(r) + 1} of ${inf.ranges.length})` : '') + ` · ${state}`;
    this.el.current.hidden = false;
    this.el.current.dataset.seg = r.seg;
    this.el.current.replaceChildren(`${line} · `, ...this.segLinks([r.seg]));
    return `Segment ${r.seg}: ${state}`;
  }

  /** Where a box-text offset is: paragraph and offset in it. */
  private posIn(box: Box, g: number): { para: number; off: number } {
    let off = Math.max(0, g);
    for (let i = 0; i < box.paragraphs.length; i++) {
      const n = paraText(box, i).length;
      if (off <= n || i === box.paragraphs.length - 1) return { para: i, off: Math.min(off, n) };
      off -= n + 1;
    }
    return { para: 0, off: 0 };
  }

  /** Why an input the text box is about to apply is refused, or null (src/embed/ranges.ts has the rules). Called
   *  before the input changes anything; a refusal leaves the text as it is. */
  refuseInput(page: number, box: Box, input: BoxInput): string | null {
    if (!this.isLinked(page, box.id)) return null;
    const lineBreak = input.data === '\u2028';
    const paraBreak = !lineBreak && (input.type === 'insertParagraph' || input.type === 'insertLineBreak');
    if (paraBreak || /[\n\r]/.test(input.data ?? '')) {
      return `${box.id} is linked to segments: Enter${/[\n\r]/.test(input.data ?? '') ? ' (or a paste with line breaks)' : ''} is off here.`;
    }
    const a = this.posIn(box, Math.min(input.start, input.end)), z = this.posIn(box, Math.max(input.start, input.end));
    if (a.para !== z.para) return `${box.id} is linked to segments: an edit across two paragraphs would join them.`;
    const len = paraText(box, a.para).length;
    const collapsed = a.off === z.off;
    if (collapsed && input.type.startsWith('delete')) {
      const back = /Backward$/.test(input.type);
      if ((back && a.off === 0) || (!back && a.off === len)) return `${box.id} is linked to segments: joining two paragraphs is not possible here.`;
    }
    const key = linkKey(page, box.id, a.para);
    const inf = this.paraInfo(page, box.id, a.para);
    if (!inf || !inf.linked) return null;
    if (lineBreak) return `Paragraph ${a.para + 1} of ${box.id} is linked to a segment: Enter is off in linked text.`;
    if (inf.why_not) return `Paragraph ${a.para + 1} of ${box.id} is read-only: ${whyText(inf.why_not)}.`;
    const ps = this.paras.get(key)!;
    const v = checkInput(ps.ranges!, ps.text, { type: input.type, start: a.off, end: z.off });
    if (!v.ok) return `Not possible in paragraph ${a.para + 1} of ${box.id}: ${whyText(v.why)}.`;
    const r = inf.ranges[v.range];
    if (!r.typable) return `Segment ${r.seg} in paragraph ${a.para + 1} of ${box.id} is read-only: ${whyText(r.why_not ?? '')}.`;
    this.hint = { key, range: v.range };
    return null;
  }

  /** Why a text edit of a box is refused, or null. `texts`: the box's paragraph texts after the edit. The text box
   *  asks refuseInput first; this check sees every edit (an IME's too) and refuses what changes a linked paragraph
   *  outside one typable range. */
  refuseText(page: number, box: Box, texts: string[]): string | null {
    if (!this.isLinked(page, box.id)) return null;
    if (texts.length !== box.paragraphs.length) {
      return `${box.id} is linked to segments: a new paragraph or a join of two is not possible here (Shift+Enter makes a line break in an unlinked paragraph).`;
    }
    for (let i = 0; i < texts.length; i++) {
      const old = paraText(box, i);
      if (texts[i] === old) continue;
      const key = linkKey(page, box.id, i);
      const inf = this.paraInfo(page, box.id, i);
      if (!inf || !inf.linked) continue;
      if (inf.why_not) return `Paragraph ${i + 1} of ${box.id} is read-only: ${whyText(inf.why_not)}.`;
      const ps = this.paras.get(key)!;
      const hint = this.hint?.key === key ? this.hint.range : undefined;
      const r = confinedRange(ps.ranges!, old, texts[i], hint);
      if (r < 0) return `Not possible in paragraph ${i + 1} of ${box.id}: ${whyText('crosses_boundary')}.`;
      if (!inf.ranges[r].typable) return `Segment ${inf.ranges[r].seg} in paragraph ${i + 1} of ${box.id} is read-only: ${whyText(inf.ranges[r].why_not ?? '')}.`;
      this.hint = { key, range: r };
    }
    return null;
  }

  /** Why a split, a merge or clearing the text of these boxes is refused, or null. */
  refuseStructure(page: number, boxes: string[], what: 'split' | 'merge' | 'clear'): string | null {
    const linked = boxes.filter((id) => this.isLinked(page, id));
    if (!linked.length) return null;
    const verb = what === 'split' ? 'split' : what === 'merge' ? 'merged' : 'cleared';
    return `${linked.join(' and ')} ${linked.length === 1 ? 'is' : 'are'} linked to segments and cannot be ${verb} here` +
      (what === 'clear' ? '; edit the text in the box instead.' : '.');
  }

  /** Called on every editor change: the ranges, the save state, the lists and write-through follow. */
  changed(c: Change): void {
    let linked = false;
    for (const id of c.boxes) {
      if (!this.isLinked(c.page, id)) continue;
      linked = true;
      const b = this.boxOf(c.page, id);
      b?.paragraphs.forEach((_, i) => { const key = linkKey(c.page, id, i); const ps = this.paras.get(key); if (ps) this.track(key, ps); });
    }
    this.hint = null;
    this.status();
    this.renderLists();
    this.selKey = '';
    if (this.at) this.renderCurrent();
  }

  // ── write-through ─────────────────────────────────────────────────────────────────────────────────────────

  /** Editing a box ended (the text box lost focus, or another box was chosen): its pending segment edits are written.
   *  Nothing is written while someone is still typing, so a half-made edit never reaches a segment. */
  editingEnded(): void {
    if (this.pendingWrites().length) void this.writeSegments();
  }

  /** Segment ranges whose text differs from what their segment has; shortened paragraphs left out. */
  private pendingWrites(): { key: string; seg: string; text: string }[] {
    const out: { key: string; seg: string; text: string }[] = [];
    if (!this.params.segments) return out;
    for (const [key, ps] of this.paras) {
      this.track(key, ps);
      if (!ps.ranges || this.activeShort(ps.link.page, ps.link.box, ps.link.para)) continue;
      for (const r of ps.ranges) {
        const text = ps.text.slice(r.start, r.end);
        if (text !== r.base) out.push({ key, seg: r.seg, text });
      }
    }
    return out;
  }

  /** Writes every pending range to its segment, one write after the other. True when nothing is left unwritten. */
  writeSegments(): Promise<boolean> {
    this.writeChain = this.writeChain.then(() => this.writeOnce(), () => this.writeOnce());
    return this.writeChain;
  }

  private async writeOnce(): Promise<boolean> {
    if (!this.ready || !this.hooks.editor()) return true;
    const work = this.pendingWrites();
    if (!work.length) { this.unsaved.clear(); this.status(); return true; }
    this.writing = true;
    this.status();
    try {
      for (const w of work) await this.writeOne(w.key, w.seg);
    } finally {
      this.writing = false;
      this.status();
      this.renderLists();
      this.hooks.refresh();
    }
    return this.unsaved.size === 0 && this.pendingWrites().length === 0;
  }

  /** The unsaved marker of one segment range. */
  private static mark(key: string, seg: string) { return `${key}@${seg}`; }

  private async writeOne(key: string, segId: string): Promise<void> {
    const ps = this.paras.get(key);
    if (!ps) return;
    this.track(key, ps);
    const r = ps.ranges?.find((x) => x.seg === segId);
    if (!r) return;
    const l = ps.link;
    const text = ps.text.slice(r.start, r.end);
    const mark = Embed.mark(key, segId);
    if (text === r.base) { this.unsaved.delete(mark); return; }
    const seg = this.segs.get(segId);
    const where = `paragraph ${l.para + 1} of ${l.box} on page ${l.page + 1}`;
    if (!seg || !canType(seg)) {
      // an undo or redo brought text back into a segment that no longer takes it
      this.revertRange(key, segId, r.base);
      this.show({ kind: 'warn', text: `Not written: segment ${segId} in ${where} is read-only (${whyText(this.segWhy(segId) ?? 'unknown_segment')}).` });
      return;
    }
    const base = r.base;
    const full = segmentTextFor(seg.text, base, text);
    try {
      const res = await this.api.writeSegment(seg.id, { text: full, marks: marksFor(seg.marks, full.length), base_version_id: seg.version });
      seg.version = res.version?.id ?? seg.version;
      seg.text = full;
      seg.marks = marksFor(seg.marks, full.length);
      const now = this.paras.get(key)?.ranges?.find((x) => x.seg === segId);
      if (now) now.base = text;
      this.unsaved.delete(mark);
      this.writes.push({ seg: seg.id, ok: true, status: 200 });
    } catch (e) {
      const err = e instanceof HostError ? e : null;
      this.writes.push({ seg: seg.id, ok: false, status: err?.status ?? null });
      const cur = err?.status === 409 ? (err.data.current as { id?: string; text?: string; marks?: Mark[] } | null | undefined) : null;
      if (err?.status === 409 && cur && typeof cur.text === 'string') {
        // changed elsewhere: the range shows the segment's current text, and the text typed here is listed
        seg.version = cur.id ?? seg.version;
        seg.text = cur.text;
        seg.marks = Array.isArray(cur.marks) ? cur.marks : [];
        const b = this.boxOf(l.page, l.box);
        const shown = l.seg_ids.length === 1 && b?.paragraphs[l.para] ? withoutBullet(cur.text, b.paragraphs[l.para].bullet) : cur.text.trim();
        const now = this.paras.get(key)?.ranges?.find((x) => x.seg === segId);
        if (now) now.base = shown;
        this.unsaved.delete(mark);
        this.revertRange(key, segId, shown);
        this.conflicts = [...this.conflicts.filter((c) => c.seg !== seg.id), { key, page: l.page, box: l.box, para: l.para, seg: seg.id, mine: text, current: cur.text }];
        this.show({ kind: 'warn', text: `Segment ${seg.id} was changed elsewhere: ${where} now shows its current text. The text typed here is listed below.` });
      } else if (err?.status === 409) {
        // locked, confirmed, not for translation: refused; the range goes back and is read-only from now on
        seg.refused = err.message;
        this.unsaved.delete(mark);
        this.revertRange(key, segId, base);
        this.show({ kind: 'bad', text: `Not written to segment ${seg.id}: ${err.message}. ${where[0].toUpperCase()}${where.slice(1)} shows the segment's text again.` });
      } else {
        this.unsaved.add(mark);
        this.show({ kind: 'bad', text: `Not written to segment ${seg.id}: ${(e as Error).message}. It is tried again with the next edit, Save or Export.` });
      }
    }
  }

  /** Sets one segment range's text without writing it (its base is set first): a revert after a refusal. */
  private revertRange(key: string, segId: string, text: string): void {
    const ed = this.hooks.editor();
    const ps = this.paras.get(key);
    if (!ed || !ps) return;
    this.track(key, ps);
    const i = ps.ranges?.findIndex((x) => x.seg === segId) ?? -1;
    const b = this.boxOf(ps.link.page, ps.link.box);
    if (i < 0 || !b || !b.paragraphs[ps.link.para]) return;
    const r = ps.ranges![i];
    if (ps.text.slice(r.start, r.end) === text) return;
    const texts = b.paragraphs.map((_, k) => paraText(b, k));
    texts[ps.link.para] = ps.text.slice(0, r.start) + text + ps.text.slice(r.end);
    this.hint = { key, range: i };
    try { ed.editText(ps.link.page, ps.link.box, texts); } catch (e) { this.hooks.msg(`Could not put the text back: ${(e as Error).message}`); }
  }

  // ── shortening ────────────────────────────────────────────────────────────────────────────────────────────

  /** A shortened paragraph back to its faithful text (the segment's current text, when it is linked to one). */
  useFaithful(i: number): void {
    const s = this.shortened[i];
    const ed = this.hooks.editor();
    if (!s || !ed || !shortenedActive(s, this.pageOf(s.page))) return;
    const seg = s.seg_id ? this.segs.get(s.seg_id) : undefined;
    const b = this.pageOf(s.page)!.boxes.find((x) => x.id === s.box)!;
    const faithful = seg && seg.text.trim() ? withoutBullet(seg.text, b.paragraphs[s.para].bullet) : s.before;
    try {
      ed.setText(s.page, s.box, s.para, faithful);
      this.hooks.msg(`Paragraph ${s.para + 1} of ${s.box} shows the faithful text again (Fit this page if it overflows).`);
    } catch (e) { this.hooks.msg(String((e as Error).message)); }
  }

  // ── save, export ──────────────────────────────────────────────────────────────────────────────────────────

  /** Saves the edited boxes as a new version. False when nothing was saved. */
  async save(): Promise<boolean> {
    const doc = this.hooks.doc();
    if (!this.ready || this.busy || !doc) return false;
    this.busy = true;
    this.status();
    this.hooks.refresh();
    const at = this.hooks.version();
    const state = serialiseState(doc, { engine: ENGINE, shortened: this.activeShortened() });
    const boxes = state.pages.reduce((k, p) => k + p.boxes.length, 0);
    try {
      const res = await this.api.saveVersion(this.head, state, `${plural(boxes, 'edited box', 'edited boxes')} on ${plural(state.pages.length, 'page')}`);
      const n = Number(res.doc?.head ?? res.version?.n);
      this.head = Number.isInteger(n) && n > 0 ? n : this.head + 1;
      this.savedAt = at;
      this.show({ kind: 'ok', text: `Saved as version ${this.head}.` });
      this.hooks.msg(`Saved as version ${this.head}.`);
      if (this.pendingWrites().length) void this.writeSegments();
      return true;
    } catch (e) {
      if (e instanceof HostError && e.code === 'head_moved') {
        const now = e.data.head;
        this.show({ kind: 'bad', text: `Not saved: the document was saved elsewhere${now !== undefined ? ` and is now at version ${now}` : ''}. ` +
          'Reload to continue from that version; the edits made here since the last save are then lost.',
          action: { label: 'Reload', run: () => location.reload() } });
        this.hooks.msg('Not saved: the document has a newer version.');
      } else {
        this.show({ kind: 'bad', text: `Not saved: ${(e as Error).message}` });
        this.hooks.msg(`Not saved: ${(e as Error).message}`);
      }
      return false;
    } finally {
      this.busy = false;
      this.status();
      this.hooks.refresh();
    }
  }

  /** Before the worker exports: text edits are written to their segments, and unsaved edits are saved, so the export
   *  names the version it was made from. False stops the export. */
  async beforeExport(): Promise<boolean> {
    if (!this.canExport) return false;
    if (!(await this.writeSegments())) {
      this.hooks.msg(`Export stopped: ${plural(this.unsaved.size || this.pendingWrites().length, 'segment edit')} could not be written.`);
      return false;
    }
    // an export names a saved version (n ≥ 1): unsaved edits, or a document never saved, are saved first
    if ((this.dirty || this.head === 0) && !(await this.save())) { this.hooks.msg('Export stopped: the edits could not be saved first.'); return false; }
    this.exportN = this.head;
    return true;
  }

  /** The worker's export finished: a verified file is sent to the host; one that failed verification waits for
   *  "Send anyway". */
  async exported(bytes: ArrayBuffer | null, report: ExportReport | null, error: string | null): Promise<void> {
    const n = this.exportN;
    this.exportN = null;
    if (n === null) return;
    if (!bytes || !report) { this.show({ kind: 'bad', text: `Export failed: ${report?.failures[0] ?? error ?? 'unknown error'}. Nothing was sent.` }); return; }
    const doc = this.hooks.doc(), fonts = this.hooks.fonts();
    const header = encodeReportHeader(hostReport(report, doc && fonts ? substitutionsOf(doc, fonts) : [], ENGINE, this.activeShortened()));
    if (!report.ok) {
      this.show({ kind: 'warn', text: `The export failed verification (${report.failures[0] ?? 'see the export report'}). It was not sent.`,
        action: { label: 'Send anyway', run: () => { void this.upload(n, bytes, header); } } });
      return;
    }
    await this.upload(n, bytes, header);
  }

  private async upload(n: number, bytes: ArrayBuffer, header: string): Promise<void> {
    this.busy = true;
    this.hooks.refresh();
    this.show({ kind: 'info', text: 'Sending the export…' });
    try {
      await this.api.exportPdf(n, bytes, header);
      this.uploads.push({ n, ok: true, at: Date.now() });
      this.show({ kind: 'ok', text: `Export of version ${n} sent.` });
      this.hooks.msg(`Export of version ${n} sent.`);
    } catch (e) {
      this.uploads.push({ n, ok: false, at: Date.now() });
      this.show({ kind: 'bad', text: `The export was not sent: ${(e as Error).message}`, action: { label: 'Try again', run: () => { void this.upload(n, bytes, header); } } });
    } finally {
      this.busy = false;
      this.hooks.refresh();
    }
  }

  // ── the panel ─────────────────────────────────────────────────────────────────────────────────────────────

  /** The host's link to a segment (?seglink=), or null when the host gave none. */
  segmentHref(seg: string): string | null {
    return this.params.seglink ? segLinkFor(this.params.seglink, seg) : null;
  }

  private segLinks(ids: string[]): (HTMLElement | string)[] {
    return ids.flatMap((id, i) => {
      const href = this.segmentHref(id);
      const label = ids.length > 1 ? `${this.params.seglabel} ${id}` : this.params.seglabel;
      return [...(i ? [' · '] : []), href ? h('a', { href, target: '_top', class: 'seg-link', 'data-seg': id, title: `Segment ${id}` }, label) : `segment ${id}`];
    });
  }

  /** The selected box's paragraphs with their segments (app/main.ts calls it whenever the panel is updated). */
  selection(page: number | null, box: string | null): void {
    if (!this.el || !this.ready) return;
    const b = page !== null && box ? this.boxOf(page, box) : undefined;
    const rows = b ? b.paragraphs.map((_, i) => ({ i, inf: this.paraInfo(page!, b.id, i) })) : [];
    const key = b ? `${page}/${b.id}|` + rows.map((r) => `${r.inf?.seg_ids.join(',')}:${r.inf?.why_not}:${r.inf?.ranges.map((x) => `${x.seg}${x.typable}`).join(',')}`).join(';') : '';
    if (key === this.selKey) return;
    this.selKey = key;
    if (!b || !this.linksOn) { this.el.selection.replaceChildren(); if (!b) { this.at = null; this.renderCurrent(); } return; }
    const segRow = (r: RangeInfo, paraWhy: string | null) => h('span', { class: 'seg-row', 'data-seg': r.seg },
      `segment ${r.seg} · ${paraWhy ? `read-only: ${whyText(paraWhy)}` : r.typable ? 'typing writes to it' : `read-only: ${whyText(r.why_not ?? '')}`} · `, ...this.segLinks([r.seg]));
    this.el.selection.replaceChildren(h('h3', {}, `Selected: ${b.id}`), h('ul', { class: 'untranslated', id: 'embed-selected' }, ...rows.map(({ i, inf }) => {
      if (!inf) return h('li', { 'data-para': String(i) }, `¶${i + 1} · not linked`);
      if (!inf.linked) return h('li', { 'data-para': String(i) }, `¶${i + 1} · ${whyText(inf.why_not ?? '')}`);
      if (!inf.ranges.length) return h('li', { 'data-para': String(i) }, `¶${i + 1} · segments ${inf.seg_ids.join(', ')} · read-only: ${whyText(inf.why_not ?? '')} · `, ...this.segLinks(inf.seg_ids));
      if (inf.ranges.length === 1) return h('li', { 'data-para': String(i) }, `¶${i + 1} · `, segRow(inf.ranges[0], inf.why_not));
      return h('li', { 'data-para': String(i) }, `¶${i + 1} · ${inf.ranges.length} segments:`,
        ...inf.ranges.map((r, k) => h('div', { class: 'small' }, `${k + 1}. `, segRow(r, inf.why_not))));
    })));
  }

  private renderLists(): void {
    if (!this.el) return;
    const doc = this.hooks.doc();
    const pbtn = (page: number, box: string) => h('button', { class: 'link', 'data-page': String(page), 'data-box': box, title: `Page ${page + 1}, ${box}: select the box` }, `p${page + 1}`);
    // conflicts: the text typed here that the segment's newer text replaced
    this.el.conflicts.replaceChildren(...(this.conflicts.length ? [h('h3', {}, `Changed elsewhere (${this.conflicts.length})`),
      h('ul', { class: 'untranslated' }, ...this.conflicts.slice(-MAX_LISTED).map((c) => h('li', {}, pbtn(c.page, c.box), ` ¶${c.para + 1} · segment ${c.seg}: typed here "${clip(c.mine)}" · now "${clip(c.current)}" · `, ...this.segLinks([c.seg]))))] : []));
    // shortened paragraphs that show their shortened text
    const shorts = this.shortened.map((s, i) => ({ s, i })).filter(({ s }) => shortenedActive(s, this.pageOf(s.page)));
    this.el.shortHead.hidden = !shorts.length;
    this.el.shortHead.textContent = `Shortened (${shorts.length})`;
    this.el.short.replaceChildren(...shorts.slice(0, MAX_LISTED).map(({ s, i }) => h('li', { 'data-short': String(i) }, pbtn(s.page, s.box),
      ` ¶${s.para + 1} · "${clip(s.after, 70)}" · faithful: "${clip(s.before, 70)}" `, h('button', { class: 'link', 'data-faithful': String(i), title: 'Put the faithful text back' }, 'Use faithful'))));
    // linked paragraphs that are read-only, and links that did not hold
    const attn = [...this.links.values()].map((l) => this.paraInfo(l.page, l.box, l.para)!)
      .flatMap((x) => (x.why_not ? (x.why_not === 'shortened' || x.why_not === 'no_segments_api' ? [] : [{ x, why: x.why_not, segs: x.seg_ids }])
        : x.ranges.filter((r) => !r.typable).map((r) => ({ x, why: r.why_not ?? '', segs: [r.seg] }))))
      .sort((a, b) => a.x.page - b.x.page || a.x.box.localeCompare(b.x.box) || a.x.para - b.x.para);
    this.el.attnHead.hidden = !attn.length;
    this.el.attnHead.textContent = `Read-only or not linked (${attn.length})`;
    this.el.attn.replaceChildren(...attn.slice(0, MAX_LISTED).map(({ x, why, segs }) => h('li', { 'data-why': why, 'data-seg': segs.join(',') }, pbtn(x.page, x.box),
      ` ¶${x.para + 1}${x.linked && x.seg_ids.length > 1 && segs.length === 1 ? ` (segment ${segs[0]})` : ''} · ${whyText(why)} · `, ...this.segLinks(segs))),
      ...(attn.length > MAX_LISTED ? [h('li', { class: 'muted' }, `and ${attn.length - MAX_LISTED} more`)] : []));
    // untranslated paragraphs
    const items = this.untranslated;
    this.el.listHead.hidden = !items.length;
    this.el.listHead.textContent = `Untranslated (${items.length})`;
    const edited = (u: Untranslated) => !!doc?.pages[u.page]?.boxes.find((b) => b.id === u.box)?.edited;
    this.el.list.replaceChildren(...items.slice(0, MAX_LISTED).map((u) => h('li', { class: edited(u) ? 'edited' : '' },
      pbtn(u.page, u.box), ' ', clip(u.text), edited(u) ? h('span', { class: 'muted small' }, ' · edited') : null)),
      ...(items.length > MAX_LISTED ? [h('li', { class: 'muted' }, `and ${items.length - MAX_LISTED} more`)] : []));
  }

  private status(): void {
    if (!this.el) return;
    const pending = this.ready ? this.pendingWrites().length : 0;
    this.el.save.disabled = !this.ready || this.busy || this.writing || (!this.dirty && !pending);
    this.el.save.textContent = this.busy && this.ready ? 'Saving…' : 'Save';
    if (!this.ready) { this.el.status.textContent = this.matcher ? 'Reading pages…' : 'Loading…'; return; }
    const v = this.head ? `Version ${this.head}` : 'No saved version yet';
    const writes = this.writing ? ' · writing to segments…' : this.unsaved.size ? ` · ${plural(this.unsaved.size, 'segment edit')} not written`
      : pending ? ` · ${plural(pending, 'segment edit')} to write when you finish editing or Save` : '';
    this.el.status.textContent = `${v} · ${this.dirty ? 'unsaved changes' : this.head ? 'saved' : 'translations not saved'}${writes}`;
  }

  private show(note: Note | null): void {
    this.note = note;
    if (!this.el) return;
    if (!note) { this.el.note.replaceChildren(); return; }
    const cls = note.kind === 'ok' ? 'banner ok' : note.kind === 'warn' ? 'banner warn' : note.kind === 'bad' ? 'banner bad' : 'muted';
    const p = h('p', { class: cls }, note.text);
    if (note.action) {
      const b = h('button', { class: 'link' }, note.action.label);
      const run = note.action.run;
      b.addEventListener('click', run);
      p.append(' ', b);
    }
    this.el.note.replaceChildren(p);
  }

  /** For the headless check (scripts/embed-smoke.ts). */
  get debug() {
    return {
      ready: this.ready, busy: this.busy, head: this.head, dirty: this.dirty, pairs: this.pairCount, pages: this.pageCount,
      untranslated: this.untranslated.map((u) => ({ ...u })), note: this.note && { kind: this.note.kind, text: this.note.text },
      uploads: [...this.uploads], restoredPages: [...this.state.keys()],
      linksOn: this.linksOn, linksPosts: this.linksPosts, linksStored: this.linksStored,
      links: [...this.links.values()].map((l) => ({ ...l, info: this.paraInfo(l.page, l.box, l.para) })),
      paras: [...this.paras.entries()].map(([key, p]) => ({ key, text: p.text, ranges: p.ranges && p.ranges.map((r) => ({ ...r })) })),
      segments: [...this.segs.values()].map((s) => ({ id: s.id, version: s.version, text: s.text, refused: s.refused })),
      pendingWrites: this.pendingWrites().map((w) => `${w.key}@${w.seg}`), unsaved: [...this.unsaved], writing: this.writing, writes: [...this.writes],
      conflicts: this.conflicts.map((c) => ({ ...c })),
      shortenOn: this.shortenOn, shortenCalls: this.shortenCalls, shortenFailures: [...this.shortenFailures],
      shortened: this.shortened.map((s) => ({ ...s, active: shortenedActive(s, this.pageOf(s.page)) })),
    };
  }
}
