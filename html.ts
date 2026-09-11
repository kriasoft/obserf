/**
 * Other people's markup, turned into text obserf can read.
 *
 * Two places need it and they want different things: a source adapter flattens a
 * snippet to one line, and draft-time retrieval keeps a thread's paragraphs. Only
 * the decoding is shared; whitespace policy belongs to whoever is going to read
 * the result.
 *
 * Keep it importing nothing, so reaching for it costs a caller no dependencies.
 */

/** Common references found in prose; unknown names remain visible rather than being guessed. */
const NAMED = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  // Preserve the named character; callers decide which whitespace survives.
  ["nbsp", "\u00a0"],
  ["mdash", "—"],
  ["ndash", "–"],
  ["hellip", "…"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
]);

/**
 * Character references decoded in one pass: numeric, and the names in `NAMED`.
 * Anything else is left exactly as written.
 */
export function decodeEntities(text: string): string {
  // One pass, not a chain of replacements, because a chain decodes its own
  // output: `&amp;#x27;` is the literal text `&#x27;`, and turning `&amp;` into
  // `&` before sweeping for numeric references makes it an apostrophe nobody
  // wrote.
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, reference: string) => {
    if (!reference.startsWith("#")) return NAMED.get(reference) ?? whole;

    const digits = reference.slice(1);
    const point = Number(digits[0]?.toLowerCase() === "x" ? `0${digits}` : digits);
    // Preserve invalid references rather than inventing replacement text. Controls
    // stay literal because source text is printed directly to the terminal.
    const control = point <= 0x1f || (point >= 0x7f && point <= 0x9f);
    // Refuse only bidirectional ordering controls; other format characters, such
    // as the zero-width joiner used in emoji, remain valid prose.
    const bidi =
      point === 0x061c ||
      (point >= 0x200e && point <= 0x200f) ||
      (point >= 0x202a && point <= 0x202e) ||
      (point >= 0x2066 && point <= 0x2069);
    const readable =
      Number.isInteger(point) &&
      point > 0 &&
      point <= 0x10ffff &&
      !(point >= 0xd800 && point <= 0xdfff) &&
      !control &&
      !bidi;
    return readable ? String.fromCodePoint(point) : whole;
  });
}

/**
 * A snippet as one line of text: tags removed, references decoded, every run of
 * whitespace collapsed to a single space.
 *
 * Tags go first. A decoded `&lt;b&gt;` is text the author typed, and stripping
 * after decoding would delete the thing they were quoting.
 */
export function plainText(input: string | null | undefined): string {
  if (!input) return "";
  return decodeEntities(input.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** The first `limit` UTF-16 code units, without splitting a surrogate pair. */
export function truncate(text: string, limit: number): string {
  const cut = text.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}
