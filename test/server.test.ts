import { describe, expect, test } from "bun:test";
import { db, schema } from "../db";
import {
  addressedToThisMachine,
  findingIdIn,
  intParam,
  projectParam,
  unexpectedParams,
} from "../web/server";

/** The inbox's own controls produce only valid values; these are hand-typed URLs. */
describe("findingIdIn", () => {
  test("accepts a positive whole number", () => {
    expect(findingIdIn({ id: "31" })).toBe(31);
  });

  /** Past 2^53 the parsed id is no longer the digits typed, so it names nothing. */
  test("refuses an id it could not represent", () => {
    expect(findingIdIn({ id: "99999999999999999999" })).toBeInstanceOf(Response);
  });

  test("refuses anything that is not one", () => {
    // `Number` would read the last three as 1000, 16 and 5.
    for (const id of ["abc", "", "1.5", "-3", "0", "1e3abc", "Infinity", "1e3", "0x10", " 5"]) {
      const answer = findingIdIn({ id });
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(400);
    }
  });
});

describe("intParam", () => {
  const url = (query: string) => new URL(`http://localhost/api/findings${query}`);

  test("absent means the default, which is not a failure", () => {
    expect(intParam(url(""), "min", 1, 0)).toBe(1);
  });

  test("a whole number at or above the floor passes", () => {
    expect(intParam(url("?min=0"), "min", 1, 0)).toBe(0);
    expect(intParam(url("?limit=200"), "limit", 100, 1)).toBe(200);
  });

  /** NaN compared against a score excludes everything, and says nothing. */
  test("refuses what is not a whole number, or is below the floor", () => {
    for (const [query, name, floor] of [
      ["?min=abc", "min", 0],
      ["?min=-1", "min", 0],
      ["?min=1.5", "min", 0],
      ["?limit=0", "limit", 1],
      ["?limit=-5", "limit", 1],
      ["?limit=1e20", "limit", 1],
      // `Number("")` is 0: given and blank is not the default.
      ["?min=", "min", 0],
      ["?min=%20%20", "min", 0],
    ] as const) {
      const answer = intParam(url(query), name, 1, floor);
      expect(answer).toBeInstanceOf(Response);
      expect((answer as Response).status).toBe(400);
    }
  });
});

/** Measured before this check: a GET with `Host: attacker.example` read the findings. */
describe("addressedToThisMachine", () => {
  const withHost = (host: string | null) =>
    addressedToThisMachine(
      new Request("http://127.0.0.1:4000/api/findings", {
        headers: host === null ? {} : { Host: host },
      }),
    );

  test("accepts the names that mean this machine", () => {
    for (const host of ["127.0.0.1:4000", "localhost:4000", "127.0.0.1", "localhost"]) {
      expect(withHost(host)).toBe(true);
    }
  });

  /** Host names are case-insensitive; the allowlist has to be too. */
  test("is not case-sensitive", () => {
    expect(withHost("LocalHost:4000")).toBe(true);
  });

  test("refuses a name nobody here owns", () => {
    for (const host of [
      "attacker.example",
      "attacker.example:4000",
      "obserf.com",
      "0.0.0.0:4000",
      // Other loopback spellings are deliberately outside the allowlist: the
      // server advertises 127.0.0.1 and supports ordinary `localhost`.
      "[::1]:4000",
      "[0:0:0:0:0:0:0:1]",
      "[::ffff:127.0.0.1]",
      "localhost.",
      "127.0.0.1.",
    ]) {
      expect(withHost(host)).toBe(false);
    }
  });

  /** HTTP/1.1 requires `Host`; a request without one is neither a browser nor the CLI. */
  test("refuses a request that names no host at all", () => {
    expect(withHost(null)).toBe(false);
  });

  /** A loopback name is not a prefix of somebody else's domain. */
  test("does not match a lookalike", () => {
    expect(withHost("localhost.attacker.example")).toBe(false);
    expect(withHost("127.0.0.1.attacker.example")).toBe(false);
  });

  /** The whole authority, not its prefix. */
  test("refuses a loopback name followed by anything but a port", () => {
    for (const host of [
      "localhost:junk",
      "localhost@attacker.example",
      "localhostx",
      "localhost:99999",
    ]) {
      expect(withHost(host)).toBe(false);
    }
  });
});

/**
 * An empty key would widen the query to every project rather than narrow it to
 * none, and a 200 with everything in it reads as a working filter.
 */
describe("projectParam", () => {
  const at = (query: string) => new URL(`http://127.0.0.1:4000/api/findings${query}`);
  const profiles = [{ key: "live" }];

  test("no parameter is no filter", () => {
    expect(projectParam(at(""), profiles)).toBeUndefined();
  });

  test("a profile's own key passes", () => {
    expect(projectParam(at("?project=live"), profiles)).toBe("live");
  });

  /** A workspace outlives its profiles, and its scan history stays readable. */
  test("a key only the database knows passes", () => {
    db.insert(schema.runs)
      .values({ project: "retired", startedAt: new Date(), sources: ["hn"] })
      .run();
    expect(projectParam(at("?project=retired"), profiles)).toBe("retired");
  });

  test("an unknown key is refused, not answered with an empty list", async () => {
    const response = projectParam(at("?project=nope"), profiles);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(400);
    expect(await (response as Response).json()).toEqual({ error: 'Unknown project "nope"' });
  });

  /** Given and empty is not absent: it asked for something no project is. */
  test("an empty key is refused rather than widening the query", () => {
    expect(projectParam(at("?project="), profiles)).toBeInstanceOf(Response);
  });
});

describe("unexpectedParams", () => {
  const check = (query: string) =>
    unexpectedParams(new URL(`http://127.0.0.1:4000/api/findings${query}`), ["project", "min"]);

  test("passes the keys the route reads, once each", () => {
    expect(check("?project=a&min=1")).toBeNull();
  });

  /** Ignored, a misspelled filter answers as if none had been asked for. */
  test("refuses a key the route does not read", () => {
    expect(check("?projec=a")?.status).toBe(400);
  });

  /** `get` would silently take the first. */
  test("refuses a key given twice", () => {
    expect(check("?min=10&min=banana")?.status).toBe(400);
  });
});
