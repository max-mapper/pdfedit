// Which characters of an edited text are the original's: the keep-source-lines layout (layout.ts layoutSourceLines)
// keeps a source line where it was while its characters are unchanged. The common prefix and suffix are matched
// first (one keystroke is one local change); the middle is matched by a longest common subsequence over tokens (words,
// single CJK characters, single other characters), and the characters between matched tokens by an LCS over
// characters when that is small. UTF-16 offsets.

export type TextMap = {
  /** Per offset of the new text: the offset of the same character in the old text, or -1 (inserted or changed). */
  n2o: Int32Array;
  /** Per offset of the old text: its offset in the new text, or -1 (deleted or changed). */
  o2n: Int32Array;
  /** Characters matched. */
  matched: number;
};

const MAX_CELLS = 4e6;
const MAX_CHAR_CELLS = 40000;

export function mapText(oldT: string, newT: string): TextMap {
  const n2o = new Int32Array(newT.length).fill(-1);
  const o2n = new Int32Array(oldT.length).fill(-1);
  let matched = 0;
  const link = (o: number, n: number) => { n2o[n] = o; o2n[o] = n; matched++; };
  let a = 0;
  const lim = Math.min(oldT.length, newT.length);
  while (a < lim && oldT.charCodeAt(a) === newT.charCodeAt(a)) a++;
  let z = 0;
  while (z < lim - a && oldT.charCodeAt(oldT.length - 1 - z) === newT.charCodeAt(newT.length - 1 - z)) z++;
  for (let i = 0; i < a; i++) link(i, i);
  for (let i = 0; i < z; i++) link(oldT.length - 1 - i, newT.length - 1 - i);
  const o0 = a, o1 = oldT.length - z, n0 = a, n1 = newT.length - z;
  if (o1 > o0 && n1 > n0) {
    const A = tokens(oldT, o0, o1), B = tokens(newT, n0, n1);
    const pairs = lcs(A.length, B.length, (i, j) => A[i].text === B[j].text);
    let pi = o0, pj = n0;
    const gap = (oa: number, ob: number, na: number, nb: number) => {
      if (ob <= oa || nb <= na || (ob - oa) * (nb - na) > MAX_CHAR_CELLS) return;
      for (const [i, j] of lcs(ob - oa, nb - na, (i, j) => oldT.charCodeAt(oa + i) === newT.charCodeAt(na + j)) ?? []) link(oa + i, na + j);
    };
    if (pairs) {
      for (const [i, j] of pairs) {
        const ta = A[i], tb = B[j];
        gap(pi, ta.start, pj, tb.start);
        for (let k = 0; k < ta.text.length; k++) link(ta.start + k, tb.start + k);
        pi = ta.start + ta.text.length;
        pj = tb.start + tb.text.length;
      }
    }
    gap(pi, o1, pj, n1);
  }
  return { n2o, o2n, matched };
}

type Tok = { start: number; text: string };

function tokens(t: string, from: number, to: number): Tok[] {
  const out: Tok[] = [];
  const re = /[\p{L}\p{N}]+|[\s\S]/gu;
  re.lastIndex = from;
  const part = t.slice(0, to);
  let m: RegExpExecArray | null;
  while ((m = re.exec(part))) {
    const w = m[0];
    // CJK text has no spaces: each character is a token of its own
    if (w.length > 1 && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)) {
      let k = m.index;
      for (const ch of w) { out.push({ start: k, text: ch }); k += ch.length; }
    } else out.push({ start: m.index, text: w });
  }
  return out;
}

/** Matched index pairs of a longest common subsequence (DP over n × m cells), or null when too large. */
function lcs(n: number, m: number, eq: (i: number, j: number) => boolean): [number, number][] | null {
  if (!n || !m) return [];
  if (n * m > MAX_CELLS) return null;
  const W = m + 1;
  const L = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = eq(i, j) ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
  }
  const out: [number, number][] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(i, j) && L[i * W + j] === L[(i + 1) * W + j + 1] + 1) { out.push([i, j]); i++; j++; }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) i++;
    else j++;
  }
  return out;
}
