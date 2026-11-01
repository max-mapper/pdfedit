import { defineConfig } from 'vite';

// The standalone PDF editor (app/). PDFium runs in a module worker; its WASM, HarfBuzz's WASM and the Noto fonts are
// assets of this build, so the app needs nothing from another host. Build:
//   npx vite build app --config app/vite.config.ts --outDir ../dist-app --emptyOutDir
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  // Not pre-bundled: both find their WASM next to their own module file (new URL('…wasm', import.meta.url)), which a
  // pre-bundled copy in Vite's cache would break in dev (the server then answers the .wasm with index.html).
  optimizeDeps: { exclude: ['@embedpdf/pdfium', 'harfbuzzjs'] },
  server: { fs: { allow: ['..'] } },
});
