// The substitution catalogue's core tier (`node scripts/fetch-fonts.ts --tier core`) as assets of this build: file
// name → URL. The embed build (scripts/build-embed.mjs, Vite mode 'embed') swaps this module for
// app/catalog-none.ts: there the host serves the files (app/assets.ts, configureCatalog).
const CATALOG_URLS = import.meta.glob([
  '../fonts/{NotoSans,NotoSans-Italic,NotoSerif,NotoSerif-Italic,NotoSansMono,Arimo,Arimo-Italic,Gelasio,Gelasio-Italic,NotoSansJP,NotoSerifJP}-VF.ttf',
  '../fonts/{Tinos,Cousine,Carlito,Caladea}-{Regular,Bold,Italic,BoldItalic}.ttf',
  '../fonts/Selawik-{300,350,400,600,700}.ttf',
  '../fonts/BIZUD{Gothic,PGothic,Mincho,PMincho}-{Regular,Bold}.ttf',
], { query: '?url', import: 'default', eager: true }) as Record<string, string>;

export default CATALOG_URLS;
