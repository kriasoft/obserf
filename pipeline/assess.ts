/**
 * The one model call per candidate.
 *
 * The model returns bounded components and a verdict; it never returns a score.
 * See docs/adr/003-model-scores-components-code-ranks.md.
 */

import { z } from "zod";
import { askForJson, type Usage } from "../agent";
import { OPPORTUNITY_TYPES } from "../vocabulary";
import type { ProjectProfile } from "../project";
import type { Candidate } from "../sources";

export const AssessmentSchema = z.object({
  relevance: z.number().int().min(0).max(5),
  intent: z.number().int().min(0).max(5),
  welcome: z.number().int().min(0).max(5),
  reach: z.number().int().min(0).max(5),
  opportunity: z.enum(OPPORTUNITY_TYPES).nullable(),
  disqualified: z.boolean(),
  reason: z.string().trim().min(1),
});

export type AssessmentVerdict = z.infer<typeof AssessmentSchema>;

/** The system prompt for every candidate in a scan: rubric plus project brief. */
function assessmentPrompt(project: ProjectProfile): string {
  return `${RUBRIC}\n\n${projectBrief(project)}`;
}

/**
 * Fingerprints that prompt, excluding candidate content, so prompt edits need no
 * manual version bump and one project's edits do not change another's. Pure
 * provenance: it is recorded on every assessment and nothing reads it back.
 */
export function assessPromptFingerprint(project: ProjectProfile): string {
  return new Bun.CryptoHasher("sha256")
    .update(assessmentPrompt(project))
    .digest("hex")
    .slice(0, 12);
}

const RUBRIC = `You triage marketing opportunities for an open-source maintainer.

An opportunity is a public moment where mentioning the project is USEFUL to the reader, PERMITTED by the venue, and FREE. All three must hold, and each is a prerequisite rather than a preference — no amount of one compensates for the absence of another. Your job is to reject the many that fail, not to find something good in each one.

Rate each dimension 0-5:

relevance — Is this actually about the problem the project solves? 5 = someone describing that exact problem in their own words. 0 = the keyword appears but the subject does not.
intent — Is someone looking for a solution now? 5 = an open, unanswered "what should I use for X?". 0 = a retrospective with no open question.
welcome — Would a mention be welcome under THIS venue's norms?

Rate the evidence in front of you, never an assumption. You cannot read the venue's rules — you have the supplied candidate evidence and any known venue rules — so treat missing evidence as uncertainty, not as permission.
  5 = the text itself invites it AND maintainers answering is established practice there (Hacker News, a project's own issue tracker, a thread explicitly asking maintainers to chime in).
  3 = plausibly fine, but nothing in front of you establishes the venue's stance. This is the right score for most findings, including a request for recommendations in a venue whose promotion policy you cannot see.
  1 = tolerated at best; a venue you have positive reason to think dislikes promotion.
  0 = self-promotion breaks the rules here, or the thread is closed to newcomers. Use it whenever you have positive reason to expect a rule would be broken.
A 5 you cannot point to specific evidence for is a 3. Judge the specific subreddit or forum, not the platform in general.
reach — Will anyone read it? Use the engagement figures when given, and the venue's nature when not. 0 = a dead page with no audience. Judge the place a reply would actually appear, not the platform: where the candidate is one comment inside a thread, a reply sits under that comment and is read by a fraction of the thread's audience, however large the thread. When no engagement figures are given for that comment, silence is not evidence of a wide readership.

Where the candidate is a curated repository rather than a discussion, its pull-request record is the evidence for welcome, and stars are only reach. A high proportion merged among the pull requests it resolved is evidence that submissions are getting through. A low proportion, especially beside a long open queue, is evidence that a submission may have little practical path in — however recently the repository was pushed. Judge that pattern rather than reading closed-unmerged as a count of refusals: a pull request can be closed unmerged because it was withdrawn, superseded, duplicated, or spam. These counts cover every pull request the repository saw, maintainers' own work included, so read them as a signal of how open the door is rather than as an outside contributor's acceptance rate. Where that record is absent you have no evidence either way, and absence is not permission.

opportunity — the shape of the moment, or null when it is none of these:
  question (someone is stuck), discussion (an active thread on the subject),
  comparison (a list of alternatives that omits the project),
  listing (a curated index accepting submissions), mention (the project is already referenced).
Use null whenever you disqualify something that has no genuine shape — a rejected candidate forced into a category is worse than no answer.

An opportunity needs a way in. Relevant content is not an opportunity unless the maintainer has an evident, public, free way to participate: a comment or reply, a submission or pull request, or another explicitly invited mechanism. A listicle with no comments, an immutable blog post, a closed thread, a directory whose only route is a sales email — these are things to read, not places to act. Where you have no evidence such a path exists, disqualify.

disqualified — a categorical eligibility failure, whatever the other numbers say. Distinct from the components above: relevance measures fit and welcome measures permission, while this covers the facts that end the matter outright. Set it true when any of these hold:
  - the candidate matches something in the project's NOT-for list;
  - participation costs money — a paid listing, sponsorship, "featured" placement, paid review, or any purchase;
  - there is no evident free public way to participate at all;
  - a mention would be plainly wrong on the merits.
The most expensive mistake available to you is a plausible-looking recommendation that does not actually fit; prefer disqualifying to being generous.

reason — one sentence, concrete, naming the deciding factor. When welcome is 4 or 5, name the evidence that a mention is permitted; if you cannot, that is the signal the score is too high.

Be strict. Most candidates deserve low numbers. A 5 anywhere should be rare.`;

function projectBrief(project: ProjectProfile): string {
  return [
    `# Project: ${project.name} (${project.url})`,
    "",
    project.pitch,
    "",
    "## Problems it solves",
    ...project.solves.map((s) => `- ${s}`),
    "",
    "## NOT for",
    "Contexts that look relevant but are not. Treat a match here as disqualifying.",
    ...project.notFor.map((s) => `- ${s}`),
    ...venueSection(project),
  ].join("\n");
}

/**
 * Operator-supplied facts about venue rules. Evidence outranks the model's
 * memory of community policies, which is the whole reason this exists — see
 * `venueGuidance` in project.ts.
 */
function venueSection(project: ProjectProfile): string[] {
  // The same test `venueRuleFor` applies for the drafter: a blank entry is no
  // rule, and the two readers must not disagree about whether one was recorded.
  const entries = Object.entries(project.venueGuidance ?? {}).filter(
    ([, rule]) => typeof rule === "string" && rule.trim(),
  );
  if (!entries.length) return [];
  return [
    "",
    "## Known venue rules",
    "Established facts, not impressions. Where a candidate's venue appears here, use this",
    "rather than your own recollection when rating welcome. Venues absent from this list",
    "have no evidence either way, which is not the same as permission.",
    ...entries.map(([venue, rule]) => `- ${venue}: ${rule}`),
  ];
}

/**
 * The candidate, as the model sees it. Exported for tests: every label here is
 * a claim about what a number means, and one wrong label is worth more than a
 * wrong weight: send a repository's open-issue count as `Comments` and an
 * abandoned list arrives looking like a busy discussion.
 */
export function candidateBlock(candidate: Candidate): string {
  const parts = [`Venue: ${candidate.venue}`, `URL: ${candidate.url}`, `Title: ${candidate.title}`];
  // Title and URL alone look like the enclosing thread; label the comment so
  // reach is judged where a reply would appear.
  if (candidate.isThreadComment) {
    parts.push("Shape: one comment inside that thread, not the thread itself");
  }
  if (candidate.publishedAt) parts.push(`Published: ${candidate.publishedAt.toISOString()}`);
  if (candidate.author) parts.push(`Author: ${candidate.author}`);
  if (candidate.metrics?.points !== undefined) parts.push(`Points: ${candidate.metrics.points}`);
  if (candidate.metrics?.comments !== undefined) {
    parts.push(`Comments: ${candidate.metrics.comments}`);
  }
  parts.push(...repositoryLines(candidate));
  parts.push("", "Excerpt:", candidate.excerpt.slice(0, 2000) || "(none)");
  return parts.join("\n");
}

/**
 * A repository's own facts. `pullRequests` is absent when enrichment did not run
 * and then nothing is said about merge behaviour at all —
 * silence is what the rubric tells the model to read as uncertainty, whereas a
 * zero would read as a maintainer who merges nothing.
 */
function repositoryLines(candidate: Candidate): string[] {
  const repository = candidate.repository;
  if (!repository) return [];

  const lines = [`Stars: ${repository.stars}`];
  const pullRequests = repository.pullRequests;
  if (!pullRequests) return lines;

  lines.push(
    `Open pull requests: ${pullRequests.open}`,
    `Pull requests merged in the last ${pullRequests.windowDays} days: ${pullRequests.merged}`,
    `Pull requests closed unmerged in the same period: ${pullRequests.closedUnmerged}`,
  );
  return lines;
}

/**
 * Assesses one candidate.
 *
 * The system prompt (rubric + project brief) is identical for every candidate in
 * a scan, so it caches; the candidate is the only part that varies.
 */
export async function assess(
  project: ProjectProfile,
  candidate: Candidate,
  usage: Usage,
): Promise<AssessmentVerdict> {
  const verdict = await askForJson(
    assessmentPrompt(project),
    candidateBlock(candidate),
    AssessmentSchema,
    usage,
  );
  return normalizeVerdict(verdict);
}

/**
 * The one contradiction the schema cannot express. `opportunity` is the shape of
 * the moment and `null` means it is none of the five, which is the definition of
 * not being an opportunity — but the schema types the two fields independently,
 * so a verdict can say "no shape" and "not disqualified" at once.
 *
 * Left alone it is not a small inconsistency: the weighted score ignores
 * `opportunity`, so such a verdict outranks most real findings, and drafting
 * falls back to a comment for a moment the model could not name. Resolved here
 * rather than in `score.ts` because the stored row has to be coherent too —
 * `rescore` recomputes from these components, and the inbox reads them directly.
 *
 * Corrected rather than rejected: the model contradicting itself is not a reason
 * to fail an operator's whole scan, and the correction can only remove a finding,
 * never invent one.
 *
 * Exported for tests: this is the only place the rule exists.
 */
export function normalizeVerdict(verdict: AssessmentVerdict): AssessmentVerdict {
  if (verdict.disqualified || verdict.opportunity) return verdict;
  return {
    ...verdict,
    disqualified: true,
    reason: `${verdict.reason} (No opportunity type was named, so there is no moment to act on.)`,
  };
}
