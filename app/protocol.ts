// Messages between the main thread (app/main.ts) and the PDFium worker (app/worker.ts).
import type { Doc, Page } from '../src/model/types.ts';
import type { ExportReport } from '../src/export/export.ts';

export type Source = 'orig' | 'commit';

export type Req =
  | { kind: 'open'; bytes: ArrayBuffer }
  /** Render page `n` at `scale` device pixels per point, from the original or from the page's committed export;
   *  `model: true` also reads the page, detects its boxes and sends the model page. */
  | { kind: 'render'; req: number; n: number; scale: number; source: Source; commitId?: number; model: boolean }
  | { kind: 'thumb'; n: number; scale: number; source: Source; commitId?: number }
  /** Background export of one page (the page's current model) and a render of the result. */
  | { kind: 'commit'; n: number; id: number; version: number; page: Page; scale: number }
  /** A newer edit on page `n`: queued commits of older versions are skipped. */
  | { kind: 'invalidate'; n: number; version: number }
  /** The final export of the whole document. */
  | { kind: 'export'; id: number; doc: Doc }
  /** Embed mode (app/embed.ts): read page `n`, detect its boxes and send the model page, without a render. */
  | { kind: 'model'; n: number }
  /** Embed mode: the substitution catalogue comes from the host, `<base>/<file>` (sent before 'open'). */
  | { kind: 'fonts'; base: string };

export type CommitResult = {
  kind: 'committed'; n: number; id: number; version: number;
  stale: boolean;                                  // skipped: a newer edit arrived first
  rgba?: ArrayBuffer; width?: number; height?: number; scale: number;
  written: string[];
  skipped: { box: string; reason: string }[];
  failures: string[];                              // verification failures and refusals, as sentences
  ms: number;
};

export type Res =
  | { kind: 'opened'; sizes: { w: number; h: number }[]; ms: number }
  | { kind: 'render'; req: number; n: number; scale: number; source: Source; commitId?: number; rgba: ArrayBuffer; width: number; height: number;
      page: Page | null; chars: number; objs: number; ms: number; detectMs: number }
  /** The committed export of the page is no longer held by the worker (evicted): commit again. */
  | { kind: 'render-missing'; req: number; n: number; commitId?: number }
  | { kind: 'thumb'; n: number; source: Source; rgba: ArrayBuffer; width: number; height: number }
  | CommitResult
  | { kind: 'exported'; id: number; bytes: ArrayBuffer | null; report: ExportReport | null; error: string | null }
  | { kind: 'model'; n: number; page: Page; chars: number; objs: number; detectMs: number }
  | { kind: 'error'; message: string; context: string };
