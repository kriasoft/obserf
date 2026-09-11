import { describe, expect, test } from "bun:test";
import { decodeEntities, plainText, truncate } from "../html";

describe("decodeEntities", () => {
  test("decodes named references", () => {
    expect(decodeEntities("Greptile &amp; CodeRabbit")).toBe("Greptile & CodeRabbit");
    expect(decodeEntities("&quot;quoted&quot; and &apos;quoted&apos;")).toBe(
      `"quoted" and 'quoted'`,
    );
  });

  test("decodes numeric references in both bases", () => {
    expect(decodeEntities("Workers&#x2F;D1, don&#39;t &#8212; and &#X2014; too")).toBe(
      "Workers/D1, don't — and — too",
    );
  });

  test("does not decode its own output", () => {
    expect(decodeEntities("&amp;#x27;")).toBe("&#x27;");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });

  test("leaves anything unreadable exactly as written", () => {
    expect(decodeEntities("&notarealentity; &#1114112; &#0; &#xD800; &amp")).toBe(
      "&notarealentity; &#1114112; &#0; &#xD800; &amp",
    );
    // A name an object lookup would have found on `Object.prototype`, putting a
    // JavaScript builtin into the assessment prompt.
    expect(decodeEntities("&constructor;")).toBe("&constructor;");
  });

  test("never builds a control character out of ASCII", () => {
    expect(decodeEntities("before &#27;[2J after")).toBe("before &#27;[2J after");
    expect(decodeEntities("&#7; &#8; &#127;")).toBe("&#7; &#8; &#127;");
    // C1, where an HTML parser would read `&#147;` as a quotation mark instead.
    expect(decodeEntities("&#128; &#147;")).toBe("&#128; &#147;");
  });

  test("never builds a bidirectional ordering control", () => {
    expect(decodeEntities("file &#8238;txt.exe &#x202E;")).toBe("file &#8238;txt.exe &#x202E;");
    // The joiner is not an ordering control, and an emoji needs it.
    expect(decodeEntities("&#x1F468;&#x200D;&#x1F4BB;")).toBe("\u{1F468}\u{200D}\u{1F4BB}");
  });

  test("decodes only the exact names in the table", () => {
    expect(decodeEntities("&Apos; &AMP; &NBSP;")).toBe("&Apos; &AMP; &NBSP;");
  });

  test("spells a non-breaking space the same way both ways", () => {
    expect(decodeEntities("a&nbsp;b&#160;c&#xA0;d")).toBe("a\u00a0b\u00a0c\u00a0d");
  });

  test("reads a reference above the BMP", () => {
    expect(decodeEntities("ship it &#x1F600; &#128512;")).toBe("ship it \u{1F600} \u{1F600}");
  });
});

describe("truncate", () => {
  test("does not split a surrogate pair at the cutoff", () => {
    const text = `${"x".repeat(6)}\u{1F600}`;
    expect(truncate(text, 7)).toBe("xxxxxx");
    expect(truncate(text, 8)).toBe(text);
    expect(truncate(text, 99)).toBe(text);
    expect(truncate("", 8)).toBe("");
  });
});

describe("plainText", () => {
  test("drops tags and flattens to one line", () => {
    expect(plainText("<p>one</p>\n<p>  two  </p>")).toBe("one two");
  });

  test("decodes after stripping, so quoted markup survives", () => {
    expect(plainText("use &lt;b&gt; here")).toBe("use <b> here");
  });

  test("collapses a non-breaking space like any other", () => {
    expect(plainText("a&nbsp;b &#160; c")).toBe("a b c");
  });

  test("nothing in, nothing out", () => {
    expect(plainText(null)).toBe("");
    expect(plainText(undefined)).toBe("");
    expect(plainText("   ")).toBe("");
  });
});
