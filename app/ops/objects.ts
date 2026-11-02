// Worker ops for the page object model (src/objects): a page's objects in paint order, the geometry the selection's
// hit test reads (src/objects/hit.ts), and the render hit test for objects under a point (PdfPage.paintsAt).
import { hitGeometry } from '../../src/objects/hit.ts';
import { pageObjects } from '../../src/objects/list.ts';
import type { OpModule } from '../opshost.ts';

export const ops: OpModule['ops'] = {
  /** { n } → PageObjects */
  objects: async (ctx, args) => {
    const doc = ctx.doc();
    if (!doc) throw new Error('no document is open');
    const n = Number((args as { n: number }).n);
    const edit = await ctx.edit();
    const pg = doc.page(n);
    try { return pageObjects(edit, pg); } finally { pg.close(); }
  },
  /** { n } → { model: PageObjects, geometry: HitGeometry }: the objects and what the hit test needs of their shapes */
  'objects-hit': async (ctx, args) => {
    const doc = ctx.doc();
    if (!doc) throw new Error('no document is open');
    const n = Number((args as { n: number }).n);
    const edit = await ctx.edit();
    const pg = doc.page(n);
    try {
      const model = pageObjects(edit, pg);
      return { model, geometry: hitGeometry(edit, pg, model) };
    } finally { pg.close(); }
  },
  /** { n, x, y, engine: EngineObject indices } → whether each paints at user-space point (x, y) */
  'objects-paint': (ctx, args) => {
    const doc = ctx.doc();
    if (!doc) throw new Error('no document is open');
    const a = args as { n: number; x: number; y: number; engine: number[] };
    const pg = doc.page(a.n);
    try { return pg.paintsAt(a.engine, a.x, a.y); } finally { pg.close(); }
  },
};
