# pdfedit

A PDF text editor that runs in the browser. PDFium, built to WebAssembly, reads and draws each page. pdfedit finds the paragraph boxes, lets you edit the text, and fits longer text back into the design. It saves real, searchable text. Only the edited text is removed from the page, and the new text is added as a new layer.

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
node bin/pdfedit.ts translate-fit in.pdf out.pdf --pages 1 --translate-cmd "<cmd> [args]"
node bin/pdfedit.ts replace in.pdf out.pdf --table pairs.json
```

The translator command reads `{"pages": {"<n>": ["paragraph", …]}}` on stdin. It writes the same shape back with the translations.

Node 24 runs the TypeScript directly. Module contracts are in `docs/CONTRACTS.md`.

## Licence

CC BY-SA 4.0 (see `LICENSE`). Commercial use is allowed with credit to pdfedit by max-mapper; changed versions are shared under the same licence.
