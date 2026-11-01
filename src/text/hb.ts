// HarfBuzz loading: the shaping module (harfbuzzjs, which loads harfbuzz.wasm itself, relative to its own module
// URL, so Node and bundlers both find it) and the standalone hb-subset WASM, which we instantiate ourselves.
// Both are loaded once; loadHarfBuzz() is idempotent.

import type * as HarfBuzz from 'harfbuzzjs';

export type HB = typeof HarfBuzz;

/** Bytes of a .wasm file, or a URL (string or URL) to fetch it from. */
export type WasmSource = Uint8Array | ArrayBuffer | URL | string;

export type LoadOptions = {
  /** Where hb-subset's WASM comes from. Node default: harfbuzzjs/dist/harfbuzz-subset.wasm from node_modules.
   *  A browser build passes a URL (e.g. Vite's `?url` import) or the bytes. */
  subsetWasm?: WasmSource;
};

/** The raw exports of harfbuzz-subset.wasm (a standalone module: no imports). Pointers are byte offsets. */
export type SubsetExports = {
  memory: WebAssembly.Memory;
  malloc(n: number): number;
  free(p: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_glyph_set(input: number): number;
  hb_subset_input_set(input: number, setType: number): number;
  hb_subset_input_get_flags(input: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_input_pin_all_axes_to_default(input: number, face: number): number;
  hb_subset_input_pin_axis_to_default(input: number, face: number, axisTag: number): number;
  hb_subset_input_pin_axis_location(input: number, face: number, axisTag: number, value: number): number;
  hb_subset_or_fail(face: number, input: number): number;
};

let hbModule: HB | null = null;
let subsetExports: SubsetExports | null = null;
let loading: Promise<void> | null = null;

export function loadHarfBuzz(opts: LoadOptions = {}): Promise<void> {
  if (!loading) {
    loading = (async () => {
      const [mod, sub] = await Promise.all([import('harfbuzzjs'), loadSubset(opts.subsetWasm)]);
      hbModule = mod;
      subsetExports = sub;
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** The harfbuzzjs module; loadHarfBuzz() must have resolved. */
export function hb(): HB {
  if (!hbModule) throw new Error('HarfBuzz is not loaded: await loadHarfBuzz() first');
  return hbModule;
}

/** The hb-subset WASM exports; loadHarfBuzz() must have resolved. */
export function hbSubset(): SubsetExports {
  if (!subsetExports) throw new Error('hb-subset is not loaded: await loadHarfBuzz() first');
  return subsetExports;
}

async function loadSubset(src: WasmSource | undefined): Promise<SubsetExports> {
  const bytes = await wasmBytes(src);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports as unknown as SubsetExports;
}

async function wasmBytes(src: WasmSource | undefined): Promise<Uint8Array<ArrayBuffer>> {
  if (src instanceof Uint8Array) return new Uint8Array(src);
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (src !== undefined) {
    const url = src instanceof URL ? src : new URL(src, globalThis.location?.href ?? import.meta.url);
    if (url.protocol === 'file:' && isNode()) return readNodeFile(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`hb-subset WASM: ${res.status} ${url.href}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  if (!isNode()) throw new Error('hb-subset WASM: pass loadHarfBuzz({ subsetWasm }) outside Node');
  return readNodeFile(new URL(import.meta.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')));
}

function isNode(): boolean {
  const p = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return typeof p?.versions?.node === 'string';
}

async function readNodeFile(url: URL): Promise<Uint8Array<ArrayBuffer>> {
  // A computed specifier keeps bundlers from pulling node:fs into a browser build.
  const name = 'node:fs/promises';
  const fs = (await import(/* @vite-ignore */ name)) as { readFile(u: URL): Promise<Uint8Array> };
  return new Uint8Array(await fs.readFile(url));
}

/** OpenType tag → uint32. */
export function tagToInt(tag: string): number {
  return (
    (((tag.charCodeAt(0) & 255) << 24) |
      ((tag.charCodeAt(1) & 255) << 16) |
      ((tag.charCodeAt(2) & 255) << 8) |
      (tag.charCodeAt(3) & 255)) >>>
    0
  );
}
