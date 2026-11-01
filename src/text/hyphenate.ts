// Hyphenation points for Latin words: Liang's algorithm with the TeX en-us patterns (the `hyphen` package, ISC).
// Only all-lowercase Latin words get points: a capital (names, acronyms, a sentence's first word) or a digit
// anywhere means none. At least `min` characters (default 3) stay on each side of a point.
import createHyphenator from 'hyphen/hyphen.js';
import enUs from 'hyphen/patterns/en-us.js';

const SOFT = '\u00ad';
const WORD = /^[a-zß-öø-ÿ]+$/;
let hyphenator: ((s: string) => string) | null = null;
const cache = new Map<string, number[]>();

/** UTF-16 offsets into `word` where it may be broken with a hyphen, ascending. */
export function hyphenPoints(word: string, min = 3): number[] {
  if (word.length < 2 * min || !WORD.test(word)) return [];
  const key = `${min}:${word}`;
  let pts = cache.get(key);
  if (pts) return pts;
  hyphenator ??= createHyphenator(enUs, { hyphenChar: SOFT, minWordLength: 2 * min });
  const marked = hyphenator(word);
  pts = [];
  let k = 0;
  for (const ch of marked) {
    if (ch === SOFT) { if (k >= min && word.length - k >= min) pts.push(k); }
    else k += ch.length;
  }
  if (cache.size > 20000) cache.clear();
  cache.set(key, pts);
  return pts;
}
