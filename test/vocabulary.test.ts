import { describe, expect, test } from "bun:test";
import { OPPORTUNITY_TYPES, compactAge, defaultKindFor, draftContextNote } from "../vocabulary";

describe("defaultKindFor", () => {
  test("a curated list takes a submission, not a comment", () => {
    expect(defaultKindFor("listing")).toBe("submission");
  });

  test("a direct question and an existing mention are replied to", () => {
    expect(defaultKindFor("question")).toBe("reply");
    expect(defaultKindFor("mention")).toBe("reply");
  });

  test("threads take a top-level comment", () => {
    expect(defaultKindFor("discussion")).toBe("comment");
    expect(defaultKindFor("comparison")).toBe("comment");
  });

  // No case for a missing opportunity type: the signature does not accept one,
  // because "the model named no moment to act on" has no natural draft. Each
  // caller decides what to do instead, and the compiler makes them.
  test("every opportunity type maps to something — a new type cannot fall through", () => {
    for (const type of OPPORTUNITY_TYPES) {
      expect(["comment", "reply", "submission"]).toContain(defaultKindFor(type));
    }
  });
});

describe("defaultKindFor, for a comment inside a thread", () => {
  test("prefers a reply over a standalone comment", () => {
    expect(defaultKindFor("discussion")).toBe("comment");
    expect(defaultKindFor("discussion", true)).toBe("reply");
    expect(defaultKindFor("comparison", true)).toBe("reply");
  });

  test("never overrides a listing", () => {
    expect(defaultKindFor("listing", true)).toBe("submission");
  });

  test("an unknown shape keeps the type's own default", () => {
    expect(defaultKindFor("discussion", null)).toBe("comment");
    expect(defaultKindFor("discussion", undefined)).toBe("comment");
    expect(defaultKindFor("discussion", false)).toBe("comment");
  });
});

/**
 * A draft from a 300-character search description must never read like one
 * written from the whole thread, and one from before provenance was recorded is
 * unknown rather than fine.
 */
describe("draftContextNote", () => {
  test("only a whole live read is complete", () => {
    expect(draftContextNote("hn-algolia", null)).toEqual({
      text: "written from content fetched at draft time (Hacker News via Algolia)",
      complete: true,
    });
    expect(draftContextNote("page", "12 replies not fetched").complete).toBe(false);
  });

  test("the excerpt says so, with why", () => {
    expect(draftContextNote("excerpt", "GitHub returned 404")).toEqual({
      text: "written from the stored excerpt only — GitHub returned 404",
      complete: false,
    });
  });

  test("an unrecorded source is not presented as fine", () => {
    expect(draftContextNote(null, null)).toMatchObject({ complete: false });
    expect(draftContextNote(null, null).text).toContain("not recorded");
  });
});

describe("compactAge", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  test("steps up a unit as the number grows, rounding down", () => {
    expect(compactAge(ago(5), now)).toBe("5h");
    expect(compactAge(ago(24 * 13.9), now)).toBe("13d");
    expect(compactAge(ago(24 * 14), now)).toBe("2w");
    expect(compactAge(ago(24 * 69), now)).toBe("9w");
    expect(compactAge(ago(24 * 70), now)).toBe("2mo");
    expect(compactAge(ago(24 * 729), now)).toBe("23mo");
    expect(compactAge(ago(24 * 730.2), now)).toBe("23mo");
    expect(compactAge(ago(24 * 800), now)).toBe("2y");
  });

  test("an unknown date is said, and a future one is not negative", () => {
    expect(compactAge(null, now)).toBe("?");
    expect(compactAge(ago(-3), now)).toBe("0h");
  });

  /** The inbox receives dates as JSON strings. */
  test("accepts the serialized form", () => {
    expect(compactAge(ago(48).toISOString(), now)).toBe("2d");
  });
});
