import { defineConfig } from 'vite';

// The smoke page: PDFium in a module worker, the WASM bundled as an asset of this build.
export default defineConfig({
  root: import.meta.dirname,
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // Not pre-bundled: both find their WASM next to their own module file (new URL('…wasm', import.meta.url)), which a
  // pre-bundled copy in Vite's cache would break in dev (the server then answers the .wasm with index.html).
  optimizeDeps: { exclude: ['@embedpdf/pdfium', 'harfbuzzjs'] },
  server: { fs: { allow: ['..'] } },
});
