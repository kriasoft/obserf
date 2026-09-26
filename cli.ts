#!/usr/bin/env bun
/**
 * Command dispatch and terminal output. Everything here is presentation, with
 * one exception: which projects and findings a command acts on. That belongs to
 * the invocation rather than to the pipeline, which is callable without any of
 * this.
 */

import { basename, resolve } from "node:path";
// The version that scaffolded a workspace is the one known to work with it.
import { version } from "./package.json";
import { parseArgs } from "node:util";
import { initWorkspace, placeholderQueries } from "./init";
import {
  MARKER,
  backupsDir,
  findWorkspaceRoot,
  loadProjects,
  loadProjectsIfAny,
  projectByKey,
  requireWorkspace,
} from "./workspace";
import {
  databasePath,
  draftsFor,
  findingById,
  latestFindings,
  prepareDatabase,
  setTriage,
} from "./db";
import { backup, backups, restore } from "./db/backup";
import type { Finding } from "./db/schema";
import {
  DRAFT_KINDS,
  EVERGREEN,
  TRIAGE_STATUSES,
  defaultKindFor,
  type OpportunityType,
  type TriageStatus,
} from "./vocabulary";
import { venueRuleFor, type ProjectProfile } from "./project";
import { generateDraft } from "./pipeline/draft";
import { rescore } from "./pipeline/rescore";
import { hostOf } from "./url";
import { scan } from "./pipeline/scan";
import type { Usage } from "./agent";

const HELP = `obserf — find free marketing opportunities for your projects

Usage: obserf <command> [options]

  scan      Discover, gate, enrich, and assess new opportunities
              --project <key>   Project to scan (default: all)
              --source <id>     Override profile sources
                                comma-separated or repeated
              --dry-run         List gate survivors; no model calls, nothing stored

  list      Show ranked opportunities
              --project <key>   Filter by project
              --status <s>      new | shortlisted | dismissed | acted (default: new)
                                comma-separated or repeated
              --min <score>     Minimum score (default: 1)
              --limit <n>       Default 20

  show <id>     Full detail for one finding, with its drafts
  draft <id>    Write a draft for a finding
                  --kind comment | reply | submission
                  (default: from the opportunity type, and a reply
                   where the finding is one comment in a thread)
  triage <id> <status> [--note "..."]
  rescore       Recompute scores from stored components; no model calls
                  --project <key>   Restrict to one project
  projects      List the workspace's projects
  init [dir]    Create a workspace here, or in <dir>
  backup        Snapshot the database
  backups       List this database's snapshots
  restore [f]   Replace the database with a snapshot (newest by default)
                  f is a bare name from obserf backups, or ./a/path
  serve         Open the local review inbox
                  --port <n>    Default 4000

The model runs on your Claude Code subscription — no API key. GitHub borrows
the gh CLI's token (OBSERF_GITHUB_USER picks the account). Brave and Reddit read
BRAVE_API_KEY and REDDIT_CLIENT_ID/SECRET from .env; both are optional.`;

/**
 * What each command accepts. One `parseArgs` declares every option obserf has, so
 * without this a flag meant for another command parses cleanly and is then
 * ignored — `obserf backup --project x` snapshotting the whole database, or
 * `obserf scan --limit 3` spending the quota the operator was trying to cap.
 *
 * `args` is the most positionals a command takes, not the fewest. Too few is the
 * command's own to report, because it knows what the missing one is for.
 *
 * A `Map`, so a command named `constructor` finds nothing.
 */
const ACCEPTS = new Map<string, { flags: readonly string[]; args: number }>([
  ["scan", { flags: ["project", "source", "dry-run"], args: 0 }],
  ["list", { flags: ["project", "status", "min", "limit"], args: 0 }],
  ["show", { flags: [], args: 1 }],
  ["draft", { flags: ["kind"], args: 1 }],
  ["triage", { flags: ["note"], args: 2 }],
  ["rescore", { flags: ["project"], args: 0 }],
  ["projects", { flags: [], args: 0 }],
  ["init", { flags: [], args: 1 }],
  // One database file, so there is nothing for `--project` to scope.
  ["backup", { flags: [], args: 0 }],
  ["backups", { flags: [], args: 0 }],
  ["restore", { flags: [], args: 1 }],
  ["serve", { flags: ["port"], args: 0 }],
]);

/**
 * Rejects what a command was given and does not use. Runs before dispatch, so no
 * command has opened the database, loaded a profile, sent a request or written a
 * snapshot by the time the operator is told they were misunderstood.
 *
 * An unrecognised command that parsed is left to the dispatcher, which answers
 * with the help text.
 */
function checkUsage(
  command: string,
  values: Record<string, unknown>,
  positionals: string[],
  tokens: readonly { kind: string; name?: string }[],
): void {
  const accepts = ACCEPTS.get(command);
  if (!accepts) return;

  // `parseArgs` returns only the options actually supplied, so the keys are what
  // the operator typed — a flag left off is absent, not false.
  const stray = Object.keys(values).filter((flag) => !accepts.flags.includes(flag));
  if (stray.length) {
    throw new Error(
      `\`obserf ${command}\` does not take ${stray.map((f) => `--${f}`).join(" or ")}. ` +
        (accepts.flags.length
          ? `It takes ${accepts.flags.map((f) => `--${f}`).join(", ")}.`
          : "It takes no options."),
    );
  }

  if (positionals.length > accepts.args) {
    const extra = positionals
      .slice(accepts.args)
      .map((a) => `"${a}"`)
      .join(", ");
    const takes =
      accepts.args === 0
        ? "takes no arguments"
        : `takes ${accepts.args} argument${accepts.args === 1 ? "" : "s"} at most`;
    throw new Error(`\`obserf ${command}\` ${takes}, so ${extra} would be ignored.`);
  }

  // A flag that is not a list keeps only its last value, so a repeat would
  // discard the first as quietly as a stray flag is ignored.
  const seen = new Set<string>();
  for (const { kind, name } of tokens) {
    if (kind !== "option" || !name || Array.isArray(values[name])) continue;
    if (seen.has(name)) throw new Error(`--${name} was given more than once.`);
    seen.add(name);
  }
}

/**
 * `--status` or `--source`, comma-separated or repeated: both are closed
 * vocabularies, so no value contains a comma. Not for free-text lists.
 */
export function listArg(name: string, values: string[] | undefined): string[] | undefined {
  if (!values) return undefined;
  const items = values
    .flatMap((value) => value.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  // Given and empty is not the same as absent: `--status ,` asked for something.
  if (!items.length) throw new Error(`--${name} was given no value.`);
  return items;
}

function triageStatus(raw: string): TriageStatus {
  const status = TRIAGE_STATUSES.find((value) => value === raw);
  if (!status) throw new Error(`Unknown status "${raw}". Use: ${TRIAGE_STATUSES.join(", ")}`);
  return status;
}

/** A numeric flag, rejected here rather than reaching SQL or `Bun.serve` as NaN. */
function intArg(name: string, raw: string | undefined, fallback: number, min = 1): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} must be an integer ${min} or greater, got "${raw}"`);
  }
  return value;
}

/** How wide prose may run, or 0 when nothing is reading this on a screen. */
function terminalWidth(): number {
  if (!process.stdout.isTTY) return 0;
  const columns = process.stdout.columns;
  return Number.isInteger(columns) && columns > 0 ? columns : 80;
}

/** What a reader counts as one character, which is what may not be cut in half. */
const GRAPHEMES = new Intl.Segmenter();

/**
 * `text` cut to `columns` display columns, `…` included.
 *
 * By column and grapheme, not `slice`, which can end on half an emoji and
 * lets seventy CJK units run to 140 columns. Not `Bun.sliceAnsi`: it keeps a
 * wide character straddling the last column, one past the budget.
 */
export function clipped(text: string, columns: number): string {
  if (columns <= 0) return "";
  if (Bun.stringWidth(text) <= columns) return text;

  let kept = "";
  let used = 0;
  // Not by code point: a heart's variation selector measures zero alone and two
  // with the heart. One column is held back for the ellipsis.
  for (const { segment: character } of GRAPHEMES.segment(text)) {
    const width = Bun.stringWidth(character);
    if (used + width > columns - 1) break;
    kept += character;
    used += width;
  }
  return `${kept}…`;
}

/**
 * Prose broken to the terminal, every line under the same indent.
 *
 * Reasons run to 280 characters, and printed flat they wrap against the margin,
 * so ten findings arrive as a wall. Not when piped: there a reason stays on one
 * line for whatever is matching against it.
 *
 * Applied to plain text, before colour. `width` is a parameter because a test
 * cannot be a terminal.
 */
export function wrapped(text: string, indent: string, width = terminalWidth()): string {
  const limit = width - Bun.stringWidth(indent);
  // Only breaks are added: the operator's own line breaks and spacing in a note
  // survive. `hard: false`: a URL overflows rather than breaking in half.
  const lines = limit < 24 ? text : Bun.wrapAnsi(text, limit, { hard: false });
  return lines
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

/**
 * Whether ANSI belongs on a stream: it is a terminal, and `NO_COLOR` has not
 * been set to anything (no-color.org — present and non-empty disables, whatever
 * the value).
 *
 * Per stream, because the two are redirected independently: `obserf list > file`
 * leaves stderr on the terminal, where an error is still worth colouring, and
 * `obserf scan 2> log` is the reverse.
 *
 * `noColor` is a parameter so the rule is testable without the ambient value.
 */
export function colourable(stream: { isTTY?: boolean }, noColor = process.env.NO_COLOR): boolean {
  return stream.isTTY === true && !noColor;
}

/**
 * A style that applies itself only where it would be seen. Decided once, at
 * load: a shell redirects before the process starts, and nothing here changes
 * where its output goes afterwards.
 */
function styler(stream: { isTTY?: boolean }): (code: string, text: string) => string {
  const on = colourable(stream);
  return (code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
}

const onStdout = styler(process.stdout);
const onStderr = styler(process.stderr);

const dim = (s: string) => onStdout("2", s);
const bold = (s: string) => onStdout("1", s);
const red = (s: string) => onStdout("31", s);
/** Red where the top-level handler writes, which is not where everything else does. */
const stderrRed = (s: string) => onStderr("31", s);

/** Token spend, phrased identically wherever it is reported. */
function usageLine(usage: Usage): string {
  const { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, estimatedCostUsd } = usage;
  return (
    `${inputTokens + cacheReadTokens + cacheWriteTokens} in (${cacheReadTokens} cached) / ` +
    `${outputTokens} out tokens · ~$${estimatedCostUsd.toFixed(3)} at list price`
  );
}

/** `Sep 09 2026`: one date shape wherever a day is printed. */
function day(date: Date): string {
  return date.toDateString().slice(4);
}

function scoreColor(score: number): string {
  // Padded before it is coloured, so an uncoloured run still lines up.
  return onStdout(score >= 70 ? "32" : score >= 40 ? "33" : "90", String(score).padStart(3));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  // Before the grammar is parsed or checked, deliberately: help is what someone
  // runs when they do not know the grammar, so it must not be the one command
  // that insists on it.
  if (!command || command === "help" || command === "--help") {
    console.log(HELP);
    return;
  }

  const { values, positionals, tokens } = parseArgs({
    args: rest,
    allowPositionals: true,
    tokens: true,
    options: {
      project: { type: "string" },
      source: { type: "string", multiple: true },
      status: { type: "string", multiple: true },
      kind: { type: "string" },
      note: { type: "string" },
      min: { type: "string" },
      limit: { type: "string" },
      port: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });

  checkUsage(command, values, positionals, tokens);

  switch (command) {
    case "scan":
      return runScan(values);
    case "list":
      return runList(values);
    case "show":
      return runShow(positionals[0]);
    case "draft":
      return runDraft(positionals[0], values.kind);
    case "triage":
      return runTriage(positionals[0], positionals[1], values.note);
    case "rescore": {
      const count = rescore(values.project);
      console.log(`Rescored ${count} assessment${count === 1 ? "" : "s"}.`);
      return;
    }
    case "init":
      return runInit(positionals[0]);
    // These reach the database by path rather than by opening it, so without
    // this they would answer "no database at <cwd>/.obserf/obserf.db" from a
    // directory that is not a workspace, instead of saying that it is not one.
    case "backup": {
      requireWorkspace();
      const path = backup();
      console.log(path ? `Snapshot → ${path}` : `No database at ${databasePath}.`);
      return;
    }
    case "restore": {
      requireWorkspace();
      const { restored, replaced } = restore(positionals[0]);
      console.log(`Restored ${restored} → ${databasePath}`);
      if (replaced) console.log(dim(`The database it replaced is at ${replaced}`));
      return;
    }
    case "backups": {
      requireWorkspace();
      const found = backups();
      if (!found.length) {
        console.log(dim(`No snapshots of ${databasePath}.`));
        return;
      }
      // Bare names can be passed directly to `restore`.
      console.log(dim(`In ${backupsDir}, oldest first:`));
      for (const { path, takenAt, reason } of found) {
        // Display local time; the filename retains the UTC timestamp.
        const when = `${day(takenAt)} ${takenAt.toTimeString().slice(0, 5)}`;
        console.log(
          `  ${dim(when.padEnd(17))} ${(reason ?? "unlabelled").padEnd(11)} ${basename(path)}`,
        );
      }
      return;
    }
    case "projects": {
      for (const project of await loadProjects()) {
        console.log(`${bold(project.key.padEnd(10))} ${project.name}  ${dim(project.url)}`);
      }
      return;
    }
    case "serve": {
      const { serve } = await import("./web/server");
      await serve(intArg("port", values.port, 4000));
      return;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function runScan(values: { project?: string; source?: string[]; "dry-run"?: boolean }) {
  const sourceIds = listArg("source", values.source);
  const projects = await loadProjects();
  const targets = values.project ? [projectByKey(projects, values.project)] : projects;
  const dryRun = values["dry-run"] ?? false;

  const ready = readyToScan(targets);
  if (!ready.length) {
    throw new Error("No selected project was scanned: scaffold placeholder queries remain.");
  }
  // A dry run writes no findings and runs no migration, reading any existing
  // database through a connection of its own. Every other path here stores
  // findings, so it opens — and upgrades — before spending the first model call
  // rather than after.
  if (!dryRun) prepareDatabase();

  for (const project of ready) {
    console.log(
      `\n${bold(project.name)} ${dim(`(${project.key})`)}${dryRun ? dim(" — dry run") : ""}`,
    );

    // Running totals for the progress line. A bare `44/76` for four minutes says
    // nothing about whether the scan is finding anything worth the wait.
    let scoring = 0;
    let best = 0;

    const result = await scan(project, {
      sourceIds,
      dryRun,
      onProgress: (event) => {
        switch (event.type) {
          case "source:start":
            process.stdout.write(dim(`  ${event.sourceId}… `));
            break;
          case "source:done":
            console.log(dim(`${event.count} candidates`));
            break;
          case "source:skip":
            console.log(dim(`  ${event.sourceId}… skipped (${event.reason})`));
            break;
          case "source:error":
            console.log(red(`failed: ${event.error}`));
            break;
          case "enrich:start":
            // Not "repositories": which of its survivors an adapter actually
            // fetches for is its own business, and the pipeline only knows how
            // many it handed over.
            process.stdout.write(
              dim(`  ${event.sourceId}… extra evidence for ${event.count} candidates `),
            );
            break;
          case "enrich:done":
            console.log(dim("done"));
            break;
          case "assessed": {
            if (event.score > 0) {
              scoring++;
              best = Math.max(best, event.score);
            }
            // The suffix only ever grows, so the carriage return never leaves
            // characters from a longer previous line behind.
            const found = scoring ? dim(` · ${scoring} scoring · best ${best}`) : "";
            process.stdout.write(`\r  assessing ${event.done}/${event.total}${found}`);
            if (event.done === event.total) process.stdout.write("\n");
            break;
          }
        }
      },
    });

    const gates = Object.entries(result.rejected)
      .filter(([, n]) => n > 0)
      .map(([rule, n]) => `${n} ${rule}`)
      .join(", ");
    const outcome = dryRun
      ? `${result.survivors.length} would be assessed`
      : `${result.assessed} assessed`;
    console.log(
      dim(`  ${result.candidates} candidates → ${outcome}` + (gates ? ` (dropped: ${gates})` : "")),
    );
    // Repeat skips in the closing summary so a partial scan cannot be mistaken
    // for a complete one that found less.
    for (const { sourceId, reason } of result.skipped) {
      console.log(dim(`  ${sourceId} did not run: ${reason}`));
    }

    if (dryRun) {
      // Show every survivor so query tuning is not based on a truncated sample.
      for (const item of result.survivors) {
        console.log(`  ${dim(hostOf(item.url).padEnd(28))} ${clipped(item.title, 68)}`);
      }
      continue;
    }

    console.log(dim(`  ${usageLine(result.usage)}`));

    for (const item of result.scored.slice(0, 10)) {
      console.log(
        `  ${scoreColor(item.score)} ${dim(`#${item.findingId}`)} ${clipped(item.title, 80)}`,
      );
    }
    if (!result.scored.length) console.log(dim("  nothing scored above zero"));
  }
}

/**
 * The projects worth searching for, reporting the ones that are not — see
 * `placeholderQueries` for why a placeholder must not be sent.
 *
 * Checked before the database is opened and before the first request goes out,
 * dry runs included: `init` points the operator there next, and discovery still
 * spends source quota.
 *
 * Reported and skipped rather than fatal, so one forgotten `example.ts` does not
 * stop a ready project; the scan fails only when nothing is left.
 */
function readyToScan(targets: ProjectProfile[]): ProjectProfile[] {
  const ready: ProjectProfile[] = [];
  for (const project of targets) {
    const unfinished = placeholderQueries(project.queries);
    if (!unfinished.length) {
      ready.push(project);
      continue;
    }
    console.log(`\n${bold(project.name)} ${dim(`(${project.key})`)}`);
    console.log(red("  Not scanned: these queries still contain scaffold placeholders."));
    for (const query of unfinished) console.log(dim(`    ${query}`));
    // Emptying is as valid an answer as rewriting: a project with no Reddit
    // audience should leave `subreddits` empty, not invent one to get past this.
    console.log(
      dim(
        "  Under `queries`, replace each placeholder with a real value for this\n" +
          "  project — or remove it where that kind of search is unused.",
      ),
    );
  }
  return ready;
}

function runList(values: { project?: string; status?: string[]; min?: string; limit?: string }) {
  const status = (listArg("status", values.status) ?? ["new"]).map(triageStatus);

  const rows = latestFindings({
    project: values.project,
    status,
    minScore: intArg("min", values.min, 1, 0),
    limit: intArg("limit", values.limit, 20),
  });

  if (!rows.length) {
    console.log(dim("Nothing to show. Run `obserf scan` first."));
    return;
  }

  for (const { finding, assessment, note, drafts } of rows) {
    console.log(
      `${scoreColor(assessment?.score ?? 0)} ${dim(`#${String(finding.id).padEnd(4)}`)} ` +
        `${bold(clipped(finding.title, 70))}`,
    );
    console.log(
      `     ${dim(`${finding.venue} · ${assessment?.opportunity ?? "?"}${drafts ? ` · ${drafts} draft${drafts === 1 ? "" : "s"}` : ""} · ${finding.url}`)}`,
    );
    if (assessment?.reason) console.log(dim(wrapped(assessment.reason, "     ")));
    // Last and labelled: the model's reason and the operator's own conclusion
    // about it are different claims, and a shortlist is unreadable if they blur.
    // Indented to the width of the label, so the operator's own words stay in one
    // column. Undimmed, unlike everything around it: theirs, not the model's.
    if (note) console.log(`     ${dim("note:")} ${wrapped(note, " ".repeat(11)).trimStart()}`);
  }
}

async function runShow(idArg: string | undefined) {
  const view = requireFinding(idArg);
  const { finding, assessment, status, note } = view;

  console.log(bold(finding.title));
  console.log(finding.url);
  console.log(
    dim(
      `${finding.venue} · ${finding.sourceId} · ${describeAge(finding.publishedAt, assessment?.opportunity ?? null)} · status: ${status}`,
    ),
  );
  // Show the operator the same evidence the model received, in the same terms.
  if (finding.metrics) {
    const { points, comments } = finding.metrics;
    const facts = [
      points !== undefined ? `${points} points` : "",
      comments !== undefined ? `${comments} comments` : "",
    ].filter(Boolean);
    if (facts.length) console.log(dim(facts.join(" · ")));
  }
  if (finding.repository) {
    const { stars, pullRequests } = finding.repository;
    const facts = [`${stars} stars`];
    if (pullRequests) {
      const resolved = pullRequests.merged + pullRequests.closedUnmerged;
      facts.push(
        `${pullRequests.open} open PRs`,
        `${pullRequests.merged} merged / ${pullRequests.closedUnmerged} closed unmerged ` +
          `in ${pullRequests.windowDays}d`,
      );
      // The proportion is what the operator is really reading, and working it
      // out by hand is the friction this exists to remove. Said as a merge rate,
      // not an acceptance rate: closing a pull request without merging it does
      // not establish that the maintainer refused it.
      if (resolved) {
        facts.push(
          `${Math.round((pullRequests.merged / resolved) * 100)}% merged of ${resolved} resolved`,
        );
      }
    }
    console.log(dim(facts.join(" · ")));
  }

  if (assessment) {
    console.log(
      `\n${bold(`Score ${assessment.score}`)}  ${dim(
        `relevance ${assessment.relevance} · intent ${assessment.intent} · welcome ${assessment.welcome} · reach ${assessment.reach}`,
      )}`,
    );
    console.log(wrapped(`${assessment.opportunity ?? "?"} — ${assessment.reason}`, ""));
    if (assessment.disqualified) console.log(red("Disqualified by the model."));
  }

  // Indented under the label, like the list's. The draft below is deliberately
  // left alone: it is text to be copied, and a line break folded into it here
  // would be pasted into the venue.
  if (note) console.log(`\n${dim("Note:")} ${wrapped(note, " ".repeat(6)).trimStart()}`);
  // `plainText` has already collapsed the source's own line breaks, so without
  // this the excerpt is one 800-character paragraph against the margin.
  if (finding.excerpt) console.log(`\n${dim(wrapped(finding.excerpt.slice(0, 800), ""))}`);

  const drafts = draftsFor(finding.id);
  const profiles = drafts.length ? await loadProjectsIfAny() : [];

  for (const draft of drafts) {
    console.log(`\n${bold(`Draft (${draft.kind})`)} ${dim(draft.createdAt.toISOString())}`);
    console.log(draft.body);
  }

  // Under a stored draft as much as under a freshly written one, which is what
  // the inbox already does: this is the surface an operator re-reads a draft on
  // before posting it, and what obserf cannot establish about the venue has to
  // be said at that moment rather than only at the one that wrote it.
  //
  // Resolved before a line of draft is printed, so a profile that will not load
  // fails with the draft still unsaid rather than after `obserf show 42 | pbcopy`
  // has handed over the text without it. Loaded only when there is a draft to say
  // it about, because that is the whole reason `show` would import and execute
  // every profile module — and tolerantly, because reading a finding back must
  // survive the retirement of the profile that produced it, including the last
  // one in the workspace.
  if (drafts.length) {
    const project = profiles.find((p) => p.key === finding.project);
    console.log(`\n${venueReminder(finding, project)}`);
  }
}

async function runDraft(idArg: string | undefined, kindArg: string | undefined) {
  // Validated before the lookup, which opens the database: `$type<DraftKind>()`
  // is a compile-time claim, and SQLite would happily store a typo.
  const explicitKind = DRAFT_KINDS.find((kind) => kind === kindArg);
  if (kindArg !== undefined && !explicitKind) {
    throw new Error(`Unknown draft kind "${kindArg}". Use: ${DRAFT_KINDS.join(", ")}`);
  }
  const view = requireFinding(idArg);
  // No opportunity type means the model named no moment to act on, and no draft
  // follows from that. `--kind` still works: drafting against a finding the
  // model rejected is the operator's call, made explicitly.
  const opportunity = view.assessment?.opportunity;
  const kind =
    explicitKind ??
    (opportunity ? defaultKindFor(opportunity, view.finding.isThreadComment) : null);
  if (kind === null) {
    throw new Error(
      `#${view.finding.id} has no opportunity type, so there is no default draft for it. ` +
        `Pass --kind ${DRAFT_KINDS.join(" | ")} to write one anyway.`,
    );
  }
  const project = projectByKey(await loadProjects(), view.finding.project);

  const result = await generateDraft(project, view.finding, kind, view.assessment?.reason);
  console.log(`${bold(`Draft (${kind}) for #${view.finding.id}`)} ${dim(view.finding.url)}`);
  // The warning prints whether or not context was retrieved: partial context and
  // none are different risks. Only a complete read is dimmed.
  const provenance = result.contextVia
    ? `fetched live (${result.contextVia})`
    : "could not fetch it live, so this is from the stored excerpt";
  const line = `${provenance}${result.contextWarning ? `: ${result.contextWarning}` : ""}\n`;
  console.log(result.contextVia && !result.contextWarning ? dim(line) : line);
  console.log(result.body);
  console.log(`\n${venueReminder(view.finding, project)}`);
}

/**
 * What the operator established about this venue, and what obserf could not.
 * Printed wherever drafts are shown, because that is the moment it is acted on.
 * See docs/product/opportunities.md for why the claim is this weak.
 */
function venueReminder(finding: Finding, project: ProjectProfile | undefined): string {
  const venue = finding.venue;
  const rule = project && venueRuleFor(project, venue);
  // A missing profile makes guidance unreadable, not absent. Keep both missing
  // states undimmed so uncertainty is at least as visible as a recorded rule.
  const venueLine = !project
    ? `No profile for "${finding.project}" any more, so whatever it recorded about ${venue} ` +
      "is unreadable — restore it, or read the venue's rules and what a submission requires."
    : rule
      ? `Your verified note for ${venue}: ${rule}\n` +
        "Confirm it still holds and that taking part costs nothing."
      : `No verified guidance recorded for ${venue}. Obserf cannot check whether a mention is ` +
        "permitted there or what taking part costs — read the venue's rules and what a " +
        "submission actually requires. A rule you verify yourself goes in the profile's " +
        "`venueGuidance`, with its source and the date you checked.";
  // Broken to the window like the reasons and notes above it. This is the
  // longest block the command prints and the one it prints last.
  const shown = wrapped(venueLine, "");
  return `${rule ? dim(shown) : shown}\n${dim("Then edit it and post it yourself. Obserf never posts.")}`;
}

function runTriage(idArg: string | undefined, statusArg: string | undefined, note?: string) {
  // Before the lookup, which opens and upgrades the database.
  if (statusArg === undefined) {
    throw new Error(`Expected a status: \`obserf triage <id> ${TRIAGE_STATUSES.join("|")}\``);
  }
  const status = triageStatus(statusArg);
  const view = requireFinding(idArg);
  const previous = setTriage(view.finding.id, status, note);
  console.log(`#${view.finding.id} ${previous ?? "new"} → ${status}`);
}

/**
 * Current age for context, not the age used when the stored score was computed.
 * Rescoring refreshes decay without changing the assessment timestamp.
 * See docs/product/scoring.md; the inbox uses the same evergreen exemptions.
 */
function describeAge(publishedAt: Date | null, opportunity: OpportunityType | null): string {
  if (!publishedAt) return "date unknown, not decayed";
  const days = Math.max(0, Math.floor((Date.now() - publishedAt.getTime()) / 86_400_000));
  const exempt = opportunity && EVERGREEN.has(opportunity);
  return `${day(publishedAt)} (${days}d ago${exempt ? ", evergreen" : ""})`;
}

/**
 * Reports the workspace it made and what to do next. A workspace is only useful
 * once `obserf` resolves inside it and the database exists, and neither of those
 * is something scaffolding files can do on its own.
 */
function runInit(dir?: string) {
  // A named directory is initialized as given. Bare `init` inside a workspace
  // updates that workspace rather than nesting a second one inside it, which is
  // what makes "safe to re-run" true from anywhere in the tree.
  const root = dir ? resolve(dir) : (findWorkspaceRoot(process.cwd()) ?? process.cwd());
  const written = initWorkspace(root);

  const created = written.includes(MARKER);
  console.log(
    bold(
      created
        ? `Workspace created in ${root}`
        : written.length
          ? `Workspace in ${root} updated`
          : `Workspace already in ${root}`,
    ),
  );
  for (const file of written) console.log(dim(`  + ${file}`));
  if (!written.length) return;

  // What to do next follows from what was written, not from whether this was the
  // first run: re-running `init` in a workspace that predates the scaffolded
  // `package.json` writes one, and that manifest needs installing whether or not
  // the marker is new.
  //
  // `init` never overwrites, so a directory that already had a `package.json`
  // has no `@obserf/cli` dependency in it — `bun install` there would install nothing
  // and leave every scaffolded import unresolvable.
  const steps = [
    `cd ${root}`,
    written.includes("package.json") ? `bun install` : `bun add @obserf/cli@^${version}`,
    ...(created ? [`$EDITOR projects/example.ts`, `bun run obserf scan --dry-run`] : []),
  ];
  console.log(`\nNext:`);
  for (const step of steps) console.log(dim(`  ${step}`));
  console.log(
    `\n${dim("Working from an obserf checkout instead? `bun link` there, then `bun link @obserf/cli` here.")}`,
  );
}

function requireFinding(idArg: string | undefined) {
  // Command-neutral: `draft` and `triage` reach this too, and were telling the
  // operator to run `show`.
  if (idArg === undefined) throw new Error("Expected a finding id, as `obserf list` prints them.");
  // Digits only, as `list` prints them: `Number` also reads `1e2` as 100 and
  // `0x10` as 16. Past 2^53 the parsed id is no longer the digits typed.
  const id = Number(idArg);
  if (!/^[1-9]\d*$/.test(idArg) || !Number.isSafeInteger(id)) {
    throw new Error(`Expected a finding id like 12, not "${idArg}".`);
  }
  const view = findingById(id);
  if (!view) throw new Error(`No finding #${id}.`);
  return view;
}

// True for `bun cli.ts`, `bun run obserf` and the installed bin shim; false when
// a test imports a helper.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(stderrRed(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
