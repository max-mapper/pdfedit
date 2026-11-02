# Module contracts

The source folders compose through these exports. Units: PDF user space (points,
origin bottom-left, y up) unless a field says otherwise. All functions are synchronous unless they return a Promise.

## `src/engine/` — PDFium (reading and rendering only)

```ts
openPdfium(): Promise<Pdfium>                       // loads the WASM once (Node: from node_modules; browser: URL)
pdfium.open(bytes: Uint8Array): PdfDoc
doc.pageCount: number
doc.page(i: number): PdfPage                         // 0-based
page.size: { w: number; h: number }
page.chars(): Char[]                                 // every character PDFium reports, in content order
page.textObjects(): TextObj[]                        // the page's text objects in content order, forms flattened
                                                     // with `inForm: true`; `index` = order among top-level text objects
page.render(scale: number): { width; height; rgba: Uint8ClampedArray }
page.close(); doc.close()

type Char = { i: number; unicode: string; box: Rect; loose: Rect; origin: [x, y]; fontSize: number;
              fontName: string; fontFlags: number; weight: number; fill: [r, g, b, a]; angle: number;
              generated: boolean; obj: number /* index into page.textObjects() */ };
type TextObj = { index: number; topIndex: number | null; inForm: boolean; bounds: Rect; matrix: number[];
                 fontName: string; embedded: boolean; fontSize: number; text: string; chars: number[] };
type Rect = { x0: number; y0: number; x1: number; y1: number };
```

## `src/pdf/` — content streams, surgery, saving

```ts
tokenize(bytes: Uint8Array): Token[]
parseOps(bytes: Uint8Array): Op[]
type Op = { op: string; operands: Token[]; start: number; end: number }     // byte range of operands + operator
textShows(ops: Op[]): TextShow[]                    // every Tj, TJ, ' and " in order, with the text state at that point
type TextShow = { n: number; opIndex: number; op: 'Tj' | 'TJ' | "'" | '"'; font: string /* resource name */;
                  fontSize: number; charSpacing: number; wordSpacing: number; hScale: number;
                  strings: Uint8Array[]; start: number; end: number; inBT: boolean };

openForEdit(bytes: Uint8Array): Promise<PdfEdit>
edit.pageCount: number
edit.contents(page: number): Uint8Array             // the page's content streams, decoded and concatenated
edit.fontInfo(page: number, resourceName: string): FontInfo   // codes → widths, for advances
type FontInfo = { type: string; baseFont: string; codeBytes: 1 | 2 | 0 /* 0 = other CMap, unsupported */;
                  width(code: number): number /* glyph space, 1000 = 1 em */; vertical: boolean };
blankOut(contents: Uint8Array, shows: TextShow[], fonts: (name: string) => FontInfo): Uint8Array
     // each listed text-showing operator is replaced by a no-glyph equivalent that moves the text position by
     // exactly the same amount ([-n] TJ; T* first for ', Tw Tc T* first for "), so later text stays put;
     // every other byte is unchanged
edit.setContents(page: number, contents: Uint8Array): void   // the page's /Contents becomes one new stream
edit.appendContent(page: number, content: Uint8Array, fonts: Record<string, PDFRef>): void
     // a new stream appended to /Contents, wrapped in q…Q by the caller; fonts added under the given names
     // to a copy of the page's resources
edit.context: PDFContext                            // pdf-lib context, for src/text to register font objects
edit.save(opts?: { incremental?: boolean }): Uint8Array      // incremental by default: original bytes + appended
                                                    // objects + xref (table or stream, matching the original) + trailer
```

## `src/text/` — shaping, fonts, layout, emitting

```ts
loadHarfBuzz(): Promise<void>
loadFace(bytes: Uint8Array, opts?: { variations?: Record<string, number> }): Face
type Face = { upem: number; ascent; descent; capHeight; italicAngle; bbox: [n, n, n, n]; familyName: string;
              hasGlyph(cp: number): boolean };
shape(face: Face, text: string, opts?: { features?: string[] }): Glyph[]
type Glyph = { gid: number; cluster: number; ax: number; ay: number; dx: number; dy: number }  // font units

layoutParagraphs(paras: ParaIn[], box: { width: number }, opts?): Layout
type ParaIn = { runs: { text: string; face: Face; size: number; charSpacing?: number; color?: [r, g, b] }[];
                align?: 'left' | 'center' | 'right' | 'justify'; leading?: number /* × size, default 1.2 */ };
type Layout = { lines: Line[]; height: number; width: number; overflow: boolean };
type Line = { baseline: number /* from the box top, down positive */; width: number;
              runs: { face: Face; size: number; color; glyphs: { gid; x; y; text: string }[] }[] };

class FontWriter {                                  // one per document: collects glyphs, subsets once, writes Type0
  constructor(context: PDFContext)
  use(face: Face, glyphs: { gid: number; text: string }[]): string    // returns the font key to put in resources
  finish(): Record<string, PDFRef>                  // subsets (retain-gids, pinned axes), writes FontFile2,
}                                                   // FontDescriptor, CIDFontType2 (/W, CIDToGIDMap Identity),
                                                    // Type0 (Identity-H) and ToUnicode; key → font dict ref
emit(layout: Layout, at: { x: number; yTop: number }, fontKey: (face: Face) => string): Uint8Array
     // q BT … ET Q with Tf, rg, Tm per line and [<gids> adj …] TJ that lands every glyph at its laid-out x
```

## Other modules

The source files' header comments are authoritative; this is the map.

- `src/engine/pdfium.ts`: `page.shapes(): Shape[]` (paths, images, shadings: bounds in page space, fill, stroke,
  `isRect`, `isRule`, `z`); `Char.fontSize` is the effective size (Tf × text-matrix scale), `fontSizeRaw` PDFium's;
  `TextObj.z` paint order; `decryptCopy`, `repairCopy`, `security`, `PdfiumOpenError`.
- `src/layout/detect.ts`: `detectBoxes(page: PageInput, opts?) → Result` (types in `src/layout/types.ts`;
  thresholds in `DEFAULT_THRESHOLDS`).
- `src/model/`: `buildPage`/`buildPageFrom`/`readPage`/`buildDoc`, `loadFonts → FontRegistry`, `layoutBox`,
  `LayoutCache`, `Editor` (types in `src/model/types.ts`). `SourceState.objs` are indices into `page.textObjects()`
  (forms flattened). `Paragraph.src` (`SourceLines`, filled by build) is where the source drew each line; `layoutBox`
  keeps unchanged source lines there (src/text `layoutSourceLines`). `Editor.editText(page, box, texts)` is the
  editors' typing (a diff over the box's paragraph texts; a paragraph added or removed is one `'paras'` edit).
  `src/model/caret.ts`: `caretLines`, `caretRect`, `hitTest`, `lineMove`, `lineEdge`, `selectionRects` from a
  `LaidBox` (glyph `c`/`p`, line `start`/`end`/`pEnd`).
- `web/textinput.ts`: `TextInput`, the selected box's text input shared by app/ and web/ (a hidden textarea; the caret
  and the selection drawn from the layout).
- `src/fit/fit.ts`: `fitPage(page, lay, opts?) → FitReport`.
- `src/export/export.ts`: `exportDoc(original, doc, laid, opts?) → { bytes, report }`, `verifyExport`.
- `src/pipeline.ts`: `translateAndFit(bytes, opts) → { bytes, doc, fit, shortened, substitutions, export, stats }`,
  `commandTranslator`, `tableTranslator`, `commandShortener` (opt-in targeted shortening of unfit boxes).
- `src/fonts/`: `suggestSubstitutes(info) → Suggestion[]` (the font matcher), `CATALOG` (the open font families
  `scripts/fetch-fonts.ts` downloads), `prepareSubstitutes(doc, fonts)` (sets each document font's matched face).
- `src/embed/`: `matchPairs(paragraphs, pairs) → { translations, used, unmatched }` and `createMatcher(pairs)` (paragraphs
  to translation pairs by normalised source text), `serialiseState(doc)` / `parseState` / `applyState(doc, state)` (a
  saved version: the edited boxes by page), `preparePage(editor, n, matcher, pageState)` (translate, saved boxes back,
  fit), `hostReport` / `encodeReportHeader` / `substitutionsOf` (the export summary a host receives),
  `segLinkTemplate(value, href)` / `segLinkFor(template, seg)` (the host's link to a segment). Used by the app's
  embed mode (`app/embed.ts`, `docs/EMBED.md`).
