// Paragraphs to translation pairs, by source text. A host hands the editor a list of pairs (a source segment and its
// target, in document order); each paragraph pdfedit detected takes the target of the pair whose source is the same
// text, or the joined targets of a run of consecutive pairs whose sources together are the paragraph. Text is compared
// normalised (normalise): NFKC, no whitespace, no format or control characters, CJK punctuation and dashes folded to
// one form, leading list markers dropped, so text extracted from a PDF matches the same text from another tool.
//
// A paragraph with no letters (numbers, symbols, empty) is left alone and not listed; one with letters and no match
// is listed in `unmatched`. Each paragraph also gets the ids of the pairs its source matched (`ids`, the paragraph's
// segment link), whether or not their targets are empty.
//
// Duplicate sources (two pairs with the same source, or two runs that both spell the paragraph) are taken in reading
// order: a matcher remembers where its last match ended, across calls (pages are matched in order), and takes the
// first candidate after it; when there is none, the first candidate not used yet; when every one is used, the first.
// Pure: no I/O, Node and the browser.

export type Pair = { id: string; source: string; target: string };
export type MatchResult = {
  /** Per paragraph: the translation, or null (no match, or the matched targets are empty). */
  translations: (string | null)[];
  /** Per paragraph: the ids of the pairs its source matched (one, or a run), or null (no match). */
  ids: (string[] | null)[];
  /** Ids of the pairs used, in the order first used. */
  used: string[];
  /** Indices of the paragraphs that hold letters and found no translation. */
  unmatched: number[];
};

// CJK and full-width punctuation that NFKC leaves as it is, folded to one ASCII form
const FOLD: Record<string, string> = {
  '。': '.', '｡': '.', '、': ',', '､': ',', '・': '·', '･': '·',
  '「': '"', '」': '"', '『': '"', '』': '"', '“': '"', '”': '"', '„': '"', '″': '"', '〝': '"', '〟': '"',
  '‘': "'", '’': "'", '′': "'",
  '〈': '<', '〉': '>', '《': '<', '》': '>', '【': '[', '】': ']', '〔': '[', '〕': ']', '［': '[', '］': ']',
  '〜': '~', '～': '~', '〰': '~',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-', '﹣': '-', '－': '-',
  '…': '...', '‥': '..',
};
const FOLD_RE = new RegExp(`[${Object.keys(FOLD).join('')}]`, 'gu');
const MARKER_RE = /^[•●○■□◆◇▶►‣▪◦※·]+/u;
const DROP_RE = /[\s\p{Cc}\p{Cf}]/gu;
const LETTER_RE = /\p{L}/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;

/** The form texts are compared in. */
export function normalise(text: string): string {
  return text.normalize('NFKC').replace(DROP_RE, '').replace(FOLD_RE, (c) => FOLD[c]).replace(MARKER_RE, '');
}

/** Targets of a run of pairs as one text: a space between two parts unless either side of the join is CJK. */
export function joinTargets(parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const t = raw.trim();
    if (!t) continue;
    if (out && !CJK_RE.test(out[out.length - 1]) && !CJK_RE.test(t[0])) out += ' ';
    out += t;
  }
  return out;
}

export type Matcher = { match(paragraphs: string[]): MatchResult };

/** Indexes the pairs once; `match` can then run page by page, in reading order. */
export function createMatcher(pairs: Pair[]): Matcher {
  const norm = pairs.map((p) => normalise(p.source));
  const exact = new Map<string, number[]>();     // a normalised source -> every pair index with it, in order
  const byFirst = new Map<string, number[]>();   // first code point of a non-empty source -> pair indices, in order
  norm.forEach((s, i) => {
    if (!s) return;
    let same = exact.get(s);
    if (!same) exact.set(s, (same = []));
    same.push(i);
    const k = String.fromCodePoint(s.codePointAt(0)!);
    let list = byFirst.get(k);
    if (!list) byFirst.set(k, (list = []));
    list.push(i);
  });
  let last = -1;                                  // the last pair index of the previous match
  const taken = new Set<number>();                // pair indices matched so far, by any call

  /** The first run of two or more consecutive pairs from `i` whose sources, joined, are `p` (pairs with an empty
   *  source inside the run are skipped over). */
  const runFrom = (i: number, p: string): number[] | null => {
    const run: number[] = [];
    let at = 0;
    for (let j = i; j < pairs.length && at < p.length; j++) {
      const s = norm[j];
      if (!s) continue;
      if (!p.startsWith(s, at)) return null;
      run.push(j);
      at += s.length;
    }
    return at === p.length && run.length > 1 ? run : null;
  };

  /** Of the candidates (pair index lists, in document order): the first after the last match, else the first not
   *  used yet, else the first. */
  const pick = (cands: number[][]): number[] | null => {
    if (!cands.length) return null;
    return cands.find((c) => c[0] > last) ?? cands.find((c) => c.every((i) => !taken.has(i))) ?? cands[0];
  };

  return {
    match(paragraphs) {
      const translations: (string | null)[] = [];
      const ids: (string[] | null)[] = [];
      const used: string[] = [];
      const seen = new Set<string>();
      const unmatched: number[] = [];
      paragraphs.forEach((text, k) => {
        const p = normalise(text);
        let hit: number[] | null = null;
        if (p) {
          const same = exact.get(p);
          if (same) hit = pick(same.map((i) => [i]));
          else {
            const starts = byFirst.get(String.fromCodePoint(p.codePointAt(0)!)) ?? [];
            const runs: number[][] = [];
            for (const i of starts) {
              if (norm[i].length >= p.length) continue;
              const r = runFrom(i, p);
              if (r) runs.push(r);
            }
            hit = pick(runs);
          }
        }
        if (hit) {
          last = hit[hit.length - 1];
          for (const i of hit) taken.add(i);
        }
        ids.push(hit ? hit.map((i) => pairs[i].id) : null);
        const t = hit ? joinTargets(hit.map((i) => pairs[i].target)) : '';
        translations.push(t ? t : null);
        if (t) {
          for (const i of hit!) { const id = pairs[i].id; if (!seen.has(id)) { seen.add(id); used.push(id); } }
        } else if (LETTER_RE.test(p)) unmatched.push(k);
      });
      return { translations, ids, used, unmatched };
    },
  };
}

/** Matches paragraphs to pairs (see the header). */
export function matchPairs(paragraphs: string[], pairs: Pair[]): MatchResult {
  return createMatcher(pairs).match(paragraphs);
}
