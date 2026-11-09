// Encrypted PDFs for tests: the standard security handler (ISO 32000-2, 7.6.4) applied to a plain file with pdf-lib.
//
//   encryptPdf(plain, { cipher, owner, user? }) -> bytes
//
// Ciphers: 'rc4-40' (V1 R2), 'rc4-128' (V2 R3), 'aes-128' (V4 R4, AESV2) and 'aes-256' (V5 R6, AESV3). An empty user
// password (the default) makes a file encrypted with an owner password only: any reader opens it, and its permissions
// (`permissions`, default print only) restrict the rest. Every string and stream of every object is encrypted, the
// metadata included; the encryption dictionary and the trailer's /ID are not. Passwords are ASCII.
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from 'pdf-lib';

export type Cipher = 'rc4-40' | 'rc4-128' | 'aes-128' | 'aes-256';
export const CIPHERS: Cipher[] = ['rc4-40', 'rc4-128', 'aes-128', 'aes-256'];
/** Print only: no copying, no changes, no annotations (bits 7, 8 and 13 to 32 are set, as the standard asks). */
export const PRINT_ONLY = 0xfffff0c4 | 0;

const PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
const padded = (pw: string) => Buffer.concat([Buffer.from(pw, 'latin1'), PAD]).subarray(0, 32);
const xorKey = (key: Buffer, i: number) => Buffer.from(key.map((b) => b ^ i));
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = [...Array(256).keys()];
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

function aesCbc(bits: 128 | 256, key: Buffer, iv: Buffer, data: Buffer, pad: boolean): Buffer {
  const c = createCipheriv(`aes-${bits}-cbc`, key, iv);
  c.setAutoPadding(pad);
  return Buffer.concat([c.update(data), c.final()]);
}

/** Revisions 2 to 4: /O (algorithm 3), the file key (algorithm 2) and /U (algorithms 4 and 5). */
function legacyKeys(r: 2 | 3 | 4, n: number, owner: string, user: string, p: number, id: Buffer) {
  let h = md5(padded(owner || user));
  if (r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  const ownerKey = h.subarray(0, n);
  let O = rc4(ownerKey, padded(user));
  if (r >= 3) for (let i = 1; i <= 19; i++) O = rc4(xorKey(ownerKey, i), O);
  let k = md5(padded(user), O, le32(p), id);
  if (r >= 3) for (let i = 0; i < 50; i++) k = md5(k.subarray(0, n));
  const key = k.subarray(0, n);
  let U: Buffer;
  if (r === 2) U = rc4(key, PAD);
  else {
    U = rc4(key, md5(PAD, id));
    for (let i = 1; i <= 19; i++) U = rc4(xorKey(key, i), U);
    U = Buffer.concat([U, Buffer.alloc(16)]);
  }
  return { O, U, key };
}

/** Revision 6's hash (algorithm 2.B). */
function hash6(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k: Buffer = createHash('sha256').update(Buffer.concat([pw, salt, udata])).digest();
  let e: Buffer = Buffer.alloc(0);
  for (let i = 0; i < 64 || e[e.length - 1] > i - 32; i++) {
    const block = Buffer.concat([pw, k, udata]);
    e = aesCbc(128, k.subarray(0, 16), k.subarray(16, 32), Buffer.concat(Array(64).fill(block)), false);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j];
    k = createHash(['sha256', 'sha384', 'sha512'][sum % 3]).update(e).digest();
  }
  return k.subarray(0, 32);
}

/** Revision 6: /U, /UE, /O, /OE and /Perms around a random file key (algorithms 8, 9 and 10). */
function aes256Keys(owner: string, user: string, p: number) {
  const key = randomBytes(32), zero = Buffer.alloc(16);
  const upw = Buffer.from(user, 'utf8'), opw = Buffer.from(owner, 'utf8');
  const [uv, uk, ov, ok] = [0, 1, 2, 3].map(() => randomBytes(8));
  const U = Buffer.concat([hash6(upw, uv, Buffer.alloc(0)), uv, uk]);
  const UE = aesCbc(256, hash6(upw, uk, Buffer.alloc(0)), zero, key, false);
  const O = Buffer.concat([hash6(opw, ov, U), ov, ok]);
  const OE = aesCbc(256, hash6(opw, ok, U), zero, key, false);
  const perms = Buffer.concat([le32(p), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('Tadb', 'latin1'), randomBytes(4)]);
  const ecb = createCipheriv('aes-256-ecb', key, null);
  ecb.setAutoPadding(false);
  const Perms = Buffer.concat([ecb.update(perms), ecb.final()]);
  return { key, U, UE, O, OE, Perms };
}

const hex = (b: Buffer) => PDFHexString.of(b.toString('hex'));

/** The plain file encrypted with the standard security handler. */
export async function encryptPdf(plain: Uint8Array, o: { cipher: Cipher; owner: string; user?: string; permissions?: number }): Promise<Uint8Array> {
  const user = o.user ?? '', p = o.permissions ?? PRINT_ONLY;
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const ctx = doc.context;
  const id = randomBytes(16);
  const aes = o.cipher === 'aes-128' || o.cipher === 'aes-256';
  let encrypt: Record<string, PDFObject>;
  let objectKey: (ref: PDFRef) => Buffer;
  if (o.cipher === 'aes-256') {
    const k = aes256Keys(o.owner, user, p);
    objectKey = () => k.key;
    encrypt = {
      Filter: PDFName.of('Standard'), V: PDFNumber.of(5), R: PDFNumber.of(6), Length: PDFNumber.of(256),
      CF: ctx.obj({ StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV3', Length: 32 } }), StmF: PDFName.of('StdCF'), StrF: PDFName.of('StdCF'),
      O: hex(k.O), U: hex(k.U), OE: hex(k.OE), UE: hex(k.UE), Perms: hex(k.Perms), P: PDFNumber.of(p),
    };
  } else {
    const [v, r, n] = o.cipher === 'rc4-40' ? [1, 2, 5] as const : o.cipher === 'rc4-128' ? [2, 3, 16] as const : [4, 4, 16] as const;
    const k = legacyKeys(r, n, o.owner, user, p, id);
    objectKey = (ref) => {
      const num = Buffer.from([ref.objectNumber & 255, (ref.objectNumber >> 8) & 255, (ref.objectNumber >> 16) & 255, ref.generationNumber & 255, (ref.generationNumber >> 8) & 255]);
      return md5(k.key, num, aes ? Buffer.from('sAlT', 'latin1') : Buffer.alloc(0)).subarray(0, Math.min(n + 5, 16));
    };
    encrypt = { Filter: PDFName.of('Standard'), V: PDFNumber.of(v), R: PDFNumber.of(r), Length: PDFNumber.of(n * 8), O: hex(k.O), U: hex(k.U), P: PDFNumber.of(p) };
    if (aes) Object.assign(encrypt, { CF: ctx.obj({ StdCF: { AuthEvent: 'DocOpen', CFM: 'AESV2', Length: 16 } }), StmF: PDFName.of('StdCF'), StrF: PDFName.of('StdCF') });
  }
  const seal = (key: Buffer, data: Buffer) => {
    if (!aes) return rc4(key, data);
    const iv = randomBytes(16);
    return Buffer.concat([iv, aesCbc(key.length === 32 ? 256 : 128, key, iv, data, true)]);
  };
  const walk = (x: PDFObject, key: Buffer): PDFObject => {
    if (x instanceof PDFString || x instanceof PDFHexString) return hex(seal(key, Buffer.from(x.asBytes())));
    if (x instanceof PDFArray) { x.asArray().forEach((v, i) => x.set(i, walk(v, key))); return x; }
    if (x instanceof PDFDict) { for (const [name, v] of x.entries()) x.set(name, walk(v, key)); return x; }
    return x;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const key = objectKey(ref);
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of('Type'));
      if (type === PDFName.of('XRef') || type === PDFName.of('ObjStm')) { ctx.delete(ref); continue; }
      const sealed = seal(key, Buffer.from(obj.getContents()));
      walk(obj.dict, key);
      obj.dict.set(PDFName.of('Length'), PDFNumber.of(sealed.length));
      ctx.assign(ref, PDFRawStream.of(obj.dict, sealed));
    } else ctx.assign(ref, walk(obj, key));
  }
  ctx.trailerInfo.Encrypt = ctx.register(ctx.obj(encrypt));
  ctx.trailerInfo.ID = ctx.obj([hex(id), hex(id)]);
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
