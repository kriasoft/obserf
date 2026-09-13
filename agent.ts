/**
 * Model access through the Claude Agent SDK — Claude Code as a library, using
 * the same subscription credentials the `claude` CLI already holds.
 *
 * See docs/adr/008-claude-code-subscription.md. Model calls use no API key.
 */

import { query, type Options, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { config } from "./config";

export interface Usage {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** List-price estimate from the SDK. On a subscription nothing is billed per call. */
  estimatedCostUsd: number;
}

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };
}

/**
 * Every model the query pipeline touched, not just the main loop — the SDK runs
 * auxiliary calls (title generation, quota classification) that `usage` omits.
 */
function accumulate(total: Usage, modelUsage: Record<string, ModelUsage>, costUsd: number): void {
  for (const model of Object.values(modelUsage)) {
    total.inputTokens += model.inputTokens;
    total.cacheWriteTokens += model.cacheCreationInputTokens;
    total.cacheReadTokens += model.cacheReadInputTokens;
    total.outputTokens += model.outputTokens;
  }
  total.estimatedCostUsd += costUsd;
}

interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * The subprocess inherits `process.env` unless `env` is given, and `env`
 * REPLACES rather than merges — so the whole environment is passed through with
 * both Anthropic credential variables removed. An exported key could otherwise
 * route obserf onto API billing, contradicting ADR-008 with no visible symptom.
 */
function subprocessEnv(): Record<string, string> {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = process.env;
  void ANTHROPIC_API_KEY;
  void ANTHROPIC_AUTH_TOKEN;
  return rest as Record<string, string>;
}

/**
 * Environment settings that can configure model routing, read by the Agent SDK
 * and passed through by `subprocessEnv` above.
 *
 * Reported rather than stripped, unlike the two credentials: these describe
 * where the operator's own Claude Code goes, and an enterprise install routed
 * through Bedrock or a gateway should keep working. The silence was what was
 * wrong — in a scan the request body is the candidate's text and the brief.
 * Being set is all that is reported, because `ANTHROPIC_BASE_URL` may name
 * Anthropic's own endpoint and which of several wins is the SDK's to decide.
 *
 * Read out of the SDK's own sources at the version this was written against, so
 * a variable it adds later will not appear here and nothing detects that.
 * ADR-008 records what the list leaves out and why.
 */
const ROUTING_SETTINGS = [
  "ANTHROPIC_BASE_URL",
  // Not a URL but the same effect: the SDK sends Anthropic API requests over
  // this socket instead of the network.
  "ANTHROPIC_UNIX_SOCKET",
] as const;

/**
 * Each provider switch beside the endpoint override it activates, paired as the
 * SDK's own table pairs them. Without its switch an override changes nothing.
 *
 * The override is the half that hides: an operator who set
 * `CLAUDE_CODE_USE_BEDROCK` deliberately reads that name as expected and stops
 * there, so naming the switch alone leaves a stale `ANTHROPIC_BEDROCK_BASE_URL`
 * unread — the forgotten variable this warning exists for.
 */
const PROVIDER_ENDPOINTS = [
  ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_BASE_URL"],
  ["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "ANTHROPIC_GOOGLE_CLOUD_BASE_URL"],
  ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"],
  ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_BASE_URL"],
  ["CLAUDE_CODE_USE_MANTLE", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL"],
  ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_BASE_URL"],
] as const;

/**
 * A switch is on for `1`, `true`, `yes` or `on`, trimmed and case-insensitive,
 * exactly as the SDK reads it. Truthiness is not that: `CLAUDE_CODE_USE_BEDROCK=0`
 * is a provider turned off, and warning about it teaches the operator to ignore
 * the warning that matters.
 */
const ON = new Set(["1", "true", "yes", "on"]);

/** Checked once per process: a scan makes one of these calls per candidate. */
let checkedRouting = false;

/** The routing variables this environment sets, or `null` when it sets none. */
export function routingConfiguredBy(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const names: string[] = ROUTING_SETTINGS.filter((name) => env[name]?.trim());
  for (const [selection, endpoint] of PROVIDER_ENDPOINTS) {
    if (!ON.has((env[selection] ?? "").toLowerCase().trim())) continue;
    names.push(selection);
    if (env[endpoint]?.trim()) names.push(endpoint);
  }
  // Alphabetical, so reordering the tables above cannot reorder the warning.
  return names.length ? names.sort().join(", ") : null;
}

function announceRouting(): void {
  if (checkedRouting) return;
  checkedRouting = true;
  const routing = routingConfiguredBy();
  if (routing) {
    console.warn(
      `  model-routing variables are set: ${routing} — the candidate text and ` +
        "your project brief follow your Claude Code's routing. Check these if " +
        "that is not deliberate.",
    );
  }
}

/**
 * Shared options for every obserf query. See ADR-008 for the fixed boundaries.
 *
 * `tools: []` disables built-in tools; `strictMcpConfig: true` excludes
 * ambient MCP servers and account connectors. Obserf supplies no MCP servers
 * or agent definitions. Both restrictions are needed because untrusted text
 * goes straight into the prompt. `allowedTools` only controls auto-approval,
 * not availability. ADR-008 records the SDK behavior behind this boundary.
 *
 * `settingSources: []` stops the SDK loading the operator's `CLAUDE.md`,
 * settings, and project memory into obserf's prompts, which would make an
 * assessment depend on the directory it was run from. Obserf's prompts must be
 * reproducible.
 *
 * `maxTurns: 4` because structured output is emitted through an end-turn tool
 * that needs another turn; `maxTurns: 1` fails with `error_max_turns`.
 *
 * No `permissionMode` override: with no built-in or MCP tools there is nothing
 * to permit, and `bypassPermissions` would be granting latitude that cannot be
 * exercised.
 */
function baseOptions(systemPrompt: string): Options {
  return {
    model: config.model,
    systemPrompt,
    tools: [],
    strictMcpConfig: true,
    settingSources: [],
    env: subprocessEnv(),
    maxTurns: 4,
  };
}

/**
 * The SDK reports API failures as `subtype: "success"` with `is_error: true`,
 * carrying the error text where the answer would be. Checking only the subtype
 * stores that error text as a finished draft.
 */
function assertSucceeded(
  message: SDKResultMessage,
): asserts message is Extract<SDKResultMessage, { subtype: "success" }> {
  if (message.subtype !== "success") {
    throw new Error(`Claude Code returned "${message.subtype}"`);
  }
  if (message.is_error) {
    throw new Error("Claude Code ended the turn on an API error");
  }
}

/**
 * Runs a prompt and returns its text.
 *
 * With no tools available these prompts resolve in a single assistant turn, so
 * the text blocks concatenate to one answer. Every failure path throws: a caller
 * that gets a string back knows the model actually produced it.
 */
export async function ask(systemPrompt: string, prompt: string, usage: Usage): Promise<string> {
  announceRouting();
  let text = "";
  let finished = false;

  for await (const message of query({ prompt, options: baseOptions(systemPrompt) })) {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") text += block.text;
      }
    }
    if (message.type === "result") {
      accumulate(usage, message.modelUsage, message.total_cost_usd);
      assertSucceeded(message);
      finished = true;
    }
  }

  // A stream that ends without a result never ran to completion. Returning the
  // partial text would store a truncated draft that reads as a finished one.
  if (!finished) throw new Error("Claude Code produced no result message");
  if (!text.trim()) throw new Error("Claude Code returned an empty response");

  return text.trim();
}

/**
 * Zod stamps a `$schema` dialect URI that the CLI's validator rejects outright
 * ("no schema with key or ref ..."), so it is dropped before the request.
 */
function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  void $schema;
  return rest;
}

/**
 * Runs a prompt constrained to a Zod schema. The schema is the single source of
 * truth: converted to JSON Schema for the request, and parsed back over the
 * response, so a malformed verdict fails here rather than reaching the database.
 */
export async function askForJson<T extends z.ZodType>(
  systemPrompt: string,
  prompt: string,
  schema: T,
  usage: Usage,
): Promise<z.infer<T>> {
  announceRouting();
  let output: unknown;
  let seen = false;

  for await (const message of query({
    prompt,
    options: {
      ...baseOptions(systemPrompt),
      outputFormat: { type: "json_schema", schema: jsonSchema(schema) },
    },
  })) {
    if (message.type === "result") {
      accumulate(usage, message.modelUsage, message.total_cost_usd);
      assertSucceeded(message);
      output = message.structured_output;
      seen = true;
    }
  }

  if (!seen) throw new Error("Claude Code produced no result message");
  return schema.parse(output);
}

/**
 * Runs `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * A rejected worker fails the pool — a scan that half-succeeded silently is
 * worse than one that failed. On failure the remaining queue is abandoned but
 * in-flight workers are awaited before the error propagates: returning early
 * would let a caller record its final counts while workers were still writing.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  // Zero runners would resolve successfully having done no work, so a mistyped
  // OBSERF_ASSESS_CONCURRENCY would produce a scan that gates candidates and
  // assesses none of them, reported as a success.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Pool concurrency must be a positive integer, got ${limit}`);
  }

  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && firstError === undefined) {
      const index = next++;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        firstError ??= error;
      }
    }
  });

  await Promise.all(runners);
  if (firstError !== undefined) throw firstError;
  return results;
}
