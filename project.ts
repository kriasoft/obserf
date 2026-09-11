/**
 * The project profile: what a workspace author writes, and the only configuration
 * contract Obserf promises. See docs/adr/006-project-profiles-are-typescript.md
 * for why these are TypeScript modules rather than YAML.
 *
 * Everything here is prompt input as much as configuration: `pitch`, `solves`,
 * and `notFor` are read verbatim by the model when it judges relevance, so write
 * them the way you would brief a person, not the way you would fill a form.
 */

import type { SourceId } from "./vocabulary";

export interface ProjectQueries {
  /** Free-text queries shared by Brave, Hacker News, and Reddit. */
  search: string[];
  /**
   * Brave-only queries; omitted means `search` is used instead.
   * Keep web-index operators such as `site:reddit.com` here so they are not
   * sent to Hacker News or Reddit. Query measurements belong in the profile.
   */
  brave?: string[];
  /** Subreddit names, without the `r/` prefix. */
  subreddits: string[];
  /** GitHub issue and pull-request search queries, in GitHub's search syntax. */
  github: string[];
  /**
   * GitHub *repository* search queries — how `awesome-*` lists are found.
   * A separate field because issue search and repository search are different
   * endpoints with different qualifiers; `in:name,description,readme` silently
   * matches nothing against issues.
   *
   * Prefer `in:name,description`: searching entire READMEs also picks up
   * broad indexes that mention the topic but are scoped to something else.
   */
  githubRepos?: string[];
}

export interface ProjectProfile {
  /** Stable identifier. Used as the CLI argument and the foreign key. */
  key: string;
  name: string;
  url: string;

  /** One paragraph, as you would pitch it to a peer. */
  pitch: string;

  /** The problems it solves, phrased the way someone with the problem would say it. */
  solves: string[];

  /**
   * Contexts that look relevant but are not. This is the highest-leverage field
   * in the profile: it is what stops the model recommending a confident,
   * plausible, wrong mention. See docs/product/opportunities.md.
   */
  notFor: string[];

  queries: ProjectQueries;

  /**
   * Default source ids; omitted means all, and an empty list is invalid.
   * `--source` overrides this set; execution always follows registry order.
   * Use measured results to choose defaults. An explicit list requires opting
   * into newly registered adapters rather than adding them automatically.
   */
  sources?: SourceId[];

  /** Hosts (including subdomains) or `host/path` patterns to exclude, such as the project's own pages. */
  blockedDomains?: string[];

  /**
   * What is actually known about specific venues' promotion rules, keyed by the
   * venue string a source reports (`r/golang`, `news.ycombinator.com`).
   *
   * `welcome` is the component that decides whether a mention is permitted, and
   * it is the one the model is least equipped to judge: it has no tools and
   * cannot read a subreddit's sidebar, so without this it answers from memory of
   * community policies that may be years stale. Anything written here is treated
   * as evidence and outranks the model's prior.
   *
   * Fill it from the venue's actual rules, not from an impression — a confident
   * wrong entry here produces exactly the ban this field exists to prevent.
   * Without evidence in this guidance or the candidate text, the rubric caps
   * welcome at 3. Include the rule's source and verification date in each entry
   * so it can be checked again when the venue changes its policy.
   *
   * The assessment receives the whole map; the drafter receives the exact
   * venue's rule. The CLI and inbox show it with new and stored drafts for the
   * operator to recheck. The inbox uses profiles loaded at server startup;
   * restart it after editing a rule. These reminders are not draft provenance.
   */
  venueGuidance?: Record<string, string>;

  /** How drafted comments should sound, in one or two sentences. */
  voice: string;
}

/**
 * Identity, for the types. A profile is a plain object; this exists so a file in
 * an operator's workspace — outside this repository, and outside its `tsc` run —
 * still gets completion and errors on the shape it must satisfy.
 *
 * `satisfies ProjectProfile` does the same job for a profile inside this repo,
 * but a workspace importing a type has to name it; importing a function it can
 * simply call is the smaller thing to explain, and it is the one export a
 * profile needs.
 */
export function defineProject(profile: ProjectProfile): ProjectProfile {
  return profile;
}

/**
 * The rule this operator verified for a venue, or null when they recorded none.
 *
 * Exact key, no prefix matching: `venueGuidance` is keyed by the venue string a
 * source reports, and a rule about one repository's contribution policy is not a
 * rule about github.com.
 *
 * Recorded means written in this map. A bare lookup reads the prototype chain
 * too, so a venue named `constructor` would find the one on `Object.prototype`
 * — and an inherited string would be a rule here while the assessment, which
 * enumerates own entries, saw none. The profile is executed rather than
 * compiled, so a non-string or blank entry is no rule either.
 */
export function venueRuleFor(project: ProjectProfile, venue: string): string | null {
  const guidance = project.venueGuidance;
  if (!guidance || !Object.hasOwn(guidance, venue)) return null;
  const rule = guidance[venue];
  return typeof rule === "string" && rule.trim() ? rule : null;
}
