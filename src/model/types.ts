// The editor's document model. Built from detection (src/layout) and the engine (src/engine); edited
// by the UI (app/, web/); written back by export (src/export). Units: PDF points, y up.
import type { Rect } from '../engine/pdfium.ts';
import type { ViewBox } from '../engine/view.ts';
import type { Face } from '../text/face.ts';
import type { ObjectOp } from '../objects/ops.ts';

export type { Rect, ViewBox };
export type RGB = [number, number, number];          // 0–1

/** A font a run is set in: the document's own embedded font (when it has the glyphs) or a shipped substitute. */
export type FontRef = {
  source: 'document' | 'shipped';
  name: string;            // the PDF BaseFont (document) or the shipped face id (e.g. 'NotoSans-Regular', 'NotoSansJP:700')
  bold: boolean; italic: boolean; serif: boolean;
  /** A shipped face standing in for a document font: that font's PDF name (src/fonts/apply.ts matches a closer
   *  catalogue face for it). Absent when the user picked the face. */
  from?: string;
};

export type Run = {
  text: string;
  font: FontRef;
  size: number;            // points
  color: RGB;
  charSpacing: number;     // points added after each glyph (PDF Tc); 0 for Latin text by default (the reset)
  bold: boolean; italic: boolean; underline: boolean;
};

export type Paragraph = {
  runs: Run[];
  align: 'left' | 'center' | 'right' | 'justify';
  leading: number;         // × size (1.2 = auto)
  spaceBefore: number; spaceAfter: number;   // points
  indent: number;          // first-line indent, points (negative = hanging); with a bullet: how far the first
                           // line's text starts right of the continuation lines (0 = the usual hanging item)
  bullet: string | null;   // the list marker, kept out of `runs` (src/model/build.ts) and drawn by the layout
  /** Optional (src/model/build.ts fills them for a bullet): the marker's own style, and the distance in points
   *  from the marker's left edge to the text start, measured from the source. Without bulletStyle the marker is
   *  drawn in the dominant run's style. */
  bulletStyle?: { font: FontRef; size: number; color: RGB };
  bulletIndent?: number;
  /** Optional: the paragraph starts this many points right of the box frame's left edge (every line, the marker
   *  included), measured from the source: a description indented under a bulleted title in the same box. */
  leftIndent?: number;
  /** Optional (src/model/build.ts fills it for horizontal paragraphs): where the source drew this paragraph's lines,
   *  for the keep-source-lines layout (src/model/layout.ts). Dropped when a style change makes it stale. */
  src?: SourceLines;
};

/**
 * Where the source drew a paragraph, line by line (page coordinates, points). Offsets index `text`, the paragraph
 * text as built (the runs joined; the bullet is not in it). While a paragraph's text and style are the source's, the
 * layout puts every glyph where the source put its character; once the text is edited, lines whose text is unchanged
 * keep their source breaks and positions, and the rest reflow in the source's measure with the source's advances.
 */
export type SourceLines = {
  text: string;
  starts: number[];            // per line: the offset its first character is at (starts[0] = 0)
  base: number[];              // per line: PDF y of its baseline
  ids: number[];               // per line: the page character index of its first character (unique on the page)
  prev: number[];              // per line: the id of the line before it in the source box (-1: the box's first line)
  end: number[];               // per line: PDF x of its last character's right edge
  hard: boolean[];             // per line: it ends well short of the measure (a deliberate break, kept on reflow)
  hyphen: (number | null)[];   // per line: PDF x of a line-end hyphen the text dropped (a word broken across lines)
  x: (number | null)[];        // per offset: PDF x of the character's origin (inserted spaces: the gap's start)
  adv: (number | null)[];      // per offset: its advance in the source (to the next character on the line), or null
  marker?: number[];           // PDF x of each code unit of the bullet (Paragraph.bullet)
  rise?: number[];             // per offset: the character's baseline above its line's (only when one is off it)
  /** Vertical text: lines are columns; `base` is each column's axis (PDF x), and `x` and `end` are positions down the
   *  column as -y (PDF y negated: a character's top; a column's last character's bottom), `adv` distances down it. */
  vertical?: boolean;
  size: number; leading: number; align: Paragraph['align']; indent: number;   // the style it was set in
};

/** What the box looked like before any edit. */
export interface SourceState {
  frame: Rect;             // the box as detected
  paragraphs: { text: string; size: number; align: string; leading: number }[];
  objs: number[];          // the page's text object indices that held this box's characters (export removes these)
  chars: number[];         // character indices
  /** Optional (src/model/build.ts fills them): */
  baseline?: number;       // distance from the source frame's top down to the first line's baseline, points
  charSpacing?: number;    // the source's measured character spacing (median over the box), points
  angle?: number;          // the source text's angle, degrees
  axis?: number;           // vertical boxes: distance from the source frame's right edge left to the first column's axis
}

export interface Box {
  id: string;
  kind: 'text' | 'cell' | 'label';
  frame: Rect;             // current frame (moved/resized by the user)
  rot: 0 | 90 | 180 | 270;
  vertical: boolean;
  paragraphs: Paragraph[];
  source: SourceState;
  edited: boolean;         // export rewrites only edited boxes
  locked: string | null;   // why it cannot be edited (vertical text in v1, Type 3, …), null when editable
  heightPinned: boolean;   // false: the height follows the text (vertical boxes: the width follows the text)
  /** Optional: a person adjusted the box's layout by hand (moved or resized it, or changed its font, size or style;
   *  src/model/edit.ts sets it, and a page edit may set it too). Text edits do not set it. Undo takes it back. */
  hand?: boolean;
  /** Optional (src/model/build.ts fills it): the layout direction. 'vertical-rl' (vertical: true): columns top to
   *  bottom, stacked right to left from the frame's right edge; the frame's height is the column length. */
  writingMode?: 'horizontal-tb' | 'vertical-rl';
}

export interface Page {
  n: number;               // 0-based
  w: number; h: number;    // the page as shown: its crop box, turned by /Rotate (src/engine/view.ts)
  boxes: Box[];
  /** Optional (src/model/build.ts fills it): how PDF user space maps onto the page as shown (rotation, crop box).
   *  Absent: no rotation and a crop box at the origin, so user space is the shown page. */
  view?: ViewBox;
  /** Optional: edits to the page's objects (move, resize, turn, delete, …; src/objects/ops.ts), in order, recorded
   *  against the source file's object ids. Export writes them by surgery (src/export/objects.ts). */
  objectOps?: ObjectOp[];
}

export type Doc = { pages: Page[]; title?: string };

/** One edit, for undo/redo. */
export type Edit =
  | { kind: 'text'; page: number; box: string; para: number; runs: Run[]; before: Run[]; wasEdited?: boolean }
  | { kind: 'style'; page: number; box: string; para: number | null; patch: Partial<Run> & Partial<Pick<Paragraph, 'align' | 'leading' | 'indent'>>; before: unknown; wasEdited?: boolean; wasHand?: boolean }
  | { kind: 'paras'; page: number; box: string; before: Paragraph[]; after: Paragraph[]; wasEdited?: boolean /* paragraphs added or removed */ }
  | { kind: 'frame'; page: number; box: string; frame: Rect; before: Rect; wasEdited?: boolean; wasHand?: boolean;
      pinned?: boolean; pinnedBefore?: boolean /* heightPinned after / before */ }
  | { kind: 'split' | 'merge' | 'page'; page: number; boxes: string[]; before: Box[];
      after?: Box[]; order?: string[]; orderAfter?: string[] /* page box ids before / after, for undo and redo */;
      /** 'page' (Editor.pageEdit): what the step was, and other page fields it changed, before and after. */
      label?: string; fieldsBefore?: Record<string, unknown>; fieldsAfter?: Record<string, unknown> };

/** A laid-out box: what the preview draws and export writes. Produced by src/model/layout.ts from a Box. */
export type LaidBox = {
  box: string;
  frame: Rect;             // the box frame actually used (height grown to the text unless pinned)
  height: number;          // the text's height
  overflow: boolean;       // the text does not fit the frame (pinned height or a word wider than the box)
  // x: PDF x of the frame's left edge; a glyph's x is relative to it, its y is an offset above the baseline (points)
  // c: the glyph's cluster offset in its paragraph's text (-1: drawn, not text: a marker or an inserted hyphen);
  // p: the pen position before it along the line (x like a glyph's x; vertical boxes: distance down the column)
  lines: { baseline: number /* PDF y */; x: number; runs: { font: FontRef; size: number; color: RGB; glyphs: { gid: number; x: number; y: number; text: string; c?: number; p?: number }[];
    face?: Face /* the shaped face (src/model/layout.ts sets it): what export subsets and the preview draws */
    /** Vertical boxes: upright glyphs (face is a src/text verticalFace() view, written with an Identity-V font) or
     *  sideways (a sidewaysFace() view: rotated 90° clockwise, horizontal font). */
    orientation?: 'upright' | 'sideways' }[];
    /** Vertical boxes: PDF x of the column's axis. */
    axis?: number;
    /** Horizontal boxes (src/model/layout.ts): the paragraph index, the alignment its lines were set with, and
     *  whether the line ends in an inserted hyphen. */
    para?: number; alignUsed?: 'left' | 'center' | 'right' | 'justify'; hyphen?: boolean;
    /** The line's text range in its paragraph [start, end) (trailing spaces and the break included), the pen
     *  position after its last drawn glyph (as glyph p), and whether it is a source line kept as the source drew it. */
    start?: number; end?: number; pEnd?: number; kept?: boolean }[];
  /** Optional (src/model/layout.ts, horizontal boxes): per paragraph, what the layout did with it. */
  paragraphs?: { alignUsed: 'left' | 'center' | 'right' | 'justify'; lines: number; hyphenated: number; balanced: boolean;
    widowFixed: boolean }[];
  /** Optional (src/model/layout.ts fills it): PDF y of the top of the first line box (CSS model: half-leading
   *  above the ascent), where an HTML text input with the same font, size and line-height starts. */
  textTop?: number;
  /** Vertical boxes (src/model/layout.ts): true. Then `lines` are columns (right to left), each line's `baseline`
   *  is the frame's top and each glyph's x, y its horizontal origin (y negative, down the column); `height` is the
   *  longest column, `width` the column stack, and the frame's width follows the stack (leftwards from its right
   *  edge) unless the height is pinned. */
  vertical?: boolean;
  width?: number;
};
