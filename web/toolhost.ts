// What an optional tool of the live editor (web/tools/*.ts, loaded by web/main.ts when present) is given: the editor,
// the page shown, the status line and the toolbar group to add its controls to. It may answer with hooks: something
// painted under the boxes, elements in the frame layer, and a listener for edits.
import type { Change, Editor } from '../src/model/edit.ts';
import type { Page, Rect } from '../src/model/types.ts';
import type { Underlay } from './preview.ts';

export type WebToolHost = {
  editor(): Editor | null;
  page(): Page | null;
  pageNo(): number;
  log(text: string): void;
  group: HTMLElement;
};
export type WebToolHooks = {
  underlay?(page: Page): Underlay | null;
  frames?(page: Page, add: (el: HTMLElement, r: Rect) => void): void;
  changed?(c: Change): void;
};
export type WebTool = (host: WebToolHost) => WebToolHooks | void;
