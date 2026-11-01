// Node-only helpers around rendered bitmaps: PNG encoding and a pixel difference inside or outside regions.
import { PNG } from 'pngjs';
import type { Bitmap } from './pdfium.ts';
export { diffOutside } from './diff.ts';

export function toPng(b: Bitmap): Buffer {
  const png = new PNG({ width: b.width, height: b.height });
  png.data = Buffer.from(b.rgba.buffer, b.rgba.byteOffset, b.rgba.byteLength);
  return PNG.sync.write(png);
}

