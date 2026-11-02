// Tools: optional modules of the editor (app/tools/*.ts, loaded by app/main.ts when present). A tool builds its own
// DOM in the slots the host gives it (a toolbar group, a side-panel card, a layer over each page), reads the model,
// edits through the Editor, calls worker ops (app/ops/*.ts) and adds marks to box frames. Tools with stage 'labs' load
// only with ?labs in the page URL; tools with connector: false load only in the standalone editor.
import type { Change, Editor } from '../src/model/edit.ts';
import type { Box, Doc, LaidBox, Page, Rect } from '../src/model/types.ts';
import type { ExportReport, PageReport } from '../src/export/export.ts';
import type { Underlay } from '../web/preview.ts';
import type { History } from './history.ts';
import type { Connector } from './connector.ts';

/** A mark a tool puts on a box's frame: a class on the frame, a badge, and a line for the box info. */
export type BoxNote = { cls?: string; badge?: string; info?: string };

export type ToolHost = {
  doc(): Doc | null;
  editor(): Editor | null;
  history(): History | null;
  /** The laid-out box (the layout the preview draws and export writes). */
  laid(page: number, box: Box): LaidBox;
  selected(): { page: number; id: string } | null;
  /** The page in view. */
  current(): number;
  select(page: number, id: string): boolean;
  scrollToPage(n: number): void;
  msg(text: string): void;
  /** Ends text editing, as leaving the box does. */
  endEditing(): void;
  /** Clears the text box selection (ends editing first). */
  deselect(): void;
  /** Why edits are refused now (a connector's read-only view), shown in the status line; null when allowed. */
  refused(): string | null;
  /** A group in the top bar, before the export controls. */
  toolbar(el: HTMLElement): void;
  /** A card in the side panel, before the export report. */
  panel(el: HTMLElement): void;
  /** The tool's layer over page n's frames (created on first use; null before the document is open). */
  pageLayer(n: number): HTMLDivElement | null;
  /** A user-space rectangle as percentages of page n's shown box, for placing elements in its layer. */
  placePct(el: HTMLElement, n: number, r: Rect): void;
  /** A client point as user-space coordinates of page n (null when page n has no view). */
  fromClient(n: number, clientX: number, clientY: number): { x: number; y: number } | null;
  /** Page n's frames and marks again (after a tool's notes changed). */
  refreshPage(n: number): void;
  /** The panels and the status line again. */
  refresh(): void;
  /** A worker op (app/ops/*.ts), answered in order with other requests. */
  callWorker<T = unknown>(op: string, args?: unknown): Promise<T>;
  /** Events between tools and the connector (`on` returns the unsubscribe). */
  on(event: string, fn: (data: unknown) => void): () => void;
  emit(event: string, data?: unknown): void;
  readonly connector: Connector | null;
  readonly labs: boolean;
};

export type ToolHooks = {
  /** A mark for a box's frame, or null. */
  boxNote?(page: number, id: string): BoxNote | null;
  /** Extra elements in page n's frame layer (rebuilt with the frames). */
  frames?(n: number, page: Page, add: (el: HTMLElement, r: Rect) => void): void;
  /** Paints under the boxes on page n's preview while it shows the original render. */
  underlay?(n: number): Underlay | null;
  /** Lines the tool adds to a page's export report: a note after the summary, and problems. */
  exportNotes?(p: PageReport): { note?: string; problems?: string[] } | null;
  /** A new document is open (its page count), or the editor was reset (0). */
  opened?(pages: number): void;
  changed?(c: Change): void;
  /** The selection, the current page or the edits changed: refresh controls. */
  updated?(): void;
  exported?(report: ExportReport | null): void;
  /** Page n's commit (its current model exported and rendered in the worker) came back: the object edits it refused,
   *  whether the page shows its render, and how long the worker took (ms). */
  committed?(n: number, r: { objectsSkipped: { id: string; reason: string }[]; shown: boolean; ms: number }): void;
  /**
   * A press of the primary button on page n at user-space point `at`, before the editor's own handling: `on` says
   * whether it is on a text box's frame (its id), on the selected box (`editbox`) or on one of its handles. True when
   * the tool takes it (the editor then does nothing with it); the first tool to take it ends the event.
   */
  pointerdown?(e: PointerEvent, n: number, at: { x: number; y: number }, on: { frame: string | null; editbox: boolean; handle: boolean }): boolean;
  /** A key the editor did not handle; true when the tool handled it. */
  keydown?(e: KeyboardEvent): boolean;
  /** Files dropped on the window that hold no PDF; true when the tool took them. */
  drop?(e: DragEvent): boolean;
  /** Values for window.__app.tools[id] (headless checks). */
  debug?: Record<string, unknown>;
};

export type Tool = {
  id: string;
  /** 'labs': shown only with ?labs in the page URL. Default 'on'. */
  stage?: 'labs' | 'on';
  /** false: not loaded when a connector runs the editor. Default true. */
  connector?: boolean;
  /** Load order (lower first), then id. */
  order?: number;
  setup(host: ToolHost): ToolHooks | void;
};

/** The tools present in this build that apply: stage, connector, then order and id. */
export function availableTools(opts: { labs: boolean; connector: boolean }): Tool[] {
  const mods = import.meta.glob<{ default: Tool }>('./tools/*.ts', { eager: true });
  return Object.values(mods).map((m) => m.default).filter((t) => !!t && (t.stage !== 'labs' || opts.labs) && (t.connector !== false || !opts.connector))
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}
