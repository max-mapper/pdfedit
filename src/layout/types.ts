// Box detection: the input is what src/engine reads from a page; the output is the editor's boxes.
// Units: PDF points, origin bottom-left, y up (the engine's space). A Rect is { x0, y0, x1, y1 } with y1 the top.
import type { Char, TextObj, Shape, Rect } from '../engine/pdfium.ts';

export type { Char, TextObj, Shape, Rect };

export type PageInput = {
  w: number; h: number;
  chars: Char[];            // page.chars(): content order, each with its text object index (`obj`)
  textObjects: TextObj[];   // page.textObjects()
  shapes: Shape[];          // page.shapes()
};

export type Word = { chars: number[]; text: string; box: Rect };

export type Line = {
  chars: number[];          // indices into PageInput.chars, in reading order along the line
  words: Word[];
  text: string;             // with spaces where the gaps are word gaps (and none between CJK characters)
  box: Rect;
  baseline: number;         // y of the baseline (horizontal lines), x of the centre axis (vertical lines)
  size: number;             // dominant font size in points (Char.fontSize)
  vertical: boolean;
  angle: number;            // degrees, 0 = horizontal left to right
};

export type Paragraph = {
  lines: number[];          // indices into Result.lines
  text: string;             // lines joined: a space between Latin lines, nothing between CJK lines, '\n' never
  box: Rect;
  align: 'left' | 'center' | 'right' | 'justify';
  size: number;
  leading: number;          // baseline-to-baseline distance in points (0 for one line)
  indent: number;           // first-line indent relative to the other lines, points
  bullet: string | null;    // a leading list marker ('•', '・', '①', '1.', '(1)', …) when the paragraph is a list item
};

export type Box = {
  id: string;               // stable within one result: 'b<order>'
  kind: 'text' | 'cell' | 'label';
  frame: Rect;              // the union of the box's lines, padded by nothing (insets are the editor's business)
  paragraphs: number[];     // indices into Result.paragraphs
  text: string;             // paragraphs joined with '\n'
  objs: number[];           // text object indices whose characters are in this box (sorted, unique)
  chars: number[];          // character indices (sorted)
  vertical: boolean;
  angle: number;
  order: number;            // reading order on the page, 0-based
  panel: number | null;     // index into Result.panels of the innermost panel the box lies in
  table: number | null;     // index into Result.tables when kind = 'cell'
};

export type Panel = { shape: number; frame: Rect; fill: [number, number, number, number] | null; boxes: string[] };
export type Table = { frame: Rect; rows: number; cols: number; cells: string[] /* box ids, row-major */ };

export type Skipped = { reason: 'type3' | 'generated' | 'invisible' | 'rotated-unsupported' | 'empty'; chars: number[] };

export type Result = {
  lines: Line[];
  paragraphs: Paragraph[];
  boxes: Box[];             // in reading order
  panels: Panel[];
  tables: Table[];
  skipped: Skipped[];
  ms: number;               // detection time
  /** With opts.debug: the rule pieces and panel candidates (shape indices) the detector used. */
  debug?: { rules: Rect[]; panelCandidates: number[]; gutterSplits: number };
};

export type DetectOptions = {
  /** Debug: keep intermediate structures (Result.debug). */
  debug?: boolean;
  /** Overrides for the detection thresholds; defaults in detect.ts DEFAULT_THRESHOLDS. */
  thresholds?: Partial<Thresholds>;
};

/** Every tunable number of the detector. `em` is the font size of the characters or lines being compared. */
export type Thresholds = {
  /** Characters on one line agree in baseline within this × size. */
  baselineTol: number;
  /** A gap along a line larger than this many em starts a new piece of the line (columns, table cells). */
  lineGap: number;
  /** A gap of at least this many em inside a line is a column-gutter candidate; it splits the line when the
   *  lines around it (gutterWindow × size above and below) mostly leave the same place empty. */
  gutterGap: number;
  gutterWindow: number;
  /** Latin: a gap wider than this many em (plus the line's median letter gap) is a word break. */
  wordGap: number;
  /** Next to a CJK character only a real space character, or a gap wider than this many em, becomes a space. */
  cjkSpaceGap: number;
  /** Vertical CJK: consecutive characters stack when the baseline step is within [min, max] em and their
   *  centres agree within verticalAxisTol em. */
  verticalStepMin: number;
  verticalStepMax: number;
  verticalAxisTol: number;
  /** Lines (and boxes) of one paragraph agree in size within this fraction. */
  sizeTol: number;
  /** A baseline step larger than this × size starts a new paragraph. */
  paraStep: number;
  /** … unless the two lines have the same size (within 3%) and weight: then up to this × size (wide-leading body
   *  text, common in reports set at 2× leading). */
  paraStepWide: number;
  /** In a paragraph of two or more lines, a step larger than the median leading + this × size starts a new one. */
  leadingJump: number;
  /** Left, right or centre edges agree within this many em when lines are grouped. */
  alignTol: number;
  /** Edges agree within max(alignStrictPt, alignStrict em) when a paragraph's alignment is classified. */
  alignStrict: number;
  alignStrictPt: number;
  /** A first-line indent or hanging indent of at most this many em keeps the lines together. */
  maxIndent: number;
  /** A line ending more than this many em before the paragraph's right edge is short. */
  shortLine: number;
  /** Paragraphs share a column when both edges agree within this many em (or one lies inside the other). */
  columnTol: number;
  /** Paragraphs merge into one box when the gap between them is under this × line height (1.2 × size). */
  boxGap: number;
  /** A line belongs to a panel when it lies inside it within this many points. */
  panelTol: number;
  /** A panel is larger than a text line: at least panelMinArea × the line's area and panelMinHeight × its height. */
  panelMinArea: number;
  panelMinHeight: number;
  /** Labels: at most this many words or CJK characters on one line … */
  labelWords: number;
  labelCjk: number;
  /** … inside a filled shape no taller than labelPanelHeight × line height, or within labelNear em of a picture. */
  labelPanelHeight: number;
  labelNear: number;
  /** XY-cut: the narrowest whitespace gap (points) a cut is made at, across (x) and down (y). */
  cutGapX: number;
  cutGapY: number;
};
