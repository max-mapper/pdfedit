// hb-subset: a glyph-ID subset of a face that keeps glyph IDs (CID = GID with /CIDToGIDMap /Identity) and pins
// every variation axis to the face's coordinates, so the result is a static TrueType font.

import { hbSubset, tagToInt } from './hb.ts';
import type { Face } from './face.ts';

// hb_subset_flags_t
const RETAIN_GIDS = 0x2;
const NO_HINTING = 0x1;
// hb_subset_sets_t
const SET_DROP_TABLE_TAG = 3;
// Layout and vertical tables are not needed by a PDF CIDFontType2 shown horizontally through Identity-H.
const DROP_TABLES = ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'MATH', 'STAT', 'DSIG', 'kern', 'vhea', 'vmtx', 'VORG', 'meta'];
const MEMORY_MODE_READONLY = 1;

export function subsetFace(face: Face, gids: Iterable<number>, opts: { hinting?: boolean } = {}): Uint8Array {
  const x = hbSubset();
  const src = face.bytes;
  const dataPtr = x.malloc(src.length);
  if (!dataPtr) throw new Error('hb-subset: out of memory');
  new Uint8Array(x.memory.buffer, dataPtr, src.length).set(src);
  const blob = x.hb_blob_create(dataPtr, src.length, MEMORY_MODE_READONLY, 0, 0);
  const hbFace = x.hb_face_create(blob, 0);
  const input = x.hb_subset_input_create_or_fail();
  let outFace = 0;
  try {
    if (!input) throw new Error('hb-subset: cannot create input');
    const glyphs = x.hb_subset_input_glyph_set(input);
    x.hb_set_add(glyphs, 0); // .notdef
    for (const g of gids) x.hb_set_add(glyphs, g);
    x.hb_subset_input_set_flags(input, RETAIN_GIDS | (opts.hinting ? 0 : NO_HINTING));
    const drop = x.hb_subset_input_set(input, SET_DROP_TABLE_TAG);
    for (const t of DROP_TABLES) x.hb_set_add(drop, tagToInt(t));
    for (const axis of face.axes) {
      const v = face.variations[axis.tag] ?? axis.default;
      if (!x.hb_subset_input_pin_axis_location(input, hbFace, tagToInt(axis.tag), v)) {
        throw new Error(`hb-subset: cannot pin axis ${axis.tag} to ${v}`);
      }
    }
    outFace = x.hb_subset_or_fail(hbFace, input);
    if (!outFace) throw new Error(`hb-subset failed for ${face.postScriptName}`);
    const outBlob = x.hb_face_reference_blob(outFace);
    const lenPtr = x.malloc(4);
    const ptr = x.hb_blob_get_data(outBlob, lenPtr);
    const len = x.hb_blob_get_length(outBlob);
    const out = new Uint8Array(x.memory.buffer, ptr, len).slice();
    x.free(lenPtr);
    x.hb_blob_destroy(outBlob);
    if (!len) throw new Error(`hb-subset produced an empty font for ${face.postScriptName}`);
    return out;
  } finally {
    if (outFace) x.hb_face_destroy(outFace);
    if (input) x.hb_subset_input_destroy(input);
    x.hb_face_destroy(hbFace);
    x.hb_blob_destroy(blob);
    x.free(dataPtr);
  }
}
