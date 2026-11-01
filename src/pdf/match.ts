// Matching PDFium's text objects to text-showing operators when they do not map one to one (the
// decoded string is the tie-breaker). Both lists are in content order; an operator PDFium skipped (a Tj with no
// font, for instance) has no object, and an object we could not see the operator of (a form we could not decode) has
// no operator. Each object takes the first operator ahead of the previous match whose decoded text and start position
// agree with it; anything left over is unmatched, and a box that needs it is refused.

export type ObjectKey = {
  inForm: boolean;
  text: string; // PDFium's object text (it may end with one character of PDFium's own)
  fontName: string; // PDFium's base font name
  matrix: number[]; // PDFium's object matrix: e, f are the text origin (rise included) in the object's space
  origin: [number, number] | null; // the first character's origin, page space
  size: number; // effective font size (points), for the position tolerance
};

export type SiteKey = {
  inForm: boolean;
  text: string | null; // the operator's codes decoded through ToUnicode or the encoding; null when unknown
  baseFont: string; // the font resource's /BaseFont ('' when unknown)
  objPos: [number, number]; // tm × ctm applied to (0, rise): the same space as the object's matrix
  pagePos: [number, number]; // the same point in page space
  exact: boolean; // the tracked text matrix is exact (every earlier advance on the line was computed)
};

export type MatchResult = { site: (number | null)[]; matched: number; unmatched: number[] };

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
const stripSubset = (n: string) => n.replace(/^[A-Z]{6}\+/, '');

/** null: cannot tell; true or false otherwise. */
export function textAgrees(obj: ObjectKey, site: SiteKey): boolean | null {
  if (site.text === null) return null;
  const t = norm(site.text);
  if (!t) return null; // only white space: says nothing
  const o = norm(obj.text);
  const cps = [...obj.text];
  const trimmed = norm(cps.slice(0, -1).join(''));
  return t === o || t === trimmed;
}

export function positionAgrees(obj: ObjectKey, site: SiteKey): boolean | null {
  if (!site.exact) return null;
  const tol = Math.max(1, 0.25 * (obj.size || 0));
  const e = obj.matrix[4], f = obj.matrix[5];
  if (Number.isFinite(e) && Number.isFinite(f) && Math.hypot(site.objPos[0] - e, site.objPos[1] - f) <= tol) return true;
  if (obj.origin && Math.hypot(site.pagePos[0] - obj.origin[0], site.pagePos[1] - obj.origin[1]) <= tol) return true;
  return false;
}

/**
 * For each object, the index of its operator in `sites`, or null. An object matches an operator when they are in the
 * same kind of stream (page or form), their fonts agree, and either the text agrees (and the position does not
 * disagree) or the position agrees (and the text does not disagree). The search runs forward from the last match,
 * up to `window` operators ahead.
 */
export function matchObjects(objs: ObjectKey[], sites: SiteKey[], window = 256): MatchResult {
  const site: (number | null)[] = [];
  const unmatched: number[] = [];
  let p = 0;
  let matched = 0;
  objs.forEach((o, i) => {
    let found: number | null = null;
    for (let j = p; j < Math.min(sites.length, p + window); j++) {
      const s = sites[j];
      if (s.inForm !== o.inForm) continue;
      const a = stripSubset(o.fontName), b = stripSubset(s.baseFont);
      if (a && b && a !== b) continue;
      const t = textAgrees(o, s);
      const q = positionAgrees(o, s);
      if ((t === true && q !== false) || (q === true && t !== false)) {
        found = j;
        break;
      }
    }
    site.push(found);
    if (found === null) unmatched.push(i);
    else {
      matched++;
      p = found + 1;
    }
  });
  return { site, matched, unmatched };
}
