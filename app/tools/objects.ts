// The Objects card. It lists the objects under the pointer, topmost first (bold: painting there), or,
// with a selection, the selection's context (the objects under the press that selected it, or its groups, itself and
// its members), each row with its kind (text, image, inline image, vector, vector group, shading, form group, group,
// proposed group), size and a clip mark; a group's members are indented under it. A group the editor proposed
// (src/objects/groups.ts) is marked dashed; with several objects selected (Shift-click), each is marked. Hovering a row outlines the object on the page; a click
// selects it (app/tools/select.ts does the selecting and the outlines). "List this page" lists every object of the
// page object model in paint order (a form's contents indented). Nothing is changed.
import type { PageObject, PageObjects } from '../../src/objects/types.ts';
import { h } from '../reports.ts';
import type { Tool } from '../toolhost.ts';
import type { ObjectList, ObjectRow } from './select.ts';

const CSS = `
#objects .rows { max-height: 320px; overflow-y: auto; font: 11px/1.45 ui-monospace, monospace; }
#objects .row { display: flex; gap: 6px; padding: 1px 2px; cursor: default; white-space: nowrap; }
#objects .rows .row { cursor: pointer; }
#objects .row:hover, #objects .row.hot { background: var(--sel, #2563eb22); }
#objects .row.sel { outline: 1.5px solid #2563eb; outline-offset: -1.5px; }
#objects .row.auto .k { font-style: italic; }
#objects .row.auto.sel { outline-style: dashed; }
#objects .row.paints { font-weight: 600; }
#objects .row .k { width: 112px; flex: none; overflow: hidden; text-overflow: ellipsis; }
#objects .row .id { width: 64px; flex: none; color: var(--muted); }
#objects .row .clip { color: var(--muted); font-style: italic; }
`;

const r1 = (x: number) => Math.round(x * 10) / 10;

const tool: Tool = {
  id: 'objects',
  connector: false,
  order: 90,
  setup(host) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    const listBtn = h('button', { title: 'List every object the current page paints, in paint order' }, 'List this page') as HTMLButtonElement;
    const info = h('p', { class: 'muted small' }, 'Open a PDF, then point at a page or list it.');
    const rows = h('div', { class: 'rows' });
    host.panel(h('section', { id: 'objects' }, h('h2', {}, 'Objects'), h('div', { class: 'row' }, listBtn), info, rows));

    const cache = new Map<number, PageObjects>();
    async function load(n: number): Promise<PageObjects | null> {
      if (cache.has(n)) return cache.get(n)!;
      try {
        const p = await host.callWorker<PageObjects>('objects', { n });
        cache.set(n, p);
        return p;
      } catch (err) { info.textContent = `Page ${n + 1}: ${(err as Error).message}`; return null; }
    }

    function rowEl(n: number, id: string, cls: string, title: string, ...cells: (string | HTMLElement)[]) {
      const el = h('div', { class: `row${cls}`, 'data-id': id, title }, ...cells);
      el.addEventListener('pointerenter', () => host.emit('objects:hover', { n, id }));
      el.addEventListener('pointerleave', () => host.emit('objects:hover', null));
      el.addEventListener('click', () => host.emit('objects:pick', { n, id }));
      return el;
    }

    /** A row of the selection tool's list. */
    function listed(n: number, r: ObjectRow, selected: string | null, picked: readonly string[] = []) {
      const title = `${r.label} ${r.id}: ${r.w} × ${r.h} pt` + (r.clipped ? ' · clipped' : '') + (r.paints ? ' · painting here' : '') +
        (r.uses ? ` · painted ${r.uses}× in the document` : '') + (r.auto ? ' · proposed: Ungroup undoes it' : r.group ? ' · a group' : '');
      return rowEl(n, r.id, `${r.paints ? ' paints' : ''}${r.auto ? ' auto' : ''}${r.id === selected || picked.includes(r.id) ? ' sel' : ''}`, title,
        h('span', { class: 'k' }, `${'· '.repeat(r.depth)}${r.label}`), h('span', {}, `${r.w} × ${r.h}`),
        ...(r.clipped ? [h('span', { class: 'clip' }, 'clipped')] : []), h('span', { class: 'id' }, r.id));
    }

    /** A row of the page list: an object of the page object model. */
    function modelRow(p: PageObjects, o: PageObject) {
      const b = o.bounds;
      const title = `${o.kind} ${o.id}: ${r1(b.x1 - b.x0)} × ${r1(b.y1 - b.y0)} pt at ${r1(b.x0)}, ${r1(b.y0)}` +
        (o.clips.length ? ` · clipped (${o.clips.length})` : '') + (o.uses && o.uses > 1 ? ` · painted ${o.uses}× in the document` : '');
      return rowEl(p.page, o.id, '', title, h('span', { class: 'z' }, String(o.z).padStart(3)),
        h('span', { class: 'k' }, `${'· '.repeat(o.path.length)}${o.kind}`), h('span', { class: 'id' }, o.id), h('span', {}, `${r1(b.x1 - b.x0)} × ${r1(b.y1 - b.y0)}`));
    }

    host.on('objects:list', (d) => {
      const l = d as ObjectList | null;
      if (!l) { for (const el of rows.querySelectorAll('.row.sel')) el.classList.remove('sel'); return; }   // the list stays until there is another
      info.textContent = `Page ${l.n + 1}: ${l.title}`;
      rows.replaceChildren(...l.rows.map((r) => listed(l.n, r, l.selected, l.picked)));
      rows.querySelector('.row.sel')?.scrollIntoView({ block: 'nearest' });
    });

    listBtn.addEventListener('click', async () => {
      const p = await load(host.current());
      if (!p) return;
      info.textContent = `Page ${p.page + 1}: ${p.objects.length} objects in paint order, ${p.clips.length} clips` +
        (p.view.rotate ? `, turned ${p.view.rotate}°` : '') + (p.notes.length ? ` · ${p.notes.join('; ')}` : '') + '.';
      rows.replaceChildren(...p.objects.map((o) => modelRow(p, o)));
    });

    return {
      opened(pages) { cache.clear(); rows.replaceChildren(); info.textContent = pages ? 'Point at a page, or list it, to see its objects.' : 'Open a PDF, then point at a page or list it.'; },
      debug: { list: (n: number) => load(n) },
    };
  },
};
export default tool;
