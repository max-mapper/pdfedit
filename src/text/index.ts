// src/text: shaping, fonts, layout, emitting (docs/CONTRACTS.md).

export { loadHarfBuzz } from './hb.ts';
export type { LoadOptions, WasmSource } from './hb.ts';
export { baseFace, emCenter, loadFace, pdfVMetrics, pdfWidth, sidewaysFace, verticalFace, vMetrics } from './face.ts';
export type { Face, AxisInfo, Orientation, VMetrics } from './face.ts';
export { shape, scriptRuns } from './shape.ts';
export type { Glyph, ScriptRun } from './shape.ts';
export { DEFAULT_JUSTIFY_POLICY, layoutParagraphs } from './layout.ts';
export type { Align, JustifyPolicy, Layout, LayoutOptions, Line, LineGlyph, LineRun, ParaIn, ParaInfo, Rgb, RunIn } from './layout.ts';
export { hyphenPoints } from './hyphenate.ts';
export { FontWriter, buildW2, toUnicodeCMap } from './font-writer.ts';
export type { FontWriterOptions } from './font-writer.ts';
export { subsetFace } from './subset.ts';
export { emit, useLayout } from './emit.ts';
export { verticalUpright } from './unicode.ts';
