// The files the app ships with (Vite `?url` imports, so they are assets of this build and load from its own origin):
// the shipped OFL faces, hb-subset's WASM and the fonts' licence. Imported by the main thread and by the worker.
import sansUrl from '../fonts/NotoSans-Regular.ttf?url';
import sansBoldUrl from '../fonts/NotoSans-Bold.ttf?url';
import jpUrl from '../fonts/NotoSansJP-VF.ttf?url';
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import oflUrl from '../fonts/OFL.txt?url';
import { CATALOG } from '../src/fonts/catalog.ts';
import { loadFonts, type FontRegistry } from '../src/model/fonts.ts';
import BUNDLED from './catalog-assets.ts';

export const FONT_URLS = { 'NotoSans-Regular.ttf': sansUrl, 'NotoSans-Bold.ttf': sansBoldUrl, 'NotoSansJP-VF.ttf': jpUrl } as const;

// The substitution catalogue: by default the core tier bundled with this build (app/catalog-assets.ts), loaded only
// when a document needs one. A host can serve the files instead (configureCatalog, the page's ?fonts=<base>): then
// the same files, the core tier, are fetched from <base>/<file>.
const catalogUrl = new Map(Object.entries(BUNDLED).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
const HOST_FILES = new Set(CATALOG.filter((f) => f.tier === 'core').flatMap((f) => f.files.map((x) => x.file)));
let hostBase: string | null = null;

/** Serves the catalogue from a host (`<base>/<file>`, an absolute URL without a trailing slash), or from this
 *  build's own files (null). Call before loadAppFonts. */
export function configureCatalog(base: string | null): void {
  hostBase = base ? base.replace(/\/+$/, '') : null;
}
export const catalogSource = (file: string): string | null =>
  hostBase !== null ? (HOST_FILES.has(file) ? `${hostBase}/${encodeURIComponent(file)}` : null) : catalogUrl.get(file) ?? null;
export { oflUrl, subsetWasmUrl };

/** The font registry (HarfBuzz loaded with this build's hb-subset WASM). */
export function loadAppFonts(): Promise<FontRegistry> {
  return loadFonts({ ...FONT_URLS }, { harfbuzz: { subsetWasm: subsetWasmUrl }, catalog: catalogSource });
}
