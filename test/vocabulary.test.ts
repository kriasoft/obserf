import { describe, expect, test } from "bun:test";
import { OPPORTUNITY_TYPES, defaultKindFor } from "../vocabulary";

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
