// src/pdf: content streams, surgery, saving (docs/CONTRACTS.md).

export { tokenize, Lexer, type Token } from './tokenizer.ts';
export { parseOps, textShows, type Op, type TextShow } from './ops.ts';
export { fontInfoFromDict, type FontInfo } from './fonts.ts';
export { blankOut, blankOutDetailed, showDisplacement, type Displacement, type Replacement } from './surgery.ts';
export { openForEdit, PdfEdit } from './edit.ts';
export { hasEncrypt, openEditable } from './editable.ts';
// filters, decoding and the content tree
export { decodeFilters, SUPPORTED_FILTERS, type DecodeParms, type FilterSpec } from './filters.ts';
export { decodeStream, streamFilters } from './edit.ts';
export { checkXrefChain, readTail, type OriginalTail } from './incremental.ts';
export { xobjectCalls, mul, apply, type M6, type XObjectCall } from './ops.ts';
export { contentTree, formUses, commitForms, type ContentTree, type StreamNode, type TextSite } from './tree.ts';
export { matchObjects, type ObjectKey, type SiteKey, type MatchResult } from './match.ts';
export { fontDecoder, parseToUnicode, type FontDecoder } from './textdecode.ts';
