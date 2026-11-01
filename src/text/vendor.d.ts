// Types for the `hyphen` package (ISC; Liang's algorithm with the TeX patterns), which ships none. Only the two
// modules src/text/hyphenate.ts imports.
declare module 'hyphen/hyphen.js' {
  type Options = { hyphenChar?: string; minWordLength?: number; exceptions?: string[] };
  const createHyphenator: (patterns: unknown, options?: Options) => (text: string, options?: Options) => string;
  export default createHyphenator;
}
declare module 'hyphen/patterns/en-us.js' {
  const patterns: unknown;
  export default patterns;
}
