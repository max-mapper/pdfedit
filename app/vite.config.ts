import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { CATALOG } from '../src/fonts/catalog.ts';

// The standalone PDF editor (app/). PDFium runs in a module worker; its WASM, HarfBuzz's WASM and the Noto fonts are
// assets of this build, so the app needs nothing from another host. Build:
//   npx vite build app --config app/vite.config.ts --outDir ../dist-app --emptyOutDir

// Font files whose licence forbids renaming them (the IPA licence, Art. 3.2): emitted as assets/<file>, without the
// content hash Vite adds to other assets.
const KEEP_NAME = new Set(CATALOG.filter((f) => f.licence === 'IPA').flatMap((f) => f.files.map((x) => x.file)));
const assetFileNames = (a: { names?: string[] }): string =>
  (a.names?.some((n) => KEEP_NAME.has(n)) ? 'assets/[name][extname]' : 'assets/[name]-[hash][extname]');

// The licence of every catalogue family this build bundles (the core tier), as licenses/<id>.txt beside the files:
// the IPA licence requires its text with every copy, and OFL and Apache ask the same. scripts/fetch-fonts.ts wrote
// the texts to fonts/licenses/; a family whose files are not fetched is not bundled and needs none.
function catalogLicences(): Plugin {
  return {
    name: 'pdfedit-catalog-licences',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const bundled = new Set(Object.values(bundle).flatMap((a) => (a.type === 'asset' ? [...a.names, ...a.originalFileNames] : []))
        .map((n) => n.slice(n.lastIndexOf('/') + 1)));
      for (const f of CATALOG) {
        if (!f.files.some((x) => bundled.has(x.file))) continue;
        const src = resolve(import.meta.dirname, '../fonts/licenses', `${f.id}.txt`);
        if (!existsSync(src)) this.error(`${f.id} is bundled but fonts/licenses/${f.id}.txt is missing (run scripts/fetch-fonts.ts)`);
        this.emitFile({ type: 'asset', fileName: `licenses/${f.id}.txt`, source: readFileSync(src) });
      }
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [catalogLicences()],
  worker: { format: 'es', rollupOptions: { output: { assetFileNames } } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096, rollupOptions: { output: { assetFileNames } } },
  // Not pre-bundled: both find their WASM next to their own module file (new URL('…wasm', import.meta.url)), which a
  // pre-bundled copy in Vite's cache would break in dev (the server then answers the .wasm with index.html).
  optimizeDeps: { exclude: ['@embedpdf/pdfium', 'harfbuzzjs'] },
  server: { fs: { allow: ['..'] } },
});
