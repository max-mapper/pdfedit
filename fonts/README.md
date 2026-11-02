Fonts are not committed. `npm run fonts` fetches the three default faces (Noto Sans regular and bold, Noto Sans JP).
`node scripts/fetch-fonts.ts --tier core` fetches the substitution catalogue (`src/fonts/catalog.ts`), checks each
file's SHA-256 and writes its licence to `fonts/licenses/`.
Every family is OFL 1.1 except Kosugi Maru (Apache 2.0) and IPAGothic and IPAMincho (IPA Font License v1.0). Ship
each family's licence text with its files. The IPA files keep their upstream names (`ipag.ttf`, `ipam.ttf`) and are
never modified; the app build emits them unhashed, with `licenses/<id>.txt` beside the bundled fonts.
