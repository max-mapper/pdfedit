// The files the app ships with (Vite `?url` imports, so they are assets of this build and load from its own origin):
// the shipped OFL faces, hb-subset's WASM and the fonts' licence. Imported by the main thread and by the worker.
import sansUrl from '../fonts/NotoSans-Regular.ttf?url';
import sansBoldUrl from '../fonts/NotoSans-Bold.ttf?url';
import jpUrl from '../fonts/NotoSansJP-VF.ttf?url';
import subsetWasmUrl from 'harfbuzzjs/dist/harfbuzz-subset.wasm?url';
import oflUrl from '../fonts/OFL.txt?url';
import { loadFonts, type FontRegistry } from '../src/model/fonts.ts';

export const FONT_URLS = { 'NotoSans-Regular.ttf': sansUrl, 'NotoSans-Bold.ttf': sansBoldUrl, 'NotoSansJP-VF.ttf': jpUrl } as const;

// The substitution catalogue's core tier (`node scripts/fetch-fonts.ts --tier core`), as assets of this build, loaded
// only when a document needs one.
const CATALOG_URLS = import.meta.glob([
  '../fonts/{NotoSans,NotoSans-Italic,NotoSerif,NotoSerif-Italic,NotoSansMono,Arimo,Arimo-Italic,Gelasio,Gelasio-Italic,NotoSansJP,NotoSerifJP}-VF.ttf',
  '../fonts/{Tinos,Cousine,Carlito,Caladea}-{Regular,Bold,Italic,BoldItalic}.ttf',
  '../fonts/Selawik-{300,350,400,600,700}.ttf',
  '../fonts/BIZUD{Gothic,PGothic,Mincho,PMincho}-{Regular,Bold}.ttf',
], { query: '?url', import: 'default', eager: true }) as Record<string, string>;
const catalogUrl = new Map(Object.entries(CATALOG_URLS).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url]));
export const catalogSource = (file: string): string | null => catalogUrl.get(file) ?? null;
export { oflUrl, subsetWasmUrl };

/** The font registry (HarfBuzz loaded with this build's hb-subset WASM). */
export function loadAppFonts(): Promise<FontRegistry> {
  return loadFonts({ ...FONT_URLS }, { harfbuzz: { subsetWasm: subsetWasmUrl }, catalog: catalogSource });
}
