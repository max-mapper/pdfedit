// src/model: the editor's document model (types.ts), built from detection (build.ts), laid out (layout.ts) in the
// shipped faces (fonts.ts), and edited with undo/redo (edit.ts).
export type * from './types.ts';
export { buildDoc, buildPage, buildPageFrom, detectAndBuild, readPage, runsOf } from './build.ts';
export type { BuildOptions } from './build.ts';
export { LEAD_END, dominantRun, styleKeyOf } from './style.ts';
export { FontRegistry, SHIPPED_FACES, SHIPPED_FILES, canDocumentFontDraw, fontFor, hasCjk, loadFonts, substituteRef } from './fonts.ts';
export type { FontFile, FontSource, ShippedFaceId } from './fonts.ts';
export { LayoutCache, VERTICAL_SUFFIX, layoutBox } from './layout.ts';
export { Editor } from './edit.ts';
export type { Change, EditOptions, StylePatch } from './edit.ts';
