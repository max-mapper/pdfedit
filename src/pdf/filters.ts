// Stream filters (ISO 32000-1 §7.4): the decoders a content stream, a form XObject or a CMap may use, applied in the
// order the /Filter array lists them, with /DecodeParms predictors (§7.4.4.4: TIFF predictor 2, PNG predictors 10–15)
// after FlateDecode and LZWDecode. Image-only filters (DCTDecode, JPXDecode, JBIG2Decode, CCITTFaxDecode) and the
// Crypt filter are refused with a reason: their output is never content-stream syntax, and an encrypted stream must be
// decrypted first (src/engine's decryptCopy).

import pako from 'pako';

export type DecodeParms = {
  Predictor?: number;
  Colors?: number;
  BitsPerComponent?: number;
  Columns?: number;
  EarlyChange?: number;
  /** Crypt filter: the crypt filter's name (only /Identity is a no-op). */
  Name?: string;
};

export type FilterSpec = { name: string; parms?: DecodeParms | null };

const ABBREVIATIONS: Record<string, string> = {
  AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode', LZW: 'LZWDecode', Fl: 'FlateDecode', RL: 'RunLengthDecode',
  CCF: 'CCITTFaxDecode', DCT: 'DCTDecode',
};

const IMAGE_ONLY = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode']);

export const SUPPORTED_FILTERS: readonly string[] = ['FlateDecode', 'LZWDecode', 'ASCIIHexDecode', 'ASCII85Decode', 'RunLengthDecode'];

/** The full filter name for an abbreviation (inline images may use AHx, A85, LZW, Fl, RL, CCF, DCT). */
export function filterName(name: string): string {
  return ABBREVIATIONS[name] ?? name;
}

function concat(parts: Uint8Array[], total = parts.reduce((s, p) => s + p.length, 0)): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const isWhite = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00;

/** FlateDecode. A truncated or checksum-less stream keeps what decompresses, as viewers render it. */
export function inflate(data: Uint8Array, label = 'stream'): Uint8Array {
  try {
    return pako.inflate(data);
  } catch {
    const chunks: Uint8Array[] = [];
    const inf = new pako.Inflate();
    inf.onData = (c: Uint8Array) => chunks.push(c);
    inf.push(data, true);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    if (total === 0) {
      // A raw deflate stream without the zlib header: some producers write those.
      try {
        const raw = pako.inflateRaw(data);
        if (raw.length) return raw;
      } catch {
        /* fall through */
      }
      throw new Error(`pdfedit: ${label} does not inflate (${inf.msg || 'corrupt data'})`);
    }
    return concat(chunks, total);
  }
}

/** ASCIIHexDecode: pairs of hex digits, white space ignored, `>` ends the data; an odd final digit is followed by 0. */
export function asciiHexDecode(data: Uint8Array, label = 'stream'): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2));
  let n = 0;
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break; // '>'
    if (isWhite(c)) continue;
    let v: number;
    if (c >= 0x30 && c <= 0x39) v = c - 0x30;
    else if (c >= 0x41 && c <= 0x46) v = c - 0x37;
    else if (c >= 0x61 && c <= 0x66) v = c - 0x57;
    else throw new Error(`pdfedit: ${label}: ASCIIHexDecode found the byte 0x${c.toString(16)} at ${i}`);
    if (hi < 0) hi = v;
    else {
      out[n++] = hi * 16 + v;
      hi = -1;
    }
  }
  if (hi >= 0) out[n++] = hi * 16;
  return out.subarray(0, n);
}

/** ASCII85Decode: groups of five characters ! … u, `z` for four zero bytes, `~>` ends the data; a final partial group
 *  of n characters gives n − 1 bytes. A leading `<~` (as PostScript writes it) is skipped. */
export function ascii85Decode(data: Uint8Array, label = 'stream'): Uint8Array {
  const out: number[] = [];
  const group: number[] = [];
  let i = 0;
  while (i < data.length && isWhite(data[i])) i++;
  if (data[i] === 0x3c && data[i + 1] === 0x7e) i += 2; // '<~'
  for (; i < data.length; i++) {
    const c = data[i];
    if (isWhite(c)) continue;
    if (c === 0x7e) break; // '~' of '~>'
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0); // 'z'
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new Error(`pdfedit: ${label}: ASCII85Decode found the byte 0x${c.toString(16)} at ${i}`);
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      if (v > 0xffffffff) throw new Error(`pdfedit: ${label}: ASCII85Decode group out of range at ${i}`);
      out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
      group.length = 0;
    }
  }
  if (group.length === 1) throw new Error(`pdfedit: ${label}: ASCII85Decode ends with a single character`);
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84); // 'u'
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const b = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    out.push(...b.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

/** LZWDecode (§7.4.4.2): 9- to 12-bit codes, 256 clears the table, 257 ends the data; with EarlyChange 1 (the default)
 *  the code width grows one code early. */
export function lzwDecode(data: Uint8Array, earlyChange = 1, label = 'stream'): Uint8Array {
  const out: Uint8Array[] = [];
  let total = 0;
  // The table as (prefix code, last byte, length): strings are rebuilt on output.
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  const first = new Uint8Array(4096);
  for (let k = 0; k < 256; k++) {
    prefix[k] = -1;
    suffix[k] = k;
    length[k] = 1;
    first[k] = k;
  }
  let next = 258;
  let width = 9;
  let prev = -1;
  let bitBuf = 0;
  let bitCount = 0;
  let pos = 0;
  const emit = (code: number) => {
    const n = length[code];
    const s = new Uint8Array(n);
    for (let k = n - 1, c = code; k >= 0; k--, c = prefix[c]) s[k] = suffix[c];
    out.push(s);
    total += n;
  };
  for (;;) {
    while (bitCount < width && pos < data.length) {
      bitBuf = ((bitBuf << 8) | data[pos++]) >>> 0;
      bitCount += 8;
    }
    if (bitCount < width) break; // the data ends without an EOD code: keep what was decoded
    const code = (bitBuf >>> (bitCount - width)) & ((1 << width) - 1);
    bitCount -= width;
    bitBuf &= (1 << bitCount) - 1;
    if (code === 256) {
      next = 258;
      width = 9;
      prev = -1;
      continue;
    }
    if (code === 257) break;
    if (prev < 0) {
      if (code > 255) throw new Error(`pdfedit: ${label}: LZWDecode starts with the code ${code}`);
      emit(code);
      prev = code;
      continue;
    }
    let firstByte: number;
    if (code < next) firstByte = first[code];
    else if (code === next) firstByte = first[prev]; // KwKwK: the code being defined by this very step
    else throw new Error(`pdfedit: ${label}: LZWDecode found the code ${code} before it was defined (next ${next})`);
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstByte;
      length[next] = length[prev] + 1;
      first[next] = first[prev];
      next++;
    }
    emit(code);
    prev = code;
    if (next + earlyChange >= 1 << width && width < 12) width++;
  }
  return concat(out, total);
}

/** PNG (10–15) and TIFF (2) predictors (§7.4.4.4). Predictor 1 or absent: the data as is. */
export function unpredict(data: Uint8Array, p: DecodeParms, label = 'stream'): Uint8Array {
  const predictor = p.Predictor ?? 1;
  if (predictor <= 1) return data;
  const colors = p.Colors ?? 1;
  const bpc = p.BitsPerComponent ?? 8;
  const columns = p.Columns ?? 1;
  if (![1, 2, 4, 8, 16].includes(bpc)) throw new Error(`pdfedit: ${label}: /BitsPerComponent ${bpc} is not valid for a predictor`);
  if (colors < 1 || columns < 1) throw new Error(`pdfedit: ${label}: predictor with /Colors ${colors} /Columns ${columns}`);
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));

  if (predictor === 2) {
    const rows = Math.ceil(data.length / rowBytes);
    const out = new Uint8Array(data);
    for (let r = 0; r < rows; r++) {
      const row = out.subarray(r * rowBytes, Math.min((r + 1) * rowBytes, out.length));
      if (bpc === 8) {
        for (let i = colors; i < row.length; i++) row[i] = (row[i] + row[i - colors]) & 0xff;
      } else if (bpc === 16) {
        for (let i = 2 * colors; i + 1 < row.length; i += 2) {
          const v = (((row[i] << 8) | row[i + 1]) + ((row[i - 2 * colors] << 8) | row[i - 2 * colors + 1])) & 0xffff;
          row[i] = v >> 8;
          row[i + 1] = v & 0xff;
        }
      } else {
        // sub-byte components: add sample by sample, modulo 2^bpc
        const mask = (1 << bpc) - 1;
        const samples = colors * columns;
        const get = (k: number) => (row[(k * bpc) >> 3] >> (8 - bpc - ((k * bpc) & 7))) & mask;
        const set = (k: number, v: number) => {
          const byte = (k * bpc) >> 3;
          const shift = 8 - bpc - ((k * bpc) & 7);
          row[byte] = (row[byte] & ~(mask << shift)) | ((v & mask) << shift);
        };
        for (let k = colors; k < samples && (k * bpc) >> 3 < row.length; k++) set(k, get(k) + get(k - colors));
      }
    }
    return out;
  }

  if (predictor >= 10 && predictor <= 15) {
    // Every row starts with its own PNG filter type byte (the predictor value only says "PNG").
    const stride = rowBytes + 1;
    const rows = Math.ceil(data.length / stride);
    const out = new Uint8Array(rows * rowBytes);
    let prevRow = new Uint8Array(rowBytes);
    let n = 0;
    for (let r = 0; r < rows; r++) {
      const at = r * stride;
      const type = data[at];
      const src = data.subarray(at + 1, Math.min(at + stride, data.length));
      const row = out.subarray(r * rowBytes, r * rowBytes + rowBytes);
      for (let i = 0; i < src.length; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = prevRow[i];
        const upLeft = i >= bpp ? prevRow[i - bpp] : 0;
        let v: number;
        switch (type) {
          case 0: v = src[i]; break;
          case 1: v = src[i] + left; break;
          case 2: v = src[i] + up; break;
          case 3: v = src[i] + ((left + up) >> 1); break;
          case 4: {
            const pa = Math.abs(up - upLeft), pb = Math.abs(left - upLeft), pc = Math.abs(left + up - 2 * upLeft);
            v = src[i] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
            break;
          }
          default:
            throw new Error(`pdfedit: ${label}: PNG predictor row ${r} has the filter type ${type}`);
        }
        row[i] = v & 0xff;
      }
      n = r * rowBytes + src.length; // every row but a truncated last one is full
      prevRow = row;
    }
    return out.subarray(0, n);
  }
  throw new Error(`pdfedit: ${label}: /Predictor ${predictor} is not defined (1, 2 or 10–15)`);
}

/** RunLengthDecode: a length byte 0–127 copies the next n + 1 bytes, 129–255 repeats the next byte 257 − n times, 128
 *  ends the data. */
export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
    } else if (i < data.length) {
      const b = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(b);
    }
  }
  return Uint8Array.from(out);
}

/** Applies the filters in order. `label` names the stream in errors. */
export function decodeFilters(data: Uint8Array, filters: FilterSpec[], label = 'stream'): Uint8Array {
  let out = data;
  const list = filters.map((f) => '/' + f.name).join(' ');
  for (const f of filters) {
    const name = filterName(f.name);
    const p = f.parms ?? {};
    switch (name) {
      case 'FlateDecode':
        out = unpredict(inflate(out, label), p, label);
        break;
      case 'LZWDecode':
        out = unpredict(lzwDecode(out, p.EarlyChange ?? 1, label), p, label);
        break;
      case 'ASCIIHexDecode':
        out = asciiHexDecode(out, label);
        break;
      case 'ASCII85Decode':
        out = ascii85Decode(out, label);
        break;
      case 'RunLengthDecode':
        out = runLengthDecode(out);
        break;
      case 'Crypt':
        if (!p.Name || p.Name === 'Identity') break;
        throw new Error(
          `pdfedit: ${label} uses the /Crypt filter /${p.Name} (filters: ${list}); encrypted streams are read from a ` +
            'decrypted copy of the document (decryptCopy), not decoded here',
        );
      default:
        if (IMAGE_ONLY.has(name)) {
          throw new Error(
            `pdfedit: ${label} uses the filter /${name} (filters: ${list}); it is an image-only filter, so the data is not ` +
              'content-stream syntax',
          );
        }
        throw new Error(
          `pdfedit: ${label} uses the filter /${name} (filters: ${list}); supported: ${SUPPORTED_FILTERS.map((x) => '/' + x).join(' ')}`,
        );
    }
  }
  return out;
}
