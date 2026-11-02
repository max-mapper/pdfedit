// Worker ops for adding images (src/objects/place.ts): the worker keeps each image file by key, so the page commits and
// the export it runs can write the image. The file is read here once (a PNG is decoded and compressed again), so a
// file this code cannot write is refused before the image is placed.
import { ImageRefused } from '../../src/objects/imagefile.ts';
import { hasAsset, preparedAsset, putAsset } from '../../src/objects/place.ts';
import type { OpModule } from '../opshost.ts';

export const ops: OpModule['ops'] = {
  /** { bytes: ArrayBuffer } → { key, info, ms } (ms: reading and preparing the file here), or { refused } */
  'place-asset': async (_ctx, args) => {
    const t0 = performance.now();
    try {
      const { key, info } = await putAsset(new Uint8Array((args as { bytes: ArrayBuffer }).bytes));
      preparedAsset(key);
      return { key, info, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (e instanceof ImageRefused) return { refused: e.message };
      throw e;
    }
  },
  /** { keys } → whether the worker holds each file */
  'place-has': (_ctx, args) => (args as { keys: string[] }).keys.map(hasAsset),
};
