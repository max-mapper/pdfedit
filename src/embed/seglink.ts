// The host's link to a segment (the frame's ?seglink=): a URL template where every `{seg}` is replaced by the
// URL-encoded segment id. The template must hold `{seg}` and be a path on the frame's origin (`/…`, not `//…`) or an
// absolute http(s) URL on that origin. Pure: no I/O, Node and the browser.

/** Checks a template against the frame's URL `href`: the template as given (null when there is none), or an error. */
export function segLinkTemplate(value: string | null, href: string): { template: string | null } | { error: string } {
  if (!value) return { template: null };
  if (!value.includes('{seg}')) return { error: 'the segment link needs {seg} where the segment id goes' };
  if (!/^\/(?![/\\])/.test(value) && !/^https?:\/\//i.test(value)) return { error: 'the segment link must be a path starting with / or a URL on this page\'s origin' };
  try {
    if (new URL(value.replaceAll('{seg}', 'x'), href).origin !== new URL(href).origin) return { error: 'the segment link must be on this page\'s own origin' };
  } catch { return { error: 'the segment link is not a URL' }; }
  return { template: value };
}

/** A segment's link from a template: every `{seg}` replaced by the URL-encoded id. */
export const segLinkFor = (template: string, seg: string): string => template.replaceAll('{seg}', encodeURIComponent(seg));
