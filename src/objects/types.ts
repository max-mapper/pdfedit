// The page object model: everything a page paints, in paint order (later on top), read from the content stream with
// every form XObject entered (src/objects/read.ts) and checked against PDFium's own object list (src/objects/list.ts).
// Read-only: nothing here changes a page. Units: user space (PDF points, y up), as the rest of the editor.
import type { Rect } from '../engine/pdfium.ts';
import type { ViewBox } from '../engine/view.ts';
import type { M6 } from '../pdf/ops.ts';

export type ObjectKind = 'text' | 'image' | 'inline-image' | 'path' | 'shading' | 'form';

/**
 * A clip in force: a clipping path (W or W* with its painting operator), a form XObject's /BBox, or a text clip
 * (text render modes 4–7). Objects name the clips they are painted under; `users` counts them, so a clip shared by
 * several objects can be told from a clip of one object's own.
 */
export type Clip = {
  id: string;               // the content path and operator index of the operator that sets it ('bbox' for a form's box)
  kind: 'path' | 'bbox' | 'text';
  bounds: Rect;             // page space
  rect: boolean;            // an axis-aligned rectangle in page space
  evenOdd: boolean;         // W* (even-odd rule)
  users: number;            // objects painted under it
};

export type PageObject = {
  /** Stable for a given file: the content path (the Do operator indices from the page's stream down to the stream that
   *  paints it, '/'-joined) and the operator index in that stream, e.g. "12" or "4/7". */
  id: string;
  kind: ObjectKind;
  z: number;                // paint order on the page, 0 first; a form comes before its contents
  path: number[];           // Do operator indices from the page's stream to the object's stream
  ops: [number, number];    // operator range in its stream (a path: its first construction operator to its painting one)
  parent: string | null;    // the form it is inside
  bounds: Rect;             // page space, after the CTM (paths: control points, widened by half the line width when stroked)
  ctm: M6;                  // the page-space matrix in force where it is painted (images: the unit square's)
  clips: string[];          // ids of the clips in force, outermost first
  marked: { tag: string; mcid?: number }[];   // marked-content sequences around it, outermost first
  /** The q … Q pair around it that paints nothing else (operator indices in its stream), or null. */
  group: [number, number] | null;
  name?: string;            // the XObject or shading resource name
  ref?: string;             // the XObject's object number and generation ("12 0")
  uses?: number;            // XObjects: how many times the document paints it
  paint?: string;           // paths: the painting operator (f, S, B*, …)
  pathSegs?: number;        // paths: construction operators (m, l, c, v, y, re, h)
  pixels?: [number, number];   // images: width and height in samples
  smask?: boolean;          // images: a soft mask (/SMask) or a mask
  chars?: number;           // text: characters shown (no text is kept)
  children?: string[];      // forms: the objects painted inside, in order
  /** The matching PDFium object (EngineObject.index), when the content-stream object was found in PDFium's list. */
  engine?: number;
};

export type PageObjects = {
  page: number;
  view: ViewBox;
  objects: PageObject[];
  clips: Clip[];
  /** What could not be read or matched, as sentences. */
  notes: string[];
};
