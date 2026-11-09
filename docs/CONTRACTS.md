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

openForEdit(bytes: Uint8Array): Promise<PdfEdit>     // refuses an encrypted file (pdf-lib cannot decrypt)
openEditable(bytes: Uint8Array, P: Pdfium): Promise<{ edit: PdfEdit; decrypted: boolean }>
     // openForEdit on any file PDFium opens without a password: a file encrypted with an owner password only is read
     // from PDFium's decrypted copy (decrypted: true); one that needs a user password throws PdfiumOpenError
     // (needsPassword). exportDoc edits the same copy and writes the output unencrypted, with a full save.
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

- `src/engine/view.ts`: `page.view: ViewBox` (`rotate`, `crop`, `media`, shown `w`/`h`); `toView`/`fromView`,
  `rectToView`/`rectFromView`, `rectToPixels` map user space onto the page as PDFium renders it (/Rotate, crop box).
  `diffOutside(a, b, regions, scale, view | pageH)` takes the view.
- `src/engine/pdfium.ts`: `page.objects(): EngineObject[]` (every object in paint order, forms entered, page-space
  bounds and quad, marks), `page.paintsAt(indices, x, y)` (the render hit test: does hiding the object change the
  pixel there).
- `src/objects/`: the page object model, read-only. `readObjects(edit, page, crop)` walks the content stream (forms
  entered) into `PageObject`s in paint order (`id` = content path and operator index, `bounds`, `ctm`, `clips`,
  `marked`, `group`, `children` for forms) and `Clip`s with their user counts; `pageObjects(edit, pdfPage)` matches
  them with `page.objects()`; `listObjects(bytes, pages?)`; `bin/pdfedit.ts objects`.
- `src/engine/pdfium.ts`: `page.shapes(): Shape[]` (paths, images, shadings: bounds in page space, fill, stroke,
  `isRect`, `isRule`, `pathSegs`, `z`); `Char.fontSize` is the effective size (Tf × text-matrix scale), `fontSizeRaw` PDFium's;
  `TextObj.z` paint order; `decryptCopy`, `repairCopy`, `security`, `PdfiumOpenError`.
- `src/layout/detect.ts`: `detectBoxes(page: PageInput, opts?) → Result` (types in `src/layout/types.ts`;
  thresholds in `DEFAULT_THRESHOLDS`).
- `src/model/`: `buildPage`/`buildPageFrom`/`readPage`/`buildDoc`, `loadFonts → FontRegistry`, `layoutBox`,
  `LayoutCache`, `Editor` (types in `src/model/types.ts`). `SourceState.objs` are indices into `page.textObjects()`
  (forms flattened). `Paragraph.src` (`SourceLines`, filled by build) is where the source drew each line; `layoutBox`
  keeps unchanged source lines there (src/text `layoutSourceLines`). `Editor.editText(page, box, texts)` is the
  editors' typing (a diff over the box's paragraph texts; a paragraph added or removed is one `'paras'` edit).
  `Box.hand` marks a box a person adjusted by hand: `setFrame`, `setHeightPinned` and `setStyle` set it (undo takes
  it back); text edits do not. `Editor.pageEdit(page, label, run, fields?)` is a change to the whole page as one undo
  step (every box and the named page fields snapshotted). Seams for optional modules: `addPageBuilder(fn)`
  (src/model/build.ts: more page data on every page built), `addBoxHooks({ split, merge })` (src/model/edit.ts),
  `addPageWriter(fn)` (src/export/export.ts: more changes written into an edited page, with their pixel regions),
  `addObjectOpSource({ wants, ops })` (src/export/objects.ts: object ops a module adds to a page at export, written
  in the same surgery as `Page.objectOps` and checked by the same verification; its report fields are its own).
  `loadFonts(sources, { catalog })` takes a catalogue source that may answer with a Promise.
  `src/model/caret.ts`: `caretLines`, `caretRect`, `hitTest`, `lineMove`, `lineEdge`, `selectionRects` from a
  `LaidBox` (glyph `c`/`p`, line `start`/`end`/`pEnd`).
- `web/textinput.ts`: `TextInput`, the selected box's text input shared by app/ and web/ (a hidden textarea; the caret
  and the selection drawn from the layout).
- `app/toolhost.ts`, `app/connector.ts`, `app/opshost.ts`: the editor's optional modules, loaded from folders when
  present: tools (`app/tools/*.ts`: toolbar groups, panel cards, page layers, marks on frames, preview underlays),
  a connector (`app/connectors/*.ts`: the document from and to a host application, edit gates) and worker ops
  (`app/ops/*.ts`, `ToolHost.callWorker(op, args)`). `web/toolhost.ts` does the same for `web/tools/*.ts`, and
  `bin/pdfedit.ts` loads `bin/commands/<name>.ts`.
- `src/export/export.ts`: `exportDoc(original, doc, laid, opts?) → { bytes, report }`, `verifyExport`.
- `src/export/replace.ts`: `replaceText(bytes, table, opts?) → { bytes, doc, replaced, overflow, substitutions, export,
  stats }` (exact paragraph replacements, headless; `bin/pdfedit.ts replace`). A longer text stays in its box and may
  overflow it.
- `src/fonts/`: `suggestSubstitutes(info) → Suggestion[]` (the font matcher), `CATALOG` (the open font families
  `scripts/fetch-fonts.ts` downloads), `prepareSubstitutes(doc, fonts)` (sets each document font's matched face).
