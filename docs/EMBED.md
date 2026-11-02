# Embed mode

A host page can frame the editor app and give it one document through an HTTP API. The editor loads the PDF and a list of translation pairs, sets each pair's target text into the matching paragraph, and fits the page. People edit as usual. Save stores the edited boxes as a new version on the host. Export writes the PDF in the browser and sends it to the host.

A host that keeps segments can also take text edits: the editor links each paragraph to its segments once, stores the links on the host, and writes what is typed in a linked paragraph to the segment it was typed in. A host can also shorten text that does not fit.

## Build

```bash
node scripts/build-embed.mjs <outDir> [--base /pdf-editor/]
```

The base is the path the host serves the folder at. The default is `/pdf-editor/`. The bundle holds the editor, its worker, the PDFium and HarfBuzz WASM files and the three default fonts (Noto Sans Regular and Bold, Noto Sans JP). The substitution catalogue is not in it; the host serves those files. The output folder is emptied first, so it must be empty, absent or an earlier build. The script prints every file with its size. The build records the pdfedit commit (with `-dirty` when the tree has changes). It goes into saved states and export reports as `engine`.

## The frame URL

```
<base>index.html?doc=<id>&api=<api base>&fonts=<fonts base>&segments=<segment route base>&seglink=<link template>&seglabel=<label>
```

- `doc`: the host's document id. It is shown when the doc has no title.
- `api`: the base of the host API below, for example `/api/docs/<id>`.
- `fonts` (optional): where the catalogue files are, as `<fonts base>/<file>`. Without it the embed build sets new text in the three default fonts only.
- `segments` (optional): the base of the segment write route (`PATCH <segments>/<seg_id>`, below). There is no default. Without it, links still load and linked paragraphs show their segments' text, but linked text is read-only, and the panel says "the host gave no segments API".
- `seglink` (optional): a link to a segment in the host, as a template. The editor replaces every `{seg}` with the segment id, URL-encoded. The template must hold `{seg}`, and it must be a path starting with `/` or an absolute URL on the frame's own origin. Everything else in it is the host's choice. The links open in the top window (`target="_top"`). Without it, the panel names segments without links.
- `seglabel` (optional): the text of those links. The default is `Open segment`. When one row lists several segments, each link reads `<label> <seg_id>`.

Values are URL-encoded in the frame URL, so a template such as `/segments/view?seg={seg}` is passed as `seglink=%2Fsegments%2Fview%3Fseg%3D%7Bseg%7D`. A `segments` or `seglink` value that breaks these rules turns embed mode off, with the reason in the status bar.

`api`, `fonts` and `segments` must be on the frame's own origin. Requests carry the page's own cookies (`credentials: 'same-origin'`). Without `doc` and `api` the app is the standalone editor. `fonts` also works without them.

## Host API

Paths are relative to `api`. Errors are JSON: `{ "error": "<sentence>", "code": "<code>", ... }`. The editor shows `error` to the person.

### `GET <api>`

Returns `{ doc, versions, exports }`.

- `doc.head`: the latest version number. `0` (or absent) means no version is saved yet. Version 0 is the PDF as it is, with the translations from the pairs.
- `doc.title` (optional): shown in the toolbar and used for the download name.
- `doc.links` (optional): `null` when no links are stored yet, or any object when they are. When the field is absent, the host keeps no links: the editor neither links paragraphs nor writes to segments, and `/state`, `/links` and the segment route are not called.
- `doc.settings.shorten` (optional): `true` turns targeted shortening on (below). Off by default.
- `versions` and `exports` are not read by the editor.

### `GET <api>/source`

Returns the PDF bytes. The editor refuses a body without `%PDF-` in its first 1024 bytes.

### `GET <api>/pairs?limit=<n>&cursor=<c>`

Returns `{ pairs: [{ seg_id, source, target, confirmed }], next }`.

- The editor asks with `limit=500` and no cursor first. It then follows `next` until `next` is `null`, absent or empty, or repeats.
- Pairs are in document order. The order matters: a paragraph can match a run of consecutive pairs.
- `target` may be empty. An empty target is not a translation.
- `confirmed: false` is counted and shown. Unconfirmed targets are still used.

### `GET <api>/state?limit=<n>&cursor=<c>`

With links only. Returns `{ segments: [{ seg_id, version_id, text, marks, locked, confirmed, stale, editable, why_not }], next }`, paged like the pairs.

- `version_id`: the segment's current target version, or `null` when it has no target. Writes send it as `base_version_id`.
- `text`: the current target text. A linked paragraph shows it, also over a saved box (below).
- `marks`: the segment's formatting marks (`{ start, end, type, href? }`). Writes send them back as they are. A mark that would end past the new text is cut at its end. The editor does not write formatting.
- A segment takes typing when `editable` is not `false` and it is neither `locked` nor `confirmed`. `why_not` says why not (`locked`, `confirmed`, `not_translatable`, `file_not_open`, or a sentence). The editor shows it.
- A linked segment the list does not have (retired since) is read-only.

### `GET <api>/links`

With links only, when `doc.links` is set. Returns the blob the editor stored: `{ links_version: 1, engine, links: [{ page, box, para, seg_ids, src_sha }] }`.

### `POST <api>/links`

Body: `{ engine, links }` as JSON, sent once, when `doc.links` is `null`, after every page is read.

- `engine`: the pdfedit build that detected the boxes, 1 to 80 characters of `[A-Za-z0-9._:+-]` (`dev` for a build without a commit).
- `links`: one per linked paragraph. `page` is 0-based, `box` and `para` name the paragraph as this build detects the PDF, `seg_ids` lists its segments in order (one, or a run), and `src_sha` is the SHA-256 (hex) of the paragraph's source text, normalised as for matching.

Returns `{ doc }`. When links already exist, answer `409` with `code: "links_exist"` (same engine) or `"engine_mismatch"`. On `links_exist` the editor reads the stored links and uses those. On any other error it uses its own links for the session and posts again on the next load.

### `POST <api>/shorten`

Only when `doc.settings.shorten` is `true`. Body: `{ items: [{ seg_id, source, english, max_chars }] }`, at most 30 items per request. The editor sends more items as further requests.

- `seg_id`: the one segment the paragraph is linked to, or `null` (not linked, or a run of segments).
- `source`: the paragraph's source text. `english`: its translation. `max_chars`: the budget, from half to 0.95 of the translation's length.

Returns `{ items: [<text>] }`: one shorter text per item, in order. An item may also be `{ text }`. A text that is not shorter keeps the translation. Any error leaves the page with the faithful text and shows why.

### `PATCH <segments>/<seg_id>`

With links and the `segments` parameter only. Body: `{ text, marks, base_version_id }` as JSON: the segment's new target text, its marks (from `/state`) and the version the edit was made on.

Returns `{ version: { id } }`. The editor takes `version.id` as the segment's new version.

- `409` with `current: { id, text, marks }`: the segment changed elsewhere. The editor shows the current text in the paragraph and lists the text typed in the frame.
- `409` without `current` (locked, confirmed, not for translation): the editor puts the segment's text back and treats the segment as read-only from then on, with the answer's `error`.
- Any other error: the edit stays in the frame, marked as not written. The editor tries again on the next edit, on Save and on Export. Export stops while an edit is not written.

### `GET <api>/versions/<n>`

Returns `{ version, state }`. The editor asks for `n = doc.head` when it is above 0. `state` is what the editor saved (below).

### `POST <api>/versions`

Body: `{ base_n, state, summary }` as JSON.

- `base_n`: the version the edits were made on (the head the editor loaded or last saved).
- `state`: the saved state (below).
- `summary`: a short sentence, for example `"4 edited boxes on 2 pages"`. It holds no document text.

Returns `{ doc, version }`. The editor takes the new head from `doc.head`, else from `version.n`, else `base_n + 1`.

When `base_n` is not the head, answer `409` with `code: "head_moved"` and `head: <the current head>`. The editor then says that the document was saved elsewhere and offers a reload. It does not retry.

### `POST <api>/exports?n=<version>`

The body is the exported PDF (`Content-Type: application/pdf`). `n` is the version the export was made from. Before an export the editor saves unsaved edits, so `n` is always a saved version or 0.

The `X-Pdfedit-Report` header holds a JSON summary of the export. It is ASCII: other characters are `\u` escapes. It is at most 6000 characters; when lists are cut to fit, `truncated` is `true`.

```json
{
  "ok": true, "verified": true, "engine": "<pdfedit commit>",
  "written": 12, "pages": [0, 1],
  "skipped": [{ "page": 0, "box": "b7", "reason": "<sentence>" }],
  "fonts": [{ "face": "NotoSans-Regular", "font": "<face id>", "glyphs": 40, "bytes": 9000 }],
  "substitutions": [{ "font": "<PDF font name>", "script": "latn", "bold": false, "family": "Arimo", "face": "cat:Arimo-VF.ttf@wght=400", "match": "metric" }],
  "shortened": [], "failures": [], "bytesIn": 100000, "bytesOut": 140000
}
```

- `written`: boxes written. `pages`: 0-based pages with boxes written.
- `skipped`: boxes the export left as they were, and why.
- `fonts`: the fonts written into the file.
- `substitutions`: the catalogue face each document font of the edited text is set in.
- `shortened`: every paragraph that holds a shortened text, as `{ page, box, para, seg_id, chars_before, chars_after, max_chars, reason }` with `reason` `unfit` or `shrunk`. No text.
- `failures`: verification problems, as sentences.

Returns `{ export }`. The editor sends a file only when `ok` is `true`. When verification fails, it shows why and offers "Send anyway". A failed send offers "Try again".

### `GET <fonts>/<file>`

Returns a font file of the catalogue (`src/fonts/catalog.ts`). The editor asks only for the core tier, the same files the standalone build bundles. A file the host does not serve (any error status) is skipped, and the matcher takes its next choice. Files are fetched when a page needs them.

## Matching

Each paragraph of an editable box is compared with the pair sources. Texts are normalised first: NFKC, whitespace and format characters removed, CJK punctuation and dashes folded to one form, a leading list marker dropped.

1. A pair whose source equals the paragraph gives its target.
2. Otherwise, a run of two or more consecutive pairs whose sources together equal the paragraph gives their targets joined. Parts are joined with a space, except next to CJK text.
3. Otherwise the paragraph keeps its text. If it holds letters, it is listed as untranslated in the side panel. A click on an entry selects its box.

Duplicate sources (two pairs with the same source, or two runs that spell the same paragraph) are taken in reading order. Pages are matched in order, and each match takes the first candidate after where the last match ended. When no candidate comes after it, the match takes the first candidate not used yet. When every candidate is used, it takes the first.

A target equal to the source is not set. Locked boxes are skipped. Vertical boxes are translated (the layout sets Latin text sideways).

## Links

With links on, the pairs a paragraph matched (rule 1 or 2) are its link, even when their targets are empty. The first load posts the links. Every later load reads them and checks each one: the paragraph at `page`/`box`/`para` must have the source text whose hash the link records. A link that does not hold leaves the paragraph unmapped. It is then translated by the matcher as above, listed with its reason (`source_changed`, or `box_missing` when the box or paragraph is gone, also when a saved version merged the box away), and its text stays in the editor's versions.

A linked paragraph shows its segments' current text (`/state`), joined like a run of pairs. This applies on a fresh page and over a saved box: the saved box keeps its frame, sizes and styles, and only its text is replaced (runs keep their styles where the text is the same). An empty segment text leaves the paragraph as it is.

## Write-through

Write-through needs the `segments` parameter. Without it, every linked paragraph is read-only and the rest of this section does not apply.

Each segment owns a range of its linked paragraph's text: the whole text for one segment, or its part of the joined text for a run. The text between two parts (the space of the join) belongs to no segment. In edit mode the ranges are tinted, alternating, with a thin mark where one starts after another. A read-only range is hatched. The caret or the pointer in a range names its segment in the side panel, with the host's link to it (`seglink`). The tints are on the screen only, never in the export.

An edit is written to the segment it was typed in when the person finishes editing: when the text box closes (Escape, or another box is chosen), when the frame loses focus, on Save, and before an Export. Nothing is written while someone is still typing, so a half-made edit never reaches a segment. The status line counts the edits still to write. The write is `PATCH <segments>/<seg_id>` with the range's text (a list marker or spaces the segment has around it are kept), the segment's marks and its version. Undo and redo write too. An edit must stay inside one range:

- a selection that is replaced or deleted must lie inside one range;
- Backspace at the start of a range other than the first, and Delete at the end of a range other than the last, are refused;
- typing at a caret goes into the leftmost range the caret is in. At the end of a range it extends that range. Where two ranges touch (CJK, no space between) the caret is at the end of the left one, so typing there goes into the range on the caret's left. After the space of a join the caret is at the start of the right range;
- Enter, Shift+Enter and a paste with line breaks are refused in linked text.

A range whose segment is locked, confirmed or otherwise not editable is read-only, and the other ranges of the paragraph stay editable. A paragraph whose segments' texts cannot be found in it, or that holds a shortened text, is read-only as a whole.

Boxes with links keep their structure: split, merge, clearing the box, Enter, and joining two paragraphs (Backspace at a paragraph's start, Delete at its end) are refused, with the reason in the status bar. Unlinked paragraphs in such a box take typing as usual, and their text stays in the editor's versions.

## Shortening

With `doc.settings.shorten` on, each page whose translated boxes are fitted on load is shortened. Every box that ended unfit or under 80% of its size gives its translated paragraphs of 12 characters or more a budget. The budget is the share of the text that fitted at the scale reached, then the area ratio from that scale up to a readable size (0.85 when unfit, 0.9 when shrunk). It is at least half the length and at most 0.95 of it. The host shortens them (`POST <api>/shorten`). When a text comes back shorter, the page goes back to how it was before the fit, takes the shorter texts and is fitted again.

A shortened text is layout only. It is never written to a segment, and its paragraph is read-only while it shows the shortened text. The side panel lists each shortened paragraph with its faithful text and "Use faithful", which puts the faithful text back (the segment's current text when the paragraph is linked to one). A saved version lists its shortened paragraphs. On load a saved shortened paragraph keeps its text while its segments still have the text it was shortened from. Pages restored from a saved version are not shortened again.

## Saved state

A version's state holds only the edited boxes:

```json
{ "format": "pdfedit-state@1", "engine": "<pdfedit commit>",
  "pages": [{ "n": 0, "order": ["b0", "b1", "b1.1"], "boxes": [<Box>, …], "pictures": [{ "id": "pic0", "move": { "dx": 0, "dy": -12, "scale": 0.9 } }],
              "shortened": [{ "box": "b1", "para": 0, "seg_id": "s9", "before": "<faithful>", "after": "<shortened>", "max_chars": 120, "reason": "unfit" }] }] }
```

- `boxes` are pdfedit model boxes (`src/model/types.ts`): paragraphs, runs, frame and source.
- `order` is every box id of the page as saved. A box merged away is not in it.
- `pictures` lists the pictures the fitter moved.
- `shortened` lists the saved paragraphs that hold a shortened text.
- Pages without edits are left out.
- For linked paragraphs the state keeps the layout. Their text is not the record: on load the segments' current text replaces it.

On load the editor detects every page, translates it from the pairs, and then puts the saved boxes back by id. A box made by a split is put in again. The fit runs only on pages with translated boxes that the state does not cover. Saved boxes come back as they were saved. Detection is deterministic for one pdfedit build and one PDF, so the ids line up. A host should keep the build a document was saved with (`engine`).

## Behaviour in the frame

- The Open button and file drops are off.
- Save is enabled when there are unsaved edits. Ctrl+S saves.
- The page asks before it is left with unsaved edits or edits not yet written to segments.
- Export writes pending text edits to their segments, saves, then writes, verifies and sends the file. The download link still works.
- The side panel shows the selected box's paragraphs with their segments, each with its state and the host's link to it (`seglink`, target `_top`). It also lists the segment under the caret or the pointer, edits changed elsewhere (the text typed here and the current text), shortened paragraphs, read-only ranges and links that did not hold, and untranslated paragraphs.
