/**
 * URL canonicalization. The canonical form is the dedupe key for findings, so
 * two sources returning the same thread with different tracking parameters must
 * collapse to one row.
 */

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_[ce]id$|ref$|ref_src$|source$|si$)/i;

/**
 * Normalizes scheme, host, tracking parameters, and trailing slash.
 * Returns the input unchanged if it does not parse — a malformed URL is still a
 * stable dedupe key, and dropping the candidate here would hide a source bug.
 */
export function canonicalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return raw.trim();
  }

  url.protocol = url.protocol === "http:" ? "https:" : url.protocol;
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  // Trailing slash on a path is not a distinct resource; on the root it is the
  // canonical form, so `example.com/` and `example.com` both keep one slash.
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** Registrable-ish host for blocklist matching and display. */
export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}
