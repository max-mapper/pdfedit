// Builds the editor app (app/) for embedding in a host page (docs/EMBED.md): Vite mode 'embed', so the substitution
// catalogue is left out of the bundle (the host serves it, ?fonts=<base>) while the three default fonts, PDFium's and
// HarfBuzz's WASM and the worker stay in. Prints the files written with their sizes.
//   node scripts/build-embed.mjs <outDir> [--base /pdf-editor/]
// The base is the path the host serves the folder at (default /pdf-editor/). The output folder must be empty, absent
// or an earlier build (index.html and assets/ only): it is emptied first. The pdfedit commit (git, "-dirty" when the
// tree has changes) is built in as VITE_PDFEDIT_COMMIT and written into saved states and export reports.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let outDir = null;
let base = '/pdf-editor/';
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--base') base = args[++i];
  else if (a.startsWith('--base=')) base = a.slice(7);
  else if (!a.startsWith('-') && !outDir) outDir = a;
  else { console.error(`build-embed: unknown argument ${a}`); process.exit(2); }
}
if (!outDir || !base) { console.error('usage: node scripts/build-embed.mjs <outDir> [--base /pdf-editor/]'); process.exit(2); }
if (!base.endsWith('/')) base += '/';
const out = resolve(outDir);

// the folder is emptied by the build: refuse one that holds anything but an earlier build
if (existsSync(out)) {
  const extra = readdirSync(out).filter((f) => f !== 'index.html' && f !== 'assets');
  if (extra.length) { console.error(`build-embed: ${out} holds other files (${extra.slice(0, 5).join(', ')}); give an empty folder or an earlier build`); process.exit(2); }
}

const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' }).trim();
let commit = 'unknown';
try { commit = git('rev-parse', '--short=12', 'HEAD') + (git('status', '--porcelain', '--untracked-files=no') ? '-dirty' : ''); } catch { /* not a git checkout */ }
process.env.VITE_PDFEDIT_COMMIT = commit;

await build({
  configFile: join(root, 'app', 'vite.config.ts'),
  mode: 'embed',
  base,
  logLevel: 'warn',
  build: { outDir: out, emptyOutDir: true },
});

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else files.push({ path: relative(out, p), bytes: statSync(p).size });
  }
};
walk(out);
const human = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} kB` : `${n} B`);
const w = Math.max(...files.map((f) => f.path.length));
for (const f of files) console.log(`${f.path.padEnd(w)}  ${human(f.bytes).padStart(10)}`);
const total = files.reduce((k, f) => k + f.bytes, 0);
console.log(`${files.length} files, ${human(total)} (base ${base}, pdfedit ${commit}) in ${out}`);

// the bundle's fonts are the three defaults only
const fonts = files.filter((f) => /\.(ttf|otf)$/i.test(f.path)).map((f) => f.path.replace(/^.*\//, ''));
const defaults = ['NotoSans-Regular', 'NotoSans-Bold', 'NotoSansJP-VF'];
const unexpected = fonts.filter((f) => !defaults.some((d) => f.startsWith(`${d}-`) || f === `${d}.ttf`));
if (unexpected.length || fonts.length !== defaults.length) {
  console.error(`build-embed: the bundle's fonts should be the three defaults; found ${fonts.join(', ') || 'none'}`);
  process.exit(1);
}
