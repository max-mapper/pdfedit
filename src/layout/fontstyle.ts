// Font names → weight. Shared by detection (a line's boldness) and the model (a run's bold flag), so both agree.
//
// Japanese foundries name weights W1–W9 (W6 and up is bold) or with letter codes (L, R, M, DB,
// B, EB, H, U); Latin families spell them out (Bold, SemiBold, DemiBold, ExtraBold, Heavy, Black). Medium and
// DemiLight/SemiLight are not bold. Letter codes count only as a whole name part ('RodinPro-DB'), never inside a word
// ('GothicBBBPro-Medium' is Medium), and 'H'/'V' are never read as weights (they end CMap names: '-90ms-RKSJ-H').

const BOLD_WORD = /(?:extra|ultra|semi|demi)?bold|black|heavy/i;
const LIGHT_WORD = /(?:semi|demi)light/i;
const BOLD_PART = new Set(['DB', 'B', 'EB', 'XB', 'UB', 'BD', 'BLK', 'HV', 'SB', 'W6', 'W7', 'W8', 'W9', 'W10', 'W11', 'W12']);

/** True when a font's name says bold (a PDF BaseFont, with or without a subset prefix). */
export function isBoldFontName(name: string): boolean {
  if (!name) return false;
  const n = name.replace(/^[A-Z]{6}\+/, '');
  if (BOLD_WORD.test(n.replace(LIGHT_WORD, ''))) return true;
  for (const part of n.split(/[-_,+ ]+/)) if (BOLD_PART.has(part.toUpperCase())) return true;
  // a weight code glued to the family: 'HiraKakuStd-W8' is split above; 'ShinGoProW6' / 'FOTRodinProDB' here
  return /(?:^|[a-z])(?:W(?:[6-9]|1[0-2])|DB|EB|UB)$/.test(n);
}

/** True when a character is set bold: PDFium's weight (≥ 600), the font name, or the descriptor's ForceBold flag. */
export function isBoldChar(c: { fontName: string; weight: number; fontFlags: number }): boolean {
  return c.weight >= 600 || isBoldFontName(c.fontName) || (c.fontFlags >= 0 && (c.fontFlags & (1 << 18)) !== 0);
}
