// Connectors: optional modules (app/connectors/*.ts, loaded by app/main.ts when present) that connect the editor to a
// host application. A connector that recognises the page URL takes over where the document comes from and where it
// goes (load, save, export), may supply every page's model itself, and may refuse edits with a reason. Without one the
// editor is the standalone one: it opens files from the user.
import type { Change, Editor } from '../src/model/edit.ts';
import type { FontRegistry } from '../src/model/fonts.ts';
import type { Box, Doc, LaidBox, Page } from '../src/model/types.ts';
import type { ExportReport } from '../src/export/export.ts';
import type { ToolHost } from './toolhost.ts';

/** An input as the text box would apply it: InputEvent.inputType, the text it inserts, the selection as offsets. */
export type BoxInput = { type: string; data: string | null; start: number; end: number };

/** What the editor gives a connector. */
export type ConnectorHost = {
  /** Opens a document as if the user had dropped it. */
  open(bytes: ArrayBuffer, name: string): void;
  fonts(): FontRegistry | null;
  doc(): Doc | null;
  editor(): Editor | null;
  /** A counter that grows with every edit. */
  version(): number;
  /** Scrolls to a box and selects it. */
  reveal(page: number, box: string): void;
  msg(text: string): void;
  /** The panels and the status line again. */
  refresh(): void;
  /** Installs page n's model (when the connector supplies pages): its frames are built, and edited boxes are committed
   *  once the page is on screen. */
  setPage(n: number, page: Page, stats: { detectMs: number; chars: number }): void;
  /** Shows another version of the document in the same views, read-only by the connector's gates (`pages`), or goes
   *  back to the live document (null). Each version keeps its own renders; the page and scroll position stay. */
  swapDocument(key: string, pages: Page[] | null): void;
  /** Ends text editing and drops the selection. */
  endEditing(): void;
  deselect(): void;
  /** The tool host (events, worker ops, panel slots). */
  tools: ToolHost;
};

export interface Connector {
  /** Why edits are refused right now (e.g. a read-only view), or null. */
  readonly readOnly: string | null;
  /** Whether Export may run now. */
  readonly canExport: boolean;
  /** True: the connector supplies every page's model (ConnectorHost.setPage); the editor does not detect pages itself. */
  readonly loadsPages: boolean;
  /** The editor is set up: build the connector's UI. */
  mount(): void;
  /** Load the document (the connector calls ConnectorHost.open). */
  load(): Promise<void>;
  /** The document is open with this many pages. */
  opened(pages: number): void;
  /** Gates: a reason to refuse, or null. */
  refuseText?(page: number, box: Box, texts: string[]): string | null;
  refuseInput?(page: number, box: Box, input: BoxInput): string | null;
  refuseStructure?(page: number, boxes: string[], what: 'split' | 'merge' | 'clear'): string | null;
  /** A title for the split and merge buttons when they are refused for this box, or null. */
  structureNote?(page: number, box: string): string | null;
  /** Events. */
  changed?(c: Change): void;
  selection?(page: number | null, box: string | null): void;
  editingEnded?(): void;
  /** Before an export: false cancels it. */
  beforeExport?(): Promise<boolean>;
  exported?(bytes: ArrayBuffer | null, report: ExportReport | null, error: string | null): void | Promise<void>;
  /** While a box is edited: draws into a layer over the text box (cleared by the connector). */
  decorate?(layer: HTMLElement, at: { page: number; box: Box; laid: LaidBox; zoom: number } | null): void;
  /** The pointer is over a text position of the edited box (off null: it left): a tooltip, or ''. */
  hover?(page: number, box: string, para: number, off: number | null): string;
  /** The caret moved to a text position. */
  caret?(page: number, box: string, para: number, off: number): void;
  /** Values for window.__app.connector (headless checks). */
  readonly debug?: unknown;
}

export type ConnectorModule = {
  /** A connector for this page URL, an error (the URL asks for one but is wrong), or null (not this connector's). */
  create(href: string, host: ConnectorHost): Connector | { error: string } | null;
};

/** The first connector present in this build that takes the page URL. */
export function loadConnector(href: string, host: ConnectorHost): { connector: Connector | null; error: string | null } {
  const mods = import.meta.glob<{ default: ConnectorModule }>('./connectors/*.ts', { eager: true });
  for (const key of Object.keys(mods).sort()) {
    const got = mods[key].default?.create(href, host);
    if (!got) continue;
    if ('error' in got) return { connector: null, error: got.error };
    return { connector: got, error: null };
  }
  return { connector: null, error: null };
}
