// Paragraph-to-segment links: which segments each detected paragraph shows, stored on the host once and checked on
// every load (docs/EMBED.md, "Links"). A link names a paragraph by page, box id and paragraph index, as one pdfedit
// build detects the PDF, and records the SHA-256 of the paragraph's source text, normalised as the matcher compares
// texts (src/embed/match.ts normalise). On a later load a link holds only when the paragraph at that place still has
// that hash; otherwise it is unmapped, with why: 'source_changed' (another text there) or 'box_missing' (no such box
// or paragraph). The hash is computed here (pure TypeScript, no Web Crypto: it works in Node, in a worker and on a
// page that is not a secure context). Pure: no I/O.
import { normalise } from './match.ts';

export const LINKS_VERSION = 1;

/** One paragraph's link. `seg_ids` has one id, or several for a paragraph that is a run of segments. */
export type Link = { page: number; box: string; para: number; seg_ids: string[]; src_sha: string };
/** The blob the host keeps (POST and GET <api>/links). */
export type LinksBlob = { links_version: typeof LINKS_VERSION; engine: string; links: Link[] };
/** Why a stored link does not hold on this load. */
export type LinkMiss = 'source_changed' | 'box_missing';
/** A link as this load sees it: `ok` false when it did not verify (then `why_not` says why). */
export type ParaLink = Link & { ok: boolean; why_not: LinkMiss | null };
/** A paragraph that could take a translation, as detected: its source text, the text's hash and the pairs the
 *  matcher took for it (null: none). */
export type Slot = { box: string; para: number; text: string; src_sha: string; seg_ids: string[] | null };

export const paraKey = (box: string, para: number) => `${box}#${para}`;
export const linkKey = (page: number, box: string, para: number) => `${page}/${box}#${para}`;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const ror = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of a text's UTF-8 bytes, as lower-case hex. */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const l = bytes.length;
  const n = ((l + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(n);
  m.set(bytes);
  m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  dv.setUint32(n - 4, (l * 8) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = (W[i - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + W[i - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) | 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** The hash a link records for a source paragraph: SHA-256 of the text as the matcher normalises it. */
export const srcSha = (text: string) => sha256Hex(normalise(text));

/** The links of one page from the matcher: every slot whose source matched a pair or a run of pairs. */
export function computeLinks(page: number, slots: Slot[]): Link[] {
  return slots.filter((s) => s.seg_ids && s.seg_ids.length)
    .map((s) => ({ page, box: s.box, para: s.para, seg_ids: [...s.seg_ids!], src_sha: s.src_sha }));
}

/** Stored links of one page checked against its detection: a link holds when the paragraph at its place has its
 *  source hash; a box the detection does not have is 'box_missing', another text there 'source_changed'. */
export function verifyLinks(links: Link[], slots: Slot[], detected: Iterable<string>): ParaLink[] {
  const bySlot = new Map(slots.map((s) => [paraKey(s.box, s.para), s]));
  const boxes = new Set(detected);
  return links.map((l) => {
    const s = bySlot.get(paraKey(l.box, l.para));
    const why: LinkMiss | null = s && s.src_sha === l.src_sha ? null : !boxes.has(l.box) ? 'box_missing' : 'source_changed';
    return { ...l, seg_ids: [...l.seg_ids], ok: why === null, why_not: why };
  });
}

export class LinksError extends Error {}

/** Checks a links blob read from a host and returns it typed; throws LinksError when it is not one. */
export function parseLinks(x: unknown): LinksBlob {
  const b = x as LinksBlob;
  if (!b || typeof b !== 'object' || b.links_version !== LINKS_VERSION || !Array.isArray(b.links)) throw new LinksError(`not a links blob (links_version ${LINKS_VERSION})`);
  for (const l of b.links) {
    if (!l || !Number.isInteger(l.page) || l.page < 0 || typeof l.box !== 'string' || !Number.isInteger(l.para) || l.para < 0 ||
      !Array.isArray(l.seg_ids) || !l.seg_ids.length || !l.seg_ids.every((s) => typeof s === 'string') || typeof l.src_sha !== 'string') {
      throw new LinksError('a link of the blob is malformed');
    }
  }
  return { links_version: LINKS_VERSION, engine: String(b.engine ?? ''), links: b.links };
}
