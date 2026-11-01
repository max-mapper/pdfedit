// Shared by the src/text tests: the shipped OFL fonts, loaded once. Synthetic text only.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadHarfBuzz } from './hb.ts';
import { loadFace } from './face.ts';
import type { Face } from './face.ts';

export const FONTS_DIR = fileURLToPath(new URL('../../fonts/', import.meta.url));

const bytesCache = new Map<string, Uint8Array>();
export function fontBytes(file: string): Uint8Array {
  let b = bytesCache.get(file);
  if (!b) {
    b = new Uint8Array(readFileSync(FONTS_DIR + file));
    bytesCache.set(file, b);
  }
  return b;
}

export type Faces = { sans: Face; sansBold: Face; ja: Face; jaBold: Face };

let faces: Faces | null = null;
export async function testFaces(): Promise<Faces> {
  await loadHarfBuzz();
  faces ??= {
    sans: loadFace(fontBytes('NotoSans-Regular.ttf')),
    sansBold: loadFace(fontBytes('NotoSans-Bold.ttf')),
    ja: loadFace(fontBytes('NotoSansJP-VF.ttf'), { variations: { wght: 400 } }),
    jaBold: loadFace(fontBytes('NotoSansJP-VF.ttf'), { variations: { wght: 700 } }),
  };
  return faces;
}
