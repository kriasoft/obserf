import { afterAll, describe, expect, spyOn, test } from "bun:test";
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// Capture call-site options: a spread can override the shared defaults.
// This spy checks the configuration contract, not live SDK tool availability.
const handedToTheSdk: Options[] = [];

// Restore the spy after this file so later tests can use the real SDK.
// Cast through `unknown`: the fake provides only the async stream consumed by
// the call sites, omitting the control methods required by the SDK Query type.
const capturedQuery = spyOn(sdk, "query").mockImplementation((({
  options,
}: {
  options: Options;
}) => {
  handedToTheSdk.push(options);
  return (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: "an answer" }] } };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      modelUsage: {},
      total_cost_usd: 0,
      structured_output: { ok: true },
    };
  })();
}) as unknown as typeof sdk.query);

afterAll(() => capturedQuery.mockRestore());

// Imported after the spy so `agent.ts` binds it.
const { ask, askForJson, emptyUsage, routingConfiguredBy } = await import("../agent");

async function optionsOfEveryCall(): Promise<Options[]> {
  handedToTheSdk.length = 0;
  await ask("a system prompt", "a prompt", emptyUsage());
  await askForJson("a system prompt", "a prompt", z.object({ ok: z.boolean() }), emptyUsage());
  return handedToTheSdk;
}

const calls = await optionsOfEveryCall();

describe("ADR-008: the options every model call carries", () => {
  // Strict mode still permits explicitly supplied servers, so check both.
  test("exposes no built-in or MCP tools", () => {
    expect(calls.map((call) => call.tools)).toEqual([[], []]);
    expect(calls.map((call) => call.strictMcpConfig)).toEqual([true, true]);
    expect(calls.map((call) => Object.keys(call.mcpServers ?? {}))).toEqual([[], []]);
  });

  test("loads none of the operator's own settings", () => {
    expect(calls.map((call) => call.settingSources)).toEqual([[], []]);
  });

  test("allows the turns structured output needs", () => {
    expect(calls.map((call) => call.maxTurns)).toEqual([4, 4]);
  });

  // Compare the whole environment: it replaces inheritance, so unrelated
  // variables (including enterprise routing) must survive credential removal.
  test("hands the subprocess every variable except the two that change billing", async () => {
    const injected = {
      ANTHROPIC_API_KEY: "sk-should-not-travel",
      ANTHROPIC_AUTH_TOKEN: "token-should-not-travel",
      ANTHROPIC_BASE_URL: "http://gateway.internal",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.internal",
    };
    const before = Object.fromEntries(
      Object.keys(injected).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, injected);
    try {
      const expected: Record<string, string | undefined> = { ...process.env };
      delete expected.ANTHROPIC_API_KEY;
      delete expected.ANTHROPIC_AUTH_TOKEN;
      const sent = await optionsOfEveryCall();
      expect(sent.map((call) => call.env)).toEqual([expected, expected]);
    } finally {
      // Key by key: assigning a copy back to `process.env` leaves `Bun.env`
      // holding these, and a fake credential must not outlive the test.
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

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
