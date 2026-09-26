/**
 * Draft generation. Obserf writes; the operator posts.
 * See docs/adr/005-obserf-drafts-humans-post.md.
 */

import { ask, emptyUsage } from "../agent";
import { fetchContext } from "./draft-context";
import { config } from "../config";
import { db, schema } from "../db";
import type { Draft, Finding } from "../db/schema";
import type { DraftKind } from "../vocabulary";
import { venueRuleFor, type ProjectProfile } from "../project";

/**
 * The three rules are the product's standard for a draft, not prompt decoration:
 * a comment that is not useful with the link removed is spam, and one that hides
 * the author's stake is a comment they should not be posting either.
 */
const RULES = `You are drafting a public comment on behalf of the maintainer of an open-source project. It will be reviewed and posted by a person, under their own name.

Three rules:
1. Answer first, mention second. The comment must be useful to the reader with the link removed. If it is not, say so instead of writing one.
2. Disclose the affiliation in one short clause — "I maintain X" — in the maintainer's own voice.
3. No enthusiasm the project has not earned. This reads as a peer's recommendation, not as copy. No marketing adjectives, no exclamation marks, no bullet-point feature lists.

Match the venue. A Hacker News comment, a Reddit reply, and an awesome-list pull request description are different registers and different lengths.

Write only the text to post. No preamble, no "here's a draft", no surrounding quotes. Keep it short — usually two to five sentences.`;

/**
 * Verified venue rules guide register, format and placement. They cannot relax
 * the draft's usefulness or affiliation disclosure requirements (ADR-005).
 */
function venueSection(venue: string, rule: string | null): string[] {
  if (!rule) return [];
  return [
    "",
    `## Verified rules for ${venue}`,
    "The maintainer checked these at the venue itself; they are facts, not your recollection.",
    "Follow them for where a mention may go, how it must be phrased, and what form a",
    "submission takes. They do not relax the three rules above.",
    rule,
  ];
}

function kindGuidance(kind: DraftKind): string {
  switch (kind) {
    case "comment":
      return "Write a top-level comment on the thread.";
    case "reply":
      return "Write a reply to the specific person quoted below, responding to what they actually said — answering it where they asked something, and engaging with it where they did not.";
    case "submission":
      return "Write the body of a submission — a pull request description for a curated list, or a directory entry. State plainly what the project is and why it belongs alongside the existing entries.";
  }
}

/**
 * The draft-time fetch established a fact that rules a draft out. Its own class
 * so a front end can answer it as a refusal rather than as a failure to draft.
 */
export class DraftRefused extends Error {
  constructor(reason: string) {
    super(`Not drafting: ${reason}.`);
    this.name = "DraftRefused";
  }
}

export async function generateDraft(
  project: ProjectProfile,
  finding: Finding,
  kind: DraftKind,
  reason?: string,
): Promise<Draft> {
  // `ask` accumulates into this; the draft's spend is not reported anywhere, so
  // it does not leave the function.
  const usage = emptyUsage();

  // Fetch current source context; the evidence used to rank it may be partial
  // or stale by the time the operator asks for a draft.
  const retrieved = await fetchContext(finding.url);
  // Before the model call: polished copy for a thread the fetch ruled out spends
  // quota on text that can only mislead.
  if ("refused" in retrieved) throw new DraftRefused(retrieved.refused);
  const { context: fresh, warning: contextWarning } = retrieved;

  const context = [
    `Venue: ${finding.venue}`,
    `URL: ${finding.url}`,
    `Title: ${finding.title}`,
    // The title names the thread, but this text may be one message inside it;
    // label that shape so the draft answers the commenter.
    finding.isThreadComment
      ? `Shape: one comment inside that thread, by ${finding.author ?? "an unnamed commenter"}`
      : "",
    finding.author ? `Author: ${finding.author}` : "",
    "",
    fresh ? "Content, fetched just now:" : "Content (search excerpt only):",
    fresh?.text ||
      finding.excerpt ||
      "(nothing captured — say so rather than writing a generic comment)",
    fresh
      ? ""
      : "\nYou are working from a search excerpt, not the current source. If it does not " +
        "give enough context to write this draft responsibly, say so instead of guessing " +
        "— a generic self-promotional response is worse than none.",
    // Told to the model as well as to the operator: what is missing changes what
    // can honestly be claimed about the thread, and a partial read presented as
    // a whole one is how a confident reply to the wrong question gets written.
    // Other people's replies are evidence; only a stripped page mixes in text
    // nobody wrote into the discussion.
    fresh && contextWarning
      ? `\nLimits of that content: ${contextWarning}. Claim nothing about what it leaves out.${
          fresh.via === "page"
            ? " Do not treat navigation or other text that is not clearly the page's own content as part of the discussion."
            : ""
        }`
      : "",
    reason ? `\nWhy this was flagged: ${reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const body = await ask(
    [
      RULES,
      "",
      `# Project: ${project.name} (${project.url})`,
      project.pitch,
      "",
      "## What it solves",
      ...project.solves.map((s) => `- ${s}`),
      "",
      "## What it does NOT do",
      "Never claim any of these. If the thread asks for one, say plainly that the",
      "project does not do it — a comment that oversells is worse than no comment.",
      ...project.notFor.map((s) => `- ${s}`),
      "",
      "## Voice",
      project.voice,
      ...venueSection(finding.venue, venueRuleFor(project, finding.venue)),
    ].join("\n"),
    `${kindGuidance(kind)}\n\n${context}`,
    usage,
  );

  // Stored, not only returned: a draft is re-read before posting, often days later.
  return db
    .insert(schema.drafts)
    .values({
      findingId: finding.id,
      kind,
      body,
      model: config.model,
      contextSource: fresh?.via ?? "excerpt",
      contextWarning: contextWarning ?? null,
      createdAt: new Date(),
    })
    .returning()
    .get();
}
