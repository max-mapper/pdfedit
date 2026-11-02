import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// The standalone PDF editor (app/). PDFium runs in a module worker; its WASM, HarfBuzz's WASM and the Noto fonts are
// assets of this build, so the app needs nothing from another host. Build:
//   npx vite build app --config app/vite.config.ts --outDir ../dist-app --emptyOutDir
// Mode 'embed' (scripts/build-embed.mjs) leaves the substitution catalogue out of the bundle: app/catalog-assets.ts
// resolves to app/catalog-none.ts, in the page and in the worker, and the host serves the files (docs/EMBED.md).
function noCatalog(): Plugin {
  const none = resolve(import.meta.dirname, 'catalog-none.ts');
  return {
    name: 'pdfedit-embed-no-catalog',
    enforce: 'pre',
    resolveId(source) { return /(^|\/)catalog-assets\.ts$/.test(source) ? none : null; },
  };
}

export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  base: './',
  plugins: mode === 'embed' ? [noCatalog()] : [],
  worker: { format: 'es' as const, plugins: () => (mode === 'embed' ? [noCatalog()] : []) },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  // Not pre-bundled: both find their WASM next to their own module file (new URL('…wasm', import.meta.url)), which a
  // pre-bundled copy in Vite's cache would break in dev (the server then answers the .wasm with index.html).
  optimizeDeps: { exclude: ['@embedpdf/pdfium', 'harfbuzzjs'] },
  server: { fs: { allow: ['..'] } },
}));
