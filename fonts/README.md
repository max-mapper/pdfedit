Fonts are not committed. `npm run fonts` fetches the three default faces (Noto Sans regular and bold, Noto Sans JP).
`node scripts/fetch-fonts.ts --tier core` fetches the substitution catalogue (`src/fonts/catalog.ts`), checks each
file's SHA-256 and writes its licence to `fonts/licenses/`.
