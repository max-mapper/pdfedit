# pdfedit

A PDF text editor that runs in the browser. PDFium, built to WebAssembly, reads and draws each page. pdfedit finds the paragraph boxes and lets you edit the text in each box. The text reflows inside its own box. It saves real, searchable text. Only the edited text is removed from the page, and the new text is added as a new layer.

**Demo:** https://max-mapper.github.io/pdfedit/ (open a PDF, double-click a paragraph, edit, export).

## Run

```bash
npm ci
npm run fonts        # default fonts into fonts/ (not committed)
npm test
npm run app:dev      # the editor at http://localhost:5181
```

## Command line

```bash
node bin/pdfedit.ts detect in.pdf --pages 1,3
node bin/pdfedit.ts replace in.pdf out.pdf --table pairs.json
```

`pairs.json` lists exact paragraph replacements: `{"old text": "new text"}`.

Node 24 runs the TypeScript directly. Module contracts are in `docs/CONTRACTS.md`.

## Licence

CC BY-SA 4.0 (see `LICENSE`). Commercial use is allowed with credit to pdfedit by max-mapper; changed versions are shared under the same licence.
