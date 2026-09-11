import { describe, expect, test } from "bun:test";
import { canonicalizeUrl, hostOf } from "../url";

describe("canonicalizeUrl", () => {
  test("upgrades http, lowercases the host, and drops www", () => {
    expect(canonicalizeUrl("http://WWW.Example.com/Path")).toBe("https://example.com/Path");
  });

  test("strips tracking parameters but keeps meaningful ones", () => {
    expect(canonicalizeUrl("https://example.com/a?utm_source=x&id=7&fbclid=y")).toBe(
      "https://example.com/a?id=7",
    );
  });

  test("sorts query parameters so ordering does not create a second row", () => {
    expect(canonicalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      canonicalizeUrl("https://example.com/a?a=1&b=2"),
    );
  });

  test("drops the fragment", () => {
    expect(canonicalizeUrl("https://example.com/a#section")).toBe("https://example.com/a");
  });

  test("removes a trailing slash on a path but keeps the root one", () => {
    expect(canonicalizeUrl("https://example.com/a/")).toBe("https://example.com/a");
    expect(canonicalizeUrl("https://example.com")).toBe("https://example.com/");
  });

  test("returns an unparseable url unchanged rather than dropping the candidate", () => {
    expect(canonicalizeUrl("  not a url  ")).toBe("not a url");
  });
});

describe("hostOf", () => {
  test("returns the bare host", () => {
    expect(hostOf("https://www.Reddit.com/r/golang/comments/1")).toBe("reddit.com");
  });

  test("returns an empty string for garbage, so blocklist checks cannot throw", () => {
    expect(hostOf("nonsense")).toBe("");
  });
});
