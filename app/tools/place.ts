// Labs (?labs): adding a PNG or JPEG image to a page (src/objects/place.ts).
//
// "Add image" picks a file and places it on the page in view, centred; a file dropped on a page goes where it is
// dropped. It comes at its natural size (its pixels at the resolution the file declares, else 72 dpi), made smaller to
// fit the page, upright as the page is shown (pages turned by /Rotate too), on top of everything. It is then selected
// by the select tool (app/tools/select.ts), which selects, lists, moves, resizes, turns and removes added images as it
// does the page's own objects (one selection for all of them); each change is one undo step on the page's object ops
// (the add-image op's frame and quarter turn). Until the page's commit render arrives the image is drawn over the page
// from the file; the commit then shows what the PDF paints.
//
// The file is checked here (format and size limits, src/objects/imagefile.ts) and in the worker, which keeps it for
// export (app/ops/place.ts).
import { plainView, type ViewBox } from '../../src/engine/view.ts';
import { IMAGE_LIMITS, IMAGE_LIMITS_WHY, ImageRefused, readImageInfo, type ImageInfo } from '../../src/objects/imagefile.ts';
import type { ObjectOp } from '../../src/objects/ops.ts';
import { ADD } from '../../src/objects/handles.ts';
import { imageMatrix, naturalSize, placeImage, type AddImage } from '../../src/objects/place.ts';
import { mul } from '../../src/pdf/ops.ts';
import type { Page } from '../../src/model/types.ts';
import { canvasMatrix, type Underlay } from '../../web/preview.ts';
import { h } from '../reports.ts';
import type { Tool } from '../toolhost.ts';
const TYPES = ['image/png', 'image/jpeg'];
const isImage = (f: File) => TYPES.includes(f.type) || /\.(png|jpe?g)$/i.test(f.name);

const tool: Tool = {
  id: 'place',
  stage: 'labs',
  order: 80,
  setup(host) {
    const input = h('input', { type: 'file', accept: TYPES.join(','), hidden: '' }) as HTMLInputElement;
    const button = h('button', { title: `Add a PNG or JPEG image to the page in view (or drop one on a page). Up to ${IMAGE_LIMITS.bytes / 1048576} MB and ${IMAGE_LIMITS.side} pixels a side.` }, 'Add image') as HTMLButtonElement;
    host.toolbar(h('div', {}, button, input));

    /** Files placed in this session, by asset key: the decoded image for drawing until the commit render shows it. */
    const files = new Map<string, { bitmap: ImageBitmap; info: ImageInfo }>();
    /** The select tool's selection, when it is one added image (app/tools/select.ts emits it). */
    let sel: { n: number; key: string } | null = null;
    host.on('objects:selection', (x) => {
      const s = x as { n: number; ids: string[] } | null;
      sel = s && s.ids.length === 1 && s.ids[0].startsWith(ADD) ? { n: s.n, key: s.ids[0].slice(ADD.length) } : null;
    });
    let seq = 0;
    let busy = false;

    const opsOf = (n: number): ObjectOp[] => host.doc()?.pages[n]?.objectOps ?? [];
    const addedOn = (n: number): AddImage[] => opsOf(n).filter((o): o is AddImage => o.op === 'add-image');
    const find = (n: number, key: string) => addedOn(n).find((o) => o.key === key) ?? null;
    const viewOf = (p: Page): ViewBox => p.view ?? plainView(p.w, p.h);

    function edit(n: number, label: string, fn: (ops: ObjectOp[]) => ObjectOp[]): boolean {
      const ed = host.editor();
      const why = host.refused();
      if (why) { host.msg(why); return false; }
      if (!ed) return false;
      ed.pageEdit(n, label, (pg) => { pg.objectOps = fn(pg.objectOps ?? []); }, ['objectOps']);
      return true;
    }

    // ── adding ──────────────────────────────────────────────────────────────────────────────────────────────
    /** Adds an image file to page n, centred on `at` (user space) or on the page. Returns a sentence saying what happened. */
    async function add(bytes: Uint8Array, type: string, n: number, at: { x: number; y: number } | null): Promise<string> {
      const say = (s: string) => { host.msg(s); return s; };
      const why = host.refused();
      if (why) return say(why);
      const page = host.doc()?.pages[n];
      if (!page || !host.editor()) return say('Wait until the page is shown, then add the image again.');
      if (busy) return say('An image is still being added.');
      let info: ImageInfo;
      try { info = readImageInfo(bytes); } catch (e) {
        if (e instanceof ImageRefused) return say(`${e.message} ${/up to/.test(e.message) ? IMAGE_LIMITS_WHY : ''}`.trim());
        throw e;
      }
      busy = true;
      try {
        let bitmap: ImageBitmap;
        try { bitmap = await createImageBitmap(new Blob([bytes.slice()], { type })); } catch {
          return say('The browser cannot show this image, so it was not added.');
        }
        const got = await host.callWorker<{ key: string; info: ImageInfo; ms: number } | { refused: string }>('place-asset', { bytes: bytes.slice().buffer });
        if ('refused' in got) { bitmap.close(); return say(got.refused); }
        if (!files.has(got.key)) files.set(got.key, { bitmap, info: got.info }); else bitmap.close();
        const { frame, rotate } = placeImage(info, viewOf(page), at);
        let key: string;
        do key = `img${++seq}`; while (find(n, key));
        if (!edit(n, 'add image', (ops) => [...ops, { op: 'add-image', key, asset: got.key, frame, rotate }])) return 'refused';
        host.emit('objects:select', { n, id: ADD + key });
        const nat = naturalSize(info), w = frame.x1 - frame.x0, hh = frame.y1 - frame.y0;
        const shown = rotate % 180 ? [hh, w] : [w, hh];
        const smaller = shown[0] < nat.w - 0.01;
        return say(`Image added: ${info.width} × ${info.height} px ${info.format.toUpperCase()}, ${shown.map((v) => v.toFixed(0)).join(' × ')} pt${smaller ? ' (made smaller to fit the page)' : ''}. Drag to move it, the handles resize and turn it, arrows nudge it, Delete removes it.`);
      } finally { busy = false; }
    }
    async function addFile(f: File, n: number, at: { x: number; y: number } | null) {
      if (!isImage(f)) { host.msg(`${f.name} is not a PNG or JPEG image.`); return; }
      if (f.size > IMAGE_LIMITS.bytes) { host.msg(`The file is ${(f.size / 1048576).toFixed(1)} MB; image files up to ${IMAGE_LIMITS.bytes / 1048576} MB can be added. ${IMAGE_LIMITS_WHY}`); return; }
      await add(new Uint8Array(await f.arrayBuffer()), f.type || (/\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg'), n, at);
    }
    button.addEventListener('click', () => { if (!host.doc()) { host.msg('Open a PDF first.'); return; } input.click(); });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.value = '';
      if (f) void addFile(f, host.current(), null);
    });

    // ── drawing the image until the commit shows it ─────────────────────────────────────────────────────────
    function underlay(n: number): Underlay | null {
      if (!addedOn(n).some((o) => files.has(o.asset))) return null;
      return {
        rects: (p: Page) => (p.objectOps ?? []).flatMap((o) => (o.op === 'add-image' ? [o.frame] : [])),
        paint: (c, p, a) => {
          const D = canvasMatrix(a.view);
          for (const o of p.objectOps ?? []) {
            if (o.op !== 'add-image') continue;
            const f = files.get(o.asset);
            if (!f) continue;
            // canvas unit square (y down) → the image's unit square (y up) → user space → canvas pixels
            const m = mul(mul([1, 0, 0, -1, 0, 1], imageMatrix(o.frame, o.rotate)), D);
            c.save();
            c.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
            c.drawImage(f.bitmap, 0, 0, 1, 1);
            c.restore();
          }
        },
      };
    }

    // ── drops ───────────────────────────────────────────────────────────────────────────────────────────────
    function drop(e: DragEvent): boolean {
      const f = [...(e.dataTransfer?.files ?? [])].find(isImage);
      if (!f || !host.doc()) return false;
      const pageEl = ((e.target as HTMLElement | null)?.closest?.('.page') ?? document.elementsFromPoint(e.clientX, e.clientY).map((el) => el.closest('.page')).find(Boolean)) as HTMLElement | null;
      const n = pageEl ? Number(pageEl.dataset.n) : host.current();
      const at = pageEl ? host.fromClient(n, e.clientX, e.clientY) : null;
      void addFile(f, n, at);
      return true;
    }

    return {
      underlay,
      drop,
      opened() { sel = null; },
      updated() { button.disabled = !host.doc() || !!host.refused(); },
      debug: {
        get state() { return { selected: sel ? { ...sel } : null, files: files.size }; },
        /** Adds an image from bytes (base64) to page n at a user-space point or the centre; the sentence shown. */
        add: (b64: string, type: string, n: number, at: { x: number; y: number } | null = null) =>
          add(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)), type, n, at),
        added: (n: number) => addedOn(n).map((o) => ({ ...o, frame: { ...o.frame } })),
        hasInWorker: (n: number) => host.callWorker<boolean[]>('place-has', { keys: addedOn(n).map((o) => o.asset) }),
      },
    };
  },
};
export default tool;
