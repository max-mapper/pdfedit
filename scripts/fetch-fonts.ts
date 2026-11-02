// Fetches the substitute font families of src/fonts/catalog.ts from their pinned upstream sources (the google/fonts
// repository at a fixed commit, the Selawik release) into fonts/, with each family's
// licence in fonts/licenses/<id>.txt, and records SHA-256 sums in fonts/SUBSTITUTES.local.sha256. A file whose
// catalog entry pins a sum is refused when it does not match. Nothing is sent but the GET of each file's URL.
//
//   node scripts/fetch-fonts.ts                       # every family up to 30 MB (the default budget per family)
//   node scripts/fetch-fonts.ts --tier core           # core families only
//   node scripts/fetch-fonts.ts --family shippori-mincho   # a named family, whatever its size
//   node scripts/fetch-fonts.ts --max-mb 0 --list     # print the plan and sizes, fetch nothing
//   node scripts/fetch-fonts.ts --print-sums          # also print { file: sha256 } JSON for pinning in the catalog
//
// The font files are gitignored (fonts/*.ttf, *.otf); the licence texts are small and belong with the fonts.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { CATALOG, familyBytes, sourceUrl, type Family, type FontFileSpec, type Source } from '../src/fonts/catalog.ts';

const FONTS = new URL('../fonts/', import.meta.url);
const LICENSES = new URL('licenses/', FONTS);

type Args = { tier: 'core' | 'extended' | 'all'; families: string[]; maxMb: number; list: boolean; force: boolean; printSums: boolean };

function parseArgs(argv: string[]): Args {
  const a: Args = { tier: 'all', families: [], maxMb: 30, list: false, force: false, printSums: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--tier') a.tier = argv[++i] as Args['tier'];
    else if (k === '--family') a.families.push(...argv[++i].split(','));
    else if (k === '--max-mb') a.maxMb = Number(argv[++i]);
    else if (k === '--list') a.list = true;
    else if (k === '--force') a.force = true;
    else if (k === '--print-sums') a.printSums = true;
    else throw new Error(`fetch-fonts: unknown argument ${k}`);
  }
  if (!['core', 'extended', 'all'].includes(a.tier)) throw new Error(`fetch-fonts: --tier core|extended|all`);
  for (const id of a.families) if (!CATALOG.some((f) => f.id === id)) throw new Error(`fetch-fonts: no family '${id}' in the catalog`);
  return a;
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const mb = (n: number): string => (n / 1e6).toFixed(1) + ' MB';

const downloads = new Map<string, Promise<Uint8Array>>();

/** GET a URL once per run (archives hold several files). */
function get(url: string): Promise<Uint8Array> {
  let p = downloads.get(url);
  if (!p) {
    p = (async () => {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    })();
    downloads.set(url, p);
  }
  return p;
}

async function fetchSource(src: Source): Promise<Uint8Array> {
  const bytes = await get(sourceUrl(src));
  if (src.kind === 'zip') return unzipMember(bytes, src.member);
  return bytes;
}

/** One member of a zip archive (stored or deflated), read through the central directory. */
export function unzipMember(zip: Uint8Array, member: string): Uint8Array {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('zip: no end of central directory');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('zip: bad central directory');
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = dec.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === member) {
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const data = zip.subarray(start, start + size);
      if (method === 0) return data.slice();
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`zip: ${member} uses compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: no member ${member}`);
}

function writeAtomic(url: URL, bytes: Uint8Array): void {
  const tmp = new URL(url.href + '.part');
  writeFileSync(tmp, bytes);
  renameSync(tmp, url);
}

/** The file on disk, fetched when missing (or --force), checked against its pinned sum. Returns its sum. */
async function ensureFile(spec: FontFileSpec, force: boolean): Promise<{ sum: string; fetched: boolean }> {
  const dest = new URL(spec.file, FONTS);
  if (!force && existsSync(dest)) {
    const sum = sha256(readFileSync(dest));
    if (!spec.sha256 || spec.sha256 === sum) return { sum, fetched: false };
    console.warn(`  ${spec.file}: on disk ${sum.slice(0, 12)}… does not match the pinned sum; fetching again`);
  }
  const bytes = await fetchSource(spec.src);
  const sum = sha256(bytes);
  if (spec.sha256 && spec.sha256 !== sum) throw new Error(`${spec.file}: SHA-256 ${sum} does not match the pinned ${spec.sha256}`);
  if (!spec.sha256) console.warn(`  ${spec.file}: no pinned sum in the catalog (recorded ${sum.slice(0, 12)}…)`);
  writeAtomic(dest, bytes);
  return { sum, fetched: true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const named = new Set(args.families);
  const chosen: Family[] = [];
  const skipped: Family[] = [];
  for (const f of CATALOG) {
    if (named.size ? !named.has(f.id) : args.tier !== 'all' && f.tier !== args.tier) continue;
    if (!named.has(f.id) && familyBytes(f) > args.maxMb * 1e6) skipped.push(f);
    else chosen.push(f);
  }
  console.log(`fetch-fonts: ${chosen.length} families, ${mb(chosen.reduce((n, f) => n + familyBytes(f), 0))}`);
  for (const f of chosen) console.log(`  ${f.id.padEnd(26)} ${mb(familyBytes(f)).padStart(9)}  ${f.licence}  (${f.files.length} files)`);
  for (const f of skipped) console.log(`  skipped ${f.id} (${mb(familyBytes(f))} > ${args.maxMb} MB; name it with --family to fetch)`);
  if (args.list) return;

  mkdirSync(LICENSES, { recursive: true });
  const sums: Record<string, string> = {};
  let failures = 0;
  for (const f of chosen) {
    try {
      for (const spec of f.files) {
        const { sum, fetched } = await ensureFile(spec, args.force);
        sums[spec.file] = sum;
        console.log(`  ${fetched ? 'fetched' : 'present'} ${spec.file}`);
      }
      const lic = new URL(`${f.id}.txt`, LICENSES);
      if (args.force || !existsSync(lic)) writeAtomic(lic, await fetchSource(f.licenceSrc));
    } catch (err) {
      failures++;
      console.error(`  FAILED ${f.id}: ${(err as Error).message}`);
    }
  }

  // every catalog file on disk, so the sums file describes fonts/ whatever this run fetched
  for (const f of CATALOG) for (const spec of f.files) {
    const p = new URL(spec.file, FONTS);
    if (!sums[spec.file] && existsSync(p)) sums[spec.file] = sha256(readFileSync(p));
  }
  const lines = Object.keys(sums).sort().map((file) => `${sums[file]}  ${file}`);
  writeFileSync(new URL('SUBSTITUTES.local.sha256', FONTS), lines.join('\n') + '\n');
  if (args.printSums) console.log(JSON.stringify(sums, null, 2));
  console.log(`fetch-fonts: done, ${Object.keys(sums).length} files recorded in fonts/SUBSTITUTES.local.sha256${failures ? `, ${failures} families failed` : ''}`);
  if (failures) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-fonts.ts')) await main();
