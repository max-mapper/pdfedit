// Worker op for paint order (src/objects/order.ts): plans a page's order ops against its content streams, so the
// selection tool can refuse a move with the reason before recording it, and knows the new paint order of the objects
// it moved (the render of the file still shows the old one until the page is committed).
import { contentTree } from '../../src/pdf/tree.ts';
import { proposedGroups } from '../../src/objects/groups.ts';
import { pageObjects } from '../../src/objects/list.ts';
import { applyOps, type ObjectOp } from '../../src/objects/ops.ts';
import { planOrder } from '../../src/objects/order.ts';
import type { OpModule } from '../opshost.ts';

/** One order op's outcome. */
export type OrderCheck = { id: string; to: 'forward' | 'backward'; ok: boolean; reason?: string; past?: string[] };
export type OrderAnswer = { results: OrderCheck[]; z: [string, number][] };

export const ops: OpModule['ops'] = {
  /** { n, ops: ObjectOp[] } → OrderAnswer: every order op of the list, in order, and the new paint order */
  'objects-order': async (ctx, args) => {
    const doc = ctx.doc();
    if (!doc) throw new Error('no document is open');
    const a = args as { n: number; ops: ObjectOp[] };
    const n = Number(a.n);
    const edit = await ctx.edit();
    const tree = contentTree(edit, n);
    const pg = doc.page(n);
    try {
      const model = pageObjects(edit, pg, tree);
      const plan = planOrder(model, tree, applyOps(model, a.ops ?? [], { groups: proposedGroups(model) }));
      const answer: OrderAnswer = {
        results: plan.results.map((r) => ({ id: r.op.id, to: r.op.to, ok: r.ok, ...(r.reason ? { reason: r.reason } : {}), ...(r.past ? { past: r.past } : {}) })),
        z: [...plan.z],
      };
      return answer;
    } finally { pg.close(); }
  },
};
