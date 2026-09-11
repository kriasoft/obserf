import { describe, expect, test } from "bun:test";
import { routingConfiguredBy } from "../agent";

/**
 * ADR-008 strips the two Anthropic credentials so an exported key cannot switch
 * obserf onto API billing with no visible symptom. Variables that configure
 * model routing are reported rather than stripped, so an enterprise install
 * routed through Bedrock keeps working. These pin which variables count because
 * a warning that cries wolf is not read.
 */
describe("routingConfiguredBy", () => {
  test("an ordinary environment configures no routing", () => {
    expect(routingConfiguredBy({})).toBeNull();
    expect(routingConfiguredBy({ PATH: "/usr/bin", ANTHROPIC_MODEL: "x" })).toBeNull();
  });

  test("names a base URL and a unix socket, which each move a call alone", () => {
    expect(routingConfiguredBy({ ANTHROPIC_BASE_URL: "http://gateway.internal" })).toBe(
      "ANTHROPIC_BASE_URL",
    );
    expect(routingConfiguredBy({ ANTHROPIC_UNIX_SOCKET: "/tmp/claude.sock" })).toBe(
      "ANTHROPIC_UNIX_SOCKET",
    );
  });

  /**
   * Written out again rather than imported from `agent.ts`: the pairing is a
   * hand-maintained transcription of the SDK's own table, so it is the behaviour
   * and not an implementation detail. Sharing the constant would let a dropped
   * line pass as a provider that quietly stopped being reported.
   */
  const PROVIDER_ENDPOINTS = [
    ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_BASE_URL"],
    ["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"],
    ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
    ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_BASE_URL"],
    ["CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"],
    ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_BASE_URL"],
  ] as const;

  test.each(PROVIDER_ENDPOINTS)("%s carries %s, and only while it is on", (selection, endpoint) => {
    expect(routingConfiguredBy({ [selection]: "1" })).toBe(selection);
    // The half that hides: an expected switch read on its own leaves a stale
    // override unmentioned.
    expect(routingConfiguredBy({ [selection]: "1", [endpoint]: "https://gw.example" })).toBe(
      [selection, endpoint].sort().join(", "),
    );
    // Dead without its switch, so naming it would be the false alarm `=0` avoids.
    expect(routingConfiguredBy({ [endpoint]: "https://gw.example" })).toBeNull();
  });

  test("a switch is read the way the SDK reads it", () => {
    expect(routingConfiguredBy({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("CLAUDE_CODE_USE_BEDROCK");
    expect(routingConfiguredBy({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe("CLAUDE_CODE_USE_VERTEX");
    expect(routingConfiguredBy({ CLAUDE_CODE_USE_MANTLE: " On " })).toBe("CLAUDE_CODE_USE_MANTLE");
  });

  /**
   * JavaScript truthiness disagrees, and a warning about a provider that is not
   * in use is how the operator learns to skip the one that matters.
   */
  test("a switch that is turned off is not routing", () => {
    for (const value of ["0", "false", "no", "off", " "]) {
      expect(routingConfiguredBy({ CLAUDE_CODE_USE_BEDROCK: value })).toBeNull();
    }
  });

  /**
   * `CLAUDE_CODE_CUSTOM_OAUTH_URL` was on the list once, which is why it is
   * asserted here: it moves the token and console URLs, is allowlisted to
   * approved hosts, and no prompt follows it.
   */
  test("says nothing about what does not move the inference call", () => {
    expect(routingConfiguredBy({ ANTHROPIC_CUSTOM_HEADERS: "X-Test: 1" })).toBeNull();
    expect(routingConfiguredBy({ ANTHROPIC_IDENTITY_TOKEN_FILE: "/tmp/t" })).toBeNull();
    expect(
      routingConfiguredBy({ CLAUDE_CODE_CUSTOM_OAUTH_URL: "https://claude.example" }),
    ).toBeNull();
  });

  test("an empty value is not routing", () => {
    expect(routingConfiguredBy({ ANTHROPIC_BASE_URL: "" })).toBeNull();
    expect(routingConfiguredBy({ ANTHROPIC_BASE_URL: "  " })).toBeNull();
  });

  test("says nothing about the two credentials", () => {
    expect(
      routingConfiguredBy({ ANTHROPIC_API_KEY: "sk-x", ANTHROPIC_AUTH_TOKEN: "t" }),
    ).toBeNull();
  });
});
